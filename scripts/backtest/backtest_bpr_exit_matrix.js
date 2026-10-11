/**
 * Matriz de salidas BPR sobre CSV reales MT5.
 *
 * Objetivo: comparar de forma repetible cuanto aportan o destruyen
 * el break-even y el trailing stop frente a salidas limpias.
 *
 * Uso:
 *   node scripts/backtest/backtest_bpr_exit_matrix.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');
const HISTORY_DIR = path.join(ROOT, 'history_exports');
const XAU_PIP_VALUE_PER_LOT = 10;

const DATASETS = [
  {
    tf: 'M1',
    file: 'XAUUSD_M1_202606171851_202609291057.csv',
    cfg: { minFvgGap: 0.15, minOverlap: 0.10, slPips: 10, tp1Pips: 25, tp2Pips: 50, autoBePips: 18, minRange: 0.20 }
  },
  {
    tf: 'M2',
    file: 'XAUUSD_M2_202603051240_202609291056.csv',
    cfg: { minFvgGap: 0.18, minOverlap: 0.12, slPips: 11, tp1Pips: 28, tp2Pips: 56, autoBePips: 18, minRange: 0.22 }
  },
  {
    tf: 'M3',
    file: 'XAUUSD_M3_202511201233_202609291057.csv',
    cfg: { minFvgGap: 0.20, minOverlap: 0.15, slPips: 12, tp1Pips: 30, tp2Pips: 60, autoBePips: 20, minRange: 0.25 }
  },
  {
    tf: 'M5',
    file: 'XAUUSD_M5_202504291430_202609291055.csv',
    cfg: { minFvgGap: 0.30, minOverlap: 0.20, slPips: 15, tp1Pips: 40, tp2Pips: 80, autoBePips: 25, minRange: 0.35 }
  },
  {
    tf: 'M15',
    file: 'XAUUSD_M15_202401020100_202609291045.csv',
    cfg: { minFvgGap: 0.50, minOverlap: 0.35, slPips: 25, tp1Pips: 60, tp2Pips: 120, autoBePips: 40, minRange: 0.60 }
  }
];

const EXIT_MODELS = [
  {
    id: 'FULL_TP2_NO_BE',
    description: '100% posicion, SL fijo, TP2 completo, sin BE ni trailing',
    partial: false,
    beTrigger: null,
    trailing: null
  },
  {
    id: 'FULL_EARLY_BE',
    description: '100% posicion, BE temprano al umbral de la estrategia, TP2 completo',
    partial: false,
    beTrigger: 'AUTO',
    trailing: null
  },
  {
    id: 'FULL_BE_AT_TP1',
    description: '100% posicion, mover SL a BE solo cuando toca TP1, TP2 completo',
    partial: false,
    beTrigger: 'TP1',
    trailing: null
  },
  {
    id: 'PARTIAL_50_NO_BE',
    description: '50% TP1 + 50% TP2, segundo tramo mantiene SL original',
    partial: true,
    beTrigger: null,
    trailing: null
  },
  {
    id: 'PARTIAL_50_BE_TP1',
    description: '50% TP1 + mover segundo tramo a BE en TP1',
    partial: true,
    beTrigger: 'TP1',
    trailing: null
  },
  {
    id: 'FULL_TRAILING_AFTER_TP1',
    description: '100% posicion, trailing solo despues de TP1',
    partial: false,
    beTrigger: 'TP1',
    trailing: { trigger: 'TP1', distancePips: 40, stepPips: 5 }
  }
];

const PORTFOLIO_MODELS = EXIT_MODELS.filter(model => (
  model.id === 'FULL_TP2_NO_BE' ||
  model.id === 'PARTIAL_50_NO_BE'
));
const DEPLOYABLE_MODEL_IDS = new Set(PORTFOLIO_MODELS.map(model => model.id));

const PERIODS = [
  { id: 'FULL', days: null },
  { id: 'RECENT_90D', days: 90 },
  { id: 'RECENT_30D', days: 30 }
];

const ACCOUNT_PROFILES = [
  {
    id: 'RAW',
    label: 'Raw pips',
    commissionPerLotRoundTurn: 0,
    slippagePipsRoundTurn: 0
  },
  {
    id: 'FTMO_100K',
    label: 'FTMO 100k',
    commissionPerLotRoundTurn: 5.86,
    slippagePipsRoundTurn: 1.0
  },
  {
    id: 'THE5ERS_5K',
    label: 'The5ers 5k',
    commissionPerLotRoundTurn: 8.25,
    slippagePipsRoundTurn: 1.2
  },
  {
    id: 'VT_100',
    label: 'VT Markets 100',
    commissionPerLotRoundTurn: 0,
    slippagePipsRoundTurn: 1.5
  }
];

async function loadCandles(fileName) {
  const filePath = path.join(ROOT, fileName);
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });

  const candles = [];
  let header = true;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 9) continue;

    const [y, m, d] = parts[0].split('.').map(Number);
    const [hour, minute, sec] = parts[1].split(':').map(Number);
    const timeMs = Date.UTC(y, m - 1, d, hour, minute, sec);
    candles.push({
      timeMs,
      date: parts[0],
      time: parts[1],
      hour,
      minute,
      open: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      close: Number(parts[5]),
      spreadPips: Number(parts[8]) / 10.0
    });
  }

  let ema100 = candles[0] ? candles[0].close : 0;
  const k = 2 / 101;
  for (const candle of candles) {
    ema100 = candle.close * k + ema100 * (1 - k);
    candle.ema100 = ema100;
  }

  return candles;
}

function detectBprZones(candles, cfg) {
  const zones = [];
  let lastBear = -999;
  let lastBull = -999;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const bearishFvg = (c2.low - c0.high) >= cfg.minFvgGap;
    const bullishFvg = (c0.low - c2.high) >= cfg.minFvgGap;

    if (bearishFvg) lastBear = i;
    if (bullishFvg) lastBull = i;

    if (bullishFvg && i - lastBear > 0 && i - lastBear <= 10) {
      const bearTop = candles[lastBear - 2].low;
      const bearBottom = candles[lastBear].high;
      const bullTop = c0.low;
      const bullBottom = c2.high;
      const bottom = Math.max(bearBottom, bullBottom);
      const top = Math.min(bearTop, bullTop);
      if (top > bottom + cfg.minOverlap) {
        zones.push({ type: 'BULLISH', createdIdx: i, top, bottom });
      }
    }

    if (bearishFvg && i - lastBull > 0 && i - lastBull <= 10) {
      const bullTop = candles[lastBull].low;
      const bullBottom = candles[lastBull - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const bottom = Math.max(bullBottom, bearBottom);
      const top = Math.min(bullTop, bearTop);
      if (top > bottom + cfg.minOverlap) {
        zones.push({ type: 'BEARISH', createdIdx: i, top, bottom });
      }
    }
  }

  return zones;
}

function extractSignals(tf, candles, zones, cfg) {
  const signals = [];
  let lastTradeIdx = -100;

  for (const zone of zones) {
    for (let i = zone.createdIdx + 1; i < Math.min(candles.length, zone.createdIdx + 45); i++) {
      if (i - lastTradeIdx < 4) continue;
      const c = candles[i];
      if (isBlockedTime(c)) continue;

      const range = c.high - c.low;
      if (range < cfg.minRange) continue;

      if (zone.type === 'BULLISH') {
        if (c.low > zone.top || c.low < zone.bottom - 0.5) continue;
        const lowerWick = Math.min(c.open, c.close) - c.low;
        if (lowerWick / range < 0.25) continue;
        if (c.close < c.ema100) continue;

        lastTradeIdx = i;
        signals.push(buildSignal(tf, 'BUY', i, c, zone.top, zone.bottom - (cfg.slPips / 10), cfg));
        break;
      }

      if (zone.type === 'BEARISH') {
        if (c.high < zone.bottom || c.high > zone.top + 0.5) continue;
        const upperWick = c.high - Math.max(c.open, c.close);
        if (upperWick / range < 0.25) continue;
        if (c.close > c.ema100) continue;

        lastTradeIdx = i;
        signals.push(buildSignal(tf, 'SELL', i, c, zone.bottom, zone.top + (cfg.slPips / 10), cfg));
        break;
      }
    }
  }

  return signals;
}

function isBlockedTime(candle) {
  if (candle.hour === 23) return true;
  if (candle.hour === 0 && candle.minute < 30) return true;
  return false;
}

function buildSignal(tf, side, entryIdx, candle, entry, sl, cfg) {
  const dir = side === 'BUY' ? 1 : -1;
  return {
    tf,
    side,
    entryIdx,
    timeMs: candle.timeMs,
    date: candle.date,
    time: candle.time,
    entry,
    sl,
    tp1: entry + dir * (cfg.tp1Pips / 10),
    tp2: entry + dir * (cfg.tp2Pips / 10),
    slPips: Math.abs(entry - sl) * 10,
    tp1Pips: cfg.tp1Pips,
    tp2Pips: cfg.tp2Pips,
    autoBePips: cfg.autoBePips,
    entrySpreadPips: candle.spreadPips
  };
}

function simulateSignal(signal, candles, model, accountProfile) {
  const dir = signal.side === 'BUY' ? 1 : -1;
  const beOffsetPips = 3.0;
  const maxBars = 100;
  const start = signal.entryIdx + 1;
  const end = Math.min(candles.length, signal.entryIdx + maxBars);

  let runnerSL = signal.sl;
  let tp1Hit = false;
  let trailingAnchor = null;

  for (let i = start; i < end; i++) {
    const c = candles[i];
    const highProgressPips = dir === 1 ? (c.high - signal.entry) * 10 : (signal.entry - c.low) * 10;

    // Criterio conservador OHLC: si una vela permite tocar SL y objetivo,
    // asumimos primero el evento adverso porque no tenemos orden intrabar.
    const slHitBeforeUpdates = dir === 1 ? c.low <= runnerSL : c.high >= runnerSL;
    if (slHitBeforeUpdates) {
      const runnerPips = dir === 1 ? (runnerSL - signal.entry) * 10 : (signal.entry - runnerSL) * 10;
      const netRunnerPips = runnerPips - c.spreadPips;
      if (model.partial && tp1Hit) {
        return close(signal, model, accountProfile, signal.tp1Pips * 0.5 + netRunnerPips * 0.5, 'TP1_THEN_SL', c, i);
      }
      return close(signal, model, accountProfile, netRunnerPips, runnerPips >= 0 ? 'BE_STOP' : 'STOP_LOSS', c, i);
    }

    const tp2HitBeforeUpdates = dir === 1 ? c.high >= signal.tp2 : c.low <= signal.tp2;
    if (tp2HitBeforeUpdates) {
      if (model.partial) {
        return close(signal, model, accountProfile, signal.tp1Pips * 0.5 + signal.tp2Pips * 0.5, 'TP2_AFTER_TP1', c, i);
      }
      return close(signal, model, accountProfile, signal.tp2Pips, 'TP2_FULL', c, i);
    }

    if (!tp1Hit && highProgressPips >= signal.tp1Pips) {
      tp1Hit = true;
      if (model.beTrigger === 'TP1') {
        runnerSL = signal.entry + dir * (beOffsetPips / 10);
      }
      if (model.trailing && model.trailing.trigger === 'TP1') {
        trailingAnchor = highProgressPips;
      }
    }

    if (model.beTrigger === 'AUTO' && highProgressPips >= signal.autoBePips) {
      const beSL = signal.entry + dir * (beOffsetPips / 10);
      if ((dir === 1 && runnerSL < beSL) || (dir === -1 && runnerSL > beSL)) {
        runnerSL = beSL;
      }
    }

    if (model.trailing && tp1Hit) {
      const shouldStep = trailingAnchor === null || highProgressPips >= trailingAnchor + model.trailing.stepPips;
      if (shouldStep) {
        trailingAnchor = highProgressPips;
        const trailed = signal.entry + dir * ((highProgressPips - model.trailing.distancePips) / 10);
        if ((dir === 1 && trailed > runnerSL) || (dir === -1 && trailed < runnerSL)) {
          runnerSL = trailed;
        }
      }
    }
  }

  const last = candles[end - 1] || candles[start] || {};
  const markToMarketPips = last.close
    ? (dir === 1 ? (last.close - signal.entry) * 10 : (signal.entry - last.close) * 10) - (last.spreadPips || 0)
    : 0;
  if (model.partial && tp1Hit) {
    return close(signal, model, accountProfile, signal.tp1Pips * 0.5 + markToMarketPips * 0.5, 'TIMEOUT_AFTER_TP1', last, end - 1);
  }
  return close(signal, model, accountProfile, markToMarketPips, 'TIMEOUT', last, end - 1);
}

function frictionPips(accountProfile) {
  const commissionPips = (accountProfile.commissionPerLotRoundTurn || 0) / XAU_PIP_VALUE_PER_LOT;
  return commissionPips + (accountProfile.slippagePipsRoundTurn || 0);
}

function close(signal, model, accountProfile, grossPips, reason, candle, exitIdx) {
  const netPips = grossPips - frictionPips(accountProfile);
  return {
    tf: signal.tf,
    accountProfile: accountProfile.id,
    model: model.id,
    side: signal.side,
    grossPips: Number(grossPips.toFixed(1)),
    pips: Number(netPips.toFixed(1)),
    reason,
    entryTime: `${signal.date} ${signal.time}`,
    exitTime: candle ? `${candle.date} ${candle.time}` : '',
    entryTimeMs: signal.timeMs,
    exitTimeMs: candle ? candle.timeMs : signal.timeMs,
    entryIdx: signal.entryIdx,
    exitIdx
  };
}

function summarize(results) {
  let netPips = 0;
  let grossWon = 0;
  let grossLost = 0;
  let wins = 0;
  let losses = 0;
  let peak = 0;
  let maxDD = 0;
  const reasons = {};

  for (const r of results) {
    netPips += r.pips;
    if (r.pips > 0) {
      wins++;
      grossWon += r.pips;
    } else if (r.pips < 0) {
      losses++;
      grossLost += Math.abs(r.pips);
    }
    if (netPips > peak) peak = netPips;
    if (peak - netPips > maxDD) maxDD = peak - netPips;
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }

  return {
    trades: results.length,
    winRate: results.length ? Number(((wins / results.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLost > 0 ? Number((grossWon / grossLost).toFixed(2)) : (grossWon > 0 ? 99 : 0),
    netPips: Number(netPips.toFixed(1)),
    avgPips: results.length ? Number((netPips / results.length).toFixed(1)) : 0,
    maxDDPips: Number(maxDD.toFixed(1)),
    wins,
    losses,
    reasons
  };
}

async function runDataset(dataset) {
  const candles = await loadCandles(dataset.file);
  const zones = detectBprZones(candles, dataset.cfg);
  const signals = extractSignals(dataset.tf, candles, zones, dataset.cfg);
  const rows = [];
  const maxTimeMs = candles.length ? candles[candles.length - 1].timeMs : 0;

  for (const period of PERIODS) {
    const periodStart = period.days ? maxTimeMs - period.days * 86400000 : 0;
    const periodSignals = signals.filter(signal => signal.timeMs >= periodStart);

    for (const accountProfile of ACCOUNT_PROFILES) {
      for (const model of EXIT_MODELS) {
        const results = periodSignals.map(signal => simulateSignal(signal, candles, model, accountProfile));
        rows.push({
          tf: dataset.tf,
          period: period.id,
          accountProfile: accountProfile.id,
          accountLabel: accountProfile.label,
          frictionPips: Number(frictionPips(accountProfile).toFixed(2)),
          model: model.id,
          description: model.description,
          zones: zones.length,
          signals: periodSignals.length,
          ...summarize(results)
        });
      }
    }
  }

  return rows;
}

async function buildSignalUniverse() {
  const universe = [];
  const candlesByTf = {};
  const metaByTf = {};

  for (const dataset of DATASETS) {
    if (!fs.existsSync(path.join(ROOT, dataset.file))) continue;
    const candles = await loadCandles(dataset.file);
    const zones = detectBprZones(candles, dataset.cfg);
    const signals = extractSignals(dataset.tf, candles, zones, dataset.cfg);
    candlesByTf[dataset.tf] = candles;
    metaByTf[dataset.tf] = { zones: zones.length, signals: signals.length };
    universe.push(...signals);
  }

  universe.sort((a, b) => a.timeMs - b.timeMs);
  return { universe, candlesByTf, metaByTf };
}

function runPortfolio({ universe, candlesByTf, accountProfile, model, period, maxConcurrent }) {
  const maxTimeMs = universe.length ? universe[universe.length - 1].timeMs : 0;
  const periodStart = period.days ? maxTimeMs - period.days * 86400000 : 0;
  const active = [];
  const accepted = [];
  let skippedConcurrency = 0;

  for (const signal of universe) {
    if (signal.timeMs < periodStart) continue;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].exitTimeMs <= signal.timeMs) active.splice(i, 1);
    }
    if (active.length >= maxConcurrent) {
      skippedConcurrency++;
      continue;
    }

    const result = simulateSignal(signal, candlesByTf[signal.tf], model, accountProfile);
    accepted.push(result);
    active.push(result);
  }

  return {
    accountProfile: accountProfile.id,
    accountLabel: accountProfile.label,
    period: period.id,
    model: model.id,
    maxConcurrent,
    acceptedSignals: accepted.length,
    skippedConcurrency,
    ...summarize(accepted)
  };
}

async function runPortfolioMatrix() {
  const signalUniverse = await buildSignalUniverse();
  const rows = [];

  for (const period of PERIODS) {
    for (const accountProfile of ACCOUNT_PROFILES.filter(p => p.id !== 'RAW')) {
      for (const model of PORTFOLIO_MODELS) {
        for (const maxConcurrent of [1, 2]) {
          rows.push(runPortfolio({
            ...signalUniverse,
            accountProfile,
            model,
            period,
            maxConcurrent
          }));
        }
      }
    }
  }

  return rows;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function normalizeRealTf(comment = '') {
  const match = String(comment).match(/(?:PROPRIETARY_BPR|BPR_XAUUSD|BPR)\_?[_\s-]?(M1|M2|M3|M5|M15)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function summarizeReal(rows) {
  const total = rows.reduce((acc, row) => {
    acc.trades++;
    acc.netUsd += Number(row.NetProfit) || 0;
    acc.points += Number(row.Pips) || 0;
    acc.commission += Number(row.Commission) || 0;
    if ((Number(row.NetProfit) || 0) > 0) acc.wins++;
    else if ((Number(row.NetProfit) || 0) < 0) acc.losses++;
    return acc;
  }, { trades: 0, wins: 0, losses: 0, netUsd: 0, points: 0, commission: 0 });

  return {
    trades: total.trades,
    winRate: total.trades ? Number(((total.wins / total.trades) * 100).toFixed(1)) : 0,
    netUsd: Number(total.netUsd.toFixed(2)),
    strategyPips: Number((total.points / 10).toFixed(1)),
    avgStrategyPips: total.trades ? Number(((total.points / 10) / total.trades).toFixed(1)) : 0,
    commission: Number(total.commission.toFixed(2)),
    wins: total.wins,
    losses: total.losses
  };
}

function loadRealBprComparison(backtestRows) {
  const accountMap = {
    '1514787530': 'FTMO_100K',
    '26727509': 'THE5ERS_5K',
    '1290919': 'VT_100'
  };
  const comparison = [];

  for (const [account, profileId] of Object.entries(accountMap)) {
    const positions = readJsonIfExists(path.join(HISTORY_DIR, `history_positions_${account}.json`));
    const deals = readJsonIfExists(path.join(HISTORY_DIR, `history_deals_${account}.json`));
    if (!positions || !deals) continue;

    const entryCommentByPosition = new Map();
    for (const deal of deals) {
      if (deal.Entry === 'IN' && deal.PositionID) {
        entryCommentByPosition.set(String(deal.PositionID), String(deal.Comment || ''));
      }
    }

    const bprRows = positions
      .map(pos => ({ ...pos, EntryComment: entryCommentByPosition.get(String(pos.PositionID)) || '' }))
      .filter(pos => String(pos.Symbol || '').toUpperCase().includes('XAU'))
      .map(pos => ({ ...pos, tf: normalizeRealTf(pos.EntryComment) }))
      .filter(pos => pos.tf);

    for (const tf of ['M1', 'M2', 'M3', 'M5', 'M15']) {
      const realRows = bprRows.filter(row => row.tf === tf);
      if (!realRows.length) continue;
      const real = summarizeReal(realRows);
      const btCandidates = backtestRows
        .filter(row => row.accountProfile === profileId && row.period === 'RECENT_30D' && row.tf === tf)
        .sort((a, b) => b.netPips - a.netPips);
      const best = btCandidates[0];
      const deployableBest = btCandidates.find(row => DEPLOYABLE_MODEL_IDS.has(row.model));
      comparison.push({
        account,
        profileId,
        tf,
        real,
        bestRecent30Backtest: best ? {
          model: best.model,
          trades: best.trades,
          avgPips: best.avgPips,
          netPips: best.netPips,
          winRate: best.winRate,
          profitFactor: best.profitFactor
        } : null,
        bestDeployableRecent30Backtest: deployableBest ? {
          model: deployableBest.model,
          trades: deployableBest.trades,
          avgPips: deployableBest.avgPips,
          netPips: deployableBest.netPips,
          winRate: deployableBest.winRate,
          profitFactor: deployableBest.profitFactor
        } : null
      });
    }
  }

  return comparison;
}

async function main() {
  const allRows = [];
  for (const dataset of DATASETS) {
    if (!fs.existsSync(path.join(ROOT, dataset.file))) continue;
    allRows.push(...await runDataset(dataset));
  }
  const portfolioRows = await runPortfolioMatrix();

  console.log('\nBPR EXIT MATRIX - XAUUSD CSV MT5 REAL');
  console.log('=====================================');
  console.table(allRows.filter(r => r.period === 'FULL' && r.accountProfile === 'FTMO_100K').map(r => ({
    tf: r.tf,
    period: r.period,
    account: r.accountProfile,
    model: r.model,
    signals: r.signals,
    winRate: r.winRate,
    profitFactor: r.profitFactor,
    netPips: r.netPips,
    avgPips: r.avgPips,
    maxDDPips: r.maxDDPips
  })));

  const bestByTf = {};
  for (const row of allRows) {
    const key = `${row.accountProfile}:${row.period}:${row.tf}`;
    if (!bestByTf[key] || row.netPips > bestByTf[key].netPips) {
      bestByTf[key] = row;
    }
  }

  console.log('\nBest model by period/timeframe:');
  console.table(Object.values(bestByTf).map(r => ({
    account: r.accountProfile,
    period: r.period,
    tf: r.tf,
    model: r.model,
    signals: r.signals,
    netPips: r.netPips,
    profitFactor: r.profitFactor,
    winRate: r.winRate,
    maxDDPips: r.maxDDPips
  })));

  const deployableBestByTf = {};
  for (const row of allRows.filter(row => DEPLOYABLE_MODEL_IDS.has(row.model))) {
    const key = `${row.accountProfile}:${row.period}:${row.tf}`;
    if (!deployableBestByTf[key] || row.netPips > deployableBestByTf[key].netPips) {
      deployableBestByTf[key] = row;
    }
  }

  console.log('\nBest deployable model by period/timeframe (no BE/trailing):');
  console.table(Object.values(deployableBestByTf).map(r => ({
    account: r.accountProfile,
    period: r.period,
    tf: r.tf,
    model: r.model,
    signals: r.signals,
    netPips: r.netPips,
    profitFactor: r.profitFactor,
    winRate: r.winRate,
    maxDDPips: r.maxDDPips
  })));

  const realComparison = loadRealBprComparison(allRows);
  console.log('\nReal MT5 vs best deployable RECENT_30D backtest by account/timeframe:');
  console.table(realComparison.map(row => ({
    account: row.account,
    profile: row.profileId,
    tf: row.tf,
    realTrades: row.real.trades,
    realAvgPips: row.real.avgStrategyPips,
    realNetUsd: row.real.netUsd,
    bestDeployableModel: row.bestDeployableRecent30Backtest ? row.bestDeployableRecent30Backtest.model : 'N/A',
    btAvgPips: row.bestDeployableRecent30Backtest ? row.bestDeployableRecent30Backtest.avgPips : 0,
    btTrades: row.bestDeployableRecent30Backtest ? row.bestDeployableRecent30Backtest.trades : 0
  })));

  console.log('\nPortfolio anti-stacking matrix (XAUUSD all BPR timeframes, no BE/trailing models):');
  console.table(portfolioRows
    .filter(row => row.period === 'RECENT_30D')
    .map(row => ({
      account: row.accountProfile,
      period: row.period,
      model: row.model,
      maxConcurrent: row.maxConcurrent,
      trades: row.trades,
      skipped: row.skippedConcurrency,
      winRate: row.winRate,
      profitFactor: row.profitFactor,
      netPips: row.netPips,
      avgPips: row.avgPips,
      maxDDPips: row.maxDDPips
    })));

  const outPath = path.join(ROOT, 'scripts', 'backtest', 'bpr_exit_matrix_report.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    accountProfiles: ACCOUNT_PROFILES,
    rows: allRows,
    portfolioRows,
    realComparison
  }, null, 2));
  console.log(`\nReport saved: ${outPath}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
