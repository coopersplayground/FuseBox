# Cosmo Gadget UI

Kiosk UI for the Muse gadget: animated Cosmo avatar with real activity
states + a voice-navigable suggestion queue + a card stream
(emails / calls / texts / calendar). Zero-dependency Node.

Run: systemd user service cosmo-ui (port 3180) on Server 2.
On S1 later: copy this directory, install the same unit, done.

## Event bus (how the rest of the stack drives the screen)

Set the avatar state:
  curl -X POST http://127.0.0.1:3180/api/state -H 'Content-Type: application/json'     -d '{"state":"scanning","message":"Scanning your inbox"}'
States: idle | scanning | working | listening | speaking | waiting | playing | done | offline

Add a card (kind 'suggestion' joins the numbered voice queue):
  curl -X POST http://127.0.0.1:3180/api/card -H 'Content-Type: application/json'     -d '{"kind":"suggestion","title":"Reply to X","body":"Draft ready...","meta":"Email"}'

Resolve a suggestion when the owner decides (by card id from GET /api/state):
  curl -X POST http://127.0.0.1:3180/api/resolve -H 'Content-Type: application/json'     -d '{"id":101,"action":"sent"}'     # sent | skipped | held

Calendar overlay (30-day / week / day views; events: [{date, title, start, end, allDay, location}]):
  curl -X POST http://127.0.0.1:3180/api/calendar -H 'Content-Type: application/json'     -d '{"anchor":"2026-10-25","view":"days30","show":true,"events":[...]}'

State persists in data/state.json. The browser updates live over SSE (/events).
