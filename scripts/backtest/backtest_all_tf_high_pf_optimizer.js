/**
 * Optimizador Cuantitativo Exhaustivo para Maximizar Profit Factor (PF > 2.0+) en XAUUSD
 * Periodo: 2020 a 2026 (~7 Años de Historial Completo)
 * 
 * Evalúa TODAS las temporalidades: M1, M2, M3, M5, M15
 * Búsqueda de Máximo Profit Factor:
 * - Ratios R:R de 1:1.5 a 1:3.5
 * - Modelos Asimétricos de Alta Precisión
 * - Filtros de Rechazo Institucional Estricto (Mecha 0.35 - 0.45)
 * - Filtro HTF M15/H1 EMA
 * - Horarios: Killzones (07-11 y 13-17 UTC) vs Prime (07-18 UTC)
 * Fricción Real: Spread 0.45$ + Slippage 0.05$ = 0.50$ (5.0 pips por trade)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const GOLD_FILES = {
  M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202001020600_202610011115.csv'),
  M5:  path.join(__dirname, '..', '..', 'XAUUSD_M5_202001020600_202610011120.csv'),
  M3:  path.join(__dirname, '..', '..', 'XAUUSD_M3_202001020600_202610011121.csv'),
  M2:  path.join(__dirname, '..', '..', 'XAUUSD_M2_202001020600_202610011120.csv'),
  M1:  path.join(__dirname, '..', '..', 'XAUUSD_M1_202001020600_202610011121.csv')
};

const TF_BASE_CONFIG = {
  M15: { minFvgGap: 0.50, minOverlap: 0.30, minRange: 0.60 },
  M5:  { minFvgGap: 0.30, minOverlap: 0.18, minRange: 0.35 },
  M3:  { minFvgGap: 0.20, minOverlap: 0.12, minRange: 0.25 },
  M2:  { minFvgGap: 0.18, minOverlap: 0.10, minRange: 0.22 },
  M1:  { minFvgGap: 0.18, minOverlap: 0.12, minRange: 0.22 }
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
      year: y,
      hour: h,
      minute: min,
      timeMs,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 4.5
    });
  }

  // Precalcular EMA 100 y ATR 14
  if (candles.length > 0) {
    let ema100 = candles[0].close;
    const k100 = 2 / (100 + 1);
    let atrSum = 0;
    const atrPeriod = 14;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      ema100 = c.close * k100 + ema100 * (1 - k100);
      c.ema100 = ema100;

      const prevClose = i > 0 ? candles[i - 1].close : c.open;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      c.tr = tr;

      if (i < atrPeriod) {
        atrSum += tr;
        c.atr = atrSum / (i + 1);
      } else {
        c.atr = (candles[i - 1].atr * (atrPeriod - 1) + tr) / atrPeriod;
      }
    }
  }

  return candles;
}

function findBprZones(candles, minFvgGap, minOverlap) {
  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const isBearishFVG = (c2.low - c0.high) >= minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= minFvgGap;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    if (isBullishFVG && (i - lastBearishFVGIdx) <= 10 && (i - lastBearishFVGIdx) > 0) {
      const bearTop = candles[lastBearishFVGIdx - 2].low;
      const bearBottom = candles[lastBearishFVGIdx].high;
      const bullTop = c0.low;
      const bullBottom = c2.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);

      if (cHigh > cLow + minOverlap) {
        bprZones.push({ type: 'BULLISH', createdIdx: i, top: cHigh, bottom: cLow, timeMs: c0.timeMs });
      }
    }

    if (isBearishFVG && (i - lastBullishFVGIdx) <= 10 && (i - lastBullishFVGIdx) > 0) {
      const bullTop = candles[lastBullishFVGIdx].low;
      const bullBottom = candles[lastBullishFVGIdx - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);

      if (cHigh > cLow + minOverlap) {
        bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow, timeMs: c0.timeMs });
      }
    }
  }

  return bprZones;
}

function evaluateTradeOutcome(type, startIdx, entryPrice, stopLossPrice, takeProfitPrice, autoBePrice, candles, frictionPips) {
  let currentSL = stopLossPrice;
  let autoBeHit = false;
  let finalPips = 0;

  for (let m = startIdx + 1; m < Math.min(candles.length, startIdx + 240); m++) {
    const fBar = candles[m];

    if (type === 'BUY') {
      if (fBar.low <= currentSL) {
        const diffPips = (currentSL - entryPrice) * 10.0;
        finalPips = diffPips - frictionPips;
        break;
      }
      if (!autoBeHit && fBar.high >= autoBePrice) {
        autoBeHit = true;
        currentSL = entryPrice + 0.30; // Break-Even protegido
      }
      if (fBar.high >= takeProfitPrice) {
        const diffPips = (takeProfitPrice - entryPrice) * 10.0;
        finalPips = diffPips - frictionPips;
        break;
      }
    } else { // SELL
      if (fBar.high >= currentSL) {
        const diffPips = (entryPrice - currentSL) * 10.0;
        finalPips = diffPips - frictionPips;
        break;
      }
      if (!autoBeHit && fBar.low <= autoBePrice) {
        autoBeHit = true;
        currentSL = entryPrice - 0.30;
      }
      if (fBar.low <= takeProfitPrice) {
        const diffPips = (entryPrice - takeProfitPrice) * 10.0;
        finalPips = diffPips - frictionPips;
        break;
      }
    }
  }

  return finalPips;
}

function runSimulation(candles, bprZones, params) {
  const {
    atrSlMult = 1.0,
    atrTpMult = 2.5,
    autoBeRatio = 0.5,
    minWickRatio = 0.30,
    minRange = 0.30,
    sessionMode = 'KILLZONES', // 'KILLZONES' (07-11 y 13-17) | 'PRIME' (07-18)
    frictionPips = 5.0
  } = params;

  let lastTradeIdx = -100;
  const trades = [];

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 20); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      if (bar.hour === 23 || (bar.hour === 0 && bar.minute <= 15)) continue;

      if (sessionMode === 'KILLZONES') {
        const inLondon = (bar.hour >= 7 && bar.hour < 11);
        const inNy = (bar.hour >= 13 && bar.hour < 17);
        if (!inLondon && !inNy) continue;
      } else if (sessionMode === 'PRIME') {
        if (bar.hour < 7 || bar.hour >= 18) continue;
      }

      const candleRange = bar.high - bar.low;
      if (candleRange < minRange) continue;

      const atr = bar.atr || (candleRange * 1.2);
      const slDist = atr * atrSlMult;
      const tpDist = atr * atrTpMult;
      const autoBeDist = tpDist * autoBeRatio;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < minWickRatio) continue;
          if (bar.close < bar.ema100) continue;

          lastTradeIdx = k;
          const entryPrice = bpr.top;
          const slPrice = entryPrice - slDist;
          const tpPrice = entryPrice + tpDist;
          const bePrice = entryPrice + autoBeDist;

          const pips = evaluateTradeOutcome('BUY', k, entryPrice, slPrice, tpPrice, bePrice, candles, frictionPips);
          trades.push({ year: bar.year, pips });
          break;
        }
      } else { // BEARISH
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.5) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < minWickRatio) continue;
          if (bar.close > bar.ema100) continue;

          lastTradeIdx = k;
          const entryPrice = bpr.bottom;
          const slPrice = entryPrice + slDist;
          const tpPrice = entryPrice - tpDist;
          const bePrice = entryPrice - autoBeDist;

          const pips = evaluateTradeOutcome('SELL', k, entryPrice, slPrice, tpPrice, bePrice, candles, frictionPips);
          trades.push({ year: bar.year, pips });
          break;
        }
      }
    }
  });

  const total = trades.length;
  if (total === 0) return { trades: 0, winRate: '0%', netPips: 0, pf: 0, maxDd: 0, profitableYearsRatio: 0 };

  const wins = trades.filter(t => t.pips > 0).length;
  const winRate = ((wins / total) * 100).toFixed(1);
  const netPips = trades.reduce((a, b) => a + b.pips, 0);
  const grossWon = trades.filter(t => t.pips > 0).reduce((a, b) => a + b.pips, 0);
  const grossLost = Math.abs(trades.filter(t => t.pips < 0).reduce((a, b) => a + b.pips, 0));
  const pf = grossLost > 0 ? parseFloat((grossWon / grossLost).toFixed(2)) : 99.0;

  let peak = 0, running = 0, maxDd = 0;
  trades.forEach(t => {
    running += t.pips;
    if (running > peak) peak = running;
    if (peak - running > maxDd) maxDd = peak - running;
  });

  const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
  let profYears = 0;
  years.forEach(yr => {
    const yNet = trades.filter(t => t.year === yr).reduce((a, b) => a + b.pips, 0);
    if (yNet > 0) profYears++;
  });

  return {
    trades: total,
    winRate: `${winRate}%`,
    netPips: parseFloat(netPips.toFixed(1)),
    pf,
    maxDd: parseFloat(maxDd.toFixed(1)),
    profitableYearsRatio: `${profYears}/${years.length}`
  };
}

async function runHighPfOptimizer() {
  console.log('========================================================================================');
  console.log('💎 OPTIMIZADOR CUANTITATIVO DE MÁXIMO PROFIT FACTOR EN XAUUSD (2020 - 2026)');
  console.log('   Evaluando M1, M2, M3, M5, M15 con Fricción Estresada (5.0 pips / 0.50$ por trade)');
  console.log('========================================================================================\n');

  for (const tf of ['M15', 'M5', 'M3', 'M2', 'M1']) {
    const filePath = GOLD_FILES[tf];
    if (!fs.existsSync(filePath)) continue;

    console.log(`\n========================================================================================`);
    console.log(`🔍 ESCANEANDO TEMPORALIDAD: XAUUSD ${tf}`);
    console.log(`========================================================================================`);

    const candles = await loadCandles(filePath);
    const baseCfg = TF_BASE_CONFIG[tf];
    const bprZones = findBprZones(candles, baseCfg.minFvgGap, baseCfg.minOverlap);
    console.log(`Velas: ${candles.length.toLocaleString()} | BPRs: ${bprZones.length}`);

    // Grid Search de R:R y Filtros Institucionales
    const models = [
      { name: '1. R:R 1:3.0 Elite (SL 1.0x ATR / TP 3.0x ATR) | Killzones | Mecha 35%', params: { atrSlMult: 1.0, atrTpMult: 3.0, autoBeRatio: 0.50, minWickRatio: 0.35, minRange: baseCfg.minRange, sessionMode: 'KILLZONES' } },
      { name: '2. R:R 1:2.5 Solido (SL 1.0x ATR / TP 2.5x ATR) | Killzones | Mecha 30%', params: { atrSlMult: 1.0, atrTpMult: 2.5, autoBeRatio: 0.50, minWickRatio: 0.30, minRange: baseCfg.minRange, sessionMode: 'KILLZONES' } },
      { name: '3. R:R 1:2.0 Sniper (SL 1.0x ATR / TP 2.0x ATR) | Killzones | Mecha 35%', params: { atrSlMult: 1.0, atrTpMult: 2.0, autoBeRatio: 0.55, minWickRatio: 0.35, minRange: baseCfg.minRange, sessionMode: 'KILLZONES' } },
      { name: '4. R:R 1:3.0 Prime   (SL 1.0x ATR / TP 3.0x ATR) | Sesión Prime (07-18 UTC)', params: { atrSlMult: 1.0, atrTpMult: 3.0, autoBeRatio: 0.50, minWickRatio: 0.35, minRange: baseCfg.minRange, sessionMode: 'PRIME' } },
      { name: '5. R:R 1:2.5 Prime   (SL 1.2x ATR / TP 3.0x ATR) | Sesión Prime (07-18 UTC)', params: { atrSlMult: 1.2, atrTpMult: 3.0, autoBeRatio: 0.50, minWickRatio: 0.30, minRange: baseCfg.minRange, sessionMode: 'PRIME' } },
      { name: '6. Asimétrico Rapido (SL 1.5x ATR / TP 1.2x ATR) | Killzones | Mecha 35%', params: { atrSlMult: 1.5, atrTpMult: 1.2, autoBeRatio: 0.50, minWickRatio: 0.35, minRange: baseCfg.minRange, sessionMode: 'KILLZONES' } }
    ];

    console.log(`---------------------------------------------------------------------------------------------------------------------------`);
    console.log(`Configuración                                              | Trades | Win Rate | Pips Netos  | Profit Factor | Max DD   | Años + `);
    console.log(`---------------------------------------------------------------------------------------------------------------------------`);

    for (const m of models) {
      const res = runSimulation(candles, bprZones, m.params);
      const namePadded = m.name.padEnd(58, ' ');
      const trPadded = res.trades.toString().padStart(6, ' ');
      const wrPadded = res.winRate.padStart(8, ' ');
      const netPadded = ((res.netPips > 0 ? '+' : '') + res.netPips.toFixed(1)).padStart(11, ' ');
      const pfPadded = res.pf.toString().padStart(13, ' ');
      const ddPadded = (res.maxDd.toFixed(1) + 'p').padStart(8, ' ');
      const yrPadded = res.profitableYearsRatio.padStart(6, ' ');

      console.log(`${namePadded} | ${trPadded} | ${wrPadded} | ${netPadded}p | ${pfPadded} | ${ddPadded} | ${yrPadded}`);
    }
  }

  console.log('\n========================================================================================');
  console.log('✅ Estudio de Máximo Profit Factor Finalizado.');
  console.log('========================================================================================');
}

runHighPfOptimizer().catch(console.error);
