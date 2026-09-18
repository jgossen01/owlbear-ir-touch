#!/usr/bin/env node
'use strict';
/* HID probe — fetches the HID report descriptors of the frame and lists their top-level collections.
   Question it answers: does the frame carry a vendor-defined collection (usage page 0xFF00…) next to the
   touch screen? Frames that do can usually be switched into a "direct mode" by an output report on that collection
   and then send the contacts there — readable through the normal HID driver, no WinUSB swap, and the OS sees no touch.

     node probe.js [--vid 0x08d3 --pid 0x1000]

   Run it with the touch service stopped and interface 0 on WinUSB (the state after the Zadig step). Interfaces that
   are still on the OS HID driver may refuse the request; the probe says so and carries on. It only reads. */
const KNOWN_USAGES = { '1:2': 'mouse', '1:6': 'keyboard', '12:1': 'consumer control', '13:4': 'touch screen', '13:5': 'touch pad', '13:14': 'device configuration' };

/* HID report descriptor → [{ page, usage, vendor, name, reports: [{ kind: 'in'|'out'|'feature', id, bytes }] }], one entry
   per top-level collection. `bytes` includes the report id byte. Pure, so it can be unit-tested without a frame. */
function parseDescriptor(buf) {
  const cols = [];
  let depth = 0, cur = null, page = 0, size = 0, count = 0, id = 0, usages = [];
  for (let i = 0; i < buf.length;) {
    const p = buf[i];
    if (p === 0xfe) { i += 3 + (buf[i + 1] || 0); continue; } // long item
    const n = [0, 1, 2, 4][p & 3], type = (p >> 2) & 3, tag = p >> 4;
    if (i + 1 + n > buf.length) break;
    const v = n ? buf.readUIntLE(i + 1, n) : 0;
    i += 1 + n;
    if (type === 1) { // global
      if (tag === 0) page = v; else if (tag === 7) size = v; else if (tag === 8) id = v; else if (tag === 9) count = v;
    } else if (type === 2) { // local
      if (tag === 0) usages.push(n === 4 ? { page: v >>> 16, usage: v & 0xffff } : { page, usage: v });
    } else if (type === 0) { // main
      if (tag === 0xa) {
        if (depth++ === 0) {
          const u = usages[0] || { page, usage: 0 };
          cur = { page: u.page, usage: u.usage, vendor: u.page >= 0xff00, name: u.page >= 0xff00 ? 'vendor-defined' : KNOWN_USAGES[`${u.page}:${u.usage}`] || null, bits: new Map() };
          cols.push(cur);
        }
      } else if (tag === 0xc) { if (--depth <= 0) { depth = 0; cur = null; } }
      else if (cur && (tag === 8 || tag === 9 || tag === 0xb)) {
        const key = `${tag === 8 ? 'in' : tag === 9 ? 'out' : 'feature'}:${id}`;
        cur.bits.set(key, (cur.bits.get(key) || 0) + size * count);
      }
      usages = [];
    }
  }
  return cols.map(({ bits, ...c }) => ({ ...c, reports: [...bits].map(([key, b]) => { const [kind, rid] = key.split(':'); return { kind, id: Number(rid), bytes: Math.ceil(b / 8) + (Number(rid) ? 1 : 0) }; }) }));
}

const hex = v => '0x' + v.toString(16).toUpperCase().padStart(4, '0');

async function main() {
  const usb = require('usb');
  const { KNOWN } = require('./frame');
  const argv = process.argv.slice(2);
  const arg = name => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? parseInt(argv[i + 1]) : null; };
  const vid = arg('--vid'), pid = arg('--pid');
  const dev = usb.getDeviceList().find(d => { const dd = d.deviceDescriptor; return vid ? dd.idVendor === vid && (!pid || dd.idProduct === pid) : KNOWN.some(k => k.vid === dd.idVendor && k.pid === dd.idProduct); });
  if (!dev) { console.log('frame not found on USB'); process.exit(1); }
  dev.open();
  const ctrl = (rt, req, val, idx, len) => new Promise((res, rej) => dev.controlTransfer(rt, req, val, idx, len, (e, d) => e ? rej(e) : res(d)));
  console.log(`device ${hex(dev.deviceDescriptor.idVendor)}:${hex(dev.deviceDescriptor.idProduct)}, ${dev.interfaces.length} interface(s)`);
  let vendor = 0;
  for (const iface of dev.interfaces) {
    const num = iface.descriptor.bInterfaceNumber;
    if (iface.descriptor.bInterfaceClass !== 3) { console.log(`\ninterface ${num}: class ${iface.descriptor.bInterfaceClass}, not HID`); continue; }
    let claimed = false;
    try { iface.claim(); claimed = true; } catch (_) {} // only works on WinUSB interfaces; the request below may still go through
    try {
      const hd = await ctrl(0x81, 0x06, 0x2100, num, 9);
      const rd = await ctrl(0x81, 0x06, 0x2200, num, hd && hd.length >= 9 ? hd.readUInt16LE(7) : 1024);
      console.log(`\ninterface ${num}: report descriptor, ${rd.length} bytes`);
      for (const c of parseDescriptor(rd)) {
        if (c.vendor) vendor++;
        console.log(`  ${c.vendor ? '>>' : '  '} usage page ${hex(c.page)} usage ${hex(c.usage)}${c.name ? ` (${c.name})` : ''}`);
        for (const r of c.reports) console.log(`        ${r.kind.padEnd(7)} report id ${r.id}, ${r.bytes} bytes`);
      }
      console.log('  raw: ' + rd.toString('hex'));
    } catch (e) {
      console.log(`\ninterface ${num}: could not read the report descriptor (${e.message})${claimed ? '' : ' — the interface is on the OS HID driver; look at it with a HID tool instead'}`);
    }
    if (claimed) await new Promise(res => iface.release(true, () => res()));
  }
  console.log(vendor ? `\n${vendor} vendor-defined collection(s) — the frame is a candidate for direct mode without the WinUSB swap.` : '\nno vendor-defined collection found in the descriptors that could be read.');
  dev.close();
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { parseDescriptor };
