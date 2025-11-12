// nimbus_conference.js
// Single-file WebRTC mesh + signaling prototype with embedded client HTML.
// Dependencies: express, ws, mongodb, jsonwebtoken, uuid, cookie-parser
// Install: npm i express ws mongodb jsonwebtoken uuid cookie-parser

require('dotenv').config?.();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'nimbus_demo';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const TOKEN_TTL_SEC = Number(process.env.TOKEN_TTL_SEC || 60 * 10); // 10 min
const PUBLIC_ORIGINS = (process.env.PUBLIC_ORIGINS || 'http://localhost:3000').split(',');
const STUN_SERVERS = (process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302').split(',');
const TURN_SERVERS = process.env.TURN_SERVERS ? process.env.TURN_SERVERS.split(',') : []; // format user:pass@turn:host:port or host:port

// Utility to build ICE servers array
function buildIceServers() {
  const ice = [];
  STUN_SERVERS.forEach(s => { if (s) ice.push({ urls: s }); });
  TURN_SERVERS.forEach(t => {
    // Accept format: username:password@turn:host:port or just turn:host:port?username=... (we keep simple)
    // If username:password@host:port, parse
    const m = t.match(/^([^:]+):([^@]+)@(.+)$/);
    if (m) {
      ice.push({ urls: turn:${m[3]}, username: m[1], credential: m[2] });
    } else {
      ice.push({ urls: turn:${t} });
    }
  });
  return ice;
}

// In-memory WS -> participant mapping
const rooms = new Map(); // roomId => { participants: Map(peerId -> { ws, name, joinedAt, muted }) }

// Simple logger
function log(obj, ...rest) {
  const base = { t: new Date().toISOString(), pid: process.pid };
  console.log(JSON.stringify(Object.assign(base, typeof obj === 'object' ? obj : { msg: obj }), null, 0), ...rest);
}

// MongoDB setup
let mongoClient;
let db;
async function initMongo() {
  mongoClient = new MongoClient(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true });
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  await db.collection('rooms').createIndex({ roomId: 1 }, { unique: true });
  await db.collection('participants').createIndex({ roomId: 1 });
  await db.collection('events').createIndex({ roomId: 1 });
  log({ msg: 'Mongo connected', url: MONGO_URL, db: DB_NAME });
}

// Express + HTTP + WS server
const app = express();
app.use(express.json());
app.use(cookieParser());

// CORS simple check for ws origins and http endpoints
app.use((req, res, next) => {
  const origin = req.get('origin') || req.get('referer') || '*';
  if (PUBLIC_ORIGINS.includes('*') || PUBLIC_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Health & metrics
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), rooms: rooms.size });
});

// Provide ICE config to clients
app.get('/ice', (req, res) => {
  res.json({ iceServers: buildIceServers() });
});

// Issue short-lived room token (POST {roomId, name})
app.post('/token', async (req, res) => {
  const { roomId, name } = req.body || {};
  if (!roomId || !name) return res.status(400).json({ error: 'roomId and name required' });
  const token = jwt.sign({ roomId, name, jti: uuidv4() }, JWT_SECRET, { expiresIn: TOKEN_TTL_SEC });
  // Persist room minimal metadata
  try {
    await db.collection('rooms').updateOne({ roomId }, { $setOnInsert: { roomId, createdAt: new Date() } }, { upsert: true });
  } catch (e) {
    log({ level: 'warn', msg: 'db room upsert failed', err: e.message });
  }
  res.json({ token, ttl: TOKEN_TTL_SEC });
});

// Serve single-page client
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(CLIENT_HTML);
});

// Start HTTP server then WS
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/signal' });

