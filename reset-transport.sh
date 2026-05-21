#!/bin/bash
# Reset this Pi to the DEFAULT transport: dual (broker primary + p2p fallback)
# with mDNS auto-discovery of the broker. Removes any transport drop-in left by
# pin-broker.sh / enable-broker.sh / disable-broker.sh.
set -euo pipefail

DROPIN=/etc/systemd/system/crema.service.d/transport.conf
if [ -f "$DROPIN" ]; then
  echo "▸ Removing $DROPIN"
  sudo rm -f "$DROPIN"
  sudo rmdir /etc/systemd/system/crema.service.d 2>/dev/null || true
  sudo systemctl daemon-reload
  sudo systemctl restart crema.service
  echo "✓ Back to default: dual transport + broker auto-discovery."
else
  echo "Already on the default dual transport (no drop-in found)."
fi
