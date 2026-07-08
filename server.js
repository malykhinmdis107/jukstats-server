const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const admin = require('firebase-admin');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
  }
} catch(e) {
  console.error('❌ Ошибка Firebase:', e.message);
}

// ==================== API ====================
app.get('/', (req, res) => {
  res.json({ status: 'ok', firebase: !!db });
});

// ==================== ИСТОРИЯ ЧАТА ====================
app.get('/api/chat/:clanId/history', async (req, res) => {
  if (!db) return res.json({ general: [], officer: [] });
  
  try {
    const { clanId } = req.params;
    
    const snapshot = await db
      .collection('clans').doc(clanId)
      .collection('messages')
      .orderBy('id', 'desc')
      .limit(200)
      .get();
    
    const allMessages = [];
    snapshot.forEach(d => allMessages.push(d.data()));
    
    const general = allMessages.filter(m => !m.isOfficer).slice(0, 100);
    const officer = allMessages.filter(m => m.isOfficer).slice(0, 100);
    
    res.json({ general: general.reverse(), officer: officer.reverse() });
  } catch(e) {
    console.error('❌ Ошибка истории:', e.message);
    res.json({ general: [], officer: [] });
  }
});

// ==================== СОХРАНЕНИЕ СООБЩЕНИЯ ====================
app.post('/api/chat/:clanId/message', async (req, res) => {
  if (!db) return res.json({ success: false });
  
  try {
    const { clanId } = req.params;
    const { message, isOfficer } = req.body;
    
    if (!message || !message.id) return res.status(400).json({ error: 'Нет сообщения' });
    
    message.isOfficer = !!isOfficer;
    
    await db
      .collection('clans').doc(clanId)
      .collection('messages').doc(String(message.id))
      .set(message);
    
    res.json({ success: true });
  } catch(e) {
    console.error('❌ Ошибка сохранения:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== УДАЛЕНИЕ СООБЩЕНИЯ ====================
app.delete('/api/chat/:clanId/message/:messageId', async (req, res) => {
  if (!db) return res.json({ success: false });
  
  try {
    const { clanId, messageId } = req.params;
    
    await db
      .collection('clans').doc(clanId)
      .collection('messages').doc(messageId)
      .delete();
    
    console.log(`🗑️ Сообщение ${messageId} удалено`);
    res.json({ success: true });
  } catch(e) {
    console.error('❌ Ошибка удаления:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== ЧАТ-ЛОГ ====================
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

// ==================== ДОСКА ОБЪЯВЛЕНИЙ ====================
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

// ==================== АВАТАРЫ ====================
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

// ==================== ПРОФИЛИ (ОБВОДКИ И ЦВЕТА НИКОВ) ====================
app.get('/api/profiles/list', async (req, res) => {
  if (!db) return res.json({});
  try {
    const snap = await db.collection('profiles').get();
    const profiles = {};
    snap.forEach(d => profiles[d.id] = d.data());
    res.json(profiles);
  } catch(e) { res.json({}); }
});

app.post('/api/profile/:accountId', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('profiles').doc(req.params.accountId).set({
      border: req.body.border || '',
      nickname: req.body.nickname || '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== АВАТАРЫ И БАННЕРЫ КЛАНОВ ====================

// Получить аватар клана
app.get('/api/clan/:clanId/avatar', async (req, res) => {
  if (!db) return res.json({ url: null });
  try {
    const doc = await db.collection('clans').doc(req.params.clanId).collection('settings').doc('avatar').get();
    res.json(doc.exists ? doc.data() : { url: null });
  } catch(e) { res.json({ url: null }); }
});

// Сохранить аватар клана
app.post('/api/clan/:clanId/avatar', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('settings').doc('avatar').set({ url: req.body.url });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Получить баннер клана
app.get('/api/clan/:clanId/banner', async (req, res) => {
  if (!db) return res.json({ url: null });
  try {
    const doc = await db.collection('clans').doc(req.params.clanId).collection('settings').doc('banner').get();
    res.json(doc.exists ? doc.data() : { url: null });
  } catch(e) { res.json({ url: null }); }
});

// Сохранить баннер клана
app.post('/api/clan/:clanId/banner', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('settings').doc('banner').set({ url: req.body.url });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Получить соцсети клана
app.get('/api/clan/:clanId/socials', async (req, res) => {
  if (!db) return res.json({});
  try {
    const doc = await db.collection('clans').doc(req.params.clanId).collection('settings').doc('socials').get();
    res.json(doc.exists ? doc.data() : {});
  } catch(e) { res.json({}); }
});

// Сохранить соцсети клана
app.post('/api/clan/:clanId/socials', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('settings').doc('socials').set(req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== МОДЕРАЦИЯ (МУТЫ/БАНЫ) ====================
app.get('/api/chat/:clanId/moderation', async (req, res) => {
  if (!db) return res.json({ muted: {}, banned: {} });
  try {
    const doc = await db.collection('clans').doc(req.params.clanId).collection('moderation').doc('state').get();
    if (doc.exists) {
      const data = doc.data();
      res.json({ muted: data.muted || {}, banned: data.banned || {} });
    } else {
      res.json({ muted: {}, banned: {} });
    }
  } catch(e) { res.json({ muted: {}, banned: {} }); }
});

app.post('/api/chat/:clanId/moderation', async (req, res) => {
  if (!db) return res.json({ success: false });
  try {
    await db.collection('clans').doc(req.params.clanId).collection('moderation').doc('state').set(req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ==================== СТАТИСТИКА ПО ТАНКАМ (ОТМЕТКИ) ====================

// Получение статистики по конкретному танку игрока
app.get('/api/player/:accountId/tank-stats/:tankId', async (req, res) => {
  if (!db) return res.json({ error: 'no database' });
  
  try {
    const { accountId, tankId } = req.params;
    
    // Ищем документ в коллекции tankStats/{accountId}/tanks/{tankId}
    const doc = await db
      .collection('tankStats')
      .doc(accountId)
      .collection('tanks')
      .doc(tankId)
      .get();
    
    if (doc.exists) {
      res.json(doc.data());
    } else {
      // Если данных нет, возвращаем пустую структуру
      res.json({ 
        last_total_damage: 0, 
        battles_count: 0, 
        battles: [] 
      });
    }
  } catch(e) {
    console.error('❌ Ошибка загрузки статистики танка:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Обновление/Сохранение статистики по танку
app.post('/api/player/:accountId/tank-stats/:tankId', async (req, res) => {
  if (!db) return res.json({ success: false, error: 'no database' });
  
  try {
    const { accountId, tankId } = req.params;
    const { last_total_damage, battles_count, new_battles } = req.body;
    
    if (last_total_damage === undefined || !new_battles) {
      return res.status(400).json({ error: 'Недостаточно данных' });
    }

    const tankRef = db.collection('tankStats').doc(accountId).collection('tanks').doc(tankId);
    
    // Используем транзакцию или просто set с merge, чтобы не потерять старые бои, если они есть
    // Но лучше делать update, добавляя новые бои в массив
    
    await tankRef.set({
      last_total_damage: last_total_damage,
      battles_count: battles_count,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Если есть новые бои, добавляем их в подколлекцию или в массив внутри документа
    // Для простоты и скорости чтения будем хранить последние 100 боёв прямо в документе в поле 'battles'
    if (new_battles && new_battles.length > 0) {
      // Сначала получаем текущие бои, чтобы добавить к ним новые
      const currentDoc = await tankRef.get();
      let currentBattles = [];
      
      if (currentDoc.exists && currentDoc.data().battles) {
        currentBattles = currentDoc.data().battles;
      }
      
      // Добавляем новые бои в конец
      const updatedBattles = [...currentBattles, ...new_battles];
      
      // Оставляем только последние 100
      const finalBattles = updatedBattles.slice(-100);
      
      await tankRef.update({
        battles: finalBattles
      });
    }
    
    console.log(`💾 Статистика танка ${tankId} для ${accountId} обновлена`);
    res.json({ success: true });
    
  } catch(e) {
    console.error('❌ Ошибка сохранения статистики танка:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== ПОРОГИ ОТМЕТОК (АДМИНКА) ====================

// Получить пороги для конкретного танка
app.get('/api/thresholds/:tankId', async (req, res) => {
  if (!db) return res.json({ admin: {}, user: {} }); // Если БД не подключена
  
  try {
    const { tankId } = req.params;
    const doc = await db.collection('tankThresholds').doc(tankId).get();
    
    if (doc.exists) {
      res.json(doc.data());
    } else {
      res.json({ admin: { mark1: null, mark2: null, mark3: null }, user: {} });
    }
  } catch(e) {
    console.error('❌ Ошибка загрузки порогов:', e.message);
    res.json({ admin: {}, user: {} });
  }
});

// Сохранить админские пороги (только для админов!)
app.post('/api/thresholds/:tankId', async (req, res) => {
  if (!db) return res.json({ success: false });
  
  // ТУТ НУЖНА ПРОВЕРКА НА АДМИНА! 
  // Например, проверять токен или ID аккаунта из заголовков
  // const isAdmin = checkAdmin(req); 
  // if (!isAdmin) return res.status(403).json({ error: 'Access denied' });

  try {
    const { tankId } = req.params;
    const { mark1, mark2, mark3 } = req.body;
    
    await db.collection('tankThresholds').doc(tankId).set({
      admin: {
        mark1: mark1 !== null ? Number(mark1) : null,
        mark2: mark2 !== null ? Number(mark2) : null,
        mark3: mark3 !== null ? Number(mark3) : null
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    console.log(`🛡️ Админские пороги для танка ${tankId} обновлены`);
    res.json({ success: true });
  } catch(e) {
    console.error('❌ Ошибка сохранения порогов:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ==================== ЕЖЕДНЕВНАЯ СТАТИСТИКА ИГРОКА ====================

// Сохранение ежедневного снимка статистики
app.post('/api/player/:accountId/daily-stats', async (req, res) => {
  if (!db) return res.json({ success: false, error: 'no database' });
  
  try {
    const { accountId } = req.params;
    const { stats } = req.body;
    
    if (!stats) return res.status(400).json({ error: 'Нет данных' });
    
    // Ключ: дата в формате YYYY-MM-DD (МСК)
    const now = new Date();
    const mskTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    const dateKey = mskTime.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Сохраняем в коллекцию dailyStats/{accountId}/snapshots/{dateKey}
    await db
      .collection('dailyStats')
      .doc(accountId)
      .collection('snapshots')
      .doc(dateKey)
      .set({
        ...stats,
        date: dateKey,
        savedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    
    console.log(`💾 Ежедневная статистика ${accountId} за ${dateKey} сохранена`);
    res.json({ success: true, date: dateKey });
  } catch(e) {
    console.error('❌ Ошибка сохранения ежедневной статистики:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Получение ежедневной статистики
app.get('/api/player/:accountId/daily-stats', async (req, res) => {
  if (!db) return res.json({ snapshots: [] });
  
  try {
    const { accountId } = req.params;
    const { days = 30 } = req.query;
    
    // Вычисляем дату N дней назад (МСК)
    const now = new Date();
    const mskTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    mskTime.setDate(mskTime.getDate() - parseInt(days));
    const fromDate = mskTime.toISOString().split('T')[0];
    
    const snapshot = await db
      .collection('dailyStats')
      .doc(accountId)
      .collection('snapshots')
      .where('date', '>=', fromDate)
      .orderBy('date', 'asc')
      .get();
    
    const snapshots = [];
    snapshot.forEach(doc => snapshots.push(doc.data()));
    
    res.json({ snapshots });
  } catch(e) {
    console.error('❌ Ошибка загрузки ежедневной статистики:', e.message);
    res.json({ snapshots: [] });
  }
});

// Проверка, сохранена ли уже статистика за сегодня
app.get('/api/player/:accountId/daily-stats/today', async (req, res) => {
  if (!db) return res.json({ exists: false });
  
  try {
    const { accountId } = req.params;
    const now = new Date();
    const mskTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
    const today = mskTime.toISOString().split('T')[0];
    
    const doc = await db
      .collection('dailyStats')
      .doc(accountId)
      .collection('snapshots')
      .doc(today)
      .get();
    
    res.json({ exists: doc.exists, date: today });
  } catch(e) {
    res.json({ exists: false });
  }
});

// ==================== ЗАГРУЗКА ФОТО ====================
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/chat/photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  try {
    const resized = await sharp(req.file.buffer)
      .resize(800, 800, { fit: 'inside' })
      .jpeg({ quality: 70 })
      .toBuffer();
    
    const base64 = resized.toString('base64');
    res.json({ success: true, url: `data:image/jpeg;base64,${base64}` });
  } catch(e) {
    const base64 = req.file.buffer.toString('base64');
    res.json({ success: true, url: `data:${req.file.mimetype};base64,${base64}` });
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
