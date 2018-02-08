'use strict'

const { deriveAddress, deriveKeypair } = require('ripple-keypairs')
const { RippleAPI } = require('ripple-lib')
const BtpPacket = require('btp-packet')
const BigNumber = require('bignumber.js')
const debug = require('debug')('ilp-plugin-xrp-asym-client')
const BtpPlugin = require('ilp-plugin-btp')
const nacl = require('tweetnacl')
const OUTGOING_CHANNEL_DEFAULT_AMOUNT_XRP = '10' // TODO: something lower?
const {
  util,
  ChannelWatcher
} = require('ilp-plugin-xrp-paychan-shared')

class Plugin extends BtpPlugin {
  constructor (opts) {
    super(opts)
    this._currencyScale = 6
    this._server = opts.server

    if (!opts.server || !opts.secret) {
      throw new Error('opts.server and opts.secret must be specified')
    }

    // TODO: should use channel secret or xrp secret
    this._secret = opts.secret
    this._address = opts.address || deriveAddress(deriveKeypair(this._secret).publicKey)
    this._xrpServer = opts.xrpServer

    // make sure two funds don't happen at once
    this._funding = false
    this._claimInterval = opts.claimInterval || util.DEFAULT_CLAIM_INTERVAL

    // optional
    this._store = opts.store
    this._writeQueue = Promise.resolve()

    this._log = opts._log || console
    this._ws = null

    // this.on('incoming_reject', this._handleIncomingReject.bind(this))
  }

  sendTransfer () {}

  async _createOutgoingChannel () {
    debug('creating outgoing channel')
    const txTag = util.randomTag()
    const tx = await this._api.preparePaymentChannelCreate(this._address, {
      amount: OUTGOING_CHANNEL_DEFAULT_AMOUNT_XRP,
      destination: this._peerAddress,
      settleDelay: util.MIN_SETTLE_DELAY,
      publicKey: 'ED' + Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase(),
      sourceTag: txTag
    })

    debug('signing transaction')
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = await this._api.submit(signedTx.signedTransaction)

    debug('submitted outgoing channel tx to validator')
    if (result.resultCode !== 'tesSUCCESS') {
      const message = 'Error creating the payment channel: ' + result.resultCode + ' ' + result.resultMessage
      debug(message)
      return
    }

    // TODO: make a generic version of the code that submits these things
    debug('waiting for transaction to be added to the ledger')
    return new Promise((resolve) => {
      const handleTransaction = (ev) => {
        if (ev.transaction.SourceTag !== txTag) return
        if (ev.transaction.Account !== this._address) return

        debug('transaction complete')
        const channel = util.computeChannelId(
          ev.transaction.Account,
          ev.transaction.Destination,
          ev.transaction.Sequence)

        setImmediate(() => this._api.connection
          .removeListener('transaction', handleTransaction))
        resolve(channel)
      }

      this._api.connection.on('transaction', handleTransaction)
    })
  }

  async _connect () {
    const infoResponse = await this._call(null, {
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await util._requestId(),
      data: { protocolData: [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from([ util.INFO_REQUEST_ALL ])
      }] }
    })

    // TODO: do the processes of channel establishment and client-channel
    // establishment occur in here automatically (in the case that no channel
    // exists) or do they happen in a separate script?

    const info = JSON.parse(infoResponse.protocolData[0].data.toString())
    debug('got info:', info)

    this._account = info.account
    this._prefix = info.prefix
    this._channel = info.channel
    this._clientChannel = info.clientChannel
    this._peerAddress = info.address
    this._keyPair = nacl.sign.keyPair
      .fromSeed(util.hmac(
        this._secret,
        'ilp-plugin-xrp-stateless' + this._peerAddress
      ))

    if (!this._xrpServer) {
      this._xrpServer = this._account.startsWith('test.')
        ? 'wss://s.altnet.rippletest.net:51233'
        : 's1.ripple.com'
    }

