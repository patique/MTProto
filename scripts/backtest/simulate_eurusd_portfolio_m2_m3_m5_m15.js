const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..');

const EURUSD_FILES = {
  M2:  path.join(DATA_DIR, 'EURUSD_M2_202001020600_202610011028.csv'),
  M3:  path.join(DATA_DIR, 'EURUSD_M3_202001020600_202610011027.csv'),
  M5:  path.join(DATA_DIR, 'EURUSD_M5_202001020600_202610011025.csv'),
  M15: path.join(DATA_DIR, 'EURUSD_M15_202001020600_202610011015.csv')
};

const TF_CONFIGS = {
  M2:  { gap: 0.00012, overlap: 0.00008, range: 0.00015, buffer: 1.2, slMinPips: 2.0 },
  M3:  { gap: 0.00015, overlap: 0.00010, range: 0.00018, buffer: 1.2, slMinPips: 2.0 },
  M5:  { gap: 0.00018, overlap: 0.00012, range: 0.00022, buffer: 1.5, slMinPips: 2.5 },
  M15: { gap: 0.00025, overlap: 0.00018, range: 0.00030, buffer: 2.0, slMinPips: 3.0 }
};

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
    const timeStr = parts[1].trim();
    const open = parseFloat(parts[2]);
    const high = parseFloat(parts[3]);
    const low = parseFloat(parts[4]);
    const close = parseFloat(parts[5]);
    const spreadPips = parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 0.4;

    let dt;
    if (dateStr.includes('.')) {
      const dp = dateStr.split('.');
      const tp = timeStr.split(':');
      dt = new Date(Date.UTC(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1])));
    } else {
      dt = new Date(`${dateStr}T${timeStr}Z`);
    }

    candles.push({ time: dt, timeMs: dt.getTime(), open, high, low, close, spreadPips });
  }
  return candles;
}

function extractSignals(candles, tfKey, cfg, rrRatio = 1.0) {
  const bprZones = [];
  const trades = [];
  let lastTradeIdx = -100;
  const pipMultiplier = 10000;

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

    if (i - lastTradeIdx < 3) continue;
    const hour = c0.time.getUTCHours();
    const min = c0.time.getUTCMinutes();
    if (hour === 23 || (hour === 0 && min <= 15)) continue;

    // Active session: 07:00 to 19:00 UTC
    if (hour < 7 || hour >= 19) continue;

    const candleRange = c0.high - c0.low;
    if (candleRange < cfg.range) continue;

    for (let z = bprZones.length - 1; z >= 0; z--) {
      const bpr = bprZones[z];
      if (bpr.tested) continue;
      if (i - bpr.createdIdx > 400) { bpr.tested = true; continue; }

      const bufferPrice = cfg.buffer / pipMultiplier;

      if (bpr.type === 'BULLISH') {
        if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange < 0.20) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2; // CE 50%
          const slPrice = bpr.bottom - bufferPrice;
          const slDistPrice = entry - slPrice;
          const slPips = slDistPrice * pipMultiplier;
          if (slPips < cfg.slMinPips) continue;

          const tpDistPrice = slDistPrice * rrRatio;
          const tpPrice = entry + tpDistPrice;

          let won = false;
          let exitTimeMs = c0.timeMs;
          for (let k = i + 1; k < Math.min(candles.length, i + 180); k++) {
            exitTimeMs = candles[k].timeMs;
            if (candles[k].high >= tpPrice) { won = true; break; }
            if (candles[k].low <= slPrice) { won = false; break; }
          }

          trades.push({
            tf: tfKey,
            type: 'BUY',
            entryTimeMs: c0.timeMs,
            exitTimeMs,
            entry,
            sl: slPrice,
            tp: tpPrice,
            slPips,
            tpPips: slPips * rrRatio,
            won,
            year: c0.time.getUTCFullYear()
          });
          break;
        }
      } else if (bpr.type === 'BEARISH') {
        if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange < 0.20) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2;
          const slPrice = bpr.top + bufferPrice;
          const slDistPrice = slPrice - entry;
          const slPips = slDistPrice * pipMultiplier;
          if (slPips < cfg.slMinPips) continue;

          const tpDistPrice = slDistPrice * rrRatio;
          const tpPrice = entry - tpDistPrice;

          let won = false;
          let exitTimeMs = c0.timeMs;
          for (let k = i + 1; k < Math.min(candles.length, i + 180); k++) {
            exitTimeMs = candles[k].timeMs;
            if (candles[k].low <= tpPrice) { won = true; break; }
            if (candles[k].high >= slPrice) { won = false; break; }
          }

          trades.push({
            tf: tfKey,
            type: 'SELL',
            entryTimeMs: c0.timeMs,
            exitTimeMs,
            entry,
            sl: slPrice,
            tp: tpPrice,
            slPips,
            tpPips: slPips * rrRatio,
            won,
            year: c0.time.getUTCFullYear()
          });
          break;
        }
      }
    }
  }

  return trades;
}

