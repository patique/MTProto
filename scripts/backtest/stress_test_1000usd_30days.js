/**
 * Stress Test de Robustez Monte Carlo / Ventanas Rodantes de 30 Días
 * Cuenta: $1,000 USD iniciales
 * Apalancamiento: 1:500
 * Evalúa múltiples ventanas de 30 días a lo largo de todo el histórico
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
            dateStr: bar.dateStr,
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
            dateStr: bar.dateStr,
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

async function runStressTest() {
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

  // Seleccionamos 6 periodos distintos de 30 días para estrés:
  // 1. Enero 2026 (Comienzo de año)
  // 2. Marzo 2026 (Alta volatilidad de guerra/tasas)
  // 3. Mayo 2026 (Primavera / consolidaciones)
  // 4. Julio 2026 (Verano / volumen estacional)
  // 5. Agosto 2026 (Rally del Oro)
  // 6. Septiembre 2026 (Últimos 30 días recientes)

  const testWindows = [
    { name: '1. Ene 2026 (Arrancada de Año)', startStr: '2026-01-05', endStr: '2026-02-05' },
    { name: '2. Mar 2026 (Pico Volatilidad)',   startStr: '2026-03-01', endStr: '2026-03-31' },
    { name: '3. May 2026 (Mes de Transición)',  startStr: '2026-05-01', endStr: '2026-05-31' },
    { name: '4. Jul 2026 (Verano / Rangos)',    startStr: '2026-07-01', endStr: '2026-07-31' },
    { name: '5. Ago 2026 (Fuerte Tendencia)',  startStr: '2026-08-01', endStr: '2026-08-31' },
    { name: '6. Sep 2026 (Últimos 30 Días)',    startStr: '2026-09-01', endStr: '2026-09-29' }
  ];

  console.log('========================================================================================');
  console.log('🧪 STRESS TEST: BPR MULTITEMPORAL EN CUENTA DE $1,000 USD (30 DÍAS DE OPERATIVA)');
  console.log('   Parámetros: Saldo Inicial $1,000 USD | Apalancamiento 1:500 | Riesgo: 2.0% por Trade');
  console.log('========================================================================================\n');

  const results = [];

  testWindows.forEach(win => {
    const startMs = new Date(win.startStr).getTime();
    const endMs = new Date(win.endStr).getTime();

    const windowTrades = allTrades.filter(t => t.timeMs >= startMs && t.timeMs <= endMs);

    let balance = 1000.0;
    let peakBalance = 1000.0;
    let maxDDUSD = 0;
    let maxDDPct = 0;
    let wins = 0, losses = 0;
    let consecutiveLosses = 0, maxConsecutiveLosses = 0;
    let openPositions = [];

    windowTrades.forEach(t => {
      openPositions = openPositions.filter(p => p.exitTimeMs > t.timeMs);

      const marginPer001 = (t.entry * 1.0) / 500.0;
      const usedMargin = openPositions.reduce((acc, p) => acc + p.margin, 0);
      const freeMargin = Math.max(0, balance - usedMargin);

      const targetRiskUSD = balance * 0.02; // 2% de riesgo
      const slDistUSDPerLot = t.slPips * 10.0;
      let rawLots = targetRiskUSD / slDistUSDPerLot;
      let lots = Math.max(0.01, Math.floor(rawLots * 100) / 100);

      const requiredMargin = (lots / 0.01) * marginPer001;
      if (requiredMargin > freeMargin) {
        const maxLots = Math.floor(freeMargin / marginPer001) * 0.01;
        if (maxLots >= 0.01) lots = parseFloat(maxLots.toFixed(2));
        else return;
      }

      openPositions.push({ exitTimeMs: t.exitTimeMs, margin: (lots / 0.01) * marginPer001 });

      const pnlUSD = t.pips * 10.0 * lots;
      balance += pnlUSD;

      if (t.pips > 0) {
        wins++;
        consecutiveLosses = 0;
      } else {
        losses++;
        consecutiveLosses++;
        if (consecutiveLosses > maxConsecutiveLosses) maxConsecutiveLosses = consecutiveLosses;
      }

      if (balance > peakBalance) peakBalance = balance;
      const ddUSD = peakBalance - balance;
      const ddPct = (ddUSD / peakBalance) * 100.0;
      if (ddUSD > maxDDUSD) maxDDUSD = ddUSD;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
    });

    const netUSD = balance - 1000.0;
    const netPct = ((netUSD / 1000.0) * 100).toFixed(1);
    const wr = windowTrades.length > 0 ? ((wins / windowTrades.length) * 100).toFixed(1) : 0;

    results.push({
      'Ventana de 30 Días': win.name,
      'Trades': windowTrades.length,
      'WR %': `${wr}%`,
      'Racha Pérdida': `${maxConsecutiveLosses} SLs`,
      'Beneficio Neto': (netUSD >= 0 ? '+' : '') + '$' + netUSD.toFixed(2),
      'Rentabilidad %': `${netPct >= 0 ? '+' : ''}${netPct}%`,
      'Saldo Final': '$' + balance.toFixed(2),
      'Max DD %': `-${maxDDPct.toFixed(1)}%`
    });
  });

  console.table(results);
  console.log('========================================================================================\n');
}

runStressTest();
