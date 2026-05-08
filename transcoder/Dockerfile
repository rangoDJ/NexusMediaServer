FROM node:22-bookworm-slim AS base

# jellyfin-ffmpeg is a custom ffmpeg build with Intel QSV (oneVPL), VAAPI,
# and NVENC support — the same binary Jellyfin uses for hardware transcoding.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" \
        > /etc/apt/sources.list.d/jellyfin.list && \
    apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg  /usr/local/bin/ffmpeg && \
    ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM base AS dev
RUN npm install
COPY src/ ./src/
CMD ["node", "--watch", "src/index.js"]

FROM base AS production
COPY src/ ./src/
CMD ["node", "src/index.js"]
