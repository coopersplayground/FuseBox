#!/bin/bash
# Cosmo kiosk X session: no blanking, no cursor management, Chrome fullscreen
# running as cosmo (X itself is owned by root via xinit).
xset -dpms 2>/dev/null
xset s off 2>/dev/null
xset s noblank 2>/dev/null
xhost +si:localuser:cosmo 2>/dev/null
# No window manager in this session, so size the kiosk window explicitly
# to whatever the connected display is actually running.
SCREEN_SIZE="$(xdpyinfo 2>/dev/null | awk '/dimensions:/ {print $2; exit}')"
[ -z "$SCREEN_SIZE" ] && SCREEN_SIZE="1920x1080"
WIN_W="${SCREEN_SIZE%x*}"
WIN_H="${SCREEN_SIZE#*x}"
exec runuser -u cosmo -- env DISPLAY=:0 HOME=/home/cosmo google-chrome \
  --kiosk --start-fullscreen \
  --window-position=0,0 --window-size="${WIN_W},${WIN_H}" \
  --force-device-scale-factor=1 \
  --no-first-run --noerrdialogs --disable-infobars \
  --disable-session-crashed-bubble --check-for-update-interval=31536000 \
  --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/home/cosmo/.cosmo-kiosk-chrome \
  http://127.0.0.1:3180/
