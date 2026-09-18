import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inchToWidthMm, DEFAULT_SETTINGS, VERSION, CONFIG_KEY, STATUS_CHANNEL, SETTINGS_KEY, REMOTE_KEY, HERE_KEY, STATUS_KEY, CAST_PLAYER_NAME } from '../store.js';

test('43-inch 16:9 picture is 952 mm wide', () => { assert.equal(inchToWidthMm(43), 952); });
test('defaults are off, port 50000, physical scale on', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, false); assert.equal(DEFAULT_SETTINGS.port, 50000); assert.equal(DEFAULT_SETTINGS.physicalScale, true);
});
test('version is semver', () => { assert.match(VERSION, /^\d+\.\d+\.\d+$/); });
/* These keys are the contract between popover, background page and every other window in the room — a rename
   silently splits old and new windows into two configurations, so they are pinned here. */
test('the storage, room and broadcast keys are the documented ones', () => {
  assert.equal(CONFIG_KEY, 'de.jensgossen.ir-touch/config');
  assert.equal(STATUS_CHANNEL, 'de.jensgossen.ir-touch/status');
  assert.equal(SETTINGS_KEY, 'ir_touch_settings');
  assert.equal(REMOTE_KEY, 'ir_touch_remote');
  assert.equal(HERE_KEY, 'ir_touch_here');
  assert.equal(STATUS_KEY, 'ir_touch_status');
  assert.equal(CAST_PLAYER_NAME, 'Cast Receiver');
});