// WebSocket message types:
// { type: 'auth', token }
// { type: 'create', roomId } optional - server ensures room exists
// { type: 'join', roomId, peerId, name }
// { type: 'leave', roomId, peerId }
// { type: 'offer', roomId, from, to, sdp }
// { type: 'answer', roomId, from, to, sdp }
// { type: 'candidate', roomId, from, to, candidate }
// { type: 'broadcast', roomId, from, data } - server will forward to all in room
// Server sends presence updates: { type: 'presence', roomId, peers: [{peerId,name}] }
// Also: { type: 'error', msg }, { type: 'ok', msg }

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  ws._meta = { authenticated: false, name: null, roomId: null, peerId: null };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { send(ws, { type: 'error', msg: 'invalid json' }); return; }
    // handle types
    if (msg.type === 'auth') {
      if (!msg.token) return send(ws, { type: 'error', msg: 'no token' });
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        ws._meta.authenticated = true;
        ws._meta.name = payload.name;
        ws._meta.roomId = payload.roomId;
        // generate peerId if client didn't provide before join
        ws._meta.peerId = msg.peerId || uuidv4();
        send(ws, { type: 'ok', msg: 'authenticated', peerId: ws._meta.peerId });
      } catch (e) {
        send(ws, { type: 'error', msg: 'auth failed' });
      }
      return;
    }

    // enforce auth for everything else
    if (!ws._meta.authenticated && msg.type !== 'create' && msg.type !== 'token') {
      return send(ws, { type: 'error', msg: 'not authenticated' });
    }

    const roomId = msg.roomId || ws._meta.roomId;
    switch (msg.type) {
      case 'create':
        {
          const rid = msg.roomId || uuidv4();
          try {
            await db.collection('rooms').updateOne({ roomId: rid }, { $setOnInsert: { roomId: rid, createdAt: new Date() } }, { upsert: true });
            send(ws, { type: 'ok', msg: 'room_created', roomId: rid });
            log({ event: 'room_created', roomId: rid });
          } catch (e) {
            send(ws, { type: 'error', msg: 'create_failed' });
          }
        }
        break;

      case 'join':
        {
          const peerId = msg.peerId || ws._meta.peerId || uuidv4();
          ws._meta.peerId = peerId;
          ws._meta.name = msg.name || ws._meta.name || 'guest';
          ws._meta.roomId = roomId;

          if (!rooms.has(roomId)) rooms.set(roomId, { participants: new Map() });
          const room = rooms.get(roomId);
          room.participants.set(peerId, { ws, name: ws._meta.name, joinedAt: Date.now() });

          // persist participant
          try {
            await db.collection('participants').insertOne({
              roomId, peerId, name: ws._meta.name, joinedAt: new Date(), status: 'joined'
            });
            await db.collection('events').insertOne({ roomId, type: 'join', peerId, name: ws._meta.name, at: new Date() });
          } catch (e) { log({ level: 'warn', msg: 'db insert participant failed', err: e.message }); }

          // inform new peer about existing peers
          const peerList = [];
          for (let [pid, p] of room.participants.entries()) {
            if (pid !== peerId) peerList.push({ peerId: pid, name: p.name });
          }
          send(ws, { type: 'ok', msg: 'joined', roomId, peers: peerList, yourId: peerId });

          // broadcast presence
          broadcastPresence(roomId);
          log({ event: 'peer_join', roomId, peerId, name: ws._meta.name });
        }
        break;

      case 'leave':
        {
          const peerId = msg.peerId || ws._meta.peerId;
          await handleLeave(roomId, peerId, 'left');
        }
        break;

      case 'offer':
      case 'answer':
      case 'candidate':
        {
          const to = msg.to;
          if (!to) return send(ws, { type: 'error', msg: 'missing to' });
          const room = rooms.get(roomId);
          if (!room) return send(ws, { type: 'error', msg: 'room not found' });
          const target = room.participants.get(to);
          if (!target) return send(ws, { type: 'error', msg: 'target not found' });
          // forward
          send(target.ws, Object.assign({}, msg, { from: msg.from || ws._meta.peerId }));
        }
        break;

      case 'broadcast':
        {
          const payload = msg.data;
          const room = rooms.get(roomId);
          if (!room) return send(ws, { type: 'error', msg: 'room not found' });
          for (let [pid, p] of room.participants.entries()) {
            if (pid === ws._meta.peerId) continue;
            send(p.ws, { type: 'broadcast', from: ws._meta.peerId, data: payload });
          }
        }
        break;

      default:
        send(ws, { type: 'error', msg: 'unknown_type' });
    }
  });

  ws.on('close', async () => {
    const { roomId, peerId } = ws._meta;
    if (roomId && peerId) {
      await handleLeave(roomId, peerId, 'disconnected');
    }
  });

  ws.on('error', (e) => log({ level: 'warn', msg: 'ws error', err: e.message }));
});