    this._api = new RippleAPI({ server: this._xrpServer })
    await this._api.connect()
    await this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })

    this._watcher = new ChannelWatcher(60 * 1000, this._api)
    this._watcher.on('channelClose', () => {
      debug('channel closing; triggering auto-disconnect')
      // TODO: should we also close our own channel?
      this._disconnect()
    })

    // TODO: is this an attack vector, if not telling the plugin about their channel
    // causes them to open another channel?

    const channelProtocolData = []
    if (!this._channel) {
      this._channel = await this._createOutgoingChannel()

      const encodedChannel = util.encodeChannelProof(this._channel, this._account)
      const channelSignature = nacl.sign
        .detached(encodedChannel, this._keyPair.secretKey)

      channelProtocolData.push({
        protocolName: 'channel',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from(this._channel, 'hex')
      }, {
        protocolName: 'channel_signature',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from(channelSignature)
      })
    }

    // used to make sure we don't go over the limit
    this._channelDetails = await this._api.getPaymentChannel(this._channel)

    if (!this._clientChannel) {
      debug('no client channel has been established; requesting')
      channelProtocolData.push({
        protocolName: 'fund_channel',
        contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(this._address)
      })
    }

    if (channelProtocolData.length) {
      const channelResponse = await this._call(null, {
        type: BtpPacket.TYPE_MESSAGE,
        requestId: await util._requestId(),
        data: { protocolData: channelProtocolData }
      })

      if (!this._clientChannel) {
        const fundChannelResponse = channelResponse
          .protocolData
          .filter(p => p.protocolName === 'fund_channel')[0]

        this._clientChannel = fundChannelResponse.data
          .toString('hex')
          .toUpperCase()
      }
    }

    // TODO: should this occur as part of info or should the connector send us a
    // separate message to inform us that they have a channel to us?
    if (this._clientChannel) {
      this._paychan = await this._api.getPaymentChannel(this._clientChannel)

      // don't accept any channel that isn't for us
      if (this._paychan.destination !== this._address) {
        await this._disconnect()
        throw new Error('Fatal: Payment channel destination is not ours; Our connector is likely malicious')
      }

      // don't accept any channel that can be closed too fast
      if (this._paychan.settleDelay < util.MIN_SETTLE_DELAY) {
        await this._disconnect()
        throw new Error('Fatal: Payment channel settle delay is too short; Our connector is likely malicious')
      }

      // don't accept any channel that is closing
      if (this._paychan.expiration) {
        await this._disconnect()
        throw new Error('Fatal: Payment channel is already closing; Our connector is likely malicious')
      }

      // don't accept any channel with a static cancel time
      if (this._paychan.cancelAfter) {
        await this._disconnect()
        throw new Error('Fatal: Payment channel has a hard cancel; Our connector is likely malicious')
      }

      this._bestClaim = {
        amount: util.xrpToDrops(this._paychan.balance)
      }

      // load the best claim from the crash cache
      if (this._store) {
        const bestClaim = JSON.parse(await this._store.get(this._clientChannel))
        if (bestClaim.amount > this._bestClaim) {
          this._bestClaim = bestClaim
          // TODO: should it submit the recovered claim right away or wait?
        }
      }

      debug('setting claim interval on channel.')
      this._lastClaimedAmount = new BigNumber(util.xrpToDrops(this._paychan.balance))
      this._claimIntervalId = setInterval(async () => {
        await this._claimFunds()
      }, this._claimInterval)

      debug('loaded best claim of', this._bestClaim)
      this._watcher.watch(this._clientChannel)
    }

    // finished the connect process
    debug('connected asym client plugin')
  }

  async _disconnect () {
    if (this._funding) {
      await this._funding
    }

    if (this._store) {
      await this._writeQueue
    }

    await this._claimFunds()

    clearInterval(this._claimIntervalId)
    debug('done')
  }

  async _claimFunds () {
    if (this._bestClaim.amount === '0') return
    if (this._bestClaim.amount === util.xrpToDrops(this._paychan.balance)) return
    if (!this._lastClaimedAmount.lt(this._bestClaim.amount)) return

    debug('starting claim. amount=' + this._bestClaim.amount)
    this._lastClaimedAmount = new BigNumber(this._bestClaim.amount)

    debug('creating claim tx')
    const claimTx = await this._api.preparePaymentChannelClaim(this._address, {
      balance: util.dropsToXrp(this._bestClaim.amount),
      channel: this._clientChannel,
      signature: this._bestClaim.signature.toUpperCase(),
      publicKey: this._paychan.publicKey
    })

    debug('signing claim transaction')
    const signedTx = this._api.sign(claimTx.txJSON, this._secret)

    debug('submitting claim transaction ', claimTx)
    const {resultCode, resultMessage} = await this._api.submit(signedTx.signedTransaction)
    if (resultCode !== 'tesSUCCESS') {
      console.error('WARNING: Error submitting claim: ', resultMessage)
      throw new Error('Could not claim funds: ', resultMessage)
    }

    debug('claimed funds.')
  }

  async _handleData (from, message) {
    const { ilp, protocolMap } = this.protocolDataToIlpAndCustom(message.data)
    const channelProtocol = protocolMap.channel

    if (channelProtocol) {
      debug('got notification of changing channel details')
      const channel = channelProtocol
        .toString('hex')
        .toUpperCase()

      // we just use this call to refresh the channel details
      // TODO: can use this protocol to establish client paychan at a later date
      // than the connection.
      if (channel !== this._clientChannel) return
      this._paychan = await this._api.getPaymentChannel(channel)
      return []
    }

    if (!this._dataHandler) {
      throw new Error('no request handler registered')
    }

    const response = await this._dataHandler(ilp)
    return this.ilpAndCustomToProtocolData({ ilp: response })
  }

  async sendMoney (transferAmount) {
    if (!this._lastClaim) {
      const response = await this._call(null, {
        type: BtpPacket.TYPE_MESSAGE,
        requestId: await util._requestId(),
        data: { protocolData: [{
          protocolName: 'last_claim',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: Buffer.from([])
        }] }
      })

      const primary = response.protocolData[0]
      if (primary.protocolName !== 'last_claim') throw new Error('unable to obtain last claim from connector')
      this._lastClaim = JSON.parse(primary.data.toString())
    }

    // TODO: this method of having the latest claim cached will fail on multiple clients
    // connected to one server. It could be switched to fetch the last claim every time,
    // but then the latency would effectively double.

    debug('given last claim of', this._lastClaim)
    const encodedClaim = util.encodeClaim(this._lastClaim.amount, this._channel)

    // If they say we haven't sent them anything yet, it doesn't matter
    // whether they possess a valid claim to say that.
    if (this._lastClaim.amount !== '0') {
      try {
        nacl.sign.detached.verify(
          encodedClaim,
          Buffer.from(this._lastClaim.signature, 'hex'),
          this._keyPair.publicKey
        )
      } catch (err) {
        // TODO: if these get out of sync, all subsequent transfers of money will fail
        debug('invalid claim signature for', this._lastClaim.amount, err)
        throw new Error('Our last outgoing signature for ' + this._lastClaim.amount + ' is invalid')
      }
    } else {
      debug('signing first claim')
    }

    const amount = new BigNumber(this._lastClaim.amount).plus(transferAmount).toString()
    const newClaimEncoded = util.encodeClaim(amount, this._channel)
    const signature = Buffer
      .from(nacl.sign.detached(newClaimEncoded, this._keyPair.secretKey))
      .toString('hex')
      .toUpperCase()

    const aboveThreshold = new BigNumber(util
      .xrpToDrops(this._channelDetails.amount))
      .minus(util.xrpToDrops(OUTGOING_CHANNEL_DEFAULT_AMOUNT_XRP / 2))
      .lt(amount)

    // if the claim we're signing is for more than half the channel's balance, add some funds
    // TODO: should there be a balance check to make sure we have enough to fund the channel?
    // TODO: should this functionality be enabled by default?
    if (!this._funding && aboveThreshold) {
      debug('adding funds to channel')
      this._funding = util.fundChannel({
        api: this._api,
        channel: this._channel,
        address: this._address,
        secret: this._secret,
        // TODO: configurable fund amount?
        amount: util.xrpToDrops(OUTGOING_CHANNEL_DEFAULT_AMOUNT_XRP)
      })
        .then(async () => {
          this._funding = false

          const encodedChannel = util.encodeChannelProof(this._channel, this._account)
          const channelSignature = nacl.sign
            .detached(encodedChannel, this._keyPair.secretKey)

          // send a 'channel' call in order to refresh details
          await this._call(null, {
            type: BtpPacket.TYPE_MESSAGE,
            requestId: await util._requestId(),
            data: { protocolData: [{
              protocolName: 'channel',
              contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.from(this._channel, 'hex')
            }, {
              protocolName: 'channel_signature',
              contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.from(channelSignature)
            }] }
          })
        })
        .catch((e) => {
          debug('fund tx/notify failed:', e)
          this._funding = false
        })
    }

    return this._call(null, {
      type: BtpPacket.TYPE_TRANSFER,
      requestId: await util._requestId(),
      data: {
        amount: transferAmount,
        protocolData: [{
          protocolName: 'claim',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({ amount, signature }))
        }]
      }
    })
  }

  async _handleMoney (from, { requestId, data }) {
    const transferAmount = data.amount
    const primary = data.protocolData[0]

    if (primary.protocolName === 'claim') {
      const lastAmount = new BigNumber(this._bestClaim.amount)
      const { amount, signature } = JSON.parse(primary.data.toString())
      const encodedClaim = util.encodeClaim(amount, this._clientChannel)
      const addedMoney = new BigNumber(amount).minus(lastAmount)

      if (!addedMoney.equals(transferAmount)) {
        debug('warning: peer balance is out of sync with ours. peer thinks they sent ' +
          transferAmount + '; we got ' + addedMoney.toString())
      }

      if (lastAmount.gte(amount)) {
        throw new Error('got claim that was lower than our last claim.' +
          ' lastAmount=' + lastAmount.toString() +
          ' amount=' + amount)
      }

      const channelAmount = util.xrpToDrops(this._paychan.amount)
      if (new BigNumber(amount).gt(channelAmount)) {
        debug('got claim for amount larger than max. amount=' + amount,
          'max=' + channelAmount)
        throw new Error('got claim for amount larger than max. amount=' + amount +
          ' max=' + channelAmount)
      }

      try {
        nacl.sign.detached.verify(
          encodedClaim,
          Buffer.from(signature, 'hex'),
          Buffer.from(this._paychan.publicKey.substring(2), 'hex')
        )
      } catch (err) {
        debug('invalid claim signature for', amount)
        throw new Error('Invalid claim signature for: ' + amount)
      }

      debug('got new best claim for', amount)
      this._bestClaim = { amount, signature }

      if (this._store) {
        this._writeQueue = this._writeQueue.then(() => {
          return this._store.put(this._clientChannel, JSON.stringify(this._bestClaim))
        })
      }

      if (this._moneyHandler) {
        await this._moneyHandler(addedMoney.toString())
      }
    }

    return []
  }
}

Plugin.version = 2
module.exports = Plugin
