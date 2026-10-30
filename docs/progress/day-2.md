# Day 2 — Tuesday, October 27, 2026

The box became the appliance today, and the phone Guardian lit up for the
first time.

**The appliance unit.** Development moved off the big workstation and onto
the small box that is the actual product shape. The board, the screen
judge, the on-screen keyboard, and the feeders now run on the box itself.
The workstation keeps only the room microphone and speakers and the
cameras while we build. Anything the finished product needs that is not
on the box will come from the cloud, not from another machine in the
house. The box was stripped to appliance duty: it boots straight into the
kiosk, runs only the services the product needs, and comes back on its
own after a power cut.

**On-screen keyboard.** One floating keyboard for the whole box. It pops
up on its own when a text field has focus, in any app, and types into
whatever is focused. It never steals focus itself. Proven in the board's
own screens and in the browser.

**Settings and the drawer.** The board got a Settings page whose first
setting is Wi-Fi, run by the box itself: nearby networks, signal, tap to
connect, password typed on the on-screen keyboard and stored only in the
box's own network files. The app drawer and dock were rebuilt: apps can
be pinned to the dock, and a full-screen browser ships in the drawer with
the board as its start page.

**Phone Guardian, first light.** The phone side stopped being a plan.
An Asterisk PBX on the box sits pass-through between the carrier trunk
and the house phone: calls ring the phone as always, and the box records
each side of the call on its own leg for live transcription. First calls
ran both ways through the box the same night — dial out from the house
phone, call in from a mobile, both clean. The board got the Guardian
app: line status, call list, and a setup flow a senior can run from the
screen.

**PC watcher.** Every snapshot the PC agent sends is now judged on the
box: OCR text first, a small text model second, a vision model only when
text cannot decide. The verdict lands on the board with the snapshot
attached.

**Also in this commit:** the sanitized package catches up with the move —
the board and listener at their current state, the Guardian services
(`guardian/`), the on-screen keyboard (`cosmo-osk/`), the hardware-input
backend (`cosmo-hid/`: Pi USB gadget and ESP32-S3 transports behind one
command vocabulary), and the kiosk/session units for the appliance unit.
