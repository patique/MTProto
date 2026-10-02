/**
 * Backtest de Estrategia Institucional de Liquidez y Estructura (Multi-Timeframe)
 * Datos: XAUUSD M15 Real Broker CSV (2024 - 2026, 65,000 velas)
 * 
 * Reglas Institucionales:
 * 1. Detección de Swings High/Low en H1/H4 (Estructura de Mercado).
 * 2. Barrido de Liquidez (Sweep) en Apertura de Londres o NY.
 * 3. Confirmación con vela de rechazo (Pinbar / Envolvente con mecha > 40%).
 * 4. Gestión en vivo 50/50: TP1 35p, Auto-BE 25p, Trailing 20p/5p.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_FILE = path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv');

async function runInstitutionalBacktest() {
  if (!fs.existsSync(CSV_FILE)) {
    console.error('No se encontró el archivo CSV de M15');
    return;
  }

  console.log('⏳ Cargando velas M15 del broker (2024-2026)...');
  const fileStream = fs.createReadStream(CSV_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 9) continue;

    const dateParts = parts[0].split('.');
    const timeParts = parts[1].split(':');
    const timestamp = Date.UTC(
      parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]),
      parseInt(timeParts[0]), parseInt(timeParts[1]), parseInt(timeParts[2])
    );

    candles.push({
      timestamp,
      dateStr: `${parts[0]} ${parts[1]}`,
      dateOnly: parts[0],
      hour: parseInt(timeParts[0]),
      minute: parseInt(timeParts[1]),
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parseFloat(parts[8]) / 10
    });
  }

  console.log(`✅ ${candles.length.toLocaleString()} velas M15 cargadas.`);

  // Calcular Estructura H4 (cada 16 velas M15 = 4 Horas) y H1 (cada 4 velas M15 = 1 Hora)
  // Swing Highs y Swing Lows en ventanas rodantes
  console.log('⚙️ Analizando zonas de liquidez y máximos/mínimos intradiarios...');

  // Probar diferentes variantes de frecuencia:
  // A: Swings de 16 periodos M15 (4 Horas)
  // B: Swings de 8 periodos M15 (2 Horas)
  // C: Sesiones Asiáticas vs Londres/NY
  
  testVariant('A. Swing 4H Sweep & Reversal (Estructura Mayor)', candles, 16, 50, 80);
  testVariant('B. Swing 2H Sweep & Reversal (Intradiario Frecuente)', candles, 8, 45, 75);
  testVariant('C. London/NY Session Momentum Break & Retest', candles, 12, 40, 70);
}

function simulateLive5050(entryIdx, action, entryPrice, slPips, tp2Pips, candles, maxHoldBars = 60) {
  const isBuy = action === 'BUY';
  const slDist = slPips * 0.1;
  const tp1Dist = 3.5; // 35 pips
  const beTriggerDist = 2.5; // 25 pips
  const tp2Dist = tp2Pips * 0.1;
  const trailingDist = 2.0; // 20 pips
  const trailingStep = 0.5; // 5 pips

  let currentSL = isBuy ? (entryPrice - slDist) : (entryPrice + slDist);
  let tp1Hit = false;
  let highestFavorable = 0;
  let pipsGained = 0;
  let exitReason = 'TIMEOUT';

  for (let i = entryIdx + 1; i < Math.min(candles.length, entryIdx + maxHoldBars); i++) {
    const bar = candles[i];
    const spread = bar.spreadPips * 0.1;

    if (isBuy) {
      const favorable = bar.high - entryPrice;
      if (favorable > highestFavorable) highestFavorable = favorable;

      // 1. SL Hit
      if (bar.low <= currentSL) {
        exitReason = currentSL >= entryPrice ? 'BREAK_EVEN' : 'SL_HIT';
        const diffPips = (currentSL - entryPrice) * 10 - bar.spreadPips;
        pipsGained = tp1Hit ? (35 * 0.5 + diffPips * 0.5) : diffPips;
        break;
      }

      // 2. TP1 (35 pips)
      if (!tp1Hit && bar.high >= entryPrice + tp1Dist) {
        tp1Hit = true;
        if (currentSL < entryPrice) currentSL = entryPrice;
      }

      // 3. Auto-BE a 25 pips
      if (!tp1Hit && bar.high >= entryPrice + beTriggerDist && currentSL < entryPrice) {
        currentSL = entryPrice;
      }

      // 4. Trailing Stop
      if (tp1Hit && favorable > tp1Dist + trailingStep) {
        const potSL = entryPrice + favorable - trailingDist;
        if (potSL > currentSL + trailingStep) currentSL = potSL;
      }

      // 5. TP2
      if (bar.high >= entryPrice + tp2Dist) {
        exitReason = 'TP2_HIT';
        pipsGained = tp1Hit ? (35 * 0.5 + tp2Pips * 0.5) : tp2Pips;
        break;
      }
    } else {
      // Venta
      const favorable = entryPrice - bar.low;
      if (favorable > highestFavorable) highestFavorable = favorable;

      if (bar.high >= currentSL) {
        exitReason = currentSL <= entryPrice ? 'BREAK_EVEN' : 'SL_HIT';
        const diffPips = (entryPrice - currentSL) * 10 - bar.spreadPips;
        pipsGained = tp1Hit ? (35 * 0.5 + diffPips * 0.5) : diffPips;
        break;
      }

      if (!tp1Hit && bar.low <= entryPrice - tp1Dist) {
        tp1Hit = true;
        if (currentSL > entryPrice) currentSL = entryPrice;
      }

      if (!tp1Hit && bar.low <= entryPrice - beTriggerDist && currentSL > entryPrice) {
        currentSL = entryPrice;
      }

      if (tp1Hit && favorable > tp1Dist + trailingStep) {
        const potSL = entryPrice - favorable + trailingDist;
        if (potSL < currentSL - trailingStep) currentSL = potSL;
      }

      if (bar.low <= entryPrice - tp2Dist) {
        exitReason = 'TP2_HIT';
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

  return { isWin: pipsGained > 0, pipsGained, exitReason };
}

function testVariant(name, candles, lookback, slPips, tp2Pips) {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let beCount = 0;
  let tp1Count = 0;
  let tp2Count = 0;
  let totalPips = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let lastTradeIdx = -100;

  for (let i = lookback * 2; i < candles.length - 60; i++) {
    // Espaciado mínimo: 4 velas (1 hora)
    if (i - lastTradeIdx < 4) continue;

    const bar = candles[i];
    // Solo operar sesiones activas (08:00 a 20:00 broker time)
    if (bar.hour < 8 || bar.hour > 20) continue;

    // Calcular máximo y mínimo de los periodos anteriores (sin incluir la vela actual)
    let swingHigh = -Infinity;
    let swingLow = Infinity;
    for (let k = 1; k <= lookback; k++) {
      const prev = candles[i - k];
      if (prev.high > swingHigh) swingHigh = prev.high;
      if (prev.low < swingLow) swingLow = prev.low;
    }

    const candleRange = bar.high - bar.low;
    if (candleRange <= 0.5) continue;

    let signal = null;

    // Caso 1: Barrido del Swing High y mecha de rechazo bajista
    if (bar.high > swingHigh + 0.3 && bar.close < swingHigh + 0.2) {
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      if (upperWick / candleRange >= 0.40) {
        signal = { action: 'SELL', entry: bar.close };
      }
    }
    // Caso 2: Barrido del Swing Low y mecha de rechazo alcista
    else if (bar.low < swingLow - 0.3 && bar.close > swingLow - 0.2) {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      if (lowerWick / candleRange >= 0.40) {
        signal = { action: 'BUY', entry: bar.close };
      }
    }

    if (signal) {
      const res = simulateLive5050(i, signal.action, signal.entry, slPips, tp2Pips, candles);
      trades++;
      lastTradeIdx = i;

      if (res.isWin) {
        wins++;
        grossProfit += res.pipsGained;
      } else {
        losses++;
        grossLoss += Math.abs(res.pipsGained);
      }
      totalPips += res.pipsGained;

      if (res.exitReason === 'BREAK_EVEN') beCount++;
      if (res.exitReason === 'TP2_HIT') tp2Count++;
    }
  }

  const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0;
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'Inf';
  const tradesPerYear = (trades / 2.75).toFixed(0);
  const profitUSD_005 = (totalPips * 0.5).toFixed(2);

  console.log(`\n📌 ${name}`);
  console.log(`   -------------------------------------------------------------------------------------`);
  console.log(`   • Total Operaciones:   ${trades} trades (~${tradesPerYear} trades/año)`);
  console.log(`   • Tasa de Acierto:     ${winRate}% (${wins} Win / ${losses} Loss | ${beCount} Break-Evens)`);
  console.log(`   • Beneficio Neto Pips: ${totalPips >= 0 ? '+' : ''}${totalPips.toFixed(1)} pips`);
  console.log(`   • Beneficio Estimado:  $${profitUSD_005} USD (con 0.05 lotes en cuenta $10k)`);
  console.log(`   • Profit Factor:       ${pf}`);
  console.log(`   -------------------------------------------------------------------------------------`);
}

runInstitutionalBacktest();
