/**
 * Auditoría Forense y Test de Estrés: Sistema Híbrido en Oro (XAUUSD / PAXGUSDT)
 * Combinación: Estrategia 1 (SVP PoC Limit H1) + Estrategia 2 (Connors RSI M15 Sniper)
 * 
 * OBJETIVO: FORZAR EL FALLO DEL SISTEMA
 * 1. ¿Qué pasa cuando ambas estrategias se solapan en la misma dirección (Doble Exposición)?
 * 2. ¿Qué pasa cuando entran en direcciones opuestas (Hedging / Canibalización)?
 * 3. ¿Cuál es el peor día del año (Max Daily Drawdown)? ¿Rompe la regla del 5% de la Prop Firm?
 * 4. Test de Estrés de Spread y Deslizamiento (Slippage x2 y x3).
 * 5. Test de Volatilidad Extrema (Cluster de pérdidas en eventos macro).
 */

const fs = require('fs');
const path = require('path');
const { fetchFullYearData } = require('./multi_tf_volume_profile_1y');
const { VolumeProfileStrategy } = require('../../core/algorithms/VolumeProfileStrategy');

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

function calculateBollingerBands(candles, period = 20, multiplier = 2.3) {
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
    upper[i] = sma + (sd * multiplier);
    lower[i] = sma - (sd * multiplier);
  }
  return { upper, lower, middle };
}

function calculateEMA(candles, period = 100) {
  const ema = new Float64Array(candles.length);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, candles.length); i++) sum += candles[i].close;
  let prevEma = sum / Math.min(period, candles.length);
  ema[Math.min(period, candles.length) - 1] = prevEma;
  for (let i = period; i < candles.length; i++) {
    prevEma = (candles[i].close - prevEma) * k + prevEma;
    ema[i] = prevEma;
  }
  return ema;
}

// Generador de señales de Estrategia 1 (SVP PoC Limit en H1 convertida a timeline de 15m)
function generateSVPTrades(h1Candles, riskPercent, spreadPips) {
  const vpEngine = new VolumeProfileStrategy({
    priceStep: 0.10,
    valueAreaPercent: 0.70,
    minRangeUSD: 4.0,
    expansionMultiplier: 1.5,
    slBufferUSD: 1.5
  });

  const ema100 = calculateEMA(h1Candles, 100);
  const trades = [];
  const daysMap = new Map();

  for (const c of h1Candles) {
    const day = new Date(c.time).toISOString().slice(0, 10);
    if (!daysMap.has(day)) daysMap.set(day, []);
    daysMap.get(day).push(c);
  }

  let globalIndex = 0;

  for (const [day, dayCandles] of daysMap.entries()) {
    const asianCandles = dayCandles.filter(c => {
      const h = new Date(c.time).getUTCHours();
      return h >= 0 && h < 7;
    });

    if (asianCandles.length < 5) {
      globalIndex += dayCandles.length;
      continue;
    }

    const asianProfile = vpEngine.calculateProfile(asianCandles);
    const tradingCandles = dayCandles.filter(c => {
      const h = new Date(c.time).getUTCHours();
      return h >= 7 && h < 20;
    });

    if (!tradingCandles.length) {
      globalIndex += dayCandles.length;
      continue;
    }

    const firstCandleIdx = globalIndex + dayCandles.indexOf(tradingCandles[0]);
    const currentEma = ema100[firstCandleIdx];
    const firstClose = tradingCandles[0].close;

    let orderType = null;
    let limitPrice = asianProfile.poc;
    let sl = 0;
    let tp1 = 0;
    let tp2 = 0;

    if (firstClose > asianProfile.poc && firstClose > currentEma) {
      orderType = 'BUY';
      sl = asianProfile.val - 1.50 - (spreadPips / 10.0);
      tp1 = asianProfile.vah;
      tp2 = asianProfile.vah + (1.5 * (asianProfile.vah - asianProfile.val));
    } else if (firstClose < asianProfile.poc && firstClose < currentEma) {
      orderType = 'SELL';
      sl = asianProfile.vah + 1.50 + (spreadPips / 10.0);
      tp1 = asianProfile.val;
      tp2 = asianProfile.val - (1.5 * (asianProfile.vah - asianProfile.val));
    }

    if (!orderType || (orderType === 'BUY' && sl >= limitPrice) || (orderType === 'SELL' && sl <= limitPrice)) {
      globalIndex += dayCandles.length;
      continue;
    }

    let isFilled = false;
    let fillTime = 0;
    let exitTime = 0;
    let exitPrice = 0;
    let pnlUSD = 0;
    let result = '';

    const slDistance = Math.abs(limitPrice - sl);

    for (let i = 0; i < tradingCandles.length; i++) {
      const c = tradingCandles[i];
      if (!isFilled) {
        if (orderType === 'BUY' && c.low <= limitPrice) {
          isFilled = true;
          fillTime = c.time;
        } else if (orderType === 'SELL' && c.high >= limitPrice) {
          isFilled = true;
          fillTime = c.time;
        }
      } else {
        if (orderType === 'BUY') {
          if (c.low <= sl) {
            result = 'LOSS';
            exitPrice = sl;
            exitTime = c.time;
            break;
          }
          if (c.high >= tp1) {
            result = 'WIN';
            exitPrice = tp1;
            exitTime = c.time;
            break;
          }
        } else {
          if (c.high >= sl) {
            result = 'LOSS';
            exitPrice = sl;
            exitTime = c.time;
            break;
          }
          if (c.low <= tp1) {
            result = 'WIN';
            exitPrice = tp1;
            exitTime = c.time;
            break;
          }
        }
      }
    }

    if (isFilled && result !== '') {
      trades.push({
        strategy: 'SVP_H1',
        type: orderType,
        entryTime: fillTime,
        exitTime,
        entryPrice: limitPrice,
        exitPrice,
        slDistance,
        result
      });
    }

    globalIndex += dayCandles.length;
  }

  return trades;
}

