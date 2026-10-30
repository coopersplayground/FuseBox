#!/usr/bin/env python3
"""Resample a WAV to 8000 Hz mono 16-bit (Asterisk phone-line format).
Usage: grd-resample.py <in.wav> <out.wav>"""
import audioop, sys, wave

src = wave.open(sys.argv[1], "rb")
rate, width, chans = src.getframerate(), src.getsampwidth(), src.getnchannels()
pcm = src.readframes(src.getnframes())
src.close()
if width != 2:
    pcm = audioop.lin2lin(pcm, width, 2)
    width = 2
if chans == 2:
    pcm = audioop.tomono(pcm, 2, 0.5, 0.5)
elif chans != 1:
    raise SystemExit("unsupported channels %d" % chans)
if rate != 8000:
    pcm, _ = audioop.ratecv(pcm, 2, 1, rate, 8000, None)
out = wave.open(sys.argv[2], "wb")
out.setnchannels(1)
out.setsampwidth(2)
out.setframerate(8000)
out.writeframes(pcm)
out.close()
print("ok", len(pcm) // 16000, "ms ->", sys.argv[2])
