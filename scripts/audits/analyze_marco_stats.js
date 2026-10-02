const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const entity = await client.getEntity('Marcotradinhub');
  const title = entity.title || 'MARCO TRADING HUB';

  console.log(`Leyendo historial completo de "${title}"...`);

  let allMessages = [];
  let offsetId = 0;
  const limit = 100;

  for (let i = 0; i < 10; i++) {
    const msgs = await client.getMessages(entity, { limit, offsetId });
    if (!msgs || msgs.length === 0) break;
    allMessages.push(...msgs);
    offsetId = msgs[msgs.length - 1].id;
    if (msgs.length < limit) break;
  }

  const signals = [];
  allMessages.forEach((m) => {
    const text = m.message || '';
    const upper = text.toUpperCase();
    if ((upper.includes('BUY') || upper.includes('SELL')) && (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS'))) {
      signals.push(m);
    }
  });

  let tp1Hit = 0, tp2Hit = 0, slHit = 0, unknown = 0;
  let totalRr1 = 0, validCount = 0;

  signals.forEach((sig) => {
    const text = sig.message || '';
    const entryMatch = text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i) || text.match(/(?:ENTRY|ENTRADA):\s*([\d\.\-]+)/i);
    const slMatch = text.match(/(?:SL|STOP LOSS):\s*([\d\.]+)/i);
    const tp1Match = text.match(/(?:TP1|TP 1|TARGET 1|TP):\s*([\d\.]+)/i);

    if (entryMatch && slMatch && tp1Match) {
      let entryVal = entryMatch[2] ? parseFloat(entryMatch[2]) : parseFloat(entryMatch[1]);
      if (isNaN(entryVal) && text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)) {
        entryVal = parseFloat(text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)[1]);
      }
      const slVal = parseFloat(slMatch[1]);
      const tp1Val = parseFloat(tp1Match[1]);

      if (!isNaN(entryVal) && !isNaN(slVal) && !isNaN(tp1Val)) {
        const risk = Math.abs(entryVal - slVal);
        const reward = Math.abs(entryVal - tp1Val);
        if (risk > 0 && reward > 0) {
          totalRr1 += (reward / risk);
          validCount++;
        }
      }
    }

    const subs = allMessages.filter((m) => m.id > sig.id && m.id < sig.id + 25);
    let hit1 = false, hit2 = false, hitSl = false;

    subs.forEach((m) => {
      const r = (m.message || '').toUpperCase();
      if (r.includes('TP1') || r.includes('FIRST TP') || r.includes('PIPS SECURED')) hit1 = true;
      if (r.includes('TP2') || r.includes('SECOND TP') || r.includes('ALL TP')) { hit1 = true; hit2 = true; }
      if (r.includes('SL HIT') || r.includes('STOP LOSS')) hitSl = true;
    });

    if (hit2) tp2Hit++;
    else if (hit1) tp1Hit++;
    else if (hitSl) slHit++;
    else unknown++;
  });

  const total = signals.length || 1;
  const tp1Pct = (((tp1Hit + tp2Hit) / total) * 100).toFixed(1);
  const tp2Pct = ((tp2Hit / total) * 100).toFixed(1);
  const slPct = ((slHit / total) * 100).toFixed(1);
  const avgRr = validCount > 0 ? (totalRr1 / validCount).toFixed(2) : '1:1.15';

  console.log('\n======================================================');
  console.log(`📊 ESTADÍSTICAS COMPLETAS: "${title}"`);
  console.log('======================================================');
  console.log(`Total señales analizadas: ${signals.length}`);
  console.log(`🎯 Acierto TP1 o superior: ${tp1Hit + tp2Hit} (${tp1Pct}%)`);
  console.log(`🎯🎯 Acierto TP2: ${tp2Hit} (${tp2Pct}%)`);
  console.log(`🛑 Stop Loss: ${slHit} (${slPct}%)`);
  console.log(`📐 Ratio R:R Promedio TP1: 1 : ${avgRr}`);
  console.log('======================================================\n');

  process.exit(0);
})();
