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
    http://localhost:3000/display
  sleep 3
done
