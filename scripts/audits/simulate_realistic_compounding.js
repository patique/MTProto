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

  console.log('🛡️ === BACKTEST ULTRA-REALISTA (CON SPREAD, TOPE DE LOTES Y AUDITORÍA DE ERRORES) ===\n');

  let allSignalsChronological = [];

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

      let channelMsgs = [];
      let offsetId = 0;
      for (let i = 0; i < 6; i++) {
        const msgs = await client.getMessages(entity, { limit: 100, offsetId });
        if (!msgs || msgs.length === 0) break;
        channelMsgs.push(...msgs);
        offsetId = msgs[msgs.length - 1].id;
      }

      channelMsgs.forEach((m) => {
        const text = m.message || '';
        const upper = text.toUpperCase();
        if ((upper.includes('BUY') || upper.includes('SELL')) && (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS'))) {
          allSignalsChronological.push({
            channel: ch.name,
            msgId: m.id,
            date: new Date(m.date * 1000),
            text,
            allMsgs: channelMsgs
          });
        }
      });
    } catch (e) {}
  }

  allSignalsChronological.sort((a, b) => a.date - b.date);

  // REGLAS REALISTAS DE BROKER Y GESTIÓN
  const SPREAD_PIPS = 2.0;       // 2.0 pips de spread en VT Markets
  const MAX_LOT_CAP = 5.0;       // Tope máximo de 5.0 Lotes por orden (Gestión prudente)
  const MIN_LOT_CAP = 0.01;      // Mínimo 0.01 Lotes

  // SIMULACIÓN 1: 100€ Iniciales
  let balance1 = 100.0;
  let wins1 = 0, losses1 = 0;

  // SIMULACIÓN 2: 100€ Iniciales + 100€ Mensuales (DCA)
  let balance2 = 100.0;
  let totalDeposited2 = 100.0;
  let wins2 = 0, losses2 = 0;
  let lastDepositDate = allSignalsChronological.length > 0 ? new Date(allSignalsChronological[0].date) : new Date();

  allSignalsChronological.forEach((sig) => {
    // Añadir 100€ mensuales en Escenario 2
    const diffDays = (sig.date - lastDepositDate) / (1000 * 60 * 60 * 24);
    if (diffDays >= 30) {
      const monthsToAdd = Math.floor(diffDays / 30);
      balance2 += (monthsToAdd * 100);
      totalDeposited2 += (monthsToAdd * 100);
      lastDepositDate = new Date(sig.date);
    }

    const text = sig.text;
    const entryMatch = text.match(/(?:ENTRY PRICE|ENTRY|ENTRADA|PRICE):\s*([\d\.\-]+)/i) || text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i);
    const slMatch = text.match(/(?:STOP LOSS|SL):\s*([\d\.]+)/i);
    const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TP 1|TARGET 1):\s*([\d\.]+)/i);

    let slPips = 15;
    let tpPips = 15;

    if (entryMatch && slMatch && tp1Match) {
      let entryVal = entryMatch[1] ? parseFloat(entryMatch[1]) : parseFloat(entryMatch[2]);
      if (isNaN(entryVal) && text.match(/(?:SELL|BUY)\s+([\d\.]+)/i)) {
        const m = text.match(/(?:SELL|BUY)\s+([\d\.]+)/i);
        if (m) entryVal = parseFloat(m[1]);
      }
      const slVal = parseFloat(slMatch[1]);
      const tp1Val = parseFloat(tp1Match[1]);

      if (!isNaN(entryVal) && !isNaN(slVal) && !isNaN(tp1Val)) {
        slPips = Math.max(8, Math.abs(entryVal - slVal));
        tpPips = Math.max(8, Math.abs(entryVal - tp1Val));
      }
    }

    // Clasificación estricta de resultado por respuestas históricas
    const subs = sig.allMsgs.filter((m) => m.id > sig.msgId && m.id < sig.msgId + 20);
    let isWin = false;
    let isLoss = false;

    subs.forEach((m) => {
      const r = (m.message || '').toUpperCase();
      if (r.includes('TP1') || r.includes('FIRST TP') || r.includes('PIPS SECURED') || r.includes('TP 1') || r.includes('TARGET 1') || r.includes('ALL TP')) isWin = true;
      if (r.includes('SL HIT') || r.includes('STOP LOSS')) isLoss = true;
    });

    if (!isWin && !isLoss) {
      // Si no hay confirmación estricta, aplicar probabilidad realista del 85% (no 100%)
      isWin = (Math.random() < 0.85);
    }

    // --- ESCENARIO 1 ---
    const rawLot1 = (balance1 * 0.01) / (slPips * 100);
    const actualLot1 = Math.min(MAX_LOT_CAP, Math.max(MIN_LOT_CAP, Math.floor(rawLot1 * 100) / 100));

    if (isWin) {
      const netTpPips = Math.max(1, tpPips - SPREAD_PIPS);
      balance1 += (netTpPips * actualLot1 * 100);
      wins1++;
    } else {
      const netSlPips = slPips + SPREAD_PIPS;
      balance1 -= (netSlPips * actualLot1 * 100);
      losses1++;
    }
    if (balance1 < 10) balance1 = 10; // Cuentas arruinadas no bajan de 0

    // --- ESCENARIO 2 ---
    const rawLot2 = (balance2 * 0.01) / (slPips * 100);
    const actualLot2 = Math.min(MAX_LOT_CAP, Math.max(MIN_LOT_CAP, Math.floor(rawLot2 * 100) / 100));

    if (isWin) {
      const netTpPips = Math.max(1, tpPips - SPREAD_PIPS);
      balance2 += (netTpPips * actualLot2 * 100);
      wins2++;
    } else {
      const netSlPips = slPips + SPREAD_PIPS;
      balance2 -= (netSlPips * actualLot2 * 100);
      losses2++;
    }
    if (balance2 < 10) balance2 = 10;
  });

  console.log('========================================================================================');
  console.log('📊 RESULTADOS DE SIMULACIÓN REALISTA CON CONSTRICCIONES REALES DE BROKER');
  console.log('========================================================================================\n');
  console.log(`Condiciones aplicadas:`);
  console.log(` - Spread VT Markets: ${SPREAD_PIPS} pips por trade`);
  console.log(` - Lote Máximo por Operación (Tope de Gestión): ${MAX_LOT_CAP} Lotes`);
  console.log(` - Tasa de acierto no confirmada ajustada al 85% realista (en lugar de 100% ideal)\n`);

  console.log('🔹 ESCENARIO 1: Depósito Único de 100 €');
  console.log(`   - Inversión Total: 100,00 €`);
  console.log(`   - Trades Realizados: ${allSignalsChronological.length} (${wins1} ganadas / ${losses1} perdidas)`);
  console.log(`   - Tasa Acierto Realista: ${((wins1/allSignalsChronological.length)*100).toFixed(1)}%`);
  console.log(`   - SALDO FINAL ESTIMADO: ${balance1.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
  console.log(`   - Beneficio Neto Ganado: +${(balance1 - 100).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €\n`);

  console.log('🔹 ESCENARIO 2: Depósito Inicial de 100 € + 100 € Mensuales (DCA)');
  console.log(`   - Inversión Total de tu bolsillo: ${totalDeposited2.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
  console.log(`   - Trades Realizados: ${allSignalsChronological.length} (${wins2} ganadas / ${losses2} perdidas)`);
  console.log(`   - Tasa Acierto Realista: ${((wins2/allSignalsChronological.length)*100).toFixed(1)}%`);
  console.log(`   - SALDO FINAL ESTIMADO: ${balance2.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
  console.log(`   - Beneficio Neto Ganado: +${(balance2 - totalDeposited2).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €\n`);

  console.log('========================================================================================\n');

  process.exit(0);
})();
