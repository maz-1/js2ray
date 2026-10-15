'use strict';
const crypto = require('node:crypto');
const { StreamReader } = require('../../runtime/reader');
const { write } = require('../../runtime/streams');
const { failure } = require('../../runtime/errors');
const wire = require('./wire');
const keys = require('./crypto');
const certs = require('./certificate');
const { u16, u24, vector, message, extension, record, Cursor, hello, readRecord } = wire;
const retryRandom = Buffer.from(
  'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c',
  'hex',
);
const context = Buffer.concat([
  Buffer.alloc(64, 32),
  Buffer.from('TLS 1.3, server CertificateVerify\0'),
]);
function clientHello(config, pair, { now = Date.now(), suite = 0x1301, onlySuite = false } = {}) {
  const random = crypto.randomBytes(32);
  const name = Buffer.from(config.serverName, 'ascii');
  let ciphers = Buffer.concat([
    u16(suite),
    ...(onlySuite ? [] : [0x1301, 0x1302, 0x1303].filter((id) => id !== suite).map(u16)),
  ]);
  let extensions = Buffer.concat([
    extension(0, vector(Buffer.concat([Buffer.from([0]), vector(name)]))),
    extension(10, vector(u16(29))),
    extension(13, vector(Buffer.from('08070403080408050806040105010601', 'hex'))),
    extension(43, Buffer.from([2, 3, 4])),
    extension(51, vector(Buffer.concat([u16(29), vector(pair.publicKey)]))),
    extension(16, vector(Buffer.from([2, 104, 50, 8, 104, 116, 116, 112, 47, 49, 46, 49]))),
    extension(45, Buffer.from([1, 1])),
  ]);
  if (config.fingerprint)
    ({ ciphers, extensions } = require('./hello').chrome120(name, pair.publicKey));
  const result = message(
    1,
    Buffer.concat([
      u16(0x0303),
      random,
      Buffer.from([32]),
      Buffer.alloc(32),
      vector(ciphers),
      Buffer.from([1, 0]),
      vector(extensions),
    ]),
  );
  const shared = keys.exchange(pair.privateKey, Buffer.from(config.publicKey, 'base64url'));
  const auth = keys.authKey(shared, random);
  shared.fill(0);
  const payload = Buffer.alloc(16);
  Buffer.from((config.clientVersion ?? '4.0.0').split('.').map(Number)).copy(payload);
  payload.writeUInt32BE(Math.floor(now / 1000), 4);
  Buffer.from(config.shortId, 'hex').copy(payload, 8);
  keys
    .authSeal(
      auth,
      random,
      payload,
      result,
      !config.fingerprint && suite === 0x1303 ? 'chacha20-poly1305' : 'aes-256-gcm',
    )
    .copy(result, 39);
  return { hello: result, auth };
}
function authenticate(bytes, config, now = Date.now()) {
  let auth;
  try {
    const parsed = hello(bytes);
    const versions = parsed.extensions.get(43);
    const share = parsed.shares.find((share) => share.group === 29 && share.data.length === 32);
    if (
      parsed.sessionId.length !== 32 ||
      !versions ||
      !new Cursor(versions).vector(1).includes(Buffer.from([3, 4])) ||
      !share ||
      !config.serverNames.includes(parsed.serverName)
    )
      return undefined;
    const shared = keys.exchange(
      keys.privateKey(Buffer.from(config.privateKey, 'base64url')),
      share.data,
    );
    auth = keys.authKey(shared, parsed.random);
    shared.fill(0);
    const aad = Buffer.from(bytes);
    aad.fill(0, 39, 71);
    let first;
    for (let offset = 0; offset + 2 <= parsed.ciphers.length; offset += 2) {
      const id = parsed.ciphers.readUInt16BE(offset);
      if (keys.suites[id]) {
        first = id;
        break;
      }
    }
    const payload = keys.authOpen(
      auth,
      parsed.random,
      parsed.sessionId,
      aad,
      first === 0x1303 ? 'chacha20-poly1305' : 'aes-256-gcm',
    );
    const timestamp = payload.readUInt32BE(4) * 1000;
    const shortId = payload.subarray(8).toString('hex');
    const version = [...payload.subarray(0, 3)].join('.');
    const compare = require('../../config/reality').compare;
    if (
      !config.shortIds.some((id) => id.padEnd(16, '0') === shortId) ||
      (config.maxTimeDiff && Math.abs(now - timestamp) > config.maxTimeDiff) ||
      (config.minClientVer && compare(version, config.minClientVer) < 0) ||
      (config.maxClientVer && compare(version, config.maxClientVer) > 0)
    ) {
      auth.fill(0);
      return undefined;
    }
    return { parsed, auth, share, version: [...payload.subarray(0, 3)], timestamp, shortId };
  } catch {
    auth?.fill(0);
    return undefined;
  }
}
function reader(socket, options = {}) {
  return new StreamReader(socket, {
    signal: options.signal,
    timeoutMs: options.handshakeTimeoutMs ?? 10000,
    maxBytes: options.maxBufferBytes ?? 1048576,
    onRead: options.onRead,
  });
}
async function readHello(input, server = false) {
  let bytes = Buffer.alloc(0),
    records = [];
  while (bytes.length < 4 || bytes.length < 4 + bytes.readUIntBE(1, 3)) {
    const part = await readRecord(input);
    records.push(part);
    if (part[0] !== 22) throw failure('ERR_TLS', 'Expected TLS hello record.', 'reality');
    bytes = Buffer.concat([bytes, part.subarray(5)]);
    if (bytes.length > 65536) throw failure('ERR_LIMIT', 'TLS hello exceeds its limit.', 'reality');
  }
  const parsed = hello(bytes, server);
  return { parsed, bytes, records: Buffer.concat(records) };
}
function validateServer(parsed, client) {
  const suiteId = parsed.ciphers.readUInt16BE(),
    suite = keys.suites[suiteId];
  const share = parsed.shares[0];
  const offered = Array.from({ length: client.ciphers.length / 2 }, (_, i) =>
    client.ciphers.readUInt16BE(2 * i),
  );
  if (
    !suite ||
    !offered.includes(suiteId) ||
    parsed.compression[0] !== 0 ||
    !parsed.sessionId.equals(client.sessionId) ||
    parsed.random.equals(retryRandom) ||
    !parsed.extensions.get(43)?.equals(Buffer.from([3, 4])) ||
    parsed.shares.length !== 1 ||
    share.group !== 29 ||
    share.data.length !== 32 ||
    [...parsed.extensions.keys()].some((type) => ![43, 51].includes(type))
  )
    throw failure('ERR_TLS', 'Unsupported REALITY TLS server parameters.', 'reality');
  return { suite, share };
}
function appKeys(suite, master, transcript, server = false) {
  const tx = new keys.TrafficKey(
    suite,
    keys.derive(suite, master, server ? 's ap traffic' : 'c ap traffic', transcript),
  );
  const rx = new keys.TrafficKey(
    suite,
    keys.derive(suite, master, server ? 'c ap traffic' : 's ap traffic', transcript),
  );
  return { tx, rx };
}
function minimumFlight(suite, layout) {
  const certificate = certs.certificate(certs.identity(), Buffer.alloc(32));
  const sizes = [6, certificate.length + 13, 72, suite.size + 4];
  return layout === 'single'
    ? [sizes.reduce((sum, size) => sum + size, 0) + 22]
    : sizes.map((size) => size + 22);
}
async function targetFlight(input, client) {
  const template = await readHello(input, true);
  const { suite, share } = validateServer(template.parsed, client);
  const ccs = await readRecord(input);
  if (ccs[0] !== 20 || !ccs.subarray(5).equals(Buffer.from([1])))
    throw failure('ERR_TLS', 'REALITY target requires a TLS 1.3 compatibility flight.', 'reality');
  const first = await readRecord(input);
  if (first[0] !== 23) throw failure('ERR_TLS', 'Invalid REALITY target flight.', 'reality');
  const lengths = [first.length];
  if (first.length <= 512)
    for (let i = 0; i < 3; i++) {
      const next = await readRecord(input);
      if (next[0] !== 23)
        throw failure('ERR_TLS', 'Invalid REALITY target record layout.', 'reality');
      lengths.push(next.length);
    }
  const layout = lengths.length === 1 ? 'single' : 'four',
    requiredLengths = minimumFlight(suite, layout);
  if (lengths.some((size, index) => size < requiredLengths[index]))
    throw failure(
      'ERR_TLS',
      'REALITY target records cannot contain the authenticated flight.',
      'reality',
    );
  return { template, suite, share, ccs, lengths, layout, requiredLengths };
}
async function client(socket, config, options = {}) {
  const pair = keys.keyPair(),
    own = clientHello(config, pair, options);
  const input = reader(socket, options);
  let tx, rx, master;
  try {
    const flight = record(22, own.hello);
    flight[2] = 1;
    await write(socket, flight);
    const received = await readHello(input, true);
    const { suite, share } = validateServer(received.parsed, hello(own.hello));
    let transcript = Buffer.concat([own.hello, received.bytes]);
    const shared = keys.exchange(pair.privateKey, share.data);
    const derived = keys.secrets(suite, shared, transcript);
    shared.fill(0);
    master = derived.master;
    tx = new keys.TrafficKey(suite, derived.client);
    rx = new keys.TrafficKey(suite, derived.server);
    let buffer = Buffer.alloc(0),
      stage = 0,
      publicKey;
    while (stage < 4) {
      const raw = await readRecord(input);
      if (raw[0] === 20 && raw.subarray(5).equals(Buffer.from([1]))) continue;
      if (raw[0] !== 23) throw failure('ERR_TLS', 'REALITY TLS handshake was rejected.', 'reality');
      const opened = rx.open(raw);
      if (opened.type !== 22)
        throw failure('ERR_TLS', 'Unexpected TLS handshake record type.', 'reality');
      buffer = Buffer.concat([buffer, opened.data]);
      if (
        buffer.length >= 4 &&
        4 + buffer.readUIntBE(1, 3) > Math.min(options.maxBufferBytes ?? 1048576, 65536)
      )
        throw failure('ERR_LIMIT', 'TLS handshake message exceeds its limit.', 'reality');
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUIntBE(1, 3)) {
        const item = buffer.subarray(0, 4 + buffer.readUIntBE(1, 3));
        buffer = buffer.subarray(item.length);
        const compressed = stage === 1 && item[0] === 25 && config.fingerprint;
        if (item[0] !== [8, 11, 15, 20][stage] && !compressed)
          throw failure('ERR_TLS', 'Unexpected REALITY handshake sequence.', 'reality');
        let content = item.subarray(4);
        if (compressed) {
          const packed = new Cursor(content);
          if (packed.word() !== 2)
            throw failure('ERR_TLS', 'Unadvertised certificate compression.', 'reality');
          const size = packed.take(3).readUIntBE(0, 3);
          if (!size || size + 4 > Math.min(options.maxBufferBytes ?? 1048576, 65536))
            throw failure('ERR_LIMIT', 'Compressed certificate exceeds its limit.', 'reality');
          content = require('node:zlib').brotliDecompressSync(packed.vector(3), {
            maxOutputLength: size,
          });
          packed.done();
          if (content.length !== size)
            throw failure('ERR_TLS', 'Invalid decompressed certificate length.', 'reality');
        }
        const body = new Cursor(content);
        if (stage === 0) {
          wire.extensions(body.vector());
          body.done();
        }
        if (stage === 1) {
          if (body.vector(1).length)
            throw failure('ERR_TLS', 'Unexpected TLS certificate context.', 'reality');
          const certificates = new Cursor(body.vector(3));
          body.done();
          const certificate = certificates.vector(3);
          certificates.vector();
          certificates.done();
          publicKey = certs.verifyCertificate(certificate, own.auth);
        }
        if (stage === 2) {
          if (
            body.word() !== 0x0807 ||
            !crypto.verify(
              null,
              Buffer.concat([context, keys.hash(suite, transcript)]),
              publicKey,
              body.vector(),
            )
          )
            throw failure('ERR_AUTH', 'REALITY CertificateVerify rejected.', 'reality');
          body.done();
        }
        if (stage === 3) {
          const expected = keys.finished(suite, rx.secret, transcript);
          if (
            item.length !== expected.length + 4 ||
            !crypto.timingSafeEqual(item.subarray(4), expected)
          )
            throw failure('ERR_AUTH', 'REALITY Finished rejected.', 'reality');
        }
        transcript = Buffer.concat([transcript, item]);
        stage++;
        if (stage === 4 && buffer.length)
          throw failure('ERR_TLS', 'Trailing TLS handshake bytes.', 'reality');
      }
    }
    const final = message(20, keys.finished(suite, tx.secret, transcript));
    await write(socket, Buffer.concat([record(20, Buffer.from([1])), tx.seal(22, final)]));
    return { ...appKeys(suite, master, transcript), suite, authenticated: true };
  } finally {
    own.auth.fill(0);
    tx?.destroy();
    rx?.destroy();
    master?.fill(0);
  }
}

