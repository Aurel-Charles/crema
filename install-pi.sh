#!/bin/bash
# Crema — install script for a Pi.
# Sets up the systemd service (server), the desktop autostart (display kiosk),
# and disables screen blanking. Idempotent — safe to re-run.
set -euo pipefail

CREMA_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
USER_NAME="$(whoami)"

echo "▸ Crema install"
echo "  user: $USER_NAME"
echo "  dir:  $CREMA_DIR"

# Make launcher scripts executable
chmod +x "$CREMA_DIR/start.sh" "$CREMA_DIR/start-display.sh"

# 1. Systemd service for the Node server
echo "▸ Writing /etc/systemd/system/crema.service"
sudo tee /etc/systemd/system/crema.service > /dev/null <<EOF
[Unit]
Description=Crema messenger
After=network-online.target avahi-daemon.service
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$CREMA_DIR
ExecStart=/bin/bash $CREMA_DIR/start.sh
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable crema.service
sudo systemctl restart crema.service

# 2. Desktop autostart for the Chromium kiosk display
echo "▸ Writing ~/.config/autostart/crema-display.desktop"
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/crema-display.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Crema Display
Comment=Crema Pi display screen
Exec=/bin/bash $CREMA_DIR/start-display.sh
X-GNOME-Autostart-enabled=true
EOF

# 3. Disable screen blanking via raspi-config (works on X11 and Wayland)
echo "▸ Disabling screen blanking"
if command -v raspi-config > /dev/null 2>&1; then
  sudo raspi-config nonint do_blanking 1 || true
else
  echo "  (raspi-config not found — disable blanking manually if needed)"
fi

echo
echo "✓ Installed."
echo "  • Server status : sudo systemctl status crema"
echo "  • Server logs   : sudo journalctl -u crema -f"
echo "  • Manual restart: sudo systemctl restart crema"
echo "  • Test full boot: sudo reboot"
