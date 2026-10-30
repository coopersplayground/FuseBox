#!/bin/bash
# Fuse_Box: Waydroid session. Weston runs NESTED on the kiosk X display (:0)
# with the X11 backend, so Android apps appear as real windows on the board
# screen when launched. The Weston window starts LOWERED (board on top);
# cosmo-ui raises it when an app is launched from the shop or the drawer.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export WAYLAND_DISPLAY=wayland-0
export DISPLAY=:0
weston --backend=x11-backend.so --socket=wayland-0 --width=1920 --height=1080 --idle-time=0 &
WPID=$!
for i in $(seq 1 30); do
  [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break
  sleep 1
done
# No socket = weston never came up (e.g. a mode the WM-less X server cannot
# grant). Fail loudly so systemd retries instead of starting a dead session.
[ -S "$XDG_RUNTIME_DIR/wayland-0" ] || { kill $WPID 2>/dev/null; exit 1; }
# Park the Weston window off-screen until an app is opened. Move, NOT
# unmap: unmapping the Weston X window stalls its repaint loop and the
# picture freezes on the last frame.
for i in $(seq 1 20); do
  WID=$(xdotool search --class Weston 2>/dev/null | head -1)
  [ -n "$WID" ] && { xdotool windowmove "$WID" 1920 0 2>/dev/null; break; }
  sleep 1
done
export DISPLAY=:0
sudo -n systemctl start waydroid-container 2>/dev/null || true
sleep 2
waydroid session start &
SPID=$!
wait $SPID
kill $WPID 2>/dev/null || true
