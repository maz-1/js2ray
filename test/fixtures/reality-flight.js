'use strict';
// A controlled TLS 1.3 peer provides independently selectable handshake records
// and faults. It is test-only; no fault controls are exposed by the product.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const net = require('node:net');
const keys = require('../../transports/reality/crypto');
const certs = require('../../transports/reality/certificate');
const handshake = require('../../transports/reality/handshake');
const wire = require('../../transports/reality/wire');
const fixture = require('./reality');
const { write } = require('../../runtime/streams');
const { listen } = require('../helpers');
const context = Buffer.concat([
  Buffer.alloc(64, 32),
  Buffer.from('TLS 1.3, server CertificateVerify\0'),
]);
const retryRandom = Buffer.from(
  'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c',
  'hex',
);
function flight(
  clientHello,
  { suite = 0x1301, fault, compression = false, layout = 'single', seed = 1 } = {},
) {
  const parsed = wire.hello(clientHello),
    pair = keys.keyPair(),
    selected = keys.suites[suite];
  const share = parsed.shares.find((share) => share.group === 29);
  const serverHello = wire.message(
    2,
    Buffer.concat([
      wire.u16(0x0303),
      fault === 'hrr' ? retryRandom : crypto.randomBytes(32),
      Buffer.from([32]),
      parsed.sessionId,
      wire.u16(suite),
      Buffer.from([0]),
      wire.vector(
        Buffer.concat([
          wire.extension(43, Buffer.from([3, 4])),
          wire.extension(51, Buffer.concat([wire.u16(29), wire.vector(pair.publicKey)])),
        ]),
      ),
    ]),
  );
  const shared = keys.exchange(pair.privateKey, share.data);
  let transcript = Buffer.concat([clientHello, serverHello]);
  const derived = keys.secrets(selected, shared, transcript);
  shared.fill(0);
  const tx = new keys.TrafficKey(selected, derived.server),
    rx = new keys.TrafficKey(selected, derived.client);
  const auth = handshake.authenticate(clientHello, fixture.server),
    identity = certs.identity();
  const certificate = certs.certificate(identity, auth?.auth ?? crypto.randomBytes(32));
  auth?.auth.fill(0);
  if (fault === 'certificate') certificate[certificate.length - 1] ^= 1;
  const certificateBody = Buffer.concat([
    Buffer.from([0]),
    wire.u24(certificate.length + 5),
    wire.u24(certificate.length),
    certificate,
    Buffer.from([0, 0]),
  ]);
  let certMessage = wire.message(11, certificateBody);
  if (compression || fault?.startsWith('compression')) {
    let body = certificateBody,
      size = body.length,
      algorithm = 2;
    if (fault === 'compression-bomb') {
      body = Buffer.alloc(1000000);
      size = 128;
    }
    if (fault === 'compression-limit') size = 65536;
    if (fault === 'compression-length') size++;
    if (fault === 'compression-algorithm') algorithm = 1;
    let packed = zlib.brotliCompressSync(body);
    if (fault === 'compression-corrupt') packed = Buffer.from([255, 255, 255]);
    certMessage = wire.message(
      25,
      Buffer.concat([wire.u16(algorithm), wire.u24(size), wire.u24(packed.length), packed]),
    );
  }
  const messages = [];
  const add = (message) => {
    messages.push(message);
    transcript = Buffer.concat([transcript, message]);
  };
  add(wire.message(8, Buffer.from([0, 0])));
  add(certMessage);
  const signature = crypto.sign(
    null,
    Buffer.concat([context, keys.hash(selected, transcript)]),
    identity.privateKey,
  );
  if (fault === 'verify') signature[0] ^= 1;
  add(wire.message(15, Buffer.concat([wire.u16(0x0807), wire.vector(signature)])));
  const finished = keys.finished(selected, tx.secret, transcript);
  if (fault === 'finished') finished[0] ^= 1;
  add(wire.message(20, finished));
  let parts = messages;
  if (layout === 'single') parts = [Buffer.concat(messages)];
  if (layout === 'fragmented') {
    parts = [];
    const all = Buffer.concat(messages);
    let offset = 0,
      state = seed;
    while (offset < all.length) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const size = 1 + (state % 47);
      parts.push(all.subarray(offset, offset + size));
      offset += size;
    }
  }
  const records = parts.map((part, index) =>
    tx.seal(
      22,
      part,
      layout === 'four' ? [64, 1536, 512, 128][index] : layout === 'single' ? 2048 : 0,
    ),
  );
  if (fault === 'space') records[0] = wire.record(23, Buffer.alloc(10));
  const bytes = Buffer.concat([
    wire.record(22, serverHello),
    ...(fault === 'ccs' ? [] : [wire.record(20, Buffer.from([1]))]),
    ...records,
  ]);
  return {
    bytes,
    serverHello,
    transcript,
    tx,
    rx,
    master: derived.master,
    suite: selected,
    records,
    destroy() {
      tx.destroy();
      rx.destroy();
      derived.master.fill(0);
    },
  };
}
async function controlled(t, options = {}) {
  const sockets = new Set(),
    evidence = { receivedAfterFlight: 0, helloBytes: 0 };
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const server = net.createServer({ allowHalfOpen: true }, async (raw) => {
    sockets.add(raw);
    raw.on('error', () => {});
    raw.once('end', () => raw.destroy());
    raw.once('close', () => {
      sockets.delete(raw);
      finish();
    });
    let built;
    try {
      const input = handshake.reader(raw, { handshakeTimeoutMs: 2000 });
      const incoming = await handshake.readHello(input);
      evidence.helloBytes = incoming.bytes.length;
      built = flight(incoming.bytes, options);
      evidence.recordLengths = built.records.map((record) => record.length);
      let bytes = built.bytes;
      if (options.fault === 'disconnect') bytes = bytes.subarray(0, bytes.length - 10);
      if (options.networkFragments) {
        for (let n = 0; n < bytes.length; n += 13) await write(raw, bytes.subarray(n, n + 13));
      } else await write(raw, bytes);
      raw.on('data', (chunk) => {
        evidence.receivedAfterFlight += chunk.length;
      });
      raw.resume();
      if (options.fault === 'disconnect') raw.end();
    } catch (error) {
      evidence.errorCode = error.code;
      raw.destroy();
    } finally {
      built?.destroy();
    }
  });
  const port = await listen(server);
  t.after(() => {
    for (const raw of sockets) raw.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return { port, evidence, done };
}
module.exports = { flight, controlled, context };
