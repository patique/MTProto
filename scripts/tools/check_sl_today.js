const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs({});
  const channelNames = [
    'aliens', 'smart pips', 'xauusd forex', 'risk management', 
    'marco', 'williams', 'ai premium', 'attaullah', 'mr.qi', 'g.s market'
  ];

  console.log('--- BUSCANDO REPORTES DE STOP LOSS / PÉRDIDAS HOY ---');

  for (const d of dialogs) {
    if (!d.name) continue;
    const norm = d.name.toLowerCase();
    if (!channelNames.some(c => norm.includes(c))) continue;

    const msgs = await client.getMessages(d.entity, { limit: 60 });
    for (const m of msgs) {
      if (!m.message) continue;
      const text = m.message;
      const upper = text.toUpperCase();
      const dateObj = new Date(m.date * 1000);
      if (dateObj.getUTCDate() !== 14 || dateObj.getUTCMonth() !== 8 || dateObj.getUTCFullYear() !== 2026) continue;

      if (upper.includes('SL HIT') || upper.includes('HIT SL') || upper.includes('HIT OUR SL') || 
          upper.includes('STOPLOSS HIT') || upper.includes('CUT ALL') || upper.includes('CLOSE WITH LOSS') ||
          upper.includes('RECOVERY SIGNAL') || upper.includes('APOLOGIES')) {
        console.log(`\n❌ [SL o Pérdida Reportada] [${d.name}] Hora: ${dateObj.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' })}`);
        console.log(`   Texto: "${text.replace(/\n/g, ' ')}"`);
      }
    }
  }

  process.exit(0);
})();
