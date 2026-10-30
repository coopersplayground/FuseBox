#!/usr/bin/env python3
"""Fuse Box silent updater.

Runs on a timer on the box. Checks the owner's gateway for a signed
release on the box's channel; if a newer version exists, downloads it,
verifies the release signature (Ed25519, public key baked in below) and
the bundle hash, stages it beside the running version, flips to it,
restarts the app services, and health-checks. Any failure flips back
to the previous version automatically.

It never touches Asterisk or the phones, never touches secrets or
state outside the app tree, and defers while a phone call is live
(fresh recordings in Asterisk's monitor spool).

Stdlib only. Config (all optional except the gateway credentials):
  ~/.config/cosmo-voice/gateway.json   {"url": ..., "token": ...}
  ~/.config/cosmo-voice/updater.json   {"app_root", "channel",
                                        "services", "health_url"}
State: <app_root>/update-state.json
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ed25519 import verify as ed_verify

# Release-signing public key (raw Ed25519). The private half never
# leaves the owner's release machine; it is not in this repo either.
RELEASE_PUBKEY = bytes.fromhex(
    "4b48c7b536277ffd79afa943f036de355bf32263d105181182070e78bcb15924")

CFG_DIR = Path("~/.config/cosmo-voice").expanduser()
MONITOR_DIR = "/var/spool/asterisk/monitor"

# Runtime data that must survive a flip: inside each release these paths
# are symlinks into <app_root>/shared/, recreated at staging time.
SHARED_LINKS = {
    "cosmo-ui/data": "shared/cosmo-ui-data",
    "cosmo-ui/public/found": "shared/found",
    "cosmo-listener/logs": "shared/listener-logs",
    "cosmo-listener/state": "shared/listener-state",
}


def ensure_shared_links(root: Path, release_dir: Path):
    for link_rel, target_rel in SHARED_LINKS.items():
        target = root / target_rel
        target.mkdir(parents=True, exist_ok=True)
        link = release_dir / link_rel
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.is_symlink() or link.exists():
            if link.is_dir() and not link.is_symlink():
                subprocess.run(["rm", "-rf", str(link)], check=True)
            else:
                link.unlink()
        link.symlink_to(target)


def prepare_release(dest: Path) -> bool:
    """Run the release's PREPARE.sh when the listener venv is missing
    (a fresh bundle never carries one)."""
    prep = dest / "cosmo-listener" / "PREPARE.sh"
    venv = dest / "cosmo-listener" / "venv"
    if prep.exists() and not venv.exists():
        log("preparing release (building listener venv)…")
        r = subprocess.run(["bash", str(prep)], capture_output=True,
                           timeout=1200)
        if r.returncode != 0:
            log("PREPARE.sh failed")
            return False
    return True


def log(msg):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), msg, flush=True)


def load_config():
    cfg = {"app_root": str(Path("~/fusebox-app").expanduser()),
           "channel": "stable",
           "services": ["cosmo-ui", "guardian-ear", "cosmo-listener"],
           "health_url": "http://127.0.0.1:3180/"}
    try:
        cfg.update(json.loads((CFG_DIR / "updater.json").read_text()))
    except Exception:
        pass
    gw = json.loads((CFG_DIR / "gateway.json").read_text())
    cfg["gateway_url"] = str(gw["url"]).rstrip("/")
    cfg["token"] = gw["token"]
    return cfg


def gw_get(cfg, path):
    req = urllib.request.Request(
        cfg["gateway_url"] + path,
        headers={"Authorization": "Bearer " + cfg["token"]})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def canonical(manifest) -> bytes:
    return json.dumps(manifest, sort_keys=True,
                      separators=(",", ":")).encode()


def call_in_progress() -> bool:
    """A live call keeps Asterisk's monitor files growing."""
    try:
        now = time.time()
        for f in os.scandir(MONITOR_DIR):
            if f.name.endswith(".raw") and now - f.stat().st_mtime < 20:
                return True
    except Exception:
        pass  # cannot confirm — app services don't carry the call anyway
    return False


def restart_services(cfg):
    for svc in cfg["services"]:
        subprocess.run(["systemctl", "--user", "restart", svc],
                       capture_output=True, timeout=60)


