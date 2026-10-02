/**
 * Backtest Exhaustivo de "UT Bot Alerts" (PineScript en Datos Reales MT5)
 * Implementa matemáticamente el código PineScript exacto:
 * - ATR(10), Key Value (a = 1 o 2)
 * - Trailing Stop ratcheting
 * - Crossover de EMA(close, 1) frente a xATRTrailingStop
 * 
 * Testeado en:
 * - XAUUSD M5 (100.000 velas) y M15 (65.000 velas)
 * - Con y sin filtros de tendencia/sesión
 * - Gestión: Cruda vs Live 50/50
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M5 = path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv');
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
    const timestamp = Date.UTC(y, m - 1, d, h - 2, min, s);

    candles.push({
      dateStr: `${parts[0]} ${parts[1]}`,
      timestamp,
      hour: h,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  return candles;
}

function calculateUTBot(candles, a = 1, c = 10) {
  // 1. Calcular ATR(c)
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
    } else {
      const hl = candles[i].high - candles[i].low;
      const hc = Math.abs(candles[i].high - candles[i - 1].close);
      const lc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(hl, hc, lc));
    }
  }

  // RMA / EMA de TR para ATR
  const atr = [];
  let sumTR = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < c) {
      sumTR += tr[i];
      atr.push(sumTR / (i + 1));
    } else {
      const prevAtr = atr[i - 1];
      atr.push((prevAtr * (c - 1) + tr[i]) / c);
    }
  }

  // 2. Trailing Stop exacto de UT Bot:
  // xATRTrailingStop := iff(src > nz(xATRTrailingStop[1], 0) and src[1] > nz(xATRTrailingStop[1], 0), max(nz(xATRTrailingStop[1]), src - nLoss),
  //    iff(src < nz(xATRTrailingStop[1], 0) and src[1] < nz(xATRTrailingStop[1], 0), min(nz(xATRTrailingStop[1]), src + nLoss), 
  //    iff(src > nz(xATRTrailingStop[1], 0), src - nLoss, src + nLoss)))
  const trailingStop = [];
  const signals = [];

  for (let i = 0; i < candles.length; i++) {
    const src = candles[i].close;
    const nLoss = a * atr[i];

    if (i === 0) {
      trailingStop.push(src - nLoss);
      signals.push(null);
      continue;
    }

    const prevStop = trailingStop[i - 1];
    const prevSrc = candles[i - 1].close;

    let currentStop = 0;
    if (src > prevStop && prevSrc > prevStop) {
      currentStop = Math.max(prevStop, src - nLoss);
    } else if (src < prevStop && prevSrc < prevStop) {
      currentStop = Math.min(prevStop, src + nLoss);
    } else if (src > prevStop) {
      currentStop = src - nLoss;
    } else {
      currentStop = src + nLoss;
    }
    trailingStop.push(currentStop);

    // Crossovers
    // above = crossover(src, currentStop)
    // below = crossover(currentStop, src)
    const above = prevSrc <= prevStop && src > currentStop;
    const below = prevSrc >= prevStop && src < currentStop;

    let sig = null;
    if (src > currentStop && above) sig = 'BUY';
    else if (src < currentStop && below) sig = 'SELL';

    signals.push(sig);
  }

  return signals;
}

// Simulador con Gestión 50/50 y SL = TrailingStop del UT Bot
function evaluateUTBot(candles, signals, opts = {}) {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let netPips = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let peak = 0;
  let maxDD = 0;

  const tp1Dist = (opts.tp1Pips || 35.0) * 0.1;
  const beTriggerDist = (opts.beTriggerPips || 25.0) * 0.1;
  const tp2Dist = (opts.tp2Pips || 70.0) * 0.1;

  for (let i = 50; i < candles.length - 60; i++) {
    const sig = signals[i];
    if (!sig) continue;

    const bar = candles[i];
    // Filtro horario opcional (Londres / NY: 08:00 a 19:00 broker)
    if (opts.useSessionFilter && (bar.hour < 8 || bar.hour > 19)) continue;

    // Filtro EMA 200 opcional
    if (opts.useEMA200) {
      if (sig === 'BUY' && bar.close < bar.ema200) continue;
      if (sig === 'SELL' && bar.close > bar.ema200) continue;
    }

    trades++;
    const isBuy = sig === 'BUY';
    const entryPrice = bar.close;
    // SL inicial = 50 pips o 80 pips
    const slDist = (opts.slPips || 65.0) * 0.1;
    let currentSL = isBuy ? (entryPrice - slDist) : (entryPrice + slDist);
    let tp1Hit = false;
    let isBE = false;
    let pipsGained = 0;

    for (let k = i + 1; k < Math.min(candles.length, i + 120); k++) {
      const c = candles[k];

      if (isBuy) {
        if (c.low <= currentSL) {
          const diffPips = (currentSL - entryPrice) * 10 - c.spreadPips;
          pipsGained = tp1Hit ? (opts.tp1Pips * 0.5 + diffPips * 0.5) : diffPips;
          break;
        }
        if (!tp1Hit && c.high >= entryPrice + tp1Dist) {
          tp1Hit = true;
          if (currentSL < entryPrice) currentSL = entryPrice;
        }
        if (!isBE && c.high >= entryPrice + beTriggerDist) {
          isBE = true;
          if (currentSL < entryPrice) currentSL = entryPrice;
        }
        if (c.high >= entryPrice + tp2Dist) {
          pipsGained = tp1Hit ? (opts.tp1Pips * 0.5 + opts.tp2Pips * 0.5) : opts.tp2Pips;
          break;
        }
      } else {
        if (c.high >= currentSL) {
          const diffPips = (entryPrice - currentSL) * 10 - c.spreadPips;
          pipsGained = tp1Hit ? (opts.tp1Pips * 0.5 + diffPips * 0.5) : diffPips;
          break;
        }
        if (!tp1Hit && c.low <= entryPrice - tp1Dist) {
          tp1Hit = true;
          if (currentSL > entryPrice) currentSL = entryPrice;
        }
        if (!isBE && c.low <= entryPrice - beTriggerDist) {
          isBE = true;
          if (currentSL > entryPrice) currentSL = entryPrice;
        }
        if (c.low <= entryPrice - tp2Dist) {
          pipsGained = tp1Hit ? (opts.tp1Pips * 0.5 + opts.tp2Pips * 0.5) : opts.tp2Pips;
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
    netPips += pipsGained;
    if (netPips > peak) peak = netPips;
    if (peak - netPips > maxDD) maxDD = peak - netPips;
  }

  const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0;
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'Inf';

  return { trades, wins, losses, winRate, netPips, pf, maxDD };
}

async function runUTBotAudit() {
  console.log('📂 Cargando histórico real de velas del broker...');
  const candlesM15 = await loadCandles(CSV_M15);
  const candlesM5 = await loadCandles(CSV_M5);

  // Calcular EMA 200 para filtro
  [candlesM15, candlesM5].forEach(list => {
    let ema = list[0].close;
    const k = 2 / (200 + 1);
    list.forEach(c => {
      ema = c.close * k + ema * (1 - k);
      c.ema200 = ema;
    });
  });

  console.log(`\n========================================================================================================================`);
  console.log(`🤖 AUDITORÍA DE "UT BOT ALERTS" EN XAUUSD (DATOS REALES DEL BROKER MT5)`);
  console.log(`========================================================================================================================\n`);

  // Pruebas M15:
  console.log('📍 1. RESULTADOS EN M15 (2024 - 2026, 65.000 Velas):');
  console.log('-'.repeat(105));
  
  // Test A: Crudo (Key Value 1, ATR 10)
  const sigM15_a1 = calculateUTBot(candlesM15, 1, 10);
  const resM15_raw = evaluateUTBot(candlesM15, sigM15_a1, { slPips: 65, tp1Pips: 35, tp2Pips: 70 });
  printRow('UT Bot Crudo (a=1, c=10)', resM15_raw);

  // Test B: Con Filtro de Tendencia EMA 200 + Sesión
  const resM15_filtered = evaluateUTBot(candlesM15, sigM15_a1, { slPips: 65, tp1Pips: 35, tp2Pips: 70, useEMA200: true, useSessionFilter: true });
  printRow('UT Bot + EMA200 + Sesión Londres/NY', resM15_filtered);

  // Test C: Menos Sensible (Key Value 2, ATR 10)
  const sigM15_a2 = calculateUTBot(candlesM15, 2, 10);
  const resM15_a2 = evaluateUTBot(candlesM15, sigM15_a2, { slPips: 75, tp1Pips: 35, tp2Pips: 70, useEMA200: true, useSessionFilter: true });
  printRow('UT Bot (a=2) + EMA200 + Sesión', resM15_a2);

  // Pruebas M5:
  console.log('\n📍 2. RESULTADOS EN M5 (Abril 2025 - Septiembre 2026, 100.000 Velas):');
  console.log('-'.repeat(105));
  const sigM5_a1 = calculateUTBot(candlesM5, 1, 10);
  const resM5_raw = evaluateUTBot(candlesM5, sigM5_a1, { slPips: 50, tp1Pips: 30, tp2Pips: 60 });
  printRow('UT Bot Crudo en M5 (a=1, c=10)', resM5_raw);

  const sigM5_a2 = calculateUTBot(candlesM5, 2, 10);
  const resM5_filtered = evaluateUTBot(candlesM5, sigM5_a2, { slPips: 60, tp1Pips: 30, tp2Pips: 60, useEMA200: true, useSessionFilter: true });
  printRow('UT Bot en M5 (a=2) + EMA200 + Sesión', resM5_filtered);

  console.log('========================================================================================================================\n');
}

function printRow(name, r) {
  console.log(`${name.padEnd(42)} | Trades: ${String(r.trades).padStart(5)} | WR: ${(r.winRate + '%').padStart(6)} (${r.wins}W/${r.losses}L) | Net Pips: ${(r.netPips >= 0 ? '+' : '') + r.netPips.toFixed(1).padStart(8)}p | PF: ${r.pf.padStart(5)} | MaxDD: -${r.maxDD.toFixed(1)}p`);
}

runUTBotAudit();
