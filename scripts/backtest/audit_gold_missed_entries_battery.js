/**
 * Batería de Pruebas Cuantitativa: Diagnóstico de Entradas Escapadas y Optimización de XAUUSD (Oro)
 * Periodo: Historial Real MT5 (2025 - 2026, últimos 12 meses y desglose plurianual)
 * 
 * Objetivos:
 * 1. Embudo de Rechazo (Rejection Funnel): Identificar exactamente qué filtro está descartando operaciones.
 * 2. Comparativa de Sensibilidad:
 *    - Umbrales de Gap FVG: 0.70$ (actual hiper-restringido) vs 0.40$ vs 0.25$
 *    - Ventana de Solapamiento (Lookback): 12 velas (actual) vs 25 velas vs 40 velas
 *    - Filtro de Mecha de Absorción: 0.25 (actual) vs 0.15 vs 0.10 vs Sin filtro de mecha
 *    - Filtro Tendencial EMA: EMA 100 estricta vs EMA 200 vs Sin filtro EMA
 *    - Inclusión de M5 y M15 junto a M2 y M3
 * 3. Incorporación de FVG Clásico (Fair Value Gap sin solapamiento forzado) vs Solo BPR
 * 4. Fricción Realista: Spread 0.45$ + Slippage 0.05$ = 0.50$ (5.0 pips de coste por operación)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_FILES = {
  M2: path.join(__dirname, '..', '..', 'XAUUSD_M2_202001020600_202610011120.csv'),
  M3: path.join(__dirname, '..', '..', 'XAUUSD_M3_202001020600_202610011121.csv'),
  M5: path.join(__dirname, '..', '..', 'XAUUSD_M5_202001020600_202610011120.csv'),
  M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202001020600_202610011115.csv')
};

async function loadCandles(filePath, maxCandles = 120000) {
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

  // Tomamos las últimas `maxCandles` velas para evaluar periodo reciente (2025-2026)
  const recentCandles = candles.slice(-maxCandles);

  // Precalcular EMA 100 y EMA 200
  if (recentCandles.length > 0) {
    let ema100 = recentCandles[0].close;
    let ema200 = recentCandles[0].close;
    const k100 = 2 / (100 + 1);
    const k200 = 2 / (200 + 1);

    for (let i = 0; i < recentCandles.length; i++) {
      const c = recentCandles[i];
      ema100 = c.close * k100 + ema100 * (1 - k100);
      ema200 = c.close * k200 + ema200 * (1 - k200);
      c.ema100 = ema100;
      c.ema200 = ema200;
    }
  }

  return recentCandles;
}

// Simulación de ejecución con fricción real (Spread 0.45$ + Slippage 0.05$)
function simulateStrategy(candles, options) {
  const {
    tfKey = 'M2',
    minFvgGap = 0.70,
    minOverlap = 0.40,
    minRange = 0.80,
    bufferPrice = 1.20,
    slMinPrice = 1.80,
    rrRatio = 1.0,
    minWickRatio = 0.25,
    lookbackBars = 12,
    useEmaFilter = true,
    emaType = 'EMA100', // 'EMA100', 'EMA200', 'NONE'
    includeSingleFvg = false, // Permitir también FVG limpio sin requerir solapamiento BPR
    frictionPips = 5.0 // 0.50 USD
  } = options;

  let totalFvgs = 0;
  let totalBprsFormed = 0;
  let retestsOccurred = 0;

  // Estadísticas del embudo de descarte
  const rejections = {
    emaMismatch: 0,
    candleRangeTooSmall: 0,
    insufficientWick: 0,
    slTooTight: 0,
    timeFiltered: 0
  };

  const zones = [];
  const trades = [];

  for (let n = 3; n < candles.length - 1; n++) {
    const c0 = candles[n];
    const c1 = candles[n - 1];
    const c2 = candles[n - 2];
    const c3 = candles[n - 3];

    // Detección FVG
    const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
    const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
    if (isBearishFVG) { c1.isBearishFVG = true; totalFvgs++; }
    if (isBullishFVG) { c1.isBullishFVG = true; totalFvgs++; }

    // Detección BPR (Solapamiento)
    if (isBullishFVG) {
      let bprFound = false;
      for (let i = n - 2; i >= Math.max(0, n - lookbackBars); i--) {
        if (candles[i].isBearishFVG) {
          const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + minFvgGap;
          const bearBottom = candles[i].high;
          const cLow = Math.max(bearBottom, c3.high);
          const cHigh = Math.min(bearTop, c1.low);

          if (cHigh > cLow + minOverlap) {
            zones.push({
              id: `BPR_BULL_${c0.timeMs}`,
              type: 'BULLISH',
              isBpr: true,
              top: cHigh,
              bottom: cLow,
              tested: false,
              createdIndex: n
            });
            totalBprsFormed++;
            bprFound = true;
            break;
          }
        }
      }

      // Si permitimos FVG simple de alta calidad cuando no hay BPR
      if (!bprFound && includeSingleFvg) {
        zones.push({
          id: `FVG_BULL_${c0.timeMs}`,
          type: 'BULLISH',
          isBpr: false,
          top: c1.low,
          bottom: c3.high,
          tested: false,
          createdIndex: n
        });
      }
    }

    if (isBearishFVG) {
      let bprFound = false;
      for (let i = n - 2; i >= Math.max(0, n - lookbackBars); i--) {
        if (candles[i].isBullishFVG) {
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const bullTop = candles[i].low;
          const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - minFvgGap;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + minOverlap) {
            zones.push({
              id: `BPR_BEAR_${c0.timeMs}`,
              type: 'BEARISH',
              isBpr: true,
              top: cHigh,
              bottom: cLow,
              tested: false,
              createdIndex: n
            });
            totalBprsFormed++;
            bprFound = true;
            break;
          }
        }
      }

      if (!bprFound && includeSingleFvg) {
        zones.push({
          id: `FVG_BEAR_${c0.timeMs}`,
          type: 'BEARISH',
          isBpr: false,
          top: c3.low,
          bottom: c1.high,
          tested: false,
          createdIndex: n
        });
      }
    }

    // Limpieza de memoria de zonas viejas (> 350 velas)
    while (zones.length > 80) zones.shift();

    // Evaluación de entradas sobre la vela recién cerrada c0
    const hour = c0.hour;
    // Horario: 01:00 a 22:00 UTC (excluyendo rollover 22-01 y pre-almuerzo 10:00)
    const isTradingHour = !(hour >= 22 || hour < 1 || hour === 10);

    const candleRange = c0.high - c0.low;

    for (let z = zones.length - 1; z >= 0; z--) {
      const zone = zones[z];
      if (zone.tested) continue;
      if (n - zone.createdIndex > 300) { zone.tested = true; continue; }

      // Bullish Retest
      if (zone.type === 'BULLISH') {
        if (c0.low <= zone.top && c0.low >= zone.bottom - bufferPrice) {
          retestsOccurred++;

          if (!isTradingHour) {
            rejections.timeFiltered++;
            continue;
          }

          if (candleRange < minRange) {
            rejections.candleRangeTooSmall++;
            continue;
          }

          if (useEmaFilter) {
            const emaVal = emaType === 'EMA200' ? c0.ema200 : c0.ema100;
            if (c0.close <= emaVal) {
              rejections.emaMismatch++;
              continue;
            }
          }

          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (minWickRatio > 0 && (lowerWick / candleRange) < minWickRatio) {
            rejections.insufficientWick++;
            continue;
          }

          zone.tested = true;
          const entry = (zone.top + zone.bottom) / 2.0;
          const slPrice = zone.bottom - bufferPrice;
          const slDist = entry - slPrice;
          if (slDist < slMinPrice) {
            rejections.slTooTight++;
            continue;
          }

          const tpPrice = entry + (slDist * rrRatio);
          const trade = executeForward(candles, n + 1, 'BUY', entry, slPrice, tpPrice, frictionPips);
          trades.push(trade);
          break;
        }
      }

      // Bearish Retest
      else if (zone.type === 'BEARISH') {
        if (c0.high >= zone.bottom && c0.high <= zone.top + bufferPrice) {
          retestsOccurred++;

          if (!isTradingHour) {
            rejections.timeFiltered++;
            continue;
          }

          if (candleRange < minRange) {
            rejections.candleRangeTooSmall++;
            continue;
          }

          if (useEmaFilter) {
            const emaVal = emaType === 'EMA200' ? c0.ema200 : c0.ema100;
            if (c0.close >= emaVal) {
              rejections.emaMismatch++;
              continue;
            }
          }

          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (minWickRatio > 0 && (upperWick / candleRange) < minWickRatio) {
            rejections.insufficientWick++;
            continue;
          }

          zone.tested = true;
          const entry = (zone.top + zone.bottom) / 2.0;
          const slPrice = zone.top + bufferPrice;
          const slDist = slPrice - entry;
          if (slDist < slMinPrice) {
            rejections.slTooTight++;
            continue;
          }

          const tpPrice = entry - (slDist * rrRatio);
          const trade = executeForward(candles, n + 1, 'SELL', entry, slPrice, tpPrice, frictionPips);
          trades.push(trade);
          break;
        }
      }
    }
  }

  return computeMetrics(trades, {
    totalFvgs,
    totalBprsFormed,
    retestsOccurred,
    rejections
  });
}

function executeForward(candles, startIndex, type, entry, sl, tp, frictionPips) {
  const frictionPrice = frictionPips / 10.0;
  const realEntry = type === 'BUY' ? entry + frictionPrice : entry - frictionPrice;
  const riskPrice = Math.abs(entry - sl);
  const targetPrice = Math.abs(tp - entry);

  for (let i = startIndex; i < Math.min(candles.length, startIndex + 300); i++) {
    const bar = candles[i];
    if (type === 'BUY') {
      if (bar.low <= sl) {
        return { won: false, pips: -(riskPrice * 10.0 + frictionPips), barsHeld: i - startIndex };
      }
      if (bar.high >= tp) {
        return { won: true, pips: (targetPrice * 10.0 - frictionPips), barsHeld: i - startIndex };
      }
    } else {
      if (bar.high >= sl) {
        return { won: false, pips: -(riskPrice * 10.0 + frictionPips), barsHeld: i - startIndex };
      }
      if (bar.low <= tp) {
        return { won: true, pips: (targetPrice * 10.0 - frictionPips), barsHeld: i - startIndex };
      }
    }
  }

  // Si no toca SL ni TP en 300 velas, cierre por mercado
  const lastBar = candles[Math.min(candles.length - 1, startIndex + 299)];
  const diff = type === 'BUY' ? (lastBar.close - realEntry) : (realEntry - lastBar.close);
  const pips = diff * 10.0;
  return { won: pips > 0, pips, barsHeld: 300 };
}

function computeMetrics(trades, funnel) {
  const total = trades.length;
  if (total === 0) {
    return {
      trades: 0,
      winRate: 0,
      profitFactor: 0,
      netPips: 0,
      grossWon: 0,
      grossLost: 0,
      maxDrawdownPips: 0,
      funnel
    };
  }

  let wins = 0;
  let losses = 0;
  let grossWon = 0;
  let grossLost = 0;
  let runningPips = 0;
  let peakPips = 0;
  let maxDd = 0;

  for (const t of trades) {
    if (t.won) {
      wins++;
      grossWon += t.pips;
    } else {
      losses++;
      grossLost += Math.abs(t.pips);
    }
    runningPips += t.pips;
    if (runningPips > peakPips) peakPips = runningPips;
    const dd = peakPips - runningPips;
    if (dd > maxDd) maxDd = dd;
  }

  const winRate = (wins / total) * 100;
  const profitFactor = grossLost > 0 ? (grossWon / grossLost) : 99.0;
  const netPips = grossWon - grossLost;

  return {
    trades: total,
    wins,
    losses,
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    netPips: parseFloat(netPips.toFixed(1)),
    grossWon: parseFloat(grossWon.toFixed(1)),
    grossLost: parseFloat(grossLost.toFixed(1)),
    maxDrawdownPips: parseFloat(maxDd.toFixed(1)),
    funnel
  };
}

async function runBattery() {
  console.log(`========================================================================================`);
  console.log(`🧪 BATERÍA DE PRUEBAS XAUUSD: DESMITIFICANDO ENTRADAS ESCAPADAS (HISTORIAL REAL MT5)`);
  console.log(`========================================================================================\n`);

  console.log(`Cargando velas históricas de MT5...`);
  const [candlesM2, candlesM3, candlesM5, candlesM15] = await Promise.all([
    loadCandles(CSV_FILES.M2, 120000), // ~6-8 meses
    loadCandles(CSV_FILES.M3, 100000), // ~8-10 meses
    loadCandles(CSV_FILES.M5, 70000),  // ~10-12 meses
    loadCandles(CSV_FILES.M15, 35000)  // ~14 meses
  ]);

  console.log(`✅ Velas listas: M2 (${candlesM2.length}), M3 (${candlesM3.length}), M5 (${candlesM5.length}), M15 (${candlesM15.length})\n`);

  // ====================================================================================
  // TEST 1: ANÁLISIS DEL EMBUDO DE DESCARTE (¿POR QUÉ SE ESCAPAN LAS ENTRADAS ACTUALMENTE?)
  // ====================================================================================
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`📊 TEST 1: EMBUDO DE RECHAZO EN LA CONFIGURACIÓN ACTUAL (M2 y M3)`);
  console.log(`----------------------------------------------------------------------------------------`);
  
  const currentM2 = simulateStrategy(candlesM2, {
    tfKey: 'M2',
    minFvgGap: 0.70,
    minOverlap: 0.40,
    minRange: 0.80,
    bufferPrice: 1.20,
    slMinPrice: 1.80,
    rrRatio: 1.0,
    minWickRatio: 0.25,
    lookbackBars: 12,
    useEmaFilter: true,
    emaType: 'EMA100'
  });

  const currentM3 = simulateStrategy(candlesM3, {
    tfKey: 'M3',
    minFvgGap: 0.80,
    minOverlap: 0.50,
    minRange: 1.00,
    bufferPrice: 1.50,
    slMinPrice: 2.00,
    rrRatio: 1.0,
    minWickRatio: 0.25,
    lookbackBars: 12,
    useEmaFilter: true,
    emaType: 'EMA100'
  });

  console.log(`Configuración Actual M2 (Gap 0.70$, Lookback 12, Mecha 0.25, EMA 100):`);
  console.log(`  - Trades Ejecutados: ${currentM2.trades} | Win Rate: ${currentM2.winRate}% | PF: ${currentM2.profitFactor} | Pips Netos: +${currentM2.netPips}`);
  console.log(`  - Retesteos detectados: ${currentM2.funnel.retestsOccurred}`);
  console.log(`  - Rechazos por Filtro EMA 100: ${currentM2.funnel.rejections.emaMismatch}`);
  console.log(`  - Rechazos por Mecha Insuficiente (<25%): ${currentM2.funnel.rejections.insufficientWick}`);
  console.log(`  - Rechazos por Rango de Vela Pequeño: ${currentM2.funnel.rejections.candleRangeTooSmall}`);
  console.log(`  - Rechazos por Horario: ${currentM2.funnel.rejections.timeFiltered}\n`);

  console.log(`Configuración Actual M3 (Gap 0.80$, Lookback 12, Mecha 0.25, EMA 100):`);
  console.log(`  - Trades Ejecutados: ${currentM3.trades} | Win Rate: ${currentM3.winRate}% | PF: ${currentM3.profitFactor} | Pips Netos: +${currentM3.netPips}`);
  console.log(`  - Retesteos detectados: ${currentM3.funnel.retestsOccurred}`);
  console.log(`  - Rechazos por Filtro EMA 100: ${currentM3.funnel.rejections.emaMismatch}`);
  console.log(`  - Rechazos por Mecha Insuficiente (<25%): ${currentM3.funnel.rejections.insufficientWick}`);
  console.log(`  - Rechazos por Rango de Vela Pequeño: ${currentM3.funnel.rejections.candleRangeTooSmall}\n`);

  // ====================================================================================
  // TEST 2: BATERÍA DE OPTIMIZACIÓN - RELAJACIÓN SELECTIVA DE FILTROS CUELLO DE BOTELLA
  // ====================================================================================
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`🔬 TEST 2: COMPARATIVA DE ESCENARIOS PARA CAPTURAR LAS ENTRADAS ESCAPADAS`);
  console.log(`----------------------------------------------------------------------------------------`);

  const scenarios = [
    {
      name: '1. Actual (Línea Base Hiper-Defensiva)',
      cfg: { minFvgGap: 0.70, minOverlap: 0.40, minRange: 0.80, minWickRatio: 0.25, lookbackBars: 12, useEmaFilter: true, emaType: 'EMA100' }
    },
    {
      name: '2. Lookback Ampliado (25 velas en vez de 12)',
      cfg: { minFvgGap: 0.70, minOverlap: 0.40, minRange: 0.80, minWickRatio: 0.25, lookbackBars: 25, useEmaFilter: true, emaType: 'EMA100' }
    },
    {
      name: '3. Mecha Relajada (15% en vez de 25%)',
      cfg: { minFvgGap: 0.70, minOverlap: 0.40, minRange: 0.60, minWickRatio: 0.15, lookbackBars: 20, useEmaFilter: true, emaType: 'EMA100' }
    },
    {
      name: '4. Gap FVG Más Accesible (0.45$ en vez de 0.70$)',
      cfg: { minFvgGap: 0.45, minOverlap: 0.25, minRange: 0.60, minWickRatio: 0.15, lookbackBars: 20, useEmaFilter: true, emaType: 'EMA100' }
    },
    {
      name: '5. Sin Filtro EMA 100 (Price Action Puro BPR)',
      cfg: { minFvgGap: 0.50, minOverlap: 0.25, minRange: 0.60, minWickRatio: 0.15, lookbackBars: 20, useEmaFilter: false }
    },
    {
      name: '6. Sweet Spot Balanceado (Gap 0.45$, Lookback 22, Mecha 0.15, EMA 100)',
      cfg: { minFvgGap: 0.45, minOverlap: 0.25, minRange: 0.60, minWickRatio: 0.15, lookbackBars: 22, useEmaFilter: true, emaType: 'EMA100' }
    },
    {
      name: '7. BPR + FVG Institucional Limpio (Entrada en Imbalances de Alta Convicción)',
      cfg: { minFvgGap: 0.50, minOverlap: 0.25, minRange: 0.60, minWickRatio: 0.15, lookbackBars: 22, useEmaFilter: true, emaType: 'EMA100', includeSingleFvg: true }
    }
  ];

  console.log(`Analizando Escenarios en Temporalidad M2 (Datos Reales):`);
  console.log(`Escenario                                | Trades | Win Rate | Profit Factor | Pips Netos | Max DD`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  for (const sc of scenarios) {
    const res = simulateStrategy(candlesM2, { tfKey: 'M2', rrRatio: 1.0, bufferPrice: 1.20, slMinPrice: 1.80, ...sc.cfg });
    console.log(`${sc.name.padEnd(40)} | ${String(res.trades).padStart(6)} | ${(res.winRate + '%').padStart(8)} | ${String(res.profitFactor).padStart(13)} | ${('+' + res.netPips + 'p').padStart(10)} | ${('-' + res.maxDrawdownPips + 'p').padStart(8)}`);
  }

  console.log(`\nAnalizando Escenarios en Temporalidad M3 (Datos Reales):`);
  console.log(`Escenario                                | Trades | Win Rate | Profit Factor | Pips Netos | Max DD`);
  console.log(`-------------------------------------------------------------------------------------------------`);
  for (const sc of scenarios) {
    const res = simulateStrategy(candlesM3, { tfKey: 'M3', rrRatio: 1.0, bufferPrice: 1.50, slMinPrice: 2.00, ...sc.cfg });
    console.log(`${sc.name.padEnd(40)} | ${String(res.trades).padStart(6)} | ${(res.winRate + '%').padStart(8)} | ${String(res.profitFactor).padStart(13)} | ${('+' + res.netPips + 'p').padStart(10)} | ${('-' + res.maxDrawdownPips + 'p').padStart(8)}`);
  }

  // ====================================================================================
  // TEST 3: COMPARATIVA MULTITEMPORAL COMPLETA: M2 vs M3 vs M5 vs M15
  // ====================================================================================
  console.log(`\n----------------------------------------------------------------------------------------`);
  console.log(`⏰ TEST 3: EXPANSIÓN MULTITEMPORAL (¿DEBERÍAMOS OPERAR M5 Y M15 EN ORO?)`);
  console.log(`----------------------------------------------------------------------------------------`);

  const optimalConfigByTf = {
    M2:  { tfKey: 'M2',  minFvgGap: 0.45, minOverlap: 0.25, minRange: 0.60, bufferPrice: 1.20, slMinPrice: 1.80, minWickRatio: 0.15, lookbackBars: 22, useEmaFilter: true },
    M3:  { tfKey: 'M3',  minFvgGap: 0.55, minOverlap: 0.30, minRange: 0.75, bufferPrice: 1.50, slMinPrice: 2.00, minWickRatio: 0.15, lookbackBars: 20, useEmaFilter: true },
    M5:  { tfKey: 'M5',  minFvgGap: 0.70, minOverlap: 0.40, minRange: 0.90, bufferPrice: 1.80, slMinPrice: 2.20, minWickRatio: 0.15, lookbackBars: 18, useEmaFilter: true },
    M15: { tfKey: 'M15', minFvgGap: 1.00, minOverlap: 0.60, minRange: 1.40, bufferPrice: 2.50, slMinPrice: 3.00, minWickRatio: 0.15, lookbackBars: 15, useEmaFilter: true }
  };

  const resM2 = simulateStrategy(candlesM2, optimalConfigByTf.M2);
  const resM3 = simulateStrategy(candlesM3, optimalConfigByTf.M3);
  const resM5 = simulateStrategy(candlesM5, optimalConfigByTf.M5);
  const resM15 = simulateStrategy(candlesM15, optimalConfigByTf.M15);

  console.log(`Temporalidad | Trades Totales | Trades/Mes | Win Rate | Profit Factor | Pips Netos | Max DD`);
  console.log(`-------------------------------------------------------------------------------------------`);
  console.log(`M2           | ${String(resM2.trades).padStart(14)} | ${String((resM2.trades / 7).toFixed(1)).padStart(10)} | ${(resM2.winRate + '%').padStart(8)} | ${String(resM2.profitFactor).padStart(13)} | ${('+' + resM2.netPips + 'p').padStart(10)} | ${('-' + resM2.maxDrawdownPips + 'p').padStart(8)}`);
  console.log(`M3           | ${String(resM3.trades).padStart(14)} | ${String((resM3.trades / 9).toFixed(1)).padStart(10)} | ${(resM3.winRate + '%').padStart(8)} | ${String(resM3.profitFactor).padStart(13)} | ${('+' + resM3.netPips + 'p').padStart(10)} | ${('-' + resM3.maxDrawdownPips + 'p').padStart(8)}`);
  console.log(`M5           | ${String(resM5.trades).padStart(14)} | ${String((resM5.trades / 11).toFixed(1)).padStart(10)} | ${(resM5.winRate + '%').padStart(8)} | ${String(resM5.profitFactor).padStart(13)} | ${('+' + resM5.netPips + 'p').padStart(10)} | ${('-' + resM5.maxDrawdownPips + 'p').padStart(8)}`);
  console.log(`M15          | ${String(resM15.trades).padStart(14)} | ${String((resM15.trades / 14).toFixed(1)).padStart(10)} | ${(resM15.winRate + '%').padStart(8)} | ${String(resM15.profitFactor).padStart(13)} | ${('+' + resM15.netPips + 'p').padStart(10)} | ${('-' + resM15.maxDrawdownPips + 'p').padStart(8)}`);

  // ====================================================================================
  // TEST 4: COMPARATIVA DE RATIO BENEFICIO/RIESGO EN ORO (1:1.0 vs 1:1.2 vs 1:1.5)
  // ====================================================================================
  console.log(`\n----------------------------------------------------------------------------------------`);
  console.log(`⚖️ TEST 4: RATIO RIESGO:BENEFICIO EN ORO (R:R 1:1.0 vs 1:1.2 vs 1:1.5)`);
  console.log(`----------------------------------------------------------------------------------------`);

  const rrList = [1.0, 1.2, 1.5];
  for (const rr of rrList) {
    const rM2 = simulateStrategy(candlesM2, { ...optimalConfigByTf.M2, rrRatio: rr });
    const rM5 = simulateStrategy(candlesM5, { ...optimalConfigByTf.M5, rrRatio: rr });
    console.log(`R:R 1:${rr.toFixed(1)} -> M2: WR ${rM2.winRate}% | PF ${rM2.profitFactor} | Pips: +${rM2.netPips}p  ||  M5: WR ${rM5.winRate}% | PF ${rM5.profitFactor} | Pips: +${rM5.netPips}p`);
  }

  console.log(`\n========================================================================================`);
  console.log(`🏁 FIN DE LA BATERÍA DE PRUEBAS DE ORO`);
  console.log(`========================================================================================\n`);
}

runBattery().catch(console.error);
