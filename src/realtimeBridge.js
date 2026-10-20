'use strict';

const WebSocket = require('ws');
const { errInfo } = require('./logger');

const OPEN = 1;
const CONNECT_TIMEOUT_MS = 15000;
const MAX_CHUNK_CHARS = 256 * 1024;
const MIN_COMMIT_BYTES = 4800; // 100ms of 24kHz PCM16 mono
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE_INSTRUCTIONS = 'You are a helpful, concise voice assistant.';

function buildInstructions(brain) {
  if (typeof brain === 'string' && brain.trim()) {
    return `${BASE_INSTRUCTIONS}\n\nUse the following saved knowledge when relevant:\n${brain}`;
  }
  return BASE_INSTRUCTIONS;
}

class RealtimeBridge {
  constructor({ config, wsFactory = (url, opts) => new WebSocket(url, opts), emit, logger, getInstructions = buildInstructions }) {
    this.config = config;
    this.wsFactory = wsFactory;
    this.emit = emit;
    this.logger = logger;
    this.getInstructions = getInstructions;
    this.ws = null;
    this.timer = null;
    this.closed = false;
    this.errored = false;
    this.readyEmitted = false;
    this.activeResponseId = null;
    this.bufferedBytes = 0;
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === OPEN;
  }

  _send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  _status(state) {
    this.emit('session:status', { state });
  }

  _clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  connect(brainText) {
    const { config } = this;
    if (!config.openaiApiKey) {
      this.emit('app:error', { code: 'NO_API_KEY', message: 'Server is missing its OpenAI API key.' });
      this._status('error');
      return;
    }
    this._status('connecting');
    this.brainText = brainText;
    const url = `${config.realtimeUrl}?model=${encodeURIComponent(config.realtimeModel)}`;
    let ws;
    try {
      ws = this.wsFactory(url, { headers: { Authorization: `Bearer ${config.openaiApiKey}` } });
    } catch (err) {
      this.logger.error('realtime connect failed', errInfo(err));
      this._fail();
      return;
    }
    this.ws = ws;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.logger.warn('realtime connect timeout');
      this.errored = true;
      this._status('error');
      this.emit('app:error', { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the voice service.' });
      try { ws.terminate(); } catch { /* ignore */ }
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      this._clearTimer();
      this._send({
        type: 'session.update',
        session: {
          type: 'realtime',
          // Read at open time so a brain saved while connecting is not lost.
          instructions: this.getInstructions(this.brainText),
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: config.transcriptionModel },
              turn_detection: null,
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: config.voice,
            },
          },
        },
      });
    });

    ws.on('message', (data) => this._onMessage(data));

    ws.on('error', (err) => {
      this.logger.error('realtime socket error', errInfo(err));
      this._clearTimer();
      if (this.closed) return;
      this.errored = true;
      this._status('error');
      this.emit('app:error', { code: 'UPSTREAM_UNAVAILABLE', message: 'Voice service connection failed.' });
    });

    ws.on('close', () => {
      this._clearTimer();
      this.activeResponseId = null;
      if (!this.closed && !this.errored) this._status('closed');
    });
  }

  _fail() {
    this.errored = true;
    this._status('error');
    this.emit('app:error', { code: 'UPSTREAM_UNAVAILABLE', message: 'Voice service connection failed.' });
  }

  _onMessage(data) {
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      this.logger.warn('ignored malformed upstream message');
      return;
    }
    if (!ev || typeof ev.type !== 'string') return;
    switch (ev.type) {
      case 'session.updated':
        if (!this.readyEmitted) {
          this.readyEmitted = true;
          this._status('ready');
        }
        break;
      case 'response.created':
        this.activeResponseId = ev.response && ev.response.id ? ev.response.id : null;
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.emit('transcript:user', { itemId: ev.item_id, text: ev.transcript });
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        this.emit('response:transcript.delta', { responseId: ev.response_id, delta: ev.delta });
        break;
      case 'response.output_audio.delta':
        this.emit('response:audio.delta', { responseId: ev.response_id, audio: ev.delta });
        break;
      case 'response.done':
        this.activeResponseId = null;
        this.emit('response:done', {
          responseId: ev.response && ev.response.id,
          status: ev.response && ev.response.status,
        });
        break;
      case 'error': {
        const e = ev.error || {};
        this.logger.warn('upstream error event', { code: e.code, type: e.type });
        this.emit('app:error', {
          code: 'UPSTREAM_ERROR',
          message: typeof e.message === 'string' ? e.message.slice(0, 200) : 'Voice service error.',
        });
        break;
      }
      default:
        this.logger.debug('ignored upstream event', { type: ev.type });
    }
  }

  updateInstructions(brain) {
    this.brainText = brain;
    if (!this.isOpen) return;
    this._send({ type: 'session.update', session: { type: 'realtime', instructions: this.getInstructions(brain) } });
  }

  appendAudio(base64) {
    if (typeof base64 !== 'string' || base64.length === 0) return { ok: false, code: 'INVALID_AUDIO' };
    if (base64.length > MAX_CHUNK_CHARS) return { ok: false, code: 'AUDIO_TOO_LARGE' };
    if (base64.length % 4 !== 0 || !BASE64_RE.test(base64)) return { ok: false, code: 'INVALID_AUDIO' };
    const bytes = Buffer.from(base64, 'base64').length;
    if (bytes === 0 || bytes % 2 !== 0) return { ok: false, code: 'INVALID_AUDIO' };
    if (!this.isOpen) return { ok: false, code: 'NOT_READY' };
    this._send({ type: 'input_audio_buffer.append', audio: base64 });
    this.bufferedBytes += bytes;
    return { ok: true };
  }

  commit() {
    if (!this.isOpen) return { ok: false, code: 'NOT_READY' };
    if (this.bufferedBytes < MIN_COMMIT_BYTES) {
      this._send({ type: 'input_audio_buffer.clear' });
      this.bufferedBytes = 0;
      return { ok: false, code: 'TOO_SHORT' };
    }
    this._send({ type: 'input_audio_buffer.commit' });
    this._send({ type: 'response.create' });
    this.bufferedBytes = 0;
    return { ok: true };
  }

  cancel() {
    if (this.isOpen) {
      this._send({ type: 'input_audio_buffer.clear' });
      if (this.activeResponseId) this._send({ type: 'response.cancel' });
    }
    this.bufferedBytes = 0;
    return { ok: true };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._clearTimer();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      const ws = this.ws;
      // Ensure a half-open socket cannot keep the process alive.
      const t = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, 2000);
      t.unref();
    }
  }
}

module.exports = { RealtimeBridge, buildInstructions };
