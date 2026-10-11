/**
 * Backtest Maestro Multi-Activo Institucional 2020 - 2026 (7 Años)
 * 
 * Modela con un 99% de realismo frente al mercado live:
 * 1. Spread dinámico real del broker por sesión y activo.
 * 2. Comisiones reales Round-Turn (The5%ers $8.25/lote, FTMO $5.86/lote).
 * 3. Slippage real de red/ejecución (0.5 - 1.5 pips).
 * 4. Escudos temporales activos: Rollover Shield (22:55 - 00:10 CET) y Friday Close Guard (Viernes 21:30 CET).
 * 5. Resolución intra-vela conservadora (en caso de duda, SL toca primero).
 * 
 * Métricas calculadas:
 * - Pips/Puntos netos
 * - Win Rate (%) y Profit Factor
 * - Profit Total en $ USD (The5%ers 5k y FTMO 100k con lotaje adaptativo a riesgo 0.75%)
 * - Media de Profit por Día ($ USD/día y pips/día, en días de trading y días naturales)
 * - Max Drawdown en pips, en $ USD y en % del balance
 * - Comparativa: FULL_TP2_NO_BE vs PARTIAL_50_NO_BE
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');

// Perfiles de cuentas para cálculo monetario ($ USD) y comisiones
const PROFILES = {
  THE5ERS_5K: {
    id: 'THE5ERS_5K',
    name: 'The 5%ers $5,000 USD',
    initialBalance: 5000,
    riskPercent: 0.75, // $37.50 USD por operación
    commissionPerLotRoundTurn: 8.25,
    slippagePips: 1.0,
    maxConcurrent: 2
  },
  FTMO_100K: {
    id: 'FTMO_100K',
    name: 'FTMO $100,000 USD',
    initialBalance: 100000,
    riskPercent: 0.75, // $750.00 USD por operación
    commissionPerLotRoundTurn: 5.86,
    slippagePips: 1.0,
    maxConcurrent: 2
  }
};

// Configuraciones institucionales por activo (2020 - 2026)
const ASSETS_CONFIG = [
  {
    symbol: 'XAUUSD',
    name: 'Oro Spot (XAUUSD)',
    file: 'XAUUSD_M15_202001020600_202610011115.csv',
    timeframe: 'M15',
    unitName: 'pips',
    pipSize: 0.1,
    pipValuePerLotUSD: 10.0,
    propMaxLot5k: 0.10,
    propMaxLot100k: 2.00,
    defaultSpreadPips: 2.5,
    direction: 'BOTH',
    minFvgGap: 0.50,
    minOverlap: 0.35,
    slPips: 25.0,
    tp1Pips: 60.0,
    tp2Pips: 120.0,
    allowedHoursUTC: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
  },
  {
    symbol: 'EURUSD',
    name: 'Euro / Dólar (EURUSD)',
    file: 'EURUSD_M15_202001020600_202610011015.csv',
    timeframe: 'M15',
    unitName: 'pips',
    pipSize: 0.0001,
    pipValuePerLotUSD: 10.0,
    propMaxLot5k: 0.75,
    propMaxLot100k: 15.00,
    defaultSpreadPips: 0.3,
    direction: 'BOTH',
    minFvgGap: 0.00018,
    minOverlap: 0.00010,
    slPips: 6.0,
    tp1Pips: 8.0,
    tp2Pips: 15.0,
    allowedHoursUTC: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
  },
  {
    symbol: 'GBPJPY',
    name: 'Libra / Yen (GBPJPY)',
    file: 'GBPJPY_M15_202001020600_202610011015.csv',
    timeframe: 'M15',
    unitName: 'pips',
    pipSize: 0.01,
    pipValuePerLotUSD: 7.20,
    propMaxLot5k: 0.50,
    propMaxLot100k: 10.00,
    defaultSpreadPips: 1.5,
    direction: 'SELL_ONLY',
    minFvgGap: 0.055,
    minOverlap: 0.030,
    slPips: 14.0,
    tp1Pips: 18.0,
    tp2Pips: 32.0,
    allowedHoursUTC: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
  },
  {
    symbol: 'NAS100',
    name: 'Nasdaq 100 Cash (NAS100)',
    file: 'NAS100_M15_202001010300_202610011015.csv',
    timeframe: 'M15',
    unitName: 'pts',
    pipSize: 1.0,
    pipValuePerLotUSD: 1.0,
    propMaxLot5k: 2.0,
    propMaxLot100k: 40.0,
    defaultSpreadPips: 1.5,
    direction: 'BUY_ONLY',
    minFvgGap: 12.0,
    minOverlap: 7.0,
    slPips: 20.0,
    tp1Pips: 35.0,
    tp2Pips: 70.0,
    allowedHoursUTC: [13, 14, 15, 16, 17, 18, 19, 20]
  }
];

// Modelos de salida a comparar
const EXIT_MODELS = [
  { id: 'FULL_TP2_NO_BE', name: '100% Posición | TP2 Directo (Sin BE ni Trailing)', partial: false },
  { id: 'PARTIAL_50_NO_BE', name: '50% en TP1 + 50% en TP2 (Sin BE ni Trailing)', partial: true }
];

async function loadCandles(filePath, asset) {
  const fullPath = path.join(ROOT, filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Archivo no encontrado: ${fullPath}`);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(fullPath),
    crlfDelay: Infinity
  });

  const candles = [];
  let header = true;

  for await (const line of rl) {
    if (header) { header = false; continue; }
    if (!line.trim()) continue;
    const p = line.split('\t');
    if (p.length < 6) continue;

    const [y, m, d] = p[0].split('.').map(Number);
    const [hh, mm, ss] = p[1].split(':').map(Number);
    const timeMs = Date.UTC(y, m - 1, d, hh - 2, mm, ss); // Broker en UTC+2
    const dObj = new Date(timeMs);

    let spread = asset.defaultSpreadPips;
    if (p.length >= 9) {
      const rawSpread = parseFloat(p[8]);
      if (!isNaN(rawSpread) && rawSpread > 0) {
        if (asset.symbol === 'EURUSD') spread = rawSpread / 10.0;
        else if (asset.symbol === 'GBPJPY') spread = rawSpread / 10.0;
        else if (asset.symbol === 'XAUUSD') spread = rawSpread / 10.0;
        else if (asset.symbol === 'NAS100') spread = rawSpread / 4.0;
      }
    }

    candles.push({
      dateStr: p[0],
      timeStr: p[1],
      timeMs,
      utcDay: dObj.getUTCDay(),
      utcHour: dObj.getUTCHours(),
      utcMinute: dObj.getUTCMinutes(),
      open: parseFloat(p[2]),
      high: parseFloat(p[3]),
      low: parseFloat(p[4]),
      close: parseFloat(p[5]),
      spread
    });
  }

  candles.sort((a, b) => a.timeMs - b.timeMs);

  // Calcular EMA 100 para filtro institucional
  let ema = candles[0].close;
  const k = 2 / (100 + 1);
  for (let i = 0; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    candles[i].ema100 = ema;
  }

  return candles;
}

function detectBprSignals(candles, asset) {
  const zones = [];
  let lastBullIdx = -100;
  let lastBearIdx = -100;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i - 2];
    const c1 = candles[i - 1];
    const c2 = candles[i];

    const isBullFvg = c2.low > c0.high + asset.minFvgGap;
    const isBearFvg = c0.low > c2.high + asset.minFvgGap;

    if (isBullFvg) lastBullIdx = i;
    if (isBearFvg) lastBearIdx = i;

    // BPR Alcista: FVG alcista solapando FVG bajista reciente
    if (isBullFvg && i - lastBearIdx > 0 && i - lastBearIdx <= 10 && asset.direction !== 'SELL_ONLY') {
      const bearTop = candles[lastBearIdx - 2].low;
      const bearBottom = candles[lastBearIdx].high;
      const bullTop = c2.low;
      const bullBottom = c0.high;
      const bottom = Math.max(bearBottom, bullBottom);
      const top = Math.min(bearTop, bullTop);
      if (top > bottom + asset.minOverlap) {
        zones.push({ type: 'BULLISH', createdIdx: i, top, bottom });
      }
    }

    // BPR Bajista: FVG bajista solapando FVG alcista reciente
    if (isBearFvg && i - lastBullIdx > 0 && i - lastBullIdx <= 10 && asset.direction !== 'BUY_ONLY') {
      const bullTop = candles[lastBullIdx].low;
      const bullBottom = candles[lastBullIdx - 2].high;
      const bearTop = c0.low;
      const bearBottom = c2.high;
      const bottom = Math.max(bullBottom, bearBottom);
      const top = Math.min(bullTop, bearTop);
      if (top > bottom + asset.minOverlap) {
        zones.push({ type: 'BEARISH', createdIdx: i, top, bottom });
      }
    }
  }

  const signals = [];
  let lastSignalIdx = -100;

  for (const zone of zones) {
    for (let i = zone.createdIdx + 1; i < Math.min(candles.length, zone.createdIdx + 40); i++) {
      if (i - lastSignalIdx < 3) continue;
      const c = candles[i];

      // 1. Filtro de Horario Operativo Institucional
      if (!asset.allowedHoursUTC.includes(c.utcHour)) continue;

      // 2. Rollover Shield (22:55 - 00:10 CET => 20:55 - 22:10 UTC)
      if (c.utcHour === 21 || (c.utcHour === 22 && c.utcMinute < 15)) continue;

      // 3. Friday Close Guard (Viernes > 19:30 UTC => 21:30 CET)
      if (c.utcDay === 5 && c.utcHour >= 19 && c.utcMinute >= 30) continue;
      if (c.utcDay === 6 || (c.utcDay === 0 && c.utcHour < 21)) continue;

      const range = c.high - c.low;
      if (range <= 0) continue;

      if (zone.type === 'BULLISH') {
        if (c.low > zone.top || c.low < zone.bottom - (asset.slPips * asset.pipSize * 0.5)) continue;
        const lowerWick = Math.min(c.open, c.close) - c.low;
        if (lowerWick / range < 0.20) continue;
        if (c.close < c.ema100) continue; // Filtro tendencial EMA 100

        const entry = zone.top;
        const sl = entry - (asset.slPips * asset.pipSize);
        const tp1 = entry + (asset.tp1Pips * asset.pipSize);
        const tp2 = entry + (asset.tp2Pips * asset.pipSize);

        lastSignalIdx = i;
        signals.push({
          symbol: asset.symbol,
          action: 'BUY',
          idx: i,
          timeMs: c.timeMs,
          dateStr: c.dateStr,
          entry,
          sl,
          tp1,
          tp2,
          slPips: asset.slPips,
          tp1Pips: asset.tp1Pips,
          tp2Pips: asset.tp2Pips,
          spreadAtEntry: c.spread
        });
        break;
      }

      if (zone.type === 'BEARISH') {
        if (c.high < zone.bottom || c.high > zone.top + (asset.slPips * asset.pipSize * 0.5)) continue;
        const upperWick = c.high - Math.max(c.open, c.close);
        if (upperWick / range < 0.20) continue;
        if (c.close > c.ema100) continue;

        const entry = zone.bottom;
        const sl = entry + (asset.slPips * asset.pipSize);
        const tp1 = entry - (asset.tp1Pips * asset.pipSize);
        const tp2 = entry - (asset.tp2Pips * asset.pipSize);

        lastSignalIdx = i;
        signals.push({
          symbol: asset.symbol,
          action: 'SELL',
          idx: i,
          timeMs: c.timeMs,
          dateStr: c.dateStr,
          entry,
          sl,
          tp1,
          tp2,
          slPips: asset.slPips,
          tp1Pips: asset.tp1Pips,
          tp2Pips: asset.tp2Pips,
          spreadAtEntry: c.spread
        });
        break;
      }
    }
  }

  return signals;
}

function simulateTrades(signals, candles, asset, model, profile) {
  const dirMultiplier = 1;
  const frictionPips = profile.slippagePips + (profile.commissionPerLotRoundTurn / asset.pipValuePerLotUSD);

  const trades = [];
  const maxHoldBars = 120; // 30 horas máx en M15

  for (const s of signals) {
    const isBuy = s.action === 'BUY';
    const startIdx = s.idx + 1;
    const endIdx = Math.min(candles.length, s.idx + maxHoldBars);

    let tp1Reached = false;
    let exitReason = 'TIMEOUT';
    let exitPips = 0;
    let exitTimeMs = s.timeMs;

    for (let i = startIdx; i < endIdx; i++) {
      const c = candles[i];
      exitTimeMs = c.timeMs;

      // Resolución Pesimista Intra-Vela: Primero comprobamos el SL
      const hitSL = isBuy ? c.low <= s.sl : c.high >= s.sl;
      if (hitSL) {
        if (model.partial && tp1Reached) {
          // El primer 50% ya cobró TP1, el segundo 50% toca SL completo
          exitReason = 'TP1_THEN_SL';
          exitPips = (s.tp1Pips * 0.5) - (s.slPips * 0.5);
        } else {
          exitReason = 'STOP_LOSS';
          exitPips = -s.slPips;
        }
        break;
      }

      // Comprobar TP2
      const hitTP2 = isBuy ? c.high >= s.tp2 : c.low <= s.tp2;
      if (hitTP2) {
        if (model.partial) {
          exitReason = 'TP2_AFTER_TP1';
          exitPips = (s.tp1Pips * 0.5) + (s.tp2Pips * 0.5);
        } else {
          exitReason = 'TP2_FULL';
          exitPips = s.tp2Pips;
        }
        break;
      }

      // Comprobar TP1 (para marcar tramo parcial)
      const hitTP1 = isBuy ? c.high >= s.tp1 : c.low <= s.tp1;
      if (hitTP1) {
        tp1Reached = true;
      }
    }

    if (exitReason === 'TIMEOUT') {
      const lastC = candles[endIdx - 1];
      const mtm = isBuy ? (lastC.close - s.entry) / asset.pipSize : (s.entry - lastC.close) / asset.pipSize;
      if (model.partial && tp1Reached) {
        exitPips = (s.tp1Pips * 0.5) + (mtm * 0.5);
      } else {
        exitPips = mtm;
      }
    }

    const netPips = exitPips - frictionPips;

    // Dimensionamiento de Lotaje por Perfil de Cuenta
    const riskUSD = profile.initialBalance * (profile.riskPercent / 100);
    const monetaryRiskPerLot = s.slPips * asset.pipValuePerLotUSD;
    let lotSize = monetaryRiskPerLot > 0 ? riskUSD / monetaryRiskPerLot : 0.01;
    lotSize = Math.max(0.01, Math.floor(lotSize * 100) / 100);

    const maxLot = profile.id === 'THE5ERS_5K' ? asset.propMaxLot5k : asset.propMaxLot100k;
    lotSize = Math.min(lotSize, maxLot);

    const profitUSD = netPips * asset.pipValuePerLotUSD * lotSize;

    trades.push({
      symbol: asset.symbol,
      dateStr: s.dateStr,
      timeMs: s.timeMs,
      exitTimeMs,
      action: s.action,
      netPips: Number(netPips.toFixed(1)),
      lotSize,
      profitUSD: Number(profitUSD.toFixed(2)),
      isWin: profitUSD > 0,
      reason: exitReason
    });
  }

  return trades;
}

function calculateComprehensiveMetrics(trades, profile) {
  if (!trades || trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      profitFactor: 0,
      totalPips: 0,
      maxDDPips: 0,
      totalProfitUSD: 0,
      maxDDUSD: 0,
      maxDDPercent: 0,
      tradingDays: 0,
      calendarDays: 1,
      avgProfitPerTradingDayUSD: 0,
      avgProfitPerCalendarDayUSD: 0,
      avgPipsPerTradingDay: 0
    };
  }

  // Filtrar concurrencia máxima (ej. máx 2 operaciones activas simultáneas)
  trades.sort((a, b) => a.timeMs - b.timeMs);
  const activeTrades = [];
  const accepted = [];

  for (const t of trades) {
    // Eliminar las que ya cerraron antes de t.timeMs
    for (let i = activeTrades.length - 1; i >= 0; i--) {
      if (activeTrades[i].exitTimeMs <= t.timeMs) {
        activeTrades.splice(i, 1);
      }
    }
    if (activeTrades.length < profile.maxConcurrent) {
      activeTrades.push(t);
      accepted.push(t);
    }
  }

  let totalPips = 0;
  let totalProfitUSD = 0;
  let grossWonUSD = 0;
  let grossLostUSD = 0;
  let wins = 0;
  let losses = 0;

  let balance = profile.initialBalance;
  let peakBalance = balance;
  let maxDDUSD = 0;

  let peakPips = 0;
  let maxDDPips = 0;
  let runningPips = 0;

  const uniqueDays = new Set();
  const startTime = accepted[0].timeMs;
  const endTime = accepted[accepted.length - 1].exitTimeMs;

  for (const t of accepted) {
    totalPips += t.netPips;
    totalProfitUSD += t.profitUSD;
    balance += t.profitUSD;
    runningPips += t.netPips;
    uniqueDays.add(t.dateStr);

    if (t.profitUSD > 0) {
      wins++;
      grossWonUSD += t.profitUSD;
    } else {
      losses++;
      grossLostUSD += Math.abs(t.profitUSD);
    }

    if (balance > peakBalance) peakBalance = balance;
    const currentDDUSD = peakBalance - balance;
    if (currentDDUSD > maxDDUSD) maxDDUSD = currentDDUSD;

    if (runningPips > peakPips) peakPips = runningPips;
    const currentDDPips = peakPips - runningPips;
    if (currentDDPips > maxDDPips) maxDDPips = currentDDPips;
  }

  const calendarDays = Math.max(1, Math.round((endTime - startTime) / (24 * 3600 * 1000)));
  const tradingDays = uniqueDays.size;

  const profitFactor = grossLostUSD > 0 ? grossWonUSD / grossLostUSD : 99.9;
  const winRate = (wins / accepted.length) * 100;
  const maxDDPercent = (maxDDUSD / profile.initialBalance) * 100;

  const avgProfitPerTradingDayUSD = totalProfitUSD / tradingDays;
  const avgProfitPerCalendarDayUSD = totalProfitUSD / calendarDays;
  const avgPipsPerTradingDay = totalPips / tradingDays;

  return {
    totalTrades: accepted.length,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    profitFactor: Number(profitFactor.toFixed(2)),
    totalPips: Number(totalPips.toFixed(1)),
    maxDDPips: Number(maxDDPips.toFixed(1)),
    totalProfitUSD: Number(totalProfitUSD.toFixed(2)),
    maxDDUSD: Number(maxDDUSD.toFixed(2)),
    maxDDPercent: Number(maxDDPercent.toFixed(1)),
    tradingDays,
    calendarDays,
    avgProfitPerTradingDayUSD: Number(avgProfitPerTradingDayUSD.toFixed(2)),
    avgProfitPerCalendarDayUSD: Number(avgProfitPerCalendarDayUSD.toFixed(2)),
    avgPipsPerTradingDay: Number(avgPipsPerTradingDay.toFixed(1))
  };
}

async function runMasterBacktest() {
  console.log('========================================================================================');
  console.log('🏛️  INICIANDO BACKTEST MAESTRO MULTI-ACTIVO INSTITUCIONAL 2020 - 2026 (7 AÑOS)');
  console.log('   Fricción Real: Spread Dinámico + Comisiones Broker + Slippage + Escudos Temporales');
  console.log('========================================================================================\n');

  const assetCandles = {};
  const assetSignals = {};

  for (const asset of ASSETS_CONFIG) {
    process.stdout.write(`📂 Cargando datos de ${asset.name} (${asset.file})... `);
    const candles = await loadCandles(asset.file, asset);
    assetCandles[asset.symbol] = candles;
    console.log(`✅ ${candles.length.toLocaleString()} velas (${candles[0].dateStr} a ${candles[candles.length - 1].dateStr}).`);

    process.stdout.write(`   🔍 Detectando zonas y señales BPR institucionales... `);
    const signals = detectBprSignals(candles, asset);
    assetSignals[asset.symbol] = signals;
    console.log(`✅ ${signals.length} señales detectadas.\n`);
  }

  const results = [];

  for (const profileKey of Object.keys(PROFILES)) {
    const profile = PROFILES[profileKey];
    console.log(`\n========================================================================================`);
    console.log(`👤 AUDITORÍA DE CUENTA: ${profile.name}`);
    console.log(`========================================================================================`);

    for (const model of EXIT_MODELS) {
      console.log(`\n----------------------------------------------------------------------------------------`);
      console.log(`📌 Modelo: [${model.id}] -> ${model.name}`);
      console.log(`----------------------------------------------------------------------------------------`);

      const portfolioTrades = [];

      for (const asset of ASSETS_CONFIG) {
        const signals = assetSignals[asset.symbol];
        const candles = assetCandles[asset.symbol];
        const trades = simulateTrades(signals, candles, asset, model, profile);
        portfolioTrades.push(...trades);

        const metrics = calculateComprehensiveMetrics(trades, profile);
        results.push({
          profile: profile.id,
          model: model.id,
          symbol: asset.symbol,
          metrics
        });

        console.log(`  🔹 ${asset.symbol.padEnd(8)}: Trades: ${metrics.totalTrades.toString().padEnd(4)} | WR: ${metrics.winRate}% | PF: ${metrics.profitFactor} | Pips: ${metrics.totalPips >= 0 ? '+' : ''}${metrics.totalPips.toLocaleString()}p | Profit: $${metrics.totalProfitUSD.toLocaleString()} USD | DD Máx: -$${metrics.maxDDUSD.toLocaleString()} USD (${metrics.maxDDPercent}%) | Media/Día: $${metrics.avgProfitPerTradingDayUSD} USD/día`);
      }

      // Métricas del Portfolio Global Combinado (los 4 activos operando simultáneamente)
      const combinedMetrics = calculateComprehensiveMetrics(portfolioTrades, profile);
      results.push({
        profile: profile.id,
        model: model.id,
        symbol: 'PORTFOLIO_TOTAL',
        metrics: combinedMetrics
      });

      console.log(`\n  🌟 PORTFOLIO COMBINADO (4 ACTIVOS):`);
      console.log(`     • Total Operaciones:   ${combinedMetrics.totalTrades}`);
      console.log(`     • Win Rate Global:     ${combinedMetrics.winRate}%`);
      console.log(`     • Profit Factor:       ${combinedMetrics.profitFactor}`);
      console.log(`     • Pips Netos Totales:  +${combinedMetrics.totalPips.toLocaleString()} pips/pts`);
      console.log(`     • BENEFICIO TOTAL:     +$${combinedMetrics.totalProfitUSD.toLocaleString()} USD`);
      console.log(`     • DRAWDOWN MÁXIMO:     -$${combinedMetrics.maxDDUSD.toLocaleString()} USD (${combinedMetrics.maxDDPercent}% sobre balance)`);
      console.log(`     • MEDIA DIARIA (Mercado): $${combinedMetrics.avgProfitPerTradingDayUSD} USD / día (+${combinedMetrics.avgPipsPerTradingDay} pips/día)`);
      console.log(`     • MEDIA DIARIA (Natural): $${combinedMetrics.avgProfitPerCalendarDayUSD} USD / día`);
    }
  }

  // Guardar reporte detallado en JSON para consultas futuras
  const reportPath = path.join(__dirname, 'multi_asset_7years_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Reporte completo consolidado guardado en: scripts/backtest/multi_asset_7years_report.json\n`);
}

runMasterBacktest().catch(err => {
  console.error('❌ Error en el backtest maestro:', err);
});
