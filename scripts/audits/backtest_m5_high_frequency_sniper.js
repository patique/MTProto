/**
 * Auditoría Cuantitativa: Estrategias Sniper de Alta Frecuencia M5 (5 Minutos) para Cuentas de Fondeo (10K)
 * 
 * Objetivo:
 * - Frecuencia: 1 a 3 operaciones por día (250 a 600+ operaciones al año).
 * - Win Rate objetivo: 75% a 85%+ (tolerando R:R asimétrico negativo ej. TP 10-12p / SL 15-20p).
 * - Control de Riesgo Prop Firm: Drawdown Máximo Diario < 2.5% y Total < 4.0%.
 * - Velocidad de pase: Pasar la Fase 1 (+10% / +$1,000 USD) en semanas.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache_paxg_5m_1y.json');

function fetchKlines(interval, startTime, endTime, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
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

async function loadOrFetchM5Candles() {
  if (fs.existsSync(CACHE_FILE)) {
    console.log(`📦 Cargando velas M5 desde caché local (${CACHE_FILE})...`);
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log(`✅ ${data.length} velas M5 cargadas exitosamente.`);
    return data;
  }

  console.log(`🌐 Descargando 1 Año Completo de velas M5 de Oro (PAXGUSDT) desde Binance (~105,000 velas)...`);
  const now = Date.now();
  const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
  const stepMs = 1000 * 5 * 60 * 1000; // 1000 velas de 5m = 5,000 minutos
  let allCandles = [];
  let currentStart = oneYearAgo;

  while (currentStart < now) {
    const currentEnd = Math.min(currentStart + stepMs, now);
    try {
      const batch = await fetchKlines('5m', currentStart, currentEnd, 1000);
      if (batch.length === 0) break;
      allCandles.push(...batch);
      process.stdout.write(`\r   ⏳ Descargadas ${allCandles.length} velas M5 (${new Date(batch[batch.length - 1].time).toISOString().slice(0, 10)})...`);
      currentStart = batch[batch.length - 1].time + (5 * 60 * 1000);
      await new Promise(r => setTimeout(r, 80));
    } catch (err) {
      console.error('\nError descargando batch:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\n✅ Descarga completada: ${allCandles.length} velas M5 obtenidas.`);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(allCandles));
  console.log(`💾 Guardado en caché local: ${CACHE_FILE}`);
  return allCandles;
}

// Indicadores
function calculateRSI(candles, period = 7) {
  const rsi = new Float64Array(candles.length);
  if (candles.length <= period) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) rsi[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      rsi[i] = 100 - (100 / (1 + rs));
    }
  }

  return rsi;
}

function calculateStochRSI(rsi, period = 14, smoothK = 3) {
  const stochK = new Float64Array(rsi.length);
  const rawStoch = new Float64Array(rsi.length);

  for (let i = period - 1; i < rsi.length; i++) {
    let minRsi = Infinity;
    let maxRsi = -Infinity;
    for (let j = 0; j < period; j++) {
      const val = rsi[i - j];
      if (val < minRsi) minRsi = val;
      if (val > maxRsi) maxRsi = val;
    }
    const denom = maxRsi - minRsi;
    rawStoch[i] = denom === 0 ? 50 : ((rsi[i] - minRsi) / denom) * 100;
  }

  // Smooth K
  for (let i = period - 1 + smoothK - 1; i < rsi.length; i++) {
    let sum = 0;
    for (let j = 0; j < smoothK; j++) {
      sum += rawStoch[i - j];
    }
    stochK[i] = sum / smoothK;
  }

  return stochK;
}

function calculateBollingerBands(candles, period = 20, multiplier = 2.0) {
  const upper = new Float64Array(candles.length);
  const lower = new Float64Array(candles.length);
  const middle = new Float64Array(candles.length);

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    const sma = sum / period;
    middle[i] = sma;

    let varianceSum = 0;
    for (let j = 0; j < period; j++) {
      const d = candles[i - j].close - sma;
      varianceSum += d * d;
    }
    const stdDev = Math.sqrt(varianceSum / period);
    upper[i] = sma + (stdDev * multiplier);
    lower[i] = sma - (stdDev * multiplier);
  }

  return { upper, lower, middle };
}

function calculateEMA(candles, period = 50) {
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

function calculateATR(candles, period = 14) {
  const atr = new Float64Array(candles.length);
  if (candles.length < 2) return atr;

  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trSum += tr;
  }
  atr[period] = trSum / period;

  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}

/**
 * Motor de Simulación Cuantitativa
 */
