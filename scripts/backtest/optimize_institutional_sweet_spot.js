/**
 * Optimización Cuantitativa de Estrategia Institucional de Oro (XAUUSD)
 * Encuentra el "Sweet Spot" matemático:
 * - Tasa de acierto > 68%
 * - Profit Factor > 1.50
 * - Frecuencia: 100 - 350 trades/año (1-2 operaciones/día)
 * 
 * Datos: XAUUSD M15 Real Broker (2024-2026, 65,000 velas)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_FILE = path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv');

async function runOptimizationGrid() {
  const fileStream = fs.createReadStream(CSV_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 9) continue;

    const dateParts = parts[0].split('.');
    const timeParts = parts[1].split(':');
    const timestamp = Date.UTC(
      parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]),
      parseInt(timeParts[0]), parseInt(timeParts[1]), parseInt(timeParts[2])
    );

    candles.push({
      timestamp,
      dateStr: `${parts[0]} ${parts[1]}`,
      hour: parseInt(timeParts[0]),
      minute: parseInt(timeParts[1]),
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parseFloat(parts[8]) / 10
    });
  }

  // Pre-calcular indicadores en M15:
  // RSI (periodo 14 y 7 para mayor agilidad intradiaria)
  // ATR 14
  // EMA 50 y EMA 200
  calculateIndicators(candles);

  console.log(`\n========================================================================================`);
  console.log(`🔍 BÚSQUEDA DEL SWEET SPOT MATEMÁTICO: ALTA FRECUENCIA + ALTA PRECISIÓN (2024 - 2026)`);
  console.log(`========================================================================================\n`);

  const results = [];

  // Parámetros a explorar:
  const rsiPeriods = [7, 14];
  const rsiExtremes = [
    { low: 20, high: 80 },
    { low: 25, high: 75 },
    { low: 28, high: 72 },
    { low: 30, high: 70 }
  ];
  const wickThresholds = [0.30, 0.40, 0.50];
  const slDistances = [40, 50, 60, 75]; // pips
  const tp1Distances = [25, 30, 35]; // pips

  for (const rsiPeriod of rsiPeriods) {
    for (const rsiExt of rsiExtremes) {
      for (const wickThresh of wickThresholds) {
        for (const slPips of slDistances) {
          for (const tp1Pips of tp1Distances) {
            const res = evaluateStrategy(candles, {
              rsiKey: rsiPeriod === 7 ? 'rsi7' : 'rsi14',
              rsiLow: rsiExt.low,
              rsiHigh: rsiExt.high,
              wickRatio: wickThresh,
              slPips,
              tp1Pips,
              beTriggerPips: Math.max(15, tp1Pips - 10),
              tp2Pips: tp1Pips * 2
            });

            const tradesPerYear = (res.trades / 2.75).toFixed(0);
            if (res.trades >= 50 && res.winRate >= 65 && res.pf >= 1.30) {
              results.push({
                config: `RSI${rsiPeriod} [${rsiExt.low}/${rsiExt.high}] | Mecha: ${(wickThresh*100)}% | SL: ${slPips}p | TP1: ${tp1Pips}p`,
                trades: res.trades,
                tradesPerYear: parseInt(tradesPerYear),
                winRate: res.winRate,
                pips: res.totalPips,
                pf: res.pf,
                maxDD: res.maxDD
              });
            }
          }
        }
      }
    }
  }

  // Ordenar por Rentabilidad y Profit Factor
  results.sort((a, b) => b.pf - a.pf);

  console.log(`🏆 TOP CONFIGURACIONES GANADORAS CON MÁS DE 65% WIN RATE Y PF > 1.30:\n`);
  if (results.length === 0) {
    console.log('No se encontraron configuraciones que cumplan el criterio estricto de >65% WR y PF>1.30');
  } else {
    results.slice(0, 10).forEach((r, idx) => {
      console.log(`${(idx + 1).toString().padStart(2)}. ${r.config}`);
      console.log(`    Trades: ${r.trades} (~${r.tradesPerYear}/año) | Win Rate: ${r.winRate.toFixed(1)}% | PF: ${r.pf.toFixed(2)} | Pips: +${r.pips.toFixed(1)} | MaxDD: -${r.maxDD.toFixed(1)}p\n`);
    });
  }
}

function calculateIndicators(candles) {
  // RSI 14
  calcRSI(candles, 14, 'rsi14');
  // RSI 7 (Reversión rápida intradiaria)
  calcRSI(candles, 7, 'rsi7');

  // EMA 50 y EMA 200
  let ema50 = candles[0].close;
  let ema200 = candles[0].close;
  const k50 = 2 / (50 + 1);
  const k200 = 2 / (200 + 1);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    ema50 = c.close * k50 + ema50 * (1 - k50);
    ema200 = c.close * k200 + ema200 * (1 - k200);
    c.ema50 = ema50;
    c.ema200 = ema200;
  }
}

function calcRSI(candles, period, key) {
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) { c[key] = 50; continue; }

    const diff = c.close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      c[key] = 50;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      c[key] = 100 - (100 / (1 + rs));
    }
  }
}

function evaluateStrategy(candles, cfg) {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let totalPips = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let peakPips = 0;
  let maxDD = 0;
  let lastTradeIdx = -100;

  const slDist = cfg.slPips * 0.1;
  const tp1Dist = cfg.tp1Pips * 0.1;
  const beDist = cfg.beTriggerPips * 0.1;
  const tp2Dist = cfg.tp2Pips * 0.1;

  for (let i = 50; i < candles.length - 40; i++) {
    if (i - lastTradeIdx < 4) continue; // 1 hora de separación

    const bar = candles[i];
    // Horario líquido de sesiones (08:00 a 19:00 broker time)
    if (bar.hour < 8 || bar.hour > 19) continue;

    const rsi = bar[cfg.rsiKey];
    const candleRange = bar.high - bar.low;
    if (candleRange <= 0.4) continue;

    let action = null;

    // Compra en agotamiento bajista con rechazo
    if (rsi <= cfg.rsiLow) {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      if (lowerWick / candleRange >= cfg.wickRatio) {
        action = 'BUY';
      }
    }
    // Venta en agotamiento alcista con rechazo
    else if (rsi >= cfg.rsiHigh) {
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      if (upperWick / candleRange >= cfg.wickRatio) {
        action = 'SELL';
      }
    }

    if (action) {
      trades++;
      lastTradeIdx = i;
      const isBuy = action === 'BUY';
      const entryPrice = bar.close;
      let currentSL = isBuy ? (entryPrice - slDist) : (entryPrice + slDist);
      let tp1Hit = false;
      let pipsGained = 0;

      for (let k = i + 1; k < Math.min(candles.length, i + 48); k++) {
        const c = candles[k];
        if (isBuy) {
          if (c.low <= currentSL) {
            const exitPips = (currentSL - entryPrice) * 10 - c.spreadPips;
            pipsGained = tp1Hit ? (cfg.tp1Pips * 0.5 + exitPips * 0.5) : exitPips;
            break;
          }
          if (!tp1Hit && c.high >= entryPrice + tp1Dist) {
            tp1Hit = true;
            currentSL = entryPrice; // Break-Even
          }
          if (!tp1Hit && c.high >= entryPrice + beDist && currentSL < entryPrice) {
            currentSL = entryPrice;
          }
          if (c.high >= entryPrice + tp2Dist) {
            pipsGained = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
            break;
          }
        } else {
          if (c.high >= currentSL) {
            const exitPips = (entryPrice - currentSL) * 10 - c.spreadPips;
            pipsGained = tp1Hit ? (cfg.tp1Pips * 0.5 + exitPips * 0.5) : exitPips;
            break;
          }
          if (!tp1Hit && c.low <= entryPrice - tp1Dist) {
            tp1Hit = true;
            currentSL = entryPrice;
          }
          if (!tp1Hit && c.low <= entryPrice - beDist && currentSL > entryPrice) {
            currentSL = entryPrice;
          }
          if (c.low <= entryPrice - tp2Dist) {
            pipsGained = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
            break;
          }
        }
      }

      if (pipsGained > 0) {
        wins++;
        grossProfit += pipsGained;
      } else {
        losses++;
        grossLoss += Math.abs(pipsGained);
      }
      totalPips += pipsGained;
      if (totalPips > peakPips) peakPips = totalPips;
      const dd = peakPips - totalPips;
      if (dd > maxDD) maxDD = dd;
    }
  }

  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  const pf = grossLoss > 0 ? (grossProfit / grossLoss) : 99;
  return { trades, winRate, pf, totalPips, maxDD };
}

runOptimizationGrid();
