const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', '..');

const FILES = {
  M1:  path.join(DATA_DIR, 'GBPJPY_M1_202001020600_202610011029.csv'),
  M2:  path.join(DATA_DIR, 'GBPJPY_M2_202001020600_202610011028.csv'),
  M3:  path.join(DATA_DIR, 'GBPJPY_M3_202001020600_202610011027.csv'),
  M5:  path.join(DATA_DIR, 'GBPJPY_M5_202001020600_202610011025.csv'),
  M15: path.join(DATA_DIR, 'GBPJPY_M15_202001020600_202610011015.csv')
};

async function loadCandles(filePath, maxCount = Infinity) {
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
    const tickVol = parts.length >= 7 ? parseInt(parts[6]) : 1;
    // Spread in MT5 JPY pairs: points (e.g. 17 points = 1.7 pips)
    const spreadPips = parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 1.8;

    let dt;
    if (dateStr.includes('.')) {
      const dp = dateStr.split('.');
      const tp = timeStr.split(':');
      dt = new Date(Date.UTC(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1])));
    } else {
      dt = new Date(`${dateStr}T${timeStr}Z`);
    }

    candles.push({ time: dt, timeMs: dt.getTime(), open, high, low, close, tickVol, spreadPips });
    if (candles.length >= maxCount) break;
  }
  return candles;
}

// 1. Análisis de Microestructura, Volumen y Spread por Hora (en M5 para representatividad)
async function analyzeHourlyProfile() {
  console.log('⏳ Analizando perfil horario de GBPJPY en M5 (2020-2026)...');
  const candles = await loadCandles(FILES.M5);
  
  const hourlyStats = Array.from({ length: 24 }, () => ({
    count: 0,
    totalRangePips: 0,
    totalSpreadPips: 0,
    totalVolume: 0,
    spreads: []
  }));

  for (const c of candles) {
    const h = c.time.getUTCHours();
    const rangePips = (c.high - c.low) * 100; // 1 pip = 0.01 JPY -> multiplier 100
    hourlyStats[h].count++;
    hourlyStats[h].totalRangePips += rangePips;
    hourlyStats[h].totalSpreadPips += c.spreadPips;
    hourlyStats[h].totalVolume += c.tickVol;
  }

  console.log('\n========================================================================================');
  console.log('📊 PERFIL HORARIO INSTITUCIONAL GBPJPY (UTC) | VOLATILIDAD, VOLUMEN Y SPREAD');
  console.log('========================================================================================');
  console.log('Hora UTC | Sesión       | Rango M5 (pips) | Spread Medio | Vol Relativo | Estado');
  console.log('----------------------------------------------------------------------------------------');

  const maxVol = Math.max(...hourlyStats.map(s => s.count > 0 ? s.totalVolume / s.count : 0));

  for (let h = 0; h < 24; h++) {
    const s = hourlyStats[h];
    if (s.count === 0) continue;
    const avgRange = (s.totalRangePips / s.count).toFixed(1);
    const avgSpread = (s.totalSpreadPips / s.count).toFixed(2);
    const avgVol = s.totalVolume / s.count;
    const volPct = Math.round((avgVol / maxVol) * 100);

    let session = 'Off-hours';
    if (h >= 0 && h < 6) session = 'Tokio / Asia';
    else if (h === 6) session = 'Pre-Londres';
    else if (h >= 7 && h <= 11) session = 'Londres Open';
    else if (h >= 12 && h <= 16) session = 'Londres + NY';
    else if (h >= 17 && h <= 20) session = 'Wall Street';
    else if (h >= 21) session = 'Rollover/Swap';

    let tag = '⚪ Normal';
    if (h >= 21 || h === 0) tag = '🔴 SPREAD ALTO (Evitar)';
    else if (volPct >= 75) tag = '🟢 LIQUIDEZ PICO';
    else if (volPct >= 50) tag = '🟡 Alta Actividad';

    console.log(
      `${String(h).padStart(2, '0')}:00    | ${session.padEnd(12)} | ${avgRange.padStart(6)} pips    | ${avgSpread.padStart(5)} pips  | ${String(volPct).padStart(3)}% bar     | ${tag}`
    );
  }
}

