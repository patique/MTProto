const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', '..');

// Multiplicadores y Pip Values aproximados en Euros (1 EUR ~= 1.135 USD)
const EUR_USD_RATE = 1.135;
const PIP_VALUE_001_EUR = {
  EURUSD: (0.10 / EUR_USD_RATE), // ~0.088 € por pip en 0.01 lotes
  GBPJPY: (0.067 / EUR_USD_RATE), // ~0.059 € por pip en 0.01 lotes
  XAUUSD: (0.10 / EUR_USD_RATE)  // ~0.088 € por pip ($1/punto en 0.01 lotes = $0.10/pip)
};

// 1. Cargar velas con filtro de fecha desde 2026-09-20 para inicializar memoria
async function loadCandles(filePath, startDateStr = '2026-09-18') {
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

  // Merge cache live if exists
  return candles;
}

// 2. Extraer trades EURUSD (07:00 a 19:00 UTC, R:R 1.0)
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
              pips: won ? slPips : -slPips,
              slPips
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
              pips: won ? slPips : -slPips,
              slPips
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

// 3. Extraer trades GBPJPY (07:00 a 18:30 UTC, Sólo Ventas)
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
            pips: won ? slPips : -slPips,
            slPips
          });
          break;
        }
      }
    }
  }
  return trades;
}

// 4. Extraer trades XAUUSD (Oro): 50/50 Split (TP1 + TP2 Auto-BE)
async function getGoldTrades() {
  const TF_CONFIGS = {
    M1:  { file: 'XAUUSD_M1_202001020600_202610011121.csv', gap: 0.50, overlap: 0.30, range: 0.60, buffer: 1.0, slMin: 1.5, tp1: 3.0, tp2: 6.0 },
    M2:  { file: 'XAUUSD_M2_202001020600_202610011120.csv', gap: 0.70, overlap: 0.40, range: 0.80, buffer: 1.2, slMin: 1.8, tp1: 3.5, tp2: 7.0 },
    M3:  { file: 'XAUUSD_M3_202001020600_202610011121.csv', gap: 0.80, overlap: 0.50, range: 1.00, buffer: 1.5, slMin: 2.0, tp1: 4.0, tp2: 8.0 },
    M5:  { file: 'XAUUSD_M5_202001020600_202610011120.csv', gap: 1.20, overlap: 0.70, range: 1.40, buffer: 2.0, slMin: 2.5, tp1: 5.0, tp2: 10.0 },
    M15: { file: 'XAUUSD_M15_202001020600_202610011115.csv', gap: 2.00, overlap: 1.20, range: 2.20, buffer: 2.5, slMin: 3.0, tp1: 7.0, tp2: 14.0 }
  };

  const trades = [];
  const pipMultiplier = 10; // 1 dólar en oro = 10 pips

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
      if (hour >= 22 || hour < 1) continue; // Bloqueo 22:00-01:00 UTC

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

            // Simulación 50/50:
            let tp1Hit = false;
            let tp2Hit = false;
            let slHit = false;
            let beHit = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (!tp1Hit) {
                if (candles[k].high >= tp1Price) {
                  tp1Hit = true;
                }
                if (candles[k].low <= slPrice) {
                  slHit = true;
                  break;
                }
              } else {
                // TP1 ya se cobró. Segunda mitad protegida en Break-Even (entry)
                if (candles[k].high >= tp2Price) {
                  tp2Hit = true;
                  break;
                }
                if (candles[k].low <= entry) {
                  beHit = true;
                  break;
                }
              }
            }

            let pipsNet = 0;
            if (slHit) {
              pipsNet = -slPips; // Ambas partes pierden el SL
            } else if (tp2Hit) {
              pipsNet = (tp1Pips * 0.5) + (tp2Pips * 0.5); // Ambas partes ganan pleno
            } else if (tp1Hit) {
              pipsNet = (tp1Pips * 0.5); // Parte 1 cobró TP1, Parte 2 cerró en BE (0)
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
              pips: pipsNet,
              slPips,
              details: slHit ? 'SL (-'+slPips.toFixed(0)+'p)' : (tp2Hit ? 'TP1+TP2 (+'+pipsNet.toFixed(0)+'p)' : 'TP1+BE (+'+pipsNet.toFixed(0)+'p)')
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
            let beHit = false;
            let exitTime = c0.time;

            for (let k = i + 1; k < Math.min(candles.length, i + 240); k++) {
              exitTime = candles[k].time;
              if (!tp1Hit) {
                if (candles[k].low <= tp1Price) {
                  tp1Hit = true;
                }
                if (candles[k].high >= slPrice) {
                  slHit = true;
                  break;
                }
              } else {
                if (candles[k].low <= tp2Price) {
                  tp2Hit = true;
                  break;
                }
                if (candles[k].high >= entry) {
                  beHit = true;
                  break;
                }
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
              pips: pipsNet,
              slPips,
              details: slHit ? 'SL (-'+slPips.toFixed(0)+'p)' : (tp2Hit ? 'TP1+TP2 (+'+pipsNet.toFixed(0)+'p)' : 'TP1+BE (+'+pipsNet.toFixed(0)+'p)')
            });
            break;
          }
        }
      }
    }
  }
  return trades;
}

