// Realtime Voice Brain - frontend. Plain ES2020, no dependencies.
const DEBUG = false;
const debug = (...a) => { if (DEBUG) console.debug('[rtgpt]', ...a); };

const TOKEN_KEY = 'rtgpt_token';
const ACK_TIMEOUT = 10000;
const MAX_ENTRIES = 200;
const PLAY_RATE = 24000;
const B64_STEP = 0x8000;

const $ = (id) => document.getElementById(id);
const el = {
  statusPill: $('statusPill'), statusText: $('statusText'), reconnectBtn: $('reconnectBtn'),
  banner: $('banner'), busyBox: $('busyBox'), busyText: $('busyText'), retryBtn: $('retryBtn'),
  authPanel: $('authPanel'), authForm: $('authForm'), tokenInput: $('tokenInput'), authError: $('authError'),
  brainInput: $('brainInput'), brainCount: $('brainCount'), saveBrain: $('saveBrain'), loadBrain: $('loadBrain'),
  transcript: $('transcript'), emptyState: $('emptyState'), clearBtn: $('clearBtn'),
  micButton: $('micButton'), micLabel: $('micLabel'), micHint: $('micHint'), stopReply: $('stopReply'),
  toasts: $('toasts'),
};

const state = {
  config: { authRequired: false, brainMaxChars: 20000, maxAudioChunkChars: 1000000 },
  socket: null,
  connected: false,
  session: 'connecting', // connecting | ready | error | closed
  needsAuth: false,
  starting: false,
  recording: false,
  stopping: false,
  thinking: false,
  currentResponseId: null,
  cancelledResponses: new Set(),
  brainSaved: '',
  brainPending: false,
  brainAutoLoaded: false,
};

