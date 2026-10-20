'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { io: ioc } = require('socket.io-client');
const { createServer } = require('../src/app');
const { createBrainStore } = require('../src/brainStore');
const { startMockRealtime } = require('../scripts/mock-realtime');
const { waitFor, captureLogger, testConfig, pcm } = require('./helpers');

function fakeRedis() {
  const data = new Map();
  return {
    down: false,
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async set(k, v) { data.set(k, v); return 'OK'; },
    async ping() { if (this.down) throw new Error('down'); return 'PONG'; },
  };
}

async function start(configOver = {}) {
  const mock = await startMockRealtime({ port: 0 });
  const redis = fakeRedis();
  const config = testConfig({ realtimeUrl: mock.url, brainMaxChars: 50, ...configOver });
  const logger = captureLogger();
  const server = createServer({ config, store: createBrainStore(redis, { maxChars: config.brainMaxChars }), logger });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const port = server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  const clients = [];
  const t = {
    mock, redis, server, base, logger,
    client(opts = {}) {
      const c = ioc(base, { reconnection: false, forceNew: true, transports: ['websocket'], ...opts });
      c.events = [];
      c.onAny((name, payload) => c.events.push({ name, payload }));
      c.find = (name, pred = () => true) => c.events.find((e) => e.name === name && pred(e.payload));
      clients.push(c);
      return c;
    },
    async connected(opts) {
      const c = t.client(opts);
      await new Promise((res, rej) => { c.on('connect', res); c.on('connect_error', rej); });
      return c;
    },
    async ready(opts) {
      const c = await t.connected(opts);
      await waitFor(() => c.find('session:status', (p) => p.state === 'ready'), { label: 'ready' });
      return c;
    },
    async stop() {
      for (const c of clients) c.close();
      await server.close();
      await mock.close();
    },
  };
  return t;
}

const emitAck = (c, ev, ...args) => new Promise((res) => c.emit(ev, ...args, res));
const connectError = (c) => new Promise((res) => c.on('connect_error', (e) => res(e.message)));

test('auth: rejected without/with wrong token, accepted with right one', async () => {
  const t = await start({ accessToken: 's3cret' });
  try {
    assert.strictEqual(await connectError(t.client()), 'unauthorized');
    assert.strictEqual(await connectError(t.client({ auth: { token: 'wrong' } })), 'unauthorized');
    assert.strictEqual(await connectError(t.client({ auth: { token: 5 } })), 'unauthorized');
    const c = await t.connected({ auth: { token: 's3cret' } });
    assert.ok(c.connected);
  } finally { await t.stop(); }
});

test('connection cap', async () => {
  const t = await start({ maxConnections: 1 });
  try {
    await t.connected();
    assert.strictEqual(await connectError(t.client()), 'server_busy');
  } finally { await t.stop(); }
});

test('brain save -> load round trip with acks', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    const saved = await emitAck(c, 'brain:save', { value: 'remember pie' });
    assert.strictEqual(saved.ok, true);
    assert.ok(saved.savedAt);
    assert.deepStrictEqual(await emitAck(c, 'brain:load'), { ok: true, value: 'remember pie' });
  } finally { await t.stop(); }
});

test('invalid brain payloads return error acks and server survives', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    for (const bad of [null, 42, 'str', {}, { value: 5 }]) {
      const r = await emitAck(c, 'brain:save', bad);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error.code, 'INVALID_BRAIN');
    }
    const long = await emitAck(c, 'brain:save', { value: 'x'.repeat(51) });
    assert.strictEqual(long.error.code, 'BRAIN_TOO_LONG');
    // no ack function supplied must not crash
    c.emit('brain:save', null);
    c.emit('audio:commit');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(c.connected);
    assert.strictEqual((await emitAck(c, 'brain:load')).ok, true);
  } finally { await t.stop(); }
});

test('storage failure gives STORAGE_ERROR', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    t.redis.set = async () => { throw new Error('boom secret'); };
    const r = await emitAck(c, 'brain:save', { value: 'a' });
    assert.deepStrictEqual(r, { ok: false, error: { code: 'STORAGE_ERROR', message: 'Could not save. Please try again.' } });
  } finally { await t.stop(); }
});

test('brain:save pushes session.update to live bridges; stored brain used on connect', async () => {
  const t = await start();
  try {
    const c = await t.ready();
    await emitAck(c, 'brain:save', { value: 'new knowledge' });
    await waitFor(() => t.mock.received.some((m) => m.type === 'session.update' && m.session.instructions
      && m.session.instructions.includes('new knowledge') && !m.session.audio), { label: 'push' });
    const c2 = await t.ready();
    assert.ok(c2.connected);
    const updates = t.mock.received.filter((m) => m.type === 'session.update' && m.session.audio);
    assert.ok(updates[updates.length - 1].session.instructions.includes('new knowledge'));
  } finally { await t.stop(); }
});