async function run() {
  console.log('🔄 Extrayendo operaciones institucionales del 21/09 al 01/10 (2 semanas)...');
  const [eurusd, gbpjpy, gold] = await Promise.all([
    getEurusdTrades(),
    getGbpjpyTrades(),
    getGoldTrades()
  ]);

  const allTrades = [...eurusd, ...gbpjpy, ...gold];
  allTrades.sort((a, b) => a.time.getTime() - b.time.getTime());

  console.log(`\n======================================================`);
  console.log(`📈 TOTAL OPERACIONES GENERADAS EN LAS 2 SEMANAS: ${allTrades.length}`);
  console.log(`   • Oro (XAUUSD):   ${gold.length} operaciones`);
  console.log(`   • EURUSD:         ${eurusd.length} operaciones`);
  console.log(`   • GBPJPY (Ventas): ${gbpjpy.length} operaciones`);
  console.log(`======================================================`);

  // SIMULACIÓN 1: CUENTA 100€ CON 0.01 LOTES FIJOS (RETAIL STANDARD)
  let balanceFixed = 100.00;
  let peakBalanceFixed = 100.00;
  let maxDDFixed = 0.00;

  // SIMULACIÓN 2: CUENTA 100€ CON COMPOUNDING 3.0% RIESGO POR OPERACIÓN
  let balanceCompound = 100.00;
  let peakBalanceCompound = 100.00;
  let maxDDCompound = 0.00;

  const dailyHistory = {};

  for (const t of allTrades) {
    const day = t.time.toISOString().substring(0, 10);
    if (!dailyHistory[day]) {
      dailyHistory[day] = { trades: 0, pnlFixed: 0, pnlCompound: 0, gold: 0, eurusd: 0, gbpjpy: 0 };
    }

    // 1. Beneficio en Euros con 0.01 lotes:
    const eurPipVal = PIP_VALUE_001_EUR[t.symbol];
    const tradeEurFixed = t.pips * eurPipVal;
    balanceFixed += tradeEurFixed;
    if (balanceFixed > peakBalanceFixed) peakBalanceFixed = balanceFixed;
    const ddF = peakBalanceFixed - balanceFixed;
    if (ddF > maxDDFixed) maxDDFixed = ddF;

    // 2. Beneficio en Euros con Compounding (3% riesgo del balance actual)
    const riskEuro = balanceCompound * 0.03;
    let tradeEurCompound = 0;
    if (t.won) {
      // Si el trade ganó con R:R 1.0 -> gana el riesgo; si es Oro y cobró parcial -> proporcional
      const rrAchieved = t.slPips > 0 ? (t.pips / t.slPips) : 1.0;
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
  }

  console.log('\n📅 EVOLUCIÓN DÍA A DÍA DE LA CUENTA DE 100€ (Desde el lunes 21/09):');
  console.log('-----------------------------------------------------------------------------------------');
  console.log('Fecha      | Ops | Composición (XAU/EUR/GBP) | PnL 0.01L (€) | Saldo 0.01L | Saldo Compuesto (3%)');
  console.log('-----------------------------------------------------------------------------------------');

  let curBalF = 100.00;
  let curBalC = 100.00;

  for (const [day, data] of Object.entries(dailyHistory)) {
    curBalF += data.pnlFixed;
    curBalC += data.pnlCompound;
    const signF = data.pnlFixed >= 0 ? '+' : '';
    const signC = data.pnlCompound >= 0 ? '+' : '';
    console.log(
      `${day} | ${String(data.trades).padStart(3)} | ${data.gold} XAU / ${data.eurusd} EUR / ${data.gbpjpy} GBP    | ${signF}${data.pnlFixed.toFixed(2).padStart(6)} €      | ${curBalF.toFixed(2).padStart(7)} €  | ${curBalC.toFixed(2).padStart(7)} € (${signC}${((curBalC-100)/100*100).toFixed(1)}%)`
    );
  }

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

  const wins = allTrades.filter(t => t.won).length;
  const losses = allTrades.length - wins;
  console.log(`\nEstadísticas Globales de los 3 Activos:`);
  console.log(`   • Operaciones:      ${allTrades.length} (${wins} Wins / ${losses} Losses)`);
  console.log(`   • Tasa de Acierto:  ${((wins / allTrades.length) * 100).toFixed(1)}%`);
}

run().catch(console.error);
