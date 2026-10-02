/**
 * Simulación de Interés Compuesto Realista (con Límite de Lotes del Broker: Max 20-50 Lotes)
 * Evolución Mes a Mes partiendo de $100 USD
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M3  = path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv');
const CSV_M5  = path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv');
const CSV_M15 = path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv');

async function loadCandles(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const [y, m, d] = parts[0].split('.').map(Number);
    const [h, min, s] = parts[1].split(':').map(Number);
    const timeMs = new Date(Date.UTC(y, m - 1, d, h, min, s)).getTime();

    candles.push({
      dateStr: parts[0],
      monthKey: `${y}-${String(m).padStart(2, '0')}`,
      timeMs,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  let ema100 = candles[0].close;
  const k100 = 2 / (100 + 1);
  candles.forEach(c => {
    ema100 = c.close * k100 + ema100 * (1 - k100);
    c.ema100 = ema100;
  });

  return candles;
}

function findBprZones(candles, cfg) {
  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    if (isBullishFVG && (i - lastBearishFVGIdx) <= 10 && (i - lastBearishFVGIdx) > 0) {
      const bearTop = candles[lastBearishFVGIdx - 2].low;
      const bearBottom = candles[lastBearishFVGIdx].high;
      const bullTop = c0.low;
      const bullBottom = c2.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);
      if (cHigh > cLow + cfg.minOverlap) {
        bprZones.push({ type: 'BULLISH', createdIdx: i, top: cHigh, bottom: cLow, timeMs: c0.timeMs });
      }
    }

    if (isBearishFVG && (i - lastBullishFVGIdx) <= 10 && (i - lastBullishFVGIdx) > 0) {
      const bullTop = candles[lastBullishFVGIdx].low;
      const bullBottom = candles[lastBullishFVGIdx - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const cLow = Math.max(bullBottom, bearBottom);
      const cHigh = Math.min(bullTop, bearTop);
      if (cHigh > cLow + cfg.minOverlap) {
        bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow, timeMs: c0.timeMs });
      }
    }
  }
  return bprZones;
}

function extractSignals(tf, candles, bprZones, cfg) {
  const signals = [];
  let lastTradeIdx = -100;

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 45); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      if (bar.hour === 23 || (bar.hour === 0 && bar.minute < 30)) continue;
      const candleRange = bar.high - bar.low;
      if (candleRange < cfg.minRange) continue;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < 0.25) continue;
          if (bar.close < bar.ema100) continue;

          lastTradeIdx = k;
          signals.push({
            tf,
            type: 'BUY',
            entryIdx: k,
            timeMs: bar.timeMs,
            monthKey: bar.monthKey,
            entry: bpr.top,
            sl: bpr.bottom - (cfg.slPips / 10.0),
            slPips: cfg.slPips,
            tp1: bpr.top + (cfg.tp1Pips / 10.0),
            tp2: bpr.top + (cfg.tp2Pips / 10.0),
            tp1Pips: cfg.tp1Pips,
            tp2Pips: cfg.tp2Pips,
            autoBePips: cfg.autoBe,
            spread: bar.spreadPips
          });
          break;
        }
      } else {
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.5) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < 0.25) continue;
          if (bar.close > bar.ema100) continue;

          lastTradeIdx = k;
          signals.push({
            tf,
            type: 'SELL',
            entryIdx: k,
            timeMs: bar.timeMs,
            monthKey: bar.monthKey,
            entry: bpr.bottom,
            sl: bpr.top + (cfg.slPips / 10.0),
            slPips: cfg.slPips,
            tp1: bpr.bottom - (cfg.tp1Pips / 10.0),
            tp2: bpr.bottom - (cfg.tp2Pips / 10.0),
            tp1Pips: cfg.tp1Pips,
            tp2Pips: cfg.tp2Pips,
            autoBePips: cfg.autoBe,
            spread: bar.spreadPips
          });
          break;
        }
      }
    }
  });

  return signals;
}

function evaluateTradeOutcome(sig, candles) {
  const k = sig.entryIdx;
  let currentSL = sig.sl;
  let tp1Hit = false;
  let pips = 0;
  let exitTimeMs = sig.timeMs;

  for (let m = k + 1; m < Math.min(candles.length, k + 100); m++) {
    const bar = candles[m];
    exitTimeMs = bar.timeMs;

    if (sig.type === 'BUY') {
      if (bar.low <= currentSL) {
        const diff = (currentSL - sig.entry) * 10 - bar.spreadPips;
        pips = tp1Hit ? (sig.tp1Pips * 0.5 + diff * 0.5) : diff;
        break;
      }
      if (!tp1Hit && bar.high >= sig.tp1) {
        tp1Hit = true;
        currentSL = sig.entry + 0.2;
      }
      if (!tp1Hit && bar.high >= sig.entry + (sig.autoBePips / 10.0)) {
        if (currentSL < sig.entry + 0.2) currentSL = sig.entry + 0.2;
      }
      if (bar.high >= sig.tp2) {
        pips = tp1Hit ? (sig.tp1Pips * 0.5 + sig.tp2Pips * 0.5) : sig.tp2Pips;
        break;
      }
    } else {
      if (bar.high >= currentSL) {
        const diff = (sig.entry - currentSL) * 10 - bar.spreadPips;
        pips = tp1Hit ? (sig.tp1Pips * 0.5 + diff * 0.5) : diff;
        break;
      }
      if (!tp1Hit && bar.low <= sig.tp1) {
        tp1Hit = true;
        currentSL = sig.entry - 0.2;
      }
      if (!tp1Hit && bar.low <= sig.entry - (sig.autoBePips / 10.0)) {
        if (currentSL > sig.entry - 0.2) currentSL = sig.entry - 0.2;
      }
      if (bar.low <= sig.tp2) {
        pips = tp1Hit ? (sig.tp1Pips * 0.5 + sig.tp2Pips * 0.5) : sig.tp2Pips;
        break;
      }
    }
  }

  if (pips === 0 && tp1Hit) pips = sig.tp1Pips * 0.5;

  return {
    ...sig,
    exitTimeMs,
    pips: parseFloat(pips.toFixed(1))
  };
}

async function runRealisticCompounding() {
  const [candlesM3, candlesM5, candlesM15] = await Promise.all([
    loadCandles(CSV_M3),
    loadCandles(CSV_M5),
    loadCandles(CSV_M15)
  ]);

  const cfgM3  = { minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0, autoBe: 20.0, minRange: 0.25 };
  const cfgM5  = { minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0, autoBe: 25.0, minRange: 0.35 };
  const cfgM15 = { minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60 };

  const sM3  = extractSignals('M3', candlesM3, findBprZones(candlesM3, cfgM3), cfgM3).map(s => evaluateTradeOutcome(s, candlesM3));
  const sM5  = extractSignals('M5', candlesM5, findBprZones(candlesM5, cfgM5), cfgM5).map(s => evaluateTradeOutcome(s, candlesM5));
  const sM15 = extractSignals('M15', candlesM15, findBprZones(candlesM15, cfgM15), cfgM15).map(s => evaluateTradeOutcome(s, candlesM15));

  const allTrades = [...sM3, ...sM5, ...sM15].sort((a, b) => a.timeMs - b.timeMs);

  function simulateRealistic(riskPct, maxLots = 20.0) {
    let balance = 100.0;
    const monthlyStats = {};
    let openPositions = [];

    allTrades.forEach(t => {
      openPositions = openPositions.filter(p => p.exitTimeMs > t.timeMs);

      const marginPer001 = (t.entry * 1.0) / 500.0;
      const usedMargin = openPositions.reduce((acc, p) => acc + p.margin, 0);
      const freeMargin = Math.max(0, balance - usedMargin);

      const targetRiskUSD = balance * (riskPct / 100.0);
      const slDistUSDPerLot = t.slPips * 10.0;

      let rawLots = targetRiskUSD / slDistUSDPerLot;
      let lots = Math.max(0.01, Math.floor(rawLots * 100) / 100);

      // Tope máximo de lotes impuesto por liquidez de broker
      if (lots > maxLots) lots = maxLots;

      const requiredMargin = (lots / 0.01) * marginPer001;

      if (requiredMargin > freeMargin) {
        const maxPossibleLots = Math.floor(freeMargin / marginPer001) * 0.01;
        if (maxPossibleLots >= 0.01) {
          lots = parseFloat(maxPossibleLots.toFixed(2));
        } else {
          return;
        }
      }

      openPositions.push({ exitTimeMs: t.exitTimeMs, margin: (lots / 0.01) * marginPer001 });

      const pnlUSD = t.pips * 10.0 * lots;
      balance += pnlUSD;

      if (!monthlyStats[t.monthKey]) {
        monthlyStats[t.monthKey] = { trades: 0, pips: 0, pnlUSD: 0, endBalance: 0 };
      }
      monthlyStats[t.monthKey].trades++;
      monthlyStats[t.monthKey].pips += t.pips;
      monthlyStats[t.monthKey].pnlUSD += pnlUSD;
      monthlyStats[t.monthKey].endBalance = balance;
    });

    return { balance, monthlyStats };
  }

  console.log('========================================================================================');
  console.log('📈 EVOLUCIÓN MENSUAL DETALLADA: CUENTA DE $100 USD (Apalancamiento 1:500)');
  console.log('   Estrategia: BPR Portafolio (M3 + M5 + M15) | Riesgo: 2.0% por Trade (Max 10 lotes broker)');
  console.log('========================================================================================\n');

  const sim2pct = simulateRealistic(2.0, 10.0);

  const monthRows = Object.entries(sim2pct.monthlyStats).map(([month, data]) => ({
    'Mes': month,
    'Trades': data.trades,
    'Pips Mes': (data.pips >= 0 ? '+' : '') + data.pips.toFixed(1) + 'p',
    'PnL Mes ($USD)': (data.pnlUSD >= 0 ? '+' : '') + '$' + data.pnlUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    'Saldo al Cierre': '$' + data.endBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }));

  console.table(monthRows);

  console.log('========================================================================================\n');
}

runRealisticCompounding();
