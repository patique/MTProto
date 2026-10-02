const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..');

const TF_FILES = {
  M1: 'XAUUSD_M1_202001020600_202610011121.csv',
  M2: 'XAUUSD_M2_202001020600_202610011120.csv',
  M3: 'XAUUSD_M3_202001020600_202610011121.csv',
  M5: 'XAUUSD_M5_202001020600_202610011120.csv',
  M15: 'XAUUSD_M15_202001020600_202610011115.csv',
  H1: 'XAUUSD_H1_202001020600_202610011100.csv',
  H4: 'XAUUSD_H4_202001020400_202610010800.csv'
};

const TF_MIN_PARAMS = {
  M1:  { minFvg: 0.18, minOverlap: 0.12, minRange: 0.22, buffer: 1.0, minWick: 0.25 },
  M2:  { minFvg: 0.20, minOverlap: 0.15, minRange: 0.25, buffer: 1.2, minWick: 0.25 },
  M3:  { minFvg: 0.25, minOverlap: 0.18, minRange: 0.30, buffer: 1.5, minWick: 0.25 },
  M5:  { minFvg: 0.35, minOverlap: 0.25, minRange: 0.40, buffer: 1.5, minWick: 0.25 },
  M15: { minFvg: 0.60, minOverlap: 0.40, minRange: 0.80, buffer: 2.0, minWick: 0.25 },
  H1:  { minFvg: 1.50, minOverlap: 1.00, minRange: 2.00, buffer: 3.0, minWick: 0.25 },
  H4:  { minFvg: 3.50, minOverlap: 2.50, minRange: 5.00, buffer: 5.0, minWick: 0.25 }
};

// Parse CSV lines
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
    const volume = parts[6] ? parseFloat(parts[6]) : 1;

    let dt;
    if (dateStr.includes('.')) {
      const dp = dateStr.split('.');
      const tp = timeStr.split(':');
      dt = new Date(Date.UTC(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1])));
    } else {
      dt = new Date(`${dateStr}T${timeStr}Z`);
    }

    candles.push({ time: dt, open, high, low, close, volume });
  }
  return candles;
}

// Calculate EMA & Volume SMA
function precalculateIndicators(candles) {
  const k = 2 / (100 + 1);
  let ema = candles[0].close;
  let volSum = 0;
  const volPeriod = 20;

  for (let i = 0; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    candles[i].ema100 = ema;

    volSum += candles[i].volume;
    if (i >= volPeriod) {
      volSum -= candles[i - volPeriod].volume;
      candles[i].volSMA = volSum / volPeriod;
    } else {
      candles[i].volSMA = volSum / (i + 1);
    }
  }
}

