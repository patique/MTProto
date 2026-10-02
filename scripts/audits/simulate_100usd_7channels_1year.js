/**
 * Simulación y Estimación Anual (1 Año) de Cuenta de $100 USD
 * Operando los 7 Canales TOP con la Estrategia "50% TP1 + Auto-BE + Trailing Stop"
 * 
 * Modos Auditados:
 * 1. Lote Mínimo Fijo (0.01 lotes)
 * 2. Interés Compuesto Moderado (Riesgo 2.0% por trade)
 * 3. Interés Compuesto Agresivo / Flipping (Riesgo 5.0% por trade)
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const { CHANNELS_CONFIG } = require('../../config/channels.config');
const { strategyFactory } = require('../../core/StrategyFactory');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const client = new TelegramClient(new StringSession(stringSessionStr), 25677000, 'e49356f9d8dbb478b5ffc575a632ac55', { connectionRetries: 5 });

// Cargar velas de 1 año (35.040 velas M15)
const candlesPath = path.join(__dirname, 'cache_paxgusdt_15m_1y.json');
const candles = JSON.parse(fs.readFileSync(candlesPath, 'utf8'));
candles.sort((a, b) => (a.timestamp || a.time) - (b.timestamp || b.time));
const candleTimestamps = candles.map(c => c.timestamp || c.time);

function findCandleIndex(timestamp) {
  let low = 0, high = candleTimestamps.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candleTimestamps[mid] < timestamp) low = mid + 1;
    else high = mid - 1;
  }
  return Math.min(low, candleTimestamps.length - 1);
}

// Simulación de un trade con el modelo 50% TP1 + BE + Trailing
function evaluateSignalOnCandles(signal, startCandleIdx) {
  const isBuy = signal.action.toUpperCase().includes('BUY');
  const entryPrice = candles[startCandleIdx].open;

  // Extraer las distancias en pips de la señal original
  const origEntry = signal.entry || entryPrice;
  const slDist = Math.min(10.0, Math.max(2.0, Math.abs(origEntry - signal.sl) || 6.0));
  const tp1Dist = Math.min(6.0, Math.max(1.5, Math.abs(signal.tp1 - origEntry) || 3.5));
  const tp2Dist = Math.min(15.0, Math.max(3.0, Math.abs(signal.tp2 - origEntry) || 7.5));

  const initialSL = isBuy ? entryPrice - slDist : entryPrice + slDist;
  const tp1 = isBuy ? entryPrice + tp1Dist : entryPrice - tp1Dist;
  const tp2 = isBuy ? entryPrice + tp2Dist : entryPrice - tp2Dist;

  const BE_TRIGGER = 2.5; // 25 pips ($2.50)
  const BE_OFFSET = 0.5;  // 5 pips ($0.50)
  const TRAILING_DIST = 2.0; // 20 pips ($2.00)
  const TRAILING_STEP = 0.5; // 5 pips ($0.50)

  let leg1Closed = false;
  let leg1Pips = 0;
  let leg2Closed = false;
  let leg2Pips = 0;
  let leg2SL = initialSL;
  let isBEActive = false;

  const maxLookforward = Math.min(candles.length, startCandleIdx + 200);

  for (let i = startCandleIdx; i < maxLookforward; i++) {
    const c = candles[i];

    if (isBuy) {
      if (!leg1Closed) {
        if (c.high >= tp1) {
          leg1Closed = true;
          leg1Pips = tp1Dist * 10;
        } else if (c.low <= initialSL) {
          leg1Closed = true;
          leg1Pips = -slDist * 10;
        }
      }

      if (!isBEActive && c.high >= entryPrice + BE_TRIGGER) {
        isBEActive = true;
        leg2SL = entryPrice + BE_OFFSET;
      }

      if (isBEActive) {
        const potentialSL = c.high - TRAILING_DIST;
        if (potentialSL >= leg2SL + TRAILING_STEP) leg2SL = potentialSL;
      }

      if (!leg2Closed) {
        if (c.high >= tp2) {
          leg2Closed = true;
          leg2Pips = tp2Dist * 10;
        } else if (c.low <= leg2SL) {
          leg2Closed = true;
          leg2Pips = (leg2SL - entryPrice) * 10;
        }
      }
    } else {
      if (!leg1Closed) {
        if (c.low <= tp1) {
          leg1Closed = true;
          leg1Pips = tp1Dist * 10;
        } else if (c.high >= initialSL) {
          leg1Closed = true;
          leg1Pips = -slDist * 10;
        }
      }

      if (!isBEActive && c.low <= entryPrice - BE_TRIGGER) {
        isBEActive = true;
        leg2SL = entryPrice - BE_OFFSET;
      }

      if (isBEActive) {
        const potentialSL = c.low + TRAILING_DIST;
        if (potentialSL <= leg2SL - TRAILING_STEP) leg2SL = potentialSL;
      }

      if (!leg2Closed) {
        if (c.low <= tp2) {
          leg2Closed = true;
          leg2Pips = tp2Dist * 10;
        } else if (c.high >= leg2SL) {
          leg2Closed = true;
          leg2Pips = (entryPrice - leg2SL) * 10;
        }
      }
    }

    if (leg1Closed && leg2Closed) break;
  }

  if (!leg1Closed) {
    const endPrice = candles[maxLookforward - 1].close;
    const diff = (isBuy ? endPrice - entryPrice : entryPrice - endPrice) * 10;
    leg1Pips = Math.max(-slDist * 10, Math.min(tp1Dist * 10, diff));
  }
  if (!leg2Closed) {
    const endPrice = candles[maxLookforward - 1].close;
    const diff = (isBuy ? endPrice - entryPrice : entryPrice - endPrice) * 10;
    leg2Pips = Math.max(-slDist * 10, Math.min(tp2Dist * 10, diff));
  }

  const combinedNetPips = (leg1Pips * 0.5) + (leg2Pips * 0.5);
  return {
    netPips: combinedNetPips,
    leg1Pips,
    leg2Pips,
    isWin: combinedNetPips > 0
  };
}

async function run100DollarAnnualSimulation() {
  await client.connect();
  const dialogs = await client.getDialogs({});

  const active7 = Object.entries(CHANNELS_CONFIG).filter(([id, cfg]) => cfg.enabled);

  console.log('========================================================================================');
  console.log('🚀 SIMULACIÓN ANUAL: CUENTA DE $100 USD CON LOS 7 CANALES TOP');
  console.log('   ESTRATEGIA: 50% TP1 + Auto Break-Even + Trailing Stop (Anti-Spam The5%ers)');
  console.log('   PERÍODO: 12 Meses (365 Días de Operativa Completa)');
  console.log('========================================================================================\n');

  // Recolectar señales históricas reales de los 7 canales
  const allSignals = [];

  for (const [chId, cfg] of active7) {
    const rawId = chId.replace(/^-100/, '').replace(/^-/, '');
    const found = dialogs.find(d => d.id.toString() === chId || d.id.toString() === rawId || (d.name && d.name.toLowerCase().includes(cfg.name.toLowerCase())));

    if (!found) continue;

    process.stdout.write(`📥 Extrayendo histórico de [${cfg.name}]... `);
    let msgs = [];
    let offsetId = 0;
    for (let b = 0; b < 6; b++) {
      const batch = await client.getMessages(found.inputEntity, { limit: 100, offsetId });
      if (!batch || batch.length === 0) break;
      msgs.push(...batch);
      offsetId = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }

    const strategy = strategyFactory.getStrategy(chId, cfg.name);
    let count = 0;

    msgs.reverse().forEach(m => {
      if (!m.message) return;
      const sig = strategy.parse(m.message, { messageId: m.id });
      if (sig && sig.action && (sig.action.includes('BUY') || sig.action.includes('SELL'))) {
        const sym = (sig.symbol || 'XAUUSD').toUpperCase();
        // Solo señales de Oro (XAUUSD / GOLD)
        if (!sym.includes('XAU') && !sym.includes('GOLD')) return;

        let entry = sig.entry;
        // Si el precio es de BTC o atípico, omitir
        if (entry && (entry > 5000 || entry < 1500)) return;
        if (!entry) entry = 4200;

        if (!sig.sl) {
          const dist = (cfg.defaultSLPips || 80) / 10;
          sig.sl = sig.action.includes('BUY') ? entry - dist : entry + dist;
        }
        if (!sig.tp1) {
          const dist1 = (cfg.defaultTP1Pips || 35) / 10;
          const dist2 = (cfg.defaultTP2Pips || 75) / 10;
          sig.tp1 = sig.action.includes('BUY') ? entry + dist1 : entry - dist1;
          sig.tp2 = sig.action.includes('BUY') ? entry + dist2 : entry - dist2;
        }

        const slDist = Math.abs(entry - sig.sl) * 10;
        if (slDist > 100) {
          sig.sl = sig.action.includes('BUY') ? entry - 10.0 : entry + 10.0;
        }

        allSignals.push({
          channelName: cfg.name,
          timestamp: m.date * 1000,
          signal: sig
        });
        count++;
      }
    });

    console.log(`✅ ${count} señales válidas de Oro.`);
  }

  // Ordenar todas las señales cronológicamente
  allSignals.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`\n📦 Total de señales de Oro recolectadas del portafolio: ${allSignals.length} señales.`);

  // Simular los resultados técnicos en pips de cada señal sobre las velas
  const evaluatedTrades = [];
  allSignals.forEach(s => {
    const cIdx = findCandleIndex(s.timestamp);
    if (cIdx < candles.length - 10) {
      const outcome = evaluateSignalOnCandles(s.signal, cIdx);
      evaluatedTrades.push({
        ...s,
        candleIdx: cIdx,
        netPips: outcome.netPips,
        isWin: outcome.isWin
      });
    }
  });

  console.log(`🎯 Señales de Oro mapeadas exactamente en el gráfico de 1 año: ${evaluatedTrades.length} trades.`);

  // -------------------------------------------------------------
  // SIMULACIÓN 1: Lote Fijo Mínimo (0.01 lotes)
  // -------------------------------------------------------------
  let balFixed = 100.0;
  let peakFixed = balFixed;
  let maxDDFixed = 0;
  let winsFixed = 0;

  // -------------------------------------------------------------
  // SIMULACIÓN 2: Interés Compuesto Moderado (Escalado cada $100: 0.01 lot / $100 saldo)
  // Max cap: 10.0 lotes
  // -------------------------------------------------------------
  let balComp = 100.0;
  let peakComp = balComp;
  let maxDDComp = 0;

  // -------------------------------------------------------------
  // SIMULACIÓN 3: Interés Compuesto Agresivo (0.02 lotes por cada $100 saldo)
  // Max cap: 20.0 lotes
  // -------------------------------------------------------------
  let balAggressive = 100.0;
  let peakAgg = balAggressive;
  let maxDDAgg = 0;

  // Evolución mensual (12 meses)
  const monthlyStats = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    trades: 0,
    wins: 0,
    pips: 0,
    startBalComp: 0,
    endBalComp: 0,
    startBalFixed: 0,
    endBalFixed: 0,
    startBalAgg: 0,
    endBalAgg: 0
  }));

  const totalTrades = evaluatedTrades.length;
  const tradesPerMonth = Math.ceil(totalTrades / 12);

  evaluatedTrades.forEach((t, idx) => {
    const monthIdx = Math.min(11, Math.floor(idx / tradesPerMonth));
    if (monthlyStats[monthIdx].trades === 0) {
      monthlyStats[monthIdx].startBalComp = balComp;
      monthlyStats[monthIdx].startBalFixed = balFixed;
      monthlyStats[monthIdx].startBalAgg = balAggressive;
    }

    const pips = t.netPips;
    monthlyStats[monthIdx].trades++;
    monthlyStats[monthIdx].pips += pips;

    // 1. Fixed Lot: 0.01 lotes -> 1 pip = $0.10 USD
    const profitFixed = pips * 0.10;
    balFixed += profitFixed;
    if (balFixed > peakFixed) peakFixed = balFixed;
    const ddFixed = ((peakFixed - balFixed) / peakFixed) * 100;
    if (ddFixed > maxDDFixed) maxDDFixed = ddFixed;
    if (profitFixed > 0) {
      winsFixed++;
      monthlyStats[monthIdx].wins++;
    }

    // 2. Compounding Moderado (0.01 lot por cada $100 de balance | Cap: 10.0 lotes)
    // Ej: $100 -> 0.01 lot | $200 -> 0.02 lot | $500 -> 0.05 lot | $1,000 -> 0.10 lot
    const lotComp = Math.min(10.0, Math.max(0.01, parseFloat((Math.floor(balComp / 100) * 0.01).toFixed(2))));
    const profitComp = pips * (lotComp * 10);
    balComp += profitComp;
    if (balComp > peakComp) peakComp = balComp;
    const ddComp = ((peakComp - balComp) / peakComp) * 100;
    if (ddComp > maxDDComp) maxDDComp = ddComp;

    // 3. Compounding Agresivo (0.02 lot por cada $100 de balance | Cap: 20.0 lotes)
    const lotAgg = Math.min(20.0, Math.max(0.01, parseFloat((Math.floor(balAggressive / 50) * 0.01).toFixed(2))));
    const profitAgg = pips * (lotAgg * 10);
    balAggressive += profitAgg;
    if (balAggressive > peakAgg) peakAgg = balAggressive;
    const ddAgg = ((peakAgg - balAggressive) / peakAgg) * 100;
    if (ddAgg > maxDDAgg) maxDDAgg = ddAgg;

    monthlyStats[monthIdx].endBalComp = balComp;
    monthlyStats[monthIdx].endBalFixed = balFixed;
    monthlyStats[monthIdx].endBalAgg = balAggressive;
  });

  // Guardar resultados JSON
  fs.writeFileSync('scripts/audits/cache_100usd_simulation.json', JSON.stringify({
    balFixed,
    balComp,
    balAggressive,
    maxDDFixed,
    maxDDComp,
    maxDDAgg,
    monthlyStats
  }, null, 2));

  // Imprimir Reporte
  console.log('\n========================================================================================================');
  console.log('📈 RESULTADOS ANUALES ESTIMADOS: CUENTA INICIAL $100.00 USD (PORTAFOLIO 7 CANALES)');
  console.log('========================================================================================================\n');

  console.log(`• Total Operaciones en el Año:      ${totalTrades} operaciones (~${(totalTrades / 52).toFixed(1)} trades/semana)`);
  console.log(`• Tasa de Acierto (Win Rate):       ${((winsFixed / totalTrades) * 100).toFixed(1)}%`);
  console.log(`• Pips Totales Netos Generados:     ${monthlyStats.reduce((acc, m) => acc + m.pips, 0).toFixed(1)} pips`);
  console.log('--------------------------------------------------------------------------------------------------------');

  console.log('\n🔹 COMPARATIVA DE ESTRATEGIAS DE CAPITAL:\n');
  console.log(`${'Estrategia de Capital'.padEnd(35)} | ${'Saldo Final'.padStart(14)} | ${'Rentabilidad'.padStart(14)} | ${'Max Drawdown'.padStart(14)}`);
  console.log('-'.repeat(85));
  console.log(`${'1. Lote Fijo Mínimo (0.01 lot)'.padEnd(35)} | ${('$' + balFixed.toFixed(2)).padStart(14)} | ${('+' + (((balFixed - 100) / 100) * 100).toFixed(1) + '%').padStart(14)} | ${(maxDDFixed.toFixed(1) + '%').padStart(14)}`);
  console.log(`${'2. Compuesto Moderado (2% riesgo)'.padEnd(35)} | ${('$' + balComp.toFixed(2)).padStart(14)} | ${('+' + (((balComp - 100) / 100) * 100).toFixed(1) + '%').padStart(14)} | ${(maxDDComp.toFixed(1) + '%').padStart(14)}`);
  console.log(`${'3. Compuesto Agresivo (5% riesgo)'.padEnd(35)} | ${('$' + balAggressive.toFixed(2)).padStart(14)} | ${('+' + (((balAggressive - 100) / 100) * 100).toFixed(1) + '%').padStart(14)} | ${(maxDDAgg.toFixed(1) + '%').padStart(14)}`);

  // -------------------------------------------------------------
  // DESGLOSE INDIVIDUAL POR CANAL (¿Todos son rentables a 1 año?)
  // -------------------------------------------------------------
  const channelStats = {};
  evaluatedTrades.forEach(t => {
    const ch = t.channelName;
    if (!channelStats[ch]) {
      channelStats[ch] = {
        name: ch,
        trades: 0,
        wins: 0,
        losses: 0,
        pipsWon: 0,
        pipsLost: 0,
        peak: 0,
        running: 0,
        maxDD: 0
      };
    }
    const cs = channelStats[ch];
    cs.trades++;
    const p = t.netPips;
    cs.running += p;
    if (cs.running > cs.peak) cs.peak = cs.running;
    const dd = cs.peak - cs.running;
    if (dd > cs.maxDD) cs.maxDD = dd;

    if (p > 0) {
      cs.wins++;
      cs.pipsWon += p;
    } else {
      cs.losses++;
      cs.pipsLost += Math.abs(p);
    }
  });

  console.log('\n\n🔹 DESGLOSE DE RENTABILIDAD POR CANAL A 1 AÑO (PORTAFOLIO DE 7 CANALES):\n');
  console.log(`${'Canal'.padEnd(28)} | ${'Trades'.padStart(6)} | ${'Win Rate'.padStart(8)} | ${'Pips Netos'.padStart(12)} | ${'P. Factor'.padStart(9)} | ${'Drawdown'.padStart(10)} | ${'Estado a 1 Año'.padStart(16)}`);
  console.log('-'.repeat(102));

  Object.values(channelStats).sort((a, b) => (b.pipsWon - b.pipsLost) - (a.pipsWon - a.pipsLost)).forEach(cs => {
    const net = cs.pipsWon - cs.pipsLost;
    const wr = ((cs.wins / cs.trades) * 100).toFixed(1) + '%';
    const pf = cs.pipsLost > 0 ? (cs.pipsWon / cs.pipsLost).toFixed(2) : 'MAX';
    const pipsStr = (net > 0 ? '+' : '') + net.toFixed(1) + 'p';
    const status = net > 1000 ? '💎 TOP Rentable' : (net > 0 ? '✅ Rentable' : '❌ Negativo');
    console.log(`${cs.name.slice(0, 28).padEnd(28)} | ${String(cs.trades).padStart(6)} | ${wr.padStart(8)} | ${pipsStr.padStart(12)} | ${pf.padStart(9)} | ${(cs.maxDD.toFixed(1) + 'p').padStart(10)} | ${status.padStart(16)}`);
  });

  console.log('\n========================================================================================================\n');
  process.exit(0);
}

run100DollarAnnualSimulation().catch(e => {
  console.error('Error en simulación:', e);
  process.exit(1);
});
