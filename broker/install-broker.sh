#!/bin/bash
# Crema broker — install the relay as a systemd service on a LAN server.
# Run this on the dedicated server (not on a Pi). Idempotent — safe to re-run.
#
# Optional env:
#   BROKER_PORT         listen port (default 4000)
#   CREMA_BROKER_TOKEN  shared secret; when set, Pis must register with it
#
# Example:
#   CREMA_BROKER_TOKEN=s3cret ./install-broker.sh
set -euo pipefail

BROKER_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
USER_NAME="$(whoami)"
PORT="${BROKER_PORT:-4000}"

echo "▸ Crema broker install"
echo "  user: $USER_NAME"
echo "  dir:  $BROKER_DIR"
echo "  port: $PORT"

chmod +x "$BROKER_DIR/start-broker.sh"

# Install runtime deps (socket.io only — skip the socket.io-client devDep).
if [ ! -d "$BROKER_DIR/node_modules" ]; then
  echo "▸ npm install (broker deps)"
  (cd "$BROKER_DIR" && npm install --omit=dev)
fi

# Bake env into the unit. BROKER_PORT always; token only if provided.
ENV_BLOCK="Environment=BROKER_PORT=$PORT"$'\n'
if [ -n "${CREMA_BROKER_TOKEN:-}" ]; then
  ENV_BLOCK="${ENV_BLOCK}Environment=CREMA_BROKER_TOKEN=$CREMA_BROKER_TOKEN"$'\n'
fi

echo "▸ Writing /etc/systemd/system/crema-broker.service"
sudo tee /etc/systemd/system/crema-broker.service > /dev/null <<EOF
[Unit]
Description=Crema LAN broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$BROKER_DIR
ExecStart=/bin/bash $BROKER_DIR/start-broker.sh
${ENV_BLOCK}Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable crema-broker.service
sudo systemctl restart crema-broker.service

echo
echo "✓ Broker installed."
echo "  • Status : sudo systemctl status crema-broker"
echo "  • Logs   : sudo journalctl -u crema-broker -f"
echo "  • Health : curl http://localhost:$PORT/health"
echo
echo "  Point each Pi at this server:"
echo "    ./enable-broker.sh ws://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT${CREMA_BROKER_TOKEN:+ $CREMA_BROKER_TOKEN}"
