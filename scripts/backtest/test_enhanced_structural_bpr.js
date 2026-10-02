const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..');

// Load candles
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

// Optimized Structural BPR with Machine Learning discovered filters:
// 1. Structural SL = BPR Height + Buffer
// 2. Killzones (London 07-11 UTC, NY 13-17 UTC)
// 3. Rejection Wick >= 35%
// 4. Momentum Impulse (Close in direction of trend)
// 5. Test R:R 1:0.5, 1:1, 1:1.5, 1:2, 1:2.5
// 6. Test BE Modes: NO_BE vs BE_75PCT_TP vs BE_1R
function runEnhancedStructuralTest(candles, tfKey, config) {
  const friction = 0.50; // 5 pips broker friction (spread + slippage stress)
  const bprZones = [];
  const results = [];

  const rrList = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  const beList = ['NO_BE', 'BE_75PCT_TP', 'BE_1R'];

  for (const rr of rrList) {
    for (const beMode of beList) {
      if (beMode === 'BE_1R' && rr < 1.5) continue;

      let totalTrades = 0;
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

      // Clear zones
      bprZones.length = 0;

      for (let i = 3; i < candles.length; i++) {
        const c0 = candles[i];
        const c1 = candles[i - 1];
        const c2 = candles[i - 2];
        const c3 = candles[i - 3];

        const isBearishFVG = (c3.low - c1.high) >= config.minFvg;
        const isBullishFVG = (c1.low - c3.high) >= config.minFvg;
        if (isBearishFVG) c1.isBearishFVG = true;
        if (isBullishFVG) c1.isBullishFVG = true;

        if (isBullishFVG) {
          for (let j = i - 2; j >= Math.max(0, i - 10); j--) {
            if (candles[j].isBearishFVG) {
              const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + 1;
              const bearBottom = candles[j].high;
              const bullTop = c1.low;
              const bullBottom = c3.high;
              const cLow = Math.max(bearBottom, bullBottom);
              const cHigh = Math.min(bearTop, bullTop);

              if (cHigh > cLow + config.minOverlap) {
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
          for (let j = i - 2; j >= Math.max(0, i - 10); j--) {
            if (candles[j].isBullishFVG) {
              const bullTop = candles[j].low;
              const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - 1;
              const bearTop = c3.low;
              const bearBottom = c1.high;
              const cLow = Math.max(bullBottom, bearBottom);
              const cHigh = Math.min(bullTop, bearTop);

              if (cHigh > cLow + config.minOverlap) {
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

        if (bprZones.length > 20) bprZones.shift();

        // Killzone Filter (07-11 UTC London & 13-17 UTC NY)
        const hour = c0.time.getUTCHours();
        const min = c0.time.getUTCMinutes();
        const inKillzone = (hour >= 7 && hour < 11) || (hour >= 13 && hour < 17);
        if (!inKillzone) continue;

        const candleRange = c0.high - c0.low;
        if (candleRange < config.minRange) continue;

        for (const bpr of bprZones) {
          if (bpr.tested) continue;
          if (i - bpr.createdIndex > 20) { bpr.tested = true; continue; }

          if (bpr.type === 'BULLISH') {
            if (c0.low <= bpr.top && c0.low >= bpr.bottom - config.buffer) {
              const lowerWick = Math.min(c0.open, c0.close) - c0.low;
              if (lowerWick / candleRange >= 0.35) { // 35% rejection wick
                if (c0.close > c0.ema) { // Trend alignment
                  bpr.tested = true;

                  const entry = c0.close;
                  // Structural SL: bottom of BPR minus buffer
                  const sl = bpr.bottom - config.buffer;
                  const slDist = entry - sl;
                  if (slDist < 1.0) continue; // Min 10 pips risk

                  const tpDist = slDist * rr;
                  const tp = entry + tpDist;

                  // Evaluate forward
                  let resolved = false;
                  let beSet = false;
                  let curSL = sl;

                  for (let k = i + 1; k < Math.min(candles.length, i + 100); k++) {
                    const bar = candles[k];
                    const profit = bar.high - entry;

                    if (!beSet) {
                      if (beMode === 'BE_75PCT_TP' && profit >= tpDist * 0.75) {
                        beSet = true;
                        curSL = entry + 0.30;
                      } else if (beMode === 'BE_1R' && profit >= slDist) {
                        beSet = true;
                        curSL = entry + 0.30;
                      }
                    }

                    if (bar.high >= tp) {
                      resolved = true;
                      const won = (tpDist - friction) * 10;
                      netPips += won;
                      grossWon += won;
                      wins++;
                      break;
                    }

                    if (bar.low <= curSL) {
                      resolved = true;
                      if (beSet && curSL > entry) {
                        const beWin = (0.30 - friction) * 10;
                        netPips += beWin;
                        if (beWin > 0) grossWon += beWin; else grossLost += Math.abs(beWin);
                        beExits++;
                      } else {
                        const lost = (slDist + friction) * 10;
                        netPips -= lost;
                        grossLost += lost;
                        losses++;
                      }
                      break;
                    }
                  }

                  totalTrades++;
                  runningPips = netPips;
                  if (runningPips > peak) peak = runningPips;
                  const dd = peak - runningPips;
                  if (dd > maxDD) maxDD = dd;

                  const yr = c0.time.getUTCFullYear();
                  if (!yearly[yr]) yearly[yr] = { trades: 0, wins: 0, pips: 0 };
                  yearly[yr].trades++;
                  if (netPips > runningPips - (slDist * 10)) yearly[yr].wins++;
                  yearly[yr].pips += (netPips - runningPips);
                  break;
                }
              }
            }
          } else if (bpr.type === 'BEARISH') {
            if (c0.high >= bpr.bottom && c0.high <= bpr.top + config.buffer) {
              const upperWick = c0.high - Math.max(c0.open, c0.close);
              if (upperWick / candleRange >= 0.35) {
                if (c0.close < c0.ema) {
                  bpr.tested = true;

                  const entry = c0.close;
                  const sl = bpr.top + config.buffer;
                  const slDist = sl - entry;
                  if (slDist < 1.0) continue;

                  const tpDist = slDist * rr;
                  const tp = entry - tpDist;

                  let resolved = false;
                  let beSet = false;
                  let curSL = sl;

                  for (let k = i + 1; k < Math.min(candles.length, i + 100); k++) {
                    const bar = candles[k];
                    const profit = entry - bar.low;

                    if (!beSet) {
                      if (beMode === 'BE_75PCT_TP' && profit >= tpDist * 0.75) {
                        beSet = true;
                        curSL = entry - 0.30;
                      } else if (beMode === 'BE_1R' && profit >= slDist) {
                        beSet = true;
                        curSL = entry - 0.30;
                      }
                    }

                    if (bar.low <= tp) {
                      resolved = true;
                      const won = (tpDist - friction) * 10;
                      netPips += won;
                      grossWon += won;
                      wins++;
                      break;
                    }

                    if (bar.high >= curSL) {
                      resolved = true;
                      if (beSet && curSL < entry) {
                        const beWin = (0.30 - friction) * 10;
                        netPips += beWin;
                        if (beWin > 0) grossWon += beWin; else grossLost += Math.abs(beWin);
                        beExits++;
                      } else {
                        const lost = (slDist + friction) * 10;
                        netPips -= lost;
                        grossLost += lost;
                        losses++;
                      }
                      break;
                    }
                  }

                  totalTrades++;
                  runningPips = netPips;
                  if (runningPips > peak) peak = runningPips;
                  const dd = peak - runningPips;
                  if (dd > maxDD) maxDD = dd;

                  const yr = c0.time.getUTCFullYear();
                  if (!yearly[yr]) yearly[yr] = { trades: 0, wins: 0, pips: 0 };
                  yearly[yr].trades++;
                  if (netPips > runningPips - (slDist * 10)) yearly[yr].wins++;
                  yearly[yr].pips += (netPips - runningPips);
                  break;
                }
              }
            }
          }
        }
      }

      const pf = grossLost > 0 ? (grossWon / grossLost) : 99.0;
      const wr = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0';

      let posYears = 0, totYears = 0;
      for (const [yr, y] of Object.entries(yearly)) {
        totYears++;
        if (y.pips > 0) posYears++;
      }

      results.push({
        tf: tfKey,
        rr,
        beMode,
        totalTrades,
        winRate: wr + '%',
        pf: pf.toFixed(2),
        netPips: netPips.toFixed(1),
        maxDD: maxDD.toFixed(1),
        consistency: `${posYears}/${totYears}`
      });
    }
  }

  return results;
}

async function main() {
  console.log('================================================================================');
  console.log('🚀 OPTIMIZACIÓN ESTRUCTURAL BPR: SL = ALTURA BPR + AIRE + KILLZONES + WICK 35%');
  console.log('   Evaluación de R:R (1:0.5 a 1:3.0) y Gestión de BE en M3, M5, M15');
  console.log('================================================================================\n');

  const configs = {
    M3:  { file: 'XAUUSD_M3_202001020600_202610011121.csv', minFvg: 0.30, minOverlap: 0.20, minRange: 0.35, buffer: 1.5 },
    M5:  { file: 'XAUUSD_M5_202001020600_202610011120.csv', minFvg: 0.40, minOverlap: 0.25, minRange: 0.50, buffer: 1.5 },
    M15: { file: 'XAUUSD_M15_202001020600_202610011115.csv', minFvg: 0.70, minOverlap: 0.45, minRange: 0.90, buffer: 2.0 }
  };

  for (const [tf, cfg] of Object.entries(configs)) {
    process.stdout.write(`Analizando ${tf}... `);
    const candles = await loadCandles(cfg.file);
    precalculateEMA(candles, 100);
    console.log(`${candles.length.toLocaleString()} velas cargadas.`);

    const res = runEnhancedStructuralTest(candles, tf, cfg);

    console.log(
      'TF'.padEnd(5) +
      'R:R'.padEnd(7) +
      'Modo BE'.padEnd(14) +
      'Trades'.padEnd(9) +
      'WinRate'.padEnd(10) +
      'PF'.padEnd(8) +
      'Net Pips'.padEnd(14) +
      'Max DD'.padEnd(12) +
      'Años Positivos'
    );
    console.log('-'.repeat(85));

    for (const r of res) {
      if (parseFloat(r.pf) >= 1.5 || r.rr === 0.5 || r.rr === 1.0) {
        console.log(
          r.tf.padEnd(5) +
          `1:${r.rr}`.padEnd(7) +
          r.beMode.padEnd(14) +
          String(r.totalTrades).padEnd(9) +
          r.winRate.padEnd(10) +
          r.pf.padEnd(8) +
          r.netPips.padEnd(14) +
          r.maxDD.padEnd(12) +
          r.consistency
        );
      }
    }
    console.log('');
  }
}

main().catch(console.error);
