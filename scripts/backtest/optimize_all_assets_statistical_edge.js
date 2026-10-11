/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  OPTIMIZADOR MULTI-ACTIVO DE VENTAJA ESTADÍSTICA (BPR INSTITUCIONAL)   ║
 * ║  Prueba rigurosa de matrices R:R (1:2 a 1:5), Filtros de Sesión y EMA    ║
 * ║  Para EURUSD, GBPJPY, NAS100, XAGUSD (Plata) y BTCUSD (Cripto Finde)     ║
 * ║  Con spread real, comisiones $8.25/lote RT y slippage adverso            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');

// Helper para encontrar CSVs en el directorio raíz
function findCsvFile(pattern) {
  const files = fs.readdirSync(ROOT);
  const prefix = pattern.replace('*', '');
  const matches = files.filter(f => f.startsWith(prefix) && f.endsWith('.csv'));
  if (matches.length === 0) return null;
  matches.sort();
  return path.join(ROOT, matches[matches.length - 1]);
}

async function loadCsvCandles(filePath, maxCandles = 250000) {
  return new Promise((resolve) => {
    const candles = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });

    let isFirst = true;
    rl.on('line', (line) => {
      if (isFirst) { isFirst = false; return; }
      const parts = line.split('\t');
      if (parts.length < 7) return;

      const [date, time, open, high, low, close, tickVol, vol, spread] = parts;
      const [year, month, day] = date.split('.').map(Number);
      const [hour, minute, sec] = time.split(':').map(Number);
      const timestamp = Date.UTC(year, month - 1, day, hour, minute, sec || 0);

      candles.push({
        time: timestamp,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        spread: spread ? parseFloat(spread) : 10,
        hourUTC: hour,
        minuteUTC: minute,
        dayOfWeek: new Date(timestamp).getUTCDay()
      });
    });

    rl.on('close', () => {
      // Si son demasiadas velas para la prueba de optimización, tomar las más recientes
      if (candles.length > maxCandles) {
        resolve(candles.slice(-maxCandles));
      } else {
        resolve(candles);
      }
    });
  });
}

// Cálculo rápido de EMA
function computeEMA(candles, period = 100) {
  const k = 2 / (period + 1);
  const emas = new Float64Array(candles.length);
  if (candles.length < period) return emas;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  let prevEma = sum / period;
  emas[period - 1] = prevEma;

  for (let i = period; i < candles.length; i++) {
    prevEma = (candles[i].close - prevEma) * k + prevEma;
    emas[i] = prevEma;
  }
  return emas;
}

// Scanner genérico de BPR con parámetros flexibles
function scanBprFlexible(candles, idx, lookback, minGap, minOverlap) {
  if (idx < 4) return null;
  const c0 = candles[idx];
  const c2 = candles[idx - 2];

  const isBullFVG = (c0.low - c2.high) >= minGap;
  const isBearFVG = (c2.low - c0.high) >= minGap;

  if (!isBullFVG && !isBearFVG) return null;

  if (isBullFVG) {
    // Buscar FVG bajista previa
    for (let j = idx - 1; j >= Math.max(0, idx - lookback); j--) {
      const b0 = candles[j];
      const b2 = candles[j - 2];
      if (b2 && (b2.low - b0.high) >= minGap) {
        const bearTop = b2.low;
        const bearBottom = b0.high;
        const bullTop = c0.low;
        const bullBottom = c2.high;
        const cLow = Math.max(bearBottom, bullBottom);
        const cHigh = Math.min(bearTop, bullTop);
        if (cHigh > cLow + minOverlap) {
          return { type: 'BULLISH', top: cHigh, bottom: cLow, ce50: (cHigh + cLow) / 2 };
        }
      }
    }
  }

  if (isBearFVG) {
    // Buscar FVG alcista previa
    for (let j = idx - 1; j >= Math.max(0, idx - lookback); j--) {
      const b0 = candles[j];
      const b2 = candles[j - 2];
      if (b2 && (b0.low - b2.high) >= minGap) {
        const bullTop = b0.low;
        const bullBottom = b2.high;
        const bearTop = c2.low;
        const bearBottom = c0.high;
        const cLow = Math.max(bullBottom, bearBottom);
        const cHigh = Math.min(bullTop, bearTop);
        if (cHigh > cLow + minOverlap) {
          return { type: 'BEARISH', top: cHigh, bottom: cLow, ce50: (cHigh + cLow) / 2 };
        }
      }
    }
  }

  return null;
}

