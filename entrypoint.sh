#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create group with the requested GID if it doesn't already exist
if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" nexus
fi
GROUP=$(getent group "$PGID" | cut -d: -f1)

# Create user with the requested UID if it doesn't already exist
if ! getent passwd "$PUID" >/dev/null 2>&1; then
    adduser -u "$PUID" -G "$GROUP" -s /bin/sh -D nexus
fi

# Ensure config directory and expected subdirectories exist, owned by the target user
mkdir -p /config/plugins
chown -R "$PUID:$PGID" /config

echo "[nexusmediaserver] Running as UID=${PUID} GID=${PGID}"

exec su-exec "$PUID:$PGID" "$@"
