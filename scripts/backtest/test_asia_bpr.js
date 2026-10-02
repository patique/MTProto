/**
 * Comparativa: BPR en Sesión Asiática vs Londres/NY vs 24 Horas
 * Datos: XAUUSD M3 (100.000 velas reales MT5, 10.3 meses)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M3 = path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv');

async function testAsiaSession() {
  const fileStream = fs.createReadStream(CSV_M3);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const [y, m, d] = parts[0].split('.').map(Number);
    const [h, min, s] = parts[1].split(':').map(Number);
    candles.push({
      dateStr: `${parts[0]} ${parts[1]}`,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  // Precalcular EMA 100
  let ema100 = candles[0].close;
  const k100 = 2 / (100 + 1);
  candles.forEach(c => {
    ema100 = c.close * k100 + ema100 * (1 - k100);
    c.ema100 = ema100;
  });

  // Extraer BPRs
  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const isBearishFVG = (c2.low - c0.high) >= 0.20;
    const isBullishFVG = (c0.low - c2.high) >= 0.20;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    if (isBullishFVG && (i - lastBearishFVGIdx) <= 10 && (i - lastBearishFVGIdx) > 0) {
      const bearTop = candles[lastBearishFVGIdx - 2].low;
      const bearBottom = candles[lastBearishFVGIdx].high;
      const bullTop = c0.low;
      const bullBottom = c2.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);
      if (cHigh > cLow + 0.15) bprZones.push({ type: 'BULLISH', createdIdx: i, top: cHigh, bottom: cLow });
    }

    if (isBearishFVG && (i - lastBullishFVGIdx) <= 10 && (i - lastBullishFVGIdx) > 0) {
      const bullTop = candles[lastBullishFVGIdx].low;
      const bullBottom = candles[lastBullishFVGIdx - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const cLow = Math.max(bullBottom, bearBottom);
      const cHigh = Math.min(bullTop, bearTop);
      if (cHigh > cLow + 0.15) bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow });
    }
  }

  function simulateSession(sessionName, hourCondition) {
    let trades = 0, wins = 0, losses = 0, netPips = 0, grossWon = 0, grossLost = 0, maxDD = 0, peak = 0, lastTradeIdx = -100;
    let avgSpread = 0;

    bprZones.forEach(bpr => {
      for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 50); k++) {
        if (k - lastTradeIdx < 4) continue;
        const bar = candles[k];
        if (!hourCondition(bar.hour)) continue;

        const candleRange = bar.high - bar.low;
        if (candleRange <= 0.25) continue;

        if (bpr.type === 'BULLISH') {
          if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.6) {
            const lowerWick = Math.min(bar.open, bar.close) - bar.low;
            if (lowerWick / candleRange < 0.25) continue;
            if (bar.close < bar.ema100) continue; // Filtro EMA 100

            trades++;
            lastTradeIdx = k;
            avgSpread += bar.spreadPips;
            const entry = bpr.top;
            const sl = bpr.bottom - 1.2;
            let currentSL = sl;
            let tp1Hit = false;
            let pips = 0;

            for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
              const fBar = candles[m];
              if (fBar.low <= currentSL) {
                const diff = (currentSL - entry) * 10 - fBar.spreadPips;
                pips = tp1Hit ? (30 * 0.5 + diff * 0.5) : diff;
                break;
              }
              if (!tp1Hit && fBar.high >= entry + 3.0) {
                tp1Hit = true;
                currentSL = entry + 0.2;
              }
              if (!tp1Hit && fBar.high >= entry + 2.0) {
                if (currentSL < entry + 0.2) currentSL = entry + 0.2;
              }
              if (fBar.high >= entry + 6.0) {
                pips = tp1Hit ? (30 * 0.5 + 60 * 0.5) : 60;
                break;
              }
            }
            if (pips === 0 && tp1Hit) pips = 15;
            if (pips > 0) { wins++; grossWon += pips; } else { losses++; grossLost += Math.abs(pips); }
            netPips += pips;
            if (netPips > peak) peak = netPips;
            if (peak - netPips > maxDD) maxDD = peak - netPips;
            break;
          }
        } else {
          if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.6) {
            const upperWick = bar.high - Math.max(bar.open, bar.close);
            if (upperWick / candleRange < 0.25) continue;
            if (bar.close > bar.ema100) continue;

            trades++;
            lastTradeIdx = k;
            avgSpread += bar.spreadPips;
            const entry = bpr.bottom;
            const sl = bpr.top + 1.2;
            let currentSL = sl;
            let tp1Hit = false;
            let pips = 0;

            for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
              const fBar = candles[m];
              if (fBar.high >= currentSL) {
                const diff = (entry - currentSL) * 10 - fBar.spreadPips;
                pips = tp1Hit ? (30 * 0.5 + diff * 0.5) : diff;
                break;
              }
              if (!tp1Hit && fBar.low <= entry - 3.0) {
                tp1Hit = true;
                currentSL = entry - 0.2;
              }
              if (!tp1Hit && fBar.low <= entry - 2.0) {
                if (currentSL > entry - 0.2) currentSL = entry - 0.2;
              }
              if (fBar.low <= entry - 6.0) {
                pips = tp1Hit ? (30 * 0.5 + 60 * 0.5) : 60;
                break;
              }
            }
            if (pips === 0 && tp1Hit) pips = 15;
            if (pips > 0) { wins++; grossWon += pips; } else { losses++; grossLost += Math.abs(pips); }
            netPips += pips;
            if (netPips > peak) peak = netPips;
            if (peak - netPips > maxDD) maxDD = peak - netPips;
            break;
          }
        }
      }
    });

    const wr = trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0;
    const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : 'Inf';
    const spreadMean = trades > 0 ? (avgSpread / trades).toFixed(1) : 0;

    console.log(`📌 ${sessionName.padEnd(35)} | Trades: ${String(trades).padStart(4)} | Spread: ${spreadMean}p | WR: ${(wr + '%').padStart(6)} (${wins}W/${losses}L) | Pips: ${(netPips >= 0 ? '+' : '') + netPips.toFixed(1).padStart(8)}p | PF: ${pf.padStart(5)} | MaxDD: -${maxDD.toFixed(1)}p`);
  }

  console.log(`\n========================================================================================================================`);
  console.log(`🔬 COMPARATIVA DE SESIÓN: ASIA vs LONDRES/NY vs 24 HORAS (XAUUSD M3 + EMA 100)`);
  console.log(`========================================================================================================================\n`);

  simulateSession('1. Solo Asia (01:00 - 08:00 broker)', h => h >= 1 && h < 8);
  simulateSession('2. Londres + NY (08:00 - 19:00 broker)', h => h >= 8 && h <= 19);
  simulateSession('3. TODO EL DÍA 24H (Asia + Lon + NY)', h => h >= 1 && h <= 23);
  console.log(`========================================================================================================================\n`);
}

testAsiaSession();
