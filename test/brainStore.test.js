'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createBrainStore, ValidationError, KEY } = require('../src/brainStore');

function fakeRedis() {
  const data = new Map();
  return {
    data,
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async set(k, v) { data.set(k, v); return 'OK'; },
    async ping() { return 'PONG'; },
  };
}

test('key is unchanged', () => assert.strictEqual(KEY, 'vbrain:content'));

test('get returns empty string when missing', async () => {
  const s = createBrainStore(fakeRedis(), { maxChars: 10 });
  assert.strictEqual(await s.get(), '');
});

test('set then get round-trips under the right key', async () => {
  const r = fakeRedis();
  const s = createBrainStore(r, { maxChars: 100 });
  const { savedAt } = await s.set('  hello ');
  assert.ok(!Number.isNaN(Date.parse(savedAt)));
  assert.strictEqual(r.data.get('vbrain:content'), 'hello');
  assert.strictEqual(await s.get(), 'hello');
});

test('empty string clears', async () => {
  const s = createBrainStore(fakeRedis(), { maxChars: 10 });
  await s.set('x');
  await s.set('');
  assert.strictEqual(await s.get(), '');
});

test('validation errors', async () => {
  const s = createBrainStore(fakeRedis(), { maxChars: 5 });
  for (const bad of [null, undefined, 5, {}, []]) {
    await assert.rejects(() => s.set(bad), (e) => e instanceof ValidationError && e.code === 'INVALID_BRAIN');
  }
  await assert.rejects(() => s.set('123456'), (e) => e instanceof ValidationError && e.code === 'BRAIN_TOO_LONG');
  await s.set('12345');
});

test('ping true/false', async () => {
  assert.strictEqual(await createBrainStore(fakeRedis(), {}).ping(), true);
  const broken = { ping: async () => { throw new Error('down'); } };
  assert.strictEqual(await createBrainStore(broken, {}).ping(), false);
});
