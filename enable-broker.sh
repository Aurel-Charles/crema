#!/bin/bash
# Switch this Pi's Crema server to BROKER transport via a systemd drop-in.
# The base crema.service is left untouched; this only layers env on top, so
# reverting is just ./disable-broker.sh.
#
# Usage: ./enable-broker.sh ws://<broker-host>:4000 [token]
set -euo pipefail

URL="${1:-}"
TOKEN="${2:-}"
if [ -z "$URL" ]; then
  echo "Usage: $0 ws://<broker-host>:4000 [token]" >&2
  exit 1
fi

DROPIN_DIR=/etc/systemd/system/crema.service.d
echo "▸ Writing $DROPIN_DIR/transport.conf (broker → $URL)"
sudo mkdir -p "$DROPIN_DIR"
{
  echo "[Service]"
  echo "Environment=CREMA_TRANSPORT=broker"
  echo "Environment=CREMA_BROKER_URL=$URL"
  [ -n "$TOKEN" ] && echo "Environment=CREMA_BROKER_TOKEN=$TOKEN"
} | sudo tee "$DROPIN_DIR/transport.conf" > /dev/null

sudo systemctl daemon-reload
sudo systemctl restart crema.service

echo "✓ Crema is now in BROKER mode → $URL"
echo "  Revert to P2P: ./disable-broker.sh"
echo "  Logs:          sudo journalctl -u crema -f"
