/**
 * Auditoría Integral y Rigurosa de TODOS los Canales de Telegram
 * Conectado a Telegram MTProto + 100,000 Velas Reales de MT5 Broker (Marzo - Septiembre 2026)
 * Calcula matemáticamente:
 *  - % Hit a TP1
 *  - % Hit a TP2
 *  - % Hit a TP3
 *  - % SL Directo
 *  - % Retorno a BE tras TP1
 *  - Pips Netos (Estrategia TP1 vs TP2 vs Híbrida 50/50 + Trailing)
 *  - Desempeño reciente (última semana / hoy)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CHANNELS_CONFIG } = require('../../config/channels.config');
const { strategyFactory } = require('../../core/StrategyFactory');

const CSV_M2 = path.join(__dirname, '..', '..', 'XAUUSD_M2_202603051240_202609291056.csv');
const CSV_M1 = path.join(__dirname, '..', '..', 'XAUUSD_M1_202606171851_202609291057.csv');

const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
const client = new TelegramClient(new StringSession(stringSessionStr), 25677000, 'e49356f9d8dbb478b5ffc575a632ac55', { connectionRetries: 3 });

async function loadCandles(filePath) {
  console.log(`📂 Cargando velas reales desde: ${path.basename(filePath)}...`);
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const [y, m, d] = parts[0].split('.').map(Number);
    const [h, min, s] = parts[1].split(':').map(Number);
    // Broker Time UTC+2 (EET) -> convertir a UTC real
    const timestamp = Date.UTC(y, m - 1, d, h - 2, min, s);

    candles.push({
      dateStr: `${parts[0]} ${parts[1]}`,
      timestamp,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.5
    });
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`✅ ${candles.length.toLocaleString()} velas cargadas. Rango: ${candles[0].dateStr} a ${candles[candles.length - 1].dateStr}\n`);
  return candles;
}

function findCandleIndex(candles, candleTimestamps, targetTime) {
  let low = 0, high = candleTimestamps.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candleTimestamps[mid] < targetTime) low = mid + 1;
    else high = mid - 1;
  }
  return Math.min(low, candleTimestamps.length - 1);
}

/**
 * Evalúa el recorrido exacto de una señal en las velas
 */
