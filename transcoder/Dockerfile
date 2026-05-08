FROM node:22-alpine AS base
# ffmpeg with VAAPI support (open-source Intel iHD driver for Gen8+ iGPU)
# QSV is not available in Alpine ffmpeg — use HW_ACCEL=vaapi for Intel hardware encoding
RUN apk add --no-cache ffmpeg intel-media-driver libva-utils
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
