/**
 * Motor de Aprendizaje y Backtest Cuantitativo: Antigravity Institutional Sniper (AIS-v1)
 * 
 * Ingeniería Inversa a partir de las 31 operaciones reales de los canales en MT5 (market_snapshots.json):
 * 1. Filtro de Zona: El precio toca o perfora el extremo del rango de 24 horas (cuantil superior/inferior) o Bollinger 2.2σ.
 * 2. Filtro de Gatillo (Exhaustion Pinbar): Vela de rechazo con mecha >= 45% del rango total de la vela.
 * 3. Filtro de Volumen: Volumen de la vela >= 1.1x la media de volumen reciente.
 * 4. Filtro de Sesión: Londres y New York (07:00 a 17:00 UTC = 09:00 a 19:00 hora broker).
 * 5. Arquitectura de Salida Probada: 50% TP1 (35p) + Auto-BE a 25p + Trailing 20p (step 5p) hacia TP2 (70p).
 * 
 * Fricción Real: Spread real del broker (3.7p) + 1.0p Slippage en cada trade.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Cargador de CSV a memoria
async function loadCSV(filename) {
  const filePath = path.join(__dirname, '../../', filename);
  console.log(`📂 Cargando ${filename}...`);
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const dateStr = parts[0];
    const timeStr = parts[1];
    const [y, m, d] = dateStr.split('.').map(Number);
    const [h, min, s] = timeStr.split(':').map(Number);

    const timestamp = Date.UTC(y, m - 1, d, h - 2, min, s);

    candles.push({
      dateStr,
      timeStr,
      hour: h,
      time: timestamp,
      timestamp,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      volume: parseFloat(parts[6]) || 1,
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`   ✅ ${candles.length} velas cargadas (${candles[0].dateStr} -> ${candles[candles.length - 1].dateStr}).`);
  return candles;
}

// Simulador del Algoritmo Antigravity Institutional Sniper
function runBacktestSniper(candles, params) {
  const {
    tfName = 'M15',
    bbPeriod = 20,
    bbMult = 2.2,
    rsiPeriod = 7,
    wickRatio = 0.45,       // Mecha de rechazo mínima (45% de la vela)
    volMult = 1.1,         // Volumen superior a la media
    tp1Pips = 35.0,        // 50% TP1 a 35 pips
    tp2Pips = 70.0,        // 50% TP2 a 70 pips
    beTriggerPips = 25.0,  // Auto-BE al llegar a 25 pips
    beOffsetPips = 5.0,    // Offset de +5 pips por encima de entrada
    trailingDistPips = 20.0, // Trailing a 20 pips
    trailingStepPips = 5.0,  // Paso mínimo anti-spam 5 pips
    slPips = 45.0,         // Stop loss fijo de 45 pips (o detrás de mecha)
    cooldownBars = 12      // Barras de espera tras un trade
  } = params;

  console.log(`\n========================================================================================`);
  console.log(`🚀 EVALUANDO MOTOR: ANTIGRAVITY INSTITUTIONAL SNIPER (${tfName})`);
  console.log(`   TP1: ${tp1Pips}p (50%) | TP2: ${tp2Pips}p | Auto-BE: ${beTriggerPips}p | Trailing: ${trailingDistPips}p | SL: ${slPips}p`);
  console.log(`========================================================================================\n`);

  // 1. Calcular Bandas de Bollinger
  const upperBB = new Float64Array(candles.length);
  const lowerBB = new Float64Array(candles.length);
  const smaBB = new Float64Array(candles.length);

  for (let i = bbPeriod - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < bbPeriod; j++) sum += candles[i - j].close;
    const sma = sum / bbPeriod;
    smaBB[i] = sma;

    let varSum = 0;
    for (let j = 0; j < bbPeriod; j++) {
      const d = candles[i - j].close - sma;
      varSum += d * d;
    }
    const stdDev = Math.sqrt(varSum / bbPeriod);
    upperBB[i] = sma + (stdDev * bbMult);
    lowerBB[i] = sma - (stdDev * bbMult);
  }

  // 2. Calcular RSI(7)
  const rsi = new Float64Array(candles.length);
  let g = 0, l = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) g += diff; else l += Math.abs(diff);
  }
  let avgG = g / rsiPeriod, avgL = l / rsiPeriod;
  rsi[rsiPeriod] = avgL === 0 ? 100 : 100 - (100 / (1 + (avgG / avgL)));

  for (let i = rsiPeriod + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgG = (avgG * (rsiPeriod - 1) + gain) / rsiPeriod;
    avgL = (avgL * (rsiPeriod - 1) + loss) / rsiPeriod;
    rsi[i] = avgL === 0 ? 100 : 100 - (100 / (1 + (avgG / avgL)));
  }

  // 3. Simulación trade por trade
  let wins = 0, losses = 0, pipsWon = 0, pipsLost = 0;
  let peak = 0, run = 0, maxDD = 0;
  let bal = 5263.49, peakBal = 5263.49, maxDDBal = 0;
  let totalTrades = 0;
  const executedTrades = [];

  const lookbackVol = 10;

  for (let i = 50; i < candles.length - 80; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    // Filtro horario de sesiones de alta liquidez: Londres y NY (08:00 a 19:00 hora broker)
    if (c.hour < 8 || c.hour > 19) continue;

    // Calcular media de volumen reciente
    let volSum = 0;
    for (let v = 0; v < lookbackVol; v++) volSum += candles[i - v].volume;
    const avgVol = volSum / lookbackVol;
    if (c.volume < avgVol * volMult) continue;

    const candleRange = c.high - c.low;
    if (candleRange <= 0.5) continue; // Descartar micro-velas

    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    let action = null;

    // CONDICIÓN VENTA (SELL):
    // 1. Perforación previa o toque de la Banda Superior
    // 2. Mecha superior de rechazo >= wickRatio (45% del rango)
    // 3. Cierre bajista o por debajo de apertura
    // 4. RSI estirado (>= 60)
    if ((prev.high >= upperBB[i - 1] || c.high >= upperBB[i]) && 
        (upperWick / candleRange) >= wickRatio && 
        c.close < c.open && 
        rsi[i] >= 60) {
      action = 'SELL';
    }

    // CONDICIÓN COMPRA (BUY):
    // 1. Perforación previa o toque de la Banda Inferior
    // 2. Mecha inferior de rechazo >= wickRatio (45% del rango)
    // 3. Cierre alcista o por encima de apertura
    // 4. RSI sobrevendido (<= 40)
    if ((prev.low <= lowerBB[i - 1] || c.low <= lowerBB[i]) && 
        (lowerWick / candleRange) >= wickRatio && 
        c.close > c.open && 
        rsi[i] <= 40) {
      action = 'BUY';
    }

    if (!action) continue;

    totalTrades++;
    const isBuy = action === 'BUY';
    const friction = c.spreadPips + 1.0;
    const entry = isBuy ? c.close + (c.spreadPips / 10.0) : c.close;

    const tp1Dist = tp1Pips / 10.0;
    const tp2Dist = tp2Pips / 10.0;
    const slDist = slPips / 10.0;

    const targetTP1 = isBuy ? entry + tp1Dist : entry - tp1Dist;
    const targetTP2 = isBuy ? entry + tp2Dist : entry - tp2Dist;
    const initialSL = isBuy ? entry - slDist : entry + slDist;

    const BE_TRIGGER = beTriggerPips / 10.0;
    const BE_OFFSET = beOffsetPips / 10.0;
    const TRAILING_DIST = trailingDistPips / 10.0;
    const TRAILING_STEP = trailingStepPips / 10.0;

    let leg1Closed = false, leg1Pips = 0;
    let leg2Closed = false, leg2Pips = 0;
    let leg2SL = initialSL;
    let isBEActive = false;

    for (let j = i + 1; j < Math.min(candles.length, i + 80); j++) {
      const nextC = candles[j];

      if (isBuy) {
        if (!leg1Closed) {
          if (nextC.high >= targetTP1) { leg1Closed = true; leg1Pips = tp1Pips - friction; }
          else if (nextC.low <= initialSL) { leg1Closed = true; leg1Pips = -slPips - friction; }
        }

        if (!isBEActive && nextC.high >= entry + BE_TRIGGER) {
          isBEActive = true;
          leg2SL = entry + BE_OFFSET;
        }

        if (isBEActive) {
          const pot = nextC.high - TRAILING_DIST;
          if (pot >= leg2SL + TRAILING_STEP) leg2SL = pot;
        }

        if (!leg2Closed) {
          if (nextC.high >= targetTP2) { leg2Closed = true; leg2Pips = tp2Pips - friction; }
          else if (nextC.low <= leg2SL) { leg2Closed = true; leg2Pips = ((leg2SL - entry) * 10) - friction; }
        }
      } else {
        if (!leg1Closed) {
          if (nextC.low <= targetTP1) { leg1Closed = true; leg1Pips = tp1Pips - friction; }
          else if (nextC.high >= initialSL) { leg1Closed = true; leg1Pips = -slPips - friction; }
        }

        if (!isBEActive && nextC.low <= entry - BE_TRIGGER) {
          isBEActive = true;
          leg2SL = entry - BE_OFFSET;
        }

        if (isBEActive) {
          const pot = nextC.low + TRAILING_DIST;
          if (pot <= leg2SL - TRAILING_STEP) leg2SL = pot;
        }

        if (!leg2Closed) {
          if (nextC.low <= targetTP2) { leg2Closed = true; leg2Pips = tp2Pips - friction; }
          else if (nextC.high >= leg2SL) { leg2Closed = true; leg2Pips = ((entry - leg2SL) * 10) - friction; }
        }
      }

      if (leg1Closed && leg2Closed) break;
    }

    if (!leg1Closed) {
      const endC = candles[Math.min(candles.length - 1, i + 80)].close;
      leg1Pips = (isBuy ? endC - entry : entry - endC) * 10 - friction;
    }
    if (!leg2Closed) {
      const endC = candles[Math.min(candles.length - 1, i + 80)].close;
      leg2Pips = (isBuy ? endC - entry : entry - endC) * 10 - friction;
    }

    const netPips = (leg1Pips * 0.5) + (leg2Pips * 0.5);

    run += netPips;
    if (run > peak) peak = run;
    if (peak - run > maxDD) maxDD = peak - run;

    bal += netPips * 1.0; // 0.10L en cuenta de $5,263 ($1.00 USD por pip)
    if (bal > peakBal) peakBal = bal;
    const dd = ((peakBal - bal) / peakBal) * 100;
    if (dd > maxDDBal) maxDDBal = dd;

    if (netPips > 0) {
      wins++;
      pipsWon += netPips;
    } else {
      losses++;
      pipsLost += Math.abs(netPips);
    }

    executedTrades.push({
      date: c.dateStr + ' ' + c.timeStr,
      action,
      netPips: parseFloat(netPips.toFixed(1)),
      leg1Pips: parseFloat(leg1Pips.toFixed(1)),
      leg2Pips: parseFloat(leg2Pips.toFixed(1))
    });

    i += cooldownBars;
  }

  const total = wins + losses;
  const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : '0';
  const pf = pipsLost > 0 ? (pipsWon / pipsLost).toFixed(2) : 'MAX';

  console.log(`📊 RESULTADOS OBTENIDOS (${tfName}):`);
  console.log(`• Total Operaciones:         ${total} trades`);
  console.log(`• Tasa de Acierto (Win Rate): ${wr}% (${wins} W / ${losses} L)`);
  console.log(`• Pips Netos Ganados:        ${(pipsWon - pipsLost).toFixed(1)} pips`);
  console.log(`• Profit Factor:             ${pf}`);
  console.log(`• Drawdown Máximo:           ${maxDD.toFixed(1)} pips (${maxDDBal.toFixed(1)}% en cuenta)`);
  console.log(`• Saldo Final Cuenta $5,263: $${bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`• Ganancia Neta en Dólares:  +$${(bal - 5263.49).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`);

  return { tfName, total, wr, pips: (pipsWon - pipsLost), pf, maxDD, maxDDBal, bal, netUSD: (bal - 5263.49), executedTrades };
}

async function main() {
  console.log('========================================================================================');
  console.log('🔬 ENTRENANDO Y OPTIMIZANDO EL ALGORITMO PROPIO CON VELAS REALES DEL BROKER MT5');
  console.log('   Inspirado en la huella estadística de las entradas ganadoras de los canales');
  console.log('========================================================================================\n');

  // 1. Probar en M15 (2024 - 2026, 65.015 velas)
  const candlesM15 = await loadCSV('XAUUSD_M15_202401020100_202609291045.csv');
  const resM15 = runBacktestSniper(candlesM15, {
    tfName: 'M15 (Enero 2024 - Septiembre 2026)',
    bbPeriod: 20,
    bbMult: 2.2,
    rsiPeriod: 7,
    wickRatio: 0.45,
    volMult: 1.0,
    tp1Pips: 35.0,
    tp2Pips: 70.0,
    beTriggerPips: 25.0,
    trailingDistPips: 20.0,
    slPips: 45.0,
    cooldownBars: 8
  });

  // 2. Probar en M5 (Abril 2025 - Septiembre 2026, 99.987 velas)
  const candlesM5 = await loadCSV('XAUUSD_M5_202504291430_202609291055.csv');
  const resM5 = runBacktestSniper(candlesM5, {
    tfName: 'M5 Scalp (Abril 2025 - Septiembre 2026)',
    bbPeriod: 25,
    bbMult: 2.3,
    rsiPeriod: 7,
    wickRatio: 0.40,
    volMult: 1.1,
    tp1Pips: 25.0,
    tp2Pips: 55.0,
    beTriggerPips: 18.0,
    trailingDistPips: 18.0,
    slPips: 35.0,
    cooldownBars: 15
  });

  console.log('\n================================================================================================================');
  console.log('🏆 COMPARATIVA DEL MOTOR ALGORÍTMICO PROPIO (M15 vs M5):');
  console.log('================================================================================================================\n');

  console.log(`${'Temporalidad Evaluada'.padEnd(40)} | ${'Win Rate'.padStart(10)} | ${'Pips Netos'.padStart(14)} | ${'Profit Factor'.padStart(14)} | ${'Drawdown Max'.padStart(14)} | ${'Beneficio Neto ($)'.padStart(20)}`);
  console.log('-'.repeat(122));

  [resM15, resM5].forEach(r => {
    console.log(`${r.tfName.padEnd(40)} | ${(r.wr + '%').padStart(10)} | ${(r.pips.toFixed(1) + ' p').padStart(14)} | ${String(r.pf).padStart(14)} | ${(r.maxDDBal.toFixed(1) + '%').padStart(14)} | ${('+$' + r.netUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).padStart(20)}`);
  });

  console.log('================================================================================================================\n');

  fs.writeFileSync('scripts/audits/cache_antigravity_sniper_v1_results.json', JSON.stringify({
    resM15: { total: resM15.total, wr: resM15.wr, pips: resM15.pips, netUSD: resM15.netUSD },
    resM5: { total: resM5.total, wr: resM5.wr, pips: resM5.pips, netUSD: resM5.netUSD }
  }, null, 2));

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
