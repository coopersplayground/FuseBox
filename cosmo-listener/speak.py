#!/home/cosmo/cosmo-listener/venv/bin/python
"""Cosmo speak path for Server 2.

Synthesizes text to speech and plays it in the room.
Engine chain (first success wins):
  1. Kokoro-FastAPI (local, open voices)  http://127.0.0.1:8880/v1/audio/speech
  2. Piper via Wyoming (local, open voices)  tcp 127.0.0.1:10200
  3. ElevenLabs v3 (only if a key file exists at
     ~/.config/cosmo-voice/elevenlabs_api_key) - Cosmo's EL voice.

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

EL_VOICE_ID = ""  # fallback only - set your ElevenLabs voice ids in config.json (voices)
EL_KEY_FILE = Path.home() / ".config" / "cosmo-voice" / "elevenlabs_api_key"


def cfg():
    defaults = {
        "kokoro_url": "http://127.0.0.1:8880/v1/audio/speech",
        "kokoro_voice": "am_michael",
        "piper_host": "127.0.0.1",
        "piper_port": 10200,
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


def synth_kokoro(text, c):
    body = json.dumps({
        "model": "tts-1",
        "input": text,
        "voice": c["kokoro_voice"],
        "response_format": "wav",
    }).encode()
    req = urllib.request.Request(c["kokoro_url"], data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = resp.read()
    if len(data) < 1000:
        raise RuntimeError("kokoro returned tiny payload")
    return data  # wav bytes


async def _piper(text, c):
    from wyoming.audio import AudioStart, AudioStop
    from wyoming.client import AsyncTcpClient
    from wyoming.tts import Synthesize

    client = AsyncTcpClient(c["piper_host"], c["piper_port"])
    await client.connect()
    try:
        await client.write_event(Synthesize(text=text).event())
        rate, width, channels = 22050, 2, 1
        pcm = bytearray()
        while True:
            event = await client.read_event()
            if event is None:
                break
            if AudioStart.is_type(event.type):
                a = AudioStart.from_event(event)
                rate, width, channels = a.rate, a.width, a.channels
            elif event.type == "audio-chunk":
                from wyoming.audio import AudioChunk
                pcm += AudioChunk.from_event(event).audio
            elif AudioStop.is_type(event.type):
                break
        if not pcm:
            raise RuntimeError("piper returned no audio")
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(channels)
            w.setsampwidth(width)
            w.setframerate(rate)
            w.writeframes(bytes(pcm))
        return buf.getvalue()
    finally:
        await client.disconnect()


def synth_piper(text, c):
    return asyncio.run(_piper(text, c))


def active_voice_id(c):
    voices = c.get("voices", {})
    active = str(c.get("active_voice", "1"))
    v = voices.get(active, {})
    return v.get("voice_id") or EL_VOICE_ID


def synth_elevenlabs(text, c, voice_id=None):
    key = EL_KEY_FILE.read_text().strip()
    vid = voice_id or active_voice_id(c)
    url = (f"https://api.elevenlabs.io/v1/text-to-speech/{vid}"
           "?output_format=pcm_24000")
    body = json.dumps({"text": text, "model_id": "eleven_v3",
                       "voice_settings": {"stability": 0.5,
                                          "similarity_boost": 0.75,
                                          "speed": float(c.get("el_speed", 1.1))}}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json", "xi-api-key": key})
    with urllib.request.urlopen(req, timeout=25) as resp:
        pcm = resp.read()
    if len(pcm) < 1000:
        raise RuntimeError("elevenlabs returned tiny payload")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)
    return buf.getvalue()


def el_available():
    try:
        return EL_KEY_FILE.exists() and len(EL_KEY_FILE.read_text().strip()) > 0
    except Exception:
        return False


def synthesize(text, voice_id=None):
    c = cfg()
    available = {"kokoro": synth_kokoro, "piper": synth_piper}
    if el_available():
        available["elevenlabs-v3"] = (
            lambda t, cc: synth_elevenlabs(t, cc, voice_id))
    order = [n for n in c.get("engine_order",
                              ["elevenlabs-v3", "kokoro", "piper"])
             if n in available]
    for name in available:  # engines not listed in engine_order go last
        if name not in order:
            order.append(name)
    errors = []
    for name in order:
        try:
            wav = available[name](text, c)
            return name, wav
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")
    raise RuntimeError("all TTS engines failed: " + " | ".join(errors))


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
    voice_override_id = None
    if args[0] == "--voice":
        v = cfg().get("voices", {}).get(str(args[1]), {})
        voice_override_id = v.get("voice_id")
        if not voice_override_id:
            print(f"unknown voice: {args[1]}", file=sys.stderr)
            return 2
        args = args[2:]
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
    engine, wav = synthesize(text, voice_override_id)
    out = render_to or (STATE / "last-speak.wav")
    out.write_bytes(wav)
    if render_to:
        log(f"render engine={engine} chars={len(text)} text={text!r}")
        print(f"rendered:{engine}")
        return 0
    _write_speaking(text, engine)
    try:
        r = play_wav(out)
    finally:
        _clear_speaking()
    log(f"speak engine={engine} result={r} chars={len(text)} text={text!r}")
    print(f"{r}:{engine}")
    return 0 if r != "failed" else 1


if __name__ == "__main__":
    sys.exit(main())
