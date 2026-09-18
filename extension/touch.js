/* IR Touch — TouchBridge. Runs in the Owlbear client that is shown on the physical table display (Owlbear's
   Cast window, or a window marked "Use THIS window" in the popover).

   Talks to the IR touch service (touch-server/) on ws://localhost:<port>. The service greets with
     { type: 'HELLO', protocol: 'ir-touch', version, frame, calibration }
   and then streams raw contacts
     { type: 'TOUCH', id, phase: 'down'|'move'|'up', x, y }        x, y = fraction of the table display (0..1)

   Binding contact → token happens HERE, once per contact: at touch-down the token under the contact (within
   BIND_CELLS of its bounds), otherwise the figure lifted most recently, set down again somewhere else (the
   "lifted" rule, with plausibility checks). The binding holds for the lifetime of the contact; a hand next to
   the figure is a separate contact and binds to nothing.

   Physical scale: with the display width known, one grid cell is forced to exactly one inch (tick()).
   No imports — the module is testable in Node with a fake OBR (test/binding.test.mjs). */
export const PROTOCOL = 'ir-touch';
export const CLIENT_NAME = 'owlbear-ir-touch';
export const TOUCH_APPLY_MS = 40;      // a bound token follows its contact at most this often (latest position wins)
export const LIFT_BIND_MS = 12000;     // a touch-down on empty map binds to the figure lifted within the last … ms
export const BIND_CELLS = 0.6;         // touch-down within this many cells of a token's bounds still binds
export const LIFT_ARM_MS = 150;        // a contact bound by the "lifted" rule moves the token only after living this long (phantom guard)
export const LIFT_SPEED_CELLS = 40;    // a carried figure travels at most this many cells per second (≈ one 43″ table width)
export const LIFT_SLACK_CELLS = 1.5;   // … plus this much regardless of time (finger that lost contact mid-drag and keeps going)
export const LIFT_DRAG_BLOCK_MS = 1000; // another figure moved within this → a new contact on empty map is that hand, not a set-down figure …
export const LIFT_DRAG_GRACE_S = 0.5;  // … unless the lift was this recent (finger flicker while two fingers drag)
export const HELLO_TIMEOUT_MS = 3000;  // something answered on the port but never said HELLO → not our service
export const LNA_TIMEOUT_MS = 5000;    // socket stuck in CONNECTING → the browser blocks local network access
export const RECONNECT_MS = 5000;
const PLOG_MAX = 40;
const log = (...a) => console.log('[ir-touch]', ...a);

export class TouchBridge {
  /**
   * @param {object} OBR   the Owlbear SDK
   * @param {object} settings   { port, displayWidthMm, physicalScale, snap }
   * @param {(patch:object)=>void} onStatus
   */
  constructor(OBR, settings, onStatus) {
    this.OBR = OBR;
    this.settings = { port: 50000, displayWidthMm: 0, physicalScale: true, snap: false, ...settings };
    this.onStatus = onStatus || (() => {});
    this.helloTimeoutMs = HELLO_TIMEOUT_MS;
    this.ws = null; this.stopped = false;
    this.mode = null;          // null until the service said HELLO, then 'touch'
    this.touch = null;         // { frame, calibration, version } as reported by the service
    this.tokens = [];          // [{ id, name, x, y, w, h }] top-left, canvas units
    this.lastTokens = '';
    this.lastVp = null;        // { left, top, width, height } canvas units of the visible screen
    this.lastViewport = '';
    this.dpiCache = 0;
    this.contacts = new Map(); // contact id → { tokenId, name, offset, target, timer, armedAt, downAt, movedAt }
    this.lifted = null;        // { tokenId, name, at } figure lifted most recently → re-binds a touch-down on empty map
    this.chain = Promise.resolve(); // token updates are applied one after another
    this.plog = [];            // protocol / diagnostic log → popover
    this.counts = { in: 0, applied: 0, ignored: 0 };
    this.noteAt = new Map();
  }

