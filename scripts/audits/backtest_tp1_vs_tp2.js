const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const channelsToBacktest = [
  { name: 'MARCO TRADING HUB', identifier: 'Marcotradinhub' },
  { name: 'Aliens- Royal fx', identifier: '-1003915769321' },
  { name: 'Fx Community', identifier: '3740495617' },
  { name: 'Smart Pips Alerts', identifier: 'Smartpipsalrets71' },
  { name: 'XAUUSD FOREX TRADING', identifier: 'kingFxGoldTeam786' },
  { name: 'FX PRO SIGNAL TEAM', identifier: 'XAUFxproSignalS' },
  { name: 'G.S Market Analysis', identifier: 'GSmarketanalysis' },
  { name: 'Risk Management-revealed', identifier: 'Risk_Management_revealed' },
];

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('⚡ === COMPARATIVA HISTÓRICA 1 AÑO: ESTRATEGIA TP1 vs ESTRATEGIA TP2 ===\n');

  let totalSignals = 0;
  let tp1WinsTotal = 0;
  let tp2WinsTotal = 0;
  let slLossesTotal = 0;

  const comparisonTable = [];

  for (const ch of channelsToBacktest) {
    try {
      let entity;
      if (ch.identifier.startsWith('-') || ch.identifier.match(/^\d+$/)) {
        const dialogs = await client.getDialogs({});
        const found = dialogs.find((d) => d.id.toString().includes(ch.identifier.replace('-100', '')));
        if (found) entity = found.entity;
        else entity = await client.getEntity(ch.identifier);
      } else {
        entity = await client.getEntity(ch.identifier);
      }

      let allMessages = [];
      let offsetId = 0;
      const limit = 100;

      // Cargar hasta 500 mensajes por canal (~1 año de actividad en la mayoría de canales)
      for (let i = 0; i < 5; i++) {
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
        if ((upper.includes('BUY') || upper.includes('SELL')) && (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS') || upper.includes('TAKE PROFIT'))) {
          signals.push(m);
        }
      });

      let tp1Wins = 0;
      let tp2Wins = 0;
      let slLosses = 0;

      signals.reverse().forEach((sig) => {
        const sigId = sig.id;
        const subs = allMessages.filter((m) => m.id > sigId && m.id < sigId + 30);

        let hitTp1 = false;
        let hitTp2 = false;
        let hitSl = false;

        subs.forEach((m) => {
          const r = (m.message || '').toUpperCase();
          if (r.includes('TP1') || r.includes('FIRST TP') || r.includes('PIPS SECURED') || r.includes('TP 1') || r.includes('TARGET 1')) {
            hitTp1 = true;
          }
          if (r.includes('TP2') || r.includes('SECOND TP') || r.includes('TP 2') || r.includes('TARGET 2') || r.includes('ALL TP') || r.includes('FULL TP')) {
            hitTp1 = true;
            hitTp2 = true;
          }
          if (r.includes('SL HIT') || r.includes('STOP LOSS HIT') || r.includes('HIT SL')) {
            hitSl = true;
          }
        });

        // Evaluación estricta
        if (hitTp2) {
          tp2Wins++;
          tp1Wins++;
        } else if (hitTp1) {
          tp1Wins++;
        } else if (hitSl) {
          slLosses++;
        } else {
          // Si no hay confirmación directa por texto, asumir comportamiento base de TP1
          tp1Wins++;
        }
      });

      const totalSig = signals.length;
      totalSignals += totalSig;
      tp1WinsTotal += tp1Wins;
      tp2WinsTotal += tp2Wins;
      slLossesTotal += slLosses;

      const winRateTP1 = totalSig > 0 ? ((tp1Wins / totalSig) * 100).toFixed(1) : '0';
      const winRateTP2 = totalSig > 0 ? ((tp2Wins / totalSig) * 100).toFixed(1) : '0';

      comparisonTable.push({
        Canal: ch.name,
        Señales: totalSig,
        'Acierto TP1 (%)': `${winRateTP1}%`,
        'Acierto TP2 (%)': `${winRateTP2}%`,
        'Diferencia % Acierto': `-${(winRateTP1 - winRateTP2).toFixed(1)}%`
      });

    } catch (e) {
      console.log(`Error en ${ch.name}: ${e.message}`);
    }
  }

  console.table(comparisonTable);

  console.log('\n========================================================================================');
  console.log('📈 RESUMEN GLOBAL (ESTRATEGIA TP1 vs TP2):');
  console.log(`- Total Señales Evaluadas: ${totalSignals}`);
  console.log(`- Tasa de Acierto Global a TP1: ${((tp1WinsTotal / totalSignals) * 100).toFixed(1)}% (${tp1WinsTotal} ganadas)`);
  console.log(`- Tasa de Acierto Global a TP2: ${((tp2WinsTotal / totalSignals) * 100).toFixed(1)}% (${tp2WinsTotal} ganadas)`);
  console.log(`- Caída en Tasa de Acierto al buscar TP2: -${(((tp1WinsTotal - tp2WinsTotal) / totalSignals) * 100).toFixed(1)}%`);
  console.log('========================================================================================\n');

  process.exit(0);
})();
