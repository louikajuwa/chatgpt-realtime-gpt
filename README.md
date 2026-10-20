# realtime-gpt

A push-to-talk voice assistant built on the OpenAI Realtime (GA) API. A "brain" stored in Redis (key `vbrain:content`) is used as the session instructions for every conversation.

```
Browser  <--Socket.IO-->  Node bridge (Express)  <--WebSocket-->  OpenAI Realtime
                               |
                             Redis (brain)
```

## Prerequisites

- Docker with Compose v2
- Host ports `3004` and `6380` free (bound to 127.0.0.1 only)
- An OpenAI API key with Realtime access

## Quick start

```bash
cp .env.example .env      # then edit .env and set OPENAI_API_KEY
docker compose up -d --build -V
```

Open http://localhost:3004. `-V` renews the anonymous `node_modules` volume; without it, stale modules persist after dependency changes. The project directory is bind-mounted and `nodemon --legacy-watch` hot-reloads code edits.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | none | Required for live responses. Never commit it. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | |
| `OPENAI_REALTIME_URL` | `wss://api.openai.com/v1/realtime` | Override for mock testing. |
| `OPENAI_VOICE` | `marin` | |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | Compose forces these for the app. |
| `REDIS_PASSWORD` | empty | Optional; Redis then starts with `--requirepass`. |
| `PORT` | `3000` | In-container port (host `3004`). |
| `APP_ACCESS_TOKEN` | empty | When set, the browser must enter it. |
| `ALLOWED_ORIGINS` | empty | Comma list; empty means same-origin only. |
| `MAX_CONNECTIONS` | `20` | |
| `BRAIN_MAX_CHARS` | `20000` | |

See `.env.example` for comments.

## Security notes

- Ports are published on `127.0.0.1` only. Set `APP_ACCESS_TOKEN` (and ideally `REDIS_PASSWORD`) before exposing the app through a proxy or other interface, and add the public origin to `ALLOWED_ORIGINS`.
- Never commit `.env` (it is git- and docker-ignored).
- Containers run with `no-new-privileges`; the app runs as the unprivileged `node` user.

## Tests

```bash
docker compose run --rm app npm test
```

## Mock mode

Run the mock Realtime server (`scripts/mock-realtime.js`) with `npm run mock:realtime`, then set `OPENAI_REALTIME_URL=ws://<host>:8089` in `.env` (from inside a container, use a host reachable from it, e.g. `host.docker.internal`).

## Production image

```bash
docker build --target prod -t realtime-gpt:prod .
docker run -d --name realtime-gpt --env-file .env -e REDIS_HOST=redis \
  --network <network-with-redis> -p 127.0.0.1:3004:3000 realtime-gpt:prod
```

The prod image has production dependencies only, runs `node server.js`, and has a built-in HEALTHCHECK.

## Health check

`GET /healthz` returns 200 when healthy, 503 if Redis is down.

```bash
curl -i http://localhost:3004/healthz
docker compose ps
```

## Backup / restore the brain

```bash
# text backup
docker compose exec redis redis-cli GET vbrain:content > brain-backup.txt

# full snapshot
docker compose exec redis redis-cli BGSAVE        # wait a moment (add -a "$REDIS_PASSWORD" if set)
docker compose cp redis:/data/dump.rdb ./dump.rdb
```

To restore a snapshot: stop Redis, copy `dump.rdb` into the `redis_data` volume at `/data/dump.rdb`, start Redis. Data lives in the named volume `redis_data`; `docker compose down -v` deletes it.

## Troubleshooting

- Microphone does not work: browsers require https or `localhost`.
- "NO_API_KEY" banner: `OPENAI_API_KEY` is missing in `.env`; recreate with `docker compose up -d`.
- Module not found / stale dependencies: `docker compose up -d --build -V`.

## Notes

`readme.txt` is superseded by this file.
