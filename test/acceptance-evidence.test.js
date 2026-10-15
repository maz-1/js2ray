'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { sourceEvidence, verify } = require('../scripts/acceptance-evidence');
test('acceptance evidence fails closed on false-green, short duration, stale sources and unreleased resources', () => {
  const good = {
    passed: true,
    formalAcceptance: true,
    concurrentSessions: 100,
    durationMinutes: 30,
    elapsedMs: 1800000,
    closed: [{ state: 'closed', generations: 0, connections: 0, pendingDials: 0, listeners: 0 }],
    ...sourceEvidence(),
  };
  assert.equal(verify(good), true);
  for (const patch of [
    { passed: false },
    { elapsedMs: 1799999 },
    { concurrentSessions: 99 },
    { formalAcceptance: false },
    { sourceSha256: 'changed' },
    { closed: [] },
    { closed: [{ ...good.closed[0], connections: 1 }] },
    { closedProxyProcesses: [{ exited: false }] },
  ])
    assert.throws(() => verify({ ...good, ...patch }));
});
