/**
 * Test: Usar "UT Bot Alerts" como FILTRO DE TENDENCIA en lugar de gatillo de entrada.
 * Hipótesis:
 * - Si UT Bot está VERDE (Tendencia Alcista) -> Solo compramos retrocesos (RSI < 35 + Mecha de rechazo).
 * - Si UT Bot está ROJO (Tendencia Bajista) -> Solo vendemos subidas (RSI > 65 + Mecha de rechazo).
 * 
 * Datos: XAUUSD M15 (65.000 velas, 2024-2026)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M15 = path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv');

async function testUTBotAsFilter() {
  const fileStream = fs.createReadStream(CSV_M15);
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
    const timestamp = Date.UTC(y, m - 1, d, h - 2, min, s);

    candles.push({
      dateStr: `${parts[0]} ${parts[1]}`,
      timestamp,
      hour: h,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  // 1. Calcular ATR(10) y Trailing Stop de UT Bot (a = 2)
  const a = 2;
  const c = 10;
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) tr.push(candles[i].high - candles[i].low);
    else {
      const hl = candles[i].high - candles[i].low;
      const hc = Math.abs(candles[i].high - candles[i - 1].close);
      const lc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(hl, hc, lc));
    }
  }

  const atr = [];
  let sumTR = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < c) { sumTR += tr[i]; atr.push(sumTR / (i + 1)); }
    else { atr.push((atr[i - 1] * (c - 1) + tr[i]) / c); }
  }

  const utTrend = []; // 1 = Alcista (Verde), -1 = Bajista (Rojo)
  let prevStop = candles[0].close - (a * atr[0]);

  for (let i = 0; i < candles.length; i++) {
    const src = candles[i].close;
    const nLoss = a * atr[i];
    let currentStop = 0;

    if (i > 0) {
      const prevSrc = candles[i - 1].close;
      if (src > prevStop && prevSrc > prevStop) {
        currentStop = Math.max(prevStop, src - nLoss);
      } else if (src < prevStop && prevSrc < prevStop) {
        currentStop = Math.min(prevStop, src + nLoss);
      } else if (src > prevStop) {
        currentStop = src - nLoss;
      } else {
        currentStop = src + nLoss;
      }
    } else {
      currentStop = src - nLoss;
    }

    prevStop = currentStop;
    utTrend.push(src >= currentStop ? 1 : -1);
  }

  // 2. Calcular RSI 14
  let avgGain = 0;
  let avgLoss = 0;
  const rsi = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { rsi.push(50); continue; }
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    if (i <= 14) {
      avgGain += gain / 14;
      avgLoss += loss / 14;
      rsi.push(50);
    } else {
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - (100 / (1 + rs)));
    }
  }

  // 3. Simular Compras de Retroceso alineadas con el Régimen de UT Bot
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let netPips = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let maxDD = 0;
  let peak = 0;
  let lastTrade = -100;

  for (let i = 50; i < candles.length - 60; i++) {
    if (i - lastTrade < 4) continue;
    const bar = candles[i];
    if (bar.hour < 8 || bar.hour > 19) continue;

    const candleRange = bar.high - bar.low;
    if (candleRange <= 0.4) continue;

    let action = null;

    // Si UT Bot está ALCISTA (Verde) -> Comprar retroceso profundo con rechazo
    if (utTrend[i] === 1 && rsi[i] <= 35) {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      if (lowerWick / candleRange >= 0.35) {
        action = 'BUY';
      }
    }
    // Si UT Bot está BAJISTA (Rojo) -> Vender subida con rechazo
    else if (utTrend[i] === -1 && rsi[i] >= 65) {
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      if (upperWick / candleRange >= 0.35) {
        action = 'SELL';
      }
    }

    if (action) {
      trades++;
      lastTrade = i;
      const isBuy = action === 'BUY';
      const entryPrice = bar.close;
      const slDist = 6.5; // 65 pips SL
      const tp1Dist = 3.5; // 35 pips TP1
      const beDist = 2.5; // 25 pips Auto-BE
      const tp2Dist = 7.0; // 70 pips TP2

      let currentSL = isBuy ? (entryPrice - slDist) : (entryPrice + slDist);
      let tp1Hit = false;
      let pipsGained = 0;

      for (let k = i + 1; k < Math.min(candles.length, i + 60); k++) {
        const c = candles[k];
        if (isBuy) {
          if (c.low <= currentSL) {
            const diff = (currentSL - entryPrice) * 10 - c.spreadPips;
            pipsGained = tp1Hit ? (35 * 0.5 + diff * 0.5) : diff;
            break;
          }
          if (!tp1Hit && c.high >= entryPrice + tp1Dist) {
            tp1Hit = true;
            currentSL = entryPrice;
          }
          if (!tp1Hit && c.high >= entryPrice + beDist) {
            currentSL = entryPrice;
          }
          if (c.high >= entryPrice + tp2Dist) {
            pipsGained = tp1Hit ? (35 * 0.5 + 70 * 0.5) : 70;
            break;
          }
        } else {
          if (c.high >= currentSL) {
            const diff = (entryPrice - currentSL) * 10 - c.spreadPips;
            pipsGained = tp1Hit ? (35 * 0.5 + diff * 0.5) : diff;
            break;
          }
          if (!tp1Hit && c.low <= entryPrice - tp1Dist) {
            tp1Hit = true;
            currentSL = entryPrice;
          }
          if (!tp1Hit && c.low <= entryPrice - beDist) {
            currentSL = entryPrice;
          }
          if (c.low <= entryPrice - tp2Dist) {
            pipsGained = tp1Hit ? (35 * 0.5 + 70 * 0.5) : 70;
            break;
          }
        }
      }

      if (pipsGained > 0) { wins++; grossProfit += pipsGained; }
      else { losses++; grossLoss += Math.abs(pipsGained); }
      netPips += pipsGained;
      if (netPips > peak) peak = netPips;
      if (peak - netPips > maxDD) maxDD = peak - netPips;
    }
  }

  const winRate = ((wins / trades) * 100).toFixed(1);
  const pf = (grossProfit / grossLoss).toFixed(2);

  console.log(`\n========================================================================================`);
  console.log(`🔬 RESULTADO: UT BOT USADO COMO FILTRO DE RÉGIMEN + COMPRA DE RETROCESO`);
  console.log(`========================================================================================`);
  console.log(`   • Total Operaciones:   ${trades} trades (~120 trades/año)`);
  console.log(`   • Tasa de Acierto:     ${winRate}% (${wins} Win / ${losses} Loss)`);
  console.log(`   • Pips Netos Ganados:  +${netPips.toFixed(1)} pips`);
  console.log(`   • Beneficio Estimado:  +$${(netPips * 0.5).toFixed(2)} USD (con 0.05 lotes base)`);
  console.log(`   • Profit Factor:       ${pf}`);
  console.log(`   • Max Drawdown:        -${maxDD.toFixed(1)} pips`);
  console.log(`========================================================================================\n`);
}

testUTBotAsFilter();
