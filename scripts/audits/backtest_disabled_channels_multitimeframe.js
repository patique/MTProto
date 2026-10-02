/**
 * Backtest Histórico Multitemporal (1 Mes, 3 Meses, 6 Meses, 1 Año)
 * Para los 11 Canales Desactivados con la NUEVA Estrategia:
 * "50% Parcial en TP1 + Auto Break-Even + Trailing Stop Dinámico (The5%ers Safe)"
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');
const { CHANNELS_CONFIG } = require('../../config/channels.config');
const { strategyFactory } = require('../../core/StrategyFactory');
const { riskEngine } = require('../../core/RiskEngine');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const client = new TelegramClient(new StringSession(stringSessionStr), 25677000, 'e49356f9d8dbb478b5ffc575a632ac55', { connectionRetries: 5 });

// Cargar velas de Oro 15m de 1 año (35.040 velas)
const candlesPath = path.join(__dirname, 'cache_paxgusdt_15m_1y.json');
const candles = JSON.parse(fs.readFileSync(candlesPath, 'utf8'));

// Ordenar velas cronológicamente
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

/**
 * Simula la ejecución de un trade con el nuevo modelo:
 * 50% TP1 + 50% TP2/Trailing + Auto-BE a 25 pips
 */
function simulateTradeWithNewStrategy(signal, startCandleIdx) {
  const isBuy = signal.action.toUpperCase().includes('BUY');
  const entryPrice = signal.entry || candles[startCandleIdx].open;
  const initialSL = signal.sl;
  const tp1 = signal.tp1 || (isBuy ? entryPrice + 3.0 : entryPrice - 3.0);
  const tp2 = signal.tp2 || (isBuy ? entryPrice + 7.0 : entryPrice - 7.0);

  const BE_TRIGGER = 2.5; // 25 pips ($2.50 en Oro)
  const BE_OFFSET = 0.5;  // 5 pips ($0.50 en Oro)
  const TRAILING_DIST = 2.0; // 20 pips ($2.00)
  const TRAILING_STEP = 0.5; // 5 pips ($0.50) Anti-spam

  let leg1Closed = false;
  let leg1Pips = 0;
  let leg2Closed = false;
  let leg2Pips = 0;
  let leg2SL = initialSL;
  let isBEActive = false;

  const maxLookforward = Math.min(candles.length, startCandleIdx + 200); // máx ~2 días

  for (let i = startCandleIdx; i < maxLookforward; i++) {
    const c = candles[i];

    if (isBuy) {
      // 1. Verificar Leg 1 (TP1)
      if (!leg1Closed) {
        if (c.high >= tp1) {
          leg1Closed = true;
          leg1Pips = Math.abs(tp1 - entryPrice) * 10;
        } else if (c.low <= initialSL) {
          leg1Closed = true;
          leg1Pips = -Math.abs(entryPrice - initialSL) * 10;
        }
      }

      // 2. Verificar Auto Break-Even para Leg 2
      if (!isBEActive && c.high >= entryPrice + BE_TRIGGER) {
        isBEActive = true;
        leg2SL = entryPrice + BE_OFFSET;
      }

      // 3. Trailing Stop Dinámico
      if (isBEActive) {
        const potentialSL = c.high - TRAILING_DIST;
        if (potentialSL >= leg2SL + TRAILING_STEP) {
          leg2SL = potentialSL;
        }
      }

      // 4. Verificar Leg 2 (TP2 o SL / Trailing)
      if (!leg2Closed) {
        if (c.high >= tp2) {
          leg2Closed = true;
          leg2Pips = Math.abs(tp2 - entryPrice) * 10;
        } else if (c.low <= leg2SL) {
          leg2Closed = true;
          const currentLoss = (leg2SL - entryPrice) * 10;
          leg2Pips = currentLoss; // Puede ser positivo si ya estaba en trailing o +5 pips en BE
        }
      }
    } else {
      // SELL
      // 1. Verificar Leg 1 (TP1)
      if (!leg1Closed) {
        if (c.low <= tp1) {
          leg1Closed = true;
          leg1Pips = Math.abs(entryPrice - tp1) * 10;
        } else if (c.high >= initialSL) {
          leg1Closed = true;
          leg1Pips = -Math.abs(initialSL - entryPrice) * 10;
        }
      }

      // 2. Verificar Auto Break-Even para Leg 2
      if (!isBEActive && c.low <= entryPrice - BE_TRIGGER) {
        isBEActive = true;
        leg2SL = entryPrice - BE_OFFSET;
      }

      // 3. Trailing Stop Dinámico
      if (isBEActive) {
        const potentialSL = c.low + TRAILING_DIST;
        if (potentialSL <= leg2SL - TRAILING_STEP) {
          leg2SL = potentialSL;
        }
      }

      // 4. Verificar Leg 2 (TP2 o SL / Trailing)
      if (!leg2Closed) {
        if (c.low <= tp2) {
          leg2Closed = true;
          leg2Pips = Math.abs(entryPrice - tp2) * 10;
        } else if (c.high >= leg2SL) {
          leg2Closed = true;
          const currentLoss = (entryPrice - leg2SL) * 10;
          leg2Pips = currentLoss;
        }
      }
    }

    if (leg1Closed && leg2Closed) break;
  }

  // Si al cabo del período no cerró, cerrar al precio actual
  if (!leg1Closed) {
    const endPrice = candles[maxLookforward - 1].close;
    leg1Pips = (isBuy ? endPrice - entryPrice : entryPrice - endPrice) * 10;
  }
  if (!leg2Closed) {
    const endPrice = candles[maxLookforward - 1].close;
    leg2Pips = (isBuy ? endPrice - entryPrice : entryPrice - endPrice) * 10;
  }

  // Pips combinados netos (50% Leg 1 + 50% Leg 2)
  const combinedNetPips = (leg1Pips * 0.5) + (leg2Pips * 0.5);
  const isWin = combinedNetPips > 0;
  const isBE = Math.abs(combinedNetPips) <= 3.0;

  return {
    isWin,
    isBE,
    leg1Pips,
    leg2Pips,
    netPips: combinedNetPips,
    // Con 0.5% riesgo en cuenta de 5k ($25 riesgo), cada pip en Oro suele ser ~$0.70 a $1.00 USD
    netUSD: combinedNetPips * 0.75
  };
}

