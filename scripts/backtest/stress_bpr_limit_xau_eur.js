/**
 * Stress test BPR limit orders for XAUUSD + EURUSD.
 *
 * Hypothesis:
 * - Pending limit orders around BPR CE/edge.
 * - Small fixed SL, RR 1:3.
 * - No BE, no trailing.
 * - Multi-timeframe including synthetic M4/M10 from available MT5 CSVs.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'stress_bpr_limit_xau_eur_report.json');

const RR = 3;
const RISK_PER_TRADE = 0.0075;

const ASSETS = {
  EURUSD: {
    pipSize: 0.0001,
    pipMultiplier: 10000,
    spreadMultiplier: 0.1,
    baseTf: 'M2',
    directTfs: ['M2', 'M3', 'M5', 'M15'],
    syntheticTfs: { M4: { from: 'M2', minutes: 4 }, M10: { from: 'M5', minutes: 10 } },
    slPips: [4, 5, 6, 8],
    minFvgPips: [0.4, 0.6, 0.8, 1.0, 1.2],
    minOverlapPips: [0.2, 0.4, 0.6, 0.8],
    minRangePips: [0.8, 1.0, 1.2, 1.5, 2.0],
    bufferPips: [0.2, 0.5, 0.8, 1.2],
    wickThresholds: [0, 0.1, 0.2, 0.3],
    maxHoldBars: 180
  },
  XAUUSD: {
    pipSize: 0.1,
    pipMultiplier: 10,
    spreadMultiplier: 0.1,
    baseTf: 'M2',
    directTfs: ['M2', 'M3', 'M5', 'M15'],
    syntheticTfs: { M4: { from: 'M2', minutes: 4 }, M10: { from: 'M5', minutes: 10 } },
    slPips: [5, 6, 8, 10, 12, 15],
    minFvgPips: [0.5, 0.8, 1.0, 1.5, 2.0, 3.0],
    minOverlapPips: [0.3, 0.5, 0.8, 1.0, 1.5],
    minRangePips: [1.5, 2.0, 2.5, 3.0, 4.0],
    bufferPips: [0.5, 1.0, 1.5, 2.0],
    wickThresholds: [0, 0.1, 0.2, 0.3],
    maxHoldBars: 180
  }
};

const SESSIONS = {
  london_ny: (h) => h >= 7 && h < 19 && h !== 10,
  killzones: (h, m) => {
    const mod = h * 60 + m;
    return (mod >= 420 && mod < 600) || (mod >= 780 && mod < 960);
  },
  full_no_rollover: (h, m) => !(h === 23 || (h === 0 && m < 15))
};

function sampleValues(values, max = 3) {
  if (values.length <= max) return values;
  return [values[0], values[Math.floor(values.length / 2)], values[values.length - 1]];
}

function findCsv(symbol, tf) {
  const prefix = `${symbol}_${tf}_`;
  const files = fs.readdirSync(ROOT).filter(f => f.startsWith(prefix) && f.endsWith('.csv')).sort();
  if (!files.length) throw new Error(`Missing CSV ${symbol} ${tf}`);
  return path.join(ROOT, files[files.length - 1]);
}

function loadCsv(symbol, tf) {
  const file = findCsv(symbol, tf);
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1);
  return rows.map(line => {
    const p = line.split('\t');
    return {
      time: new Date(`${p[0].replace(/\./g, '-')}T${p[1]}Z`).getTime(),
      open: +p[2],
      high: +p[3],
      low: +p[4],
      close: +p[5],
      volume: +p[6] || 0,
      spread: +p[8] || 0
    };
  }).filter(c => Number.isFinite(c.time) && Number.isFinite(c.close));
}

function aggregate(candles, minutes) {
  const out = [];
  let cur = null;
  const bucketMs = minutes * 60 * 1000;
  for (const c of candles) {
    const bucket = Math.floor(c.time / bucketMs) * bucketMs;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur);
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, spread: c.spread };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      cur.spread = Math.max(cur.spread, c.spread);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function addEma(candles, period) {
  if (!candles.length) return candles;
  let ema = candles[0].close;
  const k = 2 / (period + 1);
  for (const c of candles) {
    ema = c.close * k + ema * (1 - k);
    c[`ema${period}`] = ema;
  }
  return candles;
}

function sessionOk(name, candle) {
  const d = new Date(candle.time);
  return SESSIONS[name](d.getUTCHours(), d.getUTCMinutes());
}

function detectZones(candles, asset, params) {
  const zones = [];
  const minFvg = params.minFvgPips * asset.pipSize;
  const minOverlap = params.minOverlapPips * asset.pipSize;
  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const bear = (c2.low - c0.high) >= minFvg;
    const bull = (c0.low - c2.high) >= minFvg;
    if (bear) c0._bear = true;
    if (bull) c0._bull = true;

    if (bull) {
      for (let j = i - 1; j >= Math.max(2, i - params.lookback); j--) {
        if (!candles[j]._bear) continue;
        const top = Math.min(candles[j - 2]?.low || candles[j].high + minFvg, c0.low);
        const bottom = Math.max(candles[j].high, c2.high);
        if (top > bottom + minOverlap) {
          zones.push({ type: 'BUY', top, bottom, ce: (top + bottom) / 2, idx: i });
          break;
        }
      }
    }

    if (bear) {
      for (let j = i - 1; j >= Math.max(2, i - params.lookback); j--) {
        if (!candles[j]._bull) continue;
        const top = Math.min(candles[j].low, c2.low);
        const bottom = Math.max(candles[j - 2]?.high || candles[j].low - minFvg, c0.high);
        if (top > bottom + minOverlap) {
          zones.push({ type: 'SELL', top, bottom, ce: (top + bottom) / 2, idx: i });
          break;
        }
      }
    }
  }
  return zones;
}

function trendOk(mode, type, c) {
  if (mode === 'none') return true;
  if (mode === 'ema100') return type === 'BUY' ? c.close >= c.ema100 : c.close <= c.ema100;
  if (mode === 'ema200') return type === 'BUY' ? c.close >= c.ema200 : c.close <= c.ema200;
  if (mode === 'ema100_200') {
    return type === 'BUY'
      ? c.close >= c.ema100 && c.ema100 >= c.ema200
      : c.close <= c.ema100 && c.ema100 <= c.ema200;
  }
  return true;
}

function entryPrice(mode, zone, type, bufferPrice) {
  if (mode === 'ce') return zone.ce;
  if (mode === 'edge') return type === 'BUY' ? zone.top : zone.bottom;
  if (mode === 'beyond_edge') return type === 'BUY' ? zone.top + bufferPrice : zone.bottom - bufferPrice;
  return zone.ce;
}

function runCase(candles, zones, asset, params) {
  const trades = [];
  let lastFill = -999;
  const slDist = params.slPips * asset.pipSize;
  const tpDist = slDist * RR;
  const bufferPrice = params.bufferPips * asset.pipSize;
  const minRange = params.minRangePips * asset.pipSize;

  for (const z of zones) {
    const type = z.type;
    const entry = entryPrice(params.entryMode, z, type, bufferPrice);
    const sl = type === 'BUY' ? entry - slDist : entry + slDist;
    const tp = type === 'BUY' ? entry + tpDist : entry - tpDist;

    for (let i = z.idx + 1; i < Math.min(candles.length, z.idx + 1 + params.ttlBars); i++) {
      if (i - lastFill < params.cooldownBars) continue;
      const c = candles[i];
      if (!sessionOk(params.session, c)) continue;
      if (!trendOk(params.trend, type, candles[Math.max(0, i - 1)])) continue;

      const range = c.high - c.low;
      if (range < minRange) continue;

      const filled = type === 'BUY' ? c.low <= entry : c.high >= entry;
      if (!filled) continue;

      if (params.confirmWick > 0) {
        const wick = type === 'BUY'
          ? Math.min(c.open, c.close) - c.low
          : c.high - Math.max(c.open, c.close);
        if (range <= 0 || wick / range < params.confirmWick) continue;
      }

      let result = null;
      let closeIdx = -1;
      for (let j = i; j < Math.min(candles.length, i + params.maxHoldBars); j++) {
        const f = candles[j];
        if (type === 'BUY') {
          const hitSL = f.low <= sl;
          const hitTP = f.high >= tp;
          if (hitSL && hitTP) { result = 'SL'; closeIdx = j; break; }
          if (hitSL) { result = 'SL'; closeIdx = j; break; }
          if (hitTP) { result = 'TP'; closeIdx = j; break; }
        } else {
          const hitSL = f.high >= sl;
          const hitTP = f.low <= tp;
          if (hitSL && hitTP) { result = 'SL'; closeIdx = j; break; }
          if (hitSL) { result = 'SL'; closeIdx = j; break; }
          if (hitTP) { result = 'TP'; closeIdx = j; break; }
        }
      }
      if (!result) break;

      const costPips = ((c.spread || 0) * asset.spreadMultiplier) + params.slippagePips;
      const pips = (result === 'TP' ? params.slPips * RR : -params.slPips) - costPips;
      trades.push({ time: c.time, result, pips, r: pips / params.slPips, closeIdx });
      lastFill = i;
      break;
    }
  }

  return summarize(trades);
}

function summarize(trades) {
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, netPips = 0, netR = 0, peakR = 0, ddR = 0;
  const byWeek = new Map();
  const byYear = {};
  for (const t of trades) {
    if (t.pips > 0) { wins++; grossWin += t.pips; } else { losses++; grossLoss += Math.abs(t.pips); }
    netPips += t.pips;
    netR += t.r;
    peakR = Math.max(peakR, netR);
    ddR = Math.max(ddR, peakR - netR);
    const d = new Date(t.time);
    const year = d.getUTCFullYear();
    const week = `${year}-W${String(Math.ceil((((t.time - Date.UTC(year, 0, 1)) / 86400000) + new Date(Date.UTC(year, 0, 1)).getUTCDay() + 1) / 7)).padStart(2, '0')}`;
    byWeek.set(week, (byWeek.get(week) || 0) + t.r);
    byYear[year] = (byYear[year] || 0) + t.r;
  }
  const weeks = [...byWeek.values()];
  const avgWeeklyPct = weeks.length ? (weeks.reduce((a, b) => a + b, 0) / weeks.length) * RISK_PER_TRADE * 100 : 0;
  const bestWeeklyPct = weeks.length ? Math.max(...weeks) * RISK_PER_TRADE * 100 : 0;
  const worstWeeklyPct = weeks.length ? Math.min(...weeks) * RISK_PER_TRADE * 100 : 0;
  return {
    trades: trades.length,
    winRate: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
    pf: grossLoss ? +(grossWin / grossLoss).toFixed(2) : 0,
    netPips: +netPips.toFixed(1),
    netR: +netR.toFixed(1),
    maxDdR: +ddR.toFixed(1),
    avgWeeklyPct: +avgWeeklyPct.toFixed(2),
    bestWeeklyPct: +bestWeeklyPct.toFixed(2),
    worstWeeklyPct: +worstWeeklyPct.toFixed(2),
    r2024: +(byYear[2024] || 0).toFixed(1),
    r2025: +(byYear[2025] || 0).toFixed(1),
    r2026: +(byYear[2026] || 0).toFixed(1)
  };
}

function topByKey(rows, keyFn, limit = 5) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.pf - a.pf || b.netR - a.netR);
    out.push(...group.slice(0, limit));
  }
  return out;
}

function buildTfCandles(symbol, asset) {
  const byTf = {};
  for (const tf of asset.directTfs) {
    byTf[tf] = addEma(addEma(loadCsv(symbol, tf), 100), 200);
  }
  for (const [tf, spec] of Object.entries(asset.syntheticTfs)) {
    byTf[tf] = addEma(addEma(aggregate(byTf[spec.from], spec.minutes), 100), 200);
  }
  return byTf;
}

function main() {
  const rows = [];
  for (const [symbol, asset] of Object.entries(ASSETS)) {
    const byTf = buildTfCandles(symbol, asset);
    for (const [tf, candles] of Object.entries(byTf)) {
      const tfMinutes = Number(tf.slice(1));
      const ttlBarsList = tfMinutes <= 3 ? [3, 8] : [2, 6];
      const lookbacks = tfMinutes <= 5 ? [10, 25] : [8, 20];
      const fvgValues = sampleValues(asset.minFvgPips, 3);
      const overlapValues = sampleValues(asset.minOverlapPips, 3);
      const rangeValues = sampleValues(asset.minRangePips, 3);
      const bufferValues = sampleValues(asset.bufferPips, 2);
      const wickValues = [0, 0.2];
      let tested = 0;

      for (const minFvgPips of fvgValues) {
        for (const minOverlapPips of overlapValues) {
          if (minOverlapPips >= minFvgPips * 1.5) continue;
          for (const lookback of lookbacks) {
            const zoneParams = { minFvgPips, minOverlapPips, lookback };
            const cloned = candles.map(c => ({ ...c }));
            const zones = detectZones(cloned, asset, zoneParams);
            if (zones.length < 20) continue;

            for (const minRangePips of rangeValues) {
              for (const slPips of asset.slPips) {
                for (const bufferPips of bufferValues) {
                  for (const ttlBars of ttlBarsList) {
                    for (const trend of ['none', 'ema100', 'ema100_200']) {
                      for (const session of ['london_ny', 'killzones']) {
                        for (const entryMode of ['ce', 'edge']) {
                          for (const confirmWick of wickValues) {
                            const params = {
                              ...zoneParams,
                              minRangePips,
                              slPips,
                              bufferPips,
                              ttlBars,
                              trend,
                              session,
                              entryMode,
                              confirmWick,
                              cooldownBars: 3,
                              maxHoldBars: asset.maxHoldBars,
                              slippagePips: 0.5
                            };
                            const res = runCase(candles, zones, asset, params);
                            tested++;
                            if (res.trades >= 60 && res.pf >= 1.05 && res.netR > 0) {
                              rows.push({ symbol, tf, rr: RR, ...params, ...res });
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      console.error(`[OK] ${symbol} ${tf}: candles=${candles.length}, tested=${tested}, candidates=${rows.filter(r => r.symbol === symbol && r.tf === tf).length}`);
    }
  }

  rows.sort((a, b) => b.pf - a.pf || b.avgWeeklyPct - a.avgWeeklyPct || b.trades - a.trades);
  const report = {
    generatedAt: new Date().toISOString(),
    assumptions: {
      rr: RR,
      riskPerTradePct: RISK_PER_TRADE * 100,
      costs: 'CSV spread converted to pips + 0.5 pips/points slippage',
      execution: 'pending limit order after BPR zone formation, conservative SL first on ambiguous candles'
    },
    topOverall: rows.slice(0, 100),
    topBySymbolTimeframe: topByKey(rows, r => `${r.symbol}:${r.tf}`, 5),
    allCandidates: rows
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    saved: OUT,
    candidates: rows.length,
    topOverall: report.topOverall.slice(0, 20),
    topBySymbolTimeframe: report.topBySymbolTimeframe
  }, null, 2));
}

main();
