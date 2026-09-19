#!/usr/bin/env node
'use strict';
/* IR touch service (owlbear-ir-touch) — runs on the computer the IR frame is plugged into (the table-display PC).
   Reads the frame raw (frame.js), tracks contacts (tracker.js), maps them through the calibration and
   serves them over WebSocket. Several clients may connect at once (the Owlbear table window, the calibration page).

     node server.js [--port 50000] [--vid 0x08d3 --pid 0x1000] [--transport auto|hid|usb] [--calibrate] [--verbose]

   HTTP  GET  /            status (JSON)
         GET  /calibrate   calibration page — open it full-screen (F11) on the table display
         GET  /calibration current calibration (JSON)     DELETE /calibration  drop it
   WS    server → client
         { type: 'HELLO', protocol: 'ir-touch', version, frame: { connected, name, transport, maxContacts, error }, calibration: { calibrated, savedAt } }
         { type: 'FRAME', connected, error }                              frame plugged / unplugged
         { type: 'TOUCH', id, phase: 'down'|'move'|'up', x, y, rx, ry, t }  x,y = fraction of the display picture (0..1), rx,ry raw
         { type: 'CALIBRATED', calibrated, savedAt }
         client → server
         { type: 'CALIBRATION', points: [{ rx, ry, fx, fy }, …] }         from the calibration page
         { type: 'CALIBRATION_CLEAR' } */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Frame } = require('./frame');
const { Tracker } = require('./tracker');
const { Calibration } = require('./calibration');

const VERSION = require('./package.json').version;
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const PORT = Number(arg('--port', process.env.TOUCH_PORT || 50000));
const VERBOSE = argv.includes('--verbose');
const FLUSH_MS = 10; // moves are coalesced per contact and flushed at this rate (the frame reports at up to ~1 kHz)

const ts = () => new Date().toLocaleTimeString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

const frame = new Frame({ vid: arg('--vid') ? parseInt(arg('--vid')) : null, pid: arg('--pid') ? parseInt(arg('--pid')) : null, transport: arg('--transport', 'auto') });
const tracker = new Tracker();
const calib = new Calibration();
let frameStatus = { connected: false, error: 'starting' };
let clients = new Set();
let stats = { touches: 0, downs: 0, sent: 0 };

frame.on('status', st => {
  frameStatus = { connected: !!st.connected, error: st.error || null, name: st.frame && st.frame.name, transport: st.frame && st.frame.transport, maxContacts: st.frame && st.frame.maxContacts };
  log(st.connected ? `frame connected: ${frameStatus.name} (${frameStatus.maxContacts || '?'} contacts, ${frameStatus.transport === 'hid' ? 'HID direct mode' : 'raw USB'})` : `frame not connected: ${st.error}`);
  broadcast({ type: 'FRAME', ...frameStatus });
});
frame.on('report', rep => tracker.feed(rep));

const pending = new Map(); // contact id → latest move (coalesced)
tracker.on('touch', ev => {
  stats.touches++;
  const p = calib.apply(ev.rx, ev.ry);
  const msg = { type: 'TOUCH', id: ev.id, phase: ev.phase, x: round(p.x), y: round(p.y), rx: ev.rx, ry: ev.ry, t: ev.t };
  if (ev.phase === 'move') { pending.set(ev.id, msg); return; }
  if (ev.phase === 'down') stats.downs++;
  if (ev.phase === 'up') { pending.delete(ev.id); msg.held = ev.held; if (ev.why) msg.why = ev.why; }
  if (VERBOSE || ev.phase !== 'move') log(`${ev.phase.padEnd(4)} #${ev.id} ${(p.x * 100).toFixed(1)}%,${(p.y * 100).toFixed(1)}% raw ${ev.rx},${ev.ry}${ev.held ? ` held ${ev.held} ms` : ''}${ev.why ? ` (${ev.why})` : ''}`);
  broadcast(msg);
});
setInterval(() => { if (pending.size) { for (const m of pending.values()) broadcast(m); pending.clear(); } }, FLUSH_MS);

function round(v) { return Math.round(v * 10000) / 10000; }
function broadcast(obj) {
  if (!clients.size) return;
  const s = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) { ws.send(s); stats.sent++; }
}
function hello() { return { type: 'HELLO', protocol: 'ir-touch', version: VERSION, port: PORT, frame: frameStatus, calibration: calib.describe() }; }
function status() { return { service: 'ir-touch', version: VERSION, port: PORT, frame: frameStatus, calibration: calib.describe(), clients: clients.size, reports: frame.reports, active: tracker.active.size, stats }; }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/calibrate') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(__dirname, 'calibrate.html'))); }
  if (url.pathname === '/calibration' && req.method === 'DELETE') { calib.clear(); broadcast({ type: 'CALIBRATED', ...calib.describe() }); log('calibration cleared'); }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(url.pathname === '/calibration' ? calib.describe() : status(), null, 2));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  clients.add(ws);
  log(`client connected (${clients.size}) from ${req.socket.remoteAddress} ${req.headers.origin || ''}`);
  ws.send(JSON.stringify(hello()));
  ws.on('message', data => {
    let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.type === 'CALIBRATION' && Array.isArray(msg.points)) {
      const ok = calib.set(msg.points);
      log(ok ? `calibration saved (${msg.points.length} points)` : 'calibration rejected (degenerate points)');
      broadcast({ type: 'CALIBRATED', ok, ...calib.describe() });
    } else if (msg.type === 'CALIBRATION_CLEAR') { calib.clear(); broadcast({ type: 'CALIBRATED', ...calib.describe() }); log('calibration cleared'); }
    else if (msg.type === 'HELLO') log(`client says hello: ${msg.client || '?'}`);
  });
  ws.on('close', () => { clients.delete(ws); log(`client disconnected (${clients.size})`); });
  ws.on('error', () => {});
});
server.listen(PORT, '127.0.0.1', () => {
  log(`IR touch service v${VERSION} on ws://localhost:${PORT} — calibration page http://localhost:${PORT}/calibrate`);
  frame.open();
  setInterval(() => { if (!frame.dev) frame.open(); }, 3000); // frame plugged in later / driver swapped
  if (argv.includes('--calibrate')) { const { exec } = require('child_process'); exec(`${process.platform === 'win32' ? 'start ""' : 'xdg-open'} http://localhost:${PORT}/calibrate`); }
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { log('bye'); tracker.stop(); frame.close(); process.exit(0); }); // close() hands the touch screen back to the OS (SIGHUP = console window closed)