function runM5SniperBacktest(candles, options = {}) {
  const {
    modelType = 'RSI_BB', // 'RSI_BB', 'STOCH_EMA', 'LIQUIDITY_SWEEP', 'FAST_MEAN_REV'
    rsiPeriod = 5,
    rsiOversold = 15,
    rsiOverbought = 85,
    bbPeriod = 20,
    bbMult = 2.2,
    emaPeriod = 50,
    tpPips = 12.0, // 12 pips en Oro = $1.20 USD
    slPips = 16.0, // 16 pips en Oro = $1.60 USD (R:R 1:0.75)
    riskPercent = 0.50, // 0.50% por operación ($50 USD en cuenta de 10k)
    maxDailyTrades = 3, // Máximo 3 trades por día para control de DD
    sessionFilter = true, // Operar solo entre 07:00 UTC y 18:00 UTC (Londres + NY)
    slippageSpread = 0.25 // $0.25 USD de spread/comisión (2.5 pips)
  } = options;

  const rsi = calculateRSI(candles, rsiPeriod);
  const stochRSI = modelType === 'STOCH_EMA' ? calculateStochRSI(calculateRSI(candles, 14), 14, 3) : null;
  const { upper, lower, middle } = calculateBollingerBands(candles, bbPeriod, bbMult);
  const ema = calculateEMA(candles, emaPeriod);

  const initialBalance = 10000.0;
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  // Seguimiento de DD diario
  let currentDayStr = '';
  let dayStartBalance = initialBalance;
  let maxDailyDDPct = 0;
  let dailyTradesCount = 0;

  const trades = [];
  let inTrade = null;
  let passPhase1TradeIndex = null;

  const startIndex = Math.max(emaPeriod, bbPeriod, 50);

  for (let i = startIndex; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];
    const dateObj = new Date(c.time);
    const dayStr = dateObj.toISOString().slice(0, 10);
    const hour = dateObj.getUTCHours();

    // Cambio de día
    if (dayStr !== currentDayStr) {
      currentDayStr = dayStr;
      dayStartBalance = balance;
      dailyTradesCount = 0;
    }

    // Comprobar si hay trade activo
    if (inTrade) {
      let isClosed = false;
      let exitPrice = 0;
      let result = '';

      if (inTrade.type === 'BUY') {
        if (c.low <= inTrade.sl) {
          exitPrice = inTrade.sl;
          result = 'LOSS';
          isClosed = true;
        } else if (c.high >= inTrade.tp) {
          exitPrice = inTrade.tp;
          result = 'WIN';
          isClosed = true;
        }
      } else if (inTrade.type === 'SELL') {
        if (c.high >= inTrade.sl) {
          exitPrice = inTrade.sl;
          result = 'LOSS';
          isClosed = true;
        } else if (c.low <= inTrade.tp) {
          exitPrice = inTrade.tp;
          result = 'WIN';
          isClosed = true;
        }
      }

      if (isClosed) {
        const priceDiff = inTrade.type === 'BUY' ? (exitPrice - inTrade.entry) : (inTrade.entry - exitPrice);
        const pnlUSD = (priceDiff * inTrade.lotSize * 100); // 1 lote de oro = 100 oz

        balance += pnlUSD;
        if (balance > peakBalance) peakBalance = balance;
        const ddUSD = peakBalance - balance;
        const ddPct = (ddUSD / peakBalance) * 100;
        if (ddPct > maxDrawdownPct) {
          maxDrawdownPct = ddPct;
          maxDrawdownUSD = ddUSD;
        }

        // Drawdown diario respecto al balance al iniciar el día
        const dailyDD = ((dayStartBalance - balance) / dayStartBalance) * 100;
        if (dailyDD > maxDailyDDPct) maxDailyDDPct = dailyDD;

        trades.push({
          type: inTrade.type,
          entryTime: inTrade.entryTime,
          exitTime: c.time,
          entry: inTrade.entry,
          exit: exitPrice,
          pnlUSD,
          result,
          balanceAfter: balance
        });

        if (balance >= 11000.0 && passPhase1TradeIndex === null) {
          passPhase1TradeIndex = trades.length;
        }

        inTrade = null;
      }

      continue; // No abrir otro trade si ya había uno cerrándose en la misma vela
    }

    // Filtros de entrada
    if (sessionFilter && (hour < 7 || hour >= 18)) continue; // Solo Londres y NY (07:00 a 18:00 UTC)
    if (dailyTradesCount >= maxDailyTrades) continue; // Límite diario anti-overtrading

    let signal = null;

    if (modelType === 'RSI_BB') {
      // Reversión elástica rápida M5: Connors RSI(5) + Bollinger Band (20, 2.2)
      // BUY: Vela toca o perfora banda inferior y RSI <= 15 + cierre de rechazo
      if (prevC.low <= lower[i - 1] || c.low <= lower[i]) {
        if (rsi[i] <= rsiOversold && c.close > c.open) {
          signal = 'BUY';
        }
      }
      // SELL: Vela toca o perfora banda superior y RSI >= 85 + cierre de rechazo
      if (prevC.high >= upper[i - 1] || c.high >= upper[i]) {
        if (rsi[i] >= rsiOverbought && c.close < c.open) {
          signal = 'SELL';
        }
      }
    } else if (modelType === 'STOCH_EMA') {
      // Micro-Pullback Trend Sniper: EMA 50 direccional + StochRSI saliendo de sobreventa/sobrecompra
      const isUptrend = c.close > ema[i];
      const isDowntrend = c.close < ema[i];

      // BUY: Tendencia alcista + StochRSI cruza arriba de 20
      if (isUptrend && stochRSI[i - 1] <= 20 && stochRSI[i] > 20 && c.close > c.open) {
        signal = 'BUY';
      }
      // SELL: Tendencia bajista + StochRSI cruza abajo de 80
      if (isDowntrend && stochRSI[i - 1] >= 80 && stochRSI[i] < 80 && c.close < c.open) {
        signal = 'SELL';
      }
    } else if (modelType === 'LIQUIDITY_SWEEP') {
      // Barrido de liquidez de rango (últimas 12 velas M5 = 1 hora)
      let highest12 = -Infinity;
      let lowest12 = Infinity;
      for (let j = 1; j <= 12; j++) {
        if (candles[i - j].high > highest12) highest12 = candles[i - j].high;
        if (candles[i - j].low < lowest12) lowest12 = candles[i - j].low;
      }

      // BUY: El precio perfora el mínimo previo y vuelve a cerrar por encima (Fakeout / Liquidity Grab)
      if (c.low < lowest12 && c.close > lowest12 && rsi[i] < 35 && c.close > c.open) {
        signal = 'BUY';
      }
      // SELL: El precio perfora el máximo previo y vuelve a cerrar por debajo
      if (c.high > highest12 && c.close < highest12 && rsi[i] > 65 && c.close < c.open) {
        signal = 'SELL';
      }
    } else if (modelType === 'FAST_MEAN_REV') {
      // Mean Reversion Puro: RSI(3) ultra rápido en extremos (<= 10 o >= 90)
      if (rsi[i] <= 10 && c.close > c.open) {
        signal = 'BUY';
      } else if (rsi[i] >= 90 && c.close < c.open) {
        signal = 'SELL';
      }
    }

    if (signal) {
      const entryPrice = c.close;
      const tpDist = tpPips / 10.0; // pips a dólares (ej: 12 pips = $1.20)
      const slDist = slPips / 10.0; // pips a dólares (ej: 16 pips = $1.60)

      // Cálculo de lotaje con riesgo fijo en $USD
      const riskUSD = balance * (riskPercent / 100);
      const effectiveSlDist = slDist + (slippageSpread / 2); // incluye spread
      const lotSize = Math.max(0.01, Math.round((riskUSD / (effectiveSlDist * 100)) * 100) / 100);

      const tp = signal === 'BUY' ? (entryPrice + tpDist) : (entryPrice - tpDist);
      const sl = signal === 'BUY' ? (entryPrice - slDist) : (entryPrice + slDist);

      inTrade = {
        type: signal,
        entryTime: c.time,
        entry: entryPrice,
        tp,
        sl,
        lotSize
      };

      dailyTradesCount++;
    }
  }

  const wins = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? ((wins.length / totalTrades) * 100).toFixed(1) : '0';
  const netProfitUSD = balance - initialBalance;
  const netProfitPct = ((netProfitUSD / initialBalance) * 100).toFixed(2);

  const grossProfit = wins.reduce((sum, t) => sum + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlUSD, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'Inf';

  // Desglose mensual
  const monthlyResults = {};
  for (const t of trades) {
    const m = new Date(t.entryTime).toISOString().slice(0, 7);
    if (!monthlyResults[m]) monthlyResults[m] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    monthlyResults[m].trades++;
    if (t.result === 'WIN') monthlyResults[m].wins++;
    else monthlyResults[m].losses++;
    monthlyResults[m].pnl += t.pnlUSD;
  }

  return {
    totalTrades,
    tradesPerDay: (totalTrades / 250).toFixed(2), // 250 días hábiles de trading al año
    totalWins: wins.length,
    totalLosses: losses.length,
    winRate,
    initialBalance,
    balance,
    netProfitUSD,
    netProfitPct,
    maxDrawdownPct,
    maxDrawdownUSD,
    maxDailyDDPct,
    profitFactor,
    tradesToPass: passPhase1TradeIndex,
    monthlyResults
  };
}