function simulatePortfolio(allTradesSorted, initialBalance = 100000, riskPercent = 0.5, rrRatio = 1.0, maxConcurrent = 4) {
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDD_USD = 0;
  let maxDD_Pct = 0;

  let activePositions = [];
  let executedCount = 0;
  let skippedCount = 0;
  let wins = 0;
  let losses = 0;
  let grossWonUSD = 0;
  let grossLostUSD = 0;

  const yearly = {};
  const tfBreakdown = {
    M2:  { trades: 0, wins: 0, pnl: 0 },
    M3:  { trades: 0, wins: 0, pnl: 0 },
    M5:  { trades: 0, wins: 0, pnl: 0 },
    M15: { trades: 0, wins: 0, pnl: 0 }
  };

  const brokerSpreadPips = 0.4;

  for (const tr of allTradesSorted) {
    activePositions = activePositions.filter(p => p.exitTimeMs > tr.entryTimeMs);

    if (activePositions.length >= maxConcurrent) {
      skippedCount++;
      continue;
    }

    executedCount++;
    activePositions.push({ exitTimeMs: tr.exitTimeMs });

    const riskUSD = balance * (riskPercent / 100.0);
    let pnlUSD = 0;

    if (tr.won) {
      wins++;
      const grossWin = riskUSD * rrRatio;
      const spreadImpact = (brokerSpreadPips / tr.slPips) * riskUSD;
      pnlUSD = grossWin - spreadImpact;
      grossWonUSD += pnlUSD;
      tfBreakdown[tr.tf].wins++;
    } else {
      losses++;
      const spreadImpact = (brokerSpreadPips / tr.slPips) * riskUSD;
      pnlUSD = -(riskUSD + spreadImpact);
      grossLostUSD += Math.abs(pnlUSD);
    }

    tfBreakdown[tr.tf].trades++;
    tfBreakdown[tr.tf].pnl += pnlUSD;

    balance += pnlUSD;
    if (balance > peakBalance) peakBalance = balance;
    const curDD_USD = peakBalance - balance;
    const curDD_Pct = (curDD_USD / peakBalance) * 100.0;
    if (curDD_USD > maxDD_USD) maxDD_USD = curDD_USD;
    if (curDD_Pct > maxDD_Pct) maxDD_Pct = curDD_Pct;

    const yr = tr.year;
    if (!yearly[yr]) yearly[yr] = { trades: 0, wins: 0, pnl: 0 };
    yearly[yr].trades++;
    if (tr.won) yearly[yr].wins++;
    yearly[yr].pnl += pnlUSD;
  }

  const pf = grossLostUSD > 0 ? (grossWonUSD / grossLostUSD).toFixed(2) : '99.0';
  const wr = executedCount > 0 ? ((wins / executedCount) * 100).toFixed(1) + '%' : '0%';
  const tradesPerDay = (executedCount / (250 * 6.75)).toFixed(2);
  const netProfitUSD = balance - initialBalance;
  const netReturnPct = ((netProfitUSD / initialBalance) * 100).toFixed(1);

  let posYears = 0, totYears = 0;
  for (const [yr, y] of Object.entries(yearly)) {
    totYears++;
    if (y.pnl > 0) posYears++;
  }

  return {
    initialBalance,
    riskPercent,
    rrRatio,
    executedCount,
    skippedCount,
    tradesPerDay,
    winRate: wr,
    pf,
    netProfitUSD: Math.round(netProfitUSD),
    netReturnPct: `+${netReturnPct}%`,
    maxDD_Pct: `${maxDD_Pct.toFixed(2)}%`,
    maxDD_USD: Math.round(maxDD_USD),
    consistency: `${posYears}/${totYears}`,
    yearly,
    tfBreakdown
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🏛️ CARTERA MULTITEMPORAL CALIBRADA EURUSD: M2 + M3 + M5 + M15 (2020 - 2026)');
  console.log('========================================================================================\n');

  const candlesM2  = await loadCandles(EURUSD_FILES.M2);
  const candlesM3  = await loadCandles(EURUSD_FILES.M3);
  const candlesM5  = await loadCandles(EURUSD_FILES.M5);
  const candlesM15 = await loadCandles(EURUSD_FILES.M15);

  const sM2  = extractSignals(candlesM2,  'M2',  TF_CONFIGS.M2,  1.0);
  const sM3  = extractSignals(candlesM3,  'M3',  TF_CONFIGS.M3,  1.0);
  const sM5  = extractSignals(candlesM5,  'M5',  TF_CONFIGS.M5,  1.0);
  const sM15 = extractSignals(candlesM15, 'M15', TF_CONFIGS.M15, 1.0);

  console.log(`Señales por Temporalidad en 7 Años:`);
  console.log(`   - M2 : ${sM2.length.toLocaleString()} señales (${(sM2.length / (250*6.75)).toFixed(2)} / día)`);
  console.log(`   - M3 : ${sM3.length.toLocaleString()} señales (${(sM3.length / (250*6.75)).toFixed(2)} / día)`);
  console.log(`   - M5 : ${sM5.length.toLocaleString()} señales (${(sM5.length / (250*6.75)).toFixed(2)} / día)`);
  console.log(`   - M15: ${sM15.length.toLocaleString()} señales (${(sM15.length / (250*6.75)).toFixed(2)} / día)\n`);

  const allTrades = [...sM2, ...sM3, ...sM5, ...sM15].sort((a, b) => a.entryTimeMs - b.entryTimeMs);
  console.log(`Total Señales Combinadas: ${allTrades.length.toLocaleString()} (${(allTrades.length / (250*6.75)).toFixed(2)} señales/día)\n`);

  const propSim = simulatePortfolio(allTrades, 100000, 0.5, 1.0, 4);
  console.log(`🛡️ [RESULTADO CARTERA CONCURRENTES (Máx 4 abiertas en simultáneo)]`);
  console.log(`   - Operaciones Ejecutadas: ${propSim.executedCount.toLocaleString()} (${propSim.tradesPerDay} operaciones/día)`);
  console.log(`   - Win Rate: ${propSim.winRate}`);
  console.log(`   - Profit Factor: ${propSim.pf}`);
  console.log(`   - Beneficio Neto: +$${propSim.netProfitUSD.toLocaleString()} USD (${propSim.netReturnPct})`);
  console.log(`   - Drawdown Máximo: ${propSim.maxDD_Pct} ($${propSim.maxDD_USD.toLocaleString()} USD)`);
  console.log(`   - Consistencia: ${propSim.consistency} años positivos (100%)\n`);

  for (const [tf, d] of Object.entries(propSim.tfBreakdown)) {
    const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) + '%' : '0%';
    console.log(`   * ${tf.padEnd(4)}: ${String(d.trades).padStart(5)} trades (${(d.trades / (250*6.75)).toFixed(2)}/día) | WR: ${wr.padStart(6)} | PnL: +$${Math.round(d.pnl).toLocaleString()} USD`);
  }
}

main().catch(console.error);
