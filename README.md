# Fuse_Box

A voice-first home board built on **Muse**: a kiosk screen that shows what
needs you, an agent that speaks and listens in the room, and a strict rule
that nothing sends, posts, buys, or changes without the owner's say-so.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026).
This repository is the hackathon source release: **all personal data,
accounts, and credentials have been removed.** Demo/seed content is
fictional, the avatar ships in its drawn (SVG) mode, and every integration
is configured locally by whoever installs it.

## What it does

- **The board** (`cosmo-ui/`) — a zero-dependency Node kiosk UI: a numbered
  "NEEDS YOUR VOICE" approval queue, a live card stream (mail, texts, calls,
  calendar, camera events), and full-screen overlays for calendar, cameras,
  email, messages, music, weather, home control, network, apps, and a
  built-in newspaper reader. State persists in `cosmo-ui/data/state.json`
  (created from a fictional seed on first run) and updates over SSE.
- **The voice loop** (`cosmo-listener/`) — a local listener on the box:
  microphone → energy VAD → local Whisper (Wyoming protocol) → wake-phrase
  spotting ("Hey Cosmo") → the owner's Muse session via the Muse Gadget
  SDK → speech back through ElevenLabs v3, Kokoro, or Piper (in that order).
  `sudo cosmo` on the box shows a live WAITING / LISTENING / THINKING /
  SPEAKING status.
- **Reflexes** — small, fast jobs (open the calendar, show a camera, read
  the weather) are handled locally or by a small model (Meta Muse Spark via
  the Model API, see `cosmo-listener/spark.py`); anything needing judgment
  wakes the full Muse session. The session's operating instructions live
  in `cosmo-listener/preamble.txt`.
- **PC companion & guardian** — a small Windows agent (`cosmo-ui/public/pc/`)
  reports laptop health to the board; every screen snapshot is judged for
  scam patterns, and full PC control is session-gated behind the owner's
  explicit start, with a visible banner on the PC while it runs.
- **Feeders** (`cosmo-ui/feeders/`) — zero-token scripts that keep weather,
  network state, and touch input flowing into the board.

## Layout

| Path | What it is |
| --- | --- |
| `cosmo-ui/` | The board: `server.js`, `public/` (kiosk page), `feeders/`, `config.json` |
| `cosmo-listener/` | The voice loop: listener, speech, UI driver (`ui.py`), HA helper, status tool |
| `usr/`, `etc/`, `.config/` | Install tree: kiosk session + systemd units, mirroring where files land on the box |

The reference install runs as a dedicated `cosmo` user, so paths read
`/home/cosmo/...`; adjust the units and configs if your user differs.

## Configuration & secrets

**No secrets are in this repo, by design.** The code reads credentials
from files on the box at runtime, and those files are git-ignored:

- ElevenLabs API key: `~/.config/cosmo-voice/elevenlabs_api_key` (0600) —
  optional; without it, speech falls back to local Kokoro/Piper.
- Meta Model API key: `~/.config/cosmo-voice/meta_api_key` (0600) — only
  for the Spark reflex tier.
- Home Assistant long-lived token: the path set by `haTokenPath` in
  `cosmo-ui/config.json`.
- Voice profiles (ElevenLabs voice IDs), weather location, camera and
  integration settings: `cosmo-listener/config.json` and
  `cosmo-ui/config.json` — shipped here with placeholder/demo values.

Mail, messages, social, and music are driven by the agent session through
its own connector CLIs on the agent host (see `preamble.txt`); wire up
whichever connections you want — the board works without any of them.

## Demo data

First run seeds a handful of clearly-marked demo cards (pharmacy follow-up,
a PC-guardian scam drill, a bakery callback). The weather demo location is
New York, NY; the network feeder ships with example devices
(`192.168.1.x`, `00:11:22:...` MACs). Replace all of it with your own
configuration — nothing in the demo data is real.

## Avatar

`cosmo-ui/AVATAR_MODE` ships as `svg`: the board draws a built-in animated
bot. The reference install uses personally generated video clips for the
avatar instead; those stay on the owner's machine and are **not** part of
this repo. To use clips, drop them into `cosmo-ui/public/avatar/` (see the
`.gitkeep` there) and set `AVATAR_MODE` to `real`.

## Quick start (sketch)

1. On a small Linux box: create the `cosmo` user, clone this repo, copy
   `cosmo-ui/` and `cosmo-listener/` into `~/`, and install the units from
   `.config/systemd/user/` (plus the kiosk pieces from `usr/` and `etc/`
   for a dedicated screen).
2. `cd ~/cosmo-listener && python3 -m venv venv && venv/bin/pip install -r requirements.txt`
3. Point `cosmo-ui/config.json` at your weather location and (optionally)
   your Frigate / Home Assistant installs; put any API keys in the files
   listed above.
4. Start `cosmo-ui` and `cosmo-listener`; the board seeds itself with the
   demo cards, and the listener starts waiting for "Hey Cosmo".

Whisper, Piper, and Kokoro run as local Wyoming/HTTP services on the box —
see `cosmo-listener/config.json` for the ports the loop expects.
