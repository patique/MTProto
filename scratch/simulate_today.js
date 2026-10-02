const fs = require('fs');
const readline = require('readline');

async function loadCandles(file) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const candles = [];
  for await (const line of rl) {
    if (!line || line.startsWith('Date') || line.startsWith('<')) continue;
    const parts = line.split('\t').length > 1 ? line.split('\t') : line.split(',');
    if (parts.length < 5) continue;
    if (parts[0] >= '2026.09.28') {
      const timeParts = parts[1].split(':');
      candles.push({
        date: parts[0],
        time: parts[1],
        hour: parseInt(timeParts[0], 10),
        min: parseInt(timeParts[1], 10),
        open: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        close: parseFloat(parts[5]),
        range: parseFloat(parts[3]) - parseFloat(parts[4])
      });
    }
  }
  return candles;
}

function appendCache(candles, cacheList) {
  const existing = new Set(candles.map(c => c.time));
  for (const c of (cacheList || [])) {
    if (c.barId && c.barId.startsWith('2026-10-1')) {
      const timeStr = c.barId.split(' ')[1] + ':00';
      if (!existing.has(timeStr)) {
        candles.push({
          date: '2026.10.01',
          time: timeStr,
          hour: parseInt(timeStr.split(':')[0], 10),
          min: parseInt(timeStr.split(':')[1], 10),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          range: c.high - c.low,
          ema100: c.ema100
        });
        existing.add(timeStr);
      }
    }
  }
  candles.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
  });
}

