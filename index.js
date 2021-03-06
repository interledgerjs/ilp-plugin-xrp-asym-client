'use strict'

const { URL } = require('url')
const { deriveAddress, deriveKeypair } = require('ripple-keypairs')
const { RippleAPI } = require('ripple-lib')
const BtpPacket = require('btp-packet')
const BigNumber = require('bignumber.js')
const debug = require('debug')
const BtpPlugin = require('ilp-plugin-btp')
const sodium = require('sodium-universal')
const OUTGOING_CHANNEL_DEFAULT_AMOUNT_XRP = '10' // TODO: something lower?
const {
  util,
  ChannelWatcher
} = require('ilp-plugin-xrp-paychan-shared')

const createLogger = require('ilp-logger')

const DEBUG_NAMESPACE = 'ilp-plugin-xrp-asym-client'

class Plugin extends BtpPlugin {
  constructor (opts, { log, store } = {}) {
    // derive secret from HMAC of host and ripple secret, unless specified already
    const parsedServer = new URL(opts.server)
    parsedServer.password = parsedServer.password ||
      util.hmac(util.hmac('parent_btp_uri', parsedServer.host + parsedServer.username),
        opts.secret).toString('hex')
    const server = parsedServer.href

    if (opts.assetScale && opts.currencyScale) {
      throw new Error('opts.assetScale is an alias for opts.currencyScale;' +
        'only one must be specified')
    }

    const currencyScale = opts.assetScale || opts.currencyScale

    if (typeof currencyScale !== 'number' && currencyScale !== undefined) {
      throw new Error('currency scale must be a number if specified.' +
        ' type=' + (typeof currencyScale) +
        ' value=' + currencyScale)
    }

    super(Object.assign({}, opts, { server }))
    this._currencyScale = (typeof currencyScale === 'number') ? currencyScale : 6

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
    this._outgoingChannelAmountXRP = opts.outgoingChannelAmountXRP || OUTGOING_CHANNEL_DEFAULT_AMOUNT_XRP
    this._maxFeePercent = opts.maxFeePercent || '0.01'

    // optional
    this._store = store || opts.store
    this._writeQueue = Promise.resolve()

    this._log = log || createLogger(DEBUG_NAMESPACE)
    this._log.trace = this._log.trace || debug(this._log.debug.namespace + ':trace')
    this._ws = null

    // this.on('incoming_reject', this._handleIncomingReject.bind(this))
  }

  xrpToBase (amount) {
    return new BigNumber(amount)
      .times(Math.pow(10, this._currencyScale))
      .toString()
  }

  baseToXrp (amount) {
    return new BigNumber(amount)
      .div(Math.pow(10, this._currencyScale))
      .toFixed(6, BigNumber.ROUND_UP)
  }

  sendTransfer () {}

  async _createOutgoingChannel () {
    const amount = this._outgoingChannelAmountXRP
    this._log.info('creating outgoing channel. from=%s to=%s amount=%s', this._address, this._peerAddress, amount)
    const txTag = util.randomTag()
    const tx = await this._api.preparePaymentChannelCreate(this._address, {
      amount,
      destination: this._peerAddress,
      settleDelay: util.MIN_SETTLE_DELAY,
      publicKey: 'ED' + this._keyPair.publicKey.toString('hex').toUpperCase(),
      sourceTag: txTag
    })

    this._log.trace('signing transaction')
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = await this._api.submit(signedTx.signedTransaction)

    this._log.trace('submitted outgoing channel tx to validator')
    if (result.resultCode !== 'tesSUCCESS') {
      const message = 'failed to create the payment channel from ' + this._address + ' to ' + this._peerAddress + ' with ' + this._outgoingChannelAmountXRP + ' XRP: ' + result.resultCode + ' ' + result.resultMessage
      this._log.error(message)
      return
    }

    // TODO: make a generic version of the code that submits these things
    this._log.trace('waiting for transaction to be added to the ledger')
    return new Promise((resolve) => {
      const handleTransaction = (ev) => {
        if (ev.transaction.SourceTag !== txTag) return
        if (ev.transaction.Account !== this._address) return

        this._log.info('transaction complete')
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
    this._log.trace('got info:', info)

    // if the info is from an old version and we use a non-default scale, or the versions match and our scales don't match
    if ((info.currencyScale || 6) !== this._currencyScale) {
      throw new Error('Fatal! Currency scale mismatch. this=' + this._currencyScale +
        ' peer=' + (info.currencyScale || 6))
    }

    this._account = info.account
    this._prefix = info.prefix
    this._channel = info.channel
    this._clientChannel = info.clientChannel
    this._peerAddress = info.address
    const keyPairHolder = {
      publicKey: Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES),
      secretKey: Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)
    }
    sodium.crypto_sign_seed_keypair(
      keyPairHolder.publicKey,
      keyPairHolder.secretKey,
      util.hmac(
        this._secret,
        'ilp-plugin-xrp-stateless' + this._peerAddress
      )
    )
    this._keyPair = keyPairHolder

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
      this._log.info('channel closing; triggering auto-disconnect')
      // TODO: should we also close our own channel?
      this._disconnect()
    })

