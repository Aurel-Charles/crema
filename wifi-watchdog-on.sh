#!/bin/bash
# Install + start the Wi-Fi watchdog on this Pi: a systemd service that recovers
# a hung USB Wi-Fi dongle automatically, with no physical replug. Aimed at the
# rtl8xxxu / RTL8192EU (TP-Link TL-WN823N on pi-desk), which freezes after a few
# hours of idle ("Disabling MAC timed out" in dmesg) and only comes back on an
# unplug/replug. The watchdog pings the gateway and, on sustained loss, reloads
# the dongle's kernel module — the software equivalent of the replug.
#
# Only needed on Pis using a USB Wi-Fi dongle; built-in Wi-Fi Pis don't need it.
# See docs/usb-wifi-dongle.md. Reverse with ./wifi-watchdog-off.sh.
#
# Override for another dongle:
#   WATCHDOG_DRIVER=mt7601u WATCHDOG_IFACE=wlan1 ./wifi-watchdog-on.sh
set -euo pipefail

DRIVER="${WATCHDOG_DRIVER:-rtl8xxxu}"
IFACE="${WATCHDOG_IFACE:-wlan0}"

echo "▸ Writing /usr/local/bin/wifi-watchdog.sh (iface=$IFACE driver=$DRIVER)"
# First heredoc is unquoted so IFACE/DRIVER are baked in at install time…
sudo tee /usr/local/bin/wifi-watchdog.sh >/dev/null <<EOF
#!/usr/bin/env bash
set -u
IFACE="$IFACE"; DRIVER="$DRIVER"
CHECK_INTERVAL=30; FAIL_THRESHOLD=3; PING_TIMEOUT=5
EOF
# …the rest is a quoted heredoc so the worker's own \$vars stay literal.
sudo tee -a /usr/local/bin/wifi-watchdog.sh >/dev/null <<'EOF'
log() { echo "$(date '+%F %T') wifi-watchdog: $*"; }
gateway() { ip route show default dev "$IFACE" 2>/dev/null | awk '/default/{print $3; exit}'; }
alive() { local gw; gw="$(gateway)"; [ -n "$gw" ] && ping -c1 -W"$PING_TIMEOUT" "$gw" >/dev/null 2>&1; }
soft_recover() {
  log "soft recovery: nmcli reconnect $IFACE"
  nmcli device disconnect "$IFACE" >/dev/null 2>&1; sleep 2
  nmcli device connect "$IFACE" >/dev/null 2>&1
}
hard_recover() {
  log "hard recovery: reloading kernel module $DRIVER"
  modprobe -r "$DRIVER" 2>/dev/null; sleep 3; modprobe "$DRIVER" 2>/dev/null; sleep 5
  nmcli device connect "$IFACE" >/dev/null 2>&1
}
log "started (iface=$IFACE driver=$DRIVER interval=${CHECK_INTERVAL}s threshold=$FAIL_THRESHOLD)"
fails=0
while true; do
  if alive; then
    [ "$fails" -gt 0 ] && log "link OK again"; fails=0
  else
    fails=$((fails+1)); log "no connectivity, fail $fails/$FAIL_THRESHOLD"
    if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
      soft_recover; sleep 8
      if alive; then log "recovered via soft reconnect"
      else hard_recover; sleep 8
        if alive; then log "recovered via module reload"
        else log "STILL DOWN after module reload — likely hard USB disconnect (see docs: DKMS plan B)"; fi
      fi
      fails=0
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
EOF
sudo chmod +x /usr/local/bin/wifi-watchdog.sh

echo "▸ Writing /etc/systemd/system/wifi-watchdog.service"
sudo tee /etc/systemd/system/wifi-watchdog.service >/dev/null <<'EOF'
[Unit]
Description=Wi-Fi watchdog (recover a hung USB Wi-Fi dongle)
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=simple
ExecStart=/usr/local/bin/wifi-watchdog.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now wifi-watchdog.service
sudo systemctl status wifi-watchdog.service --no-pager
echo
echo "✓ Watchdog active and enabled at boot. Follow: journalctl -u wifi-watchdog -f"
