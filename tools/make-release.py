#!/usr/bin/env python3
"""Build a signed Fuse Box release bundle + manifest.

Runs on the owner's release machine. The bundle carries the app tree;
the manifest (canonical JSON: sorted keys, compact separators) is
signed with the release Ed25519 key via openssl. The private key never
leaves this machine and is never in the repo.

  python3 tools/make-release.py --version 1.1.0 --channel stable \
      --key ~/.fusebox-release/signing-key.pem --out ~/releases/1.1.0

Outputs bundle.tar.gz, manifest.json, manifest.sig in --out. Publish by
copying the three files to the gateway host's releases/<channel>/.
"""
import argparse
import base64
import hashlib
import io
import json
import subprocess
import tarfile
import time
from pathlib import Path

APP_DIRS = ["cosmo-ui", "cosmo-listener", "guardian", "updater"]
SKIP_SUFFIXES = (".pyc", ".bak", ".bak-gateway", ".bak-compliance")
SKIP_PARTS = {"__pycache__", "node_modules", ".git"}
# Runtime data — never shipped in a bundle (mirrors install.sh's rsync
# excludes; on the box these are symlinks into fusebox-app/shared/).
SKIP_PATHS = {
    "cosmo-ui/data", "cosmo-ui/shop-index.json", "cosmo-ui/public/found",
    "cosmo-ui/public/pc/latest.jpg",
    "cosmo-listener/venv", "cosmo-listener/logs", "cosmo-listener/state",
    "cosmo-listener/session-id",
}


def build_bundle(src: Path, version: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for d in APP_DIRS:
            base = src / d
            if not base.exists():
                continue
            for f in sorted(base.rglob("*")):
                if f.is_dir():
                    continue
                rel = f.relative_to(src)
                if any(p in SKIP_PARTS for p in rel.parts):
                    continue
                rel_s = str(rel)
                if any(rel_s == p or rel_s.startswith(p + "/")
                       for p in SKIP_PATHS):
                    continue
                if f.name.endswith(SKIP_SUFFIXES) or ".bak-" in f.name:
                    continue
                tf.add(f, arcname=str(rel))
        info = tarfile.TarInfo("VERSION")
        data = (version + "\n").encode()
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--channel", default="stable")
    ap.add_argument("--key", required=True)
    ap.add_argument("--src", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--out", required=True)
    ap.add_argument("--notes", default="")
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    bundle = build_bundle(src, args.version)
    (out / "bundle.tar.gz").write_bytes(bundle)
    manifest = {
        "product": "fusebox",
        "version": args.version,
        "channel": args.channel,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bundle_sha256": hashlib.sha256(bundle).hexdigest(),
        "bundle_size": len(bundle),
        "notes": args.notes,
    }
    canonical = json.dumps(manifest, sort_keys=True,
                           separators=(",", ":")).encode()
    (out / "manifest.json").write_bytes(canonical)
    # openssl's Ed25519 one-shot signing wants a real file, not stdin.
    import tempfile
    with tempfile.NamedTemporaryFile(delete=False) as tf:
        tf.write(canonical)
        tf_path = tf.name
    try:
        sig = subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-inkey", args.key, "-rawin",
             "-in", tf_path], capture_output=True, check=True).stdout
    finally:
        Path(tf_path).unlink(missing_ok=True)
    assert len(sig) == 64, len(sig)
    (out / "manifest.sig").write_text(base64.b64encode(sig).decode() + "\n")
    print(f"release {args.version} ({args.channel}): bundle "
          f"{len(bundle)} bytes sha256 {manifest['bundle_sha256'][:16]}…")
    print(f"files in {out}: bundle.tar.gz manifest.json manifest.sig")


if __name__ == "__main__":
    main()
