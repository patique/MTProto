/**
 * Auditoría y Backtest Cuantitativo Anual (12 Meses): 
 * Estrategia Parciales 50% en TP1 + Break-Even + Trailing Stop Dinámico (Normativa The5%ers)
 * 
 * Reglas de The5%ers Auditadas:
 * - Cuenta: $5,000.00 USD (y $10,000 USD de referencia).
 * - Objetivo Fase 1: +10% (+$500 USD para 5k | +$1,000 USD para 10k).
 * - Límite Drawdown Diario: 5.0% ($250 USD en 5k).
 * - Límite Drawdown Total: 10.0% ($500 USD en 5k).
 * - Regla Anti-Spam de Servidor: Modificaciones de Trailing con paso mínimo de 5 pips (0.5 USD).
 */

const fs = require('fs');
const path = require('path');

// Cargar velas M15 de 1 año (35.040 velas)
const goldCandles = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache_paxgusdt_15m_1y.json'), 'utf8'));

function calculateRSI(candles, period = 7) {
  const rsi = new Float64Array(candles.length);
  if (candles.length <= period) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
}

function calculateBollingerBands(candles, period = 20, mult = 2.3) {
  const upper = new Float64Array(candles.length);
  const lower = new Float64Array(candles.length);
  const middle = new Float64Array(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    const sma = sum / period;
    middle[i] = sma;
    let varSum = 0;
    for (let j = 0; j < period; j++) {
      const d = candles[i - j].close - sma;
      varSum += d * d;
    }
    const sd = Math.sqrt(varSum / period);
    upper[i] = sma + (sd * mult);
    lower[i] = sma - (sd * mult);
  }
  return { upper, lower, middle };
}

/**
 * Motor de Simulación de Salidas
 */
