FROM node:22-alpine AS base
RUN apk add --no-cache ffmpeg
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
