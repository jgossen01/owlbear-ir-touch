# Changelog

## 1.0.1 — 2026-09-18

- With **snap on release** on, a phantom contact next to a figure you just lifted could still snap the token onto
  another cell. The phantom guard now applies to the snap as well — a contact that never lived long enough moves
  nothing.
- Right after start-up and after every zoom correction the table window ignored touches for up to half a second;
  it now works with the corrected view immediately.
- A touch table that is switched off (or that stops being the table window) tells the GM popover so, instead of
  showing as active until the room is reloaded. A bridge that was replaced can no longer overwrite the status of
  the one running now.
- A second GM window without settings of its own no longer publishes the defaults over the room settings and
  switches the table off; it simply follows what the room says.
- The table-test checklist in the README gained the phantom-with-snap case, and the required Node version is
  stated as 22 or newer (the test runner needs it).
- Development: the extension dev server binds `127.0.0.1` only, and the release script also bumps
  `touch-server/package-lock.json`, so a release no longer leaves the lock file dirty.

## 1.0.0 — 2026-09-18

First release as its own extension. Extracted from the D&D Sync extension (0.5.2) and its touch service (0.1.0):

- Touch service: raw USB reader for the IR frame (WinUSB), contact tracking, 4-point calibration, WebSocket protocol `ir-touch`
- Extension: contact → token binding with the "lifted" rule, plausibility checks and phantom guard; physical scale (1 cell = 1 inch); snap on release
- Settings travel GM → Cast window through room metadata; status comes back by broadcast
- The DigitalTableTops fallback protocol is gone
