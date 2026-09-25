'use strict';
/* Turns frame reports into contact events: down / move / up per contact id.
   The frame reports tip=0 once when an object leaves; as a safety net a contact that is not mentioned for
   GONE_MS while other reports arrive, or with no reports at all for SILENT_MS, is closed too. */
const EventEmitter = require('events');
const GONE_MS = 150, SILENT_MS = 1000;

class Tracker extends EventEmitter {
  constructor() {
    super();
    this.active = new Map(); // id → { rx, ry, rw, rh, downAt, seenAt }
    this.timer = setInterval(() => this.sweep(), 50);
    this.lastReportAt = 0;
  }
  feed(rep) {
    this.lastReportAt = rep.t;
    for (const c of rep.contacts) {
      const cur = this.active.get(c.id);
      if (c.tip) {
        // rw, rh = the contact's size as the frame reports it (raw units, 0 when it does not); a size change alone is no move
        if (!cur) { this.active.set(c.id, { rx: c.rx, ry: c.ry, rw: c.w || 0, rh: c.h || 0, downAt: rep.t, seenAt: rep.t }); this.emit('touch', { id: c.id, phase: 'down', rx: c.rx, ry: c.ry, rw: c.w || 0, rh: c.h || 0, t: rep.t }); }
        else {
          cur.seenAt = rep.t; if (c.w || c.h) { cur.rw = c.w || 0; cur.rh = c.h || 0; }
          if (cur.rx !== c.rx || cur.ry !== c.ry) { cur.rx = c.rx; cur.ry = c.ry; this.emit('touch', { id: c.id, phase: 'move', rx: c.rx, ry: c.ry, rw: cur.rw, rh: cur.rh, t: rep.t }); }
        }
      } else if (cur) {
        this.active.delete(c.id);
        this.emit('touch', { id: c.id, phase: 'up', rx: c.rx, ry: c.ry, rw: cur.rw, rh: cur.rh, t: rep.t, held: rep.t - cur.downAt });
      }
    }
    // a full report (count > 0) lists every live contact — anything missing is gone (hybrid follow-ups carry count 0 and are partial)
    if (rep.count > 0 && rep.contacts.length >= Math.min(rep.count, 6)) {
      const seen = new Set(rep.contacts.map(c => c.id));
      for (const [id, cur] of this.active) if (!seen.has(id) && rep.t - cur.seenAt > GONE_MS) this.close(id, cur, rep.t, 'missing');
    }
  }
  sweep() {
    const now = Date.now();
    for (const [id, cur] of this.active) if (now - this.lastReportAt > SILENT_MS && now - cur.seenAt > SILENT_MS) this.close(id, cur, now, 'silent');
  }
  close(id, cur, t, why) {
    this.active.delete(id);
    this.emit('touch', { id, phase: 'up', rx: cur.rx, ry: cur.ry, rw: cur.rw, rh: cur.rh, t, held: t - cur.downAt, why });
  }
  stop() { clearInterval(this.timer); }
}
module.exports = { Tracker };
