# Changelog

## 1.0.0 — 2026-09-18

First release as its own extension. Extracted from the D&D Sync extension (0.5.2) and its touch service (0.1.0):

- Touch service: raw USB reader for the IR frame (WinUSB), contact tracking, 4-point calibration, WebSocket protocol `ir-touch`
- Extension: contact → token binding with the "lifted" rule, plausibility checks and phantom guard; physical scale (1 cell = 1 inch); snap on release
- Settings travel GM → Cast window through room metadata; status comes back by broadcast
- The DigitalTableTops fallback protocol is gone
