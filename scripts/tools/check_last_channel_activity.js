const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { normalizeTitle } = require('./bot_listener');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const APPROVED_CHANNELS = [
  'aliens', 'smart pips', 'xauusd forex', 'fx pro signal',
  'risk management', 'marco', 'marcotradinhub', 'fx community',
  'community', 'g.s market', 'williams', 'ai premium',
  'attaullah', 'mr.qi', 'mr qi'
];

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs({});
  console.log('\n================================================================---------------');
  console.log('⚡ ÚLTIMA ACTIVIDAD REGISTRADA EN TUS CANALES APROBADOS');
  console.log('================================================================---------------\n');

  for (const d of dialogs) {
    if (!d.name) continue;
    const norm = normalizeTitle(d.name);
    if (!APPROVED_CHANNELS.some(c => norm.includes(c))) continue;

    const msgs = await client.getMessages(d.entity, { limit: 1 });
    if (msgs && msgs.length > 0) {
      const lastMsg = msgs[0];
      const dateObj = new Date(lastMsg.date * 1000);
      const now = new Date();
      const diffHours = ((now - dateObj) / (1000 * 60 * 60)).toFixed(1);
      const textClean = lastMsg.message ? lastMsg.message.replace(/\n/g, ' ').slice(0, 80) : '[Sin texto / Imagen]';

      console.log(`📌 Canal: "${d.name}"`);
      console.log(`   🕒 Hora del Mensaje: ${dateObj.toLocaleString('es-ES')} (${diffHours} h atrás)`);
      console.log(`   💬 Último Mensaje: "${textClean}"`);
      console.log('-------------------------------------------------------------------------------');
    }
  }

  await client.disconnect();
})();
