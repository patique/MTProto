const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const targetChannels = [
  { name: 'Elite Gold Mines', identifier: '-1001695324069' },
  { name: '𝐗𝐀𝐔𝐔𝐒𝐃 𝐅𝐎𝐑𝐄𝐗 𝐓𝐑𝐀𝐃𝐈𝐍𝐆 ™', identifier: 'kingFxGoldTeam786' },
  { name: '𝙁𝙓 𝙋𝙍𝙊 𝙎𝙄𝙂𝙉𝘼𝙇 𝙏𝙀𝘼𝙈 ♛', identifier: 'XAUFxproSignalS' },
  { name: 'Ai Premium Pips', identifier: '-1003862726389' },
  { name: 'G.S Market Analysis', identifier: 'GSmarketanalysis' },
  { name: '𝙎𝙢𝙖𝙧𝙩 𝙋𝙞𝙥𝙨 𝘼𝙡𝙚𝙧𝙩𝙨', identifier: 'Smartpipsalrets71' },
];

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const results = [];

  for (const ch of targetChannels) {
    console.log(`\n======================================================`);
    console.log(`🔎 Analizando canal: "${ch.name}" (${ch.identifier})...`);
    console.log(`======================================================`);

    try {
      let entity;
      if (ch.identifier.startsWith('-')) {
        const dialogs = await client.getDialogs({});
        const found = dialogs.find((d) => d.id.toString() === ch.identifier || (d.entity && d.entity.id && d.entity.id.toString().includes(ch.identifier.replace('-100', ''))));
        if (found) entity = found.entity;
        else entity = await client.getEntity(ch.identifier);
      } else {
        entity = await client.getEntity(ch.identifier);
      }

      let allMessages = [];
      let offsetId = 0;
      const limit = 100;

      for (let i = 0; i < 10; i++) { // Hasta 1000 mensajes por canal
        const msgs = await client.getMessages(entity, { limit, offsetId });
        if (!msgs || msgs.length === 0) break;
        allMessages.push(...msgs);
        offsetId = msgs[msgs.length - 1].id;
        if (msgs.length < limit) break;
      }

      console.log(`Mensajes analizados: ${allMessages.length}`);

      // Filtrar señales
      const signals = [];
      allMessages.forEach((m) => {
        const text = m.message || '';
        const upper = text.toUpperCase();
        if ((upper.includes('BUY') || upper.includes('SELL')) && (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS') || upper.includes('TARGET'))) {
          signals.push(m);
        }
      });

      console.log(`Señales detectadas: ${signals.length}`);

      let tp1Hit = 0;
      let tp2Hit = 0;
      let slHit = 0;
      let unknown = 0;

      let totalRrTp1 = 0;
      let validRrCount = 0;

      signals.forEach((sig) => {
        const sigId = sig.id;
        const text = sig.message || '';

        const entryMatch = text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i) || text.match(/(?:ENTRY|ENTRADA|PRICE):\s*([\d\.\-]+)/i);
        const tp1Match = text.match(/(?:TP1|TP 1|TARGET 1|TP):\s*([\d\.]+)/i);
        const slMatch = text.match(/(?:SL|STOP LOSS):\s*([\d\.]+)/i);

        if (entryMatch && slMatch && tp1Match) {
          let entryVal = entryMatch[2] ? parseFloat(entryMatch[2]) : parseFloat(entryMatch[1]);
          if (isNaN(entryVal) && text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)) {
            const m = text.match(/(?:SELL|BUY)\s+([\d\.]+)/i);
            if (m) entryVal = parseFloat(m[1]);
          }
          const tp1Val = parseFloat(tp1Match[1]);
          const slVal = parseFloat(slMatch[1]);

          if (!isNaN(entryVal) && !isNaN(slVal) && !isNaN(tp1Val)) {
            const risk = Math.abs(entryVal - slVal);
            const reward1 = Math.abs(entryVal - tp1Val);

            if (risk > 0 && reward1 > 0) {
              totalRrTp1 += (reward1 / risk);
              validRrCount++;
            }
          }
        }

        // Buscar resultados posteriores
        const replies = allMessages.filter((m) => m.replyTo && m.replyTo.replyToMsgId === sigId);
        let hit1 = false;
        let hit2 = false;
        let hitSl = false;

        replies.forEach((rep) => {
          const r = (rep.message || '').toUpperCase();
          if (r.includes('TP1') || r.includes('TP 1') || r.includes('FIRST TP') || r.includes('DONE') || r.includes('HIT') || r.includes('PIPS')) hit1 = true;
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
            if ((r.includes('BUY') || r.includes('SELL')) && r.includes('ENTRY')) break;
            if (r.includes('TP1') || r.includes('TP 1') || r.includes('FIRST TP') || r.includes('PIPS DONE') || r.includes('PROFIT') || r.includes('HIT')) hit1 = true;
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

      const totalSig = signals.length || 1;
      const tp1Pct = (( (tp1Hit + tp2Hit) / totalSig) * 100).toFixed(1);
      const tp2Pct = ((tp2Hit / totalSig) * 100).toFixed(1);
      const slPct = ((slHit / totalSig) * 100).toFixed(1);
      const avgRr1 = validRrCount > 0 ? (totalRrTp1 / validRrCount).toFixed(2) : '1:1.20';

      console.log(`📊 Tasa acierto TP1: ${tp1Pct}% | TP2: ${tp2Pct}% | SL: ${slPct}% | RR TP1 Promedio: 1:${avgRr1}`);

      results.push({
        name: ch.name,
        signalsCount: signals.length,
        tp1Pct: `${tp1Pct}%`,
        tp2Pct: `${tp2Pct}%`,
        slPct: `${slPct}%`,
        avgRr1: `1 : ${avgRr1}`
      });
    } catch (e) {
      console.log(`Error al analizar ${ch.name}: ${e.message}`);
    }
  }

  console.log('\n======================================================');
  console.log('📋 RESUMEN FINAL DE CANALES SELECCIONADOS');
  console.log('======================================================');
  console.table(results);

  process.exit(0);
})();
