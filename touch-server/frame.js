'use strict';
/* IR frame reader (raw USB via WinUSB/libusb).
   Tested with "InfraredMultiTouch-61 / Touch Device,43-50P" (VID 08D3, PID 1000) — a standard HID multitouch digitizer:
     interface 0: EP 0x81 IN, input report id 2, 62 bytes:
       6 slots × 10 bytes  [flags(bit0 tip, bit1 in-range, bit2 confidence)] [contact id, 0xFF = empty] [x u16] [y u16] [w u16] [h u16]
       byte 61 = contact count (hybrid mode: the first report of a burst carries the total, follow-ups 0)
       x, y in 0..32767 over the frame's active area
     interface 1: mouse/keyboard emulation (not used)
   The frame only starts sending on interface 0 once the host has fetched the HID report descriptor —
   with the OS driver replaced by WinUSB we have to do that ourselves (Windows refuses raw reads of touch devices). */
const usb = require('usb');
const EventEmitter = require('events');

const KNOWN = [{ vid: 0x08d3, pid: 0x1000, name: 'InfraredMultiTouch 43-50P' }];
const RAW_MAX = 32767;

/* One input report (id 2, 62 bytes) → { count, contacts }. Pure, so it can be unit-tested without a frame. */
function parseReport(buf) {
  if (!buf || buf.length < 62 || buf[0] !== 2) return null;
  const contacts = [];
  for (let i = 0; i < 6; i++) {
    const o = 1 + i * 10, flags = buf[o], id = buf[o + 1];
    if (id === 0xff || (flags === 0 && buf.readUInt16LE(o + 2) === 0 && buf.readUInt16LE(o + 4) === 0)) continue;
    contacts.push({ id, tip: !!(flags & 1), inRange: !!(flags & 2), confidence: !!(flags & 4), rx: buf.readUInt16LE(o + 2), ry: buf.readUInt16LE(o + 4), w: buf.readUInt16LE(o + 6), h: buf.readUInt16LE(o + 8) });
  }
  return { count: buf[61], contacts };
}

class Frame extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = { vid: null, pid: null, iface: 0, ...opts };
    this.dev = null; this.ep = null; this.if = null;
    this.reports = 0;
    this.info = null;
    this.lastReportAt = 0;
    const hot = usb.usb && typeof usb.usb.on === 'function' ? usb.usb : null; // usb@2: hotplug events live on the legacy `usb` object
    if (hot) { hot.on('attach', () => setTimeout(() => this.open(), 800)); hot.on('detach', d => { if (this.dev && d === this.dev) this.onLost('unplugged'); }); }
  }
  match(d) {
    const dd = d.deviceDescriptor;
    if (this.opts.vid) return dd.idVendor === this.opts.vid && (!this.opts.pid || dd.idProduct === this.opts.pid);
    return KNOWN.some(k => k.vid === dd.idVendor && k.pid === dd.idProduct);
  }
  open() {
    if (this.dev) return true;
    const dev = usb.getDeviceList().find(d => this.match(d));
    if (!dev) { this.emit('status', { connected: false, error: 'frame not found on USB' }); return false; }
    try {
      dev.open();
      const iface = dev.interface(this.opts.iface);
      iface.claim();
      const ep = iface.endpoint(0x81) || iface.endpoints.find(e => e.direction === 'in');
      if (!ep) throw new Error('no IN endpoint on interface ' + this.opts.iface);
      this.dev = dev; this.if = iface; this.ep = ep;
      const dd = dev.deviceDescriptor;
      this.info = { vid: dd.idVendor, pid: dd.idProduct, name: (KNOWN.find(k => k.vid === dd.idVendor && k.pid === dd.idProduct) || {}).name || 'unknown frame', maxContacts: null };
      ep.on('data', buf => this.onReport(buf));
      ep.on('error', e => { if (this.dev) this.onLost('read error: ' + e.message); });
      this.activate().then(() => {
        ep.startPoll(8, ep.descriptor.wMaxPacketSize || 64);
        this.emit('status', { connected: true, error: null, frame: this.info });
      }).catch(e => this.onLost('activation failed: ' + e.message));
      return true;
    } catch (e) {
      const hint = /NOT_SUPPORTED|ACCESS|BUSY/i.test(e.message) ? ' — is interface 0 of the frame on the WinUSB driver (Zadig)? Is another program reading it?' : '';
      this.emit('status', { connected: false, error: e.message + hint });
      try { dev.close(); } catch (_) {}
      return false;
    }
  }
  ctrl(rt, req, val, idx, data) {
    return new Promise((res, rej) => this.dev.controlTransfer(rt, req, val, idx, data, (e, d) => e ? rej(e) : res(d)));
  }
  async activate() {
    const iface = this.opts.iface;
    // HID descriptor → length of the report descriptor; fetching the report descriptor is what switches the frame to multitouch reports
    const hd = await this.ctrl(0x81, 0x06, 0x2100, iface, 9);
    const rdLen = hd && hd.length >= 9 ? hd.readUInt16LE(7) : 613;
    await this.ctrl(0x81, 0x06, 0x2200, iface, rdLen);
    try { await this.ctrl(0x21, 0x0a, 0, iface, Buffer.alloc(0)); } catch (_) {} // SET_IDLE(0): report on change only
    try { const f = await this.ctrl(0xa1, 0x01, 0x0300 | 3, iface, 2); if (f && f.length >= 2) this.info.maxContacts = f[1]; } catch (_) {} // feature 3 = contact count maximum
  }
  onReport(buf) {
    const rep = parseReport(buf);
    if (!rep) return;
    this.reports++;
    this.lastReportAt = Date.now();
    this.emit('report', { t: this.lastReportAt, ...rep });
  }
  onLost(reason) {
    const dev = this.dev; this.dev = null;
    try { this.ep && this.ep.stopPoll(); } catch (_) {}
    try { this.if && this.if.release(true, () => { try { dev.close(); } catch (_) {} }); } catch (_) { try { dev && dev.close(); } catch (_) {} }
    this.ep = null; this.if = null;
    this.emit('status', { connected: false, error: reason });
  }
  close() { if (this.dev) this.onLost('closed'); }
}

module.exports = { Frame, RAW_MAX, KNOWN, parseReport };
