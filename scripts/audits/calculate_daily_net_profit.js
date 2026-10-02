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

  allSignals.sort((a, b) => a.timestamp - b.timestamp);

  // Stop Losses confirmados durante el día
  // 1. MARCO 15:14 (SELL 4264, SL 4276) - Reportado en telegram a las 15:28 "cut all at 4278" / "Apologies standby for recovery"
  // 2. MR. QI 8:30 (BUY 29, SL 24) - Reportado a las 8:55 "Public group had a signal hit SL"
  
  const balance = 100000;
  
  let pipsTotal = 0;
  let wins = 0;
  let losses = 0;
  let resultsTable = [];

  for (const s of allSignals) {
    const p = s.parsed;
    let entry = p.entry;
    let sl = p.sl;
    let tp1 = p.tp1;

    // Normalizar 2-digitos a precios de XAUUSD (base 4300 o 4200)
    if (entry && entry < 100) entry = (entry > 50 ? 4200 : 4300) + entry;
    if (sl && sl < 100) sl = (sl > 50 ? 4200 : 4300) + sl;
    if (tp1 && tp1 < 100) tp1 = (tp1 > 50 ? 4200 : 4300) + tp1;

    if (!entry) entry = p.action === 'BUY' ? sl + 10 : sl - 10;
    if (!tp1) tp1 = p.action === 'BUY' ? entry + 4 : entry - 4;

    const slPips = Math.abs(entry - sl);
    const tpPips = Math.abs(tp1 - entry);

    let isLoss = false;

    // Identificar pérdidas documentadas
    if (s.channel.toLowerCase().includes('marco') && s.timeStr.includes('15:14')) {
      isLoss = true;
    }
    if (s.channel.toLowerCase().includes('qi') && s.timeStr.includes('8:30')) {
      isLoss = true;
    }

    let pipsResult = isLoss ? -slPips : tpPips;
    if (isLoss) losses++; else wins++;
    pipsTotal += pipsResult;

    // Riesgo 1% = $1,000 | Riesgo 2% = $2,000
    // Lotes al 1% = 1000 / (slPips * 100)
    // Ganancia 1% = (pipsResult / slPips) * 1000
    const profit1pct = (pipsResult / slPips) * 1000;
    const profit2pct = (pipsResult / slPips) * 2000;

    resultsTable.push({
      time: s.timeStr,
      channel: s.channel,
      action: p.action,
      entry: entry.toFixed(1),
      sl: sl.toFixed(1),
      tp1: tp1.toFixed(1),
      pips: pipsResult.toFixed(1),
      result: isLoss ? 'LOSS' : 'WIN',
      profit1: profit1pct,
      profit2: profit2pct
    });
  }

  const totalUSD_1 = resultsTable.reduce((acc, r) => acc + r.profit1, 0);
  const totalUSD_2 = resultsTable.reduce((acc, r) => acc + r.profit2, 0);

  console.log(JSON.stringify({
    totalTrades: resultsTable.length,
    wins,
    losses,
    winRate: ((wins / resultsTable.length) * 100).toFixed(1) + '%',
    totalPips: pipsTotal.toFixed(1),
    totalProfit_1pct: totalUSD_1.toFixed(2),
    totalProfit_2pct: totalUSD_2.toFixed(2),
    trades: resultsTable
  }, null, 2));

  process.exit(0);
})();
