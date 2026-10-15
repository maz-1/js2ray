'use strict';
function createVMess({ storage, events, logger, limits }) {
  const account = require('./account').createAccount(events);
  const store = require('./store').createStore(storage, account);
  const validator = require('./validator').createValidator(account, store);
  return {
    client: require('./client')(validator, logger, limits.maxBufferBytes),
    server: require('./server')(validator, logger, limits.maxBufferBytes),
    close: validator.close,
    api: {
      getUserByEmail: validator.getUserByEmail,
      getUsers: validator.getUser,
      addUsers: validator.addUsers,
      removeUsers: validator.removeUsers,
    },
  };
}
module.exports = { createVMess };
