const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const DATA_DIR = path.join(__dirname, '..', '..');

// Multiplicadores y Pip/Point Values aproximados en Euros (1 EUR ~= 1.135 USD)
const EUR_USD_RATE = 1.135;
const VALUE_001_EUR = {
  EURUSD: (0.10 / EUR_USD_RATE), // ~0.088 € por pip en 0.01L
  GBPJPY: (0.067 / EUR_USD_RATE), // ~0.059 € por pip en 0.01L
  XAUUSD: (0.10 / EUR_USD_RATE),  // ~0.088 € por pip ($1/punto en 0.01L = $0.10/pip)
  NAS100: (0.01 / EUR_USD_RATE)   // ~0.0088 € por punto en 0.01L ($1 USD por punto por 1 lote)
};

// Cargar velas filtrando a partir de 2026-09-18 para inicializar memoria técnica y EMAs
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
    if (dateStr < '2026.09.18' && dateStr < '2026-09-18') continue;

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

// 1. Extraer trades EURUSD (07:00 a 19:00 UTC, R:R 1.0)
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
      const c0 = candles[i];
      const c1 = candles[i - 1];
      const c2 = candles[i - 2];
      const c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBullishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBearish) {
            const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + cfg.gap;
            const bearBottom = candles[j].high;
            const bullTop = c1.low;
            const bullBottom = c3.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const cHigh = Math.min(bearTop, bullTop);
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
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.gap;
            const bearTop = c3.low;
            const bearBottom = c1.high;
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

      if (c0.time < new Date('2026-09-21T00:00:00Z')) continue;
      if (i - lastTradeIdx < 3) continue;

      const hour = c0.time.getUTCHours();
      if (hour < 7 || hour >= 19) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      const bufferPrice = cfg.buffer / pipMultiplier;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 400) { bpr.tested = true; continue; }

        if (bpr.type === 'BULLISH') {
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
            const lowerWick = Math.min(c0.open, c0.close) - c0.low;
            if (lowerWick / candleRange < 0.20) continue;
            bpr.tested = true;
            lastTradeIdx = i;
            const entry = (bpr.top + bpr.bottom) / 2;
            const slPrice = bpr.bottom - bufferPrice;
            const slDist = entry - slPrice;
            const slPips = slDist * pipMultiplier;
            if (slPips < cfg.slMinPips) continue;
            const tpPrice = entry + slDist;
            let won = false;
            let exitTime = c0.time;
            for (let k = i + 1; k < Math.min(candles.length, i + 180); k++) {
              if (candles[k].high >= tpPrice) { won = true; exitTime = candles[k].time; break; }
              if (candles[k].low <= slPrice) { won = false; exitTime = candles[k].time; break; }
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
              won,
              pointsOrPips: won ? slPips : -slPips,
              slDist: slPips
            });
            break;
          }
        } else {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / candleRange < 0.20) continue;
            bpr.tested = true;
            lastTradeIdx = i;
            const entry = (bpr.top + bpr.bottom) / 2;
            const slPrice = bpr.top + bufferPrice;
            const slDist = slPrice - entry;
            const slPips = slDist * pipMultiplier;
            if (slPips < cfg.slMinPips) continue;
            const tpPrice = entry - slDist;
            let won = false;
            let exitTime = c0.time;
            for (let k = i + 1; k < Math.min(candles.length, i + 180); k++) {
              if (candles[k].low <= tpPrice) { won = true; exitTime = candles[k].time; break; }
              if (candles[k].high >= slPrice) { won = false; exitTime = candles[k].time; break; }
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
              won,
              pointsOrPips: won ? slPips : -slPips,
              slDist: slPips
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 2. Extraer trades GBPJPY (07:00 a 18:30 UTC, Sólo Ventas)
async function getGbpjpyTrades() {
  const TF_CONFIGS = {
    M2:  { file: 'GBPJPY_M2_202001020600_202610011028.csv', gap: 0.035, overlap: 0.020, range: 0.040, buffer: 3.5, slMin: 5.0, slMax: 25.0 },
    M3:  { file: 'GBPJPY_M3_202001020600_202610011027.csv', gap: 0.045, overlap: 0.025, range: 0.050, buffer: 4.0, slMin: 6.0, slMax: 30.0 },
    M5:  { file: 'GBPJPY_M5_202001020600_202610011025.csv', gap: 0.060, overlap: 0.035, range: 0.070, buffer: 5.0, slMin: 8.0, slMax: 40.0 },
    M15: { file: 'GBPJPY_M15_202001020600_202610011015.csv', gap: 0.090, overlap: 0.050, range: 0.100, buffer: 7.0, slMin: 12.0, slMax: 60.0 }
  };

  const trades = [];
  const pipMultiplier = 100;

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandles(path.join(DATA_DIR, cfg.file));
    const bprZones = [];
    let lastTradeIdx = -100;

    for (let i = 3; i < candles.length; i++) {
      const c0 = candles[i];
      const c1 = candles[i - 1];
      const c2 = candles[i - 2];
      const c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBearishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBullish) {
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.gap;
            const bearTop = c3.low;
            const bearBottom = c1.high;
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

      if (c0.time < new Date('2026-09-21T00:00:00Z')) continue;
      if (i - lastTradeIdx < 3) continue;

      const hour = c0.time.getUTCHours();
      const min = c0.time.getUTCMinutes();
      if (hour < 7 || (hour === 18 && min > 30) || hour > 18) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      const bufferPrice = cfg.buffer / pipMultiplier;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

        if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange < 0.20) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2;
          const slPrice = bpr.top + bufferPrice;
          const slDist = slPrice - entry;
          const slPips = slDist * pipMultiplier;
          if (slPips < cfg.slMin || slPips > cfg.slMax) continue;

          const tpPrice = entry - slDist;
          let won = false;
          let exitTime = c0.time;
          for (let k = i + 1; k < Math.min(candles.length, i + 200); k++) {
            if (candles[k].low <= tpPrice) { won = true; exitTime = candles[k].time; break; }
            if (candles[k].high >= slPrice) { won = false; exitTime = candles[k].time; break; }
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
            won,
            pointsOrPips: won ? slPips : -slPips,
            slDist: slPips
          });
          break;
        }
      }
    }
  }
  return trades;
}

