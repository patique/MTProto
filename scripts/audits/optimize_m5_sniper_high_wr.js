/**
 * Optimizador Cuantitativo M5 Sniper: Buscando el Santo Grial de Alta Frecuencia (200-500 trades) + Alto Win Rate (75-85%+)
 * 
 * Hipótesis a Validar:
 * 1. El gran fallo de M5 individual es operar contratendencia. Si el Oro en H1/M30 está en tendencia fuerte,
 *    un RSI sobrevendido en M5 sigue cayendo 50 pips.
 * 2. HIPÓTESIS A: Trend-Following M5 Sniper (H1 EMA 50 trend + M5 Pullback RSI <= 20).
 * 3. HIPÓTESIS B: Asian High/Low Liquidity Sweep con rechazo rápido.
 * 4. HIPÓTESIS C: Trailing Stop / R:R Simétrico 1:1 o 1:1.2 con confirmación de volumen (Volume Spike).
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache_paxg_5m_1y.json');
const candles = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

// Convertir velas M5 a H1 para filtro macro
function buildH1Candles(m5Candles) {
  const h1 = [];
  let currentH1 = null;

  for (const c of m5Candles) {
    const h1Time = Math.floor(c.time / (60 * 60 * 1000)) * (60 * 60 * 1000);
    if (!currentH1 || currentH1.time !== h1Time) {
      if (currentH1) h1.push(currentH1);
      currentH1 = {
        time: h1Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      };
    } else {
      if (c.high > currentH1.high) currentH1.high = c.high;
      if (c.low < currentH1.low) currentH1.low = c.low;
      currentH1.close = c.close;
      currentH1.volume += c.volume;
    }
  }
  if (currentH1) h1.push(currentH1);
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

function calculateBollingerBands(candles, period = 20, mult = 2.0) {
  const upper = new Float64Array(candles.length);
  const lower = new Float64Array(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    const sma = sum / period;
    let varSum = 0;
    for (let j = 0; j < period; j++) {
      const d = candles[i - j].close - sma;
      varSum += d * d;
    }
    const sd = Math.sqrt(varSum / period);
    upper[i] = sma + (sd * mult);
    lower[i] = sma - (sd * mult);
  }
  return { upper, lower };
}

const h1Candles = buildH1Candles(candles);
const h1Closes = h1Candles.map(c => c.close);
const h1Ema50 = calculateEMA(h1Closes, 50);
const h1Ema200 = calculateEMA(h1Closes, 200);

// Mapeo rápido de H1 index por timestamp
const h1TimeMap = new Map();
h1Candles.forEach((c, idx) => h1TimeMap.set(c.time, idx));

function getH1Trend(time) {
  const h1Time = Math.floor(time / (60 * 60 * 1000)) * (60 * 60 * 1000);
  const idx = h1TimeMap.get(h1Time);
  if (idx === undefined || idx < 200) return null;
  const close = h1Candles[idx].close;
  const ema50 = h1Ema50[idx];
  const ema200 = h1Ema200[idx];

  if (close > ema50 && ema50 > ema200) return 'STRONG_BULL';
  if (close < ema50 && ema50 < ema200) return 'STRONG_BEAR';
  if (close > ema50) return 'BULL';
  if (close < ema50) return 'BEAR';
  return 'NEUTRAL';
}

function runOptimizerBacktest(opts) {
  const {
    name,
    rsiPeriod = 5,
    rsiOversold = 15,
    rsiOverbought = 85,
    bbPeriod = 20,
    bbMult = 2.0,
    tpPips = 12.0,
    slPips = 15.0,
    trendFilterMode = 'STRONG_ONLY', // 'STRONG_ONLY', 'ANY_TREND', 'NONE', 'PULLBACK'
    bePips = 0, // 0 = sin BE
    riskPercent = 0.50
  } = opts;

  const rsi = calculateRSI(candles, rsiPeriod);
  const { upper, lower } = calculateBollingerBands(candles, bbPeriod, bbMult);

  let balance = 10000.0;
  let peak = balance;
  let maxDD = 0;
  let dayStartBal = balance;
  let currentDay = '';
  let maxDailyDD = 0;

  const trades = [];
  let inTrade = null;
  let passTradeIdx = null;

  for (let i = 250; i < candles.length; i++) {
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

      // Check Break-Even trigger
      if (bePips > 0 && !inTrade.isBE) {
        if (inTrade.type === 'BUY' && c.high >= inTrade.entry + (bePips / 10.0)) {
          inTrade.sl = inTrade.entry + 0.10; // BE + 1 pip para cubrir comisión
          inTrade.isBE = true;
        } else if (inTrade.type === 'SELL' && c.low <= inTrade.entry - (bePips / 10.0)) {
          inTrade.sl = inTrade.entry - 0.10;
          inTrade.isBE = true;
        }
      }

      if (inTrade.type === 'BUY') {
        if (c.low <= inTrade.sl) {
          exitPrice = inTrade.sl;
          res = inTrade.isBE && exitPrice >= inTrade.entry ? 'BE' : 'LOSS';
          closed = true;
        } else if (c.high >= inTrade.tp) {
          exitPrice = inTrade.tp;
          res = 'WIN';
          closed = true;
        }
      } else {
        if (c.high >= inTrade.sl) {
          exitPrice = inTrade.sl;
          res = inTrade.isBE && exitPrice <= inTrade.entry ? 'BE' : 'LOSS';
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

        trades.push({ type: inTrade.type, res, pnl, exitTime: c.time });
        if (balance >= 11000.0 && passTradeIdx === null) passTradeIdx = trades.length;
        inTrade = null;
      }
      continue;
    }

    // Horario: Londres + NY (07:00 a 18:00 UTC)
    if (hour < 7 || hour >= 18) continue;

    const macroTrend = getH1Trend(c.time);
    if (!macroTrend) continue;

    let signal = null;

    if (trendFilterMode === 'STRONG_ONLY') {
      // Solo comprar si H1 es STRONG_BULL y M5 toca banda inferior + RSI sobreventa
      if (macroTrend === 'STRONG_BULL' && (c.low <= lower[i] || prevC.low <= lower[i - 1]) && rsi[i] <= rsiOversold && c.close > c.open) {
        signal = 'BUY';
      }
      // Solo vender si H1 es STRONG_BEAR y M5 toca banda superior + RSI sobrecompra
      if (macroTrend === 'STRONG_BEAR' && (c.high >= upper[i] || prevC.high >= upper[i - 1]) && rsi[i] >= rsiOverbought && c.close < c.open) {
        signal = 'SELL';
      }
    } else if (trendFilterMode === 'ANY_TREND') {
      if ((macroTrend === 'STRONG_BULL' || macroTrend === 'BULL') && rsi[i] <= rsiOversold && c.close > c.open) {
        signal = 'BUY';
      }
      if ((macroTrend === 'STRONG_BEAR' || macroTrend === 'BEAR') && rsi[i] >= rsiOverbought && c.close < c.open) {
        signal = 'SELL';
      }
    } else if (trendFilterMode === 'PULLBACK_RETEST') {
      // Pullback de retroceso a la banda opuesta tras confirmación de tendencia
      if (macroTrend === 'STRONG_BULL' && c.low <= lower[i] && rsi[i] <= 25 && c.close > c.open) {
        signal = 'BUY';
      }
      if (macroTrend === 'STRONG_BEAR' && c.high >= upper[i] && rsi[i] >= 75 && c.close < c.open) {
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
        lotSize,
        isBE: false
      };
    }
  }

  const wins = trades.filter(t => t.res === 'WIN');
  const losses = trades.filter(t => t.res === 'LOSS');
  const bes = trades.filter(t => t.res === 'BE');
  const decisive = wins.length + losses.length;
  const wr = decisive > 0 ? ((wins.length / decisive) * 100).toFixed(1) : '0';
  const netUSD = balance - 10000.0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'Inf';

  return {
    name,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    bes: bes.length,
    winRate: wr,
    netProfitUSD: netUSD,
    netPct: ((netUSD / 10000.0) * 100).toFixed(2),
    maxDD: maxDD.toFixed(2),
    maxDailyDD: maxDailyDD.toFixed(2),
    pf,
    passTrades: passTradeIdx
  };
}

const testConfigurations = [
  // 1. Trend H1 Fuerte + Pullback M5 (RSI 5 <= 15)
  { name: 'A1. H1 Strong Trend + M5 RSI(5)<=15 (TP 15p / SL 18p | BE 10p)', trendFilterMode: 'STRONG_ONLY', rsiPeriod: 5, rsiOversold: 15, rsiOverbought: 85, bbMult: 2.0, tpPips: 15.0, slPips: 18.0, bePips: 10.0 },
  { name: 'A2. H1 Strong Trend + M5 RSI(5)<=18 (TP 12p / SL 15p | BE 8p)', trendFilterMode: 'STRONG_ONLY', rsiPeriod: 5, rsiOversold: 18, rsiOverbought: 82, bbMult: 1.9, tpPips: 12.0, slPips: 15.0, bePips: 8.0 },
  { name: 'A3. H1 Strong Trend + M5 RSI(7)<=20 (TP 20p / SL 20p | BE 12p)', trendFilterMode: 'STRONG_ONLY', rsiPeriod: 7, rsiOversold: 20, rsiOverbought: 80, bbMult: 2.0, tpPips: 20.0, slPips: 20.0, bePips: 12.0 },
  
  // 2. Trend H1 Flexible + Alta Frecuencia (ANY_TREND)
  { name: 'B1. H1 Trend + M5 BB Touch (TP 15p / SL 18p | Sin BE)', trendFilterMode: 'ANY_TREND', rsiPeriod: 5, rsiOversold: 20, rsiOverbought: 80, bbMult: 2.0, tpPips: 15.0, slPips: 18.0, bePips: 0 },
  { name: 'B2. H1 Trend + M5 BB Touch (TP 12p / SL 15p | BE 8p)', trendFilterMode: 'ANY_TREND', rsiPeriod: 5, rsiOversold: 20, rsiOverbought: 80, bbMult: 2.0, tpPips: 12.0, slPips: 15.0, bePips: 8.0 },
  { name: 'B3. H1 Trend + M5 BB Touch (TP 10p / SL 12p | R:R 1:0.83)', trendFilterMode: 'ANY_TREND', rsiPeriod: 5, rsiOversold: 22, rsiOverbought: 78, bbMult: 1.8, tpPips: 10.0, slPips: 12.0, bePips: 0 },

  // 3. Pullback Retest Profundo
  { name: 'C1. H1 Trend Retest Profundo (TP 18p / SL 20p | BE 10p)', trendFilterMode: 'PULLBACK_RETEST', rsiPeriod: 5, bbMult: 2.2, tpPips: 18.0, slPips: 20.0, bePips: 10.0 },
  { name: 'C2. H1 Trend Retest Profundo (TP 15p / SL 15p | R:R 1:1)', trendFilterMode: 'PULLBACK_RETEST', rsiPeriod: 5, bbMult: 2.2, tpPips: 15.0, slPips: 15.0, bePips: 0 },
  { name: 'C3. H1 Trend Retest Profundo (TP 25p / SL 22p | R:R 1:1.14)', trendFilterMode: 'PULLBACK_RETEST', rsiPeriod: 7, bbMult: 2.3, tpPips: 25.0, slPips: 22.0, bePips: 12.0 }
];

console.log('| Configuración M5 Sniper Multi-TF | Ops | W | L | BE | Win Rate | Beneficio Neto (10k) | Rentabilidad | Max DD | Max DD Diario | PF |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');

for (const cfg of testConfigurations) {
  const r = runOptimizerBacktest(cfg);
  const sign = r.netProfitUSD >= 0 ? '+' : '';
  console.log(`| ${r.name.padEnd(52)} | ${r.trades.toString().padEnd(4)} | ${r.wins.toString().padEnd(3)} | ${r.losses.toString().padEnd(3)} | ${r.bes.toString().padEnd(3)} | ${(r.winRate + '%').padEnd(8)} | ${(sign + '$' + r.netProfitUSD.toFixed(2)).padEnd(20)} | ${(sign + r.netPct + '%').padEnd(12)} | ${(r.maxDD + '%').padEnd(6)} | ${(r.maxDailyDD + '%').padEnd(13)} | ${r.pf.padEnd(4)} |`);
}
