/**
 * Test de Expansión de Frecuencia Operativa para Estrategias Sniper
 * 
 * Pregunta clave: ¿Cómo alcanzar entre 250 y 500+ operaciones al año manteniendo el Win Rate alto (>70-75%)
 * y un Drawdown controlado (<3.0%) para retos de fondeo?
 * 
 * Vías Cuantitativas a Investigar:
 * 1. M15 Multi-Setup Sniper:
 *    - Setup A: Reversión Elástica (Connors RSI en bandas de Bollinger).
 *    - Setup B: Trend Continuation Pullback (EMA 50 / 200 retest con RSI).
 *    - Setup C: Asian Session High/Low Breakout & Pullback.
 * 2. M15 con umbrales calibrados (RSI 22/78 en vez de 16/84).
 * 3. ¿Qué combinación de setups produce >250 ops/año con curva de equidad creciente y DD < 3%?
 */

const { fetchFullYearData } = require('./multi_tf_volume_profile_1y');

function calculateRSI(candles, period = 7) {
  const rsi = new Float64Array(candles.length);
  if (candles.length <= period) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
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
    let varSum = 0;
    for (let j = 0; j < period; j++) {
      const d = candles[i - j].close - sma;
      varSum += d * d;
    }
    const sd = Math.sqrt(varSum / period);
    upper[i] = sma + (sd * multiplier);
    lower[i] = sma - (sd * multiplier);
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

function runMultiSetupBacktest(candles, opts = {}) {
  const {
    name,
    rsiOversold = 22,
    rsiOverbought = 78,
    bbMult = 2.0,
    tpPips = 16.0,
    slPips = 22.0,
    enablePullbackSetup = true,
    riskPercent = 0.50
  } = opts;

  const rsi = calculateRSI(candles, 7);
  const { upper, lower } = calculateBollingerBands(candles, 20, bbMult);
  const ema50 = calculateEMA(candles, 50);
  const ema200 = calculateEMA(candles, 200);

  let balance = 10000.0;
  let peak = balance;
  let maxDD = 0;
  let maxDailyDD = 0;
  let currentDay = '';
  let dayStartBal = balance;

  const trades = [];
  let inTrade = null;
  let passTrade = null;

  for (let i = 200; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];
    const d = new Date(c.time);
    const dayStr = d.toISOString().slice(0, 10);
    const hour = d.getUTCHours();

    if (dayStr !== currentDay) {
      currentDay = dayStr;
      dayStartBal = balance;
    }

    if (inTrade) {
      let closed = false;
      let exitPrice = 0;
      let res = '';

      if (inTrade.type === 'BUY') {
        if (c.low <= inTrade.sl) {
          exitPrice = inTrade.sl;
          res = 'LOSS';
          closed = true;
        } else if (c.high >= inTrade.tp) {
          exitPrice = inTrade.tp;
          res = 'WIN';
          closed = true;
        }
      } else {
        if (c.high >= inTrade.sl) {
          exitPrice = inTrade.sl;
          res = 'LOSS';
          closed = true;
        } else if (c.low <= inTrade.tp) {
          exitPrice = inTrade.tp;
          res = 'WIN';
          closed = true;
        }
      }

      if (closed) {
        const diff = inTrade.type === 'BUY' ? (exitPrice - inTrade.entry) : (inTrade.entry - exitPrice);
        const pnl = diff * inTrade.lotSize * 100;
        balance += pnl;
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDD) maxDD = dd;

        const dailyDD = ((dayStartBal - balance) / dayStartBal) * 100;
        if (dailyDD > maxDailyDD) maxDailyDD = dailyDD;

        trades.push({ res, pnl });
        if (balance >= 11000.0 && passTrade === null) passTrade = trades.length;
        inTrade = null;
      }
      continue;
    }

    if (hour < 7 || hour >= 18) continue; // Sesiones Londres + NY

    let signal = null;

    // SETUP 1: Elastic Mean Reversion
    if ((prevC.low <= lower[i - 1] || c.low <= lower[i]) && rsi[i] <= rsiOversold && c.close > c.open) {
      signal = 'BUY';
    } else if ((prevC.high >= upper[i - 1] || c.high >= upper[i]) && rsi[i] >= rsiOverbought && c.close < c.open) {
      signal = 'SELL';
    }

    // SETUP 2: Trend Continuation Pullback (si está activado y no hubo señal de reversión)
    if (!signal && enablePullbackSetup) {
      const isUptrend = c.close > ema50[i] && ema50[i] > ema200[i];
      const isDowntrend = c.close < ema50[i] && ema50[i] < ema200[i];

      // Pullback en tendencia alcista: precio toca EMA 50 y RSI está entre 35 y 48
      if (isUptrend && prevC.low <= ema50[i] && c.close > ema50[i] && rsi[i] >= 38 && rsi[i] <= 52 && c.close > c.open) {
        signal = 'BUY';
      }
      // Pullback en tendencia bajista: precio toca EMA 50 y RSI está entre 50 y 62
      if (isDowntrend && prevC.high >= ema50[i] && c.close < ema50[i] && rsi[i] >= 48 && rsi[i] <= 62 && c.close < c.open) {
        signal = 'SELL';
      }
    }

    if (signal) {
      const entry = c.close;
      const tpDist = tpPips / 10.0;
      const slDist = slPips / 10.0;
      const riskUSD = balance * (riskPercent / 100);
      const lotSize = Math.max(0.01, Math.round((riskUSD / ((slDist + 0.15) * 100)) * 100) / 100);

      inTrade = {
        type: signal,
        entry,
        tp: signal === 'BUY' ? entry + tpDist : entry - tpDist,
        sl: signal === 'BUY' ? entry - slDist : entry + slDist,
        lotSize
      };
    }
  }

  const wins = trades.filter(t => t.res === 'WIN');
  const losses = trades.filter(t => t.res === 'LOSS');
  const total = trades.length;
  const wr = total > 0 ? ((wins.length / total) * 100).toFixed(1) : '0';
  const netUSD = balance - 10000.0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'Inf';

  return {
    name,
    trades: total,
    opsPerDay: (total / 250).toFixed(2),
    wins: wins.length,
    losses: losses.length,
    winRate: wr,
    netProfitUSD: netUSD,
    netPct: ((netUSD / 10000.0) * 100).toFixed(2),
    maxDD: maxDD.toFixed(2),
    maxDailyDD: maxDailyDD.toFixed(2),
    pf,
    passTrades: passTrade
  };
}

