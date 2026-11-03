#!/usr/bin/env python3
"""Touch-action watcher. Polls cosmo-ui's action outbox and forwards
each tap intent to the voice session via musegadget send-user-msg,
exactly like a spoken command; acks on success. Actions a small local
handler can complete (showing a text thread, printing a list, network
refresh / wake) never leave the box - they are handled here and acked.
The session id is read from cosmo-listener's session-id file - the
same file the listener dispatches to."""
import json, os, subprocess, sys, time, urllib.request

UI = 'http://127.0.0.1:3180'

def _session():
    try:
        return open(os.path.expanduser('~/cosmo-listener/session-id')).read().strip()
    except Exception:
        return ''

SESSION = _session()

def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(UI + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read() or b'{}')

def message_for(a):
    k = a.get('kind')
    if k == 'pc-alert':
        return ("[touch] PC GUARDIAN ALERT: the screen on the owner's laptop looks like a scam. Reason: %s. "
                "Speak a clear warning out loud right away: say it looks like a scam, say the reason "
                "plainly, and tell him not to call any number on that screen and not to click anything. "
                "Then show the laptop screen on the board (ui.py pc-show) and stay with him until it "
                "is resolved." % a.get('why'))
    if k == 'card-send':
        return ("[touch] The owner tapped SEND IT on board item #%s '%s'. Treat it exactly like a voice "
                "'send it' for that item: say the title aloud first, carry out the real action, then resolve it."
                % (a.get('n'), a.get('title')))
    if k == 'mail-send':
        return ("[touch] The owner tapped SEND DRAFT on email #%s '%s'. Send the on-screen draft reply for "
                "that email (say the subject aloud first), then resolve the email."
                % (a.get('n'), a.get('subject')))
    if k == 'music-play':
        return ("[touch] The owner tapped '%s' on the music screen. Play it on Spotify on the CURRENTLY "
                "active device - do not move the session to another speaker; if no device is active, "
                "start it on the Cosmo speaker in the room. Then refresh the music overlay." % a.get('title'))
    if k == 'music-device':
        return ("[touch] The owner tapped the device '%s' on the music screen. Move Spotify playback to "
                "that device (transfer only - keep the same music playing), then refresh the music "
                "overlay showing the true device." % a.get('name'))
    if k == 'music-toggle':
        return ("[touch] The owner tapped play/pause on the music screen. Toggle Spotify playback (pause "
                "if playing, resume if paused) and refresh the music overlay.")
    if k == 'music-next':
        return "[touch] The owner tapped NEXT TRACK on the music screen. Skip on Spotify and refresh the music overlay."
    if k == 'music-prev':
        return "[touch] The owner tapped PREVIOUS TRACK on the music screen. Go back on Spotify and refresh the music overlay."
    if k == 'music-vol-up':
        return "[touch] The owner tapped VOLUME UP on the music screen. Raise the Spotify volume by about 10 and refresh the music overlay."
    if k == 'music-vol-down':
        return "[touch] The owner tapped VOLUME DOWN on the music screen. Lower the Spotify volume by about 10 and refresh the music overlay."
    if k == 'sms-open':
        return ("[touch] The owner tapped text conversation #%s in the Texts phone. Fetch that SMS "
                "thread from his phone (texts are grouped by address) and open it with "
                "ui.py sms-thread, then read him the latest messages." % a.get('n'))
    if k == 'apps-custom':
        return ("[touch] The owner tapped ADD A CUSTOM CONNECTION on the Apps page. Ask him which "
                "service he wants to connect, then wire it up for him, and once it works add "
                "its card to the Apps page.")
    if k == 'apps-build':
        return ("[touch] The owner tapped BUILD A CUSTOM APP on the Apps page. Ask him what he "
                "wants the app to do, then design and build it with him: it gets a card on the "
                "Apps page and its own page. This page is the home for everything built that way.")
    if k == 'guardian-setup-new':
        return ("[touch] The owner tapped GET A NEW NUMBER in the Guardian app. Set up his phone line: "
                "(1) generate a strong SIP password into a 0600 file on this VM with python secrets, never print it; "
                "(2) telnyx create-sip-connection --name 'Fuse_Box Guardian' --username guard01 --password-file <that file>; "
                "(3) telnyx search-numbers --area-code 570 --limit 5 and pick the first; buy it with telnyx buy-number; "
                "(4) telnyx update-number --id <number id> --connection-id <sip connection id>; "
                "(5) POST the line to the box: {number, sipUser: 'guard01', sipPassword: <the file contents>, sipServer: 'sip.telnyx.com'} to http://127.0.0.1:3180/api/guardian/line - read the password from the file in the same command, do not echo it; "
                "(6) delete the password file on the VM; (7) watch state.guardian on the box until the line is live or the app asks for the adapter password, then tell the owner.")
    if k == 'guardian-numbers':
        return ("[touch] the owner is setting up the Guardian phone and asked for new-number choices. Run "
                "telnyx search-numbers --area-code 570 --limit 6 and POST the phone_numbers list as "
                "{numbers: [...]} to http://127.0.0.1:3180/api/guardian/candidates (via the tailnet proxy). "
                "Do not buy anything yet - she picks one on screen first.")
    if k == 'guardian-pick':
        return ("[touch] In the Guardian setup, the number %s was picked on screen. Buy exactly that number: "
                "telnyx buy-number --phone-number %s --connection-id 3080302941756720360 (the Fuse_Box Guardian "
                "SIP connection), confirm it goes active with telnyx list-numbers, then read the SIP password "
                "from the box flow: POST {number: %s, sipUser: 'guardian11', sipPassword: <current guardian sip "
                "password>, sipServer: 'sip.telnyx.com'} to /api/guardian/line ONLY if the box does not already "
                "hold those credentials; if unsure, tell the owner what you did instead of guessing credentials." % (a.get('number'), a.get('number'), a.get('number')))
    if k == 'guardian-ring':
        return ("[touch] The owner tapped RING MY PHONE in the Guardian app. Place a test call to his Guardian "
                "number (read it from the board state) using telnyx outbound-call --connection-id 3065819485194684005 "
                "--from +12727779215 --to <guardian number>, so his handset rings. Then refresh nothing; just confirm.")
    if k == 'guardian-port':
        return ("[touch] the owner submitted the number-transfer form in the Guardian app. Read state.guardian.porting "
                "on the box and create the port order: telnyx port-order-create --numbers <number in E.164>. Then POST "
                "the resulting status back into state.guardian.porting via /api/guardian/port-status if it exists, else "
                "tell the owner the status and what Telnyx still needs (usually a signed letter of authorization and a "
                "recent bill). Never ask for or repeat the account PIN - it stays on the box.")
    if k == 'paper-build':
        return ("[touch] The owner tapped MAKE A NEW EDITION in the Daily Newspaper app. Build a "
                "fresh edition for today the way The Daily Newspaper is built (fresh news only, "
                "the usual sections), show him the draft first, and refresh the app front page "
                "with ui.py paper when it is ready. Do not print without his go-ahead.")
    if k == 'paper-print':
        return ("[touch] The owner tapped PRINT IT in the Daily Newspaper app. Print the current "
                "edition PDF on the Epson printer (the established Daily Newspaper flow) and "
                "confirm when it is printing.")
    if k == 'insta-open':
        return ("[touch] The owner tapped Instagram post #%s in the Instagram phone. Fetch that "
                "post's comments (instagram-cli fetch-post-comments for its id, which is in the "
                "board state) and open the detail with ui.py insta-post, then read him the "
                "caption and the comments." % a.get('n'))
    if k == 'sms-send':
        return ("[touch] the owner typed a text reply on the board to %s: \"%s\" Send it now to that "
                "SMS conversation from his phone (thread id %s), then clear the board draft "
                "(POST /api/sms/draft with clear on the board) and confirm here that it went."
                % (a.get('name'), a.get('text'), a.get('threadId')))
    if k == 'messenger-open':
        return ("[touch] The owner tapped Messenger conversation #%s. Fetch that conversation's "
                "recent messages (hatch_messenger_cli messages --cid) and open it with "
                "ui.py messenger-thread, then read him the latest messages." % a.get('n'))
    if k == 'birthday-draft':
        return ("[touch] The owner tapped birthday #%s (%s) on the Facebook page. Draft a short warm "
                "happy-birthday wish for them, put it on the board draft (ui.py facebook-draft birthday), "
                "and read it back for his approval - do not send anything yet." % (a.get('n'), a.get('name')))
    if k == 'group-open':
        return ("[touch] The owner tapped group #%s '%s' on the Facebook page. Fetch that group's "
                "posts (facebook-cli groups posts) and open the group feed with ui.py facebook-group, "
                "then tell him what is new in the group." % (a.get('n'), a.get('name')))
    if k == 'facebook-read':
        return ("[touch] The owner tapped Facebook post #%s in the modal. Fetch that post in full "
                "(facebook-cli post read + comments + reactions; its id is in the board state), "
                "push the detail with ui.py facebook-post, then read him the post and its comments. "
                "If a group feed is open, the number refers to that group's post list." % a.get('n'))
    if k == 'text-show':
        return ("[touch] The owner tapped text message #%s on the board - it is already highlighted there. "
                "Run ui.py show %s and read that text to him in full, the same as a voice show."
                % (a.get('n'), a.get('n')))
    if k == 'test':
        return "[touch] Test ping from the touch layer. No action needed; do not speak."
    return "[touch] The owner tapped something on the board: " + json.dumps(a)

