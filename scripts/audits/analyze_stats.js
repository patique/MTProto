const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs();
  const targetDialog = dialogs.find((d) => {
    const title = d.title || d.name || '';
    return title.toLowerCase().includes('aliens');
  });

  if (!targetDialog) {
    console.log('Canal no encontrado');
    process.exit(1);
  }

  console.log(`Leyendo historial completo de "${targetDialog.title}"...`);

  let allMessages = [];
  let offsetId = 0;
  const limit = 100;

  for (let i = 0; i < 10; i++) { // Obtener hasta 1000 mensajes
    const msgs = await client.getMessages(targetDialog.entity, { limit, offsetId });
    if (!msgs || msgs.length === 0) break;
    allMessages.push(...msgs);
    offsetId = msgs[msgs.length - 1].id;
    if (msgs.length < limit) break;
  }

  console.log(`Total mensajes recuperados: ${allMessages.length}`);

  // Mapa de id de mensaje a mensaje
  const msgMap = new Map();
  allMessages.forEach((m) => msgMap.set(m.id, m));

  // Identificar mensajes que son señales
  const signals = [];
  allMessages.forEach((m) => {
    const text = m.message || '';
    const upper = text.toUpperCase();
    
    // Una señal suele tener PAIR / ENTRY / BUY NOW / SELL NOW / STOP LOSS / TAKE PROFIT
    if ((upper.includes('SIGNAL') || upper.includes('PAIR') || upper.includes('SELL NOW') || upper.includes('BUY NOW')) &&
        (upper.includes('ENTRY') || upper.includes('TAKE PROFIT') || upper.includes('STOP LOSS'))) {
      signals.push(m);
    }
  });

  console.log(`Señales detectadas: ${signals.length}`);

  // Analizar cada señal y buscar mensajes posteriores (o respuestas directas a la señal)
  let stats = {
    totalSignals: signals.length,
    tp1Hit: 0,
    tp2Hit: 0,
    slHit: 0,
    unknown: 0,
    details: []
  };

  // Extraer valores numéricos y calcular Risk:Reward (RR) para TP1 y TP2
  let totalRrTp1 = 0;
  let totalRrTp2 = 0;
  let validRrCount = 0;

  signals.forEach((sig) => {
    const text = sig.message || '';
    
    // Buscar valores numéricos de Entry, TP1, TP2, SL
    const entryMatch = text.match(/(?:ENTRY|ENTRADA):\s*([\d\.]+)/i);
    const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TP 1):\s*([\d\.]+)/i);
    const tp2Match = text.match(/(?:TAKE PROFIT 2|TP2|TP 2):\s*([\d\.]+)/i);
    const slMatch = text.match(/(?:STOP LOSS|SL):\s*([\d\.]+)/i);

    if (entryMatch && slMatch && tp1Match) {
      const entry = parseFloat(entryMatch[1]);
      const tp1 = parseFloat(tp1Match[1]);
      const sl = parseFloat(slMatch[1]);
      const tp2 = tp2Match ? parseFloat(tp2Match[1]) : null;

      const risk = Math.abs(entry - sl);
      const reward1 = Math.abs(entry - tp1);
      const reward2 = tp2 ? Math.abs(entry - tp2) : null;

      if (risk > 0 && reward1 > 0) {
        const rr1 = reward1 / risk;
        totalRrTp1 += rr1;
        if (reward2) {
          totalRrTp2 += reward2 / risk;
        }
        validRrCount++;
      }
    }

    const sigId = sig.id;
    const sigDate = new Date(sig.date * 1000).toLocaleString();
    const sigText = sig.message;

    // Buscar respuestas directas que hagan referencia a `sigId`
    const replies = allMessages.filter((m) => m.replyTo && m.replyTo.replyToMsgId === sigId);
    
    // Si no hay respuestas por `replyToMsgId`, buscar en mensajes posteriores dentro del mismo rango de tiempo (siguientes 48h o hasta la siguiente señal)
    let hitTp1 = false;
    let hitTp2 = false;
    let hitSl = false;

    // Analizar el texto de las respuestas directas primero
    replies.forEach((rep) => {
      const rText = (rep.message || '').toUpperCase();
      if (rText.includes('TP1') || rText.includes('FIRST TP') || rText.includes('TP 1') || rText.includes('1ST TP') || rText.includes('FIRST TP DONE')) hitTp1 = true;
      if (rText.includes('TP2') || rText.includes('SECOND TP') || rText.includes('TP 2') || rText.includes('2ND TP') || rText.includes('ALL TPS') || rText.includes('ALL TP') || rText.includes('ALL OUR TPS') || rText.includes('TARGET CAPTURED')) {
        hitTp1 = true;
        hitTp2 = true;
      }
      if (rText.includes('SL HIT') || rText.includes('STOP LOSS HIT') || rText.includes('HIT SL') || rText.includes('STOPLOSS HIT') || rText.includes('HIT OUR SL')) {
        hitSl = true;
      }
    });

    // Si aún no se determinó por reply directo, buscar mensajes posteriores cercanos en el canal
    if (!hitTp1 && !hitTp2 && !hitSl) {
      const subsequentMsgs = allMessages
        .filter((m) => m.id > sigId && m.id < sigId + 30)
        .sort((a, b) => a.id - b.id);

      for (const m of subsequentMsgs) {
        const textUpper = (m.message || '').toUpperCase();
        // Si encontramos otra señal nueva, paramos la búsqueda para este trade
        if ((textUpper.includes('SIGNAL') || textUpper.includes('SELL NOW') || textUpper.includes('BUY NOW')) && textUpper.includes('ENTRY')) {
          break;
        }
        if (textUpper.includes('TP1') || textUpper.includes('FIRST TP') || textUpper.includes('TP 1') || textUpper.includes('1ST TP') || textUpper.includes('60 PIPS') || textUpper.includes('RUNNING PROFIT')) {
          hitTp1 = true;
        }
        if (textUpper.includes('TP2') || textUpper.includes('SECOND TP') || textUpper.includes('TP 2') || textUpper.includes('2ND TP') || textUpper.includes('ALL TPS') || textUpper.includes('ALL OUR TPS') || textUpper.includes('TARGET CAPTURED') || textUpper.includes('900+ PIPS')) {
          hitTp1 = true;
          hitTp2 = true;
        }
        if (textUpper.includes('SL HIT') || textUpper.includes('STOP LOSS HIT') || textUpper.includes('HIT SL') || textUpper.includes('STOPLOSS HIT') || textUpper.includes('HIT OUR SL')) {
          hitSl = true;
        }
      }
    }

    if (hitTp2) stats.tp2Hit++;
    else if (hitTp1) stats.tp1Hit++;
    else if (hitSl) stats.slHit++;
    else stats.unknown++;

    // Extraer par
    const pairMatch = sigText.match(/(?:PAIR|PAR):\s*([A-Z0-9\/]+)/i) || sigText.match(/\b(XAU\/?USD|GOLD|EUR\/?USD|GBP\/?USD|BTC\/?USD|US30|NAS100)\b/i);
    const pair = pairMatch ? pairMatch[1] : 'GOLD/XAUUSD';

    stats.details.push({
      id: sigId,
      date: sigDate,
      pair,
      hitTp1: hitTp1 || hitTp2,
      hitTp2,
      hitSl,
      status: hitTp2 ? 'TP2 HIT 🎯🎯' : hitTp1 ? 'TP1 HIT 🎯' : hitSl ? 'SL HIT 🛑' : 'Sin confirmación explícita ❓'
    });
  });

  const avgRrTp1 = validRrCount > 0 ? (totalRrTp1 / validRrCount).toFixed(2) : 'N/A';
  const avgRrTp2 = validRrCount > 0 ? (totalRrTp2 / validRrCount).toFixed(2) : 'N/A';

  console.log('\n======================================================');
  console.log(`📊 ESTADÍSTICAS DEL CANAL: "${targetDialog.title}"`);
  console.log('======================================================');
  console.log(`Total de señales analizadas: ${stats.totalSignals}`);
  console.log(`🎯 Hit TP1 o superior: ${stats.details.filter(d => d.hitTp1).length} (${((stats.details.filter(d => d.hitTp1).length / (stats.totalSignals || 1)) * 100).toFixed(1)}%)`);
  console.log(`🎯🎯 Hit TP2 (Objetivo Completo): ${stats.tp2Hit} (${((stats.tp2Hit / (stats.totalSignals || 1)) * 100).toFixed(1)}%)`);
  console.log(`🛑 Hit Stop Loss (SL): ${stats.slHit} (${((stats.slHit / (stats.totalSignals || 1)) * 100).toFixed(1)}%)`);
  console.log(`❓ Sin resultado / En curso: ${stats.unknown} (${((stats.unknown / (stats.totalSignals || 1)) * 100).toFixed(1)}%)`);
  console.log('------------------------------------------------------');
  console.log(`📐 Ratio Riesgo:Beneficio (RR) Promedio:`);
  console.log(`   👉 TP1 vs SL: 1 : ${avgRrTp1} ${parseFloat(avgRrTp1) >= 1 ? '✅ (Supera el 1:1)' : '⚠️ (Inferior a 1:1)'}`);
  console.log(`   👉 TP2 vs SL: 1 : ${avgRrTp2}`);
  console.log('======================================================\n');

  console.log('Desglose de las últimas 10 señales:');
  stats.details.slice(0, 10).forEach((d) => {
    console.log(`- [${d.date}] ${d.pair} | Resultado: ${d.status}`);
  });

  process.exit(0);
})();
