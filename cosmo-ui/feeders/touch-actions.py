#!/usr/bin/env python3
"""Touch-action watcher (Server 2). Polls cosmo-ui's action outbox and
forwards each tap intent to the voice session via musegadget
send-user-msg, exactly like a spoken command; acks on success.
The session id matches cosmo-listener's dispatch target - if the voice
session is ever re-homed, update BOTH files."""
import json, os, subprocess, sys, time, urllib.request

UI = 'http://127.0.0.1:3180'
SESSION = 'd1726051-b123-4239-a108-d5f5c951fdde'

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

def main():
    attempts = {}
    print('touch-actions watcher up', flush=True)
    while True:
        try:
            state = http('GET', '/api/state')
            for a in state.get('actionOutbox') or []:
                aid = a.get('id')
                k = a.get('kind')
                if k in ('network-refresh', 'network-wol'):
                    if k == 'network-refresh':
                        cmd = ['/usr/bin/python3', '/home/cosmo/cosmo-ui/feeders/network-feeder.py', '--once']
                    elif os.path.exists('/home/cosmo/bin/wake-gaming-rig'):
                        cmd = ['/home/cosmo/bin/wake-gaming-rig']
                    else:
                        cmd = ['wakeonlan', '00:11:22:33:44:99']
                    r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
                    print('local action', k, 'rc=%s' % r.returncode, (r.stdout or r.stderr or '')[:160], flush=True)
                    http('POST', '/api/action', {'ack': [aid]})
                    attempts.pop(aid, None)
                    continue
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
