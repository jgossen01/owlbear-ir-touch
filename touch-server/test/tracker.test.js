'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../tracker');

const rep = (t, contacts, count = contacts.length) => ({ t, count, contacts });
const c = (id, tip, rx, ry) => ({ id, tip, rx, ry });
function collect(tr) { const ev = []; tr.on('touch', e => ev.push(e)); return ev; }

test('down, move on position change only, up with held time', () => {
  const tr = new Tracker(); const ev = collect(tr);
  tr.feed(rep(1000, [c(3, true, 100, 200)]));
  tr.feed(rep(1010, [c(3, true, 100, 200)]));   // same position → no event
  tr.feed(rep(1020, [c(3, true, 110, 200)]));
  tr.feed(rep(1500, [c(3, false, 110, 200)]));
  tr.stop();
  assert.deepEqual(ev.map(e => e.phase), ['down', 'move', 'up']);
  assert.equal(ev[0].id, 3);
  assert.equal(ev[2].held, 500);
});

test('a contact missing from a full report for more than 150 ms is closed', () => {
  const tr = new Tracker(); const ev = collect(tr);
  tr.feed(rep(0, [c(1, true, 10, 10), c(2, true, 20, 20)]));
  tr.feed(rep(100, [c(2, true, 20, 20)], 1)); // 100 ms without #1 → still open
  assert.equal(ev.filter(e => e.phase === 'up').length, 0);
  tr.feed(rep(200, [c(2, true, 20, 20)], 1)); // 200 ms → gone
  tr.stop();
  const up = ev.find(e => e.phase === 'up');
  assert.equal(up.id, 1);
  assert.equal(up.why, 'missing');
  assert.equal(tr.active.size, 1);
});

test('partial follow-up reports (count 0) do not close other contacts', () => {
  const tr = new Tracker(); const ev = collect(tr);
  tr.feed(rep(0, [c(1, true, 10, 10), c(2, true, 20, 20)]));
  tr.feed(rep(500, [c(2, true, 21, 20)], 0)); // hybrid follow-up: only the moving contact, count 0
  tr.stop();
  assert.equal(ev.filter(e => e.phase === 'up').length, 0);
  assert.equal(tr.active.size, 2);
});

test('silence for more than 1 s closes every contact', () => {
  const tr = new Tracker(); const ev = collect(tr);
  const t0 = Date.now() - 2000;
  tr.feed(rep(t0, [c(7, true, 5, 5)]));
  tr.sweep();
  tr.stop();
  const up = ev.find(e => e.phase === 'up');
  assert.equal(up.id, 7);
  assert.equal(up.why, 'silent');
  assert.equal(tr.active.size, 0);
});
