#!/bin/bash
# Crema broker launcher — sources nvm so systemd can find Node.
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd "$(dirname "$(readlink -f "$0")")"
exec node server.js
