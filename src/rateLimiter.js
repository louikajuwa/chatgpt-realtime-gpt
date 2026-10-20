'use strict';

function createRateLimiter({ capacity, refillPerSec, now = Date.now }) {
  let tokens = capacity;
  let last = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
      last = t;
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
  };
}

module.exports = { createRateLimiter };
