#!/usr/bin/env node
/*
 * Provision device tokens for the Fuse Box gateway.
 *
 *   node provision.js add <label> [--chat N] [--asr-min N]
 *   node provision.js list
 *   node provision.js disable <id>
 *   node provision.js enable <id>
 *
 * Tokens are shown ONCE, at creation. The gateway stores only SHA-256
 * hashes, so a leaked tokens.json reveals no usable token. The token
 * itself is entered on the box (its own screen) at setup time.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKENS_FILE = process.env.GW_TOKENS_FILE || path.join(__dirname, 'tokens.json');

function load() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return {}; }
}
function save(t) {
  const tmp = TOKENS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(t, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_FILE);
}
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

const [cmd, arg] = process.argv.slice(2);
const flags = {};
for (let i = 4; i + 1 < process.argv.length; i += 2) {
  flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

if (cmd === 'add') {
  if (!arg) { console.error('usage: provision.js add <label> [--chat N] [--asr-min N]'); process.exit(1); }
  const tokens = load();
  const token = 'fbx_' + crypto.randomBytes(32).toString('base64url');
  const id = 'box-' + crypto.randomBytes(4).toString('hex');
  tokens[hash(token)] = {
    id, label: arg, created: new Date().toISOString(), disabled: false,
    caps: {
      chat_per_day: flags.chat ? parseInt(flags.chat, 10) : 2000,
      asr_min_per_day: flags['asr-min'] ? parseFloat(flags['asr-min']) : 600,
    },
  };
  save(tokens);
  console.log('id:    ', id);
  console.log('label: ', arg);
  console.log('token: ', token);
  console.log('\nShown once. Enter it on the box at setup; it is not stored anywhere in plain text.');
} else if (cmd === 'list') {
  const tokens = load();
  const rows = Object.values(tokens);
  if (!rows.length) console.log('(no devices)');
  for (const r of rows) {
    console.log(r.id, '|', r.label, '|', r.disabled ? 'DISABLED' : 'active',
      '| caps: chat/day=' + (r.caps?.chat_per_day ?? '-'), 'asr-min/day=' + (r.caps?.asr_min_per_day ?? '-'),
      '| created ' + (r.created || '?'));
  }
} else if (cmd === 'disable' || cmd === 'enable') {
  const tokens = load();
  let found = false;
  for (const rec of Object.values(tokens)) {
    if (rec.id === arg) { rec.disabled = (cmd === 'disable'); found = true; }
  }
  if (!found) { console.error('no device with id ' + arg); process.exit(1); }
  save(tokens);
  console.log(arg, cmd === 'disable' ? 'disabled' : 'enabled');
} else {
  console.error('commands: add <label> | list | disable <id> | enable <id>');
  process.exit(1);
}