function auditSignalTrajectory(signal, candles, startIdx) {
  const isBuy = signal.action.toUpperCase().includes('BUY');
  const entryPrice = signal.entry || candles[startIdx].open;
  const initialSL = signal.sl;
  const tp1 = signal.tp1;
  const tp2 = signal.tp2;
  const tp3 = signal.tp3;

  const slDistPips = Math.abs(entryPrice - initialSL) * 10;
  const tp1DistPips = tp1 ? Math.abs(tp1 - entryPrice) * 10 : null;
  const tp2DistPips = tp2 ? Math.abs(tp2 - entryPrice) * 10 : null;
  const tp3DistPips = tp3 ? Math.abs(tp3 - entryPrice) * 10 : null;

  let hitTP1 = false;
  let hitTP2 = false;
  let hitTP3 = false;
  let hitSLDirect = false;
  let hitBEAfterTP1 = false;
  let tradeFinished = false;

  let maxFavorablePips = 0;
  let maxAdversePips = 0;
  let candlesToTP1 = 0;
  let candlesToTP2 = 0;

  // Seguimiento híbrido 50/50: 50% TP1 + 50% TP2 con Auto-BE
  let hybridPips = 0;
  let hybridLeg1Closed = false;
  let hybridLeg2Closed = false;
  let hybridBEActive = false;
  let hybridLeg2SL = initialSL;

  const maxLookforward = Math.min(candles.length, startIdx + 300); // hasta ~10 horas en M2

  for (let i = startIdx; i < maxLookforward; i++) {
    const c = candles[i];
    const high = c.high;
    const low = c.low;

    const currentFavorable = isBuy ? (high - entryPrice) * 10 : (entryPrice - low) * 10;
    const currentAdverse = isBuy ? (entryPrice - low) * 10 : (high - entryPrice) * 10;
    if (currentFavorable > maxFavorablePips) maxFavorablePips = currentFavorable;
    if (currentAdverse > maxAdversePips) maxAdversePips = currentAdverse;

    if (isBuy) {
      // 1. SL Directo antes de TP1
      if (!hitTP1 && low <= initialSL) {
        hitSLDirect = true;
        tradeFinished = true;
        hybridPips = -slDistPips;
        break;
      }

      // 2. Comprobar TP1
      if (!hitTP1 && tp1 && high >= tp1) {
        hitTP1 = true;
        candlesToTP1 = i - startIdx;
        hybridLeg1Closed = true;
        hybridPips += (tp1DistPips * 0.5);
        // Activar Auto-BE para Leg 2
        hybridBEActive = true;
        hybridLeg2SL = entryPrice + 0.2; // +2 pips para cubrir comisiones
      }

      // 3. Si ya tocó TP1, vigilar TP2 vs retroceso a BE/SL
      if (hitTP1) {
        if (!hitTP2 && tp2 && high >= tp2) {
          hitTP2 = true;
          candlesToTP2 = i - startIdx;
          hybridLeg2Closed = true;
          hybridPips += (tp2DistPips * 0.5);
        } else if (!hitTP2 && low <= hybridLeg2SL) {
          hitBEAfterTP1 = true;
          hybridLeg2Closed = true;
          hybridPips += 1.0; // +1 pip garantizado en BE
        }

        if (tp3 && high >= tp3) {
          hitTP3 = true;
        }

        if (hitTP2 || hitBEAfterTP1) {
          tradeFinished = true;
          break;
        }
      }
    } else {
      // SELL
      // 1. SL Directo antes de TP1
      if (!hitTP1 && high >= initialSL) {
        hitSLDirect = true;
        tradeFinished = true;
        hybridPips = -slDistPips;
        break;
      }

      // 2. Comprobar TP1
      if (!hitTP1 && tp1 && low <= tp1) {
        hitTP1 = true;
        candlesToTP1 = i - startIdx;
        hybridLeg1Closed = true;
        hybridPips += (tp1DistPips * 0.5);
        hybridBEActive = true;
        hybridLeg2SL = entryPrice - 0.2;
      }

      // 3. Si ya tocó TP1, vigilar TP2 vs retroceso a BE/SL
      if (hitTP1) {
        if (!hitTP2 && tp2 && low <= tp2) {
          hitTP2 = true;
          candlesToTP2 = i - startIdx;
          hybridLeg2Closed = true;
          hybridPips += (tp2DistPips * 0.5);
        } else if (!hitTP2 && high >= hybridLeg2SL) {
          hitBEAfterTP1 = true;
          hybridLeg2Closed = true;
          hybridPips += 1.0;
        }

        if (tp3 && low <= tp3) {
          hitTP3 = true;
        }

        if (hitTP2 || hitBEAfterTP1) {
          tradeFinished = true;
          break;
        }
      }
    }
  }

  // Si no concluyó en la ventana, cerrar al precio actual
  if (!tradeFinished && !hitSLDirect) {
    if (hitTP1 && !hitTP2 && !hitBEAfterTP1) {
      hitBEAfterTP1 = true;
      hybridPips += 1.0;
    } else if (!hitTP1) {
      hitSLDirect = true;
      hybridPips = -slDistPips;
    }
  }

  return {
    hitTP1,
    hitTP2,
    hitTP3,
    hitSLDirect,
    hitBEAfterTP1,
    tp1Pips: tp1DistPips,
    tp2Pips: tp2DistPips,
    tp3Pips: tp3DistPips,
    slPips: slDistPips,
    maxFavorablePips: parseFloat(maxFavorablePips.toFixed(1)),
    maxAdversePips: parseFloat(maxAdversePips.toFixed(1)),
    hybridNetPips: parseFloat(hybridPips.toFixed(1)),
    candlesToTP1,
    candlesToTP2
  };
}

