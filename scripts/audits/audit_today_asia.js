const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal, normalizeTitle } = require('./bot_listener');
const { processSignalForExecution } = require('./risk_engine');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const APPROVED_CHANNELS = [
  'aliens', 'smart pips', 'xauusd forex', 'fx pro signal',
  'risk management', 'marco', 'marcotradinhub', 'fx community',
  'community', 'g.s market', 'williams', 'ai premium',
  'attaullah', 'mr.qi', 'mr qi', 'candlelogiclab1', 'candle logic', 'candle'
];

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs({});
  console.log('⚡ AUDITANDO TODAS LAS SEÑALES ENVIADAS HOY (15 DE SEPTIEMBRE):');

  for (const d of dialogs) {
    if (!d.name) continue;
    const norm = normalizeTitle(d.name);
    if (!APPROVED_CHANNELS.some(c => norm.includes(c))) continue;

    const msgs = await client.getMessages(d.entity, { limit: 25 });
    for (const m of msgs) {
      if (!m.message) continue;
      const dateObj = new Date(m.date * 1000);
      if (dateObj.getUTCDate() === 15 && dateObj.getUTCMonth() === 8) {
        const parsed = parseSignal(m.message);
        if (parsed) {
          const plan = processSignalForExecution(parsed);
          console.log('\n-------------------------------------------------------------');
          console.log(`📌 [${dateObj.toLocaleTimeString('es-ES')}] Canal: "${d.name}"`);
          console.log(`💬 Texto:\n"${m.message.replace(/\n/g, ' ').slice(0, 100)}"`);
          console.log(`🎯 Parsed:`, JSON.stringify(parsed));
          console.log(`🚀 Plan Valid: ${plan.valid} ${!plan.valid ? '❌ RECHAZADO: ' + plan.reason : '✅ OK'}`);
          if (plan.valid) {
            console.log(`   Acción: ${plan.action} | Entry: ${plan.entryPrice} | SL: ${plan.slPrice} | TP: ${plan.orders[0]?.tp}`);
          }
        }
      }
    }
  }

  await client.disconnect();
})();
