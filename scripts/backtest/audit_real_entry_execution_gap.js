/**
 * Auditoría Rigurosa: Impacto del Desfase de Entrada (Entry Execution Gap)
 * ¿Qué pasa cuando entramos al cierre de la vela (candle.close) en vez del teórico CE 50%?
 * 
 * Historial Real MT5: XAUUSD M2 y M5 (Velas 2025-2026)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M5 = path.join(__dirname, '..', '..', 'XAUUSD_M5_202001020600_202610011120.csv');
const CSV_M2 = path.join(__dirname, '..', '..', 'XAUUSD_M2_202001020600_202610011120.csv');

async function loadCandles(filePath, maxCandles = 70000) {
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
      time: Date.UTC(y, m - 1, d, h, min, s),
      hour: h,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 4.5
    });
  }

  return candles.slice(-maxCandles);
}

function auditExecutionModels(name, candles, cfg) {
  const { minFvgGap, minOverlap, minRange, bufferPrice, slMinPrice, minWickRatio, lookbackBars } = cfg;
  const frictionPips = 5.0; // 0.50$

  const zones = [];
  const tradesCE = [];       // Modelo 1: Teórico CE 50% (como estaba en los scripts anteriores)
  const tradesMarket = [];   // Modelo 2: Real a mercado al cierre (candle.close) con SL estructural y TP 1:1.0
  const tradesTightSL = [];  // Modelo 3: Real a mercado al cierre pero con SL ceñido (distancia fija original de 2.0-2.5$)

  for (let n = 3; n < candles.length - 1; n++) {
    const c0 = candles[n], c1 = candles[n - 1], c2 = candles[n - 2], c3 = candles[n - 3];

    const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
    const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
    if (isBearishFVG) c1.isBearishFVG = true;
    if (isBullishFVG) c1.isBullishFVG = true;

    // Bearish BPR
    if (isBearishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - lookbackBars); i--) {
        if (candles[i].isBullishFVG) {
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const bullTop = candles[i].low;
          const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - minFvgGap;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + minOverlap) {
            zones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, tested: false, n });
            break;
          }
        }
      }
    }

    // Bullish BPR
    if (isBullishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - lookbackBars); i--) {
        if (candles[i].isBearishFVG) {
          const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + minFvgGap;
          const bearBottom = candles[i].high;
          const cLow = Math.max(bearBottom, c3.high);
          const cHigh = Math.min(bearTop, c1.low);

          if (cHigh > cLow + minOverlap) {
            zones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, tested: false, n });
            break;
          }
        }
      }
    }

    while (zones.length > 50) zones.shift();

    if (c0.hour >= 22 || c0.hour < 1 || c0.hour === 10) continue;
    const candleRange = c0.high - c0.low;
    if (candleRange < minRange) continue;

    for (let z = zones.length - 1; z >= 0; z--) {
      const zone = zones[z];
      if (zone.tested || n - zone.n > 250) continue;

      // Retest Bullish
      if (zone.type === 'BULLISH' && c0.low <= zone.top && c0.low >= zone.bottom - bufferPrice) {
        const lowerWick = Math.min(c0.open, c0.close) - c0.low;
        if (lowerWick / candleRange >= minWickRatio) {
          zone.tested = true;

          // 1. Teórico CE 50%
          const ceEntry = (zone.top + zone.bottom) / 2.0;
          const ceSL = zone.bottom - bufferPrice;
          const ceDist = ceEntry - ceSL;
          if (ceDist >= slMinPrice) {
            const ceTP = ceEntry + ceDist;
            tradesCE.push(simTrade(candles, n + 1, 'BUY', ceEntry, ceSL, ceTP, frictionPips));
          }

          // 2. Real a Mercado (candle.close) con SL estructural y TP 1:1.0
          const mktEntry = c0.close;
          const mktSL = zone.bottom - bufferPrice;
          const mktDist = Math.abs(mktEntry - mktSL);
          if (mktDist >= slMinPrice) {
            const mktTP = mktEntry + mktDist;
            tradesMarket.push(simTrade(candles, n + 1, 'BUY', mktEntry, mktSL, mktTP, frictionPips));
          }

          // 3. Real a Mercado pero SL ceñido (distancia fija del BPR)
          const tightDist = (zone.top - zone.bottom) + bufferPrice;
          const tightSL = mktEntry - tightDist;
          const tightTP = mktEntry + tightDist;
          tradesTightSL.push(simTrade(candles, n + 1, 'BUY', mktEntry, tightSL, tightTP, frictionPips));
          break;
        }
      }

      // Retest Bearish
      if (zone.type === 'BEARISH' && c0.high >= zone.bottom && c0.high <= zone.top + bufferPrice) {
        const upperWick = c0.high - Math.max(c0.open, c0.close);
        if (upperWick / candleRange >= minWickRatio) {
          zone.tested = true;

          // 1. Teórico CE 50%
          const ceEntry = (zone.top + zone.bottom) / 2.0;
          const ceSL = zone.top + bufferPrice;
          const ceDist = ceSL - ceEntry;
          if (ceDist >= slMinPrice) {
            const ceTP = ceEntry - ceDist;
            tradesCE.push(simTrade(candles, n + 1, 'SELL', ceEntry, ceSL, ceTP, frictionPips));
          }

          // 2. Real a Mercado (candle.close) con SL estructural y TP 1:1.0
          const mktEntry = c0.close;
          const mktSL = zone.top + bufferPrice;
          const mktDist = Math.abs(mktSL - mktEntry);
          if (mktDist >= slMinPrice) {
            const mktTP = mktEntry - mktDist;
            tradesMarket.push(simTrade(candles, n + 1, 'SELL', mktEntry, mktSL, mktTP, frictionPips));
          }

          // 3. Real a Mercado pero SL ceñido (distancia fija)
          const tightDist = (zone.top - zone.bottom) + bufferPrice;
          const tightSL = mktEntry + tightDist;
          const tightTP = mktEntry - tightDist;
          tradesTightSL.push(simTrade(candles, n + 1, 'SELL', mktEntry, tightSL, tightTP, frictionPips));
          break;
        }
      }
    }
  }

  function simTrade(candles, start, type, entry, sl, tp, friction) {
    const fPrice = friction / 10.0;
    const rEntry = type === 'BUY' ? entry + fPrice : entry - fPrice;
    const rDist = Math.abs(entry - sl);
    const tDist = Math.abs(tp - entry);

    for (let i = start; i < Math.min(candles.length, start + 250); i++) {
      const b = candles[i];
      if (type === 'BUY') {
        if (b.low <= sl) return { won: false, pips: -(rDist * 10 + friction) };
        if (b.high >= tp) return { won: true, pips: (tDist * 10 - friction) };
      } else {
        if (b.high >= sl) return { won: false, pips: -(rDist * 10 + friction) };
        if (b.low <= tp) return { won: true, pips: (tDist * 10 - friction) };
      }
    }
    return { won: false, pips: -(rDist * 10 + friction) };
  }

  function calcStats(trades) {
    const total = trades.length;
    if (total === 0) return { total: 0, wr: '0%', pf: '0', net: '0p' };
    const wins = trades.filter(t => t.won).length;
    const wr = (wins / total * 100).toFixed(1);
    const wonP = trades.filter(t => t.won).reduce((s, t) => s + t.pips, 0);
    const lostP = trades.filter(t => !t.won).reduce((s, t) => s + Math.abs(t.pips), 0);
    const pf = (wonP / (lostP || 1)).toFixed(2);
    const net = (wonP - lostP).toFixed(1);
    return { total, wr: wr + '%', pf, net: '+' + net + 'p' };
  }

  console.log(`\n========================================================================================`);
  console.log(`📊 COMPARATIVA EN ${name}: TEÓRICO (CE 50%) vs REAL MERCADO (CLOSE TRAS RECHAZO)`);
  console.log(`========================================================================================`);
  console.log(`Modelo de Ejecución                                  | Trades | Win Rate | Profit Factor | Pips Netos`);
  console.log(`------------------------------------------------------------------------------------------------------`);
  const sCE = calcStats(tradesCE);
  const sMkt = calcStats(tradesMarket);
  const sTight = calcStats(tradesTightSL);
  console.log(`1. Teórico CE 50% (Asume entrada en techo de zona)   | ${String(sCE.total).padStart(6)} | ${sCE.wr.padStart(8)} | ${sCE.pf.padStart(13)} | ${sCE.net.padStart(10)}`);
  console.log(`2. Real a Mercado al Cierre (SL Estructural Detrás)  | ${String(sMkt.total).padStart(6)} | ${sMkt.wr.padStart(8)} | ${sMkt.pf.padStart(13)} | ${sMkt.net.padStart(10)}`);
  console.log(`3. Real a Mercado al Cierre (SL Ceñido Adaptativo)   | ${String(sTight.total).padStart(6)} | ${sTight.wr.padStart(8)} | ${sTight.pf.padStart(13)} | ${sTight.net.padStart(10)}`);
}

async function run() {
  const cM5 = await loadCandles(CSV_M5, 70000);
  auditExecutionModels('XAUUSD M5 (~12 Meses)', cM5, {
    minFvgGap: 0.70, minOverlap: 0.40, minRange: 0.90, bufferPrice: 1.80, slMinPrice: 2.20, minWickRatio: 0.15, lookbackBars: 20
  });

  const cM2 = await loadCandles(CSV_M2, 100000);
  auditExecutionModels('XAUUSD M2 (~8 Meses)', cM2, {
    minFvgGap: 0.45, minOverlap: 0.25, minRange: 0.60, bufferPrice: 1.20, slMinPrice: 1.80, minWickRatio: 0.15, lookbackBars: 25
  });
}

run().catch(console.error);