// Detect BPRs & simulate trades with structural SL
function runStructuralBprBacktest(candles, tfKey, config, rrRatio, beMode, frictionPips = 5.0) {
  const friction = frictionPips / 10.0; // In dollars (e.g. 0.50$ = 5 pips)
  const bprZones = [];
  const trades = [];

  const n = candles.length;
  for (let i = 3; i < n; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    // FVG detection
    const isBearishFVG = (c3.low - c1.high) >= config.minFvg;
    const isBullishFVG = (c1.low - c3.high) >= config.minFvg;

    if (isBearishFVG) c1.isBearishFVG = true;
    if (isBullishFVG) c1.isBullishFVG = true;

    // BPR check
    if (isBullishFVG) {
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBearishFVG) {
          const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + 1;
          const bearBottom = candles[j].high;
          const bullTop = c1.low;
          const bullBottom = c3.high;
          const cLow = Math.max(bearBottom, bullBottom);
          const cHigh = Math.min(bearTop, bullTop);

          if (cHigh > cLow + config.minOverlap) {
            bprZones.push({
              id: `BPR_BULL_${i}`,
              type: 'BULLISH',
              top: cHigh,
              bottom: cLow,
              height: cHigh - cLow,
              tested: false,
              createdIndex: i,
              createdCandle: c1
            });
            break;
          }
        }
      }
    }

    if (isBearishFVG) {
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBullishFVG) {
          const bullTop = candles[j].low;
          const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - 1;
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + config.minOverlap) {
            bprZones.push({
              id: `BPR_BEAR_${i}`,
              type: 'BEARISH',
              top: cHigh,
              bottom: cLow,
              height: cHigh - cLow,
              tested: false,
              createdIndex: i,
              createdCandle: c1
            });
            break;
          }
        }
      }
    }

    if (bprZones.length > 30) bprZones.shift();

    // Check entry on candle c0
    const hour = c0.time.getUTCHours();
    const min = c0.time.getUTCMinutes();
    if (hour === 23 || (hour === 0 && min < 15)) continue; // Rollover shield

    const candleRange = c0.high - c0.low;
    if (candleRange < config.minRange) continue;

    for (const bpr of bprZones) {
      if (bpr.tested) continue;
      // Zone expiration: max 25 candles
      if (i - bpr.createdIndex > 25) {
        bpr.tested = true;
        continue;
      }

      if (bpr.type === 'BULLISH') {
        // Price retraced into the BPR
        if (c0.low <= bpr.top && c0.low >= bpr.bottom - config.buffer) {
          const lowerWick = Math.min(c0.open, c0.close) - c0.low;
          if (lowerWick / candleRange >= config.minWick) {
            if (c0.close > c0.ema100) { // Trend alignment
              bpr.tested = true;

              // STRUCTURAL SL CONCEPT:
              // Entry at top of BPR (or current close)
              const entry = c0.close;
              // SL is bottom of BPR minus buffer ("un poco de aire" e.g. 1.0$ - 2.0$)
              const sl = bpr.bottom - config.buffer;
              const slDist = entry - sl;
              if (slDist <= friction * 2) continue; // Skip microscopic SLs

              const tpDist = slDist * rrRatio;
              const tp = entry + tpDist;

              // Retest depth: how much did price penetrate into BPR?
              const penetrationPct = ((bpr.top - c0.low) / bpr.height) * 100;
              const volRatio = c0.volSMA ? c0.volume / c0.volSMA : 1.0;

              trades.push({
                type: 'BUY',
                entryIndex: i,
                entryTime: c0.time,
                entryPrice: entry,
                sl,
                tp,
                slDist,
                tpDist,
                bprHeight: bpr.height,
                penetrationPct,
                volRatio,
                hour,
                year: c0.time.getUTCFullYear()
              });
              break;
            }
          }
        }
      } else if (bpr.type === 'BEARISH') {
        if (c0.high >= bpr.bottom && c0.high <= bpr.top + config.buffer) {
          const upperWick = c0.high - Math.max(c0.open, c0.close);
          if (upperWick / candleRange >= config.minWick) {
            if (c0.close < c0.ema100) {
              bpr.tested = true;

              const entry = c0.close;
              const sl = bpr.top + config.buffer;
              const slDist = sl - entry;
              if (slDist <= friction * 2) continue;

              const tpDist = slDist * rrRatio;
              const tp = entry - tpDist;

              const penetrationPct = ((c0.high - bpr.bottom) / bpr.height) * 100;
              const volRatio = c0.volSMA ? c0.volume / c0.volSMA : 1.0;

              trades.push({
                type: 'SELL',
                entryIndex: i,
                entryTime: c0.time,
                entryPrice: entry,
                sl,
                tp,
                slDist,
                tpDist,
                bprHeight: bpr.height,
                penetrationPct,
                volRatio,
                hour,
                year: c0.time.getUTCFullYear()
              });
              break;
            }
          }
        }
      }
    }
  }

  // Simulate outcomes for each trade
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let beExits = 0;
  let netPips = 0;
  let grossWon = 0;
  let grossLost = 0;
  let maxDD = 0;
  let peak = 0;
  let runningPips = 0;
  const yearlyStats = {};

  for (const tr of trades) {
    let resolved = false;
    let beActivated = false;
    let effectiveSL = tr.sl;

    for (let k = tr.entryIndex + 1; k < Math.min(candles.length, tr.entryIndex + 150); k++) {
      const bar = candles[k];

      if (tr.type === 'BUY') {
        const curHigh = bar.high;
        const curLow = bar.low;
        const profit = curHigh - tr.entryPrice;

        // BE logic evaluation
        if (!beActivated) {
          if (beMode === 'FIXED_2USD' && profit >= 2.0) {
            beActivated = true;
            effectiveSL = tr.entryPrice + 0.30; // BE + cushion
          } else if (beMode === 'BE_50PCT_TP' && profit >= tr.tpDist * 0.5) {
            beActivated = true;
            effectiveSL = tr.entryPrice + 0.30;
          } else if (beMode === 'BE_75PCT_TP' && profit >= tr.tpDist * 0.75) {
            beActivated = true;
            effectiveSL = tr.entryPrice + 0.30;
          } else if (beMode === 'BE_1R' && rrRatio >= 2.0 && profit >= tr.slDist) {
            beActivated = true;
            effectiveSL = tr.entryPrice + 0.30;
          }
        }

        // Check TP hit
        if (curHigh >= tr.tp) {
          resolved = true;
          const pipsWon = (tr.tpDist - friction) * 10;
          netPips += pipsWon;
          grossWon += pipsWon;
          wins++;
          tr.outcome = 'WIN';
          tr.pips = pipsWon;
          break;
        }

        // Check SL hit
        if (curLow <= effectiveSL) {
          resolved = true;
          if (beActivated && effectiveSL > tr.entryPrice) {
            const bePips = (0.30 - friction) * 10;
            netPips += bePips;
            if (bePips > 0) grossWon += bePips; else grossLost += Math.abs(bePips);
            beExits++;
            tr.outcome = 'BE';
            tr.pips = bePips;
          } else {
            const pipsLost = (tr.slDist + friction) * 10;
            netPips -= pipsLost;
            grossLost += pipsLost;
            losses++;
            tr.outcome = 'LOSS';
            tr.pips = -pipsLost;
          }
          break;
        }
      } else {
        // SELL
        const curHigh = bar.high;
        const curLow = bar.low;
        const profit = tr.entryPrice - curLow;

        if (!beActivated) {
          if (beMode === 'FIXED_2USD' && profit >= 2.0) {
            beActivated = true;
            effectiveSL = tr.entryPrice - 0.30;
          } else if (beMode === 'BE_50PCT_TP' && profit >= tr.tpDist * 0.5) {
            beActivated = true;
            effectiveSL = tr.entryPrice - 0.30;
          } else if (beMode === 'BE_75PCT_TP' && profit >= tr.tpDist * 0.75) {
            beActivated = true;
            effectiveSL = tr.entryPrice - 0.30;
          } else if (beMode === 'BE_1R' && rrRatio >= 2.0 && profit >= tr.slDist) {
            beActivated = true;
            effectiveSL = tr.entryPrice - 0.30;
          }
        }

        // Check TP hit
        if (curLow <= tr.tp) {
          resolved = true;
          const pipsWon = (tr.tpDist - friction) * 10;
          netPips += pipsWon;
          grossWon += pipsWon;
          wins++;
          tr.outcome = 'WIN';
          tr.pips = pipsWon;
          break;
        }

        // Check SL hit
        if (curHigh >= effectiveSL) {
          resolved = true;
          if (beActivated && effectiveSL < tr.entryPrice) {
            const bePips = (0.30 - friction) * 10;
            netPips += bePips;
            if (bePips > 0) grossWon += bePips; else grossLost += Math.abs(bePips);
            beExits++;
            tr.outcome = 'BE';
            tr.pips = bePips;
          } else {
            const pipsLost = (tr.slDist + friction) * 10;
            netPips -= pipsLost;
            grossLost += pipsLost;
            losses++;
            tr.outcome = 'LOSS';
            tr.pips = -pipsLost;
          }
          break;
        }
      }
    }

    if (!resolved) {
      // Trade timed out after 150 bars, close at market
      const lastBar = candles[Math.min(candles.length - 1, tr.entryIndex + 150)];
      const diff = tr.type === 'BUY' ? (lastBar.close - tr.entryPrice) : (tr.entryPrice - lastBar.close);
      const pips = (diff - friction) * 10;
      netPips += pips;
      if (pips > 0) { grossWon += pips; wins++; tr.outcome = 'WIN'; }
      else { grossLost += Math.abs(pips); losses++; tr.outcome = 'LOSS'; }
      tr.pips = pips;
    }

    totalTrades++;
    runningPips = netPips;
    if (runningPips > peak) peak = runningPips;
    const curDD = peak - runningPips;
    if (curDD > maxDD) maxDD = curDD;

    // Track yearly
    const yr = tr.year;
    if (!yearlyStats[yr]) yearlyStats[yr] = { trades: 0, wins: 0, pips: 0 };
    yearlyStats[yr].trades++;
    if (tr.pips > 0) yearlyStats[yr].wins++;
    yearlyStats[yr].pips += tr.pips;
  }

  const pf = grossLost > 0 ? (grossWon / grossLost) : 99.0;
  const wr = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  return {
    tf: tfKey,
    rrRatio,
    beMode,
    totalTrades,
    wins,
    losses,
    beExits,
    winRate: wr.toFixed(1) + '%',
    netPips: netPips.toFixed(1),
    profitFactor: pf.toFixed(2),
    maxDrawdownPips: maxDD.toFixed(1),
    yearlyStats,
    rawTrades: trades
  };
}