// Generador de señales de Estrategia 2 (Connors RSI en M15)
function generateRSITrades(m15Candles, riskPercent, spreadPips) {
  const rsi = calculateRSI(m15Candles, 7);
  const { upper, lower } = calculateBollingerBands(m15Candles, 20, 2.3);
  const trades = [];

  const tpDist = 1.50; // 15 pips
  const slDist = 2.50 + (spreadPips / 10.0); // 25 pips + spread adicional

  let inTrade = false;
  let exitIdx = -1;

  for (let i = 50; i < m15Candles.length; i++) {
    if (inTrade && i <= exitIdx) continue;
    inTrade = false;

    const c = m15Candles[i];
    const prevC = m15Candles[i - 1];
    const h = new Date(c.time).getUTCHours();

    if (h < 7 || h >= 19) continue;

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

    const entryPrice = c.close;
    const tpPrice = signal === 'BUY' ? entryPrice + tpDist : entryPrice - tpDist;
    const slPrice = signal === 'BUY' ? entryPrice - slDist : entryPrice + slDist;

    let resolved = false;
    let isWin = false;
    let finalExitPrice = 0;
    let finalExitTime = 0;

    for (let j = i + 1; j < Math.min(m15Candles.length, i + 32); j++) {
      const fc = m15Candles[j];
      if (signal === 'BUY') {
        if (fc.high >= tpPrice) {
          resolved = true;
          isWin = true;
          finalExitPrice = tpPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
        if (fc.low <= slPrice) {
          resolved = true;
          isWin = false;
          finalExitPrice = slPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
      } else {
        if (fc.low <= tpPrice) {
          resolved = true;
          isWin = true;
          finalExitPrice = tpPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
        if (fc.high >= slPrice) {
          resolved = true;
          isWin = false;
          finalExitPrice = slPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
      }
    }

    if (!resolved) {
      const lastC = m15Candles[Math.min(m15Candles.length - 1, i + 32)];
      const diff = signal === 'BUY' ? lastC.close - entryPrice : entryPrice - lastC.close;
      isWin = diff > 0;
      finalExitPrice = lastC.close;
      finalExitTime = lastC.time;
      exitIdx = i + 32;
      resolved = true;
    }

    if (resolved) {
      trades.push({
        strategy: 'RSI_M15',
        type: signal,
        entryTime: c.time,
        exitTime: finalExitTime,
        entryPrice,
        exitPrice: finalExitPrice,
        slDistance: slDist,
        result: isWin ? 'WIN' : 'LOSS'
      });
      inTrade = true;
    }
  }

  return trades;
}

/**
 * MOTOR DE ESTRÉS COMBINADO (TIMELINE UNIFICADA)
 */
function runForensicStressSimulation(allTrades, initialBalance = 10000.0, riskPercent = 0.75, options = {}) {
  const {
    enforceHedgingBlock = false, // Bloquear si intentan operar en direcciones opuestas
    enforceDailyLossCap = true,  // Si pierde 2.5% en el día, apagar bot hasta mañana
    maxDailyLossPct = 2.5
  } = options;

  // Ordenar cronológicamente por entryTime
  allTrades.sort((a, b) => a.entryTime - b.entryTime);

  let balance = initialBalance;
  let peak = balance;
  let maxDDUSD = 0;
  let maxDDPct = 0;

  let currentDay = '';
  let dayStartBal = balance;
  let maxDailyDD = 0;
  let dailyLossHit = false;

  // Métricas forenses
  let overlapCount = 0;
  let sameDirectionOverlap = 0;
  let oppositeDirectionOverlap = 0;
  let worstDayPnl = 0;
  let worstDayStr = '';
  let consecutiveLossesMax = 0;
  let currentConsecLosses = 0;

  const closedHistory = [];
  const activeTrades = [];

  for (const t of allTrades) {
    const dayStr = new Date(t.entryTime).toISOString().slice(0, 10);

    // Cambio de día
    if (dayStr !== currentDay) {
      if (currentDay !== '') {
        const dayPnl = balance - dayStartBal;
        if (dayPnl < worstDayPnl) {
          worstDayPnl = dayPnl;
          worstDayStr = currentDay;
        }
      }
      currentDay = dayStr;
      dayStartBal = balance;
      dailyLossHit = false;
    }

    // Filtro de Drawdown Diario (Kill-Switch)
    if (enforceDailyLossCap && dailyLossHit) {
      continue; // Ignorar trades por el resto del día
    }

    // Comprobar solapamiento con trades activos
    const overlapping = activeTrades.filter(at => at.exitTime > t.entryTime);
    if (overlapping.length > 0) {
      overlapCount++;
      for (const ot of overlapping) {
        if (ot.type === t.type) sameDirectionOverlap++;
        else oppositeDirectionOverlap++;
      }

      if (enforceHedgingBlock && overlapping.some(ot => ot.type !== t.type)) {
        continue; // Descartar trade por conflicto de dirección
      }
    }

    // Calcular lotaje y resultado
    const riskUSD = balance * (riskPercent / 100.0);
    const lotSize = Math.max(0.01, Math.round((riskUSD / (t.slDistance * 100)) * 100) / 100);

    const priceDiff = t.type === 'BUY' ? (t.exitPrice - t.entryPrice) : (t.entryPrice - t.exitPrice);
    const pnl = priceDiff * lotSize * 100;

    balance += pnl;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDDPct) {
      maxDDPct = dd;
      maxDDUSD = peak - balance;
    }

    const currentDailyDD = ((dayStartBal - balance) / dayStartBal) * 100;
    if (currentDailyDD > maxDailyDD) maxDailyDD = currentDailyDD;

    if (currentDailyDD >= maxDailyLossPct) {
      dailyLossHit = true;
    }

    if (t.result === 'LOSS') {
      currentConsecLosses++;
      if (currentConsecLosses > consecutiveLossesMax) consecutiveLossesMax = currentConsecLosses;
    } else {
      currentConsecLosses = 0;
    }

    closedHistory.push({ ...t, pnl, balanceAfter: balance });
    activeTrades.push(t);
  }

  const wins = closedHistory.filter(t => t.pnl > 0);
  const losses = closedHistory.filter(t => t.pnl < 0);
  const total = closedHistory.length;
  const wr = total > 0 ? ((wins.length / total) * 100).toFixed(1) : 0;
  const netUSD = balance - initialBalance;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'Inf';

  return {
    totalTrades: total,
    wins: wins.length,
    losses: losses.length,
    winRate: wr,
    finalBalance: balance,
    netProfitUSD: netUSD,
    netProfitPct: ((netUSD / initialBalance) * 100).toFixed(2),
    maxDrawdownPct: maxDDPct,
    maxDrawdownUSD: maxDDUSD,
    maxDailyDD,
    worstDayStr,
    worstDayPnl,
    consecutiveLossesMax,
    overlapCount,
    sameDirectionOverlap,
    oppositeDirectionOverlap,
    profitFactor: pf
  };
}

async function main() {
  console.log(`========================================================================================================`);
  console.log(`🚨 BANCO DE PRUEBAS DE ESTRÉS: FORZANDO EL FALLO EN EL SISTEMA HÍBRIDO EN ORO (SVP H1 + RSI M15)`);
  console.log(`🎯 Cuenta Fondeo: $10,000 USD | Regla Prop Firm: Violación si Max Daily DD >= 5.0% o Total >= 10.0%`);
  console.log(`========================================================================================================\n`);

  console.log(`📡 Descargando datos M15 y H1 para reconstruir la ejecución simultánea...`);
  const m15Candles = await fetchFullYearData('15m', 1000 * 15 * 60 * 1000);
  const h1Candles = await fetchFullYearData('1h', 1000 * 60 * 60 * 1000);

  // Escenario 1: Baseline Normal (Spread estándar 2.0 pips, Riesgo 0.75% por trade)
  const svpTrades = generateSVPTrades(h1Candles, 0.75, 0.0);
  const rsiTrades = generateRSITrades(m15Candles, 0.75, 0.0);
  const allBaseline = [...svpTrades, ...rsiTrades];

  console.log(`\n📊 Señales generadas en el año:`);
  console.log(`   • Estrategia 1 (SVP PoC Limit H1):   ${svpTrades.length} operaciones`);
  console.log(`   • Estrategia 2 (Connors RSI M15):    ${rsiTrades.length} operaciones`);
  console.log(`   • Total Operaciones Combinadas:     ${allBaseline.length} operaciones (~0.98 ops/día hábil)`);

  const stressTests = [
    {
      name: '1. Línea Base Normal (Riesgo 0.75% | Spread Normal | Sin Kill-Switch)',
      trades: allBaseline,
      risk: 0.75,
      opts: { enforceDailyLossCap: false }
    },
    {
      name: '2. Estrés de Exposición Agresiva (Riesgo 1.00% por trade | Sin Kill-Switch)',
      trades: allBaseline,
      risk: 1.00,
      opts: { enforceDailyLossCap: false }
    },
    {
      name: '3. Estrés de Spread y Deslizamiento x2 (Spread 4.0 pips / -$0.40 por trade)',
      trades: [...generateSVPTrades(h1Candles, 0.75, 2.0), ...generateRSITrades(m15Candles, 0.75, 2.0)],
      risk: 0.75,
      opts: { enforceDailyLossCap: false }
    },
    {
      name: '4. Estrés Extremo de Spread x3 (Spread 6.0 pips / Noticias Volátiles)',
      trades: [...generateSVPTrades(h1Candles, 0.75, 4.0), ...generateRSITrades(m15Candles, 0.75, 4.0)],
      risk: 0.75,
      opts: { enforceDailyLossCap: false }
    },
    {
      name: '5. Con Bloqueo Anti-Hedging (Prohibido abrir BUY y SELL simultáneos)',
      trades: allBaseline,
      risk: 0.75,
      opts: { enforceHedgingBlock: true, enforceDailyLossCap: false }
    },
    {
      name: '6. Con Kill-Switch Prop Firm (Corte automático diario si DD alcanza 2.5%)',
      trades: allBaseline,
      risk: 0.75,
      opts: { enforceHedgingBlock: true, enforceDailyLossCap: true, maxDailyLossPct: 2.5 }
    }
  ];

  console.log('\n| Escenario de Estrés Forense | Trades | Win Rate | Beneficio Neto | Rentabilidad | Max DD Total | Max DD Diario | Peor Día ($) | Racha Pérdidas | Solapamientos | PF |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');

  for (const st of stressTests) {
    const res = runForensicStressSimulation(st.trades, 10000.0, st.risk, st.opts);
    const sign = res.netProfitUSD >= 0 ? '+' : '';
    console.log(`| ${st.name.padEnd(52)} | ${res.totalTrades.toString().padEnd(6)} | ${(res.winRate + '%').padEnd(8)} | ${(sign + '$' + res.netProfitUSD.toFixed(2)).padEnd(14)} | ${(sign + res.netProfitPct + '%').padEnd(12)} | ${(res.maxDrawdownPct.toFixed(2) + '%').padEnd(12)} | ${(res.maxDailyDD.toFixed(2) + '%').padEnd(13)} | ${('-$' + Math.abs(res.worstDayPnl).toFixed(2)).padEnd(12)} | ${res.consecutiveLossesMax.toString().padEnd(14)} | ${res.overlapCount.toString().padEnd(13)} | ${res.profitFactor.padEnd(3)} |`);
  }

  console.log('\n========================================================================================================');
  console.log('🔍 ANÁLISIS DE PUNTOS CRÍTICOS Y TALÓN DE AQUILES DEL SISTEMA HÍBRIDO');
  console.log('========================================================================================================\n');
}

main().catch(console.error);
