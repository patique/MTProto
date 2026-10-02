const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

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

  console.log('⚡ === BACKTEST HISTÓRICO DE CANALES APROBADOS ($100,000 USD / 1% RIESGO / 100% TP1) ===\n');

  const backtestResults = [];

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

      for (let i = 0; i < 5; i++) { // 500 mensajes por canal
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

      let balance = 100000;
      const riskPercent = 1.0;
      let wins = 0;
      let losses = 0;
      let maxBalance = 100000;
      let maxDrawdown = 0;

      signals.reverse().forEach((sig) => {
        const sigId = sig.id;
        const text = sig.message || '';

        const entryMatch = text.match(/(?:ENTRY PRICE|ENTRY|ENTRADA|PRICE):\s*([\d\.\-]+)/i) || text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i);
        const slMatch = text.match(/(?:STOP LOSS|SL):\s*([\d\.]+)/i);
        const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TP 1|TARGET 1):\s*([\d\.]+)/i);

        let riskRatio = 1.20;

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
            if (r > 0 && w > 0) riskRatio = w / r;
          }
        }

        const subs = allMessages.filter((m) => m.id > sigId && m.id < sigId + 25);
        let hitTp1 = false;
        let hitSl = false;

        subs.forEach((m) => {
          const r = (m.message || '').toUpperCase();
          if (r.includes('TP1') || r.includes('FIRST TP') || r.includes('PIPS SECURED') || r.includes('TP 1') || r.includes('TARGET 1') || r.includes('ALL TP')) hitTp1 = true;
          if (r.includes('SL HIT') || r.includes('STOP LOSS')) hitSl = true;
        });

        const riskDollars = (balance * riskPercent) / 100;

        if (hitTp1) {
          wins++;
          balance += (riskDollars * riskRatio);
        } else if (hitSl) {
          losses++;
          balance -= riskDollars;
        } else {
          wins++;
          balance += (riskDollars * riskRatio);
        }

        if (balance > maxBalance) maxBalance = balance;
        const dd = ((maxBalance - balance) / maxBalance) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
      });

      const netProfit = balance - 100000;
      const winRate = signals.length > 0 ? ((wins / signals.length) * 100).toFixed(1) : '0';

      backtestResults.push({
        Canal: ch.name,
        Señales: signals.length,
        'Ganadas (TP1)': wins,
        'Perdidas (SL)': losses,
        'Tasa Acierto': `${winRate}%`,
        'Saldo Final': `$${Math.round(balance).toLocaleString()} USD`,
        'Beneficio Neto': `${netProfit >= 0 ? '+' : ''}$${Math.round(netProfit).toLocaleString()} USD`,
        'Max Drawdown': `${maxDrawdown.toFixed(1)}%`
      });

    } catch (e) {
      console.log(`Error al procesar ${ch.name}: ${e.message}`);
    }
  }

  console.log('\n========================================================================================');
  console.log('📊 RESULTADOS DEL BACKTEST ($100,000 USD INICIALES / CANALES APROBADOS / ESTRATEGIA 100% TP1)');
  console.log('========================================================================================\n');
  console.table(backtestResults);

  process.exit(0);
})();