def health_ok(cfg) -> bool:
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(cfg["health_url"], timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(3)
    return False


def read_state(root: Path):
    try:
        return json.loads((root / "update-state.json").read_text())
    except Exception:
        return {}


def write_state(root: Path, state):
    tmp = root / "update-state.json.tmp"
    tmp.write_text(json.dumps(state, indent=1))
    os.replace(tmp, root / "update-state.json")


def main() -> int:
    try:
        cfg = load_config()
    except Exception as e:
        log(f"config error: {e}")
        return 1
    root = Path(cfg["app_root"])
    (root / "releases").mkdir(parents=True, exist_ok=True)
    state = read_state(root)
    current = state.get("current")

    # 1. Signed manifest from the gateway
    try:
        payload = json.loads(gw_get(
            cfg, f"/v1/update/manifest?channel={cfg['channel']}"))
        manifest, sig_b64 = payload["manifest"], payload["signature"]
    except Exception as e:
        log(f"manifest fetch failed: {e}")
        return 0  # transient — the timer will retry
    import base64
    try:
        sig = base64.b64decode(sig_b64)
    except Exception:
        log("release REJECTED: signature is not valid base64")
        return 1
    if not ed_verify(RELEASE_PUBKEY, canonical(manifest), sig):
        log("release REJECTED: signature verification failed")
        return 1
    version = str(manifest.get("version", ""))
    if manifest.get("product") != "fusebox" or not version:
        log("release REJECTED: bad manifest")
        return 1
    if version == current:
        log(f"up to date ({version})")
        state["last_check"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        write_state(root, state)
        return 0
    log(f"release {version} available (current: {current})")

    # 2. Never disturb a live call
    if call_in_progress():
        log("deferred: a phone call is live")
        return 0

    # 3. Download + hash-check the bundle
    try:
        bundle = gw_get(cfg, f"/v1/update/bundle?channel={cfg['channel']}")
    except Exception as e:
        log(f"bundle fetch failed: {e}")
        return 0
    if len(bundle) != int(manifest.get("bundle_size", -1)) or \
            hashlib.sha256(bundle).hexdigest() != manifest.get("bundle_sha256"):
        log("release REJECTED: bundle hash/size mismatch")
        return 1
    log(f"bundle verified ({len(bundle)} bytes)")

    # 4. Stage beside the running version, then flip
    dest = root / "releases" / version
    staging = root / "releases" / (version + ".staging")
    try:
        if staging.exists():
            subprocess.run(["rm", "-rf", str(staging)], check=True)
        staging.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as tf:
            tf.extractall(staging, filter="data")
        if dest.exists():
            subprocess.run(["rm", "-rf", str(dest)], check=True)
        os.replace(staging, dest)
        ensure_shared_links(root, dest)
    except Exception as e:
        log(f"staging failed: {e}")
        return 1
    link = root / "current"
    tmp_link = root / "current.tmp"
    try:
        tmp_link.unlink()
    except FileNotFoundError:
        pass
    tmp_link.symlink_to(dest)
    os.replace(tmp_link, link)

    # 5. Prepare (fresh venv), restart, health-check; roll back on doubt
    prepared = prepare_release(dest)
    if prepared:
        restart_services(cfg)
    if prepared and health_ok(cfg):
        state.update({"current": version, "previous": current,
                      "last_result": "updated",
                      "last_check": time.strftime("%Y-%m-%dT%H:%M:%S")})
        write_state(root, state)
        log(f"updated to {version}; health OK")
        # prune: keep current + previous only
        keep = {version, current}
        for d in (root / "releases").iterdir():
            if d.is_dir() and d.name not in keep and not d.name.endswith(".staging"):
                subprocess.run(["rm", "-rf", str(d)], capture_output=True)
        return 0
    log(f"health check FAILED after update to {version} — rolling back")
    if current:
        prev = root / "releases" / current
        try:
            tmp_link.unlink()
        except FileNotFoundError:
            pass
        tmp_link.symlink_to(prev)
        os.replace(tmp_link, link)
        restart_services(cfg)
    state.update({"last_result": f"rolled-back from {version}",
                  "last_check": time.strftime("%Y-%m-%dT%H:%M:%S")})
    write_state(root, state)
    return 1


if __name__ == "__main__":
    sys.exit(main())
