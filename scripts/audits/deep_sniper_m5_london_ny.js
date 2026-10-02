/**
 * Deep Analysis: Sniper M5 de Alta Frecuencia para Fondeo
 * Buscando la confluencia que maximice operaciones (1-3 al día) y Win Rate (>= 75%)
 * 
 * Factores a testear:
 * 1. Filtro Horario Quirúrgico (London Open 07:00-11:00 UTC + NY Open 12:00-16:00 UTC).
 * 2. Confluencia Multi-Indicador: H1 EMA 50 + M5 RSI(5) + Bollinger Band + Rejection Candle (mecha de rechazo).
 * 3. Gestión de R:R Asimétrico:
 *    - TP 12p / SL 14p
 *    - TP 15p / SL 18p
 *    - TP 10p / SL 12p
 *    - TP 18p / SL 20p
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache_paxg_5m_1y.json');
const candles = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

// H1 data builder
function buildH1Candles(m5Candles) {
  const h1 = [];
  let cur = null;
  for (const c of m5Candles) {
    const h1Time = Math.floor(c.time / 3600000) * 3600000;
    if (!cur || cur.time !== h1Time) {
      if (cur) h1.push(cur);
      cur = { time: h1Time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) h1.push(cur);
  return h1;
}

function calculateEMA(arr, period) {
  const ema = new Float64Array(arr.length);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, arr.length); i++) sum += arr[i];
  let prev = sum / Math.min(period, arr.length);
  ema[Math.min(period, arr.length) - 1] = prev;
  for (let i = period; i < arr.length; i++) {
    prev = (arr[i] - prev) * k + prev;
    ema[i] = prev;
  }
  return ema;
}

function calculateRSI(candles, period = 5) {
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

function calculateBollingerBands(candles, period = 20, mult = 2.0) {
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
    upper[i] = sma + (sd * mult);
    lower[i] = sma - (sd * mult);
  }
  return { upper, lower, middle };
}

const h1Candles = buildH1Candles(candles);
const h1Closes = h1Candles.map(c => c.close);
const h1Ema50 = calculateEMA(h1Closes, 50);

const h1TimeMap = new Map();
h1Candles.forEach((c, idx) => h1TimeMap.set(c.time, idx));

function getH1Trend(time) {
  const h1Time = Math.floor(time / 3600000) * 3600000;
  const idx = h1TimeMap.get(h1Time);
  if (idx === undefined || idx < 50) return null;
  return h1Candles[idx].close > h1Ema50[idx] ? 'BULL' : 'BEAR';
}

function runSim(p) {
  const {
    name,
    rsiPeriod = 5,
    rsiBuy = 25,
    rsiSell = 75,
    bbMult = 2.0,
    tpPips = 12.0,
    slPips = 15.0,
    wickRatio = 0.25, // Rechazo mínimo de mecha (25% de la vela)
    riskPercent = 0.50,
    sessionHours = [7, 18], // UTC
    allowCounterTrendOnExtreme = false // si RSI es ultra extremo (<=10 o >=90) permitir contra-tendencia
  } = p;

  const rsi = calculateRSI(candles, rsiPeriod);
  const { upper, lower } = calculateBollingerBands(candles, 20, bbMult);

  let balance = 10000.0;
  let peak = balance;
  let maxDD = 0;
  let maxDailyDD = 0;
  let currentDay = '';
  let dayStartBal = balance;

  const trades = [];
  let inTrade = null;
  let passTrade = null;

  for (let i = 100; i < candles.length; i++) {
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

    if (hour < sessionHours[0] || hour >= sessionHours[1]) continue;

    const macroTrend = getH1Trend(c.time);
    if (!macroTrend) continue;

    const candleRange = c.high - c.low;
    if (candleRange <= 0.20) continue; // evitar velas minúsculas sin liquidez

    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    const hasLowerRejection = (lowerWick / candleRange) >= wickRatio;
    const hasUpperRejection = (upperWick / candleRange) >= wickRatio;

    let signal = null;

    // BUY LOGIC
    const isBuySetup = (prevC.low <= lower[i - 1] || c.low <= lower[i]) && rsi[i] <= rsiBuy && c.close > c.open;
    if (isBuySetup) {
      if (macroTrend === 'BULL') {
        if (hasLowerRejection) signal = 'BUY';
      } else if (allowCounterTrendOnExtreme && rsi[i] <= 12 && hasLowerRejection) {
        signal = 'BUY';
      }
    }

    // SELL LOGIC
    const isSellSetup = (prevC.high >= upper[i - 1] || c.high >= upper[i]) && rsi[i] >= rsiSell && c.close < c.open;
    if (isSellSetup) {
      if (macroTrend === 'BEAR') {
        if (hasUpperRejection) signal = 'SELL';
      } else if (allowCounterTrendOnExtreme && rsi[i] >= 88 && hasUpperRejection) {
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

const matrix = [
  // Variación A: Precision Rejection Scalp (Wick Ratio 25%)
  { name: '1. M5 Sniper Confluencia (TP 12p / SL 15p | R:R 1:0.80)', tpPips: 12.0, slPips: 15.0, rsiBuy: 25, rsiSell: 75, bbMult: 2.0, wickRatio: 0.25 },
  { name: '2. M5 Sniper Confluencia (TP 15p / SL 18p | R:R 1:0.83)', tpPips: 15.0, slPips: 18.0, rsiBuy: 25, rsiSell: 75, bbMult: 2.0, wickRatio: 0.25 },
  { name: '3. M5 Sniper Ultra Rápido (TP 10p / SL 12p | R:R 1:0.83)', tpPips: 10.0, slPips: 12.0, rsiBuy: 28, rsiSell: 72, bbMult: 1.9, wickRatio: 0.20 },
  { name: '4. M5 Confluencia + Contra-Extremos (TP 14p / SL 16p | R:R 1:0.88)', tpPips: 14.0, slPips: 16.0, rsiBuy: 25, rsiSell: 75, bbMult: 2.0, wickRatio: 0.25, allowCounterTrendOnExtreme: true },
  { name: '5. M5 London + NY Prime Time (08-16 UTC | TP 15p / SL 18p)', tpPips: 15.0, slPips: 18.0, rsiBuy: 25, rsiSell: 75, bbMult: 2.0, wickRatio: 0.25, sessionHours: [8, 16] },
  { name: '6. M5 Scalper Asimétrico Agresivo (TP 10p / SL 14p | R:R 1:0.71)', tpPips: 10.0, slPips: 14.0, rsiBuy: 30, rsiSell: 70, bbMult: 1.8, wickRatio: 0.15 }
];

console.log('| Configuración M5 Sniper Avanzada | Ops | Ops/Día | Win Rate | Beneficio Neto (10k) | Rentabilidad | Max DD | DD Diario | PF | Pase (+10%) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');

for (const m of matrix) {
  const r = runSim(m);
  const sign = r.netProfitUSD >= 0 ? '+' : '';
  const pass = r.passTrades ? `${r.passTrades} ops (~${Math.ceil(r.passTrades / parseFloat(r.opsPerDay))} días)` : 'No alcanzó';
  console.log(`| ${r.name.padEnd(52)} | ${r.trades.toString().padEnd(3)} | ${r.opsPerDay.toString().padEnd(7)} | ${(r.winRate + '%').padEnd(8)} | ${(sign + '$' + r.netProfitUSD.toFixed(2)).padEnd(20)} | ${(sign + r.netPct + '%').padEnd(12)} | ${(r.maxDD + '%').padEnd(6)} | ${(r.maxDailyDD + '%').padEnd(9)} | ${r.pf.padEnd(4)} | ${pass} |`);
}
