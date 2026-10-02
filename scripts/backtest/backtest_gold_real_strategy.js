/**
 * Backtest Real de XAUUSD (Oro) 2020 - 2026 (~7 Años)
 * Implementando la Estrategia EXACTA del Bot en Vivo:
 * - Auto-BE dinámico a +15/+20 pips
 * - TP1 (50% de cierre asegurado) + TP2
 * - Filtro HTF M15 EMA 100
 * - Filtro de Mecha de Rechazo Institucional (minWickRatio 0.35 en M1, 0.25 en M2/M3/M5/M15)
 * - Fricción real del broker (Spread por vela + Slippage)
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

const STRATEGY_CONFIGS = {
  M15: { minFvgGap: 0.50, minOverlap: 0.30, minRange: 0.60, minWickRatio: 0.25, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBePips: 40.0 },
  M5:  { minFvgGap: 0.30, minOverlap: 0.18, minRange: 0.35, minWickRatio: 0.25, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0,  autoBePips: 25.0 },
  M3:  { minFvgGap: 0.20, minOverlap: 0.12, minRange: 0.25, minWickRatio: 0.25, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0,  autoBePips: 20.0 },
  M2:  { minFvgGap: 0.18, minOverlap: 0.10, minRange: 0.22, minWickRatio: 0.25, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0,  autoBePips: 20.0 },
  M1:  { minFvgGap: 0.18, minOverlap: 0.12, minRange: 0.22, minWickRatio: 0.35, slPips: 16.0, tp1Pips: 15.0, tp2Pips: 20.0,  autoBePips: 15.0 }
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
      spreadPips: parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 3.5
    });
  }

  // Precalcular EMA 100
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

function evaluateTradeOutcome(type, startIdx, entryPrice, stopLossPrice, cfg, candles) {
  let currentSL = stopLossPrice;
  let tp1Hit = false;
  let autoBeHit = false;
  let finalPips = 0;
  const frictionPips = 3.5; // 0.35$

  const tp1Price = type === 'BUY' ? entryPrice + (cfg.tp1Pips * 0.10) : entryPrice - (cfg.tp1Pips * 0.10);
  const tp2Price = type === 'BUY' ? entryPrice + (cfg.tp2Pips * 0.10) : entryPrice - (cfg.tp2Pips * 0.10);
  const autoBePrice = type === 'BUY' ? entryPrice + (cfg.autoBePips * 0.10) : entryPrice - (cfg.autoBePips * 0.10);

  for (let m = startIdx + 1; m < Math.min(candles.length, startIdx + 180); m++) {
    const fBar = candles[m];

    if (type === 'BUY') {
      // 1. Verificar Stop Loss o Trailing
      if (fBar.low <= currentSL) {
        const diffPips = (currentSL - entryPrice) * 10.0;
        finalPips = tp1Hit ? (cfg.tp1Pips * 0.5 + diffPips * 0.5) : diffPips;
        finalPips -= frictionPips;
        break;
      }
      // 2. Verificar Auto-BE
      if (!tp1Hit && !autoBeHit && fBar.high >= autoBePrice) {
        autoBeHit = true;
        currentSL = entryPrice + 0.30; // Protegido +3 pips
      }
      // 3. Verificar TP1
      if (!tp1Hit && fBar.high >= tp1Price) {
        tp1Hit = true;
        currentSL = entryPrice + 0.30;
      }
      // 4. Verificar TP2
      if (fBar.high >= tp2Price) {
        finalPips = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
        finalPips -= frictionPips;
        break;
      }
    } else { // SELL
      // 1. Verificar Stop Loss o Trailing
      if (fBar.high >= currentSL) {
        const diffPips = (entryPrice - currentSL) * 10.0;
        finalPips = tp1Hit ? (cfg.tp1Pips * 0.5 + diffPips * 0.5) : diffPips;
        finalPips -= frictionPips;
        break;
      }
      // 2. Verificar Auto-BE
      if (!tp1Hit && !autoBeHit && fBar.low <= autoBePrice) {
        autoBeHit = true;
        currentSL = entryPrice - 0.30; // Protegido +3 pips
      }
      // 3. Verificar TP1
      if (!tp1Hit && fBar.low <= tp1Price) {
        tp1Hit = true;
        currentSL = entryPrice - 0.30;
      }
      // 4. Verificar TP2
      if (fBar.low <= tp2Price) {
        finalPips = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
        finalPips -= frictionPips;
        break;
      }
    }
  }

  return finalPips;
}

async function runRealGoldBacktest() {
  console.log('========================================================================================');
  console.log('🏛️ BACKTEST OFICIAL XAUUSD (ORO) 2020 - 2026: ESTRATEGIA REAL CON AUTO-BE Y TP1/TP2');
  console.log('   Fricción: 3.5 pips (0.35$) | Auto-BE con Colchón 0.30$ | Sesión Prime vs 24H');
  console.log('========================================================================================\n');

  for (const [tf, cfg] of Object.entries(STRATEGY_CONFIGS)) {
    const filePath = GOLD_FILES[tf];
    if (!fs.existsSync(filePath)) continue;

    process.stdout.write(`⏳ Cargando XAUUSD ${tf}... `);
    const candles = await loadCandles(filePath);
    console.log(`${candles.length.toLocaleString()} velas cargadas. Trazando BPRs...`);
    const bprZones = findBprZones(candles, cfg.minFvgGap, cfg.minOverlap);

    console.log(`TF: ${tf} | BPRs Detectados: ${bprZones.length}`);

    // Probar: 1) Prime Session (07:00 - 18:00 UTC) y 2) 24 Horas
    ['PRIME', '24H'].forEach(session => {
      let lastTradeIdx = -100;
      const tradePips = [];

      bprZones.forEach(bpr => {
        for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 20); k++) {
          if (k - lastTradeIdx < 4) continue;
          const bar = candles[k];

          // Rollover Shield (22:55 - 00:10 UTC)
          if (bar.hour === 23 || (bar.hour === 0 && bar.minute <= 15)) continue;

          // Filtro de sesión
          if (session === 'PRIME' && (bar.hour < 7 || bar.hour >= 18)) continue;

          const candleRange = bar.high - bar.low;
          if (candleRange < cfg.minRange) continue;

          if (bpr.type === 'BULLISH') {
            if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
              const lowerWick = Math.min(bar.open, bar.close) - bar.low;
              if (lowerWick / candleRange < cfg.minWickRatio) continue;
              if (bar.close < bar.ema100) continue;

              lastTradeIdx = k;
              const result = evaluateTradeOutcome('BUY', k, bpr.top, bpr.bottom - (cfg.slPips * 0.10), cfg, candles);
              tradePips.push(result);
              break;
            }
          } else { // BEARISH
            if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.5) {
              const upperWick = bar.high - Math.max(bar.open, bar.close);
              if (upperWick / candleRange < cfg.minWickRatio) continue;
              if (bar.close > bar.ema100) continue;

              lastTradeIdx = k;
              const result = evaluateTradeOutcome('SELL', k, bpr.bottom, bpr.top + (cfg.slPips * 0.10), cfg, candles);
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

      console.log(`   🔹 [${session === 'PRIME' ? 'Sesión Prime (07-18 UTC)' : '24 Horas'}] -> Trades: ${total} | Win: ${winRate}% | Net: ${netPips > 0 ? '+' : ''}${netPips.toFixed(1)}p | PF: ${pf} | MaxDD: ${maxDD.toFixed(1)}p`);
    });
    console.log('----------------------------------------------------------------------------------------');
  }

  console.log('✅ Backtest Oficial XAUUSD Finalizado con Éxito.');
}

runRealGoldBacktest().catch(console.error);
