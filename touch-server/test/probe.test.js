'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDescriptor } = require('../probe');

const TOUCH = [0x05, 0x0d, 0x09, 0x04, 0xa1, 0x01, 0x85, 0x02, 0x09, 0x22, 0xa1, 0x02, 0x75, 0x08, 0x95, 0x3d, 0x81, 0x02, 0xc0, 0x85, 0x03, 0x95, 0x01, 0xb1, 0x02, 0xc0];
const VENDOR = [0x06, 0x00, 0xff, 0x09, 0x00, 0xa1, 0x01, 0x85, 0x06, 0x75, 0x08, 0x95, 0x3f, 0x91, 0x02, 0x85, 0x07, 0x81, 0x02, 0xc0];

test('lists the top-level collections with their report sizes', () => {
  const cols = parseDescriptor(Buffer.from([...TOUCH, ...VENDOR]));
  assert.equal(cols.length, 2);
  assert.deepEqual(cols[0], { page: 0x0d, usage: 0x04, vendor: false, name: 'touch screen', reports: [{ kind: 'in', id: 2, bytes: 62 }, { kind: 'feature', id: 3, bytes: 2 }] });
  assert.deepEqual(cols[1], { page: 0xff00, usage: 0, vendor: true, name: 'vendor-defined', reports: [{ kind: 'out', id: 6, bytes: 64 }, { kind: 'in', id: 7, bytes: 64 }] });
});

test('a truncated descriptor does not throw', () => {
  assert.equal(parseDescriptor(Buffer.from([...TOUCH, 0x06, 0x00])).length, 1);
  assert.deepEqual(parseDescriptor(Buffer.alloc(0)), []);
});
