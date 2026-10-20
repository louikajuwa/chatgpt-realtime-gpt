'use strict';

function int(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`Invalid ${name}: expected a non-negative integer, got "${s}"`);
  return parseInt(s, 10);
}

function str(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  return String(raw).trim();
}

function loadConfig(env = process.env) {
  const origins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return Object.freeze({
    port: int(env, 'PORT', 3000),
    redis: Object.freeze({
      host: str(env, 'REDIS_HOST', '127.0.0.1'),
      port: int(env, 'REDIS_PORT', 6379),
      password: str(env, 'REDIS_PASSWORD', undefined),
    }),
    openaiApiKey: str(env, 'OPENAI_API_KEY', undefined),
    realtimeModel: str(env, 'OPENAI_REALTIME_MODEL', 'gpt-realtime'),
    realtimeUrl: str(env, 'OPENAI_REALTIME_URL', 'wss://api.openai.com/v1/realtime'),
    voice: str(env, 'OPENAI_VOICE', 'marin'),
    transcriptionModel: str(env, 'OPENAI_TRANSCRIPTION_MODEL', 'gpt-4o-mini-transcribe'),
    accessToken: str(env, 'APP_ACCESS_TOKEN', undefined),
    allowedOrigins: Object.freeze(origins),
    maxConnections: int(env, 'MAX_CONNECTIONS', 20),
    brainMaxChars: int(env, 'BRAIN_MAX_CHARS', 20000),
  });
}

module.exports = { loadConfig };