    // TODO: is this an attack vector, if not telling the plugin about their channel
    // causes them to open another channel?

    const channelProtocolData = []
    if (!this._channel) {
      this._channel = await this._createOutgoingChannel()

      const encodedChannel = util.encodeChannelProof(this._channel, this._account)
      const channelSignature = Buffer.alloc(sodium.crypto_sign_BYTES)
      sodium.crypto_sign_detached(channelSignature, encodedChannel, this._keyPair.secretKey)

      channelProtocolData.push({
        protocolName: 'channel',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from(this._channel, 'hex')
      }, {
        protocolName: 'channel_signature',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: channelSignature
      })
    }

    // used to make sure we don't go over the limit
    this._channelDetails = await this._api.getPaymentChannel(this._channel)

    if (!this._clientChannel) {
      this._log.trace('no client channel has been established; requesting')
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
        amount: this.xrpToBase(this._paychan.balance)
      }

      // load the best claim from the crash cache
      if (this._store) {
        const bestClaimJson = await this._store.get(this._clientChannel)

        if (bestClaimJson) {
          const bestClaim = JSON.parse(bestClaimJson)
          if (bestClaim.amount > this._bestClaim) {
            this._bestClaim = bestClaim
            // TODO: should it submit the recovered claim right away or wait?
          }
        }
      }

      this._log.trace('setting claim interval on channel.')
      this._lastClaimedAmount = new BigNumber(this.xrpToBase(this._paychan.balance))
      this._claimIntervalId = setInterval(async () => {
        try {
          await this._autoClaim()
        } catch (e) {
          this._log.error('error during auto-claim. error=' + e.stack)
        }
      }, this._claimInterval)

