const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', '..');

const NAS_FILES = {
  M1:  path.join(DATA_DIR, 'NAS100_M1_202001010300_202610011029.csv'),
  M2:  path.join(DATA_DIR, 'NAS100_M2_202001010300_202610011028.csv'),
  M3:  path.join(DATA_DIR, 'NAS100_M3_202001010300_202610011027.csv'),
  M5:  path.join(DATA_DIR, 'NAS100_M5_202001010300_202610011025.csv'),
  M15: path.join(DATA_DIR, 'NAS100_M15_202001010300_202610011015.csv')
};

async function loadCandles(filePath) {
  const candles = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const [y, m, d] = parts[0].split('.').map(Number);
    const [h, min, s] = parts[1].split(':').map(Number);
    const timeMs = new Date(Date.UTC(y, m - 1, d, h, min, s)).getTime();

    candles.push({
      time: new Date(timeMs),
      timeMs,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPoints: parts.length >= 9 ? (parseFloat(parts[8]) / 100.0) : 2.0
    });
  }

  // EMA 100
  if (candles.length > 0) {
    let ema = candles[0].close;
    const k = 2 / (100 + 1);
    for (const c of candles) {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    }
  }

  return candles;
}

// 1. Análisis de Spread y Volatilidad por Hora en NAS100
async function analyzeHourlyNas100() {
  console.log('⏳ Analizando perfil horario de NAS100 (2020-2026)...');
  const candles = await loadCandles(NAS_FILES.M5);

  const stats = Array.from({ length: 24 }, () => ({ count: 0, rangeSum: 0, spreadSum: 0 }));
  for (const c of candles) {
    stats[c.hour].count++;
    stats[c.hour].rangeSum += (c.high - c.low);
    stats[c.hour].spreadSum += c.spreadPoints;
  }

  console.log('\n========================================================================================');
  console.log('📊 PERFIL HORARIO INSTITUCIONAL NAS100 (UTC) | VOLATILIDAD Y SPREAD');
  console.log('========================================================================================');
  console.log('Hora UTC | Sesión          | Rango M5 (pts) | Spread (pts) | Estado');
  console.log('----------------------------------------------------------------------------------------');

  for (let h = 0; h < 24; h++) {
    const s = stats[h];
    if (s.count === 0) continue;
    const avgR = (s.rangeSum / s.count).toFixed(1);
    const avgS = (s.spreadSum / s.count).toFixed(2);

    let session = 'Off-hours';
    if (h >= 13 && h <= 20) session = 'Wall Street (US)';
    else if (h >= 7 && h <= 12) session = 'Londres (EU)';
    else if (h === 21 || h === 22) session = 'Cierre / Rollover';

    let tag = '⚪ Normal';
    if (h === 21 || h === 22) tag = '🔴 SPREAD ALTO (Bloquear)';
    else if (h >= 13 && h <= 17) tag = '🟢 LIQUIDEZ MÁXIMA (US Core)';
    else if (h >= 8 && h <= 12) tag = '🟡 Moderado (Londres)';

    console.log(`${String(h).padStart(2, '0')}:00    | ${session.padEnd(16)} | ${avgR.padStart(7)} pts     | ${avgS.padStart(5)} pts   | ${tag}`);
  }
}

