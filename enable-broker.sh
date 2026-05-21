#!/bin/bash
# Force this Pi to PURE BROKER transport — mDNS/p2p disabled entirely. The Pi
# talks only through the relay. Mostly a debug/diagnostic switch now that the
# default (dual) already uses the broker as primary with p2p fallback; for
# normal use prefer ./pin-broker.sh (keeps the fallback) or auto-discovery.
#
# The base crema.service is untouched; revert with ./reset-transport.sh.
# Usage: ./enable-broker.sh ws://<broker-host>:4000 [token]
set -euo pipefail

URL="${1:-}"
TOKEN="${2:-}"
if [ -z "$URL" ]; then
  echo "Usage: $0 ws://<broker-host>:4000 [token]" >&2
  exit 1
fi

DROPIN_DIR=/etc/systemd/system/crema.service.d
echo "▸ Writing $DROPIN_DIR/transport.conf (PURE broker → $URL)"
sudo mkdir -p "$DROPIN_DIR"
{
  echo "[Service]"
  echo "Environment=CREMA_TRANSPORT=broker"
  echo "Environment=CREMA_BROKER_URL=$URL"
  [ -n "$TOKEN" ] && echo "Environment=CREMA_BROKER_TOKEN=$TOKEN"
} | sudo tee "$DROPIN_DIR/transport.conf" > /dev/null

sudo systemctl daemon-reload
sudo systemctl restart crema.service

echo "✓ Crema in PURE BROKER mode → $URL (no p2p fallback)"
echo "  For broker + p2p fallback instead: ./pin-broker.sh $URL"
echo "  Back to default dual:              ./reset-transport.sh"
echo "  Logs:                              sudo journalctl -u crema -f"
