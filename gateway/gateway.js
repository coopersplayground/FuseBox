#!/usr/bin/env node
/*
 * Fuse Box gateway — the relay that lets a Fuse Box use cloud Meta models
 * without any owner API key ever touching the box.
 *
 * The box authenticates with its own per-device token. This service holds
 * the owner's Meta Model API key in its environment only, forwards the two
 * cloud jobs (Muse Spark chat, Muse Voice Transcribe), meters usage per
 * device, enforces per-device daily caps, and serves signed update
 * releases. It is a dumb pipe: request/response bodies are never logged
 * or stored — only counters are.
 *
 * Zero dependencies. Node 18+.
 *
 * Env:
 *   META_API_KEY     (required) the owner's Meta Model API key
 *   META_BASE        default https://api.meta.ai
 *   GW_PORT          default 8791
 *   GW_TOKENS_FILE   default ./tokens.json   (hashes only, see provision.js)
 *   GW_STATE_FILE    default ./state.json    (usage counters)
 *   GW_RELEASES_DIR  default ./releases      (manifest.json, manifest.sig, bundles/)
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.GW_PORT || '8791', 10);
const META_BASE = (process.env.META_BASE || 'https://api.meta.ai').replace(/\/$/, '');
const META_KEY = process.env.META_API_KEY || '';
const TOKENS_FILE = process.env.GW_TOKENS_FILE || path.join(__dirname, 'tokens.json');
const STATE_FILE = process.env.GW_STATE_FILE || path.join(__dirname, 'state.json');
const RELEASES_DIR = process.env.GW_RELEASES_DIR || path.join(__dirname, 'releases');
const MAX_BODY = 40 * 1024 * 1024; // Meta ASR caps audio at 32 MB; multipart overhead on top

if (!META_KEY) {
  console.error('META_API_KEY is not set — refusing to start.');
  process.exit(1);
}

// ---------- token store (hashes only) ----------
function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return {}; }
}
function tokenHash(tok) { return crypto.createHash('sha256').update(tok).digest('hex'); }
function authenticate(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const hash = tokenHash(m[1].trim());
  const tokens = loadTokens();
  for (const [stored, rec] of Object.entries(tokens)) {
    const a = Buffer.from(stored), b = Buffer.from(hash);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      if (rec.disabled) return null;
      return rec; // {id, label, caps:{chat_per_day, asr_min_per_day}}
    }
  }
  return null;
}

// ---------- usage counters ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function usageFor(state, id) {
  const day = todayKey();
  state[id] = state[id] || {};
  state[id][day] = state[id][day] || { chat: 0, asr_min: 0, asr_calls: 0, updates: 0 };
  return state[id][day];
}

// ---------- WAV duration (for ASR metering) ----------
function wavSeconds(buf) {
  try {
    const riff = buf.indexOf('RIFF');
    if (riff < 0) return 0;
    let off = riff + 12, byteRate = 0, dataSize = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data') { dataSize = size; break; }
      off += 8 + size + (size % 2);
    }
    return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : 0;
  } catch { return 0; }
}

// ---------- upstream forward (raw pass-through, nothing stored) ----------
function forward(req, res, upstreamPath, body) {
  const u = new URL(META_BASE + upstreamPath);
  const headers = { 'Authorization': 'Bearer ' + META_KEY, 'Content-Length': body.length };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const up = https.request({
    hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
    method: 'POST', headers, timeout: 120000,
  }, (ur) => {
    const rh = {};
    if (ur.headers['content-type']) rh['Content-Type'] = ur.headers['content-type'];
    res.writeHead(ur.statusCode || 502, rh);
    ur.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (e) => {
    console.error('upstream error:', e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_unreachable' }));
  });
  up.write(body);
  up.end();
}

function readBody(req, cb) {
  const chunks = [];
  let total = 0, tooBig = false;
  req.on('data', (c) => {
    total += c.length;
    if (total > MAX_BODY) { tooBig = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!tooBig) cb(Buffer.concat(chunks)); });
  req.on('error', () => {});
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function logLine(rec, what, extra) {
  console.log(new Date().toISOString(), rec ? rec.id : '-', what, extra || '');
}

// ---------- server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/health') return json(res, 200, { ok: true });

  const rec = authenticate(req);
  if (!rec) return json(res, 401, { error: 'unauthorized' });
  const caps = rec.caps || {};
  const state = loadState();
  const use = usageFor(state, rec.id);

  if (p === '/v1/me') {
    return json(res, 200, { id: rec.id, label: rec.label || '', today: use, caps });
  }

  if (p === '/v1/chat/completions' && req.method === 'POST') {
    if (caps.chat_per_day && use.chat >= caps.chat_per_day) {
      logLine(rec, 'chat CAP');
      return json(res, 429, { error: 'daily_cap_reached', kind: 'chat' });
    }
    return readBody(req, (body) => {
      use.chat += 1; saveState(state);
      logLine(rec, 'chat', body.length + 'B');
      forward(req, res, '/v1/chat/completions', body);
    });
  }

  if (p === '/v1/asr/transcribe' && req.method === 'POST') {
    return readBody(req, (body) => {
      const mins = wavSeconds(body) / 60;
      if (caps.asr_min_per_day && use.asr_min + mins > caps.asr_min_per_day) {
        logLine(rec, 'asr CAP');
        return json(res, 429, { error: 'daily_cap_reached', kind: 'asr' });
      }
      use.asr_min = Math.round((use.asr_min + mins) * 1000) / 1000;
      use.asr_calls += 1; saveState(state);
      logLine(rec, 'asr', mins.toFixed(2) + 'min');
      forward(req, res, '/v1/asr/transcribe', body);
    });
  }

  if (p === '/v1/update/manifest' && req.method === 'GET') {
    const channel = (url.searchParams.get('channel') || 'stable').replace(/[^a-z0-9-]/gi, '');
    const dir = path.join(RELEASES_DIR, channel);
    try {
      const manifest = fs.readFileSync(path.join(dir, 'manifest.json'));
      const signature = fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8').trim();
      use.updates += 1; saveState(state);
      logLine(rec, 'update-manifest', channel);
      return json(res, 200, { manifest: JSON.parse(manifest), signature });
    } catch { return json(res, 404, { error: 'no_release' }); }
  }

  if (p === '/v1/update/bundle' && req.method === 'GET') {
    const channel = (url.searchParams.get('channel') || 'stable').replace(/[^a-z0-9-]/gi, '');
    const file = path.join(RELEASES_DIR, channel, 'bundle.tar.gz');
    try {
      const st = fs.statSync(file);
      logLine(rec, 'update-bundle', channel + ' ' + st.size + 'B');
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
      return;
    } catch { return json(res, 404, { error: 'no_release' }); }
  }

  return json(res, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('fusebox-gateway listening on 127.0.0.1:' + PORT, '-> upstream', META_BASE);
});