// 3. Extraer trades XAUUSD (Oro): 50/50 Split (TP1 + TP2 Auto-BE)
async function getGoldTrades() {
  const TF_CONFIGS = {
    M1:  { file: 'XAUUSD_M1_202001020600_202610011121.csv', gap: 0.50, overlap: 0.30, range: 0.60, buffer: 1.0, slMin: 1.5, tp1: 3.0, tp2: 6.0 },
    M2:  { file: 'XAUUSD_M2_202001020600_202610011120.csv', gap: 0.70, overlap: 0.40, range: 0.80, buffer: 1.2, slMin: 1.8, tp1: 3.5, tp2: 7.0 },
    M3:  { file: 'XAUUSD_M3_202001020600_202610011121.csv', gap: 0.80, overlap: 0.50, range: 1.00, buffer: 1.5, slMin: 2.0, tp1: 4.0, tp2: 8.0 },
    M5:  { file: 'XAUUSD_M5_202001020600_202610011120.csv', gap: 1.20, overlap: 0.70, range: 1.40, buffer: 2.0, slMin: 2.5, tp1: 5.0, tp2: 10.0 },
    M15: { file: 'XAUUSD_M15_202001020600_202610011115.csv', gap: 2.00, overlap: 1.20, range: 2.20, buffer: 2.5, slMin: 3.0, tp1: 7.0, tp2: 14.0 }
  };

  const trades = [];
  const pipMultiplier = 10;

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
      const c0 = candles[i];
      const c1 = candles[i - 1];
      const c2 = candles[i - 2];
      const c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBullishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBearish) {
            const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + cfg.gap;
            const bearBottom = candles[j].high;
            const bullTop = c1.low;
            const bullBottom = c3.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const cHigh = Math.min(bearTop, bullTop);
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
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.gap;
            const bearTop = c3.low;
            const bearBottom = c1.high;
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

      if (c0.time < new Date('2026-09-21T00:00:00Z')) continue;
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

            const entry = (bpr.top + bpr.bottom) / 2;
            const slPrice = bpr.bottom - cfg.buffer;
            const slPips = (entry - slPrice) * pipMultiplier;
            if (slPips < cfg.slMin * pipMultiplier) continue;

            const tp1Price = entry + cfg.tp1;
            const tp2Price = entry + cfg.tp2;
            const tp1Pips = cfg.tp1 * pipMultiplier;
            const tp2Pips = cfg.tp2 * pipMultiplier;

            let tp1Hit = false;
            let tp2Hit = false;
            let slHit = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (!tp1Hit) {
                if (candles[k].high >= tp1Price) tp1Hit = true;
                if (candles[k].low <= slPrice) { slHit = true; break; }
              } else {
                if (candles[k].high >= tp2Price) { tp2Hit = true; break; }
                if (candles[k].low <= entry) { break; }
              }
            }

            let pipsNet = 0;
            if (slHit) {
              pipsNet = -slPips;
            } else if (tp2Hit) {
              pipsNet = (tp1Pips * 0.5) + (tp2Pips * 0.5);
            } else if (tp1Hit) {
              pipsNet = (tp1Pips * 0.5);
            }

            trades.push({
              symbol: 'XAUUSD',
              tf,
              type: 'BUY',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tp2Price,
              won: pipsNet > 0,
              pointsOrPips: pipsNet,
              slDist: slPips
            });
            break;
          }
        } else if (bpr.type === 'BEARISH' && c0.close < c0.ema100) {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + cfg.buffer) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / candleRange < 0.25) continue;

            bpr.tested = true;
            lastTradeIdx = i;

            const entry = (bpr.top + bpr.bottom) / 2;
            const slPrice = bpr.top + cfg.buffer;
            const slPips = (slPrice - entry) * pipMultiplier;
            if (slPips < cfg.slMin * pipMultiplier) continue;

            const tp1Price = entry - cfg.tp1;
            const tp2Price = entry - cfg.tp2;
            const tp1Pips = cfg.tp1 * pipMultiplier;
            const tp2Pips = cfg.tp2 * pipMultiplier;

            let tp1Hit = false;
            let tp2Hit = false;
            let slHit = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (!tp1Hit) {
                if (candles[k].low <= tp1Price) tp1Hit = true;
                if (candles[k].high >= slPrice) { slHit = true; break; }
              } else {
                if (candles[k].low <= tp2Price) { tp2Hit = true; break; }
                if (candles[k].high >= entry) { break; }
              }
            }

            let pipsNet = 0;
            if (slHit) {
              pipsNet = -slPips;
            } else if (tp2Hit) {
              pipsNet = (tp1Pips * 0.5) + (tp2Pips * 0.5);
            } else if (tp1Hit) {
              pipsNet = (tp1Pips * 0.5);
            }

            trades.push({
              symbol: 'XAUUSD',
              tf,
              type: 'SELL',
              time: c0.time,
              exitTime,
              entry,
              sl: slPrice,
              tp: tp2Price,
              won: pipsNet > 0,
              pointsOrPips: pipsNet,
              slDist: slPips
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 4. Extraer trades NAS100 (SÓLO COMPRAS / Bullish BPR, 13:30-20:00 UTC, R:R 1.0)
async function getNas100Trades() {
  const TF_CONFIGS = {
    M2:  { file: 'NAS100_M2_202001010300_202610011028.csv', gap: 6.0,  overlap: 3.5,  range: 7.0,  buffer: 4.0,  slMin: 6.0,  slMax: 40.0 },
    M3:  { file: 'NAS100_M3_202001010300_202610011027.csv', gap: 8.0,  overlap: 4.5,  range: 9.0,  buffer: 5.0,  slMin: 8.0,  slMax: 50.0 },
    M5:  { file: 'NAS100_M5_202001010300_202610011025.csv', gap: 12.0, overlap: 6.0,  range: 14.0, buffer: 7.0,  slMin: 12.0, slMax: 70.0 },
    M15: { file: 'NAS100_M15_202001010300_202610011015.csv', gap: 20.0, overlap: 10.0, range: 22.0, buffer: 10.0, slMin: 18.0, slMax: 100.0 }
  };

  const trades = [];

  for (const [tf, cfg] of Object.entries(TF_CONFIGS)) {
    const candles = await loadCandles(path.join(DATA_DIR, cfg.file));
    if (candles.length < 50) continue;

    // Calcular EMA 100
    const k = 2 / (100 + 1);
    let ema = candles[0].close;
    for (let c of candles) {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    }

    const bprZones = [];
    let lastTradeIdx = -100;

    for (let i = 3; i < candles.length; i++) {
      const c0 = candles[i];
      const c1 = candles[i - 1];
      const c2 = candles[i - 2];
      const c3 = candles[i - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      // Solo zonas alcistas
      if (isBullishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
          if (candles[j].isBearish) {
            const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + cfg.gap;
            const bearBottom = candles[j].high;
            const bullTop = c1.low;
            const bullBottom = c3.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const cHigh = Math.min(bearTop, bullTop);
            if (cHigh > cLow + cfg.overlap) {
              bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
              break;
            }
          }
        }
      }

      while (bprZones.length > 250) bprZones.shift();

      if (c0.time < new Date('2026-09-21T00:00:00Z')) continue;
      if (i - lastTradeIdx < 3) continue;

      // Horario Wall Street: 13:30 a 20:00 UTC
      const hour = c0.time.getUTCHours();
      const min = c0.time.getUTCMinutes();
      const minOfDay = hour * 60 + min;
      if (minOfDay < 810 || minOfDay >= 1200) continue;

      const candleRange = c0.high - c0.low;
      if (candleRange < cfg.range) continue;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

        if (c0.low <= bpr.top && c0.low >= bpr.bottom - cfg.buffer) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange < 0.20) continue;

          // Filtro EMA 100
          if (c0.close < c0.ema100) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2;
          const slPrice = bpr.bottom - cfg.buffer;
          const slDist = entry - slPrice;
          if (slDist < cfg.slMin || slDist > cfg.slMax) continue;

          const tpPrice = entry + slDist; // R:R 1:1.0
          let won = false;
          let exitTime = c0.time;

          for (let k = i + 1; k < Math.min(candles.length, i + 200); k++) {
            if (candles[k].high >= tpPrice) { won = true; exitTime = candles[k].time; break; }
            if (candles[k].low <= slPrice) { won = false; exitTime = candles[k].time; break; }
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
            won,
            pointsOrPips: won ? slDist : -slDist,
            slDist
          });
          break;
        }
      }
    }
  }
  return trades;
}

