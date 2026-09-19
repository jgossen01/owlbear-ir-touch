'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReport, Frame } = require('../frame');

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

// packets recorded on the table (Greentouch GT-IR-F43, direct mode over the vendor HID collection)
const hexbuf = s => Buffer.from(s.replace(/ /g, ''), 'hex');
const DIRECT = hexbuf('05 07 00 6c 24 1c 14 40 00 71 00' + ' 00 ff 00 00 00 00 00 00 00 00'.repeat(5) + ' 01 00 00');
const ACK = hexbuf('05 1f f7 fc 13 00 00 00 25' + ' 00'.repeat(55));

test('direct mode: report id 5 carries the same slots', () => {
  assert.equal(DIRECT.length, 64);
  assert.deepEqual(parseReport(DIRECT), { count: 1, contacts: [{ id: 0, tip: true, inRange: true, confidence: true, rx: 0x246c, ry: 0x141c, w: 0x40, h: 0x71 }] });
});

test('direct mode: the acknowledgement of a mode switch is not a touch report', () => {
  assert.equal(parseReport(ACK), null);
});

function fakeHid(devices) {
  const opened = [];
  class Dev extends require('events') {
    constructor(path) { super(); this.path = path; this.written = []; this.closed = false; opened.push(this); }
    write(a) { this.written.push(a); return a.length; }
    close() { this.closed = true; }
  }
  return { devices: () => devices, HID: Dev, opened };
}

test('hid transport: picks the vendor collection, switches direct mode on, reads, and switches it off on close', () => {
  const lib = fakeHid([
    { vendorId: 0x08d3, productId: 0x1000, usagePage: 0x0d, usage: 4, path: 'col01' },
    { vendorId: 0x08d3, productId: 0x1000, usagePage: 0xff00, usage: 0, path: 'col03' },
  ]);
  const frame = new Frame({ hidLib: lib, transport: 'hid', hotplug: false });
  const status = [], reports = [];
  frame.on('status', s => status.push(s)); frame.on('report', r => reports.push(r));
  assert.equal(frame.open(), true);
  const dev = lib.opened[0];
  assert.equal(dev.path, 'col03');
  assert.equal(dev.written[0].length, 64);
  assert.deepEqual(dev.written[0].slice(0, 5), [5, 31, 247, 252, 18]);
  assert.equal(status[0].connected, true);
  assert.equal(status[0].frame.transport, 'hid');
  dev.emit('data', ACK); dev.emit('data', DIRECT);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].contacts[0].rx, 0x246c);
  frame.close();
  assert.deepEqual(dev.written[1].slice(0, 5), [5, 31, 247, 252, 20]);
  assert.equal(dev.closed, true);
  assert.equal(status[1].connected, false);
  assert.equal(frame.dev, null);
});

test('hid transport: a read error drops the frame so that the service can reopen it', () => {
  const lib = fakeHid([{ vendorId: 0x08d3, productId: 0x1000, usagePage: 0xff00, usage: 0, path: 'col03' }]);
  const frame = new Frame({ hidLib: lib, transport: 'hid', hotplug: false });
  const status = [];
  frame.on('status', s => status.push(s));
  frame.open();
  lib.opened[0].emit('error', new Error('could not read from HID device'));
  assert.equal(frame.dev, null);
  assert.match(status[1].error, /read error/);
  assert.equal(frame.open(), true);
  assert.equal(lib.opened.length, 2);
  frame.close();
});

test('hid transport: without a vendor collection it reports why', () => {
  const frame = new Frame({ hidLib: fakeHid([]), transport: 'hid', hotplug: false });
  const status = [];
  frame.on('status', s => status.push(s));
  assert.equal(frame.open(), false);
  assert.match(status[0].error, /vendor HID collection/);
});
