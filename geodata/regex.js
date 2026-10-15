'use strict';
const { RE2JS } = require('re2js');

// Go regexp / RE2 syntax, with no backtracking or native runtime dependency.
function expression(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 2048)
    throw new TypeError('Expected a nonempty RE2 expression up to 2048 characters.');
  try {
    const compiled = RE2JS.compile(pattern);
    return (text) => typeof text === 'string' && compiled.matcher(text).find();
  } catch {
    throw new TypeError('Invalid or unsupported RE2 expression.');
  }
}
module.exports = { expression };
