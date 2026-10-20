# realtime-gpt

A real-time voice/text assistant built on the OpenAI Realtime API (WebSocket streaming), running as a Node.js app with Redis, orchestrated via Docker Compose.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose v2](https://docs.docker.com/compose/) (the `docker compose` CLI plugin)
- Host ports `3004` and `6380` free
- An OpenAI API key with Realtime API access (for live responses)

## Run

```bash
docker compose up -d --build
```

This builds the app image and starts both services in the background.

## Services

| Service | Image/Build | Purpose | Port (host:container) | URL |
|---------|-------------|---------|-----------------------|-----|
| `app` (`realtime-gpt`) | Build from `./Dockerfile` (`node:18`) | Express + Socket.io + `ws` bridge to the OpenAI Realtime API | `3004:3000` | http://localhost:3004 |
| `redis` (`realtime-redis`) | `redis:7.2` | State/cache store | `6380:6379` | `127.0.0.1:6380` |

The project directory is bind-mounted into the app container and the container starts via `nodemon --legacy-watch`, so code edits hot-reload.

## Environment

Configuration is loaded from a `.env` file (referenced via `env_file` in `docker-compose.yml`). Create one before running:

```env
OPENAI_API_KEY=sk-...   # REQUIRED for live Realtime API responses
REDIS_HOST=redis        # Compose service name (default: redis)
REDIS_PORT=6379         # (default: 6379)
PORT=3000               # in-container app port (default: 3000)
```

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `OPENAI_API_KEY` | Yes (for live responses) | `changeme` (Dockerfile fallback) | Must have Realtime API access. The app boots and serves the UI without a valid key, but realtime responses require one. Never commit a real key. |
| `REDIS_HOST` | No | `redis` | Overridden to `redis` in compose. |
| `REDIS_PORT` | No | `6379` | Overridden to `6379` in compose. |
| `PORT` | No | `3000` | In-container listen port; mapped to host `3004`. |

## Volumes & persistence

- Named volume `redis_data` → `redis:/data` — persists Redis data across container restarts.
- Bind mount `.:/usr/src/app` — mounts the project source into the app container for hot reload.
- Anonymous volume `/usr/src/app/node_modules` — preserves the container's installed `node_modules` (prevents the bind mount from shadowing them).

## Common commands

```bash
docker compose logs -f app      # follow app logs (expect "Server running..." and Redis connect)
docker compose ps               # list service status
docker compose down             # stop and remove containers (keeps redis_data)
docker compose down -v          # also remove the redis_data volume
docker compose up -d --build    # rebuild and restart
docker compose exec app sh      # shell into the app container
docker compose exec redis redis-cli   # open a Redis CLI
```

## Verify

```bash
curl -I http://localhost:3004   # expect HTTP 200
```

Then open http://localhost:3004 in a browser and start a session (live responses require a valid `OPENAI_API_KEY`).
