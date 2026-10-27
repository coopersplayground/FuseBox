#!/usr/bin/env python3
"""cosmo - live status of the Cosmo voice listener on Server 2.

Prints one status block; run it under `watch` for a live feed:
    sudo watch cosmo
Reads only files under /home/cosmo/cosmo-listener - no user session needed,
so it works as root or as cosmo.
"""
import json
import os
import time
from pathlib import Path

BASE = Path("/home/cosmo/cosmo-listener")
STATE = BASE / "state"


def load(name):
    try:
        return json.loads((STATE / name).read_text())
    except Exception:
        return {}


def load_cfg():
    try:
        return json.loads((BASE / "config.json").read_text())
    except Exception:
        return {}


def fmt_clock(ts):
    return time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "--:--:--"


def fmt_ago(ts, now):
    if not ts:
        return ""
    s = int(now - ts)
    if s < 5:
        return "just now"
    if s < 90:
        return f"{s}s ago"
    if s < 5400:
        return f"{s // 60}m ago"
    return f"{s // 3600}h ago"


def fmt_dur(s):
    s = int(s)
    if s < 90:
        return f"{s}s"
    return f"{s // 60}m{s % 60:02d}s"


def main():
    now = time.time()
    st = load("status.json")
    sp = load("speaking.json")
    last = load("last-spoken.json")
    cfg = load_cfg()

    pid_alive = False
    pf = STATE / "speaking.pid"
    if pf.exists():
        try:
            os.kill(int(pf.read_text().strip()), 0)
            pid_alive = True
        except Exception:
            pid_alive = False
    speaking = pid_alive and bool(sp)

    updated = st.get("updated", 0)
    fresh = bool(updated) and (now - updated) < 20
    armed_until = st.get("armed_until", 0) or 0
    since = st.get("since", updated)

    if speaking:
        state = "SPEAKING"
        detail = sp.get("text", "")
        since = sp.get("started", now)
    elif not fresh:
        state = "OFFLINE?"
        detail = "listener heartbeat stale - systemctl --user status cosmo-listener"
    elif armed_until > now:
        state = "LISTENING"
        detail = "Awake - say your command"
        since = st.get("since", now)
    elif st.get("state") == "thinking" and (now - since) < 240:
        state = "THINKING"
        detail = st.get("detail", "")
    elif st.get("state") == "listening":
        state = "LISTENING"
        detail = st.get("detail", "")
    else:
        state = "WAITING"
        detail = "Say 'Hey Cosmo'"

    mic = cfg.get("mic_device", "?").replace("plughw:CARD=", "").replace(",DEV=0", "")
    engines = cfg.get("engine_order", ["kokoro"])
    session = ""
    try:
        session = (BASE / "session-id").read_text().strip()[:8]
    except Exception:
        pass

    print("=" * 56)
    print("  COSMO - voice status (Server 2)")
    print("=" * 56)
    print(f"  State:     {state}   ({fmt_dur(now - since)})")
    if detail:
        print(f"  Doing:     {detail}")
    print("-" * 56)
    if st.get("last_heard"):
        print(f"  Heard:     \"{st['last_heard']}\"  ({fmt_ago(st.get('last_heard_at', 0), now)})")
    if st.get("last_ack"):
        print(f"  Ack:       \"{st['last_ack']}\"  ({fmt_ago(st.get('last_ack_at', 0), now)})")
    if st.get("last_command"):
        print(f"  Asked:     \"{st['last_command']}\"  ({fmt_ago(st.get('last_command_at', 0), now)})")
    if last.get("text"):
        print(f"  Last said: \"{last['text']}\"  [{last.get('engine', '?')}] ({fmt_ago(last.get('at', 0), now)})")
    print("-" * 56)
    hb = f"heartbeat {fmt_ago(updated, now)}" if updated else "no heartbeat"
    print(f"  Mic: {mic}   Voice: {engines[0]}   Session: {session}   {hb}")
    print("=" * 56)


if __name__ == "__main__":
    main()
