'use strict';

async function waitFor(fn, { timeout = 3000, interval = 10, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

function captureLogger() {
  const calls = [];
  const mk = (level) => (msg, meta) => calls.push({ level, msg, meta });
  return { calls, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

function testConfig(over = {}) {
  return Object.freeze({
    port: 0,
    redis: { host: '127.0.0.1', port: 6379, password: undefined },
    openaiApiKey: 'test-key',
    realtimeModel: 'gpt-realtime',
    realtimeUrl: 'ws://127.0.0.1:1',
    voice: 'marin',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    accessToken: undefined,
    allowedOrigins: [],
    maxConnections: 20,
    brainMaxChars: 20000,
    ...over,
  });
}

// 1 second of 24kHz PCM16 silence = 48000 bytes; returns base64 of n bytes.
const pcm = (n) => Buffer.alloc(n).toString('base64');

module.exports = { waitFor, captureLogger, testConfig, pcm };
