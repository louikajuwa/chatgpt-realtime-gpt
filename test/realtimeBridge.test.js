'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RealtimeBridge, buildInstructions } = require('../src/realtimeBridge');
const { startMockRealtime } = require('../scripts/mock-realtime');
const { waitFor, captureLogger, testConfig, pcm } = require('./helpers');

async function setup({ brain = '', config = {} } = {}) {
  const mock = await startMockRealtime({ port: 0 });
  const events = [];
  const logger = captureLogger();
  const bridge = new RealtimeBridge({
    config: testConfig({ realtimeUrl: mock.url, ...config }),
    emit: (event, payload) => events.push({ event, payload }),
    logger,
    getInstructions: buildInstructions,
  });
  bridge.connect(brain);
  const find = (name, pred = () => true) => events.find((e) => e.event === name && pred(e.payload));
  return {
    mock, bridge, events, logger, find,
    async ready() { await waitFor(() => find('session:status', (p) => p.state === 'ready'), { label: 'ready' }); },
    async cleanup() { bridge.close(); await mock.close(); },
  };
}

test('buildInstructions', () => {
  assert.strictEqual(buildInstructions(''), 'You are a helpful, concise voice assistant.');
  assert.strictEqual(
    buildInstructions('facts'),
    'You are a helpful, concise voice assistant.\n\nUse the following saved knowledge when relevant:\nfacts',
  );
});

test('connect sends exact session.update, no OpenAI-Beta header, ready status', async () => {
  const t = await setup({ brain: 'my brain' });
  try {
    await t.ready();
    assert.deepStrictEqual(t.events[0], { event: 'session:status', payload: { state: 'connecting' } });
    assert.deepStrictEqual(t.mock.received[0], {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: buildInstructions('my brain'),
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: null,
          },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
        },
      },
    });
    assert.strictEqual(t.mock.headers[0].authorization, 'Bearer test-key');
    assert.strictEqual(t.mock.headers[0]['openai-beta'], undefined);
  } finally { await t.cleanup(); }
});

