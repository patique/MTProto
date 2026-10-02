const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..');

const TF_FILES = {
  M1:  { file: 'XAUUSD_M1_202001020600_202610011121.csv', minFvg: 0.20, minOverlap: 0.12, minRange: 0.25, buffer: 1.0 },
  M2:  { file: 'XAUUSD_M2_202001020600_202610011120.csv', minFvg: 0.20, minOverlap: 0.15, minRange: 0.25, buffer: 1.0 },
  M3:  { file: 'XAUUSD_M3_202001020600_202610011121.csv', minFvg: 0.25, minOverlap: 0.18, minRange: 0.30, buffer: 1.2 },
  M5:  { file: 'XAUUSD_M5_202001020600_202610011120.csv', minFvg: 0.35, minOverlap: 0.25, minRange: 0.40, buffer: 1.5 },
  M15: { file: 'XAUUSD_M15_202001020600_202610011115.csv', minFvg: 0.60, minOverlap: 0.40, minRange: 0.60, buffer: 2.0 },
  H1:  { file: 'XAUUSD_H1_202001020600_202610011100.csv', minFvg: 1.50, minOverlap: 1.00, minRange: 1.50, buffer: 3.0 },
  H4:  { file: 'XAUUSD_H4_202001020400_202610010800.csv', minFvg: 3.50, minOverlap: 2.50, minRange: 4.00, buffer: 5.0 }
};

async function loadCandles(fileName) {
  const candles = [];
  const fullPath = path.join(DATA_DIR, fileName);
  const fileStream = fs.createReadStream(fullPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split(/[\t,;]+/);
    if (parts.length < 6) continue;

    const dateStr = parts[0].trim();
    const timeStr = parts[1].trim();
    const open = parseFloat(parts[2]);
    const high = parseFloat(parts[3]);
    const low = parseFloat(parts[4]);
    const close = parseFloat(parts[5]);
    const volume = parts[6] ? parseFloat(parts[6]) : 1;

    let dt;
    if (dateStr.includes('.')) {
      const dp = dateStr.split('.');
      const tp = timeStr.split(':');
      dt = new Date(Date.UTC(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1])));
    } else {
      dt = new Date(`${dateStr}T${timeStr}Z`);
    }

    candles.push({ time: dt, open, high, low, close, volume });
  }
  return candles;
}

function precalculateEMA(candles, period = 100) {
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 0; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    candles[i].ema = ema;
  }
}

