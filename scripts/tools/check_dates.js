const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('📅 Comprobando fechas exactas del rango del backtest...\n');

  const channels = [
    { name: 'MARCO TRADING HUB', id: 'Marcotradinhub' },
    { name: 'XAUUSD FOREX TRADING', id: 'kingFxGoldTeam786' },
    { name: 'FX PRO SIGNAL TEAM', id: 'XAUFxproSignalS' },
    { name: 'Fx Community', id: '3740495617' }
  ];

  for (const ch of channels) {
    try {
      let entity;
      if (ch.id.match(/^\d+$/)) {
        const dialogs = await client.getDialogs({});
        const found = dialogs.find((d) => d.id.toString().includes(ch.id));
        if (found) entity = found.entity;
        else entity = await client.getEntity(ch.id);
      } else {
        entity = await client.getEntity(ch.id);
      }

      const msgs = await client.getMessages(entity, { limit: 500 });
      if (msgs && msgs.length > 0) {
        const newest = new Date(msgs[0].date * 1000);
        const oldest = new Date(msgs[msgs.length - 1].date * 1000);
        const diffDays = Math.round((newest - oldest) / (1000 * 60 * 60 * 24));
        console.log(`📌 Canal "${ch.name}":`);
        console.log(`   - Mensaje más reciente: ${newest.toLocaleDateString()}`);
        console.log(`   - Mensaje más antiguo analizado: ${oldest.toLocaleDateString()}`);
        console.log(`   - Rango temporal: ${diffDays} días (~${(diffDays / 30).toFixed(1)} meses)\n`);
      }
    } catch (e) {
      console.log(`Error comprobando ${ch.name}: ${e.message}`);
    }
  }

  process.exit(0);
})();
