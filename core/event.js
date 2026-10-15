'use strict';
const { EventEmitter } = require('node:events');
module.exports = { createEvents: () => new EventEmitter() };