  start() {
    this.stopped = false;
    this.connect();
    this.unsubItems = this.OBR.scene.items.onChange(() => this.scheduleTokens());
    this.unsubGrid  = this.OBR.scene.grid.onChange(() => { this.scheduleTokens(); this.tick(); });
    this.timer = setInterval(() => this.tick(), 500);
    this.scheduleTokens(); this.tick();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer); clearTimeout(this.tokenTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.connectTimer); clearTimeout(this.helloTimer);
    for (const c of this.contacts.values()) clearTimeout(c.timer);
    this.contacts.clear(); this.mode = null;
    if (this.unsubItems) this.unsubItems();
    if (this.unsubGrid) this.unsubGrid();
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    this.onStatus({ connected: false });
  }

  /* ── diagnostics ── */
  note(...a) {
    const line = `${new Date().toLocaleTimeString()} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`.slice(0, 220);
    this.plog.push(line); if (this.plog.length > PLOG_MAX) this.plog.shift();
    log(...a);
    this.onStatus({ plog: this.plog.slice(), counts: { ...this.counts } });
  }
  noteThrottled(key, ...a) { // phantom contacts flicker at 5–30 Hz next to a standing figure — one line per second per key
    const now = Date.now();
    const prev = this.noteAt.get(key) || { t: 0, n: 0 };
    if (now - prev.t < 1000) { prev.n++; this.noteAt.set(key, prev); return; }
    this.noteAt.set(key, { t: now, n: 0 });
    this.note(...a, prev.n ? `(+${prev.n} more in the last second)` : '');
  }

  /* ── socket ── */
  connect() {
    if (this.stopped) return;
    const url = `ws://localhost:${this.settings.port}`;
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { this.onStatus({ connected: false, error: e.message }); this.reconnectLater(); return; }
    this.ws = ws;
    // Chrome/Edge block ws://localhost from an embedded https page and report NOTHING — the socket just sits in CONNECTING.
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        this.onStatus({ connected: false, error: `${url} is blocked by the browser: Chrome/Edge do not let an embedded extension reach the local network. On the table PC start the browser with --disable-features=LocalNetworkAccessChecks (or disable chrome://flags/#local-network-access-check) and reload the room.` });
        try { ws.close(); } catch (_) {}
      }
    }, LNA_TIMEOUT_MS);
    ws.onopen = () => this.onOpen(ws, url);
    ws.onmessage = ev => {
      const text = ev.data instanceof Blob ? ev.data.text() : Promise.resolve(ev.data);
      text.then(t => this.handle(JSON.parse(t))).catch(e => log('bad message', e));
    };
    ws.onerror = () => { this.note('ws error', url); this.onStatus({ connected: false, error: `No touch service on ${url} — is "node touch-server/server.js" running on the table PC? If it is, the browser blocks local-network access from the extension: start it with --disable-features=LocalNetworkAccessChecks.` }); };
    ws.onclose = ev => { this.note('ws closed', ev && ev.code); this.mode = null; this.onStatus({ connected: false, protocol: null }); this.reconnectLater(); }; // keeps a previously set error text
  }
  onOpen(ws, url) {
    clearTimeout(this.connectTimer);
    this.note('ws connected', url);
    this.mode = null; this.contacts.clear();
    this.onStatus({ connected: true, error: null, protocol: null });
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      if (this.ws === ws && !this.mode) {
        this.onStatus({ connected: false, error: `Something answered on port ${this.settings.port} but it is not the IR touch service (no HELLO). Is another program using that port?` });
        try { ws.close(); } catch (_) {}
      }
    }, this.helloTimeoutMs);
  }
  reconnectLater() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
  }

  /* ── incoming ── */
  handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'HELLO' && msg.protocol === PROTOCOL) { this.note('←', msg); this.becomeTouch(msg); return; }
    if (this.mode !== 'touch') return; // nothing counts before the service said hello
    if (msg.type === 'TOUCH') { this.counts.in++; if (msg.phase !== 'move') this.note('←', msg); this.onTouch(msg); return; }
    this.note('←', msg);
    if (msg.type === 'FRAME') { this.touch.frame = msg; this.onStatus({ touch: this.touchStatus() }); }
    if (msg.type === 'CALIBRATED') { this.touch.calibration = msg; this.onStatus({ touch: this.touchStatus() }); }
  }
  becomeTouch(hello) {
    clearTimeout(this.helloTimer);
    this.mode = 'touch';
    this.touch = { frame: hello.frame || null, calibration: hello.calibration || null, version: hello.version };
    try { this.ws.send(JSON.stringify({ type: 'HELLO', client: CLIENT_NAME })); } catch (_) {}
    this.onStatus({ connected: true, error: null, protocol: PROTOCOL, touch: this.touchStatus() });
    this.refreshTokens(); this.tick();
  }
  touchStatus() {
    const t = this.touch || {};
    return { frame: !!(t.frame && t.frame.connected), frameName: t.frame && t.frame.name, frameError: t.frame && t.frame.error, calibrated: !!(t.calibration && t.calibration.calibrated), version: t.version, contacts: this.contacts.size, lifted: this.lifted && Date.now() - this.lifted.at < LIFT_BIND_MS ? this.lifted.name : null };
  }

  /* ── tokens + viewport ── */
  scheduleTokens() { clearTimeout(this.tokenTimer); this.tokenTimer = setTimeout(() => this.refreshTokens(), 120); }
  async refreshTokens() {
    if (!(await this.OBR.scene.isReady())) return;
    const items = await this.OBR.scene.items.getItems(i => i.layer === 'CHARACTER' && i.type === 'IMAGE');
    const out = [];
    for (const it of items) {
      let b;
      try { b = await this.OBR.scene.items.getItemBounds([it.id]); } catch (_) { continue; }
      out.push({ id: it.id, name: (it.text && it.text.plainText) || it.name || '', x: Math.round(b.min.x), y: Math.round(b.min.y), w: Math.round(b.width), h: Math.round(b.height) });
    }
    this.tokens = out;
    const json = JSON.stringify(out);
    if (json !== this.lastTokens) { this.lastTokens = json; this.onStatus({ tokens: out.length }); }
  }
  async tick() {
    if (!(await this.OBR.scene.isReady())) return;
    const OBR = this.OBR;
    const [pos, scale, w, h, dpi] = await Promise.all([OBR.viewport.getPosition(), OBR.viewport.getScale(), OBR.viewport.getWidth(), OBR.viewport.getHeight(), OBR.scene.grid.getDpi()]);
    // physical scale: one grid cell = one inch on the display
    if (this.settings.physicalScale && this.settings.displayWidthMm > 100 && w > 0 && dpi > 0) {
      const pxPerInch = w / (this.settings.displayWidthMm / 25.4);
      const wanted = pxPerInch / dpi;
      if (Math.abs(scale - wanted) / wanted > 0.01) {
        const cx = (w / 2 - pos.x) / scale, cy = (h / 2 - pos.y) / scale; // zoom around the screen centre so the map does not jump
        const newPos = { x: w / 2 - cx * wanted, y: h / 2 - cy * wanted };
        await OBR.viewport.setScale(wanted);
        await OBR.viewport.setPosition(newPos);
        // keep the viewport we just asked for — without it onTouch would drop every contact until the next tick
        this.lastVp = { left: -newPos.x / wanted, top: -newPos.y / wanted, width: w / wanted, height: h / wanted };
        this.dpiCache = dpi;
        this.lastViewport = JSON.stringify(this.lastVp);
        this.onStatus({ scale: wanted, pxPerInch: Math.round(pxPerInch), viewport: `${Math.round(w)}×${Math.round(h)} px · scale ${wanted.toFixed(3)} · dpi ${dpi}` });
        return; // corrected already — the next tick only confirms it
      }
    }
    this.lastVp = { left: -pos.x / scale, top: -pos.y / scale, width: w / scale, height: h / scale };
    this.dpiCache = dpi;
    const json = JSON.stringify(this.lastVp);
    if (json !== this.lastViewport) { this.lastViewport = json; this.onStatus({ viewport: `${Math.round(w)}×${Math.round(h)} px · scale ${scale.toFixed(3)} · dpi ${dpi}` }); }
  }

  /* ── contact → token binding ── */
  onTouch(m) {
    const v = this.lastVp; if (!v) { this.counts.ignored++; return; }
    const now = Date.now();
    const p = { x: v.left + m.x * v.width, y: v.top + m.y * v.height };
    const dpi = this.dpiCache || 150;
    if (m.phase === 'down') {
      const boundIds = new Set([...this.contacts.values()].map(c => c.tokenId));
      let tok = this.tokenAt(p, dpi), how = 'under contact';
      if (tok && boundIds.has(tok.id)) { this.counts.ignored++; this.noteThrottled('held:' + tok.id, 'touch #' + m.id, 'down on', tok.name, '— already held by another contact, ignored'); return; }
      let why = '';
      if (!tok && this.lifted && now - this.lifted.at < LIFT_BIND_MS && !boundIds.has(this.lifted.tokenId)) {
        /* "Lifted" rule: a contact on empty map may be the figure set down again — or the other hand, a phantom
           next to a dragged figure, or a finger that lost contact mid-drag. Plausibility: (1) the figure cannot
           have travelled faster than a hand carries it; (2) while another figure is actively being dragged, a new
           contact elsewhere is that player's hand, not a figure being set down. */
        const lt = this.tokens.find(t => t.id === this.lifted.tokenId);
        const elapsed = (now - this.lifted.at) / 1000;
        const distCells = lt ? Math.hypot(lt.x + lt.w / 2 - p.x, lt.y + lt.h / 2 - p.y) / dpi : 0;
        const maxCells = LIFT_SLACK_CELLS + LIFT_SPEED_CELLS * elapsed;
        const dragging = [...this.contacts.values()].some(c => c.tokenId !== this.lifted.tokenId && now - (c.movedAt || 0) < LIFT_DRAG_BLOCK_MS);
        if (!lt) why = 'lifted figure gone';
        else if (distCells > maxCells) why = `${this.lifted.name} lifted ${elapsed.toFixed(1)} s ago is ${distCells.toFixed(1)} cells away (max ${maxCells.toFixed(1)})`;
        else if (dragging && elapsed > LIFT_DRAG_GRACE_S) why = `${this.lifted.name} lifted ${elapsed.toFixed(1)} s ago, but another figure is being dragged right now`;
        else { tok = lt; how = 'lifted ' + elapsed.toFixed(1) + ' s ago'; }
      }
      if (!tok) {
        this.counts.ignored++;
        this.noteThrottled('nothing', 'touch #' + m.id, 'down on nothing at', this.screenPct(p), why ? '— not rebound: ' + why : '');
        this.onStatus({ touch: this.touchStatus(), lastUnbound: `${Math.round(m.x * 100)}%,${Math.round(m.y * 100)}%` });
        return;
      }
      const centre = { x: tok.x + tok.w / 2, y: tok.y + tok.h / 2 };
      // keep the offset between contact and token centre — a finger at the edge must not make the token jump;
      // a figure set down on empty map (lifted rule) is centred under the contact
      const offset = how === 'under contact' ? { x: centre.x - p.x, y: centre.y - p.y } : { x: 0, y: 0 };
      const c = { tokenId: tok.id, name: tok.name, offset, target: null, timer: null, downAt: now, movedAt: 0, armedAt: 0 };
      this.contacts.set(m.id, c);
      if (this.lifted && this.lifted.tokenId === tok.id) this.lifted = null;
      this.note('touch #' + m.id, 'down →', tok.name, '(' + how + ')', this.screenPct(p));
      if (how !== 'under contact') {
        // the "lifted" rule may catch a phantom contact of the frame (they live 30–500 ms next to a figure) —
        // move the token only once the contact has survived LIFT_ARM_MS
        c.target = { x: p.x + offset.x, y: p.y + offset.y }; c.armedAt = now + LIFT_ARM_MS;
        c.timer = setTimeout(() => { c.timer = null; if (this.contacts.get(m.id) === c) this.chain = this.chain.then(() => this.applyTouch(c, false)).catch(e => log('touch apply failed', e)); }, LIFT_ARM_MS);
      }
      this.onStatus({ touch: this.touchStatus(), lastMoveName: tok.name });
    } else if (m.phase === 'move') {
      const c = this.contacts.get(m.id); if (!c) return;
      c.target = { x: p.x + c.offset.x, y: p.y + c.offset.y }; c.movedAt = now;
      this.scheduleApply(m.id, c);
    } else if (m.phase === 'up') {
      const c = this.contacts.get(m.id); if (!c) return;
      clearTimeout(c.timer); c.timer = null;
      this.contacts.delete(m.id);
      this.lifted = { tokenId: c.tokenId, name: c.name, at: now };
      this.note('touch #' + m.id, 'up ←', c.name, 'held', Math.round((now - c.downAt) / 100) / 10, 's');
      // snap only when the contact is armed — a phantom bound by the "lifted" rule that dies before LIFT_ARM_MS
      // must not move the token either (applyTouch skips the arm guard for a final apply). Under-contact binds
      // have armedAt = 0 and snap as usual.
      if (this.settings.snap && c.target && (!c.armedAt || now >= c.armedAt)) this.chain = this.chain.then(() => this.applyTouch(c, true)).catch(e => log('snap failed', e));
      this.onStatus({ touch: this.touchStatus() });
    }
  }
  tokenAt(p, dpi) { // token whose bounds (grown by BIND_CELLS) contain p, nearest centre wins
    let best = null, bestD = Infinity;
    const grow = BIND_CELLS * dpi;
    for (const t of this.tokens) {
      if (p.x < t.x - grow || p.x > t.x + t.w + grow || p.y < t.y - grow || p.y > t.y + t.h + grow) continue;
      const d = Math.hypot(t.x + t.w / 2 - p.x, t.y + t.h / 2 - p.y);
      if (d < bestD) { best = t; bestD = d; }
    }
    return best;
  }
  scheduleApply(id, c) {
    if (c.timer) return;
    c.timer = setTimeout(() => { c.timer = null; if (this.contacts.get(id) === c) this.chain = this.chain.then(() => this.applyTouch(c, false)).catch(e => log('touch apply failed', e)); }, TOUCH_APPLY_MS);
  }
  async applyTouch(c, final) {
    const target = c.target; if (!target) return;
    if (c.armedAt && Date.now() < c.armedAt && !final) return; // not yet — the arm timer applies the latest target
    const items = await this.OBR.scene.items.getItems([c.tokenId]);
    if (!items.length) { for (const [id, cc] of this.contacts) if (cc === c) this.contacts.delete(id); return; } // token deleted while held
    const it = items[0];
    let b = null;
    try { b = await this.OBR.scene.items.getItemBounds([it.id]); } catch (_) { return; }
    if (!b || !(b.width > 0)) return;
    const cur = { x: b.min.x + b.width / 2, y: b.min.y + b.height / 2 };
    let dest = target;
    if (final && this.settings.snap) { try { dest = await this.OBR.scene.grid.snapPosition(target, 1, false, true); } catch (_) {} }
    const dx = dest.x - cur.x, dy = dest.y - cur.y;
    if (Math.hypot(dx, dy) < 0.5) return;
    await this.OBR.scene.items.updateItems([it], drafts => { for (const d of drafts) d.position = { x: d.position.x + dx, y: d.position.y + dy }; });
    this.counts.applied++;
    const t = this.tokens.find(x => x.id === it.id); if (t) { t.x = dest.x - b.width / 2; t.y = dest.y - b.height / 2; }
    this.onStatus({ lastMove: Date.now(), lastMoveName: c.name, lastMoveDelta: `${Math.round(dx)},${Math.round(dy)}`, counts: { ...this.counts } });
  }
  screenPct(p) { // canvas → % of the table display
    const v = this.lastVp; if (!v) return '?';
    return `${Math.round((p.x - v.left) / v.width * 100)}% from left, ${Math.round((p.y - v.top) / v.height * 100)}% from top`;
  }
}
