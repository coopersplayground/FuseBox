# Fuse Box gateway

The hosted relay a Fuse Box talks to for its cloud models and its
updates. It exists so that **no owner API key ever ships on a box**: the
box carries only its own per-device token, and the owner's Meta Model
API key lives in this service's environment on the host, nowhere else.

## What it does

- **Model relay.** `POST /v1/chat/completions` and
  `POST /v1/asr/transcribe` are forwarded to the Meta Model API with
  the owner's key. Bodies pass through untouched and are never logged
  or stored — the service keeps counters, not content.
- **Per-device tokens.** Each box gets a token (`provision.js add`).
  Only SHA-256 hashes are stored server-side. A token can be disabled
  instantly without affecting any other box.
- **Metering + caps.** Per device, per day: chat calls and transcribed
  minutes (measured from the WAV headers). Daily caps return HTTP 429
  when reached. The counters are the usage record a subscription plan
  hangs off.
- **Update channel.** `GET /v1/update/manifest` and
  `GET /v1/update/bundle` serve the signed release for a channel from
  `releases/<channel>/`. The box verifies the manifest signature
  against the release public key baked into its image before anything
  is applied; this service never holds the signing key.

## Run

```sh
META_API_KEY=... node gateway.js        # or the systemd unit
node provision.js add "Margaret — box 1"
node provision.js list
node provision.js disable box-1a2b3c4d
```

**Run `provision.js` as the same user the service runs as.** It writes
`tokens.json` with mode 0600; if root creates it, the service cannot
read it and every device gets a 401. Under systemd:
`runuser -u fusebox-gateway -- node provision.js add "..."`.

Listens on `127.0.0.1:8791` by default; put it behind a TLS-terminating
reverse proxy (the reference deployment uses nginx on the relay host).

## Files

| File | What |
| --- | --- |
| `gateway.js` | The service (zero-dependency Node) |
| `provision.js` | Device token CLI |
| `tokens.json` | Token hashes + caps (created by provision.js, 0600) |
| `state.json` | Usage counters (created at runtime) |
| `releases/` | Per-channel signed releases served to boxes |
| `fusebox-gateway.service` | systemd unit |
| `gateway.env` | `META_API_KEY` and overrides — host-only, never in git |
