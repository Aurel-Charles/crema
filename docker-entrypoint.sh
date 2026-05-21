#!/bin/sh
set -e

mkdir -p /app/data

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data
  exec runuser -u node -- "$@"
fi

exec "$@"
