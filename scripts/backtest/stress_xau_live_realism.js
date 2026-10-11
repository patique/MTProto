/**
 * Stress test realista para la estrategia live XAUUSD BPR Multi-TF.
 *
 * Objetivo:
 * - Replicar las reglas actuales del motor live:
 *   M3/M5/M15, BPR, EMA100, rechazo 25%, SL fijo, TP completo, max 2 abiertas.
 * - Comparar la entrada teorica del backtest (borde BPR) contra una ejecucion
 *   mas realista a mercado (cierre de vela + spread/slippage adversos).
 * - Estresar spread, slippage, latencia, orden intra-vela y subperiodos.
 *
 * Limitacion honesta: con CSV OHLC no se puede reconstruir el tick-by-tick real.
 * Por eso el script usa supuestos conservadores y SL-first cuando TP/SL coinciden
 * en la misma vela.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'stress_xau_live_realism_report.json');

const SYMBOL = 'XAUUSD';
const PIP_SIZE = 0.1;
const PIP_MULT = 10;
const SPREAD_MULT = 0.1;
const MAX_ACTIVE_TRADES = 2;

const TF_CONFIG = {
  M3:  { tfMinutes: 3,  minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tpPips: 60.0,  minRange: 0.25 },
  M5:  { tfMinutes: 5,  minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tpPips: 80.0,  minRange: 0.35 },
  M15: { tfMinutes: 15, minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tpPips: 120.0, minRange: 0.60 }
};

const SCENARIOS = [
  {
    id: 'theoretical_backtest_like',
    fillMode: 'bpr_edge',
    spreadMultiplier: 1.0,
    slippagePips: 0.0,
    entryDelayBars: 0,
    ambiguous: 'sl_first'
  },
  {
    id: 'market_realistic',
    fillMode: 'market_close',
    spreadMultiplier: 1.0,
    slippagePips: 0.5,
    entryDelayBars: 0,
    ambiguous: 'sl_first'
  },
  {
    id: 'market_harsh_spread_slip',
    fillMode: 'market_close',
    spreadMultiplier: 1.5,
    slippagePips: 1.5,
    entryDelayBars: 0,
    ambiguous: 'sl_first'
  },
  {
    id: 'market_latency_1bar',
    fillMode: 'market_close',
    spreadMultiplier: 1.25,
    slippagePips: 1.0,
    entryDelayBars: 1,
    ambiguous: 'sl_first'
  },
  {
    id: 'market_extreme',
    fillMode: 'market_close',
    spreadMultiplier: 2.0,
    slippagePips: 2.5,
    entryDelayBars: 1,
    ambiguous: 'sl_first'
  }
];

function findCsv(tf) {
  const prefix = `${SYMBOL}_${tf}_`;
  const files = fs.readdirSync(ROOT).filter(f => f.startsWith(prefix) && f.endsWith('.csv')).sort();
  if (!files.length) throw new Error(`No CSV found for ${SYMBOL} ${tf}`);
  return path.join(ROOT, files[files.length - 1]);
}

function loadCandles(tf) {
  const file = findCsv(tf);
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1);
  const candles = [];
  for (const line of rows) {
    const p = line.split('\t');
    if (p.length < 7) continue;
    const time = new Date(`${p[0].replace(/\./g, '-')}T${p[1]}Z`).getTime();
    if (!Number.isFinite(time)) continue;
    candles.push({
      tf,
      time,
      open: +p[2],
      high: +p[3],
      low: +p[4],
      close: +p[5],
      tickVol: +p[6] || 0,
      spreadRaw: +p[8] || 0,
      spreadPips: (+p[8] || 0) * SPREAD_MULT
    });
  }
  calculateEma100(candles);
  return candles;
}

function calculateEma100(candles) {
  if (!candles.length) return;
  const k = 2 / 101;
  let ema = candles[0].close;
  for (const candle of candles) {
    ema = candle.close * k + ema * (1 - k);
    candle.ema100 = ema;
  }
}

function isRolloverBlocked(time) {
  const d = new Date(time);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return h === 23 || (h === 0 && m < 15);
}

function scanBprZonesIncremental(candleBuffer, cfg, zones, tf) {
  const n = candleBuffer.length;
  if (n < 4) return;

  const c0 = candleBuffer[n - 1];
  const c2 = candleBuffer[n - 3];
  const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
  const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

  if (isBearishFVG) c0.isBearishFVG = true;
  if (isBullishFVG) c0.isBullishFVG = true;

  if (isBullishFVG) {
    for (let i = n - 2; i >= Math.max(2, n - 11); i--) {
      if (!candleBuffer[i].isBearishFVG) continue;
      const bearTop = candleBuffer[i - 2].low;
      const bearBottom = candleBuffer[i].high;
      const bullTop = c0.low;
      const bullBottom = c2.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);
      if (cHigh > cLow + cfg.minOverlap) {
        zones.push({ tf, type: 'BULLISH', top: cHigh, bottom: cLow, tested: false, createdTime: c0.time });
        break;
      }
    }
  }

  if (isBearishFVG) {
    for (let i = n - 2; i >= Math.max(2, n - 11); i--) {
      if (!candleBuffer[i].isBullishFVG) continue;
      const bullTop = candleBuffer[i].low;
      const bullBottom = candleBuffer[i - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const cLow = Math.max(bullBottom, bearBottom);
      const cHigh = Math.min(bullTop, bearTop);
      if (cHigh > cLow + cfg.minOverlap) {
        zones.push({ tf, type: 'BEARISH', top: cHigh, bottom: cLow, tested: false, createdTime: c0.time });
        break;
      }
    }
  }

  if (zones.length > 25) zones.shift();
}

function generateSignals(tf, candles, cfg) {
  const buffer = [];
  const zones = [];
  const signals = [];

  for (let idx = 0; idx < candles.length; idx++) {
    const source = candles[idx];
    const candle = { ...source };
    buffer.push(candle);
    if (buffer.length > 300) buffer.shift();

    scanBprZonesIncremental(buffer, cfg, zones, tf);

    if (!candle.ema100) continue;
    if (isRolloverBlocked(candle.time)) continue;
    const candleRange = candle.high - candle.low;
    if (candleRange < cfg.minRange) continue;

    for (const bpr of zones) {
      if (bpr.tested) continue;

      if (bpr.type === 'BULLISH') {
        if (candle.low <= bpr.top && candle.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(candle.open, candle.close) - candle.low;
          if (lowerWick / candleRange >= 0.25 && candle.close > candle.ema100) {
            bpr.tested = true;
            signals.push({
              tf,
              idx,
              time: candle.time,
              type: 'BUY',
              theoreticalEntry: bpr.top,
              theoreticalSL: bpr.bottom - (cfg.slPips / PIP_MULT),
              theoreticalTP: bpr.top + (cfg.tpPips / PIP_MULT),
              slPips: cfg.slPips,
              tpPips: cfg.tpPips,
              candleClose: candle.close,
              spreadPips: candle.spreadPips
            });
            break;
          }
        }
      } else if (bpr.type === 'BEARISH') {
        if (candle.high >= bpr.bottom && candle.high <= bpr.top + 0.5) {
          const upperWick = candle.high - Math.max(candle.open, candle.close);
          if (upperWick / candleRange >= 0.25 && candle.close < candle.ema100) {
            bpr.tested = true;
            signals.push({
              tf,
              idx,
              time: candle.time,
              type: 'SELL',
              theoreticalEntry: bpr.bottom,
              theoreticalSL: bpr.top + (cfg.slPips / PIP_MULT),
              theoreticalTP: bpr.bottom - (cfg.tpPips / PIP_MULT),
              slPips: cfg.slPips,
              tpPips: cfg.tpPips,
              candleClose: candle.close,
              spreadPips: candle.spreadPips
            });
            break;
          }
        }
      }
    }
  }

  return signals;
}

function buildExecution(signal, candles, scenario) {
  const fillIdx = Math.min(candles.length - 1, signal.idx + scenario.entryDelayBars);
  const fillCandle = candles[fillIdx];
  const stressedSpreadPips = (fillCandle.spreadPips || signal.spreadPips || 0) * scenario.spreadMultiplier;
  const adversePips = stressedSpreadPips + scenario.slippagePips;

  if (scenario.fillMode === 'bpr_edge') {
    return {
      fillIdx,
      fillTime: fillCandle.time,
      fillPrice: signal.theoreticalEntry,
      sl: signal.theoreticalSL,
      tp: signal.theoreticalTP,
      costPips: adversePips
    };
  }

  const fillPrice = signal.type === 'BUY'
    ? fillCandle.close + (adversePips * PIP_SIZE)
    : fillCandle.close - (adversePips * PIP_SIZE);

  return {
    fillIdx,
    fillTime: fillCandle.time,
    fillPrice,
    sl: signal.theoreticalSL,
    tp: signal.theoreticalTP,
    costPips: 0
  };
}

function resolveTrade(signal, candles, scenario) {
  const exec = buildExecution(signal, candles, scenario);
  if (!exec || exec.fillIdx >= candles.length - 1) return null;

  for (let idx = exec.fillIdx; idx < candles.length; idx++) {
    const c = candles[idx];
    if (signal.type === 'BUY') {
      const hitSL = c.low <= exec.sl;
      const hitTP = c.high >= exec.tp;
      if (hitSL && hitTP) return closeTrade(signal, exec, idx, c.time, 'SL', scenario);
      if (hitSL) return closeTrade(signal, exec, idx, c.time, 'SL', scenario);
      if (hitTP) return closeTrade(signal, exec, idx, c.time, 'TP', scenario);
    } else {
      const hitSL = c.high >= exec.sl;
      const hitTP = c.low <= exec.tp;
      if (hitSL && hitTP) return closeTrade(signal, exec, idx, c.time, 'SL', scenario);
      if (hitSL) return closeTrade(signal, exec, idx, c.time, 'SL', scenario);
      if (hitTP) return closeTrade(signal, exec, idx, c.time, 'TP', scenario);
    }
  }

  return null;
}

function closeTrade(signal, exec, closeIdx, closeTime, outcome, scenario) {
  let rawPips;
  if (signal.type === 'BUY') {
    rawPips = outcome === 'TP'
      ? (exec.tp - exec.fillPrice) * PIP_MULT
      : (exec.sl - exec.fillPrice) * PIP_MULT;
  } else {
    rawPips = outcome === 'TP'
      ? (exec.fillPrice - exec.tp) * PIP_MULT
      : (exec.fillPrice - exec.sl) * PIP_MULT;
  }
  const pips = rawPips - exec.costPips;
  return {
    ...signal,
    fillTime: exec.fillTime,
    fillPrice: +exec.fillPrice.toFixed(3),
    sl: +exec.sl.toFixed(3),
    tp: +exec.tp.toFixed(3),
    closeIdx,
    closeTime,
    outcome,
    pips: +pips.toFixed(1),
    r: +(pips / signal.slPips).toFixed(2),
    scenario: scenario.id
  };
}

function applyPortfolioConcurrency(allResolvedTrades) {
  const sorted = allResolvedTrades
    .filter(Boolean)
    .sort((a, b) => a.fillTime - b.fillTime || a.time - b.time);

  const accepted = [];
  const active = [];
  let skippedByConcurrency = 0;

  for (const trade of sorted) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].closeTime <= trade.fillTime) active.splice(i, 1);
    }
    if (active.length >= MAX_ACTIVE_TRADES) {
      skippedByConcurrency++;
      continue;
    }
    active.push(trade);
    accepted.push(trade);
  }

  return { trades: accepted, skippedByConcurrency };
}

function summarize(trades) {
  let wins = 0;
  let losses = 0;
  let grossWon = 0;
  let grossLost = 0;
  let netPips = 0;
  let peak = 0;
  let maxDD = 0;
  let maxLossStreak = 0;
  let curLossStreak = 0;
  const byYear = {};
  const byTf = {};
  const byMonth = {};

  for (const t of trades) {
    if (!byTf[t.tf]) byTf[t.tf] = { trades: 0, wins: 0, pips: 0 };
    byTf[t.tf].trades++;
    byTf[t.tf].pips += t.pips;

    if (t.pips > 0) {
      wins++;
      grossWon += t.pips;
      byTf[t.tf].wins++;
      curLossStreak = 0;
    } else {
      losses++;
      grossLost += Math.abs(t.pips);
      curLossStreak++;
      maxLossStreak = Math.max(maxLossStreak, curLossStreak);
    }

    netPips += t.pips;
    peak = Math.max(peak, netPips);
    maxDD = Math.max(maxDD, peak - netPips);

    const d = new Date(t.fillTime);
    const year = d.getUTCFullYear();
    const month = `${year}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byYear[year]) byYear[year] = { trades: 0, pips: 0 };
    byYear[year].trades++;
    byYear[year].pips += t.pips;
    byMonth[month] = (byMonth[month] || 0) + t.pips;
  }

  const monthly = Object.values(byMonth);
  const negativeMonths = monthly.filter(v => v < 0).length;

  return {
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
    profitFactor: grossLost ? +(grossWon / grossLost).toFixed(2) : 99,
    netPips: +netPips.toFixed(1),
    maxDrawdownPips: +maxDD.toFixed(1),
    maxLossStreak,
    negativeMonths,
    months: monthly.length,
    byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, {
      trades: v.trades,
      pips: +v.pips.toFixed(1)
    }])),
    byTimeframe: Object.fromEntries(Object.entries(byTf).map(([tf, v]) => [tf, {
      trades: v.trades,
      winRate: v.trades ? +(v.wins / v.trades * 100).toFixed(1) : 0,
      pips: +v.pips.toFixed(1)
    }]))
  };
}

function walkForward(summary) {
  return Object.entries(summary.byYear)
    .filter(([year]) => Number(year) >= 2022)
    .map(([year, data]) => ({ year: Number(year), pass: data.pips > 0, ...data }));
}

function main() {
  const candlesByTf = {};
  const signalsByTf = {};
  for (const [tf, cfg] of Object.entries(TF_CONFIG)) {
    const candles = loadCandles(tf);
    candlesByTf[tf] = candles;
    signalsByTf[tf] = generateSignals(tf, candles, cfg);
    console.error(`[signals] ${tf}: candles=${candles.length}, signals=${signalsByTf[tf].length}`);
  }

  const scenarioReports = [];
  for (const scenario of SCENARIOS) {
    const resolved = [];
    for (const [tf, signals] of Object.entries(signalsByTf)) {
      const candles = candlesByTf[tf];
      for (const signal of signals) {
        resolved.push(resolveTrade(signal, candles, scenario));
      }
    }

    const { trades, skippedByConcurrency } = applyPortfolioConcurrency(resolved);
    const summary = summarize(trades);
    scenarioReports.push({
      scenario,
      skippedByConcurrency,
      summary,
      walkForward: walkForward(summary),
      sampleTrades: trades.slice(0, 10)
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    symbol: SYMBOL,
    liveSetup: {
      timeframes: TF_CONFIG,
      maxActiveTrades: MAX_ACTIVE_TRADES,
      breakEven: false,
      trailing: false,
      rolloverBlock: '23:00 UTC and 00:00-00:15 UTC',
      signal: 'BPR retest + 25% rejection wick + EMA100 trend',
      note: 'market_close scenarios model the actual BUY/SELL market execution more harshly than the strategy internal theoretical entry'
    },
    scenarios: scenarioReports
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    saved: OUT,
    scenarios: scenarioReports.map(r => ({
      id: r.scenario.id,
      skippedByConcurrency: r.skippedByConcurrency,
      ...r.summary,
      walkForward: r.walkForward
    }))
  }, null, 2));
}

main();
