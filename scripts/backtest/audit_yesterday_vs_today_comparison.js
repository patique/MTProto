const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..');

const TF_FILES = {
  M1:  path.join(DATA_DIR, 'XAUUSD_M1_202001020600_202610011121.csv'),
  M2:  path.join(DATA_DIR, 'XAUUSD_M2_202001020600_202610011120.csv'),
  M3:  path.join(DATA_DIR, 'XAUUSD_M3_202001020600_202610011121.csv'),
  M5:  path.join(DATA_DIR, 'XAUUSD_M5_202001020600_202610011120.csv'),
  M15: path.join(DATA_DIR, 'XAUUSD_M15_202001020600_202610011115.csv')
};

// Exact parameters from yesterday's TF_CONFIG
const TF_CONFIG_YESTERDAY = {
  M1:  { tfMinutes: 1,  minFvgGap: 0.18, minOverlap: 0.12, slPips: 16.0, tp1Pips: 10.0, tp2Pips: 12.0,  autoBe: 8.0,  minRange: 0.22, minWickRatio: 0.35, useSessionFilter: true, useHtfEma: true },
  M2:  { tfMinutes: 2,  minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0,  autoBe: 18.0, minRange: 0.22, minWickRatio: 0.25 },
  M3:  { tfMinutes: 3,  minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0,  autoBe: 20.0, minRange: 0.25, minWickRatio: 0.25 },
  M5:  { tfMinutes: 5,  minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0,  autoBe: 25.0, minRange: 0.35, minWickRatio: 0.25 },
  M15: { tfMinutes: 15, minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60, minWickRatio: 0.25 }
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
    const spreadPips = parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 4.5;

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

function precalculateEMA(candles, period = 100) {
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 0; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    candles[i].ema100 = ema;
  }
}

function runYesterdayOriginalStrategy(candles, cfg) {
  const bprZones = [];
  const trades = [];

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

    if (isBearishFVG) c0.isBearish = true;
    if (isBullishFVG) c0.isBullish = true;

    if (isBullishFVG) {
      for (let j = i - 1; j >= Math.max(0, i - 11); j--) {
        if (candles[j].isBearish) {
          const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + 1;
          const bearBottom = candles[j].high;
          const bullTop = c0.low;
          const bullBottom = c2.high;
          const cLow = Math.max(bearBottom, bullBottom);
          const cHigh = Math.min(bearTop, bullTop);
          if (cHigh > cLow + cfg.minOverlap) {
            bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
            break;
          }
        }
      }
    }

    if (isBearishFVG) {
      for (let j = i - 1; j >= Math.max(0, i - 11); j--) {
        if (candles[j].isBullish) {
          const bullTop = candles[j].low;
          const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - 1;
          const bearTop = c2.low;
          const bearBottom = c0.high;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);
          if (cHigh > cLow + cfg.minOverlap) {
            bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, tested: false, createdIdx: i });
            break;
          }
        }
      }
    }

    if (bprZones.length > 25) bprZones.shift();

    const hour = c0.time.getUTCHours();
    const min = c0.time.getUTCMinutes();
    if (hour === 23 || (hour === 0 && min <= 15)) continue;

    const candleRange = c0.high - c0.low;
    if (candleRange < cfg.minRange) continue;

    for (const bpr of bprZones) {
      if (bpr.tested) continue;
      if (i - bpr.createdIdx > 20) { bpr.tested = true; continue; }

      if (bpr.type === 'BULLISH') {
        if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange < cfg.minWickRatio) continue;
          if (c0.close < c0.ema100) continue;

          bpr.tested = true;
          trades.push({
            type: 'BUY',
            entryIdx: i,
            time: c0.time,
            entry: bpr.top,
            sl: bpr.bottom - (cfg.slPips / 10.0),
            tp1: bpr.top + (cfg.tp1Pips / 10.0),
            tp2: bpr.top + (cfg.tp2Pips / 10.0),
            autoBePrice: bpr.top + (cfg.autoBe / 10.0),
            slPips: cfg.slPips,
            tp1Pips: cfg.tp1Pips,
            tp2Pips: cfg.tp2Pips
          });
          break;
        }
      } else if (bpr.type === 'BEARISH') {
        if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.5) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange < cfg.minWickRatio) continue;
          if (c0.close > c0.ema100) continue;

          bpr.tested = true;
          trades.push({
            type: 'SELL',
            entryIdx: i,
            time: c0.time,
            entry: bpr.bottom,
            sl: bpr.top + (cfg.slPips / 10.0),
            tp1: bpr.bottom - (cfg.tp1Pips / 10.0),
            tp2: bpr.bottom - (cfg.tp2Pips / 10.0),
            autoBePrice: bpr.bottom - (cfg.autoBe / 10.0),
            slPips: cfg.slPips,
            tp1Pips: cfg.tp1Pips,
            tp2Pips: cfg.tp2Pips
          });
          break;
        }
      }
    }
  }

  // Simulate outcomes with yesterday's exact partial TP1 + TP2 + BE logic
  const executedTrades = [];
  for (const tr of trades) {
    let currentSL = tr.sl;
    let tp1Hit = false;
    let pips = 0;

    for (let k = tr.entryIdx + 1; k < Math.min(candles.length, tr.entryIdx + 100); k++) {
      const bar = candles[k];

      if (tr.type === 'BUY') {
        if (bar.low <= currentSL) {
          const diff = (currentSL - tr.entry) * 10 - bar.spreadPips;
          pips = tp1Hit ? (tr.tp1Pips * 0.5 + diff * 0.5) : diff;
          break;
        }
        if (!tp1Hit && bar.high >= tr.tp1) {
          tp1Hit = true;
          currentSL = tr.entry + 0.2;
        }
        if (!tp1Hit && bar.high >= tr.autoBePrice) {
          if (currentSL < tr.entry + 0.2) currentSL = tr.entry + 0.2;
        }
        if (bar.high >= tr.tp2) {
          pips = tp1Hit ? (tr.tp1Pips * 0.5 + tr.tp2Pips * 0.5) : tr.tp2Pips;
          break;
        }
      } else {
        if (bar.high >= currentSL) {
          const diff = (tr.entry - currentSL) * 10 - bar.spreadPips;
          pips = tp1Hit ? (tr.tp1Pips * 0.5 + diff * 0.5) : diff;
          break;
        }
        if (!tp1Hit && bar.low <= tr.tp1) {
          tp1Hit = true;
          currentSL = tr.entry - 0.2;
        }
        if (!tp1Hit && bar.low <= tr.autoBePrice) {
          if (currentSL > tr.entry - 0.2) currentSL = tr.entry - 0.2;
        }
        if (bar.low <= tr.tp2) {
          pips = tp1Hit ? (tr.tp1Pips * 0.5 + tr.tp2Pips * 0.5) : tr.tp2Pips;
          break;
        }
      }
    }

    if (pips === 0 && tp1Hit) pips = tr.tp1Pips * 0.5;

    executedTrades.push({
      time: tr.time,
      year: tr.time.getUTCFullYear(),
      pips: parseFloat(pips.toFixed(1))
    });
  }

  return executedTrades;
}

