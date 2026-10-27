const $ = (id) => document.getElementById(id);
const ICONS = { email: '✉️', call: '📞', text: '💬', calendar: '📅', suggestion: '💡', system: '⚙️', person: '\u{1F464}' };
const STATE_LABEL = { idle: 'IDLE', scanning: 'SCANNING', working: 'WORKING', listening: 'LISTENING', speaking: 'SPEAKING', waiting: 'WAITING FOR YOU', playing: 'PLAYING', done: 'DONE', offline: 'OFFLINE' };

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function ago(t) {
  const m = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

let avatarState = 'idle';
let avatarMode = 'svg';
// State -> the real avatar's own activity videos (same variants the
// board uses). States without a variant keep the nearest one; CSS effects
// (rings, glow, eq bars, badge) layer on top either way.
const VARIANTS = {
  idle: 'avatar/idle.mp4', connecting: 'avatar/idle.mp4',
  listening: 'avatar/waking.mp4', speaking: 'avatar/idle.mp4',
  working: 'avatar/working.mp4', scanning: 'avatar/making.mp4',
  waiting: 'avatar/idle.mp4', playing: 'avatar/making.mp4',
  done: 'avatar/milestone.mp4', offline: 'avatar/idle.mp4'
};
function renderAvatar(a) {
  if (!a) return;
  avatarState = a.state || 'idle';
  document.body.dataset.state = avatarState;
  $('stateChip').textContent = STATE_LABEL[avatarState] || avatarState.toUpperCase();
  $('statusMsg').textContent = a.message || '';
  if (avatarMode === 'real') {
    const v = $('botVideo');
    const src = VARIANTS[avatarState] || VARIANTS.idle;
    if (v.dataset.src !== src) {
      v.dataset.src = src;
      v.src = src;
      v.play().catch(() => {});
    }
  }
}

let lastCards = [];
let lastFocusId = null;

function renderCards(cards) {
  const queue = cards.filter((c) => c.kind === 'suggestion' && c.status === 'open');
  const rest = cards.filter((c) => !(c.kind === 'suggestion' && c.status === 'open'));
  $('queueCount').textContent = queue.length;
  $('queue').innerHTML = queue.length
    ? queue.map((c, i) =>
        '<div class="qcard' + (c.id === lastFocusId ? ' focused' : '') + '"><div class="qnum">' + (i + 1) + '</div><div class="qbody"><h3>' +
        esc(c.title) + '</h3><p>' + esc(c.body) + '</p><div class="meta">' + esc(c.meta) +
        ' · ' + ago(c.time) + '</div></div></div>').join('')
    : '<div class="qempty">All clear — nothing waiting on you.</div>';
  $('stream').innerHTML = rest.slice(0, 14).map((c) => {
    const resolved = c.status === 'sent' || c.status === 'skipped' || c.status === 'held';
    const tag = resolved ? '<span class="rtag ' + c.status + '">' + c.status.toUpperCase() + '</span>' : '';
    return '<div class="scard' + (resolved ? ' resolved' : '') + '"><div class="sicon">' +
      (ICONS[c.kind] || '•') + '</div><div><h3>' + esc(c.title) + tag + '</h3><p>' + esc(c.body) +
      (c.image ? '<img class="scard-img" src="' + esc(c.image) + '">' : '') +
      '</p><div class="meta">' + esc(c.meta) + ' · ' + ago(c.time) + '</div></div></div>';
  }).join('');
}



let lastFbSig = '';
function renderFacebook(snap) {
  const ov = $('facebookOverlay');
  if (!ov) return;
  const view = snap.facebookView || { visible: false };
  ov.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;
  const fb = snap.facebook || { me: null, posts: [], groups: [], birthdays: [] };
  const detail = snap.facebookPost || null;
  const grp = snap.facebookGroup || null;
  const baseLen = grp && grp.posts ? grp.posts.length : (fb.posts || []).length;
  const sig = JSON.stringify([fb.updatedAt, view.draft, detail ? detail.id : null, grp ? grp.id : null, (fb.posts || []).length, (fb.birthdays || []).length, baseLen]);
  if (sig === lastFbSig) return;
  lastFbSig = sig;
  $('fbMe').textContent = fb.me ? fb.me.name : '';
  const pic = $('fbPic');
  if (pic) { if (fb.me && fb.me.pic) { pic.src = fb.me.pic; pic.classList.remove('hidden'); pic.onerror = () => pic.classList.add('hidden'); } else pic.classList.add('hidden'); }
  const dr = $('fbDraft');
  if (view.draft) {
    dr.classList.remove('hidden');
    const label = view.draft.kind === 'comment' ? 'DRAFT COMMENT ON POST ' + (view.draft.postN || '') + ' - SAY SEND IT' : view.draft.kind === 'birthday' ? 'BIRTHDAY WISH FOR ' + String(view.draft.person || '').toUpperCase() + ' - SAY SEND IT' : 'DRAFT POST - SAY SEND IT TO PUBLISH';
    dr.innerHTML = '<div class="fb-draft-label">' + label + '</div><p>' + esc(view.draft.text) + '</p>';
  } else { dr.classList.add('hidden'); dr.innerHTML = ''; }
  const bd = $('fbBirthdays');
  const det = $('fbDetail');
  const wrap = $('fbListWrap');
  // The rail renders on EVERY pass so its numbers always follow the one
  // page-wide sequence (main list first, then birthdays, then groups).
  if ((fb.birthdays || []).length) {
    bd.classList.remove('hidden'); $('fbBdaySec').classList.remove('hidden');
    bd.innerHTML = fb.birthdays.map((b, i) => '<div class="fb-bday-row" data-bn="' + (baseLen + i + 1) + '" data-bname="' + esc(b.name) + '"><span class="fb-num">' + (baseLen + i + 1) + '</span><span class="fb-bname">' + esc(b.name) + '</span><span class="fb-blabel">' + esc(b.label) + '</span></div>').join('') + '<div class="fb-bhint">Tap a name - or say wish number ' + (baseLen + 1) + ' - and I will draft a birthday wish for your approval.</div>';
  } else { bd.classList.add('hidden'); $('fbBdaySec').classList.add('hidden'); }
  $('fbGroups').innerHTML = (fb.groups || []).map((g, i) =>
    '<span class="fb-group" data-gn="' + (baseLen + (fb.birthdays || []).length + i + 1) + '" data-gname="' + esc(g.name || '') + '"><span class="fb-num">' + (baseLen + (fb.birthdays || []).length + i + 1) + '</span> ' + esc(g.name || '') + (g.members ? ' &middot; ' + esc(String(g.members)) + ' members' : '') + '</span>').join('');
  if (detail) {
    wrap.classList.add('hidden');
    det.classList.remove('hidden');
    det.innerHTML = '<button class="fb-back" id="fbBack">&larr; ALL POSTS</button>' +
      '<div class="fb-phead"><span class="fb-author">' + esc(detail.author || '') + '</span><span class="fb-time">' + (detail.time ? ago(detail.time) : '') + '</span></div>' +
      '<p class="fb-full">' + esc(detail.text || '') + '</p>' +
      (detail.reactions && detail.reactions.length ? '<div class="fb-react">' + esc(detail.reactions.join(' \u00B7 ')) + '</div>' : '') +
      '<div class="fb-sec">COMMENTS</div>' +
      ((detail.comments || []).length ? detail.comments.map((c) => '<div class="fb-comment"><span class="fb-cauthor">' + esc(c.author || '') + '</span> <span class="fb-ctext">' + esc(c.text || '') + '</span><div class="fb-ctime">' + (c.time ? ago(c.time) : '') + '</div></div>').join('') : '<div class="qempty">No comments yet.</div>');
    const back = $('fbBack');
    if (back) back.addEventListener('click', () => post('/api/facebook/post', { clear: true }));
  } else if (grp) {
    wrap.classList.add('hidden');
    det.classList.remove('hidden');
    det.innerHTML = '<button class="fb-back" id="fbBack">&larr; BACK TO FEED</button>' +
      '<div class="fb-gname">' + esc(grp.name || '') + '</div>' +
      ((grp.posts || []).length ? grp.posts.map((p, i) =>
        '<div class="fb-post" data-fbn="' + (i + 1) + '" data-scope="group"><div class="fb-phead"><span class="fb-num">' + (i + 1) + '</span><span class="fb-author">' + esc(p.author || '') + '</span><span class="fb-time">' + (p.time ? ago(p.time) : '') + '</span></div><p>' + (p.text ? esc(p.text) : '<span class="fb-notext">Tap to open this post</span>') + '</p>' +
        ((p.comments != null || p.reactions != null) ? '<div class="fb-counts">' + (p.comments != null ? p.comments + ' comments' : '') + (p.comments != null && p.reactions != null ? ' &middot; ' : '') + (p.reactions != null ? p.reactions + ' reactions' : '') + '</div>' : '') + '</div>').join('')
        : '<div class="qempty">No posts in this group yet.</div>');
    const back = $('fbBack');
    if (back) back.addEventListener('click', () => post('/api/facebook/group', { clear: true }));
  } else {
    det.classList.add('hidden'); det.innerHTML = '';
    wrap.classList.remove('hidden');
    $('fbPosts').innerHTML = (fb.posts || []).length ? fb.posts.map((p, i) =>
      '<div class="fb-post" data-fbn="' + (i + 1) + '" data-scope="feed"><div class="fb-phead"><span class="fb-num">' + (i + 1) + '</span><span class="fb-author">' + esc(p.author || '') + '</span><span class="fb-time">' + (p.time ? ago(p.time) : '') + '</span></div><p>' + (p.text ? esc(p.text) : '<span class="fb-notext">Tap to open this post</span>') + '</p></div>').join('')
      : '<div class="qempty">No posts loaded yet.</div>';
  }
}

let lastMgSig = '';
function renderMessenger(snap) {
  const ov = $('messengerOverlay');
  if (!ov) return;
  const view = snap.messengerView || { visible: false };
  ov.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;
  const mg = snap.messenger || { threads: [] };
  const th = snap.messengerThread || null;
  const sig = JSON.stringify([mg.updatedAt, view.draft, th ? th.id : null, (mg.threads || []).length]);
  if (sig === lastMgSig) return;
  lastMgSig = sig;
  const dr = $('mgDraft');
  if (view.draft) {
    dr.classList.remove('hidden');
    dr.innerHTML = '<div class="fb-draft-label">DRAFT REPLY TO ' + esc(String(view.draft.name || '').toUpperCase()) + ' - SAY SEND IT</div><p>' + esc(view.draft.text) + '</p>';
  } else { dr.classList.add('hidden'); dr.innerHTML = ''; }
  const det = $('mgThread');
  const wrap = $('mgListWrap');
  if (th) {
    wrap.classList.add('hidden');
    det.classList.remove('hidden');
    det.innerHTML = '<button class="fb-back" id="mgBack">&larr; ALL CONVERSATIONS</button>' +
      '<div class="fb-gname">' + esc(th.name || '') + '</div>' +
      ((th.messages || []).length ? th.messages.map((m) => '<div class="mg-msg' + (m.mine ? ' mine' : '') + '"><span class="fb-cauthor">' + esc(m.mine ? 'You' : (m.sender || th.name || '')) + '</span> <span class="fb-ctext">' + esc(m.text || '') + '</span><div class="fb-ctime">' + (m.time ? ago(m.time) : '') + '</div></div>').join('') : '<div class="qempty">No messages loaded.</div>');
    const back = $('mgBack');
    if (back) back.addEventListener('click', () => post('/api/messenger/thread', { clear: true }));
  } else {
    det.classList.add('hidden'); det.innerHTML = '';
    wrap.classList.remove('hidden');
    $('mgList').innerHTML = (mg.threads || []).length ? mg.threads.map((t, i) =>
      '<div class="fb-post' + (t.unread ? ' unread' : '') + '" data-mgn="' + (i + 1) + '"><div class="fb-phead"><span class="fb-num">' + (i + 1) + '</span><span class="fb-author">' + esc(t.name || '') + '</span>' + (t.unread ? '<span class="mg-unread">NEW</span>' : '') + '<span class="fb-time">' + (t.time ? ago(t.time) : '') + '</span></div><p>' + esc(t.snippet || '') + '</p></div>').join('')
      : '<div class="qempty">No conversations loaded yet.</div>';
  }
}

let lastSmsSig = '';
function renderSms(snap) {
  const ov = $('smsOverlay');
  if (!ov) return;
  const view = snap.smsView || { visible: false };
  ov.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;
  const sm = snap.sms || { threads: [] };
  const th = snap.smsThread || null;
  const sig = JSON.stringify([sm.updatedAt, view.draft, th ? th.id : null, (sm.threads || []).length]);
  if (sig === lastSmsSig) return;
  lastSmsSig = sig;
  const dr = $('smsDraft');
  if (view.draft) {
    dr.classList.remove('hidden');
    dr.innerHTML = '<div class="fb-draft-label">DRAFT TEXT TO ' + esc(String(view.draft.name || '').toUpperCase()) + ' - SAY SEND IT</div><p>' + esc(view.draft.text) + '</p>';
  } else { dr.classList.add('hidden'); dr.innerHTML = ''; }
  const det = $('smsThread');
  const wrap = $('smsListWrap');
  if (th) {
    wrap.classList.add('hidden');
    det.classList.remove('hidden');
    det.innerHTML = '<button class="fb-back" id="smsBack">&larr; ALL CONVERSATIONS</button>' +
      '<div class="fb-gname">' + esc(th.name || '') + '</div>' +
      ((th.messages || []).length ? th.messages.map((m) => '<div class="mg-msg' + (m.mine ? ' mine' : '') + '"><span class="fb-cauthor">' + esc(m.mine ? 'You' : (m.sender || th.name || '')) + '</span> <span class="fb-ctext">' + esc(m.text || '') + '</span><div class="fb-ctime">' + (m.time ? ago(m.time) : '') + '</div></div>').join('') : '<div class="qempty">No messages loaded.</div>');
    const back = $('smsBack');
    if (back) back.addEventListener('click', () => post('/api/sms/thread', { clear: true }));
  } else {
    det.classList.add('hidden'); det.innerHTML = '';
    wrap.classList.remove('hidden');
    $('smsList').innerHTML = (sm.threads || []).length ? sm.threads.map((t, i) =>
      '<div class="fb-post' + (t.unread ? ' unread' : '') + '" data-smsn="' + (i + 1) + '"><div class="fb-phead"><span class="fb-num">' + (i + 1) + '</span><span class="fb-author">' + esc(t.name || '') + '</span>' + (t.unread ? '<span class="mg-unread">NEW</span>' : '') + '<span class="fb-time">' + (t.time ? ago(t.time) : '') + '</span></div><p>' + esc(t.snippet || '') + '</p></div>').join('')
      : '<div class="qempty">No conversations loaded yet.</div>';
  }
}

let lastApps = [];
let lastCatalog = [];
let lastAppsSig = '';
const APP_TARGETS = { music: () => post('/api/music', { show: true }), mail: () => post('/api/mail', { show: true }), calendar: () => post('/api/calendar', { show: true }), facebook: () => post('/api/facebook', { show: true }), messenger: () => post('/api/messenger', { show: true }), instagram: () => post('/api/insta', { show: true }), texts: () => post('/api/sms', { show: true }), home: () => post('/api/ha', { show: true }), weather: () => post('/api/weather', { show: true }), cameras: () => { if (lastCameras.length) post('/api/camera', { id: lastCameras[0].id }); }, paper: () => post('/api/paper', { show: true }), network: () => post('/api/network', { show: true }) };
function appCardHtml(a, mode) {
  const status = mode === 'catalog' ? '<div class="app-status avail">AVAILABLE</div>' : '<div class="app-status">' + (a.status === 'connected' ? 'CONNECTED' : esc(String(a.status || '').toUpperCase())) + '</div>';
  const acts = mode === 'catalog'
    ? '<div class="app-acts"><button class="app-btn add" data-appadd="' + a.id + '">ADD</button></div>'
    : '<div class="app-acts"><button class="app-btn" data-appopen="' + a.id + '">OPEN</button><button class="app-btn pin' + (a.inDock ? ' on' : '') + '" data-apppin="' + a.id + '">' + (a.inDock ? 'IN DOCK' : 'PIN TO DOCK') + '</button></div>';
  return '<div class="app-card" data-appid="' + a.id + '"><div class="app-ico" style="background:' + esc(a.bg || '#33507e') + '">' + esc(a.icon || '') + '</div><div class="app-name">' + esc(a.name || '') + '</div><p>' + esc(a.desc || '') + '</p>' + status + acts + '</div>';
}
function renderApps(snap) {
  lastApps = snap.apps || [];
  lastCatalog = snap.appsCatalog || [];
  const ov = $('appsOverlay');
  const aov = $('appOverlay');
  if (ov) ov.classList.toggle('hidden', !(snap.appsView && snap.appsView.visible));
  const app = snap.appView ? (lastApps.find((x) => x.id === snap.appView.id) || lastCatalog.find((x) => x.id === snap.appView.id)) : null;
  if (aov) aov.classList.toggle('hidden', !app);
  const sig = JSON.stringify([snap.appsView && snap.appsView.visible, snap.appView, lastApps.map((a) => a.id + ':' + (a.inDock ? 1 : 0)), lastCatalog.map((a) => a.id)]);
  if (sig === lastAppsSig) return;
  lastAppsSig = sig;
  if (ov && snap.appsView && snap.appsView.visible) {
    $('appsGrid').innerHTML = lastApps.length ? lastApps.map((a) => appCardHtml(a, 'mine')).join('') : '<div class="qempty">No apps yet - add one below.</div>';
    $('appsCatalog').innerHTML = lastCatalog.length ? lastCatalog.map((a) => appCardHtml(a, 'catalog')).join('') : '<div class="qempty">Everything available is already added.</div>';
  }
  if (aov && app) {
    $('appPageBody').innerHTML =
      '<button class="fb-back apps-back" id="appBackApps">&larr; ALL APPS</button>' +
      '<div class="app-page-head"><div class="app-ico" style="background:' + esc(app.bg || '#33507e') + '">' + esc(app.icon || '') + '</div><div><div class="app-page-name">' + esc(app.name || '') + '</div><div class="app-status">' + (app.status === 'connected' ? 'CONNECTED' : esc(String(app.status || '').toUpperCase())) + '</div></div></div>' +
      '<p class="app-page-desc">' + esc(app.desc || '') + '</p>' +
      ((app.facts || []).length ? '<ul class="app-facts">' + app.facts.map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>' : '') +
      '<div>' + (app.target ? '<button class="app-go" data-appgo="' + app.id + '">OPEN ' + esc(String(app.name || '').toUpperCase()) + '</button>' : '') +
      (lastApps.some((x) => x.id === app.id) ? '<button class="app-pin2' + (app.inDock ? ' on' : '') + '" data-apppin="' + app.id + '">' + (app.inDock ? 'PINNED TO DOCK - TAP TO UNPIN' : 'PIN TO DOCK') + '</button>' : '<button class="app-go" data-appadd="' + app.id + '">ADD THIS APP</button>') + '</div>';
  }
}
let lastDockSig = '';
function renderAppDock(snap) {
  const pinned = (snap.apps || []).filter((a) => a.inDock);
  const sig = JSON.stringify(pinned.map((a) => a.id));
  if (sig === lastDockSig) return;
  lastDockSig = sig;
  const nav = $('boardNav');
  if (!nav) return;
  nav.querySelectorAll('button.app-nav').forEach((b) => b.remove());
  let ref = nav.querySelector('#navStyleBtn');
  for (const a of pinned) {
    const b = document.createElement('button');
    b.className = 'app-nav';
    b.dataset.appid = a.id;
    b.innerHTML = '<span class="nav-icon">' + esc(a.icon || '') + '</span><span class="nav-label">' + esc(a.name || '') + '</span><span class="nav-dot"></span>';
    if (ref && ref.nextSibling) nav.insertBefore(b, ref.nextSibling);
    else if (ref) nav.appendChild(b);
    else nav.insertBefore(b, nav.firstChild);
    ref = b;
  }
}

let lastSnap = null;
let lastNetworkSig = '';
function netDot(st) { return '<span class="net-dot ' + esc(st || 'down') + '"></span>'; }
function renderNetwork(snap) {
  const ov = $('networkOverlay');
  if (!ov) return;
  const view = snap.networkView || { visible: false };
  ov.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;
  const net = snap.network || {};
  const sig = JSON.stringify(net);
  if (sig === lastNetworkSig) return;
  lastNetworkSig = sig;
  const box = $('networkBody');
  const sum = net.summary || {};
  const upd = net.updatedAt ? new Date(net.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'never';
  let h = '<div class="net-chips">' +
    '<span class="net-chip' + (sum.internet ? '' : ' bad') + '">INTERNET <b>' + (sum.internet ? 'UP' : 'DOWN') + '</b></span>' +
    '<span class="net-chip' + (sum.tunnel ? '' : ' bad') + '">VPN TUNNEL <b>' + (sum.tunnel ? 'UP' : 'DOWN') + '</b></span>' +
    '<span class="net-chip">DEVICES <b>' + (sum.devicesUp || 0) + ' UP</b> / ' + (sum.devicesSeen || 0) + ' SEEN OF ' + (sum.devicesTotal || 0) + '</span>' +
    '<span class="net-chip">UPDATED <b>' + esc(upd) + '</b></span></div>';
  const host = net.host;
  const hostHtml = host ? '<div class="fb-sec">THIS BOX - ' + esc((host.hostname || 'SERVER').toUpperCase()) + '</div><div class="net-host">' +
    '<b>' + esc(host.ip || '') + '</b> on ' + esc(host.iface || '') + ' &middot; up ' + esc(host.uptime || '') + '<br>' +
    'Load ' + esc(host.load || '') + ' &middot; CPU ' + esc(host.temp || '-') + ' &middot; RAM ' + esc(host.mem || '') + '<br>Disk ' + esc(host.disk || '') + '</div>' : '';
  const links = (net.links || []).map((l) => '<div class="net-row">' + netDot(l.ok ? 'up' : 'down') + '<span class="net-name">' + esc(l.name || '') + '</span><span class="net-detail">' + esc(l.target || '') + (l.ms != null ? ' &middot; ' + l.ms + ' ms' : '') + (l.detail ? '<br>' + esc(l.detail) : '') + '</span></div>').join('');
  const devs = (net.devices || []).map((d) => '<div class="net-row">' + netDot(d.status) + '<span class="net-name">' + esc(d.name || '') + '</span><span class="net-detail">' + esc(d.ip || 'not seen') + (d.detail ? '<br>' + esc(d.detail) : '') + '</span></div>').join('');
  const unk = (net.unknown || []).map((d) => '<div class="net-row">' + netDot('seen') + '<span class="net-name">Unknown device</span><span class="net-detail">' + esc(d.ip || '') + '<br>' + esc(d.mac || '') + '</span></div>').join('');
  h += '<div class="net-grid"><div class="net-col">' + hostHtml + '<div class="fb-sec">LINKS</div>' + links + '</div>' +
    '<div class="net-col"><div class="fb-sec">KNOWN DEVICES</div>' + devs +
    (unk ? '<div class="fb-sec" style="margin-top:14px">ALSO ON THE LAN (' + (net.unknown || []).length + ')</div>' + unk : '') + '</div></div>';
  box.innerHTML = h;
}

let lastPaperSig = '';
let paperPdfOpen = false;
function renderPaper(snap) {
  const ov = $('paperOverlay');
  if (!ov) return;
  const view = snap.paperView || { visible: false };
  ov.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;
  const ed = (snap.paper || {}).edition || null;
  const sig = JSON.stringify([ed, paperPdfOpen]);
  if (sig === lastPaperSig) return;
  lastPaperSig = sig;
  const box = $('paperBody');
  if (!ed) { box.innerHTML = '<div class="qempty">No edition yet.</div>'; return; }
  box.innerHTML =
    '<div class="paper-mast">' + esc(ed.brand || 'The Daily Times') + '</div>' +
    '<div class="paper-date">' + esc(ed.dateLabel || '') + (ed.note ? ' &middot; ' + esc(ed.note) : '') + '</div>' +
    '<div class="paper-cols"><div class="paper-main">' +
    (ed.top || []).map((t, i) => '<div class="paper-story' + (i === 0 ? ' lead' : '') + '"><h3>' + esc(t.title || '') + '</h3><p>' + esc(t.dek || '') + '</p></div>').join('') +
    '</div><div class="paper-side"><div class="fb-sec">INSIDE TODAY</div>' +
    (ed.sections || []).map((x) => '<div class="paper-sec">' + esc(x) + '</div>').join('') +
    '<div class="paper-acts">' + (ed.pdf ? '<button class="app-go" id="paperRead">' + (paperPdfOpen ? 'CLOSE THE PAPER' : 'READ THE PAPER') + '</button>' : '') + '<button class="app-pin2" id="paperBuild">MAKE A NEW EDITION</button><button class="app-pin2" id="paperPrint">PRINT IT</button></div>' +
    '</div></div>' +
    (paperPdfOpen && ed.pdf ? '<iframe class="paper-pdf" src="' + esc(ed.pdf) + '"></iframe>' : '');
}

let lastInstaSig = '';
function renderInsta(snap) {
  const ov = $('instaOverlay');
  if (!ov) return;
  const view = snap.instaView || { visible: false };
  ov.classList.toggle('hidden', !view.visible);
  if (!view.visible) return;
  const ig = snap.insta || { profile: null, posts: [] };
  const det = snap.instaPost || null;
  const sig = JSON.stringify([ig.updatedAt, det ? det.id : null, (ig.posts || []).length, ig.profile ? ig.profile.username : null]);
  if (sig === lastInstaSig) return;
  lastInstaSig = sig;
  const prof = $('igProfile');
  if (ig.profile) {
    prof.classList.remove('hidden');
    prof.innerHTML = (ig.profile.pic ? '<img class="ig-pic" src="' + esc(ig.profile.pic) + '" alt="">' : '') + '<div class="ig-pmeta"><div class="ig-uname">@' + esc(ig.profile.username || '') + '</div><div class="ig-pstats">' + (ig.profile.followers != null ? ig.profile.followers + ' followers' : '') + (ig.profile.following != null ? ' &middot; ' + ig.profile.following + ' following' : '') + '</div></div>';
  } else { prof.classList.add('hidden'); prof.innerHTML = ''; }
  const detEl = $('igPost');
  const wrap = $('igListWrap');
  if (det) {
    wrap.classList.add('hidden');
    detEl.classList.remove('hidden');
    detEl.innerHTML = '<button class="fb-back" id="igBack">&larr; ALL POSTS</button>' +
      '<div class="fb-phead">' + (det.avatar ? '<img class="ig-av" src="' + esc(det.avatar) + '" alt="">' : '') + '<span class="fb-author">' + esc(det.username || '') + '</span>' + (det.mediaType ? '<span class="ig-media">' + esc(String(det.mediaType).toUpperCase()) + '</span>' : '') + '<span class="fb-time">' + (det.time ? ago(det.time) : '') + '</span></div>' +
      '<p class="ig-cap">' + esc(det.caption || '') + '</p>' +
      (det.likes != null ? '<div class="ig-likes">' + det.likes + ' likes</div>' : '') +
      '<div class="fb-sec">COMMENTS</div>' +
      ((det.comments || []).length ? det.comments.map((c) => '<div class="mg-msg"><span class="fb-cauthor">' + esc(c.author || '') + '</span> <span class="fb-ctext">' + esc(c.text || '') + '</span><div class="fb-ctime">' + (c.time ? ago(c.time) : '') + '</div></div>').join('') : '<div class="qempty">No comments loaded.</div>');
    const back = $('igBack');
    if (back) back.addEventListener('click', () => post('/api/insta/post', { clear: true }));
  } else {
    detEl.classList.add('hidden'); detEl.innerHTML = '';
    wrap.classList.remove('hidden');
    $('igList').innerHTML = (ig.posts || []).length ? ig.posts.map((p, i) =>
      '<div class="fb-post" data-ign="' + (i + 1) + '"><div class="fb-phead"><span class="fb-num">' + (i + 1) + '</span>' + (p.avatar ? '<img class="ig-av" src="' + esc(p.avatar) + '" alt="">' : '') + '<span class="fb-author">' + esc(p.username || '') + '</span>' + (p.mediaType ? '<span class="ig-media">' + esc(String(p.mediaType).toUpperCase()) + '</span>' : '') + '<span class="fb-time">' + (p.time ? ago(p.time) : '') + '</span></div><p>' + esc(p.caption || '') + '</p></div>').join('')
      : '<div class="qempty">No posts loaded yet.</div>';
  }
}

function renderTexts(snap) {
  const box = $('textsList');
  if (!box) return;
  const q = (snap.cards || []).filter((c) => c.kind === 'suggestion' && c.status === 'open').length;
  const msgs = ((snap.texts && snap.texts.messages) || []).slice(0, 6);
  const tc = $('textsCount'); if (tc) tc.textContent = msgs.length;
  const hl = snap.textView ? snap.textView.highlightId : null;
  box.innerHTML = msgs.length ? msgs.map((m, i) =>
    '<div class="trow' + (m.id === hl ? ' hl' : '') + (m.read === false && m.dir !== 'out' ? ' unread' : '') + '" data-tid="' + esc(m.id || '') + '"><div class="qnum tnum">' + (q + i + 1) + '</div><div class="tbody"><div class="thead"><span class="tfrom">' +
    esc(m.from || m.address || '') + (m.dir === 'out' ? '<span class="tdir"> (you)</span>' : '') + '</span>' + (m.source ? '<span class="tsrc' + (m.source === 'messenger' ? ' fb' : '') + '">' + (m.source === 'messenger' ? 'Messenger' : 'Text') + '</span>' : '') + '<span class="ttime">' + ago(m.time) + '</span></div><p>' + esc(m.body || '') + '</p></div></div>').join('')
    : '<div class="qempty">No recent texts.</div>';
}

function renderFocus() {
  const ov = $('focusOverlay');
  const card = lastFocusId != null ? lastCards.find((c) => c.id === lastFocusId) : null;
  if (!card) { ov.classList.add('hidden'); document.body.classList.remove('focusing'); return; }
  const queue = lastCards.filter((c) => c.kind === 'suggestion' && c.status === 'open');
  const idx = queue.findIndex((c) => c.id === card.id);
  $('focusNum').textContent = idx >= 0 ? String(idx + 1) : '•';
  $('focusKind').textContent = (ICONS[card.kind] || '') + ' ' + card.kind.toUpperCase();
  $('focusTitle').textContent = card.title || '';
  $('focusBody').textContent = card.body || '';
  $('focusMeta').textContent = (card.meta || '') + ' · ' + ago(card.time);
  const fimg = $('focusImg');
  if (card.image) { if (fimg.getAttribute('src') !== card.image) fimg.src = card.image; fimg.classList.remove('hidden'); }
  else { fimg.classList.add('hidden'); fimg.removeAttribute('src'); }
  const tw = $('focusThreadWrap');
  if (Array.isArray(card.thread) && card.thread.length) {
    $('focusThread').innerHTML = card.thread.map((m, i) =>
      '<div class="tmsg' + (i === card.thread.length - 1 ? ' latest' : '') + '">' +
      '<div class="tmsg-head"><span class="tmsg-from">' + esc(m.from || '') + '</span>' +
      '<span class="tmsg-when">' + esc(m.when || '') + '</span>' +
      (i === card.thread.length - 1 ? '<span class="tmsg-tag">LATEST</span>' : '') + '</div>' +
      '<div class="tmsg-body">' + esc(m.body || '') + '</div></div>').join('');
    tw.classList.remove('hidden');
    resetFocusScroll();
  } else {
    tw.classList.add('hidden');
    $('focusThread').innerHTML = '';
  }
  const dw = $('focusDraftWrap');
  if (card.draft) {
    $('focusDraft').textContent = card.draft;
    dw.classList.remove('hidden');
  } else {
    dw.classList.add('hidden');
    $('focusDraft').textContent = '';
  }
  ov.classList.remove('hidden');
  document.body.classList.add('focusing');
}

let lastCalendar = null;
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function parseD(s) { const p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
function fmtDay(d) { return DOW[d.getDay()] + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getDate(); }

function renderCalendar() {
  const cal = lastCalendar;
  const ov = $('calOverlay');
  if (!cal || !cal.visible) { ov.classList.add('hidden'); document.body.classList.remove('calopen'); return; }
  const view = cal.view || 'days30';
  const byDate = {};
  (cal.events || []).forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  Object.values(byDate).forEach((list) => list.sort((a, b) => (a.allDay === b.allDay ? String(a.start || '').localeCompare(String(b.start || '')) : (a.allDay ? -1 : 1))));
  const today = new Date(); const todayS = dstr(today);
  let anchor = cal.anchor ? parseD(cal.anchor) : today;
  // Roll forward: the cache holds ~60 days, so whenever today falls inside
  // the covered range, today becomes the window start - no refetch needed.
  const coverEnd = addDays(anchor, (cal.days || 30) - 1);
  if (dstr(today) >= dstr(anchor) && dstr(today) <= dstr(coverEnd)) anchor = parseD(dstr(today));
  let sel = cal.date ? parseD(cal.date) : today;
  const evCell = (e, maxTitle) => '<div class="cal-ev' + (e.allDay ? ' allday' : '') + '">' + (e.allDay ? '' : '<span class="cal-ev-t">' + esc(e.start || '') + '</span>') + esc(e.title || '') + '</div>';
  const cell = (d, opts) => {
    const ds = dstr(d); const evs = byDate[ds] || [];
    const max = opts.max;
    let h = '<div class="cal-cell' + (ds === todayS ? ' today' : '') + (ds === dstr(sel) && view === 'day' ? ' sel' : '') + (opts.dim ? ' dim' : '') + '">';
    h += '<div class="cal-dnum">' + d.getDate() + (opts.mon ? '<span class="cal-mon">' + MONTHS[d.getMonth()].slice(0, 3).toUpperCase() + '</span>' : '') + (ds === todayS ? '<span class="cal-today-tag">TODAY</span>' : '') + '</div>';
    h += evs.slice(0, max).map((e) => evCell(e)).join('');
    if (evs.length > max) h += '<div class="cal-more">+' + (evs.length - max) + ' more</div>';
    return h + '</div>';
  };
  $('calViews').innerHTML = ['days30', 'week', 'day'].map((v) => '<span class="cal-view-chip' + (v === view ? ' on' : '') + '">' + (v === 'days30' ? '30 DAYS' : v.toUpperCase()) + '</span>').join('');
  const dow = $('calDow');
  if (view === 'day') {
    dow.classList.add('hidden'); dow.innerHTML = '';
    $('calSub').textContent = sel.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const evs = byDate[dstr(sel)] || [];
    $('calBody').innerHTML = '<div class="cal-day-list">' + (evs.length ? evs.map((e) =>
      '<div class="cal-day-ev' + (e.allDay ? ' allday' : '') + '"><div class="cal-day-time">' + (e.allDay ? 'ALL DAY' : esc(e.start || '') + (e.end ? ' - ' + esc(e.end) : '')) + '</div><div><div class="cal-day-title">' + esc(e.title || '') + '</div>' + (e.location ? '<div class="cal-day-loc">' + esc(e.location) + '</div>' : '') + '</div></div>').join('')
      : '<div class="cal-day-empty">Nothing scheduled this day.</div>') + '</div>';
  } else if (view === 'week') {
    dow.classList.remove('hidden');
    dow.innerHTML = DOW.map((x) => '<div>' + x + '</div>').join('');
    const sunday = addDays(sel, -sel.getDay());
    $('calSub').textContent = 'WEEK OF ' + fmtDay(sunday) + ' - ' + fmtDay(addDays(sunday, 6));
    let h = '<div class="cal-grid week">';
    for (let i = 0; i < 7; i++) h += cell(addDays(sunday, i), { max: 8, mon: true });
    $('calBody').innerHTML = h + '</div>';
  } else {
    dow.classList.remove('hidden');
    dow.innerHTML = DOW.map((x) => '<div>' + x + '</div>').join('');
    $('calSub').textContent = 'NEXT 30 DAYS · ' + fmtDay(anchor) + ' - ' + fmtDay(addDays(anchor, 29));
    const lead = anchor.getDay();
    const total = Math.ceil((lead + 30) / 7) * 7;
    let h = '<div class="cal-grid">';
    for (let i = 0; i < total; i++) {
      const d = addDays(anchor, i - lead);
      const inRange = i >= lead && i < lead + 30;
      h += cell(d, { max: 3, dim: !inRange, mon: inRange && (i === lead || d.getDate() === 1) });
    }
    $('calBody').innerHTML = h + '</div>';
  }
  ov.classList.remove('hidden');
  document.body.classList.add('calopen');
}

let lastCameras = [];
let lastCameraView = null;
let lastImageView = null;
let imgShownSrc = null;
let camShownId = null;
function renderCamera() {
  const ov = $('camOverlay');
  const cv = lastCameraView;
  const cam = cv && cv.cameraId ? lastCameras.find((c) => c.id === cv.cameraId) : null;
  if (!cv || !cv.visible || !cam) {
    ov.classList.add('hidden');
    if (camShownId) { $('camFeed').removeAttribute('src'); camShownId = null; }
    return;
  }
  $('camTitle').textContent = '\u{1F4F7} ' + (cam.name || '').toUpperCase();
  const isRtsp = String(cam.feed || '').startsWith('rtsp');
  $('camSrc').textContent = cam.source === 'frigate' ? 'FRIGATE \u00b7 LIVE' : (isRtsp ? 'IP CAMERA \u00b7 RTSP (NO WEB FEED)' : 'IP CAMERA \u00b7 LIVE');
  const ask = $('camAsk');
  if (cv.identify) {
    ask.textContent = 'Is this the ' + cv.identify + '? Say "yes" to save that name for this camera, or "no" to see the next one.';
    ask.classList.remove('hidden');
    $('camHint').innerHTML = 'Say: <b>"yes"</b> \u00b7 <b>"no"</b> \u00b7 <b>"back to the board"</b>';
  } else {
    ask.classList.add('hidden');
    $('camHint').innerHTML = 'Say: <b>"back to the board"</b>';
  }
  if (camShownId !== cam.id) {
    camShownId = cam.id;
    if (isRtsp) $('camFeed').removeAttribute('src'); else $('camFeed').src = cam.feed;
  }
  $('camFeed').style.transform = cam.mirror ? 'scaleX(-1)' : '';
  ov.classList.remove('hidden');
}

function renderImage() {
  const ov = $('imageOverlay');
  const iv = lastImageView;
  if (!iv || !iv.visible || !iv.src) {
    ov.classList.add('hidden');
    if (imgShownSrc) { $('imgMain').removeAttribute('src'); imgShownSrc = null; }
    return;
  }
  $('imgTitle').textContent = (iv.title || 'IMAGE').toUpperCase();
  $('imgCredit').textContent = iv.credit || '';
  if (imgShownSrc !== iv.src) { imgShownSrc = iv.src; $('imgMain').src = iv.src; }
  ov.classList.remove('hidden');
}

let lastInbox = { emails: [], updatedAt: null };
let lastMailView = null;
let lastMailSig = null;
function threadHtml(msgs) {
  return msgs.map((m, i) =>
    '<div class="tmsg' + (i === msgs.length - 1 ? ' latest' : '') + '">' +
    '<div class="tmsg-head"><span class="tmsg-from">' + esc(m.from || '') + '</span>' +
    '<span class="tmsg-when">' + esc(m.when || m.date || '') + '</span>' +
    (i === msgs.length - 1 ? '<span class="tmsg-tag">LATEST</span>' : '') + '</div>' +
    '<div class="tmsg-body">' + esc(m.body || '') + '</div></div>').join('');
}
function renderMail() {
  const ov = $('mailOverlay');
  const mv = lastMailView;
  const emails = (lastInbox && lastInbox.emails) || [];
  if (!mv || !mv.visible) { ov.classList.add('hidden'); lastMailSig = null; return; }
  const focused = mv.focusN != null ? emails[mv.focusN - 1] : null;
  // Signature guard: avatar-state snapshots arrive constantly while the owner
  // talks; rebuilding the DOM each time would keep resetting the auto-scroll.
  const sig = [mv.focusN || 0, emails.length, lastInbox.updatedAt || '',
    focused ? (focused.thread ? focused.thread.length : 0) : 0,
    focused ? (focused.draft ? focused.draft.length : 0) : 0].join(':');
  if (sig === lastMailSig) { ov.classList.remove('hidden'); return; }
  lastMailSig = sig;
  resetMailScroll();
  const listEl = $('mailList');
  const tw = $('mailThreadWrap');
  if (focused) {
    $('mailTitle').textContent = '\u{2709}\u{FE0F} EMAIL ' + mv.focusN + ' OF ' + emails.length;
    $('mailSub').textContent = focused.subject || '(no subject)';
    listEl.classList.add('hidden');
    tw.classList.remove('hidden');
    $('mailTHead').innerHTML = '<span class="tmsg-from">' + esc(focused.from || '') + '</span>' +
      '<span class="tmsg-when">' + esc(focused.date || '') + '</span>';
    const msgs = (Array.isArray(focused.thread) && focused.thread.length)
      ? focused.thread
      : [{ from: focused.from, when: focused.date, body: focused.body || focused.snippet || '' }];
    $('mailThread').innerHTML = threadHtml(msgs);
    const dw = $('mailDraftWrap');
    if (focused.draft) { $('mailDraft').textContent = focused.draft; dw.classList.remove('hidden'); }
    else { dw.classList.add('hidden'); $('mailDraft').textContent = ''; }
    $('mailHint').innerHTML = 'Say: <b>"draft a reply"</b> \u00b7 <b>"reply with ..."</b> \u00b7 <b>"back to my email"</b> \u00b7 <b>"back to the board"</b>';
  } else {
    $('mailTitle').textContent = '\u{2709}\u{FE0F} EMAIL';
    $('mailSub').textContent = emails.length + (emails.length === 1 ? ' MESSAGE' : ' MESSAGES') + (lastInbox.updatedAt ? ' \u00b7 UPDATED ' + new Date(lastInbox.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '');
    tw.classList.add('hidden');
    listEl.classList.remove('hidden');
    listEl.innerHTML = emails.map((e, i) =>
      '<div class="mrow' + (e.unread ? ' unread' : '') + '">' +
      '<div class="mnum">' + (i + 1) + '</div>' +
      '<div class="mmain"><div class="mfrom">' + (e.unread ? '<span class="mdot"></span>' : '') + esc(e.from || '') +
      '<span class="msubj">' + esc(e.subject || '(no subject)') + '</span></div>' +
      '<div class="msnip">' + esc(e.snippet || '') + '</div></div>' +
      '<div class="mdate">' + esc(e.date || '') + '</div></div>').join('') ||
      '<div class="mrow"><div class="mmain"><div class="mfrom">Inbox is empty.</div></div></div>';
    $('mailHint').innerHTML = 'Say: <b>"show me 3"</b> to open one \u00b7 <b>"back to the board"</b>';
  }
  ov.classList.remove('hidden');
}

let lastWeather = null;
let lastWeatherView = null;
let lastHomeView = null;
let lastMusic = null;
let lastMusicView = null;
let lastMusicSig = '';
function fmtDur(ms) {
  if (ms == null) return '';
  const sec = Math.round(ms / 1000);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function renderMusic() {
  const ov = $('musicOverlay');
  if (!lastMusicView || !lastMusicView.visible) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  const m = lastMusic || { nowPlaying: null, picks: [], updatedAt: null };
  const sig = JSON.stringify(m);
  if (sig === lastMusicSig) return;
  lastMusicSig = sig;
  const np = m.nowPlaying;
  if (np) {
    $('musicTrack').textContent = np.title || 'Unknown track';
    $('musicArtist').textContent = np.artist || '';
    $('musicAlbum').textContent = np.album || '';
    const progMs = np.isPlaying && m.updatedAt && np.durationMs ? Math.min(np.durationMs, (np.progressMs || 0) + Math.max(0, Date.now() - m.updatedAt)) : (np.progressMs || 0);
    const bits = [];
    bits.push(np.isPlaying ? '\u25B6 Playing' : '\u275A\u275A Paused');
    if (np.device) bits.push('on ' + np.device);
    if (np.contextName) bits.push('from ' + np.contextName);
    if (np.durationMs) bits.push(fmtDur(progMs) + ' of ' + fmtDur(np.durationMs));
    $('musicMeta').textContent = bits.join('  \u00B7  ');
    $('musicProgFill').style.width = np.durationMs ? Math.min(100, Math.round(100 * progMs / np.durationMs)) + '%' : '0%';
    if (np.art) { $('musicArt').src = np.art; $('musicArt').style.display = 'block'; $('musicArtFallback').style.display = 'none'; }
    else { $('musicArt').style.display = 'none'; $('musicArtFallback').style.display = 'flex'; }
  } else {
    $('musicTrack').textContent = 'Nothing playing';
    $('musicArtist').textContent = '';
    $('musicAlbum').textContent = '';
    $('musicMeta').textContent = '';
    $('musicProgFill').style.width = '0%';
    $('musicArt').style.display = 'none';
    $('musicArtFallback').style.display = 'flex';
  }
  $('musicUpd').textContent = m.updatedAt ? new Date(m.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  const devs = m.devices || [];
  $('musicDevicesHead').style.display = devs.length ? 'block' : 'none';
  $('musicDevices').innerHTML = devs.map((d) => '<button class="mdev' + (d.active ? ' on' : '') + '" data-did="' + esc(d.id) + '" data-dname="' + esc(d.name || '') + '"><span class="mdev-nm">' + esc(d.name || 'Speaker') + '</span>' + (d.here ? '<span class="mdev-tag">THIS ROOM</span>' : '') + (d.active ? '<span class="mdev-tag live">' + (np && np.isPlaying ? 'PLAYING' : 'PAUSED') + '</span>' : '') + '</button>').join('');
  const picks = m.picks || [];
  $('musicPicksHead').style.display = picks.length ? 'block' : 'none';
  $('musicPicks').innerHTML = picks.map((pk, i) => '<div class="mpick"><span class="mnum">' + (i + 1) + '</span><div class="mpick-main"><div class="mpick-title">' + esc(pk.title) + '</div>' + (pk.meta ? '<div class="mpick-meta">' + esc(pk.meta) + '</div>' : '') + '</div></div>').join('');
}

let lastHelpView = null;
let helpShownOnce = false;
function renderHelp() {
  const ov = $('helpOverlay');
  if (!lastHelpView || !lastHelpView.visible) { ov.classList.add('hidden'); helpShownOnce = false; return; }
  if (!helpShownOnce) {
    helpShownOnce = true;
    helpScroller.el.scrollTop = 0; helpScroller.dir = 1; helpScroller.waitUntil = Date.now() + 4000;
  }
  ov.classList.remove('hidden');
}

function render(snap) {
  lastCards = snap.cards || [];
  lastFocusId = snap.focusId !== undefined ? snap.focusId : null;
  if (snap.avatarMode && snap.avatarMode !== avatarMode) {
    avatarMode = snap.avatarMode;
    document.body.dataset.avatarMode = avatarMode;
    $('botVideo').classList.toggle('hidden', avatarMode !== 'real');
    if (avatarMode === 'real') { $('botVideo').dataset.src = ''; }
  }
  lastCalendar = snap.calendar || null;
  renderAvatar(snap.avatar);
  renderCards(lastCards);
  renderFocus();
  renderCalendar();
  lastCameras = snap.cameras || [];
  lastCameraView = snap.cameraView || null;
  lastImageView = snap.imageView || null;
  renderCamera();
  lastMusic = snap.music || null;
  lastMusicView = snap.musicView || null;
  renderMusic();
  lastHelpView = snap.helpView || null;
  renderHelp();
  renderImage();
  applyNavStyle(snap);
  renderTexts(snap);
  renderFacebook(snap);
  renderMessenger(snap);
  renderSms(snap);
  renderInsta(snap);
  lastSnap = snap;
  renderApps(snap);
  renderPaper(snap);
  renderNetwork(snap);
  renderAppDock(snap);
  lastInbox = snap.inbox || { emails: [], updatedAt: null };
  lastMailView = snap.mailView || null;
  renderMail();
  lastWeather = snap.weather || null;
  lastWeatherView = snap.weatherView || null;
  renderRail();
  renderWxPanel();
  renderWeather();
  lastHomeView = snap.homeView || null;
  homeHidden = snap.homeHidden || [];
  renderHome();
}

function connect() {
  const es = new EventSource('/events');
  es.addEventListener('snapshot', (e) => { $('liveDot').className = 'livedot on'; render(JSON.parse(e.data)); });
  es.addEventListener('avatar', (e) => renderAvatar(JSON.parse(e.data)));
  es.addEventListener('card', () => fetch('/api/state').then((r) => r.json()).then(render));
  es.onerror = () => { $('liveDot').className = 'livedot'; };
}
connect();
fetch('/api/state').then((r) => r.json()).then(render).catch(() => {});

// Clock
function tick() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  $('dateLine').textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}
tick(); setInterval(tick, 15000);

// If nothing tells Cosmo otherwise for a while, settle back to idle (display-only).
setInterval(() => {
  fetch('/api/state').then((r) => r.json()).then((s) => {
    if (s.avatar && Date.now() - s.avatar.since > 5 * 60000 && s.avatar.state !== 'idle' && s.avatar.state !== 'waiting') {
      renderAvatar(Object.assign({}, s.avatar, { state: 'idle', message: 'Watching over things' }));
    }
  }).catch(() => {});
}, 30000);

// Node info line (static for this build; the bus can overwrite later)
$('nodeInfo').textContent = 'Gadget · paired';

// ---- Auto-scroll (mouseless kiosk: nothing on this screen can be scrolled
// by hand, so long content scrolls itself — slow down, pause, back up) ----
function makeScroller(el, downSpeed) { return { el, downSpeed, dir: 1, waitUntil: Date.now() + 3500 }; }
const focusScroller = makeScroller(document.querySelector('.focus-card'), 30);
const streamScroller = makeScroller($('stream'), 16);
const queueScroller = makeScroller($('queue'), 16);
const mailListScroller = makeScroller($('mailList'), 20);
const helpScroller = makeScroller($('helpBody'), 20);
const musicScroller = makeScroller($('musicPicks'), 20);
const wxScroller = makeScroller($('wxDays'), 22);
const homeScroller = makeScroller($('homeGroups'), 24);
const mailThreadScroller = makeScroller($('mailThreadWrap'), 26);
function resetMailScroll() {
  for (const s of [mailListScroller, mailThreadScroller]) {
    s.el.scrollTop = 0; s.dir = 1; s.waitUntil = Date.now() + 4000;
  }
}
function resetFocusScroll() {
  focusScroller.el.scrollTop = 0;
  focusScroller.dir = 1;
  focusScroller.waitUntil = Date.now() + 4000;
}
function stepScroller(s, dt, now) {
  const el = s.el;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 4) { el.scrollTop = 0; return; }
  if (now < s.waitUntil) return;
  const v = s.dir > 0 ? s.downSpeed : s.downSpeed * 3.2;
  el.scrollTop += s.dir * v * dt / 1000;
  if (s.dir > 0 && el.scrollTop >= max - 1) { el.scrollTop = max; s.dir = -1; s.waitUntil = now + 5000; }
  else if (s.dir < 0 && el.scrollTop <= 1) { el.scrollTop = 0; s.dir = 1; s.waitUntil = now + 3500; }
}
let lastScrollTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(120, now - lastScrollTick);
  lastScrollTick = now;
  if (!$('helpOverlay').classList.contains('hidden')) stepScroller(helpScroller, dt, now);
  else if (!$('mailOverlay').classList.contains('hidden')) stepScroller(lastMailView && lastMailView.focusN != null ? mailThreadScroller : mailListScroller, dt, now);
  else if (!$('weatherOverlay').classList.contains('hidden')) stepScroller(wxScroller, dt, now);
  else if (!$('homeOverlay').classList.contains('hidden')) stepScroller(homeScroller, dt, now);
  else if (!$('musicOverlay').classList.contains('hidden')) stepScroller(musicScroller, dt, now);
  else if (!$('focusOverlay').classList.contains('hidden')) stepScroller(focusScroller, dt, now);
  else { stepScroller(streamScroller, dt, now); stepScroller(queueScroller, dt, now); }
}, 50);


// ---- Touch layer (2026-10-26): the whole screen is tappable. Navigation
// runs locally through the same endpoints ui.py uses; actions that need
// Cosmo himself (sending, playing) go to /api/action, where the
// touch-actions watcher forwards them to the voice session as [touch]
// messages, exactly like spoken commands.
function post(path, body) { return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).catch(() => {}); }

// ---- Button dock (2026-10-26): the bottom buttons have two styles - the
// text bar (default) and a mac-style icon dock with hover magnification.
// Style is server state (state.navStyle) so voice, touch and restarts agree.
const NAV_ICONS = { apps: '\u{1F9E9}', facebook: 'f', messenger: '\u26A1', texts: '\u{1F4AC}', instagram: '\u{1F4F8}', calendar: '\u{1F4C5}', mail: '\u{1F4E7}', music: '\u{1F3B5}', cameras: '\u{1F4F7}', home: '\u{1F3E0}', help: '\u{1F4A1}' };
function initNavDock() {
  const nav = $('boardNav');
  if (!nav || nav.dataset.dockInit) return;
  nav.dataset.dockInit = '1';
  for (const btn of [...nav.querySelectorAll('button[data-nav]')]) {
    const label = btn.textContent;
    btn.dataset.tip = label;
    btn.innerHTML = '';
    const ic = document.createElement('span'); ic.className = 'nav-icon'; ic.textContent = NAV_ICONS[btn.dataset.nav] || '\u{1F518}';
    if (btn.dataset.nav === 'texts') ic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#2fbf4f" d="M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.4 5.4 3.7 7.1V22l3.4-1.9c.9.3 1.9.4 2.9.4 5.5 0 10-4.1 10-9.3S17.5 2 12 2z"/><path stroke="#fff" stroke-width="1.8" stroke-linecap="round" d="M7 9.2h10M7 13h6.5"/></svg>';
    if (btn.dataset.nav === 'instagram') ic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="igGrad2" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#feda75"/><stop offset=".35" stop-color="#fa7e1e"/><stop offset=".6" stop-color="#d62976"/><stop offset=".82" stop-color="#962fbf"/><stop offset="1" stop-color="#4f5bd5"/></linearGradient></defs><rect x="2.6" y="2.6" width="18.8" height="18.8" rx="5.4" fill="none" stroke="url(#igGrad2)" stroke-width="2.2"/><circle cx="12" cy="12" r="4.3" fill="none" stroke="url(#igGrad2)" stroke-width="2.2"/><circle cx="17.5" cy="6.5" r="1.6" fill="url(#igGrad2)"/></svg>';
    if (btn.dataset.nav === 'messenger') ic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="mgGrad2" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#006aff"/><stop offset=".55" stop-color="#a033ff"/><stop offset="1" stop-color="#ff5280"/></linearGradient></defs><path fill="url(#mgGrad2)" d="M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.4 5.4 3.7 7.1V22l3.4-1.9c.9.3 1.9.4 2.9.4 5.5 0 10-4.1 10-9.3S17.5 2 12 2z"/><path fill="#fff" d="M13.4 6.9l-6 5.5h3.1l-1.7 4.7 6-5.5h-3.1l1.7-4.7z"/></svg>';
    const lb = document.createElement('span'); lb.className = 'nav-label'; lb.textContent = label;
    const dot = document.createElement('span'); dot.className = 'nav-dot';
    btn.append(ic, lb, dot);
  }
  const tgl = document.createElement('button');
  tgl.id = 'navStyleBtn';
  tgl.innerHTML = '<span class="nav-icon">\u{1F39B}\u{FE0F}</span><span class="nav-label">Dock</span><span class="nav-dot"></span>';
  tgl.dataset.tip = 'Dock';
  nav.insertBefore(tgl, nav.firstChild);
  tgl.addEventListener('click', () => {
    post('/api/navstyle', { style: document.body.classList.contains('dock-nav') ? 'bar' : 'dock' });
  });
  // Touch screen: no hover. The tapped icon magnifies (+ name shows) as the tap feedback.
  let tapTimer = null;
  nav.addEventListener('pointerdown', (ev) => {
    if (!document.body.classList.contains('dock-nav')) return;
    const btn = ev.target.closest('#boardNav button');
    for (const b of nav.querySelectorAll('button')) { b.style.transform = ''; b.classList.remove('tapped'); }
    if (!btn) return;
    btn.style.transform = 'scale(1.5)';
    btn.classList.add('tapped');
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { btn.style.transform = ''; btn.classList.remove('tapped'); }, 650);
  });
}
function applyNavStyle(snap) {
  const dock = !!(snap && snap.navStyle === 'dock');
  document.body.classList.toggle('dock-nav', dock);
  const tgl = $('navStyleBtn');
  if (tgl) {
    tgl.querySelector('.nav-label').textContent = dock ? 'Bar' : 'Dock';
    tgl.dataset.tip = dock ? 'Button bar' : 'Dock';
  }
}
initNavDock();

function hideAllOverlays() {
  post('/api/help', { clear: true });
  post('/api/mail', { clear: true });
  post('/api/music', { clear: true });
  post('/api/weather', { clear: true });
  post('/api/ha', { clear: true });
  post('/api/camera', { clear: true });
  post('/api/calendar', { show: false });
  post('/api/focus', { clear: true });
  post('/api/image', { clear: true });
  post('/api/facebook', { clear: true });
  post('/api/messenger', { clear: true });
  post('/api/sms', { clear: true });
  post('/api/insta', { clear: true });
  post('/api/apps', { clear: true });
  post('/api/app', { clear: true });
  post('/api/paper', { clear: true });
  post('/api/network', { clear: true });
}
function flashBtn(btn, text) {
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; delete btn.dataset.busy; }, 2600);
}
function queuePos(cardId) {
  const q = lastCards.filter((c) => c.kind === 'suggestion' && c.status === 'open');
  const i = q.findIndex((c) => c.id === cardId);
  return i >= 0 ? i + 1 : null;
}
function calCellDate(cell) {
  const cells = [...document.querySelectorAll('.cal-cell')];
  const idx = cells.indexOf(cell);
  if (idx < 0 || !lastCalendar) return null;
  const view = lastCalendar.view || 'days30';
  if (view === 'week') {
    const sel = lastCalendar.date ? parseD(lastCalendar.date) : new Date();
    return dstr(addDays(addDays(sel, -sel.getDay()), idx));
  }
  if (view === 'day') return lastCalendar.date || dstr(new Date());
  let anchor = lastCalendar.anchor ? parseD(lastCalendar.anchor) : new Date();
  const todayS = dstr(new Date());
  const coverEnd = addDays(anchor, (lastCalendar.days || 30) - 1);
  if (todayS >= dstr(anchor) && todayS <= dstr(coverEnd)) anchor = parseD(todayS);
  return dstr(addDays(anchor, idx - anchor.getDay()));
}
document.addEventListener('click', (ev) => {
  const nav = ev.target.closest('#boardNav button');
  if (nav && nav.dataset.nav) {
    const k = nav.dataset.nav;
    if (k === 'apps') post('/api/apps', { show: true });
    else if (k === 'calendar') post('/api/calendar', { show: true });
    else if (k === 'mail') post('/api/mail', { show: true });
    else if (k === 'facebook') post('/api/facebook', { show: true });
    else if (k === 'messenger') post('/api/messenger', { show: true });
    else if (k === 'texts') post('/api/sms', { show: true });
    else if (k === 'instagram') post('/api/insta', { show: true });
    else if (k === 'music') post('/api/music', { show: true });
    else if (k === 'help') post('/api/help', { show: true });
    else if (k === 'home') post('/api/ha', { show: true });
    else if (k === 'cameras' && lastCameras.length) post('/api/camera', { id: lastCameras[0].id });
    return;
  }
  const apin = ev.target.closest('[data-apppin]');
  if (apin) { const a = (lastApps || []).find((x) => x.id === apin.dataset.apppin); post('/api/apps/dock', { id: apin.dataset.apppin, inDock: !(a && a.inDock) }); return; }
  const aadd = ev.target.closest('[data-appadd]');
  if (aadd) { post('/api/apps/add', { id: aadd.dataset.appadd }); return; }
  const ago2 = ev.target.closest('[data-appgo]');
  if (ago2) { const a = (lastApps || []).find((x) => x.id === ago2.dataset.appgo); if (a && a.target && APP_TARGETS[a.target]) APP_TARGETS[a.target](); return; }
  const aopen = ev.target.closest('[data-appopen]');
  if (aopen) { post('/api/app', { id: aopen.dataset.appopen }); return; }
  if (ev.target.closest('#appsCustom')) { post('/api/action', { kind: 'apps-custom' }); return; }
  if (ev.target.closest('#appsBuild')) { post('/api/action', { kind: 'apps-build' }); return; }
  const aback = ev.target.closest('#appBackApps');
  if (aback) { post('/api/app', { clear: true }); post('/api/apps', { show: true }); return; }
  const anav = ev.target.closest('#boardNav button.app-nav');
  if (anav) { post('/api/app', { id: anav.dataset.appid }); return; }
  const acard = ev.target.closest('[data-appid]');
  if (acard) { post('/api/app', { id: acard.dataset.appid }); return; }
  if (ev.target.closest('#netRefresh')) { post('/api/action', { kind: 'network-refresh' }); return; }
  if (ev.target.closest('#netWol')) { post('/api/action', { kind: 'network-wol' }); return; }
  if (ev.target.closest('#paperBuild')) { post('/api/action', { kind: 'paper-build' }); return; }
  if (ev.target.closest('#paperPrint')) { post('/api/action', { kind: 'paper-print' }); return; }
  if (ev.target.closest('#paperRead')) { paperPdfOpen = !paperPdfOpen; lastPaperSig = ''; if (lastSnap) renderPaper(lastSnap); return; }
  if (ev.target.closest('#touchClose')) { hideAllOverlays(); return; }
  const qc = ev.target.closest('#queue .qcard');
  if (qc) {
    const n = [...document.querySelectorAll('#queue .qcard')].indexOf(qc) + 1;
    if (n >= 1) post('/api/focus', { n });
    return;
  }
  const smp = ev.target.closest('#smsList .fb-post');
  if (smp) { post('/api/action', { kind: 'sms-open', n: Number(smp.dataset.smsn) }); return; }
  const igp = ev.target.closest('#igList .fb-post');
  if (igp) { post('/api/action', { kind: 'insta-open', n: Number(igp.dataset.ign) }); return; }
  const mgp = ev.target.closest('#mgList .fb-post');
  if (mgp) { post('/api/action', { kind: 'messenger-open', n: Number(mgp.dataset.mgn) }); return; }
  const fp = ev.target.closest('#fbPosts .fb-post');
  if (fp) {
    post('/api/action', { kind: 'facebook-read', n: Number(fp.dataset.fbn), scope: fp.dataset.scope || 'feed' });
    return;
  }
  const br = ev.target.closest('#fbBirthdays .fb-bday-row');
  if (br) { post('/api/action', { kind: 'birthday-draft', n: Number(br.dataset.bn), name: br.dataset.bname }); return; }
  const gr2 = ev.target.closest('#fbGroups .fb-group');
  if (gr2) { post('/api/action', { kind: 'group-open', n: Number(gr2.dataset.gn), name: gr2.dataset.gname }); return; }
  const tr = ev.target.closest('#textsList .trow');
  if (tr) {
    const rows = [...document.querySelectorAll('#textsList .trow')];
    const qn = lastCards.filter((c) => c.kind === 'suggestion' && c.status === 'open').length;
    post('/api/texts/highlight', { id: tr.dataset.tid });
    post('/api/action', { kind: 'text-show', n: qn + rows.indexOf(tr) + 1, id: tr.dataset.tid });
    return;
  }
  const chip = ev.target.closest('.cal-view-chip');
  if (chip) {
    const v = ['days30', 'week', 'day'][[...document.querySelectorAll('.cal-view-chip')].indexOf(chip)];
    if (v) post('/api/calendar', { view: v, show: true });
    return;
  }
  const cell = ev.target.closest('.cal-cell');
  if (cell) {
    const d = calCellDate(cell);
    if (d) post('/api/calendar', { view: 'day', date: d, show: true });
    return;
  }
  const mr = ev.target.closest('#mailList .mrow');
  if (mr) {
    const n = [...document.querySelectorAll('#mailList .mrow')].indexOf(mr) + 1;
    if (n >= 1) post('/api/mail', { n });
    return;
  }
  const pk = ev.target.closest('#musicPicks .mpick');
  if (pk) {
    const i = [...document.querySelectorAll('#musicPicks .mpick')].indexOf(pk);
    const pick = ((lastMusic && lastMusic.picks) || [])[i];
    if (pick) {
      post('/api/action', { kind: 'music-play', uri: pick.uri, title: pick.title });
      pk.classList.add('tapped');
      setTimeout(() => pk.classList.remove('tapped'), 1400);
    }
    return;
  }
});
$('btnFocusSend').addEventListener('click', () => {
  const card = lastCards.find((c) => c.id === lastFocusId);
  if (!card) return;
  post('/api/action', { kind: 'card-send', cardId: card.id, n: queuePos(card.id), title: card.title });
  flashBtn($('btnFocusSend'), 'ASKING COSMO...');
});
$('btnFocusSkip').addEventListener('click', () => { if (lastFocusId != null) post('/api/resolve', { id: lastFocusId, action: 'skipped' }); });
$('btnFocusHold').addEventListener('click', () => { if (lastFocusId != null) post('/api/resolve', { id: lastFocusId, action: 'held' }); });
$('btnFocusBack').addEventListener('click', () => post('/api/focus', { clear: true }));
function camStep(dir) {
  if (!lastCameras.length || !lastCameraView) return;
  const idx = lastCameras.findIndex((c) => c.id === lastCameraView.cameraId);
  const nxt = lastCameras[(idx + dir + lastCameras.length) % lastCameras.length];
  if (!nxt) return;
  if (lastCameraView.identify) post('/api/camera', { id: nxt.id, identify: lastCameraView.identify });
  else post('/api/camera', { id: nxt.id });
}
$('btnCamPrev').addEventListener('click', () => camStep(-1));
$('btnCamNext').addEventListener('click', () => camStep(1));
$('btnCamYes').addEventListener('click', () => {
  const cv = lastCameraView;
  if (!cv || !cv.identify) return;
  post('/api/camera/alias', { id: cv.cameraId, alias: cv.identify });
  setTimeout(() => post('/api/camera', { id: cv.cameraId }), 200);
});
$('btnMailBack').addEventListener('click', () => post('/api/mail', { show: true }));
$('btnMailSend').addEventListener('click', () => {
  const n = lastMailView && lastMailView.focusN;
  const em = n != null ? (lastInbox.emails || [])[n - 1] : null;
  if (!em || !em.draft) { flashBtn($('btnMailSend'), 'NO DRAFT YET'); return; }
  post('/api/action', { kind: 'mail-send', n, subject: em.subject || '' });
  flashBtn($('btnMailSend'), 'ASKING COSMO...');
});
for (const [id, kind] of [['btnMusPrev', 'music-prev'], ['btnMusToggle', 'music-toggle'], ['btnMusNext', 'music-next'], ['btnMusVolDown', 'music-vol-down'], ['btnMusVolUp', 'music-vol-up']]) {
  $(id).addEventListener('click', () => { post('/api/action', { kind }); flashBtn($(id), 'ASKING COSMO...'); });
}
// Touch/drag pauses the auto-scroll on whatever was grabbed.
for (const [el, sc] of [[$('queue'), queueScroller], [$('stream'), streamScroller], [document.querySelector('.focus-card'), focusScroller], [$('mailList'), mailListScroller], [$('mailThreadWrap'), mailThreadScroller], [$('helpBody'), helpScroller], [$('musicPicks'), musicScroller]]) {
  if (el && sc) el.addEventListener('pointerdown', () => { sc.waitUntil = Date.now() + 25000; }, { passive: true });
}
// Keep the touch chrome in sync with what's on screen.
setInterval(() => {
  const vis = (id) => !$(id).classList.contains('hidden');
  const any = vis('helpOverlay') || vis('mailOverlay') || vis('musicOverlay') || vis('camOverlay') || vis('calOverlay') || vis('focusOverlay') || vis('weatherOverlay') || vis('homeOverlay') || vis('imageOverlay') || vis('facebookOverlay') || vis('messengerOverlay') || vis('smsOverlay') || vis('instaOverlay') || vis('appsOverlay') || vis('appOverlay') || vis('paperOverlay') || vis('networkOverlay');
  $('touchClose').classList.toggle('hidden', !any);
  $('boardNav').style.display = any ? 'none' : 'flex';
  const card = lastFocusId != null ? lastCards.find((c) => c.id === lastFocusId) : null;
  $('focusActions').classList.toggle('hidden', !(vis('focusOverlay') && card && card.kind === 'suggestion' && card.status === 'open'));
  const mFocus = !!(lastMailView && lastMailView.focusN != null);
  $('mailActions').classList.toggle('hidden', !(vis('mailOverlay') && mFocus));
  if (mFocus) {
    const em = (lastInbox.emails || [])[lastMailView.focusN - 1];
    $('btnMailSend').classList.toggle('disabled', !(em && em.draft));
  }
  $('btnCamYes').classList.toggle('hidden', !(vis('camOverlay') && lastCameraView && lastCameraView.identify));
  $('camBar').classList.toggle('hidden', !vis('camOverlay'));
  const openMap = { calendar: 'calOverlay', mail: 'mailOverlay', music: 'musicOverlay', cameras: 'camOverlay', home: 'homeOverlay', help: 'helpOverlay', facebook: 'facebookOverlay', messenger: 'messengerOverlay', texts: 'smsOverlay', instagram: 'instaOverlay', apps: 'appsOverlay' };
  for (const btn of document.querySelectorAll('#boardNav button[data-nav]')) btn.classList.toggle('active', vis(openMap[btn.dataset.nav] || ''));
}, 500);

