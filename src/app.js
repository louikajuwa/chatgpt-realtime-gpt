'use strict';

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const { RealtimeBridge, buildInstructions } = require('./realtimeBridge');
const { ValidationError } = require('./brainStore');
const { createRateLimiter } = require('./rateLimiter');
const { errInfo } = require('./logger');

const MAX_AUDIO_CHUNK_CHARS = 256 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function digest(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  return crypto.timingSafeEqual(digest(expected), digest(given));
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function createServer({ config, store, wsFactory, logger }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    next();
  });

  app.get('/healthz', async (req, res) => {
    let ok = false;
    try {
      ok = !!(await store.ping());
    } catch {
      ok = false;
    }
    res.status(ok ? 200 : 503).json(ok ? { status: 'ok', redis: true } : { status: 'degraded', redis: false });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      authRequired: !!config.accessToken,
      brainMaxChars: config.brainMaxChars,
      maxAudioChunkChars: MAX_AUDIO_CHUNK_CHARS,
    });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const httpServer = http.createServer(app);
  const allowed = config.allowedOrigins || [];

  const ioOptions = {
    maxHttpBufferSize: 512 * 1024,
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      const h = hostOf(origin);
      return cb(null, !!h && h === req.headers.host);
    },
  };
  if (allowed.length) ioOptions.cors = { origin: [...allowed] };
  const io = new Server(httpServer, ioOptions);

  io.use((socket, next) => {
    if (config.accessToken && !tokenMatches(config.accessToken, socket.handshake.auth && socket.handshake.auth.token)) {
      return next(new Error('unauthorized'));
    }
    if (io.engine.clientsCount > config.maxConnections) return next(new Error('server_busy'));
    next();
  });

  const bridges = new Set();

  io.on('connection', (socket) => {
    const audioLimiter = createRateLimiter({ capacity: 60, refillPerSec: 30 });
    const controlLimiter = createRateLimiter({ capacity: 10, refillPerSec: 2 });
    let lastRateEmit = 0;
    let bridge = null;

    function makeBridge() {
      const b = new RealtimeBridge({
        config,
        wsFactory,
        logger,
        getInstructions: buildInstructions,
        emit: (event, payload) => {
          if (bridge === b) socket.emit(event, payload);
        },
      });
      bridge = b;
      bridges.add(b);
      return b;
    }

    async function startBridge() {
      const b = makeBridge();
      let brain = '';
      try {
        brain = await store.get();
      } catch (err) {
        logger.warn('brain load failed', errInfo(err));
      }
      if (socket.disconnected || bridge !== b) return;
      b.connect(brain);
    }

    function dropBridge() {
      if (bridge) {
        bridge.close();
        bridges.delete(bridge);
        bridge = null;
      }
    }

    function rateLimited(limiter, ack) {
      if (limiter.take()) return false;
      const msg = 'Too many requests. Please slow down.';
      if (typeof ack === 'function') {
        ack(fail('RATE_LIMITED', msg));
      } else {
        const t = Date.now();
        if (t - lastRateEmit >= 1000) {
          lastRateEmit = t;
          socket.emit('app:error', { code: 'RATE_LIMITED', message: msg });
        }
      }
      return true;
    }

    // Wraps a handler: ack-safe, never throws.
    function handle(name, limiter, fn) {
      socket.on(name, async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
        const reply = (v) => { if (ack) { try { ack(v); } catch { /* ignore */ } } };
        try {
          if (limiter && rateLimited(limiter, ack)) return;
          await fn(args[0] === ack ? undefined : args[0], reply);
        } catch (err) {
          logger.error(`handler ${name} failed`, errInfo(err));
          reply(fail('INTERNAL', 'Something went wrong.'));
        }
      });
    }

    const toAck = (r) => {
      if (r.ok) return { ok: true };
      const message = r.code === 'TOO_SHORT'
        ? 'Recording too short — hold the button a little longer.'
        : r.code === 'NOT_READY' ? 'Voice session is not ready yet.' : 'Request failed.';
      return fail(r.code, message);
    };

    handle('audio:append', audioLimiter, (base64) => {
      const r = bridge ? bridge.appendAudio(base64) : { ok: false, code: 'NOT_READY' };
      if (!r.ok) socket.emit('app:error', { code: r.code, message: toAck(r).error.message });
    });

    handle('audio:commit', controlLimiter, (_p, reply) => {
      reply(toAck(bridge ? bridge.commit() : { ok: false, code: 'NOT_READY' }));
    });

    handle('audio:cancel', controlLimiter, (_p, reply) => {
      reply(toAck(bridge ? bridge.cancel() : { ok: true }));
    });

    handle('brain:save', controlLimiter, async (payload, reply) => {
      if (!payload || typeof payload !== 'object' || typeof payload.value !== 'string') {
        return reply(fail('INVALID_BRAIN', 'Brain content must be text.'));
      }
      let saved;
      try {
        saved = await store.set(payload.value);
      } catch (err) {
        if (err instanceof ValidationError) return reply(fail(err.code, err.message));
        logger.error('brain save failed', errInfo(err));
        return reply(fail('STORAGE_ERROR', 'Could not save. Please try again.'));
      }
      reply({ ok: true, savedAt: saved.savedAt });
      for (const b of bridges) {
        try { b.updateInstructions(payload.value.trim()); } catch (err) { logger.warn('instruction push failed', errInfo(err)); }
      }
    });

    handle('brain:load', controlLimiter, async (_p, reply) => {
      try {
        reply({ ok: true, value: await store.get() });
      } catch (err) {
        logger.error('brain load failed', errInfo(err));
        reply(fail('STORAGE_ERROR', 'Could not load. Please try again.'));
      }
    });

    handle('session:restart', controlLimiter, async (_p, reply) => {
      dropBridge();
      await startBridge();
      reply({ ok: true });
    });

    socket.on('disconnect', dropBridge);

    startBridge().catch((err) => logger.error('session start failed', errInfo(err)));
  });

  async function close() {
    for (const b of bridges) b.close();
    bridges.clear();
    io.disconnectSockets(true);
    await new Promise((resolve) => io.close(() => resolve()));
  }

  return { app, httpServer, io, close };
}

module.exports = { createServer };
