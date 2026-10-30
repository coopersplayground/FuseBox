#!/home/cosmo/cosmo-listener/venv/bin/python
"""Cosmo listener for Server 2 - gives Cosmo (via the Muse gadget) a voice.

Loop:
  mic (webcam, ALSA) -> energy VAD segments -> local faster-whisper (Wyoming,
  :10300) -> wake-phrase spot ("Hey Cosmo") -> transcript is sent to Cosmo with
  `musegadget send-user-msg --session-id <voice session>`.
Cosmo speaks back by running ~/cosmo-listener/speak.py on this box through the
gadget. While he is speaking this listener keeps listening: a stop phrase or a
new wake phrase cuts playback (state/stop.flag) - barge-in.

All audio processing is local. Only transcripts leave the room, and only
after the wake phrase is heard.

Usage:
  listener.py                 live mic loop
  listener.py --test-file f.wav [--dry-run]   feed one wav through the pipeline
  listener.py --dry-run       live loop, print dispatches instead of sending
"""
import argparse
import asyncio
import json
import math
import random
import re
import struct
import subprocess
import sys
import time
import uuid
import wave
from pathlib import Path

try:
    import uipost
except Exception:
    uipost = None

try:
    import router as local_router
except Exception:
    local_router = None

try:
    import spark as spark_tier
except Exception:
    spark_tier = None

BASE = Path.home() / "cosmo-listener"
STATE = BASE / "state"
LOGS = BASE / "logs"
SESSION_FILE = BASE / "session-id"
PREAMBLE_FILE = BASE / "preamble.txt"
CONFIG = BASE / "config.json"

RATE = 16000
FRAME_SAMPLES = 480  # 30 ms
FRAME_BYTES = FRAME_SAMPLES * 2


def cfg():
    defaults = {
        "mic_device": "plughw:CARD=WBC0E01,DEV=0",
        "whisper_host": "127.0.0.1",
        "whisper_port": 10300,
        "vad_start_frames": 3,       # consecutive loud frames to open a segment
        "vad_end_silence_s": 1.4,    # trailing silence that closes a segment
        "min_segment_s": 0.6,
        "max_segment_s": 25.0,
        "threshold_min": 500,        # RMS floor for "loud"
        "armed_window_s": 12,        # after bare wake word, next segment = command
    }
    if CONFIG.exists():
        try:
            defaults.update(json.loads(CONFIG.read_text()))
        except Exception:
            pass
    return defaults


def log(msg):
    LOGS.mkdir(parents=True, exist_ok=True)
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with (LOGS / "listener.log").open("a") as f:
        f.write(line + "\n")


STATUS_JSON = STATE / "status.json"


def _read_status():
    try:
        return json.loads(STATUS_JSON.read_text())
    except Exception:
        return {}


def _merge_status(**fields):
    STATE.mkdir(parents=True, exist_ok=True)
    s = _read_status()
    s.update(fields)
    s["updated"] = time.time()
    tmp = STATUS_JSON.with_suffix(".tmp")
    tmp.write_text(json.dumps(s))
    tmp.replace(STATUS_JSON)
    return s


_last_ui_post = [None, None]


def _post_ui(state, detail):
    """Mirror listener state onto the cosmo-ui avatar (best-effort)."""
    if uipost is None:
        return
    try:
        if state == "listening":
            key = ("listening", detail or "Listening")
            if _last_ui_post != list(key):
                uipost.post("listening", detail or "Listening")
                _last_ui_post[:] = list(key)
        elif state == "thinking":
            key = ("working", detail or "Working")
            if _last_ui_post != list(key):
                uipost.post("working", detail or "Working")
                _last_ui_post[:] = list(key)
        elif state == "waiting":
            key = ("baseline", "")
            if _last_ui_post != list(key):
                uipost.post_baseline()
                _last_ui_post[:] = list(key)
    except Exception:
        pass


def set_state(state, detail="", **extra):
    s = _read_status()
    if s.get("state") != state:
        extra["since"] = time.time()
    extra["state"] = state
    extra["detail"] = detail
    out = _merge_status(**extra)
    _post_ui(state, detail)
    return out


def rms(frame: bytes) -> float:
    n = len(frame) // 2
    if n == 0:
        return 0.0
    samples = struct.unpack(f"<{n}h", frame[: n * 2])
    return math.sqrt(sum(s * s for s in samples) / n)