async function main() {
  const candles = await loadOrFetchM5Candles();
  console.log(`\n========================================================================================================`);
  console.log(`🚀 AUDITORÍA ANUAL (1 AÑO): ESTRATEGIAS SNIPER ALTA FRECUENCIA EN M5 (5 MINUTOS)`);
  console.log(`🎯 Cuenta Fondeo 10K ($10,000 USD) | Límite DD Diario: 5.0% | Objetivo Fase 1: +10% (+$1,000 USD)`);
  console.log(`========================================================================================================\n`);

  const models = [
    {
      name: '1. M5 Connors RSI(5) + BB(20, 2.2) Sniper (TP 12p / SL 16p | R:R 1:0.75)',
      opts: { modelType: 'RSI_BB', rsiPeriod: 5, rsiOversold: 15, rsiOverbought: 85, bbMult: 2.2, tpPips: 12.0, slPips: 16.0, riskPercent: 0.50 }
    },
    {
      name: '2. M5 Connors RSI(5) Ultra Rápido (TP 10p / SL 14p | R:R 1:0.71)',
      opts: { modelType: 'RSI_BB', rsiPeriod: 5, rsiOversold: 18, rsiOverbought: 82, bbMult: 2.0, tpPips: 10.0, slPips: 14.0, riskPercent: 0.50 }
    },
    {
      name: '3. M5 StochRSI + EMA 50 Momentum Scalp (TP 15p / SL 18p | R:R 1:0.83)',
      opts: { modelType: 'STOCH_EMA', emaPeriod: 50, tpPips: 15.0, slPips: 18.0, riskPercent: 0.50 }
    },
    {
      name: '4. M5 Liquidity Grab Sweep (TP 14p / SL 16p | R:R 1:0.87)',
      opts: { modelType: 'LIQUIDITY_SWEEP', rsiPeriod: 7, tpPips: 14.0, slPips: 16.0, riskPercent: 0.50 }
    },
    {
      name: '5. M5 Extreme Scalper RSI(3) Mean-Rev (TP 10p / SL 15p | R:R 1:0.67)',
      opts: { modelType: 'FAST_MEAN_REV', rsiPeriod: 3, tpPips: 10.0, slPips: 15.0, riskPercent: 0.50 }
    },
    {
      name: '6. M5 Micro-Scalp Conservador (TP 12p / SL 15p | R:R 1:0.80 | Riesgo 0.40%)',
      opts: { modelType: 'RSI_BB', rsiPeriod: 5, rsiOversold: 14, rsiOverbought: 86, bbMult: 2.3, tpPips: 12.0, slPips: 15.0, riskPercent: 0.40 }
    }
  ];

  console.log('| Modelo Sniper M5 | Operaciones | Ops/Día | Win Rate | Beneficio Neto (10k) | Rentabilidad (%) | Max DD Total | Max DD Diario | Profit Factor | Pase Fase 1 (+10%) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');

  let best = null;
  let maxPnl = -Infinity;

  for (const m of models) {
    const res = runM5SniperBacktest(candles, m.opts);
    const sign = res.netProfitUSD >= 0 ? '+' : '';
    const passText = res.tradesToPass ? `~${Math.ceil(res.tradesToPass / parseFloat(res.tradesPerDay))} días (${res.tradesToPass} trades)` : 'No alcanzó';

    console.log(`| ${m.name.padEnd(46)} | ${res.totalTrades.toString().padEnd(11)} | ${res.tradesPerDay.toString().padEnd(7)} | ${(res.winRate + '%').padEnd(8)} | ${(sign + '$' + res.netProfitUSD.toFixed(2)).padEnd(20)} | ${(sign + res.netProfitPct + '%').padEnd(16)} | ${(res.maxDrawdownPct.toFixed(2) + '%').padEnd(12)} | ${(res.maxDailyDDPct.toFixed(2) + '%').padEnd(13)} | ${res.profitFactor.padEnd(13)} | ${passText} |`);

    if (res.netProfitUSD > maxPnl && res.maxDailyDDPct < 4.5) {
      maxPnl = res.netProfitUSD;
      best = { ...m, ...res };
    }
  }

  if (best) {
    console.log('\n========================================================================================================');
    console.log(`🏆 MODELO SNIPER M5 GANADOR: ${best.name}`);
    console.log('========================================================================================================');
    console.log(`💰 Saldo Inicial:          $10,000.00 USD`);
    console.log(`💵 Saldo Final:            $${best.balance.toFixed(2)} USD`);
    console.log(`🚀 Beneficio Neto Anual:   +$${best.netProfitUSD.toFixed(2)} USD (+${best.netProfitPct}%)`);
    console.log(`🎯 Frecuencia Operativa:    ${best.totalTrades} operaciones en el año (~${best.tradesPerDay} ops/día hábil)!`);
    console.log(`🏆 Win Rate Real:          ${best.winRate}% (${best.totalWins} Ganadas / ${best.totalLosses} Perdidas)`);
    console.log(`📉 Drawdown Máximo Total:  ${best.maxDrawdownPct.toFixed(2)}% (-$${best.maxDrawdownUSD.toFixed(2)} USD) [Regla Prop Firm: < 5.0%]`);
    console.log(`⚠️ Drawdown Máximo Diario: ${best.maxDailyDDPct.toFixed(2)}% [Regla Prop Firm: < 5.0%]`);
    console.log(`⚖️ Profit Factor:          ${best.profitFactor}`);
    console.log(`⚡ VELOCIDAD FASE 1:       ¡Pasa el reto (+10% / +$1,000 USD) en ${best.tradesToPass} operaciones (~${Math.ceil(best.tradesToPass / parseFloat(best.tradesPerDay))} días de trading)!`);
    console.log('--------------------------------------------------------------------------------------------------------');
    console.log('📅 Rendimiento Mes a Mes:');
    for (const [m, d] of Object.entries(best.monthlyResults)) {
      const sign = d.pnl >= 0 ? '+' : '';
      const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) : 0;
      console.log(`   🗓️ ${m}: ${d.trades} ops (${d.wins}W / ${d.losses}L, WR: ${wr}%) | PnL: ${sign}$${d.pnl.toFixed(2)} USD`);
    }
    console.log('========================================================================================================\n');
  }
}

main().catch(console.error);
