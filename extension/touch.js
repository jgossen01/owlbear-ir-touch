/* IR Touch — TouchBridge. Runs in the Owlbear client that is shown on the physical table display (Owlbear's
   Cast window, or a window marked "Use THIS window" in the popover).

   Talks to the IR touch service (touch-server/) on ws://localhost:<port>. The service greets with
     { type: 'HELLO', protocol: 'ir-touch', version, frame, calibration }
   and then streams raw contacts
     { type: 'TOUCH', id, phase: 'down'|'move'|'up', x, y, w, h }  x, y = fraction of the table display (0..1),
                                                                    w, h = contact size (service ≥ 1.3.0, diagnostics only)

   Binding contact → token happens HERE, once per contact: at touch-down the token under the contact (within
   BIND_CELLS of its bounds), otherwise the figure lifted most recently, set down again somewhere else (the
   "lifted" rule, with plausibility checks). The binding holds for the lifetime of the contact; a hand next to
   the figure is a separate contact and binds to nothing.

   A miniature is not a finger: it is put down and stays. So a bound contact is
     dragging  → the token follows it (position smoothed with a One Euro filter, at most every TOUCH_APPLY_MS);
     standing  → it has not moved more than STILL_CELLS for SETTLE_MS: the figure counts as put down (snapped when
                 snap is on) while the contact stays bound; the frame's jitter is ignored — no updates for the
                 whole room — until it moves more than RESUME_CELLS, then it drags on without a jump;
     lost      → it vanished mid-drag (IR shadow, a hand in the way): for LOST_MS a new contact within LOST_CELLS
                 carries on with the same figure instead of dropping (and snapping) it halfway.
   One figure at a time: while a figure is dragged (and LOCK_GRACE_MS after it is put down, while the hand is
   withdrawn) every other figure is locked — a contact on it binds but moves nothing, a nudged standing figure stays
   where it is. Two figures are practically never moved at the very same moment; a hand brushing past one is.
   Stillness and jitter are measured in cells on the display, so a viewport change is not a moving figure.

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
export const STILL_CELLS = 0.2;        // a contact that stays within this …
export const SETTLE_MS = 350;          // … for this long stands: the figure is put down (snapped), the contact stays bound
export const RESUME_CELLS = 0.35;      // a standing contact must move this far to drag again (the frame jitters by a few mm)
export const LOST_MS = 300;            // a contact gone mid-drag is kept this long …
export const LOST_CELLS = 1.2;         // … for a new contact this close by to carry on with (IR dropout, a hand in the way)
export const LOCK_GRACE_MS = 500;      // the other figures stay locked this long after the moving one is put down
export const OFFSET_EASE_S = 0.12;     // after a pause the token eases back under the contact at this time constant
export const EURO = { minCutoff: 1.5, beta: 2, dCutoff: 1 }; // One Euro filter; beta per cell/s
const TICK_MS = 16;
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
    this.contacts = new Map(); // contact id → { tokenId, name, state: 'drag'|'standing', offset, base, target, f (filtered fraction), … }
    this.lost = new Map();     // contacts gone mid-drag, waiting LOST_MS for a new contact close by
    this.lock = null;          // { tokenId, until } the figure on the move — every other one is locked
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
    this.release(); this.mode = null;
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
    this.mode = null; this.release();
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
    return { frame: !!(t.frame && t.frame.connected), frameName: t.frame && t.frame.name, frameError: t.frame && t.frame.error, calibrated: !!(t.calibration && t.calibration.calibrated), version: t.version, contacts: this.contacts.size, standing: [...this.contacts.values()].filter(c => c.state === 'standing').length, lifted: this.lifted && Date.now() - this.lifted.at < LIFT_BIND_MS ? this.lifted.name : null };
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
    const p = this.toCanvas(m);
    const dpi = this.dpiCache || 150;
    if (m.phase === 'down') {
      // a contact that vanished mid-drag a moment ago and reappears close by is the same figure
      for (const [id, c] of this.lost) {
        if (this.cellsBetween(m, c.f) > LOST_CELLS) continue;
        // a hand next to a lifted figure makes phantom contacts too: like the "lifted" rule, the new contact takes
        // over only once it has lived LIFT_ARM_MS; one that dies before is dropped and the figure stays lost
        this.lost.delete(id);
        c.saved = { f: c.f, df: c.df, fAt: c.fAt, raw: c.raw, rawAt: c.rawAt, lostAt: c.lostAt };
        c.armedAt = now + LIFT_ARM_MS; c.raw = { x: m.x, y: m.y }; c.rawAt = now;
        this.contacts.set(m.id, c);
        this.note('touch #' + m.id, 'down → carries on with', c.name, `(#${id} lost ${Math.round(now - (c.lostSince || now))} ms ago)`);
        this.loop();
        return;
      }
      const boundIds = new Set([...this.contacts.values(), ...this.lost.values()].map(c => c.tokenId));
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
        this.noteThrottled('nothing', 'touch #' + m.id, 'down on nothing at', this.screenPct(p), this.sizeText(m), why ? '— not rebound: ' + why : '');
        this.onStatus({ touch: this.touchStatus(), lastUnbound: `${Math.round(m.x * 100)}%,${Math.round(m.y * 100)}%` });
        return;
      }
      const locked = this.locked(tok.id, now);
      if (locked && how !== 'under contact') { this.counts.ignored++; this.noteThrottled('locked', 'touch #' + m.id, 'down — not rebound to', tok.name, ': another figure is on the move'); return; }
      const centre = { x: tok.x + tok.w / 2, y: tok.y + tok.h / 2 };
      // keep the offset between contact and token centre — a finger at the edge must not make the token jump;
      // a figure set down on empty map (lifted rule) is centred under the contact. The "lifted" rule may catch a
      // phantom contact of the frame (they live 30–500 ms next to a figure) — such a contact moves the token only
      // once it has survived LIFT_ARM_MS.
      const under = how === 'under contact';
      const offset = under ? { x: centre.x - p.x, y: centre.y - p.y } : { x: 0, y: 0 };
      const f = { x: m.x, y: m.y };
      const c = { tokenId: tok.id, name: tok.name, state: locked ? 'standing' : 'drag', offset, base: { ...offset }, target: null, timer: null, downAt: now, movedAt: 0,
        armedAt: under ? 0 : now + LIFT_ARM_MS, moved: !under, dirty: !under, raw: { ...f }, rawAt: now, f, df: { x: 0, y: 0 }, fAt: now,
        anchor: { ...f }, stillSince: now, lostAt: 0 };
      this.contacts.set(m.id, c);
      if (this.lifted && this.lifted.tokenId === tok.id) this.lifted = null;
      this.note('touch #' + m.id, 'down →', tok.name, '(' + how + ')', this.screenPct(p), this.sizeText(m), locked ? '— locked: another figure is on the move' : '');
      this.onStatus({ touch: this.touchStatus(), lastMoveName: tok.name });
      this.loop();
    } else if (m.phase === 'move') {
      const c = this.contacts.get(m.id); if (!c) return;
      c.raw = { x: m.x, y: m.y }; c.rawAt = now;
      this.smooth(c, now);
    } else if (m.phase === 'up') {
      const c = this.contacts.get(m.id); if (!c) return;
      this.contacts.delete(m.id);
      const armed = !c.armedAt || now >= c.armedAt;
      if (c.saved && !armed) { Object.assign(c, c.saved); c.saved = null; this.lost.set(m.id, c); this.noteThrottled('phantom', 'touch #' + m.id, 'up ← a phantom next to', c.name, '— ignored'); return; }
      if (c.state === 'drag' && c.moved && armed) { c.lostAt = c.lostSince = now; this.lost.set(m.id, c); this.note('touch #' + m.id, 'up ←', c.name, '— waiting', LOST_MS, 'ms for it to come back'); return; }
      // a phantom bound by the "lifted" rule that dies before LIFT_ARM_MS moves nothing (no snap either)
      clearTimeout(c.timer); c.timer = null;
      this.lifted = { tokenId: c.tokenId, name: c.name, at: now };
      this.note('touch #' + m.id, 'up ←', c.name, 'held', Math.round((now - c.downAt) / 100) / 10, 's');
      this.onStatus({ touch: this.touchStatus() });
    }
  }
  /* the contact's size as the frame reports it (service ≥ 1.3.0) — in mm once the display width is known, to tell
     a mini's base from a finger or a phantom at the table */
  sizeText(m) {
    if (!(m.w > 0 || m.h > 0)) return '';
    const v = this.lastVp, mm = this.settings.displayWidthMm;
    if (mm > 100 && v && v.width > 0) return `size ${Math.round(m.w * mm)}×${Math.round(m.h * mm * v.height / v.width)} mm`;
    return `size ${(m.w * 100).toFixed(1)}%×${(m.h * 100).toFixed(1)}%`;
  }
  toCanvas(f) { const v = this.lastVp; return { x: v.left + f.x * v.width, y: v.top + f.y * v.height }; }
  cellsBetween(a, b) { const v = this.lastVp, dpi = this.dpiCache || 150; return Math.hypot((a.x - b.x) * v.width, (a.y - b.y) * v.height) / dpi; }
  /* One Euro filter on the display position: steady when still, little lag when moved fast */
  smooth(c, now) {
    const v = this.lastVp; if (!v) return;
    const dt = Math.max(0.001, (now - c.fAt) / 1000), dpi = this.dpiCache || 150;
    const a = cut => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
    const ad = a(EURO.dCutoff);
    c.df = { x: c.df.x + ad * ((c.raw.x - c.f.x) / dt - c.df.x), y: c.df.y + ad * ((c.raw.y - c.f.y) / dt - c.df.y) };
    const speed = Math.hypot(c.df.x * v.width, c.df.y * v.height) / dpi; // cells per second
    const k = a(EURO.minCutoff + EURO.beta * speed);
    c.f = { x: c.f.x + k * (c.raw.x - c.f.x), y: c.f.y + k * (c.raw.y - c.f.y) };
    c.fAt = now;
    if (this.cellsBetween(c.f, c.anchor) > (c.state === 'standing' ? RESUME_CELLS : STILL_CELLS)) {
      if (c.state === 'standing' && this.locked(c.tokenId, now)) { c.anchor = { ...c.f }; c.stillSince = now; return; } // nudged while another figure moves
      if (c.state === 'standing') this.resume(c);
      c.anchor = { ...c.f }; c.stillSince = now; c.movedAt = now; c.moved = true;
    }
    if (c.state === 'drag' && c.moved) c.dirty = true;
  }
  /* while contacts are down: follow the dragged ones, put down the ones that stand still, give up lost ones */
  loop() {
    if (this.loopTimer) return;
    this.loopTimer = setInterval(() => this.step(), TICK_MS);
    if (this.loopTimer && this.loopTimer.unref) this.loopTimer.unref();
  }
  step() {
    const now = Date.now();
    for (const c of this.lost.values()) if (now - c.rawAt > 20) this.smooth(c, now);
    for (const [id, c] of this.lost) if (now - c.lostAt > LOST_MS) {
      this.lost.delete(id);
      this.lifted = { tokenId: c.tokenId, name: c.name, at: c.lostAt };
      this.note('touch #' + id, 'gone —', c.name, 'put down');
      this.follow(c, true); this.drop(c);
      this.onStatus({ touch: this.touchStatus() });
    }
    for (const c of this.contacts.values()) {
      if (now - c.rawAt > 20) this.smooth(c, now); // no report = the contact did not move: the filter settles on it
      if (c.state !== 'drag' || (c.armedAt && now < c.armedAt)) continue;
      if (c.saved) { c.saved = null; c.lostAt = 0; c.stillSince = now; c.anchor = { ...c.f }; } // the contact that took over lived long enough
      if (c.moved) {
        // one figure at a time: the first one to move holds the lock, a second one stays where it is
        if (this.locked(c.tokenId, now)) { clearTimeout(c.timer); c.timer = null; c.state = 'standing'; c.target = null; c.anchor = { ...c.f }; c.stillSince = now; this.noteThrottled('locked:' + c.tokenId, c.name, 'stays — another figure is on the move'); continue; }
        this.lock = { tokenId: c.tokenId, until: Infinity };
      }
      if (now - c.stillSince >= SETTLE_MS) { this.follow(c, true); this.drop(c); c.state = 'standing'; c.anchor = { ...c.f }; continue; }
      if (c.dirty) this.follow(c);
    }
    // the figure holding the lock is put down (or lifted): the others stay locked a moment longer, while the hand is withdrawn
    const l = this.lock;
    if (l && l.until === Infinity && ![...this.contacts.values(), ...this.lost.values()].some(c => c.tokenId === l.tokenId && c.state === 'drag' && c.moved)) l.until = now + LOCK_GRACE_MS;
    if (!this.contacts.size && !this.lost.size) { clearInterval(this.loopTimer); this.loopTimer = null; }
  }
  follow(c, exact = false) {
    if (!this.lastVp || !c.moved) return;
    c.dirty = false;
    // after a pause the figure starts where it was put down; the offset eases back to where the hand holds it
    const k = exact ? 1 : 1 - Math.exp(-(TICK_MS / 1000) / OFFSET_EASE_S);
    c.offset = { x: c.offset.x + (c.base.x - c.offset.x) * k, y: c.offset.y + (c.base.y - c.offset.y) * k };
    if (Math.abs(c.offset.x - c.base.x) > 0.3 || Math.abs(c.offset.y - c.base.y) > 0.3) c.dirty = true;
    const p = this.toCanvas(c.f), t = { x: p.x + c.offset.x, y: p.y + c.offset.y };
    if (c.target && Math.hypot(t.x - c.target.x, t.y - c.target.y) < 0.5) return;
    c.target = t;
    if (!exact) this.scheduleApply(c);
  }
  /* the figure is put down (lifted, or standing still): the last position, snapped when snap is on */
  drop(c) {
    clearTimeout(c.timer); c.timer = null;
    if (!c.target) return;
    this.chain = this.chain.then(() => this.applyTouch(c, true)).catch(e => log('put down failed', e));
  }
  /* a standing figure is moved again: drag on from where it stands (no jump), the offset eases back */
  resume(c) {
    const t = this.tokens.find(x => x.id === c.tokenId), p = this.toCanvas(c.f);
    c.state = 'drag';
    if (t) c.offset = { x: t.x + t.w / 2 - p.x, y: t.y + t.h / 2 - p.y };
  }
  locked(tokenId, now) { const l = this.lock; return !!l && l.tokenId !== tokenId && now < l.until; }
  release() {
    clearInterval(this.loopTimer); this.loopTimer = null; this.lock = null;
    for (const c of [...this.contacts.values(), ...this.lost.values()]) clearTimeout(c.timer);
    this.contacts.clear(); this.lost.clear();
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
  scheduleApply(c) {
    if (c.timer) return;
    c.timer = setTimeout(() => { c.timer = null; if (c.state === 'drag') this.chain = this.chain.then(() => this.applyTouch(c, false)).catch(e => log('touch apply failed', e)); }, TOUCH_APPLY_MS);
  }
  async applyTouch(c, final) {
    const target = c.target; if (!target) return;
    if (c.armedAt && Date.now() < c.armedAt && !final) return; // not yet — the arm timer applies the latest target
    const items = await this.OBR.scene.items.getItems([c.tokenId]);
    if (!items.length) { for (const [id, cc] of this.contacts) if (cc === c) this.contacts.delete(id); for (const [id, cc] of this.lost) if (cc === c) this.lost.delete(id); return; } // token deleted while held
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
