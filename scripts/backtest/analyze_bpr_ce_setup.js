/**
 * Analisis aislado del setup BPR CE 50%.
 *
 * Compara dos lecturas:
 * - rejection_ce: entrada en CE 50% de la BPR cuando aparece vela de rechazo.
 *   Es util para medir el edge conceptual, pero puede sobreestimar fills reales.
 * - pending_ce: orden limit en CE colocada despues de nacer la zona BPR.
 *   Es la version mas operable para live sin BE ni trailing.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const COST_SLIPPAGE = 0.5;

const ASSETS = {
  XAUUSD: {
    pipSize: 0.1,
    pipMultiplier: 10,
    spreadMultiplier: 0.1,
    direction: 'BOTH',
    usesEma100: true,
    wickThreshold: 0.25,
    lookback: 10,
    maxBarsAfterEntry: 160,
    pendingTtlBars: 80,
    timeframes: {
      M3: { minFvgGap: 0.20, minOverlap: 0.15, minRange: 0.25, bufferPrice: 0.5, slMin: 0, slMax: Infinity, rrValues: [1, 1.5, 2] },
      M5: { minFvgGap: 0.30, minOverlap: 0.20, minRange: 0.35, bufferPrice: 0.5, slMin: 0, slMax: Infinity, rrValues: [1, 1.5, 2] },
      M15: { minFvgGap: 0.50, minOverlap: 0.35, minRange: 0.60, bufferPrice: 0.5, slMin: 0, slMax: Infinity, rrValues: [1, 1.5, 2] }
    },
    sessionFilter: (h, m) => !(h === 23 || (h === 0 && m < 15))
  },
  EURUSD: {
    pipSize: 0.0001,
    pipMultiplier: 10000,
    spreadMultiplier: 0.1,
    direction: 'BOTH',
    usesEma100: true,
    wickThreshold: 0.20,
    lookback: 25,
    maxBarsAfterEntry: 160,
    pendingTtlBars: 80,
    timeframes: {
      M2: { minFvgGap: 0.00008, minOverlap: 0.00005, minRange: 0.00010, bufferPips: 1.2, slMin: 2.0, slMax: 4.5, rrValues: [1, 1.5, 2] },
      M3: { minFvgGap: 0.00010, minOverlap: 0.00006, minRange: 0.00012, bufferPips: 1.2, slMin: 2.0, slMax: 6.0, rrValues: [1, 1.5, 2] },
      M5: { minFvgGap: 0.00012, minOverlap: 0.00008, minRange: 0.00015, bufferPips: 1.5, slMin: 2.5, slMax: 8.5, rrValues: [1, 1.5, 2] },
      M15: { minFvgGap: 0.00018, minOverlap: 0.00010, minRange: 0.00020, bufferPips: 2.0, slMin: 3.0, slMax: 15.0, rrValues: [1, 1.5, 2] }
    },
    sessionFilter: (h) => h >= 7 && h < 19 && h !== 10
  },
  GBPJPY: {
    pipSize: 0.01,
    pipMultiplier: 100,
    spreadMultiplier: 0.1,
    direction: 'SELL_ONLY',
    usesEma100: false,
    wickThreshold: 0.20,
    lookback: 25,
    maxBarsAfterEntry: 160,
    pendingTtlBars: 80,
    timeframes: {
      M2: { minFvgGap: 0.035, minOverlap: 0.020, minRange: 0.040, bufferPips: 4.0, slMin: 6.0, slMax: 35.0, rrValues: [1, 1.5, 2] },
      M3: { minFvgGap: 0.040, minOverlap: 0.025, minRange: 0.045, bufferPips: 4.5, slMin: 7.0, slMax: 40.0, rrValues: [1, 1.5, 2] },
      M5: { minFvgGap: 0.050, minOverlap: 0.030, minRange: 0.055, bufferPips: 5.0, slMin: 8.0, slMax: 50.0, rrValues: [1, 1.5, 2] },
      M15: { minFvgGap: 0.075, minOverlap: 0.045, minRange: 0.080, bufferPips: 6.0, slMin: 10.0, slMax: 70.0, rrValues: [1, 1.5, 2] }
    },
    sessionFilter: (h, m) => h >= 7 && (h < 18 || (h === 18 && m <= 30)) && h !== 10
  },
  NAS100: {
    pipSize: 1,
    pipMultiplier: 1,
    spreadMultiplier: 1,
    direction: 'BOTH',
    usesEma100: true,
    wickThreshold: 0.25,
    lookback: 25,
    maxBarsAfterEntry: 160,
    pendingTtlBars: 80,
    timeframes: {
      M2: { minFvgGap: 4.0, minOverlap: 2.5, minRange: 6.0, bufferPrice: 6.0, slMin: 8.0, slMax: 50.0, rrValues: [1, 1.5, 2, 2.5] },
      M3: { minFvgGap: 5.5, minOverlap: 3.5, minRange: 8.0, bufferPrice: 7.0, slMin: 10.0, slMax: 60.0, rrValues: [1, 1.5, 2, 2.5] },
      M5: { minFvgGap: 8.0, minOverlap: 5.0, minRange: 10.0, bufferPrice: 8.0, slMin: 12.0, slMax: 80.0, rrValues: [1, 1.5, 2, 2.5] },
      M15: { minFvgGap: 14.0, minOverlap: 8.0, minRange: 16.0, bufferPrice: 10.0, slMin: 18.0, slMax: 100.0, rrValues: [1, 1.5, 2, 2.5] }
    },
    sessionFilter: (h, m) => {
      const mod = h * 60 + m;
      return mod >= 810 && mod < 1080;
    }
  }
};

function findCsv(symbol, tf) {
  const prefix = `${symbol}_${tf}_`;
  const files = fs.readdirSync(ROOT).filter(f => f.startsWith(prefix) && f.endsWith('.csv')).sort();
  return files.length ? path.join(ROOT, files[files.length - 1]) : null;
}

function loadCandles(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1);
  const candles = [];
  for (const line of lines) {
    const p = line.split('\t');
    if (p.length < 7) continue;
    const time = new Date(`${p[0].replace(/\./g, '-')}T${p[1]}Z`).getTime();
    if (!Number.isFinite(time)) continue;
    candles.push({ time, open: +p[2], high: +p[3], low: +p[4], close: +p[5], spread: +p[8] || 0 });
  }
  let ema = candles[0]?.close || 0;
  const k = 2 / 101;
  for (const c of candles) {
    ema = c.close * k + ema * (1 - k);
    c.ema100 = ema;
  }
  return candles;
}

function scanZones(symbol, candles, cfg, lookback) {
  const zones = [];
  for (let i = 3; i < candles.length; i++) {
    if (symbol === 'GBPJPY') {
      const c1 = candles[i - 1];
      const c3 = candles[i - 3];
      const isBearishFvg = (c3.low - c1.high) >= cfg.minFvgGap;
      const isBullishFvg = (c1.low - c3.high) >= cfg.minFvgGap;
      if (isBearishFvg) c1._bear = true;
      if (isBullishFvg) c1._bull = true;
      if (!isBearishFvg) continue;
      for (let j = i - 3; j >= Math.max(2, i - lookback); j--) {
        if (!candles[j]._bull) continue;
        const top = Math.min(candles[j].low, c3.low);
        const bottom = Math.max(candles[j - 2]?.high || candles[j].low - cfg.minFvgGap, c1.high);
        if (top > bottom + cfg.minOverlap) {
          zones.push({ type: 'BEARISH', top, bottom, ce: (top + bottom) / 2, idx: i });
          break;
        }
      }
      continue;
    }

    const c0 = candles[i];
    const c2 = candles[i - 2];
    const isBearishFvg = (c2.low - c0.high) >= cfg.minFvgGap;
    const isBullishFvg = (c0.low - c2.high) >= cfg.minFvgGap;
    if (isBearishFvg) c0._bear = true;
    if (isBullishFvg) c0._bull = true;

    if (isBullishFvg) {
      for (let j = i - 1; j >= Math.max(2, i - lookback); j--) {
        if (!candles[j]._bear) continue;
        const top = Math.min(candles[j - 2]?.low || candles[j].high + cfg.minFvgGap, c0.low);
        const bottom = Math.max(candles[j].high, c2.high);
        if (top > bottom + cfg.minOverlap) {
          zones.push({ type: 'BULLISH', top, bottom, ce: (top + bottom) / 2, idx: i });
          break;
        }
      }
    }

    if (isBearishFvg) {
      for (let j = i - 1; j >= Math.max(2, i - lookback); j--) {
        if (!candles[j]._bull) continue;
        const top = Math.min(candles[j].low, c2.low);
        const bottom = Math.max(candles[j - 2]?.high || candles[j].low - cfg.minFvgGap, c0.high);
        if (top > bottom + cfg.minOverlap) {
          zones.push({ type: 'BEARISH', top, bottom, ce: (top + bottom) / 2, idx: i });
          break;
        }
      }
    }
  }
  return zones;
}

function isSession(asset, ts) {
  const d = new Date(ts);
  return asset.sessionFilter(d.getUTCHours(), d.getUTCMinutes());
}

function directionOk(asset, type) {
  if (asset.direction === 'BUY_ONLY') return type === 'BUY';
  if (asset.direction === 'SELL_ONLY') return type === 'SELL';
  return true;
}

function trendOk(asset, type, candle) {
  if (!asset.usesEma100 || !candle.ema100) return true;
  return type === 'BUY' ? candle.close >= candle.ema100 : candle.close <= candle.ema100;
}

function slTp(asset, cfg, zone, type, entry, rr) {
  const buffer = cfg.bufferPrice ?? (cfg.bufferPips * asset.pipSize);
  const sl = type === 'BUY' ? zone.bottom - buffer : zone.top + buffer;
  const slUnits = Math.abs(entry - sl) * asset.pipMultiplier;
  if (slUnits < cfg.slMin || slUnits > cfg.slMax) return null;
  const tp = type === 'BUY' ? entry + Math.abs(entry - sl) * rr : entry - Math.abs(entry - sl) * rr;
  return { sl, tp, slUnits, tpUnits: slUnits * rr };
}

function outcome(candles, startIdx, type, sl, tp, maxBars) {
  for (let i = startIdx + 1; i < Math.min(candles.length, startIdx + 1 + maxBars); i++) {
    const c = candles[i];
    if (type === 'BUY') {
      if (c.low <= sl && c.high >= tp) return { result: 'SL', idx: i };
      if (c.low <= sl) return { result: 'SL', idx: i };
      if (c.high >= tp) return { result: 'TP', idx: i };
    } else {
      if (c.high >= sl && c.low <= tp) return { result: 'SL', idx: i };
      if (c.high >= sl) return { result: 'SL', idx: i };
      if (c.low <= tp) return { result: 'TP', idx: i };
    }
  }
  return null;
}

function summarize(trades) {
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, net = 0, peak = 0, dd = 0;
  const yearly = {};
  for (const t of trades) {
    if (t.pips > 0) { wins++; grossWin += t.pips; } else { losses++; grossLoss += Math.abs(t.pips); }
    net += t.pips;
    peak = Math.max(peak, net);
    dd = Math.max(dd, peak - net);
    const y = new Date(t.time).getUTCFullYear();
    yearly[y] = (yearly[y] || 0) + t.pips;
  }
  return {
    trades: trades.length,
    wr: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
    pf: grossLoss ? +(grossWin / grossLoss).toFixed(2) : 0,
    net: +net.toFixed(1),
    dd: +dd.toFixed(1),
    y2024: +(yearly[2024] || 0).toFixed(1),
    y2025: +(yearly[2025] || 0).toFixed(1),
    y2026: +(yearly[2026] || 0).toFixed(1)
  };
}

function runRejectionCe(symbol, asset, tf, cfg, candles, zones, rr) {
  const trades = [];
  let lastEntryIdx = -999;
  for (const zone of zones) {
    const type = zone.type === 'BULLISH' ? 'BUY' : 'SELL';
    if (!directionOk(asset, type)) continue;
    for (let i = zone.idx + 1; i < Math.min(candles.length, zone.idx + 400); i++) {
      if (i - lastEntryIdx < 3) continue;
      const c = candles[i];
      if (!isSession(asset, c.time)) continue;
      if (!trendOk(asset, type, c)) continue;
      const range = c.high - c.low;
      if (range < cfg.minRange) continue;
      const buffer = cfg.bufferPrice ?? (cfg.bufferPips * asset.pipSize);
      if (type === 'BUY') {
        if (!(c.low <= zone.top && c.low >= zone.bottom - buffer)) continue;
        if ((Math.min(c.open, c.close) - c.low) / range < asset.wickThreshold) continue;
      } else {
        if (!(c.high >= zone.bottom && c.high <= zone.top + buffer)) continue;
        if ((c.high - Math.max(c.open, c.close)) / range < asset.wickThreshold) continue;
      }
      const st = slTp(asset, cfg, zone, type, zone.ce, rr);
      if (!st) continue;
      const out = outcome(candles, i, type, st.sl, st.tp, asset.maxBarsAfterEntry);
      if (!out) break;
      const cost = (candles[out.idx].spread || 0) * asset.spreadMultiplier + COST_SLIPPAGE;
      trades.push({ time: c.time, pips: (out.result === 'TP' ? st.tpUnits : -st.slUnits) - cost });
      lastEntryIdx = i;
      break;
    }
  }
  return summarize(trades);
}

function runPendingCe(symbol, asset, tf, cfg, candles, zones, rr) {
  const trades = [];
  let lastEntryIdx = -999;
  for (const zone of zones) {
    const type = zone.type === 'BULLISH' ? 'BUY' : 'SELL';
    if (!directionOk(asset, type)) continue;
    const st = slTp(asset, cfg, zone, type, zone.ce, rr);
    if (!st) continue;
    for (let i = zone.idx + 1; i < Math.min(candles.length, zone.idx + 1 + asset.pendingTtlBars); i++) {
      if (i - lastEntryIdx < 3) continue;
      const c = candles[i];
      if (!isSession(asset, c.time)) continue;
      if (!trendOk(asset, type, candles[i - 1] || c)) continue;
      const filled = type === 'BUY' ? c.low <= zone.ce : c.high >= zone.ce;
      if (!filled) continue;
      const out = outcome(candles, i, type, st.sl, st.tp, asset.maxBarsAfterEntry);
      if (!out) break;
      const cost = (c.spread || 0) * asset.spreadMultiplier + COST_SLIPPAGE;
      trades.push({ time: c.time, pips: (out.result === 'TP' ? st.tpUnits : -st.slUnits) - cost });
      lastEntryIdx = i;
      break;
    }
  }
  return summarize(trades);
}

function main() {
  const rows = [];
  for (const [symbol, asset] of Object.entries(ASSETS)) {
    for (const [tf, cfg] of Object.entries(asset.timeframes)) {
      const csv = findCsv(symbol, tf);
      if (!csv) continue;
      const candles = loadCandles(csv);
      const zones = scanZones(symbol, candles, cfg, asset.lookback);
      for (const rr of cfg.rrValues) {
        rows.push({ symbol, tf, mode: 'rejection_ce', rr, ...runRejectionCe(symbol, asset, tf, cfg, candles, zones, rr) });
        rows.push({ symbol, tf, mode: 'pending_ce', rr, ...runPendingCe(symbol, asset, tf, cfg, candles, zones, rr) });
      }
      console.error(`[OK] ${symbol} ${tf}: ${candles.length} candles, ${zones.length} zones`);
    }
  }

  rows.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.tf.localeCompare(b.tf) || a.mode.localeCompare(b.mode) || b.pf - a.pf);
  console.table(rows);
  fs.writeFileSync(path.join(__dirname, 'bpr_ce_setup_report.json'), JSON.stringify(rows, null, 2));
  console.log(`\nSaved: ${path.join(__dirname, 'bpr_ce_setup_report.json')}`);
}

main();
