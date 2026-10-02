const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal } = require('./bot_listener');
const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  
  // MARCO FOREX HUB: -1004467579725
  console.log('--- BUSCANDO ÚLTIMA SEÑAL DE MARCO FOREX HUB (15:40) ---');
  const messages = await client.getMessages(-1004467579725, { limit: 5 });
  messages.forEach((m, idx) => {
    if (m.message) {
      console.log(`\n[${idx + 1}] Hora: ${new Date(m.date * 1000).toLocaleString('es-ES')}`);
      console.log(`    Texto Raw: "${m.message}"`);
      const parsed = parseSignal(m.message);
      console.log(`    Parsed Signal:`, parsed);
    }
  });
  process.exit(0);
})();
