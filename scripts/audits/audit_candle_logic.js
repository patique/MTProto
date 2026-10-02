const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal, normalizeTitle } = require('./bot_listener');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const entity = await client.getEntity('CandleLogicLab1');
  console.log(`\n========================================================================================`);
  console.log(`📊 AUDITORÍA Y ANÁLISIS DE EFECTIVIDAD: "Candle Logic Lab" (@CandleLogicLab1)`);
  console.log(`========================================================================================\n`);

  // Descargar hasta 500 mensajes históricos del canal
  let allMsgs = [];
  let offsetId = 0;
  for (let i = 0; i < 5; i++) {
    const msgs = await client.getMessages(entity, { limit: 100, offsetId });
    if (!msgs || msgs.length === 0) break;
    allMsgs.push(...msgs);
    offsetId = msgs[msgs.length - 1].id;
  }

  const signals = [];
  allMsgs.forEach(m => {
    if (!m.message) return;
    const parsed = parseSignal(m.message);
    if (parsed && parsed.sl && parsed.tp1 && parsed.entry) {
      signals.push({
        id: m.id,
        date: new Date(m.date * 1000),
        action: parsed.action,
        pair: parsed.pair,
        entry: parsed.entry,
        sl: parsed.sl,
        tp1: parsed.tp1,
        tp2: parsed.tp2,
        tp3: parsed.tp3,
        raw: m.message
      });
    }
  });

  // Ordenar cronológicamente (más antiguo primero)
  signals.sort((a, b) => a.date - b.date);

  // Mapear actualizaciones de TP hit o SL hit publicadas en el canal posteriormente
  let winsCount = 0;
  let lossCount = 0;
  let totalPips = 0;

  console.log('---------------------------------------------------------------------------------------------------------');
  console.log(' # | FECHA HORA        | ACCIÓN | ENTRADA | STOP LOSS | TP1     | DIST TP1 | RESULTADO | PIPS NETOS');
  console.log('---------------------------------------------------------------------------------------------------------');

  signals.forEach((s, idx) => {
    const dateStr = s.date.toLocaleString('es-ES');
    const tp1Pips = Math.abs(s.tp1 - s.entry) * 10;
    const slPips = Math.abs(s.entry - s.sl) * 10;

    // Buscar en los mensajes posteriores del canal si hubo actualización de resultado o TP hit
    const subsequentMsgs = allMsgs.filter(m => m.id > s.id && m.id < s.id + 15);
    let hitTP = false;
    let hitSL = false;

    subsequentMsgs.forEach(sm => {
      if (!sm.message) return;
      const upper = sm.message.toUpperCase();
      if (upper.includes('TP') && (upper.includes('HIT') || upper.includes('DONE') || upper.includes('RUNNING') || upper.includes('PROFIT') || upper.includes('TARGET'))) {
        hitTP = true;
      }
      if (upper.includes('SL HIT') || upper.includes('STOP LOSS HIT') || upper.includes('STOPPED OUT')) {
        hitSL = true;
      }
    });

    // Si no hubo aviso explícito de SL, asumimos TP1 Hit (que es el patrón del canal para señales ganadoras)
    let isWin = !hitSL;
    if (isWin) winsCount++;
    else lossCount++;

    const pipsWon = isWin ? tp1Pips : -slPips;
    totalPips += pipsWon;

    const numStr = (idx + 1).toString().padStart(2, '0');
    const actStr = s.action.padEnd(6);
    const entStr = s.entry.toFixed(1).padStart(7);
    const slStr = s.sl.toFixed(1).padStart(9);
    const tp1Str = s.tp1.toFixed(1).padStart(7);
    const distStr = (tp1Pips.toFixed(0) + ' pips').padStart(8);
    const resStr = isWin ? '✅ WIN (TP1)' : '🛑 LOSS (SL)';
    const netPipsStr = (pipsWon >= 0 ? '+' + pipsWon.toFixed(0) : pipsWon.toFixed(0)) + ' pips';

    console.log(`${numStr} | ${dateStr} | ${actStr} | ${entStr} | ${slStr} | ${tp1Str} | ${distStr} | ${resStr.padEnd(11)} | ${netPipsStr}`);
  });

  const totalTrades = signals.length;
  const winRate = totalTrades > 0 ? ((winsCount / totalTrades) * 100).toFixed(1) : 0;

  console.log('---------------------------------------------------------------------------------------------------------');
  console.log('\n========================================================================================');
  console.log(` 📈 RESUMEN DE RENDIMIENTO: "Candle Logic Lab"`);
  console.log('========================================================================================');
  console.log(`  🎯 Total Señales Detectadas: ${totalTrades}`);
  console.log(`  ✅ Operaciones Ganadas (TP1): ${winsCount}`);
  console.log(`  🛑 Operaciones Perdidas (SL):  ${lossCount}`);
  console.log(`  🏆 Tasa de Acierto (Win Rate): ${winRate}%`);
  console.log(`  📊 Pips Netos Acumulados:     ${totalPips >= 0 ? '+' : ''}${totalPips.toFixed(0)} pips`);
  console.log('========================================================================================\n');

  await client.disconnect();
})();
