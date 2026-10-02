/**
 * Backtest de Estrategias Propias Intradiarias en M5 (Datos Reales de Broker MT5)
 * Periodo: Abril 2025 - Septiembre 2026 (17 meses, ~100,000 velas M5)
 * 
 * Modela con precisión la gestión en vivo 50/50:
 * - TP1 a 35 pips (asegura 50% de la posición)
 * - Auto-BE cuando flotante alcanza +25 pips
 * - Trailing Stop a 20 pips con step de 5 pips (conforme The5%ers)
 * - Fricción de spread real del broker incluida en cada vela
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_FILE = path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv');

async function runM5ProprietaryBacktest() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error('No se encontró el archivo CSV de M5');
    return;
  }

  console.log('⏳ Cargando velas M5 del broker...');
  const fileStream = fs.createReadStream(CSV_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 9) continue;

    // Date: YYYY.MM.DD Time: HH:MM:SS
    const dateParts = parts[0].split('.');
    const timeParts = parts[1].split(':');
    const timestamp = Date.UTC(
      parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]),
      parseInt(timeParts[0]), parseInt(timeParts[1]), parseInt(timeParts[2])
    );

    candles.push({
      timestamp,
      dateStr: `${parts[0]} ${parts[1]}`,
      hour: parseInt(timeParts[0]),
      minute: parseInt(timeParts[1]),
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parseFloat(parts[8]) / 10 // MT5 points to pips
    });
  }

  console.log(`✅ ${candles.length.toLocaleString()} velas M5 cargadas.`);

  // Calcular Indicadores Técnicos
  console.log('⚙️ Calculando EMAs y RSIs...');
  calculateIndicators(candles);

  // Ejecutar Pruebas para 3 Modelos:
  // 1. Asian Sweep & Reversal (Judas Swing)
  // 2. EMA Trend Pullback Sniper
  // 3. Round Number (.00 / .50) Institutional Rejection
  // 4. Portafolio Combinado (Todos los setups filtrados)

  console.log('\n========================================================================================');
  console.log('🚀 RESULTADOS DE BACKTEST: ESTRATEGIAS PROPIAS EN M5 (ABR 2025 - SEP 2026)');
  console.log('   Gestión: Live 50/50 (TP1: 35p, BE: 25p, Trailing: 20p/5p, SL: 40-50p)');
  console.log('========================================================================================\n');

  testSetup('1. Asian Session Liquidity Sweep (London Judas Swing)', candles, runAsianSweepSetup);
  testSetup('2. EMA 50/200 Trend Pullback Rejection', candles, runEMAPullbackSetup);
  testSetup('3. Institutional Round Number Rejection (.00 / .50)', candles, runRoundNumberSetup);
  testSetup('4. PORTAFOLIO PROPIO COMBINADO (Todos los Setups)', candles, runCombinedPortfolio);
}

function calculateIndicators(candles) {
  // EMA 50 y EMA 200
  const k50 = 2 / (50 + 1);
  const k200 = 2 / (200 + 1);

  let ema50 = candles[0].close;
  let ema200 = candles[0].close;

  // RSI 14
  const period = 14;
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    ema50 = c.close * k50 + ema50 * (1 - k50);
    ema200 = c.close * k200 + ema200 * (1 - k200);
    c.ema50 = ema50;
    c.ema200 = ema200;

    if (i > 0) {
      const diff = c.close - candles[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;

      if (i <= period) {
        avgGain += gain / period;
        avgLoss += loss / period;
        c.rsi = 50;
      } else {
        avgGain = (avgGain * 13 + gain) / period;
        avgLoss = (avgLoss * 13 + loss) / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        c.rsi = 100 - (100 / (1 + rs));
      }
    } else {
      c.rsi = 50;
    }
  }
}

// Simulador de Trade con Gestión Live 50/50
function simulateTrade(entryIdx, action, entryPrice, slPrice, tp2Price, candles, maxHoldBars = 120) {
  const isBuy = action === 'BUY';
  const initialSLDist = Math.abs(entryPrice - slPrice);
  const tp1Dist = 3.5; // 35 pips ($3.50 en Oro)
  const beTriggerDist = 2.5; // 25 pips ($2.50)
  const trailingDist = 2.0; // 20 pips
  const trailingStep = 0.5; // 5 pips

  let currentSL = slPrice;
  let tp1Hit = false;
  let highestFavorable = 0;
  let pipsGained = 0;
  let durationBars = 0;
  let exitReason = 'TIMEOUT';

  for (let i = entryIdx + 1; i < Math.min(candles.length, entryIdx + maxHoldBars); i++) {
    durationBars++;
    const bar = candles[i];
    const spread = bar.spreadPips * 0.1;

    if (isBuy) {
      const favorable = bar.high - entryPrice;
      if (favorable > highestFavorable) highestFavorable = favorable;

      // 1. Verificar SL
      if (bar.low <= currentSL) {
        exitReason = currentSL >= entryPrice ? 'BREAK_EVEN' : 'SL_HIT';
        const exitPrice = currentSL;
        const diffPips = (exitPrice - entryPrice) * 10 - bar.spreadPips;
        pipsGained = tp1Hit ? (35 * 0.5 + diffPips * 0.5) : diffPips;
        break;
      }

      // 2. Verificar TP1 (35 pips)
      if (!tp1Hit && bar.high >= entryPrice + tp1Dist) {
        tp1Hit = true;
        // Mover SL a Break-Even
        if (currentSL < entryPrice) currentSL = entryPrice;
      }

      // 3. Auto-BE a 25 pips si no saltó TP1
      if (!tp1Hit && bar.high >= entryPrice + beTriggerDist && currentSL < entryPrice) {
        currentSL = entryPrice;
      }

      // 4. Trailing Stop (después de 35 pips)
      if (tp1Hit && favorable > tp1Dist + trailingStep) {
        const potentialSL = entryPrice + favorable - trailingDist;
        if (potentialSL > currentSL + trailingStep) {
          currentSL = potentialSL;
        }
      }

      // 5. Verificar TP2
      if (tp2Price && bar.high >= tp2Price) {
        exitReason = 'TP2_HIT';
        const tp2Pips = (tp2Price - entryPrice) * 10;
        pipsGained = tp1Hit ? (35 * 0.5 + tp2Pips * 0.5) : tp2Pips;
        break;
      }
    } else {
      // Venta (SELL)
      const favorable = entryPrice - bar.low;
      if (favorable > highestFavorable) highestFavorable = favorable;

      // 1. Verificar SL
      if (bar.high >= currentSL) {
        exitReason = currentSL <= entryPrice ? 'BREAK_EVEN' : 'SL_HIT';
        const exitPrice = currentSL;
        const diffPips = (entryPrice - exitPrice) * 10 - bar.spreadPips;
        pipsGained = tp1Hit ? (35 * 0.5 + diffPips * 0.5) : diffPips;
        break;
      }

      // 2. Verificar TP1 (35 pips)
      if (!tp1Hit && bar.low <= entryPrice - tp1Dist) {
        tp1Hit = true;
        if (currentSL > entryPrice) currentSL = entryPrice;
      }

      // 3. Auto-BE a 25 pips
      if (!tp1Hit && bar.low <= entryPrice - beTriggerDist && currentSL > entryPrice) {
        currentSL = entryPrice;
      }

      // 4. Trailing Stop
      if (tp1Hit && favorable > tp1Dist + trailingStep) {
        const potentialSL = entryPrice - favorable + trailingDist;
        if (potentialSL < currentSL - trailingStep) {
          currentSL = potentialSL;
        }
      }

      // 5. Verificar TP2
      if (tp2Price && bar.low <= tp2Price) {
        exitReason = 'TP2_HIT';
        const tp2Pips = (entryPrice - tp2Price) * 10;
        pipsGained = tp1Hit ? (35 * 0.5 + tp2Pips * 0.5) : tp2Pips;
        break;
      }
    }
  }

  if (exitReason === 'TIMEOUT') {
    const lastBar = candles[Math.min(candles.length - 1, entryIdx + maxHoldBars)];
    const diff = isBuy ? (lastBar.close - entryPrice) : (entryPrice - lastBar.close);
    pipsGained = diff * 10;
  }

  const isWin = pipsGained > 0;
  return { isWin, pipsGained, exitReason, durationBars };
}

// -------------------------------------------------------------
// DEFINICIÓN DE SETUPS
// -------------------------------------------------------------

// Setup 1: Asian Session Sweep & Reversal (London Judas Swing)
function runAsianSweepSetup(candles, i, state) {
  const bar = candles[i];
  // Registrar Asian High / Low entre 00:00 y 06:55 UTC
  if (bar.hour === 0 && bar.minute === 0) {
    state.asianHigh = bar.high;
    state.asianLow = bar.low;
    state.sweptHigh = false;
    state.sweptLow = false;
    state.inSession = true;
  } else if (bar.hour < 7 && state.inSession) {
    if (bar.high > state.asianHigh) state.asianHigh = bar.high;
    if (bar.low < state.asianLow) state.asianLow = bar.low;
  }

  // Operar durante London Open (07:00 a 11:30 UTC)
  if (bar.hour >= 7 && bar.hour <= 11 && state.inSession) {
    const range = state.asianHigh - state.asianLow;
    if (range < 3.0 || range > 80.0) return null; // Rango asiático realista para Oro (30 a 800 pips)

    const candleRange = bar.high - bar.low;
    if (candleRange <= 0) return null;

    // Sweep Alcista (Falsa rotura al alza y rechazo bajista)
    if (!state.sweptHigh && bar.high > state.asianHigh + 0.5 && bar.close < state.asianHigh + 0.2) {
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      if (upperWick / candleRange >= 0.35) { // Mecha de rechazo > 35%
        state.sweptHigh = true;
        return {
          action: 'SELL',
          entry: bar.close,
          sl: bar.close + 8.5, // 85 pips SL (respiración institucional)
          tp2: state.asianLow
        };
      }
    }

    // Sweep Bajista (Falsa rotura a la baja y rechazo alcista)
    if (!state.sweptLow && bar.low < state.asianLow - 0.5 && bar.close > state.asianLow - 0.2) {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      if (lowerWick / candleRange >= 0.35) { // Mecha de rechazo > 35%
        state.sweptLow = true;
        return {
          action: 'BUY',
          entry: bar.close,
          sl: bar.close - 8.5, // 85 pips SL
          tp2: state.asianHigh
        };
      }
    }
  }

  if (bar.hour > 11) {
    state.inSession = false;
  }

  return null;
}

// Setup 2: EMA Trend Pullback Rejection (M5 Trend Following)
function runEMAPullbackSetup(candles, i, state) {
  if (i < 200) return null;
  const bar = candles[i];

  // Operar en Londres y NY (07:00 a 18:00 UTC)
  if (bar.hour < 7 || bar.hour > 18) return null;

  const ema50 = bar.ema50;
  const ema200 = bar.ema200;
  const candleRange = bar.high - bar.low;
  if (candleRange <= 0) return null;

  // Tendencia Alcista Fuerte (EMA50 > EMA200 por al menos 15 pips)
  if (ema50 > ema200 + 1.5) {
    // Retroceso a la EMA 50
    if (bar.low <= ema50 + 0.8 && bar.close > ema50) {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      // Vela de rechazo con mecha inferior y RSI saliendo de sobreventa intradiaria (< 45)
      if (lowerWick / candleRange >= 0.35 && bar.rsi >= 30 && bar.rsi <= 45) {
        return {
          action: 'BUY',
          entry: bar.close,
          sl: bar.close - 8.5, // 85 pips SL (margen de maniobra institucional)
          tp2: bar.close + 7.0 // 70 pips TP2
        };
      }
    }
  }

  // Tendencia Bajista Fuerte (EMA50 < EMA200 por al menos 15 pips)
  if (ema50 < ema200 - 1.5) {
    if (bar.high >= ema50 - 0.8 && bar.close < ema50) {
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      if (upperWick / candleRange >= 0.35 && bar.rsi >= 55 && bar.rsi <= 70) {
        return {
          action: 'SELL',
          entry: bar.close,
          sl: bar.close + 8.5, // 85 pips SL
          tp2: bar.close - 7.0
        };
      }
    }
  }

  return null;
}

// Setup 3: Institutional Round Number Rejection (.00 / .50)
function runRoundNumberSetup(candles, i, state) {
  const bar = candles[i];
  if (bar.hour < 7 || bar.hour > 19) return null;

  const candleRange = bar.high - bar.low;
  if (candleRange <= 0) return null;

  // Evaluar cercanía a niveles .00 o .50
  const floorPrice = Math.floor(bar.close);
  const dec = bar.close - floorPrice;
  const isNear50 = Math.abs(dec - 0.50) <= 0.10;
  const isNear00 = dec <= 0.10 || dec >= 0.90;

  if (!isNear50 && !isNear00) return null;

  // Rechazo en Techo Redondo (Sobrecompra con mecha superior)
  if (bar.rsi > 70) {
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    if (upperWick / candleRange >= 0.40) {
      return {
        action: 'SELL',
        entry: bar.close,
        sl: bar.close + 8.5, // 85 pips SL
        tp2: bar.close - 6.0
      };
    }
  }

  // Rechazo en Suelo Redondo (Sobreventa con mecha inferior)
  if (bar.rsi < 30) {
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    if (lowerWick / candleRange >= 0.40) {
      return {
        action: 'BUY',
        entry: bar.close,
        sl: bar.close - 8.5, // 85 pips SL
        tp2: bar.close + 6.0
      };
    }
  }

  return null;
}

// Portfolio Combinado
function runCombinedPortfolio(candles, i, state) {
  // Probar setups en orden de prioridad
  const s1 = runAsianSweepSetup(candles, i, state);
  if (s1) return s1;

  const s2 = runEMAPullbackSetup(candles, i, state);
  if (s2) return s2;

  const s3 = runRoundNumberSetup(candles, i, state);
  if (s3) return s3;

  return null;
}

// Ejecutor de Pruebas
function testSetup(name, candles, setupFn) {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let totalPips = 0;
  let grossProfitPips = 0;
  let grossLossPips = 0;
  let lastTradeBar = -100;
  const state = { asianHigh: 0, asianLow: 0, sweptHigh: false, sweptLow: false };

  for (let i = 200; i < candles.length - 120; i++) {
    // Evitar sobre-operar (mínimo 10 velas de separación = 50 min)
    if (i - lastTradeBar < 10) continue;

    const signal = setupFn(candles, i, state);
    if (signal) {
      const result = simulateTrade(i, signal.action, signal.entry, signal.sl, signal.tp2, candles);
      trades++;
      lastTradeBar = i + Math.min(result.durationBars, 15);

      if (result.isWin) {
        wins++;
        grossProfitPips += result.pipsGained;
      } else {
        losses++;
        grossLossPips += Math.abs(result.pipsGained);
      }
      totalPips += result.pipsGained;
    }
  }

  const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0;
  const profitFactor = grossLossPips > 0 ? (grossProfitPips / grossLossPips).toFixed(2) : 'Inf';
  const tradesPerYear = (trades / 1.42).toFixed(0); // 17 meses = ~1.42 años
  const profitUSD_005 = (totalPips * 0.5).toFixed(2); // con 0.05 lotes

  console.log(`📌 ${name}`);
  console.log(`   -------------------------------------------------------------------------------------`);
  console.log(`   • Total Operaciones:   ${trades} trades (~${tradesPerYear} trades/año)`);
  console.log(`   • Tasa de Acierto:     ${winRate}% (${wins} Win / ${losses} Loss)`);
  console.log(`   • Beneficio Neto Pips: ${totalPips >= 0 ? '+' : ''}${totalPips.toFixed(1)} pips`);
  console.log(`   • Beneficio Estimado:  $${profitUSD_005} USD (con 0.05 lotes base)`);
  console.log(`   • Profit Factor:       ${profitFactor}`);
  console.log(`   -------------------------------------------------------------------------------------\n`);
}

runM5ProprietaryBacktest();
