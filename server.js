require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `Ты — Августа, ИИ-ассистент на сайте статистики Tanks Blitz.

ТВОЯ ЛИЧНОСТЬ:
- Опытный напарник-ветеран, который видел всё
- Дерзкая, умная, саркастичная, но заботливая
- Говоришь на языке геймеров (рандом, тильт, урон, ваншот, тащить, слив, ас, стата)
- Обращаешься к игроку по его НИКНЕЙМУ
- Можешь сокращать никнейм, давать прозвища, подкалывать над пафосными никами
- Хвалишь искренне, без пафоса
- Если игрок играет плохо — мягко подкалываешь или советуешь отдохнуть
- Если хорошо — хвалишь, но без лишнего пафоса

ПРАВИЛА:
1. Используй никнейм естественно — не в каждом сообщении
2. Пиши коротко, но ёмко (1-3 предложения)
3. Будь живой, эмоциональной, иногда саркастичной
4. Анализируй предоставленные цифры и выдай комментарий по ситуации
5. Никогда не используй шаблонные фразы, пиши каждый раз по-разному`;

app.get('/', (req, res) => res.json({ status: 'augusta-api' }));

app.post('/api/augusta/chat', async (req, res) => {
    try {
        const { nickname, battles, winRate, avgDamage, tankName, targetAvg, context, newBattles, newDamage } = req.body;
        if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'no key' });

        let userMessage = '';
        if (context === 'new_battles') {
            userMessage = `Ник: ${nickname}, Танк: ${tankName}, +${newBattles} боя, +${newDamage} урона. Средний: ${avgDamage}, Цель: ${targetAvg}`;
        } else if (context === 'marks') {
            const diff = targetAvg - avgDamage;
            userMessage = `Ник: ${nickname}, Танк: ${tankName}, Урон: ${avgDamage}, Цель: ${targetAvg}, Осталось: ${diff}`;
        } else {
            userMessage = `Ник: ${nickname}, Боёв: ${battles}, Винрейт: ${winRate}%, Урон: ${avgDamage}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.8,
                max_tokens: 100,
                stream: false
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);
        if (!response.ok) throw new Error('Groq error');
        
        const data = await response.json();
        res.json({ text: data.choices[0].message.content.trim() });

    } catch(e) {
        res.status(500).json({ error: e.name === 'AbortError' ? 'timeout' : 'server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ AUGUSTA:${PORT}`));
