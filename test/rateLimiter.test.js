'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../src/rateLimiter');

test('allows up to capacity then blocks', () => {
  let t = 0;
  const l = createRateLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
  assert.ok(l.take());
  assert.ok(l.take());
  assert.ok(l.take());
  assert.strictEqual(l.take(), false);
});

test('refills over time but never above capacity', () => {
  let t = 0;
  const l = createRateLimiter({ capacity: 2, refillPerSec: 2, now: () => t });
  l.take(2);
  assert.strictEqual(l.take(), false);
  t = 500;
  assert.ok(l.take());
  assert.strictEqual(l.take(), false);
  t = 100000;
  assert.ok(l.take(2));
  assert.strictEqual(l.take(), false);
});

test('take(n) is all-or-nothing', () => {
  const l = createRateLimiter({ capacity: 2, refillPerSec: 0, now: () => 0 });
  assert.strictEqual(l.take(3), false);
  assert.ok(l.take(2));
});
