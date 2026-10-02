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

function extractRawBPRs(candles, tfKey, cfg) {
  const bprZones = [];
  const setups = [];
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

          const entry = (bpr.top + bpr.bottom) / 2;
          const slPrice = bpr.bottom - bufferPrice;
          const slDistPrice = entry - slPrice;
          const slPips = slDistPrice * pipMultiplier;
          if (slPips < cfg.slMinPips) continue;

          setups.push({
            tf: tfKey,
            type: 'BUY',
            entryIdx: i,
            entryTime: c0.time,
            entryTimeMs: c0.timeMs,
            entry,
            slPrice,
            slDistPrice,
            slPips,
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

          setups.push({
            tf: tfKey,
            type: 'SELL',
            entryIdx: i,
            entryTime: c0.time,
            entryTimeMs: c0.timeMs,
            entry,
            slPrice,
            slDistPrice,
            slPips,
            year: c0.time.getUTCFullYear()
          });
          break;
        }
      }
    }
  }

  return setups;
}

function evaluateSetupsForRR(setups, candlesByTf, rrRatio) {
  const executedTrades = [];

  for (const s of setups) {
    const candles = candlesByTf[s.tf];
    const tpDistPrice = s.slDistPrice * rrRatio;
    const tpPrice = s.type === 'BUY' ? (s.entry + tpDistPrice) : (s.entry - tpDistPrice);

    let won = false;
    let exitTimeMs = s.entryTimeMs;

    for (let k = s.entryIdx + 1; k < Math.min(candles.length, s.entryIdx + 200); k++) {
      const bar = candles[k];
      exitTimeMs = bar.timeMs;

      if (s.type === 'BUY') {
        if (bar.high >= tpPrice) { won = true; break; }
        if (bar.low <= s.slPrice) { won = false; break; }
      } else {
        if (bar.low <= tpPrice) { won = true; break; }
        if (bar.high >= s.slPrice) { won = false; break; }
      }
    }

    executedTrades.push({
      ...s,
      rrRatio,
      won,
      exitTimeMs
    });
  }

  return executedTrades;
}

function simulatePortfolioFixedRisk(trades, riskUSD = 500) {
  const brokerSpreadPips = 0.4;
  let activePositions = [];

  let executed = 0;
  let wins = 0;
  let grossWon = 0;
  let grossLost = 0;
  let balance = 100000;
  let peak = 100000;
  let maxDD = 0;

  for (const tr of trades) {
    activePositions = activePositions.filter(p => p.exitTimeMs > tr.entryTimeMs);
    if (activePositions.length >= 4) continue;
    activePositions.push({ exitTimeMs: tr.exitTimeMs });

    executed++;
    let pnl = 0;
    const spreadImpact = (brokerSpreadPips / tr.slPips) * riskUSD;

    if (tr.won) {
      wins++;
      pnl = (riskUSD * tr.rrRatio) - spreadImpact;
      grossWon += pnl;
    } else {
      pnl = -(riskUSD + spreadImpact);
      grossLost += Math.abs(pnl);
    }

    balance += pnl;
    if (balance > peak) peak = balance;
    const curDD = peak - balance;
    if (curDD > maxDD) maxDD = curDD;
  }

  const wr = executed > 0 ? (wins / executed) * 100 : 0;
  const pf = grossLost > 0 ? (grossWon / grossLost) : 99.0;
  const evUSD = executed > 0 ? ((grossWon - grossLost) / executed) : 0;
  const maxDDPct = (maxDD / 100000) * 100;
  const netProfitUSD = balance - 100000;

  return {
    rrRatio: trRatioStr(trades[0] ? trades[0].rrRatio : 1.0),
    executed,
    winRate: wr.toFixed(1) + '%',
    pf: pf.toFixed(2),
    evUSD: `$${evUSD.toFixed(1)}/trade`,
    netProfitUSD: `$${Math.round(netProfitUSD).toLocaleString()}`,
    maxDDPct: maxDDPct.toFixed(2) + '%',
    maxDDUSD: `$${Math.round(maxDD).toLocaleString()}`
  };
}

function trRatioStr(rr) {
  return `1:${rr.toFixed(1)}`;
}

async function main() {
  console.log('========================================================================================');
  console.log('🔬 ESTUDIO EXHAUSTIVO DEL ESPECTRO R:R (1:0.6 A 1:3.0) EN EURUSD MULTITEMPORAL');
  console.log('   Cartera M2 + M3 + M5 + M15 (2020 a 2026: ~7 Años completos)');
  console.log('   Simulación en Cuenta de $100,000 USD (Riesgo Fijo 0.5% = $500 por Trade)');
  console.log('========================================================================================\n');

  const candlesByTf = {
    M2:  await loadCandles(EURUSD_FILES.M2),
    M3:  await loadCandles(EURUSD_FILES.M3),
    M5:  await loadCandles(EURUSD_FILES.M5),
    M15: await loadCandles(EURUSD_FILES.M15)
  };

  const rawSetups = [
    ...extractRawBPRs(candlesByTf.M2,  'M2',  TF_CONFIGS.M2),
    ...extractRawBPRs(candlesByTf.M3,  'M3',  TF_CONFIGS.M3),
    ...extractRawBPRs(candlesByTf.M5,  'M5',  TF_CONFIGS.M5),
    ...extractRawBPRs(candlesByTf.M15, 'M15', TF_CONFIGS.M15)
  ].sort((a, b) => a.entryTimeMs - b.entryTimeMs);

  console.log(`Total setups BPR detectados en los 7 años: ${rawSetups.length.toLocaleString()}\n`);

  console.log(
    'R:R'.padEnd(8) +
    'Trades'.padEnd(10) +
    'Win Rate'.padEnd(11) +
    'Profit Factor'.padEnd(15) +
    'Esperanza ($/trade)'.padEnd(22) +
    'Beneficio Total ($)'.padEnd(22) +
    'Max Drawdown'
  );
  console.log('-'.repeat(105));

  const rrList = [0.6, 0.8, 1.0, 1.2, 1.3, 1.5, 1.8, 2.0, 2.5, 3.0];

  for (const rr of rrList) {
    const trades = evaluateSetupsForRR(rawSetups, candlesByTf, rr);
    const res = simulatePortfolioFixedRisk(trades, 500);

    console.log(
      res.rrRatio.padEnd(8) +
      String(res.executed).padEnd(10) +
      res.winRate.padEnd(11) +
      res.pf.padEnd(15) +
      res.evUSD.padEnd(22) +
      res.netProfitUSD.padEnd(22) +
      `${res.maxDDPct} (${res.maxDDUSD})`
    );
  }
}

main().catch(console.error);
