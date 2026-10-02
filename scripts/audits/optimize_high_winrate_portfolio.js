/**
 * Optimizador Cuantitativo de Máximo Win Rate y Máxima Estabilidad
 * Para el Portafolio de los 7 Canales TOP sobre el histórico de 1 año (35.040 velas M15)
 * 
 * Objetivos:
 * 1. Maximizar la Tasa de Acierto (Win Rate > 80%+)
 * 2. Minimizar el Drawdown (Estabilidad de curva de capital)
 * 3. Encontrar la combinación óptima de:
 *    - Ratio de Parcial (50/50 vs 70/30 vs 80/20)
 *    - Trigger de Auto Break-Even (15p vs 20p vs 25p)
 *    - Objetivo TP1 por canal (20p vs 25p vs 30p vs 35p)
 *    - Distancia de Trailing Stop (15p vs 20p)
 */

const fs = require('fs');
const path = require('path');
const { CHANNELS_CONFIG } = require('../../config/channels.config');

const candlesPath = path.join(__dirname, 'cache_paxgusdt_15m_1y.json');
const candles = JSON.parse(fs.readFileSync(candlesPath, 'utf8'));
candles.sort((a, b) => (a.timestamp || a.time) - (b.timestamp || b.time));
const candleTimestamps = candles.map(c => c.timestamp || c.time);

function findCandleIndex(timestamp) {
  let low = 0, high = candleTimestamps.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candleTimestamps[mid] < timestamp) low = mid + 1;
    else high = mid - 1;
  }
  return Math.min(low, candleTimestamps.length - 1);
}

// Cargar las 513 señales de Oro extraídas en el test anterior
const simCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache_100usd_simulation.json'), 'utf8'));

// Reconstruir la lista de señales limpias
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { strategyFactory } = require('../../core/StrategyFactory');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const client = new TelegramClient(new StringSession(stringSessionStr), 25677000, 'e49356f9d8dbb478b5ffc575a632ac55', { connectionRetries: 5 });

function simulateTradeParametric(signal, startCandleIdx, params) {
  const {
    tp1OverridePips = null,
    beTriggerPips = 20.0,
    beOffsetPips = 4.0,
    trailingDistPips = 18.0,
    trailingStepPips = 5.0,
    partialRatio = 0.70 // 70% TP1, 30% Trailing
  } = params;

  const isBuy = signal.action.toUpperCase().includes('BUY');
  const entryPrice = candles[startCandleIdx].open;
  const origEntry = signal.entry || entryPrice;

  const slDist = Math.min(9.0, Math.max(2.5, Math.abs(origEntry - signal.sl) || 6.0));
  
  let targetTP1Pips = tp1OverridePips;
  if (!targetTP1Pips) {
    targetTP1Pips = Math.min(5.0, Math.max(1.8, Math.abs(signal.tp1 - origEntry) || 3.0));
  } else {
    targetTP1Pips = targetTP1Pips / 10.0;
  }

  const tp2Dist = Math.min(12.0, Math.max(3.5, Math.abs(signal.tp2 - origEntry) || 7.0));

  const initialSL = isBuy ? entryPrice - slDist : entryPrice + slDist;
  const tp1 = isBuy ? entryPrice + targetTP1Pips : entryPrice - targetTP1Pips;
  const tp2 = isBuy ? entryPrice + tp2Dist : entryPrice - tp2Dist;

  const BE_TRIGGER = beTriggerPips / 10.0;
  const BE_OFFSET = beOffsetPips / 10.0;
  const TRAILING_DIST = trailingDistPips / 10.0;
  const TRAILING_STEP = trailingStepPips / 10.0;

  let leg1Closed = false;
  let leg1Pips = 0;
  let leg2Closed = false;
  let leg2Pips = 0;
  let leg2SL = initialSL;
  let isBEActive = false;

  const maxLookforward = Math.min(candles.length, startCandleIdx + 200);

  for (let i = startCandleIdx; i < maxLookforward; i++) {
    const c = candles[i];

    if (isBuy) {
      if (!leg1Closed) {
        if (c.high >= tp1) {
          leg1Closed = true;
          leg1Pips = targetTP1Pips * 10;
        } else if (c.low <= initialSL) {
          leg1Closed = true;
          leg1Pips = -slDist * 10;
        }
      }

      if (!isBEActive && c.high >= entryPrice + BE_TRIGGER) {
        isBEActive = true;
        leg2SL = entryPrice + BE_OFFSET;
      }

      if (isBEActive) {
        const potentialSL = c.high - TRAILING_DIST;
        if (potentialSL >= leg2SL + TRAILING_STEP) leg2SL = potentialSL;
      }

      if (!leg2Closed) {
        if (c.high >= tp2) {
          leg2Closed = true;
          leg2Pips = tp2Dist * 10;
        } else if (c.low <= leg2SL) {
          leg2Closed = true;
          leg2Pips = (leg2SL - entryPrice) * 10;
        }
      }
    } else {
      if (!leg1Closed) {
        if (c.low <= tp1) {
          leg1Closed = true;
          leg1Pips = targetTP1Pips * 10;
        } else if (c.high >= initialSL) {
          leg1Closed = true;
          leg1Pips = -slDist * 10;
        }
      }

      if (!isBEActive && c.low <= entryPrice - BE_TRIGGER) {
        isBEActive = true;
        leg2SL = entryPrice - BE_OFFSET;
      }

      if (isBEActive) {
        const potentialSL = c.low + TRAILING_DIST;
        if (potentialSL <= leg2SL - TRAILING_STEP) leg2SL = potentialSL;
      }

      if (!leg2Closed) {
        if (c.low <= tp2) {
          leg2Closed = true;
          leg2Pips = tp2Dist * 10;
        } else if (c.high >= leg2SL) {
          leg2Closed = true;
          leg2Pips = (entryPrice - leg2SL) * 10;
        }
      }
    }

    if (leg1Closed && leg2Closed) break;
  }

  if (!leg1Closed) {
    const endPrice = candles[maxLookforward - 1].close;
    const diff = (isBuy ? endPrice - entryPrice : entryPrice - endPrice) * 10;
    leg1Pips = Math.max(-slDist * 10, Math.min(targetTP1Pips * 10, diff));
  }
  if (!leg2Closed) {
    const endPrice = candles[maxLookforward - 1].close;
    const diff = (isBuy ? endPrice - entryPrice : entryPrice - endPrice) * 10;
    leg2Pips = Math.max(-slDist * 10, Math.min(tp2Dist * 10, diff));
  }

  const combinedNetPips = (leg1Pips * partialRatio) + (leg2Pips * (1.0 - partialRatio));
  return {
    netPips: combinedNetPips,
    isWin: combinedNetPips > 0,
    leg1Pips,
    leg2Pips
  };
}

