const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const approvedChannels = [
  { name: 'MARCO TRADING HUB', id: 'Marcotradinhub' },
  { name: 'Aliens- Royal fx', id: '-1003915769321' },
  { name: 'Fx Community', id: '3740495617' },
  { name: 'Smart Pips Alerts', id: 'Smartpipsalrets71' },
  { name: 'XAUUSD FOREX TRADING', id: 'kingFxGoldTeam786' },
  { name: 'FX PRO SIGNAL TEAM', id: 'XAUFxproSignalS' },
  { name: 'Ai Premium Pips', id: '-1003862726389' },
  { name: 'G.S Market Analysis', id: 'GSmarketanalysis' },
  { name: 'Risk Management-revealed', id: 'Risk_Management_revealed' },
];

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('⚡ === DESGLOSE INDIVIDUAL POR CANAL DE TELEGRAM ===\n');

  const report = [];

  for (const ch of approvedChannels) {
    try {
      let entity;
      if (ch.id.startsWith('-') || ch.id.match(/^\d+$/)) {
        const dialogs = await client.getDialogs({});
        const found = dialogs.find((d) => d.id.toString().includes(ch.id.replace('-100', '')));
        if (found) entity = found.entity;
        else entity = await client.getEntity(ch.id);
      } else {
        entity = await client.getEntity(ch.id);
      }

      let msgs = [];
      let offsetId = 0;
      for (let i = 0; i < 5; i++) {
        const batch = await client.getMessages(entity, { limit: 100, offsetId });
        if (!batch || batch.length === 0) break;
        msgs.push(...batch);
        offsetId = batch[batch.length - 1].id;
      }

      const signals = [];
      msgs.forEach((m) => {
        const text = m.message || '';
        const upper = text.toUpperCase();
        if ((upper.includes('BUY') || upper.includes('SELL')) && (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS'))) {
          signals.push(m);
        }
      });

      let wins = 0, losses = 0, totalRr = 0, rrCount = 0;

      signals.forEach((sig) => {
        const text = sig.message || '';
        const entryMatch = text.match(/(?:ENTRY PRICE|ENTRY|ENTRADA|PRICE):\s*([\d\.\-]+)/i) || text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i);
        const slMatch = text.match(/(?:STOP LOSS|SL):\s*([\d\.]+)/i);
        const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TP 1|TARGET 1):\s*([\d\.]+)/i);

        if (entryMatch && slMatch && tp1Match) {
          let entryVal = entryMatch[1] ? parseFloat(entryMatch[1]) : parseFloat(entryMatch[2]);
          if (isNaN(entryVal) && text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)) {
            const m = text.match(/(?:SELL|BUY)\s+([\d\.]+)/i);
            if (m) entryVal = parseFloat(m[1]);
          }
          const slVal = parseFloat(slMatch[1]);
          const tp1Val = parseFloat(tp1Match[1]);

          if (!isNaN(entryVal) && !isNaN(slVal) && !isNaN(tp1Val)) {
            const r = Math.abs(entryVal - slVal);
            const w = Math.abs(entryVal - tp1Val);
            if (r > 0 && w > 0) {
              totalRr += (w / r);
              rrCount++;
            }
          }
        }

        const subs = msgs.filter((m) => m.id > sig.id && m.id < sig.id + 25);
        let isWin = false;
        let isLoss = false;

        subs.forEach((m) => {
          const r = (m.message || '').toUpperCase();
          if (r.includes('TP1') || r.includes('FIRST TP') || r.includes('PIPS SECURED') || r.includes('TP 1') || r.includes('TARGET 1') || r.includes('ALL TP')) isWin = true;
          if (r.includes('SL HIT') || r.includes('STOP LOSS')) isLoss = true;
        });

        if (isLoss) losses++;
        else wins++;
      });

      const total = signals.length || 1;
      const winRate = ((wins / total) * 100).toFixed(1);
      const avgRr = rrCount > 0 ? (totalRr / rrCount).toFixed(2) : '1:1.20';
      const newestDate = msgs.length > 0 ? new Date(msgs[0].date * 1000).toLocaleDateString() : 'N/A';
      const oldestDate = msgs.length > 0 ? new Date(msgs[msgs.length - 1].date * 1000).toLocaleDateString() : 'N/A';

      report.push({
        Canal: ch.name,
        Señales: signals.length,
        'Ganadas (TP1)': wins,
        'Perdidas (SL)': losses,
        'Acierto TP1 (%)': `${winRate}%`,
        'Ratio R:R Promedio': `1 : ${avgRr}`,
        'Rango Fechas': `${oldestDate} ➔ ${newestDate}`
      });

    } catch (e) {
      console.log(`Error en ${ch.name}: ${e.message}`);
    }
  }

  console.table(report);
  process.exit(0);
})();
