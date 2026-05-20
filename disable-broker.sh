#!/bin/bash
# Revert this Pi's Crema server to P2P (mDNS) transport by removing the
# broker drop-in installed by ./enable-broker.sh.
set -euo pipefail

DROPIN=/etc/systemd/system/crema.service.d/transport.conf
if [ -f "$DROPIN" ]; then
  echo "▸ Removing $DROPIN"
  sudo rm -f "$DROPIN"
  # Drop the dir too if now empty, to keep things tidy.
  sudo rmdir /etc/systemd/system/crema.service.d 2>/dev/null || true
  sudo systemctl daemon-reload
  sudo systemctl restart crema.service
  echo "✓ Crema reverted to P2P (mDNS) mode."
else
  echo "Already in P2P mode (no broker drop-in found)."
fi
