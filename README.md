# NexusMediaServer

A self-hosted media server with a modern web UI, hardware-accelerated transcoding, and a plugin system. Stream your movies and TV shows to any browser — no client app required.

## Features

- **Library management** — point it at your media folders; the scanner picks up new files automatically via filesystem watching
- **Metadata** — fetches artwork, cast, plot, ratings, and genres from [TMDB](https://www.themoviedb.org/)
- **NFO support** — reads `.nfo` sidecar files (Kodi / Jellyfin format) as a metadata source
- **Streaming**
  - Direct play for browser-native containers (MP4/WebM/MOV) — zero transcoding, full scrubbing
  - HLS transcoding via ffmpeg for everything else
  - Adaptive Bitrate (ABR) — hls.js picks the best of 480p / 720p / 1080p variants automatically
  - Manual quality presets from 360p (700 Kbps) up to 4K (15 Mbps)
  - Server-side seeking — jumping to any position restarts the transcode from that offset instead of waiting for ffmpeg to catch up
- **Hardware acceleration** — CPU (default), NVIDIA NVENC, Intel VAAPI, Intel QSV
- **Distributed transcoding** — run transcoder nodes on separate machines; the API load-balances across them
- **Subtitles** — embedded subtitle tracks delivered via the player
- **Progress tracking** — resume where you left off, per user
- **People pages** — cast & crew with filmography, backed by TMDB
- **Plugin system** — drop JS plugins into `/config/plugins` to extend scanning, metadata, and streaming behaviour
- **Admin dashboard** — live transcoding stats, session history, per-node metrics, play-type ratio

## Tech stack

| Layer | Technology |
|---|---|
| API | [Fastify](https://fastify.dev/) (Node.js) |
| Database | PostgreSQL 16 |
| Transcoder | ffmpeg via [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) |
| Web UI | React 18 + [Vidstack](https://www.vidstack.io/) + hls.js |
| Container | Docker / Docker Compose |

## Quick start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2
- A free [TMDB API key](https://www.themoviedb.org/settings/api) (optional but recommended)

### 1 — Clone and configure

```bash
git clone https://github.com/rangoDJ/NexusMediaServer.git
cd NexusMediaServer
cp .env.example .env
```

Edit `.env`:

```env
# PostgreSQL credentials
POSTGRES_USER=nexus
POSTGRES_PASSWORD=a_strong_password
POSTGRES_DB=nexusdb

# Generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=your_long_random_secret

# Optional — enables automatic metadata fetching
TMDB_API_KEY=your_tmdb_key

# Shared secret between API and transcoder(s) — generate the same way as JWT_SECRET
TRANSCODER_SECRET=another_strong_secret

# Port the web UI is exposed on (default 80)
APP_PORT=80

# Where NexusMediaServer stores its config and database
CONFIG_PATH=./config
```

### 2 — Mount your media

Open `docker-compose.yml` and add your media directories to **both** the `nexusmediaserver` and `transcoder` services. The transcoder must be able to read the same paths as the API.

```yaml
# nexusmediaserver service
volumes:
  - ${CONFIG_PATH:-./config}:/config
  - /mnt/media/movies:/movies:ro   # ← add your paths here
  - /mnt/media/tv:/tv:ro

# transcoder service
volumes:
  - hls_segments:/tmp/hls
  - /mnt/media/movies:/movies:ro   # ← mirror the same paths
  - /mnt/media/tv:/tv:ro
```

### 3 — Start

```bash
docker compose up -d
```

Open **http://localhost** (or your server's IP) and follow the first-launch setup wizard to create an admin account and add your first library.

## Hardware acceleration

By default the bundled transcoder uses CPU (libx264). To use a GPU, edit `docker-compose.yml`:

### NVIDIA (NVENC)

Requires [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/).

```yaml
# Replace the "transcoder" service with the nvidia block from docker-compose.yml
transcoder-nvidia:
  image: ghcr.io/rangodj/nexusmediaserver-transcoder:latest
  runtime: nvidia
  environment:
    HW_ACCEL: nvenc
    ...
```

### Intel (VAAPI / QuickSync)

```yaml
transcoder-intel:
  image: ghcr.io/rangodj/nexusmediaserver-transcoder:latest
  devices:
    - /dev/dri/renderD128:/dev/dri/renderD128
  environment:
    HW_ACCEL: vaapi   # or: qsv
    VAAPI_DEVICE: /dev/dri/renderD128
    ...
```

Full commented examples for both are included in `docker-compose.yml`.

## Distributed transcoding

The transcoder is a separate Fastify service that registers itself with the API on startup. You can run multiple transcoder nodes (on different machines) and the API will distribute sessions across them by load.

Each additional node needs:
- The same media volumes mounted at the same container paths
- `TRANSCODER_SECRET` matching the API
- `API_URL` pointing at the API container
- `TRANSCODER_PUBLIC_URL` set to its own address (so the API can route segment requests back to it)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_USER` | — | PostgreSQL username |
| `POSTGRES_PASSWORD` | — | PostgreSQL password |
| `POSTGRES_DB` | — | PostgreSQL database name |
| `DATABASE_URL` | _(built from above)_ | Full connection string — set this to use an external Postgres |
| `JWT_SECRET` | — | Secret used to sign auth tokens |
| `TMDB_API_KEY` | _(empty)_ | TMDB API key for metadata fetching |
| `TRANSCODER_SECRET` | — | Shared secret between API and transcoder nodes |
| `APP_PORT` | `80` | Host port the web UI is exposed on |
| `CONFIG_PATH` | `./config` | Host path for persistent config and database data |
| `PUID` / `PGID` | `1000` | User/group ID the process runs as inside the container |
| `HW_ACCEL` | `cpu` | Transcoder acceleration: `cpu`, `nvenc`, `vaapi`, `qsv` |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | DRI device path for VAAPI/QSV |
| `HLS_OUTPUT_PATH` | `/tmp/hls` | Where ffmpeg writes HLS segments (transcoder only) |

## Development

### Running locally

```bash
# 1. Start Postgres and the transcoder in Docker
docker compose -f docker-compose.yml -f docker-compose.dev.yml up db transcoder -d

# 2. Install dependencies and start the API with hot reload
npm install
npm run dev

# The API hot-reloads on :3000 and Vite serves the UI on :5173
```

### Building the production image from source

```bash
docker compose build
# or without cache:
docker compose build --no-cache
```

### Database migrations

Migrations run automatically on startup. To run them manually:

```bash
node src/db/migrate.js
```

Migration files live in `src/db/migrations/` and are applied in filename order. New migrations are picked up automatically — never edit an existing migration file.

## Project layout

```
NexusMediaServer/
├── src/                    # Fastify API server
│   ├── db/                 # Migrations and Postgres pool
│   ├── middleware/         # Auth, role guards
│   ├── routes/             # API route handlers (auth, libraries, media, stream, …)
│   ├── services/           # Scanner, TMDB, transcoder pool, plugin loader, …
│   └── index.js            # Server entry point
├── transcoder/             # Standalone HLS transcoder service
│   └── src/
│       ├── routes/         # Session management endpoints
│       └── services/       # ffmpeg wrapper, session store, idle janitor
├── client/                 # React web UI (Vite)
│   └── src/
│       ├── api/            # Axios client
│       └── pages/          # Route pages and Player component
├── docker-compose.yml      # Production compose (CPU + NVIDIA + Intel profiles)
├── docker-compose.dev.yml  # Dev overrides
├── Dockerfile              # Multi-stage build (client → dev → production)
└── .env.example            # Environment variable template
```

## Plugins

Drop a `.js` file into `CONFIG_PATH/plugins/`. Plugins can hook into:

| Hook | Description |
|---|---|
| `metadata.enrich` | Add or override metadata fields after TMDB/NFO fetch |
| `stream.start` | Override codec, resolution, or bitrate for a stream |

Plugins are hot-reloaded; no restart required. See `src/services/pluginLoader.js` for the hook API.

## License

MIT
