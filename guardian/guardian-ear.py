#!/usr/bin/env python3
"""Guardian ear for Asterisk pass-through calls (per-leg edition).

Asterisk records each leg's own microphone stream with MixMonitor r():
  guardian-<dir>-<ts>-<peer>-her.raw   (the house side, mono PCM)
  guardian-<dir>-<ts>-<peer>-them.raw  (the remote side, mono PCM)
This feeder streams each growing file into cosmo-ui's ear pipeline in
~3.2 s chunks with proper side labels (live pass: small model, scam
watch), and at call end re-transcribes each side whole with the big
model (large-v3-turbo) and replaces the saved record's lines.
"""
import base64, json, os, re, socket, struct, threading, time, urllib.request

MON = "/var/spool/asterisk/monitor"
BOARD = "http://127.0.0.1:3180"
STATE = os.path.expanduser("~/.guardian-ear-state.json")
CHUNK = 51200  # 3.2 s of 8 kHz 16-bit mono
NAME = re.compile(r"^guardian-(in|out)-(\d{8})-(\d{6})-(\+?\d+)-(her|them)\.raw$")
BIG_WHISPER = ("192.168.1.50", 10301)  # large-v3-turbo, guardian-whisper container
ACC = {}  # callId -> {"local": bytearray, "remote": bytearray} (memory only)
LIVE = set()  # callIds in a live call right now (main loop maintains)
FINAL_LOCK = threading.Lock()  # one final pass at a time

def post(path, body):
    req = urllib.request.Request(BOARD + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status
    except Exception as e:
        print("post fail", path, e, flush=True)
        return 0

def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(s, f)
    os.replace(tmp, STATE)

def _send_event(sock, ev):
    data = ev.pop("data", None)
    payload = ev.pop("payload", None)
    db = b""
    if data is not None:
        db = json.dumps(data).encode()
        ev["data_length"] = len(db)
    if payload is not None:
        ev["payload_length"] = len(payload)
    else:
        payload = b""
    sock.sendall(json.dumps(ev).encode() + b"\n" + db + payload)

def _read_event(sock, buf):
    while b"\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    line, buf = buf.split(b"\n", 1)
    ev = json.loads(line)
    dl = ev.get("data_length", 0)
    while len(buf) < dl:
        buf += sock.recv(65536)
    if dl:
        ev["data"] = json.loads(buf[:dl])
        buf = buf[dl:]
    pl = ev.get("payload_length", 0)
    while len(buf) < pl:
        buf += sock.recv(65536)
    if pl:
        ev["payload"] = buf[:pl]
        buf = buf[pl:]
    return ev, buf

def transcribe_big(pcm):
    try:
        s = socket.create_connection(BIG_WHISPER, timeout=180)
        _send_event(s, {"type": "transcribe", "data": {"language": "en"}})
        _send_event(s, {"type": "audio-start", "data": {"rate": 8000, "width": 2, "channels": 1}})
        for i in range(0, len(pcm), 32000):
            _send_event(s, {"type": "audio-chunk", "data": {"rate": 8000, "width": 2, "channels": 1}, "payload": bytes(pcm[i:i + 32000])})
        _send_event(s, {"type": "audio-stop"})
        buf = b""
        for _ in range(40):
            ev, buf = _read_event(s, buf)
            if ev.get("type") == "transcript":
                s.close()
                return (ev.get("data") or {}).get("text", "").strip()
        s.close()
    except Exception as e:
        print("big transcribe fail", e, flush=True)
    return ""

def sentences(text):
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]

def send_chunk(call_id, side, pcm):
    acc = ACC.setdefault(call_id, {"local": bytearray(), "remote": bytearray()})
    acc[side] += pcm
    post("/api/guardian/audio",
         {"callId": call_id, "side": side, "rate": 8000,
          "pcm": base64.b64encode(pcm).decode()})

ARTIFACTS = {"thank you", "thanks", "you", "thank you very much",
             "thank you for watching", "thanks for watching",
             "bye", "bye bye", "okay", "ok", "uh", "um", "hmm"}

def norm_text(t):
    return re.sub(r"[^a-z ]", "", t.lower()).strip()

def is_artifact(text, dur_ms, mean_rms):
    """Whisper invents stock phrases ('Thank you.') on stray sounds.
    Drop a line only if it is a known phantom phrase AND short/quiet -
    a real 'thank you' spoken at normal level survives."""
    return norm_text(text) in ARTIFACTS and (dur_ms < 1400 or mean_rms < 700)

