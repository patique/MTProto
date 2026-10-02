const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const targetEntity = await client.getEntity('Risk_Management_revealed');
  
  let allMessages = [];
  let offsetId = 0;
  const limit = 100;

  for (let i = 0; i < 15; i++) { // 1500 mensajes
    const msgs = await client.getMessages(targetEntity, { limit, offsetId });
    if (!msgs || msgs.length === 0) break;
    allMessages.push(...msgs);
    offsetId = msgs[msgs.length - 1].id;
    if (msgs.length < limit) break;
  }

  console.log(`Total mensajes analizados en 𝑹𝒊𝒔𝒌 𝑴𝒂𝒏𝒂𝒈𝒆𝒎𝒆𝒏𝒕-𝒓𝒆𝒗𝒆𝒂𝒍𝒆𝒅: ${allMessages.length}`);

  // Filtrar mensajes de señales
  const signals = [];
  allMessages.forEach((m) => {
    const text = m.message || '';
    const upper = text.toUpperCase();
    if ((upper.includes('BUY') || upper.includes('SELL')) && (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS') || upper.includes('TARGET'))) {
      signals.push(m);
    }
  });

  console.log(`Señales detectadas: ${signals.length}`);

  console.log('\n--- Muestra de 5 señales detectadas ---');
  signals.slice(0, 5).forEach((s, idx) => {
    console.log(`\n[Señal #${idx + 1}] [${new Date(s.date * 1000).toLocaleString()}]`);
    console.log(s.message);
  });

  // Estadísticas
  let tp1Hit = 0;
  let tp2Hit = 0;
  let slHit = 0;
  let unknown = 0;

  let totalRrTp1 = 0;
  let totalRrTp2 = 0;
  let validRrCount = 0;

  signals.forEach((sig) => {
    const sigId = sig.id;
    const text = sig.message || '';

    // Extraer entry, tp1, tp2, sl
    const entryMatch = text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i) || text.match(/(?:ENTRY|ENTRADA|PRICE):\s*([\d\.\-]+)/i);
    const tp1Match = text.match(/(?:TP1|TP 1|TARGET 1):\s*([\d\.]+)/i);
    const tp2Match = text.match(/(?:TP2|TP 2|TARGET 2):\s*([\d\.]+)/i);
    const slMatch = text.match(/(?:SL|STOP LOSS):\s*([\d\.]+)/i);

    if (entryMatch && slMatch && tp1Match) {
      let entryVal = entryMatch[2] ? parseFloat(entryMatch[2]) : parseFloat(entryMatch[1]);
      if (isNaN(entryVal) && text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)) {
        entryVal = parseFloat(text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)[1]);
      }
      const tp1Val = parseFloat(tp1Match[1]);
      const slVal = parseFloat(slMatch[1]);
      const tp2Val = tp2Match ? parseFloat(tp2Match[1]) : null;

      if (!isNaN(entryVal) && !isNaN(slVal) && !isNaN(tp1Val)) {
        const risk = Math.abs(entryVal - slVal);
        const reward1 = Math.abs(entryVal - tp1Val);
        const reward2 = tp2Val ? Math.abs(entryVal - tp2Val) : null;

        if (risk > 0 && reward1 > 0) {
          totalRrTp1 += (reward1 / risk);
          if (reward2) totalRrTp2 += (reward2 / risk);
          validRrCount++;
        }
      }
    }

    // Buscar si tuvo TP1, TP2 o SL en los siguientes 30 mensajes o replies
    const replies = allMessages.filter((m) => m.replyTo && m.replyTo.replyToMsgId === sigId);
    let hit1 = false;
    let hit2 = false;
    let hitSl = false;

    replies.forEach((rep) => {
      const r = (rep.message || '').toUpperCase();
      if (r.includes('TP1') || r.includes('TP 1') || r.includes('FIRST TP') || r.includes('DONE') || r.includes('HIT')) hit1 = true;
      if (r.includes('TP2') || r.includes('TP 2') || r.includes('SECOND TP') || r.includes('ALL TP') || r.includes('ALL TARGETS')) {
        hit1 = true;
        hit2 = true;
      }
      if (r.includes('SL') || r.includes('STOP LOSS')) hitSl = true;
    });

    if (!hit1 && !hit2 && !hitSl) {
      const subs = allMessages.filter((m) => m.id > sigId && m.id < sigId + 25).sort((a, b) => a.id - b.id);
      for (const m of subs) {
        const r = (m.message || '').toUpperCase();
        if (r.includes('BUY') && r.includes('TP')) break; // nueva señal
        if (r.includes('TP1') || r.includes('TP 1') || r.includes('FIRST TP') || r.includes('PIPS DONE') || r.includes('PROFIT')) hit1 = true;
        if (r.includes('TP2') || r.includes('TP 2') || r.includes('ALL TP') || r.includes('ALL TARGETS')) {
          hit1 = true;
          hit2 = true;
        }
        if (r.includes('SL HIT') || r.includes('STOP LOSS HIT')) hitSl = true;
      }
    }

    if (hit2) tp2Hit++;
    else if (hit1) tp1Hit++;
    else if (hitSl) slHit++;
    else unknown++;
  });

  const totalHits = tp1Hit + tp2Hit;
  const avgRr1 = validRrCount > 0 ? (totalRrTp1 / validRrCount).toFixed(2) : 'N/A';
  const avgRr2 = validRrCount > 0 ? (totalRrTp2 / validRrCount).toFixed(2) : 'N/A';

  console.log('\n======================================================');
  console.log(`📊 ESTADÍSTICAS CANAL: "𝑹𝒊𝒔𝒌 𝑴𝒂𝒏𝒂𝒈𝒆𝒎𝒆𝒏𝒕-𝒓𝒆𝒗𝒆𝒂𝒍𝒆𝒅 🐬"`);
  console.log('======================================================');
  console.log(`Total señales analizadas: ${signals.length}`);
  console.log(`🎯 Acierto TP1 o superior: ${totalHits} (${((totalHits / (signals.length || 1)) * 100).toFixed(1)}%)`);
  console.log(`🎯🎯 Acierto TP2 (Objetivo Completo): ${tp2Hit} (${((tp2Hit / (signals.length || 1)) * 100).toFixed(1)}%)`);
  console.log(`🛑 Stop Loss (SL): ${slHit} (${((slHit / (signals.length || 1)) * 100).toFixed(1)}%)`);
  console.log(`❓ Sin confirmación / En curso: ${unknown} (${((unknown / (signals.length || 1)) * 100).toFixed(1)}%)`);
  console.log('------------------------------------------------------');
  console.log(`📐 Ratio Riesgo:Beneficio (RR) Promedio:`);
  console.log(`   👉 TP1 vs SL: 1 : ${avgRr1} ${parseFloat(avgRr1) >= 1 ? '✅ (Supera el 1:1)' : '⚠️ (Inferior a 1:1)'}`);
  console.log(`   👉 TP2 vs SL: 1 : ${avgRr2}`);
  console.log('======================================================\n');

  process.exit(0);
})();
