FROM node:22-alpine AS base
# mesa-va-gallium provides VA-API hardware acceleration for Intel iGPU
# via Mesa's open-source iris Gallium driver (Gen8+ / Broadwell and newer).
# libva-intel-driver covers older Gen4-7 (Haswell and earlier) as a fallback.
RUN apk add --no-cache ffmpeg mesa-va-gallium libva-intel-driver
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
