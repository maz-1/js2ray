'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { shake128, encrypt } = require('../protocols/vmess/common');

test('bounded SHAKE reader matches native SHAKE128 across many rate blocks', () => {
  const key = Buffer.from('synthetic-vmess-iv');
  const expected = crypto.createHash('shake128', { outputLength: 100000 }).update(key).digest();
  const generator = shake128(key);
  const parts = [];
  let remaining = expected.length;
  for (let i = 0; remaining; i++) {
    const length = Math.min(remaining, 1 + (i % 511));
    parts.push(generator.nextBytes(length));
    remaining -= length;
  }
  assert.deepEqual(Buffer.concat(parts), expected);
});

test('VMess refuses nonce reuse instead of wrapping to zero', () => {
  assert.throws(() => encrypt(Buffer.alloc(0), { _cipherNonce: 65536 }), { code: 'ERR_LIMIT' });
});
