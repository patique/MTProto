const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', '..');

// Ventana de esta semana: Lunes 28 de Septiembre 00:00 UTC al Viernes 2 de Octubre
const WEEK_START = new Date('2026-09-28T00:00:00Z');
const WEEK_END   = new Date('2026-10-02T23:59:59Z');

async function loadCandles(filePath) {
  const candles = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split(/[\t,;]+/);
    if (parts.length < 6) continue;

    const dateStr = parts[0].trim();
    if (dateStr < '2026.09.20' && dateStr < '2026-09-20') continue;

    const timeStr = parts[1].trim();
    const open = parseFloat(parts[2]);
    const high = parseFloat(parts[3]);
    const low = parseFloat(parts[4]);
    const close = parseFloat(parts[5]);

    let dt;
    if (dateStr.includes('.')) {
      const dp = dateStr.split('.');
      const tp = timeStr.split(':');
      dt = new Date(Date.UTC(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1])));
    } else {
      dt = new Date(`${dateStr}T${timeStr}Z`);
    }

    candles.push({ time: dt, timeMs: dt.getTime(), open, high, low, close });
  }

  return candles;
}

// 1. Extraer trades XAUUSD Sweet Spot (M2 + M3 + M5)
async function getGoldTrades() {
  const TF_CONFIGS = {
    M2: { file: 'XAUUSD_M2_202001020600_202610011120.csv', gap: 0.70, overlap: 0.40, range: 0.80, buffer: 1.20, slMin: 1.80 },
    M3: { file: 'XAUUSD_M3_202001020600_202610011121.csv', gap: 0.80, overlap: 0.50, range: 1.00, buffer: 1.50, slMin: 2.00 },
    M5: { file: 'XAUUSD_M5_202001020600_202610011120.csv', gap: 1.20, overlap: 0.70, range: 1.40, buffer: 2.00, slMin: 2.50 }
  };

  const trades = [];
  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandles(path.join(DATA_DIR, cfg.file));
    if (candles.length < 50) continue;

    const k = 2 / (100 + 1);
    let ema = candles[0].close;
    for (let c of candles) {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    }

    const bprZones = [];
    let lastTradeIdx = -100;

    for (let i = 3; i < candles.length; i++) {
      const c0 = candles[i], c1 = candles[i - 1], c2 = candles[i - 2], c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBullishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBearish) {
            const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + cfg.gap;
            const bearBottom = candles[j].high;
            const cLow = Math.max(bearBottom, c3.high);
            const cHigh = Math.min(bearTop, c1.low);
            if (cHigh > cLow + cfg.overlap) {
              bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
              break;
            }
          }
        }
      }

      if (isBearishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBullish) {
            const bearTop = c3.low;
            const bearBottom = c1.high;
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.gap;
            const cLow = Math.max(bullBottom, bearBottom);
            const cHigh = Math.min(bullTop, bearTop);
            if (cHigh > cLow + cfg.overlap) {
              bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
              break;
            }
          }
        }
      }

      while (bprZones.length > 250) bprZones.shift();

      if (c0.time < WEEK_START || c0.time > WEEK_END) continue;
      if (i - lastTradeIdx < 4) continue;

      const hour = c0.time.getUTCHours();
      if (hour >= 22 || hour < 1) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

        if (bpr.type === 'BULLISH' && c0.close > c0.ema100) {
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - cfg.buffer) {
            const lowerWick = Math.min(c0.open, c0.close) - c0.low;
            if (lowerWick / candleRange < 0.25) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
            const slPrice = bpr.bottom - cfg.buffer;
            const slDist = entry - slPrice;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry + slDist;
            let won = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (candles[k].high >= tpPrice) { won = true; break; }
              if (candles[k].low <= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'XAUUSD',
              tf,
              type: 'BUY',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tpPrice,
              slPriceDiff: slDist,
              won
            });
            break;
          }
        } else if (bpr.type === 'BEARISH' && c0.close < c0.ema100) {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + cfg.buffer) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / candleRange < 0.25) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
            const slPrice = bpr.top + cfg.buffer;
            const slDist = slPrice - entry;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry - slDist;
            let won = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (candles[k].low <= tpPrice) { won = true; break; }
              if (candles[k].high >= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'XAUUSD',
              tf,
              type: 'SELL',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tpPrice,
              slPriceDiff: slDist,
              won
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 2. Extraer trades EURUSD (M2 + M3 + M5 + M15)
async function getEurusdTrades() {
  const TF_CONFIGS = {
    M2:  { file: 'EURUSD_M2_202001020600_202610011028.csv', gap: 0.00012, overlap: 0.00008, range: 0.00015, buffer: 1.2, slMinPips: 2.0 },
    M3:  { file: 'EURUSD_M3_202001020600_202610011027.csv', gap: 0.00015, overlap: 0.00010, range: 0.00018, buffer: 1.2, slMinPips: 2.0 },
    M5:  { file: 'EURUSD_M5_202001020600_202610011025.csv', gap: 0.00018, overlap: 0.00012, range: 0.00022, buffer: 1.5, slMinPips: 2.5 },
    M15: { file: 'EURUSD_M15_202001020600_202610011015.csv', gap: 0.00025, overlap: 0.00018, range: 0.00030, buffer: 2.0, slMinPips: 3.0 }
  };

  const trades = [];
  const pipMultiplier = 10000;

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandles(path.join(DATA_DIR, cfg.file));
    const bprZones = [];
    let lastTradeIdx = -100;

    for (let i = 3; i < candles.length; i++) {
      const c0 = candles[i], c1 = candles[i - 1], c2 = candles[i - 2], c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBullishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBearish) {
            const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + cfg.gap;
            const bearBottom = candles[j].high;
            const cLow = Math.max(bearBottom, c3.high);
            const cHigh = Math.min(bearTop, c1.low);
            if (cHigh > cLow + cfg.overlap) {
              bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
              break;
            }
          }
        }
      }

      if (isBearishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBullish) {
            const bearTop = c3.low;
            const bearBottom = c1.high;
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.gap;
            const cLow = Math.max(bullBottom, bearBottom);
            const cHigh = Math.min(bullTop, bearTop);
            if (cHigh > cLow + cfg.overlap) {
              bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
              break;
            }
          }
        }
      }

      while (bprZones.length > 250) bprZones.shift();

      if (c0.time < WEEK_START || c0.time > WEEK_END) continue;
      if (i - lastTradeIdx < 4) continue;

      const hour = c0.time.getUTCHours();
      if (hour < 7 || hour >= 19) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

        if (bpr.type === 'BULLISH') {
          const bufferPrice = cfg.buffer / pipMultiplier;
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
            const slPrice = bpr.bottom - bufferPrice;
            const slDist = entry - slPrice;
            if (slDist * pipMultiplier < cfg.slMinPips) continue;

            const tpPrice = entry + slDist;
            let won = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (candles[k].high >= tpPrice) { won = true; break; }
              if (candles[k].low <= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'EURUSD',
              tf,
              type: 'BUY',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tpPrice,
              slPriceDiff: slDist,
              won
            });
            break;
          }
        } else if (bpr.type === 'BEARISH') {
          const bufferPrice = cfg.buffer / pipMultiplier;
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
            const slPrice = bpr.top + bufferPrice;
            const slDist = slPrice - entry;
            if (slDist * pipMultiplier < cfg.slMinPips) continue;

            const tpPrice = entry - slDist;
            let won = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (candles[k].low <= tpPrice) { won = true; break; }
              if (candles[k].high >= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'EURUSD',
              tf,
              type: 'SELL',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tpPrice,
              slPriceDiff: slDist,
              won
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 3. Extraer trades GBPJPY (Ventas, M2 + M3 + M5 + M15)
async function getGbpjpyTrades() {
  const TF_CONFIGS = {
    M2:  { file: 'GBPJPY_M2_202001020600_202610011028.csv', gap: 0.035, overlap: 0.020, range: 0.040, buffer: 0.040, slMin: 0.060 },
    M3:  { file: 'GBPJPY_M3_202001020600_202610011027.csv', gap: 0.045, overlap: 0.025, range: 0.050, buffer: 0.050, slMin: 0.070 },
    M5:  { file: 'GBPJPY_M5_202001020600_202610011025.csv', gap: 0.060, overlap: 0.035, range: 0.070, buffer: 0.060, slMin: 0.090 },
    M15: { file: 'GBPJPY_M15_202001020600_202610011015.csv', gap: 0.100, overlap: 0.050, range: 0.120, buffer: 0.080, slMin: 0.120 }
  };

  const trades = [];

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandles(path.join(DATA_DIR, cfg.file));
    if (candles.length < 50) continue;

    const k = 2 / (100 + 1);
    let ema = candles[0].close;
    for (let c of candles) {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    }

    const bprZones = [];
    let lastTradeIdx = -100;

    for (let i = 3; i < candles.length; i++) {
      const c0 = candles[i], c1 = candles[i - 1], c2 = candles[i - 2], c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBearishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBullish) {
            const bearTop = c3.low;
            const bearBottom = c1.high;
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.gap;
            const cLow = Math.max(bullBottom, bearBottom);
            const cHigh = Math.min(bullTop, bearTop);
            if (cHigh > cLow + cfg.overlap) {
              bprZones.push({ top: cHigh, bottom: cLow, tested: false, createdIdx: i });
              break;
            }
          }
        }
      }

      while (bprZones.length > 250) bprZones.shift();

      if (c0.time < WEEK_START || c0.time > WEEK_END) continue;
      if (i - lastTradeIdx < 4) continue;

      const hour = c0.time.getUTCHours();
      if (hour < 6 || hour >= 18) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

        if (c0.close < c0.ema100) {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + cfg.buffer) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / candleRange < 0.20) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
            const slPrice = bpr.top + cfg.buffer;
            const slDist = slPrice - entry;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry - slDist;
            let won = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (candles[k].low <= tpPrice) { won = true; break; }
              if (candles[k].high >= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'GBPJPY',
              tf,
              type: 'SELL',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tpPrice,
              slPriceDiff: slDist,
              won
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 4. Extraer trades NAS100 (Compras, M2 + M3 + M5 + M15)
async function getNas100Trades() {
  const TF_CONFIGS = {
    M2:  { file: 'NAS100_M2_202001010300_202610011028.csv', gap: 7.0, overlap: 3.5, range: 8.0, buffer: 10.0, slMin: 14.0 },
    M3:  { file: 'NAS100_M3_202001010300_202610011027.csv', gap: 9.0, overlap: 4.5, range: 11.0, buffer: 12.0, slMin: 18.0 },
    M5:  { file: 'NAS100_M5_202001010300_202610011025.csv', gap: 12.0, overlap: 6.0, range: 15.0, buffer: 15.0, slMin: 22.0 },
    M15: { file: 'NAS100_M15_202001010300_202610011015.csv', gap: 20.0, overlap: 10.0, range: 25.0, buffer: 20.0, slMin: 30.0 }
  };

  const trades = [];

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandles(path.join(DATA_DIR, cfg.file));
    if (candles.length < 50) continue;

    const k = 2 / (100 + 1);
    let ema = candles[0].close;
    for (let c of candles) {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    }

    const bprZones = [];
    let lastTradeIdx = -100;

    for (let i = 3; i < candles.length; i++) {
      const c0 = candles[i], c1 = candles[i - 1], c2 = candles[i - 2], c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBullishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBearish) {
            const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + cfg.gap;
            const bearBottom = candles[j].high;
            const cLow = Math.max(bearBottom, c3.high);
            const cHigh = Math.min(bearTop, c1.low);
            if (cHigh > cLow + cfg.overlap) {
              bprZones.push({ top: cHigh, bottom: cLow, tested: false, createdIdx: i });
              break;
            }
          }
        }
      }

      while (bprZones.length > 250) bprZones.shift();

      if (c0.time < WEEK_START || c0.time > WEEK_END) continue;
      if (i - lastTradeIdx < 4) continue;

      const hour = c0.time.getUTCHours();
      if (hour < 13 || hour >= 20) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

        if (c0.close > c0.ema100) {
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - cfg.buffer) {
            const lowerWick = Math.min(c0.open, c0.close) - c0.low;
            if (lowerWick / candleRange < 0.20) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
            const slPrice = bpr.bottom - cfg.buffer;
            const slDist = entry - slPrice;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry + slDist;
            let won = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (candles[k].high >= tpPrice) { won = true; break; }
              if (candles[k].low <= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'NAS100',
              tf,
              type: 'BUY',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tpPrice,
              slPriceDiff: slDist,
              won
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// Cálculo del lotaje y PnL institucional para cada cuenta (0.75% riesgo por trade)
function calculateTradePnL(trade, balance, riskPercent = 0.75) {
  const riskUSD = balance * (riskPercent / 100);
  let lotSize = 0.01;
  let pnlUSD = 0;

  if (trade.symbol === 'XAUUSD') {
    // 1 USD move = $100 per 1 standard lot
    const dollarRisk = trade.slPriceDiff;
    lotSize = riskUSD / (dollarRisk * 100);
    lotSize = Math.max(0.01, Math.round(lotSize * 100) / 100);
    pnlUSD = trade.won ? (lotSize * dollarRisk * 100) : -(lotSize * dollarRisk * 100);
  } else if (trade.symbol === 'EURUSD') {
    // 1 pip = 0.0001 = $10 per 1 standard lot
    const pipsRisk = trade.slPriceDiff * 10000;
    lotSize = riskUSD / (pipsRisk * 10);
    lotSize = Math.max(0.01, Math.round(lotSize * 100) / 100);
    pnlUSD = trade.won ? (lotSize * pipsRisk * 10) : -(lotSize * pipsRisk * 10);
  } else if (trade.symbol === 'GBPJPY') {
    // 1 pip = 0.01 = approx $6.70 per 1 standard lot
    const pipsRisk = trade.slPriceDiff * 100;
    lotSize = riskUSD / (pipsRisk * 6.70);
    lotSize = Math.max(0.01, Math.round(lotSize * 100) / 100);
    pnlUSD = trade.won ? (lotSize * pipsRisk * 6.70) : -(lotSize * pipsRisk * 6.70);
  } else if (trade.symbol === 'NAS100') {
    // 1 point = $1 per 1 standard lot
    const pointsRisk = trade.slPriceDiff;
    lotSize = riskUSD / (pointsRisk * 1.0);
    lotSize = Math.max(0.01, Math.round(lotSize * 100) / 100);
    pnlUSD = trade.won ? (lotSize * pointsRisk * 1.0) : -(lotSize * pointsRisk * 1.0);
  }

  return { lotSize, pnlUSD };
}

async function run() {
  console.log('🔄 Analizando operativa institucional de ESTA SEMANA (28 Sep - 02 Oct 2026)...');
  const [gold, eurusd, gbpjpy, nas100] = await Promise.all([
    getGoldTrades(),
    getEurusdTrades(),
    getGbpjpyTrades(),
    getNas100Trades()
  ]);

  const allTrades = [...gold, ...eurusd, ...gbpjpy, ...nas100];
  allTrades.sort((a, b) => a.time.getTime() - b.time.getTime());

  console.log(`📊 Operaciones encontradas esta semana: ${allTrades.length} trades`);
  console.log(`   • Oro (XAUUSD Sweet Spot): ${gold.length} trades`);
  console.log(`   • EURUSD:                  ${eurusd.length} trades`);
  console.log(`   • GBPJPY (Ventas):          ${gbpjpy.length} trades`);
  console.log(`   • NAS100 (Compras):         ${nas100.length} trades`);

  // SIMULACIÓN CUENTA 5K (The5ers)
  let bal5k = 5000.00;
  let peak5k = 5000.00;
  let maxDD5k = 0.00;
  const days5k = {};

  // SIMULACIÓN CUENTA 100K (FTMO)
  let bal100k = 100000.00;
  let peak100k = 100000.00;
  let maxDD100k = 0.00;
  const days100k = {};

  for (const t of allTrades) {
    const day = t.time.toISOString().substring(0, 10);
    if (!days5k[day]) days5k[day] = { pnl: 0, trades: 0, wins: 0, losses: 0, gold: 0, eur: 0, gbp: 0, nas: 0 };
    if (!days100k[day]) days100k[day] = { pnl: 0, trades: 0, wins: 0, losses: 0, gold: 0, eur: 0, gbp: 0, nas: 0 };

    // Cuenta 5k
    const sim5k = calculateTradePnL(t, bal5k, 0.75);
    bal5k += sim5k.pnlUSD;
    if (bal5k > peak5k) peak5k = bal5k;
    const dd5k = peak5k - bal5k;
    if (dd5k > maxDD5k) maxDD5k = dd5k;

    days5k[day].trades++;
    days5k[day].pnl += sim5k.pnlUSD;
    if (t.won) days5k[day].wins++; else days5k[day].losses++;
    if (t.symbol === 'XAUUSD') days5k[day].gold++;
    if (t.symbol === 'EURUSD') days5k[day].eur++;
    if (t.symbol === 'GBPJPY') days5k[day].gbp++;
    if (t.symbol === 'NAS100') days5k[day].nas++;

    // Cuenta 100k
    const sim100k = calculateTradePnL(t, bal100k, 0.75);
    bal100k += sim100k.pnlUSD;
    if (bal100k > peak100k) peak100k = bal100k;
    const dd100k = peak100k - bal100k;
    if (dd100k > maxDD100k) maxDD100k = dd100k;

    days100k[day].trades++;
    days100k[day].pnl += sim100k.pnlUSD;
    if (t.won) days100k[day].wins++; else days100k[day].losses++;
    if (t.symbol === 'XAUUSD') days100k[day].gold++;
    if (t.symbol === 'EURUSD') days100k[day].eur++;
    if (t.symbol === 'GBPJPY') days100k[day].gbp++;
    if (t.symbol === 'NAS100') days100k[day].nas++;
  }

  const winsTotal = allTrades.filter(t => t.won).length;
  const lossTotal = allTrades.length - winsTotal;
  const winRate = ((winsTotal / allTrades.length) * 100).toFixed(1);

  console.log('\n================================================================================');
  console.log('🏛️ CUENTA 1: 5K PROP FIRM (The5ers - $5,000 USD Inicial | 0.75% Riesgo)');
  console.log('================================================================================');
  console.log(`Saldo Inicial:      $5,000.00 USD`);
  console.log(`Saldo Final:        $${bal5k.toFixed(2)} USD`);
  console.log(`Beneficio Neto:     +$${(bal5k - 5000).toFixed(2)} USD (+${((bal5k - 5000)/5000*100).toFixed(2)}%)`);
  console.log(`Máximo Drawdown:    -$${maxDD5k.toFixed(2)} USD (-${((maxDD5k/5000)*100).toFixed(2)}%)`);
  console.log(`Meta Fase 1 ($5,500): ${bal5k >= 5500 ? '✅ ¡OBJETIVO ALCANZADO Y SUPERADO!' : '⏳ En progreso'}`);

  console.log('\n📅 Desglose Diario Cuenta 5K:');
  for (const [day, d] of Object.entries(days5k)) {
    const sign = d.pnl >= 0 ? '+' : '';
    console.log(`  ${day} | ${String(d.trades).padStart(2)} trades (${d.wins}W/${d.losses}L) | ${String(d.gold).padStart(2)} XAU / ${String(d.eur).padStart(2)} EUR / ${String(d.gbp).padStart(2)} GBP / ${String(d.nas).padStart(2)} NAS | ${sign}$${d.pnl.toFixed(2).padStart(7)} USD`);
  }

  console.log('\n================================================================================');
  console.log('🏛️ CUENTA 2: 100K PROP FIRM (FTMO - $100,000 USD Inicial | 0.75% Riesgo)');
  console.log('================================================================================');
  console.log(`Saldo Inicial:      $100,000.00 USD`);
  console.log(`Saldo Final:        $${bal100k.toFixed(2)} USD`);
  console.log(`Beneficio Neto:     +$${(bal100k - 100000).toFixed(2)} USD (+${((bal100k - 100000)/100000*100).toFixed(2)}%)`);
  console.log(`Máximo Drawdown:    -$${maxDD100k.toFixed(2)} USD (-${((maxDD100k/100000)*100).toFixed(2)}%)`);
  console.log(`Meta Fase 1 ($110,000): ${bal100k >= 110000 ? '✅ ¡OBJETIVO ALCANZADO Y SUPERADO!' : '⏳ En progreso'}`);

  console.log('\n📅 Desglose Diario Cuenta 100K:');
  for (const [day, d] of Object.entries(days100k)) {
    const sign = d.pnl >= 0 ? '+' : '';
    console.log(`  ${day} | ${String(d.trades).padStart(2)} trades (${d.wins}W/${d.losses}L) | ${String(d.gold).padStart(2)} XAU / ${String(d.eur).padStart(2)} EUR / ${String(d.gbp).padStart(2)} GBP / ${String(d.nas).padStart(2)} NAS | ${sign}$${d.pnl.toFixed(2).padStart(9)} USD`);
  }

  console.log('\n================================================================================');
  console.log(`📈 ESTADÍSTICAS TOTALES DE LA SEMANA:`);
  console.log(`   • Total Operaciones: ${allTrades.length} (${winsTotal} Wins / ${lossTotal} Losses)`);
  console.log(`   • Win Rate Global:   ${winRate}%`);
  console.log('================================================================================');
}

run().catch(console.error);
