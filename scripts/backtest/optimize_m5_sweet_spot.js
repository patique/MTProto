/**
 * Optimización en M5 (100,000 velas, Abril 2025 - Septiembre 2026)
 * Buscando frecuencia de 150-400 trades/año con >65% Win Rate y PF > 1.30
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_FILE = path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv');

async function runM5SweetSpot() {
  const fileStream = fs.createReadStream(CSV_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 9) continue;

    const timeParts = parts[1].split(':');
    candles.push({
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

  // Pre-calcular RSI 14 en M5
  calcRSI(candles, 14, 'rsi14');
  calcRSI(candles, 9, 'rsi9');

  console.log(`\n========================================================================================`);
  console.log(`🚀 OPTIMIZACIÓN EN M5 (100,000 VELAS REALES DE BROKER: ABR 2025 - SEP 2026)`);
  console.log(`========================================================================================\n`);

  const results = [];
  const rsiKeys = ['rsi14', 'rsi9'];
  const rsiExtremes = [
    { low: 15, high: 85 },
    { low: 20, high: 80 },
    { low: 22, high: 78 },
    { low: 25, high: 75 }
  ];
  const wickThresholds = [0.35, 0.45, 0.50];
  const slDistances = [50, 65, 80];
  const tp1Distances = [25, 30, 35];

  for (const rsiKey of rsiKeys) {
    for (const rsiExt of rsiExtremes) {
      for (const wickThresh of wickThresholds) {
        for (const slPips of slDistances) {
          for (const tp1Pips of tp1Distances) {
            const res = evaluateStrategy(candles, {
              rsiKey,
              rsiLow: rsiExt.low,
              rsiHigh: rsiExt.high,
              wickRatio: wickThresh,
              slPips,
              tp1Pips,
              beTriggerPips: Math.max(15, tp1Pips - 10),
              tp2Pips: tp1Pips * 2
            });

            const tradesPerYear = (res.trades / 1.42).toFixed(0);
            if (res.trades >= 60 && res.winRate >= 60 && res.pf >= 1.15) {
              results.push({
                config: `${rsiKey.toUpperCase()} [${rsiExt.low}/${rsiExt.high}] | Mecha: ${(wickThresh*100)}% | SL: ${slPips}p | TP1: ${tp1Pips}p`,
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

  results.sort((a, b) => b.pf - a.pf);

  if (results.length === 0) {
    console.log('No se encontraron configuraciones M5 con WR >= 60% y PF >= 1.15');
  } else {
    results.slice(0, 10).forEach((r, idx) => {
      console.log(`${(idx + 1).toString().padStart(2)}. ${r.config}`);
      console.log(`    Trades: ${r.trades} (~${r.tradesPerYear}/año | ~${(r.tradesPerYear/250).toFixed(1)} trades/día) | Win Rate: ${r.winRate.toFixed(1)}% | PF: ${r.pf.toFixed(2)} | Pips: +${r.pips.toFixed(1)} | MaxDD: -${r.maxDD.toFixed(1)}p\n`);
    });
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
    if (i - lastTradeIdx < 6) continue; // 30 min de separación

    const bar = candles[i];
    if (bar.hour < 8 || bar.hour > 19) continue;

    const rsi = bar[cfg.rsiKey];
    const candleRange = bar.high - bar.low;
    if (candleRange <= 0.4) continue;

    let action = null;

    if (rsi <= cfg.rsiLow) {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      if (lowerWick / candleRange >= cfg.wickRatio) {
        action = 'BUY';
      }
    } else if (rsi >= cfg.rsiHigh) {
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

      for (let k = i + 1; k < Math.min(candles.length, i + 60); k++) {
        const c = candles[k];
        if (isBuy) {
          if (c.low <= currentSL) {
            const exitPips = (currentSL - entryPrice) * 10 - c.spreadPips;
            pipsGained = tp1Hit ? (cfg.tp1Pips * 0.5 + exitPips * 0.5) : exitPips;
            break;
          }
          if (!tp1Hit && c.high >= entryPrice + tp1Dist) {
            tp1Hit = true;
            currentSL = entryPrice;
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

runM5SweetSpot();
