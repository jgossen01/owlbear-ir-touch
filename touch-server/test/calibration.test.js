'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Calibration, fit } = require('../calibration');
const { RAW_MAX } = require('../frame');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-touch-cal-')), 'calibration.json');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
// frame corners sit 1000 raw units inside the picture edges; 10 % of the picture per calibration target
const POINTS = [
  { rx: 1000, ry: 1000, fx: 0.1, fy: 0.1 }, { rx: 31000, ry: 1000, fx: 0.9, fy: 0.1 },
  { rx: 31000, ry: 31000, fx: 0.9, fy: 0.9 }, { rx: 1000, ry: 31000, fx: 0.1, fy: 0.9 },
];

test('without a calibration the raw range maps 1:1 onto the picture', () => {
  const cal = new Calibration({ file: tmpFile() });
  assert.equal(cal.calibrated, false);
  near(cal.apply(0, 0).x, 0); near(cal.apply(RAW_MAX, RAW_MAX).x, 1); near(cal.apply(RAW_MAX, RAW_MAX).y, 1);
});

test('four corner points give an affine map that hits the centre and persists', () => {
  const file = tmpFile();
  const cal = new Calibration({ file });
  assert.equal(cal.set(POINTS), true);
  const mid = cal.apply(16000, 16000);
  near(mid.x, 0.5); near(mid.y, 0.5);
  near(cal.apply(1000, 31000).y, 0.9);
  assert.ok(fs.existsSync(file));
  const again = new Calibration({ file });
  assert.equal(again.calibrated, true);
  near(again.apply(16000, 16000).x, 0.5);
  assert.deepEqual(again.describe().points, POINTS);
});

test('degenerate points are rejected and clear() removes the file', () => {
  const file = tmpFile();
  const cal = new Calibration({ file });
  assert.equal(cal.set([{ rx: 5, ry: 5, fx: 0.1, fy: 0.1 }, { rx: 5, ry: 5, fx: 0.2, fy: 0.2 }, { rx: 5, ry: 5, fx: 0.3, fy: 0.3 }]), false);
  assert.equal(fit(null), null);
  cal.set(POINTS);
  cal.clear();
  assert.equal(cal.calibrated, false);
  assert.equal(fs.existsSync(file), false);
});
