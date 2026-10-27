#!/usr/bin/env python3
"""Tier-2 quick answers for cosmo-listener (the box) - Muse Spark.

When the local Llama router (tier 1) cannot route a command, this tier
tries to answer a QUICK FACTUAL QUESTION from a compact digest of the
board state, using Meta's Muse Spark via the Model API. It can only
answer - never act. If the answer is not fully contained in the digest,
the model must reply FALLTHROUGH and the caller dispatches to the cloud
Claude session exactly as before.

The API key is read per call from meta_api_key_path in config.json
(default ~/.config/cosmo-voice/meta_api_key, 0600, Server-2-only). No key
or any error -> None (fall through). Answers are never cached.
"""
import json, re, subprocess, sys, urllib.request
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
STATE_URL = 'http://127.0.0.1:3180/api/state'
API_URL = 'https://api.meta.ai/v1/chat/completions'
MODEL = 'muse-spark-1.3'
WX = {0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'foggy', 48: 'foggy',
      51: 'light drizzle', 53: 'drizzle', 55: 'drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
      71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'showers', 81: 'showers', 82: 'heavy showers',
      95: 'thunderstorms'}

SYSTEM = (
    'You are the quick-answer voice of a home display board. Answer the question using ONLY the STATE below. '
    'One short sentence, at most 25 words, plain spoken words, no lists, no markdown. '
    'If the answer is not fully contained in the STATE, reply with exactly FALLTHROUGH and nothing else. '
    'Never guess, never use outside knowledge, never offer to do anything. Quantities listed as conversations with unread messages ARE the count of unread conversations - answer count questions with them directly.'
)

def _cfg():
    try:
        return json.loads((BASE / 'config.json').read_text())
    except Exception:
        return {}

def _key():
    p = Path(_cfg().get('meta_api_key_path', '~/.config/cosmo-voice/meta_api_key')).expanduser()
    try:
        return p.read_text().strip()
    except Exception:
        return ''

def build_digest(state):
    today = datetime.now().strftime('%Y-%m-%d')
    lines = ['Now: ' + datetime.now().strftime('%A %B %d, %I:%M %p')]
    w = state.get('weather') or {}
    cur = w.get('current') or {}
    if cur:
        daily = (w.get('daily') or [{}])[0]
        lines.append('Weather in %s: %dF, feels %dF, %s, wind %d mph; today high %s low %s.' % (
            w.get('place', ''), cur.get('temp', 0), cur.get('feels', 0), WX.get(cur.get('code'), 'fair'),
            cur.get('wind', 0), daily.get('hi', '?'), daily.get('lo', '?')))
    cal = state.get('calendar') or {}
    evs = [e for e in cal.get('events', []) if e.get('date') == today]
    if evs:
        lines.append('On the calendar today: ' + '; '.join(
            (e.get('title', '') + ((' at ' + e['start']) if e.get('start') else ' (all day)')) for e in evs[:6]) + '.')
    else:
        lines.append('On the calendar today: nothing.')
    inbox = state.get('inbox') or {}
    emails = inbox.get('emails', [])
    unread = [e for e in emails if e.get('unread')]
    lines.append('Email: %d in the inbox list, %d unread.' % (len(emails), len(unread)))
    if unread:
        lines.append('Newest unread: ' + '; '.join(
            '%s - %s' % (re.sub(r'<[^>]+>', '', e.get('from', '')).strip().strip('"'), e.get('subject', '')) for e in unread[:3]) + '.')
    sms = state.get('sms') or {}
    sthr = sms.get('threads', [])
    sun = sum(1 for t in sthr if t.get('unread'))
    msg = state.get('messenger') or {}
    mthr = msg.get('threads', [])
    mun = sum(1 for t in mthr if t.get('unread'))
    lines.append('Text messages (SMS): %d conversations, %d conversations with unread messages. Messenger: %d conversations, %d conversations with unread messages.' % (len(sthr), sun, len(mthr), mun))
    cards = [c for c in state.get('cards', []) if c.get('status') in ('open', None)]
    lines.append('Items waiting on the board: %d.' % len(cards))
    for c in cards[:4]:
        lines.append('- ' + str(c.get('title', '')))
    return '\n'.join(lines)

def try_answer(command):
    """Return a one-sentence answer string, or None to fall through."""
    key = _key()
    if not key:
        return None
    try:
        with urllib.request.urlopen(STATE_URL, timeout=6) as r:
            state = json.loads(r.read())
        digest = build_digest(state)
        body = {'model': MODEL, 'max_tokens': 2000,
                'messages': [{'role': 'system', 'content': SYSTEM + '\n\nSTATE:\n' + digest},
                             {'role': 'user', 'content': command}]}
        req = urllib.request.Request(API_URL, data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json',
                                              'Authorization': 'Bearer ' + key})
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read())
        text = (d['choices'][0]['message']['content'] or '').strip()
    except Exception:
        return None
    if not text or 'FALLTHROUGH' in text.upper() or len(text) > 300:
        return None
    return text

if __name__ == '__main__':
    print(json.dumps(try_answer(' '.join(sys.argv[1:]))))
