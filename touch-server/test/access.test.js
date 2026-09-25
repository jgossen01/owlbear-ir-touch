'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { canCalibrate } = require('../access');

test('only the own calibration page or a local program may calibrate', () => {
  assert.equal(canCalibrate(undefined, 50000), true, 'no Origin header = not a browser');
  assert.equal(canCalibrate('http://localhost:50000', 50000), true);
  assert.equal(canCalibrate('http://127.0.0.1:50000', 50000), true);
  assert.equal(canCalibrate('http://[::1]:50000', 50000), true);
  assert.equal(canCalibrate('http://localhost:8788', 50000), false, 'another local port (a dev server, another app)');
  assert.equal(canCalibrate('https://www.owlbear.rodeo', 50000), false);
  assert.equal(canCalibrate('https://evil.example', 50000), false);
  assert.equal(canCalibrate('http://localhost.evil.example:50000', 50000), false);
  assert.equal(canCalibrate('null', 50000), false, 'sandboxed iframes / file pages');
});

/* the real service without a frame: a foreign page cannot change the calibration, the calibration page can */
test('the service refuses a calibration from a foreign page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irt-'));
  const file = path.join(dir, 'calibration.json');
  const port = 51000 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(port), '--no-frame', '--calibration', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', d => { out += d; });
  try {
    for (let i = 0; i < 100 && !/IR touch service/.test(out); i++) await new Promise(r => setTimeout(r, 50));
    const points = [{ rx: 0, ry: 0, fx: 0, fy: 0 }, { rx: 32767, ry: 0, fx: 1, fy: 0 }, { rx: 0, ry: 32767, fx: 0, fy: 1 }, { rx: 32767, ry: 32767, fx: 1, fy: 1 }];
    const talk = origin => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
      const got = [];
      ws.on('message', d => {
        const m = JSON.parse(d.toString()); got.push(m);
        if (m.type === 'HELLO') ws.send(JSON.stringify({ type: 'CALIBRATION', points }));
        if (m.type === 'ERROR' || m.type === 'CALIBRATED') { ws.close(); resolve(got); }
      });
      ws.on('error', reject);
    });
    const foreign = await talk('https://evil.example');
    assert.equal(foreign[foreign.length - 1].type, 'ERROR');
    assert.equal(fs.existsSync(file), false, 'nothing written');
    const del = await fetch(`http://127.0.0.1:${port}/calibration`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
    assert.equal(del.status, 403, 'nor can it be deleted over HTTP');
    const own = await talk(`http://localhost:${port}`);
    const last = own[own.length - 1];
    assert.equal(last.type, 'CALIBRATED');
    assert.equal(last.calibrated, true);
    assert.equal(fs.existsSync(file), true, 'the calibration page may');
  } finally { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
