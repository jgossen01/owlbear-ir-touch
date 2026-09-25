'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { Relay, parseCode } = require('../relay');

const KEY = '12.' + 'ab'.repeat(20);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(30); } return false; };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'irt-relay-')), 'relay.json');

/* a stand-in for D&D Sync's /api/vtt/touch-relay */
function fakeServer(onHello = (ws, m) => ws.send(JSON.stringify({ type: 'RELAY_OK' }))) {
  const port = 52000 + Math.floor(Math.random() * 800);
  const wss = new WebSocket.Server({ port, host: '127.0.0.1' });
  const got = [], conns = [];
  wss.on('connection', (ws, req) => {
    conns.push({ ws, url: req.url });
    ws.on('message', d => { const m = JSON.parse(d.toString()); got.push(m); if (m.type === 'RELAY_HELLO') onHello(ws, m); });
  });
  return { port, wss, got, conns, code: `http://127.0.0.1:${port}/#touch=${KEY}` };
}

test('pairing codes: https / http with #touch=<campaign>.<40 hex>', () => {
  assert.deepEqual(parseCode(`https://dnd.example.com/#touch=${KEY}`), { url: 'wss://dnd.example.com/api/vtt/touch-relay', key: KEY, server: 'https://dnd.example.com', campaign: 12 });
  assert.equal(parseCode(`http://127.0.0.1:3000/#touch=${KEY}`).url, 'ws://127.0.0.1:3000/api/vtt/touch-relay');
  assert.equal(parseCode(`https://dnd.example.com/#touch=12.abc`), null, 'a short secret');
  assert.equal(parseCode(`ftp://dnd.example.com/#touch=${KEY}`), null);
  assert.equal(parseCode('nonsense'), null);
});

test('the relay says hello with the key, then forwards contacts and frame status only', async () => {
  const srv = fakeServer();
  const r = new Relay({ file: tmp(), hello: () => ({ type: 'HELLO', protocol: 'ir-touch', version: '9.9.9', frame: { connected: true } }) });
  try {
    assert.equal(r.set(srv.code), true);
    assert.ok(await until(() => r.state === 'online'), 'online after RELAY_OK');
    const hello = srv.got.find(m => m.type === 'RELAY_HELLO');
    assert.equal(hello.key, KEY);
    assert.equal(hello.service.protocol, 'ir-touch');
    assert.equal(srv.conns[0].url, '/api/vtt/touch-relay');
    r.forward(JSON.stringify({ type: 'TOUCH', id: 1, phase: 'down', x: 0.5, y: 0.5 }), 'TOUCH');
    r.forward(JSON.stringify({ type: 'FRAME', connected: false }), 'FRAME');
    r.forward(JSON.stringify({ type: 'HELLO', protocol: 'ir-touch' }), 'HELLO');
    assert.ok(await until(() => srv.got.length >= 3));
    await sleep(100);
    assert.deepEqual(srv.got.slice(1).map(m => m.type), ['TOUCH', 'FRAME'], 'nothing but contacts and frame status');
    assert.equal(r.describe().campaign, 12);
  } finally { r.stop(); srv.wss.close(); }
});

test('refused or replaced: it stops and waits for a new code; a lost connection: it reconnects', async () => {
  const refuse = fakeServer((ws) => { ws.send(JSON.stringify({ type: 'RELAY_REFUSED', error: 'unknown or revoked pairing code' })); ws.close(4003, 'refused'); });
  const r = new Relay({ file: tmp(), hello: () => ({ type: 'HELLO', protocol: 'ir-touch', version: 't' }) });
  try {
    r.set(refuse.code);
    assert.ok(await until(() => r.state === 'stopped'));
    assert.match(r.error, /revoked/);
    await sleep(2500);
    assert.equal(refuse.conns.length, 1, 'no retry with a refused code');
  } finally { r.stop(); refuse.wss.close(); }

  const flaky = fakeServer();
  const r2 = new Relay({ file: tmp(), hello: () => ({ type: 'HELLO', protocol: 'ir-touch', version: 't' }) });
  try {
    r2.set(flaky.code);
    assert.ok(await until(() => r2.state === 'online'));
    flaky.conns[0].ws.terminate(); // network gone / server restarted
    assert.ok(await until(() => flaky.conns.length === 2 && r2.state === 'online', 5000), 'back online by itself');
  } finally { r2.stop(); flaky.wss.close(); }
});

test('the service: --relay connects out; only its own page may change the relay', async () => {
  const srv = fakeServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irt-svc-'));
  const port = 51000 + Math.floor(Math.random() * 800);
  const svc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(port), '--no-frame', '--calibration', path.join(dir, 'c.json'), '--relay-file', path.join(dir, 'r.json'), '--relay', srv.code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; svc.stdout.on('data', d => { out += d; });
  try {
    assert.ok(await until(() => srv.got.some(m => m.type === 'RELAY_HELLO'), 6000), 'the service says hello to the server');
    const st = await (await fetch(`http://127.0.0.1:${port}/relay.json`)).json();
    assert.ok(await until(async () => (await (await fetch(`http://127.0.0.1:${port}/relay.json`)).json()).state === 'online'), `online (${JSON.stringify(st)})`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8')).code, srv.code, 'the code is kept for the next start');
    const foreign = await fetch(`http://127.0.0.1:${port}/relay`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403, 'a foreign page cannot switch it off');
    const page = await fetch(`http://127.0.0.1:${port}/relay`);
    assert.match(await page.text(), /Pairing code/);
    const bad = await fetch(`http://127.0.0.1:${port}/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` }, body: JSON.stringify({ code: 'nonsense' }) });
    assert.equal(bad.status, 400);
    const off = await fetch(`http://127.0.0.1:${port}/relay`, { method: 'DELETE', headers: { Origin: `http://localhost:${port}` } });
    assert.equal((await off.json()).configured, false, 'its own page can');
  } finally { svc.kill(); srv.wss.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
