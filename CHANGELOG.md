# Changelog

## 1.1.0 — 2026-10-20

### Security
- Optional `APP_ACCESS_TOKEN`, checked on the Socket.IO handshake (sha256 + `crypto.timingSafeEqual`).
- Same-origin check on the handshake, with an `ALLOWED_ORIGINS` allowlist (replaces Socket.IO CORS `*`).
- `MAX_CONNECTIONS` cap (default 20).
- Per-socket token-bucket rate limits: audio 60 burst / 30 per second; control 10 burst / 2 per second.
- `maxHttpBufferSize` set to 512 KB.
- Ports bound to `127.0.0.1` (app 3004, redis 6380).
- Strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no CDNs).
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`. `X-Powered-By` removed.
- Docker image: `.dockerignore` added; `ENV OPENAI_API_KEY=changeme` removed; `.gitignore` and `.env.example` added.
- Container runs as non-root `node` user (uid 1000); Redis runs as uid 999.
- Compose: `no-new-privileges`, optional `REDIS_PASSWORD`.
- Logs record event types and error codes only (no transcripts, brain content, or audio).
- Dependency vulnerabilities: `npm audit --omit=dev` reported 9 (1 critical, 5 high, 3 moderate) before the fix and 0 after (`npm audit fix`; `express` ^4.22.3, `ws` ^8.22.0 floors).

### Fixed
- Voice feature was non-functional: the server sent raw webm bytes to the Realtime WebSocket and read nonexistent response fields. The bridge is rewritten (`src/realtimeBridge.js`) for the GA Realtime interface.
- Stored XSS: model and server text was inserted via `innerHTML`. All DOM output now uses `textContent`.
- `btoa(String.fromCharCode(...))` threw `RangeError` on recordings longer than a few seconds. Base64 encoding is now chunked (0x8000 slices).
- Microphone tracks were never stopped; a double-click race leaked recorders. Full cleanup now runs on stop, error, disconnect and `pagehide`.
- Redis handlers lacked validation and try/catch (unhandled rejections; null payloads threw).
- Missing API key produced `Bearer undefined` requests. The UI now shows a `NO_API_KEY` banner; the server still serves the page.
- "Brain saved" was shown before server confirmation. Saves now use Socket.IO acks with a 10 s timeout and show real success or error toasts.
- Saved brain was never used by the model. It is now the session instructions, and saves push `session.update` to live sessions.
- Disconnect during async brain load could leave an orphan upstream socket; reconnect leaked the previous upstream WebSocket.
- Redis client queued commands offline indefinitely. Now `maxRetriesPerRequest` 2, `enableOfflineQueue` false, capped `retryStrategy`.
- Layout broke on mobile (fixed 50/50 columns, `overflow: hidden`). Replaced with a responsive CSS grid (stacks below 900px), `100dvh`, labels, `role="log"` `aria-live` transcript, `aria-pressed` on the mic button, focus rings, skip link, `prefers-reduced-motion`, system fonts.
- `VBRIAN_KEY` typo renamed; the key value is unchanged, so stored data is preserved.
- `package.json` `main` pointed to a nonexistent `index.js`.

### Added
- Status pill (Connecting / Ready / Recording / Thinking / Speaking / Offline / Error) with a Reconnect button.
- Token form (stored in `sessionStorage`).
- Stop reply (barge-in cancels the in-flight response).
- Character counter for the brain, with a 20000-character limit (`BRAIN_MAX_CHARS`).
- Unsaved-changes confirmation on Load; Ctrl/Cmd+S to save; Clear transcript with confirmation.
- Transcript capped at 200 entries.
- Toasts and microphone error messages (denied, no device, insecure context).
- `AudioWorklet` capture (`public/pcm-worklet.js`): 24 kHz PCM16 frames of about 100 ms; gapless playback of PCM16 deltas.
- `GET /healthz` (200 when Redis is up, 503 when down; never calls OpenAI).
- `GET /api/config`.
- Graceful SIGTERM / SIGINT shutdown.
- `session:restart` socket event.
- `scripts/mock-realtime.js` mock OpenAI Realtime server.
- Test suite (`node:test`, 47 tests); see TEST_REPORT.md.
- Docker: multi-stage `Dockerfile` on `node:22-slim` (`dev` and `prod` targets, `HEALTHCHECK`, `node server.js`).
- Compose: redis healthcheck with `depends_on: service_healthy` (replaces `sleep 5`); app healthcheck; `restart: unless-stopped`; `init: true`.

### Changed
- Stack: Node 18 to Node 22 (`node:22-slim`); Express 4 retained.
- Tailwind Play CDN replaced with local `public/styles.css`; styles and scripts are local.
- Source layout: `server.js` (entry), `src/app.js`, `src/realtimeBridge.js`, `src/brainStore.js`, `src/rateLimiter.js`, `src/config.js`, `src/logger.js`. Frontend: `public/index.html`, `public/styles.css`, `public/app.js`, `public/pcm-worklet.js`.
- Compose `app` service runs `target: dev` (nodemon); production image uses `target: prod` (`npm ci --omit=dev`).
- Model defaults: `gpt-realtime` (`OPENAI_REALTIME_MODEL`), voice `marin` (`OPENAI_VOICE`), transcription `gpt-4o-mini-transcribe` (`OPENAI_TRANSCRIPTION_MODEL`). The `OpenAI-Beta` header is no longer sent.
- Brain validation: string, trimmed, at most `BRAIN_MAX_CHARS` (20000). Errors: `INVALID_BRAIN`, `BRAIN_TOO_LONG`, `STORAGE_ERROR`.
- Socket contract: client to server `audio:append`, `audio:commit` (ack), `audio:cancel` (ack), `brain:save` (ack), `brain:load` (ack), `session:restart` (ack). Server to client `session:status`, `transcript:user`, `response:transcript.delta`, `response:audio.delta`, `response:done`, `app:error`.

### Removed
- Unused dependencies `multer` and `mysql2`; `openai` and `dotenv` were installed in the Dockerfile but not used.
- `nodemon` is no longer used as a runtime dependency in production (dev target only).
- Duplicate comments, duplicate `readme.txt`, and empty `tmp/` directory.

### Dependencies
- `ws` and `ioredis` added to `package.json` (previously installed ad hoc in the Dockerfile).
- `socket.io-client` added as a devDependency (test only).
- `npm audit --omit=dev`: 9 vulnerabilities before, 0 after (see Security).

### Configuration and migration notes
- New environment variables: `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_URL`, `OPENAI_VOICE`, `OPENAI_TRANSCRIPTION_MODEL`, `APP_ACCESS_TOKEN`, `ALLOWED_ORIGINS`, `MAX_CONNECTIONS`, `BRAIN_MAX_CHARS`, `REDIS_PASSWORD`, `LOG_LEVEL`.
- Set `APP_ACCESS_TOKEN` before exposing the app beyond localhost.
- Mic capture requires localhost or HTTPS for remote access (no TLS is provided by the app).
- After pulling dependency changes, run `docker compose up -d --build -V`. `-V` renews the anonymous `node_modules` volume; without it, stale modules persist (observed at baseline: container had `ws` 8.17.1).
- No data migration. The Redis key `vbrain:content` is unchanged.
- Backup of the brain: `docker compose exec redis redis-cli GET vbrain:content > brain-backup.txt` (documented in README).
- The pre-change state is preserved in `realtime-gpt.backup-20261020.tgz` (`/root/projects/chatgpt-realtimeAPI/`); git baseline commit `04d2ab8`.
