const fs = require('fs');
const readline = require('readline');

async function runSessionComparison() {
  const fileStream = fs.createReadStream('EURUSD_M5_202001020600_202610011025.csv');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const allCandles = [];
  for await (const line of rl) {
    if (!line || line.startsWith('Date') || line.startsWith('<')) continue;
    const parts = line.split('\t').length > 1 ? line.split('\t') : line.split(',');
    if (parts.length < 5) continue;
    const dateStr = parts[0];
    const timeStr = parts[1];
    const h = parseInt(timeStr.split(':')[0], 10);
    const m = parseInt(timeStr.split(':')[1], 10);
    const o = parseFloat(parts[2]);
    const hg = parseFloat(parts[3]);
    const l = parseFloat(parts[4]);
    const c = parseFloat(parts[5]);
    allCandles.push({ date: dateStr, time: timeStr, hour: h, min: m, open: o, high: hg, low: l, close: c, range: hg - l });
  }

  console.log(`Cargadas ${allCandles.length} velas M5 de EURUSD (2020-2026)`);

  function simulate(sessionType) {
    const minFvgGap = 0.00030;
    const minOverlap = 0.00020;
    const slMinPips = 3.0;
    const bufferPips = 2.0;
    const bufferPrice = bufferPips / 10000;
    const rrRatio = 1.0;

    let trades = 0;
    let wins = 0;
    let losses = 0;
    let netPips = 0;
    let grossWon = 0;
    let grossLost = 0;

    const bprZones = [];

    for (let idx = 2; idx < allCandles.length; idx++) {
      const c0 = allCandles[idx];
      const c2 = allCandles[idx - 2];

      const isBearishFVG = (c2.low - c0.high) >= minFvgGap;
      const isBullishFVG = (c0.low - c2.high) >= minFvgGap;
      if (isBearishFVG) c0.isBearish = true;
      if (isBullishFVG) c0.isBullish = true;

      if (isBullishFVG) {
        for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
          if (allCandles[i].isBearish) {
            const bearBottom = allCandles[i].high;
            const bullBottom = c2.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const bearTop = allCandles[i - 2] ? allCandles[i - 2].low : allCandles[i].high + minFvgGap;
            const bullTop = c0.low;
            const cHigh = Math.min(bearTop, bullTop);
            if (cHigh > cLow + minOverlap) {
              bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, ce: (cHigh + cLow) / 2.0, idx, tested: false });
              break;
            }
          }
        }
      }

      if (isBearishFVG) {
        for (let i = idx - 1; i >= Math.max(0, idx - 10); i--) {
          if (allCandles[i].isBullish) {
            const bullBottom = allCandles[i - 2] ? allCandles[i - 2].high : allCandles[i].low - minFvgGap;
            const bearBottom = c0.high;
            const cLow = Math.max(bullBottom, bearBottom);
            const bullTop = allCandles[i].low;
            const bearTop = c2.low;
            const cHigh = Math.min(bullTop, bearTop);
            if (cHigh > cLow + minOverlap) {
              bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, ce: (cHigh + cLow) / 2.0, idx, tested: false });
              break;
            }
          }
        }
      }

      // Check session
      let inSession = false;
      const h = c0.hour;
      if (sessionType === 'asia_full') {
        // 00:00 a 07:00 UTC
        inSession = (h >= 0 && h < 7);
      } else if (sessionType === 'asia_late') {
        // 02:00 a 07:00 UTC (estabilizada)
        inSession = (h >= 2 && h < 7);
      } else if (sessionType === 'rollover') {
        // 22:00 a 01:00 UTC
        inSession = (h >= 22 || h < 1);
      } else if (sessionType === 'london_ny') {
        // 07:00 a 19:00 UTC
        inSession = (h >= 7 && h < 19);
      }

      if (!inSession) continue;
      if (c0.range < 0.00035) continue;

      // Evaluate entry
      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (idx - bpr.idx > 400) { bpr.tested = true; continue; }

        if (bpr.type === 'BULLISH') {
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
            const lowerWick = Math.min(c0.open, c0.close) - c0.low;
            if (lowerWick / c0.range < 0.20) continue;

            bpr.tested = true;
            const entry = bpr.ce;
            const sl = bpr.bottom - bufferPrice;
            const slPips = (entry - sl) * 10000;
            if (slPips < slMinPips) continue;
            const tp = entry + (entry - sl) * rrRatio;
            const tpPips = slPips * rrRatio;

            // Simular resultado
            let outcome = null;
            for (let f = idx + 1; f < Math.min(idx + 150, allCandles.length); f++) {
              const fut = allCandles[f];
              if (fut.low <= sl) { outcome = 'LOSS'; break; }
              if (fut.high >= tp) { outcome = 'WIN'; break; }
            }
            if (outcome === 'WIN') {
              trades++; wins++; grossWon += tpPips; netPips += tpPips;
            } else if (outcome === 'LOSS') {
              trades++; losses++; grossLost += slPips; netPips -= slPips;
            }
            break;
          }
        } else if (bpr.type === 'BEARISH') {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / c0.range < 0.20) continue;

            bpr.tested = true;
            const entry = bpr.ce;
            const sl = bpr.top + bufferPrice;
            const slPips = (sl - entry) * 10000;
            if (slPips < slMinPips) continue;
            const tp = entry - (sl - entry) * rrRatio;
            const tpPips = slPips * rrRatio;

            let outcome = null;
            for (let f = idx + 1; f < Math.min(idx + 150, allCandles.length); f++) {
              const fut = allCandles[f];
              if (fut.high >= sl) { outcome = 'LOSS'; break; }
              if (fut.low <= tp) { outcome = 'WIN'; break; }
            }
            if (outcome === 'WIN') {
              trades++; wins++; grossWon += tpPips; netPips += tpPips;
            } else if (outcome === 'LOSS') {
              trades++; losses++; grossLost += slPips; netPips -= slPips;
            }
            break;
          }
        }
      }
    }

    const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : 0;
    const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : 'N/A';
    return { sessionType, trades, wins, losses, wr, pf, netPips: netPips.toFixed(1) };
  }

  console.log('\n================ RESULTADOS BACKTEST POR SESIÓN EN EURUSD (7 AÑOS) ================');
  console.log('1. Londres + Nueva York (07:00 - 19:00 UTC):', simulate('london_ny'));
  console.log('2. Asia Completa (00:00 - 07:00 UTC):', simulate('asia_full'));
  console.log('3. Asia Estabilizada (02:00 - 07:00 UTC):', simulate('asia_late'));
  console.log('4. Rollover Nocturno (22:00 - 01:00 UTC):', simulate('rollover'));
}

runSessionComparison();
