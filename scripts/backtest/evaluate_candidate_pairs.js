const https = require('https');

const CANDIDATE_ASSETS = {
  USDJPY: {
    symbol: 'USDJPY',
    yahooTicker: 'USDJPY=X',
    pipValue: 0.010,
    pipSize: 0.010,
    digits: 3,
    fvgMin: 0.030,
    overlapMin: 0.018,
    slBuffer: 0.025,
    beBufferPips: 1.2,
    rrRatio: 3.0,
    spreadPips: 0.8
  },
  AUDUSD: {
    symbol: 'AUDUSD',
    yahooTicker: 'AUDUSD=X',
    pipValue: 0.00010,
    pipSize: 0.00010,
    digits: 5,
    fvgMin: 0.00014,
    overlapMin: 0.00008,
    slBuffer: 0.00010,
    beBufferPips: 0.8,
    rrRatio: 3.0,
    spreadPips: 0.8
  },
  EURJPY: {
    symbol: 'EURJPY',
    yahooTicker: 'EURJPY=X',
    pipValue: 0.010,
    pipSize: 0.010,
    digits: 3,
    fvgMin: 0.035,
    overlapMin: 0.020,
    slBuffer: 0.025,
    beBufferPips: 1.2,
    rrRatio: 3.0,
    spreadPips: 1.0
  },
  NZDUSD: {
    symbol: 'NZDUSD',
    yahooTicker: 'NZDUSD=X',
    pipValue: 0.00010,
    pipSize: 0.00010,
    digits: 5,
    fvgMin: 0.00014,
    overlapMin: 0.00008,
    slBuffer: 0.00010,
    beBufferPips: 0.8,
    rrRatio: 3.0,
    spreadPips: 1.0
  }
};

