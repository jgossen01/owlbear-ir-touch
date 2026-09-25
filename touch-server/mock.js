#!/usr/bin/env node
'use strict';
/* Mock of the IR touch service — speaks the protocol without a frame, for testing the extension.
     node mock.js [--port 50000]
   stdin commands (x, y in % of the display picture):
     down <id> <x> <y>      move <id> <x> <y>      up <id>
     drag <id> <x1> <y1> <x2> <y2> [ms]   down, moves at ~60 Hz, up (default 1000 ms) */
const http = require('http');
const readline = require('readline');
const { WebSocketServer } = require('ws');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const PORT = Number(arg('--port', 50000));
const clients = new Set();
const last = new Map(); // id → { x, y }

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ service: 'ir-touch', mock: true, version: 'mock', port: PORT, clients: clients.size }, null, 2));
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  clients.add(ws);
  console.log(`client connected (${clients.size})`);
  ws.send(JSON.stringify({ type: 'HELLO', protocol: 'ir-touch', version: 'mock', port: PORT, frame: { connected: true, name: 'mock frame', maxContacts: 10, error: null }, calibration: { calibrated: true, savedAt: null } }));
  ws.on('message', d => { try { const m = JSON.parse(d.toString()); if (m.type === 'HELLO') console.log('client says hello:', m.client); } catch (_) {} });
  ws.on('close', () => { clients.delete(ws); console.log(`client disconnected (${clients.size})`); });
  ws.on('error', () => {});
});

function send(id, phase, x, y) {
  if (phase === 'up') { const p = last.get(id); if (p) { x = p.x; y = p.y; } last.delete(id); } else last.set(id, { x, y });
  const msg = { type: 'TOUCH', id, phase, x: x / 100, y: y / 100, w: 0.027, h: 0.047, rx: Math.round(x / 100 * 32767), ry: Math.round(y / 100 * 32767), rw: 875, rh: 1555, t: Date.now() }; // a 1″ base on a 43″ picture
  const s = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
  if (phase !== 'move') console.log(`${phase.padEnd(4)} #${id} ${x}%,${y}%`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function drag(id, x1, y1, x2, y2, ms = 1000) {
  send(id, 'down', x1, y1);
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) { await sleep(16); send(id, 'move', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); }
  send(id, 'up', x2, y2);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const [cmd, ...a] = line.trim().split(/\s+/);
  const n = a.map(Number);
  if ((cmd === 'down' || cmd === 'move') && n.length >= 3) send(n[0], cmd, n[1], n[2]);
  else if (cmd === 'up' && n.length >= 1) send(n[0], 'up', 0, 0);
  else if (cmd === 'drag' && n.length >= 5) drag(n[0], n[1], n[2], n[3], n[4], n[5]);
  else console.log('commands: down|move <id> <x%> <y%> · up <id> · drag <id> <x1> <y1> <x2> <y2> [ms]');
});
server.listen(PORT, '127.0.0.1', () => console.log(`mock IR touch service on ws://localhost:${PORT} — type "drag 1 30 30 60 60" to move a figure`));