async function main() {
  const candles = await fetchFullYearData('15m', 1000 * 15 * 60 * 1000);
  console.log(`\n========================================================================================================`);
  console.log(`🎯 AUDITORÍA DE FRECUENCIA SNIPER EXPANDIDA (M15 MULTI-SETUP)`);
  console.log(`========================================================================================================\n`);

  const tests = [
    { name: '1. Reversión Calibrada (RSI 22/78 | BB 2.0 | TP 16p / SL 22p)', rsiOversold: 22, rsiOverbought: 78, bbMult: 2.0, tpPips: 16.0, slPips: 22.0, enablePullbackSetup: false },
    { name: '2. Reversión Calibrada (RSI 20/80 | BB 2.1 | TP 15p / SL 20p)', rsiOversold: 20, rsiOverbought: 80, bbMult: 2.1, tpPips: 15.0, slPips: 20.0, enablePullbackSetup: false },
    { name: '3. Multi-Setup Dual: Reversión + Pullback EMA 50 (TP 16p / SL 22p)', rsiOversold: 22, rsiOverbought: 78, bbMult: 2.0, tpPips: 16.0, slPips: 22.0, enablePullbackSetup: true },
    { name: '4. Multi-Setup Dual: Reversión + Pullback EMA 50 (TP 15p / SL 20p)', rsiOversold: 20, rsiOverbought: 80, bbMult: 2.1, tpPips: 15.0, slPips: 20.0, enablePullbackSetup: true },
    { name: '5. Multi-Setup Asimétrico R:R 1:0.75 (TP 12p / SL 16p)', rsiOversold: 22, rsiOverbought: 78, bbMult: 2.0, tpPips: 12.0, slPips: 16.0, enablePullbackSetup: true },
    { name: '6. Multi-Setup R:R 1:1 Puro (TP 18p / SL 18p)', rsiOversold: 20, rsiOverbought: 80, bbMult: 2.1, tpPips: 18.0, slPips: 18.0, enablePullbackSetup: true }
  ];

  console.log('| Configuración Multi-Setup | Ops | Ops/Día | Win Rate | Beneficio Neto (10k) | Rentabilidad | Max DD | DD Diario | PF | Pase (+10%) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');

  for (const t of tests) {
    const r = runMultiSetupBacktest(candles, t);
    const sign = r.netProfitUSD >= 0 ? '+' : '';
    const pass = r.passTrades ? `${r.passTrades} ops (~${Math.ceil(r.passTrades / parseFloat(r.opsPerDay))} días)` : 'No alcanzó';
    console.log(`| ${t.name.padEnd(52)} | ${r.trades.toString().padEnd(3)} | ${r.opsPerDay.toString().padEnd(7)} | ${(r.winRate + '%').padEnd(8)} | ${(sign + '$' + r.netProfitUSD.toFixed(2)).padEnd(20)} | ${(sign + r.netPct + '%').padEnd(12)} | ${(r.maxDD + '%').padEnd(6)} | ${(r.maxDailyDD + '%').padEnd(9)} | ${r.pf.padEnd(4)} | ${pass} |`);
  }
}

main().catch(console.error);
