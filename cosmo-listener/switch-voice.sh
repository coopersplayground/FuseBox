#!/bin/bash
# Switch Cosmo's active speaking voice: flip config active_voice + re-render
# the wake-ack pool in the new voice. Usage: switch-voice.sh <N>
set -euo pipefail
cd "$(dirname "$0")"
N="${1:-}"
if [ -z "$N" ]; then echo "usage: switch-voice.sh <voice-number>" >&2; exit 2; fi
LABEL=$(python3 - "$N" <<'PY'
import json, os, sys, tempfile
n = sys.argv[1]
p = "config.json"
c = json.load(open(p))
voices = c.get("voices", {})
if n not in voices:
    print(f"ERROR: no voice profile {n} (have: {', '.join(sorted(voices))})",
          file=sys.stderr)
    sys.exit(1)
c["active_voice"] = n
fd, tmp = tempfile.mkstemp(dir=".", prefix=".config-", suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(c, f, indent=1, sort_keys=True)
os.replace(tmp, p)
print(voices[n].get("label", f"voice {n}"))
PY
)
echo "active voice -> $N ($LABEL); re-rendering acks..."
python3 - <<'PY'
import json, subprocess, sys
manifest = json.load(open("acks/manifest.json"))
for fname in sorted(manifest):
    r = subprocess.run(["./speak.py", "--render", f"acks/{fname}", manifest[fname]],
                       capture_output=True, text=True)
    if r.returncode != 0 or "elevenlabs" not in r.stdout:
        print(f"WARN: {fname}: {r.stdout.strip()} {r.stderr.strip()}",
              file=sys.stderr)
print("acks re-rendered")
PY
echo "switched to voice $N ($LABEL)"