test('ready is emitted only once', async () => {
  const t = await setup();
  try {
    await t.ready();
    t.bridge.updateInstructions('new');
    await waitFor(() => t.mock.received.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(t.events.filter((e) => e.event === 'session:status' && e.payload.state === 'ready').length, 1);
  } finally { await t.cleanup(); }
});

test('updateInstructions sends minimal session.update', async () => {
  const t = await setup();
  try {
    await t.ready();
    t.bridge.updateInstructions('fresh');
    await waitFor(() => t.mock.received.length === 2);
    assert.deepStrictEqual(t.mock.received[1], {
      type: 'session.update',
      session: { type: 'realtime', instructions: buildInstructions('fresh') },
    });
  } finally { await t.cleanup(); }
});

test('brain saved while still connecting is used when the session opens', async () => {
  const t = await setup({ brain: 'old brain' });
  try {
    t.bridge.updateInstructions('newer brain'); // before upstream open
    await t.ready();
    assert.strictEqual(t.mock.received[0].session.instructions, buildInstructions('newer brain'));
  } finally { await t.cleanup(); }
});

test('appendAudio validation', async () => {
  const t = await setup();
  try {
    await t.ready();
    assert.strictEqual(t.bridge.appendAudio(123).code, 'INVALID_AUDIO');
    assert.strictEqual(t.bridge.appendAudio('').code, 'INVALID_AUDIO');
    assert.strictEqual(t.bridge.appendAudio('A'.repeat(256 * 1024 + 4)).code, 'AUDIO_TOO_LARGE');
    assert.strictEqual(t.bridge.appendAudio('not base64!!').code, 'INVALID_AUDIO');
    assert.strictEqual(t.bridge.appendAudio(Buffer.alloc(3).toString('base64')).code, 'INVALID_AUDIO'); // odd length
    assert.deepStrictEqual(t.bridge.appendAudio(pcm(100)), { ok: true });
    await waitFor(() => t.mock.types.includes('input_audio_buffer.append'));
    assert.strictEqual(t.mock.types.filter((x) => x === 'input_audio_buffer.append').length, 1);
  } finally { await t.cleanup(); }
});

test('appendAudio before open is NOT_READY', async () => {
  const mock = await startMockRealtime({ port: 0 });
  const bridge = new RealtimeBridge({
    config: testConfig({ realtimeUrl: mock.url }), emit() {}, logger: captureLogger(),
  });
  try {
    assert.strictEqual(bridge.appendAudio(pcm(100)).code, 'NOT_READY');
  } finally { bridge.close(); await mock.close(); }
});

test('commit too short sends clear', async () => {
  const t = await setup();
  try {
    await t.ready();
    t.bridge.appendAudio(pcm(1000));
    assert.deepStrictEqual(t.bridge.commit(), { ok: false, code: 'TOO_SHORT' });
    await waitFor(() => t.mock.types.includes('input_audio_buffer.clear'));
    assert.ok(!t.mock.types.includes('input_audio_buffer.commit'));
    // buffer was reset: another short commit still too short
    assert.strictEqual(t.bridge.commit().code, 'TOO_SHORT');
  } finally { await t.cleanup(); }
});

test('commit ok sends commit then response.create, maps events', async () => {
  const t = await setup();
  try {
    await t.ready();
    t.bridge.appendAudio(pcm(4800));
    assert.deepStrictEqual(t.bridge.commit(), { ok: true });
    await waitFor(() => t.find('response:done'));
    const types = t.mock.types;
    assert.ok(types.indexOf('input_audio_buffer.commit') < types.indexOf('response.create'));
    assert.deepStrictEqual(t.find('transcript:user').payload, { itemId: 'item_1', text: 'hello from mock' });
    const deltas = t.events.filter((e) => e.event === 'response:transcript.delta').map((e) => e.payload);
    assert.deepStrictEqual(deltas, [
      { responseId: 'resp_1', delta: 'Hi ' },
      { responseId: 'resp_1', delta: 'there <b>xss</b>' },
    ]);
    const audio = t.find('response:audio.delta').payload;
    assert.strictEqual(audio.responseId, 'resp_1');
    assert.strictEqual(Buffer.from(audio.audio, 'base64').length, 2400);
    assert.deepStrictEqual(t.find('response:done').payload, { responseId: 'resp_1', status: 'completed' });
    // buffer reset after commit
    assert.strictEqual(t.bridge.commit().code, 'TOO_SHORT');
  } finally { await t.cleanup(); }
});

test('cancel sends clear, and response.cancel only with an active response', async () => {
  const t = await setup();
  try {
    await t.ready();
    assert.deepStrictEqual(t.bridge.cancel(), { ok: true });
    await waitFor(() => t.mock.types.includes('input_audio_buffer.clear'));
    assert.ok(!t.mock.types.includes('response.cancel'));
    t.bridge.activeResponseId = 'resp_1';
    t.bridge.cancel();
    await waitFor(() => t.mock.types.includes('response.cancel'));
    await waitFor(() => t.find('response:done', (p) => p.status === 'cancelled'));
  } finally { await t.cleanup(); }
});

test('upstream error event and malformed JSON', async () => {
  const events = [];
  const logger = captureLogger();
  let handlers = {};
  const fakeWs = { readyState: 1, send() {}, close() {}, terminate() {}, on(n, f) { handlers[n] = f; } };
  const bridge = new RealtimeBridge({
    config: testConfig(), emit: (e, p) => events.push({ event: e, payload: p }), logger, wsFactory: () => fakeWs,
  });
  bridge.connect('');
  handlers.message(Buffer.from('{not json'));
  handlers.message(Buffer.from(JSON.stringify({ type: 'something.else' })));
  handlers.message(Buffer.from(JSON.stringify({ type: 'error', error: { code: 'bad', type: 'invalid', message: 'x'.repeat(500) } })));
  const err = events.find((e) => e.event === 'app:error');
  assert.strictEqual(err.payload.code, 'UPSTREAM_ERROR');
  assert.strictEqual(err.payload.message.length, 200);
  assert.ok(logger.calls.some((c) => c.level === 'warn' && c.msg.includes('malformed')));
  bridge.close();
});

test('ws error -> status error + UPSTREAM_UNAVAILABLE; close after is not "closed"', async () => {
  const events = [];
  let handlers = {};
  const fakeWs = { readyState: 0, send() {}, close() {}, terminate() {}, on(n, f) { handlers[n] = f; } };
  const bridge = new RealtimeBridge({
    config: testConfig(), emit: (e, p) => events.push({ event: e, payload: p }), logger: captureLogger(), wsFactory: () => fakeWs,
  });
  bridge.connect('');
  handlers.error(new Error('ECONNREFUSED'));
  handlers.close();
  assert.ok(events.some((e) => e.event === 'session:status' && e.payload.state === 'error'));
  assert.ok(events.some((e) => e.event === 'app:error' && e.payload.code === 'UPSTREAM_UNAVAILABLE'));
  assert.ok(!events.some((e) => e.payload.state === 'closed'));
  bridge.close();
});

test('server-side close emits closed status; intentional close does not', async () => {
  const t = await setup();
  try {
    await t.ready();
    for (const s of t.mock.sockets) s.close();
    await waitFor(() => t.find('session:status', (p) => p.state === 'closed'));
  } finally { await t.cleanup(); }

  const t2 = await setup();
  try {
    await t2.ready();
    t2.bridge.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!t2.find('session:status', (p) => p.state === 'closed'));
  } finally { await t2.cleanup(); }
});

test('NO_API_KEY path', () => {
  const events = [];
  let created = false;
  const bridge = new RealtimeBridge({
    config: testConfig({ openaiApiKey: undefined }),
    emit: (e, p) => events.push({ event: e, payload: p }),
    logger: captureLogger(),
    wsFactory: () => { created = true; },
  });
  bridge.connect('');
  assert.strictEqual(created, false);
  assert.deepStrictEqual(events[0], {
    event: 'app:error', payload: { code: 'NO_API_KEY', message: 'Server is missing its OpenAI API key.' },
  });
  assert.deepStrictEqual(events[1], { event: 'session:status', payload: { state: 'error' } });
  assert.strictEqual(bridge.appendAudio(pcm(100)).code, 'NOT_READY');
});

test('close is idempotent', async () => {
  const t = await setup();
  try {
    await t.ready();
    t.bridge.close();
    t.bridge.close();
    assert.strictEqual(t.bridge.closed, true);
  } finally { await t.cleanup(); }
});

test('logger never receives transcript, brain or audio text', async () => {
  const secret = 'TOP-SECRET-BRAIN';
  const t = await setup({ brain: secret });
  try {
    await t.ready();
    t.bridge.appendAudio(pcm(4800));
    t.bridge.commit();
    await waitFor(() => t.find('response:done'));
    t.bridge._onMessage(Buffer.from(`{broken ${secret}`));
    t.bridge._onMessage(Buffer.from(JSON.stringify({ type: 'error', error: { code: 'c', type: 't', message: secret } })));
    const dump = JSON.stringify(t.logger.calls);
    for (const s of [secret, 'hello from mock', 'xss', 'Bearer', 'test-key']) {
      assert.ok(!dump.includes(s), `logger leaked ${s}`);
    }
  } finally { await t.cleanup(); }
});
