const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const channels = [
  { name: 'Smart Pips Alerts', identifier: 'Smartpipsalrets71' },
  { name: 'FX PRO SIGNAL TEAM', identifier: 'XAUFxproSignalS' },
  { name: 'MARCO TRADING HUB', identifier: 'Marcotradinhub' },
  { name: 'Aliens- Royal fx', identifier: '-1003915769321' },
  { name: 'XAUUSD FOREX TRADING', identifier: 'kingFxGoldTeam786' },
];

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('🔍 === REVISANDO MENSAJES DE ESTA MADRUGADA (14 SEPTIEMBRE) ===\n');

  for (const ch of channels) {
    try {
      let entity;
      if (ch.identifier.startsWith('-') || ch.identifier.match(/^\d+$/)) {
        const dialogs = await client.getDialogs({});
        const found = dialogs.find((d) => d.id.toString().includes(ch.identifier.replace('-100', '')));
        if (found) entity = found.entity;
        else entity = await client.getEntity(ch.identifier);
      } else {
        entity = await client.getEntity(ch.identifier);
      }

      console.log(`=========================================================`);
      console.log(`📌 Canal: "${ch.name}"`);
      console.log(`=========================================================`);

      const msgs = await client.getMessages(entity, { limit: 15 });
      msgs.forEach((m) => {
        const text = m.message || '';
        const date = new Date(m.date * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
        console.log(`\n[ID: ${m.id} | Fecha: ${date}]`);
        console.log(`RAW TEXT:\n${text}`);
        console.log(`---------------------------------------------------------`);
      });

    } catch (e) {
      console.log(`Error inspect ${ch.name}: ${e.message}`);
    }
  }

  process.exit(0);
})();
