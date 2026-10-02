const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal, normalizeTitle } = require('./bot_listener');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs({});
  console.log('\n================================================================---------------');
  console.log('⚡ MENSAJES ENVIADOS EN LA SESIÓN DE ASIA (15 DE SEPTIEMBRE - 00:00 A 04:35)');
  console.log('================================================================---------------\n');

  for (const d of dialogs) {
    if (!d.name) continue;
    const msgs = await client.getMessages(d.entity, { limit: 15 });
    for (const m of msgs) {
      if (!m.message) continue;
      const dateObj = new Date(m.date * 1000);
      // Mensajes de hoy 15 de Septiembre
      if (dateObj.getUTCDate() === 15 && dateObj.getUTCMonth() === 8 && dateObj.getUTCFullYear() === 2026) {
        console.log(`📌 Canal: "${d.name}" | Hora: ${dateObj.toLocaleTimeString('es-ES')}`);
        console.log(`💬 Texto:\n"${m.message}"`);
        const parsed = parseSignal(m.message);
        console.log(`🎯 Parseo:`, parsed ? JSON.stringify(parsed) : 'Sin parseo');
        console.log('-------------------------------------------------------------------------------');
      }
    }
  }

  await client.disconnect();
})();
