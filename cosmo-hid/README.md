# Cosmo HID — real hardware input for Muse Home

Some windows refuse program-injected input (antivirus UIs are the proven
case: hover registers, clicks silently die — integrity-level filtering).
This package gives Cosmo a **real hand**: input that arrives at the PC as
genuine hardware HID, indistinguishable from the user's own keyboard and
mouse, and able to reach the login screen and UAC secure desktop.

## Transports (one command vocabulary, picked automatically)

| Priority | Transport | How | Notes |
|---|---|---|---|
| 1 | **Pi USB gadget** | The hub Pi's USB-C port presents as keyboard + ABSOLUTE mouse (`/dev/hidg0`, `/dev/hidg1`) | No pairing, works pre-boot/BIOS/BitLocker, absolute coordinates. Primary. |
| 2 | **ESP32-S3 BLE dongle** | Hub sends lines over WiFi TCP (or USB-serial); the dongle pairs as a BLE keyboard+mouse | Wireless; mouse is RELATIVE (firmware parks + steps); needs one guided pairing; Windows caches the HID descriptor per bond — FREEZE the report map before shipping. |
| 3 | **Dev sink** | Report bytes logged to `sink.log` | No hardware; the whole pipeline is testable today. |

## Pieces

- `hid.py` — report builders (keyboard boot protocol, absolute mouse)
  and the command vocabulary: `type:`, `key:`, `move:`, `click:`,
  `dblclick:`, `rclick:`, `scroll:` (coordinates 0..1000 normalized).
- `emitter.py` — systemd user service `hid-emitter`: drains the board's
  HID queue (0.4s poll) and drives the best transport; posts status to
  `/api/hid/status`. Config: `config.json` (`esp32_host`, `esp32_port`).
- Board side (cosmo-ui): `POST /api/hid/command` queues a command —
  **only during an active PC control session** (same gate as every
  other control verb). `GET /api/hid/command` drains one per call.
- Voice side: `ui.py pc-hid type <text…> | key <combo> | click <x> <y> |
  dblclick | rclick | move <x> <y> | scroll <n>`.
- `esp32/cosmo_hid_esp32s3.ino` — dongle firmware (ready to flash;
  first flash shakes out library API details). Feed: TCP 4210 or serial.
- `pi-gadget/setup-gadget.sh` — run on the Pi at install: enables dwc2
  peripheral mode, builds the configfs composite (keyboard + absolute
  mouse, HID-only, plain identity strings).

## Install order when hardware lands

1. **Pi**: flash hub image → `sudo bash pi-gadget/setup-gadget.sh` →
   reboot → cable USB-C to the PC → power the Pi from the GPIO header
   or PoE HAT (never from the target PC) → emitter auto-selects
   `gadget` (check `state.hid`).
2. **ESP32-S3**: flash the sketch → set `esp32_host` in `config.json` →
   restart `hid-emitter` → guide the user through one Windows
   Bluetooth pairing ("Cosmo Keyboard") → emitter auto-selects `esp32`
   whenever no gadget exists.

## Rules

- HID input is CONTROL: it types and clicks on the user's PC. It stays
  behind the control-session gate + red banner, like every other verb.
- Prefer UIA (exact, readable) → gadget absolute clicks → BLE park+step
  → guide mode, in that order. Use HID where the window refuses
  synthetic input (AV UIs) or no agent is present (login/UAC).
- The mouse report layout in `hid.py` (`<Bhhb`) MUST match the gadget
  descriptor in `setup-gadget.sh` and the ESP32 report map. Change one,
  change all — and for BLE, changing the report map means users re-pair.
