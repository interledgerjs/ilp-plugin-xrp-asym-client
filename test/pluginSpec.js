'use strict' /* eslint-env mocha */

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert

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
})
