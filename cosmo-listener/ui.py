#!/usr/bin/env python3
"""Cosmo board helper — drives the cosmo-ui screen from the voice session.

Talks to the local cosmo-ui server (http://127.0.0.1:3180).

Usage:
  ui.py list                      print the open suggestion queue
  ui.py show N                    put queue item N on the big screen and print
                                  its full card + email thread (for speaking)
  ui.py hide                      clear the big screen, back to the board
  ui.py texts                     replace the board texts (JSON stdin:
                                  {messages: [{id, from, address, body,
                                  time (epoch ms), dir, read}]})
  ui.py facebook                  push Facebook data (JSON stdin: {me,
                                  posts: [{id, author, text, time (epoch
                                  ms)}], groups: [{name, members}]})
  ui.py facebook-open             open the Facebook modal from cache
  ui.py facebook-post             show one full post + comments (JSON
                                  stdin: {n, id, author, text, time, url,
                                  reactions: [..], comments: [{author,
                                  text, time (epoch ms)}]})
  ui.py facebook-post-clear       back to the Facebook post list
  ui.py facebook-group            open a group feed (JSON stdin: {id,
                                  name, posts: [{id, text, time (epoch
                                  ms), comments, reactions}]})
  ui.py facebook-group-clear      back to the main Facebook feed
  ui.py facebook-draft birthday NAME  draft a birthday wish (text stdin)
  ui.py facebook-draft post       set a draft post (text on stdin)
  ui.py facebook-draft comment N  set a draft comment on post N (stdin)
  ui.py facebook-draft-clear      clear the Facebook draft
  ui.py nav dock|bar              switch the bottom buttons between the
                                  text bar and the mac-style icon dock
  ui.py resolve N sent|skipped|held
                                  mark queue item N resolved (clears focus too)
  ui.py attach N                  read {"thread":[...], "draft":"..."} JSON from
                                  stdin and attach it to queue item N
  ui.py avatar STATE "message"    set the avatar state/message on screen
  ui.py calendar                  read {"anchor": "YYYY-MM-DD", "events": [...]}
                                  JSON from stdin and show the calendar overlay
                                  (30-day view). Event: {"date": "YYYY-MM-DD",
                                  "title": "...", "start": "1:00 PM", "end":
                                  "2:00 PM", "allDay": false, "location": "..."}
  ui.py calendar-open [view]      open the calendar INSTANTLY from the
                                  stored cache (60 days pre-loaded); prints
                                  coverage + freshness - refresh only if it
                                  reports CACHE EMPTY or CACHE STALE
  ui.py calendar-view days30|week|day [YYYY-MM-DD]
                                  switch the open calendar's view (day view
                                  shows the given date, default today)
  ui.py calendar-hide             close the calendar overlay
  ui.py music                     read {"nowPlaying":{...}, "picks":[{title, meta, uri}]} from stdin; store + OPEN the music overlay (Spotify state + playlist pick-list). Prints NOW and PICKS lines
  ui.py music-open                just open the music overlay from cache; says MUSIC EMPTY if nothing stored yet
  ui.py music-state               read {"nowPlaying":{...}} from stdin; update now-playing only (overlay follows if open). Prints MUSIC STATE UPDATED
  ui.py help                      open the "what can you do" modal on
                                  screen (capabilities + example commands,
                                  auto-scrolling); prints the spoken rundown
  ui.py card                      read {"kind","title","body","meta",
                                  "source","image","thread","draft","queue"}
                                  JSON from stdin and post a board card.
                                  queue:true (or kind "suggestion") = a voice
                                  queue item; anything else is an info card
  ui.py mail                      read {"emails": [...]} JSON from stdin,
                                  store it as the inbox and open the email
                                  list on screen (numbered, auto-scrolls).
                                  Email: {"threadId", "messageId", "from",
                                  "subject", "date", "snippet", "unread"}
  ui.py mail-open                 open the email list INSTANTLY from the
                                  stored inbox; prints count + freshness -
                                  fetch fresh mail only if it says INBOX EMPTY
  ui.py mail-show N               open email N (its thread view, auto-
                                  scrolling) and print it for speaking
  ui.py mail-back                 from an open email back to the list
  ui.py mail-attach N             read {"thread": [...], "draft": "..."}
                                  JSON from stdin and attach to email N
  ui.py mail-draft N              read the draft reply as RAW TEXT from
                                  stdin and put it under email N's thread
  ui.py mail-resolve N sent|skipped
                                  email N handled; it leaves the list and
                                  the remaining emails renumber
  ui.py cameras                   list the cameras the app found (Frigate
                                  or IP scan), with any learned names
  ui.py camera <title...>         show that camera's live feed. If no camera
                                  has that title, shows the FIRST feed in
                                  identify mode instead (ask the owner if it is
                                  the camera he means)
  ui.py camera-yes                identify mode: yes, save the asked title as
                                  a name for the camera on screen
  ui.py camera-no                 identify mode: no, move to the next feed
  ui.py calendar-day <when>       open day view for a date: a day-of-month
                                  ("11" or "11th"), a month + day ("nov 5"),
                                  or a full date ("2026-11-05"). A bare day
                                  number resolves inside the open 30-day
                                  window first, else the next occurrence.

Thread items: {"from": "...", "when": "...", "body": "..."} oldest first.
"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:3180"


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode() or "{}")


def current_state():
    return call("GET", "/api/state")


def queue():
    s = call("GET", "/api/state")
    return [c for c in s.get("cards", []) if c.get("kind") == "suggestion" and c.get("status") == "open"], s


def nth(n):
    q, _ = queue()
    if n < 1 or n > len(q):
        print(f"NO_ITEM: there is no number {n}. The queue has {len(q)} item(s).")
        sys.exit(2)
    return q[n - 1]


def print_card(card, n=None):
    head = f"#{n} " if n else ""
    print(f"{head}[{card.get('kind')}] {card.get('title')}")
    print(f"META: {card.get('meta', '')}")
    if card.get("source"):
        print(f"SOURCE: {card['source']}")
    print(f"BODY: {card.get('body', '')}")
    th = card.get("thread") or []
    if th:
        print(f"THREAD ({len(th)} message(s), oldest first, latest last):")
        for m in th:
            print(f"--- from {m.get('from', '?')} ({m.get('when', '')}) ---")
            print(m.get("body", ""))
    else:
        print("THREAD: none attached. If this card is about an email, fetch the "
              "thread with your mail tools and attach it: ui.py attach N")
    if card.get("draft"):
        print("DRAFT REPLY:")
        print(card["draft"])
    else:
        print("DRAFT: none yet.")


def _norm(s):
    import re as _re
    s = _re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    return " ".join(t for t in s.split() if t not in ("cam", "camera", "the"))


def _cam_names(c):
    names = [c.get("name", ""), c.get("id", "").split(":")[-1].replace("_", " ")]
    names += c.get("aliases") or []
    return names


def _match_cam(title, cams):
    t = _norm(title)
    for c in cams:
        if any(_norm(n) == t for n in _cam_names(c)):
            return c
    tt = set(t.split())
    if tt:
        for c in cams:
            for n in _cam_names(c):
                nt = set(_norm(n).split())
                if nt and (nt <= tt or tt <= nt):
                    return c
    return None


def _cams():
    _, snap = queue()
    cams = snap.get("cameras") or []
    if not cams:
        call("POST", "/api/cameras/rescan", {})
        _, snap = queue()
        cams = snap.get("cameras") or []
    return cams, snap



def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd == "list":
        q, _ = queue()
        if not q:
            print("QUEUE EMPTY: nothing needs the owner's voice.")
        for i, c in enumerate(q, 1):
            print(f"{i}. {c.get('title')}  ({c.get('meta', '')})")
    elif cmd == "show":
        n = int(args[1])
        st = call("GET", "/api/state")
        q = len([c for c in st.get("cards", []) if c.get("kind") == "suggestion" and c.get("status") == "open"])
        msgs = (st.get("texts") or {}).get("messages") or []
        if n > q and msgs:
            idx = n - q - 1
            if idx < len(msgs):
                m = msgs[idx]
                call("POST", "/api/texts/highlight", {"id": m.get("id")})
                who = m.get("from") or m.get("address") or "Unknown"
                t = m.get("time")
                when = ""
                if isinstance(t, (int, float)):
                    from datetime import datetime
                    when = datetime.fromtimestamp(t / 1000).strftime("%a %I:%M %p")
                print(f"ON SCREEN: text number {n} is highlighted on the board. FROM {who} ({when}):")
                print(m.get("body", ""))
                sys.exit(0)
            print(f"NO ITEM {n}: the queue has {q} item(s) and there are {len(msgs)} texts.")
            sys.exit(3)
        card = nth(n)
        r = call("POST", "/api/focus", {"n": n})
        print(f"ON SCREEN: number {n} is now big on the display.")
        print_card(r.get("card") or card, n)
    elif cmd == "hide":
        try:
            call("POST", "/api/browser", {"show": False})
        except Exception:
            pass
        try:
            call("POST", "/api/android", {"front": False})
        except Exception:
            pass
        call("POST", "/api/help", {"clear": True})
        call("POST", "/api/mail", {"clear": True})
        call("POST", "/api/music", {"clear": True})
        call("POST", "/api/weather", {"clear": True})
        call("POST", "/api/ha", {"clear": True})
        call("POST", "/api/camera", {"clear": True})
        call("POST", "/api/calendar", {"show": False})
        call("POST", "/api/focus", {"clear": True})
        call("POST", "/api/image", {"clear": True})
        call("POST", "/api/shop", {"clear": True})
        call("POST", "/api/texts/highlight", {"id": None})
        call("POST", "/api/facebook", {"clear": True})
        call("POST", "/api/messenger", {"clear": True})
        call("POST", "/api/sms", {"clear": True})
        call("POST", "/api/insta", {"clear": True})
        call("POST", "/api/apps", {"clear": True})
        call("POST", "/api/app", {"clear": True})
        call("POST", "/api/paper", {"clear": True})
        call("POST", "/api/network", {"clear": True})
        call("POST", "/api/settings", {"clear": True})
        print("SCREEN CLEARED: back to the board.")
    elif cmd == "sms":
        data = json.load(sys.stdin)
        call("POST", "/api/sms/data", data)
        threads = data.get("threads") or []
        print(f"TEXTS ON BOARD: {len(threads)} conversations.")
        for i, t in enumerate(threads[:12]):
            print(f"{i + 1}. {t.get('name', '')}{' (UNREAD)' if t.get('unread') else ''}: {(t.get('snippet') or '')[:80]}")
    elif cmd == "sms-open":
        st = call("GET", "/api/state")
        sm = st.get("sms") or {}
        if not (sm.get("threads")):
            print("TEXTS EMPTY: fetch SMS conversations and push with ui.py sms first.")
            sys.exit(3)
        call("POST", "/api/sms", {"show": True})
        print(f"ON SCREEN: Texts - {len(sm.get('threads') or [])} conversations, updated {sm.get('updatedAt', '?')}.")
        for i, t in enumerate((sm.get("threads") or [])[:12]):
            print(f"{i + 1}. {t.get('name', '')}{' (UNREAD)' if t.get('unread') else ''}: {(t.get('snippet') or '')[:80]}")
    elif cmd == "sms-thread":
        data = json.load(sys.stdin)
        r = call("POST", "/api/sms/thread", data)
        th = r.get("smsThread") or data
        msgs = th.get("messages") or []
        print(f"ON SCREEN: text conversation with {th.get('name', '')} - {len(msgs)} messages (oldest first).")
        for m in msgs:
            print(f"- {'You' if m.get('mine') else m.get('sender', th.get('name', ''))}: {m.get('text', '')}")
    elif cmd == "sms-thread-clear":
        call("POST", "/api/sms/thread", {"clear": True})
        print("BACK TO THE TEXT CONVERSATION LIST.")
    elif cmd == "sms-draft":
        n = int(args[1]) if len(args) > 1 else None
        name = " ".join(args[2:]) if len(args) > 2 else None
        text = sys.stdin.read().strip()
        call("POST", "/api/sms/draft", {"text": text, "threadN": n, "name": name})
        print(f"DRAFT SET (text reply to #{n} {name or ''}): {text[:120]}")
    elif cmd == "shop":
        call("POST", "/api/shop", {"show": True})
        import time as _t
        _t.sleep(4)
        st = call("GET", "/api/state")
        s = st.get("shop") or {}
        print("Fuse Shop:", s.get("name"), "| apps:", len(s.get("apps") or []), "| installed:", len(s.get("installed") or []), "| error:", s.get("error") or "none")
        for a in s.get("apps") or []:
            print(" -", a.get("name"), a.get("version") or "", "[installed]" if a.get("package") in (s.get("installed") or []) else "")
    elif cmd == "guardian":
        call("POST", "/api/guardian", {"show": True})
        st = call("GET", "/api/state")
        g = st.get("guardian") or {}
        ad = g.get("adapter") or {}
        line = g.get("line") or {}
        print("ON SCREEN: Guardian app. Adapter: " + (("found - " + str(ad.get("model", "")) + " at " + str(ad.get("ip", "")) + ", " + ("registered" if ad.get("registered") else "not registered")) if ad.get("found") else "not found yet") + ". Line: " + (str(line.get("number")) + " (" + str(line.get("status")) + ")" if line.get("number") else "none yet") + ".")
    elif cmd == "guardian-status":
        st = call("GET", "/api/state")
        print(json.dumps(st.get("guardian") or {}, indent=1))
    elif cmd == "guardian-stepin":
        call("POST", "/api/guardian/intr", {"cmd": "in"})
        print("STEPPING IN: Cosmo is taking over the live call - both parties now talk only to Cosmo.")
    elif cmd == "guardian-release":
        call("POST", "/api/guardian/intr", {"cmd": "out"})
        print("STEPPING BACK: the two parties can hear each other again.")
    elif cmd == "guardian-askpw":
        r = call("POST", "/api/guardian/askpw", {})
        print("ASKING FOR THE FAMILY PASSWORD." if r.get("ok") else "COULD NOT ASK: " + str(r.get("error")))
    elif cmd == "guardian-hangup":
        r = call("POST", "/api/guardian/hangup", {})
        print("CALL HUNG UP by the Guardian." if r.get("ok") else "COULD NOT HANG UP: " + str(r.get("error")))
    elif cmd == "pc-check":
        call("POST", "/api/pc/command", {"command": "health"})
        print("PC CHECK REQUESTED: the agent answers within about 30 seconds (the update scan can be slow); then run ui.py pc-status.")
    elif cmd == "pc-snap":
        call("POST", "/api/pc/command", {"command": "snapshot"})
        print("SNAPSHOT REQUESTED: the agent answers within a few seconds; then run ui.py pc-status and ui.py pc-show.")
    elif cmd == "pc-open":
        target = " ".join(sys.argv[2:])
        call("POST", "/api/pc/command", {"command": "open:" + target})
        print("PC OPEN REQUESTED: " + target)
    elif cmd == "pc-control":
        mode = sys.argv[2] if len(sys.argv) > 2 else ""
        if mode == "start":
            call("POST", "/api/pc/control", {"start": True})
            print("CONTROL SESSION STARTED: the banner is up on the PC; control commands are unlocked until stop or 10 idle minutes.")
        elif mode == "stop":
            call("POST", "/api/pc/control", {"stop": True})
            print("CONTROL SESSION STOPPED.")
        else:
            st = call("GET", "/api/state")
            print("CONTROL: " + str(st.get("pcControl") or {}))
    elif cmd == "pc-do":
        action = " ".join(sys.argv[2:])
        r = call("POST", "/api/pc/command", {"command": action})
        if r and r.get("ok"):
            print("ACTION QUEUED: " + action)
        else:
            print("ACTION REJECTED: " + str((r or {}).get("error") or r))
    elif cmd == "pc-guide":
        text = " ".join(sys.argv[2:])
        call("POST", "/api/pc/command", {"command": "guide:" + text})
        print("GUIDE SHOWN ON PC: " + text)
    elif cmd == "pc-guide-done":
        call("POST", "/api/pc/command", {"command": "guide-done"})
        print("GUIDE CLEARED.")
    elif cmd == "pc-banner":
        text = " ".join(sys.argv[2:])
        r = call("POST", "/api/pc/command", {"command": "banner:" + text})
        print(("BANNER SET: " + text) if r and r.get("ok") else ("BANNER REJECTED: " + str((r or {}).get("error") or r)))
    elif cmd == "pc-uia":
        call("POST", "/api/pc/command", {"command": "uia"})
        print("UIA REQUESTED: the foreground window element tree lands in the result output; read it via ui.py pc-status.")
    elif cmd == "pc-uia-click":
        n = sys.argv[2] if len(sys.argv) > 2 else ""
        r = call("POST", "/api/pc/command", {"command": "uia-click:" + n})
        print(("ACTION QUEUED: uia-click:" + n) if r and r.get("ok") else ("ACTION REJECTED: " + str((r or {}).get("error") or r)))
    elif cmd == "pc-hid":
        args = sys.argv[2:]
        hcmd = ""
        if args:
            verb = args[0]
            if verb == "type": hcmd = "type:" + " ".join(args[1:])
            elif verb == "key": hcmd = "key:" + (args[1] if len(args) > 1 else "")
            elif verb in ("click", "dblclick", "rclick", "move") and len(args) > 2: hcmd = verb + ":" + args[1] + "," + args[2]
            elif verb == "scroll" and len(args) > 1: hcmd = "scroll:" + args[1]
        if not hcmd:
            print("usage: pc-hid type <text...> | key <combo> | click <x> <y> | dblclick <x> <y> | rclick <x> <y> | move <x> <y> | scroll <n>")
        else:
            r = call("POST", "/api/hid/command", {"command": hcmd})
            print(("HID QUEUED: " + hcmd) if r and r.get("ok") else ("HID REJECTED: " + str((r or {}).get("error") or r)))
    elif cmd == "pc-status":
        st = call("GET", "/api/state")
        pc = st.get("pc") or {}
        if not pc.get("lastSeen"):
            print("PC OFFLINE: no agent has checked in yet.")
            sys.exit(3)
        import time as _t
        age = int(_t.time() - pc["lastSeen"] / 1000)
        nm = pc.get("name") or "?"
        print("PC: " + nm + " (" + str(pc.get("os") or "") + ") user " + str(pc.get("user") or "") + ", last seen " + str(age) + "s ago, foreground: " + str(pc.get("foreground") or ""))
        rt = pc.get("remoteTools") or []
        if rt:
            print("REMOTE TOOLS RUNNING: " + ", ".join(rt))
        h = pc.get("health")
        if h:
            tot = (h.get("diskUsedGB") or 0) + (h.get("diskFreeGB") or 0)
            fp = round(100 * (h.get("diskFreeGB") or 0) / tot) if tot else None
            print("HEALTH: disk " + str(fp) + "% free (" + str(h.get("diskFreeGB")) + " GB), CPU " + str(h.get("cpuLoad")) + "%, RAM free " + str(h.get("ramFreeGB")) + " of " + str(h.get("ramTotalGB")) + " GB, updates pending: " + str(h.get("updatesPending")) + ", antivirus on: " + str(h.get("defenderOn")) + ", defs days old: " + str(h.get("definitionsDaysOld")) + ", uptime " + str(h.get("uptimeMin")) + " min")
            if h.get("topRam"):
                print("TOP RAM: " + ", ".join(h["topRam"]))
            su = h.get("startup") or []
            if su:
                print("STARTUP ITEMS (" + str(len(su)) + "): " + ", ".join(su[:12]))
        else:
            print("HEALTH: no report yet - run ui.py pc-check and wait.")
        v = pc.get("verdict")
        if v:
            print("LAST SCREEN VERDICT: scam=" + str(v.get("scam")) + " - " + str(v.get("why") or ""))
        print("SNAPSHOT AT: " + str(pc.get("snapshotAt") or 0))
    elif cmd == "pc-show":
        st = call("GET", "/api/state")
        pc = st.get("pc") or {}
        if not pc.get("snapshotAt"):
            print("NO SNAPSHOT: request one with ui.py pc-snap first.")
            sys.exit(3)
        call("POST", "/api/image", {"show": True, "src": "/pc/latest.jpg", "title": "Laptop screen - " + str(pc.get("name") or "PC"), "credit": "Cosmo PC agent"})
        print("ON SCREEN: the latest laptop snapshot.")
    elif cmd == "network":
        data = json.load(sys.stdin)
        call("POST", "/api/network/data", data)
        sm = data.get("summary") or {}
        print(f"NETWORK ON BOARD: internet {'UP' if sm.get('internet') else 'DOWN'}, tunnel {'UP' if sm.get('tunnel') else 'DOWN'}, devices {sm.get('devicesUp', 0)} up of {sm.get('devicesTotal', 0)}.")
    elif cmd == "network-open":
        st = call("GET", "/api/state")
        nw = st.get("network") or {}
        if not nw.get("updatedAt"):
            print("NETWORK EMPTY: run feeders/network-feeder.py --once first.")
            sys.exit(3)
        call("POST", "/api/network", {"show": True})
        sm = nw.get("summary") or {}
        print(f"ON SCREEN: Network Administrator - internet {'UP' if sm.get('internet') else 'DOWN'}, tunnel {'UP' if sm.get('tunnel') else 'DOWN'}.")
        for l in nw.get("links") or []:
            print(f"- {l.get('name')}: {'up' if l.get('ok') else 'DOWN'}" + (f" {l.get('ms')} ms" if l.get('ms') is not None else ""))
        for d in nw.get("devices") or []:
            print(f"- {d.get('name')} ({d.get('ip') or 'not seen'}): {d.get('status')}")
    elif cmd in ("settings", "settings-open"):
        call("POST", "/api/settings", {"show": True})
        st = call("GET", "/api/state")
        w = (st.get("settings") or {}).get("wifi") or {}
        c = w.get("connected")
        if not w.get("radio", True):
            print("ON SCREEN: Settings. Wi-Fi is OFF.")
        elif c:
            print(f"ON SCREEN: Settings. Wi-Fi is connected to {c.get('ssid')} ({c.get('ip') or 'no IP yet'}).")
        else:
            print("ON SCREEN: Settings. Wi-Fi is on, not connected to any network.")
        for n in (w.get("networks") or [])[:8]:
            print(f"- {n.get('ssid')}: signal {n.get('signal')}%, {'locked' if n.get('secured') else 'open'}" + (" (connected)" if n.get("inUse") else ""))
        print("A fresh scan was just triggered - the on-screen list fills in within seconds. Wi-Fi passwords are typed on the screen keyboard only, never by voice.")
    elif cmd == "browser":
        r = call("POST", "/api/browser", {"show": True})
        print("BROWSER OPEN: Brave is full screen on the box, on the Fuse_Box start page." if r.get("ok") else f"BROWSER FAILED: {r}")
    elif cmd == "browser-close":
        r = call("POST", "/api/browser", {"show": False})
        print("BACK TO THE BOARD: the browser is behind the board again." if r.get("ok") else f"BROWSER CLOSE FAILED: {r}")
    elif cmd == "settings-wifi":
        st = call("GET", "/api/state")
        w = (st.get("settings") or {}).get("wifi") or {}
        c = w.get("connected")
        if not w.get("radio", True):
            print("WI-FI: off.")
        elif c:
            print(f"WI-FI: connected to {c.get('ssid')} ({c.get('ip') or 'no IP yet'}), signal {c.get('signal')}%.")
        else:
            print("WI-FI: on, not connected.")
        for n in (w.get("networks") or [])[:10]:
            print(f"- {n.get('ssid')}: signal {n.get('signal')}%, {'locked' if n.get('secured') else 'open'}" + (" (connected)" if n.get("inUse") else ""))
    elif cmd == "settings-wifi-scan":
        r = call("POST", "/api/settings/wifi/scan", {})
        w = r.get("wifi") or {}
        print(f"WI-FI SCAN: {len(w.get('networks') or [])} networks.")
        for n in (w.get("networks") or [])[:10]:
            print(f"- {n.get('ssid')}: signal {n.get('signal')}%, {'locked' if n.get('secured') else 'open'}")
    elif cmd == "settings-wifi-disconnect":
        call("POST", "/api/settings/wifi/disconnect", {})
        print("WI-FI DISCONNECTED. (The wired connection is untouched.)")
    elif cmd == "settings-wifi-forget":
        ssid = " ".join(sys.argv[2:])
        call("POST", "/api/settings/wifi/forget", {"ssid": ssid})
        print(f"FORGOT SAVED WI-FI NETWORK: {ssid}")
    elif cmd == "settings-wifi-radio":
        on = len(sys.argv) > 2 and sys.argv[2] == "on"
        call("POST", "/api/settings/wifi/radio", {"on": on})
        print("WI-FI RADIO " + ("ON." if on else "OFF."))
    elif cmd == "paper":
        data = json.load(sys.stdin)
        call("POST", "/api/paper/data", data)
        ed = data.get("edition") or {}
        print(f"NEWSPAPER ON BOARD: {ed.get('brand', '')} - {ed.get('dateLabel', '')} ({len(ed.get('top') or [])} top stories).")
    elif cmd == "paper-open":
        st = call("GET", "/api/state")
        pp = st.get("paper") or {}
        if not pp.get("edition"):
            print("PAPER EMPTY: push an edition with ui.py paper first.")
            sys.exit(3)
        call("POST", "/api/paper", {"show": True})
        ed = pp["edition"]
        print(f"ON SCREEN: {ed.get('brand', '')} - {ed.get('dateLabel', '')}.")
        for i, t in enumerate(ed.get("top") or []):
            print(f"{i + 1}. {t.get('title', '')}")
    elif cmd == "apps":
        data = json.load(sys.stdin)
        r = call("POST", "/api/apps/data", data)
        print(f"APPS ON BOARD: {r.get('apps', 0)} apps.")
    elif cmd == "apps-open":
        st = call("GET", "/api/state")
        apps = st.get("apps") or []
        call("POST", "/api/apps", {"show": True})
        print(f"ON SCREEN: Apps - {len(apps)} apps, {len(st.get('appsCatalog') or [])} more available to add.")
        for i, a in enumerate(apps):
            print(f"{i + 1}. {a.get('name', '')}{' [in dock]' if a.get('inDock') else ''} - {a.get('desc', '')}")
    elif cmd == "app-open":
        st = call("GET", "/api/state")
        apps = st.get("apps") or []
        want = args[1] if len(args) > 1 else ""
        app = None
        if want.isdigit():
            n = int(want)
            if 1 <= n <= len(apps):
                app = apps[n - 1]
        else:
            app = next((a for a in apps if a.get("id") == want or (a.get("name") or "").lower() == want.lower()), None)
        if not app:
            print(f"NO SUCH APP: {want}")
            sys.exit(2)
        call("POST", "/api/app", {"id": app.get("id")})
        print(f"ON SCREEN: app page for {app.get('name', '')} - {app.get('desc', '')}")
    elif cmd == "app-dock":
        st = call("GET", "/api/state")
        apps = st.get("apps") or []
        want = args[1] if len(args) > 1 else ""
        on = len(args) > 2 and args[2] == "on"
        app = next((a for a in apps if a.get("id") == want or (a.get("name") or "").lower() == want.lower()), None)
        if not app:
            print(f"NO SUCH APP: {want}")
            sys.exit(2)
        call("POST", "/api/apps/dock", {"id": app.get("id"), "inDock": on})
        print(f"APP {'PINNED TO DOCK' if on else 'REMOVED FROM DOCK'}: {app.get('name', '')}")
    elif cmd == "insta":
        data = json.load(sys.stdin)
        call("POST", "/api/insta/data", data)
        posts = data.get("posts") or []
        prof = data.get("profile") or {}
        print(f"INSTAGRAM ON BOARD: {len(posts)} posts, @{prof.get('username', '')}.")
        for i, p in enumerate(posts[:12]):
            print(f"{i + 1}. {p.get('username', '')}: {(p.get('caption') or '')[:100]}")
    elif cmd == "insta-open":
        st = call("GET", "/api/state")
        ig = st.get("insta") or {}
        if not (ig.get("posts")):
            print("INSTAGRAM EMPTY: fetch the feed and push with ui.py insta first.")
            sys.exit(3)
        call("POST", "/api/insta", {"show": True})
        print(f"ON SCREEN: Instagram - @{((ig.get('profile') or {}).get('username', ''))}, {len(ig.get('posts') or [])} posts, updated {ig.get('updatedAt', '?')}.")
        for i, p in enumerate((ig.get("posts") or [])[:12]):
            print(f"{i + 1}. {p.get('username', '')}: {(p.get('caption') or '')[:100]}")
    elif cmd == "insta-post":
        data = json.load(sys.stdin)
        r = call("POST", "/api/insta/post", data)
        det = r.get("instaPost") or data
        cmts = det.get("comments") or []
        print(f"ON SCREEN: Instagram post by {det.get('username', '')} - {len(cmts)} comments.")
        print(f"Caption: {(det.get('caption') or '')[:300]}")
        for c in cmts[:20]:
            print(f"- {c.get('author', '')}: {c.get('text', '')}")
    elif cmd == "insta-post-clear":
        call("POST", "/api/insta/post", {"clear": True})
        print("BACK TO THE INSTAGRAM FEED.")
    elif cmd == "messenger":
        data = json.load(sys.stdin)
        call("POST", "/api/messenger/data", data)
        threads = data.get("threads") or []
        print(f"MESSENGER ON BOARD: {len(threads)} conversations.")
        for i, t in enumerate(threads[:12]):
            print(f"{i + 1}. {t.get('name', '')}{' (UNREAD)' if t.get('unread') else ''}: {(t.get('snippet') or '')[:80]}")
    elif cmd == "messenger-open":
        st = call("GET", "/api/state")
        mg = st.get("messenger") or {}
        if not (mg.get("threads")):
            print("MESSENGER EMPTY: fetch conversations and push with ui.py messenger first.")
            sys.exit(3)
        call("POST", "/api/messenger", {"show": True})
        print(f"ON SCREEN: Messenger - {len(mg.get('threads') or [])} conversations, updated {mg.get('updatedAt', '?')}.")
        for i, t in enumerate((mg.get("threads") or [])[:12]):
            print(f"{i + 1}. {t.get('name', '')}{' (UNREAD)' if t.get('unread') else ''}: {(t.get('snippet') or '')[:80]}")
    elif cmd == "messenger-thread":
        data = json.load(sys.stdin)
        r = call("POST", "/api/messenger/thread", data)
        th = r.get("messengerThread") or data
        msgs = th.get("messages") or []
        print(f"ON SCREEN: conversation with {th.get('name', '')} - {len(msgs)} messages (oldest first).")
        for m in msgs:
            print(f"- {'You' if m.get('mine') else m.get('sender', th.get('name', ''))}: {m.get('text', '')}")
    elif cmd == "messenger-thread-clear":
        call("POST", "/api/messenger/thread", {"clear": True})
        print("BACK TO THE CONVERSATION LIST.")
    elif cmd == "messenger-draft":
        n = int(args[1]) if len(args) > 1 else None
        name = " ".join(args[2:]) if len(args) > 2 else None
        text = sys.stdin.read().strip()
        call("POST", "/api/messenger/draft", {"text": text, "threadN": n, "name": name})
        print(f"DRAFT SET (messenger reply to #{n} {name or ''}): {text[:120]}")
    elif cmd == "facebook":
        data = json.load(sys.stdin)
        r = call("POST", "/api/facebook/data", data)
        print(f"FACEBOOK ON BOARD: {r.get('posts', 0)} posts.")
        for i, p in enumerate((data.get("posts") or [])[:10]):
            print(f"{i + 1}. {p.get('author', '')}: {(p.get('text') or '')[:110]}")
    elif cmd == "facebook-open":
        st = call("GET", "/api/state")
        fb = st.get("facebook") or {}
        posts = fb.get("posts") or []
        if not posts:
            print("FACEBOOK EMPTY: fetch the feed and push it with ui.py facebook first.")
            sys.exit(3)
        call("POST", "/api/facebook", {"show": True})
        print(f"ON SCREEN: Facebook - {(fb.get('me') or {}).get('name', '')}, updated {fb.get('updatedAt', '?')}.")
        _np = len(posts)
        _nb = len(fb.get("birthdays") or [])
        if fb.get("birthdays"):
            print("Birthdays (page numbers): " + ", ".join(f"{_np + 1 + i} {b.get('name', '')} ({b.get('label', '')})" for i, b in enumerate(fb["birthdays"])))
        if fb.get("groups"):
            print("Groups (page numbers): " + ", ".join(f"{_np + _nb + 1 + i} {g.get('name', '')}" for i, g in enumerate(fb["groups"])))
        for i, p in enumerate(posts[:10]):
            print(f"{i + 1}. {p.get('author', '')}: {(p.get('text') or '')[:110]}")
    elif cmd == "facebook-group":
        data = json.load(sys.stdin)
        r = call("POST", "/api/facebook/group", data)
        g = r.get("facebookGroup") or data
        print(f"ON SCREEN: group '{g.get('name', '')}' - {len(g.get('posts') or [])} posts.")
        for i, p in enumerate((g.get("posts") or [])[:10]):
            print(f"{i + 1}. {(p.get('text') or '')[:110]}")
        _fb2 = (call("GET", "/api/state").get("facebook") or {})
        _m = len(g.get("posts") or [])
        if _fb2.get("birthdays"):
            print("While this group is open, birthdays are: " + ", ".join(f"{_m + 1 + i} {b.get('name', '')}" for i, b in enumerate(_fb2["birthdays"])))
    elif cmd == "facebook-group-clear":
        call("POST", "/api/facebook/group", {"clear": True})
        print("BACK TO THE FACEBOOK FEED.")
    elif cmd == "facebook-post":
        data = json.load(sys.stdin)
        r = call("POST", "/api/facebook/post", data)
        d = r.get("facebookPost") or data
        print(f"ON SCREEN: full post by {d.get('author', '')}:")
        print(d.get("text", ""))
        if d.get("reactions"):
            print("REACTIONS: " + ", ".join(d["reactions"]))
        print(f"COMMENTS ({len(d.get('comments') or [])}):")
        for c in (d.get("comments") or []):
            print(f"- {c.get('author', '')}: {c.get('text', '')}")
    elif cmd == "facebook-post-clear":
        call("POST", "/api/facebook/post", {"clear": True})
        print("BACK TO THE FACEBOOK LIST.")
    elif cmd == "facebook-draft":
        kind = args[1] if len(args) > 1 else "post"
        postn = int(args[2]) if kind == "comment" and len(args) > 2 else None
        person = " ".join(args[2:]) if kind == "birthday" else None
        text = sys.stdin.read().strip()
        r = call("POST", "/api/facebook/draft", {"kind": kind, "text": text, "postN": postn, "person": person})
        print(f"DRAFT SET ({kind}): {text[:120]}")
    elif cmd == "facebook-draft-clear":
        call("POST", "/api/facebook/draft", {"clear": True})
        print("DRAFT CLEARED.")
    elif cmd == "texts":
        data = json.load(sys.stdin)
        msgs = data.get("messages") or []
        r = call("POST", "/api/texts", {"messages": msgs})
        print(f"TEXTS ON BOARD: {r.get('count', len(msgs))} messages.")
    elif cmd == "nav":
        style = args[1] if len(args) > 1 else ""
        if style not in ("dock", "bar"):
            print("USAGE: ui.py nav dock|bar")
            sys.exit(2)
        r = call("POST", "/api/navstyle", {"style": style})
        print(f"BUTTONS: {r.get('navStyle')} style.")
    elif cmd == "image":
        payload = json.loads(sys.stdin.read() or "{}")
        src = payload.get("src")
        if not src:
            print('NO SRC: image needs a JSON with src on stdin.')
            sys.exit(2)
        call("POST", "/api/image", {"show": True, "src": src, "title": payload.get("title", ""), "credit": payload.get("credit", "")})
        print("ON SCREEN: image '" + str(payload.get("title") or src) + "'.")
    elif cmd == "calendar":
        payload = json.loads(sys.stdin.read() or "{}")
        events = payload.get("events", [])
        r = call("POST", "/api/calendar", {"events": events, "view": "days30",
                                            "anchor": payload.get("anchor"),
                                            "days": payload.get("days", 60), "show": True})
        days = {}
        for e in events:
            days.setdefault(e.get("date", "?"), []).append(e)
        print(f"ON SCREEN: calendar, 30-day view. {len(events)} event(s) on {len(days)} day(s).")
        for d in sorted(days):
            for e in days[d]:
                t = "ALL DAY" if e.get("allDay") else (e.get("start", "") + ("-" + e["end"] if e.get("end") else ""))
                print(f"  {d}  {t}  {e.get('title', '')}" + (f" @ {e['location']}" if e.get("location") else ""))
    elif cmd == "calendar-open":
        import datetime as _dt
        import time as _time
        _, snap = queue()
        cal = snap.get("calendar") or {}
        evs = cal.get("events") or []
        if not evs:
            print("CACHE EMPTY: no calendar data stored. Fetch fresh 60 days and push with ui.py calendar.")
            sys.exit(3)
        view = args[1] if len(args) > 1 else "days30"
        call("POST", "/api/calendar", {"view": view, "show": True})
        anchor = cal.get("anchor")
        ndays = int(cal.get("days") or 30)
        end = None
        if anchor:
            end = (_dt.date.fromisoformat(anchor) + _dt.timedelta(days=ndays - 1)).isoformat()
        age_h = None
        if cal.get("updatedAt"):
            age_h = (_time.time() * 1000 - cal["updatedAt"]) / 3600000.0
        today = _dt.date.today()
        age_s = f"{age_h:.1f}h ago" if age_h is not None else "unknown age"
        print(f"ON SCREEN (cached, instant): calendar, {view} view. {len(evs)} event(s) stored, covering {anchor} .. {end}, updated {age_s}.")
        for e in [x for x in evs if x.get("date", "") >= today.isoformat()][:5]:
            t = "ALL DAY" if e.get("allDay") else (e.get("start", "") + ("-" + e["end"] if e.get("end") else ""))
            print(f"  {e.get('date')}  {t}  {e.get('title', '')}")
        stale = age_h is None or age_h > 24 or (end is not None and end < (today + _dt.timedelta(days=29)).isoformat())
        if stale:
            print("CACHE STALE: refresh in the background (fetch fresh 60 days, ui.py calendar). The cached view stays on screen meanwhile.")
    elif cmd == "calendar-view":
        view = args[1] if len(args) > 1 else "days30"
        body = {"view": view, "show": True}
        if len(args) > 2:
            body["date"] = args[2]
        call("POST", "/api/calendar", body)
        print(f"ON SCREEN: calendar, {view} view.")
    elif cmd == "music":
        data = json.loads(sys.stdin.read() or "{}")
        call("POST", "/api/music", {"state": {"nowPlaying": data.get("nowPlaying"), "picks": data.get("picks") or [], "devices": data.get("devices") or []}, "show": True})
        np_ = data.get("nowPlaying") or {}
        print("MUSIC OPEN. NOW: %s" % ((np_.get("title") or "nothing") + (" - " + np_["artist"] if np_.get("artist") else "")))
        picks = data.get("picks") or []
        for i, pk in enumerate(picks, 1):
            print("PICK %d: %s <%s>" % (i, pk.get("title"), pk.get("uri")))
        if not picks:
            print("PICKS: none posted")
    elif cmd == "music-open":
        st = current_state()
        mus = st.get("music") or {}
        if not mus.get("updatedAt"):
            print("MUSIC EMPTY - nothing posted yet (run ui.py music with state first)")
            return 4
        call("POST", "/api/music", {"show": True})
        print("MUSIC OPEN (cached).")
    elif cmd == "music-state":
        data = json.loads(sys.stdin.read() or "{}")
        _st = {"nowPlaying": data.get("nowPlaying")}
        if data.get("devices") is not None: _st["devices"] = data.get("devices")
        call("POST", "/api/music", {"state": _st})
        print("MUSIC STATE UPDATED.")
    elif cmd == "weather":
        # Push weather data (JSON on stdin) without opening the overlay.
        data = json.load(sys.stdin)
        call("POST", "/api/weather", {"state": data})
        print("WEATHER STORED.")
    elif cmd == "ha-hide":
        # Hide a tile from the Home screen (entity stays in HA).
        call("POST", "/api/ha/hide", {"id": args[1]})
        print("HIDDEN:", args[1])
    elif cmd == "ha-unhide":
        call("POST", "/api/ha/unhide", {"id": args[1]})
        print("RESTORED:", args[1])
    elif cmd == "home-open":
        # Open the Home Assistant control overlay; tiles load live from HA.
        call("POST", "/api/ha", {"show": True})
        print("HOME OPEN - the control tiles are on screen.")
    elif cmd == "weather-open":
        # Open the weather overlay from the cache and print a summary line.
        st = call("GET", "/api/state")
        wx = st.get("weather")
        if not wx or not wx.get("current"):
            print("WEATHER EMPTY - run feeders/weather-feeder.py once, then retry.")
            return 5
        call("POST", "/api/weather", {"show": True})
        c = wx["current"]
        d0 = (wx.get("daily") or [{}])[0]
        print("WEATHER OPEN. Now %sF, code %s, feels %sF, wind %s mph. Today hi %s lo %s, precip %s%%. Updated %s." % (c.get("temp"), c.get("code"), c.get("feels"), c.get("wind"), d0.get("hi"), d0.get("lo"), d0.get("precip"), (wx.get("updatedAt") or "")[:16]))
    elif cmd == "help":
        call("POST", "/api/help", {"show": True})
        print("ON SCREEN: 'What I can do' modal (auto-scrolling).")
        print("SPOKEN RUNDOWN (say this, briefly): I can answer questions and tell stories; run the board - show me a number, send it, edit it, skip it, hold it, or read the full thing; show your calendar three ways and any date you name; show any camera by name and learn new names from you; read your email, draft replies, and send only when you say send it; switch between my five voices. Full details are on the screen.")
    elif cmd == "card":
        data = json.load(sys.stdin)
        payload = {k: data[k] for k in ("kind", "title", "body", "meta", "source", "image", "thread", "draft") if k in data}
        if data.get("queue"):
            payload["kind"] = "suggestion"
        r = call("POST", "/api/card", payload)
        cid = r.get("id")
        if payload.get("kind") == "suggestion":
            ids, _ = queue()
            pos = (ids.index(cid) + 1) if cid in ids else None
            print(f"QUEUE CARD POSTED: #{pos} (id {cid}) - {payload.get('title', '')}")
        else:
            print(f"INFO CARD POSTED (id {cid}): {payload.get('title', '')}")
    elif cmd == "mail":
        data = json.load(sys.stdin)
        emails = data.get("emails") or []
        r = call("POST", "/api/inbox", {"emails": emails})
        call("POST", "/api/mail", {"show": True})
        print(f"ON SCREEN: email list, {r.get('count', len(emails))} message(s), newest first.")
        for i, e in enumerate(emails, 1):
            print(f"  {i}. {e.get('from', '')} - {e.get('subject', '')} ({e.get('date', '')})" + (" [unread]" if e.get("unread") else ""))
    elif cmd == "mail-open":
        _, snap = queue()
        inbox = snap.get("inbox") or {}
        emails = inbox.get("emails") or []
        if not emails:
            print("INBOX EMPTY: no stored mail. Fetch Gmail (triage in:inbox, max 30) and push it with ui.py mail first.")
            sys.exit(3)
        call("POST", "/api/mail", {"show": True})
        upd = inbox.get("updatedAt") or ""
        age = ""
        if upd:
            try:
                import datetime as _dt
                t = _dt.datetime.fromisoformat(upd.replace("Z", "+00:00"))
                mins = int((_dt.datetime.now(_dt.timezone.utc) - t).total_seconds() // 60)
                age = f", updated {mins} min ago" + (" (STALE - refresh when convenient)" if mins > 30 else "")
            except Exception:
                pass
        print(f"ON SCREEN (cached, instant): email list, {len(emails)} message(s){age}.")
        for i, e in enumerate(emails[:5], 1):
            print(f"  {i}. {e.get('from', '')} - {e.get('subject', '')}")
    elif cmd == "mail-show":
        n = int(args[1])
        _, snap = queue()
        emails = (snap.get("inbox") or {}).get("emails") or []
        if not (1 <= n <= len(emails)):
            print(f"NO EMAIL {n}: the list has {len(emails)} message(s).")
            sys.exit(2)
        e = emails[n - 1]
        call("POST", "/api/mail", {"n": n})
        print(f"ON SCREEN: email {n} (thread view, auto-scrolling).")
        print(f"SUBJECT: {e.get('subject', '')}")
        print(f"FROM: {e.get('from', '')}   DATE: {e.get('date', '')}")
        print(f"THREADID: {e.get('threadId', '')}   MESSAGEID: {e.get('messageId', '')}")
        th = e.get("thread")
        if th:
            print(f"THREAD: {len(th)} message(s) attached.")
            for m in th:
                print(f"--- {m.get('from', '')} ({m.get('when', m.get('date', ''))}) ---")
                print(m.get("body", ""))
        else:
            print("THREAD: none attached - the screen shows the list snippet only.")
            print("If the owner wants the full conversation: fetch the Gmail thread, ui.py mail-attach N, then ui.py mail-show N again.")
            print("SNIPPET: " + (e.get("snippet", "") or e.get("body", "")))
        if e.get("draft"):
            print("DRAFT (on screen under the thread):")
            print(e["draft"])
    elif cmd == "mail-back":
        call("POST", "/api/mail", {"show": True})
        print("ON SCREEN: back to the email list.")
    elif cmd == "mail-attach":
        n = int(args[1])
        data = json.load(sys.stdin)
        payload = {"n": n}
        if "thread" in data:
            payload["thread"] = data["thread"]
        if "draft" in data:
            payload["draft"] = data["draft"]
        r = call("POST", "/api/mail/attach", payload)
        if not r.get("found"):
            print(f"NO EMAIL {n}.")
            sys.exit(2)
        parts = []
        if "thread" in payload:
            parts.append(f"{len(payload['thread'])} message(s)")
        if "draft" in payload:
            parts.append("draft")
        print(f"ATTACHED to email {n}: " + ", ".join(parts) + ".")
    elif cmd == "mail-draft":
        n = int(args[1])
        text = sys.stdin.read().strip()
        r = call("POST", "/api/mail/attach", {"n": n, "draft": text})
        if not r.get("found"):
            print(f"NO EMAIL {n}.")
            sys.exit(2)
        _, snap = queue()
        if (snap.get("mailView") or {}).get("focusN") != n:
            call("POST", "/api/mail", {"n": n})
        print(f"ON SCREEN: draft reply under email {n}'s thread, waiting for approval.")
        print(text)
    elif cmd == "mail-resolve":
        n = int(args[1])
        action = args[2] if len(args) > 2 else "sent"
        r = call("POST", "/api/mail/resolve", {"n": n, "action": action})
        if not r.get("found"):
            print(f"NO EMAIL {n}.")
            sys.exit(2)
        print(f"RESOLVED: email {n} marked {action} and removed from the list; {r.get('count')} message(s) remain (renumbered).")
    elif cmd == "cameras":
        cams, _ = _cams()
        if not cams:
            print("NO CAMERAS: discovery found nothing (no Frigate, no IP cameras).")
            sys.exit(3)
        print(f"CAMERAS ({len(cams)}):")
        for i, c in enumerate(cams, 1):
            al = ", ".join(c.get("aliases") or [])
            print(f"  {i}. {c.get('name')}  [{c.get('source')}]" + (f"  also: {al}" if al else ""))
    elif cmd == "camera":
        title = " ".join(args[1:])
        cams, _ = _cams()
        if not cams:
            print("NO CAMERAS: discovery found nothing (no Frigate, no IP cameras).")
            sys.exit(3)
        m = _match_cam(title, cams)
        if m:
            call("POST", "/api/camera", {"id": m["id"]})
            print(f"ON SCREEN: {m['name']} feed (live).")
        else:
            first = cams[0]
            call("POST", "/api/camera", {"id": first["id"], "identify": title})
            print(f"NO MATCH: no camera titled '{title}'. ON SCREEN: first feed is {first['name']} (identify mode, {len(cams)} camera(s) total).")
            print(f"ASK HAROLD: I can't find a device with that title, but let me show you what I do have. Is this the {title}?")
    elif cmd == "camera-yes":
        cams, snap = _cams()
        cv = snap.get("cameraView") or {}
        if not cv.get("identify") or not cv.get("cameraId"):
            print("NOT IDENTIFYING: no pending camera question on screen.")
            sys.exit(2)
        cam = next((c for c in cams if c["id"] == cv["cameraId"]), None)
        call("POST", "/api/camera/alias", {"id": cv["cameraId"], "alias": cv["identify"]})
        call("POST", "/api/camera", {"id": cv["cameraId"]})
        print(f"SAVED: {cam['name'] if cam else cv['cameraId']} is now also called '{cv['identify']}'. ON SCREEN: its feed, identify mode off.")
    elif cmd == "camera-no":
        cams, snap = _cams()
        cv = snap.get("cameraView") or {}
        if not cv.get("identify") or not cv.get("cameraId"):
            print("NOT IDENTIFYING: no pending camera question on screen.")
            sys.exit(2)
        idx = next((i for i, c in enumerate(cams) if c["id"] == cv["cameraId"]), -1)
        nxt = cams[idx + 1] if 0 <= idx < len(cams) - 1 else None
        if nxt:
            call("POST", "/api/camera", {"id": nxt["id"], "identify": cv["identify"]})
            print(f"ON SCREEN: next feed is {nxt['name']}. ASK HAROLD: Is this the {cv['identify']}?")
        else:
            call("POST", "/api/camera", {"clear": True})
            print(f"NO MORE CAMERAS: showed all {len(cams)} feed(s); none was confirmed as '{cv['identify']}'. Screen is back to the board.")
    elif cmd == "calendar-day":
        import datetime as _dt
        import re as _re
        raw = " ".join(args[1:]).strip().lower().replace(",", "")
        _, snap = queue()
        cal = snap.get("calendar") or {}
        today = _dt.date.today()
        anchor_d = today
        if cal.get("anchor"):
            try: anchor_d = _dt.date.fromisoformat(cal["anchor"])
            except ValueError: pass
        target = None
        try:
            target = _dt.date.fromisoformat(raw)
        except ValueError:
            pass
        if target is None:
            mon_names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
            month = None; day = None
            for tok in raw.split():
                t = _re.sub(r"(st|nd|rd|th)$", "", tok)
                if t.isdigit():
                    day = int(t)
                else:
                    for i, mn in enumerate(mon_names, 1):
                        if tok == mn or tok == mn[:3]:
                            month = i
            if day is None:
                print("NO_DATE: could not read a day out of: " + raw)
                sys.exit(2)
            if month is not None:
                y = anchor_d.year
                target = _dt.date(y, month, day)
                if target < anchor_d - _dt.timedelta(days=15):
                    target = _dt.date(y + 1, month, day)
            else:
                win_end = anchor_d + _dt.timedelta(days=29)
                cands = []
                base = anchor_d
                for k in range(0, 3):
                    y = base.year + (base.month - 1 + k) // 12
                    m = (base.month - 1 + k) % 12 + 1
                    try: cands.append(_dt.date(y, m, day))
                    except ValueError: pass
                inwin = [c for c in cands if anchor_d <= c <= win_end]
                future = [c for c in cands if c >= today]
                target = inwin[0] if inwin else (future[0] if future else cands[-1])
        call("POST", "/api/calendar", {"view": "day", "date": target.isoformat(), "show": True})
        evs = [e for e in (cal.get("events") or []) if e.get("date") == target.isoformat()]
        label = target.strftime("%A, %B %-d, %Y")
        print(f"ON SCREEN: calendar, day view for {label}. {len(evs)} event(s).")
        for e in evs:
            t = "ALL DAY" if e.get("allDay") else (e.get("start", "") + ("-" + e["end"] if e.get("end") else ""))
            print(f"  {t}  {e.get('title', '')}" + (f" @ {e['location']}" if e.get("location") else ""))
    elif cmd == "calendar-hide":
        call("POST", "/api/calendar", {"show": False})
        print("SCREEN CLEARED: calendar closed.")
    elif cmd == "resolve":
        n = int(args[1])
        action = args[2] if len(args) > 2 else "skipped"
        card = nth(n)
        call("POST", "/api/resolve", {"id": card["id"], "action": action})
        print(f"RESOLVED: number {n} ('{card.get('title')}') marked {action}.")
    elif cmd == "attach":
        n = int(args[1])
        card = nth(n)
        payload = json.loads(sys.stdin.read() or "{}")
        payload["id"] = card["id"]
        r = call("POST", "/api/detail", payload)
        print(f"ATTACHED to number {n}: {r}")
        print_card({**card, **{k: v for k, v in payload.items() if k in ('thread', 'draft')}}, n)
    elif cmd == "avatar":
        call("POST", "/api/state", {"state": args[1], "message": args[2] if len(args) > 2 else ""})
        print(f"AVATAR: {args[1]}")
    else:
        print(f"unknown command: {cmd}")
        sys.exit(2)


if __name__ == "__main__":
    main()
