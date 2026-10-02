const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const channelsToBacktest = [
  { name: 'MARCO TRADING HUB', identifier: 'Marcotradinhub' },
  { name: 'Aliens- Royal fx', identifier: '-1003915769321' },
  { name: 'Fx Community', identifier: '3740495617' },
  { name: 'Smart Pips Alerts', identifier: 'Smartpipsalrets71' },
  { name: 'XAUUSD FOREX TRADING', identifier: 'kingFxGoldTeam786' },
  { name: 'FX PRO SIGNAL TEAM', identifier: 'XAUFxproSignalS' },
  { name: 'Ai Premium Pips', identifier: '-1003862726389' },
  { name: 'G.S Market Analysis', identifier: 'GSmarketanalysis' },
  { name: 'Risk Management-revealed', identifier: 'Risk_Management_revealed' },
];

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('⚡ === CONSULTANDO ANTIGÜEDAD MÁXIMA E HISTORIAL DE MENSAGES ===\n');

  const historyReport = [];

  for (const ch of channelsToBacktest) {
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

      // Obtener los primeros 100 mensajes más antiguos recuperables
      const recentMsgs = await client.getMessages(entity, { limit: 1 });
      const oldestMsgs = await client.getMessages(entity, { limit: 100, offsetId: 0 }); // Intento de muestra masiva

      if (recentMsgs.length > 0) {
        const newestDate = new Date(recentMsgs[0].date * 1000);
        const oldestDate = oldestMsgs.length > 0 ? new Date(oldestMsgs[oldestMsgs.length - 1].date * 1000) : newestDate;
        
        historyReport.push({
          Canal: ch.name,
          'Mensaje Más Reciente': newestDate.toLocaleDateString(),
          'Primer Mensaje Leído': oldestDate.toLocaleDateString(),
          'ID del Canal': entity.id
        });
      }
    } catch (e) {
      console.log(`Error comprobando ${ch.name}: ${e.message}`);
    }
  }

  console.table(historyReport);
  process.exit(0);
})();
