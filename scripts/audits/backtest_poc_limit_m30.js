/**
 * Auditoría Cuantitativa y Backtesting en M30:
 * Estrategia de Orden Límite en el PoC (Point of Control)
 * 
 * Reglas solicitadas por el usuario:
 * - Temporalidad: 30 minutos (M30)
 * - Rango de Sesión: Sesión Asiática (00:00 - 07:00 UTC) genera el Perfil de Volumen (POC, VAH, VAL).
 * - Orden Pendiente:
 *   • BUY LIMIT en el POC con SL en VAL (con aire / buffer) y TP en VAH.
 *   • SELL LIMIT en el POC con SL en VAH (con aire) y TP en VAL.
 * - Variaciones auditadas:
 *   1. Configuración Pura del Usuario (con diferentes niveles de aire: $1.50, $2.00, $2.50).
 *   2. Con Filtro de Tendencia Institucional (EMA 100 M30).
 *   3. Con Ratio R:R Optimizado (Extensión de TP más allá de VAH/VAL a 1:1.3 / 1:1.5).
 */

const https = require('https');
const { VolumeProfileStrategy } = require('../../core/algorithms/VolumeProfileStrategy');

function fetchM30Klines(startTime, endTime, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=30m&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          if (!Array.isArray(raw)) return resolve([]);
          const candles = raw.map(c => ({
            time: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
          }));
          resolve(candles);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function fetch6MonthsM30() {
  const now = Date.now();
  const sixMonthsAgo = now - (180 * 24 * 60 * 60 * 1000);
  let allCandles = [];
  let currentStart = sixMonthsAgo;

  while (currentStart < now) {
    const chunk = await fetchM30Klines(currentStart, now, 1000);
    if (!chunk || chunk.length === 0) break;
    allCandles.push(...chunk);
    currentStart = chunk[chunk.length - 1].time + (30 * 60 * 1000);
    if (chunk.length < 1000) break;
    await new Promise(r => setTimeout(r, 60));
  }
  return allCandles;
}

function calculateEMA(candles, period = 100) {
  const ema = new Float64Array(candles.length);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, candles.length); i++) sum += candles[i].close;
  let prevEma = sum / Math.min(period, candles.length);
  ema[Math.min(period, candles.length) - 1] = prevEma;
  for (let i = period; i < candles.length; i++) {
    prevEma = (candles[i].close - prevEma) * k + prevEma;
    ema[i] = prevEma;
  }
  return ema;
}

