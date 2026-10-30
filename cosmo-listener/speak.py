#!/home/cosmo/cosmo-listener/venv/bin/python
"""Cosmo speak path.

Spoken output uses NO AI model: the board page speaks queued lines with
the browser's built-in speechSynthesis (a browser feature, per the
contest rules). If the board is unreachable, espeak-ng (a rule-based
formant synthesizer) speaks through the local speakers instead.

Usage:
  speak.py "text to speak"
  speak.py --file some.wav        play an existing wav
  speak.py --render out.wav "text"  synthesize only, no playback
Playback registers state/speaking.pid; writing state/stop.flag cuts it off.
"""
import asyncio
import io
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

BASE = Path.home() / "cosmo-listener"
STATE = BASE / "state"
LOGS = BASE / "logs"
PIDFILE = STATE / "speaking.pid"
STOPFLAG = STATE / "stop.flag"
CONFIG = BASE / "config.json"



def cfg():
    defaults = {
        "board_url": "http://127.0.0.1:3180",
        "lead_in_s": 0.9,
        "play_devices": ["plughw:CARD=Generic_1,DEV=9",
                         "plughw:CARD=Generic,DEV=0"],
    }
    if CONFIG.exists():
        try:
            defaults.update(json.loads(CONFIG.read_text()))
        except Exception:
            pass
    return defaults


def log(msg):
    LOGS.mkdir(parents=True, exist_ok=True)
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    with (LOGS / "speak.log").open("a") as f:
        f.write(line)


def _write_speaking(text, engine):
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "speaking.json").write_text(json.dumps(
        {"text": text, "engine": engine, "started": time.time()}))
    (STATE / "last-spoken.json").write_text(json.dumps(
        {"text": text, "engine": engine, "at": time.time()}))
    try:
        import uipost
        uipost.post("speaking", (text or "")[:150])
    except Exception:
        pass


def _clear_speaking():
    try:
        (STATE / "speaking.json").unlink()
    except Exception:
        pass
    try:
        import uipost
        uipost.post_baseline()
    except Exception:
        pass


def synth_espeak(text):
    r = subprocess.run(["espeak-ng", "--stdout", "-v", "en-US", "-s", "165",
                        str(text)], capture_output=True, timeout=30)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError("espeak-ng failed")
    return r.stdout


