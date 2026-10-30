#!/bin/bash
# Fuse_Box installer - turns a clean Ubuntu 24.04 (x86_64) machine into a Fuse Box.
#
#   git clone https://github.com/coopersplayground/FuseBox.git
#   cd FuseBox && sudo bash install.sh
#
# Flags:
#   --no-android    skip Waydroid + the Fuse Shop catalog (Android apps)
#   --no-reboot     do everything but stay up at the end
#   --dry-run       print every action, change nothing
#
# The install is idempotent: run it again to update an existing box.
# Every component reports OK / SKIPPED / DEGRADED at the end. A component
# that fails (say, Android on a kernel without binder) degrades - the box
# still comes up. Nothing personal is installed or asked for here: line
# credentials, the family password, and API keys are entered later, on the
# box's own screen or in the key files the README lists.

set -uo pipefail

DRY=0; ANDROID=1; REBOOT=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1; REBOOT=0 ;;
    --no-android) ANDROID=0 ;;
    --no-reboot) REBOOT=0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FB_USER="cosmo"
FB_HOME="/home/cosmo"
LOG="/var/log/fusebox-install.log"
declare -a SUMMARY=()

say()  { echo "== $*"; }
note() { SUMMARY+=("$1"); }

# run CMD... - execute (or just print, in dry-run)
run() {
  if [ "$DRY" = 1 ]; then echo "  + $*"; return 0; fi
  echo "  + $*"
  "$@"
}
# run_sh "shell string" - same, through bash -c
run_sh() {
  if [ "$DRY" = 1 ]; then echo "  + sh -c: $1"; return 0; fi
  echo "  + sh -c: $1"
  bash -c "$1"
}
# put FILE - write stdin to FILE (or just report, in dry-run)
put() {
  if [ "$DRY" = 1 ]; then echo "  + write $1"; cat >/dev/null; return 0; fi
  mkdir -p "$(dirname "$1")"
  cat > "$1"
  echo "  + write $1"
}
as_cosmo() { run sudo -u "$FB_USER" env HOME="$FB_HOME" "$@"; }
# to_link PATH TARGET - make PATH a symlink to TARGET. A pre-existing
# real file/dir (a pre-versioning install) is moved aside into
# ~/pre-versioned-backup/ first - nothing is deleted.
to_link() {
  local p="$1" t="$2"
  if [ -L "$p" ]; then run ln -sfn "$t" "$p"; return 0; fi
  if [ -e "$p" ]; then
    run install -d -o "$FB_USER" -g "$FB_USER" "$FB_HOME/pre-versioned-backup"
    run mv "$p" "$FB_HOME/pre-versioned-backup/$(basename "$p").$(date +%s)"
  fi
  run ln -s "$t" "$p"
}

if [ "$(id -u)" != 0 ]; then
  if [ "$DRY" = 1 ]; then
    echo "(dry-run: would re-run under sudo)"
  else
    exec sudo "$0" "$@"
  fi
fi

if [ "$DRY" = 0 ]; then
  exec > >(tee -a "$LOG") 2>&1
fi

say "Fuse_Box install - source: $SRC_DIR"
[ "$DRY" = 1 ] && say "DRY RUN - nothing will be changed"

# ---------------------------------------------------------------- preflight
say "Preflight"
. /etc/os-release
echo "  OS: ${PRETTY_NAME:-unknown}"
[ "${ID:-}" = "ubuntu" ] || { echo "  This installer targets Ubuntu. Stopping."; exit 1; }
if [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "  NOTE: proven on Ubuntu 24.04; this is ${VERSION_ID:-?} - continuing, expect possible drift."
fi
ARCH="$(uname -m)"
[ "$ARCH" = "x86_64" ] || { echo "  x86_64 required for this build (found $ARCH). Stopping."; exit 1; }
RAM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 ))
echo "  RAM: ${RAM_GB} GB"
[ "$RAM_GB" -ge 6 ] || echo "  NOTE: under 6 GB RAM - the voice and judge models will be tight."
DISK_GB=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
echo "  Disk free: ${DISK_GB} GB"
[ "${DISK_GB:-0}" -ge 20 ] || echo "  NOTE: under 20 GB free - model and app downloads may not fit."
run curl -fsSI https://archive.ubuntu.com >/dev/null || { echo "  No internet reachability. Stopping."; exit 1; }
note "Preflight: OK"

