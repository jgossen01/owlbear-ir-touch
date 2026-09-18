'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReport } = require('../frame');

function slot(buf, i, { flags, id, x, y, w = 10, h = 10 }) {
  const o = 1 + i * 10;
  buf[o] = flags; buf[o + 1] = id;
  buf.writeUInt16LE(x, o + 2); buf.writeUInt16LE(y, o + 4); buf.writeUInt16LE(w, o + 6); buf.writeUInt16LE(h, o + 8);
}
function report(contacts, count) {
  const buf = Buffer.alloc(62);
  buf[0] = 2;
  for (let i = 0; i < 6; i++) buf[1 + i * 10 + 1] = 0xff; // empty slots
  contacts.forEach((c, i) => slot(buf, i, c));
  buf[61] = count;
  return buf;
}

test('parses two contacts and skips empty slots', () => {
  const rep = parseReport(report([{ flags: 7, id: 1, x: 1000, y: 2000 }, { flags: 4, id: 2, x: 5, y: 6 }], 2));
  assert.equal(rep.count, 2);
  assert.deepEqual(rep.contacts, [
    { id: 1, tip: true, inRange: true, confidence: true, rx: 1000, ry: 2000, w: 10, h: 10 },
    { id: 2, tip: false, inRange: false, confidence: true, rx: 5, ry: 6, w: 10, h: 10 },
  ]);
});

test('rejects other report ids and short buffers', () => {
  const wrong = report([], 0); wrong[0] = 1;
  assert.equal(parseReport(wrong), null);
  assert.equal(parseReport(Buffer.alloc(10)), null);
});

test('a slot with id 0 but all-zero coordinates and flags is treated as empty', () => {
  const buf = report([{ flags: 0, id: 0, x: 0, y: 0, w: 0, h: 0 }], 0);
  assert.deepEqual(parseReport(buf).contacts, []);
});
