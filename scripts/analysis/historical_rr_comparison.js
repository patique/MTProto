const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', '..');

async function loadCandlesForWindow(filePath, warmupDateStr, endDateStr) {
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
    if (dateStr < warmupDateStr) continue;
    if (dateStr > endDateStr) break;

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

// 1. Simulación Gold (M2, M3, M5)
async function simulateGold(warmupStr, evalStartStr, endStr, rr = 1.0) {
  const TF_CONFIGS = {
    M2: { file: 'XAUUSD_M2_202001020600_202610011120.csv', gap: 0.70, overlap: 0.40, range: 0.80, buffer: 1.20, slMin: 1.80 },
    M3: { file: 'XAUUSD_M3_202001020600_202610011121.csv', gap: 0.80, overlap: 0.50, range: 1.00, buffer: 1.50, slMin: 2.00 },
    M5: { file: 'XAUUSD_M5_202001020600_202610011120.csv', gap: 1.20, overlap: 0.70, range: 1.40, buffer: 2.00, slMin: 2.50 }
  };
  const trades = [];
  const pipMultiplier = 10;
  const evalStartMs = new Date(`${evalStartStr}T00:00:00Z`).getTime();

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandlesForWindow(path.join(DATA_DIR, cfg.file), warmupStr, endStr);
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
      if (c0.timeMs < evalStartMs) continue;
      if (i - lastTradeIdx < 4) continue;

      const hour = c0.time.getUTCHours();
      if (hour < 1 || hour >= 22) continue;

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
              slDistPips: slDist * pipMultiplier,
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

            const entry = (bpr.top + bpr.bottom) / 2.0;
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
              symbol: 'XAUUSD',
              tf,
              type: 'SELL',
              time: c0.time,
              hour,
              slDistPips: slDist * pipMultiplier,
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

// 2. Simulación EURUSD (M2, M3, M5, M15)
async function simulateEurusd(warmupStr, evalStartStr, endStr, rr = 1.0) {
  const TF_CONFIGS = {
    M2:  { file: 'EURUSD_M2_202001020600_202610011028.csv', gap: 0.00012, overlap: 0.00008, range: 0.00015, buffer: 1.2, slMinPips: 2.0 },
    M3:  { file: 'EURUSD_M3_202001020600_202610011027.csv', gap: 0.00015, overlap: 0.00010, range: 0.00018, buffer: 1.2, slMinPips: 2.0 },
    M5:  { file: 'EURUSD_M5_202001020600_202610011025.csv', gap: 0.00018, overlap: 0.00012, range: 0.00022, buffer: 1.5, slMinPips: 2.5 },
    M15: { file: 'EURUSD_M15_202001020600_202610011015.csv', gap: 0.00025, overlap: 0.00018, range: 0.00030, buffer: 2.0, slMinPips: 3.0 }
  };
  const trades = [];
  const pipMultiplier = 10000;
  const evalStartMs = new Date(`${evalStartStr}T00:00:00Z`).getTime();

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandlesForWindow(path.join(DATA_DIR, cfg.file), warmupStr, endStr);
    if (candles.length < 50) continue;

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
      if (c0.timeMs < evalStartMs) continue;
      if (i - lastTradeIdx < 4) continue;

      const hour = c0.time.getUTCHours();
      if (hour < 6 || hour >= 20) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

        if (bpr.type === 'BULLISH') {
          const bufferPrice = cfg.buffer / pipMultiplier;
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
            const lowerWick = Math.min(c0.open, c0.close) - c0.low;
            if (lowerWick / candleRange < 0.20) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
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
              slDistPips: slDist * pipMultiplier,
              won,
              pips: won ? (slDist * rr * pipMultiplier) : -(slDist * pipMultiplier)
            });
            break;
          }
        } else if (bpr.type === 'BEARISH') {
          const bufferPrice = cfg.buffer / pipMultiplier;
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / candleRange < 0.20) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2.0;
            const slPrice = bpr.top + bufferPrice;
            const slDist = slPrice - entry;
            if (slDist * pipMultiplier < cfg.slMinPips) continue;

            const tpPrice = entry + (slDist * rr);
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
              slDistPips: slDist * pipMultiplier,
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

