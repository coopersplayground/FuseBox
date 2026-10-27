#!/usr/bin/env python3
"""Local command router for cosmo-listener (Server 2).

Classifies a voice transcript with the local Llama 3.2 3B (Ollama) and,
for a small set of board DISPLAY commands, executes them locally via
ui.py - no wake of the cloud Muse session. Anything else returns None
and the caller dispatches to Muse exactly as before.

Safety: the router can only show/hide board views. It cannot send,
resolve, draft, or change device/playback state. The executor speaks a
short canned confirmation for opens (matching the session's wording),
and stays silent for hide and direct camera matches (the owner's rules).
"""
import json, re, subprocess, sys, urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
OLLAMA = 'http://127.0.0.1:11434/api/generate'
MODEL = 'llama3.2:3b'

SYSTEM = (
    'You route voice commands for a home display board. Reply with ONLY a JSON object, no other text.\n'
    'Routes:\n'
    '{"action":"hide"} - back to the board / close / go back / never mind\n'
    '{"action":"open","app":X} - X one of: calendar, email, music, facebook, messenger, texts, instagram, apps, newspaper, network, weather, home - for requests to open or show that app or page\n'
    '{"action":"camera","target":NAME} - to show a camera; NAME one of: shop, driveway, microscope\n'
    '{"action":"none"} - anything else: questions, requests to send, draft, reply, read, play or pause music, show a numbered item, control devices, tell a story, general conversation\n'
    'Questions are NOT opens: a question about content (anything starting with what, who, is there, are there, do i, did, when, why, how) is a none, even if it names an app - "is there anything important in my email" is a none.\n'
    'Speech recognition makes mistakes: "paul\'s the music" means pause the music (that is a none - music control is not routed), "shop camp" means the shop camera.\n'
    'Examples:\n'
    '"open my messages" -> {"action":"open","app":"texts"}\n'
    '"show me the shop camp" -> {"action":"camera","target":"shop"}\n'
    '"what is on my calendar tomorrow" -> {"action":"none"}\n'
    '"play some music" -> {"action":"none"}\n'
    '"send it" -> {"action":"none"}\n'
    '"who is at the door" -> {"action":"none"}'
)

APPS = {'calendar', 'email', 'music', 'facebook', 'messenger', 'texts',
        'instagram', 'apps', 'newspaper', 'network', 'weather', 'home'}
CAMERAS = {'shop', 'driveway', 'microscope'}

OPEN_CMD = {
    'calendar': ['calendar-open'], 'email': ['mail-open'], 'music': ['music-open'],
    'facebook': ['facebook-open'], 'messenger': ['messenger-open'], 'texts': ['sms-open'],
    'instagram': ['insta-open'], 'apps': ['apps-open'], 'newspaper': ['paper-open'],
    'network': ['network-open'], 'weather': ['weather-open'], 'home': ['home-open'],
}
OPEN_SAY = {
    'calendar': 'Your calendar is on screen.', 'email': 'Your email is on screen.',
    'music': 'Your music is on screen.', 'facebook': 'Facebook is on screen.',
    'messenger': 'Your Messenger chats are on screen.', 'texts': 'Your text messages are on screen.',
    'instagram': 'Instagram is on screen.', 'apps': 'Your apps are on screen.',
    'newspaper': 'The newspaper is on screen.', 'network': 'The network page is on screen.',
    'weather': 'The weather is on screen.', 'home': 'Home controls are on screen.',
}

def classify(text):
    """Return a validated route dict, or None to fall through to Muse."""
    body = {'model': MODEL, 'system': SYSTEM, 'prompt': text, 'stream': False,
            'options': {'temperature': 0, 'num_ctx': 4096}}
    try:
        req = urllib.request.Request(OLLAMA, data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read()).get('response', '')
    except Exception:
        return None
    m = re.search(r'\{.*\}', resp, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except Exception:
        return None
    a = d.get('action')
    if a == 'hide':
        return {'action': 'hide'}
    if a == 'open' and d.get('app') in APPS:
        return {'action': 'open', 'app': d['app']}
    if a == 'camera' and str(d.get('target', '')).lower() in CAMERAS:
        return {'action': 'camera', 'target': str(d['target']).lower()}
    return None

def _run(args, timeout=20):
    r = subprocess.run([sys.executable, str(BASE / 'ui.py')] + args,
                       capture_output=True, text=True, timeout=timeout)
    return r.stdout or ''

def _speak(text):
    subprocess.Popen([str(BASE / 'speak.py'), text],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def execute(route):
    """Carry out a validated route locally. Returns a short log line."""
    a = route['action']
    if a == 'hide':
        _run(['hide'])
        return 'hide (silent)'
    if a == 'camera':
        out = _run(['camera', route['target']])
        q = re.search(r"Is this the [^?]+\?", out)
        if q:
            _speak(q.group(0))  # identify mode: speak the question, as the session does
            return 'camera %s (identify question spoken)' % route['target']
        return 'camera %s (direct, silent)' % route['target']
    if a == 'open':
        _run(OPEN_CMD[route['app']])
        return 'open %s (silent)' % route['app']
    return 'unhandled'

if __name__ == '__main__':
    r = classify(' '.join(sys.argv[1:]))
    print(json.dumps(r))
