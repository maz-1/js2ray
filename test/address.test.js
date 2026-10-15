'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { iptoBuffer, iptoString } = require('../core/utils');

test('address encoding covers IPv4, compressed IPv6 and mapped IPv4', () => {
  for (const [address, hex] of [
    ['127.0.0.1', '7f000001'],
    ['::1', '00000000000000000000000000000001'],
    ['2001:db8::2', '20010db8000000000000000000000002'],
    ['::ffff:192.0.2.1', '00000000000000000000ffffc0000201'],
  ]) {
    const bytes = iptoBuffer(address);
    assert.equal(bytes.toString('hex'), hex);
    assert.deepEqual(iptoBuffer(iptoString(bytes)), bytes);
  }
  assert.throws(() => iptoBuffer('999.1.1.1'), TypeError);
  assert.throws(() => iptoBuffer('::1', Buffer.alloc(4)), RangeError);
  assert.throws(() => iptoString(Buffer.alloc(5)), RangeError);
});
