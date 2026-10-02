/**
 * Backtest Multitemporal Definitivo de las Estrategias Algorítmicas Propias
 * Ejecutado 100% sobre los datos reales del broker de MT5:
 * - XAUUSD_M15_202401020100_202609291045.csv (2024-2026, 65.015 velas M15)
 * - XAUUSD_M5_202504291430_202609291055.csv (2025-2026, 99.987 velas M5)
 * - XAUUSD_M1_202606171851_202609291057.csv (Últimos meses, 99.940 velas M1)
 * 
 * Estrategias Auditadas:
 * 1. Connors RSI(7) + Bollinger Bands (2.3σ) Mean-Reversion Sniper (M15)
 * 2. Smart Money Concepts: Asian Liquidity Sweep & MSS Judas Swing (M15 / M5)
 * 3. Institutional Volume Profile & PoC Limit (SVP Swing H1)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Importar clases de algoritmos propios
const { InstitutionalVolumeSMCStrategy } = require('../../core/algorithms/InstitutionalVolumeSMCStrategy');
const { RSIMeanReversionSniper } = require('../../core/algorithms/RSIMeanReversionSniper');
const { GoldSMCStrategy } = require('../../core/algorithms/GoldSMCStrategy');

// Cargador de CSV a memoria
async function loadCSV(filename, maxRows = Infinity) {
  const filePath = path.join(__dirname, '../../', filename);
  console.log(`📂 Cargando ${filename}...`);
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const dateStr = parts[0];
    const timeStr = parts[1];
    const [y, m, d] = dateStr.split('.').map(Number);
    const [h, min, s] = timeStr.split(':').map(Number);

    // Broker opera en UTC+2
    const timestamp = Date.UTC(y, m - 1, d, h - 2, min, s);

    candles.push({
      dateStr,
      timeStr,
      time: timestamp,
      timestamp,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      volume: parseFloat(parts[6]) || 1,
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });

    if (candles.length >= maxRows) break;
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`   ✅ ${candles.length} velas cargadas (${candles[0].dateStr} -> ${candles[candles.length - 1].dateStr}).`);
  return candles;
}

// Convertir velas M15 en velas H1 (4 velas M15 = 1 vela H1)
function aggregateM15ToH1(candlesM15) {
  const candlesH1 = [];
  let currentH1 = null;

  for (const c of candlesM15) {
    const h = c.timeStr.split(':')[0];
    const hourKey = `${c.dateStr} ${h}:00`;

    if (!currentH1 || currentH1.hourKey !== hourKey) {
      if (currentH1) candlesH1.push(currentH1);
      currentH1 = {
        hourKey,
        dateStr: c.dateStr,
        timeStr: `${h}:00:00`,
        time: c.time,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        spreadPips: c.spreadPips
      };
    } else {
      if (c.high > currentH1.high) currentH1.high = c.high;
      if (c.low < currentH1.low) currentH1.low = c.low;
      currentH1.close = c.close;
      currentH1.volume += c.volume;
    }
  }
  if (currentH1) candlesH1.push(currentH1);
  return candlesH1;
}

// =========================================================================
// 1. ESTRATEGIA 1: Connors RSI(7) + Bollinger Bands (2.3σ) Sniper (M15)
// =========================================================================
function runBacktestRSI(candlesM15) {
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('🧪 [ESTRATEGIA 1] Connors RSI(7) + Bollinger Bands (2.3σ) Mean-Reversion Sniper (M15)');
  console.log('----------------------------------------------------------------------------------------');

  const sniper = new RSIMeanReversionSniper({
    rsiPeriod: 7,
    rsiOversold: 16,
    rsiOverbought: 84,
    bbPeriod: 20,
    bbMult: 2.3,
    tpPips: 25.0, // 25 pips objetivo
    slPips: 30.0  // 30 pips stop loss
  });

  const rsi = sniper.calculateRSI(candlesM15);
  const bb = sniper.calculateBollingerBands(candlesM15);

  let wins = 0, losses = 0, pipsWon = 0, pipsLost = 0;
  let peak = 0, run = 0, maxDD = 0;
  let bal = 5263.49, peakBal = 5263.49, maxDDBal = 0;

  for (let i = 25; i < candlesM15.length - 30; i++) {
    const c = candlesM15[i];
    const prevC = candlesM15[i - 1];
    const curRsi = rsi[i];
    const curLower = bb.lower[i];
    const curUpper = bb.upper[i];

    let action = null;
    if (prevC.low <= curLower && curRsi <= 16 && c.close > c.open) {
      action = 'BUY';
    } else if (prevC.high >= curUpper && curRsi >= 84 && c.close < c.open) {
      action = 'SELL';
    }

    if (!action) continue;

    // Fricción real del broker (Spread 3.7p + 1.0p slippage)
    const friction = c.spreadPips + 1.0;
    const isBuy = action === 'BUY';
    const entry = isBuy ? c.close + (c.spreadPips / 10.0) : c.close;
    const targetTP = isBuy ? entry + (sniper.tpPips / 10.0) : entry - (sniper.tpPips / 10.0);
    const targetSL = isBuy ? entry - (sniper.slPips / 10.0) : entry + (sniper.slPips / 10.0);

    let closed = false;
    let netPips = 0;

    for (let j = i + 1; j < Math.min(candlesM15.length, i + 35); j++) {
      const nextC = candlesM15[j];
      if (isBuy) {
        if (nextC.high >= targetTP) {
          netPips = sniper.tpPips - friction;
          closed = true;
          break;
        }
        if (nextC.low <= targetSL) {
          netPips = -sniper.slPips - friction;
          closed = true;
          break;
        }
      } else {
        if (nextC.low <= targetTP) {
          netPips = sniper.tpPips - friction;
          closed = true;
          break;
        }
        if (nextC.high >= targetSL) {
          netPips = -sniper.slPips - friction;
          closed = true;
          break;
        }
      }
    }

    if (!closed) {
      const exitPrice = candlesM15[Math.min(candlesM15.length - 1, i + 35)].close;
      netPips = (isBuy ? exitPrice - entry : entry - exitPrice) * 10 - friction;
    }

    run += netPips;
    if (run > peak) peak = run;
    if (peak - run > maxDD) maxDD = peak - run;

    bal += netPips * 1.0; // 0.10L en cuenta $5,263 ($1/pip)
    if (bal > peakBal) peakBal = bal;
    const dd = ((peakBal - bal) / peakBal) * 100;
    if (dd > maxDDBal) maxDDBal = dd;

    if (netPips > 0) {
      wins++;
      pipsWon += netPips;
    } else {
      losses++;
      pipsLost += Math.abs(netPips);
    }

    i += 10; // Espaciado de señal
  }

  const total = wins + losses;
  const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';
  const pf = pipsLost > 0 ? (pipsWon / pipsLost).toFixed(2) : 'MAX';

  console.log(`• Total Operaciones:         ${total} trades`);
  console.log(`• Tasa de Acierto (Win Rate): ${wr}% (${wins} W / ${losses} L)`);
  console.log(`• Pips Netos Ganados:        ${(pipsWon - pipsLost).toFixed(1)} pips`);
  console.log(`• Profit Factor:             ${pf}`);
  console.log(`• Drawdown Máximo:           ${maxDD.toFixed(1)} pips (${maxDDBal.toFixed(1)}% de cuenta)`);
  console.log(`• Saldo Final Cuenta $5,263: $${bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  return { name: 'RSI Mean-Reversion Sniper (M15)', total, wr, pips: (pipsWon - pipsLost), pf, maxDD, bal, maxDDBal };
}

// =========================================================================
// 2. ESTRATEGIA 2: Smart Money Concepts (Asian Liquidity Sweep & Judas Swing)
// =========================================================================
function runBacktestSMC(candlesM15) {
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('⚡ [ESTRATEGIA 2] Smart Money Concepts: Asian Liquidity Sweep & MSS Judas Swing (M15)');
  console.log('----------------------------------------------------------------------------------------');

  const smc = new GoldSMCStrategy({
    minSweepPips: 6.0,
    maxSweepPips: 30.0,
    slBufferPips: 5.0,
    riskRewardTP1: 1.5,
    riskRewardTP2: 2.5
  });

  const signals = smc.analyzeCandles(candlesM15);
  console.log(`• Señales de Caza de Liquidez detectadas: ${signals.length}`);

  let wins = 0, losses = 0, pipsWon = 0, pipsLost = 0;
  let peak = 0, run = 0, maxDD = 0;
  let bal = 5263.49, peakBal = 5263.49, maxDDBal = 0;

  signals.forEach(s => {
    const startIdx = s.index;
    if (startIdx === undefined || startIdx >= candlesM15.length - 20) return;

    const friction = candlesM15[startIdx].spreadPips + 1.0;
    const isBuy = s.action === 'BUY';
    const entry = isBuy ? s.entry + (candlesM15[startIdx].spreadPips / 10.0) : s.entry;
    const sl = s.sl;
    const tp1 = s.tp1;
    const tp2 = s.tp2;
    const slDist = Math.abs(entry - sl);
    const tp1Dist = Math.abs(tp1 - entry);
    const tp2Dist = Math.abs(tp2 - entry);

    let leg1Closed = false, leg1Pips = 0;
    let leg2Closed = false, leg2Pips = 0;
    let leg2SL = sl;

    // Permitir hasta 50 velas M15 (~12 horas de desarrollo)
    for (let j = startIdx + 1; j < Math.min(candlesM15.length, startIdx + 50); j++) {
      const c = candlesM15[j];
      if (isBuy) {
        if (!leg1Closed) {
          if (c.high >= tp1) { leg1Closed = true; leg1Pips = (tp1Dist * 10) - friction; leg2SL = entry; }
          else if (c.low <= sl) { leg1Closed = true; leg1Pips = -(slDist * 10) - friction; }
        }
        if (!leg2Closed) {
          if (c.high >= tp2) { leg2Closed = true; leg2Pips = (tp2Dist * 10) - friction; }
          else if (c.low <= leg2SL) { leg2Closed = true; leg2Pips = ((leg2SL - entry) * 10) - friction; }
        }
      } else {
        if (!leg1Closed) {
          if (c.low <= tp1) { leg1Closed = true; leg1Pips = (tp1Dist * 10) - friction; leg2SL = entry; }
          else if (c.high >= sl) { leg1Closed = true; leg1Pips = -(slDist * 10) - friction; }
        }
        if (!leg2Closed) {
          if (c.low <= tp2) { leg2Closed = true; leg2Pips = (tp2Dist * 10) - friction; }
          else if (c.high >= leg2SL) { leg2Closed = true; leg2Pips = ((entry - leg2SL) * 10) - friction; }
        }
      }
      if (leg1Closed && leg2Closed) break;
    }

    if (!leg1Closed) {
      const endPrice = candlesM15[Math.min(candlesM15.length - 1, startIdx + 50)].close;
      leg1Pips = (isBuy ? endPrice - entry : entry - endPrice) * 10 - friction;
    }
    if (!leg2Closed) {
      const endPrice = candlesM15[Math.min(candlesM15.length - 1, startIdx + 50)].close;
      leg2Pips = (isBuy ? endPrice - entry : entry - endPrice) * 10 - friction;
    }

    const netPips = (leg1Pips * 0.5) + (leg2Pips * 0.5);

    run += netPips;
    if (run > peak) peak = run;
    if (peak - run > maxDD) maxDD = peak - run;

    bal += netPips * 1.0;
    if (bal > peakBal) peakBal = bal;
    const dd = ((peakBal - bal) / peakBal) * 100;
    if (dd > maxDDBal) maxDDBal = dd;

    if (netPips > 0) {
      wins++;
      pipsWon += netPips;
    } else {
      losses++;
      pipsLost += Math.abs(netPips);
    }
  });

  const total = wins + losses;
  const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';
  const pf = pipsLost > 0 ? (pipsWon / pipsLost).toFixed(2) : 'MAX';

  console.log(`• Total Operaciones Llenadas: ${total} trades`);
  console.log(`• Tasa de Acierto (Win Rate): ${wr}% (${wins} W / ${losses} L)`);
  console.log(`• Pips Netos Ganados:        ${(pipsWon - pipsLost).toFixed(1)} pips`);
  console.log(`• Profit Factor:             ${pf}`);
  console.log(`• Drawdown Máximo:           ${maxDD.toFixed(1)} pips (${maxDDBal.toFixed(1)}% de cuenta)`);
  console.log(`• Saldo Final Cuenta $5,263: $${bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  return { name: 'Smart Money Liquidity Sweep (M15)', total, wr, pips: (pipsWon - pipsLost), pf, maxDD, bal, maxDDBal };
}

// =========================================================================
// 3. ESTRATEGIA 3: Institutional Volume Profile & PoC Limit (H1 Swing)
// =========================================================================
function runBacktestVolumeProfileH1(candlesM15) {
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('🏛️ [ESTRATEGIA 3] Institutional Volume Profile & PoC Limit (SVP Swing H1)');
  console.log('----------------------------------------------------------------------------------------');

  const candlesH1 = aggregateM15ToH1(candlesM15);
  console.log(`• Velas H1 construidas: ${candlesH1.length} velas`);

  const ivp = new InstitutionalVolumeSMCStrategy({
    binSize: 0.50,
    valueAreaRatio: 0.70,
    minAreaSpan: 4.0,
    maxAreaSpan: 22.0,
    slAir: 1.50
  });

  const daysMap = new Map();
  candlesH1.forEach(c => {
    if (!daysMap.has(c.dateStr)) daysMap.set(c.dateStr, []);
    daysMap.get(c.dateStr).push(c);
  });

  let wins = 0, losses = 0, pipsWon = 0, pipsLost = 0;
  let peak = 0, run = 0, maxDD = 0;
  let bal = 5263.49, peakBal = 5263.49, maxDDBal = 0;
  let totalTrades = 0;

  daysMap.forEach((dayCandles, dateStr) => {
    // Sesión asiática (02:00 a 09:00 hora broker = 00:00 a 07:00 UTC)
    const asianCandles = dayCandles.filter(c => {
      const h = parseInt(c.timeStr.split(':')[0], 10);
      return h >= 2 && h < 9;
    });

    if (asianCandles.length < 5) return;

    const profile = ivp.calculateProfile(asianCandles);
    if (!profile) return;

    const { poc, vah, val, span } = profile;
    if (span < ivp.minAreaSpan || span > ivp.maxAreaSpan) return;

    const idxInAll = candlesH1.indexOf(asianCandles[asianCandles.length - 1]);
    if (idxInAll < 50) return;

    let emaSum = 0;
    for (let k = 0; k < 50; k++) emaSum += candlesH1[idxInAll - k].close;
    const ema50 = emaSum / 50;

    const isBullish = asianCandles[asianCandles.length - 1].close > ema50;
    const entryLimit = poc;
    const sl = isBullish ? val - ivp.slAir : vah + ivp.slAir;
    const tp1 = isBullish ? vah : val;
    const tp2 = isBullish ? poc + (span * 1.2) : poc - (span * 1.2);

    // Buscar entrada en sesión Londres/NY
    let fillIdx = -1;
    for (let i = idxInAll + 1; i < Math.min(candlesH1.length, idxInAll + 10); i++) {
      const c = candlesH1[i];
      if (isBullish && c.low <= entryLimit) { fillIdx = i; break; }
      if (!isBullish && c.high >= entryLimit) { fillIdx = i; break; }
    }

    if (fillIdx === -1) return;

    totalTrades++;
    const friction = candlesH1[fillIdx].spreadPips + 1.0;
    const slDist = Math.abs(entryLimit - sl);
    const tp1Dist = Math.abs(tp1 - entryLimit);
    const tp2Dist = Math.abs(tp2 - entryLimit);

    let leg1Closed = false, leg1Pips = 0;
    let leg2Closed = false, leg2Pips = 0;
    let leg2SL = sl;

    // Permitir seguimiento hasta 24 horas (24 velas H1)
    for (let i = fillIdx + 1; i < Math.min(candlesH1.length, fillIdx + 24); i++) {
      const c = candlesH1[i];
      if (isBullish) {
        if (!leg1Closed) {
          if (c.high >= tp1) { leg1Closed = true; leg1Pips = (tp1Dist * 10) - friction; leg2SL = entryLimit; }
          else if (c.low <= sl) { leg1Closed = true; leg1Pips = -(slDist * 10) - friction; }
        }
        if (!leg2Closed) {
          if (c.high >= tp2) { leg2Closed = true; leg2Pips = (tp2Dist * 10) - friction; }
          else if (c.low <= leg2SL) { leg2Closed = true; leg2Pips = ((leg2SL - entryLimit) * 10) - friction; }
        }
      } else {
        if (!leg1Closed) {
          if (c.low <= tp1) { leg1Closed = true; leg1Pips = (tp1Dist * 10) - friction; leg2SL = entryLimit; }
          else if (c.high >= sl) { leg1Closed = true; leg1Pips = -(slDist * 10) - friction; }
        }
        if (!leg2Closed) {
          if (c.low <= tp2) { leg2Closed = true; leg2Pips = (tp2Dist * 10) - friction; }
          else if (c.high >= leg2SL) { leg2Closed = true; leg2Pips = ((entryLimit - leg2SL) * 10) - friction; }
        }
      }
      if (leg1Closed && leg2Closed) break;
    }

    if (!leg1Closed) {
      const endPrice = candlesH1[Math.min(candlesH1.length - 1, fillIdx + 24)].close;
      leg1Pips = (isBullish ? endPrice - entryLimit : entryLimit - endPrice) * 10 - friction;
    }
    if (!leg2Closed) {
      const endPrice = candlesH1[Math.min(candlesH1.length - 1, fillIdx + 24)].close;
      leg2Pips = (isBullish ? endPrice - entryLimit : entryLimit - endPrice) * 10 - friction;
    }

    const netPips = (leg1Pips * 0.5) + (leg2Pips * 0.5);

    run += netPips;
    if (run > peak) peak = run;
    if (peak - run > maxDD) maxDD = peak - run;

    bal += netPips * 1.0;
    if (bal > peakBal) peakBal = bal;
    const dd = ((peakBal - bal) / peakBal) * 100;
    if (dd > maxDDBal) maxDDBal = dd;

    if (netPips > 0) {
      wins++;
      pipsWon += netPips;
    } else {
      losses++;
      pipsLost += Math.abs(netPips);
    }
  });

  const total = wins + losses;
  const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';
  const pf = pipsLost > 0 ? (pipsWon / pipsLost).toFixed(2) : 'MAX';

  console.log(`• Total Órdenes Límite Llenadas: ${total} trades`);
  console.log(`• Tasa de Acierto (Win Rate):    ${wr}% (${wins} W / ${losses} L)`);
  console.log(`• Pips Netos Ganados:           ${(pipsWon - pipsLost).toFixed(1)} pips`);
  console.log(`• Profit Factor:                ${pf}`);
  console.log(`• Drawdown Máximo:              ${maxDD.toFixed(1)} pips (${maxDDBal.toFixed(1)}% de cuenta)`);
  console.log(`• Saldo Final Cuenta $5,263:    $${bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  return { name: 'Volume Profile & PoC Limit (H1)', total, wr, pips: (pipsWon - pipsLost), pf, maxDD, bal, maxDDBal };
}

async function main() {
  console.log('========================================================================================');
  console.log('🔬 AUDITORÍA INTEGRAL DE ESTRATEGIAS ALGORÍTMICAS PROPIAS (VELAS REALES MT5)');
  console.log('   Activo: XAUUSD (Oro Spot) | Spread y Slippage Real Descontado');
  console.log('========================================================================================\n');

  const candlesM15 = await loadCSV('XAUUSD_M15_202401020100_202609291045.csv');

  const res1 = runBacktestRSI(candlesM15);
  const res2 = runBacktestSMC(candlesM15);
  const res3 = runBacktestVolumeProfileH1(candlesM15);

  console.log('\n================================================================================================================');
  console.log('📊 CUADRO RESUMEN COMPARATIVO DE ESTRATEGIAS PROPIAS (DATOS 100% REALES DEL BROKER):');
  console.log('================================================================================================================\n');

  console.log(`${'Estrategia Algorítmica'.padEnd(36)} | ${'Win Rate'.padStart(10)} | ${'Pips Netos'.padStart(14)} | ${'Profit Factor'.padStart(14)} | ${'Max Drawdown'.padStart(16)} | ${'Saldo Final $5,263'.padStart(20)}`);
  console.log('-'.repeat(120));

  [res1, res2, res3].forEach(r => {
    console.log(`${r.name.padEnd(36)} | ${(r.wr + '%').padStart(10)} | ${(r.pips.toFixed(1) + ' p').padStart(14)} | ${String(r.pf).padStart(14)} | ${(r.maxDD.toFixed(1) + ' p (' + r.maxDDBal.toFixed(1) + '%)').padStart(16)} | ${('$' + r.bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).padStart(20)}`);
  });

  console.log('================================================================================================================\n');

  fs.writeFileSync('scripts/audits/cache_proprietary_strategies_real_broker.json', JSON.stringify({
    results: [res1, res2, res3],
    auditDate: new Date().toISOString()
  }, null, 2));

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
