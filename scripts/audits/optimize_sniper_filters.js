/**
 * Script de Optimización Fina: Antigravity Institutional Sniper
 * Calibración de umbrales sobre 65.015 velas reales M15 de MT5
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function testOptimized() {
  const filePath = path.join(__dirname, '../../XAUUSD_M15_202401020100_202609291045.csv');
  const fileStream = fs.createReadStream(filePath);
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
      hour: h,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  console.log('✅ ' + candles.length + ' velas cargadas.');

  // Precalcular EMA 200 de M15 (Tendencia Macro)
  const ema200 = new Float64Array(candles.length);
  const k = 2 / (200 + 1);
  let val = candles[0].close;
  for (let i = 0; i < candles.length; i++) {
    val = candles[i].close * k + val * (1 - k);
    ema200[i] = val;
  }

  // Precalcular RSI(7)
  const rsi = new Float64Array(candles.length);
  const period = 7;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) g += d; else l += Math.abs(d);
  }
  let ag = g / period, al = l / period;
  rsi[period] = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    ag = (ag * 6 + (d >= 0 ? d : 0)) / 7;
    al = (al * 6 + (d < 0 ? Math.abs(d) : 0)) / 7;
    rsi[i] = al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  }

  // Bandas de Bollinger 2.3
  const upperBB = new Float64Array(candles.length);
  const lowerBB = new Float64Array(candles.length);
  for (let i = 19; i < candles.length; i++) {
    let s = 0;
    for (let j = 0; j < 20; j++) s += candles[i - j].close;
    const m = s / 20;
    let v = 0;
    for (let j = 0; j < 20; j++) { const diff = candles[i - j].close - m; v += diff * diff; }
    const std = Math.sqrt(v / 20);
    upperBB[i] = m + std * 2.3;
    lowerBB[i] = m - std * 2.3;
  }

  console.log('\n================================================================================================================');
  console.log('🔬 BÚSQUEDA DEL UMBRAL ÓPTIMO (CALIBRANDO AGOTAMIENTO REAL):');
  console.log('================================================================================================================\n');

  [25, 20, 18, 16, 14, 12].forEach(rsiThreshold => {
    let wins = 0, losses = 0, pipsWon = 0, pipsLost = 0;
    let peak = 0, run = 0, maxDD = 0;

    for (let i = 200; i < candles.length - 40; i++) {
      const c = candles[i];
      const prev = candles[i - 1];

      // Sesión activa (Londres o NY: 08:00 a 19:00 hora broker)
      if (c.hour < 8 || c.hour > 19) continue;

      const candleRange = c.high - c.low;
      if (candleRange <= 0.6) continue;
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;

      let action = null;

      // BUY: Sobreventa real + Rechazo inferior + Toque banda inferior
      if (rsi[i] <= rsiThreshold && (prev.low <= lowerBB[i - 1] || c.low <= lowerBB[i]) && (lowerWick / candleRange) >= 0.40 && c.close > c.open) {
        action = 'BUY';
      }
      // SELL: Sobrecompra real + Rechazo superior + Toque banda superior
      else if (rsi[i] >= (100 - rsiThreshold) && (prev.high >= upperBB[i - 1] || c.high >= upperBB[i]) && (upperWick / candleRange) >= 0.40 && c.close < c.open) {
        action = 'SELL';
      }

      if (!action) continue;

      const friction = c.spreadPips + 1.0;
      const isBuy = action === 'BUY';
      const entry = isBuy ? c.close + (c.spreadPips / 10.0) : c.close;
      const tp1Dist = 3.0; // 30 pips
      const tp2Dist = 6.0; // 60 pips
      const slDist = 3.5;  // 35 pips

      const targetTP1 = isBuy ? entry + tp1Dist : entry - tp1Dist;
      const targetTP2 = isBuy ? entry + tp2Dist : entry - tp2Dist;
      const targetSL = isBuy ? entry - slDist : entry + slDist;

      let leg1Closed = false, leg1Pips = 0;
      let leg2Closed = false, leg2Pips = 0;
      let leg2SL = targetSL;
      let beActive = false;

      for (let j = i + 1; j < Math.min(candles.length, i + 40); j++) {
        const nextC = candles[j];
        if (isBuy) {
          if (!leg1Closed) {
            if (nextC.high >= targetTP1) { leg1Closed = true; leg1Pips = 30.0 - friction; }
            else if (nextC.low <= targetSL) { leg1Closed = true; leg1Pips = -35.0 - friction; }
          }
          if (!beActive && nextC.high >= entry + 2.2) { beActive = true; leg2SL = entry + 0.4; }
          if (beActive) {
            const pot = nextC.high - 1.8;
            if (pot >= leg2SL + 0.5) leg2SL = pot;
          }
          if (!leg2Closed) {
            if (nextC.high >= targetTP2) { leg2Closed = true; leg2Pips = 60.0 - friction; }
            else if (nextC.low <= leg2SL) { leg2Closed = true; leg2Pips = ((leg2SL - entry) * 10) - friction; }
          }
        } else {
          if (!leg1Closed) {
            if (nextC.low <= targetTP1) { leg1Closed = true; leg1Pips = 30.0 - friction; }
            else if (nextC.high >= targetSL) { leg1Closed = true; leg1Pips = -35.0 - friction; }
          }
          if (!beActive && nextC.low <= entry - 2.2) { beActive = true; leg2SL = entry - 0.4; }
          if (beActive) {
            const pot = nextC.low + 1.8;
            if (pot <= leg2SL - 0.5) leg2SL = pot;
          }
          if (!leg2Closed) {
            if (nextC.low <= targetTP2) { leg2Closed = true; leg2Pips = 60.0 - friction; }
            else if (nextC.high >= leg2SL) { leg2Closed = true; leg2Pips = ((entry - leg2SL) * 10) - friction; }
          }
        }
        if (leg1Closed && leg2Closed) break;
      }

      const netPips = (leg1Pips * 0.5) + (leg2Pips * 0.5);
      run += netPips;
      if (run > peak) peak = run;
      if (peak - run > maxDD) maxDD = peak - run;

      if (netPips > 0) { wins++; pipsWon += netPips; }
      else { losses++; pipsLost += Math.abs(netPips); }

      i += 8;
    }

    const tot = wins + losses;
    const wr = tot > 0 ? ((wins / tot) * 100).toFixed(1) : '0';
    const net = (pipsWon - pipsLost).toFixed(1);
    const pf = pipsLost > 0 ? (pipsWon / pipsLost).toFixed(2) : 'MAX';
    console.log(`RSI <= ${String(rsiThreshold).padStart(2)} / >= ${String(100 - rsiThreshold).padStart(2)} | Trades: ${String(tot).padStart(4)} | Win Rate: ${(wr + '%').padStart(6)} (${wins}W/${losses}L) | Pips Netos: ${(net + ' p').padStart(10)} | PF: ${String(pf).padStart(5)} | MaxDD: ${maxDD.toFixed(1)}p`);
  });

  console.log('\n================================================================================================================\n');
}

testOptimized().catch(console.error);
