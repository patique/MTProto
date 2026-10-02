/**
 * Batería de Backtests Cuantitativa Exhaustiva para NASDAQ 100 (NAS100 / US100)
 * Periodo: 2020 a 2026 (~7 Años de Historial Real del Broker)
 * 
 * Evalúa:
 * 1. Temporalidades: M1, M2, M3, M5, M15
 * 2. Modelos de Riesgo:
 *    - Modelo A: Ratio Positivo Institucional (1:2 a 1:3)
 *    - Modelo B: Asimétrico / Negativo Alta Probabilidad (Auto-BE ultra rápido)
 *    - Modelo C: Scalping Corto Ajustado
 * 3. Filtro de Sesión: 24h vs Londres+NY (07-20 UTC) vs Wall Street Core (13:30-20:00 UTC)
 * 4. Fricción: Spread real (1.97 - 2.50 pts) + Deslizamiento (0.5 pts)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const NAS_FILES = {
  M1:  path.join(__dirname, '..', '..', 'NAS100_M1_202001010300_202610011029.csv'),
  M2:  path.join(__dirname, '..', '..', 'NAS100_M2_202001010300_202610011028.csv'),
  M3:  path.join(__dirname, '..', '..', 'NAS100_M3_202001010300_202610011027.csv'),
  M5:  path.join(__dirname, '..', '..', 'NAS100_M5_202001010300_202610011025.csv'),
  M15: path.join(__dirname, '..', '..', 'NAS100_M15_202001010300_202610011015.csv'),
  H1:  path.join(__dirname, '..', '..', 'NAS100_H1_202001010300_202610011000.csv')
};

async function loadCandles(filePath, maxBars = null) {
  if (!fs.existsSync(filePath)) {
    console.warn(`Archivo no encontrado: ${filePath}`);
    return [];
  }
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
      year: y,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPoints: parts.length >= 9 ? (parseFloat(parts[8]) / 100.0) : 2.0
    });
  }

  const result = (maxBars && candles.length > maxBars) ? candles.slice(-maxBars) : candles;

  // Precalcular EMA 100
  if (result.length > 0) {
    let ema = result[0].close;
    const k = 2 / (100 + 1);
    result.forEach(c => {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    });
  }

  return result;
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
      const cLow = Math.max(bullBottom, bearBottom);
      const cHigh = Math.min(bullTop, bearTop);
      if (cHigh > cLow + minOverlap) {
        bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow, timeMs: c0.timeMs });
      }
    }
  }
  return bprZones;
}

function runSimulation(candles, bprZones, params) {
  const {
    minRange = 5.0,
    minWickRatio = 0.25,
    slPoints = 20.0,
    tp1Points = 30.0,
    tp2Points = 60.0,
    autoBePoints = 20.0,
    sessionFilter = 'ALL', // 'ALL' | 'US_CORE' (13:30-20:00) | 'US_EU' (07:00-20:00)
    slippagePoints = 0.5
  } = params;

  let lastTradeIdx = -100;
  const trades = [];

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 45); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      // Filtro horario anti-rollover (20:55 - 22:15 UTC para índices)
      if (bar.hour === 21) continue;

      // Filtro de sesión
      if (sessionFilter === 'US_CORE') {
        const minuteOfDay = bar.hour * 60 + bar.minute;
        // 13:30 a 20:00 UTC (810 min a 1200 min)
        if (minuteOfDay < 810 || minuteOfDay >= 1200) continue;
      } else if (sessionFilter === 'US_EU') {
        if (bar.hour < 7 || bar.hour >= 20) continue;
      }

      const candleRange = bar.high - bar.low;
      if (candleRange < minRange) continue;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - (minRange * 0.5)) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < minWickRatio) continue;
          if (bar.close < bar.ema100) continue;

          lastTradeIdx = k;
          trades.push(evaluateOutcome('BUY', k, bar, bpr.top, bpr.bottom - slPoints, {
            tp1Points, tp2Points, autoBePoints, slippagePoints
          }, candles));
          break;
        }
      } else { // BEARISH
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + (minRange * 0.5)) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < minWickRatio) continue;
          if (bar.close > bar.ema100) continue;

          lastTradeIdx = k;
          trades.push(evaluateOutcome('SELL', k, bar, bpr.bottom, bpr.top + slPoints, {
            tp1Points, tp2Points, autoBePoints, slippagePoints
          }, candles));
          break;
        }
      }
    }
  });

  const totalTrades = trades.length;
  const wins = trades.filter(t => t.points > 0).length;
  const losses = totalTrades - wins;
  const netPoints = trades.reduce((a, b) => a + b.points, 0);
  const grossWon = trades.filter(t => t.points > 0).reduce((a, b) => a + b.points, 0);
  const grossLost = trades.filter(t => t.points <= 0).reduce((a, b) => a + Math.abs(b.points), 0);
  const wr = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';

  let peak = 0, maxDD = 0, running = 0;
  trades.forEach(t => {
    running += t.points;
    if (running > peak) peak = running;
    if (peak - running > maxDD) maxDD = peak - running;
  });

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate: `${wr}%`,
    netPoints: parseFloat(netPoints.toFixed(1)),
    profitFactor: parseFloat(pf),
    maxDrawdownPoints: parseFloat(maxDD.toFixed(1)),
    avgPointsTrade: totalTrades > 0 ? parseFloat((netPoints / totalTrades).toFixed(1)) : 0
  };
}

function evaluateOutcome(type, k, bar, entry, sl, cfg, candles) {
  let currentSL = sl;
  let tp1Hit = false;
  let points = 0;
  const totalFriction = bar.spreadPoints + cfg.slippagePoints;

  for (let m = k + 1; m < Math.min(candles.length, k + 120); m++) {
    const fBar = candles[m];

    if (type === 'BUY') {
      if (fBar.low <= currentSL) {
        const diff = (currentSL - entry) - totalFriction;
        points = tp1Hit ? (cfg.tp1Points * 0.5 + diff * 0.5) : diff;
        break;
      }
      if (!tp1Hit && fBar.high >= entry + cfg.tp1Points) {
        tp1Hit = true;
        currentSL = entry + 1.0; // Break-Even + 1 punto de resguardo
      }
      if (!tp1Hit && fBar.high >= entry + cfg.autoBePoints) {
        if (currentSL < entry + 1.0) currentSL = entry + 1.0;
      }
      if (fBar.high >= entry + cfg.tp2Points) {
        points = tp1Hit ? (cfg.tp1Points * 0.5 + cfg.tp2Points * 0.5) : cfg.tp2Points;
        break;
      }
    } else {
      if (fBar.high >= currentSL) {
        const diff = (entry - currentSL) - totalFriction;
        points = tp1Hit ? (cfg.tp1Points * 0.5 + diff * 0.5) : diff;
        break;
      }
      if (!tp1Hit && fBar.low <= entry - cfg.tp1Points) {
        tp1Hit = true;
        currentSL = entry - 1.0;
      }
      if (!tp1Hit && fBar.low <= entry - cfg.autoBePoints) {
        if (currentSL > entry - 1.0) currentSL = entry - 1.0;
      }
      if (fBar.low <= entry - cfg.tp2Points) {
        points = tp1Hit ? (cfg.tp1Points * 0.5 + cfg.tp2Points * 0.5) : cfg.tp2Points;
        break;
      }
    }
  }

  if (points === 0 && tp1Hit) points = cfg.tp1Points * 0.5;
  return { points };
}

async function main() {
  console.log('========================================================================================');
  console.log('🏛️ BATERÍA DE BACKTESTS ALGORÍTMICOS: NASDAQ 100 (NAS100 / US100)');
  console.log('   Periodo Histórico: 2020 a 2026 (~7 Años de Datos Reales de Broker)');
  console.log('   Fricción: Spread Broker (~2.0 pts) + Deslizamiento (0.5 pts) = 2.5 pts por trade');
  console.log('========================================================================================\n');

  const tfList = ['M15', 'M5', 'M3', 'M2', 'M1'];

  for (const tf of tfList) {
    console.log(`\n⏳ Analizando ${tf} de NAS100...`);
    const candles = await loadCandles(NAS_FILES[tf]);
    if (candles.length === 0) continue;

    console.log(`   ✅ ${candles.length.toLocaleString()} velas cargadas (${candles[0].dateStr} a ${candles[candles.length - 1].dateStr})`);

    // Parámetros adaptados por temporalidad para Nasdaq
    let gapSize = 3.0, overlap = 2.0, minRange = 5.0;
    if (tf === 'M1')  { gapSize = 2.0; overlap = 1.0; minRange = 3.5; }
    if (tf === 'M2')  { gapSize = 3.0; overlap = 1.5; minRange = 5.0; }
    if (tf === 'M3')  { gapSize = 4.0; overlap = 2.0; minRange = 7.0; }
    if (tf === 'M5')  { gapSize = 6.0; overlap = 3.0; minRange = 10.0; }
    if (tf === 'M15') { gapSize = 12.0; overlap = 6.0; minRange = 20.0; }

    const bprZones = findBprZones(candles, gapSize, overlap);
    console.log(`   🎯 ${bprZones.length.toLocaleString()} zonas BPR identificadas.`);

    // 1. Matriz de Modelos de Riesgo: Ratio Positivo vs Asimétrico / Negativo
    const models = [
      {
        name: 'A) Ratio Positivo Clásico (1:2 - 1:3)',
        sl: tf === 'M15' ? 40 : (tf === 'M5' ? 25 : (tf === 'M3' ? 20 : 15)),
        tp1: tf === 'M15' ? 60 : (tf === 'M5' ? 35 : (tf === 'M3' ? 25 : 20)),
        tp2: tf === 'M15' ? 120 : (tf === 'M5' ? 70 : (tf === 'M3' ? 50 : 40)),
        be: tf === 'M15' ? 35 : (tf === 'M5' ? 20 : (tf === 'M3' ? 15 : 12))
      },
      {
        name: 'B) Asimétrico / R:R Negativo (Alta Efectividad)',
        sl: tf === 'M15' ? 50 : (tf === 'M5' ? 35 : (tf === 'M3' ? 28 : 22)),
        tp1: tf === 'M15' ? 25 : (tf === 'M5' ? 18 : (tf === 'M3' ? 14 : 10)),
        tp2: tf === 'M15' ? 35 : (tf === 'M5' ? 25 : (tf === 'M3' ? 20 : 15)),
        be: tf === 'M15' ? 18 : (tf === 'M5' ? 12 : (tf === 'M3' ? 10 : 8))
      },
      {
        name: 'C) Scalping Rápido Simétrico (1:1)',
        sl: tf === 'M15' ? 30 : (tf === 'M5' ? 20 : (tf === 'M3' ? 15 : 12)),
        tp1: tf === 'M15' ? 25 : (tf === 'M5' ? 18 : (tf === 'M3' ? 15 : 12)),
        tp2: tf === 'M15' ? 40 : (tf === 'M5' ? 30 : (tf === 'M3' ? 25 : 20)),
        be: tf === 'M15' ? 18 : (tf === 'M5' ? 12 : (tf === 'M3' ? 10 : 8))
      }
    ];

    const resultsTable = [];

    for (const m of models) {
      // Test 1: Sesión 24h
      const r24 = runSimulation(candles, bprZones, {
        minRange, slPoints: m.sl, tp1Points: m.tp1, tp2Points: m.tp2, autoBePoints: m.be, sessionFilter: 'ALL'
      });

      // Test 2: Solo Wall Street Core (13:30 - 20:00 UTC)
      const rUS = runSimulation(candles, bprZones, {
        minRange, slPoints: m.sl, tp1Points: m.tp1, tp2Points: m.tp2, autoBePoints: m.be, sessionFilter: 'US_CORE'
      });

      resultsTable.push({
        'TF': tf,
        'Modelo / Estrategia': `${m.name} [24H]`,
        'SL / TP': `${m.sl}p / ${m.tp2}p`,
        'Trades': r24.trades,
        'WinRate': r24.winRate,
        'Puntos Netos': r24.netPoints,
        'PF': r24.profitFactor,
        'MaxDD': r24.maxDrawdownPoints,
        'Avg Pts/Tr': r24.avgPointsTrade
      });

      resultsTable.push({
        'TF': tf,
        'Modelo / Estrategia': `${m.name} [WALL STREET CORE]`,
        'SL / TP': `${m.sl}p / ${m.tp2}p`,
        'Trades': rUS.trades,
        'WinRate': rUS.winRate,
        'Puntos Netos': rUS.netPoints,
        'PF': rUS.profitFactor,
        'MaxDD': rUS.maxDrawdownPoints,
        'Avg Pts/Tr': rUS.avgPointsTrade
      });
    }

    console.table(resultsTable);
  }
}

main().catch(console.error);