// 3. Simulación GBPJPY (M2, M3, M5, M15) - Sells only
async function simulateGbpjpy(warmupStr, evalStartStr, endStr, rr = 1.0) {
  const TF_CONFIGS = {
    M2:  { file: 'GBPJPY_M2_202001020600_202610011028.csv', gap: 0.08, overlap: 0.04, range: 0.10, buffer: 0.15, slMin: 0.25 },
    M3:  { file: 'GBPJPY_M3_202001020600_202610011027.csv', gap: 0.10, overlap: 0.05, range: 0.12, buffer: 0.18, slMin: 0.30 },
    M5:  { file: 'GBPJPY_M5_202001020600_202610011025.csv', gap: 0.14, overlap: 0.07, range: 0.16, buffer: 0.22, slMin: 0.35 },
    M15: { file: 'GBPJPY_M15_202001020600_202610011015.csv', gap: 0.22, overlap: 0.11, range: 0.25, buffer: 0.30, slMin: 0.45 }
  };
  const trades = [];
  const pipMultiplier = 100;
  const evalStartMs = new Date(`${evalStartStr}T00:00:00Z`).getTime();

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandlesForWindow(path.join(DATA_DIR, cfg.file), warmupStr, endStr);
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
      if (c0.timeMs < evalStartMs) continue;
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
              slDistPips: slDist * pipMultiplier,
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

// 4. Simulación NAS100 (M2, M3, M5, M15) - Buys only
async function simulateNas100(warmupStr, evalStartStr, endStr, rr = 1.0) {
  const TF_CONFIGS = {
    M2:  { file: 'NAS100_M2_202001010300_202610011028.csv', gap: 7.0, overlap: 3.5, range: 8.0, buffer: 10.0, slMin: 14.0 },
    M3:  { file: 'NAS100_M3_202001010300_202610011027.csv', gap: 9.0, overlap: 4.5, range: 11.0, buffer: 12.0, slMin: 18.0 },
    M5:  { file: 'NAS100_M5_202001010300_202610011025.csv', gap: 12.0, overlap: 6.0, range: 15.0, buffer: 15.0, slMin: 22.0 },
    M15: { file: 'NAS100_M15_202001010300_202610011015.csv', gap: 20.0, overlap: 10.0, range: 25.0, buffer: 20.0, slMin: 30.0 }
  };
  const trades = [];
  const evalStartMs = new Date(`${evalStartStr}T00:00:00Z`).getTime();

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandlesForWindow(path.join(DATA_DIR, cfg.file), warmupStr, endStr);
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
      if (c0.timeMs < evalStartMs) continue;
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
              slDistPips: slDist,
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

function evaluateStats(tradesList) {
  let wins = 0, losses = 0;
  let grossWonPips = 0, grossLostPips = 0;
  let simulatedEur5k = 0, simulatedEur100k = 0;
  let maxLossStreak = 0, currentLossStreak = 0;
  let peakEur5k = 0, maxDdEur5k = 0;

  for (const t of tradesList) {
    if (t.won) {
      wins++;
      currentLossStreak = 0;
      grossWonPips += t.pips;
    } else {
      losses++;
      currentLossStreak++;
      if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
      grossLostPips += Math.abs(t.pips);
    }

    let eur5kTrade = 0;
    if (t.symbol === 'XAUUSD') eur5kTrade = 0.10 * 10 * t.pips;
    else if (t.symbol === 'EURUSD') eur5kTrade = 1.00 * 10 * t.pips;
    else if (t.symbol === 'GBPJPY') eur5kTrade = 1.00 * 6.5 * t.pips;
    else if (t.symbol === 'NAS100') eur5kTrade = 1.00 * 1.0 * t.pips;

    simulatedEur5k += eur5kTrade;
    simulatedEur100k += eur5kTrade * 20.0;

    if (simulatedEur5k > peakEur5k) peakEur5k = simulatedEur5k;
    const currentDd = peakEur5k - simulatedEur5k;
    if (currentDd > maxDdEur5k) maxDdEur5k = currentDd;
  }

  const wr = tradesList.length > 0 ? ((wins / tradesList.length) * 100).toFixed(1) + '%' : '0.0%';
  const pf = grossLostPips > 0 ? (grossWonPips / grossLostPips).toFixed(2) : '99.9';
  const netPips = (grossWonPips - grossLostPips).toFixed(1);

  return {
    ops: tradesList.length,
    wins,
    losses,
    wr,
    pf,
    netPips: parseFloat(netPips),
    maxLossStreak,
    eur5k: Math.round(simulatedEur5k),
    eur100k: Math.round(simulatedEur100k),
    maxDd5k: Math.round(maxDdEur5k),
    maxDdPct: ((maxDdEur5k / 5000) * 100).toFixed(2) + '%'
  };
}

const TEST_PERIODS = [
  { name: 'Periodo 1: 2021 Lateral', warmup: '2021.04.15', evalStart: '2021.05.03', end: '2021.06.18' },
  { name: 'Periodo 2: 2022 Bear / Inflación', warmup: '2022.08.15', evalStart: '2022.09.05', end: '2022.10.21' },
  { name: 'Periodo 3: 2023 Crisis SVB', warmup: '2023.02.10', evalStart: '2023.03.01', end: '2023.04.14' },
  { name: 'Periodo 4: 2024 Bull AI', warmup: '2024.01.15', evalStart: '2024.02.05', end: '2024.03.22' },
  { name: 'Periodo 5: 2025 Consolidación', warmup: '2025.09.15', evalStart: '2025.10.06', end: '2025.11.21' },
  { name: 'Periodo 6: 2026 Reciente (90d)', warmup: '2026.06.15', evalStart: '2026.07.01', end: '2026.10.01' }
];

async function runRrHistoricalAudit() {
  console.log('========================================================================================================');
  console.log('⚖️ AUDITORÍA HISTÓRICA MULTI-AÑO: RATIO R:R 1:1.0 vs RATIO R:R 1:1.5');
  console.log('   Simulación rigurosa sobre los 6 periodos históricos (Oro, EURUSD, GBPJPY, NAS100)');
  console.log('========================================================================================================\n');

  const comparison = [];

  for (const p of TEST_PERIODS) {
    console.log(`⏳ Simulando ${p.name}...`);
    // Correr con RR = 1.0
    const [g10, e10, j10, n10] = await Promise.all([
      simulateGold(p.warmup, p.evalStart, p.end, 1.0),
      simulateEurusd(p.warmup, p.evalStart, p.end, 1.0),
      simulateGbpjpy(p.warmup, p.evalStart, p.end, 1.0),
      simulateNas100(p.warmup, p.evalStart, p.end, 1.0)
    ]);
    const all10 = [...g10, ...e10, ...j10, ...n10].sort((a,b)=>a.time.getTime()-b.time.getTime());
    const stats10 = evaluateStats(all10);

    // Correr con RR = 1.5
    const [g15, e15, j15, n15] = await Promise.all([
      simulateGold(p.warmup, p.evalStart, p.end, 1.5),
      simulateEurusd(p.warmup, p.evalStart, p.end, 1.5),
      simulateGbpjpy(p.warmup, p.evalStart, p.end, 1.5),
      simulateNas100(p.warmup, p.evalStart, p.end, 1.5)
    ]);
    const all15 = [...g15, ...e15, ...j15, ...n15].sort((a,b)=>a.time.getTime()-b.time.getTime());
    const stats15 = evaluateStats(all15);

    comparison.push({ period: p.name, s10: stats10, s15: stats15 });
  }

  console.log('\n========================================================================================================================');
  console.log('📊 TABLA COMPARATIVA: R:R 1:1.0 vs R:R 1:1.5 POR RÉGIMEN HISTÓRICO');
  console.log('========================================================================================================================');
  console.log('Periodo Histórico              | WR 1:1.0 vs 1:1.5 | PF 1:1.0 vs 1:1.5 | Pips Netos: 1:1.0 -> 1:1.5 | PnL 5k: 1:1.0 -> 1:1.5    | PnL 100k: 1:1.0 -> 1:1.5  | Max DD (5k)');
  console.log('-------------------------------+-------------------+-------------------+----------------------------+---------------------------+---------------------------+-------------');

  let totPips10 = 0, totPips15 = 0;
  let tot5k10 = 0, tot5k15 = 0;
  let tot100k10 = 0, tot100k15 = 0;
  let maxStreak10 = 0, maxStreak15 = 0;

  for (const c of comparison) {
    const s10 = c.s10;
    const s15 = c.s15;

    totPips10 += s10.netPips;
    totPips15 += s15.netPips;
    tot5k10 += s10.eur5k;
    tot5k15 += s15.eur5k;
    tot100k10 += s10.eur100k;
    tot100k15 += s15.eur100k;
    if (s10.maxLossStreak > maxStreak10) maxStreak10 = s10.maxLossStreak;
    if (s15.maxLossStreak > maxStreak15) maxStreak15 = s15.maxLossStreak;

    const diff5k = s15.eur5k - s10.eur5k;
    const sign = diff5k >= 0 ? '+' : '';
    const diffPct = ((diff5k / s10.eur5k) * 100).toFixed(1);

    console.log(
      `${c.period.padEnd(30)} | ` +
      `${s10.wr.padStart(6)} vs ${s15.wr.padStart(6)} | ` +
      `${s10.pf.padStart(6)} vs ${s15.pf.padStart(6)} | ` +
      `${String(s10.netPips.toFixed(0)).padStart(7)}p -> ${String(s15.netPips.toFixed(0)).padStart(7)}p | ` +
      `${String(s10.eur5k).padStart(6)}€ -> ${String(s15.eur5k).padStart(6)}€ (${sign}${diffPct.padStart(5)}%) | ` +
      `${String(s10.eur100k).padStart(7)}€ -> ${String(s15.eur100k).padStart(7)}€ | ` +
      `${s10.maxDdPct.padStart(5)} -> ${s15.maxDdPct.padStart(5)}`
    );
  }

  console.log('-------------------------------+-------------------+-------------------+----------------------------+---------------------------+---------------------------+-------------');
  const globalDiff5k = tot5k15 - tot5k10;
  const globalPct = ((globalDiff5k / tot5k10) * 100).toFixed(1);
  console.log(
    `TOTAL ACUMULADO MULTI-AÑO      | ` +
    `  --- vs ---       | ` +
    `  --- vs ---       | ` +
    `${String(totPips10.toFixed(0)).padStart(7)}p -> ${String(totPips15.toFixed(0)).padStart(7)}p | ` +
    `${String(tot5k10).padStart(6)}€ -> ${String(tot5k15).padStart(6)}€ (+${globalPct}%) | ` +
    `${String(tot100k10).padStart(7)}€ -> ${String(tot100k15).padStart(7)}€ | ` +
    `Racha Max: ${maxStreak10} -> ${maxStreak15}`
  );
  console.log('========================================================================================================================\n');
}

runRrHistoricalAudit().catch(console.error);