function runBprStructuralSim(candles, tfKey, cfg, entryMode, rr, beMode) {
  const friction = 0.50; // 5 pips
  const bprZones = [];
  const trades = [];

  let lastTradeIdx = -100;

  for (let i = 3; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    const isBearishFVG = (c3.low - c1.high) >= cfg.minFvg;
    const isBullishFVG = (c1.low - c3.high) >= cfg.minFvg;
    if (isBearishFVG) c1.isBearishFVG = true;
    if (isBullishFVG) c1.isBullishFVG = true;

    if (isBullishFVG) {
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBearishFVG) {
          const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + 1;
          const bearBottom = candles[j].high;
          const bullTop = c1.low;
          const bullBottom = c3.high;
          const cLow = Math.max(bearBottom, bullBottom);
          const cHigh = Math.min(bearTop, bullTop);

          if (cHigh > cLow + cfg.minOverlap) {
            bprZones.push({
              type: 'BULLISH',
              top: cHigh,
              bottom: cLow,
              height: cHigh - cLow,
              tested: false,
              createdIndex: i
            });
            break;
          }
        }
      }
    }

    if (isBearishFVG) {
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBullishFVG) {
          const bullTop = candles[j].low;
          const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - 1;
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + cfg.minOverlap) {
            bprZones.push({
              type: 'BEARISH',
              top: cHigh,
              bottom: cLow,
              height: cHigh - cLow,
              tested: false,
              createdIndex: i
            });
            break;
          }
        }
      }
    }

    if (bprZones.length > 25) bprZones.shift();

    // Check entry on candle c0
    if (i - lastTradeIdx < 4) continue;
    const hour = c0.time.getUTCHours();
    const min = c0.time.getUTCMinutes();
    if (hour === 23 || (hour === 0 && min <= 15)) continue;

    // Filter: Killzones (London 07-11 UTC + NY 13-17 UTC)
    const inKillzone = (hour >= 7 && hour < 11) || (hour >= 13 && hour < 17);
    if (!inKillzone) continue;

    const candleRange = c0.high - c0.low;
    if (candleRange < cfg.minRange) continue;

    for (const bpr of bprZones) {
      if (bpr.tested) continue;
      if (i - bpr.createdIndex > 25) { bpr.tested = true; continue; }

      if (bpr.type === 'BULLISH') {
        // Price touches or penetrates the BPR
        if (c0.low <= bpr.top && c0.low >= bpr.bottom - cfg.buffer) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange < 0.30) continue;
          if (c0.close < c0.ema) continue; // Trend EMA

          bpr.tested = true;
          lastTradeIdx = i;

          // ENTRY PRICE:
          // 'TOUCH': at bpr.top
          // 'CE_50': at 50% consequent encroachment
          const entryPrice = entryMode === 'CE_50' ? (bpr.top + bpr.bottom) / 2 : bpr.top;
          // STRUCTURAL SL: bottom of BPR minus buffer
          const slPrice = bpr.bottom - cfg.buffer;
          const slDist = entryPrice - slPrice;
          if (slDist <= friction * 2) continue;

          const tpDist = slDist * rr;
          const tpPrice = entryPrice + tpDist;

          trades.push({
            type: 'BUY',
            entryIdx: i,
            entryPrice,
            slPrice,
            tpPrice,
            slDist,
            tpDist,
            year: c0.time.getUTCFullYear()
          });
          break;
        }
      } else if (bpr.type === 'BEARISH') {
        if (c0.high >= bpr.bottom && c0.high <= bpr.top + cfg.buffer) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange < 0.30) continue;
          if (c0.close > c0.ema) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entryPrice = entryMode === 'CE_50' ? (bpr.top + bpr.bottom) / 2 : bpr.bottom;
          const slPrice = bpr.top + cfg.buffer;
          const slDist = slPrice - entryPrice;
          if (slDist <= friction * 2) continue;

          const tpDist = slDist * rr;
          const tpPrice = entryPrice - tpDist;

          trades.push({
            type: 'SELL',
            entryIdx: i,
            entryPrice,
            slPrice,
            tpPrice,
            slDist,
            tpDist,
            year: c0.time.getUTCFullYear()
          });
          break;
        }
      }
    }
  }

  // Simulate outcomes
  let wins = 0;
  let losses = 0;
  let beExits = 0;
  let netPips = 0;
  let grossWon = 0;
  let grossLost = 0;
  let maxDD = 0;
  let peak = 0;
  let runningPips = 0;
  const yearly = {};

  for (const tr of trades) {
    let resolved = false;
    let beSet = false;
    let curSL = tr.slPrice;

    for (let k = tr.entryIdx + 1; k < Math.min(candles.length, tr.entryIdx + 120); k++) {
      const bar = candles[k];

      if (tr.type === 'BUY') {
        const profit = bar.high - tr.entryPrice;

        if (!beSet) {
          if (beMode === 'FIXED_2USD' && profit >= 2.0) {
            beSet = true;
            curSL = tr.entryPrice + 0.30;
          } else if (beMode === 'BE_50PCT_TP' && profit >= tr.tpDist * 0.5) {
            beSet = true;
            curSL = tr.entryPrice + 0.30;
          } else if (beMode === 'BE_1R' && rr >= 1.5 && profit >= tr.slDist) {
            beSet = true;
            curSL = tr.entryPrice + 0.30;
          }
        }

        if (bar.high >= tr.tpPrice) {
          resolved = true;
          const pips = (tr.tpDist - friction) * 10;
          netPips += pips;
          grossWon += pips;
          wins++;
          tr.pips = pips;
          break;
        }

        if (bar.low <= curSL) {
          resolved = true;
          if (beSet && curSL > tr.entryPrice) {
            const bePips = (0.30 - friction) * 10;
            netPips += bePips;
            if (bePips > 0) grossWon += bePips; else grossLost += Math.abs(bePips);
            beExits++;
            tr.pips = bePips;
          } else {
            const lost = (tr.slDist + friction) * 10;
            netPips -= lost;
            grossLost += lost;
            losses++;
            tr.pips = -lost;
          }
          break;
        }
      } else { // SELL
        const profit = tr.entryPrice - bar.low;

        if (!beSet) {
          if (beMode === 'FIXED_2USD' && profit >= 2.0) {
            beSet = true;
            curSL = tr.entryPrice - 0.30;
          } else if (beMode === 'BE_50PCT_TP' && profit >= tr.tpDist * 0.5) {
            beSet = true;
            curSL = tr.entryPrice - 0.30;
          } else if (beMode === 'BE_1R' && rr >= 1.5 && profit >= tr.slDist) {
            beSet = true;
            curSL = tr.entryPrice - 0.30;
          }
        }

        if (bar.low <= tr.tpPrice) {
          resolved = true;
          const pips = (tr.tpDist - friction) * 10;
          netPips += pips;
          grossWon += pips;
          wins++;
          tr.pips = pips;
          break;
        }

        if (bar.high >= curSL) {
          resolved = true;
          if (beSet && curSL < tr.entryPrice) {
            const bePips = (0.30 - friction) * 10;
            netPips += bePips;
            if (bePips > 0) grossWon += bePips; else grossLost += Math.abs(bePips);
            beExits++;
            tr.pips = bePips;
          } else {
            const lost = (tr.slDist + friction) * 10;
            netPips -= lost;
            grossLost += lost;
            losses++;
            tr.pips = -lost;
          }
          break;
        }
      }
    }

    if (!resolved) {
      const lastBar = candles[Math.min(candles.length - 1, tr.entryIdx + 120)];
      const diff = tr.type === 'BUY' ? (lastBar.close - tr.entryPrice) : (tr.entryPrice - lastBar.close);
      const pips = (diff - friction) * 10;
      netPips += pips;
      if (pips > 0) { grossWon += pips; wins++; } else { grossLost += Math.abs(pips); losses++; }
      tr.pips = pips;
    }

    runningPips = netPips;
    if (runningPips > peak) peak = runningPips;
    const curDD = peak - runningPips;
    if (curDD > maxDD) maxDD = curDD;

    const yr = tr.year;
    if (!yearly[yr]) yearly[yr] = { trades: 0, wins: 0, pips: 0 };
    yearly[yr].trades++;
    if (tr.pips > 0) yearly[yr].wins++;
    yearly[yr].pips += tr.pips;
  }

  const pf = grossLost > 0 ? (grossWon / grossLost) : 99.0;
  const wr = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0';

  let posYears = 0, totYears = 0;
  for (const [yr, y] of Object.entries(yearly)) {
    totYears++;
    if (y.pips > 0) posYears++;
  }

  return {
    tf: tfKey,
    entryMode,
    rr,
    beMode,
    totalTrades: trades.length,
    winRate: wr + '%',
    pf: pf.toFixed(2),
    netPips: netPips.toFixed(1),
    maxDD: maxDD.toFixed(1),
    consistency: `${posYears}/${totYears}`
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🔬 BATERÍA EXHAUSTIVA DE TODAS LAS TEMPORALIDADES CON SL ESTRUCTURAL DE BPR');
  console.log('   Entrada: TOUCH (borde BPR) vs CE_50 (50% Consequent Encroachment)');
  console.log('   SL = Altura BPR + Buffer de Aire');
  console.log('   R:R = 1:0.5 | 1:1.0 | 1:2.0 | 1:3.0');
  console.log('   BE = NO_BE vs FIXED_2USD vs BE_50PCT_TP vs BE_1R');
  console.log('========================================================================================\n');

  for (const [tf, cfg] of Object.entries(TF_FILES)) {
    const candles = await loadCandles(cfg.file);
    precalculateEMA(candles, 100);

    console.log(`\n----------------------------------------------------------------------------------------`);
    console.log(`⏱️ TEMPORALIDAD: ${tf} (${candles.length.toLocaleString()} velas)`);
    console.log(`----------------------------------------------------------------------------------------`);
    console.log(
      'Entrada'.padEnd(9) +
      'R:R'.padEnd(7) +
      'Modo BE'.padEnd(14) +
      'Trades'.padEnd(9) +
      'WinRate'.padEnd(10) +
      'PF'.padEnd(8) +
      'Net Pips'.padEnd(14) +
      'Max DD'.padEnd(12) +
      'Años Positivos'
    );
    console.log('-'.repeat(90));

    const entryModes = ['TOUCH', 'CE_50'];
    const rrs = [0.5, 1.0, 2.0, 3.0];
    const beModes = ['NO_BE', 'FIXED_2USD', 'BE_50PCT_TP', 'BE_1R'];

    for (const em of entryModes) {
      for (const rr of rrs) {
        for (const be of beModes) {
          if (be === 'BE_1R' && rr < 1.5) continue;

          const res = runBprStructuralSim(candles, tf, cfg, em, rr, be);
          // Highlight results
          console.log(
            res.entryMode.padEnd(9) +
            `1:${res.rr}`.padEnd(7) +
            res.beMode.padEnd(14) +
            String(res.totalTrades).padEnd(9) +
            res.winRate.padEnd(10) +
            res.pf.padEnd(8) +
            res.netPips.padEnd(14) +
            res.maxDD.padEnd(12) +
            res.consistency
          );
        }
      }
    }
  }
}

main().catch(console.error);
