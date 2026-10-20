'use strict';

// Minimal leveled logger. Callers must only pass short, non-sensitive strings
// (never transcripts, audio, tokens or brain text).
function createLogger({ out = console, debug = false } = {}) {
  const line = (level, msg, meta) => {
    const extra = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra}`;
  };
  return {
    debug: (msg, meta) => { if (debug) out.log(line('debug', msg, meta)); },
    info: (msg, meta) => out.log(line('info', msg, meta)),
    warn: (msg, meta) => out.warn(line('warn', msg, meta)),
    error: (msg, meta) => out.error(line('error', msg, meta)),
  };
}

// Log an error without stack/payload: message and code only.
function errInfo(err) {
  return { message: err && err.message ? String(err.message).slice(0, 200) : 'unknown', code: err && err.code };
}

module.exports = { createLogger, errInfo };