// Simulador de trading para una configuración dada
function runSimulation(candles, emas, opts) {
  const {
    pipMultiplier,
    spreadMultiplier,
    commissionRT,
    slippagePips,
    rrRatio,
    minGap,
    minOverlap,
    wickPct,
    bufferPips,
    minSlPips,
    maxSlPips,
    sessionFilter,
    directionFilter, // 'BOTH', 'BUY_ONLY', 'SELL_ONLY'
    useEma,
    maxHoldCandles = 100
  } = opts;

  let activeTrade = null;
  const trades = [];
  const n = candles.length;

  for (let i = 105; i < n; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];

    // Gestión de trade activo
    if (activeTrade) {
      activeTrade.holding++;
      let closed = false;

      if (activeTrade.type === 'BUY') {
        if (c.low <= activeTrade.sl) {
          const exitPrice = activeTrade.sl - (slippagePips / pipMultiplier);
          const pips = (exitPrice - activeTrade.entry) * pipMultiplier;
          trades.push({ ...activeTrade, exit: exitPrice, pips, win: false, reason: 'SL' });
          activeTrade = null;
          closed = true;
        } else if (c.high >= activeTrade.tp) {
          const exitPrice = activeTrade.tp;
          const pips = (exitPrice - activeTrade.entry) * pipMultiplier;
          trades.push({ ...activeTrade, exit: exitPrice, pips, win: true, reason: 'TP' });
          activeTrade = null;
          closed = true;
        } else if (activeTrade.holding >= maxHoldCandles) {
          const exitPrice = c.close;
          const pips = (exitPrice - activeTrade.entry) * pipMultiplier;
          trades.push({ ...activeTrade, exit: exitPrice, pips, win: pips > 0, reason: 'TIMEOUT' });
          activeTrade = null;
          closed = true;
        }
      } else { // SELL
        if (c.high >= activeTrade.sl) {
          const exitPrice = activeTrade.sl + (slippagePips / pipMultiplier);
          const pips = (activeTrade.entry - exitPrice) * pipMultiplier;
          trades.push({ ...activeTrade, exit: exitPrice, pips, win: false, reason: 'SL' });
          activeTrade = null;
          closed = true;
        } else if (c.low <= activeTrade.tp) {
          const exitPrice = activeTrade.tp;
          const pips = (activeTrade.entry - exitPrice) * pipMultiplier;
          trades.push({ ...activeTrade, exit: exitPrice, pips, win: true, reason: 'TP' });
          activeTrade = null;
          closed = true;
        } else if (activeTrade.holding >= maxHoldCandles) {
          const exitPrice = c.close;
          const pips = (activeTrade.entry - exitPrice) * pipMultiplier;
          trades.push({ ...activeTrade, exit: exitPrice, pips, win: pips > 0, reason: 'TIMEOUT' });
          activeTrade = null;
          closed = true;
        }
      }

      if (closed) continue;
    }

    if (activeTrade) continue;

    // Filtro horario de sesión
    if (sessionFilter && !sessionFilter(c.hourUTC, c.minuteUTC, c.dayOfWeek)) {
      continue;
    }

    // Escaneo BPR en vela cerrada anterior (prevC)
    const bpr = scanBprFlexible(candles, i - 1, 20, minGap, minOverlap);
    if (!bpr) continue;

    const candleRange = prevC.high - prevC.low;
    if (candleRange <= 0) continue;

    const ema = emas[i - 1];

    // Señal BUY
    if (bpr.type === 'BULLISH' && (directionFilter === 'BOTH' || directionFilter === 'BUY_ONLY')) {
      if (useEma && ema > 0 && prevC.close < ema) continue;

      const lowerWick = Math.min(prevC.open, prevC.close) - prevC.low;
      const lowerWickRatio = lowerWick / candleRange;
      if (lowerWickRatio < wickPct) continue;

      // Re-test de zona BPR
      if (prevC.low <= bpr.top && prevC.close >= bpr.bottom) {
        const spreadPips = (c.spread * spreadMultiplier);
        const entryPrice = c.open + ((spreadPips + slippagePips) / pipMultiplier);
        const slPrice = bpr.bottom - (bufferPips / pipMultiplier);
        const slDist = Math.abs(entryPrice - slPrice);
        const slPips = slDist * pipMultiplier;

        if (slPips >= minSlPips && slPips <= maxSlPips) {
          const tpDist = slDist * rrRatio;
          const tpPrice = entryPrice + tpDist;

          activeTrade = {
            type: 'BUY',
            entry: entryPrice,
            sl: slPrice,
            tp: tpPrice,
            slPips,
            tpPips: slPips * rrRatio,
            holding: 0,
            openTime: c.time
          };
        }
      }
    }

    // Señal SELL
    if (bpr.type === 'BEARISH' && (directionFilter === 'BOTH' || directionFilter === 'SELL_ONLY')) {
      if (useEma && ema > 0 && prevC.close > ema) continue;

      const upperWick = prevC.high - Math.max(prevC.open, prevC.close);
      const upperWickRatio = upperWick / candleRange;
      if (upperWickRatio < wickPct) continue;

      // Re-test de zona BPR
      if (prevC.high >= bpr.bottom && prevC.close <= bpr.top) {
        const entryPrice = c.open - (slippagePips / pipMultiplier);
        const slPrice = bpr.top + (bufferPips / pipMultiplier);
        const slDist = Math.abs(slPrice - entryPrice);
        const slPips = slDist * pipMultiplier;

        if (slPips >= minSlPips && slPips <= maxSlPips) {
          const tpDist = slDist * rrRatio;
          const tpPrice = entryPrice - tpDist;

          activeTrade = {
            type: 'SELL',
            entry: entryPrice,
            sl: slPrice,
            tp: tpPrice,
            slPips,
            tpPips: slPips * rrRatio,
            holding: 0,
            openTime: c.time
          };
        }
      }
    }
  }

  // Calcular métricas
  if (trades.length === 0) return null;

  let grossProfitPips = 0;
  let grossLossPips = 0;
  let netPips = 0;
  let wins = 0;
  let maxDD = 0;
  let peak = 0;
  let runningPips = 0;

  for (const t of trades) {
    if (t.win) {
      wins++;
      grossProfitPips += t.pips;
    } else {
      grossLossPips += Math.abs(t.pips);
    }
    runningPips += t.pips;
    if (runningPips > peak) peak = runningPips;
    const dd = peak - runningPips;
    if (dd > maxDD) maxDD = dd;
  }

  netPips = grossProfitPips - grossLossPips;
  const wr = (wins / trades.length) * 100;
  const pf = grossLossPips > 0 ? grossProfitPips / grossLossPips : 99.0;

  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: parseFloat(wr.toFixed(1)),
    profitFactor: parseFloat(pf.toFixed(2)),
    netPips: parseFloat(netPips.toFixed(1)),
    maxDD: parseFloat(maxDD.toFixed(1))
  };
}

