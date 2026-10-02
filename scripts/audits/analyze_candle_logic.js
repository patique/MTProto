const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal, normalizeTitle } = require('./bot_listener');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const entity = await client.getEntity('CandleLogicLab1');
  console.log(`✅ Canal: "${entity.title}" (ID: ${entity.id.toString()})`);

  const msgs = await client.getMessages(entity, { limit: 400 });
  console.log(`📩 Analizando ${msgs.length} mensajes...\n`);

  const signals = [];
  msgs.forEach((m) => {
    if (!m.message) return;
    const txt = m.message;
    const upper = txt.toUpperCase();

    // Buscar si es un mensaje de orden (BUY / SELL)
    if (upper.includes('BUY') || upper.includes('SELL')) {
      const parsed = parseSignal(txt);
      signals.push({
        id: m.id,
        date: new Date(m.date * 1000),
        raw: txt,
        parsed: parsed
      });
    }
  });

  console.log(`=======================================================`);
  console.log(`🎯 SEÑALES ENCONTRADAS EN CANDLE LOGIC LAB: ${signals.length}`);
  console.log(`=======================================================\n`);

  signals.slice(0, 25).forEach((s, i) => {
    console.log(`[#${i+1}] ID:${s.id} | Fecha: ${s.date.toLocaleString('es-ES')}`);
    console.log(`RAW:\n"${s.raw}"`);
    console.log(`PARSEADO:`, s.parsed ? JSON.stringify(s.parsed) : '❌ NO PARSEADO');
    console.log('-------------------------------------------------------------------------------');
  });

  await client.disconnect();
})();