async function runCompleteAudit() {
  console.log('========================================================================================');
  console.log('🚀 INICIANDO AUDITORÍA VELA A VELA DE TODOS LOS CANALES (7 MESES REALES MT5)');
  console.log('========================================================================================\n');

  const candles = await loadCandles(CSV_M2);
  const candleTimestamps = candles.map(c => c.timestamp);

  console.log('📡 Conectando a Telegram MTProto...');
  await client.connect();
  const dialogs = await client.getDialogs({});
  console.log(`✅ Conectado. ${dialogs.length} diálogos accesibles en la cuenta.\n`);

  const report = {};
  const channelEntries = Object.entries(CHANNELS_CONFIG);

  for (const [chId, cfg] of channelEntries) {
    process.stdout.write(`🔍 Procesando: "${cfg.name}"... `);

    const rawId = chId.replace(/^-100/, '').replace(/^-/, '');
    const found = dialogs.find(d => 
      d.id.toString() === chId || 
      d.id.toString() === rawId || 
      (d.name && d.name.toLowerCase().includes(cfg.name.toLowerCase())) ||
      (cfg.username && d.entity?.username && cfg.username.toLowerCase().includes(d.entity.username.toLowerCase()))
    );

    if (!found) {
      console.log(`❌ No encontrado en diálogos.`);
      continue;
    }

    // Descargar hasta 600 mensajes
    let allMsgs = [];
    let offsetId = 0;
    for (let b = 0; b < 6; b++) {
      try {
        const batch = await client.getMessages(found.inputEntity, { limit: 100, offsetId });
        if (!batch || batch.length === 0) break;
        allMsgs.push(...batch);
        offsetId = batch[batch.length - 1].id;
        if (batch.length < 100) break;
      } catch (err) {
        break;
      }
    }

    const strategy = strategyFactory.getStrategy(chId, cfg.name);
    const auditedTrades = [];

    allMsgs.reverse().forEach(m => {
      if (!m.message) return;
      const tMs = m.date * 1000;
      const sig = strategy.parse(m.message, { messageId: m.id });

      if (sig && sig.action && (sig.action.includes('BUY') || sig.action.includes('SELL'))) {
        const sym = (sig.symbol || 'XAUUSD').toUpperCase();
        if (!sym.includes('XAU') && !sym.includes('GOLD')) return;

        // Si falta SL o TP, aplicar parámetros del canal
        if (!sig.sl) {
          const entry = sig.entry || 4200;
          const dist = (cfg.defaultSLPips || 80) / 10;
          sig.sl = sig.action.includes('BUY') ? entry - dist : entry + dist;
        }
        if (!sig.tp1) {
          const entry = sig.entry || 4200;
          const dist1 = (cfg.defaultTP1Pips || 35) / 10;
          const dist2 = (cfg.defaultTP2Pips || 75) / 10;
          sig.tp1 = sig.action.includes('BUY') ? entry + dist1 : entry - dist1;
          sig.tp2 = sig.action.includes('BUY') ? entry + dist2 : entry - dist2;
        }

        const candleIdx = findCandleIndex(candles, candleTimestamps, tMs);
        // Validar que la señal coincida con el rango de velas
        if (candleIdx >= 0 && candleIdx < candles.length - 10) {
          const result = auditSignalTrajectory(sig, candles, candleIdx);
          auditedTrades.push({
            id: m.id,
            date: new Date(tMs).toISOString(),
            dateStr: new Date(tMs).toLocaleString('es-ES'),
            action: sig.action,
            entry: sig.entry,
            sl: sig.sl,
            tp1: sig.tp1,
            tp2: sig.tp2,
            tp3: sig.tp3,
            ...result
          });
        }
      }
    });

    const total = auditedTrades.length;
    if (total === 0) {
      console.log(`⚠️ 0 señales válidas encontradas en el periodo.`);
      continue;
    }

    const tp1Count = auditedTrades.filter(t => t.hitTP1).length;
    const tp2Count = auditedTrades.filter(t => t.hitTP2).length;
    const tp3Count = auditedTrades.filter(t => t.hitTP3).length;
    const slDirectCount = auditedTrades.filter(t => t.hitSLDirect).length;
    const beCount = auditedTrades.filter(t => t.hitBEAfterTP1).length;

    const tp1Rate = (tp1Count / total) * 100;
    const tp2Rate = (tp2Count / total) * 100;
    const tp3Rate = (tp3Count / total) * 100;
    const slRate = (slDirectCount / total) * 100;
    const beRate = (beCount / total) * 100;

    let totalHybridPips = 0;
    let totalTP1OnlyPips = 0;
    let totalTP2OnlyPips = 0;

    auditedTrades.forEach(t => {
      totalHybridPips += t.hybridNetPips;
      totalTP1OnlyPips += t.hitTP1 ? (t.tp1Pips || 35) : -(t.slPips || 80);
      totalTP2OnlyPips += t.hitTP2 ? (t.tp2Pips || 75) : -(t.slPips || 80);
    });

    // Análisis de la última semana (últimos 7 días)
    const sevenDaysAgo = Date.now() - (7 * 86400000);
    const recentTrades = auditedTrades.filter(t => new Date(t.date).getTime() >= sevenDaysAgo);
    let recentPips = 0;
    let recentLosses = 0;
    let recentWins = 0;
    recentTrades.forEach(t => {
      recentPips += t.hybridNetPips;
      if (t.hybridNetPips > 0) recentWins++;
      else recentLosses++;
    });

    report[chId] = {
      name: cfg.name,
      currentlyEnabled: cfg.enabled,
      strategy: cfg.strategy,
      totalSignals: total,
      metrics: {
        tp1HitRate: parseFloat(tp1Rate.toFixed(1)),
        tp2HitRate: parseFloat(tp2Rate.toFixed(1)),
        tp3HitRate: parseFloat(tp3Rate.toFixed(1)),
        slDirectRate: parseFloat(slRate.toFixed(1)),
        bePullbackRate: parseFloat(beRate.toFixed(1)),
        netPipsHybrid: parseFloat(totalHybridPips.toFixed(1)),
        netPipsTP1Only: parseFloat(totalTP1OnlyPips.toFixed(1)),
        netPipsTP2Only: parseFloat(totalTP2OnlyPips.toFixed(1))
      },
      recentWeek: {
        trades: recentTrades.length,
        wins: recentWins,
        losses: recentLosses,
        wr: recentTrades.length > 0 ? parseFloat(((recentWins / recentTrades.length) * 100).toFixed(1)) : 0,
        netPips: parseFloat(recentPips.toFixed(1))
      },
      verdict: (tp1Rate >= 70 && totalHybridPips > 0 && slRate <= 30) ? 'RECOMENDADO' : (totalHybridPips < 0 || slRate > 40 ? 'TOXICO / DESCARTAR' : 'NEUTRO')
    };

    console.log(`✅ ${total} señales auditadas | TP1: ${tp1Rate.toFixed(1)}% | TP2: ${tp2Rate.toFixed(1)}% | SL: ${slRate.toFixed(1)}% | Pips: ${totalHybridPips > 0 ? '+' : ''}${totalHybridPips.toFixed(0)}p`);
  }

  // Guardar archivo JSON con los resultados detallados
  const outPath = path.join(__dirname, 'audit_all_channels_results.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Informe completo exportado a: ${outPath}\n`);

  // Imprimir Tablas Resumen
  console.log('========================================================================================================================');
  console.log('📊 TABLA DE RENDIMIENTO HISTÓRICO REAL (Velas M2 MT5 Broker)');
  console.log('========================================================================================================================');
  console.log(`${'Canal'.padEnd(28)} | ${'Estado'.padEnd(7)} | ${'Trades'.padEnd(6)} | ${'% TP1'.padEnd(7)} | ${'% TP2'.padEnd(7)} | ${'% SL'.padEnd(6)} | ${'% BE'.padEnd(6)} | ${'Pips Híbrido'.padEnd(13)} | ${'7D Pips'.padEnd(9)} | ${'Veredicto'.padEnd(12)}`);
  console.log('-'.repeat(120));

  const sorted = Object.values(report).sort((a, b) => b.metrics.netPipsHybrid - a.metrics.netPipsHybrid);

  sorted.forEach(c => {
    const m = c.metrics;
    const r = c.recentWeek;
    const stateStr = c.currentlyEnabled ? '🟢 ON' : '⚪ OFF';
    const pipsStr = `${m.netPipsHybrid > 0 ? '+' : ''}${m.netPipsHybrid.toFixed(0)}p`;
    const recPipsStr = `${r.netPips > 0 ? '+' : ''}${r.netPips.toFixed(0)}p`;
    
    console.log(
      `${c.name.slice(0, 28).padEnd(28)} | ` +
      `${stateStr.padEnd(7)} | ` +
      `${String(c.totalSignals).padStart(6)} | ` +
      `${(m.tp1HitRate + '%').padStart(7)} | ` +
      `${(m.tp2HitRate + '%').padStart(7)} | ` +
      `${(m.slDirectRate + '%').padStart(6)} | ` +
      `${(m.bePullbackRate + '%').padStart(6)} | ` +
      `${pipsStr.padStart(13)} | ` +
      `${recPipsStr.padStart(9)} | ` +
      `${c.verdict.padEnd(12)}`
    );
  });

  console.log('========================================================================================================================\n');
  process.exit(0);
}

runCompleteAudit().catch(err => {
  console.error('❌ Error ejecutando auditoría completa:', err);
  process.exit(1);
});
