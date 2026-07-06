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
  }

  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('🔥 FIREBASE OK - Project:', serviceAccount.project_id);
    
    // Тестовая запись
    db.collection('test').doc('connection').set({ time: Date.now() })
      .then(() => console.log('✅ Тестовая запись в Firebase успешна'))
      .catch(e => console.error('❌ Ошибка тестовой записи:', e.message));
  } else {
    console.log('❌ Ключ не найден');
  }
} catch(e) {
  console.error('❌ ОШИБКА Firebase:', e.message);
}

// ==================== API ====================
app.get('/', (req, res) => {
  res.json({ status: 'ok', firebase: !!db });
});

// История чата
app.get('/api/chat/:clanId/history', async (req, res) => {
  if (!db) {
    console.log('❌ history: нет БД');
    return res.json({ general: [], officer: [] });
  }
  
  try {
    const { clanId } = req.params;
    console.log(`📖 Загрузка истории для клана ${clanId}`);
    
    const generalSnap = await db
      .collection('clans').doc(clanId)
      .collection('messages')
      .where('isOfficer', '==', false)
      .orderBy('id', 'desc')
      .limit(100)
      .get();
    
    const general = [];
    generalSnap.forEach(d => general.push(d.data()));
    console.log(`📖 Общий чат: ${general.length} сообщений`);
    
    const officerSnap = await db
      .collection('clans').doc(clanId)
      .collection('messages')
      .where('isOfficer', '==', true)
      .orderBy('id', 'desc')
      .limit(100)
      .get();
    
    const officer = [];
    officerSnap.forEach(d => officer.push(d.data()));
    console.log(`📖 Офицерский чат: ${officer.length} сообщений`);
    
    res.json({ general: general.reverse(), officer: officer.reverse() });
  } catch(e) {
    console.error('❌ Ошибка истории:', e.message);
    res.json({ general: [], officer: [] });
  }
});

// Сохранение сообщения
app.post('/api/chat/:clanId/message', async (req, res) => {
  if (!db) {
    console.log('❌ message: нет БД');
    return res.json({ success: false, error: 'no database' });
  }
  
  try {
    const { clanId } = req.params;
    const { message, isOfficer } = req.body;
    
    if (!message || !message.id) {
      console.log('❌ Нет сообщения или id');
      return res.status(400).json({ error: 'Нет сообщения' });
    }
    
    message.isOfficer = !!isOfficer;
    
    console.log(`💾 Сохранение: clan=${clanId} id=${message.id} officer=${!!isOfficer}`);
    
    await db
      .collection('clans').doc(clanId)
      .collection('messages').doc(String(message.id))
      .set(message);
    
    console.log(`✅ Сообщение ${message.id} сохранено`);
    res.json({ success: true });
  } catch(e) {
    console.error('❌ Ошибка сохранения:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Лог
app.get('/api/chat/:clanId/log', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const snap = await db.collection('clans').doc(req.params.clanId).collection('logs').orderBy('timestamp', 'desc').limit(100).get();
    const log = []; snap.forEach(d => log.push(d.data()));
    res.json(log);
  } catch(e) { res.json([]); }
});

app.post('/api/chat/:clanId/log', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('logs').add({
      ...req.body.entry,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    broadcast(req.params.clanId, { type: 'log_update', entry: req.body.entry });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Доска
app.get('/api/chat/:clanId/board', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const snap = await db.collection('clans').doc(req.params.clanId).collection('board').orderBy('id', 'desc').limit(50).get();
    const board = []; snap.forEach(d => board.push(d.data()));
    res.json(board);
  } catch(e) { res.json([]); }
});

app.post('/api/chat/:clanId/board', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('board').doc(String(req.body.item.id)).set(req.body.item);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/chat/:clanId/board/:itemId', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('board').doc(req.params.itemId).delete();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Аватары
app.get('/api/avatars/list', async (req, res) => {
  if (!db) return res.json({});
  try {
    const snap = await db.collection('avatars').get();
    const avatars = {}; snap.forEach(d => avatars[d.id] = d.data().url);
    res.json(avatars);
  } catch(e) { res.json({}); }
});

app.post('/api/avatar/:accountId', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('avatars').doc(req.params.accountId).set({
      url: req.body.avatarUrl,
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Загрузка фото
const multer = require('multer');
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/chat/photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  try {
    const base64 = req.file.buffer.toString('base64');
    res.json({ success: true, url: `data:${req.file.mimetype};base64,${base64}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== WEBSOCKET ====================
const wss = new WebSocket.Server({ server });
const rooms = new Map();

function broadcast(clanId, data) {
  const room = rooms.get(String(clanId));
  if (room) {
    const m = JSON.stringify(data);
    room.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(m); });
  }
}

wss.on('connection', (ws, req) => {
  const clanId = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').pop();
  if (!rooms.has(clanId)) rooms.set(clanId, new Set());
  rooms.get(clanId).add(ws);
  console.log(`🔌 WS +${clanId}: ${rooms.get(clanId).size}`);
  
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      rooms.get(clanId)?.forEach(c => {
        if (c !== ws && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
      });
    } catch(e) {}
  });
  
  ws.on('close', () => {
    rooms.get(clanId)?.delete(ws);
    if (rooms.get(clanId)?.size === 0) rooms.delete(clanId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ PORT:${PORT} DB:${!!db}`));
