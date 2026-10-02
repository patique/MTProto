/**
 * Estudio Cuantitativo de Expansión de SL/TP en XAUUSD (2020 - 2026)
 * Objetivo: Evaluar la absorción de Spreads Altos (0.55$ - 0.65$) y Ruido Inter-Broker (FTMO vs The5ers)
 * 
 * Compara:
 * 1. Configuración Actual (Ajustada: SL 10p - 15p)
 * 2. Expansión x1.5 (SL 18p - 25p)
 * 3. Expansión x2.0 (SL 25p - 35p)
 * Fricción Estresada: Spread 0.55$ + Slippage 0.10$ = 0.65$ (6.5 pips)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const GOLD_FILES = {
  M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202001020600_202610011115.csv'),
  M5:  path.join(__dirname, '..', '..', 'XAUUSD_M5_202001020600_202610011120.csv'),
  M3:  path.join(__dirname, '..', '..', 'XAUUSD_M3_202001020600_202610011121.csv'),
  M2:  path.join(__dirname, '..', '..', 'XAUUSD_M2_202001020600_202610011120.csv')
};

const EXPANSION_MODELS = {
  M15: {
    minFvgGap: 0.50, minOverlap: 0.30, minRange: 0.60, minWickRatio: 0.25,
    variants: {
      '1_ACTUAL':  { name: 'Actual (SL 25p / TP 60p / BE 40p)',    sl: 25.0, tp: 60.0,  be: 40.0 },
      '2_EXP_1_5': { name: 'Exp x1.5 (SL 40p / TP 90p / BE 55p)',  sl: 40.0, tp: 90.0,  be: 55.0 },
      '3_EXP_2_0': { name: 'Exp x2.0 (SL 55p / TP 130p / BE 75p)', sl: 55.0, tp: 130.0, be: 75.0 }
    }
  },
  M5: {
    minFvgGap: 0.30, minOverlap: 0.18, minRange: 0.35, minWickRatio: 0.25,
    variants: {
      '1_ACTUAL':  { name: 'Actual (SL 15p / TP 40p / BE 25p)',   sl: 15.0, tp: 40.0, be: 25.0 },
      '2_EXP_1_5': { name: 'Exp x1.5 (SL 25p / TP 60p / BE 35p)', sl: 25.0, tp: 60.0, be: 35.0 },
      '3_EXP_2_0': { name: 'Exp x2.0 (SL 35p / TP 80p / BE 50p)', sl: 35.0, tp: 80.0, be: 50.0 }
    }
  },
  M3: {
    minFvgGap: 0.20, minOverlap: 0.12, minRange: 0.25, minWickRatio: 0.25,
    variants: {
      '1_ACTUAL':  { name: 'Actual (SL 12p / TP 30p / BE 20p)',   sl: 12.0, tp: 30.0, be: 20.0 },
      '2_EXP_1_5': { name: 'Exp x1.5 (SL 20p / TP 45p / BE 30p)', sl: 20.0, tp: 45.0, be: 30.0 },
      '3_EXP_2_0': { name: 'Exp x2.0 (SL 30p / TP 70p / BE 45p)', sl: 30.0, tp: 70.0, be: 45.0 }
    }
  },
  M2: {
    minFvgGap: 0.18, minOverlap: 0.10, minRange: 0.22, minWickRatio: 0.25,
    variants: {
      '1_ACTUAL':  { name: 'Actual (SL 10p / TP 25p / BE 20p)',   sl: 10.0, tp: 25.0, be: 20.0 },
      '2_EXP_1_5': { name: 'Exp x1.5 (SL 18p / TP 40p / BE 25p)', sl: 18.0, tp: 40.0, be: 25.0 },
      '3_EXP_2_0': { name: 'Exp x2.0 (SL 25p / TP 60p / BE 35p)', sl: 25.0, tp: 60.0, be: 35.0 }
    }
  }
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
      timeMs,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 5.5
    });
  }

  // EMA 100
  if (candles.length > 0) {
    let ema = candles[0].close;
    const k = 2 / (100 + 1);
    candles.forEach(c => {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    });
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
        bprZones.push({ type: 'BULLISH', createdIdx: i, top: cHigh, bottom: cLow });
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
        bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow });
      }
    }
  }

  return bprZones;
}

function evaluateTradeOutcome(type, startIdx, entryPrice, stopLossPrice, cfg, candles, frictionPips) {
  let currentSL = stopLossPrice;
  let autoBeHit = false;
  let finalPips = 0;

  const tpPrice = type === 'BUY' ? entryPrice + (cfg.tp * 0.10) : entryPrice - (cfg.tp * 0.10);
  const autoBePrice = type === 'BUY' ? entryPrice + (cfg.be * 0.10) : entryPrice - (cfg.be * 0.10);

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
        currentSL = entryPrice + 0.40; // Break-Even protegido
      }
      if (fBar.high >= tpPrice) {
        finalPips = cfg.tp - frictionPips;
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
        currentSL = entryPrice - 0.40;
      }
      if (fBar.low <= tpPrice) {
        finalPips = cfg.tp - frictionPips;
        break;
      }
    }
  }

  return finalPips;
}

async function runExpansionStudy() {
  console.log('========================================================================================');
  console.log('🔬 ESTUDIO CUANTITATIVO DE EXPANSIÓN DE SL/TP EN ORO (XAUUSD 2020 - 2026)');
  console.log('   Fricción Alta Estresada: Spread 0.55$ + Slippage 0.10$ = 0.65$ (6.5 pips por trade)');
  console.log('========================================================================================\n');

  const STRESSED_FRICTION = 6.5; // 0.65$ por trade

  for (const [tf, cfg] of Object.entries(EXPANSION_MODELS)) {
    const filePath = GOLD_FILES[tf];
    if (!fs.existsSync(filePath)) continue;

    process.stdout.write(`⏳ Cargando XAUUSD ${tf}... `);
    const candles = await loadCandles(filePath);
    console.log(`${candles.length.toLocaleString()} velas cargadas. Trazando BPRs...`);
    const bprZones = findBprZones(candles, cfg.minFvgGap, cfg.minOverlap);

    console.log(`----------------------------------------------------------------------------------------`);
    console.log(`📊 TEMPORALIDAD: ${tf} (BPRs: ${bprZones.length})`);
    console.log(`----------------------------------------------------------------------------------------`);

    for (const [vKey, vDef] of Object.entries(cfg.variants)) {
      // 1. Prime Session (07:00 - 18:00 UTC)
      // 2. 24 Horas
      ['PRIME', '24H'].forEach(session => {
        let lastTradeIdx = -100;
        const tradePips = [];

        bprZones.forEach(bpr => {
          for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 20); k++) {
            if (k - lastTradeIdx < 4) continue;
            const bar = candles[k];

            if (bar.hour === 23 || (bar.hour === 0 && bar.minute <= 15)) continue;
            if (session === 'PRIME' && (bar.hour < 7 || bar.hour >= 18)) continue;

            const candleRange = bar.high - bar.low;
            if (candleRange < cfg.minRange) continue;

            if (bpr.type === 'BULLISH') {
              if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
                const lowerWick = Math.min(bar.open, bar.close) - bar.low;
                if (lowerWick / candleRange < cfg.minWickRatio) continue;
                if (bar.close < bar.ema100) continue;

                lastTradeIdx = k;
                const result = evaluateTradeOutcome('BUY', k, bpr.top, bpr.bottom - (vDef.sl * 0.10), vDef, candles, STRESSED_FRICTION);
                tradePips.push(result);
                break;
              }
            } else {
              if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.5) {
                const upperWick = bar.high - Math.max(bar.open, bar.close);
                if (upperWick / candleRange < cfg.minWickRatio) continue;
                if (bar.close > bar.ema100) continue;

                lastTradeIdx = k;
                const result = evaluateTradeOutcome('SELL', k, bpr.bottom, bpr.top + (vDef.sl * 0.10), vDef, candles, STRESSED_FRICTION);
                tradePips.push(result);
                break;
              }
            }
          }
        });

        const total = tradePips.length;
        const wins = tradePips.filter(p => p > 0).length;
        const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;
        const netPips = tradePips.reduce((a, b) => a + b, 0);
        const grossWon = tradePips.filter(p => p > 0).reduce((a, b) => a + b, 0);
        const grossLost = Math.abs(tradePips.filter(p => p < 0).reduce((a, b) => a + b, 0));
        const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';

        let peak = 0, running = 0, maxDD = 0;
        tradePips.forEach(p => {
          running += p;
          if (running > peak) peak = running;
          if (peak - running > maxDD) maxDD = peak - running;
        });

        console.log(`🔹 [${vDef.name}] - ${session === 'PRIME' ? 'Sesión Prime (07-18)' : '24 Horas'}`);
        console.log(`   -> Trades: ${total} | Win: ${winRate}% | Net: ${netPips > 0 ? '+' : ''}${netPips.toFixed(1)}p | PF: ${pf} | MaxDD: ${maxDD.toFixed(1)}p`);
      });
    }
  }

  console.log('\n========================================================================================');
  console.log('✅ Estudio de Expansión de Parámetros Finalizado.');
  console.log('========================================================================================');
}

runExpansionStudy().catch(console.error);