function simulateStrategy(candles, options = {}) {
  const {
    slAir = 2.0,
    useAutoBE = false,
    useTrendFilter = false,
    tpMultiplier = 1.0, // 1.0 = TP en VAH/VAL exacto; 1.3 = extensión
    emaPeriod = 100
  } = options;

  const strategy = new VolumeProfileStrategy({ binSize: 0.50, valueAreaRatio: 0.70 });
  const emaValues = useTrendFilter ? calculateEMA(candles, emaPeriod) : null;

  let balance = 5000.0;
  const initialBalance = balance;
  const riskPercent = 0.75; // 0.75% por trade ($37.50 en 5k)

  let peakBalance = balance;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  let totalLimitPlaced = 0;
  let totalLimitFilled = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalBreakevens = 0;
  let totalGrossProfit = 0;
  let totalGrossLoss = 0;

  const monthlyResults = {};

  const days = {};
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dayStr = new Date(c.time).toISOString().split('T')[0];
    if (!days[dayStr]) days[dayStr] = [];
    days[dayStr].push({ ...c, index: i });
  }

  for (const [dayStr, dayCandles] of Object.entries(days)) {
    const asianCandles = dayCandles.filter(c => {
      const h = new Date(c.time).getUTCHours();
      return h >= 0 && h < 7;
    });

    if (asianCandles.length < 6) continue;

    const profile = strategy.calculateProfile(asianCandles);
    if (!profile) continue;

    const { poc, vah, val } = profile;
    const valueAreaSpan = vah - val;
    if (valueAreaSpan < 3.0) continue;

    const londonOpenCandle = dayCandles.find(c => new Date(c.time).getUTCHours() === 7);
    if (!londonOpenCandle) continue;

    let orderType = null;
    let limitPrice = poc;
    let slPrice = 0;
    let tpPrice = 0;

    const currentEma = emaValues ? emaValues[londonOpenCandle.index] : 0;

    if (londonOpenCandle.close >= poc) {
      // Intención Compradora
      if (useTrendFilter && londonOpenCandle.close < currentEma) continue; // Filtrar contra-tendencia

      orderType = 'BUY_LIMIT';
      slPrice = parseFloat((val - slAir).toFixed(2));
      const baseTpDist = vah - poc;
      tpPrice = parseFloat((poc + baseTpDist * tpMultiplier).toFixed(2));
    } else {
      // Intención Vendedora
      if (useTrendFilter && londonOpenCandle.close > currentEma) continue;

      orderType = 'SELL_LIMIT';
      slPrice = parseFloat((vah + slAir).toFixed(2));
      const baseTpDist = poc - val;
      tpPrice = parseFloat((poc - baseTpDist * tpMultiplier).toFixed(2));
    }

    const slDistance = Math.abs(limitPrice - slPrice);
    const tpDistance = Math.abs(tpPrice - limitPrice);
    if (slDistance <= 0 || tpDistance <= 0) continue;
    if (options.minRR && (tpDistance / slDistance) < options.minRR) continue;

    totalLimitPlaced++;

    const localStartIdx = dayCandles.findIndex(c => c.index === londonOpenCandle.index);
    if (localStartIdx < 0) continue;

    let filled = false;
    let fillIndex = -1;

    for (let j = localStartIdx + 1; j < dayCandles.length; j++) {
      const c = dayCandles[j];
      const h = new Date(c.time).getUTCHours();
      if (h >= 21) break;

      if (orderType === 'BUY_LIMIT' && c.low <= limitPrice) {
        filled = true;
        fillIndex = c.index;
        break;
      } else if (orderType === 'SELL_LIMIT' && c.high >= limitPrice) {
        filled = true;
        fillIndex = c.index;
        break;
      }
    }

    if (!filled) continue;
    totalLimitFilled++;

    const riskUSD = (balance * riskPercent) / 100.0;
    const lotSize = riskUSD / (slDistance * 100.0);

    let tradeOutcome = 'PENDING';
    let profitUSD = 0;
    let beActivated = false;
    const halfTP = limitPrice + (orderType === 'BUY_LIMIT' ? tpDistance * 0.5 : -tpDistance * 0.5);

    for (let k = fillIndex + 1; k < Math.min(candles.length, fillIndex + 48); k++) {
      const c = candles[k];

      if (orderType === 'BUY_LIMIT') {
        if (useAutoBE && !beActivated && c.high >= halfTP) {
          beActivated = true;
        }

        if (c.high >= tpPrice) {
          tradeOutcome = 'WIN';
          profitUSD = tpDistance * 100.0 * lotSize;
          break;
        }

        const currentSL = beActivated ? limitPrice : slPrice;
        if (c.low <= currentSL) {
          tradeOutcome = beActivated ? 'BE' : 'LOSS';
          profitUSD = beActivated ? 0 : -riskUSD;
          break;
        }
      } else {
        if (useAutoBE && !beActivated && c.low <= halfTP) {
          beActivated = true;
        }

        if (c.low <= tpPrice) {
          tradeOutcome = 'WIN';
          profitUSD = tpDistance * 100.0 * lotSize;
          break;
        }

        const currentSL = beActivated ? limitPrice : slPrice;
        if (c.high >= currentSL) {
          tradeOutcome = beActivated ? 'BE' : 'LOSS';
          profitUSD = beActivated ? 0 : -riskUSD;
          break;
        }
      }
    }

    if (tradeOutcome === 'PENDING') {
      tradeOutcome = beActivated ? 'BE' : 'LOSS';
      profitUSD = beActivated ? 0 : -riskUSD;
    }

    if (tradeOutcome === 'WIN') {
      totalWins++;
      totalGrossProfit += profitUSD;
    } else if (tradeOutcome === 'BE') {
      totalBreakevens++;
    } else {
      totalLosses++;
      totalGrossLoss += Math.abs(profitUSD);
    }

    balance += profitUSD;
    if (balance > peakBalance) peakBalance = balance;
    const currentDD = peakBalance - balance;
    const currentDDPct = (currentDD / peakBalance) * 100.0;
    if (currentDD > maxDrawdownUSD) maxDrawdownUSD = currentDD;
    if (currentDDPct > maxDrawdownPct) maxDrawdownPct = currentDDPct;

    const monthKey = dayStr.slice(0, 7);
    if (!monthlyResults[monthKey]) {
      monthlyResults[monthKey] = { trades: 0, wins: 0, losses: 0, be: 0, pnl: 0 };
    }
    monthlyResults[monthKey].trades++;
    if (tradeOutcome === 'WIN') monthlyResults[monthKey].wins++;
    else if (tradeOutcome === 'BE') monthlyResults[monthKey].be++;
    else monthlyResults[monthKey].losses++;
    monthlyResults[monthKey].pnl += profitUSD;
  }

  const resolvedTrades = totalWins + totalLosses;
  const winRate = resolvedTrades > 0 ? ((totalWins / resolvedTrades) * 100).toFixed(1) : 0;
  const netProfitUSD = balance - initialBalance;
  const netProfitPct = ((netProfitUSD / initialBalance) * 100).toFixed(2);
  const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'Inf';

  return {
    options,
    totalLimitPlaced,
    totalLimitFilled,
    fillRate: totalLimitPlaced > 0 ? ((totalLimitFilled / totalLimitPlaced) * 100).toFixed(1) : 0,
    totalWins,
    totalLosses,
    totalBreakevens,
    winRate,
    netProfitUSD,
    netProfitPct,
    profitFactor,
    maxDrawdownUSD,
    maxDrawdownPct,
    balance,
    monthlyResults
  };
}

