'use strict';
/* Relay: the touch service connects OUT to a D&D Sync server and sends the contacts there; the server hands them to
   the campaign's table display. For a table display that cannot reach ws://localhost (Chrome's local network
   access check without the --disable-features switch, a cast window). The local WebSocket keeps working as before;
   the table display takes whichever it gets (localhost first).
     pairing code  https://<server>/#touch=<campaign>.<secret>   — created by the GM in D&D Sync (Table panel)
     protocol      → { type: 'RELAY_HELLO', key, version, service: <HELLO> }   ← { type: 'RELAY_OK' } | RELAY_REFUSED
                   then the same TOUCH / FRAME / CALIBRATED messages the local clients get
   Close codes from the server: 4001 replaced / revoked / another touch service took over, 4003 code refused —
   both mean "stop and wait for a new code"; anything else (server restart, network) → reconnect with back-off. */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const FILE = path.join(__dirname, 'relay.json');
const RELAY_PATH = '/api/vtt/touch-relay';

/* "https://host/#touch=12.abc…" → { url: 'wss://host/api/vtt/touch-relay', key: '12.abc…', server: 'https://host' } */
function parseCode(code) {
  let u; try { u = new URL(String(code || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const key = new URLSearchParams(u.hash.replace(/^#/, '')).get('touch') || '';
  if (!/^\d{1,10}\.[a-f0-9]{40}$/.test(key)) return null;
  return { url: `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}${RELAY_PATH}`, key, server: `${u.protocol}//${u.host}`, campaign: parseInt(key) };
}

class Relay {
  constructor({ file = FILE, hello, log = () => {}, WS = WebSocket } = {}) {
    this.file = file; this.hello = hello; this.log = log; this.WS = WS;
    this.target = null; this.ws = null; this.state = 'off'; this.error = null; this.retryMs = 2000; this.timer = null; this.sent = 0;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && j.code) this.target = parseCode(j.code); } catch (_) {}
  }
  describe() {
    return { configured: !!this.target, server: this.target ? this.target.server : null, campaign: this.target ? this.target.campaign : null, state: this.state, error: this.error, sent: this.sent };
  }
  /* a new pairing code (from --relay or the /relay page); null/'' switches the relay off */
  set(code) {
    const t = code ? parseCode(code) : null;
    if (code && !t) return false;
    this.stop();
    this.target = t; this.error = null;
    if (t) fs.writeFileSync(this.file, JSON.stringify({ code: `${t.server}/#touch=${t.key}`, savedAt: new Date().toISOString() }, null, 2));
    else { try { fs.unlinkSync(this.file); } catch (_) {} }
    this.start();
    return true;
  }
  start() {
    if (!this.target || this.ws) return;
    const t = this.target;
    this.state = 'connecting';
    let ws; try { ws = new this.WS(t.url); } catch (e) { this.error = e.message; return this.later(); }
    this.ws = ws;
    ws.on('open', () => { try { ws.send(JSON.stringify({ type: 'RELAY_HELLO', key: t.key, version: this.hello().version, service: this.hello() })); } catch (_) {} });
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch (_) { return; }
      if (m.type === 'RELAY_OK') { this.state = 'online'; this.error = null; this.retryMs = 2000; this.log(`relay: online via ${t.server} (campaign ${t.campaign})`); }
      if (m.type === 'RELAY_REFUSED') this.error = m.error || 'refused';
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const why = String(reason || '');
      if (code === 4001 || code === 4003) { // replaced, revoked or refused: wait for a new code
        this.state = 'stopped'; this.error = code === 4003 ? (this.error || 'the pairing code was refused') : `the server closed the relay: ${why || 'replaced'}`;
        this.log(`relay: ${this.error} — create a new code in D&D Sync (Table panel)`);
        return;
      }
      if (this.state === 'online') this.log(`relay: connection lost (${code}) — reconnecting`);
      this.later();
    });
    ws.on('error', e => { this.error = e.message; });
  }
  later() {
    this.state = 'waiting';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, this.retryMs);
    if (this.timer.unref) this.timer.unref();
    this.retryMs = Math.min(30000, this.retryMs * 2);
  }
  stop() {
    clearTimeout(this.timer); this.timer = null;
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.close(1000, 'stopped'); } catch (_) {} }
    this.state = 'off';
  }
  /* a message the local clients get (already JSON) — TOUCH / FRAME / CALIBRATED only */
  forward(s, type) {
    if (this.state !== 'online' || !this.ws || this.ws.readyState !== 1) return;
    if (type !== 'TOUCH' && type !== 'FRAME' && type !== 'CALIBRATED') return;
    try { this.ws.send(s); this.sent++; } catch (_) {}
  }
}

module.exports = { Relay, parseCode };
