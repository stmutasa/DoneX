#!/bin/sh
set -e

# The data dir is typically a platform volume mounted root-owned. Make it
# writable for the app user, then drop privileges before starting the server.
DIR="${DATA_DIR:-/data}"
mkdir -p "$DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DIR"
  exec gosu node "$@"
fi

exec "$@"