async function runConsolidatedSimulation() {
  console.log('🚀 Iniciando simulación auditada completa para HOY (01/10/2026)...');

  // ==========================================
  // 1. CARGA DE DATOS EURUSD
  // ==========================================
  const eurCache = JSON.parse(fs.readFileSync('bpr_eurusd_candle_cache.json', 'utf8'));
  const eurCandles = {
    M2: await loadCandles('EURUSD_M2_202001020600_202610011028.csv'),
    M3: await loadCandles('EURUSD_M3_202001020600_202610011027.csv'),
    M5: await loadCandles('EURUSD_M5_202001020600_202610011025.csv'),
    M15: await loadCandles('EURUSD_M15_202001020600_202610011015.csv')
  };
  for (const tf of ['M2', 'M3', 'M5', 'M15']) {
    appendCache(eurCandles[tf], eurCache[tf]);
  }

  // ==========================================
  // 2. CARGA DE DATOS XAUUSD
  // ==========================================
  const xauCache = JSON.parse(fs.readFileSync('bpr_candle_cache.json', 'utf8'));
  const xauCandles = {
    M1: await loadCandles('XAUUSD_M1_202001020600_202610011121.csv'),
    M2: await loadCandles('XAUUSD_M2_202001020600_202610011120.csv'),
    M3: await loadCandles('XAUUSD_M3_202001020600_202610011121.csv'),
    M5: await loadCandles('XAUUSD_M5_202001020600_202610011120.csv'),
    M15: await loadCandles('XAUUSD_M15_202001020600_202610011115.csv')
  };
  for (const tf of ['M1', 'M2', 'M3', 'M5', 'M15']) {
    appendCache(xauCandles[tf], xauCache[tf]);
  }

  const allTrades = [];

  // ==========================================
  // 3. ESTRATEGIA EURUSD MULTI-TF (Opción A: 07:00 a 19:00 UTC)
  // ==========================================
  const eurConfigs = {
    M2:  { minFvgGap: 0.00018, minOverlap: 0.00012, slMinPips: 2.0, bufferPips: 1.2, minRange: 0.00022 },
    M3:  { minFvgGap: 0.00020, minOverlap: 0.00015, slMinPips: 2.5, bufferPips: 1.5, minRange: 0.00025 },
    M5:  { minFvgGap: 0.00030, minOverlap: 0.00020, slMinPips: 3.0, bufferPips: 2.0, minRange: 0.00035 },
    M15: { minFvgGap: 0.00050, minOverlap: 0.00035, slMinPips: 4.0, bufferPips: 2.0, minRange: 0.00060 }
  };

  for (const tf of ['M2', 'M3', 'M5', 'M15']) {
    const list = eurCandles[tf];
    const cfg = eurConfigs[tf];
    const bufferPrice = cfg.bufferPips / 10000;
    const bprZones = [];

    for (let i = 2; i < list.length; i++) {
      const c0 = list[i];
      const c2 = list[i - 2];
      const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
      const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;
      if (isBearishFVG) c0.isBearish = true;
      if (isBullishFVG) c0.isBullish = true;

      if (isBullishFVG) {
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
          if (list[j].isBearish) {
            const bearBottom = list[j].high;
            const bullBottom = c2.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const bearTop = list[j - 2] ? list[j - 2].low : list[j].high + cfg.minFvgGap;
            const bullTop = c0.low;
            const cHigh = Math.min(bearTop, bullTop);
            if (cHigh > cLow + cfg.minOverlap) {
              bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, ce: (cHigh + cLow)/2, idx: i, tested: false });
              break;
            }
          }
        }
      }

      if (isBearishFVG) {
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
          if (list[j].isBullish) {
            const bullBottom = list[j - 2] ? list[j - 2].high : list[j].low - cfg.minFvgGap;
            const bearBottom = c0.high;
            const cLow = Math.max(bullBottom, bearBottom);
            const bullTop = list[j].low;
            const bearTop = c2.low;
            const cHigh = Math.min(bullTop, bearTop);
            if (cHigh > cLow + cfg.minOverlap) {
              bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, ce: (cHigh + cLow)/2, idx: i, tested: false });
              break;
            }
          }
        }
      }

      // Solo hoy 01/10/2026 entre 07:00 y 19:00 UTC
      if (c0.date !== '2026.10.01') continue;
      if (c0.hour < 7 || c0.hour >= 19) continue;
      if (c0.range < cfg.minRange) continue;

      for (let z = bprZones.length - 1; z >= 0; z--) {
        const bpr = bprZones[z];
        if (bpr.tested) continue;
        if (i - bpr.idx > 400) { bpr.tested = true; continue; }

        if (bpr.type === 'BULLISH') {
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - bufferPrice) {
            const lowerWick = Math.min(c0.open, c0.close) - c0.low;
            if (lowerWick / c0.range >= 0.20) {
              bpr.tested = true;
              const entry = bpr.ce;
              const sl = bpr.bottom - bufferPrice;
              const slPips = parseFloat(((entry - sl) * 10000).toFixed(1));
              if (slPips < cfg.slMinPips) continue;
              const tp = entry + (entry - sl);
              const tpPips = slPips;

              let outcome = null;
              let closeTime = null;
              for (let f = i + 1; f < list.length; f++) {
                if (list[f].low <= sl) { outcome = 'LOSS'; closeTime = list[f].time; break; }
                if (list[f].high >= tp) { outcome = 'WIN'; closeTime = list[f].time; break; }
              }

              allTrades.push({
                symbol: 'EURUSD',
                tf,
                type: 'BUY',
                time: c0.time,
                closeTime: closeTime || 'OPEN',
                entry: parseFloat(entry.toFixed(5)),
                sl: parseFloat(sl.toFixed(5)),
                tp: parseFloat(tp.toFixed(5)),
                slPips,
                tpPips,
                outcome: outcome || 'RUNNING',
                pips: outcome === 'WIN' ? tpPips : (outcome === 'LOSS' ? -slPips : 0)
              });
              break;
            }
          }
        } else if (bpr.type === 'BEARISH') {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + bufferPrice) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if (upperWick / c0.range >= 0.20) {
              bpr.tested = true;
              const entry = bpr.ce;
              const sl = bpr.top + bufferPrice;
              const slPips = parseFloat(((sl - entry) * 10000).toFixed(1));
              if (slPips < cfg.slMinPips) continue;
              const tp = entry - (sl - entry);
              const tpPips = slPips;

              let outcome = null;
              let closeTime = null;
              for (let f = i + 1; f < list.length; f++) {
                if (list[f].high >= sl) { outcome = 'LOSS'; closeTime = list[f].time; break; }
                if (list[f].low <= tp) { outcome = 'WIN'; closeTime = list[f].time; break; }
              }

              allTrades.push({
                symbol: 'EURUSD',
                tf,
                type: 'SELL',
                time: c0.time,
                closeTime: closeTime || 'OPEN',
                entry: parseFloat(entry.toFixed(5)),
                sl: parseFloat(sl.toFixed(5)),
                tp: parseFloat(tp.toFixed(5)),
                slPips,
                tpPips,
                outcome: outcome || 'RUNNING',
                pips: outcome === 'WIN' ? tpPips : (outcome === 'LOSS' ? -slPips : 0)
              });
              break;
            }
          }
        }
      }
    }
  }

  // ==========================================
  // 4. ESTRATEGIA XAUUSD MULTI-TF (01:00 a 22:00 UTC)
  // ==========================================
  const xauConfigs = {
    M1:  { minFvgGap: 0.18, minOverlap: 0.12, slPips: 16.0, tp1Pips: 15.0, tp2Pips: 20.0, autoBe: 15.0, minRange: 0.22, minWickRatio: 0.35, useSessionFilter: true },
    M2:  { minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0, autoBe: 20.0, minRange: 0.22, minWickRatio: 0.25 },
    M3:  { minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0, autoBe: 20.0, minRange: 0.25, minWickRatio: 0.25 },
    M5:  { minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0, autoBe: 25.0, minRange: 0.35, minWickRatio: 0.25 },
    M15: { minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60, minWickRatio: 0.25 }
  };

  // Precalcular EMA100 en XAU
  for (const tf of ['M1', 'M2', 'M3', 'M5', 'M15']) {
    const list = xauCandles[tf];
    if (list.length === 0) continue;
    const k = 2 / (100 + 1);
    let ema = list[0].close;
    for (let i = 0; i < list.length; i++) {
      ema = list[i].close * k + ema * (1 - k);
      list[i].ema100 = ema;
    }
  }

  for (const tf of ['M1', 'M2', 'M3', 'M5', 'M15']) {
    const list = xauCandles[tf];
    const cfg = xauConfigs[tf];
    const bprZones = [];

    for (let i = 2; i < list.length; i++) {
      const c0 = list[i];
      const c2 = list[i - 2];
      const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
      const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;
      if (isBearishFVG) c0.isBearish = true;
      if (isBullishFVG) c0.isBullish = true;

      if (isBullishFVG) {
        for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
          if (list[j].isBearish) {
            const bearBottom = list[j].high;
            const bullBottom = c2.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const bearTop = list[j - 2] ? list[j - 2].low : list[j].high + cfg.minFvgGap;
            const bullTop = c0.low;
            const cHigh = Math.min(bearTop, bullTop);
            if (cHigh > cLow + cfg.minOverlap) {
              bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, tested: false });
              break;
            }
          }
        }
      }

      if (isBearishFVG) {
        for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
          if (list[j].isBullish) {
            const bullBottom = list[j - 2] ? list[j - 2].high : list[j].low - cfg.minFvgGap;
            const bearBottom = c0.high;
            const cLow = Math.max(bullBottom, bearBottom);
            const bullTop = list[j].low;
            const bearTop = c2.low;
            const cHigh = Math.min(bullTop, bearTop);
            if (cHigh > cLow + cfg.minOverlap) {
              bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, tested: false });
              break;
            }
          }
        }
      }

      if (bprZones.length > 25) bprZones.shift();

      if (c0.date !== '2026.10.01') continue;

      // Bloqueo estricto anti-rollover y gaps hasta las 01:00 UTC
      if (c0.hour === 22 || c0.hour === 23 || c0.hour === 0) continue;

      // Para M1: sesión prime 07:00 a 18:00 UTC
      if (cfg.useSessionFilter && (c0.hour < 7 || c0.hour >= 18)) continue;
      if (c0.range < cfg.minRange) continue;

      for (const bpr of bprZones) {
        if (bpr.tested) continue;

        if (bpr.type === 'BULLISH') {
          if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.5) {
            const lowerWick = Math.min(c0.open, c0.close) - c0.low;
            if ((lowerWick / c0.range) >= cfg.minWickRatio && c0.close > c0.ema100) {
              bpr.tested = true;
              const entry = bpr.top;
              const sl = bpr.bottom - (cfg.slPips / 10.0);
              const tp1 = entry + (cfg.tp1Pips / 10.0);
              const tp2 = entry + (cfg.tp2Pips / 10.0);

              let outcome = 'OPEN';
              let closeTime = null;
              let tp1Hit = false;
              let currentSL = sl;
              let pipsWon = 0;

              for (let f = i + 1; f < list.length; f++) {
                const fut = list[f];
                if (!tp1Hit && fut.high >= tp1) {
                  tp1Hit = true;
                  currentSL = entry + 0.3; // BE garantizado
                }
                if (tp1Hit && fut.high >= tp2) {
                  outcome = 'TP2_FULL_WIN';
                  pipsWon = (cfg.tp1Pips * 0.5) + (cfg.tp2Pips * 0.5);
                  closeTime = fut.time;
                  break;
                }
                if (fut.low <= currentSL) {
                  if (tp1Hit) {
                    outcome = 'TP1_HALF_WIN';
                    pipsWon = (cfg.tp1Pips * 0.5) + (0.3 * 10 * 0.5);
                  } else {
                    outcome = 'LOSS';
                    pipsWon = -cfg.slPips;
                  }
                  closeTime = fut.time;
                  break;
                }
              }

              allTrades.push({
                symbol: 'XAUUSD',
                tf,
                type: 'BUY',
                time: c0.time,
                closeTime: closeTime || 'OPEN',
                entry: parseFloat(entry.toFixed(2)),
                sl: parseFloat(sl.toFixed(2)),
                tp: parseFloat(tp2.toFixed(2)),
                slPips: cfg.slPips,
                tpPips: cfg.tp2Pips,
                outcome,
                pips: parseFloat(pipsWon.toFixed(1))
              });
              break;
            }
          }
        } else if (bpr.type === 'BEARISH') {
          if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.5) {
            const upperWick = c0.high - Math.max(c0.open, c0.close);
            if ((upperWick / c0.range) >= cfg.minWickRatio && c0.close < c0.ema100) {
              bpr.tested = true;
              const entry = bpr.bottom;
              const sl = bpr.top + (cfg.slPips / 10.0);
              const tp1 = entry - (cfg.tp1Pips / 10.0);
              const tp2 = entry - (cfg.tp2Pips / 10.0);

              let outcome = 'OPEN';
              let closeTime = null;
              let tp1Hit = false;
              let currentSL = sl;
              let pipsWon = 0;

              for (let f = i + 1; f < list.length; f++) {
                const fut = list[f];
                if (!tp1Hit && fut.low <= tp1) {
                  tp1Hit = true;
                  currentSL = entry - 0.3;
                }
                if (tp1Hit && fut.low <= tp2) {
                  outcome = 'TP2_FULL_WIN';
                  pipsWon = (cfg.tp1Pips * 0.5) + (cfg.tp2Pips * 0.5);
                  closeTime = fut.time;
                  break;
                }
                if (fut.high >= currentSL) {
                  if (tp1Hit) {
                    outcome = 'TP1_HALF_WIN';
                    pipsWon = (cfg.tp1Pips * 0.5) + (0.3 * 10 * 0.5);
                  } else {
                    outcome = 'LOSS';
                    pipsWon = -cfg.slPips;
                  }
                  closeTime = fut.time;
                  break;
                }
              }

              allTrades.push({
                symbol: 'XAUUSD',
                tf,
                type: 'SELL',
                time: c0.time,
                closeTime: closeTime || 'OPEN',
                entry: parseFloat(entry.toFixed(2)),
                sl: parseFloat(sl.toFixed(2)),
                tp: parseFloat(tp2.toFixed(2)),
                slPips: cfg.slPips,
                tpPips: cfg.tp2Pips,
                outcome,
                pips: parseFloat(pipsWon.toFixed(1))
              });
              break;
            }
          }
        }
      }
    }
  }

  // Ordenar cronológicamente por hora
  allTrades.sort((a, b) => a.time.localeCompare(b.time));

  // ==========================================
  // 5. CÁLCULO MONETARIO EN 5K Y 100K
  // ==========================================
  let the5ersBalance = 5000.0;
  let ftmoBalance = 100000.0;
  let wins = 0, losses = 0;

  console.log('\n================================================================================');
  console.log('📊 REPORTE CONSOLIDADO DETALLADO - OPERACIONES HOY (01/10/2026)');
  console.log('================================================================================\n');

  allTrades.forEach((t, i) => {
    let the5ersLot = 0;
    let ftmoLot = 0;
    let the5ersUSD = 0;
    let ftmoUSD = 0;

    if (t.symbol === 'EURUSD') {
      // Forex: $10 por pip y lote. Riesgo: 0.75% ($37.50 en 5k / $750 en 100k)
      the5ersLot = Math.min(1.00, Math.max(0.01, Math.floor((37.50 / (t.slPips * 10)) * 100) / 100));
      the5ersUSD = parseFloat((t.pips * 10.0 * the5ersLot).toFixed(2));

      ftmoLot = Math.min(20.00, Math.max(0.01, Math.floor((750.00 / (t.slPips * 10)) * 100) / 100));
      ftmoUSD = parseFloat((t.pips * 10.0 * ftmoLot).toFixed(2));
    } else { // XAUUSD
      // Metales: 1 pip (0.10$) = $1.00 por lote. Lotes proporcionales cap The5ers 0.10L / FTMO 2.00L
      the5ersLot = 0.10;
      the5ersUSD = parseFloat((t.pips * 1.0 * the5ersLot).toFixed(2));

      ftmoLot = 2.00;
      ftmoUSD = parseFloat((t.pips * 1.0 * ftmoLot).toFixed(2));
    }

    the5ersBalance += the5ersUSD;
    ftmoBalance += ftmoUSD;
    if (the5ersUSD > 0) wins++;
    else if (the5ersUSD < 0) losses++;

    const assetEmoji = t.symbol === 'EURUSD' ? '💶' : '🥇';
    console.log(`[#${String(i + 1).padStart(2, '0')}] ${assetEmoji} ${t.symbol} [${t.tf}] ${t.type.padEnd(4)} @ ${t.time} -> Cierre: ${t.closeTime}`);
    console.log(`     Entrada: ${t.entry} | SL: ${t.sl} (${t.slPips}p) | TP: ${t.tp} | Resultado: ${t.outcome} (${t.pips > 0 ? '+' : ''}${t.pips}p)`);
    console.log(`     👤 The5ers ($5k)   [${the5ersLot.toFixed(2)}L]: ${the5ersUSD >= 0 ? '+' : ''}$${the5ersUSD.toFixed(2)} USD`);
    console.log(`     👤 FTMO ($100k)    [${ftmoLot.toFixed(2)}L]: ${ftmoUSD >= 0 ? '+' : ''}$${ftmoUSD.toFixed(2)} USD`);
    console.log('--------------------------------------------------------------------------------');
  });

  const totalTrades = allTrades.length;
  const wr = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const the5ersGain = the5ersBalance - 5000.0;
  const ftmoGain = ftmoBalance - 100000.0;

  console.log('\n================================================================================');
  console.log('🏆 RESUMEN FINAL CONSOLIDADO DE HOY (01/10/2026)');
  console.log('================================================================================');
  console.log(`Total Operaciones Ejecutadas: ${totalTrades}`);
  console.log(`Ganadas: ${wins} | Perdidas: ${losses} | Win Rate: ${wr}%`);
  console.log(`\n💰 CUENTA THE5ERS ($5,000 USD):`);
  console.log(`   Balance Inicial: $5,000.00 USD`);
  console.log(`   Balance Final:   $${the5ersBalance.toFixed(2)} USD`);
  console.log(`   Ganancia Neta:   +$${the5ersGain.toFixed(2)} USD (+${((the5ersGain / 5000) * 100).toFixed(2)}%)`);
  console.log(`\n💰 CUENTA FTMO ($100,000 USD):`);
  console.log(`   Balance Inicial: $100,000.00 USD`);
  console.log(`   Balance Final:   $${ftmoBalance.toFixed(2)} USD`);
  console.log(`   Ganancia Neta:   +$${ftmoGain.toFixed(2)} USD (+${((ftmoGain / 100000) * 100).toFixed(2)}%)`);
  console.log('================================================================================\n');
}

runConsolidatedSimulation();