def utterances(pcm):
    """Energy VAD: return [(start_ms, pcm_bytes, mean_rms)] of speech runs."""
    frame = 320  # 20 ms of 8 kHz 16-bit mono
    n = len(pcm) // frame
    if n == 0:
        return []
    rms = []
    for i in range(n):
        s = struct.unpack("<%dh" % (frame // 2), pcm[i * frame:(i + 1) * frame])
        rms.append(int((sum(x * x for x in s) / len(s)) ** 0.5))
    out = []
    i = 0
    while i < n:
        if rms[i] > 350:
            j = i
            gap = 0
            last = i
            while j < n:
                if rms[j] > 350:
                    last = j
                    gap = 0
                else:
                    gap += 1
                    if gap > 30:  # 600 ms of quiet ends the utterance
                        break
                j += 1
            start = max(0, i - 10)  # 200 ms lead-in
            end = min(n, last + 11)  # 200 ms tail
            seg = pcm[start * frame:end * frame]
            speech = [rms[k] for k in range(i, last + 1) if rms[k] > 350]
            peak = max(speech) if speech else 0
            mean = int(sum(speech) / len(speech)) if speech else 0
            if len(seg) >= 5600 and peak >= 600:  # >= 0.35 s, real voice level
                out.append((start * 20, seg, mean))
            i = j
        else:
            i += 1
    return out

def final_pass(rec, key):
    # Runs on its own thread: a review must never block the monitor loop
    # (it starved the NEXT call's live audio once - 2026-10-28). One at a
    # time, and never while a call is live: live caller transcription
    # shares the big model and protection is real-time.
    with FINAL_LOCK:
        waited = 0
        while LIVE and waited < 900:
            time.sleep(2)
            waited += 2
        _final_pass_inner(rec, key)

def _final_pass_inner(rec, key):
    acc = ACC.pop(key, None)
    if not acc:
        return
    stamped = []
    for side in ("local", "remote"):
        pcm = bytes(acc[side])
        if len(pcm) < 16000:
            continue
        for start_ms, seg, mean in utterances(pcm):
            text = transcribe_big(seg)
            if text and not is_artifact(text, len(seg) // 16, mean):
                stamped.append((start_ms, side, text))
    if not stamped:
        # fallback: whole-side blocks (better than nothing)
        blocks = {}
        for side in ("local", "remote"):
            pcm = bytes(acc[side])
            if len(pcm) >= 16000:
                text = transcribe_big(pcm)
                if text and norm_text(text) not in ARTIFACTS:
                    blocks[side] = text
        lines = [{"side": s, "text": t, "atMs": 0} for s, t in blocks.items()]
        if lines:
            post("/api/guardian/call-final", {"callId": key, "lines": lines})
            print("final pass (block fallback)", key, len(lines), flush=True)
        return
    stamped.sort(key=lambda x: x[0])
    lines = [{"side": side, "text": text, "atMs": start_ms}
             for start_ms, side, text in stamped]
    post("/api/guardian/call-final", {"callId": key, "lines": lines})
    print("final pass", key, len(lines), "utterance lines", flush=True)

def main():
    state = load_state()
    if not state:
        try:
            for name in os.listdir(MON):
                m = NAME.match(name)
                if m:
                    key = name.rsplit("-", 1)[0]
                    state[key] = {"started": True, "done": True, "dir": "in",
                                  "peer": "", "off": {}}
            save_state(state)
            print("seeded", len(state), "existing recordings as done", flush=True)
        except Exception as e:
            print("seed fail", e, flush=True)
    print("guardian-ear (per-leg) up", flush=True)
    while True:
        try:
            names = sorted(os.listdir(MON))
        except Exception:
            names = []
        calls = {}
        for name in names:
            m = NAME.match(name)
            if not m:
                continue
            direction, _d, _t, peer, side = m.groups()
            key = name.rsplit("-", 1)[0]
            calls.setdefault(key, {"dir": "in" if direction == "in" else "out",
                                   "peer": peer, "sides": {}})["sides"][side] = name
        for key, info in calls.items():
            rec = state.get(key)
            if rec is None:
                peer = info["peer"]
                if not peer.startswith("+"):
                    peer = "+1" + peer if len(peer) == 10 else "+" + peer
                rec = {"off": {}, "started": False, "dir": info["dir"],
                       "peer": peer, "done": False}
                state[key] = rec
            if rec["done"]:
                continue
            any_growth = False
            any_file = False
            for side, name in info["sides"].items():
                path = os.path.join(MON, name)
                try:
                    st = os.stat(path)
                except Exception:
                    continue
                any_file = True
                if time.time() - st.st_mtime < 6:
                    any_growth = True
                off = rec["off"].get(side, 0)
                label = "local" if side == "her" else "remote"
                if not rec["started"] and st.st_size >= 3200:
                    post("/api/guardian/call-start",
                         {"callId": key, "peer": rec["peer"], "dir": rec["dir"]})
                    rec["started"] = True
                    LIVE.add(key)
                    print("call start", key, rec["peer"], rec["dir"], flush=True)
                while st.st_size - off >= CHUNK:
                    with open(path, "rb") as f:
                        f.seek(off)
                        raw = f.read(CHUNK)
                    send_chunk(key, label, raw)
                    off += CHUNK
                rec["off"][side] = off
            if rec["started"] and any_file and not any_growth:
                # flush tails, close the call
                for side, name in info["sides"].items():
                    path = os.path.join(MON, name)
                    try:
                        st = os.stat(path)
                    except Exception:
                        continue
                    off = rec["off"].get(side, 0)
                    label = "local" if side == "her" else "remote"
                    tail = st.st_size - off
                    if tail >= 1600:
                        with open(path, "rb") as f:
                            f.seek(off)
                            raw = f.read(tail - (tail % 2))
                        send_chunk(key, label, raw)
                        rec["off"][side] = off + len(raw)
                post("/api/guardian/call-end", {"callId": key})
                rec["done"] = True
                LIVE.discard(key)
                print("call end", key, flush=True)
                threading.Thread(target=final_pass, args=(rec, key), daemon=True).start()
        save_state(state)
        time.sleep(2)

if __name__ == "__main__":
    main()
