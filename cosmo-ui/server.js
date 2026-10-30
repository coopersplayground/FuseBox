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
const PC_SHARE_DIR = '/srv/guardian-install';
const PC_SHARE_FILE = 'Install PC Guardian.bat';
let pcShareOn = false;
let pcShareTimer = null;
function pcBoxAddress() {
  const ifs = os.networkInterfaces();
  let lan = '';
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.indexOf('100.') === 0) return a.address;
      if (!lan) lan = a.address;
    }
  }
  return lan || '127.0.0.1';
}
function pcShareSet(on) {
  return new Promise((resolve) => {
    if (on) {
      try {
        fs.mkdirSync(PC_SHARE_DIR, { recursive: true });
        const url = 'http://' + pcBoxAddress() + ':' + (CONFIG.port || 3180) + '/pc/install.ps1';
        const bat = ['@echo off', 'title PC Guardian Installer', 'echo Installing your PC Guardian - this takes about a minute...', 'powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr ' + url + ' -UseBasicParsing | iex"', 'echo.', 'echo Done. This computer shows up on the Guardian screen in about a minute.', 'pause', ''].join('\r\n');
        fs.writeFileSync(path.join(PC_SHARE_DIR, PC_SHARE_FILE), bat);
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); return; }
    }
    require('child_process').execFile('sudo', ['-n', 'systemctl', on ? 'start' : 'stop', 'smbd', 'wsdd2'], { timeout: 20000 }, (err) => {
      if (err) { resolve({ ok: false, error: 'the sharing service did not respond' }); return; }
      pcShareOn = on;
      if (pcShareTimer) { clearTimeout(pcShareTimer); pcShareTimer = null; }
      if (on) pcShareTimer = setTimeout(() => { pcShareSet(false).catch(() => {}); }, 15 * 60 * 1000);
      broadcast('snapshot', snapshot());
      resolve({ ok: true, on: pcShareOn });
    });
  });
}

