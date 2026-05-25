#!/bin/bash
# Crema display launcher — waits for the local server then opens Chromium kiosk.
# Restarts Chromium if it dies, so the display recovers from crashes.
set -uo pipefail

# Find the chromium binary (chromium-browser on older RPi OS, chromium on newer)
if command -v chromium-browser > /dev/null 2>&1; then
  BROWSER=chromium-browser
elif command -v chromium > /dev/null 2>&1; then
  BROWSER=chromium
else
  echo "ERROR: chromium not found" >&2
  exit 1
fi

# Screen profile (per-Pi): selects the display layout for this panel.
# Source order: CREMA_SCREEN env, then data/screen-profile (gitignored,
# per-Pi). Empty = the default 7"/tablet/desktop layout. pi-desk's 3.5"
# panel uses "sm" — set it with: echo sm > data/screen-profile
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SCREEN="${CREMA_SCREEN:-}"
if [ -z "$SCREEN" ] && [ -f "$DIR/data/screen-profile" ]; then
  SCREEN="$(tr -d '[:space:]' < "$DIR/data/screen-profile")"
fi
URL="http://localhost:3000/display"
[ -n "$SCREEN" ] && URL="${URL}?screen=${SCREEN}"

# Wait up to 60s for the local server to respond
for _ in $(seq 1 60); do
  if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Loop forever — if Chromium dies, restart it after 3s
while true; do
  "$BROWSER" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --check-for-update-interval=31536000 \
    --no-first-run \
    --password-store=basic \
    "$URL"
  sleep 3
done
