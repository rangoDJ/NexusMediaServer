FROM node:22-slim AS base
# Debian slim gives us access to Intel VAAPI drivers not available in Alpine.
# intel-media-va-driver  = iHD driver for Intel Gen 8+ (Broadwell and newer)
# i965-va-driver         = legacy driver for Gen 4-7 (Haswell and older)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    intel-media-va-driver \
    i965-va-driver \
    && rm -rf /var/lib/apt/lists/*
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