// ---- Left rail: mini calendar + upcoming events + inbox preview ----
let lastRailSig = '';
function shortFrom(f) {
  const t = String(f || '').replace(/<[^>]*>/g, ' ').replace(/"/g, '').trim();
  return t.split(/\s+/).slice(0, 2).join(' ') || 'Unknown';
}
function renderRail() {
  const cal = lastCalendar;
  const emails = (lastInbox && lastInbox.emails) || [];
  const today = new Date();
  const todayS = dstr(today);
  const sig = [(cal ? (cal.anchor || '') + ':' + ((cal.events || []).length) : 'nocal'), (lastInbox && lastInbox.updatedAt) || '', emails.length, todayS].join('|');
  if (sig === lastRailSig) return;
  lastRailSig = sig;
  const byDate = {};
  if (cal) for (const e of cal.events || []) (byDate[e.date] = byDate[e.date] || []).push(e);
  const y = today.getFullYear(), mo = today.getMonth();
  $('railCalMonth').textContent = MONTHS[mo].toUpperCase() + ' ' + y;
  const first = new Date(y, mo, 1);
  const start = addDays(first, -first.getDay());
  let gh = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const ds = dstr(d);
    gh += '<div class="rail-day' + (d.getMonth() === mo ? '' : ' dim') + (ds === todayS ? ' today' : '') + '" data-date="' + ds + '"><span>' + d.getDate() + '</span>' + (byDate[ds] ? '<span class="dot"></span>' : '') + '</div>';
  }
  $('railCalGrid').innerHTML = gh;
  const ups = [];
  if (cal) for (const e of cal.events || []) if (e.date >= todayS) ups.push(e);
  ups.sort((a, b) => (a.date + ' ' + (a.start || '')).localeCompare(b.date + ' ' + (b.start || '')));
  $('railCalEvents').innerHTML = ups.length
    ? ups.slice(0, 4).map((e) => '<div class="rail-ev"><span class="rail-ev-day">' + esc(e.date === todayS ? 'TODAY' : fmtDay(parseD(e.date))) + '</span><b>' + esc(e.allDay ? 'ALL DAY' : (e.start || '')) + '</b>' + esc(e.title || '') + '</div>').join('')
    : '<div class="rail-empty">Nothing coming up.</div>';
  const unread = emails.filter((e) => e.unread).length;
  $('railMailCount').textContent = emails.length ? emails.length + ' \u00B7 ' + unread + ' NEW' : '';
  $('railMail').innerHTML = emails.length
    ? emails.slice(0, 6).map((e, i) => '<div class="rail-mrow" data-n="' + (i + 1) + '"><span class="rdot"' + (e.unread ? '' : ' style="visibility:hidden"') + '></span><span class="rf">' + esc(shortFrom(e.from)) + '</span><span class="rs">' + esc(e.subject || '(no subject)') + '</span></div>').join('')
    : '<div class="rail-empty">Inbox is empty.</div>';
}
document.addEventListener('click', (ev) => {
  const rd = ev.target.closest('.rail-day');
  if (rd && rd.dataset.date) { post('/api/calendar', { view: 'day', date: rd.dataset.date, show: true }); return; }
  const rm = ev.target.closest('.rail-mrow');
  if (rm) {
    const n = +rm.dataset.n;
    post('/api/mail', { show: true });
    setTimeout(() => post('/api/mail', { n }), 150);
    return;
  }
  if (ev.target.closest('#railWxPanel')) { post('/api/weather', { show: true }); return; }
  if (ev.target.closest('#railCalPanel')) { post('/api/calendar', { show: true }); return; }
  if (ev.target.closest('#railMailPanel')) { post('/api/mail', { show: true }); return; }
});

