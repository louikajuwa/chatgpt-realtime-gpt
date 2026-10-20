'use strict';

const KEY = 'vbrain:content';

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function createBrainStore(redis, { maxChars = 20000 } = {}) {
  return {
    async get() {
      const v = await redis.get(KEY);
      return v || '';
    },
    async set(value) {
      if (typeof value !== 'string') {
        throw new ValidationError('INVALID_BRAIN', 'Brain content must be text.');
      }
      const trimmed = value.trim();
      if (trimmed.length > maxChars) {
        throw new ValidationError('BRAIN_TOO_LONG', `Brain content is too long (max ${maxChars} characters).`);
      }
      await redis.set(KEY, trimmed);
      return { savedAt: new Date().toISOString() };
    },
    async ping() {
      try {
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createBrainStore, ValidationError, KEY };