test('full flow: append -> commit -> transcript, deltas, audio, done', async () => {
  const t = await start();
  try {
    const c = await t.ready();
    c.emit('audio:append', pcm(2400));
    c.emit('audio:append', pcm(2400));
    await waitFor(() => t.mock.types.filter((x) => x === 'input_audio_buffer.append').length === 2);
    const ack = await emitAck(c, 'audio:commit');
    assert.deepStrictEqual(ack, { ok: true });
    await waitFor(() => c.find('response:done'), { label: 'done' });
    assert.deepStrictEqual(c.find('transcript:user').payload, { itemId: 'item_1', text: 'hello from mock' });
    assert.strictEqual(c.events.filter((e) => e.name === 'response:transcript.delta').length, 2);
    assert.strictEqual(c.find('response:audio.delta').payload.responseId, 'resp_1');
    assert.deepStrictEqual(c.find('response:done').payload, { responseId: 'resp_1', status: 'completed' });
  } finally { await t.stop(); }
});

test('commit too short, bad append, cancel', async () => {
  const t = await start();
  try {
    const c = await t.ready();
    c.emit('audio:append', pcm(100));
    c.emit('audio:append', 'not base64!!');
    await waitFor(() => c.find('app:error', (p) => p.code === 'INVALID_AUDIO'));
    const r = await emitAck(c, 'audio:commit');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'TOO_SHORT');
    assert.strictEqual(r.error.message, 'Recording too short — hold the button a little longer.');
    assert.deepStrictEqual(await emitAck(c, 'audio:cancel'), { ok: true });
  } finally { await t.stop(); }
});

test('session:restart reconnects upstream', async () => {
  const t = await start();
  try {
    const c = await t.ready();
    const before = t.mock.headers.length;
    assert.deepStrictEqual(await emitAck(c, 'session:restart'), { ok: true });
    await waitFor(() => t.mock.headers.length === before + 1, { label: 'reconnect' });
    await waitFor(() => c.events.filter((e) => e.name === 'session:status' && e.payload.state === 'ready').length === 2);
  } finally { await t.stop(); }
});

test('NO_API_KEY surfaces to the client', async () => {
  const t = await start({ openaiApiKey: undefined });
  try {
    const c = await t.connected();
    await waitFor(() => c.find('app:error', (p) => p.code === 'NO_API_KEY'));
  } finally { await t.stop(); }
});

test('rate limit on rapid brain:load', async () => {
  const t = await start();
  try {
    const c = await t.connected();
    const results = await Promise.all(Array.from({ length: 25 }, () => emitAck(c, 'brain:load')));
    assert.ok(results.some((r) => r.ok));
    assert.ok(results.some((r) => !r.ok && r.error.code === 'RATE_LIMITED'));
  } finally { await t.stop(); }
});

test('rate limit on audio:append emits throttled app:error', async () => {
  const t = await start();
  try {
    const c = await t.ready();
    for (let i = 0; i < 150; i++) c.emit('audio:append', pcm(100));
    await waitFor(() => c.find('app:error', (p) => p.code === 'RATE_LIMITED'), { label: 'rate limited' });
    assert.ok(c.events.filter((e) => e.name === 'app:error' && e.payload.code === 'RATE_LIMITED').length <= 2);
  } finally { await t.stop(); }
});

test('/healthz ok and degraded; never needs OpenAI', async () => {
  const t = await start({ openaiApiKey: undefined });
  try {
    let res = await fetch(`${t.base}/healthz`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: 'ok', redis: true });
    t.redis.down = true;
    res = await fetch(`${t.base}/healthz`);
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(await res.json(), { status: 'degraded', redis: false });
  } finally { await t.stop(); }
});

test('/api/config', async () => {
  const t = await start({ accessToken: 'x', brainMaxChars: 123 });
  try {
    const res = await fetch(`${t.base}/api/config`);
    assert.deepStrictEqual(await res.json(), { authRequired: true, brainMaxChars: 123, maxAudioChunkChars: 262144 });
  } finally { await t.stop(); }
});

test('security headers present, x-powered-by absent', async () => {
  const t = await start();
  try {
    const res = await fetch(`${t.base}/healthz`);
    const h = res.headers;
    assert.strictEqual(h.get('x-powered-by'), null);
    assert.ok(h.get('content-security-policy').startsWith("default-src 'self'; script-src 'self'"));
    assert.ok(h.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.strictEqual(h.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(h.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(h.get('x-frame-options'), 'DENY');
    assert.strictEqual(h.get('permissions-policy'), 'microphone=(self), camera=(), geolocation=()');
  } finally { await t.stop(); }
});

test('cross-origin handshake rejected; same-origin and no-origin allowed', async () => {
  const t = await start();
  try {
    const bad = t.client({ extraHeaders: { Origin: 'http://evil.example' } });
    await connectError(bad);
    assert.ok(!bad.connected);
    const same = await t.connected({ extraHeaders: { Origin: t.base } });
    assert.ok(same.connected);
    const none = await t.connected();
    assert.ok(none.connected);
  } finally { await t.stop(); }
});

test('allowedOrigins permits listed cross-origin', async () => {
  const t = await start({ allowedOrigins: ['http://app.example'] });
  try {
    const ok = await t.connected({ extraHeaders: { Origin: 'http://app.example' } });
    assert.ok(ok.connected);
    await connectError(t.client({ extraHeaders: { Origin: 'http://evil.example' } }));
  } finally { await t.stop(); }
});
