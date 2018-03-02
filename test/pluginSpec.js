'use strict' /* eslint-env mocha */

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const sinon = require('sinon')

const Plugin = require('..')
const {
  util
} = require('ilp-plugin-xrp-paychan-shared')

describe('pluginSpec', () => {
  describe('constructor', () => {
    beforeEach(() => {
      this.opts = {
        server: 'btp+wss://user:pass@connector.example',
        address: 'rPhQwMHJ59iiN8FAcuksX4JquLtH8U13su',
        secret: 'spjBz26efRCvtWUMoDNDuKshydEGU'
      }
    })

    it('derives default password from ripple secret', () => {
      const makeBtpUrl = (pass) => `btp+wss://user:${pass}@connector.example`
      this.opts.server = makeBtpUrl('')
      const p = new Plugin(this.opts)
      const expectedPass = util.hmac(util.hmac('parent_btp_uri', 'connector.example' + 'user'),
        this.opts.secret).toString('hex')
      assert.equal(p._server, makeBtpUrl(expectedPass))
    })
  })

  describe('sendMoney', () => {
    it('verifies signature of last claim', () => {
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
})
