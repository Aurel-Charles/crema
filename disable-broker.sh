#!/bin/bash
# Force this Pi to PURE P2P transport — broker disabled entirely (mDNS only).
# Use when you want to take the broker out of the loop (debug, broker down for
# maintenance). Lays a systemd drop-in with CREMA_TRANSPORT=p2p.
#
# Back to the default dual (broker + p2p): ./reset-transport.sh
set -euo pipefail

DROPIN_DIR=/etc/systemd/system/crema.service.d
echo "▸ Writing $DROPIN_DIR/transport.conf (force p2p)"
sudo mkdir -p "$DROPIN_DIR"
{
  echo "[Service]"
  echo "Environment=CREMA_TRANSPORT=p2p"
} | sudo tee "$DROPIN_DIR/transport.conf" > /dev/null

sudo systemctl daemon-reload
sudo systemctl restart crema.service

echo "✓ Crema forced to PURE P2P (mDNS) — broker disabled."
echo "  Back to default dual: ./reset-transport.sh"
echo "  Logs:                 sudo journalctl -u crema -f"