/* ---------- Toasts ---------- */
function toast(message, isError = false) {
  const t = document.createElement('div');
  t.className = isError ? 'toast toast-error' : 'toast';
  if (isError) t.setAttribute('role', 'alert');
  t.textContent = message;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/* ---------- Transcript ---------- */
const assistantBubbles = new Map(); // responseId -> text span

function nearBottom() {
  const t = el.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}

function entryCount() {
  return el.transcript.children.length - (el.emptyState.parentNode === el.transcript ? 1 : 0);
}

function pushEntry(node) {
  const stick = nearBottom();
  el.emptyState.hidden = true;
  el.transcript.appendChild(node);
  const entries = Array.from(el.transcript.children).filter((c) => c !== el.emptyState);
  for (let i = 0; i < entries.length - MAX_ENTRIES; i++) entries[i].remove();
  if (stick) el.transcript.scrollTop = el.transcript.scrollHeight;
}

function addBubble(kind, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (kind === 'user' ? 'msg-user' : 'msg-assistant');
  const role = document.createElement('span');
  role.className = 'msg-role';
  role.textContent = kind === 'user' ? 'You' : 'Assistant';
  const body = document.createElement('span');
  body.className = 'msg-text';
  body.textContent = text;
  div.append(role, body);
  pushEntry(div);
  return body;
}

function addSystem(text, isError = false) {
  const p = document.createElement('div');
  p.className = 'msg msg-system' + (isError ? ' is-error' : '');
  p.textContent = text;
  pushEntry(p);
}

function appendAssistant(responseId, delta) {
  let body = assistantBubbles.get(responseId);
  if (!body || !body.isConnected) {
    body = addBubble('assistant', '');
    assistantBubbles.set(responseId, body);
  }
  const stick = nearBottom();
  body.textContent += delta;
  if (stick) el.transcript.scrollTop = el.transcript.scrollHeight;
}

el.clearBtn.addEventListener('click', () => {
  if (entryCount() === 0) return;
  if (!window.confirm('Clear the conversation transcript?')) return;
  Array.from(el.transcript.children).forEach((c) => { if (c !== el.emptyState) c.remove(); });
  assistantBubbles.clear();
  el.emptyState.hidden = false;
});

/* ---------- Status / UI render ---------- */
function setPill(kind, text) {
  el.statusPill.className = 'pill pill-' + kind;
  el.statusText.textContent = text;
}

function render() {
  const ready = state.connected && state.session === 'ready';
  let kind;
  let text;
  if (state.needsAuth) { kind = 'offline'; text = 'Offline'; }
  else if (!state.connected) { kind = state.socket && state.socket.active ? 'connecting' : 'offline'; text = kind === 'connecting' ? 'Connecting' : 'Offline'; }
  else if (state.session === 'error') { kind = 'error'; text = 'Error'; }
  else if (state.session === 'closed') { kind = 'offline'; text = 'Offline'; }
  else if (state.session === 'connecting') { kind = 'connecting'; text = 'Connecting'; }
  else if (state.recording) { kind = 'recording'; text = 'Recording'; }
  else if (playback.sources.size > 0) { kind = 'speaking'; text = 'Speaking'; }
  else if (state.thinking) { kind = 'thinking'; text = 'Thinking'; }
  else { kind = 'ready'; text = 'Ready'; }
  setPill(kind, text);

  const canReconnect = !state.needsAuth && ((!state.connected && !(state.socket && state.socket.active)) ||
    (state.connected && (state.session === 'closed' || state.session === 'error')));
  el.reconnectBtn.hidden = !canReconnect;

  const busy = state.starting || state.stopping;
  el.micButton.disabled = busy || (!state.recording && !ready);
  el.micButton.setAttribute('aria-pressed', String(state.recording));
  el.micLabel.textContent = state.recording ? 'Stop & send' : 'Start talking';
  el.stopReply.hidden = !(playback.sources.size > 0 || (state.currentResponseId && !state.cancelledResponses.has(state.currentResponseId)));

  updateBrainButtons();
}

/* ---------- Ack helper ---------- */
function emitAck(event, payload, cb) {
  const s = state.socket;
  if (!s || !s.connected) { cb(new Error('Not connected')); return; }
  const handler = (err, res) => cb(err, res);
  if (payload === undefined) s.timeout(ACK_TIMEOUT).emit(event, handler);
  else s.timeout(ACK_TIMEOUT).emit(event, payload, handler);
}

function ackError(err, res, fallback) {
  if (err) return 'Request timed out. Please try again.';
  if (res && res.ok === false) return (res.error && res.error.message) || fallback;
  if (!res) return fallback;
  return null;
}

/* ---------- Brain panel ---------- */
function brainDirty() { return el.brainInput.value !== state.brainSaved; }

function updateBrainCounter() {
  const max = state.config.brainMaxChars;
  const n = el.brainInput.value.length;
  el.brainCount.textContent = `${n} / ${max}`;
  el.brainCount.classList.toggle('over', n >= max);
  el.brainCount.classList.toggle('warn', n < max && n >= max * 0.9);
}

function updateBrainButtons() {
  const on = state.connected && !state.brainPending;
  el.saveBrain.disabled = !on || !brainDirty();
  el.loadBrain.disabled = !on;
}

function saveBrain() {
  if (el.saveBrain.disabled) return;
  const value = el.brainInput.value;
  state.brainPending = true;
  updateBrainButtons();
  emitAck('brain:save', { value }, (err, res) => {
    state.brainPending = false;
    const msg = ackError(err, res, 'Could not save brain.');
    if (msg) toast(msg, true);
    else { state.brainSaved = value; toast('Brain saved.'); }
    updateBrainButtons();
  });
}

function loadBrain({ auto = false } = {}) {
  if (state.brainPending) return;
  if (!auto && brainDirty() && !window.confirm('You have unsaved changes. Replace them with the saved brain?')) return;
  state.brainPending = true;
  updateBrainButtons();
  emitAck('brain:load', undefined, (err, res) => {
    state.brainPending = false;
    const msg = ackError(err, res, 'Could not load brain.');
    if (msg) toast(msg, true);
    else {
      const value = typeof res.value === 'string' ? res.value : '';
      if (!auto || el.brainInput.value === '') {
        el.brainInput.value = value;
        state.brainSaved = value;
        updateBrainCounter();
        if (!auto) toast('Brain loaded.');
      }
    }
    updateBrainButtons();
  });
}

el.brainInput.addEventListener('input', () => { updateBrainCounter(); updateBrainButtons(); });
el.saveBrain.addEventListener('click', saveBrain);
el.loadBrain.addEventListener('click', () => loadBrain());
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveBrain();
  }
});

