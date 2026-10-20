'use strict';

const Redis = require('ioredis');
const { loadConfig } = require('./src/config');
const { createLogger, errInfo } = require('./src/logger');
const { createBrainStore } = require('./src/brainStore');
const { createServer } = require('./src/app');

const logger = createLogger({ debug: process.env.LOG_LEVEL === 'debug' });

let config;
try {
  config = loadConfig();
} catch (err) {
  logger.error('invalid configuration', { message: err.message });
  process.exit(1);
}

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
redis.on('error', (err) => logger.error('redis error', errInfo(err)));
redis.on('connect', () => logger.info('redis connected'));

const store = createBrainStore(redis, { maxChars: config.brainMaxChars });
const server = createServer({ config, store, logger });

server.httpServer.listen(config.port, () => {
  logger.info('server listening', {
    port: config.port,
    model: config.realtimeModel,
    authRequired: !!config.accessToken,
    originsRestricted: config.allowedOrigins.length > 0,
  });
});

if (!config.openaiApiKey) logger.warn('OPENAI_API_KEY is not set; voice sessions will fail');
if (!config.accessToken) logger.warn('APP_ACCESS_TOKEN is not set; anyone who can reach this server can use it');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  try {
    await server.close();
    await redis.quit();
  } catch (err) {
    logger.error('shutdown error', errInfo(err));
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { message: reason && reason.message ? reason.message : String(reason).slice(0, 200) });
});
