const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal, normalizeTitle } = require('./bot_listener');

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
  const allSignals = [];

  for (const d of dialogs) {
    if (!d.name) continue;
    const norm = normalizeTitle(d.name);
    if (!APPROVED_CHANNELS.some(c => norm.includes(c))) continue;

    const msgs = await client.getMessages(d.entity, { limit: 50 });
    for (const m of msgs) {
      if (!m.message) continue;
      const dateObj = new Date(m.date * 1000);
      // Solo 14 de Septiembre de 2026
      if (dateObj.getUTCDate() !== 14 || dateObj.getUTCMonth() !== 8 || dateObj.getUTCFullYear() !== 2026) continue;

      const parsed = parseSignal(m.message);
      if (parsed && parsed.sl) {
        allSignals.push({
          channel: d.name,
          timeStr: dateObj.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' }),
          timestamp: m.date,
          parsed,
          rawMsg: m.message
        });
      }
    }
  }

  // Ordenar cronológicamente
  allSignals.sort((a, b) => a.timestamp - b.timestamp);

  console.log(JSON.stringify({
    totalDetected: allSignals.length,
    signals: allSignals.map(s => ({
      channel: s.channel,
      time: s.timeStr,
      action: s.parsed.action,
      entry: s.parsed.entry,
      sl: s.parsed.sl,
      tp1: s.parsed.tp1,
      tp2: s.parsed.tp2,
      raw: s.rawMsg.replace(/\n/g, ' ').substring(0, 80)
    }))
  }, null, 2));

  process.exit(0);
})();