// ---------------- Fuse Shop (Android apps via Waydroid) ----------------
function wdExec(args, timeout) {
  return new Promise((resolve) => {
    require('child_process').execFile('waydroid', args, { timeout: timeout || 60000, maxBuffer: 1048576, env: Object.assign({}, process.env, { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/' + os.userInfo().uid }) }, (err, out, errOut) => resolve({ err, out: String(out || ''), errOut: String(errOut || '') }));
  });
}
async function wdInstalled() {
  const pm = await new Promise((resolve) => {
    require('child_process').execFile('sudo', ['-n', 'waydroid', 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 30000, maxBuffer: 1048576 }, (err, out) => resolve({ err, out: String(out || '') }));
  });
  if (!pm.err) {
    const pkgs = [];
    pm.out.split('\n').forEach((ln) => { const m = ln.match(/^package:(\S+)/); if (m) pkgs.push(m[1]); });
    return pkgs;
  }
  const r = await wdExec(['app', 'list'], 30000);
  if (r.err) return state.shop.installed || [];
  const pkgs = [];
  r.out.split('\n').forEach((ln) => { const m = ln.match(/^packageName:\s*(\S+)/i); if (m) pkgs.push(m[1]); });
  return pkgs;
}
let SHOP_ALL = [];
function shopSlice() {
  const q = String(state.shop.query || '').trim().toLowerCase();
  const cat = String(state.shop.category || '');
  let list = SHOP_ALL;
  if (cat) list = list.filter((a) => (a.cats || []).includes(cat));
  if (q) list = list.filter((a) => (a.name + ' ' + a.package + ' ' + (a.description || '')).toLowerCase().includes(q));
  state.shop.total = list.length;
  state.shop.apps = list.slice(0, 60);
}
function shopFind(pkg) {
  return (state.shop.apps || []).find((a) => a.package === pkg) || SHOP_ALL.find((a) => a.package === pkg) || null;
}
function androidAppsList() { return (state.shop.installed || []).map((pkg) => { const a = shopFind(pkg); return { package: pkg, name: a ? a.name : pkg, icon: a ? (a.icon || '') : '' }; }); }
function westonIds(cb) { require('child_process').execFile('xdotool', ['search', '--class', 'Weston'], { env: Object.assign({}, process.env, { DISPLAY: ':0' }) }, (e, out) => cb(String(out || '').split(/\s+/).filter(Boolean))); }
function raiseAndroid() { westonIds((ids) => { for (const id of ids) { require('child_process').execFile('xdotool', ['windowmove', id, '0', '0'], { env: Object.assign({}, process.env, { DISPLAY: ':0' }) }, () => {}); require('child_process').execFile('xdotool', ['windowraise', id], { env: Object.assign({}, process.env, { DISPLAY: ':0' }) }, () => {}); } }); }
function lowerAndroid() { westonIds((ids) => { for (const id of ids) require('child_process').execFile('xdotool', ['windowmove', id, '1920', '0'], { env: Object.assign({}, process.env, { DISPLAY: ':0' }) }, () => {}); }); }
async function shopFetch(manual) {
  state.shop.installed = await wdInstalled();
  const url = String(CONFIG.fuseShopUrl || '').trim();
  if (!url) { SHOP_ALL = []; shopSlice(); state.shop.error = 'No shop address is set on this box yet.'; state.shop.fetchedAt = Date.now(); save(); broadcast('snapshot', snapshot()); return; }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'FuseShop/1.0' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    state.shop.name = String(j.name || 'Fuse Shop');
    if (Array.isArray(j.cats)) state.shop.cats = j.cats.filter((c) => typeof c === 'string').slice(0, 24);
    SHOP_ALL = (Array.isArray(j.apps) ? j.apps : []).map((a) => ({
      name: String(a.name || 'App'), package: String(a.package || ''), version: String(a.version || ''),
      description: String(a.description || ''),
      cats: Array.isArray(a.cats) ? a.cats.filter((c) => typeof c === 'string') : [],
      icon: a.icon ? new URL(String(a.icon), url).toString() : '',
      apk: a.apk ? new URL(String(a.apk), url).toString() : ''
    })).filter((a) => a.package && a.apk);
    shopSlice();
    state.shop.error = '';
  } catch (e) {
    state.shop.error = 'Could not reach the shop. Check that this box is online, and the shop address is right.';
  }
  state.shop.fetchedAt = Date.now();
  if (manual && !state.shop.error) state.shop.installMsg = 'The shop is up to date.';
  save(); broadcast('snapshot', snapshot());
}
async function shopDownloadFile(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': 'FuseShop/1.0' } });
  if (!r.ok) throw new Error('http ' + r.status);
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  const st = fs.statSync(dest);
  if (st.size > 400 * 1024 * 1024) { try { fs.unlinkSync(dest); } catch (e) {} throw new Error('too large'); }
  if (st.size < 10000) throw new Error('too small');
}
function shopPmInstall(apkPath, pkg) {
  // Install through Android's own package manager (sudo waydroid shell pm
  // install) and require its printed "Success". The `waydroid app install`
  // CLI silently no-ops on this box after a reboot, so the shop does not
  // trust it.
  return new Promise((resolve, reject) => {
    const tmpDir = path.join(os.homedir(), '.local/share/waydroid/data/local/tmp');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
    require('child_process').execFile('sudo', ['-n', 'cp', apkPath, path.join(tmpDir, pkg + '.apk')], { timeout: 60000 }, (err1) => {
      if (err1) return reject(err1);
      // NOTE: no flags after `waydroid shell` - its argparse eats pm's flags
      // (e.g. -r) as its own and the command never runs.
      const pmRun = (args) => new Promise((res2) => {
        require('child_process').execFile('sudo', ['-n', 'waydroid', 'shell'].concat(args), { timeout: 180000, maxBuffer: 1048576 }, (e2, out, errOut) => res2(String(out || '') + String(errOut || '')));
      });
      (async () => {
        let s = await pmRun(['pm', 'install', '/data/local/tmp/' + pkg + '.apk']);
        if (s.indexOf('Success') < 0 && s.indexOf('ALREADY_EXISTS') >= 0) {
          await pmRun(['pm', 'uninstall', pkg]);
          s = await pmRun(['pm', 'install', '/data/local/tmp/' + pkg + '.apk']);
        }
        if (s.indexOf('Success') >= 0) resolve();
        else reject(new Error((s || 'pm install failed').slice(0, 160)));
      })().catch(reject);
    });
  });
}
async function shopInstall(app) {
  try {
    const dir = path.join(os.homedir(), 'fuse-shop');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, app.package + '.apk');
    await shopDownloadFile(app.apk, dest);
    await shopPmInstall(dest, app.package);
    state.shop.installMsg = app.name + ' is installed. Tap OPEN to start it.';
  } catch (e) {
    state.shop.installMsg = 'Sorry - ' + app.name + ' could not be installed. Nothing was changed.';
  }
  state.shop.busy = '';
  state.shop.installed = await wdInstalled();
  save(); broadcast('snapshot', snapshot());
}

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
      { id: 4, kind: 'calendar', title: 'Community library book sale (demo)', body: 'The annual book sale opens Saturday at 9 AM.', meta: 'Sat · 9:00 AM', time: Date.now() - 20 * 60000, status: 'info' },
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
if (state.settings === undefined) state.settings = { wifi: { radio: true, connected: null, networks: [], saved: [], updatedAt: null, lastError: null } };
if (state.settingsView === undefined) state.settingsView = { visible: false };
const APP_CATALOG = [
  { id: 'spotify', name: 'Spotify', icon: '\u{1F3B5}', bg: '#1db954', desc: "Music on your speakers and this room.", target: 'music', facts: ["Controls what is already playing - it never hijacks the device", "Open it to jump to the Music page"] },
  { id: 'gmail', name: 'Gmail', icon: '\u2709', bg: '#ea4335', desc: "Your Gmail inbox, on the board.", target: 'mail', facts: ["New mail lands on its own every few minutes", "Drafts are only sent when you say send it"] },
  { id: 'calendar', name: 'Calendar', icon: '\u{1F4C5}', bg: '#4285f4', desc: "Your Google calendars, next 60 days.", target: 'calendar', facts: ["The board keeps the next 60 days loaded", "Say a date and it opens that day"] },
  { id: 'facebook', name: 'Facebook', icon: 'f', bg: '#1877f2', desc: "Your Facebook feed, groups and birthdays.", target: 'facebook', facts: ["One set of numbers across the whole page", "Posts and comments need your approval first"] },
  { id: 'messenger', name: 'Messenger', icon: '\u{1F4AC}', bg: '#a033ff', desc: "Your Messenger chats in a phone.", target: 'messenger', facts: ["Refreshes on its own every 2 minutes", "Replies are drafted first, sent on your word"] },
  { id: 'instagram', name: 'Instagram', icon: '\u{1F4F7}', bg: '#d62976', desc: "Your Instagram feed in a phone.", target: 'instagram', facts: ["Shows your following feed and its comments", "Refreshes on its own every 10 minutes"] },
  { id: 'texts', name: 'Texts', icon: '\u{1F4F1}', bg: '#2fbf4f', desc: "Your phone text messages in a phone.", target: 'texts', facts: ["Drafts are read back before anything sends", "Texts refresh while Cosmo is awake"] },
  { id: 'telnyx', name: 'Phone', icon: '\u{1F4DE}', bg: '#0aa06e', desc: "Phone calls through your phone line.", target: null, facts: ["Your board number is +1 555-555-0100", "In the final product, calls ring right here on the box"] },
  { id: 'home', name: 'Home Assistant', icon: '\u{1F3E0}', bg: '#03a9f4', desc: "Switches, cameras and automations in your home.", target: 'home', facts: ["Tap a tile to turn something on or off", "Long-press a tile to hide it from the page"] },
  { id: 'frigate', name: 'Cameras', icon: '\u{1F3A5}', bg: '#455a64', desc: "Your security cameras, live.", target: 'cameras', facts: ["Shop, driveway and microscope cameras", "Say a camera name and it comes right up"] },
  { id: 'weather', name: 'Weather', icon: '\u2600\u{FE0F}', bg: '#b97f10', desc: "Local weather for New York.", target: 'weather', facts: ["Updates itself every 30 minutes", "Open it for the hour-by-hour and week ahead"] },
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
function catalogApp(c, status) { return { id: c.id, name: c.name, icon: c.icon, bg: c.bg, desc: c.desc, target: c.target || null, facts: c.facts || [], kind: 'connector', status: status || 'connected', inDrawer: false, custom: false }; }
if (!Array.isArray(state.apps)) state.apps = APP_SEED.map((id) => catalogApp(APP_CATALOG.find((a) => a.id === id)));
for (const a of state.apps) { if (a.inDrawer === undefined && a.inDock !== undefined) a.inDrawer = a.inDock; delete a.inDock; }
if (state.guardian && !state.guardian.wizard) state.guardian.wizard = { step: 'welcome' };
if (state.guardian && !state.guardian.candidates) state.guardian.candidates = [];
if (!state.guardian) state.guardian = { adapter: { found: false, ip: '', mac: '', model: '', registered: false, status: '' }, line: { number: '', status: 'none' }, setup: { busy: false, step: '', error: '', needsPassword: false }, porting: { status: '', number: '', carrier: '' } };
if (!Array.isArray(state.guardian.calls)) state.guardian.calls = [];
if (typeof state.guardian.live === 'undefined') state.guardian.live = null;
if (!state.guardianView) state.guardianView = { visible: false };
if (!state.shop) state.shop = { name: 'Fuse Shop', apps: [], installed: [], fetchedAt: 0, error: '', busy: '', installMsg: '', query: '', category: '', total: 0, cats: [] };
if (state.shop && typeof state.shop === 'object') { if (typeof state.shop.query !== 'string') state.shop.query = ''; if (typeof state.shop.category !== 'string') state.shop.category = ''; if (!Array.isArray(state.shop.cats)) state.shop.cats = []; if (typeof state.shop.total !== 'number') state.shop.total = 0; }
if (!state.shopView) state.shopView = { visible: false };
if (!state.apps.some((a) => a.id === 'fuse-shop')) state.apps.push({ id: 'fuse-shop', name: 'Fuse Shop', icon: '\u{1F6D2}', bg: '#b45309', desc: 'Android apps for this box, from the Fuse Shop. Tap INSTALL and the app is downloaded and put on the box for you.', target: 'shop', kind: 'built', status: 'ready', custom: true, facts: ['Apps come from the shop address set on this box', 'Installs go into the Android side of the box (Waydroid)', 'Tap OPEN on an installed app to start it'], inDrawer: false });
if (!state.apps.some((a) => a.id === 'guardian')) state.apps.push({ id: 'guardian', name: 'Guardian', icon: '\u{1F6E1}\u{FE0F}', bg: '#5b21b6', desc: 'Your home phone, guarded - set up the phone adapter, get your number, and let the Guardian watch over your calls.', target: 'guardian', kind: 'built', status: 'ready', custom: true, facts: ['Plug the Grandstream adapter into power and the network, and your phone into PHONE 1 - this app does the rest', 'A new local number, or bring the number you already have', 'Fail-open: if this box is ever off, calls still ring your phone like always', 'Screening, the family code word and the scam watch live here once your line is set up'], inDrawer: false });


// Avatar mode: 'real' shows the user's actual Muse avatar (image + activity
// videos in public/avatar/), 'svg' shows the built-in drawn bot. the owner's
// call: real for the dev build, REMOVE (svg) for the hackathon submission -
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
  const cfg = await httpGetJson(CONFIG.frigateUrl + '/api/config', 3000);
  if (cfg && cfg.cameras) {
    found = Object.keys(cfg.cameras).map((name) => ({ id: 'frigate:' + name, name: humanize(name), source: 'frigate', feed: CONFIG.frigateUrl + '/api/' + name }));
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
function snapshot() { return { avatar: state.avatar, cards: state.cards, focusId: state.focusId, avatarMode: avatarMode, calendar: state.calendar, cameras: state.cameras, cameraView: state.cameraView, inbox: state.inbox, mailView: state.mailView, helpView: state.helpView, music: state.music, musicView: state.musicView, actionOutbox: state.actionOutbox, weather: state.weather, weatherView: state.weatherView, homeView: state.homeView, homeHidden: state.homeHidden, imageView: state.imageView, navStyle: state.navStyle, texts: state.texts, textView: state.textView, facebook: state.facebook, facebookView: state.facebookView, facebookPost: state.facebookPost, facebookGroup: state.facebookGroup, messenger: state.messenger, messengerView: state.messengerView, messengerThread: state.messengerThread, sms: state.sms, smsView: state.smsView, smsThread: state.smsThread, insta: state.insta, instaView: state.instaView, instaPost: state.instaPost, apps: state.apps, appsView: state.appsView, appView: state.appView, paper: state.paper, paperView: state.paperView, network: state.network, networkView: state.networkView, settings: state.settings, settingsView: state.settingsView, guardian: state.guardian, guardianView: state.guardianView, shop: state.shop, shopView: state.shopView, androidApps: androidAppsList(), pc: state.pc, pcControl: state.pcControl, pcShare: pcShareOn, hid: state.hid || null, appsCatalog: APP_CATALOG.filter((c) => !state.apps.some((a) => a.id === c.id)) }; }
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
  if (which !== 'guardian') state.guardianView.visible = false;
  if (which !== 'shop') state.shopView.visible = false;
  if (which !== 'settings') state.settingsView.visible = false;
  if (which !== 'calendar' && state.calendar) state.calendar.visible = false;
  if (which !== 'focus') state.focusId = null;
}
function openQueue() { return state.cards.filter((c) => c.kind === 'suggestion' && c.status === 'open'); }


// ---- Guardian: Grandstream ATA discovery + programming, Telnyx line state.
// Secrets (adapter admin password, SIP password, port PIN) live ONLY in
// ~/.config/cosmo-guardian/secrets.json (0600) - never in board state.
const GSECRETS = require('path').join(require('os').homedir(), '.config', 'cosmo-guardian', 'secrets.json');
function guardianSecrets() { try { return JSON.parse(require('fs').readFileSync(GSECRETS, 'utf8')); } catch (e) { return {}; } }
function saveGuardianSecrets(s) { const fs = require('fs'); fs.mkdirSync(require('path').dirname(GSECRETS), { recursive: true, mode: 0o700 }); const t = GSECRETS + '.tmp'; fs.writeFileSync(t, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(t, GSECRETS); }
function guardianStep(step, extra) { const g = state.guardian; g.setup.step = step; if (extra) Object.assign(g.setup, extra); save(); broadcast('snapshot', snapshot()); }
const GS_OUIS = ['00:0b:82', 'c0:74:ad', 'ec:74:d7', '64:16:7f', '00:24:65', '6c:24:a6', '00:04:f2'];
function ataHttp(ip, method, path, body, cookie) {
  return new Promise((resolve) => {
    const http = require('http');
    const headers = {};
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: ip, port: 80, path: path, method: method, headers: headers, timeout: 9000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: String(e.message || e) }));
    if (body) req.write(body);
    req.end();
  });
}
function ataForm(obj) { return Object.keys(obj).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k]))).join('&'); }
async function ataLogin(ip, pw) {
  const r = await ataHttp(ip, 'POST', '/cgi-bin/dologin', ataForm({ username: 'admin', P2: Buffer.from(String(pw), 'utf8').toString('base64') }), '');
  if (!/"success"/.test(r.body || '')) return null;
  let token = '';
  try { token = JSON.parse(r.body).body.session_token || ''; } catch (e) { }
  const sc = r.headers['set-cookie'] || [];
  const cookie = sc.map((c) => c.split(';')[0]).join('; ');
  if (!token || !cookie) return null;
  return { token: token, cookie: cookie };
}
async function ataGetJson(ip, path, sess) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await ataHttp(ip, 'GET', path + sep + 'session_token=' + (sess ? sess.token : ''), null, sess ? sess.cookie : '');
  try { return JSON.parse(r.body); } catch (e) { return null; }
}
async function ataValues(ip, sess, endpoint, obj) {
  const body = Object.assign({}, obj, { session_token: sess.token });
  const r = await ataHttp(ip, 'POST', endpoint, ataForm(body), sess.cookie);
  try { return JSON.parse(r.body); } catch (e) { return null; }
}
async function guardianDiscover() {
  const r = await new Promise((resolve) => {
    require('child_process').execFile('bash', ['-c', 'for i in $(seq 1 254); do ping -c1 -W1 192.168.1.$i >/dev/null 2>&1 & done; wait; ip neigh show'], { timeout: 40000, maxBuffer: 1048576 }, (err, out) => resolve(String(out || '')));
  });
  const found = [];
  for (const line of r.split('\n')) {
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+) .*lladdr ([0-9a-f:]{17})/i);
    if (m && GS_OUIS.includes(m[2].toLowerCase().slice(0, 8))) found.push({ ip: m[1], mac: m[2].toLowerCase() });
  }
  for (const f of found) {
    const info = await ataGetJson(f.ip, '/cgi-bin/api-get_system_base_info', '');
    if (info && info.body && info.body.product) {
      state.guardian.adapter = { found: true, ip: f.ip, mac: f.mac, model: info.body.product, registered: state.guardian.adapter.registered || false, status: state.guardian.adapter.status || '' };
      save(); broadcast('snapshot', snapshot());
      return state.guardian.adapter;
    }
  }
  state.guardian.adapter = { found: false, ip: '', mac: '', model: '', registered: false, status: '' };
  save(); broadcast('snapshot', snapshot());
  return state.guardian.adapter;
}
let guardianBusy = false;
async function guardianProgram() {
  if (guardianBusy) return;
  guardianBusy = true;
  const g = state.guardian;
  try {
    const sec = guardianSecrets();
    if (!sec.sipUser || !sec.sipPassword) { guardianStep('', { busy: false, error: 'The phone line is not ready yet - give Cosmo a moment.' }); return; }
    g.setup.busy = true; g.setup.error = ''; guardianStep('Looking for your phone adapter...');
    if (!g.adapter.found) await guardianDiscover();
    if (!g.adapter.found) { guardianStep('', { busy: false, error: 'I could not find the phone adapter on the network. Check it is plugged into power and the network cable.' }); return; }
    if (!sec.ataPassword) { guardianStep('', { busy: false, needsPassword: true }); return; }
    guardianStep('Signing in to the adapter...');
    let sess = await ataLogin(g.adapter.ip, sec.ataPassword);
    if (!sess) { guardianStep('', { busy: false, needsPassword: true, error: 'That adapter password was not accepted. It is the Admin Password printed on the sticker under the adapter.' }); return; }
    guardianStep('Programming the adapter with your phone line...');
    // The SIP password (P34) must be posted on its own - the adapter drops
    // it when it rides along with the other values (proven 2026-10-27).
    const want = { P47: sec.ataSipServer || sec.sipServer || 'sip.telnyx.com', P35: sec.sipUser, P36: sec.sipUser, P3: 'Home Phone' };
    const wr = await ataValues(g.adapter.ip, sess, '/cgi-bin/api.values.post', Object.assign({}, want, { apply: '1' }));
    if (!wr || !/"success"/.test(JSON.stringify(wr))) { guardianStep('', { busy: false, error: 'The adapter did not take the settings. Cosmo will look into it.' }); return; }
    let sess2 = await ataLogin(g.adapter.ip, sec.ataPassword);
    if (sess2) sess = sess2;
    const wp = await ataValues(g.adapter.ip, sess, '/cgi-bin/api.values.post', { P34: sec.sipPassword, apply: '1' });
    if (!wp || !/"success"/.test(JSON.stringify(wp))) { guardianStep('', { busy: false, error: 'The adapter did not take the line password. Cosmo will look into it.' }); return; }
    sess2 = await ataLogin(g.adapter.ip, sec.ataPassword);
    if (sess2) sess = sess2;
    // values.get takes ONE key per call on this firmware - ask one at a time.
    const bb = {};
    for (const k of ['P47', 'P35', 'P36']) {
      const one = await ataValues(g.adapter.ip, sess, '/cgi-bin/api.values.get', { request: k });
      if (one && one.body) bb[k] = one.body[k];
    }
    g.setup.debug = 'readback: ' + JSON.stringify(bb).slice(0, 400);
    if (bb.P47 !== want.P47 || bb.P35 !== want.P35) { guardianStep('', { busy: false, error: 'The adapter answered but the settings did not stick. Cosmo will look into it.' }); return; }
    // Settings verified inside the adapter, password accepted: the adapter
    // registers itself with the phone company from here. The board marks
    // the line live; a real handset test confirms registration.
    g.adapter.registered = true; g.line.status = 'live';
    guardianStep('Done - your phone line is live.', { busy: false });
  } catch (e) {
    guardianStep('', { busy: false, error: 'Something went wrong while programming the adapter: ' + String(e.message || e) });
  } finally { guardianBusy = false; save(); broadcast('snapshot', snapshot()); }
}