/* ---------- Playback ---------- */
const playback = { ctx: null, nextStart: 0, sources: new Set() };

function ensurePlaybackCtx() {
  if (!playback.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { playback.ctx = new AC({ sampleRate: PLAY_RATE }); }
    catch (_) { playback.ctx = new AC(); }
  }
  if (playback.ctx.state === 'suspended') playback.ctx.resume().catch(() => {});
  return playback.ctx;
}

function b64ToFloat32(b64) {
  const bin = atob(b64);
  const len = bin.length & ~1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(len / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function playChunk(b64) {
  const ctx = ensurePlaybackCtx();
  if (!ctx) return;
  let samples;
  try { samples = b64ToFloat32(b64); } catch (_) { return; }
  if (!samples.length) return;
  const buf = ctx.createBuffer(1, samples.length, PLAY_RATE);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime + 0.02, playback.nextStart);
  src.start(startAt);
  playback.nextStart = startAt + buf.duration;
  playback.sources.add(src);
  src.onended = () => { playback.sources.delete(src); render(); };
  render();
}

function stopPlayback() {
  playback.sources.forEach((s) => { s.onended = null; try { s.stop(); } catch (_) { /* already stopped */ } });
  playback.sources.clear();
  playback.nextStart = 0;
}

function cancelResponse() {
  const id = state.currentResponseId;
  if (id) state.cancelledResponses.add(id);
  stopPlayback();
  state.thinking = false;
  if (state.connected) emitAck('audio:cancel', undefined, () => {});
  render();
}

el.stopReply.addEventListener('click', () => { ensurePlaybackCtx(); cancelResponse(); });

/* ---------- Capture ---------- */
let cap = null;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += B64_STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_STEP));
  }
  return btoa(bin);
}

function cleanupCapture(c) {
  if (!c) return;
  c.cancelled = true;
  try { if (c.node) { c.node.port.onmessage = null; c.node.disconnect(); } } catch (_) { /* ignore */ }
  try { if (c.src) c.src.disconnect(); } catch (_) { /* ignore */ }
  try { if (c.gain) c.gain.disconnect(); } catch (_) { /* ignore */ }
  try { if (c.stream) c.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
  try { if (c.ctx && c.ctx.state !== 'closed') c.ctx.close().catch(() => {}); } catch (_) { /* ignore */ }
  c.node = c.src = c.gain = c.stream = c.ctx = null;
  if (cap === c) cap = null;
}

function abortRecording(message) {
  const c = cap;
  const had = state.recording || state.starting;
  if (c) cleanupCapture(c);
  state.recording = false;
  state.starting = false;
  if (had && c && c.bytes > 0 && state.connected) emitAck('audio:cancel', undefined, () => {});
  if (message) { toast(message, true); el.micHint.textContent = message; }
  render();
}

function micErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow the microphone in your browser\'s site settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or unavailable. Close other apps using it and try again.';
    default:
      return 'Could not start the microphone.';
  }
}

