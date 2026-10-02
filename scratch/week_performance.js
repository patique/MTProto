const fs = require('fs');
const readline = require('readline');

async function loadCandles(file, minDate) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const candles = [];
  for await (const line of rl) {
    if (!line || line.startsWith('Date') || line.startsWith('<')) continue;
    const parts = line.split('\t').length > 1 ? line.split('\t') : line.split(',');
    if (parts.length < 5) continue;
    if (parts[0] >= minDate) {
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
  const existing = new Set(candles.map(c => c.date + ' ' + c.time));
  for (const c of (cacheList || [])) {
    if (c.barId && c.barId.startsWith('2026-10-1')) {
      const timeStr = c.barId.split(' ')[1] + ':00';
      const key = '2026.10.01 ' + timeStr;
      if (!existing.has(key)) {
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
        existing.add(key);
      }
    }
  }
  candles.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.time.localeCompare(b.time);
  });
}

async function runWeekAudit() {
  console.log('⏳ Cargando velas de la semana del 28/09/2026 al 01/10/2026...');

  const eurCache = JSON.parse(fs.readFileSync('bpr_eurusd_candle_cache.json', 'utf8'));
  const eurCandles = {
    M2: await loadCandles('EURUSD_M2_202001020600_202610011028.csv', '2026.09.25'),
    M3: await loadCandles('EURUSD_M3_202001020600_202610011027.csv', '2026.09.25'),
    M5: await loadCandles('EURUSD_M5_202001020600_202610011025.csv', '2026.09.25'),
    M15: await loadCandles('EURUSD_M15_202001020600_202610011015.csv', '2026.09.25')
  };
  for (const tf of ['M2', 'M3', 'M5', 'M15']) appendCache(eurCandles[tf], eurCache[tf]);

  const xauCache = JSON.parse(fs.readFileSync('bpr_candle_cache.json', 'utf8'));
  const xauCandles = {
    M1: await loadCandles('XAUUSD_M1_202001020600_202610011121.csv', '2026.09.25'),
    M2: await loadCandles('XAUUSD_M2_202001020600_202610011120.csv', '2026.09.25'),
    M3: await loadCandles('XAUUSD_M3_202001020600_202610011121.csv', '2026.09.25'),
    M5: await loadCandles('XAUUSD_M5_202001020600_202610011120.csv', '2026.09.25'),
    M15: await loadCandles('XAUUSD_M15_202001020600_202610011115.csv', '2026.09.25')
  };
  for (const tf of ['M1', 'M2', 'M3', 'M5', 'M15']) appendCache(xauCandles[tf], xauCache[tf]);

  const days = ['2026.09.28', '2026.09.29', '2026.09.30', '2026.10.01'];
  const dayNames = {
    '2026.09.28': 'Lunes 28/09/2026',
    '2026.09.29': 'Martes 29/09/2026',
    '2026.09.30': 'Miércoles 30/09/2026',
    '2026.10.01': 'Jueves 01/10/2026 (Hoy)'
  };

  const resultsByDay = {};
  for (const d of days) {
    resultsByDay[d] = {
      name: dayNames[d],
      trades: [],
      wins: 0,
      losses: 0,
      the5ersUSD: 0,
      ftmoUSD: 0,
      pipsGold: 0,
      pipsForex: 0
    };
  }

  // Configs
  const eurConfigs = {
    M2:  { minFvgGap: 0.00018, minOverlap: 0.00012, slMinPips: 2.0, bufferPips: 1.2, minRange: 0.00022 },
    M3:  { minFvgGap: 0.00020, minOverlap: 0.00015, slMinPips: 2.5, bufferPips: 1.5, minRange: 0.00025 },
    M5:  { minFvgGap: 0.00030, minOverlap: 0.00020, slMinPips: 3.0, bufferPips: 2.0, minRange: 0.00035 },
    M15: { minFvgGap: 0.00050, minOverlap: 0.00035, slMinPips: 4.0, bufferPips: 2.0, minRange: 0.00060 }
  };

  // 1. Simular EURUSD para cada día
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
            const bullBottom = list[j - 2] ? list[j - 2].high : list[j].low - minFvgGap;
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

      if (!days.includes(c0.date)) continue;
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
              for (let f = i + 1; f < list.length; f++) {
                if (list[f].low <= sl) { outcome = 'LOSS'; break; }
                if (list[f].high >= tp) { outcome = 'WIN'; break; }
              }

              const pips = outcome === 'WIN' ? tpPips : (outcome === 'LOSS' ? -slPips : 0);
              const the5ersLot = Math.min(1.00, Math.max(0.01, Math.floor((37.50 / (slPips * 10)) * 100) / 100));
              const ftmoLot = Math.min(20.00, Math.max(0.01, Math.floor((750.00 / (slPips * 10)) * 100) / 100));
              const t5USD = parseFloat((pips * 10.0 * the5ersLot).toFixed(2));
              const ftUSD = parseFloat((pips * 10.0 * ftmoLot).toFixed(2));

              resultsByDay[c0.date].trades.push({
                symbol: 'EURUSD', tf, type: 'BUY', time: c0.time, entry, sl, tp, pips, outcome, t5USD, ftUSD
              });
              resultsByDay[c0.date].the5ersUSD += t5USD;
              resultsByDay[c0.date].ftmoUSD += ftUSD;
              resultsByDay[c0.date].pipsForex += pips;
              if (outcome === 'WIN') resultsByDay[c0.date].wins++;
              else if (outcome === 'LOSS') resultsByDay[c0.date].losses++;
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
              for (let f = i + 1; f < list.length; f++) {
                if (list[f].high >= sl) { outcome = 'LOSS'; break; }
                if (list[f].low <= tp) { outcome = 'WIN'; break; }
              }

              const pips = outcome === 'WIN' ? tpPips : (outcome === 'LOSS' ? -slPips : 0);
              const the5ersLot = Math.min(1.00, Math.max(0.01, Math.floor((37.50 / (slPips * 10)) * 100) / 100));
              const ftmoLot = Math.min(20.00, Math.max(0.01, Math.floor((750.00 / (slPips * 10)) * 100) / 100));
              const t5USD = parseFloat((pips * 10.0 * the5ersLot).toFixed(2));
              const ftUSD = parseFloat((pips * 10.0 * ftmoLot).toFixed(2));

              resultsByDay[c0.date].trades.push({
                symbol: 'EURUSD', tf, type: 'SELL', time: c0.time, entry, sl, tp, pips, outcome, t5USD, ftUSD
              });
              resultsByDay[c0.date].the5ersUSD += t5USD;
              resultsByDay[c0.date].ftmoUSD += ftUSD;
              resultsByDay[c0.date].pipsForex += pips;
              if (outcome === 'WIN') resultsByDay[c0.date].wins++;
              else if (outcome === 'LOSS') resultsByDay[c0.date].losses++;
              break;
            }
          }
        }
      }
    }
  }

  // 2. Simular XAUUSD para cada día
  const xauConfigs = {
    M1:  { minFvgGap: 0.18, minOverlap: 0.12, slPips: 16.0, tp1Pips: 15.0, tp2Pips: 20.0, autoBe: 15.0, minRange: 0.22, minWickRatio: 0.35, useSessionFilter: true },
    M2:  { minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0, autoBe: 20.0, minRange: 0.22, minWickRatio: 0.25 },
    M3:  { minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0, autoBe: 20.0, minRange: 0.25, minWickRatio: 0.25 },
    M5:  { minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0, autoBe: 25.0, minRange: 0.35, minWickRatio: 0.25 },
    M15: { minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60, minWickRatio: 0.25 }
  };

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
            const bullBottom = list[j - 2] ? list[j - 2].high : list[j].low - minFvgGap;
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

      if (!days.includes(c0.date)) continue;
      if (c0.hour === 22 || c0.hour === 23 || c0.hour === 0) continue;
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
              let tp1Hit = false;
              let currentSL = sl;
              let pipsWon = 0;

              for (let f = i + 1; f < list.length; f++) {
                const fut = list[f];
                if (!tp1Hit && fut.high >= tp1) {
                  tp1Hit = true;
                  currentSL = entry + 0.3;
                }
                if (tp1Hit && fut.high >= tp2) {
                  outcome = 'TP2_FULL_WIN';
                  pipsWon = (cfg.tp1Pips * 0.5) + (cfg.tp2Pips * 0.5);
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
                  break;
                }
              }

              const pips = parseFloat(pipsWon.toFixed(1));
              const t5USD = parseFloat((pips * 1.0 * 0.10).toFixed(2));
              const ftUSD = parseFloat((pips * 1.0 * 2.00).toFixed(2));

              resultsByDay[c0.date].trades.push({
                symbol: 'XAUUSD', tf, type: 'BUY', time: c0.time, entry, sl, tp: tp2, pips, outcome, t5USD, ftUSD
              });
              resultsByDay[c0.date].the5ersUSD += t5USD;
              resultsByDay[c0.date].ftmoUSD += ftUSD;
              resultsByDay[c0.date].pipsGold += pips;
              if (outcome !== 'LOSS' && outcome !== 'OPEN') resultsByDay[c0.date].wins++;
              else if (outcome === 'LOSS') resultsByDay[c0.date].losses++;
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
                  break;
                }
              }

              const pips = parseFloat(pipsWon.toFixed(1));
              const t5USD = parseFloat((pips * 1.0 * 0.10).toFixed(2));
              const ftUSD = parseFloat((pips * 1.0 * 2.00).toFixed(2));

              resultsByDay[c0.date].trades.push({
                symbol: 'XAUUSD', tf, type: 'SELL', time: c0.time, entry, sl, tp: tp2, pips, outcome, t5USD, ftUSD
              });
              resultsByDay[c0.date].the5ersUSD += t5USD;
              resultsByDay[c0.date].ftmoUSD += ftUSD;
              resultsByDay[c0.date].pipsGold += pips;
              if (outcome !== 'LOSS' && outcome !== 'OPEN') resultsByDay[c0.date].wins++;
              else if (outcome === 'LOSS') resultsByDay[c0.date].losses++;
              break;
            }
          }
        }
      }
    }
  }

  console.log('\n================================================================================');
  console.log('📅 RESULTADOS POR DÍAS SEPARADOS (LUNES 28/09 A HOY 01/10/2026)');
  console.log('================================================================================\n');

  let weekTotal5k = 0;
  let weekTotal100k = 0;
  let weekTrades = 0;
  let weekWins = 0;
  let weekLosses = 0;

  for (const d of days) {
    const res = resultsByDay[d];
    const tot = res.trades.length;
    const wr = tot > 0 ? ((res.wins / tot) * 100).toFixed(1) : '0.0';
    const pct5k = ((res.the5ersUSD / 5000.0) * 100).toFixed(2);
    const pct100k = ((res.ftmoUSD / 100000.0) * 100).toFixed(2);

    weekTotal5k += res.the5ersUSD;
    weekTotal100k += res.ftmoUSD;
    weekTrades += tot;
    weekWins += res.wins;
    weekLosses += res.losses;

    console.log(`📌 ${res.name.toUpperCase()}`);
    console.log(`   Trades Totales: ${tot} | Ganados: ${res.wins} | Perdidos: ${res.losses} | Win Rate: ${wr}%`);
    console.log(`   Pips Oro: ${res.pipsGold.toFixed(1)}p | Pips Forex: ${res.pipsForex.toFixed(1)}p`);
    console.log(`   💰 The5ers ($5k): ${res.the5ersUSD >= 0 ? '+' : ''}$${res.the5ersUSD.toFixed(2)} USD (${res.the5ersUSD >= 0 ? '+' : ''}${pct5k}%)`);
    console.log(`   💰 FTMO ($100k):  ${res.ftmoUSD >= 0 ? '+' : ''}$${res.ftmoUSD.toFixed(2)} USD (${res.ftmoUSD >= 0 ? '+' : ''}${pct100k}%)`);
    console.log('--------------------------------------------------------------------------------');
  }

  const weekWR = weekTrades > 0 ? ((weekWins / weekTrades) * 100).toFixed(1) : '0.0';
  console.log('\n================================================================================');
  console.log('🏆 TOTAL ACUMULADO DE LA SEMANA (LUNES A JUEVES)');
  console.log('================================================================================');
  console.log(`Operaciones Totales: ${weekTrades} (Ganadas: ${weekWins} | Perdidas: ${weekLosses} | Win Rate: ${weekWR}%)`);
  console.log(`Beneficio Total The5ers ($5k): ${weekTotal5k >= 0 ? '+' : ''}$${weekTotal5k.toFixed(2)} USD (+${((weekTotal5k / 5000.0) * 100).toFixed(2)}%)`);
  console.log(`Beneficio Total FTMO ($100k):  ${weekTotal100k >= 0 ? '+' : ''}$${weekTotal100k.toFixed(2)} USD (+${((weekTotal100k / 100000.0) * 100).toFixed(2)}%)`);
  console.log('================================================================================\n');
}

runWeekAudit();