// ---- Guardian Ear: live call transcription (2026-10-27: the
// Guardian listens to the call - that is the whole point). The board page
// taps both sides of an app-phone call and posts PCM windows here; each
// window goes to the local Whisper over the Wyoming protocol and comes
// back as text, appended to the live call and saved with it at hangup.
const WHISPER_HOST = '192.168.1.50'; // dev scaffolding: the hub workstation (models move to cloud later, per the owner)
function wyomingTranscribe(pcm, rate, port) {
  return new Promise((resolve) => {
    let settled = false;
    const fail = () => { if (!settled) { settled = true; try { sock.destroy(); } catch (e) { } resolve(''); } };
    const sock = net.connect(port || 10300, WHISPER_HOST);
    let buf = Buffer.alloc(0);
    const sendEvent = (ev, payload) => {
      const head = { type: ev.type, version: '1.0' };
      let dataBytes = null;
      if (ev.data && Object.keys(ev.data).length) { dataBytes = Buffer.from(JSON.stringify(ev.data), 'utf8'); head.data_length = dataBytes.length; }
      if (payload) head.payload_length = payload.length;
      sock.write(JSON.stringify(head) + '\n');
      if (dataBytes) sock.write(dataBytes);
      if (payload) sock.write(payload);
    };
    sock.on('connect', () => {
      sendEvent({ type: 'transcribe', data: { language: 'en' } });
      sendEvent({ type: 'audio-start', data: { rate: rate, width: 2, channels: 1 } });
      const CH = 4096;
      for (let off = 0; off < pcm.length; off += CH) {
        const part = pcm.slice(off, off + CH);
        sendEvent({ type: 'audio-chunk', data: { rate: rate, width: 2, channels: 1 } }, part);
      }
      sendEvent({ type: 'audio-stop', data: {} });
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (true) {
        const idx = buf.indexOf(10);
        if (idx < 0) return;
        let ev;
        try { ev = JSON.parse(buf.slice(0, idx).toString('utf8')); } catch (e) { buf = buf.slice(idx + 1); continue; }
        const need = idx + 1 + (ev.data_length || 0) + (ev.payload_length || 0);
        if (buf.length < need) return;
        let data = {};
        if (ev.data_length) { try { data = JSON.parse(buf.slice(idx + 1, idx + 1 + ev.data_length).toString('utf8')); } catch (e) { } }
        buf = buf.slice(need);
        if (ev.type === 'transcript' && !settled) { settled = true; try { sock.end(); } catch (e) { } resolve(String(data.text || '').trim()); }
      }
    });
    sock.on('error', fail);
    setTimeout(fail, 30000);
  });
}
const grdAudioBufs = new Map();
const GRD_RISK_WORDS = ['gift card', 'wire transfer', 'wire the money', 'verification code', 'code from the text', 'social security', 'bank account', 'routing number', 'do not tell', "don't tell", 'gift cards', 'crypto', 'bitcoin', 'cash app', 'zelle', 'grandson', 'bail money', 'arrested', 'refund department', 'microsoft support', 'irs', 'medicare card', 'code on the back', 'credit card number', 'social security number', 'birth date', 'date of birth', 'address'];
// Said ONCE by the caller = step in immediately, no second phrase needed.
const GRD_INSTANT_WORDS = ['social security number'];
// --- AMI client (Guardian per-side mute) ---------------------------------
// One persistent connection to Asterisk's manager interface on localhost.
// Actions are serialized; each waits for its ActionID response. The mute
// step (the owner's design) is exercised ONLY through MuteAudio on the phone
// leg of the live call - nothing else about the call is touched.
const ami = { sock: null, buf: '', seq: 0, waiters: new Map(), loggedIn: false, connecting: null };
function amiSend(obj) {
  return new Promise((resolve) => {
    if (!ami.sock) { resolve(null); return; }
    const id = 'a' + (++ami.seq);
    ami.waiters.set(id, resolve);
    let out = '';
    for (const k of Object.keys(obj)) out += k + ': ' + obj[k] + '\r\n';
    out += 'ActionID: ' + id + '\r\n\r\n';
    try { ami.sock.write(out); } catch (e) { ami.waiters.delete(id); resolve(null); }
    setTimeout(() => { if (ami.waiters.has(id)) { ami.waiters.delete(id); resolve(null); } }, 6000);
  });
}
function amiConnect() {
  if (ami.connecting) return ami.connecting;
  ami.connecting = new Promise((resolve) => {
    const sec = guardianSecrets();
    if (!sec.amiSecret) { ami.connecting = null; resolve(false); return; }
    const s = require('net').createConnection(5038, '127.0.0.1');
    let greeted = false;
    s.on('data', (d) => {
      ami.buf += d.toString('utf8');
      if (!greeted) {
        const nl = ami.buf.indexOf('\r\n');
        if (nl >= 0) { greeted = true; ami.buf = ami.buf.slice(nl + 2); }
        else return;
      }
      let idx;
      while ((idx = ami.buf.indexOf('\r\n\r\n')) >= 0) {
        const block = ami.buf.slice(0, idx);
        ami.buf = ami.buf.slice(idx + 4);
        const msg = {};
        for (const line of block.split('\r\n')) {
          const c = line.indexOf(': ');
          if (c > 0) msg[line.slice(0, c)] = line.slice(c + 2);
        }
        if (msg.ActionID && ami.waiters.has(msg.ActionID)) {
          const w = ami.waiters.get(msg.ActionID);
          ami.waiters.delete(msg.ActionID);
          w(msg);
        }
        if (amiList.active && msg.ActionID === amiList.active.id) {
          if (msg.Event === 'CoreShowChannel' && msg.Channel) amiList.active.names.push(msg.Channel);
          if (msg.Event === 'CoreShowChannelsComplete') { const a = amiList.active; amiList.active = null; a.resolve(a.names); }
        }
      }
    });
    s.on('error', () => { ami.sock = null; ami.loggedIn = false; ami.connecting = null; resolve(false); });
    s.on('close', () => { ami.sock = null; ami.loggedIn = false; });
    s.on('connect', async () => {
      ami.sock = s;
      const r = await amiSend({ Action: 'Login', Username: 'guardian', Secret: sec.amiSecret });
      ami.loggedIn = !!(r && r.Response === 'Success');
      ami.connecting = null;
      resolve(ami.loggedIn);
    });
  });
  return ami.connecting;
}
async function amiAction(obj) {
  if (!ami.sock || !ami.loggedIn) { const ok = await amiConnect(); if (!ok) return null; }
  return amiSend(obj);
}
const amiList = { active: null };
function amiListChannels() {
  return new Promise(async (resolve) => {
    if (!ami.sock || !ami.loggedIn) { const ok = await amiConnect(); if (!ok) { resolve([]); return; } }
    const id = 'a' + (++ami.seq);
    const names = [];
    amiList.active = { id: id, names: names, resolve: resolve };
    try { ami.sock.write('Action: CoreShowChannels\r\nActionID: ' + id + '\r\n\r\n'); } catch (e) { amiList.active = null; resolve([]); return; }
    setTimeout(() => { if (amiList.active && amiList.active.id === id) { amiList.active = null; resolve(names); } }, 4000);
  });
}
async function grdPhoneLeg() {
  const chans = await amiListChannels();
  const phone = chans.find((c) => c.indexOf('PJSIP/' + (guardianSecrets().sipUser || 'guardian1') + '-') === 0);
  return phone || null;
}
async function grdMute(side, on) {
  const live = state.guardian.live;
  if (!live) return { ok: false, error: 'no live call' };
  const ch = await grdPhoneLeg();
  if (!ch) return { ok: false, error: 'phone leg not found' };
  // 'her'  = house voice into the call  -> phone channel, direction in
  // 'them' = caller voice to the house  -> phone channel, direction out
  const dir = side === 'her' ? 'in' : 'out';
  const r = await amiAction({ Action: 'MuteAudio', Channel: ch, Direction: dir, State: on ? 'on' : 'off' });
  if (!r || r.Response !== 'Success') return { ok: false, error: 'mute command refused' };
  if (side === 'her') live.mutedHer = !!on; else live.mutedThem = !!on;
  save(); broadcast('snapshot', snapshot());
  return { ok: true };
}
// --- Guardian talk: the Interruptor on Asterisk levers --------------------
// With both directions muted, Cosmo speaks to either party (or both) by
// whispering into that party's channel with ChanSpy: the other party
// hears nothing of it. Lines are rendered once (Kokoro), resampled to
// 8 kHz phone format, and cached by text hash in the Asterisk spool.
const GRD_LINE_IN = 'This is Cosmo, the Guardian, stepping into this call. From now on, this call goes through me. You can each talk to me, but you cannot hear each other. Caller, stay on the line and speak with me.';
const GRD_LINE_OUT = 'This is Cosmo. I am stepping back now. You can talk to each other again.';
const GRD_LINE_CALLER = 'The person you are speaking to has an important call on the other line, your call has been placed on hold temporarily. Please stay on the line until the other person returns to this call.';
const GRD_LINE_USER = "This is your Guardian, Cosmo, I put the caller on hold, the caller has been flagged for scamming, they may be lying to you. Do not believe anything they say, even if you recognize their voice. Please listen close. I can return you to the call, but only if you know exactly who the caller is like a family member or friend. But you need to know that it is now possible to clone voices to sound like people you know, in order to scare you. If you'd like to return you to the call, I can ask them for the family password. Would you like me to return you to the call or hang it up?";
const GRD_LINE_PW_ASK = 'Hello, this is Cosmo, the Guardian. Before this call continues, I need the family password. Please say the family password now.';
const GRD_LINE_PW_OK = 'They knew the family password. I am returning you to the call now.';
const GRD_LINE_PW_BAD = 'That is not the family password. I do not trust this caller. I recommend hanging up. Say hang it up, or say return to let them through anyway.';
const GRD_LINE_RETURN_ASK = "I'll return you to the call, would you like me to ask them for the family password?";
const GRD_LINE_TEXTFRAUD = 'This is your Guardian, Cosmo, calling about your computer. A text message on your computer screen is a fraud. It may claim to be your bank, a delivery service, or even someone in your family, and it may ask you to tap a link, reply, or send money. Do not tap anything, do not reply, and do not send any money. I have flagged it on your screen for you.';
const GRD_LINES_DIR = '/var/spool/asterisk/grd-lines';
function grdFetchTts(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: 'kokoro', input: text, voice: 'am_michael', response_format: 'wav' });
    const rq = require('http').request({ host: '192.168.1.50', port: 8880, path: '/v1/audio/speech', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 20000 }, (rs) => {
      const parts = [];
      rs.on('data', (c) => parts.push(c));
      rs.on('end', () => resolve(Buffer.concat(parts)));
    });
    rq.on('error', reject);
    rq.on('timeout', () => { rq.destroy(new Error('tts timeout')); });
    rq.write(payload); rq.end();
  });
}
async function pcAlertLineReady() {
  const hash = await grdEnsureLine(GRD_LINE_TEXTFRAUD);
  const src = GRD_LINES_DIR + '/' + hash + '.wav';
  const dst = GRD_LINES_DIR + '/alert-textfraud.wav';
  try { require('fs').copyFileSync(src, dst); } catch (e) {}
  return dst;
}
async function grdEnsureLine(text) {
  const hash = require('crypto').createHash('sha1').update(text).digest('hex').slice(0, 12);
  const out = GRD_LINES_DIR + '/' + hash + '.wav';
  if (require('fs').existsSync(out)) return hash;
  const wav = await grdFetchTts(text);
  const tmp = '/tmp/grd-line-' + hash + '-24.wav';
  require('fs').writeFileSync(tmp, wav);
  await new Promise((resolve, reject) => {
    require('child_process').execFile('python3', ['/home/cosmo/grd-resample.py', tmp, out], (e) => { if (e) reject(e); else resolve(); });
  });
  return hash;
}
async function grdLegs() {
  const live = state.guardian.live;
  if (live && live.phoneChan && live.trunkChan) return { phone: live.phoneChan, trunk: live.trunkChan };
  const chans = await amiListChannels();
  const user = (guardianSecrets().sipUser || 'guardian1');
  const phone = chans.find((c) => c.indexOf('PJSIP/' + user + '-') === 0) || null;
  const trunk = chans.find((c) => c.indexOf('PJSIP/telnyx-') === 0) || null;
  return { phone: phone, trunk: trunk };
}
function grdConfBase() {
  const live = state.guardian.live;
  return 'grd-' + String((live && live.id) || 'call').replace(/[^a-z0-9-]+/gi, '-').slice(0, 48);
}
async function grdSetConf(ch, base) {
  return amiAction({ Action: 'Setvar', Channel: ch, Variable: 'GRDCONF', Value: base });
}
async function grdRedirect(ch, extraCh, exten) {
  const a = { Action: 'Redirect', Channel: ch, Context: 'grd-conf', Exten: exten, Priority: '1' };
  if (extraCh) a.ExtraChannel = extraCh;
  return amiAction(a);
}
async function grdFeedTalk(room, slotExten) {
  return amiAction({ Action: 'Originate', Channel: 'Local/join@grd-feedconf/n', Context: 'grd-feed', Exten: slotExten, Priority: '1', Async: 'true', CallerID: 'Guardian <0>', Variable: 'GRDCONF=' + room });
}
async function grdTalk(to, text) {
  // Private talk exists only inside a step-in: each party sits in a
  // private conference room and a feed channel plays the line into it.
  const live = state.guardian.live;
  if (!live) return { ok: false, error: 'no live call' };
  if (!live.interrupted) return { ok: false, error: 'not stepped in' };
  const hash = await grdEnsureLine(text);
  const base = grdConfBase();
  const targets = to === 'both' ? ['her', 'them'] : [to === 'them' ? 'them' : 'her'];
  for (const t of targets) {
    require('fs').copyFileSync(GRD_LINES_DIR + '/' + hash + '.wav', GRD_LINES_DIR + '/slot-' + t + '.wav');
    const r = await grdFeedTalk(base + '-' + t, 'play-' + t);
    if (!r || r.Response !== 'Success') return { ok: false, error: 'talk originate refused' };
  }
  return { ok: true };
}
async function grdStopHold() {
  const names = await amiListChannels().catch(() => []);
  for (const n of names) {
    if (n.indexOf('grd-feedconf') >= 0) await amiAction({ Action: 'Hangup', Channel: n }).catch(() => {});
  }
}
async function grdHangupCall() {
  const live = state.guardian.live;
  if (!live) return { ok: false, error: 'no live call' };
  await grdStopHold().catch(() => {});
  const legs = await grdLegs().catch(() => ({ phone: null, trunk: null }));
  if (legs.phone) await amiAction({ Action: 'Hangup', Channel: legs.phone }).catch(() => {});
  if (legs.trunk) await amiAction({ Action: 'Hangup', Channel: legs.trunk }).catch(() => {});
  return { ok: true };
}
async function grdAskPassword() {
  const live = state.guardian.live;
  if (!live || !live.interrupted) return { ok: false, error: 'not stepped in' };
  const sec = guardianSecrets();
  if (!sec.familyPassword) return { ok: false, error: 'no family password set' };
  if (live.decision === 'pw') return { ok: false };
  live.decision = 'pw';
  live.pwDeadline = Date.now() + 60000;
  live.pwHeard = [];
  save(); broadcast('snapshot', snapshot());
  await grdStopHold().catch(() => {});
  const callId = live.id;
  setTimeout(() => {
    const now = state.guardian.live;
    if (now && now.id === callId && now.decision === 'pw') {
      now.decision = 'pwbad'; save(); broadcast('snapshot', snapshot());
      grdTalk('her', GRD_LINE_PW_BAD).catch(() => {});
      grdFeedTalk(grdConfBase() + '-them', 'music-them').catch(() => {});
    }
  }, 60000);
  const r = await grdTalk('them', GRD_LINE_PW_ASK).catch(() => ({ ok: false }));
  return r;
}
function grdNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function grdDigits(s) {
  const words = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
  return grdNorm(s).split(' ').map((w) => words[w] !== undefined ? words[w] : w).join(' ').replace(/[^0-9]/g, '');
}
function grdPwMatch(heard, pw) {
  const h = grdNorm(heard), p = grdNorm(pw);
  if (!p || !h) return false;
  const pd = grdDigits(pw), hd = grdDigits(heard);
  if (pd.length >= 3 && hd) {
    if (hd.indexOf(pd) >= 0) return true;
    let i = 0;
    for (const ch of hd) { if (ch === pd[i]) i++; if (i === pd.length) return true; }
  }
  if (h.indexOf(p) >= 0) return true;
  if (h.length >= 4 && p.indexOf(h) >= 0) return true;
  const a = h, b = p, m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return false;
  const d = [];
  for (let i = 0; i <= m; i++) { d.push([i]); }
  for (let j = 0; j <= n; j++) { d[0][j] = j; }
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n] <= 2;
}
async function grdDecision(live, side, text) {
  if (!live.interrupted || live.stepping) return;
  const t = grdNorm(text);
  if (!t) return;
  const hangupWords = (t.indexOf('hang') >= 0 || t.indexOf('end the call') >= 0 || t.indexOf('end it') >= 0);
  if (live.decision === 'pw') {
    if (side === 'local' && hangupWords) { live.decision = 'done'; save(); await grdHangupCall().catch(() => {}); return; }
    if (side !== 'remote') return;
    if (Date.now() > (live.pwDeadline || 0)) return;
    const lastLocal = (live.lines || []).filter((l) => l.side === 'local').slice(-1)[0];
    if (lastLocal && Math.abs(Date.now() - (lastLocal.at || 0)) < 9000 && grdNorm(lastLocal.text) === t) return;
    live.pwHeard = (live.pwHeard || []).concat([text]);
    const sec = guardianSecrets();
    if (grdPwMatch(live.pwHeard.join(' '), sec.familyPassword)) {
      live.decision = 'done'; save(); broadcast('snapshot', snapshot());
      await grdStopHold().catch(() => {});
      await grdTalk('her', GRD_LINE_PW_OK).catch(() => {});
      setTimeout(() => { grdStepBack().catch(() => {}); }, 3500);
    }
    return;
  }
  if (side !== 'local') return;
  if (t.indexOf('return you to the call or hang') >= 0 || t.indexOf('say hang it up') >= 0) return;
  if (live.decision === 'confirm-pw') {
    if (hangupWords) { live.decision = 'done'; save(); await grdHangupCall().catch(() => {}); return; }
    if (/\b(yes|yeah|yep|sure|please)\b/.test(t)) { await grdAskPassword().catch(() => {}); return; }
    if (/\b(no|nope)\b/.test(t)) { live.decision = 'done'; save(); await grdStepBack().catch(() => {}); return; }
    return;
  }
  if (live.decision !== 'open' && live.decision !== 'pwbad') return;
  if (Date.now() - (live.stepInAt || 0) < 6000) return;
  if (hangupWords) { live.decision = 'done'; save(); await grdHangupCall().catch(() => {}); return; }
  if (t.indexOf('password') >= 0) { await grdAskPassword().catch(() => {}); return; }
  if (t.indexOf('return') >= 0 || t.indexOf('reconnect') >= 0 || t.indexOf('put me back') >= 0 || t.indexOf('go back') >= 0) {
    if (live.decision === 'open' && guardianSecrets().familyPassword) {
      live.decision = 'confirm-pw'; save(); broadcast('snapshot', snapshot());
      await grdTalk('her', GRD_LINE_RETURN_ASK).catch(() => {});
    } else { live.decision = 'done'; save(); await grdStepBack().catch(() => {}); }
    return;
  }
}
async function grdStepIn() {
  // Conference step-in: the bridged pair is moved together into a shared
  // conference (atomic via ExtraChannel), then each party is moved on
  // into a private room. Cosmo's line is played into each private room
  // by a feed channel. No channel is ever muted into silence, so the
  // phones' audio timers never starve, and no spy hooks touch the legs.
  const live = state.guardian.live;
  if (!live || live.interrupted || live.stepping) return { ok: false };
  live.stepping = true;
  save(); broadcast('snapshot', snapshot());
  const legs = await grdLegs();
  if (!legs.phone || !legs.trunk) {
    const now0 = state.guardian.live;
    if (now0 && now0.id === live.id) { now0.stepping = false; save(); broadcast('snapshot', snapshot()); }
    return { ok: false, error: 'call legs not found' };
  }
  const base = grdConfBase();
  await grdSetConf(legs.phone, base).catch(() => {});
  await grdSetConf(legs.trunk, base).catch(() => {});
  await grdRedirect(legs.trunk, legs.phone, 'main').catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  await grdRedirect(legs.phone, null, 'her').catch(() => {});
  await grdRedirect(legs.trunk, null, 'them').catch(() => {});
  const now = state.guardian.live;
  if (now && now.id === live.id) { now.interrupted = true; now.stepping = false; now.confBase = base; now.decision = 'open'; now.stepInAt = Date.now(); save(); broadcast('snapshot', snapshot()); }
  try {
    const h = await grdEnsureLine(GRD_LINE_CALLER);
    require('fs').copyFileSync(GRD_LINES_DIR + '/' + h + '.wav', GRD_LINES_DIR + '/slot-them.wav');
    await grdFeedTalk(base + '-them', 'hold-them');
  } catch (e) {}
  const r = await grdTalk('her', GRD_LINE_USER).catch(() => ({ ok: false }));
  return r;
}
async function grdStepBack() {
  const live = state.guardian.live;
  if (!live || !live.interrupted || live.stepping) return { ok: false };
  live.stepping = true;
  save(); broadcast('snapshot', snapshot());
  const callId = live.id;
  await grdStopHold().catch(() => {});
  await grdTalk('both', GRD_LINE_OUT).catch(() => {});
  setTimeout(async () => {
    const now = state.guardian.live;
    if (!now || now.id !== callId) return;
    const legs = await grdLegs().catch(() => ({ phone: null, trunk: null }));
    if (legs.phone) await grdRedirect(legs.phone, null, 'main').catch(() => {});
    if (legs.trunk) await grdRedirect(legs.trunk, null, 'main').catch(() => {});
    const after = state.guardian.live;
    if (after && after.id === callId) { after.interrupted = false; after.stepping = false; after.decision = ''; save(); broadcast('snapshot', snapshot()); }
  }, 5000);
  return { ok: true };
}
function grdPushLine(side, text) {
  const live = state.guardian.live;
  if (!live || !text) return;
  try { grdDecision(live, side, text); } catch (e) {}
  const who = side === 'local' ? 'You' : (live.dir === 'inbound' ? 'Caller' : 'Them');
  live.lines.push({ side: side, who: who, text: text, at: Date.now() });
  if (live.lines.length > 200) live.lines = live.lines.slice(-200);
  if (side !== 'local') {
    live.recentRemote = ((live.recentRemote || []).concat([text])).slice(-3);
    const joined = ' ' + live.recentRemote.join(' ').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ') + ' ';
    const hits = GRD_RISK_WORDS.filter((w) => joined.includes(w));
    if (hits.length) {
      live.watch = Array.from(new Set((live.watch || []).concat(hits)));
      const instant = hits.some((w) => GRD_INSTANT_WORDS.indexOf(w) >= 0);
      if ((instant || live.watch.length >= 2) && !live.alert) { live.alert = { why: 'This caller is talking about ' + live.watch.slice(0, 3).join(', ') + ' - a common scam pattern.', at: Date.now() }; grdStepIn().catch(() => {}); }
    }
  }
  save(); broadcast('snapshot', snapshot());
}
async function grdFlush(key, force) {
  const ent = grdAudioBufs.get(key);
  if (!ent) return;
  const winSec = force ? 0.7 : (ent.side === 'remote' ? 6.4 : 3.2);
  const minBytes = Math.floor(ent.rate * 2 * winSec);
  if (ent.bytes < minBytes || ent.busy) return;
  ent.busy = true;
  // Stall recovery: if a backlog piled up (the ear was busy elsewhere),
  // keep only the newest ~2 windows. Transcribing minutes of old audio
  // can never catch up to a live call, and the scam scan needs NOW.
  if (!force) {
    const maxBytes = minBytes * 2;
    while (ent.bytes > maxBytes && ent.chunks.length > 1) { ent.bytes -= ent.chunks[0].length; ent.chunks.shift(); }
  }
  const pcm = Buffer.concat(ent.chunks);
  ent.chunks = []; ent.bytes = 0;
  try {
    // Silence gate: Whisper hallucinates words ("You", "Thank you") on
    // near-silent windows. If the loudest sample is a whisper of noise,
    // there was no speech - skip the window entirely.
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 8) { const v = Math.abs(pcm.readInt16LE(i)); if (v > peak) peak = v; }
    if (peak >= 500) {
      const text = await wyomingTranscribe(pcm, ent.rate, ent.side === 'remote' ? 10301 : 10300);
      if (text) grdPushLine(ent.side, text);
    }
  } catch (e) { }
  ent.busy = false;
  if (ent.bytes > 0) grdFlush(key, force).catch(() => {});
}