async function startRecording() {
  if (state.starting || state.recording || state.stopping) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const msg = window.isSecureContext === false
      ? 'Microphone access needs a secure connection. Open this page over HTTPS or on localhost.'
      : 'This browser does not support microphone capture.';
    toast(msg, true); el.micHint.textContent = msg; return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !window.AudioWorkletNode) {
    const msg = 'This browser does not support the audio features required (AudioWorklet).';
    toast(msg, true); el.micHint.textContent = msg; return;
  }

  state.starting = true;
  el.micHint.textContent = '';
  render();

  // Barge-in: stop playback; cancel server response only if one is in progress.
  const responseInProgress = !!state.currentResponseId;
  ensurePlaybackCtx();
  if (playback.sources.size > 0 || responseInProgress) {
    if (responseInProgress) cancelResponse(); else stopPlayback();
  }

  const c = { stream: null, ctx: null, src: null, node: null, gain: null, bytes: 0, cancelled: false, flushResolve: null };
  cap = c;
  try {
    c.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (c.cancelled) { cleanupCapture(c); return; }
    c.ctx = new AC({ latencyHint: 'interactive' });
    if (c.ctx.state === 'suspended') await c.ctx.resume();
    await c.ctx.audioWorklet.addModule('pcm-worklet.js');
    if (c.cancelled) { cleanupCapture(c); return; }
    c.src = c.ctx.createMediaStreamSource(c.stream);
    c.node = new AudioWorkletNode(c.ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    c.gain = c.ctx.createGain();
    c.gain.gain.value = 0;
    c.node.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.pcm) {
        if (!state.connected || c.cancelled) return;
        c.bytes += d.pcm.byteLength;
        state.socket.emit('audio:append', toBase64(d.pcm));
      } else if (d && d.flushed && c.flushResolve) {
        c.flushResolve();
      }
    };
    c.src.connect(c.node);
    c.node.connect(c.gain);
    c.gain.connect(c.ctx.destination);
    state.starting = false;
    state.recording = true;
    render();
  } catch (err) {
    debug('start failed', err && err.name);
    state.starting = false;
    cleanupCapture(c);
    const msg = micErrorMessage(err);
    toast(msg, true); el.micHint.textContent = msg;
    render();
  }
}

async function stopRecording() {
  const c = cap;
  if (!c || !state.recording || state.stopping) return;
  state.stopping = true;
  state.recording = false;
  render();

  // Flush remaining samples from the worklet (with a safety timeout).
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 300);
    c.flushResolve = () => { clearTimeout(timer); resolve(); };
    try { c.node.port.postMessage('flush'); } catch (_) { clearTimeout(timer); resolve(); }
  });
  const bytes = c.bytes;
  cleanupCapture(c);

  if (!state.connected) { state.stopping = false; render(); return; }
  if (bytes === 0) {
    state.stopping = false;
    toast('Too short - hold the button a little longer and speak.', true);
    render();
    return;
  }
  emitAck('audio:commit', undefined, (err, res) => {
    state.stopping = false;
    if (err) toast('Sending audio timed out. Please try again.', true);
    else if (res && res.ok === false) {
      const code = res.error && res.error.code;
      if (code === 'TOO_SHORT') toast('That was too short - speak a little longer.', true);
      else toast((res.error && res.error.message) || 'Could not send audio.', true);
    } else {
      state.thinking = true;
    }
    render();
  });
  render();
}

el.micButton.addEventListener('click', () => {
  ensurePlaybackCtx(); // resume on user gesture
  if (state.recording) stopRecording(); else startRecording();
});

window.addEventListener('pagehide', () => abortRecording());
window.addEventListener('beforeunload', () => { if (cap) cleanupCapture(cap); });

/* ---------- Auth ---------- */
function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
function setToken(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ } }

function showAuth(errorText) {
  state.needsAuth = true;
  el.authPanel.hidden = false;
  el.authError.hidden = !errorText;
  el.authError.textContent = errorText || '';
  el.tokenInput.value = '';
  el.tokenInput.focus();
  render();
}

el.authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = el.tokenInput.value.trim();
  if (!t) return;
  setToken(t);
  el.authPanel.hidden = true;
  state.needsAuth = false;
  connect();
});

/* ---------- Socket ---------- */
function connect() {
  if (state.socket) { state.socket.removeAllListeners(); state.socket.disconnect(); }
  el.busyBox.hidden = true;
  const token = getToken();
  const s = io({ auth: { token }, transports: ['websocket'] });
  state.socket = s;
  state.connected = false;
  state.session = 'connecting';
  bindSocket(s);
  render();
}

