# Day 5 (Oct 30) — the one-command installer, then the compliance swap

Two big moves today.

**The installer.** The repo now turns a clean Ubuntu 24.04 machine
into a Fuse Box with one line: clone, `sudo bash install.sh`, reboot
into the board. It installs every dependency, creates the appliance
user, lays down the services, smoke-tests the board, and reports each
component OK / SKIPPED / DEGRADED. It was built and exercised in a
clean virtual machine on the bench workstation (the host untouched):
the first run caught real bugs — voice-service data folders owned by
the wrong user, a model check that declared victory too early, a
kernel package minimal installs need for Android — all fixed, and the
second run came up green across the board, voice, judge, and PBX.

**The compliance swap.** The organizers clarified the model rule:
every model called at runtime must be a Meta model — Whisper,
openWakeWord, YOLO and friends are out even on-device, and spoken
output through the browser's built-in speech synthesis is fine
because it is not a model call. An honest audit found one hard
violation (Whisper did all transcription) and two softer ones (local
TTS models in the fallback chain, an OCR engine with a neural net in
the screen judge). The swap:

- All speech-to-text — the voice loop and the Guardian's live and
  final-pass call transcription — now goes to Muse Voice Transcribe
  on the Meta Model API. The endpoint was verified against a real
  Guardian prompt recording before anything was rewired.
- Spoken output is the browser's built-in speechSynthesis. The
  Guardian's phone prompts are rendered by espeak-ng, a rule-based
  formant synthesizer, and cached as plain WAV files.
- The screen judge no longer OCRs first; Muse Glimmer reads the
  screen directly, text included.
- The installer no longer installs any local voice models.

The README gained the section the organizers asked for: which parts
are Meta model calls (and where the open-weight ones run), and which
parts are browser features.
