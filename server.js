const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== FIREBASE ====================
let db = null;

try {
  let serviceAccount = null;

  if (fs.existsSync('/etc/secrets/serviceAccountKey.json')) {
    serviceAccount = JSON.parse(fs.readFileSync('/etc/secrets/serviceAccountKey.json', 'utf8'));
    console.log('✅ Ключ из Secret File');
  } else if (process.env.FIREBASE_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    console.log('✅ Ключ из FIREBASE_KEY');
  } else if (fs.existsSync('./serviceAccountKey.json')) {
    serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));
    console.log('✅ Ключ из корня');
  }

  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('🔥 FIREBASE OK');
  } else {
    console.log('❌ Ключ не найден');
  }
} catch(e) {
  console.error('❌ ОШИБКА:', e.message);
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', firebase: !!db });
});

app.get('/api/chat/:clanId/history', async (req, res) => {
  if (!db) return res.json({ general: [], officer: [] });
  try {
    const { clanId } = req.params;
    const g = []; (await db.collection('clans').doc(clanId).collection('messages').where('isOfficer', '==', false).orderBy('id', 'desc').limit(100).get()).forEach(d => g.push(d.data()));
    const o = []; (await db.collection('clans').doc(clanId).collection('messages').where('isOfficer', '==', true).orderBy('id', 'desc').limit(100).get()).forEach(d => o.push(d.data()));
    res.json({ general: g.reverse(), officer: o.reverse() });
  } catch(e) { res.json({ general: [], officer: [] }); }
});

app.post('/api/chat/:clanId/message', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    req.body.message.isOfficer = !!req.body.isOfficer;
    await db.collection('clans').doc(req.params.clanId).collection('messages').doc(String(req.body.message.id)).set(req.body.message);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chat/:clanId/log', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const l = []; (await db.collection('clans').doc(req.params.clanId).collection('logs').orderBy('timestamp', 'desc').limit(100).get()).forEach(d => l.push(d.data()));
    res.json(l);
  } catch(e) { res.json([]); }
});

app.post('/api/chat/:clanId/log', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('logs').add({ ...req.body.entry, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    broadcast(req.params.clanId, { type: 'log_update', entry: req.body.entry });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chat/:clanId/board', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const b = []; (await db.collection('clans').doc(req.params.clanId).collection('board').orderBy('id', 'desc').limit(50).get()).forEach(d => b.push(d.data()));
    res.json(b);
  } catch(e) { res.json([]); }
});

app.post('/api/chat/:clanId/board', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('board').doc(String(req.body.item.id)).set(req.body.item);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/avatars/list', async (req, res) => {
  if (!db) return res.json({});
  try {
    const a = {}; (await db.collection('avatars').get()).forEach(d => a[d.id] = d.data().url);
    res.json(a);
  } catch(e) { res.json({}); }
});

app.post('/api/avatar/:accountId', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('avatars').doc(req.params.accountId).set({ url: req.body.avatarUrl, ts: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// WebSocket
const wss = new WebSocket.Server({ server });
const rooms = new Map();

function broadcast(clanId, data) {
  const room = rooms.get(String(clanId));
  if (room) { const m = JSON.stringify(data); room.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(m); }); }
}

wss.on('connection', (ws, req) => {
  const clanId = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').pop();
  if (!rooms.has(clanId)) rooms.set(clanId, new Set());
  rooms.get(clanId).add(ws);
  ws.on('message', data => {
    try { const msg = JSON.parse(data); rooms.get(clanId)?.forEach(c => { if (c !== ws && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg)); }); } catch(e) {}
  });
  ws.on('close', () => { rooms.get(clanId)?.delete(ws); if (rooms.get(clanId)?.size === 0) rooms.delete(clanId); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ PORT:${PORT} FIREBASE:${!!db}`));
