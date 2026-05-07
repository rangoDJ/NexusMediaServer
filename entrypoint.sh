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

# Ensure app-managed config paths exist and are owned by the target user.
#
# IMPORTANT: we intentionally do NOT chown /config recursively.
# ./config/db (Postgres data) is bind-mounted into the db container and must
# remain owned by the Postgres internal user. Recursively chowning /config
# would overwrite those permissions and cause:
#   "could not open file global/pg_filenode.map: Permission denied"
#
# Instead, we only chown:
#   /config          — the directory itself, so the app can create .initialized
#   /config/plugins  — the plugin folder the app reads from
mkdir -p /config/plugins
chown "$PUID:$PGID" /config
chown -R "$PUID:$PGID" /config/plugins

echo "[nexusmediaserver] Running as UID=${PUID} GID=${PGID}"

exec su-exec "$PUID:$PGID" "$@"