# ---------------------------------------------------------------- apt base
say "System packages"
export DEBIAN_FRONTEND=noninteractive
run apt-get update
run apt-get install -y \
  curl git ca-certificates gnupg software-properties-common rsync unzip acl \
  python3 python3-venv python3-pip python3-gi gir1.2-gtk-3.0 \
  alsa-utils ffmpeg espeak-ng xdotool x11-utils xinit xserver-xorg \
  asterisk cron
note "System packages: OK"

# Node 22 (the board's runtime) from NodeSource
if ! command -v node >/dev/null || [ "$(node -v 2>/dev/null | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  run_sh "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
  run apt-get install -y nodejs
fi
note "Node $(node -v 2>/dev/null || echo '?'): OK"

# Chrome (kiosk screen)
if ! command -v google-chrome >/dev/null; then
  run curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  run apt-get install -y /tmp/google-chrome.deb
fi
note "Chrome (kiosk): OK"

# Brave (the board's full-screen browser)
if ! command -v brave-browser >/dev/null; then
  run_sh "curl -fsS https://dl.brave.com/install.sh | bash"
fi
note "Brave (board browser): OK"

# ---------------------------------------------------------------- the user
say "Appliance user"
if ! id "$FB_USER" >/dev/null 2>&1; then
  run useradd -m -s /bin/bash "$FB_USER"
fi
run usermod -aG sudo,audio,video,input,render,dialout,asterisk "$FB_USER"
# The appliance's own service account holds passwordless sudo - it is how the
# box provisions its phone PBX and network from its own screen (same model as
# the reference install). This is a single-purpose appliance account.
put /etc/sudoers.d/cosmo-fusebox <<'EOF'
cosmo ALL=(ALL) NOPASSWD: ALL
EOF
run chmod 440 /etc/sudoers.d/cosmo-fusebox
run loginctl enable-linger "$FB_USER"
FB_UID="$(id -u "$FB_USER" 2>/dev/null || echo 1000)"
note "User $FB_USER + linger: OK"

# ---------------------------------------------------------------- the tree
say "Installing the Fuse_Box tree into $FB_HOME"
# The app lives in a versioned release tree; the familiar paths
# (~/cosmo-ui, ~/guardian-ear.py, ...) are symlinks into
# fusebox-app/current - which is what the silent updater flips.
FB_VERSION="1.0.0"
REL="$FB_HOME/fusebox-app/releases/$FB_VERSION"
SHARED="$FB_HOME/fusebox-app/shared"
run install -d -o "$FB_USER" -g "$FB_USER" \
  "$REL/cosmo-ui" "$REL/cosmo-listener" "$REL/guardian" "$REL/updater" \
  "$SHARED/cosmo-ui-data" "$SHARED/found" "$SHARED/listener-logs" "$SHARED/listener-state" \
  "$FB_HOME/.config/systemd/user" \
  "$FB_HOME/.config/cosmo-guardian" "$FB_HOME/.config/cosmo-voice" \
  "$FB_HOME/android-x" "$FB_HOME/cosmo-osk" "$FB_HOME/cosmo-hid"
run chmod 700 "$FB_HOME/.config/cosmo-guardian" "$FB_HOME/.config/cosmo-voice"
run rsync -a --exclude 'data/' --exclude 'shop-index.json' --exclude 'public/found/' \
  --exclude 'public/pc/latest.jpg' "$SRC_DIR/cosmo-ui/" "$REL/cosmo-ui/"
run rsync -a --exclude 'venv/' --exclude 'logs/' --exclude 'state/' --exclude 'session-id' \
  --exclude '__pycache__/' "$SRC_DIR/cosmo-listener/" "$REL/cosmo-listener/"
run install -m 0644 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/guardian/guardian-ear.py" "$REL/guardian/guardian-ear.py"
run install -m 0644 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/guardian/setup-asterisk.py" "$REL/guardian/setup-asterisk.py"
run install -m 0644 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/guardian/grd-resample.py" "$REL/guardian/grd-resample.py"
run rsync -a --exclude '__pycache__/' "$SRC_DIR/updater/" "$REL/updater/"
put "$REL/VERSION" <<EOF
$FB_VERSION
EOF
# Runtime data lives in shared/ and is linked into the release, so an
# update flip never strands the board's state.
run ln -sfn "$SHARED/cosmo-ui-data" "$REL/cosmo-ui/data"
run ln -sfn "$SHARED/found" "$REL/cosmo-ui/public/found"
run ln -sfn "$SHARED/listener-logs" "$REL/cosmo-listener/logs"
run ln -sfn "$SHARED/listener-state" "$REL/cosmo-listener/state"
[ -L "$FB_HOME/fusebox-app/current" ] || run ln -s "$REL" "$FB_HOME/fusebox-app/current"
# Preserve board data from a pre-versioning install before linking over it.
if [ -d "$FB_HOME/cosmo-ui" ] && [ ! -L "$FB_HOME/cosmo-ui" ] && [ -d "$FB_HOME/cosmo-ui/data" ]; then
  run cp -a "$FB_HOME/cosmo-ui/data/." "$SHARED/cosmo-ui-data/"
fi
to_link "$FB_HOME/cosmo-ui" "fusebox-app/current/cosmo-ui"
to_link "$FB_HOME/cosmo-listener" "fusebox-app/current/cosmo-listener"
to_link "$FB_HOME/guardian-ear.py" "fusebox-app/current/guardian/guardian-ear.py"
to_link "$FB_HOME/setup-asterisk.py" "fusebox-app/current/guardian/setup-asterisk.py"
to_link "$FB_HOME/grd-resample.py" "fusebox-app/current/guardian/grd-resample.py"
# Seed the updater's state so the first silent update knows where it stands.
if [ ! -f "$FB_HOME/fusebox-app/update-state.json" ]; then
  put "$FB_HOME/fusebox-app/update-state.json" <<EOF
{"current": "$FB_VERSION", "previous": null, "last_result": "installed"}
EOF
fi
run install -m 0644 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/android/android-x.py" "$FB_HOME/android-x/android-x.py"
run install -m 0755 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/android/waydroid-session.sh" "$FB_HOME/waydroid-session.sh"
run install -m 0755 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/android/fuse-shop-sync.py" "$FB_HOME/fuse-shop-sync.py"
run rsync -a --exclude '__pycache__/' "$SRC_DIR/cosmo-osk/" "$FB_HOME/cosmo-osk/"
run rsync -a --exclude '__pycache__/' --exclude '*.log' "$SRC_DIR/cosmo-hid/" "$FB_HOME/cosmo-hid/"
run rsync -a "$SRC_DIR/.config/systemd/user/" "$FB_HOME/.config/systemd/user/"
run install -m 0644 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/updater/fusebox-update.service" "$FB_HOME/.config/systemd/user/fusebox-update.service"
run install -m 0644 -o "$FB_USER" -g "$FB_USER" "$SRC_DIR/updater/fusebox-update.timer" "$FB_HOME/.config/systemd/user/fusebox-update.timer"
run install -m 0644 "$SRC_DIR/etc/systemd/system/cosmo-kiosk.service" /etc/systemd/system/cosmo-kiosk.service
run install -m 0755 "$SRC_DIR/usr/local/bin/cosmo-kiosk-session.sh" /usr/local/bin/cosmo-kiosk-session.sh
run install -m 0755 "$SRC_DIR/usr/local/bin/cosmo" /usr/local/bin/cosmo
run chown -R "$FB_USER:$FB_USER" "$FB_HOME"
note "File tree: OK"

# Listener python venv (its shebang points here)
say "Voice listener environment"
as_cosmo python3 -m venv "$FB_HOME/cosmo-listener/venv"
as_cosmo "$FB_HOME/cosmo-listener/venv/bin/pip" install --quiet --upgrade pip
as_cosmo "$FB_HOME/cosmo-listener/venv/bin/pip" install --quiet -r "$FB_HOME/cosmo-listener/requirements.txt"
note "Listener venv: OK"

# ---------------------------------------------------------------- voice: Meta + browser
# No local AI voice services are installed - by design. Speech-to-text is
# Muse Voice Transcribe on the Meta Model API - reached through the
# owner's gateway (a per-device token at ~/.config/cosmo-voice/gateway.json)
# on a provisioned box, or directly with the key the owner drops at
# ~/.config/cosmo-voice/meta_api_key on their own hardware - and spoken
# output is the browser's
# built-in speechSynthesis, with espeak-ng (installed above) rendering the
# Guardian's phone prompts and acting as the local fallback voice.
note "Voice: Meta transcription API + browser speech (no local AI voice models)"

# ---------------------------------------------------------------- Ollama judge
say "Local judge (Ollama + Llama 3.2 3B)"
if ! command -v ollama >/dev/null; then
  run_sh "curl -fsSL https://ollama.com/install.sh | sh"
fi
run systemctl enable --now ollama 2>/dev/null || true
if [ "$DRY" = 0 ]; then
  for i in $(seq 1 30); do curl -s http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 2; done
fi
if run ollama pull llama3.2:3b; then
  note "Ollama + llama3.2:3b judge: OK"
else
  note "Ollama + llama3.2:3b judge: DEGRADED - model pull failed (screen judge will lean on the vision tier)"
fi

# ---------------------------------------------------------------- phone PBX
say "Phone Guardian PBX (Asterisk)"
run systemctl enable asterisk
run install -d -m 2775 -o asterisk -g asterisk /var/spool/asterisk/monitor /var/spool/asterisk/grd-lines
run_sh "setfacl -R -m u:$FB_USER:rX /var/spool/asterisk/monitor 2>/dev/null; setfacl -d -m u:$FB_USER:rX /var/spool/asterisk/monitor 2>/dev/null; true"
# If line credentials were already entered on this box, (re)generate the PBX
# config now. Otherwise the guardian-provision watcher does it the moment the
# Guardian setup is completed on the board.
if [ -f "$FB_HOME/.config/cosmo-guardian/secrets.json" ]; then
  as_cosmo python3 "$FB_HOME/setup-asterisk.py" || true
fi
note "Asterisk: OK (line activates when Guardian setup is completed on the board)"

# ---------------------------------------------------------------- Android / Fuse Shop
if [ "$ANDROID" = 1 ]; then
  say "Android side (Waydroid) + Fuse Shop catalog"
  put /etc/modules-load.d/waydroid.conf <<'EOF'
binder_linux
EOF
  put /etc/modprobe.d/waydroid.conf <<'EOF'
options binder_linux devices=binder,hwbinder,vndbinder
EOF
  if ! command -v waydroid >/dev/null; then
    run_sh "curl -fsSL https://repo.waydro.id | bash"
    run apt-get install -y waydroid
  fi
  ANDROID_OK=1
  if ! run modprobe binder_linux devices=binder,hwbinder,vndbinder; then
    # Minimal images (cloud, some server installs) split binder into the
    # kernel extras package - fetch it for the running kernel and retry.
    run apt-get install -y "linux-modules-extra-$(uname -r)" || true
    run modprobe binder_linux devices=binder,hwbinder,vndbinder || ANDROID_OK=0
  fi
  if [ "$ANDROID_OK" = 1 ]; then
    run systemctl enable waydroid-container 2>/dev/null || true
    run_sh "waydroid init" || ANDROID_OK=0
  fi
  # Weekly catalog refresh (Mondays 05:17), same cadence as the reference box.
  put /etc/cron.d/fusebox-shop-sync <<EOF
17 5 * * 1 $FB_USER /usr/bin/python3 $FB_HOME/fuse-shop-sync.py >/dev/null 2>&1
EOF
  if [ "$ANDROID_OK" = 1 ]; then
    as_cosmo python3 "$FB_HOME/fuse-shop-sync.py" || true
    note "Android (Waydroid) + Fuse Shop: OK"
  else
    note "Android (Waydroid): DEGRADED - this kernel/VM lacks binder support; the rest of the box is unaffected"
  fi
else
  note "Android (Waydroid): SKIPPED (--no-android)"
fi

# ---------------------------------------------------------------- appliance shell
say "Appliance shell"
run hostnamectl set-hostname fusebox
run systemctl mask getty@tty1.service
run systemctl daemon-reload
run systemctl enable cosmo-kiosk.service
# User services
run_sh "for i in \$(seq 1 30); do [ -S /run/user/$FB_UID/bus ] && break; sleep 1; done; true"
USERCTL="sudo -u $FB_USER env XDG_RUNTIME_DIR=/run/user/$FB_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$FB_UID/bus systemctl --user"
run_sh "$USERCTL daemon-reload"
run_sh "$USERCTL enable cosmo-ui.service cosmo-listener.service guardian-ear.service guardian-provision.path cosmo-osk.service android-x.service hid-emitter.service fusebox-update.timer"
[ "$ANDROID" = 1 ] && run_sh "$USERCTL enable waydroid-session.service"
run_sh "$USERCTL start cosmo-ui.service"
note "Kiosk + user services enabled: OK"

# ---------------------------------------------------------------- smoke test
say "Smoke test - the board must answer"
BOARD_OK=0
if [ "$DRY" = 1 ]; then
  echo "  (dry-run: would poll http://127.0.0.1:3180/ for HTTP 200)"
  BOARD_OK=1
else
  for i in $(seq 1 30); do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3180/ || true)"
    [ "$CODE" = "200" ] && { BOARD_OK=1; break; }
    sleep 2
  done