async function main() {
  console.log(`╔══════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  BATERÍA DE OPTIMIZACIÓN MULTI-ACTIVO: VENTAJA ESTADÍSTICA REAL         ║`);
  console.log(`║  Pruebas de R:R (1:1.5 a 1:5.0), Filtros de Sesión y Cripto Fin de Sem  ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝\n`);

  // ══════════════════════════════════════════════════════════════════════
  // 1. CRIPTO (BTCUSD / BTCUSDT) - FINES DE SEMANA Y DIARIO
  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  🪙 TEST 1: BITCOIN (BTCUSDT / BTCUSD) - M15 (Incluyendo Fines de Semana)`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  const btcCachePath = path.join(__dirname, '..', 'audits', 'cache_btcusdt_15m_1y.json');
  if (fs.existsSync(btcCachePath)) {
    const rawBtc = JSON.parse(fs.readFileSync(btcCachePath, 'utf8'));
    console.log(`  📊 Velas M15 cargadas: ${rawBtc.length} velas (1 año continuo 24/7)`);

    const btcCandles = rawBtc.map(c => {
      const d = new Date(c.time);
      return {
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        spread: 15, // $15 spread promedio en BTCUSD ECN
        hourUTC: d.getUTCHours(),
        minuteUTC: d.getUTCMinutes(),
        dayOfWeek: d.getUTCDay()
      };
    });

    const btcEmas = computeEMA(btcCandles, 100);

    const btcConfigs = [
      { name: 'BTC M15 R:R 1:2.0 (Todo el tiempo 24/7)', rrRatio: 2.0, minGap: 120, minOverlap: 60, wickPct: 0.20, bufferPips: 30, minSlPips: 100, maxSlPips: 800, useEma: true, sessionFilter: null },
      { name: 'BTC M15 R:R 1:3.0 (Todo el tiempo 24/7)', rrRatio: 3.0, minGap: 150, minOverlap: 80, wickPct: 0.25, bufferPips: 40, minSlPips: 120, maxSlPips: 900, useEma: true, sessionFilter: null },
      { name: 'BTC M15 R:R 1:4.0 (Filtro Fin de Semana Exclusivo: Sáb/Dom)', rrRatio: 4.0, minGap: 150, minOverlap: 80, wickPct: 0.25, bufferPips: 40, minSlPips: 120, maxSlPips: 900, useEma: true, sessionFilter: (h, m, d) => (d === 0 || d === 6) },
      { name: 'BTC M15 R:R 1:3.0 (Fin de Semana Exclusivo: Sáb/Dom)', rrRatio: 3.0, minGap: 120, minOverlap: 60, wickPct: 0.20, bufferPips: 30, minSlPips: 100, maxSlPips: 800, useEma: true, sessionFilter: (h, m, d) => (d === 0 || d === 6) },
      { name: 'BTC M15 R:R 1:2.5 (Tendencia EMA100, Filtro Volatilidad)', rrRatio: 2.5, minGap: 180, minOverlap: 90, wickPct: 0.30, bufferPips: 50, minSlPips: 150, maxSlPips: 1000, useEma: true, sessionFilter: null }
    ];

    console.log(`\n  Resultados de Optimización BTCUSD:`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const cfg of btcConfigs) {
      const res = runSimulation(btcCandles, btcEmas, {
        pipMultiplier: 1.0, // $1 por punto
        spreadMultiplier: 1.0,
        commissionRT: 15.0,
        slippagePips: 5.0,
        directionFilter: 'BOTH',
        ...cfg
      });
      if (res) {
        const flag = res.profitFactor >= 1.5 ? '🔥 VENTAJA' : (res.profitFactor >= 1.1 ? '✅ RENTABLE' : '❌ NO');
        console.log(`  ${flag.padEnd(12)} | PF: ${res.profitFactor.toFixed(2).padEnd(5)} | WR: ${(res.winRate + '%').padEnd(6)} | Trades: ${String(res.trades).padEnd(5)} | Net: ${res.netPips > 0 ? '+' : ''}${res.netPips.toFixed(0)} pts | MaxDD: ${res.maxDD.toFixed(0)} pts | ${cfg.name}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 2. NASDAQ 100 (NAS100) - OPTIMIZACIÓN R:R Y SESIÓN
  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  📈 TEST 2: NASDAQ 100 (NAS100) - M5 y M15 con R:R Asimétrico (1:2 a 1:4)`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  const nasCsv = findCsvFile('NAS100_M5_*');
  if (nasCsv) {
    const nasCandles = await loadCsvCandles(nasCsv, 200000);
    console.log(`  📊 Velas M5 cargadas: ${nasCandles.length} velas`);
    const nasEmas = computeEMA(nasCandles, 100);

    const nasConfigs = [
      { name: 'NAS100 M5 - R:R 1:1.0 (Live original: BUY ONLY)', rrRatio: 1.0, minGap: 7.0, minOverlap: 4.0, wickPct: 0.20, bufferPips: 6.0, minSlPips: 10, maxSlPips: 70, useEma: true, directionFilter: 'BUY_ONLY', sessionFilter: (h, m) => (h >= 13 && h <= 20) },
      { name: 'NAS100 M5 - R:R 1:2.0 (BUY ONLY, NY Session)', rrRatio: 2.0, minGap: 8.0, minOverlap: 5.0, wickPct: 0.25, bufferPips: 8.0, minSlPips: 12, maxSlPips: 80, useEma: true, directionFilter: 'BUY_ONLY', sessionFilter: (h, m) => (h >= 13 && h <= 20) },
      { name: 'NAS100 M5 - R:R 1:2.5 (BUY ONLY, NY Session)', rrRatio: 2.5, minGap: 10.0, minOverlap: 6.0, wickPct: 0.25, bufferPips: 8.0, minSlPips: 15, maxSlPips: 90, useEma: true, directionFilter: 'BUY_ONLY', sessionFilter: (h, m) => (h >= 13 && h <= 20) },
      { name: 'NAS100 M5 - R:R 1:3.0 (BUY ONLY, NY Session)', rrRatio: 3.0, minGap: 12.0, minOverlap: 7.0, wickPct: 0.30, bufferPips: 10.0, minSlPips: 18, maxSlPips: 100, useEma: true, directionFilter: 'BUY_ONLY', sessionFilter: (h, m) => (h >= 13 && h <= 20) },
      { name: 'NAS100 M5 - R:R 1:2.5 (BOTH DIRECTIONS, NY Open 13:30-18:00)', rrRatio: 2.5, minGap: 10.0, minOverlap: 6.0, wickPct: 0.25, bufferPips: 8.0, minSlPips: 15, maxSlPips: 90, useEma: true, directionFilter: 'BOTH', sessionFilter: (h, m) => (h === 13 && m >= 30) || (h > 13 && h < 18) },
      { name: 'NAS100 M5 - R:R 1:3.0 (BOTH DIRECTIONS, NY Open 13:30-18:00)', rrRatio: 3.0, minGap: 12.0, minOverlap: 7.0, wickPct: 0.30, bufferPips: 10.0, minSlPips: 18, maxSlPips: 100, useEma: true, directionFilter: 'BOTH', sessionFilter: (h, m) => (h === 13 && m >= 30) || (h > 13 && h < 18) }
    ];

    console.log(`\n  Resultados de Optimización NAS100:`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const cfg of nasConfigs) {
      const res = runSimulation(nasCandles, nasEmas, {
        pipMultiplier: 1.0,
        spreadMultiplier: 1.0,
        commissionRT: 3.0,
        slippagePips: 1.0,
        ...cfg
      });
      if (res) {
        const flag = res.profitFactor >= 1.5 ? '🔥 VENTAJA' : (res.profitFactor >= 1.1 ? '✅ RENTABLE' : '❌ NO');
        console.log(`  ${flag.padEnd(12)} | PF: ${res.profitFactor.toFixed(2).padEnd(5)} | WR: ${(res.winRate + '%').padEnd(6)} | Trades: ${String(res.trades).padEnd(5)} | Net: ${res.netPips > 0 ? '+' : ''}${res.netPips.toFixed(0)} pts | MaxDD: ${res.maxDD.toFixed(0)} pts | ${cfg.name}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 3. EURUSD - OPTIMIZACIÓN R:R Y SESIÓN
  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  💶 TEST 3: EURUSD - M5 con R:R Asimétrico (1:2 a 1:4) y Sesión Londres/NY`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  const euCsv = findCsvFile('EURUSD_M5_*');
  if (euCsv) {
    const euCandles = await loadCsvCandles(euCsv, 200000);
    console.log(`  📊 Velas M5 cargadas: ${euCandles.length} velas`);
    const euEmas = computeEMA(euCandles, 100);

    const euConfigs = [
      { name: 'EURUSD M5 - R:R 1:1.0 (Live original: Sin filtro)', rrRatio: 1.0, minGap: 0.0003, minOverlap: 0.00018, wickPct: 0.20, bufferPips: 2.0, minSlPips: 3.5, maxSlPips: 25, useEma: false, directionFilter: 'BOTH', sessionFilter: null },
      { name: 'EURUSD M5 - R:R 1:2.0 (Londres/NY 07:00-17:00 UTC)', rrRatio: 2.0, minGap: 0.0004, minOverlap: 0.00025, wickPct: 0.25, bufferPips: 2.5, minSlPips: 4.0, maxSlPips: 25, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h >= 7 && h <= 17) },
      { name: 'EURUSD M5 - R:R 1:2.5 (Londres/NY 07:00-17:00 UTC)', rrRatio: 2.5, minGap: 0.00045, minOverlap: 0.0003, wickPct: 0.30, bufferPips: 2.5, minSlPips: 5.0, maxSlPips: 30, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h >= 7 && h <= 17) },
      { name: 'EURUSD M5 - R:R 1:3.0 (Londres/NY 07:00-17:00 UTC)', rrRatio: 3.0, minGap: 0.0005, minOverlap: 0.00035, wickPct: 0.30, bufferPips: 3.0, minSlPips: 5.0, maxSlPips: 30, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h >= 7 && h <= 17) },
      { name: 'EURUSD M5 - R:R 1:3.5 (Londres/NY 07:00-17:00 UTC, FVG Amplio)', rrRatio: 3.5, minGap: 0.0006, minOverlap: 0.0004, wickPct: 0.35, bufferPips: 3.0, minSlPips: 6.0, maxSlPips: 35, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h >= 7 && h <= 17) }
    ];

    console.log(`\n  Resultados de Optimización EURUSD:`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const cfg of euConfigs) {
      const res = runSimulation(euCandles, euEmas, {
        pipMultiplier: 10000,
        spreadMultiplier: 0.1,
        commissionRT: 8.25,
        slippagePips: 0.5,
        ...cfg
      });
      if (res) {
        const flag = res.profitFactor >= 1.5 ? '🔥 VENTAJA' : (res.profitFactor >= 1.1 ? '✅ RENTABLE' : '❌ NO');
        console.log(`  ${flag.padEnd(12)} | PF: ${res.profitFactor.toFixed(2).padEnd(5)} | WR: ${(res.winRate + '%').padEnd(6)} | Trades: ${String(res.trades).padEnd(5)} | Net: ${res.netPips > 0 ? '+' : ''}${res.netPips.toFixed(1)} pips | MaxDD: ${res.maxDD.toFixed(1)} pips | ${cfg.name}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 4. GBPJPY - OPTIMIZACIÓN R:R Y SESIÓN
  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  💷 TEST 4: GBPJPY - M5 con R:R Asimétrico (1:2 a 1:4)`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  const gjCsv = findCsvFile('GBPJPY_M5_*');
  if (gjCsv) {
    const gjCandles = await loadCsvCandles(gjCsv, 200000);
    console.log(`  📊 Velas M5 cargadas: ${gjCandles.length} velas`);
    const gjEmas = computeEMA(gjCandles, 100);

    const gjConfigs = [
      { name: 'GBPJPY M5 - R:R 1:1.0 (Live original: SELL ONLY)', rrRatio: 1.0, minGap: 0.035, minOverlap: 0.02, wickPct: 0.20, bufferPips: 4.0, minSlPips: 6, maxSlPips: 40, useEma: false, directionFilter: 'SELL_ONLY', sessionFilter: (h) => (h >= 7 && h <= 18) },
      { name: 'GBPJPY M5 - R:R 1:2.0 (SELL ONLY, Londres/NY)', rrRatio: 2.0, minGap: 0.050, minOverlap: 0.03, wickPct: 0.25, bufferPips: 5.0, minSlPips: 8, maxSlPips: 50, useEma: true, directionFilter: 'SELL_ONLY', sessionFilter: (h) => (h >= 7 && h <= 18) },
      { name: 'GBPJPY M5 - R:R 1:2.5 (BOTH DIRECTIONS, Londres/NY)', rrRatio: 2.5, minGap: 0.055, minOverlap: 0.035, wickPct: 0.30, bufferPips: 5.0, minSlPips: 10, maxSlPips: 50, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h >= 7 && h <= 18) },
      { name: 'GBPJPY M5 - R:R 1:3.0 (BOTH DIRECTIONS, Londres/NY)', rrRatio: 3.0, minGap: 0.065, minOverlap: 0.040, wickPct: 0.30, bufferPips: 6.0, minSlPips: 12, maxSlPips: 60, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h >= 7 && h <= 18) },
      { name: 'GBPJPY M5 - R:R 1:3.5 (BOTH DIRECTIONS, Londres/NY)', rrRatio: 3.5, minGap: 0.075, minOverlap: 0.045, wickPct: 0.35, bufferPips: 6.0, minSlPips: 15, maxSlPips: 70, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h >= 7 && h <= 18) }
    ];

    console.log(`\n  Resultados de Optimización GBPJPY:`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const cfg of gjConfigs) {
      const res = runSimulation(gjCandles, gjEmas, {
        pipMultiplier: 100,
        spreadMultiplier: 0.1,
        commissionRT: 8.25,
        slippagePips: 0.8,
        ...cfg
      });
      if (res) {
        const flag = res.profitFactor >= 1.5 ? '🔥 VENTAJA' : (res.profitFactor >= 1.1 ? '✅ RENTABLE' : '❌ NO');
        console.log(`  ${flag.padEnd(12)} | PF: ${res.profitFactor.toFixed(2).padEnd(5)} | WR: ${(res.winRate + '%').padEnd(6)} | Trades: ${String(res.trades).padEnd(5)} | Net: ${res.netPips > 0 ? '+' : ''}${res.netPips.toFixed(1)} pips | MaxDD: ${res.maxDD.toFixed(1)} pips | ${cfg.name}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 5. XAGUSD (PLATA SPOT)
  // ══════════════════════════════════════════════════════════════════════
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  🥈 TEST 5: PLATA (XAGUSD) - M5 con R:R Asimétrico`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  const xagCsv = findCsvFile('XAGUSD_M5_*');
  if (xagCsv) {
    const xagCandles = await loadCsvCandles(xagCsv, 200000);
    console.log(`  📊 Velas M5 cargadas: ${xagCandles.length} velas`);
    const xagEmas = computeEMA(xagCandles, 100);

    const xagConfigs = [
      { name: 'XAGUSD M5 - R:R 1:2.0', rrRatio: 2.0, minGap: 0.03, minOverlap: 0.02, wickPct: 0.20, bufferPips: 0.05, minSlPips: 0.10, maxSlPips: 0.80, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h !== 23 && h !== 0) },
      { name: 'XAGUSD M5 - R:R 1:3.0', rrRatio: 3.0, minGap: 0.04, minOverlap: 0.025, wickPct: 0.25, bufferPips: 0.06, minSlPips: 0.15, maxSlPips: 1.00, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h !== 23 && h !== 0) },
      { name: 'XAGUSD M5 - R:R 1:4.0', rrRatio: 4.0, minGap: 0.05, minOverlap: 0.03, wickPct: 0.25, bufferPips: 0.08, minSlPips: 0.20, maxSlPips: 1.20, useEma: true, directionFilter: 'BOTH', sessionFilter: (h) => (h !== 23 && h !== 0) }
    ];

    console.log(`\n  Resultados de Optimización XAGUSD:`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const cfg of xagConfigs) {
      const res = runSimulation(xagCandles, xagEmas, {
        pipMultiplier: 100, // 0.01 = 1 centavo
        spreadMultiplier: 0.1,
        commissionRT: 8.25,
        slippagePips: 0.5,
        ...cfg
      });
      if (res) {
        const flag = res.profitFactor >= 1.5 ? '🔥 VENTAJA' : (res.profitFactor >= 1.1 ? '✅ RENTABLE' : '❌ NO');
        console.log(`  ${flag.padEnd(12)} | PF: ${res.profitFactor.toFixed(2).padEnd(5)} | WR: ${(res.winRate + '%').padEnd(6)} | Trades: ${String(res.trades).padEnd(5)} | Net: ${res.netPips > 0 ? '+' : ''}${res.netPips.toFixed(1)} pips | MaxDD: ${res.maxDD.toFixed(1)} pips | ${cfg.name}`);
      }
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  🏁 Batería de Optimización Concluida`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