async function main() {
  await client.connect();
  const dialogs = await client.getDialogs({});
  const active7 = Object.entries(CHANNELS_CONFIG).filter(([id, cfg]) => cfg.enabled);

  const rawSignals = [];

  for (const [chId, cfg] of active7) {
    const rawId = chId.replace(/^-100/, '').replace(/^-/, '');
    const found = dialogs.find(d => d.id.toString() === chId || d.id.toString() === rawId || (d.name && d.name.toLowerCase().includes(cfg.name.toLowerCase())));
    if (!found) continue;

    let msgs = [];
    let offsetId = 0;
    for (let b = 0; b < 6; b++) {
      const batch = await client.getMessages(found.inputEntity, { limit: 100, offsetId });
      if (!batch || batch.length === 0) break;
      msgs.push(...batch);
      offsetId = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }

    const strategy = strategyFactory.getStrategy(chId, cfg.name);

    msgs.reverse().forEach(m => {
      if (!m.message) return;
      const sig = strategy.parse(m.message, { messageId: m.id });
      if (sig && sig.action && (sig.action.includes('BUY') || sig.action.includes('SELL'))) {
        const sym = (sig.symbol || 'XAUUSD').toUpperCase();
        if (!sym.includes('XAU') && !sym.includes('GOLD')) return;

        let entry = sig.entry;
        if (entry && (entry > 5000 || entry < 1500)) return;
        if (!entry) entry = 4200;

        if (!sig.sl) {
          const dist = (cfg.defaultSLPips || 80) / 10;
          sig.sl = sig.action.includes('BUY') ? entry - dist : entry + dist;
        }
        if (!sig.tp1) {
          const dist1 = (cfg.defaultTP1Pips || 35) / 10;
          const dist2 = (cfg.defaultTP2Pips || 75) / 10;
          sig.tp1 = sig.action.includes('BUY') ? entry + dist1 : entry - dist1;
          sig.tp2 = sig.action.includes('BUY') ? entry + dist2 : entry - dist2;
        }

        const slDist = Math.abs(entry - sig.sl) * 10;
        if (slDist > 90) sig.sl = sig.action.includes('BUY') ? entry - 9.0 : entry + 9.0;

        const cIdx = findCandleIndex(m.date * 1000);
        if (cIdx < candles.length - 10) {
          rawSignals.push({
            channelId: chId,
            channelName: cfg.name,
            timestamp: m.date * 1000,
            candleIdx: cIdx,
            signal: sig
          });
        }
      }
    });
  }

  rawSignals.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`\n========================================================================================`);
  console.log(`🧪 OPTIMIZACIÓN MULTI-CONFIGURACIÓN SOBRE ${rawSignals.length} TRADES REALES DE 1 AÑO`);
  console.log(`========================================================================================\n`);

  // Configuraciones a probar
  const CONFIGS = [
    {
      name: 'Configuración Baseline (Actual: 50/50 | BE: 25p | Trailing: 20p)',
      params: { partialRatio: 0.50, beTriggerPips: 25.0, beOffsetPips: 5.0, trailingDistPips: 20.0 }
    },
    {
      name: 'Variante 1: BE Rápido a 20 pips (50/50 | BE: 20p | Trailing: 18p)',
      params: { partialRatio: 0.50, beTriggerPips: 20.0, beOffsetPips: 4.0, trailingDistPips: 18.0 }
    },
    {
      name: 'Variante 2: Sesgo 70/30 (70% TP1 / 30% Runner | BE: 20p | Trailing: 18p)',
      params: { partialRatio: 0.70, beTriggerPips: 20.0, beOffsetPips: 4.0, trailingDistPips: 18.0 }
    },
    {
      name: 'Variante 3: Alta Certeza 80/20 (80% TP1 / 20% Runner | BE: 18p | Trailing: 15p)',
      params: { partialRatio: 0.80, beTriggerPips: 18.0, beOffsetPips: 3.5, trailingDistPips: 15.0 }
    },
    {
      name: 'Variante 4: TP1 Rápido a 25 pips + 70/30 + BE: 18p (Máxima Estabilidad)',
      params: { partialRatio: 0.70, tp1OverridePips: 25.0, beTriggerPips: 18.0, beOffsetPips: 3.5, trailingDistPips: 18.0 }
    },
    {
      name: 'Variante 5: TP1 Ultra-Sniper a 20 pips + 75/25 + BE: 15p (Win Rate Máximo)',
      params: { partialRatio: 0.75, tp1OverridePips: 20.0, beTriggerPips: 15.0, beOffsetPips: 3.0, trailingDistPips: 15.0 }
    }
  ];

  console.log(`${'Configuración Evaluada'.padEnd(56)} | ${'Win Rate'.padStart(9)} | ${'Pips Netos'.padStart(12)} | ${'P. Factor'.padStart(9)} | ${'Drawdown'.padStart(10)} | ${'Estabilidad'}`);
  console.log('-'.repeat(112));

  let bestWRConfig = null;
  let bestStabilityConfig = null;
  let highestWR = 0;
  let lowestDD = 999999;

  CONFIGS.forEach(cfg => {
    let wins = 0;
    let pipsWon = 0;
    let pipsLost = 0;
    let peak = 0;
    let running = 0;
    let maxDD = 0;

    rawSignals.forEach(s => {
      const res = simulateTradeParametric(s.signal, s.candleIdx, cfg.params);
      const p = res.netPips;
      running += p;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;

      if (p > 0) {
        wins++;
        pipsWon += p;
      } else {
        pipsLost += Math.abs(p);
      }
    });

    const total = rawSignals.length;
    const wr = (wins / total) * 100;
    const netPips = pipsWon - pipsLost;
    const pf = pipsLost > 0 ? (pipsWon / pipsLost).toFixed(2) : 'MAX';

    let stabilityScore = 'Moderada';
    if (wr >= 75 && maxDD < 180) stabilityScore = '⭐⭐⭐⭐ Alta';
    if (wr >= 80 && maxDD < 140) stabilityScore = '⭐⭐⭐⭐⭐ MÁXIMA';
    if (wr >= 84) stabilityScore = '👑 ELITE (Anti-SL)';

    console.log(`${cfg.name.slice(0, 56).padEnd(56)} | ${(wr.toFixed(1) + '%').padStart(9)} | ${(netPips > 0 ? '+' : '') + netPips.toFixed(1) + 'p'} | ${pf.padStart(9)} | ${(maxDD.toFixed(1) + 'p').padStart(10)} | ${stabilityScore}`);

    if (wr > highestWR) {
      highestWR = wr;
      bestWRConfig = { ...cfg, wr, netPips, pf, maxDD };
    }
    if (maxDD < lowestDD) {
      lowestDD = maxDD;
      bestStabilityConfig = { ...cfg, wr, netPips, pf, maxDD };
    }
  });

  console.log('\n========================================================================================\n');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
