#!/bin/bash
# Pin the broker URL for this Pi (DUAL mode). Skips mDNS discovery and points
# the broker client straight at a known address — the robust choice when the
# broker has a DHCP-reserved static IP. P2P stays live as the fallback.
#
# Leaves CREMA_TRANSPORT unset, so the default dual topology is preserved.
# Usage: ./pin-broker.sh ws://<broker-host>:4000 [token]
set -euo pipefail

URL="${1:-}"
TOKEN="${2:-}"
if [ -z "$URL" ]; then
  echo "Usage: $0 ws://<broker-host>:4000 [token]" >&2
  exit 1
fi

DROPIN_DIR=/etc/systemd/system/crema.service.d
echo "▸ Writing $DROPIN_DIR/transport.conf (dual, broker pinned → $URL)"
sudo mkdir -p "$DROPIN_DIR"
{
  echo "[Service]"
  echo "Environment=CREMA_BROKER_URL=$URL"
  [ -n "$TOKEN" ] && echo "Environment=CREMA_BROKER_TOKEN=$TOKEN"
} | sudo tee "$DROPIN_DIR/transport.conf" > /dev/null

sudo systemctl daemon-reload
sudo systemctl restart crema.service

echo "✓ Dual mode, broker pinned → $URL (p2p fallback active)"
echo "  Back to auto-discovery: ./reset-transport.sh"
echo "  Logs:                   sudo journalctl -u crema -f"