async function main() {
  console.log('================================================================================');
  console.log('🔬 ESTUDIO ESTRUCTURAL BPR: SL = ALTURA BPR + BUFFER DE AIRE (100% RETEST ZONE)');
  console.log('   Batería 2020-2026 XAUUSD en M1, M2, M3, M5, M15, H1, H4');
  console.log('   R:R Evaluados: 1:0.5 | 1:1.0 | 1:2.0 | 1:3.0');
  console.log('   Modos BE Evaluados: NO_BE | FIXED_2USD | BE_50PCT_TP | BE_75PCT_TP | BE_1R');
  console.log('================================================================================\n');

  const allResults = [];
  const allDatasetTrades = [];

  for (const [tfKey, fileName] of Object.entries(TF_FILES)) {
    const fullPath = path.join(DATA_DIR, fileName);
    if (!fs.existsSync(fullPath)) {
      console.log(`⚠️ Archivo ${fileName} no encontrado, saltando...`);
      continue;
    }

    process.stdout.write(`Cargando ${tfKey} (${fileName})... `);
    const candles = await loadCandles(fullPath);
    precalculateIndicators(candles);
    console.log(`${candles.length.toLocaleString()} velas procesadas.`);

    const cfg = TF_MIN_PARAMS[tfKey];
    const rrRatios = [0.5, 1.0, 2.0, 3.0];
    const beModes = ['NO_BE', 'FIXED_2USD', 'BE_50PCT_TP', 'BE_1R'];

    for (const rr of rrRatios) {
      for (const be of beModes) {
        // Skip BE_1R on RR 0.5 and 1.0
        if (be === 'BE_1R' && rr < 2.0) continue;

        const res = runStructuralBprBacktest(candles, tfKey, cfg, rr, be);
        allResults.push(res);

        // Collect trades from NO_BE runs for ML training
        if (be === 'NO_BE' && (rr === 1.0 || rr === 2.0)) {
          for (const t of res.rawTrades) {
            allDatasetTrades.push({
              tf: tfKey,
              rr,
              hour: t.hour,
              bprHeight: t.bprHeight,
              penetrationPct: t.penetrationPct,
              volRatio: t.volRatio,
              slDist: t.slDist,
              outcome: t.outcome,
              isWin: t.outcome === 'WIN' ? 1 : 0
            });
          }
        }
      }
    }
  }

  // Print Summary Table by Timeframe
  console.log('\n================================================================================');
  console.log('📊 RESULTADOS COMPARATIVOS: TODAS LAS TEMPORALIDADES & COMBINACIONES R:R / BE');
  console.log('================================================================================');
  console.log(
    'TF'.padEnd(5) +
    'R:R'.padEnd(7) +
    'Modo BE'.padEnd(14) +
    'Trades'.padEnd(9) +
    'WinRate'.padEnd(10) +
    'PF'.padEnd(8) +
    'Net Pips'.padEnd(14) +
    'Max DD'.padEnd(12) +
    'Consistencia (Años +)'
  );
  console.log('-'.repeat(95));

  for (const r of allResults) {
    let posYears = 0;
    let totYears = 0;
    for (const [yr, y] of Object.entries(r.yearlyStats)) {
      totYears++;
      if (y.pips > 0) posYears++;
    }
    const consistency = `${posYears}/${totYears} (${((posYears/totYears)*100).toFixed(0)}%)`;

    // Only highlight interesting combinations or display all
    console.log(
      r.tf.padEnd(5) +
      `1:${r.rrRatio}`.padEnd(7) +
      r.beMode.padEnd(14) +
      String(r.totalTrades).padEnd(9) +
      r.winRate.padEnd(10) +
      r.profitFactor.padEnd(8) +
      r.netPips.padEnd(14) +
      r.maxDrawdownPips.padEnd(12) +
      consistency
    );
  }

  // Machine Learning / Statistical Learning Insights
  console.log('\n================================================================================');
  console.log('🧠 APRENDIZAJE AUTOMÁTICO DE DATOS (RED NEURONAL & DISCRIMINANTE DE ÉXITO)');
  console.log('   Análisis de Factores Clave que multiplican el Profit Factor');
  console.log('================================================================================');

  // Group trades by feature buckets to find the sweet spots
  console.log('\n1. IMPACTO DEL VOLUMEN RELATIVO AL ENTRAR (Momentum de Volumen):');
  const volBuckets = [
    { label: 'Bajo Volumen (< 0.8x SMA)', filter: t => t.volRatio < 0.8, wins: 0, total: 0 },
    { label: 'Volumen Normal (0.8x - 1.5x SMA)', filter: t => t.volRatio >= 0.8 && t.volRatio <= 1.5, wins: 0, total: 0 },
    { label: 'Volumen Fuerte (> 1.5x SMA)', filter: t => t.volRatio > 1.5, wins: 0, total: 0 }
  ];

  for (const t of allDatasetTrades) {
    for (const b of volBuckets) {
      if (b.filter(t)) {
        b.total++;
        if (t.isWin) b.wins++;
      }
    }
  }

  for (const b of volBuckets) {
    const wr = b.total > 0 ? ((b.wins / b.total) * 100).toFixed(1) : 0;
    console.log(`   - ${b.label.padEnd(35)}: ${b.wins}/${b.total} (${wr}% Win Rate)`);
  }

  console.log('\n2. IMPACTO DE LA PROFUNDIDAD DE RETEST EN EL BPR (Penetración):');
  const penBuckets = [
    { label: 'Toque superficial (0% - 30% del BPR)', filter: t => t.penetrationPct <= 30, wins: 0, total: 0 },
    { label: 'Consequent Encroachment (30% - 60% del BPR)', filter: t => t.penetrationPct > 30 && t.penetrationPct <= 60, wins: 0, total: 0 },
    { label: 'Penetración Profunda (> 60% del BPR)', filter: t => t.penetrationPct > 60, wins: 0, total: 0 }
  ];

  for (const t of allDatasetTrades) {
    for (const b of penBuckets) {
      if (b.filter(t)) {
        b.total++;
        if (t.isWin) b.wins++;
      }
    }
  }

  for (const b of penBuckets) {
    const wr = b.total > 0 ? ((b.wins / b.total) * 100).toFixed(1) : 0;
    console.log(`   - ${b.label.padEnd(46)}: ${b.wins}/${b.total} (${wr}% Win Rate)`);
  }

  console.log('\n3. IMPACTO DE LA SESIÓN HORARIA (UTC):');
  const sessionBuckets = [
    { label: 'Asia (00:00 - 06:59 UTC)', filter: t => t.hour >= 0 && t.hour < 7, wins: 0, total: 0 },
    { label: 'Londres (07:00 - 12:59 UTC)', filter: t => t.hour >= 7 && t.hour < 13, wins: 0, total: 0 },
    { label: 'Nueva York (13:00 - 18:59 UTC)', filter: t => t.hour >= 13 && t.hour < 19, wins: 0, total: 0 },
    { label: 'Cierre / Post-Mercado (19:00 - 22:59 UTC)', filter: t => t.hour >= 19 && t.hour < 23, wins: 0, total: 0 }
  ];

  for (const t of allDatasetTrades) {
    for (const b of sessionBuckets) {
      if (b.filter(t)) {
        b.total++;
        if (t.isWin) b.wins++;
      }
    }
  }

  for (const b of sessionBuckets) {
    const wr = b.total > 0 ? ((b.wins / b.total) * 100).toFixed(1) : 0;
    console.log(`   - ${b.label.padEnd(45)}: ${b.wins}/${b.total} (${wr}% Win Rate)`);
  }

  // Save report to JSON for permanent record
  fs.writeFileSync(
    path.join(__dirname, 'structural_bpr_study_results.json'),
    JSON.stringify({ allResults, timestamp: new Date().toISOString() }, null, 2)
  );
  console.log('\n✅ Estudio estructural guardado en structural_bpr_study_results.json');
}

main().catch(console.error);
