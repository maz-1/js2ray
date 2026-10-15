'use strict';
const { DatagramSession } = require('../../runtime/datagram');
const { failure } = require('../../runtime/errors');
class VMessDatagram extends DatagramSession {
  constructor(client, target, limit) {
    super(target, limit);
    this.pendingBytes = 0;
    this.ready = new Promise((resolve, reject) => {
      this.connection = client(
        target.host,
        target.port,
        2,
        () => resolve(this),
        (data) => this.receive(data),
        () => {
          if (!this.transport)
            reject(failure('ERR_PROTOCOL', 'VMess UDP handshake failed.', 'protocol'));
          this.destroy();
        },
      );
      this.connection.setTransportObserver((stream) => {
        this.transport = stream;
        stream.once('error', (error) => {
          reject(error);
          this.destroy(error);
        });
        stream.once('close', () => this.destroy());
      });
    });
  }
  async send(data, target) {
    this.validate(data, target);
    if (data.length > 65455)
      throw failure('ERR_TARGET', 'VMess UDP payload exceeds 65455 bytes.', 'protocol');
    if (this.pendingBytes + data.length + 128 > this.maxBufferBytes)
      throw failure('ERR_LIMIT', 'VMess UDP send queue exceeded its limit.', 'protocol');
    this.pendingBytes += data.length + 128;
    try {
      this.connection.message(data);
      if (this.transport.writableNeedDrain)
        await new Promise((resolve, reject) => {
          const done = (error) => {
            this.transport.removeListener('drain', drained);
            this.transport.removeListener('close', closed);
            error ? reject(error) : resolve();
          };
          const drained = () => done(),
            closed = () => done(failure('ERR_CLOSED', 'VMess UDP transport closed.', 'transport'));
          this.transport.once('drain', drained);
          this.transport.once('close', closed);
        });
    } finally {
      this.pendingBytes -= data.length + 128;
    }
  }
  dispose() {
    this.connection?.close();
    this.transport?.destroy();
    this.finish();
  }
}
module.exports = { VMessDatagram };