async function server(socket, config, target, options = {}) {
  const captured = [];
  const input = reader(socket, { ...options, onRead: (data) => captured.push(data) }),
    targetInput = reader(target, options);
  let incoming, auth;
  try {
    incoming = await readHello(input);
    auth = authenticate(incoming.bytes, config);
  } catch (error) {
    if (['ERR_TIMEOUT', 'ERR_CANCELLED', 'ERR_LIMIT'].includes(error.code)) throw error;
  }
  let tx, rx, master;
  try {
    await write(target, Buffer.concat(captured));
    captured.length = 0;
    input.onRead = undefined;
    if (!auth) return { fallback: true };
    const { template, suite, share, ccs, lengths } = await targetFlight(
      targetInput,
      incoming.parsed,
    );
    const pair = keys.keyPair();
    pair.publicKey.copy(share.data);
    const serverHello = template.bytes;
    let transcript = Buffer.concat([incoming.bytes, serverHello]);
    const shared = keys.exchange(pair.privateKey, auth.share.data);
    const derived = keys.secrets(suite, shared, transcript);
    shared.fill(0);
    master = derived.master;
    tx = new keys.TrafficKey(suite, derived.server);
    rx = new keys.TrafficKey(suite, derived.client);
    const identity = certs.identity();
    const certificate = certs.certificate(identity, auth.auth);
    const messages = [];
    const add = (item) => {
      transcript = Buffer.concat([transcript, item]);
      messages.push(item);
    };
    add(message(8, Buffer.from([0, 0])));
    add(
      message(
        11,
        Buffer.concat([
          Buffer.from([0]),
          u24(certificate.length + 5),
          u24(certificate.length),
          certificate,
          Buffer.from([0, 0]),
        ]),
      ),
    );
    add(
      message(
        15,
        Buffer.concat([
          u16(0x0807),
          vector(
            crypto.sign(
              null,
              Buffer.concat([context, keys.hash(suite, transcript)]),
              identity.privateKey,
            ),
          ),
        ]),
      ),
    );
    add(message(20, keys.finished(suite, tx.secret, transcript)));
    const encrypted =
      lengths.length === 1
        ? [tx.seal(22, Buffer.concat(messages), lengths[0])]
        : messages.map((item, index) => tx.seal(22, item, lengths[index]));
    await write(socket, Buffer.concat([record(22, serverHello), ccs, ...encrypted]));
    let final = Buffer.alloc(0);
    const expected = message(20, keys.finished(suite, rx.secret, transcript));
    for (;;) {
      const raw = await readRecord(input);
      if (raw[0] === 20 && raw.subarray(5).equals(Buffer.from([1]))) continue;
      const opened = rx.open(raw);
      if (opened.type !== 22)
        throw failure('ERR_AUTH', 'REALITY client Finished rejected.', 'reality');
      final = Buffer.concat([final, opened.data]);
      if (final.length >= expected.length) break;
    }
    if (final.length !== expected.length || !crypto.timingSafeEqual(final, expected))
      throw failure('ERR_AUTH', 'REALITY client Finished rejected.', 'reality');
    return {
      ...appKeys(suite, master, transcript, true),
      suite,
      authenticated: true,
      mirroredLengths: [serverHello.length + 5, ccs.length, ...lengths],
    };
  } finally {
    auth?.auth.fill(0);
    tx?.destroy();
    rx?.destroy();
    master?.fill(0);
  }
}
module.exports = { clientHello, authenticate, client, server, reader, readHello, targetFlight };
