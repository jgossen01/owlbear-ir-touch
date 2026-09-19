'use strict';
/* IR frame reader. Two transports, tried in this order:
     hid  the frame's vendor-defined HID collection (usage page 0xFF00), read through the normal OS HID driver with
          node-hid. An output report switches the frame to "direct mode": it sends the contacts on that collection and
          stops feeding the OS touch screen — no driver swap, no cursor jumps.
     usb  raw USB via WinUSB/libusb, for a frame whose interface 0 was moved to WinUSB (Zadig).
   Tested with a Greentouch GT-IR-F43 frame ("InfraredMultiTouch-61 / Touch Device,43-50P", VID 08D3, PID 1000) — a standard HID multitouch digitizer:
     interface 0: EP 0x81 IN, input report id 2, 62 bytes:
       6 slots × 10 bytes  [flags(bit0 tip, bit1 in-range, bit2 confidence)] [contact id, 0xFF = empty] [x u16] [y u16] [w u16] [h u16]
       byte 61 = contact count (hybrid mode: the first report of a burst carries the total, follow-ups 0)
       x, y in 0..32767 over the frame's active area
     interface 0, vendor collection: report id 5, 64 bytes in/out. Direct mode on = 05 1F F7 FC 12, off = 05 1F F7 FC 14
       (packets by courtesy of the DigitalTableTops developer); the frame acknowledges with 05 1F F7 FC 13 / 15 and then
       sends the same six slots + contact count under report id 5, continuously (~400 Hz) while anything is on the glass.
     interface 1: mouse/keyboard emulation (not used)
   usb transport: the frame only starts sending on interface 0 once the host has fetched the HID report descriptor —
   with the OS driver replaced by WinUSB we have to do that ourselves (Windows refuses raw reads of touch devices). */
const usb = require('usb');
const EventEmitter = require('events');
let HID = null;
try { HID = require('node-hid'); } catch (_) {} // optional: without it only the usb transport is available

const KNOWN = [{ vid: 0x08d3, pid: 0x1000, name: 'Greentouch GT-IR-F43 (InfraredMultiTouch 43-50P)', maxContacts: 50 }];
const RAW_MAX = 32767;
const VENDOR_PAGE = 0xff00, REPORT_LEN = 64;
const DIRECT_ON = [5, 0x1f, 0xf7, 0xfc, 0x12], DIRECT_OFF = [5, 0x1f, 0xf7, 0xfc, 0x14];
const padded = a => a.concat(new Array(REPORT_LEN - a.length).fill(0));

/* One input report (id 2 = touch screen, 62 bytes; id 5 = direct mode, 64 bytes, same layout) → { count, contacts }.
   Pure, so it can be unit-tested without a frame. */
