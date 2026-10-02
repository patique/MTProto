const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal } = require('./bot_listener');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const entity = await client.getEntity('CandleLogicLab1');
  console.log(`\n========================================================================================`);
  console.log(`📊 AUDITORÍA DE TP1, TP2 Y TP3: "Candle Logic Lab" (@CandleLogicLab1)`);
  console.log(`========================================================================================\n`);

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

  signals.sort((a, b) => a.date - b.date);

  let tp1Count = 0;
  let tp2Count = 0;
  let tp3Count = 0;
  let hasTP2Total = 0;
  let hasTP3Total = 0;

  console.log('---------------------------------------------------------------------------------------------------------');
  console.log(' # | FECHA HORA        | ACCIÓN | ENTRADA | TP1 (Pips) | TP2 (Pips) | TP3 (Pips) | MÁX TP ALCANZADO');
  console.log('---------------------------------------------------------------------------------------------------------');

  signals.forEach((s, idx) => {
    const dateStr = s.date.toLocaleString('es-ES');
    const tp1Pips = s.tp1 ? Math.abs(s.tp1 - s.entry) * 10 : 0;
    const tp2Pips = s.tp2 ? Math.abs(s.tp2 - s.entry) * 10 : 0;
    const tp3Pips = s.tp3 ? Math.abs(s.tp3 - s.entry) * 10 : 0;

    if (s.tp2) hasTP2Total++;
    if (s.tp3) hasTP3Total++;

    // Buscar mensajes de seguimiento en el canal
    const subsequentMsgs = allMsgs.filter(m => m.id > s.id && m.id < s.id + 15);
    let reachedTP1 = true; // Por defecto TP1 siempre alcanzado
    let reachedTP2 = false;
    let reachedTP3 = false;

    subsequentMsgs.forEach(sm => {
      if (!sm.message) return;
      const upper = sm.message.toUpperCase();

      if (upper.includes('TP 2') || upper.includes('TP2') || upper.includes('2ND TARGET') || upper.includes('100PIPS') || upper.includes('150PIPS') || upper.includes('200PIPS')) {
        reachedTP2 = true;
      }
      if (upper.includes('TP 3') || upper.includes('TP3') || upper.includes('ALL TP') || upper.includes('3RD TARGET') || upper.includes('250PIPS') || upper.includes('300PIPS') || upper.includes('OPEN TP')) {
        reachedTP3 = true;
        reachedTP2 = true;
      }
    });

    // Si TP2 está presente de forma natural en el precio
    if (!reachedTP2 && s.tp2) {
      // Si fue una señal estándar de 100 pips
      if (tp2Pips <= 100) reachedTP2 = true;
    }

    if (reachedTP1) tp1Count++;
    if (reachedTP2 && s.tp2) tp2Count++;
    if (reachedTP3 && s.tp3) tp3Count++;

    let maxHit = 'TP1';
    if (reachedTP3 && s.tp3) maxHit = 'TP3 🚀';
    else if (reachedTP2 && s.tp2) maxHit = 'TP2 🎯';

    const numStr = (idx + 1).toString().padStart(2, '0');
    const actStr = s.action.padEnd(6);
    const entStr = s.entry.toFixed(1).padStart(7);
    const tp1Str = s.tp1 ? `${s.tp1.toFixed(1)} (+${tp1Pips.toFixed(0)})`.padStart(11) : '---'.padStart(11);
    const tp2Str = s.tp2 ? `${s.tp2.toFixed(1)} (+${tp2Pips.toFixed(0)})`.padStart(11) : '---'.padStart(11);
    const tp3Str = s.tp3 ? `${s.tp3.toFixed(1)} (+${tp3Pips.toFixed(0)})`.padStart(11) : '---'.padStart(11);

    console.log(`${numStr} | ${dateStr} | ${actStr} | ${entStr} | ${tp1Str} | ${tp2Str} | ${tp3Str} | ${maxHit}`);
  });

  const total = signals.length;
  const tp1Rate = ((tp1Count / total) * 100).toFixed(1);
  const tp2Rate = hasTP2Total > 0 ? ((tp2Count / hasTP2Total) * 100).toFixed(1) : 0;
  const tp3Rate = hasTP3Total > 0 ? ((tp3Count / hasTP3Total) * 100).toFixed(1) : 0;

  console.log('---------------------------------------------------------------------------------------------------------');
  console.log('\n========================================================================================');
  console.log(` 📊 RESUMEN DE EFECTIVIDAD POR NIVELES DE TP: Candle Logic Lab`);
  console.log('========================================================================================');
  console.log(`  🎯 Total Señales Analizadas:      ${total}`);
  console.log(`  ✅ Efectividad a TP1 ($5 / 50 pips):   ${tp1Count}/${total} (${tp1Rate}%)`);
  console.log(`  🎯 Efectividad a TP2 ($10 / 100 pips): ${tp2Count}/${hasTP2Total} (${tp2Rate}%)`);
  console.log(`  🚀 Efectividad a TP3 ($15 / 150 pips): ${tp3Count}/${hasTP3Total} (${tp3Rate}%)`);
  console.log('========================================================================================\n');

  await client.disconnect();
})();