// 2. Backtest SÓLO COMPRAS (Bullish BPR)
function backtestBullishBpr(candles, tfKey, cfg, sessionMode = 'US_CORE', rrRatio = 1.0) {
  const bprZones = [];
  const trades = [];
  let lastTradeIdx = -100;

  for (let i = 3; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
    const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
    if (isBearishFVG) c1.isBearish = true;
    if (isBullishFVG) c1.isBullish = true;

    // Solo creamos zonas BULLISH (Buscamos compras en el retesteo)
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
            bprZones.push({
              type: 'BULLISH',
              top: cHigh,
              bottom: cLow,
              tested: false,
              createdIdx: i,
              createdTime: c0.timeMs
            });
            break;
          }
        }
      }
    }

    while (bprZones.length > 250) bprZones.shift();

    if (i - lastTradeIdx < 3) continue;

    // Filtros de Sesión Horaria
    const h = c0.hour;
    const m = c0.minute;
    if (h === 21 || h === 22) continue; // Bloqueo diario rollover

    if (sessionMode === 'US_CORE') {
      // 13:30 a 20:00 UTC (Apertura de New York hasta el cierre)
      const minOfDay = h * 60 + m;
      if (minOfDay < 810 || minOfDay >= 1200) continue;
    } else if (sessionMode === 'US_PLUS_EU') {
      // 08:00 a 20:00 UTC
      if (h < 8 || h >= 20) continue;
    }

    const candleRange = c0.high - c0.low;
    if (candleRange < cfg.minRange) continue;

    for (let z = bprZones.length - 1; z >= 0; z--) {
      const bpr = bprZones[z];
      if (bpr.tested) continue;
      if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

      // ENTRADA BUY: El precio baja a retestear la caja Bullish BPR
      if (c0.low <= bpr.top && c0.low >= bpr.bottom - cfg.buffer) {
        // Mecha inferior de rechazo >= 20%
        const lowerWick = Math.min(c0.open, c0.close) - c0.low;
        if (lowerWick / candleRange < 0.20) continue;

        // Filtro tendencial EMA 100 para compras
        if (c0.close < c0.ema100) continue;

        bpr.tested = true;
        lastTradeIdx = i;

        const entry = (bpr.top + bpr.bottom) / 2.0; // Consequent Encroachment 50%
        const slPrice = bpr.bottom - cfg.buffer;
        const slDist = entry - slPrice;
        if (slDist < cfg.slMin || slDist > cfg.slMax) continue;

        const tpDist = slDist * rrRatio;
        const tpPrice = entry + tpDist;

        let won = false;
        let exitTimeMs = c0.timeMs;
        for (let k = i + 1; k < Math.min(candles.length, i + 200); k++) {
          exitTimeMs = candles[k].timeMs;
          if (candles[k].high >= tpPrice) { won = true; break; }
          if (candles[k].low <= slPrice) { won = false; break; }
        }

        trades.push({
          tf: tfKey,
          time: c0.time,
          entry,
          sl: slPrice,
          tp: tpPrice,
          slPts: slDist,
          tpPts: tpDist,
          won,
          points: won ? tpDist : -slDist
        });
        break;
      }
    }
  }

  const total = trades.length;
  if (total === 0) return { total: 0, wr: 0, pf: 0, netPts: 0, maxDd: 0, tradesPerDay: 0 };

  const wins = trades.filter(t => t.won).length;
  const wr = (wins / total) * 100;
  const grossWon = trades.reduce((a, t) => a + (t.won ? t.tpPts : 0), 0);
  const grossLost = trades.reduce((a, t) => a + (!t.won ? t.slPts : 0), 0);
  const pf = grossLost > 0 ? (grossWon / grossLost) : 99.9;
  const netPts = grossWon - grossLost;

  let peak = 0, curr = 0, maxDd = 0;
  for (const t of trades) {
    curr += t.points;
    if (curr > peak) peak = curr;
    if (peak - curr > maxDd) maxDd = peak - curr;
  }

  return {
    total,
    wins,
    losses: total - wins,
    wr: wr.toFixed(1),
    pf: pf.toFixed(2),
    netPts: Math.round(netPts),
    maxDd: Math.round(maxDd),
    tradesPerDay: (total / 1730).toFixed(2),
    avgSl: (trades.reduce((a, t) => a + t.slPts, 0) / total).toFixed(1)
  };
}

async function run() {
  await analyzeHourlyNas100();

  console.log('\n========================================================================================');
  console.log('🔬 AUDITORÍA CUANTITATIVA NAS100 SÓLO COMPRAS (BULLISH BPR) 2020-2026');
  console.log('========================================================================================');

  // Parámetros por temporalidad (puntos de índice)
  const configs = {
    M2:  { gap: 6.0,  overlap: 3.5, minRange: 7.0,  buffer: 4.0, slMin: 6.0,  slMax: 40.0 },
    M3:  { gap: 8.0,  overlap: 4.5, minRange: 9.0,  buffer: 5.0, slMin: 8.0,  slMax: 50.0 },
    M5:  { gap: 12.0, overlap: 6.0, minRange: 14.0, buffer: 7.0, slMin: 12.0, slMax: 70.0 },
    M15: { gap: 20.0, overlap: 10.0, minRange: 22.0, buffer: 10.0, slMin: 18.0, slMax: 100.0 }
  };

  console.log('\n--- 1. COMPARATIVA POR SESIÓN (M5, R:R 1:1.0) ---');
  const m5Candles = await loadCandles(NAS_FILES.M5);
  for (const s of ['US_CORE', 'US_PLUS_EU', 'ALL']) {
    const res = backtestBullishBpr(m5Candles, 'M5', configs.M5, s, 1.0);
    console.log(`Sesión: ${s.padEnd(12)} | Trades: ${String(res.total).padStart(5)} (${res.tradesPerDay}/d) | WR: ${res.wr}% | PF: ${res.pf} | Pts Netos: +${res.netPts} pts | MaxDD: -${res.maxDd} pts`);
  }

  console.log('\n--- 2. COMPARATIVA POR TEMPORALIDAD (US_CORE 13:30-20:00 UTC, R:R 1:1.0) ---');
  for (const tf of ['M2', 'M3', 'M5', 'M15']) {
    const candles = await loadCandles(NAS_FILES[tf]);
    const res = backtestBullishBpr(candles, tf, configs[tf], 'US_CORE', 1.0);
    console.log(`TF: ${tf.padEnd(4)} | Trades: ${String(res.total).padStart(5)} (${res.tradesPerDay}/d) | WR: ${res.wr}% | PF: ${res.pf} | Pts Netos: +${res.netPts} pts | SL Medio: ${res.avgSl} pts | MaxDD: -${res.maxDd} pts`);
  }

  console.log('\n--- 3. COMPARATIVA DE RATIOS R:R (NAS100 Compras en M5, US_CORE) ---');
  for (const rr of [0.8, 1.0, 1.2, 1.5, 2.0]) {
    const res = backtestBullishBpr(m5Candles, 'M5', configs.M5, 'US_CORE', rr);
    console.log(`R:R 1:${rr.toFixed(1)} | Trades: ${String(res.total).padStart(5)} | WR: ${res.wr}% | PF: ${res.pf} | Pts Netos: +${res.netPts} pts | MaxDD: -${res.maxDd} pts`);
  }
}

run().catch(console.error);
