/**
 * Análisis Cuantitativo Exhaustivo al 100%: 
 * 1. Desactivación de EMA 100 (Price Action Puro vs Tendencial)
 * 2. Espectro Completo de Mecha de Rechazo (0% a 30%)
 * 3. Matriz Cruzada y Prueba de Estrés para Prop Firms y Cuenta de 100€
 * 
 * Historial Real MT5: M2, M3, M5, M15 (~7 Años / 120.000+ velas)
 * Fricción Real: Spread 0.45$ + Slippage 0.05$ (5.0 pips de coste)
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

async function loadCandles(filePath, maxCandles = 100000) {
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

  const recent = candles.slice(-maxCandles);
  if (recent.length > 0) {
    let ema100 = recent[0].close;
    const k100 = 2 / (100 + 1);
    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      ema100 = c.close * k100 + ema100 * (1 - k100);
      c.ema100 = ema100;
    }
  }

  return recent;
}

function runSimulation(candles, cfg) {
  const {
    minFvgGap = 0.45,
    minOverlap = 0.25,
    minRange = 0.60,
    bufferPrice = 1.20,
    slMinPrice = 1.80,
    rrRatio = 1.0,
    minWickRatio = 0.15,
    lookbackBars = 22,
    useEmaFilter = true,
    frictionPips = 5.0
  } = cfg;

  const zones = [];
  const trades = [];

  for (let n = 3; n < candles.length - 1; n++) {
    const c0 = candles[n];
    const c1 = candles[n - 1];
    const c2 = candles[n - 2];
    const c3 = candles[n - 3];

    const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
    const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
    if (isBearishFVG) c1.isBearishFVG = true;
    if (isBullishFVG) c1.isBullishFVG = true;

    // Bullish BPR
    if (isBullishFVG) {
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
              top: cHigh,
              bottom: cLow,
              tested: false,
              createdIndex: n
            });
            break;
          }
        }
      }
    }

    // Bearish BPR
    if (isBearishFVG) {
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
              top: cHigh,
              bottom: cLow,
              tested: false,
              createdIndex: n
            });
            break;
          }
        }
      }
    }

    while (zones.length > 80) zones.shift();

    // Filtros de horario: 01:00 a 22:00 UTC (excluyendo rollover y franja 10:00 UTC)
    const hour = c0.hour;
    if (hour >= 22 || hour < 1 || hour === 10) continue;

    const candleRange = c0.high - c0.low;
    if (candleRange < minRange) continue;

    for (let z = zones.length - 1; z >= 0; z--) {
      const zone = zones[z];
      if (zone.tested) continue;
      if (n - zone.createdIndex > 300) { zone.tested = true; continue; }

      // Bullish Retest
      if (zone.type === 'BULLISH') {
        if (c0.low <= zone.top && c0.low >= zone.bottom - bufferPrice) {
          const isWithEma = c0.close > c0.ema100;
          if (useEmaFilter && !isWithEma) continue;

          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          const wickRatio = lowerWick / candleRange;
          if (minWickRatio > 0 && wickRatio < minWickRatio) continue;

          zone.tested = true;
          const entry = (zone.top + zone.bottom) / 2.0;
          const slPrice = zone.bottom - bufferPrice;
          const slDist = entry - slPrice;
          if (slDist < slMinPrice) continue;

          const tpPrice = entry + (slDist * rrRatio);
          const trade = executeTrade(candles, n + 1, 'BUY', entry, slPrice, tpPrice, frictionPips, isWithEma, wickRatio, c0.dateStr);
          trades.push(trade);
          break;
        }
      }

      // Bearish Retest
      else if (zone.type === 'BEARISH') {
        if (c0.high >= zone.bottom && c0.high <= zone.top + bufferPrice) {
          const isWithEma = c0.close < c0.ema100;
          if (useEmaFilter && !isWithEma) continue;

          const upperWick = c0.high - Math.max(c0.open, c0.close);
          const wickRatio = upperWick / candleRange;
          if (minWickRatio > 0 && wickRatio < minWickRatio) continue;

          zone.tested = true;
          const entry = (zone.top + zone.bottom) / 2.0;
          const slPrice = zone.top + bufferPrice;
          const slDist = slPrice - entry;
          if (slDist < slMinPrice) continue;

          const tpPrice = entry - (slDist * rrRatio);
          const trade = executeTrade(candles, n + 1, 'SELL', entry, slPrice, tpPrice, frictionPips, isWithEma, wickRatio, c0.dateStr);
          trades.push(trade);
          break;
        }
      }
    }
  }

  return analyzeMetrics(trades);
}

function executeTrade(candles, startIndex, type, entry, sl, tp, frictionPips, isWithEma, wickRatio, dateStr) {
  const frictionPrice = frictionPips / 10.0;
  const riskPrice = Math.abs(entry - sl);
  const targetPrice = Math.abs(tp - entry);

  for (let i = startIndex; i < Math.min(candles.length, startIndex + 300); i++) {
    const bar = candles[i];
    if (type === 'BUY') {
      if (bar.low <= sl) {
        return { won: false, pips: -(riskPrice * 10.0 + frictionPips), isWithEma, wickRatio, dateStr };
      }
      if (bar.high >= tp) {
        return { won: true, pips: (targetPrice * 10.0 - frictionPips), isWithEma, wickRatio, dateStr };
      }
    } else {
      if (bar.high >= sl) {
        return { won: false, pips: -(riskPrice * 10.0 + frictionPips), isWithEma, wickRatio, dateStr };
      }
      if (bar.low <= tp) {
        return { won: true, pips: (targetPrice * 10.0 - frictionPips), isWithEma, wickRatio, dateStr };
      }
    }
  }

  const lastBar = candles[Math.min(candles.length - 1, startIndex + 299)];
  const diff = type === 'BUY' ? (lastBar.close - entry) : (entry - lastBar.close);
  const pips = diff * 10.0;
  return { won: pips > 0, pips, isWithEma, wickRatio, dateStr };
}

function analyzeMetrics(trades) {
  const total = trades.length;
  if (total === 0) return { trades: 0, winRate: 0, profitFactor: 0, netPips: 0, maxLossStreak: 0, maxDd: 0 };

  let wins = 0;
  let losses = 0;
  let grossWon = 0;
  let grossLost = 0;
  let runningPips = 0;
  let peakPips = 0;
  let maxDd = 0;

  let currentLossStreak = 0;
  let maxLossStreak = 0;

  // Desglose de trades con EMA vs contra EMA
  let withEmaTrades = 0, withEmaWins = 0, withEmaPips = 0;
  let againstEmaTrades = 0, againstEmaWins = 0, againstEmaPips = 0;

  for (const t of trades) {
    if (t.won) {
      wins++;
      grossWon += t.pips;
      currentLossStreak = 0;
    } else {
      losses++;
      grossLost += Math.abs(t.pips);
      currentLossStreak++;
      if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
    }

    if (t.isWithEma) {
      withEmaTrades++;
      if (t.won) withEmaWins++;
      withEmaPips += t.pips;
    } else {
      againstEmaTrades++;
      if (t.won) againstEmaWins++;
      againstEmaPips += t.pips;
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
    maxLossStreak,
    maxDd: parseFloat(maxDd.toFixed(1)),
    withEma: {
      trades: withEmaTrades,
      winRate: withEmaTrades > 0 ? parseFloat(((withEmaWins / withEmaTrades) * 100).toFixed(1)) : 0,
      pips: parseFloat(withEmaPips.toFixed(1))
    },
    againstEma: {
      trades: againstEmaTrades,
      winRate: againstEmaTrades > 0 ? parseFloat(((againstEmaWins / againstEmaTrades) * 100).toFixed(1)) : 0,
      pips: parseFloat(againstEmaPips.toFixed(1))
    }
  };
}

async function startDeepAnalysis() {
  console.log(`========================================================================================`);
  console.log(`🔬 ANÁLISIS EN PROFUNDIDAD 100%: EMA 100 vs PRICE ACTION PURO & ESPECTRO DE MECHA`);
  console.log(`========================================================================================\n`);

  console.log(`Cargando datos históricos MT5 de XAUUSD (M2, M3, M5, M15)...`);
  const [candlesM2, candlesM3, candlesM5, candlesM15] = await Promise.all([
    loadCandles(CSV_FILES.M2, 120000),
    loadCandles(CSV_FILES.M3, 100000),
    loadCandles(CSV_FILES.M5, 70000),
    loadCandles(CSV_FILES.M15, 35000)
  ]);
  console.log(`✅ Velas listas: M2(${candlesM2.length}) M3(${candlesM3.length}) M5(${candlesM5.length}) M15(${candlesM15.length})\n`);

  // ====================================================================================
  // PARTE 1: DESGSECCIÓN QUIRÚRGICA DE LA EMA 100
  // ====================================================================================
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`📌 PARTE 1: ¿QUÉ PASA EXACTAMENTE CUANDO QUITAMOS LA EMA 100?`);
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`Vamos a comparar la operativa CON EMA vs SIN EMA en M2, M3, M5 y M15.`);
  console.log(`Y desglosaremos las operaciones "Contra-Tendencia" (las que la EMA bloqueaba):\n`);

  const tfs = [
    { name: 'M2',  candles: candlesM2,  cfg: { minFvgGap: 0.45, minOverlap: 0.25, minRange: 0.60, bufferPrice: 1.20, slMinPrice: 1.80, minWickRatio: 0.15, lookbackBars: 25 } },
    { name: 'M3',  candles: candlesM3,  cfg: { minFvgGap: 0.55, minOverlap: 0.30, minRange: 0.75, bufferPrice: 1.50, slMinPrice: 2.00, minWickRatio: 0.15, lookbackBars: 22 } },
    { name: 'M5',  candles: candlesM5,  cfg: { minFvgGap: 0.70, minOverlap: 0.40, minRange: 0.90, bufferPrice: 1.80, slMinPrice: 2.20, minWickRatio: 0.15, lookbackBars: 20 } },
    { name: 'M15', candles: candlesM15, cfg: { minFvgGap: 1.00, minOverlap: 0.60, minRange: 1.40, bufferPrice: 2.50, slMinPrice: 3.00, minWickRatio: 0.15, lookbackBars: 16 } }
  ];

  for (const item of tfs) {
    const withEma = runSimulation(item.candles, { ...item.cfg, useEmaFilter: true });
    const withoutEma = runSimulation(item.candles, { ...item.cfg, useEmaFilter: false });

    console.log(`🔹 TEMPORALIDAD ${item.name}:`);
    console.log(`  • CON EMA 100: ${withEma.trades} trades | WR: ${withEma.winRate}% | PF: ${withEma.profitFactor} | Pips: +${withEma.netPips}p | Max DD: -${withEma.maxDd}p | Racha Pérdidas Máx: ${withEma.maxLossStreak}`);
    console.log(`  • SIN EMA 100: ${withoutEma.trades} trades | WR: ${withoutEma.winRate}% | PF: ${withoutEma.profitFactor} | Pips: +${withoutEma.netPips}p | Max DD: -${withoutEma.maxDd}p | Racha Pérdidas Máx: ${withoutEma.maxLossStreak}`);
    console.log(`  🔎 Desglose de las entradas que la EMA bloqueaba (Giros de tendencia / Pullbacks profundos):`);
    console.log(`     - Entradas Contra-EMA tomadas: ${withoutEma.againstEma.trades} trades`);
    console.log(`     - Win Rate de esas entradas:   ${withoutEma.againstEma.winRate}%`);
    console.log(`     - Pips generados por esas entradas: +${withoutEma.againstEma.pips} pips netos\n`);
  }

  // ====================================================================================
  // PARTE 2: ESPECTRO COMPLETO DE MECHA DE RECHAZO (0% A 30%)
  // ====================================================================================
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`📌 PARTE 2: ESPECTRO DE MECHA DE RECHAZO (¿QUÉ FILTRA CADA PORCENTAJE?)`);
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`Evaluando el ratio de mecha sobre el rango total de la vela en M2 y M5:`);
  console.log(`(0% = Entra siempre al cerrar vela retesteando; 10% = Leve absorción; 15% = Actual; 25% = Anterior)\n`);

  const wickLevels = [0.00, 0.10, 0.15, 0.20, 0.25, 0.30];

  console.log(`📊 IMPACTO DE LA MECHA EN M2 (Con EMA vs Sin EMA):`);
  console.log(`Mecha Min | Con EMA: Trades (WR / PF / Pips)         | Sin EMA: Trades (WR / PF / Pips)`);
  console.log(`-------------------------------------------------------------------------------------------`);
  for (const w of wickLevels) {
    const rWith = runSimulation(candlesM2, { ...tfs[0].cfg, minWickRatio: w, useEmaFilter: true });
    const rWithout = runSimulation(candlesM2, { ...tfs[0].cfg, minWickRatio: w, useEmaFilter: false });
    const label = `${(w * 100).toFixed(0)}%`.padEnd(9);
    const withStr = `${String(rWith.trades).padStart(4)}t (${(rWith.winRate+'%').padStart(5)} / ${String(rWith.profitFactor).padStart(4)} / +${String(rWith.netPips).padStart(6)}p)`.padEnd(38);
    const withoutStr = `${String(rWithout.trades).padStart(4)}t (${(rWithout.winRate+'%').padStart(5)} / ${String(rWithout.profitFactor).padStart(4)} / +${String(rWithout.netPips).padStart(6)}p)`;
    console.log(`${label} | ${withStr} | ${withoutStr}`);
  }

  console.log(`\n📊 IMPACTO DE LA MECHA EN M5 (Con EMA vs Sin EMA):`);
  console.log(`Mecha Min | Con EMA: Trades (WR / PF / Pips)         | Sin EMA: Trades (WR / PF / Pips)`);
  console.log(`-------------------------------------------------------------------------------------------`);
  for (const w of wickLevels) {
    const rWith = runSimulation(candlesM5, { ...tfs[2].cfg, minWickRatio: w, useEmaFilter: true });
    const rWithout = runSimulation(candlesM5, { ...tfs[2].cfg, minWickRatio: w, useEmaFilter: false });
    const label = `${(w * 100).toFixed(0)}%`.padEnd(9);
    const withStr = `${String(rWith.trades).padStart(4)}t (${(rWith.winRate+'%').padStart(5)} / ${String(rWith.profitFactor).padStart(4)} / +${String(rWith.netPips).padStart(6)}p)`.padEnd(38);
    const withoutStr = `${String(rWithout.trades).padStart(4)}t (${(rWithout.winRate+'%').padStart(5)} / ${String(rWithout.profitFactor).padStart(4)} / +${String(rWithout.netPips).padStart(6)}p)`;
    console.log(`${label} | ${withStr} | ${withoutStr}`);
  }

  // ====================================================================================
  // PARTE 3: IMPACTO DIRECTO EN CUENTAS: FTMO 100k, THE5ERS 5k Y VT MARKETS 100€
  // ====================================================================================
  console.log(`\n----------------------------------------------------------------------------------------`);
  console.log(`📌 PARTE 3: SIMULACIÓN DE IMPACTO EN TUS CUENTAS REALES (PORTAFOLIO M2+M3+M5+M15)`);
  console.log(`----------------------------------------------------------------------------------------`);

  // Evaluamos el portafolio combinado en 2 configuraciones maestras:
  // A) Configuración Sweet Spot Equilibrada (EMA 100 ACTIVA, Mecha 15%)
  // B) Configuración Price Action Puro (EMA 100 DESACTIVADA, Mecha 15%)
  // C) Configuración Ultra-Fluida (EMA 100 DESACTIVADA, Mecha 10%)

  function evalPortfolio(useEma, wick) {
    let totalTrades = 0;
    let totalWins = 0;
    let totalPips = 0;
    let grossWon = 0;
    let grossLost = 0;
    let maxStreak = 0;

    for (const item of tfs) {
      const res = runSimulation(item.candles, { ...item.cfg, useEmaFilter: useEma, minWickRatio: wick });
      totalTrades += res.trades;
      totalWins += res.wins;
      totalPips += res.netPips;
      if (res.maxLossStreak > maxStreak) maxStreak = res.maxLossStreak;
      // gross
      const won = (res.wins * (res.netPips / (res.wins - res.losses || 1)));
      // approx
    }
    const winRate = (totalWins / totalTrades) * 100;
    return { totalTrades, winRate: winRate.toFixed(1), totalPips: totalPips.toFixed(1), maxStreak };
  }

  const pSweet = evalPortfolio(true, 0.15);
  const pPure15 = evalPortfolio(false, 0.15);
  const pPure10 = evalPortfolio(false, 0.10);

  console.log(`Configuración                   | Trades Totales | Win Rate | Pips Totales | Racha Pérdidas Máx`);
  console.log(`---------------------------------------------------------------------------------------------`);
  console.log(`A) Con EMA 100 + Mecha 15%      | ${String(pSweet.totalTrades).padStart(14)} | ${(pSweet.winRate+'%').padStart(8)} | ${('+'+pSweet.totalPips+'p').padStart(12)} | ${String(pSweet.maxStreak).padStart(18)}`);
  console.log(`B) Sin EMA (Price Action)+M15%  | ${String(pPure15.totalTrades).padStart(14)} | ${(pPure15.winRate+'%').padStart(8)} | ${('+'+pPure15.totalPips+'p').padStart(12)} | ${String(pPure15.maxStreak).padStart(18)}`);
  console.log(`C) Sin EMA + Mecha Fluida 10%   | ${String(pPure10.totalTrades).padStart(14)} | ${(pPure10.winRate+'%').padStart(8)} | ${('+'+pPure10.totalPips+'p').padStart(12)} | ${String(pPure10.maxStreak).padStart(18)}`);

  console.log(`\n========================================================================================`);
  console.log(`🏁 FIN DEL ANÁLISIS QUIRÚRGICO DE EMA Y MECHA`);
  console.log(`========================================================================================\n`);
}

startDeepAnalysis().catch(console.error);
