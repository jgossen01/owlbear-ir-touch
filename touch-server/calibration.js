'use strict';
/* Affine map raw frame coordinates → fractions of the display picture (0..1).
   Fitted by least squares from ≥ 3 reference points (the calibration page uses 4, one near each corner).
   Without a calibration the raw range is mapped 1:1 onto the picture — good enough to get started when the
   frame's active area matches the panel. */
const fs = require('fs');
const path = require('path');
const { RAW_MAX } = require('./frame');

const FILE = path.join(__dirname, 'calibration.json');
const IDENTITY = { a: 1 / RAW_MAX, b: 0, c: 0, d: 0, e: 1 / RAW_MAX, f: 0 };

function solve3(m, v) { // Gaussian elimination, 3×3
  const A = m.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let j = c; j < 4; j++) A[r][j] -= k * A[c][j]; }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}
function fit(points) { // [{ rx, ry, fx, fy }]
  if (!points || points.length < 3) return null;
  const S = { xx: 0, xy: 0, x: 0, yy: 0, y: 0, n: points.length, xfx: 0, yfx: 0, fx: 0, xfy: 0, yfy: 0, fy: 0 };
  for (const p of points) { S.xx += p.rx * p.rx; S.xy += p.rx * p.ry; S.x += p.rx; S.yy += p.ry * p.ry; S.y += p.ry; S.xfx += p.rx * p.fx; S.yfx += p.ry * p.fx; S.fx += p.fx; S.xfy += p.rx * p.fy; S.yfy += p.ry * p.fy; S.fy += p.fy; }
  const M = [[S.xx, S.xy, S.x], [S.xy, S.yy, S.y], [S.x, S.y, S.n]];
  const r1 = solve3(M, [S.xfx, S.yfx, S.fx]), r2 = solve3(M, [S.xfy, S.yfy, S.fy]);
  if (!r1 || !r2) return null;
  return { a: r1[0], b: r1[1], c: r1[2], d: r2[0], e: r2[1], f: r2[2] };
}
class Calibration {
  constructor(opts = {}) { this.file = opts.file || FILE; this.map = null; this.points = null; this.savedAt = null; this.load(); }
  load() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j && j.map) { this.map = j.map; this.points = j.points || null; this.savedAt = j.savedAt || null; } } catch (_) {}
  }
  set(points) {
    const map = fit(points);
    if (!map) return false;
    this.map = map; this.points = points; this.savedAt = new Date().toISOString();
    fs.writeFileSync(this.file, JSON.stringify({ map, points, savedAt: this.savedAt }, null, 2));
    return true;
  }
  clear() { this.map = null; this.points = null; this.savedAt = null; try { fs.unlinkSync(this.file); } catch (_) {} }
  apply(rx, ry) {
    const m = this.map || IDENTITY;
    return { x: m.a * rx + m.b * ry + m.c, y: m.d * rx + m.e * ry + m.f };
  }
  /* size raw → fractions of the display: the bounding box of the mapped raw rectangle (w of the picture width, h of its height) */
  size(rw, rh) {
    const m = this.map || IDENTITY;
    return { w: Math.abs(m.a) * rw + Math.abs(m.b) * rh, h: Math.abs(m.d) * rw + Math.abs(m.e) * rh };
  }
  get calibrated() { return !!this.map; }
  describe() { return { calibrated: this.calibrated, savedAt: this.savedAt, points: this.points }; }
}
module.exports = { Calibration, fit };
