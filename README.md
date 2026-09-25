# IR Touch for Owlbear Rodeo

Move Owlbear Rodeo tokens by moving **physical miniatures** on a TV that lies flat in the table, with an
**infrared multitouch frame** on top. A small service on the table PC reads the frame directly and streams the
contacts to the extension; the extension decides which token a contact belongs to and drags it along — including
the figure being lifted and set down somewhere else.

<!-- screenshot / gif of the table goes here -->

Tested hardware: **Greentouch GT-IR-F43** infrared touch frame (43″, 50 contacts; shows up as
InfraredMultiTouch "Touch Device,43-50P", USB `08D3:1000`). Other frames: see *Other frames* below.

## What you need

- A Windows PC or a Mac connected to the TV in the table, with the IR frame plugged in over USB (direct mode uses
  plain HID, so macOS's missing multitouch support for touchscreens does not matter; Linux should work too — untested)
- [Node.js](https://nodejs.org) 22 or newer on that PC
- Chrome or Edge on that PC (it runs Owlbear's Cast window on the TV)
- An Owlbear Rodeo room (the GM installs the extension, everybody can keep playing as usual)

## Setup

### 1. Touch service on the table PC

```
git clone https://github.com/jgossen01/owlbear-ir-touch
cd owlbear-ir-touch/touch-server
npm install
```

Start the service: `node server.js` (or `npm start`). It prints whether the frame was found:

```
frame connected: Greentouch GT-IR-F43 (InfraredMultiTouch 43-50P) (50 contacts, HID direct mode)
```

No driver change is needed. The service talks to the frame's vendor-defined HID channel and switches the frame to
**direct mode**: the frame sends its contacts to the service and stops acting as a touchscreen for the OS — no cursor
jumps, no pinch-zoom from two standing minis, the mouse stays free. When the service stops (Ctrl+C, window closed) it
switches the frame back and the OS touchscreen works again. A frame that is replugged while the service runs is
picked up again and put back into direct mode. If the service is killed hard, the touchscreen stays off until the
service is started and stopped once more.

```
node server.js [--port 50000] [--vid 0x08d3 --pid 0x1000] [--transport auto|hid|usb] [--calibrate] [--verbose]
```

To start it with Windows: Task Scheduler → "At log on" → `node.exe C:\…\owlbear-ir-touch\touch-server\server.js`,
or a shortcut in `shell:startup`.

<details>
<summary>Fallback: raw USB through WinUSB (Windows, only if direct mode does not work with your frame)</summary>

Windows does not let programs read the touch reports of a touchscreen (`ReadFile` → access denied). A frame without a
usable vendor channel can still be read by moving its touch interface to the generic **WinUSB** driver — the OS then
no longer sees a touchscreen at all:

1. Download [Zadig](https://zadig.akeo.ie), start it, **Options → List All Devices**.
2. Pick **"Touch Device,43-50P (Interface 0)"** (USB ID `08D3 1000 00`, current driver `HidUsb`).
3. Target driver **WinUSB**, click **Replace Driver**.
4. Interface 1 is the frame's mouse/keyboard emulation. Leave it alone unless the mouse cursor moves when you touch
   the glass — then give it WinUSB the same way.

Undo: Device Manager → the "Touch Device,43-50P" entry under USB devices → Update driver → Browse my computer →
Let me pick → **USB Input Device**. (Do the same if you used an earlier version of this project with Zadig and want
direct mode now, then replug the frame.)

The service picks raw USB by itself when it finds no vendor HID channel; `--transport usb` forces it.

</details>

### 2. Calibrate once

Open `http://localhost:50000/calibrate` in a browser **on the table display, full screen (F11)** and hold a finger on
each of the four targets. The result is saved to `touch-server/calibration.json`. Keys on that page: `R` restart,
`T` test mode (draws every contact), `C` clear, `Esc` close.

### 3. Install the extension

In your Owlbear room: **Extensions → Add** and paste

```
https://dndsync.com/ir-touch/manifest.json
```

(Self-hosting: see below.)

### 4. Let the browser talk to the service

Chrome and Edge block `ws://localhost` from an embedded extension unless local-network-access checks are off on the
table PC. Start the browser there with

```
chrome.exe --disable-features=LocalNetworkAccessChecks
```

or disable `chrome://flags/#local-network-access-check`. This is needed only on the table PC.

### 5. Open the Cast window on the TV

In Owlbear use **Cast** to put the room on the TV (Chrome runs it as a presentation receiver). In the extension's
popover tick **Enable touch table**, pick your **display size** and leave **Auto-detect the Cast window** on. The
Cast window picks the settings up through the room and connects by itself; the popover shows
*Cast window (…): service v1.0.0 · frame OK · calibrated*.

No Cast? Open a second browser window on the TV, join the room as a player, open the popover there and tick
**Use THIS window as the touch table**.

## Settings

| Setting | Meaning |
| --- | --- |
| Enable touch table | Master switch. The GM's setting is published to the room; the Cast window follows it. |
| Service port | Port of the touch service on the table PC (default 50000). |
| Display size / picture width | Width of the picture in mm (a 43″ 16:9 panel is 952 mm). Needed for the physical scale. |
| 1 grid cell = 1 inch | Forces the zoom in the table window so one grid cell is exactly one inch on the glass — standard 1″ mini bases sit on one cell. |
| Snap to the grid on release | When the figure is set down, the token is centred on the cell under it. |
| Auto-detect the Cast window | Owlbear names the Cast window's player "Cast Receiver"; that window becomes the touch table. |
| Use THIS window | Makes the current window the touch table (per window, not saved). |

## How the binding works

- **Under the contact.** A touch-down on a token (or within 0.6 cells of its bounds) binds that contact to the
  token. The offset between finger and token centre is kept, so the token does not jump. The token follows that
  contact until it is lifted; its position is smoothed (One Euro filter), so the frame's jitter does not shake it.
- **Standing.** A mini is not a finger — it is put down and stays on the glass. A contact that has not moved more
  than 0.2 cells for 0.35 s counts as put down: with snap on the token is centred on its cell right away, without
  waiting for a lift. The contact stays bound; jitter below 0.35 cells sends no updates to the room. Moving the mini
  again drags it on from where it stands, without a jump.
- **Lost contact.** When the frame loses a mini mid-drag (a hand shading the IR, a fast move) and finds it again
  under a new id within 0.3 s and 1.2 cells, the drag goes on with the same figure instead of snapping it halfway.
  The new contact must live 150 ms (phantom guard), else the figure counts as lifted where it was lost.
- **Lifted and set down.** A touch-down on empty map re-binds the figure lifted most recently (within 12 s) — the
  player picked the mini up and put it down somewhere else. Two plausibility checks: the figure cannot have travelled
  faster than a hand carries it (40 cells/s plus 1.5 cells slack), and while another figure is actively dragged, a
  new contact elsewhere is that player's hand, not a set-down.
- **Phantom guard.** IR frames report short phantom contacts (30–500 ms) next to a moving figure. A contact bound by
  the lifted rule, or taking over a lost one, moves the token only after it has lived 150 ms.
- **Hands.** A hand on the glass next to a figure is a separate contact and binds to nothing. A second contact on a
  token that is already held is ignored.

The constants live at the top of `extension/touch.js`.

## Troubleshooting

| Popover says | Cause | Fix |
| --- | --- | --- |
| `waiting for the Cast window` | No window is the touch table | Open the Cast window on the TV, or tick *Use THIS window* in a window on the TV |
| `… is blocked by the browser` | Chrome/Edge local network access check | Start the browser on the table PC with `--disable-features=LocalNetworkAccessChecks`, reload the room |
| `No touch service on ws://localhost:50000` | Service not running, or wrong port | `node server.js` on the table PC; check the port |
| `Something answered on port … but it is not the IR touch service` | Another program on that port | Change the port on both sides |
| `frame NOT connected — frame not found on USB` | Frame unplugged, or `npm install` was not run after an update (node-hid missing) | Plug it in; `npm install` in `touch-server` |
| Touchscreen dead in Windows after the service crashed | The frame is still in direct mode | Start the service and stop it with Ctrl+C |
| `NOT calibrated (raw 1:1)` | No calibration yet | Step 2 |
| Token jumps to a hand next to the figure | Hand landed within 0.6 cells of the token | Lift the figure a little later; see *Diagnostics* for what got bound |

The **Diagnostics** section of the popover shows the last protocol messages of the touch table (`Copy log`).

## Protocol (WebSocket, JSON, `ws://localhost:50000`)

server → client

| message | meaning |
| --- | --- |
| `{ type: 'HELLO', protocol: 'ir-touch', version, port, frame: { connected, name, transport, maxContacts, error }, calibration: { calibrated, savedAt } }` | first message after connect |
| `{ type: 'TOUCH', id, phase: 'down' \| 'move' \| 'up', x, y, rx, ry, t }` | `x, y` = fraction of the display picture (0..1), `rx, ry` raw frame units (0..32767), `t` ms; `up` carries `held` (ms) |
| `{ type: 'FRAME', connected, error }` | frame plugged / unplugged |
| `{ type: 'CALIBRATED', calibrated, savedAt }` | calibration changed |

client → server: `{ type: 'HELLO', client }` (optional), `{ type: 'CALIBRATION', points: [{ rx, ry, fx, fy }, …] }`,
`{ type: 'CALIBRATION_CLEAR' }`.

HTTP on the same port: `GET /` status JSON · `GET /calibrate` calibration page · `GET /calibration` current map ·
`DELETE /calibration` drop it.

Moves are coalesced per contact and flushed every 10 ms; the frame itself reports at up to ~1 kHz while something
moves and every ~50 ms for a standing object. Several clients may be connected at once.

## Self-hosting the extension

The extension is static files (`extension/`). Put them on any HTTPS web space under the path `/ir-touch/` and add
`https://your.host/ir-touch/manifest.json` to the room. Owlbear resolves the manifest's paths against the origin, so
if you use a different path, change the four `/ir-touch/…` entries in `manifest.json`. For local development
`npm run serve` serves them at `http://localhost:8788/ir-touch/manifest.json` (Owlbear accepts http for localhost).

## How the frame behaves (learnt on the table)

- Interface 0 has three HID collections: the touch screen (input report id 2), device configuration (feature 4) and a
  **vendor-defined** one (usage page `0xFF00`, report id 5, 64 bytes in and out). Writing `05 1F F7 FC 12` (zero-padded
  to 64 bytes) to the vendor collection switches the frame to direct mode, `05 1F F7 FC 14` switches back; the frame
  acknowledges with `05 1F F7 FC 13` / `… 15`. In direct mode the contacts arrive under report id 5 in the same slot
  layout as report 2, continuously (~400 Hz) while anything is on the glass, and the touch screen collection stays
  silent. Vendor collections can be opened by any program; touch screen, mouse and keyboard collections cannot.
  The packets come from the developer of DigitalTableTops — see *Thanks*.
- Report id 2 (62 bytes): six 10-byte slots `[flags][contact id][x u16][y u16][w u16][h u16]`
  — flags bit 0 tip, bit 1 in-range, bit 2 confidence; empty slots have id `0xFF`; byte 61 = contact count.
- Raw USB only: the frame only starts sending on interface 0 after the host has **fetched the HID report descriptor** (which the
  HID driver does and WinUSB does not). `frame.js` does that on open; before that the frame falls back to mouse
  emulation on interface 1.
- Touch-down arrives as one report with confidence only, then tip; lift as tip = 0 once. A contact that simply
  disappears is closed after 150 ms (other reports arriving) or 1 s (silence).
- Feature report 3 = maximum contact count (50). The "device mode" feature report (4) is ignored by this frame.
- A mini's base shows up as **one** contact, usually with a stable id for as long as it stands; a hand on the glass
  is a burst of short extra contacts (ids 1–4, < 300 ms).

## Other frames

`node probe.js` (in `touch-server`, Windows with interface 0 on WinUSB, or Linux/macOS) prints the HID collections of a
frame and marks vendor-defined ones; `node direct.js` sends the Greentouch direct-mode packet and records what comes
back. Frames from other makers use other packets and sometimes another slot layout — add the USB id to `KNOWN` in
`touch-server/frame.js` and adapt `parseReport`. A frame that is a plain HID multitouch digitizer with the report
layout above works over raw USB (WinUSB fallback) with `--vid/--pid`.

## Works with D&D Sync

[**D&D Sync**](https://dndsync.com) is a free web app that keeps the whole D&D table in sync in real time —
character sheets, initiative tracker, GM panel, homebrew monsters — with no install. Its own Owlbear extension puts
the combat on the map; together with IR Touch you get an **initiative bar**, a **movement ring** around the active
creature and **shared dice rolls** on the table display.

If this saves your table some fiddling: [**support on Ko-fi ♥**](https://ko-fi.com/dndsync)

## Development

```
npm test                      # unit tests: contact tracker, calibration, report parsing, contact→token binding
npm run serve                 # extension at http://localhost:8788/ir-touch/manifest.json
npm run mock                  # fake touch service on ws://localhost:50000 — type "drag 1 30 30 60 60"
node scripts/set-version.js 1.0.1   # the only place a version is typed
```

Release: bump the version, update `CHANGELOG.md`, tag `v1.0.1`, push. dndsync.com pulls the tagged release in its
Docker build.

Table test checklist before a release: service finds the frame (HID direct mode, Windows cursor stays put) → calibrate → Cast window connects → drag a figure →
lift and set it down elsewhere → drag a figure and leave it standing (snaps after a moment, no lift needed) → wiggle
it slightly (nothing moves) → drag it on (no jump) → drag two figures at once → a hand on the glass moves nothing → snap on release →
snap on, lift a figure and let a phantom appear → nothing moves → stop the service, the Windows touchscreen works again.

## Thanks

Direct mode exists thanks to the developer of **[DigitalTableTops](https://digitaltabletops.com)**, who shared how his
touch client talks to these frames and the Greentouch packets. If you would rather buy a table than build one: he
sells ready-made wooden TV frames with the IR touch frame built in at [digitaltabletops.com](https://digitaltabletops.com)
(about $800 at the time of writing — hard to beat without building it yourself), and his
[Foundry VTT module](https://github.com/DigitalTableTops/digital-tabletops) is on GitHub.

## License

[MIT](LICENSE)