async function handleLeave(roomId, peerId, reason = 'left') {
  if (!roomId || !peerId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const entry = room.participants.get(peerId);
  if (entry) {
    try {
      await db.collection('participants').updateOne({ roomId, peerId }, { $set: { leftAt: new Date(), status: reason } });
      await db.collection('events').insertOne({ roomId, type: 'leave', peerId, reason, at: new Date() });
    } catch (e) { log({ level: 'warn', msg: 'db leave update failed', err: e.message }); }
    room.participants.delete(peerId);
    log({ event: 'peer_left', roomId, peerId, reason });
    // notify remaining
    for (let [pid, p] of room.participants.entries()) {
      send(p.ws, { type: 'peer_left', peerId });
    }
    broadcastPresence(roomId);
    if (room.participants.size === 0) {
      rooms.delete(roomId);
      // optional: cleanup or mark room ended
      await db.collection('rooms').updateOne({ roomId }, { $set: { endedAt: new Date() } });
      log({ event: 'room_empty', roomId });
    }
  }
}

function broadcastPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peers = [];
  for (let [pid, p] of room.participants.entries()) peers.push({ peerId: pid, name: p.name });
  for (let [pid, p] of room.participants.entries()) {
    send(p.ws, { type: 'presence', roomId, peers });
  }
}

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Start server after mongo init
(async () => {
  try {
    await initMongo();
  } catch (e) {
    log({ level: 'error', msg: 'mongo init failed', err: e.message });
    process.exit(1);
  }
  server.listen(PORT, () => {
    log({ msg: 'Server started', port: PORT });
    log({ sample_env: {
      MONGO_URL: MONGO_URL,
      JWT_SECRET: JWT_SECRET && 'hidden',
      STUN_SERVERS: STUN_SERVERS,
      TURN_SERVERS: TURN_SERVERS,
      token_endpoint: http://localhost:${PORT}/token,
      ice_endpoint: http://localhost:${PORT}/ice,
      signal_ws: ws://localhost:${PORT}/signal
    }});
  });
})();

// Graceful shutdown
process.on('SIGINT', async () => {
  log({ msg: 'Shutting down' });
  try { await mongoClient.close(); } catch (e) {}
  server.close(() => process.exit(0));
});

/* ------------------------------------------------------------------
   CLIENT: A compact SPA served as root. This is intentionally
   vanilla JS (no build) for easy single-file copy/paste.
   It implements:
   - Token fetch from /token
   - WS signaling to /signal
   - For each remote peer: create RTCPeerConnection, exchange SDP/candidates
   - Local device selection, screen share, mute/unmute, leave
   ------------------------------------------------------------------ */
