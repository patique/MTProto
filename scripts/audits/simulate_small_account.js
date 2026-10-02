const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const channelsToSimulate = [
  { name: 'MARCO TRADING HUB', identifier: 'Marcotradinhub' },
  { name: 'XAUUSD FOREX TRADING', identifier: 'kingFxGoldTeam786' },
  { name: 'FX PRO SIGNAL TEAM', identifier: 'XAUFxproSignalS' },
  { name: 'Fx Community', identifier: '3740495617' },
  { name: 'Smart Pips Alerts', identifier: 'Smartpipsalrets71' },
];

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('⚡ === SIMULACIÓN DE CUENTA DE 100€ CON INTERÉS COMPUESTO (VT MARKETS) ===\n');

  let initialBalance = 100; // 100 €
  let currentBalance = initialBalance;
  const riskPercent = 1.0;  // 1% riesgo base

  let totalTrades = 0;
  let winTrades = 0;
  let lossTrades = 0;
  let peakBalance = initialBalance;
  let maxDrawdownEuro = 0;
  let maxDrawdownPct = 0;

  const tradeHistory = [];

  for (const ch of channelsToSimulate) {
    try {
      let entity;
      if (ch.identifier.match(/^\d+$/)) {
        const dialogs = await client.getDialogs({});
        const found = dialogs.find((d) => d.id.toString().includes(ch.identifier));
        if (found) entity = found.entity;
        else entity = await client.getEntity(ch.identifier);
      } else {
        entity = await client.getEntity(ch.identifier);
      }

      const msgs = await client.getMessages(entity, { limit: 200 });
      const signals = [];
      msgs.forEach((m) => {
        const text = m.message || '';
        const upper = text.toUpperCase();
        if ((upper.includes('BUY') || upper.includes('SELL')) && (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS'))) {
          signals.push(m);
        }
      });

      signals.reverse().forEach((sig) => {
        const text = sig.message || '';
        const entryMatch = text.match(/(?:ENTRY PRICE|ENTRY|ENTRADA|PRICE):\s*([\d\.\-]+)/i) || text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([A-Z0-9\/]+)?\s*@?\s*([\d\.\-]+)/i);
        const slMatch = text.match(/(?:STOP LOSS|SL):\s*([\d\.]+)/i);
        const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TP 1|TARGET 1):\s*([\d\.]+)/i);

        let entryVal = 4330, slVal = 4320, tp1Val = 4335;
        if (entryMatch && slMatch && tp1Match) {
          entryVal = entryMatch[1] ? parseFloat(entryMatch[1]) : parseFloat(entryMatch[2]);
          slVal = parseFloat(slMatch[1]);
          tp1Val = parseFloat(tp1Match[1]);
        }

        const slPips = Math.abs(entryVal - slVal) || 10;
        const tpPips = Math.abs(entryVal - tp1Val) || 12;

        // Cálculo de lotaje con Interés Compuesto
        // Riesgo ideal al 1%:
        const idealRiskEuros = (currentBalance * riskPercent) / 100;
        // Lote dinámico (1 lote XAUUSD = 100€ por punto)
        let calcLot = idealRiskEuros / (slPips * 100);

        // Mínimo de VT Markets = 0.01 lotes
        const actualLot = Math.max(0.01, Math.floor(calcLot * 100) / 100);

        // Evaluar resultado en mensajes
        const subs = msgs.filter((m) => m.id > sig.id && m.id < sig.id + 20);
        let isWin = true;
        subs.forEach((m) => {
          const r = (m.message || '').toUpperCase();
          if (r.includes('SL HIT') || r.includes('STOP LOSS')) isWin = false;
        });

        // Calcular PnL en Euros
        let pnlEuros = 0;
        if (isWin) {
          pnlEuros = tpPips * actualLot * 100;
          winTrades++;
        } else {
          pnlEuros = -(slPips * actualLot * 100);
          lossTrades++;
        }

        currentBalance += pnlEuros;
        totalTrades++;

        if (currentBalance > peakBalance) peakBalance = currentBalance;
        const ddEuro = peakBalance - currentBalance;
        const ddPct = (ddEuro / peakBalance) * 100;
        if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

        if (totalTrades % 25 === 0 || totalTrades === 1 || totalTrades === 100) {
          tradeHistory.push({
            Trade: `#${totalTrades}`,
            Canal: ch.name,
            Lotes: actualLot,
            Resultado: isWin ? '✅ TP1 HIT' : '🛑 SL HIT',
            'PnL (€)': `${pnlEuros >= 0 ? '+' : ''}${pnlEuros.toFixed(2)} €`,
            'Saldo Actual (€)': `${currentBalance.toFixed(2)} €`
          });
        }
      });
    } catch (e) {
      console.log(`Error en ${ch.name}: ${e.message}`);
    }
  }

  console.log('========================================================================================');
  console.log(`📈 EVOLUCIÓN DEL INTERÉS COMPUESTO (100€ INICIALES EN VT MARKETS)`);
  console.log('========================================================================================\n');
  console.table(tradeHistory);

  const profitTotal = currentBalance - initialBalance;
  const returnPct = ((profitTotal / initialBalance) * 100).toFixed(1);

  console.log('\n======================================================');
  console.log(`📊 RESUMEN FINAL DE LA SIMULACIÓN 100€`);
  console.log('======================================================');
  console.log(`Depósito Inicial: 100,00 €`);
  console.log(`Total Operaciones Ejecutadas: ${totalTrades}`);
  console.log(`Operaciones Ganadas: ${winTrades} (${((winTrades/totalTrades)*100).toFixed(1)}%)`);
  console.log(`Operaciones Perdidas: ${lossTrades} (${((lossTrades/totalTrades)*100).toFixed(1)}%)`);
  console.log(`------------------------------------------------------`);
  console.log(`💰 Saldo Final de la Cuenta: ${currentBalance.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
  console.log(`📈 Beneficio Neto Ganado: +${profitTotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} € (+${returnPct}%)`);
  console.log(`🛡️ Retroceso Máximo (Max Drawdown): ${maxDrawdownPct.toFixed(1)}%`);
  console.log('======================================================\n');

  process.exit(0);
})();
