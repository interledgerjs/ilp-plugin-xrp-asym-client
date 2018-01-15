'use strict'

const chai = require('chai')
chai.use(require('chai-as-promised'))
const assert = chai.assert
const nock = require('nock')

const util = require('../src/lib/util')

describe('isPasswordCompromised', () => {
  afterEach(() => {
    assert(nock.isDone(), 'nock must be called')
  })

  it('checks if password is compromissed', () => {
    nock('https://haveibeenpwned.com')
      .get('/api/v2/pwnedpassword/21bd12dc183f740ee76f27b78eb39c8ad972a757')
      .reply(200)

    return assert.eventually.isTrue(util.isPassCompromised('P@ssw0rd'),
      'Password expected to be compromised')
  })
})