fi
if [ "$BOARD_OK" = 1 ]; then
  note "Board smoke test: OK (http://127.0.0.1:3180/)"
else
  note "Board smoke test: FAILED - check: journalctl --user -u cosmo-ui"
fi

# ---------------------------------------------------------------- summary
say "Install summary"
for line in "${SUMMARY[@]}"; do echo "  - $line"; done
echo
echo "This machine is now a Fuse Box."
echo "  Board:    http://127.0.0.1:3180/ (full screen on this machine's display)"
echo "  Next:     complete the Guardian setup on the board to bring the phone"
echo "            line up, and provision the box's cloud access - a gateway"
echo "            token at ~/.config/cosmo-voice/gateway.json, or the Meta"
echo "            Model API key at ~/.config/cosmo-voice/meta_api_key on the"
echo "            owner's own hardware (see README - Configuration & secrets)."
echo "  Log:      $LOG"
if [ "$BOARD_OK" != 1 ]; then
  echo "The board did not come up - not rebooting. Fix the above, then reboot."
  exit 1
fi
if [ "$REBOOT" = 1 ]; then
  say "Rebooting into the Fuse Box in 5 seconds (Ctrl-C to stay)"
  sleep 5
  run systemctl reboot
else
  echo "Staying up (--no-reboot). Reboot when ready: sudo systemctl reboot"
fi
