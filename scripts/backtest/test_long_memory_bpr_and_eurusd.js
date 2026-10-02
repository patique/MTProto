const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..');

// Load candles generic
async function loadCandles(filePath) {
  const candles = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split(/[\t,;]+/);
    if (parts.length < 6) continue;

    const dateStr = parts[0].trim();
    const timeStr = parts[1].trim();
    const open = parseFloat(parts[2]);
    const high = parseFloat(parts[3]);
    const low = parseFloat(parts[4]);
    const close = parseFloat(parts[5]);
    const spreadPips = parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 0.5;

    let dt;
    if (dateStr.includes('.')) {
      const dp = dateStr.split('.');
      const tp = timeStr.split(':');
      dt = new Date(Date.UTC(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1])));
    } else {
      dt = new Date(`${dateStr}T${timeStr}Z`);
    }

    candles.push({ time: dt, open, high, low, close, spreadPips });
  }
  return candles;
}

function precalculateEMA(candles, period = 100) {
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 0; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    candles[i].ema = ema;
  }
}

// BPR Scanner with 400-candle memory and 1:3 R:R
function runLongMemoryBPR(candles, symbol, tf, options) {
  const {
    minFvgGap,
    minOverlap,
    minRange,
    minWickRatio = 0.25,
    maxLookback = 400, // 400 velas de memoria
    slPipsFixed = null, // e.g. 5 pips en EURUSD
    bufferPips = 1.0,   // aire detrás del BPR
    rrRatio = 3.0,      // 1:3 siempre
    pipMultiplier = symbol === 'EURUSD' ? 10000 : 10,
    brokerSpreadPips = symbol === 'EURUSD' ? 0.5 : 4.5
  } = options;

  const bprZones = [];
  const trades = [];
  let lastTradeIdx = -100;

  for (let i = 3; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
    const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
    if (isBearishFVG) c1.isBearish = true;
    if (isBullishFVG) c1.isBullish = true;

    if (isBullishFVG) {
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBearish) {
          const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + minFvgGap;
          const bearBottom = candles[j].high;
          const bullTop = c1.low;
          const bullBottom = c3.high;
          const cLow = Math.max(bearBottom, bullBottom);
          const cHigh = Math.min(bearTop, bullTop);
          if (cHigh > cLow + minOverlap) {
            bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
            break;
          }
        }
      }
    }

    if (isBearishFVG) {
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBullish) {
          const bullTop = candles[j].low;
          const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - minFvgGap;
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);
          if (cHigh > cLow + minOverlap) {
            bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
            break;
          }
        }
      }
    }

    // Keep up to 200 active BPRs in memory (400 bars lifespan)
    while (bprZones.length > 200) bprZones.shift();

    // Check entry
    if (i - lastTradeIdx < 4) continue;
    const hour = c0.time.getUTCHours();
    const min = c0.time.getUTCMinutes();
    if (hour === 23 || (hour === 0 && min <= 15)) continue;

    // London & NY sessions for best institutional momentum
    const inSession = (hour >= 7 && hour < 11) || (hour >= 13 && hour < 17);
    if (!inSession) continue;

    const candleRange = c0.high - c0.low;
    if (candleRange < minRange) continue;

    for (let z = bprZones.length - 1; z >= 0; z--) {
      const bpr = bprZones[z];
      if (bpr.tested) continue;
      const age = i - bpr.createdIdx;
      if (age > maxLookback) { bpr.tested = true; continue; }

      const bufferPrice = bufferPips / pipMultiplier;

      if (bpr.type === 'BULLISH') {
        if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange < minWickRatio) continue;
          if (c0.close < c0.ema) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2; // CE 50%
          let slDistPrice = slPipsFixed ? (slPipsFixed / pipMultiplier) : ((entry - bpr.bottom) + bufferPrice);
          const slPips = slDistPrice * pipMultiplier;
          if (slPips < (symbol === 'EURUSD' ? 2.5 : 10.0)) continue;

          const sl = entry - slDistPrice;
          const tpDistPrice = slDistPrice * rrRatio;
          const tp = entry + tpDistPrice;

          trades.push({ type: 'BUY', entryIdx: i, entry, sl, tp, slPips, tpPips: slPips * rrRatio, age, year: c0.time.getUTCFullYear() });
          break;
        }
      } else if (bpr.type === 'BEARISH') {
        if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange < minWickRatio) continue;
          if (c0.close > c0.ema) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2;
          let slDistPrice = slPipsFixed ? (slPipsFixed / pipMultiplier) : ((bpr.top - entry) + bufferPrice);
          const slPips = slDistPrice * pipMultiplier;
          if (slPips < (symbol === 'EURUSD' ? 2.5 : 10.0)) continue;

          const sl = entry + slDistPrice;
          const tpDistPrice = slDistPrice * rrRatio;
          const tp = entry - tpDistPrice;

          trades.push({ type: 'SELL', entryIdx: i, entry, sl, tp, slPips, tpPips: slPips * rrRatio, age, year: c0.time.getUTCFullYear() });
          break;
        }
      }
    }
  }

  // Simulate execution
  let wins = 0, losses = 0, netPips = 0, grossWon = 0, grossLost = 0;
  let peak = 0, maxDD = 0, running = 0;
  const yearly = {};

  for (const tr of trades) {
    let resolved = false;

    for (let k = tr.entryIdx + 1; k < Math.min(candles.length, tr.entryIdx + 200); k++) {
      const bar = candles[k];

      if (tr.type === 'BUY') {
        if (bar.high >= tr.tp) {
          resolved = true;
          const won = tr.tpPips - brokerSpreadPips;
          netPips += won;
          grossWon += won;
          wins++;
          tr.pips = won;
          break;
        }
        if (bar.low <= tr.sl) {
          resolved = true;
          const lost = tr.slPips + brokerSpreadPips;
          netPips -= lost;
          grossLost += lost;
          losses++;
          tr.pips = -lost;
          break;
        }
      } else {
        if (bar.low <= tr.tp) {
          resolved = true;
          const won = tr.tpPips - brokerSpreadPips;
          netPips += won;
          grossWon += won;
          wins++;
          tr.pips = won;
          break;
        }
        if (bar.high >= tr.sl) {
          resolved = true;
          const lost = tr.slPips + brokerSpreadPips;
          netPips -= lost;
          grossLost += lost;
          losses++;
          tr.pips = -lost;
          break;
        }
      }
    }

    if (!resolved) {
      const lastBar = candles[Math.min(candles.length - 1, tr.entryIdx + 200)];
      const diff = tr.type === 'BUY' ? (lastBar.close - tr.entry) : (tr.entry - lastBar.close);
      const pips = (diff * pipMultiplier) - brokerSpreadPips;
      netPips += pips;
      if (pips > 0) { grossWon += pips; wins++; } else { grossLost += Math.abs(pips); losses++; }
      tr.pips = pips;
    }

    running = netPips;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;

    const yr = tr.year;
    if (!yearly[yr]) yearly[yr] = { trades: 0, wins: 0, pips: 0 };
    yearly[yr].trades++;
    if (tr.pips > 0) yearly[yr].wins++;
    yearly[yr].pips += tr.pips;
  }

  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';
  const wr = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0';

  let posYears = 0, totYears = 0;
  for (const [yr, y] of Object.entries(yearly)) {
    totYears++;
    if (y.pips > 0) posYears++;
  }

  // Breakdown of fresh vs old BPRs
  const freshTrades = trades.filter(t => t.age <= 25);
  const oldTrades = trades.filter(t => t.age > 25);
  const freshWins = freshTrades.filter(t => t.pips > 0).length;
  const oldWins = oldTrades.filter(t => t.pips > 0).length;

  return {
    symbol,
    tf,
    maxLookback,
    rrRatio: `1:${rrRatio}`,
    trades: trades.length,
    winRate: wr + '%',
    pf,
    netPips: netPips.toFixed(1),
    maxDD: maxDD.toFixed(1),
    consistency: `${posYears}/${totYears}`,
    freshWinRate: freshTrades.length > 0 ? ((freshWins / freshTrades.length) * 100).toFixed(1) + '%' : 'N/A',
    oldWinRate: oldTrades.length > 0 ? ((oldWins / oldTrades.length) * 100).toFixed(1) + '%' : 'N/A',
    oldTradesCount: oldTrades.length
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🏛️ TEST DE MEMORIA EXTENDIDA (400 VELAS) Y RATIO 1:3 EN EURUSD Y XAUUSD');
  console.log('   Periodo Completo: 2020 a 2026 (~7 Años)');
  console.log('========================================================================================\n');

  // 1. EURUSD: SL de 3 a 5 pips, RR 1:3, 400 velas de memoria
  console.log('----------------------------------------------------------------------------------------');
  console.log('💶 AUDITORÍA EURUSD CON CONFIGURACIÓN MANUAL REAL (SL 3-5 pips, RR 1:3, Memoria 400)');
  console.log('----------------------------------------------------------------------------------------');

  const eurusdFiles = {
    M1:  { file: 'EURUSD_M1_202001020600_202610011029.csv',  minFvg: 0.00015, minOverlap: 0.00010, minRange: 0.00018, slPips: 3.5 },
    M2:  { file: 'EURUSD_M2_202001020600_202610011028.csv',  minFvg: 0.00020, minOverlap: 0.00012, minRange: 0.00022, slPips: 4.0 },
    M3:  { file: 'EURUSD_M3_202001020600_202610011027.csv',  minFvg: 0.00025, minOverlap: 0.00015, minRange: 0.00025, slPips: 4.5 },
    M5:  { file: 'EURUSD_M5_202001020600_202610011025.csv',  minFvg: 0.00030, minOverlap: 0.00020, minRange: 0.00035, slPips: 5.0 },
    M15: { file: 'EURUSD_M15_202001020600_202610011015.csv', minFvg: 0.00045, minOverlap: 0.00030, minRange: 0.00050, slPips: 7.0 }
  };

  for (const [tf, cfg] of Object.entries(eurusdFiles)) {
    const fullPath = path.join(DATA_DIR, cfg.file);
    if (!fs.existsSync(fullPath)) continue;

    const candles = await loadCandles(fullPath);
    precalculateEMA(candles, 100);

    const res = runLongMemoryBPR(candles, 'EURUSD', tf, {
      minFvgGap: cfg.minFvg,
      minOverlap: cfg.minOverlap,
      minRange: cfg.minRange,
      maxLookback: 400,
      slPipsFixed: cfg.slPips,
      rrRatio: 3.0,
      brokerSpreadPips: 0.5
    });

    console.log(`EURUSD ${tf.padEnd(4)} | Trades: ${String(res.trades).padEnd(6)} | WR: ${res.winRate.padEnd(6)} | PF: ${res.pf.padEnd(5)} | Net: ${res.netPips.padStart(8)}p | MaxDD: ${res.maxDD.padStart(7)}p | Años: ${res.consistency} | BPRs Antiguos (>25v): ${res.oldTradesCount} (WR: ${res.oldWinRate})`);
  }

  // 2. XAUUSD: Memoria 400 velas
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('🥇 AUDITORÍA XAUUSD CON MEMORIA EXTENDIDA DE 400 VELAS (BPRs de largo plazo)');
  console.log('----------------------------------------------------------------------------------------');

  const goldFiles = {
    M3:  { file: 'XAUUSD_M3_202001020600_202610011121.csv', minFvg: 0.25, minOverlap: 0.18, minRange: 0.30, buffer: 1.5 },
    M5:  { file: 'XAUUSD_M5_202001020600_202610011120.csv', minFvg: 0.35, minOverlap: 0.25, minRange: 0.40, buffer: 1.5 },
    M15: { file: 'XAUUSD_M15_202001020600_202610011115.csv', minFvg: 0.60, minOverlap: 0.40, minRange: 0.60, buffer: 2.0 }
  };

  for (const [tf, cfg] of Object.entries(goldFiles)) {
    const fullPath = path.join(DATA_DIR, cfg.file);
    if (!fs.existsSync(fullPath)) continue;

    const candles = await loadCandles(fullPath);
    precalculateEMA(candles, 100);

    // Comparar Memoria 25 velas vs Memoria 400 velas
    const res25 = runLongMemoryBPR(candles, 'XAUUSD', tf, {
      minFvgGap: cfg.minFvg,
      minOverlap: cfg.minOverlap,
      minRange: cfg.minRange,
      maxLookback: 25,
      bufferPips: cfg.buffer * 10,
      rrRatio: 2.0,
      brokerSpreadPips: 4.5
    });

    const res400 = runLongMemoryBPR(candles, 'XAUUSD', tf, {
      minFvgGap: cfg.minFvg,
      minOverlap: cfg.minOverlap,
      minRange: cfg.minRange,
      maxLookback: 400,
      bufferPips: cfg.buffer * 10,
      rrRatio: 2.0,
      brokerSpreadPips: 4.5
    });

    console.log(`XAUUSD ${tf} Memoria  25 velas: ${res25.trades} trades | WR: ${res25.winRate} | PF: ${res25.pf} | Net: ${res25.netPips}p | DD: ${res25.maxDD}p`);
    console.log(`XAUUSD ${tf} Memoria 400 velas: ${res400.trades} trades | WR: ${res400.winRate} | PF: ${res400.pf} | Net: ${res400.netPips}p | DD: ${res400.maxDD}p | Trades Antiguos: ${res400.oldTradesCount} (WR: ${res400.oldWinRate})\n`);
  }
}

main().catch(console.error);
