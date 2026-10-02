/**
 * Auditoría Comparativa Multitemporal Exhaustiva de BPR:
 * M1 vs M2 vs M3 vs M5 vs M15
 * 
 * Evalúa las 5 temporalidades sobre datos reales de velas de MT5 del broker.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILES = {
  M1: path.join(__dirname, '..', '..', 'XAUUSD_M1_202606171851_202609291057.csv'),
  M2: path.join(__dirname, '..', '..', 'XAUUSD_M2_202603051240_202609291056.csv'),
  M3: path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv'),
  M5: path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv'),
  M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv')
};

// Parámetros adaptados por temporalidad (escalados orgánicamente al ATR/rango de la vela)
const TIMEFRAME_CONFIG = {
  M1:  { minFvgGap: 0.15, minOverlap: 0.10, slPips: 8.0,  tp1Pips: 20.0, tp2Pips: 40.0, autoBe: 15.0, minRange: 0.18 },
  M2:  { minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0, autoBe: 18.0, minRange: 0.22 },
  M3:  { minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0, autoBe: 20.0, minRange: 0.25 },
  M5:  { minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0, autoBe: 25.0, minRange: 0.35 },
  M15: { minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60 }
};

async function loadCandles(filePath, maxBars = 100000) {
  if (!fs.existsSync(filePath)) return null;
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
    candles.push({
      dateStr: parts[0],
      timeStr: parts[1],
      fullDate: `${parts[0]} ${parts[1]}`,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  // Si hay más barras que maxBars, tomamos las más recientes
  const sliced = candles.length > maxBars ? candles.slice(candles.length - maxBars) : candles;

  // Precalcular EMA 100
  let ema100 = sliced[0].close;
  const k100 = 2 / (100 + 1);
  sliced.forEach(c => {
    ema100 = c.close * k100 + ema100 * (1 - k100);
    c.ema100 = ema100;
  });

  return sliced;
}

function simulateTimeframe(tf, candles, cfg) {
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
        bprZones.push({ type: 'BULLISH', createdIdx: i, top: cHigh, bottom: cLow });
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
        bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow });
      }
    }
  }

  let trades = 0, wins = 0, losses = 0, netPips = 0, grossWon = 0, grossLost = 0;
  let maxDD = 0, peak = 0, lastTradeIdx = -100;
  let totalSpreadCost = 0;

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 45); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      // Filtro anti-rollover (22:55 a 00:30)
      if (bar.hour === 23 || (bar.hour === 0 && bar.minute < 30)) continue;

      const candleRange = bar.high - bar.low;
      if (candleRange < cfg.minRange) continue;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < 0.25) continue;
          if (bar.close < bar.ema100) continue; // Filtro EMA 100

          trades++;
          lastTradeIdx = k;
          totalSpreadCost += bar.spreadPips;
          const entry = bpr.top;
          const sl = bpr.bottom - (cfg.slPips / 10.0);
          let currentSL = sl;
          let tp1Hit = false;
          let pips = 0;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.low <= currentSL) {
              const diff = (currentSL - entry) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (cfg.tp1Pips * 0.5 + diff * 0.5) : diff;
              break;
            }
            if (!tp1Hit && fBar.high >= entry + (cfg.tp1Pips / 10.0)) {
              tp1Hit = true;
              currentSL = entry + 0.2;
            }
            if (!tp1Hit && fBar.high >= entry + (cfg.autoBe / 10.0)) {
              if (currentSL < entry + 0.2) currentSL = entry + 0.2;
            }
            if (fBar.high >= entry + (cfg.tp2Pips / 10.0)) {
              pips = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
              break;
            }
          }
          if (pips === 0 && tp1Hit) pips = cfg.tp1Pips * 0.5;
          if (pips > 0) { wins++; grossWon += pips; } else { losses++; grossLost += Math.abs(pips); }
          netPips += pips;
          if (netPips > peak) peak = netPips;
          if (peak - netPips > maxDD) maxDD = peak - netPips;
          break;
        }
      } else { // BEARISH
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.5) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < 0.25) continue;
          if (bar.close > bar.ema100) continue; // Filtro EMA 100

          trades++;
          lastTradeIdx = k;
          totalSpreadCost += bar.spreadPips;
          const entry = bpr.bottom;
          const sl = bpr.top + (cfg.slPips / 10.0);
          let currentSL = sl;
          let tp1Hit = false;
          let pips = 0;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.high >= currentSL) {
              const diff = (entry - currentSL) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (cfg.tp1Pips * 0.5 + diff * 0.5) : diff;
              break;
            }
            if (!tp1Hit && fBar.low <= entry - (cfg.tp1Pips / 10.0)) {
              tp1Hit = true;
              currentSL = entry - 0.2;
            }
            if (!tp1Hit && fBar.low <= entry - (cfg.autoBe / 10.0)) {
              if (currentSL > entry - 0.2) currentSL = entry - 0.2;
            }
            if (fBar.low <= entry - (cfg.tp2Pips / 10.0)) {
              pips = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
              break;
            }
          }
          if (pips === 0 && tp1Hit) pips = cfg.tp1Pips * 0.5;
          if (pips > 0) { wins++; grossWon += pips; } else { losses++; grossLost += Math.abs(pips); }
          netPips += pips;
          if (netPips > peak) peak = netPips;
          if (peak - netPips > maxDD) maxDD = peak - netPips;
          break;
        }
      }
    }
  });

  const wr = trades > 0 ? ((wins / trades) * 100).toFixed(1) : '0';
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';
  const avgPips = trades > 0 ? (netPips / trades).toFixed(1) : '0';
  const spreadFriction = grossWon > 0 ? ((totalSpreadCost / grossWon) * 100).toFixed(1) : '0';

  // Estimación de duración de datos en meses
  const totalMinutes = candles.length * (parseInt(tf.replace('M', '')) || 1);
  const totalDays = (totalMinutes / (60 * 24)).toFixed(0);
  const tradesPerDay = totalDays > 0 ? (trades / totalDays).toFixed(1) : '0';

  return {
    timeframe: tf,
    bars: candles.length,
    periodDays: totalDays,
    trades,
    tradesPerDay,
    wins,
    losses,
    winRate: `${wr}%`,
    pips: parseFloat(netPips.toFixed(1)),
    profitFactor: parseFloat(pf),
    maxDrawdown: parseFloat(maxDD.toFixed(1)),
    avgPipsTrade: parseFloat(avgPips),
    spreadFrictionPercent: `${spreadFriction}%`,
    targetRatio: `1:${(cfg.tp2Pips / cfg.slPips).toFixed(1)}`
  };
}

async function runMultiTimeframeAudit() {
  console.log('========================================================================================');
  console.log('🔬 AUDITORÍA COMPARATIVA MULTITEMPORAL DE BPR: M1 vs M2 vs M3 vs M5 vs M15');
  console.log('   Evaluando velas reales MT5 broker con fricción de spread y filtro EMA 100...');
  console.log('========================================================================================\n');

  const results = [];

  for (const [tf, filePath] of Object.entries(FILES)) {
    process.stdout.write(`⏳ Procesando ${tf}... `);
    const candles = await loadCandles(filePath, 80000);
    if (!candles) {
      console.log(`❌ Archivo no encontrado para ${tf}`);
      continue;
    }
    const res = simulateTimeframe(tf, candles, TIMEFRAME_CONFIG[tf]);
    results.push(res);
    console.log(`✅ ${res.trades} trades calculados (${res.winRate} WR, PF: ${res.profitFactor})`);
  }

  console.log('\n========================================================================================');
  console.log('📊 TABLA COMPARATIVA CONSOLIDADA MULTITEMPORAL:');
  console.log('========================================================================================');
  console.table(results.map(r => ({
    TF: r.timeframe,
    'Barras': r.bars,
    'Periodo': `${r.periodDays} d`,
    'Trades': r.trades,
    'Trades/Día': r.tradesPerDay,
    'Win Rate': r.winRate,
    'Pips Netos': (r.pips >= 0 ? '+' : '') + r.pips.toFixed(1) + 'p',
    'Profit Factor': r.profitFactor,
    'Max Drawdown': `-${r.maxDrawdown}p`,
    'Fricción Spread': r.spreadFrictionPercent,
    'Riesgo/Beneficio': r.targetRatio
  })));

  console.log('========================================================================================\n');
}

runMultiTimeframeAudit();