// 2. Simulación de BEARISH BPR (Solo Ventas)
// GBPJPY: 1 pip = 0.01
function backtestBearishBpr(candles, tfKey, cfg, sessionStartHour = 7, sessionEndHour = 18, rrRatio = 1.0) {
  const pipMultiplier = 100; // 1 pip = 0.01 en pares JPY
  const bprZones = [];
  const trades = [];
  let lastTradeIdx = -100;

  for (let i = 3; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    // Detectar FVG Bearish (c3.low - c1.high) y FVG Bullish previo
    const isBearishFVG = (c3.low - c1.high) >= cfg.gap;
    const isBullishFVG = (c1.low - c3.high) >= cfg.gap;
    if (isBearishFVG) c1.isBearish = true;
    if (isBullishFVG) c1.isBullish = true;

    // Solo creamos zonas BEARISH (para buscar ventas en el retesteo)
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
            bprZones.push({
              type: 'BEARISH',
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

    const hour = c0.time.getUTCHours();
    // Filtro horario estricto
    if (hour < sessionStartHour || hour >= sessionEndHour) continue;

    const candleRange = c0.high - c0.low;
    if (candleRange < cfg.minRange) continue;

    const bufferPrice = cfg.bufferPips / pipMultiplier;

    for (let z = bprZones.length - 1; z >= 0; z--) {
      const bpr = bprZones[z];
      if (bpr.tested) continue;
      if (i - bpr.createdIdx > 300) { bpr.tested = true; continue; }

      // ENTRADA SELL: El precio sube a retestear la zona Bearish BPR
      if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
        // Mecha de rechazo superior >= 20%
        const upperWick = c0.high - Math.max(c0.open, c0.close);
        if (upperWick / candleRange < 0.20) continue;

        bpr.tested = true;
        lastTradeIdx = i;

        const entry = (bpr.top + bpr.bottom) / 2.0; // Consequent Encroachment 50%
        const slPrice = bpr.top + bufferPrice;
        const slDistPrice = slPrice - entry;
        const slPips = slDistPrice * pipMultiplier;

        if (slPips < cfg.slMinPips || slPips > cfg.slMaxPips) continue;

        const tpDistPrice = slDistPrice * rrRatio;
        const tpPrice = entry - tpDistPrice;
        const tpPips = slPips * rrRatio;

        // Comprobación de spread
        const entryWithSpread = entry - (c0.spreadPips / pipMultiplier);

        let won = false;
        let exitTimeMs = c0.timeMs;
        for (let k = i + 1; k < Math.min(candles.length, i + 200); k++) {
          exitTimeMs = candles[k].timeMs;
          if (candles[k].low <= tpPrice) {
            won = true;
            break;
          }
          if (candles[k].high >= slPrice) {
            won = false;
            break;
          }
        }

        trades.push({
          tf: tfKey,
          time: c0.time,
          entry,
          sl: slPrice,
          tp: tpPrice,
          slPips,
          tpPips,
          won,
          year: c0.time.getUTCFullYear()
        });
        break;
      }
    }
  }

  // Calcular métricas
  const total = trades.length;
  if (total === 0) return { total: 0, wr: 0, pf: 0, netPips: 0, maxDd: 0, tradesPerDay: 0 };

  const wins = trades.filter(t => t.won).length;
  const losses = total - wins;
  const wr = (wins / total) * 100;

  const grossWon = trades.reduce((acc, t) => acc + (t.won ? t.tpPips : 0), 0);
  const grossLost = trades.reduce((acc, t) => acc + (!t.won ? t.slPips : 0), 0);
  const pf = grossLost > 0 ? (grossWon / grossLost) : 99.9;
  const netPips = grossWon - grossLost;

  // Drawdown en pips
  let peak = 0;
  let curr = 0;
  let maxDd = 0;
  for (const t of trades) {
    curr += t.won ? t.tpPips : -t.slPips;
    if (curr > peak) peak = curr;
    const dd = peak - curr;
    if (dd > maxDd) maxDd = dd;
  }

  const tradesPerDay = (total / 1730).toFixed(2); // ~1730 días de trading en 7 años

  return {
    total,
    wins,
    losses,
    wr: wr.toFixed(1),
    pf: pf.toFixed(2),
    netPips: Math.round(netPips),
    maxDd: Math.round(maxDd),
    tradesPerDay,
    avgSl: (trades.reduce((a, t) => a + t.slPips, 0) / total).toFixed(1)
  };
}

async function runFullAnalysis() {
  await analyzeHourlyProfile();

  console.log('\n========================================================================================');
  console.log('🔬 AUDITORÍA CUANTITATIVA GBPJPY SÓLO VENTAS (7 AÑOS: 2020-2026)');
  console.log('========================================================================================');

  // Parámetros calibrados por temporalidad para GBPJPY (1 pip = 0.01)
  // GBPJPY se mueve aprox 2.5x más rápido que EURUSD (gap en JPY: 0.03 = 3 pips)
  const configs = {
    M2:  { gap: 0.035, overlap: 0.020, minRange: 0.040, bufferPips: 3.5, slMinPips: 5.0, slMaxPips: 25.0 },
    M3:  { gap: 0.045, overlap: 0.025, minRange: 0.050, bufferPips: 4.0, slMinPips: 6.0, slMaxPips: 30.0 },
    M5:  { gap: 0.060, overlap: 0.035, minRange: 0.070, bufferPips: 5.0, slMinPips: 8.0, slMaxPips: 40.0 },
    M15: { gap: 0.090, overlap: 0.050, minRange: 0.100, bufferPips: 7.0, slMinPips: 12.0, slMaxPips: 60.0 }
  };

  const sessions = [
    { name: 'Londres (07-12 UTC)', start: 7, end: 12 },
    { name: 'Londres + NY (07-18 UTC)', start: 7, end: 18 },
    { name: 'Tokio/Asia (00-06 UTC)', start: 0, end: 6 },
    { name: 'Día Completo (01-21 UTC)', start: 1, end: 21 }
  ];

  console.log('\n--- 1. COMPARATIVA POR SESIÓN HORARIA (en M5, R:R 1:1.0) ---');
  const m5Candles = await loadCandles(FILES.M5);
  for (const s of sessions) {
    const res = backtestBearishBpr(m5Candles, 'M5', configs.M5, s.start, s.end, 1.0);
    console.log(`Sesión: ${s.name.padEnd(25)} | Trades: ${String(res.total).padStart(5)} (${res.tradesPerDay}/d) | WR: ${res.wr}% | PF: ${res.pf} | Pips: ${res.netPips > 0 ? '+' : ''}${res.netPips}p | MaxDD: -${res.maxDd}p`);
  }

  console.log('\n--- 2. COMPARATIVA DE TEMPORALIDADES (Sesión Óptima 07-18 UTC, R:R 1:1.0) ---');
  for (const tf of ['M2', 'M3', 'M5', 'M15']) {
    const candles = await loadCandles(FILES[tf]);
    const res = backtestBearishBpr(candles, tf, configs[tf], 7, 18, 1.0);
    console.log(`TF: ${tf.padEnd(4)} | Trades: ${String(res.total).padStart(5)} (${res.tradesPerDay}/d) | WR: ${res.wr}% | PF: ${res.pf} | Pips: ${res.netPips > 0 ? '+' : ''}${res.netPips}p | SL Medio: ${res.avgSl}p | MaxDD: -${res.maxDd}p`);
  }

  console.log('\n--- 3. COMPARATIVA DE RATIOS R:R (GBP/JPY Ventas en M5) ---');
  for (const rr of [0.8, 1.0, 1.2, 1.5, 2.0]) {
    const res = backtestBearishBpr(m5Candles, 'M5', configs.M5, 7, 18, rr);
    console.log(`R:R 1:${rr.toFixed(1)} | Trades: ${String(res.total).padStart(5)} | WR: ${res.wr}% | PF: ${res.pf} | Pips: ${res.netPips > 0 ? '+' : ''}${res.netPips}p | MaxDD: -${res.maxDd}p`);
  }
}

runFullAnalysis().catch(console.error);
