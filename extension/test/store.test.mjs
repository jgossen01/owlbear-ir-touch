import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inchToWidthMm, DEFAULT_SETTINGS, VERSION } from '../store.js';

test('43-inch 16:9 picture is 952 mm wide', () => { assert.equal(inchToWidthMm(43), 952); });
test('defaults are off, port 50000, physical scale on', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, false); assert.equal(DEFAULT_SETTINGS.port, 50000); assert.equal(DEFAULT_SETTINGS.physicalScale, true);
});
test('version is semver', () => { assert.match(VERSION, /^\d+\.\d+\.\d+$/); });