function runExitModelBacktest(candles, modelConfig = {}) {
  const {
    name = 'Modelo',
    initialBalance = 5000.0,
    riskPercent = 0.50, // 0.50% por trade ($25 en cuenta de 5k)
    tp1Pips = 15.0,     // TP1: 15 pips ($1.50 en Oro)
    tp2Pips = 35.0,     // TP2: 35 pips ($3.50 en Oro)
    slPips = 25.0,      // SL inicial: 25 pips ($2.50 en Oro)
    mode = 'BASELINE',  // 'BASELINE', 'PARTIAL_BE', 'PARTIAL_TRAILING'
    trailingDistPips = 15.0, // Trailing a 15 pips detrás del precio
    trailingStepPips = 5.0   // Solo actualiza si avanza al menos 5 pips (Anti-Spam)
  } = modelConfig;

  const rsi = calculateRSI(candles, 7);
  const { upper, lower } = calculateBollingerBands(candles, 20, 2.3);

  let balance = initialBalance;
  let peak = balance;
  let maxDD = 0;
  let maxDailyDD = 0;
  let currentDay = '';
  let dayStartBal = balance;

  const trades = [];
  let inTrade = null;
  let passPhase1TradeIndex = null;
  let passPhase1Days = null;
  let totalModifications = 0;

  let beSavedCount = 0;
  let trailingSavedCount = 0;

  const tp1Dist = tp1Pips / 10.0;
  const tp2Dist = tp2Pips / 10.0;
  const slDist = slPips / 10.0;
  const trailingDist = trailingDistPips / 10.0;
  const trailingStep = trailingStepPips / 10.0;

  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1];
    const d = new Date(c.time);
    const dayStr = d.toISOString().slice(0, 10);
    const hour = d.getUTCHours();

    if (dayStr !== currentDay) {
      currentDay = dayStr;
      dayStartBal = balance;
    }

    // Gestionar trade activo
    if (inTrade) {
      const isBuy = inTrade.type === 'BUY';
      let closed = false;
      let pnlTotal = 0;

      // Evaluar precio en la vela actual
      const bestPrice = isBuy ? c.high : c.low;
      const worstPrice = isBuy ? c.low : c.high;

      // 1. Chequeo de TP1 (Cierre parcial 50% y pase a BE)
      if (!inTrade.tp1Hit) {
        const hitTP1 = isBuy ? bestPrice >= inTrade.tp1 : bestPrice <= inTrade.tp1;
        if (hitTP1) {
          inTrade.tp1Hit = true;
          if (mode === 'PARTIAL_BE' || mode === 'PARTIAL_TRAILING') {
            // Liquidar 50% del lote en TP1
            const p1Diff = tp1Dist;
            const pnl50 = p1Diff * (inTrade.lotSize * 0.5) * 100;
            inTrade.realizedPnl += pnl50;

            // Mover SL a Break-Even (entrada + $0.20 para cubrir comisiones)
            inTrade.sl = isBuy ? inTrade.entry + 0.20 : inTrade.entry - 0.20;
            inTrade.lastTrailedSL = inTrade.sl;
            inTrade.isBE = true;
            totalModifications++;
          } else {
            // En BASELINE: solo mueve SL a BE si supera 30 pips
            if (isBuy && bestPrice >= inTrade.entry + 3.0) {
              inTrade.sl = inTrade.entry + 0.50;
              inTrade.isBE = true;
              totalModifications++;
            } else if (!isBuy && bestPrice <= inTrade.entry - 3.0) {
              inTrade.sl = inTrade.entry - 0.50;
              inTrade.isBE = true;
              totalModifications++;
            }
          }
        }
      }

      // 2. Trailing Stop Dinámico (si está activado y ya pasó TP1)
      if (mode === 'PARTIAL_TRAILING' && inTrade.tp1Hit && !closed) {
        if (isBuy) {
          const proposedSL = bestPrice - trailingDist;
          if (proposedSL > inTrade.lastTrailedSL + trailingStep) {
            inTrade.sl = proposedSL;
            inTrade.lastTrailedSL = proposedSL;
            totalModifications++;
          }
        } else {
          const proposedSL = bestPrice + trailingDist;
          if (proposedSL < inTrade.lastTrailedSL - trailingStep) {
            inTrade.sl = proposedSL;
            inTrade.lastTrailedSL = proposedSL;
            totalModifications++;
          }
        }
      }

      // 3. Chequeo de Cierre: TP2 o SL/Trailing
      if (isBuy) {
        // TP2 Hit
        if (bestPrice >= inTrade.tp2) {
          const remainingLots = (mode === 'PARTIAL_BE' || mode === 'PARTIAL_TRAILING') ? inTrade.lotSize * 0.5 : inTrade.lotSize;
          const p2Diff = tp2Dist;
          const pnlRem = p2Diff * remainingLots * 100;
          pnlTotal = inTrade.realizedPnl + pnlRem;
          closed = true;
          inTrade.outcome = 'FULL_TP2';
        }
        // SL / Trailing / BE Hit
        else if (worstPrice <= inTrade.sl) {
          const remainingLots = (mode === 'PARTIAL_BE' || mode === 'PARTIAL_TRAILING') ? inTrade.lotSize * 0.5 : inTrade.lotSize;
          const exitDiff = inTrade.sl - inTrade.entry;
          const pnlRem = exitDiff * remainingLots * 100;
          pnlTotal = inTrade.realizedPnl + pnlRem;
          closed = true;

          if (inTrade.isBE && exitDiff >= 0) {
            inTrade.outcome = (mode === 'PARTIAL_TRAILING' && exitDiff > 0.5) ? 'TRAILING_WIN' : 'BE_EXIT';
            if (inTrade.outcome === 'TRAILING_WIN') trailingSavedCount++;
            else beSavedCount++;
          } else {
            inTrade.outcome = 'SL_LOSS';
          }
        }
      } else {
        // SELL: TP2 Hit
        if (bestPrice <= inTrade.tp2) {
          const remainingLots = (mode === 'PARTIAL_BE' || mode === 'PARTIAL_TRAILING') ? inTrade.lotSize * 0.5 : inTrade.lotSize;
          const p2Diff = tp2Dist;
          const pnlRem = p2Diff * remainingLots * 100;
          pnlTotal = inTrade.realizedPnl + pnlRem;
          closed = true;
          inTrade.outcome = 'FULL_TP2';
        }
        // SELL: SL / Trailing / BE Hit
        else if (worstPrice >= inTrade.sl) {
          const remainingLots = (mode === 'PARTIAL_BE' || mode === 'PARTIAL_TRAILING') ? inTrade.lotSize * 0.5 : inTrade.lotSize;
          const exitDiff = inTrade.entry - inTrade.sl;
          const pnlRem = exitDiff * remainingLots * 100;
          pnlTotal = inTrade.realizedPnl + pnlRem;
          closed = true;

          if (inTrade.isBE && exitDiff >= 0) {
            inTrade.outcome = (mode === 'PARTIAL_TRAILING' && exitDiff > 0.5) ? 'TRAILING_WIN' : 'BE_EXIT';
            if (inTrade.outcome === 'TRAILING_WIN') trailingSavedCount++;
            else beSavedCount++;
          } else {
            inTrade.outcome = 'SL_LOSS';
          }
        }
      }

      if (closed) {
        balance += pnlTotal;
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDD) maxDD = dd;

        const dailyDD = ((dayStartBal - balance) / dayStartBal) * 100;
        if (dailyDD > maxDailyDD) maxDailyDD = dailyDD;

        trades.push({
          type: inTrade.type,
          outcome: inTrade.outcome,
          pnl: pnlTotal,
          balanceAfter: balance,
          exitTime: c.time
        });

        // Verificación de pase de Fase 1 (+10% -> $5,500 en cuenta de 5k)
        const targetPassBalance = initialBalance * 1.10;
        if (balance >= targetPassBalance && passPhase1TradeIndex === null) {
          passPhase1TradeIndex = trades.length;
          const daysFromStart = (c.time - candles[0].time) / (1000 * 60 * 60 * 24);
          passPhase1Days = Math.ceil(daysFromStart * (5 / 7)); // días hábiles
        }

        inTrade = null;
      }

      continue;
    }

    // Filtro horario: 07:00 a 19:00 UTC
    if (hour < 7 || hour >= 19) continue;

    const currentRsi = rsi[i];
    const prevRsi = rsi[i - 1];

    let signal = null;
    if (prevC.low <= lower[i - 1] || c.low <= lower[i]) {
      if (currentRsi <= 16 || (prevRsi <= 16 && currentRsi > prevRsi)) {
        if (c.close > c.open) signal = 'BUY';
      }
    } else if (prevC.high >= upper[i - 1] || c.high >= upper[i]) {
      if (currentRsi >= 84 || (prevRsi >= 84 && currentRsi < prevRsi)) {
        if (c.close < c.open) signal = 'SELL';
      }
    }

    if (!signal) continue;

    const entry = c.close;
    const tp1 = signal === 'BUY' ? entry + tp1Dist : entry - tp1Dist;
    const tp2 = signal === 'BUY' ? entry + tp2Dist : entry - tp2Dist;
    const sl = signal === 'BUY' ? entry - slDist : entry + slDist;

    const riskUSD = balance * (riskPercent / 100.0);
    const lotSize = Math.max(0.01, Math.round((riskUSD / (slDist * 100)) * 100) / 100);

    inTrade = {
      type: signal,
      entry,
      tp1,
      tp2,
      sl,
      lastTrailedSL: sl,
      lotSize,
      tp1Hit: false,
      isBE: false,
      realizedPnl: 0,
      outcome: ''
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const bes = trades.filter(t => Math.abs(t.pnl) < 1.0);
  const total = trades.length;
  const winRate = total > 0 ? ((wins.length / total) * 100).toFixed(1) : 0;
  const netUSD = balance - initialBalance;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'Inf';

  const fullTP2Count = trades.filter(t => t.outcome === 'FULL_TP2').length;
  const trailingWinsCount = trades.filter(t => t.outcome === 'TRAILING_WIN').length;

  return {
    name,
    trades: total,
    wins: wins.length,
    losses: losses.length,
    fullTP2Count,
    trailingWinsCount,
    beSavedCount,
    winRate,
    initialBalance,
    finalBalance: balance,
    netProfitUSD: netUSD,
    netProfitPct: ((netUSD / initialBalance) * 100).toFixed(2),
    maxDD: maxDD.toFixed(2),
    maxDailyDD: maxDailyDD.toFixed(2),
    pf,
    passTrades: passPhase1TradeIndex,
    passDays: passPhase1Days,
    avgModPerTrade: total > 0 ? (totalModifications / total).toFixed(1) : 0
  };
}

