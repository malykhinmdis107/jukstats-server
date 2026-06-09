// server.js
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ==================== НАСТРОЙКА ХРАНИЛИЩА АВАТАРОВ ====================
const avatarsDir = path.join(__dirname, 'storage', 'avatars');
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
}

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarsDir),
    filename: (req, file, cb) => {
        const accountId = req.params.accountId;
        cb(null, `${accountId}.webp`);
    }
});
const upload = multer({ 
    storage, 
    limits: { fileSize: 2 * 1024 * 1024 }  // 2 MB
});

// Раздача статики (аватары)
app.use('/avatars', express.static(avatarsDir));

// Загрузка аватара
app.post('/api/avatar/:accountId', upload.single('avatar'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
    }
    res.json({ 
        success: true, 
        url: `/avatars/${req.params.accountId}.webp` 
    });
});

// Удаление аватара
app.delete('/api/avatar/:accountId', (req, res) => {
    const filePath = path.join(avatarsDir, `${req.params.accountId}.webp`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    res.json({ success: true });
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: Date.now(),
        uptime: process.uptime()
    });
});

// Статистика сервера
app.get('/api/stats', (req, res) => {
    res.json({
        status: 'ok',
        avatarsCount: fs.readdirSync(avatarsDir).length
    });
});

// ==================== WEBSOCKET ====================
const chatRooms = new Map();
const voiceRooms = new Map();

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    
    // ========== Чат ==========
    if (pathname.startsWith('/ws/chat/')) {
        const clanId = pathname.split('/').pop();
        
        if (!chatRooms.has(clanId)) {
            chatRooms.set(clanId, new Set());
        }
        const room = chatRooms.get(clanId);
        room.add(ws);
        
        console.log(`[Chat] +1 в ${clanId}, всего: ${room.size}`);
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                for (const client of room) {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                }
            } catch(e) {
                console.error('[Chat] Ошибка:', e);
            }
        });
        
        ws.on('close', () => {
            room.delete(ws);
            if (room.size === 0) {
                chatRooms.delete(clanId);
            }
            console.log(`[Chat] -1 из ${clanId}, осталось: ${room.size}`);
        });
    }
    
    // ========== Голосовой чат ==========
    else if (pathname.startsWith('/ws/voice/')) {
        const channelId = pathname.split('/').pop();
        const accountId = url.searchParams.get('account_id');
        
        if (!voiceRooms.has(channelId)) {
            voiceRooms.set(channelId, new Map());
        }
        const room = voiceRooms.get(channelId);
        
        const clientId = accountId || `client_${Date.now()}`;
        room.set(clientId, ws);
        
        console.log(`[Voice] +1 в ${channelId}, всего: ${room.size}`);
        
        // Отправляем новому участнику список всех в комнате
        ws.send(JSON.stringify({
            type: 'participants',
            participants: Array.from(room.keys())
        }));
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                // Пересылка сигнала конкретному участнику
                if (data.to && room.has(data.to)) {
                    const target = room.get(data.to);
                    if (target && target.readyState === WebSocket.OPEN) {
                        target.send(JSON.stringify({
                            type: data.type,
                            from: data.from || clientId,
                            data: data.data
                        }));
                    }
                }
                // Рассылка всем
                else if (data.broadcast) {
                    for (const [id, client] of room) {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: data.type,
                                from: data.from || clientId,
                                data: data.data
                            }));
                        }
                    }
                }
            } catch(e) {
                console.error('[Voice] Ошибка:', e);
            }
        });
        
        ws.on('close', () => {
            room.delete(clientId);
            
            // Оповещаем остальных
            for (const client of room.values()) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'user_left',
                        userId: clientId
                    }));
                }
            }
            
            if (room.size === 0) {
                voiceRooms.delete(channelId);
            }
            console.log(`[Voice] -1 из ${channelId}, осталось: ${room.size}`);
        });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

// Обработка необработанных ошибок
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
});

server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`📁 Аватары хранятся в: ${avatarsDir}`);
    console.log(`📡 WebSocket готов`);
});