// ---- Weather: rail panel + forecast overlay ----
const WX = { 0: ['\u2600\uFE0F', 'Clear'], 1: ['\uD83C\uDF24\uFE0F', 'Mostly clear'], 2: ['\u26C5', 'Partly cloudy'], 3: ['\u2601\uFE0F', 'Overcast'], 45: ['\uD83C\uDF2B\uFE0F', 'Fog'], 48: ['\uD83C\uDF2B\uFE0F', 'Fog'], 51: ['\uD83C\uDF26\uFE0F', 'Light drizzle'], 53: ['\uD83C\uDF26\uFE0F', 'Drizzle'], 55: ['\uD83C\uDF26\uFE0F', 'Drizzle'], 56: ['\uD83C\uDF27\uFE0F', 'Freezing drizzle'], 57: ['\uD83C\uDF27\uFE0F', 'Freezing drizzle'], 61: ['\uD83C\uDF26\uFE0F', 'Light rain'], 63: ['\uD83C\uDF27\uFE0F', 'Rain'], 65: ['\uD83C\uDF27\uFE0F', 'Heavy rain'], 66: ['\uD83C\uDF27\uFE0F', 'Freezing rain'], 67: ['\uD83C\uDF27\uFE0F', 'Freezing rain'], 71: ['\uD83C\uDF28\uFE0F', 'Light snow'], 73: ['\u2744\uFE0F', 'Snow'], 75: ['\u2744\uFE0F', 'Heavy snow'], 77: ['\uD83C\uDF28\uFE0F', 'Snow grains'], 80: ['\uD83C\uDF26\uFE0F', 'Light showers'], 81: ['\uD83C\uDF27\uFE0F', 'Showers'], 82: ['\uD83C\uDF27\uFE0F', 'Heavy showers'], 85: ['\uD83C\uDF28\uFE0F', 'Snow showers'], 86: ['\uD83C\uDF28\uFE0F', 'Snow showers'], 95: ['\u26C8\uFE0F', 'Thunderstorm'], 96: ['\u26C8\uFE0F', 'Thunderstorm + hail'], 99: ['\u26C8\uFE0F', 'Thunderstorm + hail'] };
function wxInfo(code) { return WX[code] || ['\uD83C\uDF21\uFE0F', '']; }
let lastWxPanelSig = '';
function renderWxPanel() {
  const w = lastWeather;
  const sig = w ? (w.updatedAt || '') : 'none';
  if (sig === lastWxPanelSig) return;
  lastWxPanelSig = sig;
  if (!w || !w.current) {
    $('railWxTemp').textContent = '--';
    $('railWxCond').textContent = 'Weather unavailable';
    return;
  }
  const info = wxInfo(w.current.code);
  const d0 = (w.daily || [])[0] || {};
  $('railWxPlace').textContent = (w.place || '').toUpperCase();
  $('railWxIcon').textContent = info[0];
  $('railWxTemp').textContent = w.current.temp + '\u00B0';
  $('railWxCond').textContent = info[1];
  $('railWxHiLo').textContent = 'H ' + (d0.hi != null ? d0.hi + '\u00B0' : '--') + '  L ' + (d0.lo != null ? d0.lo + '\u00B0' : '--');
  $('railWxMeta').textContent = 'Feels ' + w.current.feels + '\u00B0 \u00B7 Wind ' + w.current.wind + ' mph \u00B7 Humidity ' + w.current.humidity + '%' + (d0.precip != null ? ' \u00B7 Rain ' + d0.precip + '%' : '');
}
let lastWxSig = '';
function renderWeather() {
  const ov = $('weatherOverlay');
  if (!lastWeatherView || !lastWeatherView.visible) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  const w = lastWeather;
  const sig = w ? (w.updatedAt || '') : 'none';
  if (sig === lastWxSig) return;
  lastWxSig = sig;
  if (!w || !w.current) {
    $('wxTitle').textContent = 'WEATHER';
    $('wxNowTemp').textContent = '--';
    $('wxNowCond').textContent = 'Weather data has not loaded yet.';
    $('wxHours').innerHTML = '';
    $('wxDays').innerHTML = '';
    return;
  }
  const info = wxInfo(w.current.code);
  const d0 = (w.daily || [])[0] || {};
  $('wxTitle').textContent = '\uD83C\uDF24\uFE0F ' + (w.place || 'WEATHER').toUpperCase();
  $('wxUpd').textContent = w.updatedAt ? 'UPDATED ' + new Date(w.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  $('wxNowIcon').textContent = info[0];
  $('wxNowTemp').textContent = w.current.temp + '\u00B0F';
  $('wxNowCond').textContent = info[1];
  $('wxNowMeta').textContent = 'Feels like ' + w.current.feels + '\u00B0 \u00B7 Today H ' + (d0.hi != null ? d0.hi + '\u00B0' : '--') + ' / L ' + (d0.lo != null ? d0.lo + '\u00B0' : '--') + ' \u00B7 Wind ' + w.current.wind + ' mph \u00B7 Humidity ' + w.current.humidity + '%' + (d0.precip != null ? ' \u00B7 Rain chance ' + d0.precip + '%' : '');
  $('wxHours').innerHTML = (w.hourly || []).map((h) => {
    const hi = wxInfo(h.code);
    return '<div class="wx-hour"><div class="wx-hour-t">' + esc(h.label) + '</div><div class="wx-hour-i">' + hi[0] + '</div><div class="wx-hour-temp">' + h.temp + '\u00B0</div>' + (h.precip ? '<div class="wx-hour-p">\uD83D\uDCA7 ' + h.precip + '%</div>' : '<div class="wx-hour-p dim">-</div>') + '</div>';
  }).join('');
  $('wxDays').innerHTML = (w.daily || []).map((d) => {
    const di = wxInfo(d.code);
    return '<div class="wx-day"><span class="wx-day-n">' + esc(d.label) + '</span><span class="wx-day-c">' + di[0] + ' ' + esc(di[1]) + '</span><span class="wx-day-p">' + (d.precip ? '\uD83D\uDCA7 ' + d.precip + '%' : '') + '</span><span class="wx-day-t"><span class="lo">' + d.lo + '\u00B0</span> \u2192 <span class="hi">' + d.hi + '\u00B0</span></span></div>';
  }).join('');
}

// ---- Home Assistant control overlay ----
const HA_ICONS = { switch: '\uD83D\uDD0C', light: '\uD83D\uDCA1', automation: '\uD83E\uDD16', media_player: '\uD83C\uDFB5', climate: '\uD83C\uDF21\uFE0F', fan: '\uD83C\uDF00', cover: '\uD83E\uDE9F', lock: '\uD83D\uDD12', scene: '\uD83C\uDFAC', script: '\uD83D\uDCDC', schedule: '\uD83D\uDDD3\uFE0F', timer: '\u23F1\uFE0F', input_boolean: '\uD83D\uDD18' };
const HA_GROUPS = [['light', 'LIGHTS'], ['switch', 'SWITCHES'], ['media_player', 'MEDIA'], ['climate', 'CLIMATE'], ['fan', 'FANS'], ['cover', 'COVERS'], ['lock', 'LOCKS'], ['automation', 'AUTOMATIONS'], ['schedule', 'SCHEDULES'], ['timer', 'TIMERS'], ['scene', 'SCENES'], ['script', 'SCRIPTS'], ['input_boolean', 'HELPERS']];
let homeEntities = null;
let homeHidden = [];
let showHidden = false;
let homeFetchAt = 0;
let homeBusy = false;
async function fetchHome(force) {
  if (homeBusy) return;
  if (!force && homeEntities && Date.now() - homeFetchAt < 7000) return;
  homeBusy = true;
  try {
    const r = await fetch('/api/ha/entities');
    const d = await r.json();
    if (d.entities) { homeEntities = d.entities; homeFetchAt = Date.now(); paintHome(); }
  } catch (e) { /* HA unreachable: keep last paint */ }
  homeBusy = false;
}
let homeSig = '';
function paintHome() {
  const box = $('homeGroups');
  const sig = (homeEntities || []).map((e) => e.id + '=' + e.state).join('|') + '#' + homeHidden.join(',') + '#' + showHidden;
  if (sig === homeSig && box.innerHTML) return;
  homeSig = sig;
  if (!homeEntities) { box.innerHTML = '<div class="rail-empty">Loading devices...</div>'; return; }
  const hid = homeEntities.filter((e) => homeHidden.includes(e.id));
  $('homeUpd').textContent = (homeEntities.length - hid.length) + ' DEVICES \u00B7 UPDATED ' + new Date(homeFetchAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  let html = '';
  for (const [dom, label] of HA_GROUPS) {
    const rows = homeEntities.filter((e) => e.domain === dom && !homeHidden.includes(e.id));
    if (!rows.length) continue;
    html += '<div class="home-sec">' + label + '</div><div class="home-grid">';
    for (const e of rows) html += tileHtml(e, dom, false);
    html += '</div>';
  }
  if (hid.length) {
    html += '<button class="home-hidden-toggle" id="homeHiddenToggle">HIDDEN (' + hid.length + ')' + (showHidden ? ' - TAP TO COLLAPSE' : ' - TAP TO SHOW') + '</button>';
    if (showHidden) html += '<div class="home-grid">' + hid.map((e) => tileHtml(e, e.domain, true)).join('') + '</div>';
  }
  box.innerHTML = html || '<div class="rail-empty">No controllable devices found.</div>';
}
function tileHtml(e, dom, isHidden) {
  const onish = e.state === 'on' || e.state === 'playing' || e.state === 'open' || e.state === 'unlocked';
  return '<button class="ha-tile' + (onish ? ' on' : '') + (isHidden ? ' hid' : '') + '" data-eid="' + esc(e.id) + '"><span class="ha-ic">' + (HA_ICONS[dom] || '\uD83D\uDD18') + '</span><span class="ha-nm">' + esc(e.name) + '</span><span class="ha-st">' + esc(String(e.state).toUpperCase()) + '</span></button>';
}
function renderHome() {
  const ov = $('homeOverlay');
  if (!lastHomeView || !lastHomeView.visible) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  fetchHome(false);
}
setInterval(() => { if (lastHomeView && lastHomeView.visible) fetchHome(false); }, 4000);
document.addEventListener('click', async (ev) => {
  const htg = ev.target.closest('#homeHiddenToggle');
  if (htg) { showHidden = !showHidden; homeSig = ''; paintHome(); return; }
  const tile = ev.target.closest('.ha-tile');
  if (!tile) return;
  if (suppressClick) { suppressClick = false; return; }
  tile.classList.add('busy');
  try {
    const r = await post('/api/ha/control', { id: tile.dataset.eid, action: 'toggle' });
    if (r && r.json) {
      const d = await r.json().catch(() => null);
      if (d && d.entity && homeEntities) {
        const i = homeEntities.findIndex((e) => e.id === d.entity.id);
        if (i >= 0) homeEntities[i] = d.entity;
        homeSig = '';
        paintHome();
      }
    }
    homeFetchAt = 0;
    await fetchHome(true);
  } catch (e) {}
  tile.classList.remove('busy');
});

// ---- Long-press a tile: pop-up to remove it from this screen (or restore) ----
let suppressClick = false;
let haPopFor = null;
let haPopHidden = false;
function openHaPop(eid) {
  const e = (homeEntities || []).find((x) => x.id === eid);
  if (!e) return;
  haPopFor = eid;
  haPopHidden = homeHidden.includes(eid);
  $('haPopName').textContent = e.name;
  $('haPopQ').textContent = haPopHidden ? 'Put this back on the Home screen?' : 'Remove this from the Home screen?';
  $('haPopYes').textContent = haPopHidden ? 'RESTORE' : 'REMOVE';
  $('haPop').classList.remove('hidden');
}
function closeHaPop() { haPopFor = null; $('haPop').classList.add('hidden'); }
$('haPopNo').addEventListener('click', closeHaPop);
$('haPopYes').addEventListener('click', async () => {
  if (!haPopFor) return;
  const id = haPopFor;
  const wasHidden = haPopHidden;
  closeHaPop();
  if (wasHidden) homeHidden = homeHidden.filter((x) => x !== id);
  else if (!homeHidden.includes(id)) homeHidden.push(id);
  homeSig = '';
  paintHome();
  await post(wasHidden ? '/api/ha/unhide' : '/api/ha/hide', { id });
});
let pressTimer = null;
let pressX = 0;
let pressY = 0;
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target.closest('.ha-tile');
  if (!t) return;
  homeScroller.waitUntil = Date.now() + 25000;
  pressX = ev.clientX;
  pressY = ev.clientY;
  const eid = t.dataset.eid;
  pressTimer = setTimeout(() => { suppressClick = true; openHaPop(eid); }, 550);
}, { passive: true });
document.addEventListener('pointermove', (ev) => {
  if (pressTimer && (Math.abs(ev.clientX - pressX) > 10 || Math.abs(ev.clientY - pressY) > 10)) { clearTimeout(pressTimer); pressTimer = null; }
}, { passive: true });
for (const evt of ['pointerup', 'pointercancel']) document.addEventListener(evt, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });
document.addEventListener('contextmenu', (ev) => { if (ev.target.closest('#homeOverlay')) ev.preventDefault(); });

// Music device picker: tapping a device asks the session to move playback there.
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('.mdev');
  if (!b) return;
  post('/api/action', { kind: 'music-device', id: b.dataset.did, name: b.dataset.dname });
});
