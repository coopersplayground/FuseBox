// Cosmo Gadget UI - zero-dependency Node server.
// Serves the kiosk UI and a tiny event bus:
//   GET  /               the UI
//   GET  /events         SSE stream (avatar state + cards)
//   GET  /api/state      current avatar state + all cards
//   POST /api/state      {state, message}            -> set avatar state
//   POST /api/card       {kind,title,body,meta}      -> add a card (kind 'suggestion' joins the queue)
//   POST /api/resolve    {id, action}               -> resolve a suggestion (sent|skipped|held)
//   POST /api/focus      {n} | {id} | {clear:true}  -> big-screen focus on a card (voice "show me N")
//   POST /api/detail     {id, thread, draft}        -> attach email thread + draft to a card
//   POST /api/clear                                 -> clear cards
//   POST /api/calendar  {events,view,date,anchor,show} -> calendar overlay (30-day / week / day)
//   POST /api/camera    {id,identify} | {clear}     -> camera overlay (live feed; identify = ask mode)
//   POST /api/camera/alias {id,alias}               -> teach a camera a new name
//   POST /api/cameras/rescan                        -> rerun camera discovery
//   POST /api/inbox     {emails:[...]}              -> store the inbox list (threads/drafts survive refresh)
//   POST /api/mail      {show} | {n} | {clear}      -> email overlay: list / open email N / close
//   POST /api/mail/attach {n, thread, draft}        -> attach a thread or draft reply to email N
//   POST /api/mail/resolve {n, action}              -> email N handled (leaves the list, list renumbers)
//   POST /api/help      {show} | {clear}            -> 'what can you do' modal
//   POST /api/ring      {start,from,line} | {end,answered,from} -> live call cards (webhook forwarder)
//   POST /api/music     {state:{nowPlaying,picks}} | {show} | {clear} -> Spotify overlay
//   POST /api/action    {kind, ...} -> queue a touch intent for the session | {ack:[ids]} -> drain
//   POST /api/weather   {state:{...}} | {show} | {clear} -> weather overlay data/view
//   GET  /api/ha/entities -> controllable HA entities (proxied; token stays server-side)
//   POST /api/ha/control {id, action:on|off|toggle} | POST /api/ha {show}|{clear} -> home overlay
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- Config (packaging: paths/devices/keys come from config.json or the
// environment, never hardcoded - code defaults stay machine-generic) ----
const CONFIG = Object.assign({
  port: 3180,
  frigateUrl: 'http://127.0.0.1:5000',
  haUrl: 'http://127.0.0.1:8123',
  haTokenPath: '/home/cosmo/.config/ha-api-token',
  haDbPath: '',
  personEntity: 'person.owner',
  personOverridePath: '',
  perimeterCameras: ['driveway_cam'],
  timezone: 'America/New_York',
  personPollSec: 20,
  personCooldownMin: 10,
}, (() => { try { return JSON.parse(fs.readFileSync(process.env.COSMO_UI_CONFIG || path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { return {}; } })());
const PORT = process.env.PORT || CONFIG.port;
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data', 'state.json');

function seed() {
  return {
    avatar: { state: 'idle', message: 'Watching over things', since: Date.now() },
    focusId: null,
    seq: 100,
    cards: [
      { id: 1, kind: 'suggestion', title: 'Follow up with the pharmacy (demo)', body: 'Your refill is ready for pickup. Draft reply: ask about Saturday hours and confirm the pickup name.', meta: 'Demo inbox - email', time: Date.now() - 42 * 60000, status: 'open' },
      { id: 2, kind: 'suggestion', title: 'Possible scam - screen check (demo)', body: 'The PC companion flagged a fake virus pop-up on the laptop. The snapshot is ready to review before anyone calls the number on screen.', meta: 'PC guardian - demo', time: Date.now() - 95 * 60000, status: 'open' },
      { id: 3, kind: 'suggestion', title: 'Call back the bakery (demo)', body: 'Missed call about Saturday\'s cake order. Callback script and order details are drafted.', meta: 'Call log - demo', time: Date.now() - 150 * 60000, status: 'open' },
      { id: 4, kind: 'calendar', title: 'Community fair opens', body: 'Gates open at 10 AM. A leave-by reminder is set for 9:15.', meta: 'Saturday - 10:00 AM', time: Date.now() - 20 * 60000, status: 'info' },
      { id: 5, kind: 'email', title: 'Library - your hold is ready (demo)', body: 'The book you requested is waiting at the front desk until Friday.', meta: 'Demo mail', time: Date.now() - 300 * 60000, status: 'info' },
      { id: 6, kind: 'text', title: 'Package delivered (demo)', body: 'A package was left at the front door at 2:04 PM.', meta: 'Delivery notice', time: Date.now() - 400 * 60000, status: 'info' }
    ]
  };
}

function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { return null; }
}
let state = load() || seed();
let hidQueue = [];  // HID command queue (memory-only, never persisted)
if (state.focusId === undefined) state.focusId = null;
if (state.calendar === undefined) state.calendar = { visible: false, view: 'days30', date: null, anchor: null, days: 60, events: [] };
if (state.cameras === undefined) state.cameras = [];
if (state.cameraView === undefined) state.cameraView = { visible: false, cameraId: null, identify: null };
if (state.inbox === undefined) state.inbox = { emails: [], updatedAt: null };
if (state.helpView === undefined) state.helpView = { visible: false };
if (state.music === undefined) state.music = { nowPlaying: null, picks: [], devices: [], updatedAt: null };
if (state.musicView === undefined) state.musicView = { visible: false };
if (state.mailView === undefined) state.mailView = { visible: false, focusN: null };
if (state.frigateSeen === undefined) state.frigateSeen = [];
if (state.personCardAt === undefined) state.personCardAt = {};
if (state.calCarded === undefined) state.calCarded = [];
if (state.morningFor === undefined) state.morningFor = null;
if (state.personPending === undefined) state.personPending = {};
if (state.ringCardId === undefined) state.ringCardId = null;
if (state.actionOutbox === undefined) state.actionOutbox = [];
if (state.pc === undefined) state.pc = { name: '', user: '', os: '', online: false, lastSeen: 0, foreground: '', remoteTools: [], health: null, healthAt: 0, snapshotAt: 0, verdict: null, lastResult: null };
if (state.pcCommand === undefined) state.pcCommand = null;
if (state.pcAutoSnapAt === undefined) state.pcAutoSnapAt = 0;
if (state.pcControl === undefined) state.pcControl = { active: false, since: 0, lastActionAt: 0 };
if (state.weather === undefined) state.weather = null;
if (state.weatherView === undefined) state.weatherView = { visible: false };
if (state.homeView === undefined) state.homeView = { visible: false };
if (state.homeHidden === undefined) state.homeHidden = [];
if (state.imageView === undefined) state.imageView = { visible: false, src: null, title: null, credit: null };
if (state.navStyle === undefined) state.navStyle = 'bar';
if (state.texts === undefined) state.texts = { messages: [], updatedAt: null };
if (state.textView === undefined) state.textView = { highlightId: null };
if (state.facebook === undefined) state.facebook = { me: null, posts: [], groups: [], updatedAt: null };
if (state.facebookView === undefined) state.facebookView = { visible: false, draft: null };
if (state.facebookPost === undefined) state.facebookPost = null;
if (state.facebookGroup === undefined) state.facebookGroup = null;
if (state.messenger === undefined) state.messenger = { threads: [], updatedAt: null };
if (state.messengerView === undefined) state.messengerView = { visible: false, draft: null };
if (state.messengerThread === undefined) state.messengerThread = null;
if (state.sms === undefined) state.sms = { threads: [], updatedAt: null };
if (state.smsView === undefined) state.smsView = { visible: false, draft: null };
if (state.smsThread === undefined) state.smsThread = null;
if (state.insta === undefined) state.insta = { profile: null, posts: [], updatedAt: null };
if (state.instaView === undefined) state.instaView = { visible: false };
if (state.instaPost === undefined) state.instaPost = null;
if (state.appsView === undefined) state.appsView = { visible: false };
if (state.appView === undefined) state.appView = null;
if (state.paper === undefined) state.paper = { edition: null, updatedAt: null };
if (state.paperView === undefined) state.paperView = { visible: false };
if (state.network === undefined) state.network = { host: null, links: [], devices: [], unknown: [], summary: null, updatedAt: null };
if (state.networkView === undefined) state.networkView = { visible: false };
const APP_CATALOG = [
  { id: 'spotify', name: 'Spotify', icon: '\u{1F3B5}', bg: '#1db954', desc: "Music on your speakers and this room.", target: 'music', facts: ["Controls what is already playing - it never hijacks the device", "Open it to jump to the Music page"] },
  { id: 'gmail', name: 'Gmail', icon: '\u2709', bg: '#ea4335', desc: "Your Gmail inbox, on the board.", target: 'mail', facts: ["New mail lands on its own every few minutes", "Drafts are only sent when you say send it"] },
  { id: 'calendar', name: 'Calendar', icon: '\u{1F4C5}', bg: '#4285f4', desc: "Your Google calendars, next 60 days.", target: 'calendar', facts: ["The board keeps the next 60 days loaded", "Say a date and it opens that day"] },
  { id: 'facebook', name: 'Facebook', icon: 'f', bg: '#1877f2', desc: "Your Facebook feed, groups and birthdays.", target: 'facebook', facts: ["One set of numbers across the whole page", "Posts and comments need your approval first"] },
  { id: 'messenger', name: 'Messenger', icon: '\u{1F4AC}', bg: '#a033ff', desc: "Your Messenger chats in a phone.", target: 'messenger', facts: ["Refreshes on its own every 2 minutes", "Replies are drafted first, sent on your word"] },
  { id: 'instagram', name: 'Instagram', icon: '\u{1F4F7}', bg: '#d62976', desc: "Your Instagram feed in a phone.", target: 'instagram', facts: ["Shows your following feed and its comments", "Refreshes on its own every 10 minutes"] },
  { id: 'texts', name: 'Texts', icon: '\u{1F4F1}', bg: '#2fbf4f', desc: "Your phone text messages in a phone.", target: 'texts', facts: ["Drafts are read back before anything sends", "Texts refresh while Cosmo is awake"] },
  { id: 'telnyx', name: 'Phone', icon: '\u{1F4DE}', bg: '#0aa06e', desc: "Phone calls on the board.", target: null, facts: ["Calls ring right here on the box", "In the final product, calls ring right here on the box"] },
  { id: 'home', name: 'Home Assistant', icon: '\u{1F3E0}', bg: '#03a9f4', desc: "Switches, cameras and automations in your home.", target: 'home', facts: ["Tap a tile to turn something on or off", "Long-press a tile to hide it from the page"] },
  { id: 'frigate', name: 'Cameras', icon: '\u{1F3A5}', bg: '#455a64', desc: "Your security cameras, live.", target: 'cameras', facts: ["Shop, driveway and microscope cameras", "Say a camera name and it comes right up"] },
  { id: 'weather', name: 'Weather', icon: '\u2600\u{FE0F}', bg: '#b97f10', desc: "Local weather for your area.", target: 'weather', facts: ["Updates itself every 30 minutes", "Open it for the hour-by-hour and week ahead"] },
  { id: 'github', name: 'GitHub', icon: '\u{1F419}', bg: '#24292e', desc: "Your GitHub repositories, issues and pull requests.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'drive', name: 'Google Drive', icon: '\u{1F4C1}', bg: '#34a853', desc: "Your Google Drive files.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'docs', name: 'Google Docs', icon: '\u{1F4C4}', bg: '#4285f4', desc: "Your Google Docs and notes.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'shopify', name: 'Shopify', icon: '\u{1F6CD}\u{FE0F}', bg: '#96bf48', desc: "Your Shopify store: products, orders, customers.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'stripe', name: 'Stripe', icon: '\u{1F4B3}', bg: '#635bff', desc: "Payments, invoices and subscriptions in Stripe.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'plaid', name: 'Finances', icon: '\u{1F3E6}', bg: '#222222', desc: "Bank balances, spending and bills via Plaid.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'duffel', name: 'Flights', icon: '\u2708\u{FE0F}', bg: '#0ea5e9', desc: "Search and book flights.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'ticketmaster', name: 'Tickets', icon: '\u{1F39F}\u{FE0F}', bg: '#026cdf', desc: "Concert and event tickets.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
  { id: 'places', name: 'Places', icon: '\u{1F4CD}', bg: '#e8710a', desc: "Restaurants, shops and places nearby.", target: null, facts: ["Connected and ready - ask Cosmo to use it"] },
];
const APP_SEED = ['spotify', 'gmail', 'calendar', 'facebook', 'messenger', 'instagram', 'texts', 'telnyx', 'home', 'frigate', 'weather'];
function catalogApp(c, status) { return { id: c.id, name: c.name, icon: c.icon, bg: c.bg, desc: c.desc, target: c.target || null, facts: c.facts || [], kind: 'connector', status: status || 'connected', inDock: false, custom: false }; }
if (!Array.isArray(state.apps)) state.apps = APP_SEED.map((id) => catalogApp(APP_CATALOG.find((a) => a.id === id)));


// Avatar mode: 'real' shows the user's actual avatar (image + activity
// videos in public/avatar/), 'svg' shows the built-in drawn bot. The
// reference install keeps the real avatar local and ships 'svg' -
// the default avatar art is excluded from the Gadget SDK license.
let avatarMode = 'svg';
try {
  const m = fs.readFileSync(path.join(__dirname, 'AVATAR_MODE'), 'utf8').trim();
  if (m === 'real' || m === 'svg') avatarMode = m;
} catch (e) {}
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(state, null, 2));
}
save();


// ---- Camera discovery: Frigate first (its /api/config lists every camera
// and /api/<name> serves a live MJPEG feed). If no camera app answers, fall
// back to scanning the local subnet for IP cameras (RTSP port + common HTTP
// snapshot paths). Runs at startup and on POST /api/cameras/rescan. Learned
// aliases survive rediscovery (merged back in by camera id).
const net = require('net');
const os = require('os');
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function httpOk(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function humanize(n) { return n.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function tcpOpen(host, port, ms) {
  return new Promise((resolve) => {
    const sock = new net.Socket(); let done = false;
    const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(v); } };
    sock.setTimeout(ms);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    sock.connect(port, host);
  });
}
async function scanLanCameras() {
  let base = null;
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) for (const i of list || []) {
    if (i.family === 'IPv4' && !i.internal) { base = i.address.split('.').slice(0, 3).join('.'); break; }
  }
  if (!base) return [];
  const queue = []; for (let i = 1; i <= 254; i++) queue.push(base + '.' + i);
  const found = [];
  async function worker() {
    while (queue.length) {
      const ip = queue.shift();
      if (await tcpOpen(ip, 554, 350)) {
        let feed = null;
        for (const path of ['/snapshot.jpg', '/cgi-bin/snapshot.cgi', '/jpg/image.jpg']) {
          if (await httpOk('http://' + ip + path, 700)) { feed = 'http://' + ip + path; break; }
        }
        found.push({ id: 'ip:' + ip, name: 'IP camera ' + ip, source: 'ipscan', feed: feed || ('rtsp://' + ip + ':554/') });
      }
    }
  }
  await Promise.all(Array.from({ length: 24 }, worker));
  return found;
}
async function discoverCameras() {
  let found = [];
  const cfg = await httpGetJson('http://127.0.0.1:5000/api/config', 3000);
  if (cfg && cfg.cameras) {
    found = Object.keys(cfg.cameras).map((name) => ({ id: 'frigate:' + name, name: humanize(name), source: 'frigate', feed: 'http://127.0.0.1:5000/api/' + name }));
  }
  if (!found.length && !state.cameras.length) found = await scanLanCameras();
  if (found.length) {
    const prev = {}; state.cameras.forEach((c) => { prev[c.id] = c; });
    state.cameras = found.map((c) => ({ ...c, aliases: (prev[c.id] && prev[c.id].aliases) || [], mirror: (CONFIG.mirrorCameras || []).includes(c.id) }));
    save(); broadcast('snapshot', snapshot());
  }
  return state.cameras;
}

function addCard(b) {
  const card = {
    id: ++state.seq,
    kind: ['suggestion', 'email', 'call', 'text', 'calendar', 'system', 'person'].includes(b.kind) ? b.kind : 'system',
    title: String(b.title || 'Update'),
    body: String(b.body || ''),
    meta: String(b.meta || ''),
    source: b.source ? String(b.source) : '',
    image: b.image ? String(b.image) : undefined,
    thread: Array.isArray(b.thread) ? b.thread.slice(0, 20) : undefined,
    draft: b.draft ? String(b.draft) : undefined,
    time: Date.now(),
    status: b.kind === 'suggestion' ? 'open' : 'info'
  };
  state.cards.unshift(card);
  state.cards = state.cards.slice(0, 60);
  save(); broadcast('card', card); broadcast('snapshot', snapshot());
  return card;
}

// ---- Frigate person events -> board cards (build list #5) ----
// Mirrors the person-alert mailer's AWAY/HOME gate exactly: manual override
// on = all cameras, off = none; at home only perimeter cameras card; away
// (or HA unreadable) = all cameras. Recognized face -> info card with the
// snapshot; unknown person -> queue item with the snapshot. Per-camera
// cooldown, same 10 minutes as the mailer.
function ownerHome() {
  if (!CONFIG.haDbPath) return false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(CONFIG.haDbPath, { readOnly: true });
    const row = db.prepare('SELECT s.state FROM states s JOIN states_meta m ON s.metadata_id = m.metadata_id WHERE m.entity_id = ? ORDER BY s.state_id DESC LIMIT 1').get(CONFIG.personEntity);
    db.close();
    return !!row && row.state === 'home';
  } catch (e) { return false; }
}
function personGateAllows(camera) {
  let ov = '';
  if (CONFIG.personOverridePath) { try { ov = fs.readFileSync(CONFIG.personOverridePath, 'utf8').trim().toLowerCase(); } catch (e) {} }
  if (ov === 'on') return true;
  if (ov === 'off') return false;
  if (CONFIG.perimeterCameras.includes(camera)) return true;
  return !ownerHome();
}
function cameraDisplayName(camId) {
  const reg = state.cameras.find((c) => c.id === 'frigate:' + camId);
  return reg ? reg.name : humanize(camId);
}
function cardPersonEvent(e) {
  const camName = cameraDisplayName(e.camera);
  const when = new Date(e.start_time * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CONFIG.timezone });
  const img = CONFIG.frigateUrl + '/api/events/' + e.id + '/snapshot.jpg';
  if (e.sub_label) {
    addCard({ kind: 'person', title: e.sub_label + ' - ' + camName, body: 'Frigate recognized ' + e.sub_label + ' at the ' + camName + ' at ' + when + '.', meta: 'Frigate person - ' + when, source: 'frigate', image: img });
  } else {
    addCard({ kind: 'suggestion', title: 'Unknown person - ' + camName, body: 'Frigate saw someone it does not recognize at the ' + camName + ' at ' + when + '. Say show me to see the snapshot, or skip it.', meta: 'Frigate person - ' + when, source: 'frigate', image: img });
    state.personPending[e.id] = { camera: e.camera, at: Date.now() };
  }
}
let personSeeded = false;
// --- Home Assistant proxy (token stays on this box; read from CONFIG.haTokenPath) ---
const HA_CONTROL = ['switch', 'light', 'automation', 'media_player', 'climate', 'fan', 'cover', 'lock', 'input_boolean', 'scene', 'script', 'schedule', 'timer'];
let haCache = { at: 0, entities: null };
function haToken() { try { return fs.readFileSync(CONFIG.haTokenPath, 'utf8').trim(); } catch (e) { return ''; } }
async function haCall(method, path, body) {
  const r = await fetch(CONFIG.haUrl + path, { method, headers: { Authorization: 'Bearer ' + haToken(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('HA ' + r.status);
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}
async function haEntities() {
  if (haCache.entities && Date.now() - haCache.at < 5000) return haCache.entities;
  const all = await haCall('GET', '/api/states');
  const ents = all.filter((e) => HA_CONTROL.includes(e.entity_id.split('.')[0])).map((e) => ({ id: e.entity_id, domain: e.entity_id.split('.')[0], name: (e.attributes && e.attributes.friendly_name) || e.entity_id, state: e.state }));
  haCache = { at: Date.now(), entities: ents };
  return ents;
}
async function pollPersons() {
  const events = await httpGetJson(CONFIG.frigateUrl + '/api/events?labels=person&has_snapshot=1&limit=25', 5000);
  if (!Array.isArray(events)) return;
  const seen = new Set(state.frigateSeen);
  if (!personSeeded) {
    // First poll after boot: adopt current history silently - the board
    // must not replay old events. Only events after this moment get cards.
    events.forEach((e) => seen.add(e.id));
    state.frigateSeen = [...seen].slice(-300);
    personSeeded = true;
    save();
    console.log('person watcher seeded with ' + events.length + ' existing events');
    return;
  }
  const fresh = events.filter((e) => !seen.has(e.id)).sort((a, b) => a.start_time - b.start_time);
  let changed = false;
  for (const e of fresh) {
    seen.add(e.id); changed = true;
    if (!personGateAllows(e.camera)) continue;
    const last = state.personCardAt[e.camera] || 0;
    if (Date.now() - last < CONFIG.personCooldownMin * 60000) continue;
    state.personCardAt[e.camera] = Date.now();
    cardPersonEvent(e);
  }
  // Face follow-up: an unknown person Frigate later identifies gets a
  // follow-up card (parity with the person-alert mailer's second send).
  const pend = state.personPending;
  const pendIds = Object.keys(pend);
  if (pendIds.length) {
    const byId = {};
    events.forEach((e) => { byId[e.id] = e; });
    for (const id of pendIds) {
      const info = pend[id];
      const ev = byId[id];
      if (ev && ev.sub_label) {
        const camName = cameraDisplayName(info.camera);
        addCard({ kind: 'person', title: ev.sub_label + ' identified - ' + camName, body: 'Frigate has now identified the unknown person at the ' + camName + ' as ' + ev.sub_label + '.', meta: 'Frigate person - follow-up', source: 'frigate', image: CONFIG.frigateUrl + '/api/events/' + id + '/snapshot.jpg' });
        delete pend[id];
        changed = true;
      } else if (Date.now() - (info.at || 0) > 2 * 3600000) {
        delete pend[id];
        changed = true;
      }
    }
  }
  if (changed) { state.frigateSeen = [...seen].slice(-300); save(); }
}

function removeCard(id) {
  const i = state.cards.findIndex((c) => c.id === id);
  if (i >= 0) { state.cards.splice(i, 1); save(); broadcast('snapshot', snapshot()); }
}

// ---- Calendar -> board cards (build list #4 upcoming + #8 morning) ----
function tzParts(d) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const parts = {};
  fmt.formatToParts(d || new Date()).forEach((pt) => { parts[pt.type] = pt.value; });
  return parts;
}
function parseStartMin(s) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(s || '').trim());
  if (!m) return null;
  let h = (+m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + (+m[2]);
}
function calendarTick() {
  const evs = (state.calendar && state.calendar.events) || [];
  if (!evs.length) return;
  const p = tzParts();
  const today = p.year + '-' + p.month + '-' + p.day;
  const tp = tzParts(new Date(Date.now() + 86400000));
  const tomorrow = tp.year + '-' + tp.month + '-' + tp.day;
  const nowMin = ((+p.hour) % 24) * 60 + (+p.minute);
  for (const e of evs) {
    if (e.allDay || !e.start) continue;
    const sm = parseStartMin(e.start);
    if (sm == null) continue;
    let delta = null;
    if (e.date === today) delta = sm - nowMin;
    else if (e.date === tomorrow) delta = (1440 - nowMin) + sm;
    if (delta == null || delta <= 0 || delta > 120) continue;
    const key = e.date + '|' + e.title + '|' + e.start;
    if (state.calCarded.includes(key)) continue;
    state.calCarded.push(key);
    state.calCarded = state.calCarded.slice(-120);
    addCard({ kind: 'calendar', title: 'Coming up - ' + e.title, body: (e.date === today ? 'Today' : 'Tomorrow') + ' at ' + e.start + (e.end ? '-' + e.end : '') + (e.location ? ' - ' + e.location : '') + '. Starts in ' + delta + ' min.', meta: 'Calendar', source: 'calendar' });
  }
  // Morning board: once a day, inside the 06:30-10:00 local window only.
  if (nowMin >= 390 && nowMin <= 600 && state.morningFor !== today) {
    state.morningFor = today;
    const todays = evs.filter((e) => e.date === today);
    const open = state.cards.filter((c) => c.kind === 'suggestion' && c.status === 'open').length;
    const lines = todays.length ? todays.map((e) => (e.allDay ? 'All day' : e.start) + ' ' + e.title).join(' - ') : 'Nothing on the calendar today.';
    addCard({ kind: 'calendar', title: 'Good morning - ' + p.weekday + ' ' + p.month + '/' + p.day, body: lines + (open ? ' - ' + open + ' item' + (open === 1 ? '' : 's') + ' waiting for your voice.' : ' - Nothing waiting for your voice.'), meta: 'Morning board', source: 'calendar' });
  }
}

const clients = new Set();
function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (e) {} }
}
function snapshot() { return { avatar: state.avatar, cards: state.cards, focusId: state.focusId, avatarMode: avatarMode, calendar: state.calendar, cameras: state.cameras, cameraView: state.cameraView, inbox: state.inbox, mailView: state.mailView, helpView: state.helpView, music: state.music, musicView: state.musicView, actionOutbox: state.actionOutbox, weather: state.weather, weatherView: state.weatherView, homeView: state.homeView, homeHidden: state.homeHidden, imageView: state.imageView, navStyle: state.navStyle, texts: state.texts, textView: state.textView, facebook: state.facebook, facebookView: state.facebookView, facebookPost: state.facebookPost, facebookGroup: state.facebookGroup, messenger: state.messenger, messengerView: state.messengerView, messengerThread: state.messengerThread, sms: state.sms, smsView: state.smsView, smsThread: state.smsThread, insta: state.insta, instaView: state.instaView, instaPost: state.instaPost, apps: state.apps, appsView: state.appsView, appView: state.appView, paper: state.paper, paperView: state.paperView, network: state.network, networkView: state.networkView, pc: state.pc, pcControl: state.pcControl, hid: state.hid || null, appsCatalog: APP_CATALOG.filter((c) => !state.apps.some((a) => a.id === c.id)) }; }
function showOnly(which) {
  // One modal at a time (the owner's rule, 2026-10-26): opening any overlay closes the others.
  if (which !== 'camera') state.cameraView = { visible: false, cameraId: null, identify: null };
  if (which !== 'mail') state.mailView = { visible: false, focusN: null };
  if (which !== 'home') state.homeView = { visible: false };
  if (which !== 'weather') state.weatherView = { visible: false };
  if (which !== 'music') state.musicView = { visible: false };
  if (which !== 'help') state.helpView = { visible: false };
  if (which !== 'image') state.imageView = { visible: false, src: null, title: null, credit: null };
  if (which !== 'facebook') state.facebookView.visible = false;
  if (which !== 'messenger') state.messengerView.visible = false;
  if (which !== 'sms') state.smsView.visible = false;
  if (which !== 'insta') state.instaView.visible = false;
  if (which !== 'apps') state.appsView.visible = false;
  if (which !== 'app') state.appView = null;
  if (which !== 'paper') state.paperView.visible = false;
  if (which !== 'network') state.networkView.visible = false;
  if (which !== 'calendar' && state.calendar) state.calendar.visible = false;
  if (which !== 'focus') state.focusId = null;
}
function openQueue() { return state.cards.filter((c) => c.kind === 'suggestion' && c.status === 'open'); }

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 3e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webp': 'image/webp' , '.pdf': 'application/pdf', '.ps1': 'text/plain', '.txt': 'text/plain' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event: snapshot\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (p === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (p === '/api/state' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.state) state.avatar.state = String(b.state);
    if (b.message !== undefined) state.avatar.message = String(b.message);
    state.avatar.since = Date.now();
    save(); broadcast('avatar', state.avatar);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/card' && req.method === 'POST') {
    const b = await readBody(req);
    const card = addCard(b);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: card.id }));
    return;
  }
  if (p === '/api/resolve' && req.method === 'POST') {
    const b = await readBody(req);
    const card = state.cards.find((c) => c.id === Number(b.id));
    if (card) {
      card.status = ['sent', 'skipped', 'held'].includes(b.action) ? b.action : 'skipped';
      card.resolvedAt = Date.now();
      if (state.focusId === card.id) state.focusId = null;
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/detail' && req.method === 'POST') {
    const b = await readBody(req);
    const card = state.cards.find((c) => c.id === Number(b.id));
    if (card) {
      if (Array.isArray(b.thread)) card.thread = b.thread.slice(0, 20);
      if (b.draft !== undefined) card.draft = String(b.draft);
      if (b.source) card.source = String(b.source);
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, found: !!card }));
    return;
  }
  if (p === '/api/focus' && req.method === 'POST') {
    const b = await readBody(req);
    let card = null;
    if (b.clear) {
      state.focusId = null;
    } else if (b.n !== undefined && b.n !== null) {
      card = openQueue()[Number(b.n) - 1] || null;
      state.focusId = card ? card.id : null;
    } else if (b.id !== undefined && b.id !== null) {
      card = state.cards.find((c) => c.id === Number(b.id)) || null;
      state.focusId = card ? card.id : null;
    }
    if (state.focusId != null) showOnly('focus');
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, focusId: state.focusId, card: card }));
    return;
  }
  if (p === '/api/camera' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) {
      state.cameraView = { visible: false, cameraId: null, identify: null };
    } else if (b.id) {
      state.cameraView = { visible: true, cameraId: String(b.id), identify: b.identify ? String(b.identify) : null };
      showOnly('camera');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cameraView: state.cameraView }));
    return;
  }
  if (p === '/api/camera/alias' && req.method === 'POST') {
    const b = await readBody(req);
    const cam = state.cameras.find((c) => c.id === String(b.id));
    if (cam && b.alias) {
      const a = String(b.alias);
      cam.aliases = cam.aliases || [];
      if (!cam.aliases.includes(a)) cam.aliases.push(a);
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, found: !!cam, aliases: cam ? (cam.aliases || []) : [] }));
    return;
  }
  if (p === '/api/cameras/rescan' && req.method === 'POST') {
    const cams = await discoverCameras();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cameras: cams }));
    return;
  }
  if (p === '/api/inbox' && req.method === 'POST') {
    const b = await readBody(req);
    if (Array.isArray(b.emails)) {
      // Preserve attached threads/drafts across refreshes (keyed by threadId).
      const prev = {};
      (state.inbox.emails || []).forEach((e) => { if (e.threadId) prev[e.threadId] = e; });
      state.inbox = {
        updatedAt: new Date().toISOString(),
        emails: b.emails.map((e) => {
          const old = e.threadId ? prev[e.threadId] : null;
          return old ? { ...e, thread: old.thread || null, draft: old.draft || null } : e;
        }),
      };
      if (state.mailView.focusN != null && state.mailView.focusN > state.inbox.emails.length) state.mailView.focusN = null;
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: state.inbox.emails.length }));
    return;
  }
  if (p === '/api/mail' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) {
      state.mailView = { visible: false, focusN: null };
    } else if (b.n != null) {
      const n = parseInt(b.n, 10);
      if (n >= 1 && n <= state.inbox.emails.length) { state.mailView = { visible: true, focusN: n }; showOnly('mail'); }
    } else if (b.show) {
      state.mailView = { visible: true, focusN: null };
      showOnly('mail');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mailView: state.mailView }));
    return;
  }
  if (p === '/api/mail/attach' && req.method === 'POST') {
    const b = await readBody(req);
    const e = state.inbox.emails[(parseInt(b.n, 10) || 0) - 1];
    if (e) {
      if (b.thread !== undefined) e.thread = b.thread;
      if (b.draft !== undefined) e.draft = b.draft;
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, found: !!e }));
    return;
  }
  if (p === '/api/mail/resolve' && req.method === 'POST') {
    const b = await readBody(req);
    const n = parseInt(b.n, 10) || 0;
    const e = state.inbox.emails[n - 1];
    if (e) {
      state.inbox.emails.splice(n - 1, 1);
      if (state.mailView.focusN === n) state.mailView.focusN = null;
      else if (state.mailView.focusN != null && state.mailView.focusN > n) state.mailView.focusN -= 1;
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, found: !!e, count: state.inbox.emails.length }));
    return;
  }
  if (p === '/api/ring' && req.method === 'POST') {
    // Live-call receiver for a phone-system webhook forwarder (Telnyx etc.).
    // {start:true, from, line} -> ringing card up. {end:true, answered} ->
    // ringing card down; missed calls become a callback queue card.
    const b = await readBody(req);
    if (b.start) {
      if (state.ringCardId != null) removeCard(state.ringCardId);
      const card = addCard({ kind: 'call', title: 'Ringing - ' + String(b.line || 'phone line'), body: 'Incoming call from ' + String(b.from || 'unknown number') + '.', meta: 'Live call', source: 'telnyx' });
      state.ringCardId = card.id;
      save(); broadcast('snapshot', snapshot());
    } else if (b.end) {
      const from = String(b.from || 'unknown number');
      if (state.ringCardId != null) { removeCard(state.ringCardId); state.ringCardId = null; }
      if (b.answered) {
        addCard({ kind: 'call', title: 'Call ended - ' + from, body: 'The call with ' + from + ' has ended.', meta: 'Call log', source: 'telnyx' });
      } else {
        addCard({ kind: 'suggestion', title: 'Missed call - ' + from, body: 'You missed a call from ' + from + '. Callback script: introduce yourself, apologize for missing them, ask how you can help.', meta: 'Call log - missed', source: 'telnyx', draft: 'Hi, I am returning your call. Sorry I missed you - how can I help?' });
      }
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ringCardId: state.ringCardId }));
    return;
  }
  // ---- PC companion agent (laptop): status, health, snapshots, commands ----
  const SCAM_TITLE_PHRASES = ['virus', 'microsoft support', 'call now', 'security alert', 'infected', 'do not turn off', 'has been locked', 'apple support', 'gift card', 'tech support'];
  function pcSuspect(pc) {
    const f = (pc.foreground || '').toLowerCase();
    if ((pc.remoteTools || []).length) return 'a remote-control tool is running: ' + pc.remoteTools.join(', ');
    for (const ph of SCAM_TITLE_PHRASES) if (f.includes(ph)) return 'the screen window title mentions ' + ph;
    return '';
  }
  let pcJudging = false;
  function pcOcr(fp) {
    return new Promise((resolve) => {
      try {
        require('child_process').execFile('tesseract', [fp, 'stdout', '--psm', '3'], { timeout: 20000, maxBuffer: 262144 }, (err, out) => resolve(err ? '' : String(out || '')));
      } catch (e) { resolve(''); }
    });
  }
  async function pcJudgeText(ocrText) {
    const rules = 'You check a computer screen text for scams aimed at seniors. A scam DECEIVES: it falsely claims the computer is infected or locked, demands the person call a support number, asks for gift cards, wire transfers or crypto payment, or impersonates Microsoft, Apple, a bank, or the police with urgent threats. NORMAL things that are NOT scams: command prompts, PowerShell, code, settings, update screens, ordinary apps and websites, even when technical. ALSO NORMAL, NEVER A SCAM: any text about a banner saying Cosmo is controlling this PC - that is the Fuse_Box banner from a session the PC owner started himself. You are given OCR text extracted from the screen (it may contain errors) plus context. Reply with ONLY this JSON: {"scam": true or false, "conf": 0.0 to 1.0, "why": "one short plain sentence"}';
    const ctx = 'Foreground window: ' + String(state.pc.foreground || '') + '. Remote tools running: ' + (state.pc.remoteTools && state.pc.remoteTools.length ? state.pc.remoteTools.join(', ') : 'none') + '. Screen text: ' + ocrText.slice(0, 2500);
    const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'llama3.2:3b', stream: false, options: { num_ctx: 4096 }, messages: [{ role: 'user', content: rules + '\n' + ctx }] }) });
    const d = await r.json();
    const txt = (d.message && d.message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  }
  async function pcJudgeVision(fp) {
    const b64 = fs.readFileSync(fp).toString('base64');
    const prompt = 'You check a computer screen image for scams aimed at seniors. A scam screen DECEIVES: false infection or lock claims, demands to call a support number, gift card or wire or crypto payment demands, impersonation of Microsoft, Apple, a bank, or police with urgent threats. NORMAL, NOT scams: command prompts, PowerShell, code, settings, updates, ordinary apps and websites. ALSO NORMAL, NEVER A SCAM: a red or blue banner at the very top saying Cosmo is controlling or guiding this PC - that is the Fuse_Box banner from a session the PC owner started himself. Reply with ONLY this JSON: {"scam": true or false, "conf": 0.0 to 1.0, "why": "one short plain sentence"}';
    const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen3-vl:4b', stream: false, messages: [{ role: 'user', content: prompt, images: [b64] }] }) });
    const d = await r.json();
    const txt = (d.message && d.message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  }
  async function pcJudge() {
    if (pcJudging) return;
    pcJudging = true;
    try {
      const fp = path.join(__dirname, 'public', 'pc', 'latest.jpg');
      const ocr = await pcOcr(fp);
      let v = null;
      if (ocr && ocr.trim().length > 15) { try { v = await pcJudgeText(ocr); } catch (e) {} }
      if (!v || typeof v.conf !== 'number' || v.conf < 0.75) { try { const vv = await pcJudgeVision(fp); if (vv) v = vv; } catch (e) {} }
      if (!v) return;
      state.pc.verdict = { scam: !!v.scam, why: String(v.why || ''), at: Date.now() };
      if (v.scam) {
        addCard({ kind: 'suggestion', title: 'Possible scam on the laptop', body: String(v.why || 'The laptop screen looks like a scam.') + ' Say show me my laptop screen to see it.', meta: 'PC guardian', source: 'pc', image: '/pc/latest.jpg' });
        state.actionOutbox.push(Object.assign({ kind: 'pc-alert', why: String(v.why || '') }, { id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), at: Date.now() }));
      }
      save(); broadcast('snapshot', snapshot());
    } catch (e) {}
    pcJudging = false;
  }
  if (p === '/api/pc/status' && req.method === 'POST') {
    const b = await readBody(req);
    state.pc.name = String(b.name || state.pc.name || '');
    state.pc.user = String(b.user || '');
    state.pc.os = String(b.os || '');
    state.pc.foreground = String(b.foreground || '');
    if (b.agent) state.pc.agent = String(b.agent);
    if (b.guide !== undefined) state.pc.guide = String(b.guide || '');
    state.pc.remoteTools = Array.isArray(b.remoteTools) ? b.remoteTools.map(String) : [];
    if (typeof b.control === 'boolean') { if (b.control && !state.pcControl.active) state.pcControl.since = Date.now(); state.pcControl.active = b.control; state.pc.control = b.control; }
    state.pc.online = true; state.pc.lastSeen = Date.now();
    const why = pcSuspect(state.pc);
    if (why && Date.now() - (state.pcAutoSnapAt || 0) > 60000) { state.pcCommand = 'snapshot'; state.pcAutoSnapAt = Date.now(); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/pc/health' && req.method === 'POST') {
    const b = await readBody(req);
    state.pc.health = Object.assign({}, state.pc.health || {}, b.report || {}); state.pc.healthAt = Date.now();
    const r = state.pc.health;
    const tot = (Number(r.diskUsedGB) || 0) + (Number(r.diskFreeGB) || 0);
    const freePct = tot ? Math.round(100 * (Number(r.diskFreeGB) || 0) / tot) : null;
    const bits = [];
    if (freePct !== null) bits.push('disk ' + freePct + '% free');
    if (r.cpuLoad !== undefined) bits.push('CPU ' + r.cpuLoad + '%');
    if (r.updatesPending !== undefined && r.updatesPending >= 0) bits.push(r.updatesPending + ' updates waiting');
    if (r.defenderOn !== undefined) bits.push(r.defenderOn ? 'antivirus on' : 'ANTIVIRUS OFF');
    const rkeys = Object.keys(b.report || {});
    if (!(rkeys.length === 1 && rkeys[0] === 'updatesPending')) addCard({ kind: 'system', title: 'Laptop health check', body: bits.join(' - ') + '.', meta: 'PC agent', source: 'pc' });
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/pc/snapshot' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.foreground !== undefined) state.pc.foreground = String(b.foreground || '');
    if (Array.isArray(b.remoteTools)) state.pc.remoteTools = b.remoteTools.map(String);
    state.pc.online = true; state.pc.lastSeen = Date.now();
    let savedSnap = false;
    if (b.image && String(b.image).length > 1000) {
      try {
        const dir = path.join(__dirname, 'public', 'pc');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'latest.jpg'), Buffer.from(String(b.image), 'base64'));
        state.pc.snapshotAt = Date.now(); savedSnap = true;
      } catch (e) {}
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saved: savedSnap }));
    if (savedSnap && !state.pcControl.active) pcJudge();
    return;
  }
  if (p === '/api/pc/control' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.start) { state.pcControl.active = true; state.pcControl.since = Date.now(); state.pcCommand = 'control-start'; }
    if (b.stop) { state.pcControl.active = false; state.pcCommand = 'control-stop'; }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, control: state.pcControl }));
    return;
  }
  if (p === '/api/pc/command' && req.method === 'GET') {
    const c = state.pcCommand; state.pcCommand = null;
    if (c) { save(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ command: c }));
    return;
  }
  if (p === '/api/pc/command' && req.method === 'POST') {
    const b = await readBody(req);
    const cmd = String(b.command || '');
    const isControl = /^(click|dblclick|rclick|move|scroll|type|key|shell|seq|uia-click):/.test(cmd) || cmd === 'wiggle';
    if (isControl && !state.pcControl.active) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no active control session' })); return; }
    if (isControl) state.pcControl.lastActionAt = Date.now();
    state.pcCommand = cmd || null;
    save();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: state.pcCommand }));
    return;
  }
  if (p === '/api/hid/command' && req.method === 'POST') {
    const b = await readBody(req);
    const cmd = String(b.command || '');
    if (!/^(type:|key:|move:|click:|dblclick:|rclick:|scroll:)/.test(cmd)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'bad hid command' })); return; }
    if (!state.pcControl || !state.pcControl.active) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no active control session' })); return; }
    hidQueue.push(cmd.slice(0, 300));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, queued: cmd.slice(0, 60) })); return;
  }
  if (p === '/api/hid/command' && req.method === 'GET') {
    const cmd = hidQueue.shift() || '';
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ command: cmd })); return;
  }
  if (p === '/api/hid/status' && req.method === 'POST') {
    const b = await readBody(req);
    state.hid = { emitter: String(b.emitter || ''), transport: String(b.transport || ''), detail: String(b.detail || ''), at: Date.now() };
    save();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
  }
  if (p === '/api/pc/result' && req.method === 'POST') {
    const b = await readBody(req);
    state.pc.lastResult = { command: String(b.command || ''), ok: !!b.ok, detail: String(b.detail || '').slice(0, 200), output: String(b.output || '').slice(0, 9000), at: Date.now() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/ha/entities' && req.method === 'GET') {
    try {
      const entities = await haEntities();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entities, at: haCache.at }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (p === '/api/ha/control' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const dom = String(b.id || '').split('.')[0];
      if (!HA_CONTROL.includes(dom)) throw new Error('domain not controllable: ' + dom);
      let svc = { on: 'turn_on', off: 'turn_off', toggle: 'toggle' }[b.action || 'toggle'];
      if (dom === 'media_player' && b.action === 'toggle') svc = 'media_play_pause';
      if (dom === 'scene') svc = 'turn_on';
      await haCall('POST', '/api/services/' + dom + '/' + svc, { entity_id: b.id });
      haCache.at = 0;
      const entities = await haEntities();
      const ent = entities.find((e) => e.id === b.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entity: ent || null }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  if (p === '/api/ha/hide' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.id && !state.homeHidden.includes(b.id)) state.homeHidden.push(b.id);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hidden: state.homeHidden.length }));
    return;
  }
  if (p === '/api/ha/unhide' && req.method === 'POST') {
    const b = await readBody(req);
    state.homeHidden = state.homeHidden.filter((x) => x !== b.id);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hidden: state.homeHidden.length }));
    return;
  }
  if (p === '/api/ha' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.show) { state.homeView = { visible: true }; showOnly('home'); }
    if (b.clear) state.homeView = { visible: false };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/weather' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.state !== undefined) state.weather = b.state;
    if (b.show) { state.weatherView = { visible: true }; showOnly('weather'); }
    if (b.clear) state.weatherView = { visible: false };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, has: !!state.weather }));
    return;
  }
  if (p === '/api/music' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.state) {
      if (b.state.nowPlaying !== undefined) state.music.nowPlaying = b.state.nowPlaying;
      if (Array.isArray(b.state.picks)) state.music.picks = b.state.picks.slice(0, 12);
      if (Array.isArray(b.state.devices)) state.music.devices = b.state.devices.slice(0, 8);
      state.music.updatedAt = Date.now();
    }
    if (b.show) { state.musicView = { visible: true }; showOnly('music'); }
    if (b.clear) state.musicView = { visible: false };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, musicView: state.musicView }));
    return;
  }
  if (p === '/api/action' && req.method === 'POST') {
    // Touch intents from the screen: the client posts what the owner tapped;
    // a watcher (feeders/touch-actions.py) forwards each entry to the voice
    // session as a message, then acks it away. The UI itself executes nothing.
    const b = await readBody(req);
    if (Array.isArray(b.ack)) {
      const ids = new Set(b.ack);
      state.actionOutbox = state.actionOutbox.filter((a) => !ids.has(a.id));
    } else if (b.kind) {
      const entry = Object.assign({}, b, { id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), at: Date.now() });
      state.actionOutbox.push(entry);
      if (state.actionOutbox.length > 50) state.actionOutbox = state.actionOutbox.slice(-50);
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pending: state.actionOutbox.length }));
    return;
  }
  if (p === '/api/sms' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.smsView.visible = false;
    if (b.show) { state.smsView.visible = true; showOnly('sms'); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, smsView: state.smsView }));
    return;
  }
  if (p === '/api/sms/data' && req.method === 'POST') {
    const b = await readBody(req);
    state.sms = { threads: Array.isArray(b.threads) ? b.threads.slice(0, 20) : [], updatedAt: new Date().toISOString() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sms: state.sms }));
    return;
  }
  if (p === '/api/sms/thread' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.smsThread = null;
    else {
      state.smsThread = { id: b.id || null, name: b.name || '', messages: Array.isArray(b.messages) ? b.messages.slice(0, 60) : [] };
      state.smsView.visible = true;
      showOnly('sms');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, smsThread: state.smsThread }));
    return;
  }
  if (p === '/api/sms/draft' && req.method === 'POST') {
    const b = await readBody(req);
    state.smsView.draft = b.clear ? null : { text: String(b.text || ''), threadN: b.threadN || null, name: b.name || null };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, draft: state.smsView.draft }));
    return;
  }
  if (p === '/api/apps' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.appsView.visible = false;
    if (b.show) { state.appsView.visible = true; showOnly('apps'); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, appsView: state.appsView }));
    return;
  }
  if (p === '/api/apps/data' && req.method === 'POST') {
    const b = await readBody(req);
    if (Array.isArray(b.apps)) state.apps = b.apps.slice(0, 40);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, apps: state.apps.length }));
    return;
  }
  if (p === '/api/apps/add' && req.method === 'POST') {
    const b = await readBody(req);
    const c = APP_CATALOG.find((a) => a.id === b.id);
    if (c && !state.apps.some((a) => a.id === c.id)) state.apps.push(catalogApp(c));
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, apps: state.apps.length }));
    return;
  }
  if (p === '/api/apps/dock' && req.method === 'POST') {
    const b = await readBody(req);
    const a = state.apps.find((x) => x.id === b.id);
    if (a) a.inDock = !!b.inDock;
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, apps: state.apps }));
    return;
  }
  if (p === '/api/app' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.appView = null;
    else if (b.id) {
      const a = state.apps.find((x) => x.id === b.id) || APP_CATALOG.find((x) => x.id === b.id);
      if (a) { state.appView = { id: a.id }; showOnly('app'); }
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, appView: state.appView }));
    return;
  }
  if (p === '/api/network' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.networkView.visible = false;
    if (b.show) { state.networkView.visible = true; showOnly('network'); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, networkView: state.networkView }));
    return;
  }
  if (p === '/api/network/data' && req.method === 'POST') {
    const b = await readBody(req);
    state.network = { host: b.host || null, links: Array.isArray(b.links) ? b.links.slice(0, 8) : [], devices: Array.isArray(b.devices) ? b.devices.slice(0, 24) : [], unknown: Array.isArray(b.unknown) ? b.unknown.slice(0, 16) : [], summary: b.summary || null, updatedAt: new Date().toISOString() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, network: state.network }));
    return;
  }
  if (p === '/api/paper' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.paperView.visible = false;
    if (b.show) { state.paperView.visible = true; showOnly('paper'); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, paperView: state.paperView }));
    return;
  }
  if (p === '/api/paper/data' && req.method === 'POST') {
    const b = await readBody(req);
    state.paper = { edition: b.edition || null, updatedAt: new Date().toISOString() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, paper: state.paper }));
    return;
  }
  if (p === '/api/insta' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.instaView.visible = false;
    if (b.show) { state.instaView.visible = true; showOnly('insta'); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, instaView: state.instaView }));
    return;
  }
  if (p === '/api/insta/data' && req.method === 'POST') {
    const b = await readBody(req);
    state.insta = { profile: b.profile || null, posts: Array.isArray(b.posts) ? b.posts.slice(0, 20) : [], updatedAt: new Date().toISOString() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, posts: state.insta.posts.length }));
    return;
  }
  if (p === '/api/insta/post' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.instaPost = null;
    else {
      state.instaPost = { n: b.n || null, id: b.id || null, username: b.username || '', avatar: b.avatar || '', caption: b.caption || '', time: b.time || null, mediaType: b.mediaType || '', likes: (b.likes === undefined ? null : b.likes), comments: Array.isArray(b.comments) ? b.comments.slice(0, 60) : [] };
      state.instaView.visible = true;
      showOnly('insta');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, instaPost: state.instaPost }));
    return;
  }
  if (p === '/api/messenger' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.messengerView.visible = false;
    if (b.show) { state.messengerView.visible = true; showOnly('messenger'); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messengerView: state.messengerView }));
    return;
  }
  if (p === '/api/messenger/data' && req.method === 'POST') {
    const b = await readBody(req);
    state.messenger = { threads: Array.isArray(b.threads) ? b.threads.slice(0, 20) : [], updatedAt: new Date().toISOString() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messenger: state.messenger }));
    return;
  }
  if (p === '/api/messenger/thread' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.messengerThread = null;
    else {
      state.messengerThread = { id: b.id || null, name: b.name || '', messages: Array.isArray(b.messages) ? b.messages.slice(0, 60) : [] };
      state.messengerView.visible = true;
      showOnly('messenger');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messengerThread: state.messengerThread }));
    return;
  }
  if (p === '/api/messenger/draft' && req.method === 'POST') {
    const b = await readBody(req);
    state.messengerView.draft = b.clear ? null : { text: String(b.text || ''), threadN: b.threadN || null, name: b.name || null };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, draft: state.messengerView.draft }));
    return;
  }
  if (p === '/api/facebook' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.facebookView.visible = false;
    else if (b.show) { state.facebookView.visible = true; showOnly('facebook'); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, facebookView: state.facebookView }));
    return;
  }
  if (p === '/api/facebook/group' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.facebookGroup = null;
    else {
      state.facebookGroup = { id: b.id || null, name: b.name || '', posts: Array.isArray(b.posts) ? b.posts.slice(0, 20) : [] };
      state.facebookView.visible = true;
      showOnly('facebook');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, facebookGroup: state.facebookGroup }));
    return;
  }
  if (p === '/api/facebook/post' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.facebookPost = null;
    else {
      state.facebookPost = { n: b.n || null, id: b.id || null, author: b.author || '', text: b.text || '', time: b.time || null, url: b.url || '', reactions: Array.isArray(b.reactions) ? b.reactions : [], comments: Array.isArray(b.comments) ? b.comments.slice(0, 30) : [] };
      state.facebookView.visible = true;
      showOnly('facebook');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, facebookPost: state.facebookPost }));
    return;
  }
  if (p === '/api/facebook/data' && req.method === 'POST') {
    const b = await readBody(req);
    state.facebook = { me: b.me || null, posts: Array.isArray(b.posts) ? b.posts.slice(0, 20) : [], groups: Array.isArray(b.groups) ? b.groups.slice(0, 12) : [], birthdays: Array.isArray(b.birthdays) ? b.birthdays.slice(0, 8) : [], updatedAt: new Date().toISOString() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, posts: state.facebook.posts.length }));
    return;
  }
  if (p === '/api/facebook/draft' && req.method === 'POST') {
    const b = await readBody(req);
    state.facebookView.draft = b.clear ? null : { kind: ['comment', 'birthday'].includes(b.kind) ? b.kind : 'post', text: String(b.text || ''), postN: b.postN || null, person: b.person || null };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, draft: state.facebookView.draft }));
    return;
  }
  if (p === '/api/texts' && req.method === 'POST') {
    const b = await readBody(req);
    if (Array.isArray(b.messages)) state.texts = { messages: b.messages.slice(0, 30), updatedAt: new Date().toISOString() };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: state.texts.messages.length }));
    return;
  }
  if (p === '/api/texts/highlight' && req.method === 'POST') {
    const b = await readBody(req);
    state.textView.highlightId = b.id || null;
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/navstyle' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.style === 'dock' || b.style === 'bar') state.navStyle = b.style;
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, navStyle: state.navStyle }));
    return;
  }
  if (p === '/api/image' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) {
      state.imageView = { visible: false, src: null, title: null, credit: null };
    } else if (b.show && b.src) {
      state.imageView = { visible: true, src: String(b.src), title: b.title ? String(b.title) : '', credit: b.credit ? String(b.credit) : '' };
      showOnly('image');
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, imageView: state.imageView }));
    return;
  }
  if (p === '/api/help' && req.method === 'POST') {
    const b = await readBody(req);
    state.helpView = { visible: !!b.show && !b.clear };
    if (state.helpView.visible) showOnly('help');
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, helpView: state.helpView }));
    return;
  }
  if (p === '/api/calendar' && req.method === 'POST') {
    const b = await readBody(req);
    if (!state.calendar) state.calendar = { visible: false, view: 'days30', date: null, anchor: null, days: 60, events: [] };
    if (Array.isArray(b.events)) state.calendar.events = b.events.slice(0, 500);
    if (b.view && ['days30', 'week', 'day'].includes(b.view)) state.calendar.view = b.view;
    if (b.date !== undefined) state.calendar.date = b.date ? String(b.date) : null;
    if (b.anchor) state.calendar.anchor = String(b.anchor);
    if (b.days) state.calendar.days = Number(b.days);
    if (b.show !== undefined) state.calendar.visible = !!b.show;
    if (state.calendar.visible) showOnly('calendar');
    state.calendar.updatedAt = Date.now();
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, visible: state.calendar.visible, view: state.calendar.view, events: state.calendar.events.length }));
    return;
  }
  if (p === '/api/clear' && req.method === 'POST') {
    state.cards = state.cards.filter((c) => c.kind === 'suggestion' && c.status === 'open');
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return;
  }
  // static
  let file = p === '/' ? '/index.html' : p;
  const fp = path.join(PUB, path.normalize(file).replace(/^\/+/, ''));
  if (!fp.startsWith(PUB) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => { console.log('cosmo-ui listening on ' + PORT); discoverCameras().then((c) => console.log('cameras discovered: ' + c.length)); pollPersons().catch(() => {}); setInterval(() => { pollPersons().catch(() => {}); }, CONFIG.personPollSec * 1000); setInterval(() => { try { calendarTick(); } catch (e) {} }, 60000); });
