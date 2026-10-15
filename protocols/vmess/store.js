'use strict';
function createStore(storage, account) {
  function save() {
    storage.data.vmess = account.getUser();
  }
  storage.on('write', save);
  return {
    get(tag) {
      return storage.data.vmess?.[tag] ?? {};
    },
    save() {
      save();
    },
  };
}
module.exports = { createStore };