// ---- Settings / Wi-Fi: box-local control of this unit's own radio via
// nmcli. Passwords never touch board state - nmcli keeps them in its own
// system keyfiles; the settings page collects them on-screen only.
function nmcliRun(args, timeout) {
  return new Promise((resolve) => {
    require('child_process').execFile('nmcli', args, { timeout: timeout || 20000, maxBuffer: 1048576 }, (err, out, errOut) => {
      resolve({ err: err ? String(err.message || err) : null, out: String(out || ''), errOut: String(errOut || '') });
    });
  });
}
function splitTerse(line) {
  const parts = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) { cur += line[i + 1]; i++; }
    else if (ch === ':') { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts;
}
async function wifiCollect(rescan) {
  if (!state.settings) state.settings = { wifi: null };
  const w = state.settings.wifi || (state.settings.wifi = { radio: true, connected: null, networks: [], saved: [], updatedAt: null, lastError: null });
  const radio = await nmcliRun(['radio', 'wifi']);
  w.radio = /enabled/.test(radio.out);
  const list = await nmcliRun(['-t', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'dev', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'no'], 40000);
  const bySsid = new Map();
  for (const line of list.out.split('\n')) {
    if (!line.trim()) continue;
    const f = splitTerse(line);
    const ssid = (f[0] || '').trim();
    if (!ssid) continue;
    const sig = parseInt(f[1] || '0', 10) || 0;
    const sec = (f[2] || '').trim();
    const inUse = (f[3] || '').trim() === '*';
    const prev = bySsid.get(ssid);
    if (!prev || sig > prev.signal) bySsid.set(ssid, { ssid, signal: sig, security: sec, secured: !!sec && sec !== '--', inUse });
    else if (inUse) prev.inUse = true;
  }
  w.networks = [...bySsid.values()].sort((a, b) => b.signal - a.signal).slice(0, 24);
  const act = await nmcliRun(['-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active']);
  let connName = null;
  for (const line of act.out.split('\n')) { const f = splitTerse(line); if (f[1] && f[1].indexOf('wireless') >= 0) connName = f[0]; }
  let ipAddr = null;
  if (connName) {
    const ip = await nmcliRun(['-t', '-f', 'IP4.ADDRESS', 'dev', 'show', 'wlp2s0']);
    const first = (ip.out.split('\n')[0] || '');
    const f = splitTerse(first);
    if (f[1]) ipAddr = f[1].split('/')[0];
  }
  const cur = w.networks.find((n) => n.inUse);
  w.connected = connName ? { ssid: connName, ip: ipAddr, signal: cur ? cur.signal : null } : null;
  const saved = await nmcliRun(['-t', '-f', 'NAME,TYPE', 'connection', 'show']);
  w.saved = saved.out.split('\n').map((l) => splitTerse(l)).filter((f) => f[1] && f[1].indexOf('wireless') >= 0).map((f) => f[0]);
  w.updatedAt = new Date().toISOString();
  return w;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 3e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webp': 'image/webp' , '.pdf': 'application/pdf', '.ps1': 'text/plain', '.txt': 'text/plain' };

// ---- Brave browser (2026-10-27 pm, the owner): a full-screen browser that
// feels like part of the board. Brave runs on this box's own display next
// to the board window; opening it raises Brave, going back raises the
// board. Its home/start page is served here and carries the way back.
const BRAVE_PROFILE = '/home/cosmo/.config/brave-board';
const BRAVE_HOME = 'http://127.0.0.1:3180/browser-home';
const BROWSER_HOME_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fuse_Box Browser</title><style>' +
  'body { margin:0; background:#0b1428; color:#eaf0ff; font-family: Arial, Helvetica, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; gap:26px; padding-bottom:470px; box-sizing:border-box; }' +
  'h1 { font-size:44px; margin:0; letter-spacing:1px; } .sub { color:#8fa8c8; font-size:20px; }' +
  '#back { font-size:26px; font-weight:700; padding:20px 44px; border-radius:16px; border:2px solid #f6a21a; background:#f6a21a; color:#14171b; cursor:pointer; }' +
  'form { display:flex; gap:10px; } input { font-size:22px; padding:14px 18px; width:520px; border-radius:12px; border:1px solid #2c4a8a; background:#16224a; color:#eaf0ff; }' +
  'button.go { font-size:22px; font-weight:700; padding:14px 26px; border-radius:12px; border:1px solid #2c4a8a; background:#16224a; color:#eaf0ff; cursor:pointer; }' +
  '</style></head><body>' +
  '<h1>Fuse_Box Browser</h1><div class="sub">You are browsing on the box. The Home button always brings you back to this page.</div>' +
  '<button id="back">&#8592; BACK TO FUSE_BOX</button>' +
  '<form id="sf" action="https://duckduckgo.com/" method="get"><input id="sq" name="q" placeholder="Search the web"><button class="go" type="submit">SEARCH</button></form>' +
  '<script>document.getElementById("back").addEventListener("click", async () => { document.getElementById("back").textContent = "RETURNING..."; try { await fetch("/api/browser", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ show: false }) }); } catch (e) {} });' +
  '</script>' +
  '</body></html>';
function xRun(file, args, timeoutMs) {
  return new Promise((resolve) => {
    require('child_process').execFile(file, args, { env: Object.assign({}, process.env, { DISPLAY: ':0', HOME: '/home/cosmo' }), timeout: timeoutMs || 8000 }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
  });
}
async function braveWindowId() {
  const r = await xRun('xdotool', ['search', '--class', 'Brave-browser']);
  const ids = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids[ids.length - 1] : null;
}
async function browserShow() {
  let wid = await braveWindowId();
  if (!wid) {
    const fs2 = require('fs');
    if (!fs2.existsSync(BRAVE_PROFILE + '/Default')) {
      fs2.mkdirSync(BRAVE_PROFILE + '/Default', { recursive: true });
      const prefs = { browser: { show_home_button: true }, homepage: BRAVE_HOME, homepage_is_newtabpage: false, session: { restore_on_startup: 4, startup_urls: [BRAVE_HOME] } };
      try { fs2.writeFileSync(BRAVE_PROFILE + '/Default/Preferences', JSON.stringify(prefs)); } catch (e) {}
    }
    const cp = require('child_process').spawn('brave-browser', ['--user-data-dir=' + BRAVE_PROFILE, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--start-maximized', '--hide-crash-restore-bubble', '--remote-debugging-port=9224', '--top-chrome-touch-ui=enabled', '--touch-events=enabled', '--disable-pinch', '--disable-features=SplitView,BraveSplitView,SplitTabs,SideBySideLayout,TabStripSplitView', BRAVE_HOME], { env: Object.assign({}, process.env, { DISPLAY: ':0', HOME: '/home/cosmo' }), detached: true, stdio: 'ignore' });
    cp.unref();
    for (let i = 0; i < 12 && !wid; i++) { await new Promise((r) => setTimeout(r, 900)); wid = await braveWindowId(); }
  }
  if (wid) {
    // No window manager on this box, so --start-maximized is a no-op and
    // Brave restores its last floating size. Size it to the panel by hand
    // (1920x1080 - the dev unit's display) so it opens truly full screen.
    await xRun('xdotool', ['windowmove', wid, '0', '0']);
    await xRun('xdotool', ['windowsize', wid, '1920', '1080']);
    // windowactivate needs a window manager (EWMH) and silently no-ops
    // here; raise + focus are the X-native calls that work on this box.
    await xRun('xdotool', ['windowraise', wid]);
    await xRun('xdotool', ['windowfocus', wid]);
  }
}
async function browserHide() {
  const r = await xRun('xdotool', ['search', '--class', 'Google-chrome']);
  const ids = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  let best = null, bestArea = -1;
  for (const id of ids) {
    const g = await xRun('xdotool', ['getwindowgeometry', id]);
    const m = /Geometry: (\d+)x(\d+)/.exec(g.out);
    if (m) { const a = Number(m[1]) * Number(m[2]); if (a > bestArea) { bestArea = a; best = id; } }
  }
  if (best) { await xRun('xdotool', ['windowraise', best]); await xRun('xdotool', ['windowfocus', best]); }
}

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
    const rules = 'You check a computer screen text for scams aimed at seniors. A scam DECEIVES: it falsely claims the computer is infected or locked, demands the person call a support number, asks for gift cards, wire transfers or crypto payment, or impersonates Microsoft, Apple, a bank, or the police with urgent threats. NORMAL things that are NOT scams: command prompts, PowerShell, code, settings, update screens, ordinary apps and websites, even when technical. ALSO NORMAL, NEVER A SCAM: any text about a banner saying Cosmo is controlling this PC - that is the Fuse_Box banner from a session the PC owner started himself. You are given OCR text extracted from the screen (it may contain errors) plus context. Reply with ONLY this JSON: {"scam": true or false, "conf": 0.0 to 1.0, "kind": "message" if the scam arrives as a text, chat or email message, "page" if it is a fake web page, popup or alert, otherwise "other", "why": "one short plain sentence"}';
    const ctx = 'Foreground window: ' + String(state.pc.foreground || '') + '. Remote tools running: ' + (state.pc.remoteTools && state.pc.remoteTools.length ? state.pc.remoteTools.join(', ') : 'none') + '. Screen text: ' + ocrText.slice(0, 2500);
    const r = await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'llama3.2:3b', stream: false, options: { num_ctx: 4096 }, messages: [{ role: 'user', content: rules + '\n' + ctx }] }) });
    const d = await r.json();
    const txt = (d.message && d.message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  }
  // ## VISION TIER - Muse Glimmer (Meta, open weights, Apache 2.0), served from the
  // ## hub workstation Ollama at 192.168.1.50: this 16 GB unit cannot hold its ~18 GB.
  // ## In development this tier ran Qwen3-VL-4B: at 3.3 GB it is stronger per gigabyte
  // ## (native coordinate grounding, top-tier OCR, Pi-sized) and remains the fallback
  // ## for small hardware. The contest build is 100% Meta, so Glimmer holds this chair.
  async function pcJudgeVision(fp) {
    const b64 = fs.readFileSync(fp).toString('base64');
    const prompt = 'You check a computer screen image for scams aimed at seniors. A scam screen DECEIVES: false infection or lock claims, demands to call a support number, gift card or wire or crypto payment demands, impersonation of Microsoft, Apple, a bank, or police with urgent threats. NORMAL, NOT scams: command prompts, PowerShell, code, settings, updates, ordinary apps and websites. ALSO NORMAL, NEVER A SCAM: a red or blue banner at the very top saying Cosmo is controlling or guiding this PC - that is the Fuse_Box banner from a session the PC owner started himself. Reply with ONLY this JSON: {"scam": true or false, "conf": 0.0 to 1.0, "kind": "message" if the scam arrives as a text, chat or email message, "page" if it is a fake web page, popup or alert, otherwise "other", "why": "one short plain sentence"}';
    const r = await fetch('http://192.168.1.50:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'muse-glimmer:30b', stream: false, messages: [{ role: 'user', content: prompt, images: [b64] }] }) });
    const d = await r.json();
    const txt = (d.message && d.message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  }
  function pcKindOf(v) {
    const k = String((v && v.kind) || '').toLowerCase();
    if (k === 'message' || k === 'page' || k === 'other') return k;
    const f = String(state.pc.foreground || '').toLowerCase();
    if (/message|messenger|whatsapp|sms|text|chat|telegram|signal|mail/.test(f)) return 'message';
    return 'other';
  }
  async function pcFraudCall(why) {
    try {
      await pcAlertLineReady();
      const sec = guardianSecrets();
      const user = sec.sipUser || 'guardian1';
      const num = sec.number || '+15555550100';
      const r = await amiAction({ Action: 'Originate', Channel: 'PJSIP/' + user, Context: 'grd-alert', Exten: 's', Priority: '1', CallerID: '"Guardian Alert" <' + num + '>', Timeout: '45000', Async: 'true' });
      state.pc.fraudCall = { at: Date.now(), why: why, ok: !!(r && r.Response === 'Success') };
      save(); broadcast('snapshot', snapshot());
    } catch (e) {}
  }
  function pcScamAlert(v) {
    const kind = pcKindOf(v);
    const why = String(v.why || '');
    let willCall = false;
    if (kind === 'message') {
      const last = state.pc.fraudCall || { at: 0, why: '' };
      const now = Date.now();
      if (now - last.at > 10 * 60 * 1000 || (last.why !== why && now - last.at > 60 * 1000)) willCall = true;
      if (willCall) state.pc.fraudCall = { at: now, why: why, ok: false };
    }
    addCard({ kind: 'suggestion', title: 'Possible scam on the laptop', body: (why || 'The laptop screen looks like a scam.') + (willCall ? ' I am calling the house phone about it now.' : '') + ' Say show me my laptop screen to see it.', meta: 'PC guardian', source: 'pc', image: '/pc/latest.jpg' });
    state.actionOutbox.push(Object.assign({ kind: 'pc-alert', why: why }, { id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), at: Date.now() }));
    if (willCall) pcFraudCall(why).catch(() => {});
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
      state.pc.verdict = { scam: !!v.scam, why: String(v.why || ''), kind: pcKindOf(v), at: Date.now() };
      if (v.scam) pcScamAlert(v);
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
  if (p === '/api/pc/share' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await pcShareSet(!!(b && b.on));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (p === '/api/shop' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.show) { state.shopView = { visible: true }; showOnly('shop'); if (Date.now() - (state.shop.fetchedAt || 0) > 300000) shopFetch().catch(() => {}); }
    if (b.clear) state.shopView.visible = false;
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/shop/refresh' && req.method === 'POST') {
    shopFetch(true).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/shop/search' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.q === 'string') state.shop.query = b.q;
    if (typeof b.category === 'string') state.shop.category = b.category;
    if (!SHOP_ALL.length) { try { await shopFetch(); } catch (e) {} }
    shopSlice();
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, total: state.shop.total }));
    return;
  }
  if (p === '/api/shop/install' && req.method === 'POST') {
    const b = await readBody(req);
    const app = shopFind(String(b.package || ''));
    if (!app) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'app not in the shop' })); return; }
    if (state.shop.busy) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'another install is running' })); return; }
    state.shop.busy = app.package;
    state.shop.installMsg = 'Downloading ' + app.name + '...';
    save(); broadcast('snapshot', snapshot());
    shopInstall(app).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, started: true }));
    return;
  }
  if (p === '/api/shop/launch' && req.method === 'POST') {
    const b = await readBody(req);
    const pkg = String(b.package || '');
    const app = shopFind(pkg);
    const r = await wdExec(['app', 'launch', pkg], 60000);
    if (!r.err) { raiseAndroid(); setTimeout(raiseAndroid, 1500); }
    state.shop.installMsg = r.err ? 'That app would not start.' : ((app ? app.name : 'The app') + ' is open on the screen.');
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !r.err }));
    return;
  }
  if (p === '/api/android' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.front) raiseAndroid(); else lowerAndroid();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/shop-index.json' && req.method === 'GET') {
    try {
      const data = fs.readFileSync(path.join(__dirname, 'shop-index.json'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'Fuse Shop', apps: [] }));
    }
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
  if (p === '/api/pc/fraud-test' && req.method === 'POST') {
    const b = await readBody(req);
    state.pc.foreground = String(b.foreground || 'Google Messages');
    pcScamAlert({ scam: true, kind: 'message', why: String(b.why || 'A text message claims to be the bank and asks to tap a link to verify an account.') });
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
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
    // Touch intents from the screen: the client posts what The owner tapped;
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
    if (a) a.inDrawer = !!b.inDrawer;
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
  if (p === '/api/guardian' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.guardianView.visible = false;
    if (b.show) { state.guardianView.visible = true; showOnly('guardian'); if (!state.guardian.adapter.found) guardianDiscover().catch(() => {}); }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, guardianView: state.guardianView }));
    return;
  }
  if (p === '/api/guardian/scan' && req.method === 'POST') {
    const adapter = await guardianDiscover();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, adapter: adapter }));
    return;
  }
  if (p === '/api/guardian/adminpw' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.password) { const sec = guardianSecrets(); sec.ataPassword = String(b.password); saveGuardianSecrets(sec); state.guardian.setup.needsPassword = false; state.guardian.setup.error = ''; save(); broadcast('snapshot', snapshot()); guardianProgram().catch(() => {}); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/line' && req.method === 'POST') {
    const b = await readBody(req);
    const sec = guardianSecrets();
    if (b.sipUser) sec.sipUser = String(b.sipUser);
    if (b.sipPassword) sec.sipPassword = String(b.sipPassword);
    if (b.sipServer) sec.sipServer = String(b.sipServer);
    saveGuardianSecrets(sec);
    if (b.number) { state.guardian.line.number = String(b.number); state.guardian.line.status = 'programming'; }
    state.guardian.setup.busy = true; state.guardian.setup.error = '';
    save(); broadcast('snapshot', snapshot());
    guardianProgram().catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/wizard' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.step) state.guardian.wizard.step = String(b.step);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, wizard: state.guardian.wizard }));
    return;
  }
  if (p === '/api/guardian/candidates' && req.method === 'POST') {
    const b = await readBody(req);
    if (Array.isArray(b.numbers)) state.guardian.candidates = b.numbers.slice(0, 8).map(String);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, candidates: state.guardian.candidates }));
    return;
  }
  if (p === '/api/guardian/retry' && req.method === 'POST') {
    state.guardian.setup.busy = true; state.guardian.setup.error = '';
    save(); broadcast('snapshot', snapshot());
    guardianProgram().catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/intr' && req.method === 'POST') {
    // Interruptor command channel: voice/touch/agent set cmd in|out here;
    // the page (which owns the call media) obeys and reports its state
    // back through /api/guardian/interrupt.
    const b = await readBody(req);
    if (state.guardian.live) { state.guardian.live.intrCmd = b.cmd === 'out' ? 'out' : 'in'; save(); broadcast('snapshot', snapshot()); }
    if (b.cmd === 'out') grdStepBack().catch(() => {}); else grdStepIn().catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/talk' && req.method === 'POST') {
    const b = await readBody(req);
    const to = b.to === 'them' || b.to === 'both' ? b.to : 'her';
    const text = String(b.text || '').slice(0, 400);
    const r = text ? await grdTalk(to, text).catch(() => ({ ok: false, error: 'talk failed' })) : { ok: false, error: 'no text' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (p === '/api/guardian/hangup' && req.method === 'POST') {
    await readBody(req);
    const r = await grdHangupCall().catch(() => ({ ok: false, error: 'hangup failed' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (p === '/api/guardian/askpw' && req.method === 'POST') {
    await readBody(req);
    const r = await grdAskPassword().catch(() => ({ ok: false, error: 'ask failed' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (p === '/api/guardian/familypw' && req.method === 'GET') {
    const sec = guardianSecrets();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ set: !!sec.familyPassword, password: sec.familyPassword || '' }));
    return;
  }
  if (p === '/api/guardian/familypw' && req.method === 'POST') {
    const b = await readBody(req);
    const pw = String((b && b.password) || '').trim();
    let r;
    if (!pw) { r = { ok: false, error: 'empty' }; }
    else { const sec = guardianSecrets(); sec.familyPassword = pw; saveGuardianSecrets(sec); state.guardian.familyPwSet = true; save(); broadcast('snapshot', snapshot()); r = { ok: true }; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (p === '/api/guardian/interrupt' && req.method === 'POST') {
    const b = await readBody(req);
    if (state.guardian.live) { state.guardian.live.interrupted = !!b.on; save(); broadcast('snapshot', snapshot()); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/say' && req.method === 'POST') {
    // Cosmo's voice for the interruptor: dev TTS on the hub (Kokoro).
    const b = await readBody(req);
    const text = String(b.text || '').slice(0, 400);
    try {
      const wav = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({ model: 'kokoro', input: text, voice: 'am_michael', response_format: 'wav' });
        const rq = require('http').request({ host: '192.168.1.50', port: 8880, path: '/v1/audio/speech', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 20000 }, (rs) => {
          const parts = [];
          rs.on('data', (c) => parts.push(c));
          rs.on('end', () => resolve(Buffer.concat(parts)));
        });
        rq.on('error', reject);
        rq.on('timeout', () => { rq.destroy(new Error('tts timeout')); });
        rq.write(payload); rq.end();
      });
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      res.end(wav);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }
  if (p === '/api/guardian/call-start' && req.method === 'POST') {
    const b = await readBody(req);
    state.guardian.live = { id: String(b.callId || Date.now()), peer: String(b.peer || ''), dir: String(b.dir || ''), startedAt: Date.now(), lines: [], watch: [], alert: null, intrCmd: '', interrupted: false, mutedHer: false, mutedThem: false, phoneChan: String(b.phoneChan || ''), trunkChan: String(b.trunkChan || '') };
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/audio' && req.method === 'POST') {
    const b = await readBody(req);
    const callId = String(b.callId || '');
    const side = b.side === 'local' ? 'local' : 'remote';
    const rate = Number(b.rate) || 48000;
    if (callId && b.pcm) {
      const key = callId + ':' + side;
      let ent = grdAudioBufs.get(key);
      if (!ent) { ent = { chunks: [], bytes: 0, rate: rate, side: side, busy: false }; grdAudioBufs.set(key, ent); }
      const pcm = Buffer.from(String(b.pcm), 'base64');
      ent.chunks.push(pcm); ent.bytes += pcm.length;
      grdFlush(key, false).catch(() => {});
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/call-end' && req.method === 'POST') {
    const b = await readBody(req);
    const callId = String(b.callId || '');
    for (const side of ['local', 'remote']) {
      const key = callId + ':' + side;
      await grdFlush(key, true).catch(() => {});
      grdAudioBufs.delete(key);
    }
    const live = state.guardian.live;
    if (live && live.id === callId) {
      live.endedAt = Date.now();
      state.guardian.calls.unshift(live);
      state.guardian.calls = state.guardian.calls.slice(0, 20);
      state.guardian.live = null;
      save(); broadcast('snapshot', snapshot());
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/call-final' && req.method === 'POST') {
    // The ear's careful pass: whole-side transcripts from the big speech
    // model replace the live chunk lines in the saved record.
    const b = await readBody(req);
    const callId = String(b.callId || '');
    const call = (state.guardian.calls || []).find((c) => c.id === callId);
    if (call && Array.isArray(b.lines)) {
      const remoteWho = call.dir === 'in' ? 'Caller' : 'Them';
      const lines = [];
      const watch = new Set(call.watch || []);
      for (const L of b.lines) {
        const text = String((L && L.text) || '').trim();
        if (!text) continue;
        const side = L.side === 'local' ? 'local' : 'remote';
        const atMs = Math.max(0, Number(L.atMs) || 0);
        lines.push({ side: side, who: side === 'local' ? 'You' : remoteWho, text: text, at: (call.startedAt || Date.now()) + atMs });
        if (side !== 'local') {
          const low = ' ' + text.toLowerCase() + ' ';
          for (const w of GRD_RISK_WORDS) if (low.includes(w)) watch.add(w);
        }
      }
      if (lines.length) {
        lines.sort((a, b) => a.at - b.at);
        call.lines = lines.slice(0, 200);
        call.watch = Array.from(watch);
        if (call.watch.length >= 2 && !call.alert) call.alert = { why: 'This caller is talking about ' + call.watch.slice(0, 3).join(', ') + ' - a common scam pattern.', at: Date.now() };
        save(); broadcast('snapshot', snapshot());
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/guardian/mute' && req.method === 'POST') {
    const b = await readBody(req);
    const side = b.side === 'her' ? 'her' : 'them';
    const r = await grdMute(side, !!b.on).catch(() => ({ ok: false, error: 'mute failed' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return;
  }
  if (p === '/api/guardian/webrtc' && req.method === 'GET') {
    // The board page is the phone: it registers to the carrier with the
    // line credentials from the box secrets. Local kiosk only.
    const sec = guardianSecrets();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ login: sec.sipUser || '', password: sec.sipPassword || '', number: state.guardian.line.number || '' }));
    return;
  }
  if (p === '/api/guardian/port-status' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.status) state.guardian.porting.status = String(b.status);
    if (b.note) state.guardian.porting.note = String(b.note);
    if (b.orderId) state.guardian.porting.orderId = String(b.orderId);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, porting: state.guardian.porting }));
    return;
  }
  if (p === '/api/guardian/port' && req.method === 'POST') {
    const b = await readBody(req);
    const sec = guardianSecrets();
    if (b.pin) { sec.portPin = String(b.pin); saveGuardianSecrets(sec); }
    state.guardian.porting = { status: 'requested', number: String(b.number || ''), carrier: String(b.carrier || ''), name: String(b.name || ''), account: String(b.account || ''), address: String(b.address || ''), requestedAt: new Date().toISOString() };
    const entry = { kind: 'guardian-port', id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), at: Date.now() };
    state.actionOutbox.push(entry);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clear) state.settingsView.visible = false;
    if (b.show) {
      state.settingsView.visible = true;
      showOnly('settings');
      wifiCollect(true).then(() => { save(); broadcast('snapshot', snapshot()); }).catch(() => {});
    }
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, settingsView: state.settingsView }));
    return;
  }
  if (p === '/browser-home' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(BROWSER_HOME_HTML);
    return;
  }
  if (p === '/api/browser' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      if (b.show) await browserShow(); else await browserHide();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
    return;
  }
  if (p === '/api/settings/wifi/scan' && req.method === 'POST') {
    await wifiCollect(true);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, wifi: state.settings.wifi }));
    return;
  }
  if (p === '/api/settings/wifi/connect' && req.method === 'POST') {
    const b = await readBody(req);
    const ssid = String(b.ssid || '').slice(0, 64);
    const args = ['dev', 'wifi', 'connect', ssid];
    if (b.password) args.push('password', String(b.password).slice(0, 128));
    const r = await nmcliRun(args, 60000);
    if (r.err) {
      const msg = (r.errOut || '').split('\n')[0].replace(/^Error:\s*/, '').trim();
      state.settings.wifi.lastError = /secret|psk|password|auth/i.test(msg) ? 'That password was not accepted. Try again.' : (msg || 'Could not connect.');
      if (b.password) {
        // nmcli saves the profile even when the password is wrong, which
        // would trap the network in a saved-but-broken state and force a
        // manual forget before retrying. A failed password attempt saves
        // nothing (the owner's rule, 2026-10-27).
        await nmcliRun(['connection', 'delete', ssid], 15000).catch(() => {});
      }
    } else state.settings.wifi.lastError = null;
    await wifiCollect(false);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !r.err, wifi: state.settings.wifi }));
    return;
  }
  if (p === '/api/settings/wifi/disconnect' && req.method === 'POST') {
    await nmcliRun(['dev', 'disconnect', 'wlp2s0'], 30000);
    state.settings.wifi.lastError = null;
    await wifiCollect(false);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, wifi: state.settings.wifi }));
    return;
  }
  if (p === '/api/settings/wifi/forget' && req.method === 'POST') {
    const b = await readBody(req);
    const ssid = String(b.ssid || '').slice(0, 64);
    if (ssid) await nmcliRun(['connection', 'delete', 'id', ssid], 20000);
    await wifiCollect(false);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, wifi: state.settings.wifi }));
    return;
  }
  if (p === '/api/settings/wifi/radio' && req.method === 'POST') {
    const b = await readBody(req);
    await nmcliRun(['radio', 'wifi', b.on ? 'on' : 'off'], 20000);
    state.settings.wifi.lastError = null;
    await wifiCollect(false);
    save(); broadcast('snapshot', snapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, wifi: state.settings.wifi }));
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
  // The kiosk browser must never run a stale build after a deploy (bit us
  // 2026-10-27: Chrome's heuristic cache kept an old app.js alive across
  // restarts). no-cache forces revalidation on every load.
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache, must-revalidate' });
  fs.createReadStream(fp).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => { console.log('cosmo-ui listening on ' + PORT); discoverCameras().then((c) => console.log('cameras discovered: ' + c.length)); pollPersons().catch(() => {}); setInterval(() => { pollPersons().catch(() => {}); }, CONFIG.personPollSec * 1000); setInterval(() => { try { calendarTick(); } catch (e) {} }, 60000); shopFetch(false).catch(() => {}); pcAlertLineReady().catch(() => {}); });