function fetchYahooM5Candles(ticker) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1mo`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart.result[0];
          const timestamps = result.timestamp;
          const quote = result.indicators.quote[0];
          const candles = [];
          for (let i = 0; i < timestamps.length; i++) {
            const o = quote.open[i];
            const h = quote.high[i];
            const l = quote.low[i];
            const c = quote.close[i];
            if (o != null && h != null && l != null && c != null && !isNaN(o)) {
              candles.push({
                time: timestamps[i] * 1000,
                open: o,
                high: h,
                low: l,
                close: c,
                volume: quote.volume[i] || 0
              });
            }
          }
          resolve(candles);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

function simulate(candles, params, startTimeMs, endTimeMs) {
  const k = 2 / (100 + 1);
  let ema = candles[0].close;
  for (const c of candles) { ema = c.close * k + ema * (1 - k); c.ema100 = ema; }

  const bprZones = [];
  const trades = [];
  let activeTrades = [];

  for (let i = 8; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    for (let tIdx = activeTrades.length - 1; tIdx >= 0; tIdx--) {
      const t = activeTrades[tIdx];
      const riskDist = Math.abs(t.entryPrice - t.sl);
      if (t.isBuy) {
        if (!t.isBE && c0.high >= t.entryPrice + riskDist) {
          t.isBE = true;
          t.sl = t.entryPrice + (params.beBufferPips * params.pipValue);
        }
        if (c0.low <= t.sl) {
          t.exitPrice = t.sl;
          t.exitTime = c0.time;
          t.outcome = t.isBE ? 'BE' : 'LOSS';
          t.rMultiple = t.isBE ? (params.beBufferPips * params.pipValue) / riskDist : -1.0;
          trades.push(t);
          activeTrades.splice(tIdx, 1);
          continue;
        }
        if (c0.high >= t.tp) {
          t.exitPrice = t.tp;
          t.exitTime = c0.time;
          t.outcome = 'WIN';
          t.rMultiple = params.rrRatio;
          trades.push(t);
          activeTrades.splice(tIdx, 1);
          continue;
        }
      } else {
        if (!t.isBE && c0.low <= t.entryPrice - riskDist) {
          t.isBE = true;
          t.sl = t.entryPrice - (params.beBufferPips * params.pipValue);
        }
        if (c0.high >= t.sl) {
          t.exitPrice = t.sl;
          t.exitTime = c0.time;
          t.outcome = t.isBE ? 'BE' : 'LOSS';
          t.rMultiple = t.isBE ? (params.beBufferPips * params.pipValue) / riskDist : -1.0;
          trades.push(t);
          activeTrades.splice(tIdx, 1);
          continue;
        }
        if (c0.low <= t.tp) {
          t.exitPrice = t.tp;
          t.exitTime = c0.time;
          t.outcome = 'WIN';
          t.rMultiple = params.rrRatio;
          trades.push(t);
          activeTrades.splice(tIdx, 1);
          continue;
        }
      }
    }

    if (c0.time < startTimeMs || c0.time > endTimeMs) continue;

    let isBullishBOS = false;
    let isBearishBOS = false;
    let swingHigh = Math.max(...candles.slice(Math.max(0, i - 16), i - 2).map(c => c.high));
    let swingLow = Math.min(...candles.slice(Math.max(0, i - 16), i - 2).map(c => c.low));

    if (c1.close > swingHigh) isBullishBOS = true;
    if (c1.close < swingLow) isBearishBOS = true;

    let bullishFvg = null;
    let bearishFvg = null;
    if (c1.low > c3.high && (c1.low - c3.high) >= params.fvgMin) {
      bullishFvg = { top: c1.low, bottom: c3.high };
    }
    if (c1.high < c3.low && (c3.low - c1.high) >= params.fvgMin) {
      bearishFvg = { top: c3.low, bottom: c1.high };
    }

    if (bullishFvg && bearishFvg) {
      const top = Math.min(bullishFvg.top, bearishFvg.top);
      const bottom = Math.max(bullishFvg.bottom, bearishFvg.bottom);
      if (top > bottom && (top - bottom) >= params.overlapMin) {
        const ce50 = (top + bottom) / 2.0;
        if (isBullishBOS) {
          bprZones.push({ isBuy: true, top, bottom, ce50, sl: bottom - params.slBuffer, active: true, barCount: 0 });
        } else if (isBearishBOS) {
          bprZones.push({ isBuy: false, top, bottom, ce50, sl: top + params.slBuffer, active: true, barCount: 0 });
        }
      }
    }

    for (const z of bprZones) {
      if (!z.active) continue;
      z.barCount++;
      if (z.barCount > 60) { z.active = false; continue; }

      const hasRisk = activeTrades.some(t => !t.isBE);
      if (hasRisk) continue;

      if (z.isBuy && c0.low <= z.ce50 && c0.high >= z.ce50) {
        if (c0.close < c0.ema100) continue;
        const candleRange = c0.high - c0.low;
        if (candleRange > 0) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange < 0.20) continue;
        }
        z.active = false;
        const entryPrice = z.ce50;
        const slPrice = z.sl;
        const riskDist = Math.abs(entryPrice - slPrice);
        const tpPrice = entryPrice + (riskDist * params.rrRatio);
        activeTrades.push({ isBuy: true, entryPrice, sl: slPrice, tp: tpPrice, entryTime: c0.time, isBE: false });
        break;
      } else if (!z.isBuy && c0.high >= z.ce50 && c0.low <= z.ce50) {
        if (c0.close > c0.ema100) continue;
        const candleRange = c0.high - c0.low;
        if (candleRange > 0) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange < 0.20) continue;
        }
        z.active = false;
        const entryPrice = z.ce50;
        const slPrice = z.sl;
        const riskDist = Math.abs(slPrice - entryPrice);
        const tpPrice = entryPrice - (riskDist * params.rrRatio);
        activeTrades.push({ isBuy: false, entryPrice, sl: slPrice, tp: tpPrice, entryTime: c0.time, isBE: false });
        break;
      }
    }
  }

  return trades;
}

async function run() {
  const start = new Date('2026-10-05T00:00:00Z').getTime();
  const end = new Date('2026-10-08T23:59:59Z').getTime();

  console.log('🔬 EVALUANDO ACTIVOS CANDIDATOS PARA INCORPORAR (ESTA SEMANA: 05 - 08 OCT):\n');
  console.log('ACTIVO  | TRADES | WINS (TP 1:3) | BEs (Riesgo $0) | LOSS | WIN RATE | NO-LOSS RATE | R NETO');
  console.log('--------+--------+---------------+-----------------+------+----------+--------------+--------');

  for (const [key, params] of Object.entries(CANDIDATE_ASSETS)) {
    const candles = await fetchYahooM5Candles(params.yahooTicker);
    if (!candles || candles.length === 0) {
      console.log(`${key.padEnd(7)} | Sin datos`);
      continue;
    }
    const trades = simulate(candles, params, start, end);
    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const bes = trades.filter(t => t.outcome === 'BE').length;
    const losses = trades.filter(t => t.outcome === 'LOSS').length;
    const total = trades.length;
    const wr = total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : '0%';
    const noLoss = total > 0 ? (((wins + bes) / total) * 100).toFixed(1) + '%' : '0%';
    const netR = trades.reduce((acc, t) => acc + (t.rMultiple || 0), 0).toFixed(2);

    console.log(`${key.padEnd(7)} | ${String(total).padStart(6)} | ${String(wins).padStart(13)} | ${String(bes).padStart(15)} | ${String(losses).padStart(4)} | ${wr.padStart(8)} | ${noLoss.padStart(12)} | +${netR}R`);
  }
}

run();
