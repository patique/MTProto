/**
 * Backtest Exhaustivo de Cartera Multitemporal BPR Sniper:
 * M1 + M2 + M3 + M5 + M15 Concurrente
 * 
 * Periodos Evaluados:
 * 1. Desde la fecha mínima disponible de M1 (17 Junio 2026 a 29 Septiembre 2026) con TODAS las 5 TFs simultáneas.
 * 2. Desde el 1 de Febrero de 2026 hasta hoy con la cartera completa ($100 USD inicial).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILES = {
  M1:  path.join(__dirname, '..', '..', 'XAUUSD_M1_202606171851_202609291057.csv'),
  M2:  path.join(__dirname, '..', '..', 'XAUUSD_M2_202603051240_202609291056.csv'),
  M3:  path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv'),
  M5:  path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv'),
  M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv')
};

const TF_CONFIG = {
  M1:  { tfMinutes: 1,  minFvgGap: 0.18, minOverlap: 0.12, slPips: 16.0, tp1Pips: 10.0, tp2Pips: 12.0,  autoBe: 8.0,  minRange: 0.22, minWickRatio: 0.35, useSessionFilter: true, useHtfEma: true },
  M2:  { tfMinutes: 2,  minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0,  autoBe: 18.0, minRange: 0.22, minWickRatio: 0.25 },
  M3:  { tfMinutes: 3,  minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0,  autoBe: 20.0, minRange: 0.25, minWickRatio: 0.25 },
  M5:  { tfMinutes: 5,  minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0,  autoBe: 25.0, minRange: 0.35, minWickRatio: 0.25 },
  M15: { tfMinutes: 15, minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60, minWickRatio: 0.25 }
};

async function loadCandles(filePath) {
  if (!fs.existsSync(filePath)) return [];
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
      timeStr: parts[1],
      fullDate: `${parts[0]} ${parts[1]}`,
      timeMs,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 4.4
    });
  }

  // Precalcular EMA 100
  if (candles.length > 0) {
    let ema100 = candles[0].close;
    const k100 = 2 / (100 + 1);
    candles.forEach(c => {
      ema100 = c.close * k100 + ema100 * (1 - k100);
      c.ema100 = ema100;
    });
  }

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

function getLatestMacroBar(macroCandles, timeMs) {
  let low = 0, high = macroCandles.length - 1, best = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (macroCandles[mid].timeMs <= timeMs) {
      best = macroCandles[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function extractSignals(tf, candles, bprZones, cfg, m15Candles = null) {
  const signals = [];
  let lastTradeIdx = -100;
  const minWickRatio = cfg.minWickRatio || 0.25;

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 45); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      // Anti-rollover (22:55 - 00:15)
      if (bar.hour === 23 || (bar.hour === 0 && bar.minute < 15)) continue;

      // Filtro de sesión M1 (07:00 a 18:00 UTC)
      if (cfg.useSessionFilter && (bar.hour < 7 || bar.hour >= 18)) continue;

      const candleRange = bar.high - bar.low;
      if (candleRange < cfg.minRange) continue;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if ((lowerWick / candleRange) < minWickRatio) continue;
          if (bar.close < bar.ema100) continue;

          // Filtro HTF M15 para M1
          if (cfg.useHtfEma && m15Candles) {
            const macroBar = getLatestMacroBar(m15Candles, bar.timeMs);
            if (macroBar && bar.close < macroBar.ema100) continue;
          }

          lastTradeIdx = k;
          signals.push({
            tf,
            type: 'BUY',
            entryIdx: k,
            timeMs: bar.timeMs,
            dateStr: bar.fullDate,
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
      } else { // BEARISH
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.5) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if ((upperWick / candleRange) < minWickRatio) continue;
          if (bar.close > bar.ema100) continue;

          // Filtro HTF M15 para M1
          if (cfg.useHtfEma && m15Candles) {
            const macroBar = getLatestMacroBar(m15Candles, bar.timeMs);
            if (macroBar && bar.close > macroBar.ema100) continue;
          }

          lastTradeIdx = k;
          signals.push({
            tf,
            type: 'SELL',
            entryIdx: k,
            timeMs: bar.timeMs,
            dateStr: bar.fullDate,
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
  let durationBars = 0;

  for (let m = k + 1; m < Math.min(candles.length, k + 100); m++) {
    const bar = candles[m];
    exitTimeMs = bar.timeMs;
    durationBars++;

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
    durationBars,
    pips: parseFloat(pips.toFixed(1))
  };
}

function runSimulation(tradeList, initialBalance = 100.0, riskPercent = 1.5, fixedLots = null, maxLots = null) {
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDD_USD = 0;
  let maxDD_Pct = 0;
  let wins = 0;
  let losses = 0;
  let executedCount = 0;
  let skippedMarginCount = 0;
  let openPositions = [];

  const tfStats = {
    M1:  { trades: 0, wins: 0, losses: 0, pips: 0 },
    M2:  { trades: 0, wins: 0, losses: 0, pips: 0 },
    M3:  { trades: 0, wins: 0, losses: 0, pips: 0 },
    M5:  { trades: 0, wins: 0, losses: 0, pips: 0 },
    M15: { trades: 0, wins: 0, losses: 0, pips: 0 }
  };

  tradeList.forEach(t => {
    // Liberar margen de posiciones cerradas
    openPositions = openPositions.filter(p => p.exitTimeMs > t.timeMs);

    const marginPer001 = (t.entry * 1.0) / 500.0; // apalancamiento 1:500
    const usedMargin = openPositions.reduce((acc, p) => acc + p.margin, 0);
    const freeMargin = Math.max(0, balance - usedMargin);

    let lots = 0.01;
    if (fixedLots) {
      lots = fixedLots;
    } else {
      const targetRiskUSD = balance * (riskPercent / 100.0);
      const slDistUSDPerLot = t.slPips * 10.0;
      const rawLots = targetRiskUSD / slDistUSDPerLot;
      lots = Math.max(0.01, Math.floor(rawLots * 100) / 100);
      if (maxLots && lots > maxLots) lots = maxLots;
    }

    const requiredMargin = (lots / 0.01) * marginPer001;
    if (requiredMargin > freeMargin) {
      const maxPossibleLots = Math.floor(freeMargin / marginPer001) * 0.01;
      if (maxPossibleLots >= 0.01) {
        lots = parseFloat(maxPossibleLots.toFixed(2));
      } else {
        skippedMarginCount++;
        return;
      }
    }

    const finalMargin = (lots / 0.01) * marginPer001;
    openPositions.push({ exitTimeMs: t.exitTimeMs, margin: finalMargin });
    executedCount++;

    const pnlUSD = t.pips * 10.0 * lots;
    balance += pnlUSD;

    if (t.pips > 0) {
      wins++;
      tfStats[t.tf].wins++;
    } else {
      losses++;
      tfStats[t.tf].losses++;
    }
    tfStats[t.tf].trades++;
    tfStats[t.tf].pips += t.pips;

    if (balance > peakBalance) peakBalance = balance;
    const currentDDUSD = peakBalance - balance;
    const currentDDPct = (currentDDUSD / peakBalance) * 100.0;
    if (currentDDUSD > maxDD_USD) maxDD_USD = currentDDUSD;
    if (currentDDPct > maxDD_Pct) maxDD_Pct = currentDDPct;

    if (balance <= 5.0) {
      balance = 0;
      return;
    }
  });

  return {
    initial: `$${initialBalance.toFixed(2)}`,
    finalBalance: balance > 0 ? `$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '$0.00 (STOP OUT)',
    netProfitUSD: balance > 0 ? `$${(balance - initialBalance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `-$${initialBalance.toFixed(2)}`,
    netProfitPercent: `+${(((balance - initialBalance) / initialBalance) * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`,
    multiplier: (balance / initialBalance).toFixed(1) + 'x',
    totalTrades: executedCount,
    wins,
    losses,
    winRate: executedCount > 0 ? `${((wins / executedCount) * 100).toFixed(1)}%` : '0%',
    maxDrawdownPct: `${maxDD_Pct.toFixed(1)}%`,
    skippedMargin: skippedMarginCount,
    tfStats
  };
}

async function main() {
  console.log('⏳ Cargando historial de velas de las 5 temporalidades...');
  const [candlesM1, candlesM2, candlesM3, candlesM5, candlesM15] = await Promise.all([
    loadCandles(FILES.M1),
    loadCandles(FILES.M2),
    loadCandles(FILES.M3),
    loadCandles(FILES.M5),
    loadCandles(FILES.M15)
  ]);

  console.log(`✅ Velas cargadas:`);
  console.log(`   M1:  ${candlesM1.length.toLocaleString()} velas (Desde: ${candlesM1[0].fullDate} hasta: ${candlesM1[candlesM1.length - 1].fullDate})`);
  console.log(`   M2:  ${candlesM2.length.toLocaleString()} velas (Desde: ${candlesM2[0].fullDate} hasta: ${candlesM2[candlesM2.length - 1].fullDate})`);
  console.log(`   M3:  ${candlesM3.length.toLocaleString()} velas (Desde: ${candlesM3[0].fullDate} hasta: ${candlesM3[candlesM3.length - 1].fullDate})`);
  console.log(`   M5:  ${candlesM5.length.toLocaleString()} velas (Desde: ${candlesM5[0].fullDate} hasta: ${candlesM5[candlesM5.length - 1].fullDate})`);
  console.log(`   M15: ${candlesM15.length.toLocaleString()} velas (Desde: ${candlesM15[0].fullDate} hasta: ${candlesM15[candlesM15.length - 1].fullDate})\n`);

  console.log('⏳ Extrayendo señales y evaluando desenlaces con spread real de broker...');
  const sM1  = extractSignals('M1',  candlesM1,  findBprZones(candlesM1,  TF_CONFIG.M1),  TF_CONFIG.M1, candlesM15).map(s => evaluateTradeOutcome(s, candlesM1));
  const sM2  = extractSignals('M2',  candlesM2,  findBprZones(candlesM2,  TF_CONFIG.M2),  TF_CONFIG.M2).map(s => evaluateTradeOutcome(s, candlesM2));
  const sM3  = extractSignals('M3',  candlesM3,  findBprZones(candlesM3,  TF_CONFIG.M3),  TF_CONFIG.M3).map(s => evaluateTradeOutcome(s, candlesM3));
  const sM5  = extractSignals('M5',  candlesM5,  findBprZones(candlesM5,  TF_CONFIG.M5),  TF_CONFIG.M5).map(s => evaluateTradeOutcome(s, candlesM5));
  const sM15 = extractSignals('M15', candlesM15, findBprZones(candlesM15, TF_CONFIG.M15), TF_CONFIG.M15).map(s => evaluateTradeOutcome(s, candlesM15));

  const allTrades = [...sM1, ...sM2, ...sM3, ...sM5, ...sM15].sort((a, b) => a.timeMs - b.timeMs);

  const m1StartTimeMs = candlesM1[0].timeMs; // 17 de Junio 2026 18:51
  const feb1TimeMs = new Date(Date.UTC(2026, 1, 1, 0, 0, 0)).getTime(); // 1 Febrero 2026

  // Filtro 1: Periodo simultáneo de TODAS las 5 TFs (Desde inicio de M1)
  const tradesSinceM1 = allTrades.filter(t => t.timeMs >= m1StartTimeMs);

  // Filtro 2: Desde 1 Febrero 2026
  const tradesSinceFeb = allTrades.filter(t => t.timeMs >= feb1TimeMs);

  console.log('========================================================================================');
  console.log('📊 ESCENARIO 1: TODAS LAS TEMPORALIDADES (M1 + M2 + M3 + M5 + M15) SIMULTÁNEAS');
  console.log(`   Periodo: ${candlesM1[0].fullDate} a ${candlesM1[candlesM1.length - 1].fullDate} (~3.5 Meses)`);
  console.log(`   Total Operaciones Concurrente: ${tradesSinceM1.length}`);
  console.log('========================================================================================\n');

  // Breakdown por TF en Periodo 1
  const tfSummarySinceM1 = {};
  ['M1', 'M2', 'M3', 'M5', 'M15'].forEach(tf => {
    const list = tradesSinceM1.filter(t => t.tf === tf);
    const wins = list.filter(t => t.pips > 0).length;
    const losses = list.length - wins;
    const pips = list.reduce((a, b) => a + b.pips, 0);
    const wr = list.length > 0 ? ((wins / list.length) * 100).toFixed(1) : 0;
    tfSummarySinceM1[tf] = {
      Trades: list.length,
      Wins: wins,
      Losses: losses,
      WinRate: `${wr}%`,
      NetPips: parseFloat(pips.toFixed(1))
    };
  });
  console.table(tfSummarySinceM1);

  console.log('\n--- SIMULACIÓN DE CUENTA DE $100 USD EN EL PERIODO SIMULTÁNEO (Desde 17 Junio 2026) ---');
  const sim1Fixed = runSimulation(tradesSinceM1, 100.0, null, 0.01);
  const sim1Cap5 = runSimulation(tradesSinceM1, 100.0, 1.5, null, 5.0);
  const sim1Cap10 = runSimulation(tradesSinceM1, 100.0, 1.5, null, 10.0);
  const sim1Uncapped = runSimulation(tradesSinceM1, 100.0, 1.5, null, null);

  console.log('\n[Modo Lote Fijo 0.01 Lotes Conservador]');
  console.log(`Saldo Inicial: $100.00 -> Saldo Final: ${sim1Fixed.finalBalance} (${sim1Fixed.netProfitPercent}) | Drawdown Máx: ${sim1Fixed.maxDrawdownPct} | Trades: ${sim1Fixed.totalTrades} (WR: ${sim1Fixed.winRate})`);

  console.log('\n[Modo Interés Compuesto Dinámico (1.5% Riesgo con Apalancamiento 1:500)]');
  console.table([
    { Modelo: 'Lote Fijo 0.01', Final: sim1Fixed.finalBalance, Rendimiento: sim1Fixed.netProfitPercent, MaxDD: sim1Fixed.maxDrawdownPct, Trades: sim1Fixed.totalTrades, WinRate: sim1Fixed.winRate },
    { Modelo: 'Compuesto 1.5% (Tope 5.0 lotes)', Final: sim1Cap5.finalBalance, Rendimiento: sim1Cap5.netProfitPercent, MaxDD: sim1Cap5.maxDrawdownPct, Trades: sim1Cap5.totalTrades, WinRate: sim1Cap5.winRate },
    { Modelo: 'Compuesto 1.5% (Tope 10.0 lotes)', Final: sim1Cap10.finalBalance, Rendimiento: sim1Cap10.netProfitPercent, MaxDD: sim1Cap10.maxDrawdownPct, Trades: sim1Cap10.totalTrades, WinRate: sim1Cap10.winRate },
    { Modelo: 'Compuesto 1.5% (Sin Límite Lote)', Final: sim1Uncapped.finalBalance, Rendimiento: sim1Uncapped.netProfitPercent, MaxDD: sim1Uncapped.maxDrawdownPct, Trades: sim1Uncapped.totalTrades, WinRate: sim1Uncapped.winRate }
  ]);

  console.log('\n========================================================================================');
  console.log('📈 ESCENARIO 2: CUENTA DE $100 USD DESDE EL 1 DE FEBRERO DE 2026 HASTA HOY');
  console.log(`   Periodo: 01 Feb 2026 a 29 Sep 2026 (~8 Meses)`);
  console.log(`   (M2/M3/M5/M15 desde Febrero + M1 integrándose desde Junio)`);
  console.log(`   Total Operaciones del Portafolio: ${tradesSinceFeb.length}`);
  console.log('========================================================================================\n');

  const tfSummarySinceFeb = {};
  ['M1', 'M2', 'M3', 'M5', 'M15'].forEach(tf => {
    const list = tradesSinceFeb.filter(t => t.tf === tf);
    const wins = list.filter(t => t.pips > 0).length;
    const losses = list.length - wins;
    const pips = list.reduce((a, b) => a + b.pips, 0);
    const wr = list.length > 0 ? ((wins / list.length) * 100).toFixed(1) : 0;
    tfSummarySinceFeb[tf] = {
      Trades: list.length,
      Wins: wins,
      Losses: losses,
      WinRate: `${wr}%`,
      NetPips: parseFloat(pips.toFixed(1))
    };
  });
  console.table(tfSummarySinceFeb);

  const simFebFixed = runSimulation(tradesSinceFeb, 100.0, null, 0.01);
  const simFebCap5 = runSimulation(tradesSinceFeb, 100.0, 1.5, null, 5.0);
  const simFebCap10 = runSimulation(tradesSinceFeb, 100.0, 1.5, null, 10.0);
  const simFebUncapped = runSimulation(tradesSinceFeb, 100.0, 1.5, null, null);

  console.log('\n[Modo Lote Fijo 0.01 Lotes Conservador (Desde 1 Febrero)]');
  console.log(`Saldo Inicial: $100.00 -> Saldo Final: ${simFebFixed.finalBalance} (${simFebFixed.netProfitPercent}) | Drawdown Máx: ${simFebFixed.maxDrawdownPct} | Trades: ${simFebFixed.totalTrades} (WR: ${simFebFixed.winRate})`);

  console.log('\n[Modo Interés Compuesto Dinámico (1.5% Riesgo con Apalancamiento 1:500)]');
  console.table([
    { Modelo: 'Lote Fijo 0.01', Final: simFebFixed.finalBalance, Rendimiento: simFebFixed.netProfitPercent, MaxDD: simFebFixed.maxDrawdownPct, Trades: simFebFixed.totalTrades, WinRate: simFebFixed.winRate },
    { Modelo: 'Compuesto 1.5% (Tope 5.0 lotes)', Final: simFebCap5.finalBalance, Rendimiento: simFebCap5.netProfitPercent, MaxDD: simFebCap5.maxDrawdownPct, Trades: simFebCap5.totalTrades, WinRate: simFebCap5.winRate },
    { Modelo: 'Compuesto 1.5% (Tope 10.0 lotes)', Final: simFebCap10.finalBalance, Rendimiento: simFebCap10.netProfitPercent, MaxDD: simFebCap10.maxDrawdownPct, Trades: simFebCap10.totalTrades, WinRate: simFebCap10.winRate },
    { Modelo: 'Compuesto 1.5% (Sin Límite Lote)', Final: simFebUncapped.finalBalance, Rendimiento: simFebUncapped.netProfitPercent, MaxDD: simFebUncapped.maxDrawdownPct, Trades: simFebUncapped.totalTrades, WinRate: simFebUncapped.winRate }
  ]);
}

main().catch(console.error);
