'use strict';
const { Duplex } = require('node:stream');
const { failure } = require('./errors');
function write(stream, data) {
  return new Promise((resolve, reject) =>
    stream.write(data, (error) => (error ? reject(error) : resolve())),
  );
}
function relay(left, right) {
  left.once('error', (error) => right.destroy(error));
  right.once('error', (error) => left.destroy(error));
  left.once('close', () => closeTransport(right));
  right.once('close', () => closeTransport(left));
  left.pipe(right).pipe(left);
}
const quicGracefulClose = Symbol.for('js2ray.quicGracefulClose');
function closeTransport(stream) {
  if (stream?.[quicGracefulClose] && stream.readableEnded && stream.writableEnded)
    stream[quicGracefulClose]();
  else stream?.destroy();
}
function legacyDuplex(start, { maxBufferBytes }) {
  let connection;
  let transport;
  let connected = false;
  let timeoutMs = 0;
  const stream = new Duplex({
    allowHalfOpen: false,
    read() {
      transport?.resume();
    },
    write(chunk, encoding, callback) {
      try {
        connection.message(chunk);
        if (transport?.writableLength > maxBufferBytes)
          return callback(
            failure('ERR_LIMIT', 'Legacy send queue exceeded its limit.', 'protocol'),
          );
        if (transport?.writableNeedDrain) {
          const done = (error) => {
            transport.removeListener('drain', drained);
            transport.removeListener('close', closed);
            callback(error);
          };
          const drained = () => done();
          const closed = () =>
            done(failure('ERR_CLOSED', 'Transport closed while writing.', 'transport'));
          transport.once('drain', drained);
          transport.once('close', closed);
        } else callback();
      } catch (error) {
        callback(error);
      }
    },
    final(callback) {
      if (transport?.[quicGracefulClose]) return void transport.end(callback);
      transport?.end();
      callback();
    },
    destroy(error, callback) {
      if (
        !error &&
        stream.readableEnded &&
        stream.writableFinished &&
        transport?.[quicGracefulClose]
      )
        closeTransport(transport);
      else {
        connection?.close();
        transport?.destroy();
      }
      callback(error);
    },
  });
  stream.on('error', () => {});
  const ready = new Promise((resolve, reject) => {
    connection = start({
      ready: () => {
        connected = true;
        resolve(stream);
      },
      data: (data) => {
        if (stream.readableLength + data.length > maxBufferBytes)
          stream.destroy(
            failure('ERR_LIMIT', 'Legacy receive queue exceeded its limit.', 'protocol'),
          );
        else if (!stream.push(data)) transport?.pause();
      },
      close: () => {
        if (!connected) {
          reject(failure('ERR_PROTOCOL', 'Legacy protocol connection closed.', 'protocol'));
          stream.destroy();
        } else stream.push(null);
      },
      transport: (value) => {
        transport = value;
        transport.once('end', () => stream.push(null));
        transport.on('timeout', () => stream.emit('timeout'));
        if (timeoutMs) transport.setTimeout(timeoutMs);
      },
    });
  });
  stream.once('close', () => {
    if (stream.readableEnded && stream.writableFinished) closeTransport(transport);
    else transport?.destroy();
  });
  stream.setTimeout = (milliseconds, callback) => {
    timeoutMs = milliseconds;
    if (callback) stream.once('timeout', callback);
    transport?.setTimeout(milliseconds);
    return stream;
  };
  for (const method of ['setNoDelay', 'setKeepAlive', 'ref', 'unref']) {
    stream[method] = (...args) => {
      transport?.[method]?.(...args);
      return stream;
    };
  }
  return { stream, ready };
}
module.exports = { write, relay, legacyDuplex, closeTransport };
