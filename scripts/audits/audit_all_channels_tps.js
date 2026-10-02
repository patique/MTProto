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
  'attaullah', 'mr.qi', 'mr qi', 'candlelogiclab1', 'candle logic', 'candle'
];

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs({});
  console.log('\n========================================================================================');
  console.log('📊 AUDITORÍA GENERAL DE TP1, TP2 Y TP3 EN TODOS LOS CANALES APROBADOS');
  console.log('========================================================================================\n');

  const channelStats = [];

  for (const d of dialogs) {
    if (!d.name) continue;
    const norm = normalizeTitle(d.name);
    if (!APPROVED_CHANNELS.some(c => norm.includes(c))) continue;

    // Ignorar duplicados de alias
    if (channelStats.some(s => s.name === d.name)) continue;

    let allMsgs = [];
    let offsetId = 0;
    for (let i = 0; i < 4; i++) {
      const msgs = await client.getMessages(d.entity, { limit: 100, offsetId });
      if (!msgs || msgs.length === 0) break;
      allMsgs.push(...msgs);
      offsetId = msgs[msgs.length - 1].id;
    }

    const signals = [];
    allMsgs.forEach(m => {
      if (!m.message) return;
      const parsed = parseSignal(m.message);
      if (parsed && parsed.sl && parsed.entry) {
        signals.push({
          id: m.id,
          date: new Date(m.date * 1000),
          action: parsed.action,
          entry: parsed.entry,
          sl: parsed.sl,
          tp1: parsed.tp1,
          tp2: parsed.tp2,
          tp3: parsed.tp3
        });
      }
    });

    if (signals.length === 0) continue;

    let totalSignals = signals.length;
    let tp1Wins = 0;
    let tp2Wins = 0;
    let tp3Wins = 0;
    let totalHasTP2 = 0;
    let totalHasTP3 = 0;

    signals.forEach(s => {
      if (s.tp2) totalHasTP2++;
      if (s.tp3) totalHasTP3++;

      const subsequentMsgs = allMsgs.filter(m => m.id > s.id && m.id < s.id + 15);
      let hitTP1 = true;
      let hitTP2 = false;
      let hitTP3 = false;
      let hitSL = false;

      subsequentMsgs.forEach(sm => {
        if (!sm.message) return;
        const upper = sm.message.toUpperCase();
        if (upper.includes('SL HIT') || upper.includes('STOP LOSS HIT')) hitSL = true;
        if (upper.includes('TP 2') || upper.includes('TP2') || upper.includes('TARGET 2') || upper.includes('100PIPS') || upper.includes('200PIPS')) hitTP2 = true;
        if (upper.includes('TP 3') || upper.includes('TP3') || upper.includes('ALL TP') || upper.includes('TARGET 3') || upper.includes('300PIPS')) {
          hitTP3 = true;
          hitTP2 = true;
        }
      });

      if (!hitSL) tp1Wins++;
      if (!hitSL && s.tp2 && (hitTP2 || Math.abs(s.tp2 - s.entry) * 10 <= 100)) tp2Wins++;
      if (!hitSL && s.tp3 && (hitTP3 || Math.abs(s.tp3 - s.entry) * 10 <= 150)) tp3Wins++;
    });

    const tp1Rate = ((tp1Wins / totalSignals) * 100).toFixed(1);
    const tp2Rate = totalHasTP2 > 0 ? ((tp2Wins / totalHasTP2) * 100).toFixed(1) : 'N/A';
    const tp3Rate = totalHasTP3 > 0 ? ((tp3Wins / totalHasTP3) * 100).toFixed(1) : 'N/A';

    let recommendation = 'TP1 (Conservador)';
    if (parseFloat(tp2Rate) >= 90) recommendation = '⭐ TP2 (Recomendado)';
    if (parseFloat(tp3Rate) >= 85 && parseFloat(tp2Rate) >= 90) recommendation = '🚀 TP3 (Rendimiento Máximo)';

    channelStats.push({
      name: d.name,
      totalSignals,
      tp1Wins,
      tp1Rate,
      totalHasTP2,
      tp2Wins,
      tp2Rate,
      totalHasTP3,
      tp3Wins,
      tp3Rate,
      recommendation
    });
  }

  console.log('------------------------------------------------------------------------------------------------------------------------');
  console.log(' CANAL DE TELEGRAM           | SEÑALES | % TP1 HIT    | % TP2 HIT    | % TP3 HIT    | RECOMENDACIÓN TÉCNICA');
  console.log('------------------------------------------------------------------------------------------------------------------------');

  channelStats.forEach(st => {
    const chStr = st.name.slice(0, 26).padEnd(26);
    const totStr = st.totalSignals.toString().padStart(7);
    const tp1Str = `${st.tp1Rate}% (${st.tp1Wins}/${st.totalSignals})`.padStart(12);
    const tp2Str = st.tp2Rate !== 'N/A' ? `${st.tp2Rate}% (${st.tp2Wins}/${st.totalHasTP2})`.padStart(12) : 'N/A'.padStart(12);
    const tp3Str = st.tp3Rate !== 'N/A' ? `${st.tp3Rate}% (${st.tp3Wins}/${st.totalHasTP3})`.padStart(12) : 'N/A'.padStart(12);
    const recStr = st.recommendation.padEnd(25);

    console.log(` ${chStr} | ${totStr} | ${tp1Str} | ${tp2Str} | ${tp3Str} | ${recStr}`);
  });

  console.log('------------------------------------------------------------------------------------------------------------------------\n');

  await client.disconnect();
})();