def _board_post(path, payload, timeout=5):
    import urllib.request
    c = cfg()
    base = str(c.get("board_url", "http://127.0.0.1:3180")).rstrip("/")
    req = urllib.request.Request(base + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def say(text):
    """Spoken output without any AI model: the board page speaks with the
    browser's built-in speechSynthesis (a browser feature). Fallback:
    espeak-ng (rule-based formant synthesis) through the local speakers."""
    try:
        if _board_post("/api/tts-say", {"text": text}) == 200:
            return "browser"
    except Exception as e:
        log(f"board say failed ({e}); espeak fallback")
    wav = synth_espeak(text)
    out = STATE / "last-speak.wav"
    out.write_bytes(wav)
    r = play_wav(out)
    if r == "failed":
        raise RuntimeError("espeak fallback playback failed")
    return "espeak"


def alsa_candidates():
    """Playback devices in preference order: a USB *speaker* if one appears
    (never the capture mic's own headphone/monitor jack), then the config
    list (HDMI monitor first by default)."""
    c = cfg()
    mic_card = ""
    m = re.search(r"CARD=([^,]+)", c.get("mic_device", ""))
    if m:
        mic_card = m.group(1).strip()
    devs = []
    try:
        out = subprocess.run(["aplay", "-l"], capture_output=True,
                             text=True, timeout=5).stdout
        # aplay -l device lines look like:
        # card 1: Device [FDUCE SL40 Audio Device], device 0: USB Audio [USB Audio]
        for line in out.splitlines():
            m = re.match(r"card \d+: (\S+) \[.*\], device (\d+):", line)
            if m and "USB Audio" in line and m.group(1) != mic_card:
                devs.append(f"plughw:CARD={m.group(1)},DEV={m.group(2)}")
    except Exception:
        pass
    devs += c.get("play_devices", ["plughw:CARD=Generic_1,DEV=9",
                                    "plughw:CARD=Generic,DEV=0"])
    seen, ordered = set(), []
    for d in devs:
        if d not in seen:
            seen.add(d)
            ordered.append(d)
    return ordered


def wav_seconds(path):
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 10.0


def _pad_lead_in(path):
    """Prepend lead-in silence so the HDMI sink's wake-up latency eats
    silence instead of the first syllable. Returns a padded copy path,
    or the original path on any failure."""
    try:
        seconds = float(cfg().get("lead_in_s", 0.9))
        if seconds <= 0:
            return path
        with wave.open(str(path), "rb") as w:
            params = w.getparams()
            frames = w.readframes(w.getnframes())
        silence = (b"\x00" * int(params.framerate * seconds)
                   * params.sampwidth * params.nchannels)
        out = STATE / "play-current.wav"
        with wave.open(str(out), "wb") as w:
            w.setparams(params)
            w.writeframes(silence + frames)
        return out
    except Exception:
        return path


def play_wav(path):
    """Play via ALSA with pidfile/stop-flag supervision and a hard watchdog
    (a hung player must never wedge the speak path)."""
    STATE.mkdir(parents=True, exist_ok=True)
    path = _pad_lead_in(path)
    if STOPFLAG.exists():
        STOPFLAG.unlink()
    deadline = time.time() + wav_seconds(path) + 10
    for dev in alsa_candidates():
        player = subprocess.Popen(["aplay", "-D", dev, str(path)],
                                  stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        PIDFILE.write_text(str(player.pid))
        result = None
        try:
            while player.poll() is None:
                if STOPFLAG.exists():
                    player.terminate()
                    result = "stopped"
                    break
                if time.time() > deadline:
                    player.kill()
                    result = "timeout"
                    break
                time.sleep(0.1)
            if result is None:
                result = "played" if player.returncode == 0 else "failed"
        finally:
            if PIDFILE.exists():
                PIDFILE.unlink()
            if STOPFLAG.exists():
                STOPFLAG.unlink()
        log(f"play dev={dev} result={result}")
        if result in ("played", "stopped"):
            return result
    return "failed"


def stop_current():
    try:
        _board_post("/api/tts-stop", {})
    except Exception:
        pass
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            return True
        except Exception:
            return False
    return False


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: speak.py [--voice N] [--file wav | --render out.wav] text",
              file=sys.stderr)
        return 2
    if args[0] == "--voice":
        args = args[2:]  # voice choice belongs to the browser now; accepted and ignored
    if args[0] == "--stop":
        print("stopped" if stop_current() else "not speaking")
        return 0
    if args[0] == "--file":
        p = Path(args[1])
        label, engine = p.name, "file"
        try:
            manifest = json.loads((BASE / "acks" / "manifest.json").read_text())
            if p.name in manifest:
                label, engine = manifest[p.name], "ack"
        except Exception:
            pass
        if not p.exists():
            _write_speaking(label, "browser")
            try:
                eng = say(label)
                r = "played"
            except Exception:
                r = "failed"
            finally:
                _clear_speaking()
            log(f"file-missing {args[1]} -> spoke label via {eng if r == 'played' else '?'}")
            print(r)
            return 0 if r != "failed" else 1
        _write_speaking(label, engine)
        try:
            r = play_wav(p)
        finally:
            _clear_speaking()
        log(f"file {args[1]} -> {r}")
        print(r)
        return 0 if r != "failed" else 1
    render_to = None
    if args[0] == "--render":
        render_to = Path(args[1])
        args = args[2:]
    text = " ".join(args).strip()
    if not text:
        print("no text", file=sys.stderr)
        return 2
    # Supersede anything currently speaking
    if PIDFILE.exists():
        stop_current()
        time.sleep(0.3)
    if render_to:
        render_to.write_bytes(synth_espeak(text))
        log(f"render engine=espeak chars={len(text)} text={text!r}")
        print("rendered:espeak")
        return 0
    _write_speaking(text, "browser")
    try:
        engine = say(text)
        r = "played"
    except Exception as e:
        engine, r = "none", "failed"
        log(f"speak failed: {e}")
    finally:
        _clear_speaking()
    log(f"speak engine={engine} result={r} chars={len(text)} text={text!r}")
    print(f"{r}:{engine}")
    return 0 if r != "failed" else 1


if __name__ == "__main__":
    sys.exit(main())