// 5. Envío a Telegram de Resumen
async function sendToTelegram(msgMarkdown) {
  const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
  const apiId = 25677000;
  const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 3 });
  try {
    await client.connect();
    await client.sendMessage('me', { message: msgMarkdown });
    console.log('✅ Resumen enviado exitosamente a tu Telegram (Mensajes Guardados).');
    await client.disconnect();
    return true;
  } catch (err) {
    console.error('⚠️ Error enviando a Telegram:', err.message);
    try { await client.disconnect(); } catch (e) {}
    return false;
  }
}

async function run() {
  console.log('🔄 Extrayendo operaciones institucionales del 21/09 al 01/10 (4 activos)...');
  const [eurusd, gbpjpy, gold, nas100] = await Promise.all([
    getEurusdTrades(),
    getGbpjpyTrades(),
    getGoldTrades(),
    getNas100Trades()
  ]);

  const allTrades = [...eurusd, ...gbpjpy, ...gold, ...nas100];
  allTrades.sort((a, b) => a.time.getTime() - b.time.getTime());

  console.log(`\n======================================================`);
  console.log(`📈 TOTAL OPERACIONES GENERADAS EN LAS 2 SEMANAS: ${allTrades.length}`);
  console.log(`   • Oro (XAUUSD):    ${gold.length} operaciones (WR: ${(gold.filter(t=>t.won).length/gold.length*100).toFixed(1)}%)`);
  console.log(`   • EURUSD:          ${eurusd.length} operaciones (WR: ${(eurusd.filter(t=>t.won).length/eurusd.length*100).toFixed(1)}%)`);
  console.log(`   • GBPJPY (Ventas):  ${gbpjpy.length} operaciones (WR: ${(gbpjpy.filter(t=>t.won).length/gbpjpy.length*100).toFixed(1)}%)`);
  console.log(`   • NAS100 (Compras): ${nas100.length} operaciones (WR: ${(nas100.filter(t=>t.won).length/nas100.length*100).toFixed(1)}%)`);
  console.log(`======================================================`);

  // SIMULACIÓN 1: CUENTA 100€ CON 0.01 LOTES FIJOS
  let balanceFixed = 100.00;
  let peakBalanceFixed = 100.00;
  let maxDDFixed = 0.00;

  // SIMULACIÓN 2: CUENTA 100€ CON COMPOUNDING 3.0% RIESGO POR TRADE
  let balanceCompound = 100.00;
  let peakBalanceCompound = 100.00;
  let maxDDCompound = 0.00;

  const dailyHistory = {};

  for (const t of allTrades) {
    const day = t.time.toISOString().substring(0, 10);
    if (!dailyHistory[day]) {
      dailyHistory[day] = { trades: 0, pnlFixed: 0, pnlCompound: 0, gold: 0, eurusd: 0, gbpjpy: 0, nas100: 0 };
    }

    // 1. Ganancia / Pérdida en Euros (Lote fijo 0.01):
    const eurUnitVal = VALUE_001_EUR[t.symbol];
    const tradeEurFixed = t.pointsOrPips * eurUnitVal;
    balanceFixed += tradeEurFixed;
    if (balanceFixed > peakBalanceFixed) peakBalanceFixed = balanceFixed;
    const ddF = peakBalanceFixed - balanceFixed;
    if (ddF > maxDDFixed) maxDDFixed = ddF;

    // 2. Ganancia / Pérdida con Compounding (3% riesgo por trade):
    const riskEuro = balanceCompound * 0.03;
    let tradeEurCompound = 0;
    if (t.won) {
      const rrAchieved = t.slDist > 0 ? (t.pointsOrPips / t.slDist) : 1.0;
      tradeEurCompound = riskEuro * rrAchieved;
    } else {
      tradeEurCompound = -riskEuro;
    }
    balanceCompound += tradeEurCompound;
    if (balanceCompound > peakBalanceCompound) peakBalanceCompound = balanceCompound;
    const ddC = ((peakBalanceCompound - balanceCompound) / peakBalanceCompound) * 100;
    if (ddC > maxDDCompound) maxDDCompound = ddC;

    dailyHistory[day].trades++;
    dailyHistory[day].pnlFixed += tradeEurFixed;
    dailyHistory[day].pnlCompound += tradeEurCompound;
    if (t.symbol === 'XAUUSD') dailyHistory[day].gold++;
    if (t.symbol === 'EURUSD') dailyHistory[day].eurusd++;
    if (t.symbol === 'GBPJPY') dailyHistory[day].gbpjpy++;
    if (t.symbol === 'NAS100') dailyHistory[day].nas100++;
  }

  console.log('\n📅 EVOLUCIÓN DÍA A DÍA DE LA CUENTA DE 100€ (Desde el lunes 21/09):');
  console.log('------------------------------------------------------------------------------------------------------');
  console.log('Fecha      | Ops | Composición (XAU/EUR/GBP/NAS)     | PnL 0.01L (€) | Saldo 0.01L | Saldo Compuesto (3%)');
  console.log('------------------------------------------------------------------------------------------------------');

  let curBalF = 100.00;
  let curBalC = 100.00;

  for (const [day, data] of Object.entries(dailyHistory)) {
    curBalF += data.pnlFixed;
    curBalC += data.pnlCompound;
    const signF = data.pnlFixed >= 0 ? '+' : '';
    const signC = data.pnlCompound >= 0 ? '+' : '';
    console.log(
      `${day} | ${String(data.trades).padStart(3)} | ${String(data.gold).padStart(2)} XAU / ${String(data.eurusd).padStart(2)} EUR / ${String(data.gbpjpy).padStart(2)} GBP / ${String(data.nas100).padStart(2)} NAS | ${signF}${data.pnlFixed.toFixed(2).padStart(6)} €      | ${curBalF.toFixed(2).padStart(7)} €  | ${curBalC.toFixed(2).padStart(7)} € (${signC}${((curBalC-100)/100*100).toFixed(1)}%)`
    );
  }

  const wins = allTrades.filter(t => t.won).length;
  const losses = allTrades.length - wins;
  const globalWR = ((wins / allTrades.length) * 100).toFixed(1);

  console.log('\n=========================================================================================');
  console.log('🏆 RESUMEN FINAL DEL PERÍODO (21/09/2026 - 01/10/2026)');
  console.log('=========================================================================================');
  console.log(`Saldo Inicial: 100.00 €`);
  console.log(`\n1. MODELO LOTE MÍNIMO FIJO (0.01 Lotes por Trade):`);
  console.log(`   • Saldo Final:      ${balanceFixed.toFixed(2)} €`);
  console.log(`   • Ganancia Neta:    +${(balanceFixed - 100).toFixed(2)} € (+${((balanceFixed - 100)/100*100).toFixed(1)}%)`);
  console.log(`   • Max Drawdown:     -${maxDDFixed.toFixed(2)} €`);

  console.log(`\n2. MODELO COMPOUNDING DINÁMICO (3.0% Riesgo Compuesto):`);
  console.log(`   • Saldo Final:      ${balanceCompound.toFixed(2)} €`);
  console.log(`   • Ganancia Neta:    +${(balanceCompound - 100).toFixed(2)} € (+${((balanceCompound - 100)/100*100).toFixed(1)}%)`);
  console.log(`   • Max Drawdown:     -${maxDDCompound.toFixed(1)}%`);

  console.log(`\nEstadísticas Globales de los 4 Activos:`);
  console.log(`   • Operaciones:      ${allTrades.length} (${wins} Wins / ${losses} Losses)`);
  console.log(`   • Tasa de Acierto:  ${globalWR}%`);

  // CONSTRUCCIÓN DEL MENSAJE TELEGRAM (CONCISO, FORMATEADO Y ELEGANTE)
  const tgLines = [
    `📊 *SIMULACIÓN CUENTA 100€ | PORTFOLIO BPR 4 ACTIVOS*`,
    `📅 *Período:* 21 Sep - 01 Oct 2026 (2 Semanas)`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🎯 *Total Operaciones:* \`${allTrades.length}\` (${wins} Wins / ${losses} Losses)`,
    `📈 *Win Rate Global:* \`${globalWR}%\``,
    `🪙 *Desglose Activos:*`,
    `  • *XAUUSD (Oro):* \`${gold.length} ops\` | WR: \`${(gold.filter(t=>t.won).length/gold.length*100).toFixed(1)}%\``,
    `  • *EURUSD:* \`${eurusd.length} ops\` | WR: \`${(eurusd.filter(t=>t.won).length/eurusd.length*100).toFixed(1)}%\``,
    `  • *GBPJPY (Ventas):* \`${gbpjpy.length} ops\` | WR: \`${(gbpjpy.filter(t=>t.won).length/gbpjpy.length*100).toFixed(1)}%\``,
    `  • *NAS100 (Compras):* \`${nas100.length} ops\` | WR: \`${(nas100.filter(t=>t.won).length/nas100.length*100).toFixed(1)}%\``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `💰 *RESULTADOS FINALES (Capital Inicial: 100.00 €)*`,
    ``,
    `1️⃣ *Modelo Fijo Retail (0.01 lotes):*`,
    `  • *Saldo Final:* \`${balanceFixed.toFixed(2)} €\``,
    `  • *Beneficio Neto:* \`+${(balanceFixed - 100).toFixed(2)} €\` (+${((balanceFixed - 100)/100*100).toFixed(1)}%)`,
    `  • *Max Drawdown:* \`-${maxDDFixed.toFixed(2)} €\``,
    ``,
    `2️⃣ *Modelo Compounding Institucional (3% riesgo):*`,
    `  • *Saldo Final:* \`${balanceCompound.toFixed(2)} €\``,
    `  • *Beneficio Neto:* \`+${(balanceCompound - 100).toFixed(2)} €\` (+${((balanceCompound - 100)/100*100).toFixed(1)}%)`,
    `  • *Max Drawdown:* \`-${maxDDCompound.toFixed(1)}%\``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `⚙️ *Regla Notificaciones Telegram:*`,
    `✅ Activado: Resumen corto únicamente al *CERRAR* posiciones.`
  ];

  const tgMessage = tgLines.join('\n');
  await sendToTelegram(tgMessage);
}

run().catch(console.error);