function bindSocket(s) {
  s.on('connect', () => {
    state.connected = true;
    state.session = 'connecting';
    el.busyBox.hidden = true;
    el.authPanel.hidden = true;
    state.needsAuth = false;
    if (!state.brainAutoLoaded) {
      state.brainAutoLoaded = true;
      if (el.brainInput.value === '') loadBrain({ auto: true });
    }
    render();
  });

  s.on('disconnect', () => {
    state.connected = false;
    state.thinking = false;
    state.currentResponseId = null;
    state.stopping = false;
    state.brainPending = false;
    stopPlayback();
    if (state.recording || state.starting) abortRecording('Connection lost while recording.');
    addSystem('Disconnected from server.');
    render();
  });

  s.on('connect_error', (err) => {
    state.connected = false;
    const m = err && err.message;
    if (m === 'unauthorized') {
      setToken('');
      s.disconnect();
      showAuth('That token was not accepted. Please try again.');
    } else if (m === 'server_busy') {
      s.disconnect();
      el.busyText.textContent = 'The server is busy right now. Please try again in a moment.';
      el.busyBox.hidden = false;
    }
    render();
  });

  s.on('session:status', (d) => {
    state.session = d && d.state ? d.state : 'connecting';
    if (state.session === 'ready') {
      if (el.banner.dataset.code !== 'NO_API_KEY') el.banner.hidden = true;
    } else if (state.session === 'error' || state.session === 'closed') {
      if (state.recording || state.starting) abortRecording('Voice session ended.');
      state.thinking = false;
      if (d && d.message) addSystem(d.message, state.session === 'error');
    }
    render();
  });

  s.on('transcript:user', (d) => { if (d && d.text) addBubble('user', d.text); });

  s.on('response:transcript.delta', (d) => {
    if (!d || typeof d.delta !== 'string') return;
    state.currentResponseId = d.responseId;
    state.thinking = false;
    appendAssistant(d.responseId, d.delta);
    render();
  });

  s.on('response:audio.delta', (d) => {
    if (!d || !d.audio) return;
    state.currentResponseId = d.responseId;
    state.thinking = false;
    if (state.cancelledResponses.has(d.responseId) || state.recording || state.starting) return;
    playChunk(d.audio);
  });

  s.on('response:done', (d) => {
    const id = d && d.responseId;
    if (id === state.currentResponseId) state.currentResponseId = null;
    assistantBubbles.delete(id);
    state.cancelledResponses.delete(id);
    state.thinking = false;
    if (d && d.status && d.status !== 'completed' && d.status !== 'cancelled') addSystem(`Response ${d.status}.`, true);
    render();
  });

  s.on('app:error', (d) => {
    const message = (d && d.message) || 'Something went wrong.';
    if (d && d.code === 'NO_API_KEY') {
      el.banner.dataset.code = 'NO_API_KEY';
      el.banner.textContent = message;
      el.banner.hidden = false;
    } else {
      toast(message, true);
    }
    addSystem(message, true);
  });
}

el.reconnectBtn.addEventListener('click', () => {
  const s = state.socket;
  if (!s) { connect(); return; }
  if (s.connected) {
    state.session = 'connecting';
    render();
    emitAck('session:restart', undefined, (err, res) => {
      const msg = ackError(err, res, 'Could not restart the session.');
      if (msg) { toast(msg, true); state.session = 'error'; render(); }
    });
  } else {
    connect();
  }
});

el.retryBtn.addEventListener('click', () => connect());

/* ---------- Init ---------- */
async function init() {
  updateBrainCounter();
  render();
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) Object.assign(state.config, await r.json());
  } catch (_) {
    toast('Could not load server configuration; using defaults.', true);
  }
  el.brainInput.maxLength = state.config.brainMaxChars;
  updateBrainCounter();
  if (state.config.authRequired && !getToken()) showAuth('');
  else connect();
}

init();