const CLIENT_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Nimbus WebRTC Mesh Prototype</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:0;background:#0f1724;color:#e6eef8}
    header{padding:12px 18px;background:#071029;display:flex;gap:12px;align-items:center}
    .container{padding:12px;max-width:1200px;margin:0 auto}
    .controls{display:flex;gap:8px;flex-wrap:wrap}
    button,input,select{padding:8px;border-radius:8px;border:1px solid #123; background:#0b1220;color:#dbeafe}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin-top:12px}
    .tile{background:#071027;border-radius:8px;padding:6px;position:relative}
    video{width:100%;height:160px;background:#000;border-radius:6px;object-fit:cover}
    .meta{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:13px}
    .active{outline:3px solid #06f}
    .small{font-size:12px;color:#9fb0d6}
    .status{position:absolute;right:8px;top:8px;background:#021124;padding:4px 6px;border-radius:6px;font-size:12px}
  </style>
</head>
<body>
  <header>
    <div style="font-weight:700">Nimbus — WebRTC Mesh Prototype</div>
    <div style="margin-left:auto" id="status">offline</div>
  </header>

  <div class="container">
    <div class="controls">
      <input id="roomId" placeholder="room id (leave empty to create)" />
      <input id="name" placeholder="your name" />
      <button id="getToken">Get Token & Connect</button>
      <button id="leaveBtn" disabled>Leave</button>

      <select id="cameraSelect"></select>
      <select id="micSelect"></select>
      <select id="audioOutput"></select>

      <button id="toggleMic" disabled>Mute</button>
      <button id="toggleCam" disabled>Disable Cam</button>
      <button id="shareScreen" disabled>Share Screen</button>
    </div>

    <div class="small" id="hint">Open multiple tabs to test multi-party mesh. Token TTL is short for demo.</div>

    <div class="grid" id="grid"></div>
  </div>

<script>
(async function(){
  const api = { token: '/token', ice: '/ice', signal: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/signal' };
  const sdButton = document.getElementById('getToken');
  const leaveBtn = document.getElementById('leaveBtn');
  const roomIdInput = document.getElementById('roomId');
  const nameInput = document.getElementById('name');
  const grid = document.getElementById('grid');
  const statusEl = document.getElementById('status');
  const camSel = document.getElementById('cameraSelect');
  const micSel = document.getElementById('micSelect');
  const outSel = document.getElementById('audioOutput');
  const toggleMicBtn = document.getElementById('toggleMic');
  const toggleCamBtn = document.getElementById('toggleCam');
  const shareScreenBtn = document.getElementById('shareScreen');

  let token = null;
  let localStream = null;
  let pcMap = new Map(); // peerId -> RTCPeerConnection
  let remoteVideoEls = new Map();
  let ws = null;
  let myPeerId = null;
  let myRoomId = null;
  let myName = null;
  let iceConfig = null;

  function setStatus(s) { statusEl.innerText = s; }
  setStatus('ready');

  // Get available devices
  async function enumerate() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      camSel.innerHTML = ''; micSel.innerHTML = ''; outSel.innerHTML = '';
      devices.forEach(d => {
        const o = document.createElement('option'); o.value = d.deviceId; o.text = d.label || d.kind + ' ' + d.deviceId;
        if (d.kind === 'videoinput') camSel.appendChild(o);
        if (d.kind === 'audioinput') micSel.appendChild(o);
        if (d.kind === 'audiooutput') outSel.appendChild(o);
      });
    } catch (e) { console.warn('enumerate failed', e); }
  }

  await enumerate();
  navigator.mediaDevices.addEventListener('devicechange', enumerate);

  async function ensureLocalStream() {
    if (localStream) return localStream;
    const camId = camSel.value || undefined;
    const micId = micSel.value || undefined;
    try {
      const constraints = { video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 640 }, height: { ideal: 360 } }, audio: { deviceId: micId ? { exact: micId } : undefined } };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      addOrUpdateLocalTile(localStream);
      toggleMicBtn.disabled = false; toggleCamBtn.disabled = false; shareScreenBtn.disabled = false;
      return localStream;
    } catch (e) {
      alert('getUserMedia failed: ' + e.message);
      throw e;
    }
  }

  function addOrUpdateLocalTile(stream) {
    let el = document.getElementById('tile-local');
    if (!el) {
      el = document.createElement('div'); el.className = 'tile'; el.id = 'tile-local';
      el.innerHTML = '<div class="status">You</div><video autoplay playsinline muted id="localVideo"></video><div class="meta"><div id="localName" class="small"></div></div>';
      grid.prepend(el);
    }
    const v = document.getElementById('localVideo'); v.srcObject = stream;
    document.getElementById('localName').innerText = (myName || 'You') + (myRoomId ? ' • ' + myRoomId : '');
  }

  function createRemoteTile(peerId, name) {
    const id = 'tile-' + peerId;
    if (document.getElementById(id)) return;
    const el = document.createElement('div'); el.className = 'tile'; el.id = id;
    el.innerHTML = \`
      <div class="status" id="status-\${peerId}">\${name || peerId}</div>
      <video autoplay playsinline id="video-\${peerId}"></video>
      <div class="meta">
        <div class="small" id="meta-\${peerId}">\${name || peerId}</div>
      </div>\`;
    grid.appendChild(el);
    const vid = document.getElementById('video-' + peerId);
    remoteVideoEls.set(peerId, vid);
  }

  function removeRemoteTile(peerId) {
    const el = document.getElementById('tile-' + peerId);
    if (el) el.remove();
    remoteVideoEls.delete(peerId);
  }

  function connectWebSocket(token) {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(api.signal);
      let backoff = 500;
      ws.onopen = () => {
        setStatus('ws open');
        // authenticate
        ws.send(JSON.stringify({ type: 'auth', token, peerId: myPeerId }));
        resolve();
      };
      ws.onerror = (e) => { console.warn('ws err', e); setStatus('ws error'); };
      ws.onclose = () => {
        setStatus('ws closed, reconnecting...');
        // try reconnect with backoff
        reconnectWithBackoff();
      };
      ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ok' && msg.peerId) myPeerId = msg.peerId;
        if (msg.type === 'joined') {
          // peers is list of existing peers to connect to (they are already in room)
          const peers = msg.peers || [];
          for (let p of peers) {
            // create outbound offer to each existing peer
            await ensureLocalStream();
            await createPeerConnectionAndOffer(p.peerId, p.name);
          }
        } else if (msg.type === 'presence') {
          // update tiles
          const peers = msg.peers || [];
          // add missing
          peers.forEach(p => { if (p.peerId !== myPeerId) createRemoteTile(p.peerId, p.name); });
          // remove absent
          const present = new Set(peers.map(p => p.peerId));
          Array.from(remoteVideoEls.keys()).forEach(pid => { if (!present.has(pid)) removeRemoteTile(pid); });
        } else if (msg.type === 'offer') {
          // incoming offer -> create pc, setRemoteDesc, create answer
          await ensureLocalStream();
          await handleIncomingOffer(msg);
        } else if (msg.type === 'answer') {
          const pc = pcMap.get(msg.from);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          }
        } else if (msg.type === 'candidate') {
          const pc = pcMap.get(msg.from);
          if (pc && msg.candidate) {
            try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn('addIceCandidate failed', e); }
          }
        } else if (msg.type === 'peer_left') {
          const pid = msg.peerId;
          const pc = pcMap.get(pid);
          if (pc) pc.close();
          pcMap.delete(pid);
          removeRemoteTile(pid);
        } else if (msg.type === 'error') {
          console.warn('signal err', msg.msg);
        }
      };

      async function reconnectWithBackoff() {
        let attempt = 0;
        while (ws && ws.readyState !== WebSocket.OPEN) {
          attempt++;
          const delay = Math.min(30000, 500 * 2 ** attempt);
          setStatus('reconnect in ' + Math.floor(delay/1000) + 's');
          await new Promise(r => setTimeout(r, delay));
          try {
            connectWebSocket(token);
            break;
          } catch (e) { console.warn('reconnect failed', e); }
        }
      }
    });
  }

  async function createPeerConnectionAndOffer(remotePeerId, remoteName) {
    if (pcMap.has(remotePeerId)) return;
    const pc = new RTCPeerConnection(iceConfig || (await fetch(api.ice).then(r=>r.json()).then(j=>{ iceConfig=j; return j; })));
    pcMap.set(remotePeerId, pc);
    createRemoteTile(remotePeerId, remoteName);

    // add local tracks
    if (localStream) {
      for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    }

    pc.ontrack = (ev) => {
      const vid = remoteVideoEls.get(remotePeerId);
      if (vid) { vid.srcObject = ev.streams[0]; }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        ws.send(JSON.stringify({ type: 'candidate', roomId: myRoomId, to: remotePeerId, candidate: ev.candidate, from: myPeerId }));
      }
    };

    // active speaker / stats basic: use onconnectionstatechange
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      const status = document.getElementById('status-' + remotePeerId);
      if (status) status.innerText = (remoteName || remotePeerId) + ' • ' + s;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        pc.close();
        pcMap.delete(remotePeerId);
        removeRemoteTile(remotePeerId);
      }
    };

    // create offer
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', roomId: myRoomId, to: remotePeerId, from: myPeerId, sdp: pc.localDescription }));
    return pc;
  }

  async function handleIncomingOffer(msg) {
    const from = msg.from;
    const pc = new RTCPeerConnection(iceConfig || (await fetch(api.ice).then(r=>r.json()).then(j=>{ iceConfig=j; return j; })));
    pcMap.set(from, pc);
    createRemoteTile(from, msg.name);

    // add local tracks
    if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream);

    pc.ontrack = (ev) => {
      const vid = remoteVideoEls.get(from);
      if (vid) vid.srcObject = ev.streams[0];
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) ws.send(JSON.stringify({ type: 'candidate', roomId: myRoomId, to: from, from: myPeerId, candidate: ev.candidate }));
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      const status = document.getElementById('status-' + from);
      if (status) status.innerText = (msg.name || from) + ' • ' + s;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        pc.close(); pcMap.delete(from); removeRemoteTile(from);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'answer', roomId: myRoomId, to: from, from: myPeerId, sdp: pc.localDescription }));
  }

  // UI actions
  sdButton.onclick = async () => {
    try {
      myName = nameInput.value || 'guest-' + Math.floor(Math.random()*1000);
      myRoomId = roomIdInput.value.trim() || undefined;
      // request token
      const tokenRes = await fetch(api.token, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ roomId: myRoomId, name: myName }) });
      const tokenJson = await tokenRes.json();
      if (!tokenJson.token) return alert('token error: ' + JSON.stringify(tokenJson));
      token = tokenJson.token;
      // connect ws
      await connectWebSocket(token);
      // ensure local stream
      await ensureLocalStream();
      // send join
      ws.send(JSON.stringify({ type: 'join', roomId: myRoomId, peerId: myPeerId, name: myName }));
      setStatus('in room ' + (myRoomId || '(new)'));
      sdButton.disabled = true; leaveBtn.disabled = false;
    } catch (e) {
      alert('connect failed: ' + e.message);
      console.error(e);
    }
  };

  leaveBtn.onclick = async () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave', roomId: myRoomId, peerId: myPeerId }));
    // close peers
    for (const [pid, pc] of pcMap.entries()) { try { pc.close(); } catch (e) {} }
    pcMap.clear();
    // stop local tracks
    if (localStream) for (const t of localStream.getTracks()) t.stop();
    localStream = null;
    sdButton.disabled = false; leaveBtn.disabled = true;
    setStatus('left');
    // clear tiles except local
    document.querySelectorAll('[id^="tile-"]').forEach(el => { if (el.id !== 'tile-local') el.remove(); });
  };

  toggleMicBtn.onclick = () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
    toggleMicBtn.innerText = audioTrack.enabled ? 'Mute' : 'Unmute';
  };

  toggleCamBtn.onclick = () => {
    if (!localStream) return;
    const v = localStream.getVideoTracks()[0];
    if (!v) return;
    v.enabled = !v.enabled;
    toggleCamBtn.innerText = v.enabled ? 'Disable Cam' : 'Enable Cam';
  };

  shareScreenBtn.onclick = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      // replace video track on all pcs
      const screenTrack = screenStream.getVideoTracks()[0];
      for (const [pid, pc] of pcMap.entries()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      }
      // show locally
      const localV = document.getElementById('localVideo');
      localV.srcObject = screenStream;
      screenTrack.onended = async () => {
        // revert to camera
        const camTrack = (await ensureLocalStream()).getVideoTracks()[0];
        for (const [pid, pc] of pcMap.entries()) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(camTrack);
        }
        localV.srcObject = localStream;
      };
    } catch (e) { console.warn('screen share failed', e); }
  };

  // device change handlers
  camSel.onchange = async () => { if (localStream) { for (const t of localStream.getTracks()) t.stop(); localStream = null; await ensureLocalStream(); } };
  micSel.onchange = camSel.onchange;

  // handle unload to leave gracefully
  window.addEventListener('beforeunload', () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave', roomId: myRoomId, peerId: myPeerId }));
  });

  // keepalive ping for ws
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 20000);

})();
</script>
</body>
</html>
`;

// End of file