      this._log.trace('loaded best claim (on clientChannel) of', this._bestClaim)
      this._watcher.watch(this._clientChannel)
    }

    // finished the connect process
    this._log.info('connected asym client plugin')
  }

  async _disconnect () {
    if (this._funding) {
      await this._funding
    }

    if (this._store) {
      await this._writeQueue
    }

    // runs autoclaim in order to ensure that this claim is profitable
    await this._autoClaim()

    clearInterval(this._claimIntervalId)
    this._log.info('disconnected.')
  }

  async _getClaimFeeInfo () {
    const income = new BigNumber(this._bestClaim.amount).minus(this._lastClaimedAmount)
    const maxFee = await this._api.getFee()
    const fee = new BigNumber(this.xrpToBase(maxFee))

    this._log.trace('checking if claim is profitable. claim=' + this._bestClaim.amount +
      ' lastClaimedAmount=' + this._lastClaimedAmount.toString() +
      ' income=' + income.toString() +
      ' fee=' + fee.toString() +
      ' maxFeePercent=' + this._maxFeePercent)

    const profitable = income.isGreaterThan(0) && fee.dividedBy(income).lte(this._maxFeePercent)

    return {
      profitable,
      maxFee
    }
  }

  async _autoClaim () {
    if (this._bestClaim.amount === '0') return
    if (this._bestClaim.amount === this.xrpToBase(this._paychan.balance)) return

    const feeResult = await this._getClaimFeeInfo()
    if (!feeResult.profitable) {
      return
    }

    return this._claimFunds(feeResult)
  }

  async _claimFunds ({ maxFee }) {
    if (this._bestClaim.amount === '0') return
    if (this._bestClaim.amount === this.xrpToBase(this._paychan.balance)) return
    if (this._lastClaimedAmount.gte(this._bestClaim.amount)) return

    this._log.trace('starting claim. amount=' + this._bestClaim.amount)
    this._lastClaimedAmount = new BigNumber(this._bestClaim.amount)

    this._log.trace('creating claim tx')
    const claimTx = await this._api.preparePaymentChannelClaim(this._address, {
      balance: this.baseToXrp(this._bestClaim.amount),
      channel: this._clientChannel,
      signature: this._bestClaim.signature.toUpperCase(),
      publicKey: this._paychan.publicKey
    }, {
      maxFee
    })

    this._log.trace('signing claim transaction')
    const signedTx = this._api.sign(claimTx.txJSON, this._secret)

    this._log.trace('submitting claim transaction ', claimTx)
    const {resultCode, resultMessage} = await this._api.submit(signedTx.signedTransaction)
    if (resultCode !== 'tesSUCCESS') {
      this._log.error('error submitting claim:', resultMessage)
      throw new Error('Could not claim funds: ' + resultMessage)
    }

    this._log.trace('claimed funds.')
  }

  async _handleData (from, message) {
    const { ilp, protocolMap } = this.protocolDataToIlpAndCustom(message.data)
    const channelProtocol = protocolMap.channel

    if (channelProtocol) {
      this._log.trace('got notification of changing channel details')
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
    if (new BigNumber(transferAmount).isLessThan(0)) {
      throw new Error('Cannot make a new claim which is lower than the last claim.')
    }

    if (new BigNumber(transferAmount).isEqualTo(0)) {
      return
    }

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

    this._log.trace('given last claim (on channel to connector) of', this._lastClaim)

    // If they say we haven't sent them anything yet, it doesn't matter
    // whether they possess a valid claim to say that.
    if (!new BigNumber(this.baseToXrp(this._lastClaim.amount)).isEqualTo(this._channelDetails.balance)) {
      const dropAmount = util.xrpToDrops(this.baseToXrp(this._lastClaim.amount))
      const encodedClaim = util.encodeClaim(dropAmount, this._channel)

      let isValid = false
      try {
        isValid = sodium.crypto_sign_verify_detached(
          Buffer.from(this._lastClaim.signature, 'hex'),
          encodedClaim,
          this._keyPair.publicKey
        )
      } catch (err) {
        this._log.warn('verifying signature failed:', err.message)
      }

      if (!isValid) {
        // TODO: if these get out of sync, all subsequent transfers of money will fail
        this._log.warn('invalid claim signature for', dropAmount)
        throw new Error('Our last outgoing signature for ' + dropAmount + ' is invalid')
      }
    } else {
      this._log.trace('signing claim based on channel balance.')
    }

    const amount = new BigNumber(this._lastClaim.amount).plus(transferAmount).toString()
    const newDropAmount = util.xrpToDrops(this.baseToXrp(amount))
    const newClaimEncoded = util.encodeClaim(newDropAmount, this._channel)
    let signature = Buffer.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(signature, newClaimEncoded, this._keyPair.secretKey)
    signature = signature.toString('hex').toUpperCase()

    const aboveThreshold = new BigNumber(this
      .xrpToBase(this._channelDetails.amount))
      .minus(this.xrpToBase(this._outgoingChannelAmountXRP / 2))
      .lt(amount)

    // if the claim we're signing is for more than half the channel's balance, add some funds
    // TODO: should there be a balance check to make sure we have enough to fund the channel?
    // TODO: should this functionality be enabled by default?
    if (!this._funding && aboveThreshold) {
      this._log.trace('adding funds to channel')
      this._funding = util.fundChannel({
        api: this._api,
        channel: this._channel,
        address: this._address,
        secret: this._secret,
        amount: util.xrpToDrops(this._outgoingChannelAmountXRP)
      })
        .then(async () => {
          // Ensures that a new funding transaction won't be submitted until we
          // update our channel details. Otherwise, many funding transactions
          // could be triggered in quick succession, which is dangerous.
          while (true) {
            try {
              this._channelDetails = await this._api.getPaymentChannel(this._channel)
              debug('reloading channel details after fund. channel=' + this._channel)
              break
            } catch (e) {
              debug('could not reload our channel details. further funding transactions are disabled until this reload is complete to prevent loss of funds. error=', e)
              await new Promise(resolve => setTimeout(resolve, 2000))
            }
          }

          this._funding = false

          const encodedChannel = util.encodeChannelProof(this._channel, this._account)
          const channelSignature = Buffer.alloc(sodium.crypto_sign_BYTES)
          sodium.crypto_sign_detached(channelSignature, encodedChannel, this._keyPair.secretKey)
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
              data: channelSignature
            }] }
          })
        })
        .catch((e) => {
          this._log.error('fund tx/notify failed:', e)
          this._funding = false
        })
    }

    this._log.trace('setting new claim. amount=' + amount)
    this._lastClaim = { amount, signature }

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
      const dropAmount = util.xrpToDrops(this.baseToXrp(amount))
      const encodedClaim = util.encodeClaim(dropAmount, this._clientChannel)
      const addedMoney = new BigNumber(amount).minus(lastAmount)

      if (!addedMoney.isEqualTo(transferAmount)) {
        this._log.warn('warning: peer balance is out of sync with ours. peer thinks they sent ' +
          transferAmount + '; we got ' + addedMoney.toString())
      }

      if (lastAmount.gt(amount)) {
        throw new Error('got claim that was lower than our last claim.' +
          ' lastAmount=' + lastAmount.toString() +
          ' amount=' + amount)
      } else if (lastAmount.eq(amount)) {
        this._log.trace(`got claim for the same amount we had before. lastAmount=${lastAmount}, amount=${amount}`)
        return []
      }

      const channelAmount = util.xrpToDrops(this._paychan.amount)
      if (new BigNumber(dropAmount).gt(channelAmount)) {
        this._log.error('got claim for amount larger than max. amount=' + dropAmount,
          'max=' + channelAmount)
        throw new Error('got claim for amount larger than max. amount=' + dropAmount +
          ' max=' + channelAmount)
      }

      let isValid = false
      try {
        isValid = sodium.crypto_sign_verify_detached(
          Buffer.from(signature, 'hex'),
          encodedClaim,
          Buffer.from(this._paychan.publicKey.substring(2), 'hex')
        )
      } catch (err) {
        this._log.error('signature verification error. err=', err)
      }

      if (!isValid) {
        this._log.error('invalid claim signature for', dropAmount)
        throw new Error('Invalid claim signature for: ' + dropAmount)
      }

      this._log.trace('got new best claim for', amount)
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
Plugin.OUTGOING_CHANNEL_DEFAULT_AMOUNT = OUTGOING_CHANNEL_DEFAULT_AMOUNT_XRP
module.exports = Plugin
