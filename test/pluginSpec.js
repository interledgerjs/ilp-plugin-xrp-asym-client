'use strict' /* eslint-env mocha */

const sinon = require('sinon')
const BigNumber = require('bignumber.js')
const Plugin = require('..')
const BtpPacket = require('btp-packet')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const nacl = require('tweetnacl')

const {
  util
} = require('ilp-plugin-xrp-paychan-shared')

describe('pluginSpec', () => {
  beforeEach(function () {
    this.sinon = sinon.sandbox.create()
    this.opts = {
      server: 'btp+wss://user:pass@connector.example',
      address: 'rPhQwMHJ59iiN8FAcuksX4JquLtH8U13su',
      secret: 'spjBz26efRCvtWUMoDNDuKshydEGU'
    }
  })

  afterEach(function () {
    this.sinon.restore()
  })

  describe('constructor', () => {
    it('derives default password from ripple secret', function () {
      const makeBtpUrl = (pass) => `btp+wss://user:${pass}@connector.example`
      this.opts.server = makeBtpUrl('')
      const p = new Plugin(this.opts)
      const expectedPass = util.hmac(util.hmac('parent_btp_uri', 'connector.example' + 'user'),
        this.opts.secret).toString('hex')
      assert.equal(p._server, makeBtpUrl(expectedPass))
    })

    it('throws if currencyScale is neither defined nor a number', function () {
      this.opts.currencyScale = 'awdiomawdiow'
      assert.throws(() => new Plugin(this.opts),
        /currency scale must be a number if specified/)
    })
  })

  describe('_connect', () => {
    beforeEach(function () {
      this.opts.currencyScale = 9
      this.plugin = new Plugin(this.opts)
    })

    it('should throw if currencyScale does not match info', async function () {
      this.sinon.stub(this.plugin, '_call').resolves({ protocolData: [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          currencyScale: 8
        }))
      }]})

      await assert.isRejected(
        this.plugin._connect(),
        /Fatal! Currency scale mismatch/)
    })
  })

  describe('autoClaim', () => {
    beforeEach(function () {
      this.plugin = new Plugin(this.opts)
      this.plugin._api = { getFee: () => Promise.resolve('0.000010') }
      this.claimStub = this.sinon.stub(this.plugin, '_claimFunds').resolves()
      this.isClaimProfitableSpy = this.sinon.spy(this.plugin, '_isClaimProfitable')

      this.plugin._lastClaimedAmount = new BigNumber('0')
      this.plugin._paychan = this.plugin._channelDetails = {
        amount: '10',
        balance: '0.000000',
        publicKey: 'edabcdef'
      }
      this.plugin._bestClaim = this.plugin._lastClaim = {
        amount: '1',
        signature: 'abcdef'
      }
    })

    it('should not claim if the income is <100x fee', async function () {
      await this.plugin._autoClaim()

      assert.isFalse(this.claimStub.called, 'claim should not be called')
      assert.isTrue(this.isClaimProfitableSpy.calledOnce, 'should check profitability')
    })

    it('should claim if the income is >100x fee', async function () {
      this.plugin._bestClaim.amount = '1000'
      await this.plugin._autoClaim()

      assert.isTrue(this.claimStub.called, 'claim should be called')
      assert.isTrue(this.isClaimProfitableSpy.calledOnce, 'should check profitability')
      assert.deepEqual(this.claimStub.firstCall.args[0], {
        profitable: true,
        maxFeeXrp: '0.000010'
      }, 'should have called claim with maxFeeXrp')
    })

    describe('with high scale', function () {
      beforeEach(function () {
        this.plugin._currencyScale = 9
      })

      it('should not claim if the income is <100x fee', async function () {
        this.plugin._bestClaim.amount = '1000'
        await this.plugin._autoClaim()

        assert.isFalse(this.claimStub.called, 'claim should not be called')
        assert.isTrue(this.isClaimProfitableSpy.calledOnce, 'should check profitability')
      })

      it('should claim if the income is >100x fee', async function () {
        this.plugin._bestClaim.amount = '1000000'
        await this.plugin._autoClaim()

        assert.isTrue(this.claimStub.called, 'claim should not be called')
        assert.isTrue(this.isClaimProfitableSpy.calledOnce, 'should check profitability')
        assert.deepEqual(this.claimStub.firstCall.args[0], {
          profitable: true,
          maxFeeXrp: '0.000010'
        }, 'should have called claim with maxFeeXrp')
      })
    })
  })

  describe('sendMoney', () => {
    describe('with high scale', function () {
      beforeEach(function () {
        this.opts.currencyScale = 9
        this.plugin = new Plugin(this.opts)

        this.sinon.stub(nacl.sign, 'detached').returns('abcdef')

        this.plugin._paychan = this.plugin._channelDetails = {
          amount: '10',
          balance: '0.000001',
          publicKey: 'edabcdef'
        }

        this.plugin._keyPair = {}
        this.plugin._funding = true
        this.plugin._channel = 'abcdef'
        this.plugin._clientChannel = 'abcdef'
        this.plugin._bestClaim = this.plugin._lastClaim = {
          amount: '990',
          signature: 'abcdef'
        }
      })

      it('should not do anything if the amount is zero', async function () {
        const encodeSpy = this.sinon.spy(util, 'encodeClaim')
        await this.plugin.sendMoney(0)
        assert.isFalse(encodeSpy.called)
      })

      it('should not throw if last claim is zero', async function () {
        const encodeSpy = this.sinon.spy(util, 'encodeClaim')
        this.plugin._lastClaim.amount = '0'
        this.plugin._channelDetails.balance = '0'
        this.sinon.stub(this.plugin, '_call').resolves(null)

        await this.plugin.sendMoney(100)

        assert.deepEqual(encodeSpy.getCall(0).args, [ '1', 'abcdef' ])
      })

      it('should round high-scale amount up to next drop', async function () {
        const encodeSpy = this.sinon.spy(util, 'encodeClaim')
        this.sinon.stub(this.plugin, '_call').resolves(null)

        await this.plugin.sendMoney(100)

        assert.deepEqual(encodeSpy.getCall(0).args, [ '2', 'abcdef' ])
      })

      it('should keep error under a drop even on repeated roundings', async function () {
        const encodeSpy = this.sinon.spy(util, 'encodeClaim')
        this.sinon.stub(this.plugin, '_call').resolves(null)

        await this.plugin.sendMoney(100)

        // we can't stub verify for some reason so we need to prevent
        // signature verification from happening
        this.plugin._channelDetails.balance = '0.000002'

        await this.plugin.sendMoney(100)

        assert.deepEqual(encodeSpy.getCall(0).args, [ '2', 'abcdef' ])
        assert.deepEqual(encodeSpy.getCall(1).args, [ '2', 'abcdef' ])
      })

      it('should handle a claim', async function () {
        this.sinon.stub(nacl.sign.detached, 'verify').returns(true)
        const encodeSpy = this.sinon.spy(util, 'encodeClaim')

        await this.plugin._handleMoney(null, {
          requestId: 1,
          data: {
            amount: '160',
            protocolData: [{
              protocolName: 'claim',
              contentType: BtpPacket.MIME_APPLICATION_JSON,
              data: Buffer.from(JSON.stringify({
                amount: '1150',
                signature: 'abcdef'
              }))
            }]
          }
        })

        assert.deepEqual(encodeSpy.getCall(0).args, [ '2', 'abcdef' ])
      })
    })

    it('verifies signature of last claim', function () {
      const p = new Plugin(this.opts)
      p._channel = 'ABCDEF1234567890'
      p._channelDetails = {balance: 11}
      sinon.stub(p, '_call').resolves({protocolData: [{
        protocolName: 'last_claim',
        data: Buffer.from(JSON.stringify({
          amount: '3',
          signature: 'AAAAAAA'}))
      }]})
      return assert.isRejected(p.sendMoney(1), 'Our last outgoing signature for 3 is invalid')
    })
  })

  describe('_handleMoney', function () {
    beforeEach(function () {
      this.plugin = new Plugin(this.opts)

      this.sinon.stub(nacl.sign, 'detached').returns('abcdef')

      this.plugin._paychan = this.plugin._channelDetails = {
        amount: '10',
        balance: '0.000001',
        publicKey: 'edabcdef'
      }

      this.plugin._keyPair = {}
      this.plugin._funding = true
      this.plugin._channel = 'abcdef'
      this.plugin._clientChannel = 'abcdef'
      this.plugin._bestClaim = this.plugin._lastClaim = {
        amount: '990',
        signature: 'abcdef'
      }
    })

    it('should throw an error if the claim amount is less than before', async function () {
      assert.isRejected(this.plugin._handleMoney('blah', {
        requestId: 'requestId',
        data: {
          amount: '989',
          protocolData: [{
            protocolName: 'claim',
            data: Buffer.from(JSON.stringify({
              amount: '989',
              signature: 'abcdef'
            }), 'utf8')
          }]
        }
      }), 'got claim that was lower than our last claim. lastAmount=990 amount=989')
    })

    it('should ignore claims for the same amount as the previous ones', async function () {
      assert.isFulfilled(this.plugin._handleMoney('blah', {
        requestId: 'requestId',
        data: {
          amount: '989',
          protocolData: [{
            protocolName: 'claim',
            data: Buffer.from(JSON.stringify({
              amount: '990',
              signature: 'abcdef'
            }), 'utf8')
          }]
        }
      }))
    })
  })
})