# ---------------------------------------------------------------- whisper
async def _transcribe(pcm: bytes, c) -> str:
    from wyoming.asr import Transcribe, Transcript
    from wyoming.audio import AudioChunk, AudioStart, AudioStop
    from wyoming.client import AsyncTcpClient

    client = AsyncTcpClient(c["whisper_host"], c["whisper_port"])
    await client.connect()
    try:
        await client.write_event(Transcribe(language="en").event())
        await client.write_event(AudioStart(rate=RATE, width=2, channels=1).event())
        step = 8192
        for i in range(0, len(pcm), step):
            await client.write_event(AudioChunk(
                rate=RATE, width=2, channels=1, audio=pcm[i:i + step]).event())
        await client.write_event(AudioStop().event())
        text = ""
        while True:
            event = await client.read_event()
            if event is None:
                break
            if Transcript.is_type(event.type):
                text = Transcript.from_event(event).text
                break
        return text.strip()
    finally:
        await client.disconnect()


def transcribe(pcm: bytes, c) -> str:
    return asyncio.run(_transcribe(pcm, c))


# ---------------------------------------------------------------- wake word
WAKE_RE = re.compile(
    r"(hey|hay|ok|okay|a|eh)?\s*,?\s*(cosmo|cosmos|kosmo)\b[ ,.:;!]*", re.I)
STOP_WORDS = {"stop", "stop talking", "quiet", "be quiet", "never mind",
              "nevermind", "cancel", "shut up", "enough", "thats enough",
              "that's enough"}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().strip())


def split_wake(text: str):
    """Return (woke, command). command '' means bare wake word only."""
    t = normalize(text)
    m = WAKE_RE.search(t)
    if not m:
        return False, ""
    # Require the wake phrase at the start, or 'hey/ok cosmo' anywhere.
    if m.start() > 0 and not (m.group(1) and m.group(1) in ("hey", "hay", "ok", "okay")):
        return False, ""
    rest = t[m.end():].strip(" ,.:;!")
    return True, rest


def is_stop(text: str) -> bool:
    t = normalize(text).strip(" .! ")
    return t in STOP_WORDS or t.startswith("stop ")



def try_local_route(command: str, dry_run: bool) -> bool:
    """Local reflex layer: classify the command with the on-box Llama
    router (config local_router) and execute board display commands
    locally. Returns True when handled - the caller then skips dispatch
    to the cloud session. Any doubt, error, or out-of-set command
    returns False and dispatch proceeds exactly as before."""
    if local_router is None:
        return False
    try:
        if not cfg().get("local_router", False):
            return False
    except Exception:
        return False
    try:
        route = local_router.classify(command)
    except Exception as e:  # noqa: BLE001
        log(f"local router error: {e}")
        return False
    if not route:
        return False
    if dry_run:
        log(f"DRY-RUN local route {route} for {command!r}")
        return True
    try:
        what = local_router.execute(route)
    except Exception as e:  # noqa: BLE001
        log(f"local route execute failed ({route}): {e}")
        return False
    log(f"handled locally: {command!r} -> {what}")
    _merge_status(last_local_route=f"{command} -> {what}", last_local_route_at=time.time())
    set_state("waiting", "Say 'Hey Cosmo'")
    return True


def try_spark_answer(command: str, dry_run: bool) -> bool:
    # Tier 2: Muse Spark quick answers from the board-state digest
    # (config spark_tier). Answers only, never acts. True when answered
    # and spoken; any doubt or error returns False and dispatch to the
    # cloud session proceeds exactly as before.
    if spark_tier is None:
        return False
    try:
        if not cfg().get("spark_tier", False):
            return False
    except Exception:
        return False
    try:
        answer = spark_tier.try_answer(command)
    except Exception as e:  # noqa: BLE001
        log(f"spark tier error: {e}")
        return False
    if not answer:
        return False
    if dry_run:
        log(f"DRY-RUN spark answer {answer!r} for {command!r}")
        return True
    try:
        subprocess.Popen([sys.executable, str(BASE / "speak.py"), answer])
    except Exception as e:  # noqa: BLE001
        log(f"spark answer speak failed: {e}")
        return False
    log(f"answered by spark: {command!r} -> {answer!r}")
    _merge_status(last_spark_answer=f"{command} -> {answer}", last_spark_answer_at=time.time())
    set_state("waiting", "Say 'Hey Cosmo'")
    return True

