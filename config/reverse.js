'use strict';
function reverseConfig(input, add, host, bounds) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add('reverse', 'Expected reverse configuration.');
    return undefined;
  }
  const result = {};
  const tags = new Set(bounds.map((item) => item.tag));
  for (const key of Object.keys(input))
    if (!['bridges', 'portals'].includes(key))
      add('reverse.' + key, 'Unsupported reverse behavior.');
  for (const role of ['bridges', 'portals']) {
    if (input[role] !== undefined && !Array.isArray(input[role]))
      add('reverse.' + role, 'Expected an array.');
    result[role] = (Array.isArray(input[role]) ? input[role] : []).map((item, i) => {
      const prefix = `reverse.${role}[${i}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        add(prefix, 'Expected reverse endpoint.');
        return {};
      }
      for (const key of Object.keys(item))
        if (!['tag', 'domain', 'maxWorkers', 'maxSessions', 'reconnectMs'].includes(key))
          add(prefix + '.' + key, 'Unsupported reverse behavior.');
      if (typeof item.tag !== 'string' || !item.tag || tags.has(item.tag))
        add(prefix + '.tag', 'Expected a unique reverse tag.');
      tags.add(item.tag);
      if (
        !host(item.domain) ||
        require('node:net').isIP(item.domain) ||
        item.domain === 'reverse.internal.v2fly.org'
      )
        add(prefix + '.domain', 'Expected a non-reserved control domain.');
      for (const [field, maximum] of [
        ['maxWorkers', 32],
        ['maxSessions', 1024],
        ['reconnectMs', 30000],
      ])
        if (
          item[field] !== undefined &&
          (!Number.isInteger(item[field]) || item[field] < 1 || item[field] > maximum)
        )
          add(prefix + '.' + field, 'Invalid reverse resource limit.');
      return { ...item };
    });
  }
  return result;
}
module.exports = { reverseConfig };
