# Changelog

## 1.4.0 — 2026-09-25

- **One figure at a time.** While a figure is dragged, all other figures are locked until half a second after it is
  put down: a hand brushing over another mini, or bumping one that stands, no longer drags it along. A contact on a
  locked figure stays bound, so it cannot grab the figure by surprise later; once the lock is over, moving that
  figure works as usual.

## 1.3.0 — 2026-09-25

- **The calibration is protected.** The table browser runs with the local-network-access check off, so any page open
  in it could reach the touch service — and overwrite or delete the calibration. Only the service's own calibration
  page (or a program on the PC) may change it now; anything else gets an `ERROR` (WebSocket) or a 403 (HTTP).
- **Contact size.** `TOUCH` messages carry `w, h` — the contact's size as the frame reports it, as a fraction of the
  picture (raw in `rw, rh`). The popover's log shows it in mm for every touch-down, to measure at the table how a
  mini's base, a finger and a phantom differ. Nothing depends on it yet.
- `--calibration <file>` and `--no-frame` for the service (tests). Update the touch service on the table PC
  (`git pull`, restart) — the extension works with older services too.

## 1.2.0 — 2026-09-25

- **Figures that stand are put down.** A mini that stays still on the glass for a moment now counts as set down —
  snapped to its cell (with snap on) without having to lift it. Its contact stays bound, so it can be dragged on.
- **No more shaking.** Contact positions are smoothed (One Euro filter); the jitter of a standing mini sends no
  updates to the room at all, a moving one follows with little lag.
- **Dropouts mid-drag are bridged.** When the frame loses a mini while it is dragged and finds it again close by
  (new contact id), the drag carries on instead of snapping the figure halfway and re-binding it. A phantom contact
  next to a lifted figure does not take it over (the 150 ms guard applies).
- The touch service is confirmed to work on macOS (HID direct mode; all contacts arrive although macOS itself has no
  multitouch support for touchscreens).

## 1.1.0 — 2026-09-19

- **No driver swap any more.** The touch service reads the frame through its vendor-defined HID channel (node-hid)
  and switches it to direct mode: the contacts go to the service, the OS no longer gets touch input, the mouse stays
  free. The Zadig/WinUSB step is only a fallback now (`--transport usb`, picked automatically when interface 0 is
  still on WinUSB). Stopping the service hands the touchscreen back to the OS. Run `npm install` in `touch-server`
  after updating. Thanks to the DigitalTableTops developer for the Greentouch direct-mode packets.
- `node probe.js` lists a frame's HID collections, `node direct.js` records what a frame sends in direct mode — for
  getting other frames to work.

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
