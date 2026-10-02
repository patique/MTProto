/**
 * Análisis Detallado de Operaciones BPR M3 + EMA 100: Ayer (2026-09-28) y Hoy (2026-09-29)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M3 = path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv');

async function analyzeYesterdayAndToday() {
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
      dateStr: parts[0],
      timeStr: parts[1],
      fullDate: `${parts[0]} ${parts[1]}`,
      year: y,
      month: m,
      day: d,
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
      if (cHigh > cLow + 0.15) bprZones.push({ type: 'BULLISH', createdIdx: i, top: cHigh, bottom: cLow, time: c0.fullDate });
    }

    if (isBearishFVG && (i - lastBullishFVGIdx) <= 10 && (i - lastBullishFVGIdx) > 0) {
      const bullTop = candles[lastBullishFVGIdx].low;
      const bullBottom = candles[lastBullishFVGIdx - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const cLow = Math.max(bullBottom, bearBottom);
      const cHigh = Math.min(bullTop, bearTop);
      if (cHigh > cLow + 0.15) bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow, time: c0.fullDate });
    }
  }

  // Simular operativa
  const trades = [];
  let lastTradeIdx = -100;

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 50); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      // Filtro anti-rollover (22:55 - 00:30)
      if (bar.hour === 23 || (bar.hour === 0 && bar.minute < 30)) continue;

      const candleRange = bar.high - bar.low;
      if (candleRange <= 0.25) continue;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.6) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < 0.25) continue;
          if (bar.close < bar.ema100) continue; // Filtro EMA 100

          lastTradeIdx = k;
          const entry = bpr.top;
          const sl = bpr.bottom - 1.2;
          let currentSL = sl;
          let tp1Hit = false;
          let pips = 0;
          let exitTime = '';
          let exitReason = '';

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.low <= currentSL) {
              const diff = (currentSL - entry) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (30 * 0.5 + diff * 0.5) : diff;
              exitTime = fBar.fullDate;
              exitReason = tp1Hit ? 'AUTO_BE_AFTER_TP1' : 'STOP_LOSS';
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
              exitTime = fBar.fullDate;
              exitReason = 'TP2_FULL_WIN';
              break;
            }
          }
          if (pips === 0 && tp1Hit) {
            pips = 15;
            exitReason = 'PARTIAL_WIN';
            exitTime = candles[Math.min(candles.length - 1, k + 20)].fullDate;
          }
          if (exitReason === '') {
            exitReason = 'IN_PROGRESS';
            exitTime = candles[candles.length - 1].fullDate;
            const lastClose = candles[candles.length - 1].close;
            pips = (lastClose - entry) * 10;
          }

          trades.push({
            date: bar.dateStr,
            entryTime: bar.fullDate,
            type: 'BUY',
            entry: parseFloat(entry.toFixed(2)),
            sl: parseFloat(sl.toFixed(2)),
            tp1: parseFloat((entry + 3.0).toFixed(2)),
            tp2: parseFloat((entry + 6.0).toFixed(2)),
            exitTime,
            exitReason,
            pips: parseFloat(pips.toFixed(1))
          });
          break;
        }
      } else { // BEARISH
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.6) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < 0.25) continue;
          if (bar.close > bar.ema100) continue; // Filtro EMA 100

          lastTradeIdx = k;
          const entry = bpr.bottom;
          const sl = bpr.top + 1.2;
          let currentSL = sl;
          let tp1Hit = false;
          let pips = 0;
          let exitTime = '';
          let exitReason = '';

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.high >= currentSL) {
              const diff = (entry - currentSL) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (30 * 0.5 + diff * 0.5) : diff;
              exitTime = fBar.fullDate;
              exitReason = tp1Hit ? 'AUTO_BE_AFTER_TP1' : 'STOP_LOSS';
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
              exitTime = fBar.fullDate;
              exitReason = 'TP2_FULL_WIN';
              break;
            }
          }
          if (pips === 0 && tp1Hit) {
            pips = 15;
            exitReason = 'PARTIAL_WIN';
            exitTime = candles[Math.min(candles.length - 1, k + 20)].fullDate;
          }
          if (exitReason === '') {
            exitReason = 'IN_PROGRESS';
            exitTime = candles[candles.length - 1].fullDate;
            const lastClose = candles[candles.length - 1].close;
            pips = (entry - lastClose) * 10;
          }

          trades.push({
            date: bar.dateStr,
            entryTime: bar.fullDate,
            type: 'SELL',
            entry: parseFloat(entry.toFixed(2)),
            sl: parseFloat(sl.toFixed(2)),
            tp1: parseFloat((entry - 3.0).toFixed(2)),
            tp2: parseFloat((entry - 6.0).toFixed(2)),
            exitTime,
            exitReason,
            pips: parseFloat(pips.toFixed(1))
          });
          break;
        }
      }
    }
  });

  // Filtrar operaciones de ayer (2026.09.28) y hoy (2026.09.29)
  const recentTrades = trades.filter(t => t.date === '2026.09.28' || t.date === '2026.09.29');

  console.log(JSON.stringify(recentTrades, null, 2));
}

analyzeYesterdayAndToday();
