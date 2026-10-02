/**
 * Motor de Aprendizaje Cuantitativo y Optimización de Robustez para XAUUSD (Oro)
 * Periodo: 2020 - 2026 (~7 Años de Historial Real)
 * 
 * Objetivos:
 * 1. Desglose Año a Año (2020, 2021, 2022, 2023, 2024, 2025, 2026) para verificar
 *    si la estrategia mejora, empeora o se degrada con el cambio de precio (de 1.800$ a 4.100$).
 * 2. Evaluación de Nuevas Variables Institucionales:
 *    - SL/TP Fijo vs SL/TP Dinámico Adaptativo por ATR (Average True Range)
 *    - Filtro de Barrido de Liquidez Previo (Liquidity Sweep de High/Low previo)
 *    - Filtro de Horario Institucional de Alta Convicción (London Open 07-11 UTC + NY Open 13-17 UTC)
 *    - Ratio de Mecha de Rechazo (0.25 vs 0.35 vs 0.45)
 *    - Filtro Macro EMA 200 vs EMA 100
 * 3. Fricción Realista Estresada: Spread 0.45$ + Slippage 0.05$ = 0.50$ (5.0 pips por trade)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const GOLD_FILES = {
  M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202001020600_202610011115.csv'),
  M5:  path.join(__dirname, '..', '..', 'XAUUSD_M5_202001020600_202610011120.csv')
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
      month: m,
      day: d,
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

  // Precalcular EMA 100, EMA 200 y ATR 14
  if (candles.length > 0) {
    let ema100 = candles[0].close;
    let ema200 = candles[0].close;
    const k100 = 2 / (100 + 1);
    const k200 = 2 / (200 + 1);

    let atrSum = 0;
    const atrPeriod = 14;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      ema100 = c.close * k100 + ema100 * (1 - k100);
      ema200 = c.close * k200 + ema200 * (1 - k200);
      c.ema100 = ema100;
      c.ema200 = ema200;

      const prevClose = i > 0 ? candles[i - 1].close : c.open;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      );
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

function runBacktestEngine(candles, bprZones, config) {
  const {
    useAtr = false,
    atrSlMult = 1.2,
    atrTpMult = 2.5,
    fixedSlPips = 25.0,
    fixedTpPips = 60.0,
    autoBeRatio = 0.6, // % del TP para mover a BE
    minWickRatio = 0.25,
    minRange = 0.35,
    emaFilter = 'EMA100', // 'EMA100' | 'EMA200'
    sessionMode = 'PRIME', // 'PRIME' (07-18) | 'KILLZONES' (07-11 y 13-17) | '24H'
    liquiditySweepFilter = false,
    frictionPips = 5.0
  } = config;

  let lastTradeIdx = -100;
  const trades = [];

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 20); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      // Rollover Shield (22:55 - 00:10 UTC)
      if (bar.hour === 23 || (bar.hour === 0 && bar.minute <= 15)) continue;

      // Filtro de Sesión
      if (sessionMode === 'PRIME') {
        if (bar.hour < 7 || bar.hour >= 18) continue;
      } else if (sessionMode === 'KILLZONES') {
        // Ventanas de Oro Institucional: London Open (07:00 - 11:00) y NY Open (13:00 - 17:00)
        const inLondon = (bar.hour >= 7 && bar.hour < 11);
        const inNy = (bar.hour >= 13 && bar.hour < 17);
        if (!inLondon && !inNy) continue;
      }

      const candleRange = bar.high - bar.low;
      if (candleRange < minRange) continue;

      // Filtro de Barrido de Liquidez Previo (debe barrer el high/low de las 5 velas previas)
      if (liquiditySweepFilter && k >= 5) {
        let prevHigh5 = 0;
        let prevLow5 = 999999;
        for (let p = k - 5; p < k; p++) {
          if (candles[p].high > prevHigh5) prevHigh5 = candles[p].high;
          if (candles[p].low < prevLow5) prevLow5 = candles[p].low;
        }
        if (bpr.type === 'BULLISH' && bar.low >= prevLow5) continue; // No barrió liquidez previa
        if (bpr.type === 'BEARISH' && bar.high <= prevHigh5) continue; // No barrió liquidez previa
      }

      // Cálculo dinámico de distancias SL y TP
      let slDist = 0;
      let tpDist = 0;
      if (useAtr && bar.atr) {
        slDist = bar.atr * atrSlMult;
        tpDist = bar.atr * atrTpMult;
      } else {
        slDist = fixedSlPips * 0.10;
        tpDist = fixedTpPips * 0.10;
      }
      const autoBeDist = tpDist * autoBeRatio;

      const emaRef = emaFilter === 'EMA200' ? bar.ema200 : bar.ema100;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < minWickRatio) continue;
          if (bar.close < emaRef) continue;

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
          if (bar.close > emaRef) continue;

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

  return trades;
}

function calculateMetrics(trades) {
  const total = trades.length;
  if (total === 0) return { trades: 0, winRate: '0%', netPips: 0, pf: '0', maxDd: 0 };

  const wins = trades.filter(t => t.pips > 0).length;
  const winRate = ((wins / total) * 100).toFixed(1);
  const netPips = trades.reduce((a, b) => a + b.pips, 0);
  const grossWon = trades.filter(t => t.pips > 0).reduce((a, b) => a + b.pips, 0);
  const grossLost = Math.abs(trades.filter(t => t.pips < 0).reduce((a, b) => a + b.pips, 0));
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';

  let peak = 0, running = 0, maxDd = 0;
  trades.forEach(t => {
    running += t.pips;
    if (running > peak) peak = running;
    if (peak - running > maxDd) maxDd = peak - running;
  });

  return {
    trades: total,
    winRate: `${winRate}%`,
    netPips: parseFloat(netPips.toFixed(1)),
    pf: parseFloat(pf),
    maxDd: parseFloat(maxDd.toFixed(1))
  };
}

async function runRobustnessAnalysis() {
  console.log('========================================================================================');
  console.log('🧠 MOTOR DE APRENDIZAJE CUANTITATIVO Y ESTUDIO DE ROBUSTEZ XAUUSD (2020 - 2026)');
  console.log('   Fricción Alta Estresada: Spread 0.45$ + Slippage 0.05$ = 0.50$ (5.0 pips / trade)');
  console.log('========================================================================================\n');

  for (const tf of ['M5', 'M15']) {
    const filePath = GOLD_FILES[tf];
    if (!fs.existsSync(filePath)) continue;

    console.log(`\n========================================================================================`);
    console.log(`📈 ANALIZANDO TEMPORALIDAD: XAUUSD ${tf}`);
    console.log(`========================================================================================`);

    const candles = await loadCandles(filePath);
    const minFvgGap = tf === 'M15' ? 0.50 : 0.30;
    const minOverlap = tf === 'M15' ? 0.30 : 0.18;
    const bprZones = findBprZones(candles, minFvgGap, minOverlap);
    console.log(`Velas cargadas: ${candles.length.toLocaleString()} | BPRs: ${bprZones.length}\n`);

    // 1. COMPARATIVA DE CONFIGURACIONES CLAVE
    const configsToTest = [
      {
        id: '1_ACTUAL_FIJO',
        name: 'Configuración Actual (SL/TP Fijo)',
        useAtr: false,
        fixedSlPips: tf === 'M15' ? 25.0 : 15.0,
        fixedTpPips: tf === 'M15' ? 60.0 : 40.0,
        autoBeRatio: 0.6,
        minWickRatio: 0.25,
        sessionMode: 'PRIME',
        emaFilter: 'EMA100'
      },
      {
        id: '2_EXPANDIDO_FIJO',
        name: 'Expansión x2.0 (SL/TP Fijo Amplio)',
        useAtr: false,
        fixedSlPips: tf === 'M15' ? 50.0 : 30.0,
        fixedTpPips: tf === 'M15' ? 120.0 : 70.0,
        autoBeRatio: 0.55,
        minWickRatio: 0.25,
        sessionMode: 'PRIME',
        emaFilter: 'EMA100'
      },
      {
        id: '3_ATR_DINAMICO',
        name: 'SL/TP Dinámico Adaptativo por ATR (1.2x ATR / 2.8x ATR)',
        useAtr: true,
        atrSlMult: 1.2,
        atrTpMult: 2.8,
        autoBeRatio: 0.5,
        minWickRatio: 0.25,
        sessionMode: 'PRIME',
        emaFilter: 'EMA100'
      },
      {
        id: '4_ATR_KILLZONES',
        name: 'ATR Dinámico + Killzones Londres & NY (07-11 y 13-17 UTC)',
        useAtr: true,
        atrSlMult: 1.2,
        atrTpMult: 2.8,
        autoBeRatio: 0.5,
        minWickRatio: 0.30,
        sessionMode: 'KILLZONES',
        emaFilter: 'EMA100'
      },
      {
        id: '5_INSTITUCIONAL_SWEEP',
        name: 'Institucional Elite: ATR + Killzones + Barrido de Liquidez Previo',
        useAtr: true,
        atrSlMult: 1.2,
        atrTpMult: 3.0,
        autoBeRatio: 0.5,
        minWickRatio: 0.35,
        sessionMode: 'KILLZONES',
        liquiditySweepFilter: true,
        emaFilter: 'EMA200'
      }
    ];

    for (const cfg of configsToTest) {
      console.log(`----------------------------------------------------------------------------------------`);
      console.log(`🔬 ESTRATEGIA: [${cfg.name}]`);
      console.log(`----------------------------------------------------------------------------------------`);

      const allTrades = runBacktestEngine(candles, bprZones, cfg);
      const globalMetrics = calculateMetrics(allTrades);

      console.log(`🌐 GLOBAL (2020-2026): ${globalMetrics.trades} Trades | Win: ${globalMetrics.winRate} | Net: ${globalMetrics.netPips > 0 ? '+' : ''}${globalMetrics.netPips}p | PF: ${globalMetrics.pf} | MaxDD: ${globalMetrics.maxDd}p`);
      console.log(`📅 DESGLOSE AÑO A AÑO (Robustez Temporal):`);

      const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
      let profitableYears = 0;

      years.forEach(yr => {
        const yTrades = allTrades.filter(t => t.year === yr);
        const yMetrics = calculateMetrics(yTrades);
        if (yMetrics.netPips > 0) profitableYears++;
        const icon = yMetrics.netPips > 0 ? '✅' : '❌';
        console.log(`   ${icon} Año ${yr}: ${yMetrics.trades.toString().padStart(4, ' ')} trades | Win: ${yMetrics.winRate.padStart(5, ' ')} | Net: ${(yMetrics.netPips > 0 ? '+' : '') + yMetrics.netPips.toFixed(1).padStart(7, ' ')}p | PF: ${yMetrics.pf.toString().padStart(4, ' ')} | DD: ${yMetrics.maxDd.toFixed(1).padStart(6, ' ')}p`);
      });

      console.log(`🏆 Consistencia Anual: ${profitableYears} de ${years.length} años en positivo (${((profitableYears / years.length) * 100).toFixed(0)}%)\n`);
    }
  }

  console.log('========================================================================================');
  console.log('✅ Estudio de Aprendizaje Cuantitativo y Robustez Finalizado.');
  console.log('========================================================================================');
}

runRobustnessAnalysis().catch(console.error);
