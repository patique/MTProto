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
            entryTime: c0.time,
            entryTimeMs: c0.timeMs,
            exitTimeMs,
            slPips,
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
            entryTime: c0.time,
            entryTimeMs: c0.timeMs,
            exitTimeMs,
            slPips,
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

// Simulates passing a Prop Firm Challenge from a specific Start Date
// Phase 1 Target: +8% (or +10%) | Phase 2 Target: +5%
// Max Daily Loss: 5% | Max Overall Loss: 10%
function simulateChallengeFromDate(trades, startDateStr, initialBalance = 100000, riskPercent = 0.5, p1TargetPct = 8.0, p2TargetPct = 5.0) {
  const startTime = new Date(startDateStr).getTime();
  const validTrades = trades.filter(t => t.entryTimeMs >= startTime);

  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDD_USD = 0;
  let maxDailyDD_USD = 0;

  let currentDayStr = '';
  let dayStartBalance = initialBalance;

  let phase = 1;
  let p1Days = 0;
  let p1Trades = 0;
  let p2Days = 0;
  let p2Trades = 0;
  let failed = false;
  let failReason = '';

  const tradingDays = new Set();
  const brokerSpreadPips = 0.4;
  let activePositions = [];

  for (const tr of validTrades) {
    activePositions = activePositions.filter(p => p.exitTimeMs > tr.entryTimeMs);
    if (activePositions.length >= 3) continue; // Concurrency limit
    activePositions.push({ exitTimeMs: tr.exitTimeMs });

    const dayStr = tr.entryTime.toISOString().slice(0, 10);
    if (dayStr !== currentDayStr) {
      currentDayStr = dayStr;
      dayStartBalance = balance;
      tradingDays.add(dayStr);
      if (phase === 1) p1Days++;
      if (phase === 2) p2Days++;
    }

    const riskUSD = balance * (riskPercent / 100.0);
    let pnl = 0;
    if (tr.won) {
      const spreadImpact = (brokerSpreadPips / tr.slPips) * riskUSD;
      pnl = riskUSD - spreadImpact;
    } else {
      const spreadImpact = (brokerSpreadPips / tr.slPips) * riskUSD;
      pnl = -(riskUSD + spreadImpact);
    }

    balance += pnl;

    // Check Daily Drawdown rule (-5% max)
    const dailyDrop = dayStartBalance - balance;
    if (dailyDrop > maxDailyDD_USD) maxDailyDD_USD = dailyDrop;
    const dailyDropPct = (dailyDrop / dayStartBalance) * 100;
    if (dailyDropPct >= 5.0) {
      failed = true;
      failReason = `Violación de Daily Loss (-${dailyDropPct.toFixed(2)}%)`;
      break;
    }

    // Check Total Drawdown rule (-10% max)
    if (balance > peakBalance) peakBalance = balance;
    const totalDrop = peakBalance - balance;
    if (totalDrop > maxDD_USD) maxDD_USD = totalDrop;
    const totalDropPct = (totalDrop / initialBalance) * 100;
    if (totalDropPct >= 10.0) {
      failed = true;
      failReason = `Violación de Max Loss (-${totalDropPct.toFixed(2)}%)`;
      break;
    }

    if (phase === 1) {
      p1Trades++;
      const currentProfitPct = ((balance - initialBalance) / initialBalance) * 100;
      if (currentProfitPct >= p1TargetPct) {
        phase = 2;
        // Reset balance for Phase 2 as per prop firm standard
        balance = initialBalance;
        peakBalance = initialBalance;
        dayStartBalance = initialBalance;
      }
    } else if (phase === 2) {
      p2Trades++;
      const currentProfitPct = ((balance - initialBalance) / initialBalance) * 100;
      if (currentProfitPct >= p2TargetPct) {
        phase = 3; // PASSED!
        break;
      }
    }
  }

  const passed = phase === 3;
  return {
    startDateStr,
    passed,
    failed,
    failReason,
    p1Days,
    p1Trades,
    p2Days,
    p2Trades,
    totalDays: p1Days + p2Days,
    totalTrades: p1Trades + p2Trades,
    maxDailyDD_Pct: ((maxDailyDD_USD / initialBalance) * 100).toFixed(2) + '%',
    maxOverallDD_Pct: ((maxDD_USD / initialBalance) * 100).toFixed(2) + '%'
  };
}

