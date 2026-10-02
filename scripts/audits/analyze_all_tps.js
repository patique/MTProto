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

  for (let i = 0; i < 15; i++) {
    const msgs = await client.getMessages(targetEntity, { limit, offsetId });
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

  let tpStats = {
    tp1: 0,
    tp2: 0,
    tp3: 0,
    tp4: 0,
    tp5: 0,
    tp6: 0,
    sl: 0
  };

  let rrSums = { tp1: 0, tp2: 0, tp3: 0, tp4: 0, tp5: 0, tp6: 0, count: 0 };

  signals.forEach((sig) => {
    const sigId = sig.id;
    const text = sig.message || '';

    // Extraer valores
    const entryMatch = text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i) || text.match(/(?:ENTRY|ENTRADA|PRICE):\s*([\d\.\-]+)/i);
    const slMatch = text.match(/(?:SL|STOP LOSS):\s*([\d\.]+)/i);

    const tps = [];
    for (let i = 1; i <= 6; i++) {
      const match = text.match(new RegExp(`(?:TP${i}|TP ${i}|TAKE PROFIT ${i}|TARGET ${i}):\\s*([\\d\\.]+)`, 'i'));
      if (match) tps[i] = parseFloat(match[1]);
    }

    if (entryMatch && slMatch) {
      let entryVal = entryMatch[2] ? parseFloat(entryMatch[2]) : parseFloat(entryMatch[1]);
      if (isNaN(entryVal) && text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)) {
        entryVal = parseFloat(text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)[1]);
      }
      const slVal = parseFloat(slMatch[1]);
      const risk = Math.abs(entryVal - slVal);

      if (risk > 0 && !isNaN(entryVal)) {
        rrSums.count++;
        for (let i = 1; i <= 6; i++) {
          if (tps[i]) {
            const reward = Math.abs(entryVal - tps[i]);
            rrSums[`tp${i}`] += (reward / risk);
          }
        }
      }
    }

    // Buscar mensajes de resultado posteriores o respuestas
    const subsequentMsgs = allMessages.filter((m) => m.id > sigId && m.id < sigId + 30);
    let maxTpDone = 0;
    let hitSl = false;

    subsequentMsgs.forEach((m) => {
      const msgUpper = (m.message || '').toUpperCase();
      if (msgUpper.includes('SL HIT') || msgUpper.includes('STOP LOSS HIT')) hitSl = true;

      for (let i = 1; i <= 6; i++) {
        if (msgUpper.includes(`TP${i}`) || msgUpper.includes(`TP ${i}`) || msgUpper.includes(`TARGET ${i}`)) {
          if (i > maxTpDone) maxTpDone = i;
        }
      }
      if (msgUpper.includes('ALL TP') || msgUpper.includes('ALL TARGETS')) {
        maxTpDone = 6;
      }
    });

    if (hitSl) tpStats.sl++;
    if (maxTpDone >= 1) tpStats.tp1++;
    if (maxTpDone >= 2) tpStats.tp2++;
    if (maxTpDone >= 3) tpStats.tp3++;
    if (maxTpDone >= 4) tpStats.tp4++;
    if (maxTpDone >= 5) tpStats.tp5++;
    if (maxTpDone >= 6) tpStats.tp6++;
  });

  const total = signals.length || 1;

  console.log('\n======================================================');
  console.log(`📊 DESGLOSE COMPLETO DE ALL TPs: "𝑹𝒊𝒔𝒌 𝑴𝒂𝒏𝒂𝒈𝒆𝒎𝒆𝒏𝒕-𝒓𝒆𝒗𝒆𝒂𝒍𝒆𝒅 🐬"`);
  console.log('======================================================');
  console.log(`Total señales analizadas: ${total}`);
  console.log(`------------------------------------------------------`);
  console.log(`🎯 TP1: ${tpStats.tp1} aciertos (${((tpStats.tp1 / total) * 100).toFixed(1)}%) | Ratio RR Promedio: 1 : ${(rrSums.tp1 / rrSums.count).toFixed(2)}`);
  console.log(`🎯 TP2: ${tpStats.tp2} aciertos (${((tpStats.tp2 / total) * 100).toFixed(1)}%) | Ratio RR Promedio: 1 : ${(rrSums.tp2 / rrSums.count).toFixed(2)}`);
  console.log(`🎯 TP3: ${tpStats.tp3} aciertos (${((tpStats.tp3 / total) * 100).toFixed(1)}%) | Ratio RR Promedio: 1 : ${(rrSums.tp3 / rrSums.count).toFixed(2)}`);
  console.log(`🎯 TP4: ${tpStats.tp4} aciertos (${((tpStats.tp4 / total) * 100).toFixed(1)}%) | Ratio RR Promedio: 1 : ${(rrSums.tp4 / rrSums.count).toFixed(2)}`);
  console.log(`🎯 TP5: ${tpStats.tp5} aciertos (${((tpStats.tp5 / total) * 100).toFixed(1)}%) | Ratio RR Promedio: 1 : ${(rrSums.tp5 / rrSums.count).toFixed(2)}`);
  console.log(`🎯 TP6: ${tpStats.tp6} aciertos (${((tpStats.tp6 / total) * 100).toFixed(1)}%) | Ratio RR Promedio: 1 : ${(rrSums.tp6 / rrSums.count).toFixed(2)}`);
  console.log(`------------------------------------------------------`);
  console.log(`🛑 Stop Loss (SL): ${tpStats.sl} (${((tpStats.sl / total) * 100).toFixed(1)}%)`);
  console.log('======================================================\n');

  process.exit(0);
})();
