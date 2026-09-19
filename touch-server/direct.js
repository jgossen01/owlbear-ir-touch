#!/usr/bin/env node
'use strict';
/* Direct-mode experiment — switches the frame to its vendor channel and dumps what it sends there.
   Greentouch frames (08D3:1000) carry a vendor-defined HID collection (usage page 0xFF00, report id 5, 64 bytes in/out)
   on interface 0. The output report 05 1F F7 FC 12 makes the frame send its contacts there and stop feeding the
   OS touch screen; 05 1F F7 FC 14 switches back (packets by courtesy of the DigitalTableTops developer).

     node direct.js [--seconds 15] [--transport auto|hid|usb] [--vid 0x08d3 --pid 0x1000] [--max 3000]

   Two transports, picked automatically:
     hid  interface 0 on the normal OS HID driver, read through node-hid — the set-up without Zadig
     usb  interface 0 on WinUSB (after the Zadig step), read raw through libusb
   Stop the touch service first. Every packet goes to direct-<transport>.txt (identical repeats are folded), the first
   ones to the console as well. The frame is switched back to normal mode at the end (also on Ctrl+C). */
const fs = require('fs');
const path = require('path');
const { KNOWN } = require('./frame');

const ON = [5, 31, 247, 252, 18], OFF = [5, 31, 247, 252, 20];
const REPORT_LEN = 64;
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const VID = parseInt(arg('--vid', KNOWN[0].vid)), PID = parseInt(arg('--pid', KNOWN[0].pid));
const SECONDS = Number(arg('--seconds', 15)), MAX_LINES = Number(arg('--max', 3000)), WANT = arg('--transport', 'auto');
const CONSOLE_LINES = 30;

const pad = a => Buffer.concat([Buffer.from(a), Buffer.alloc(REPORT_LEN - a.length)]);
const spaced = buf => buf.toString('hex').replace(/(..)/g, '$1 ').trim();

let file = null, lines = 0, packets = 0, last = null, repeats = 0;
const t0 = Date.now(), byId = new Map();
function out(s, always) {
  if (file && (always || lines < MAX_LINES)) file.write(s + '\n');
  if (always || lines < CONSOLE_LINES) console.log(s); else if (lines === CONSOLE_LINES) console.log('… (the rest goes to the file only)');
  if (!always) lines++;
}
function onPacket(buf) {
  packets++;
  byId.set(buf[0], (byId.get(buf[0]) || 0) + 1);
  const h = buf.toString('hex');
  if (h === last) { repeats++; return; }
  if (repeats) out(`           … repeated ${repeats}×`);
  repeats = 0; last = h;
  out(`${String(Date.now() - t0).padStart(6)} ms  ${String(buf.length).padStart(2)} B  ${spaced(buf)}`);
}

function viaHid() {
  let HID;
  try { HID = require('node-hid'); } catch (_) { return null; }
  const d = HID.devices().find(d => d.vendorId === VID && d.productId === PID && d.usagePage === 0xff00);
  if (!d) return null;
  const dev = new HID.HID(d.path);
  dev.on('data', onPacket);
  dev.on('error', e => out('read error: ' + e.message, true));
  return { kind: 'hid', name: `OS HID driver via node-hid (${d.path})`, send: async a => dev.write([...pad(a)]), close: async () => dev.close() };
}

async function viaUsb() {
  const usb = require('usb');
  const dev = usb.getDeviceList().find(d => d.deviceDescriptor.idVendor === VID && d.deviceDescriptor.idProduct === PID);
  if (!dev) return null;
  dev.open();
  const iface = dev.interface(0);
  iface.claim();
  const ctrl = (rt, req, val, idx, data) => new Promise((res, rej) => dev.controlTransfer(rt, req, val, idx, data, (e, d) => e ? rej(e) : res(d)));
  const hd = await ctrl(0x81, 0x06, 0x2100, 0, 9); // the frame stays silent until the report descriptor has been fetched (see frame.js)
  await ctrl(0x81, 0x06, 0x2200, 0, hd && hd.length >= 9 ? hd.readUInt16LE(7) : 613);
  const epIn = iface.endpoints.find(e => e.direction === 'in'), epOut = iface.endpoints.find(e => e.direction === 'out');
  if (!epIn) throw new Error('no IN endpoint on interface 0');
  epIn.on('data', onPacket);
  epIn.on('error', e => out('read error: ' + e.message, true));
  epIn.startPoll(8, epIn.descriptor.wMaxPacketSize || REPORT_LEN);
  return {
    kind: 'usb',
    name: `WinUSB/libusb, output reports over ${epOut ? 'the interrupt OUT endpoint' : 'SET_REPORT (no OUT endpoint)'}`,
    send: a => epOut ? new Promise((res, rej) => epOut.transfer(pad(a), e => e ? rej(e) : res())) : ctrl(0x21, 0x09, 0x0200 | a[0], 0, pad(a)),
    close: () => new Promise(res => { try { epIn.stopPoll(() => iface.release(true, () => { try { dev.close(); } catch (_) {} res(); })); } catch (_) { res(); } }),
  };
}

async function main() {
  let t = null;
  if (WANT !== 'usb') t = viaHid();
  if (!t && WANT !== 'hid') {
    try { t = await viaUsb(); } catch (e) { console.log(`libusb: ${e.message} — interface 0 is probably on the OS HID driver; run "npm install" so node-hid is there, then try again.`); process.exit(1); }
  }
  if (!t) { console.log(WANT === 'hid' ? 'no vendor collection (usage page 0xFF00) of the frame found through node-hid — is interface 0 on WinUSB? Is node-hid installed ("npm install")?' : 'frame not found'); process.exit(1); }

  file = fs.createWriteStream(path.join(__dirname, `direct-${t.kind}.txt`));
  out(`transport: ${t.name}`, true);
  let done = false;
  const finish = async why => {
    if (done) return; done = true;
    if (repeats) out(`           … repeated ${repeats}×`, true);
    try { await t.send(OFF); out(`switched back to normal mode (${why})`, true); } catch (e) { out('switching back failed: ' + e.message + ' — replug the frame', true); }
    out(`${packets} packets in ${((Date.now() - t0) / 1000).toFixed(1)} s; by report id: ${[...byId].map(([id, n]) => `${id} → ${n}`).join(', ') || 'none'}`, true);
    await t.close();
    file.end(() => { console.log(`written to ${file.path}`); process.exit(0); });
  };
  process.on('SIGINT', () => finish('Ctrl+C'));

  await new Promise(res => setTimeout(res, 300));
  await t.send(ON);
  out(`direct mode requested: ${spaced(Buffer.from(ON))}`, true);
  console.log(`\nRecording for ${SECONDS} s. On the glass, one after the other:\n  1. one finger: down, hold 2 s, drag slowly, lift\n  2. two fingers at once, move both, lift\n  3. a mini: set down, push, lift\nAlso watch whether the Windows cursor / touch still reacts.\n`);
  setTimeout(() => finish('time is up'), SECONDS * 1000);
}

main().catch(e => { console.error(e.message); process.exit(1); });