async function main() {
  console.log('========================================================================================');
  console.log('🏆 ESTIMACIÓN DE CHALLENGES PROP FIRM (FTMO / THE5ERS) USANDO SÓLO EURUSD');
  console.log('   Cartera M2 + M3 + M5 + M15 | Ratio R:R 1:1.0 | Riesgo 0.5% por Trade');
  console.log('   Reglas Fondeo: Fase 1 = +8% Objetivo | Fase 2 = +5% Objetivo');
  console.log('   Límites: Daily Loss < 5.0% | Max Overall Loss < 10.0%');
  console.log('========================================================================================\n');

  console.log('Cargando datos y generando señales multitemporales de EURUSD...');
  const candlesM2  = await loadCandles(EURUSD_FILES.M2);
  const candlesM3  = await loadCandles(EURUSD_FILES.M3);
  const candlesM5  = await loadCandles(EURUSD_FILES.M5);
  const candlesM15 = await loadCandles(EURUSD_FILES.M15);

  const sM2  = extractSignals(candlesM2,  'M2',  TF_CONFIGS.M2,  1.0);
  const sM3  = extractSignals(candlesM3,  'M3',  TF_CONFIGS.M3,  1.0);
  const sM5  = extractSignals(candlesM5,  'M5',  TF_CONFIGS.M5,  1.0);
  const sM15 = extractSignals(candlesM15, 'M15', TF_CONFIGS.M15, 1.0);

  const allTrades = [...sM2, ...sM3, ...sM5, ...sM15].sort((a, b) => a.entryTimeMs - b.entryTimeMs);
  console.log(`Total señales EURUSD listas: ${allTrades.length.toLocaleString()}\n`);

  // 4 Fechas Históricas Distintas (Diferentes Regímenes de Mercado):
  // 1. Marzo 2020: Shock de Volatilidad Extrema (Pandemia Covid)
  // 2. Julio 2021: Periodo de Rango Estrecho y Baja Volatilidad de Verano
  // 3. Septiembre 2022: Caída Vertical a la Paridad del Euro (Dólar Máximo)
  // 4. Febrero 2026: Mercado Moderno Actual
  const dates = [
    { label: 'Régimen 1: Alta Volatilidad (Shock 2020)', date: '2020-03-02T00:00:00Z' },
    { label: 'Régimen 2: Rango Estrecho y Calma (Verano 2021)', date: '2021-07-01T00:00:00Z' },
    { label: 'Régimen 3: Fuerte Tendencia Direccional (Paridad 2022)', date: '2022-09-01T00:00:00Z' },
    { label: 'Régimen 4: Mercado Actual (2026)', date: '2026-02-02T00:00:00Z' }
  ];

  console.log('Resultados de las Simulaciones de Challenge en 4 Fechas Distintas:\n');

  for (const d of dates) {
    const res = simulateChallengeFromDate(allTrades, d.date, 100000, 0.5, 8.0, 5.0);

    console.log(`----------------------------------------------------------------------------------------`);
    console.log(`📅 ${d.label}`);
    console.log(`   Fecha de Inicio del Challenge: ${d.date.slice(0, 10)}`);
    console.log(`----------------------------------------------------------------------------------------`);
    console.log(`   🏆 Estado del Challenge: ${res.passed ? '✅ APROBADO CON ÉXITO' : '❌ SUSPENDIDO'}`);
    console.log(`   ⏱️ Duración Total: ${res.totalDays} Días Hábiles (${res.totalTrades} Operaciones)`);
    console.log(`      * Fase 1 (+8%): Superada en ${res.p1Days} días (${res.p1Trades} trades)`);
    console.log(`      * Fase 2 (+5%): Superada en ${res.p2Days} días (${res.p2Trades} trades)`);
    console.log(`   🛡️ Drawdown Máximo Diario: ${res.maxDailyDD_Pct} (Límite: 5.00%)`);
    console.log(`   🛡️ Drawdown Máximo Total : ${res.maxOverallDD_Pct} (Límite: 10.00%)\n`);
  }
}

main().catch(console.error);
