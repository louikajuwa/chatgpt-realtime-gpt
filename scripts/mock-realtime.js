'use strict';

// Standalone mock of the OpenAI Realtime WebSocket API (for tests and local dev).
const { WebSocketServer } = require('ws');

function startMockRealtime({ port = 0 } = {}) {
  const received = []; // { type, msg }
  const headers = []; // handshake headers per connection
  const wss = new WebSocketServer({ port });
  const sockets = new Set();

  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    headers.push(req.headers);
    ws.on('close', () => sockets.delete(ws));
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    send({ type: 'session.created', session: {} });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      received.push(msg);
      switch (msg.type) {
        case 'session.update':
          send({ type: 'session.updated', session: msg.session });
          break;
        case 'input_audio_buffer.commit':
          send({ type: 'input_audio_buffer.committed', item_id: 'item_1' });
          send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', transcript: 'hello from mock' });
          break;
        case 'response.create':
          send({ type: 'response.created', response: { id: 'resp_1' } });
          send({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', delta: 'Hi ' });
          send({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', delta: 'there <b>xss</b>' });
          send({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: Buffer.alloc(2400).toString('base64') });
          send({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
          break;
        case 'response.cancel':
          send({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } });
          break;
        default:
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => {
      const p = wss.address().port;
      resolve({
        url: `ws://127.0.0.1:${p}`,
        port: p,
        received,
        get types() { return received.map((m) => m.type); },
        headers,
        sockets,
        close: () => new Promise((res) => {
          for (const s of sockets) s.terminate();
          wss.close(() => res());
        }),
      });
    });
  });
}

module.exports = { startMockRealtime };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8089', 10);
  startMockRealtime({ port }).then((m) => {
    console.log(`mock realtime listening on ${m.url}`);
    const stop = () => m.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
