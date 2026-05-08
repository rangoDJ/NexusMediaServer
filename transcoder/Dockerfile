FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg && \
    # Node.js 22 via NodeSource
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list && \
    # Universe repo for ffmpeg and Intel VAAPI driver
    echo "deb http://archive.ubuntu.com/ubuntu noble universe" \
        > /etc/apt/sources.list.d/universe.list && \
    apt-get update && apt-get install -y --no-install-recommends \
        nodejs ffmpeg intel-media-va-driver && \
    rm -rf /var/lib/apt/lists/*

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