SPEAK = '/home/cosmo/cosmo-listener/speak.py'
PRINTER = 'EPSON_ET_2800_Series'

def speak(text):
    r = subprocess.run([SPEAK, text], capture_output=True, text=True, timeout=120)
    return r.returncode == 0

def local_text_show(a):
    # Tier 0: the text is already on the board - just read it aloud here.
    n = int(a.get('n') or 0)
    st = http('GET', '/api/state')
    queue = [c for c in st.get('cards') or [] if c.get('kind') == 'suggestion' and c.get('status') == 'open']
    texts = (st.get('texts') or {}).get('messages') or []
    if n > len(queue):
        ix = n - len(queue) - 1
        row = texts[ix] if 0 <= ix < len(texts) else None
        if row:
            name = row.get('name') or row.get('from') or 'someone'
            body = row.get('text') or row.get('body') or row.get('snippet') or ''
            if body:
                return speak('From %s: %s' % (name, body))
    return False

def local_list_print(a):
    # Tier 0: read the list off the board, print it on the Epson here.
    st = http('GET', '/api/state')
    which = 'shopping' if a.get('list') == 'shopping' else 'todos'
    title = 'Shopping List' if which == 'shopping' else 'To Do'
    items = [t for t in (st.get(which) or []) if not t.get('done')]
    if not items:
        return speak('Your %s is empty. Nothing to print.' % title.lower())
    lines = [title, time.strftime('%A, %B %d, %Y'), '']
    lines += ['[ ] ' + (t.get('text') or '') for t in items]
    with open('/tmp/list-print.txt', 'w') as f:
        f.write('\n'.join(lines) + '\n')
    r = subprocess.run(['lp', '-d', PRINTER, '/tmp/list-print.txt'], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return False
    return speak('Printing your %s.' % title.lower())

def main():
    attempts = {}
    print('touch-actions watcher up', flush=True)
    while True:
        try:
            state = http('GET', '/api/state')
            for a in state.get('actionOutbox') or []:
                aid = a.get('id')
                k = a.get('kind')
                if k == 'msg-send':
                    continue  # VM messages feeder owns board Messenger replies; it acks after sending
                if k in ('network-refresh', 'network-wol'):
                    if k == 'network-refresh':
                        cmd = ['/usr/bin/python3', '/home/cosmo/cosmo-ui/feeders/network-feeder.py', '--once']
                    elif os.path.exists('/home/cosmo/bin/wake-gaming-rig'):
                        cmd = ['/home/cosmo/bin/wake-gaming-rig']
                    else:
                        cmd = ['wakeonlan', '00:11:22:33:44:01']
                    r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
                    print('local action', k, 'rc=%s' % r.returncode, (r.stdout or r.stderr or '')[:160], flush=True)
                    http('POST', '/api/action', {'ack': [aid]})
                    attempts.pop(aid, None)
                    continue
                if k == 'test':
                    http('POST', '/api/action', {'ack': [aid]})
                    attempts.pop(aid, None)
                    continue
                if k in ('text-show', 'list-print'):
                    try:
                        ok = local_text_show(a) if k == 'text-show' else local_list_print(a)
                    except Exception as e:
                        print('local action', k, 'error:', e, flush=True)
                        ok = False
                    if ok:
                        http('POST', '/api/action', {'ack': [aid]})
                        attempts.pop(aid, None)
                        print('local action', k, 'done', flush=True)
                        continue
                    print('local action', k, 'failed - escalating to session', flush=True)
                msg = message_for(a)
                r = subprocess.run(['musegadget', 'send-user-msg', '--session-id', SESSION, msg],
                                   capture_output=True, text=True, timeout=30)
                if r.returncode == 0:
                    http('POST', '/api/action', {'ack': [aid]})
                    attempts.pop(aid, None)
                    print('dispatched', a.get('kind'), aid, flush=True)
                else:
                    attempts[aid] = attempts.get(aid, 0) + 1
                    print('dispatch failed rc=%s (attempt %s) %s' % (r.returncode, attempts[aid], (r.stderr or '')[:160]), flush=True)
                    if attempts[aid] >= 5:
                        http('POST', '/api/action', {'ack': [aid]})
                        attempts.pop(aid, None)
                        print('dropped after 5 attempts', aid, flush=True)
        except Exception as e:
            print('poll error:', e, flush=True)
        time.sleep(1.5)

if __name__ == '__main__':
    main()
