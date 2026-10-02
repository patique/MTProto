const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', '..');

// Cargar velas de los últimos 20 días para análisis exhaustivo (14 Sep - 01 Oct 2026)
const START_DATE = new Date('2026-09-12T00:00:00Z');
const EVAL_START = new Date('2026-09-14T00:00:00Z');

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
    if (dateStr < '2026.09.05' && dateStr < '2026-09-05') continue;

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

// 1. Extraer trades Gold (M2, M3, M5)
async function getGoldTrades(rr = 1.0, spreadPenaltyPips = 0) {
  const TF_CONFIGS = {
    M2: { file: 'XAUUSD_M2_202001020600_202610011120.csv', gap: 0.70, overlap: 0.40, range: 0.80, buffer: 1.20, slMin: 1.80 },
    M3: { file: 'XAUUSD_M3_202001020600_202610011121.csv', gap: 0.80, overlap: 0.50, range: 1.00, buffer: 1.50, slMin: 2.00 },
    M5: { file: 'XAUUSD_M5_202001020600_202610011120.csv', gap: 1.20, overlap: 0.70, range: 1.40, buffer: 2.00, slMin: 2.50 }
  };
  const trades = [];
  const pipMultiplier = 10;
  const spreadPricePenalty = spreadPenaltyPips / pipMultiplier;

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
      if (c0.time < EVAL_START) continue;
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

            const entry = ((bpr.top + bpr.bottom) / 2.0) + spreadPricePenalty;
            const slPrice = (bpr.bottom - cfg.buffer);
            const slDist = entry - slPrice;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry + (slDist * rr);
            let won = false;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              if (candles[k].high >= tpPrice) { won = true; break; }
              if (candles[k].low <= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'XAUUSD',
              tf,
              type: 'BUY',
              time: c0.time,
              hour,
              slDist: slDist * pipMultiplier,
              won,
              pips: won ? (slDist * rr * pipMultiplier) : -(slDist * pipMultiplier)
            });
            break;
          }
        } else if (bpr.type === 'BEARISH' && c0.close < c0.ema100) {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + cfg.buffer) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / candleRange < 0.25) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = ((bpr.top + bpr.bottom) / 2.0) - spreadPricePenalty;
            const slPrice = (bpr.top + cfg.buffer);
            const slDist = slPrice - entry;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry - (slDist * rr);
            let won = false;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              if (candles[k].low <= tpPrice) { won = true; break; }
              if (candles[k].high >= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'XAUUSD',
              tf,
              type: 'SELL',
              time: c0.time,
              hour,
              slDist: slDist * pipMultiplier,
              won,
              pips: won ? (slDist * rr * pipMultiplier) : -(slDist * pipMultiplier)
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 2. Extraer trades EURUSD
async function getEurusdTrades(rr = 1.0, spreadPenaltyPips = 0) {
  const TF_CONFIGS = {
    M2:  { file: 'EURUSD_M2_202001020600_202610011028.csv', gap: 0.00012, overlap: 0.00008, range: 0.00015, buffer: 1.2, slMinPips: 2.0 },
    M3:  { file: 'EURUSD_M3_202001020600_202610011027.csv', gap: 0.00015, overlap: 0.00010, range: 0.00018, buffer: 1.2, slMinPips: 2.0 },
    M5:  { file: 'EURUSD_M5_202001020600_202610011025.csv', gap: 0.00018, overlap: 0.00012, range: 0.00022, buffer: 1.5, slMinPips: 2.5 },
    M15: { file: 'EURUSD_M15_202001020600_202610011015.csv', gap: 0.00025, overlap: 0.00018, range: 0.00030, buffer: 2.0, slMinPips: 3.0 }
  };
  const trades = [];
  const pipMultiplier = 10000;
  const spreadPricePenalty = spreadPenaltyPips / pipMultiplier;

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
      if (c0.time < EVAL_START) continue;
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

            const entry = ((bpr.top + bpr.bottom) / 2.0) + spreadPricePenalty;
            const slPrice = bpr.bottom - bufferPrice;
            const slDist = entry - slPrice;
            if (slDist * pipMultiplier < cfg.slMinPips) continue;

            const tpPrice = entry + (slDist * rr);
            let won = false;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              if (candles[k].high >= tpPrice) { won = true; break; }
              if (candles[k].low <= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'EURUSD',
              tf,
              type: 'BUY',
              time: c0.time,
              hour,
              slDist: slDist * pipMultiplier,
              won,
              pips: won ? (slDist * rr * pipMultiplier) : -(slDist * pipMultiplier)
            });
            break;
          }
        } else if (bpr.type === 'BEARISH') {
          const bufferPrice = cfg.buffer / pipMultiplier;
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
            bpr.tested = true;
            lastTradeIdx = i;

            const entry = ((bpr.top + bpr.bottom) / 2.0) - spreadPricePenalty;
            const slPrice = bpr.top + bufferPrice;
            const slDist = slPrice - entry;
            if (slDist * pipMultiplier < cfg.slMinPips) continue;

            const tpPrice = entry - (slDist * rr);
            let won = false;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              if (candles[k].low <= tpPrice) { won = true; break; }
              if (candles[k].high >= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'EURUSD',
              tf,
              type: 'SELL',
              time: c0.time,
              hour,
              slDist: slDist * pipMultiplier,
              won,
              pips: won ? (slDist * rr * pipMultiplier) : -(slDist * pipMultiplier)
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 3. Extraer trades GBPJPY (Shorts only)
async function getGbpjpyTrades(rr = 1.0, spreadPenaltyPips = 0) {
  const TF_CONFIGS = {
    M2:  { file: 'GBPJPY_M2_202001020600_202610011028.csv', gap: 0.035, overlap: 0.020, range: 0.040, buffer: 0.040, slMin: 0.060 },
    M3:  { file: 'GBPJPY_M3_202001020600_202610011027.csv', gap: 0.045, overlap: 0.025, range: 0.050, buffer: 0.050, slMin: 0.070 },
    M5:  { file: 'GBPJPY_M5_202001020600_202610011025.csv', gap: 0.060, overlap: 0.035, range: 0.070, buffer: 0.060, slMin: 0.090 },
    M15: { file: 'GBPJPY_M15_202001020600_202610011015.csv', gap: 0.100, overlap: 0.050, range: 0.120, buffer: 0.080, slMin: 0.120 }
  };
  const trades = [];
  const pipMultiplier = 100;
  const spreadPricePenalty = spreadPenaltyPips / pipMultiplier;

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
      if (c0.time < EVAL_START) continue;
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

            const entry = ((bpr.top + bpr.bottom) / 2.0) - spreadPricePenalty;
            const slPrice = bpr.top + cfg.buffer;
            const slDist = slPrice - entry;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry - (slDist * rr);
            let won = false;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              if (candles[k].low <= tpPrice) { won = true; break; }
              if (candles[k].high >= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'GBPJPY',
              tf,
              type: 'SELL',
              time: c0.time,
              hour,
              slDist: slDist * pipMultiplier,
              won,
              pips: won ? (slDist * rr * pipMultiplier) : -(slDist * pipMultiplier)
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 4. Extraer trades NAS100 (Longs only)
async function getNas100Trades(rr = 1.0, spreadPenaltyPts = 0) {
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
      if (c0.time < EVAL_START) continue;
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

            const entry = ((bpr.top + bpr.bottom) / 2.0) + spreadPenaltyPts;
            const slPrice = bpr.bottom - cfg.buffer;
            const slDist = entry - slPrice;
            if (slDist < cfg.slMin) continue;

            const tpPrice = entry + (slDist * rr);
            let won = false;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              if (candles[k].high >= tpPrice) { won = true; break; }
              if (candles[k].low <= slPrice) { won = false; break; }
            }

            trades.push({
              symbol: 'NAS100',
              tf,
              type: 'BUY',
              time: c0.time,
              hour,
              slDist,
              won,
              pips: won ? (slDist * rr) : -slDist
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

function calcMetrics(trades) {
  if (trades.length === 0) return { count: 0, wr: '0.0%', pf: '0.00', netPips: 0, maxLossStreak: 0 };
  const wins = trades.filter(t => t.won);
  const losses = trades.filter(t => !t.won);
  const wr = ((wins.length / trades.length) * 100).toFixed(1) + '%';
  const grossWon = wins.reduce((acc, t) => acc + Math.abs(t.pips), 0);
  const grossLost = losses.reduce((acc, t) => acc + Math.abs(t.pips), 0);
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.9';
  const netPips = (grossWon - grossLost).toFixed(1);

  // Racha de pérdidas consecutivas
  let maxStreak = 0, currentStreak = 0;
  for (const t of trades) {
    if (!t.won) {
      currentStreak++;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  return { count: trades.length, wins: wins.length, losses: losses.length, wr, pf, netPips, maxStreak };
}

async function runStressAnalysis() {
  console.log('🔄 Iniciando auditoría cuantitativa y de estrés...');

  const [goldBase, eurBase, gbpBase, nasBase] = await Promise.all([
    getGoldTrades(1.0, 0),
    getEurusdTrades(1.0, 0),
    getGbpjpyTrades(1.0, 0),
    getNas100Trades(1.0, 0)
  ]);
  const allBase = [...goldBase, ...eurBase, ...gbpBase, ...nasBase];
  allBase.sort((a, b) => a.time.getTime() - b.time.getTime());

  console.log('\n========================================================================================');
  console.log('📊 1. CASO BASE (Condiciones Normales de Mercado): 14/09 al 01/10');
  console.log('========================================================================================');
  console.log('Portfolio Completo:', calcMetrics(allBase));
  console.log('• XAUUSD (M2+M3+M5):', calcMetrics(goldBase));
  console.log('• EURUSD (M2-M15):  ', calcMetrics(eurBase));
  console.log('• GBPJPY (Ventas):  ', calcMetrics(gbpBase));
  console.log('• NAS100 (Compras): ', calcMetrics(nasBase));

  // -----------------------------------------------------------------------------------
  // TEST DE ESTRÉS 1: DEGRADACIÓN DE SPREAD Y SLIPPAGE ADVERSO
  // -----------------------------------------------------------------------------------
  console.log('\n========================================================================================');
  console.log('🌪️ 2. PRUEBA DE ESTRÉS: DEGRADACIÓN POR SPREAD Y DESLIZAMIENTO (SLIPPAGE)');
  console.log('========================================================================================');

  // Nivel 1: +50% spread (+1.0 pip Gold, +0.3 pip EUR, +1.0 pip GBP, +1.0 pt NAS)
  const [goldS1, eurS1, gbpS1, nasS1] = await Promise.all([
    getGoldTrades(1.0, 1.0),
    getEurusdTrades(1.0, 0.3),
    getGbpjpyTrades(1.0, 1.0),
    getNas100Trades(1.0, 1.0)
  ]);
  const allS1 = [...goldS1, ...eurS1, ...gbpS1, ...nasS1].sort((a,b)=>a.time.getTime()-b.time.getTime());

  // Nivel 2: +100% spread (+2.0 pips Gold, +0.6 pip EUR, +2.0 pips GBP, +2.5 pts NAS)
  const [goldS2, eurS2, gbpS2, nasS2] = await Promise.all([
    getGoldTrades(1.0, 2.0),
    getEurusdTrades(1.0, 0.6),
    getGbpjpyTrades(1.0, 2.0),
    getNas100Trades(1.0, 2.5)
  ]);
  const allS2 = [...goldS2, ...eurS2, ...gbpS2, ...nasS2].sort((a,b)=>a.time.getTime()-b.time.getTime());

  // Nivel 3: Volatilidad Extrema (+3.5 pips Gold, +1.2 pips EUR, +3.5 pips GBP, +4.0 pts NAS)
  const [goldS3, eurS3, gbpS3, nasS3] = await Promise.all([
    getGoldTrades(1.0, 3.5),
    getEurusdTrades(1.0, 1.2),
    getGbpjpyTrades(1.0, 3.5),
    getNas100Trades(1.0, 4.0)
  ]);
  const allS3 = [...goldS3, ...eurS3, ...gbpS3, ...nasS3].sort((a,b)=>a.time.getTime()-b.time.getTime());

  console.log('Condición                          | Ops | Win Rate | Profit Factor | Pips/Pts Netos | Max Racha SL');
  console.log('-----------------------------------+-----+----------+---------------+----------------+-------------');
  console.log(`Base (Spreads Institucionales)     | ${String(allBase.length).padStart(3)} | ${calcMetrics(allBase).wr.padStart(8)} | ${calcMetrics(allBase).pf.padStart(13)} | ${calcMetrics(allBase).netPips.padStart(14)} | ${calcMetrics(allBase).maxStreak}`);
  console.log(`Estrés Nivel 1 (Spread +50%)       | ${String(allS1.length).padStart(3)} | ${calcMetrics(allS1).wr.padStart(8)} | ${calcMetrics(allS1).pf.padStart(13)} | ${calcMetrics(allS1).netPips.padStart(14)} | ${calcMetrics(allS1).maxStreak}`);
  console.log(`Estrés Nivel 2 (Spread +100%)      | ${String(allS2.length).padStart(3)} | ${calcMetrics(allS2).wr.padStart(8)} | ${calcMetrics(allS2).pf.padStart(13)} | ${calcMetrics(allS2).netPips.padStart(14)} | ${calcMetrics(allS2).maxStreak}`);
  console.log(`Estrés Nivel 3 (Volatilidad Spikes)| ${String(allS3.length).padStart(3)} | ${calcMetrics(allS3).wr.padStart(8)} | ${calcMetrics(allS3).pf.padStart(13)} | ${calcMetrics(allS3).netPips.padStart(14)} | ${calcMetrics(allS3).maxStreak}`);

  // -----------------------------------------------------------------------------------
  // TEST DE ESTRÉS 2: CLÚSTERES DE PÉRDIDAS SIMULTÁNEAS Y PEOR DRAWDOWN DIARIO
  // -----------------------------------------------------------------------------------
  console.log('\n========================================================================================');
  console.log('📉 3. ANÁLISIS DE CLÚSTERES DE PÉRDIDAS DIARIAS (PEOR SESIÓN DE MERCADO)');
  console.log('========================================================================================');
  const days = {};
  for (const t of allBase) {
    const d = t.time.toISOString().substring(0, 10);
    if (!days[d]) days[d] = { total: 0, wins: 0, losses: 0, pips: 0, maxLossStreak: 0 };
    days[d].total++;
    if (t.won) days[d].wins++; else days[d].losses++;
    days[d].pips += t.pips;
  }

  console.log('Fecha      | Total Ops | Wins / Losses | Win Rate | Pips Netos | Impacto Sesión');
  console.log('-----------+-----------+---------------+----------+------------+---------------------------');
  for (const [d, stat] of Object.entries(days)) {
    const wr = ((stat.wins / stat.total) * 100).toFixed(1);
    const sign = stat.pips >= 0 ? '+' : '';
    const verdict = stat.pips < 0 ? '⚠️ Sesión Negativa' : (wr >= 80 ? '🔥 Sesión Excelente' : '✅ Sesión Positiva');
    console.log(`${d} | ${String(stat.total).padStart(9)} | ${String(stat.wins).padStart(5)} / ${String(stat.losses).padStart(6)} | ${wr.padStart(7)}% | ${sign}${stat.pips.toFixed(1).padStart(9)}p | ${verdict}`);
  }

  // -----------------------------------------------------------------------------------
  // TEST DE ESTRÉS 3: SENSIBILIDAD DEL RATIO RIESGO:BENEFICIO (R:R SPECTRUM)
  // -----------------------------------------------------------------------------------
  console.log('\n========================================================================================');
  console.log('🎯 4. BÚSQUEDA DE MEJORA: ESPECTRO DE RATIOS R:R (0.8 vs 1.0 vs 1.2 vs 1.5 vs 2.0)');
  console.log('========================================================================================');
  for (const testRR of [0.8, 1.0, 1.2, 1.5, 2.0]) {
    const [gRR, eRR, jRR, nRR] = await Promise.all([
      getGoldTrades(testRR, 0),
      getEurusdTrades(testRR, 0),
      getGbpjpyTrades(testRR, 0),
      getNas100Trades(testRR, 0)
    ]);
    const allRR = [...gRR, ...eRR, ...jRR, ...nRR];
    const m = calcMetrics(allRR);
    console.log(`Ratio R:R 1:${testRR.toFixed(1)} -> Win Rate: ${m.wr.padStart(6)} | Profit Factor: ${m.pf.padStart(5)} | Pips Netos: ${m.netPips.padStart(8)}p | Max Racha Pérdidas: ${m.maxStreak}`);
  }

  // -----------------------------------------------------------------------------------
  // TEST DE ESTRÉS 4: ANÁLISIS DE EFICIENCIA POR HORA UTC (DETECCIÓN DE MERMAS/FUGAS)
  // -----------------------------------------------------------------------------------
  console.log('\n========================================================================================');
  console.log('⏰ 5. ANÁLISIS HORARIO (DETECCIÓN DE MERMAS Y MEJORES VENTANAS DE LIQUIDEZ)');
  console.log('========================================================================================');
  const hourly = {};
  for (let h = 0; h < 24; h++) hourly[h] = { total: 0, wins: 0, losses: 0, pips: 0 };
  for (const t of allBase) {
    hourly[t.hour].total++;
    if (t.won) hourly[t.hour].wins++; else hourly[t.hour].losses++;
    hourly[t.hour].pips += t.pips;
  }

  console.log('Hora UTC | Ops | Wins / Losses | Win Rate | Pips Netos | Diagnóstico de Rendimiento');
  console.log('---------+-----+---------------+----------+------------+-----------------------------------');
  for (let h = 0; h < 24; h++) {
    const stat = hourly[h];
    if (stat.total === 0) continue;
    const wr = ((stat.wins / stat.total) * 100).toFixed(1);
    const sign = stat.pips >= 0 ? '+' : '';
    let diag = '✅ Estable';
    if (stat.pips < 0) diag = '🚨 MERMA / FUGA (Pérdida Neta)';
    else if (wr >= 90) diag = '💎 Sweet Spot de Alta Eficiencia';
    else if (wr < 70) diag = '⚠️ Rendimiento Débil';
    console.log(`${String(h).padStart(2)}:00 UTC | ${String(stat.total).padStart(3)} | ${String(stat.wins).padStart(5)} / ${String(stat.losses).padStart(6)} | ${wr.padStart(7)}% | ${sign}${stat.pips.toFixed(1).padStart(9)}p | ${diag}`);
  }
}

runStressAnalysis().catch(console.error);