# ---------------------------------------------------------------- dispatch
def get_session_id() -> str:
    if SESSION_FILE.exists():
        return SESSION_FILE.read_text().strip()
    sid = str(uuid.uuid4())
    SESSION_FILE.write_text(sid)
    return sid


def dispatch(command: str, dry_run: bool) -> bool:
    sid = get_session_id()
    marker = STATE / f"protocol-sent-{sid}"
    parts = []
    if not marker.exists():
        parts.append(PREAMBLE_FILE.read_text().strip())
    parts.append(f"[voice] {command}")
    msg = "\n\n".join(parts)
    if dry_run:
        log(f"DRY-RUN dispatch session={sid} msg={msg!r}")
        return True
    for prefix in ([], ["sudo", "-n"]):
        try:
            r = subprocess.run(prefix + ["musegadget", "send-user-msg",
                                         "--session-id", sid, msg],
                               capture_output=True, text=True, timeout=30)
            if r.returncode == 0:
                STATE.mkdir(parents=True, exist_ok=True)
                marker.touch()
                log(f"dispatched session={sid} via {'sudo' if prefix else 'direct'}: {command!r}")
                return True
            log(f"send-user-msg {'sudo' if prefix else 'direct'} rc={r.returncode} err={r.stderr.strip()[:200]}")
        except Exception as e:  # noqa: BLE001
            log(f"send-user-msg failed: {e}")
    return False


def speaking() -> bool:
    pidfile = STATE / "speaking.pid"
    if not pidfile.exists():
        return False
    try:
        pid = int(pidfile.read_text().strip())
        import os
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def stop_speaking():
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "stop.flag").write_text("1")