function calcStats(tradesList) {
  const tot = tradesList.length;
  if (tot === 0) return { trades: 0, wr: '0%', pf: '0', net: '0' };
  const wins = tradesList.filter(t => t.pips > 0).length;
  const net = tradesList.reduce((a, b) => a + b.pips, 0);
  const won = tradesList.filter(t => t.pips > 0).reduce((a, b) => a + b.pips, 0);
  const lost = Math.abs(tradesList.filter(t => t.pips < 0).reduce((a, b) => a + b.pips, 0));
  const pf = lost > 0 ? (won / lost).toFixed(2) : '99.0';
  const wr = ((wins / tot) * 100).toFixed(1) + '%';
  return { trades: tot, wr, pf, net: net.toFixed(1) };
}

async function main() {
  console.log('========================================================================================');
  console.log('🔍 AUDITORÍA DE CONTRASTE: ¿POR QUÉ AYER EL RENDIMIENTO ERA BRUTAL Y HOY CAMBIARON LOS DATOS?');
  console.log('   Comparación de la ESTRATEGIA EXACTA DE AYER:');
  console.log('   - Periodo de AYER (Junio 2026 - Septiembre 2026: ~3.5 Meses)');
  console.log('   - Periodo COMPLETO (2020 a 2026: ~7 Años)');
  console.log('========================================================================================\n');

  const startJune2026 = new Date(Date.UTC(2026, 5, 17, 0, 0, 0)).getTime();

  for (const tf of ['M1', 'M2', 'M3', 'M5', 'M15']) {
    const file = TF_FILES[tf];
    if (!fs.existsSync(file)) continue;

    const candles = await loadCandles(file);
    precalculateEMA(candles, 100);

    const cfg = TF_CONFIG_YESTERDAY[tf];
    const allTrades = runYesterdayOriginalStrategy(candles, cfg);

    // Filter for yesterday's sample period
    const tradesSummer2026 = allTrades.filter(t => t.time.getTime() >= startJune2026);
    const statsSummer2026 = calcStats(tradesSummer2026);
    const stats7Years = calcStats(allTrades);

    console.log(`⏱️ TEMPORALIDAD ${tf}:`);
    console.log(`   📍 Periodo de AYER (Junio-Sept 2026): ${statsSummer2026.trades} trades | WinRate: ${statsSummer2026.wr} | PF: ${statsSummer2026.pf} | Net: ${statsSummer2026.net} pips`);
    console.log(`   🌐 Periodo 7 AÑOS (2020-2026)      : ${stats7Years.trades} trades | WinRate: ${stats7Years.wr} | PF: ${stats7Years.pf} | Net: ${stats7Years.net} pips`);

    // Yearly breakdown
    const yearly = {};
    for (const t of allTrades) {
      if (!yearly[t.year]) yearly[t.year] = [];
      yearly[t.year].push(t);
    }
    const yearsStr = Object.keys(yearly).map(yr => {
      const s = calcStats(yearly[yr]);
      return `${yr}: PF ${s.pf} (${s.net > 0 ? '+' : ''}${s.net}p)`;
    }).join(' | ');
    console.log(`   📅 Desglose Anual: ${yearsStr}\n`);
  }
}

main().catch(console.error);
