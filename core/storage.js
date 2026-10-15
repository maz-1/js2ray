'use strict';
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { failure } = require('../runtime/errors');
function createStorage(location) {
  const events = new EventEmitter();
  let timer;
  let started = false;
  const storage = {
    data: {},
    on: events.on.bind(events),
    start() {
      if (started) return;
      if (location) {
        try {
          storage.data = JSON.parse(fs.readFileSync(location, 'utf8'));
        } catch (cause) {
          if (cause.code !== 'ENOENT')
            throw failure('ERR_STORAGE', 'Cannot read storage.', 'storage', cause);
        }
        if (!storage.data || typeof storage.data !== 'object' || Array.isArray(storage.data))
          throw failure('ERR_STORAGE', 'Storage must contain an object.', 'storage');
        timer = setInterval(() => {
          try {
            storage.write();
          } catch (error) {
            events.emit('storageError', error);
          }
        }, 30000);
        timer.unref();
      }
      started = true;
    },
    write() {
      if (!location || !started) return;
      events.emit('write');
      try {
        fs.writeFileSync(location, JSON.stringify(storage.data));
      } catch (cause) {
        throw failure('ERR_STORAGE', 'Cannot write storage.', 'storage', cause);
      }
    },
    close() {
      clearInterval(timer);
      try {
        storage.write();
      } finally {
        started = false;
        events.removeAllListeners();
      }
    },
  };
  return storage;
}
module.exports = { createStorage };
