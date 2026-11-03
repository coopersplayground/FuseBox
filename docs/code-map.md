# The code map — components and connections

Every box in the code map (`architecture-5.svg`) is a file in this repo.
This is the data behind the picture: the components, grouped the way the
system splits, and the connections between them.

Two things the picture has to show honestly: the cloud is in the mix —
every hosted model call passes through the owner's gateway, which holds
the API key server-side — and the gateway's `provision.js` issues device
tokens. It does not provision phones; phone provisioning is
`guardian/setup-asterisk.py`, which generates the Asterisk PBX config on
the box from the line details entered on the box's own screen.

```
Components
28
Voice Interaction
Voice Listener cosmo-listener/listener.py
Local Command Router cosmo-listener/router.py
Board-State Answers cosmo-listener/spark.py
Speech Output cosmo-listener/speak.py
Voice-Board Bridge cosmo-listener/uipost.py
Voice-Board Driver cosmo-listener/ui.py
Household Board
Board Server cosmo-ui/server.js
Kiosk Interface cosmo-ui/public/app.js
Touch Actions cosmo-ui/feeders/touch-actions.py
Network Feeder cosmo-ui/feeders/network-feeder.py
Weather Feeder cosmo-ui/feeders/weather-feeder.py
Guardian Safety
PC Companion cosmo-ui/public/pc/agent.ps1
Phone Guardian guardian/guardian-ear.py
Phone Provisioning guardian/setup-asterisk.py
Asterisk PBX system PBX — configured by guardian/setup-asterisk.py
Computer Control
PC Control Backend cosmo-ui/server.js
HID Emitter cosmo-hid/emitter.py
HID Report Core cosmo-hid/hid.py
ESP32 HID Transport cosmo-hid/esp32/cosmo_hid_esp32s3.ino
Home Platform
Release Gateway gateway/gateway.js
Device Provisioning gateway/provision.js
Signed Updater updater/updater.py
Ed25519 Verification updater/ed25519.py
Cloud — Meta Model API
Muse Spark hosted — Meta Model API
Muse Voice Transcribe hosted — Meta Model API
Local Models — on the box
Muse Glimmer open weights — Ollama, on the box
Llama 3.2 3B open weights — Ollama, on the box
Other components
Resident
```

```
Connections
29
Resident → Voice Listener: speaks to
Voice Listener → Local Command Router: routes locally cosmo-listener/listener.py
Voice Listener → Board-State Answers: tries answers cosmo-listener/listener.py
Voice Listener → Speech Output: dispatches speech cosmo-listener/listener.py
Voice Listener → Voice-Board Bridge: posts status cosmo-listener/listener.py
Local Command Router → Voice-Board Driver: picks board views cosmo-listener/router.py
Voice-Board Driver → Board Server: opens board views cosmo-listener/ui.py
Board-State Answers → Board Server: reads board state
Speech Output → Board Server: posts speech cosmo-listener/speak.py
Voice-Board Bridge → Board Server: posts avatar state cosmo-listener/uipost.py
Kiosk Interface → Board Server: requests board actions cosmo-ui/public/app.js
Touch Actions → Board Server: feeds board actions
Network Feeder → Board Server: feeds network data
Weather Feeder → Board Server: feeds weather data
PC Companion → PC Control Backend: reports PC text
PC Control Backend → HID Emitter: queues commands
HID Emitter → Board Server: polls commands cosmo-hid/emitter.py
HID Emitter → HID Report Core: executes reports cosmo-hid/emitter.py
HID Emitter → ESP32 HID Transport: sends commands
Phone Provisioning → Asterisk PBX: generates the PBX config guardian/setup-asterisk.py
Asterisk PBX → Phone Guardian: records each leg for the Ear
Phone Guardian → Board Server: reports call alerts
Device Provisioning → Release Gateway: issues device tokens gateway/provision.js
Release Gateway → Muse Spark: relays judgment + answers — the key stays server-side
Release Gateway → Muse Voice Transcribe: relays audio from the listener + the Ear
PC Control Backend → Muse Glimmer: sends screens to judge cosmo-ui/server.js
PC Control Backend → Llama 3.2 3B: text fallback judging cosmo-ui/server.js
Signed Updater → Release Gateway: fetches releases updater/updater.py
Signed Updater → Ed25519 Verification: verifies signatures updater/updater.py
```
