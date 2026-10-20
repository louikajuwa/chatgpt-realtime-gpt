// === Imports ===
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const Redis = require('ioredis');
const path = require('path');

// === Config ===
const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VBRIAN_KEY = 'vbrain:content';

// === Initialize Redis ===
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
redis.on('connect', () => console.log(`✅ Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`));
redis.on('error', (err) => console.error('❌ Redis error:', err));

// === Initialize Express + Socket.IO ===
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// === SOCKET LOGIC ===
io.on('connection', async (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);

  let realtimeWS = null;

  // 🧠 --- Create Realtime Session ---
  async function createRealtimeSession() {
    console.log('🔗 Connecting to OpenAI Realtime API...');

    realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    realtimeWS.on('open', () => {
      console.log('✅ [Realtime] Connected to OpenAI Realtime API.');
      socket.emit('realtimeReady', { message: 'Realtime session ready.' });
    });

    realtimeWS.on('message', (msg) => {
      console.log('📨 [Realtime → Server] Received message from OpenAI:');
      try {
        const parsed = JSON.parse(msg.toString());
        console.log(JSON.stringify(parsed, null, 2));

        // Try to extract any text message
        const text = parsed?.response?.output_text || parsed?.content?.[0]?.text;
        if (text) {
          console.log('💬 [Realtime] Text:', text);
          socket.emit('realtimeText', text);
        } else {
          console.log('🧩 [Realtime] Non-text message received.');
        }
      } catch (e) {
        console.log('⚠️ [Realtime] Raw message:', msg.toString());
      }
    });

    realtimeWS.on('error', (err) => {
      console.error('❌ [Realtime Error]:', err);
      socket.emit('realtimeError', 'Realtime API connection failed.');
    });

    realtimeWS.on('close', () => {
      console.log('🔴 [Realtime] Connection closed.');
    });
  }

  await createRealtimeSession();

  // 🧩 --- Handle incoming audio from frontend ---
  socket.on('clientAudio', (base64Audio) => {
    console.log('🎧 [Client] Received base64 audio chunk.');
    if (realtimeWS && realtimeWS.readyState === WebSocket.OPEN) {
      console.log('🚀 [Server → Realtime] Sending audio data to OpenAI...');
      const buffer = Buffer.from(base64Audio, 'base64');
      realtimeWS.send(buffer);
    } else {
      console.log('⚠️ [Server] Realtime WebSocket not open.');
      socket.emit('realtimeError', 'Realtime API not connected.');
    }
  });

  // --- Save brain data ---
  socket.on('setData', async ({ value }) => {
    console.log('🧠 [Redis] Saving brain data...');
    await redis.set(VBRIAN_KEY, value);
    socket.emit('dataSetSuccess', '🧠 Brain content saved successfully.');
  });

  // --- Load brain data ---
  socket.on('getData', async () => {
    console.log('📦 [Redis] Loading brain data...');
    const brain = await redis.get(VBRIAN_KEY);
    socket.emit('loadBrain', brain || '');
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
    if (realtimeWS) realtimeWS.close();
  });
});

server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