async function runMultitimeframeBacktest() {
  await client.connect();
  const dialogs = await client.getDialogs({});

  const disabledChannels = Object.entries(CHANNELS_CONFIG).filter(([id, cfg]) => !cfg.enabled);

  console.log('========================================================================================');
  console.log('🔬 AUDITORÍA HISTÓRICA MULTITEMPORAL DE LOS 11 CANALES DESACTIVADOS');
  console.log('   ESTRATEGIA: 50% Parcial en TP1 + Auto Break-Even + Trailing Stop (The5%ers Safe)');
  console.log('   VENTANAS AUDITADAS: 1 Mes | 3 Meses | 6 Meses | 1 Año');
  console.log('========================================================================================\n');

  const nowMs = Date.now();
  const PERIODS = {
    '1m': 30 * 24 * 3600 * 1000,
    '3m': 90 * 24 * 3600 * 1000,
    '6m': 180 * 24 * 3600 * 1000,
    '1y': 365 * 24 * 3600 * 1000
  };

  const results = {};

  for (const [chId, cfg] of disabledChannels) {
    process.stdout.write(`📡 Extrayendo histórico de "${cfg.name}"... `);

    const rawId = chId.replace(/^-100/, '').replace(/^-/, '');
    const found = dialogs.find(d => d.id.toString() === chId || d.id.toString() === rawId || (d.name && d.name.toLowerCase().includes(cfg.name.toLowerCase())));

    if (!found) {
      console.log('❌ Canal no encontrado en Telegram.');
      continue;
    }

    // Descargar hasta 600 mensajes
    let allMsgs = [];
    let offsetId = 0;
    for (let b = 0; b < 6; b++) {
      const batch = await client.getMessages(found.inputEntity, { limit: 100, offsetId });
      if (!batch || batch.length === 0) break;
      allMsgs.push(...batch);
      offsetId = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }

    const strategy = strategyFactory.getStrategy(chId, cfg.name);
    const parsedTrades = [];

    allMsgs.reverse().forEach(m => {
      if (!m.message) return;
      const tMs = m.date * 1000;
      const sig = strategy.parse(m.message, { messageId: m.id });
      if (sig && sig.action && (sig.action.includes('BUY') || sig.action.includes('SELL')) && (sig.entry || sig.sl)) {
        // Asignar SL si venía provisional
        if (!sig.sl) {
          const entry = sig.entry || 4200;
          const dist = (cfg.defaultSLPips || 80) / 10;
          sig.sl = sig.action.includes('BUY') ? entry - dist : entry + dist;
        }
        // Asignar TPs si faltaban
        if (!sig.tp1) {
          const entry = sig.entry || 4200;
          const dist1 = (cfg.defaultTP1Pips || 35) / 10;
          const dist2 = (cfg.defaultTP2Pips || 75) / 10;
          sig.tp1 = sig.action.includes('BUY') ? entry + dist1 : entry - dist1;
          sig.tp2 = sig.action.includes('BUY') ? entry + dist2 : entry - dist2;
        }

        // Acotar SL a 100 pips max (Risk protection)
        const entry = sig.entry || 4200;
        const slDistPips = Math.abs(entry - sig.sl) * 10;
        if (slDistPips > 100) {
          sig.sl = sig.action.includes('BUY') ? entry - 10.0 : entry + 10.0;
        }

        const candleIdx = findCandleIndex(tMs);
        if (candleIdx < candles.length - 10) {
          const sim = simulateTradeWithNewStrategy(sig, candleIdx);
          parsedTrades.push({
            id: m.id,
            timestamp: tMs,
            signal: sig,
            sim
          });
        }
      }
    });

    console.log(`✅ ${parsedTrades.length} señales operables encontradas.`);

    results[chId] = {
      name: cfg.name,
      totalTrades: parsedTrades.length,
      windows: {}
    };

    for (const [pKey, pDuration] of Object.entries(PERIODS)) {
      const windowTrades = parsedTrades.filter(t => t.timestamp >= (nowMs - pDuration));
      const totalW = windowTrades.length;
      if (totalW === 0) {
        results[chId].windows[pKey] = { trades: 0, wr: 0, netPips: 0, netUSD: 0, dd: 0, pf: 0 };
        continue;
      }

      let wins = 0;
      let pipsWon = 0;
      let pipsLost = 0;
      let peak = 0;
      let running = 0;
      let maxDD = 0;

      windowTrades.forEach(t => {
        const net = t.sim.netPips;
        running += net;
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDD) maxDD = dd;

        if (net > 0) {
          wins++;
          pipsWon += net;
        } else {
          pipsLost += Math.abs(net);
        }
      });

      const wr = (wins / totalW) * 100;
      const netPips = pipsWon - pipsLost;
      const netUSD = netPips * 0.75;
      const pf = pipsLost > 0 ? (pipsWon / pipsLost) : (pipsWon > 0 ? 99 : 0);

      results[chId].windows[pKey] = {
        trades: totalW,
        wins,
        wr,
        netPips,
        netUSD,
        ddPips: maxDD,
        pf
      };
    }
  }

  // Guardar reporte JSON
  fs.writeFileSync('scripts/audits/cache_disabled_channels_backtest.json', JSON.stringify(results, null, 2));

  // Imprimir Tablas Comparativas
  console.log('\n========================================================================================================');
  console.log('📊 COMPARATIVA MULTITEMPORAL DE CANALES DESACTIVADOS (NUEVA ESTRATEGIA: 50% TP1 + TRAILING)');
  console.log('========================================================================================================\n');

  for (const [pKey, pLabel] of Object.entries({ '1m': 'ÚLTIMO 1 MES (30 días)', '3m': 'ÚLTIMOS 3 MESES (90 días)', '6m': 'ÚLTIMOS 6 MESES (180 días)', '1y': 'ÚLTIMO 1 AÑO (Histórico Completo)' })) {
    console.log(`\n🔹 --- [ VENTANA: ${pLabel} ] ---`);
    console.log(`${'Canal'.padEnd(28)} | ${'Trades'.padEnd(6)} | ${'Win Rate'.padEnd(8)} | ${'Pips Netos'.padEnd(12)} | ${'Net USD ($5k)'.padEnd(14)} | ${'Drawdown'.padEnd(10)} | ${'P. Factor'.padEnd(9)}`);
    console.log('-'.repeat(105));

    const sortedByProfit = Object.values(results).sort((a, b) => (b.windows[pKey]?.netUSD || 0) - (a.windows[pKey]?.netUSD || 0));

    sortedByProfit.forEach(c => {
      const w = c.windows[pKey];
      if (!w || w.trades === 0) {
        console.log(`${c.name.slice(0, 28).padEnd(28)} | ${'0'.padStart(6)} | ${'N/A'.padStart(8)} | ${'0.0p'.padStart(12)} | ${'$0.00'.padStart(14)} | ${'0.0p'.padStart(10)} | ${'N/A'.padStart(9)}`);
        return;
      }

      const wrStr = `${w.wr.toFixed(1)}%`;
      const pipsStr = `${w.netPips > 0 ? '+' : ''}${w.netPips.toFixed(1)}p`;
      const usdStr = `${w.netUSD > 0 ? '+' : ''}$${w.netUSD.toFixed(2)}`;
      const ddStr = `${w.ddPips.toFixed(1)}p`;
      const pfStr = w.pf >= 99 ? 'MAX' : w.pf.toFixed(2);

      console.log(`${c.name.slice(0, 28).padEnd(28)} | ${String(w.trades).padStart(6)} | ${wrStr.padStart(8)} | ${pipsStr.padStart(12)} | ${usdStr.padStart(14)} | ${ddStr.padStart(10)} | ${pfStr.padStart(9)}`);
    });
  }

  process.exit(0);
}

runMultitimeframeBacktest().catch(e => {
  console.error('Error durante el backtest:', e);
  process.exit(1);
});
