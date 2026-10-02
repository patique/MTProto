const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..');

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
    const spreadPips = parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 0.5;

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

function calculateEMAs(candles) {
  const periods = [50, 100, 200];
  for (const p of periods) {
    const k = 2 / (p + 1);
    let ema = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
      ema = candles[i].close * k + ema * (1 - k);
      candles[i][`ema${p}`] = ema;
    }
  }
}

// Analytical study engine
function runAnalyticalStudy(candles, symbol, tf, params) {
  const {
    minFvgGap,
    minOverlap,
    minRange,
    minWickRatio = 0.20,
    maxLookback = 400,
    emaFilterMode = 'NONE', // 'NONE' | 'EMA50' | 'EMA100' | 'EMA200'
    rrRatio = 1.0,          // 1:0.5, 1:0.8, 1:1.0, 1:1.5, 1:2.0
    bufferPips = 1.0,
    sessionMode = 'ACTIVE', // 'ACTIVE' (07:00 - 19:00 UTC) | '24H'
    pipMultiplier = symbol === 'EURUSD' ? 10000 : 10,
    brokerSpreadPips = symbol === 'EURUSD' ? 0.4 : 4.5
  } = params;

  const bprZones = [];
  const trades = [];
  let lastTradeIdx = -100;

  for (let i = 3; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
    const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
    if (isBearishFVG) c1.isBearish = true;
    if (isBullishFVG) c1.isBullish = true;

    if (isBullishFVG) {
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBearish) {
          const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + minFvgGap;
          const bearBottom = candles[j].high;
          const bullTop = c1.low;
          const bullBottom = c3.high;
          const cLow = Math.max(bearBottom, bullBottom);
          const cHigh = Math.min(bearTop, bullTop);
          if (cHigh > cLow + minOverlap) {
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
          const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - minFvgGap;
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);
          if (cHigh > cLow + minOverlap) {
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

    if (sessionMode === 'ACTIVE') {
      // Complete European & US liquid session: 07:00 to 19:00 UTC (12 hours)
      if (hour < 7 || hour >= 19) continue;
    }

    const candleRange = c0.high - c0.low;
    if (candleRange < minRange) continue;

    for (let z = bprZones.length - 1; z >= 0; z--) {
      const bpr = bprZones[z];
      if (bpr.tested) continue;
      const age = i - bpr.createdIdx;
      if (age > maxLookback) { bpr.tested = true; continue; }

      const bufferPrice = bufferPips / pipMultiplier;

      // Trend EMA evaluation
      let passEma = true;
      if (emaFilterMode === 'EMA50') {
        passEma = bpr.type === 'BULLISH' ? (c0.close > c0.ema50) : (c0.close < c0.ema50);
      } else if (emaFilterMode === 'EMA100') {
        passEma = bpr.type === 'BULLISH' ? (c0.close > c0.ema100) : (c0.close < c0.ema100);
      } else if (emaFilterMode === 'EMA200') {
        passEma = bpr.type === 'BULLISH' ? (c0.close > c0.ema200) : (c0.close < c0.ema200);
      }
      if (!passEma) continue;

      if (bpr.type === 'BULLISH') {
        if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange < minWickRatio) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2; // CE 50%
          const slPrice = bpr.bottom - bufferPrice;
          const slDistPrice = entry - slPrice;
          const slPips = slDistPrice * pipMultiplier;
          if (slPips < (symbol === 'EURUSD' ? 2.0 : 8.0)) continue;

          const tpDistPrice = slDistPrice * rrRatio;
          const tp = entry + tpDistPrice;

          trades.push({ type: 'BUY', entryIdx: i, entry, sl: slPrice, tp, slPips, tpPips: slPips * rrRatio, year: c0.time.getUTCFullYear() });
          break;
        }
      } else if (bpr.type === 'BEARISH') {
        if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange < minWickRatio) continue;

          bpr.tested = true;
          lastTradeIdx = i;

          const entry = (bpr.top + bpr.bottom) / 2;
          const slPrice = bpr.top + bufferPrice;
          const slDistPrice = slPrice - entry;
          const slPips = slDistPrice * pipMultiplier;
          if (slPips < (symbol === 'EURUSD' ? 2.0 : 8.0)) continue;

          const tpDistPrice = slDistPrice * rrRatio;
          const tp = entry - tpDistPrice;

          trades.push({ type: 'SELL', entryIdx: i, entry, sl: slPrice, tp, slPips, tpPips: slPips * rrRatio, year: c0.time.getUTCFullYear() });
          break;
        }
      }
    }
  }

  // Simulate Dollar viability on a 100k Account (e.g. FTMO)
  // Risk = 0.5% per trade = $500 USD per trade
  const initialBalance = 100000;
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDD_USD = 0;
  let maxDD_Pct = 0;

  let wins = 0, losses = 0, grossWonUSD = 0, grossLostUSD = 0;
  const yearly = {};

  for (const tr of trades) {
    let resolved = false;
    let won = false;

    for (let k = tr.entryIdx + 1; k < Math.min(candles.length, tr.entryIdx + 180); k++) {
      const bar = candles[k];

      if (tr.type === 'BUY') {
        if (bar.high >= tr.tp) { resolved = true; won = true; break; }
        if (bar.low <= tr.sl) { resolved = true; won = false; break; }
      } else {
        if (bar.low <= tr.tp) { resolved = true; won = true; break; }
        if (bar.high >= tr.sl) { resolved = true; won = false; break; }
      }
    }

    if (!resolved) {
      const lastBar = candles[Math.min(candles.length - 1, tr.entryIdx + 180)];
      const diff = tr.type === 'BUY' ? (lastBar.close - tr.entry) : (tr.entry - lastBar.close);
      won = diff > 0;
    }

    // Trade sizing: risk $500 USD
    const riskUSD = 500;
    let pnlUSD = 0;
    if (won) {
      wins++;
      // Profit = Risk * RR minus spread impact
      const grossWin = riskUSD * rrRatio;
      const spreadCost = (brokerSpreadPips / tr.slPips) * riskUSD;
      pnlUSD = grossWin - spreadCost;
      grossWonUSD += pnlUSD;
    } else {
      losses++;
      const spreadCost = (brokerSpreadPips / tr.slPips) * riskUSD;
      pnlUSD = -(riskUSD + spreadCost);
      grossLostUSD += Math.abs(pnlUSD);
    }

    balance += pnlUSD;
    if (balance > peakBalance) peakBalance = balance;
    const curDD_USD = peakBalance - balance;
    const curDD_Pct = (curDD_USD / peakBalance) * 100;
    if (curDD_USD > maxDD_USD) maxDD_USD = curDD_USD;
    if (curDD_Pct > maxDD_Pct) maxDD_Pct = curDD_Pct;

    const yr = tr.year;
    if (!yearly[yr]) yearly[yr] = { trades: 0, pnl: 0 };
    yearly[yr].trades++;
    yearly[yr].pnl += pnlUSD;
  }

  const pf = grossLostUSD > 0 ? (grossWonUSD / grossLostUSD).toFixed(2) : '99.0';
  const wr = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0';
  const totalTradingDays = 250 * 6.75; // ~1,680 trading days
  const tradesPerDay = (trades.length / totalTradingDays).toFixed(2);
  const netProfitUSD = balance - initialBalance;
  const netReturnPct = ((netProfitUSD / initialBalance) * 100).toFixed(1);

  let posYears = 0, totYears = 0;
  for (const [yr, y] of Object.entries(yearly)) {
    totYears++;
    if (y.pnl > 0) posYears++;
  }

  return {
    symbol,
    tf,
    ema: emaFilterMode,
    rr: `1:${rrRatio}`,
    trades: trades.length,
    tradesPerDay: `${tradesPerDay}/día`,
    winRate: `${wr}%`,
    pf,
    netProfitUSD: `$${Math.round(netProfitUSD).toLocaleString()}`,
    netReturnPct: `+${netReturnPct}%`,
    maxDD_Pct: `${maxDD_Pct.toFixed(1)}%`,
    maxDD_USD: `$${Math.round(maxDD_USD).toLocaleString()}`,
    consistency: `${posYears}/${totYears}`
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🧪 ESTUDIO ANALÍTICO DE MÁXIMO PROFIT FACTOR, VIABILIDAD EN DÓLARES ($) Y FILTROS EMA');
  console.log('   Simulación en Cuenta de $100,000 USD (Riesgo 0.5% = $500/trade) | Periodo 2020 - 2026');
  console.log('========================================================================================\n');

  // PARTE 1: ¿REALMENTE AYUDA LA EMA 100 O LIMITA LA ESTRATEGIA? (Auditamos XAUUSD M5 y EURUSD M5)
  console.log('----------------------------------------------------------------------------------------');
  console.log('1. TEST DE FILTROS TENDENCIALES: NONE vs EMA 50 vs EMA 100 vs EMA 200 (XAUUSD M5)');
  console.log('----------------------------------------------------------------------------------------');

  const goldM5Path = path.join(DATA_DIR, 'XAUUSD_M5_202001020600_202610011120.csv');
  const goldCandles = await loadCandles(goldM5Path);
  calculateEMAs(goldCandles);

  const emaModes = ['NONE', 'EMA50', 'EMA100', 'EMA200'];
  for (const emaMode of emaModes) {
    const res = runAnalyticalStudy(goldCandles, 'XAUUSD', 'M5', {
      minFvgGap: 0.35, minOverlap: 0.25, minRange: 0.40,
      emaFilterMode: emaMode,
      rrRatio: 1.0,
      bufferPips: 15.0,
      brokerSpreadPips: 4.5
    });
    console.log(`EMA: ${emaMode.padEnd(7)} | Trades: ${String(res.trades).padEnd(5)} (${res.tradesPerDay.padEnd(8)}) | WR: ${res.winRate.padEnd(6)} | PF: ${res.pf.padEnd(5)} | Beneficio: ${res.netProfitUSD.padStart(10)} (${res.netReturnPct.padStart(7)}) | MaxDD: ${res.maxDD_Pct.padStart(5)} (${res.maxDD_USD}) | Años: ${res.consistency}`);
  }

  // PARTE 2: BÚSQUEDA DEL MÁXIMO PROFIT FACTOR CON RATIOS CORTOS (1:0.6 a 1:1.5) EN XAUUSD M5
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('2. BÚSQUEDA DE MÁXIMO PROFIT FACTOR CON RATIOS CORTOS (XAUUSD M5)');
  console.log('----------------------------------------------------------------------------------------');
  const shortRRs = [0.6, 0.8, 1.0, 1.2, 1.5];
  for (const rr of shortRRs) {
    const res = runAnalyticalStudy(goldCandles, 'XAUUSD', 'M5', {
      minFvgGap: 0.35, minOverlap: 0.25, minRange: 0.40,
      emaFilterMode: 'NONE', // Probar sin ataduras de EMA
      rrRatio: rr,
      bufferPips: 15.0,
      brokerSpreadPips: 4.5
    });
    console.log(`RR: 1:${rr.toFixed(1)} | Trades: ${String(res.trades).padEnd(5)} (${res.tradesPerDay.padEnd(8)}) | WR: ${res.winRate.padEnd(6)} | PF: ${res.pf.padEnd(5)} | Beneficio: ${res.netProfitUSD.padStart(10)} (${res.netReturnPct.padStart(7)}) | MaxDD: ${res.maxDD_Pct.padStart(5)} (${res.maxDD_USD}) | Años: ${res.consistency}`);
  }

  // PARTE 3: CALIBRACIÓN ANALÍTICA DE FRECUENCIA EN EURUSD (Para tener de 1 a 3 trades diarios)
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('3. CALIBRACIÓN ANALÍTICA DE FRECUENCIA Y PROFIT FACTOR EN EURUSD (M1, M2, M5)');
  console.log('   Objetivo: Aumentar la frecuencia operativa a 1-3 operaciones por día sin perder efectividad');
  console.log('----------------------------------------------------------------------------------------');

  const eurusdFiles = {
    M1: { file: 'EURUSD_M1_202001020600_202610011029.csv', gap: 0.00010, overlap: 0.00007, range: 0.00012, buffer: 1.0 },
    M2: { file: 'EURUSD_M2_202001020600_202610011028.csv', gap: 0.00012, overlap: 0.00008, range: 0.00015, buffer: 1.2 },
    M5: { file: 'EURUSD_M5_202001020600_202610011025.csv', gap: 0.00018, overlap: 0.00012, range: 0.00022, buffer: 1.5 }
  };

  for (const [tf, cfg] of Object.entries(eurusdFiles)) {
    const fullPath = path.join(DATA_DIR, cfg.file);
    if (!fs.existsSync(fullPath)) continue;

    const candles = await loadCandles(fullPath);
    calculateEMAs(candles);

    // Test with Short RR (1:1.0, 1:1.5, 1:2.0) and NO EMA vs EMA100
    for (const rr of [1.0, 1.5, 2.0]) {
      const res = runAnalyticalStudy(candles, 'EURUSD', tf, {
        minFvgGap: cfg.gap,
        minOverlap: cfg.overlap,
        minRange: cfg.range,
        minWickRatio: 0.20,
        emaFilterMode: 'NONE', // Máxima frecuencia sin censura de tendencia
        rrRatio: rr,
        bufferPips: cfg.buffer,
        brokerSpreadPips: 0.4
      });

      console.log(`EURUSD ${tf} RR 1:${rr.toFixed(1)} | Trades: ${String(res.trades).padEnd(5)} (${res.tradesPerDay.padEnd(8)}) | WR: ${res.winRate.padEnd(6)} | PF: ${res.pf.padEnd(5)} | Beneficio: ${res.netProfitUSD.padStart(10)} (${res.netReturnPct.padStart(7)}) | MaxDD: ${res.maxDD_Pct.padStart(5)} (${res.maxDD_USD}) | Años: ${res.consistency}`);
    }
    console.log('');
  }
}

main().catch(console.error);
