# Stage 1: build the React client
FROM node:22-alpine AS client-builder
WORKDIR /build
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ .
RUN npm run build

# Stage 2: development (hot reload — Vite serves client on :5173)
FROM node:22-alpine AS dev
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY src/ ./src/
CMD ["npm", "run", "dev:server"]

# Stage 3: production — API server + pre-built client + built-in CPU transcoder
FROM node:22-alpine AS production

# ffmpeg   — built-in CPU transcoder
# su-exec  — lightweight privilege-dropping for PUID/PGID support
RUN apk add --no-cache ffmpeg su-exec

WORKDIR /app

# App server dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Built-in transcoder dependencies (runs as a child process on port 3002)
COPY transcoder/package.json transcoder/package-lock.json* ./transcoder/
RUN cd transcoder && npm install --omit=dev

# Source files
COPY src/ ./src/
COPY transcoder/src/ ./transcoder/src/

# Pre-built React client
COPY --from=client-builder /build/dist ./client/dist

# Entrypoint creates the PUID/PGID user and fixes /config ownership before exec-ing
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