function parseReport(buf) {
  if (!buf || buf.length < 62 || (buf[0] !== 2 && buf[0] !== 5)) return null;
  if (buf[0] === 5 && buf[1] === 0x1f && buf[2] === 0xf7 && buf[3] === 0xfc) return null; // acknowledgement of a mode switch
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
    this.opts = { vid: null, pid: null, iface: 0, transport: 'auto', hidLib: HID, hotplug: true, ...opts }; // hidLib / hotplug: for tests (hotplug listeners keep the process alive)
    this.dev = null; this.ep = null; this.if = null; this.hid = false;
    this.reports = 0;
    this.info = null;
    this.lastReportAt = 0;
    const hot = this.opts.hotplug && usb.usb && typeof usb.usb.on === 'function' ? usb.usb : null; // usb@2: hotplug events live on the legacy `usb` object
    if (hot) { hot.on('attach', () => setTimeout(() => this.open(), 800)); hot.on('detach', d => { if (this.dev && d === this.dev) this.onLost('unplugged'); }); }
  }
  match(vid, pid) {
    if (this.opts.vid) return vid === this.opts.vid && (!this.opts.pid || pid === this.opts.pid);
    return KNOWN.some(k => k.vid === vid && k.pid === pid);
  }
  describe(vid, pid, transport) {
    const known = KNOWN.find(k => k.vid === vid && k.pid === pid) || {};
    return { vid, pid, transport, name: known.name || 'unknown frame', maxContacts: known.maxContacts || null }; // usb reads the real maximum from feature report 3
  }
  open() {
    if (this.dev) return true;
    if (this.opts.transport !== 'usb') {
      const r = this.openHid();
      if (r !== null) return r;
      if (this.opts.transport === 'hid') { this.emit('status', { connected: false, error: this.opts.hidLib ? 'no vendor HID collection of the frame found — is it plugged in, and is interface 0 on the normal HID driver (not WinUSB)?' : 'node-hid is not installed (npm install)' }); return false; }
    }
    return this.openUsb();
  }
  /* null = no vendor collection to be seen (frame absent, or interface 0 on WinUSB) → try usb */
  openHid() {
    const HID = this.opts.hidLib;
    if (!HID) return null;
    let d;
    try { d = HID.devices().find(d => this.match(d.vendorId, d.productId) && d.usagePage === VENDOR_PAGE); } catch (_) { return null; }
    if (!d) return null;
    let dev = null;
    try {
      dev = new HID.HID(d.path);
      dev.on('data', buf => this.onReport(buf));
      dev.on('error', e => { if (this.dev === dev) this.onLost('read error: ' + e.message); });
      dev.write(padded(DIRECT_ON));
      this.dev = dev; this.hid = true;
      this.info = this.describe(d.vendorId, d.productId, 'hid');
      this.emit('status', { connected: true, error: null, frame: this.info });
      return true;
    } catch (e) {
      try { dev && dev.close(); } catch (_) {}
      this.emit('status', { connected: false, error: 'HID: ' + e.message });
      return false;
    }
  }
  openUsb() {
    const dev = usb.getDeviceList().find(d => this.match(d.deviceDescriptor.idVendor, d.deviceDescriptor.idProduct));
    if (!dev) { this.emit('status', { connected: false, error: 'frame not found on USB' }); return false; }
    try {
      dev.open();
      const iface = dev.interface(this.opts.iface);
      iface.claim();
      const ep = iface.endpoint(0x81) || iface.endpoints.find(e => e.direction === 'in');
      if (!ep) throw new Error('no IN endpoint on interface ' + this.opts.iface);
      this.dev = dev; this.if = iface; this.ep = ep;
      const dd = dev.deviceDescriptor;
      this.info = this.describe(dd.idVendor, dd.idProduct, 'usb');
      ep.on('data', buf => this.onReport(buf));
      ep.on('error', e => { if (this.dev) this.onLost('read error: ' + e.message); });
      this.activate().then(() => {
        ep.startPoll(8, ep.descriptor.wMaxPacketSize || 64);
        this.emit('status', { connected: true, error: null, frame: this.info });
      }).catch(e => this.onLost('activation failed: ' + e.message));
      return true;
    } catch (e) {
      const hint = /NOT_SUPPORTED|ACCESS|BUSY/i.test(e.message) ? (this.opts.hidLib ? ' — is another program reading the frame?' : ' — node-hid is missing (npm install), and for raw USB interface 0 of the frame must be on the WinUSB driver (Zadig)') : '';
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
    if (this.hid) {
      this.hid = false;
      dev.removeAllListeners('data'); dev.removeAllListeners('error'); dev.on('error', () => {});
      try { dev.close(); } catch (_) {}
      this.emit('status', { connected: false, error: reason });
      return;
    }
    try { this.ep && this.ep.stopPoll(); } catch (_) {}
    try { this.if && this.if.release(true, () => { try { dev.close(); } catch (_) {} }); } catch (_) { try { dev && dev.close(); } catch (_) {} }
    this.ep = null; this.if = null;
    this.emit('status', { connected: false, error: reason });
  }
  close() {
    if (!this.dev) return;
    if (this.hid) { try { this.dev.write(padded(DIRECT_OFF)); } catch (_) {} } // hand the touch screen back to the OS
    this.onLost('closed');
  }
}

module.exports = { Frame, RAW_MAX, KNOWN, parseReport };
