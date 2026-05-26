#!/bin/bash
# Stop and fully remove the Wi-Fi watchdog installed by ./wifi-watchdog-on.sh.
# Reversible: re-run ./wifi-watchdog-on.sh to bring it back.
set -euo pipefail

if [ -f /etc/systemd/system/wifi-watchdog.service ]; then
  echo "▸ Stopping and removing wifi-watchdog.service"
  sudo systemctl disable --now wifi-watchdog.service
  sudo rm -f /etc/systemd/system/wifi-watchdog.service /usr/local/bin/wifi-watchdog.sh
  sudo systemctl daemon-reload
  echo "✓ Wi-Fi watchdog stopped and removed."
else
  echo "No wifi-watchdog.service installed (nothing to do)."
fi