def play_ack():
    """Play a random acknowledgment from the ack pool (acks/ack-*.wav),
    never the same one twice in a row. Falls back to the legacy ack.wav."""
    acks = sorted((BASE / "acks").glob("ack-*.wav"))
    if acks:
        STATE.mkdir(parents=True, exist_ok=True)
        last_file = STATE / "last-ack.txt"
        last = last_file.read_text().strip() if last_file.exists() else ""
        choices = [a for a in acks if a.name != last] or acks
        pick = random.choice(choices)
        last_file.write_text(pick.name)
        phrase = pick.name
        try:
            manifest = json.loads((BASE / "acks" / "manifest.json").read_text())
            phrase = manifest.get(pick.name, pick.name)
        except Exception:
            pass
        _merge_status(last_ack=phrase, last_ack_at=time.time())
        log(f"ack: {pick.name}")
        subprocess.Popen([str(BASE / "speak.py"), "--file", str(pick)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    ack = BASE / "ack.wav"
    if ack.exists():
        subprocess.Popen([str(BASE / "speak.py"), "--file", str(ack)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- segments
def handle_segment(pcm: bytes, c, state: dict, dry_run: bool):
    set_state("thinking", "Transcribing what you said...")
    text = transcribe(pcm, c)
    if not text:
        set_state("waiting", "Say 'Hey Cosmo'")
        return
    _merge_status(last_heard=text, last_heard_at=time.time())
    log(f"heard: {text!r} (speaking={speaking()}, armed={state.get('armed_until', 0) > time.time()})")
    if speaking():
        if is_stop(text):
            stop_speaking()
            log("stop phrase -> playback cut")
            set_state("waiting", "Say 'Hey Cosmo'")
            return
    woke, command = split_wake(text)
    if woke:
        if speaking():
            stop_speaking()
            log("wake during playback -> cut, barge-in")
        if command:
            if try_local_route(command, dry_run):
                state["armed_until"] = 0
            elif try_spark_answer(command, dry_run):
                state["armed_until"] = 0
            elif dispatch(command, dry_run):
                set_state("thinking", f"Cosmo is thinking - you asked: {command}",
                          last_command=command, last_command_at=time.time(),
                          armed_until=0)
            else:
                set_state("waiting", "Could not reach Cosmo")
        else:
            state["armed_until"] = time.time() + c["armed_window_s"]
            play_ack()
            set_state("listening", "Awake - say your command",
                      armed_until=state["armed_until"])
            log("bare wake word -> armed, ack played")
        return
    if state.get("armed_until", 0) > time.time() and not speaking():
        if is_stop(text):
            state["armed_until"] = 0
            set_state("waiting", "Say 'Hey Cosmo'", armed_until=0)
            log("armed + stop -> disarmed")
            return
        state["armed_until"] = 0
        cmd = normalize(text)
        if try_local_route(cmd, dry_run):
            pass
        elif try_spark_answer(cmd, dry_run):
            pass
        elif dispatch(cmd, dry_run):
            set_state("thinking", f"Cosmo is thinking - you asked: {cmd}",
                      last_command=cmd, last_command_at=time.time(),
                      armed_until=0)
        else:
            set_state("waiting", "Could not reach Cosmo", armed_until=0)
        return
    set_state("waiting", "Say 'Hey Cosmo'")


def resample_pcm(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate:
        return pcm
    n = len(pcm) // 2
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    out_n = int(n * dst_rate / src_rate)
    out = []
    for i in range(out_n):
        pos = i * src_rate / dst_rate
        j = int(pos)
        frac = pos - j
        a = samples[j]
        b = samples[min(j + 1, n - 1)]
        out.append(int(a + (b - a) * frac))
    return struct.pack(f"<{len(out)}h", *out)


def test_file(path: str, dry_run: bool):
    c = cfg()
    with wave.open(path, "rb") as w:
        rate, width, channels = w.getframerate(), w.getsampwidth(), w.getnchannels()
        pcm = w.readframes(w.getnframes())
    if width != 2 or channels != 1:
        log(f"test file must be 16-bit mono (got width={width} ch={channels})")
        return 1
    pcm = resample_pcm(pcm, rate, RATE)
    state = {}
    handle_segment(pcm, c, state, dry_run)
    return 0


def live(dry_run: bool):
    c = cfg()
    log(f"listener starting: mic={c['mic_device']} session={get_session_id()}")
    set_state("waiting", "Say 'Hey Cosmo'")
    proc = subprocess.Popen(
        ["arecord", "-D", c["mic_device"], "-f", "S16_LE", "-r", str(RATE),
         "-c", "1", "-t", "raw"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    noise_floor = 150.0
    in_segment = False
    loud_run = 0
    silence_run = 0
    segment = bytearray()
    preroll = bytearray()
    state = {}
    end_silence_frames = int(c["vad_end_silence_s"] / 0.03)
    min_frames = int(c["min_segment_s"] / 0.03)
    max_frames = int(c["max_segment_s"] / 0.03)
    frames_in_segment = 0
    last_hb = 0.0
    try:
        while True:
            frame = proc.stdout.read(FRAME_BYTES)
            now = time.time()
            if now - last_hb > 4:
                last_hb = now
                _merge_status()
            if not frame or len(frame) < FRAME_BYTES:
                log("mic stream ended")
                raise ConnectionError("mic stream ended")
            level = rms(frame)
            threshold = max(c["threshold_min"], noise_floor * 3.0)
            loud = level > threshold
            if not in_segment:
                noise_floor = noise_floor * 0.98 + min(level, threshold) * 0.02
                preroll = (preroll + frame)[-FRAME_BYTES * 10:]
                if loud:
                    loud_run += 1
                    if loud_run >= c["vad_start_frames"]:
                        in_segment = True
                        set_state("listening", "Hearing you...")
                        segment = bytearray(preroll)
                        segment += frame
                        frames_in_segment = loud_run
                        silence_run = 0
                else:
                    loud_run = 0
            else:
                segment += frame
                frames_in_segment += 1
                if loud:
                    silence_run = 0
                else:
                    silence_run += 1
                if silence_run >= end_silence_frames or frames_in_segment >= max_frames:
                    in_segment = False
                    loud_run = 0
                    if frames_in_segment >= min_frames:
                        handle_segment(bytes(segment), c, state, dry_run)
                    segment = bytearray()
                    frames_in_segment = 0
    except KeyboardInterrupt:
        proc.terminate()
        log("listener stopped")
        sys.exit(0)
    except ConnectionError:
        proc.terminate()
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-file")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.test_file:
        return test_file(args.test_file, args.dry_run)
    while True:
        try:
            live(args.dry_run)
        except ConnectionError:
            log("mic unavailable; retrying in 10s")
            time.sleep(10)


if __name__ == "__main__":
    sys.exit(main())