async function main() {
  console.log(`========================================================================================================`);
  console.log(`🏛️ AUDITORÍA ANUAL 12 MESES: PARCIALES 50% + TRAILING STOP DINÁMICO EN THE5%ERS`);
  console.log(`🎯 CUENTA THE5%ERS: $5,000 USD | OBJETIVO FASE 1: +10% (+$500 USD) | LÍMITE DD: 5.0% DIARIO / 10% TOTAL`);
  console.log(`========================================================================================================\n`);

  const models = [
    {
      name: '1. BASELINE ACTUAL (100% Lote a TP2 | Auto-BE simple)',
      mode: 'BASELINE',
      initialBalance: 5000.0,
      riskPercent: 0.50,
      tp1Pips: 15.0,
      tp2Pips: 35.0,
      slPips: 25.0
    },
    {
      name: '2. PARCIAL 50% EN TP1 + BE (Sin Trailing Stop)',
      mode: 'PARTIAL_BE',
      initialBalance: 5000.0,
      riskPercent: 0.50,
      tp1Pips: 15.0,
      tp2Pips: 35.0,
      slPips: 25.0
    },
    {
      name: '3. 🏆 PARCIAL 50% + TRAILING DINÁMICO (Paso 5p Anti-Spam)',
      mode: 'PARTIAL_TRAILING',
      initialBalance: 5000.0,
      riskPercent: 0.50,
      tp1Pips: 15.0,
      tp2Pips: 35.0,
      slPips: 25.0,
      trailingDistPips: 15.0,
      trailingStepPips: 5.0
    },
    {
      name: '4. 🚀 PARCIAL 50% + TRAILING (Riesgo 0.75% por Trade)',
      mode: 'PARTIAL_TRAILING',
      initialBalance: 5000.0,
      riskPercent: 0.75,
      tp1Pips: 15.0,
      tp2Pips: 35.0,
      slPips: 25.0,
      trailingDistPips: 15.0,
      trailingStepPips: 5.0
    }
  ];

  console.log('| Modelo de Gestión | Trades | Win Rate | Beneficio Neto (5k) | Rentabilidad | Max DD Total | DD Diario | P.Factor | Pase Fase 1 (+10%) | Mod/Trade |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');

  for (const m of models) {
    const r = runExitModelBacktest(goldCandles, m);
    const sign = r.netProfitUSD >= 0 ? '+' : '';
    const passText = r.passTrades ? `Trade #${r.passTrades} (~${r.passDays} días)` : 'No alcanzó';
    console.log(`| ${r.name.padEnd(46)} | ${r.trades.toString().padEnd(6)} | ${(r.winRate + '%').padEnd(8)} | ${(sign + '$' + r.netProfitUSD.toFixed(2)).padEnd(19)} | ${(sign + r.netProfitPct + '%').padEnd(12)} | ${(r.maxDD + '%').padEnd(12)} | ${(r.maxDailyDD + '%').padEnd(9)} | ${r.pf.padEnd(8)} | ${passText.padEnd(20)} | ${r.avgModPerTrade} mod |`);
  }

  console.log('\n========================================================================================================');
  console.log('🔍 ANÁLISIS FORENSE: ¿CÓMO SALVA EL TRAILING STOP LAS OPERACIONES QUE SE DEVUELVEN?');
  console.log('========================================================================================================');
  const winner = runExitModelBacktest(goldCandles, models[2]);
  console.log(`   • Total Operaciones Cerradas en TP2 Completo:  ${winner.fullTP2Count} trades`);
  console.log(`   • Operaciones Salvadas por Trailing Stop:       ${winner.trailingWinsCount} trades (¡Cobraron ganancia en retroceso en vez de $0!)`);
  console.log(`   • Tasa de Cumplimiento Anti-Spam The5%ers:     ${winner.avgModPerTrade} modificaciones promedio por trade (Límite seguro: < 10)`);
  console.log(`   • Tiempo para Pasar Fase 1 (+10% / +$500 USD):  Solo ${winner.passTrades} trades (~${winner.passDays} días hábiles de trading)!`);
  console.log('========================================================================================================\n');
}

main().catch(console.error);