async function main() {
  console.log('\n========================================================================================================');
  console.log('🏛️  ESTUDIO CUANTITATIVO EN M30 (6 MESES / 180 DÍAS DE ORO REAL)');
  console.log('    BUY/SELL LIMIT EN EL POC | SL EN VAL/VAH (+ AIRE) | TP EN VAH/VAL');
  console.log('========================================================================================================\n');

  const candles = await fetch6MonthsM30();

  const scenarios = [
    {
      label: '1. Modelo Puro Usuario (Aire: $1.50 / 15 pips)',
      opts: { slAir: 1.5, useAutoBE: false, useTrendFilter: false, tpMultiplier: 1.0 }
    },
    {
      label: '2. Modelo Puro Usuario (Aire: $2.00 / 20 pips)',
      opts: { slAir: 2.0, useAutoBE: false, useTrendFilter: false, tpMultiplier: 1.0 }
    },
    {
      label: '3. Modelo Puro con Filtro Asimetría R:R >= 1.0 (Aire $2)',
      opts: { slAir: 2.0, useAutoBE: false, useTrendFilter: false, tpMultiplier: 1.0, minRR: 1.0 }
    },
    {
      label: '4. Con Filtro de Tendencia EMA 100 M30 (Aire $2)',
      opts: { slAir: 2.0, useAutoBE: false, useTrendFilter: true, tpMultiplier: 1.0, emaPeriod: 100 }
    },
    {
      label: '5. Tendencia EMA 100 + Filtro Asimetría R:R >= 1.0 (Aire $2)',
      opts: { slAir: 2.0, useAutoBE: false, useTrendFilter: true, tpMultiplier: 1.0, minRR: 1.0, emaPeriod: 100 }
    },
    {
      label: '6. Tendencia EMA 100 + Filtro Asimetría + TP 1.3x + Auto-BE',
      opts: { slAir: 2.0, useAutoBE: true, useTrendFilter: true, tpMultiplier: 1.3, minRR: 1.0, emaPeriod: 100 }
    },
    {
      label: '7. Tendencia EMA 100 + TP 1.4x + Auto-BE (Sin filtro RR)',
      opts: { slAir: 2.0, useAutoBE: true, useTrendFilter: true, tpMultiplier: 1.4, emaPeriod: 100 }
    }
  ];

  console.log('| Configuración | Límites | Ejecutados | Tasa Llenado | Wins | Loss | BE | Win Rate | PnL Neto ($) | PnL (%) | Max DD (%) | Profit Factor |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');

  for (const s of scenarios) {
    const res = simulateStrategy(candles, s.opts);
    const sign = res.netProfitUSD >= 0 ? '+' : '';
    console.log(`| ${s.label.padEnd(55)} | ${res.totalLimitPlaced} | ${res.totalLimitFilled} | ${res.fillRate}% | ${res.totalWins} | ${res.totalLosses} | ${res.totalBreakevens} | ${res.winRate}% | ${sign}$${res.netProfitUSD.toFixed(2)} | ${sign}${res.netProfitPct}% | ${res.maxDrawdownPct.toFixed(2)}% | ${res.profitFactor} |`);
  }

  console.log('\n========================================================================================================\n');
}

main().catch(console.error);
