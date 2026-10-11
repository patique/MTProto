/**
 * Laboratorio Cuantitativo: Estrategia NY Open Daily Range Sniper (XAUUSD)
 * 
 * Reglas de la Estrategia:
 * 1. Marcar Alto (PDH) y Mínimo (PDL) del día anterior.
 * 2. Identificar la 1ª vela M15 tras la apertura de NY (testea 15:30 y 16:30 server time).
 * 3. Si la 1ª vela M15 es Alcista (Close > Open): Sesgo BUY hacia PDH.
 *    Si la 1ª vela M15 es Bajista (Close < Open): Sesgo SELL hacia PDL.
 * 4. Retesteo: Esperar retroceso al 50% / Open de la 1ª vela M15.
 * 5. Rechazo y Entrada a mercado.
 * 6. Test de SL:
 *    - SL en el extremo de la 1ª vela M15 (+ buffer).
 *    - SL Fijo: 20 pips, 30 pips, 40 pips, 50 pips.
 * 7. TP hacia PDH / PDL (y alternativa con ratio fijo 1:2.0 R:R).
 */

const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'XAUUSD_M15_202001020600_202610011115.csv');
console.log('📂 Cargando histórico M15 de XAUUSD...');

const content = fs.readFileSync(csvPath, 'utf8');
const lines = content.trim().split(/\r?\n/);
console.log(`📊 Total de barras M15 cargadas: ${lines.length - 1}`);

// 1. Parsear barras M15 y agrupar por Día
const daysMap = new Map(); // "YYYY.MM.DD" -> Array de barras M15

for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split('\t');
  if (parts.length >= 6) {
    const dateStr = parts[0];
    const timeStr = parts[1];
    const open = parseFloat(parts[2]);
    const high = parseFloat(parts[3]);
    const low = parseFloat(parts[4]);
    const close = parseFloat(parts[5]);
    const spread = parseFloat(parts[8] || '20') / 10.0; // en pips

    if (!daysMap.has(dateStr)) {
      daysMap.set(dateStr, []);
    }
    daysMap.get(dateStr).push({
      dateStr,
      timeStr,
      open,
      high,
      low,
      close,
      spread
    });
  }
}

const dates = Array.from(daysMap.keys()).sort();
console.log(`📅 Días de negociación disponibles: ${dates.length} (Desde ${dates[0]} hasta ${dates[dates.length - 1]})\n`);

// Función de simulación parametrizada
function runSimulation(options) {
  const {
    nyOpenTime = '15:30:00', // Hora server de la 1ª vela M15
    slMode = 'CANDLE_EXTREME', // 'CANDLE_EXTREME' | 'FIXED_PIPS'
    fixedSlPips = 30,
    tpMode = 'PREVIOUS_DAY_LEVEL', // 'PREVIOUS_DAY_LEVEL' | 'FIXED_RR'
    fixedRR = 2.0,
    minTargetPips = 20, // Descartar si el nivel PDH/PDL está a menos de 20 pips
    retestDepth = 0.50, // 50% de retroceso en la primera vela M15
    filterPremiumDiscount = false // ICT: Buy solo si debajo del 50% del rango anterior, Sell solo si arriba
  } = options;

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let netPips = 0;
  let grossWinPips = 0;
  let grossLossPips = 0;
  let skippedNoRange = 0;
  let skippedNoRetest = 0;
  let skippedAlreadyHit = 0;
  let skippedFilter = 0;

  for (let d = 1; d < dates.length; d++) {
    const prevDate = dates[d - 1];
    const currDate = dates[d];

    const prevBars = daysMap.get(prevDate);
    const currBars = daysMap.get(currDate);

    if (!prevBars || prevBars.length < 20 || !currBars || currBars.length < 20) continue;

    // Calcular PDH y PDL del día anterior
    let pdh = -Infinity;
    let pdl = Infinity;
    for (const b of prevBars) {
      if (b.high > pdh) pdh = b.high;
      if (b.low < pdl) pdl = b.low;
    }
    const prevMid = (pdh + pdl) / 2.0;

    // Buscar la 1ª vela M15 de NY
    const nyBarIndex = currBars.findIndex(b => b.timeStr === nyOpenTime);
    if (nyBarIndex === -1 || nyBarIndex + 1 >= currBars.length) continue;

    const firstBar = currBars[nyBarIndex];
    const isBullish = firstBar.close > firstBar.open;
    const isBearish = firstBar.close < firstBar.open;

    if (!isBullish && !isBearish) continue; // Doji neutro

    const bias = isBullish ? 'BUY' : 'SELL';

    if (filterPremiumDiscount) {
      if (bias === 'BUY' && firstBar.close > prevMid) {
        skippedFilter++;
        continue;
      }
      if (bias === 'SELL' && firstBar.close < prevMid) {
        skippedFilter++;
        continue;
      }
    }

    // Definir nivel de retesteo objetivo (50% de la 1ª vela M15)
    const retestLevel = isBullish
      ? (firstBar.low + (firstBar.high - firstBar.low) * (1 - retestDepth))
      : (firstBar.high - (firstBar.high - firstBar.low) * (1 - retestDepth));

    // Determinar SL
    let slPrice = 0;
    let slDistancePips = 0;

    if (slMode === 'CANDLE_EXTREME') {
      const buffer = 1.0; // 10 pips buffer
      if (bias === 'BUY') {
        slPrice = firstBar.low - buffer;
        slDistancePips = (retestLevel - slPrice) * 10.0;
      } else {
        slPrice = firstBar.high + buffer;
        slDistancePips = (slPrice - retestLevel) * 10.0;
      }
    } else {
      slDistancePips = fixedSlPips;
      const slDistPrice = fixedSlPips / 10.0;
      slPrice = bias === 'BUY' ? (retestLevel - slDistPrice) : (retestLevel + slDistPrice);
    }

    if (slDistancePips <= 0) continue;

    // Determinar TP
    let tpPrice = 0;
    if (tpMode === 'PREVIOUS_DAY_LEVEL') {
      tpPrice = bias === 'BUY' ? pdh : pdl;
      const targetPips = Math.abs(tpPrice - retestLevel) * 10.0;
      if (targetPips < minTargetPips) {
        skippedNoRange++;
        continue;
      }
      // Si el nivel ya fue superado antes de NY:
      if (bias === 'BUY' && firstBar.high >= pdh) {
        skippedAlreadyHit++;
        continue;
      }
      if (bias === 'SELL' && firstBar.low <= pdl) {
        skippedAlreadyHit++;
        continue;
      }
    } else {
      const tpDistPrice = (slDistancePips * fixedRR) / 10.0;
      tpPrice = bias === 'BUY' ? (retestLevel + tpDistPrice) : (retestLevel - tpDistPrice);
    }

    // Buscar retesteo y rechazo en las siguientes 12 barras M15 (próximas 3 horas de NY)
    let entered = false;
    let entryBarIdx = -1;
    let entryPrice = 0;

    const maxWaitBars = Math.min(currBars.length, nyBarIndex + 12);
    for (let k = nyBarIndex + 1; k < maxWaitBars; k++) {
      const bar = currBars[k];

      if (bias === 'BUY') {
        // En Compra: retestea hacia abajo y deja mecha / rechaza
        if (bar.low <= retestLevel && bar.close > slPrice) {
          entered = true;
          entryBarIdx = k;
          entryPrice = retestLevel;
          break;
        }
      } else {
        // En Venta: retestea hacia arriba y deja mecha / rechaza
        if (bar.high >= retestLevel && bar.close < slPrice) {
          entered = true;
          entryBarIdx = k;
          entryPrice = retestLevel;
          break;
        }
      }
    }

    if (!entered) {
      skippedNoRetest++;
      continue;
    }

    // Evaluar resultado en el resto de la sesión de NY
    totalTrades++;
    let tradeResult = null;
    let pipsResult = 0;

    for (let k = entryBarIdx; k < currBars.length; k++) {
      const bar = currBars[k];

      if (bias === 'BUY') {
        if (bar.low <= slPrice) {
          tradeResult = 'LOSS';
          pipsResult = -slDistancePips;
          break;
        }
        if (bar.high >= tpPrice) {
          tradeResult = 'WIN';
          pipsResult = Math.abs(tpPrice - entryPrice) * 10.0;
          break;
        }
      } else {
        if (bar.high >= slPrice) {
          tradeResult = 'LOSS';
          pipsResult = -slDistancePips;
          break;
        }
        if (bar.low <= tpPrice) {
          tradeResult = 'WIN';
          pipsResult = Math.abs(entryPrice - tpPrice) * 10.0;
          break;
        }
      }
    }

    // Si no tocó ni SL ni TP al cierre del día, cerrar al cierre de la última vela
    if (!tradeResult) {
      const lastBar = currBars[currBars.length - 1];
      const diff = bias === 'BUY' ? (lastBar.close - entryPrice) : (entryPrice - lastBar.close);
      pipsResult = diff * 10.0;
      tradeResult = pipsResult >= 0 ? 'WIN' : 'LOSS';
    }

    netPips += pipsResult;
    if (pipsResult > 0) {
      wins++;
      grossWinPips += pipsResult;
    } else {
      losses++;
      grossLossPips += Math.abs(pipsResult);
    }
  }

  const wr = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const pf = grossLossPips > 0 ? (grossWinPips / grossLossPips) : (grossWinPips > 0 ? 99 : 0);
  const avgPips = totalTrades > 0 ? (netPips / totalTrades) : 0;

  return {
    nyOpenTime,
    slMode,
    fixedSlPips,
    tpMode,
    totalTrades,
    wins,
    losses,
    wr: wr.toFixed(1) + '%',
    pf: pf.toFixed(2),
    netPips: netPips.toFixed(1),
    avgPips: avgPips.toFixed(1)
  };
}

console.log('🧪 Ejecutando matriz de configuraciones de Stop Loss y Take Profit...\n');

const configurations = [
  // A. Con Target en PDH / PDL
  { name: 'A1. SL Extremo M15 | TP PDH/PDL', nyOpenTime: '15:30:00', slMode: 'CANDLE_EXTREME', tpMode: 'PREVIOUS_DAY_LEVEL' },
  { name: 'A2. SL Fijo 30p | TP PDH/PDL', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 30, tpMode: 'PREVIOUS_DAY_LEVEL' },
  { name: 'A3. SL Fijo 40p | TP PDH/PDL', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 40, tpMode: 'PREVIOUS_DAY_LEVEL' },
  { name: 'A4. SL Fijo 30p | TP PDH/PDL + Filtro Premium/Discount', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 30, tpMode: 'PREVIOUS_DAY_LEVEL', filterPremiumDiscount: true },
  
  // B. Con Target en Ratio Fijo (R:R)
  { name: 'B1. SL Fijo 25p | TP R:R 1:1.5', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 25, tpMode: 'FIXED_RR', fixedRR: 1.5 },
  { name: 'B2. SL Fijo 25p | TP R:R 1:2.0', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 25, tpMode: 'FIXED_RR', fixedRR: 2.0 },
  { name: 'B3. SL Fijo 30p | TP R:R 1:1.5', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 30, tpMode: 'FIXED_RR', fixedRR: 1.5 },
  { name: 'B4. SL Fijo 30p | TP R:R 1:2.0', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 30, tpMode: 'FIXED_RR', fixedRR: 2.0 },
  { name: 'B5. SL Fijo 35p | TP R:R 1:2.0', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 35, tpMode: 'FIXED_RR', fixedRR: 2.0 },
  { name: 'B6. SL Fijo 30p | TP R:R 1:2.5', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 30, tpMode: 'FIXED_RR', fixedRR: 2.5 },
  { name: 'B7. SL Fijo 30p | TP R:R 1:3.0', nyOpenTime: '15:30:00', slMode: 'FIXED_PIPS', fixedSlPips: 30, tpMode: 'FIXED_RR', fixedRR: 3.0 },

  // C. Retesteo con SL Extremo de Vela M15
  { name: 'C1. SL Extremo M15 | TP R:R 1:1.5', nyOpenTime: '15:30:00', slMode: 'CANDLE_EXTREME', tpMode: 'FIXED_RR', fixedRR: 1.5 },
  { name: 'C2. SL Extremo M15 | TP R:R 1:2.0', nyOpenTime: '15:30:00', slMode: 'CANDLE_EXTREME', tpMode: 'FIXED_RR', fixedRR: 2.0 },
  { name: 'C3. SL Extremo M15 | TP R:R 1:2.0 + Filtro Prem/Disc', nyOpenTime: '15:30:00', slMode: 'CANDLE_EXTREME', tpMode: 'FIXED_RR', fixedRR: 2.0, filterPremiumDiscount: true }
];

const results = [];
for (const cfg of configurations) {
  const res = runSimulation(cfg);
  results.push({ name: cfg.name, ...res });
}

console.log('| Configuración | Trades | Win Rate | Profit Factor | Pips Netos | Pips Prom/Trade |');
console.log('| :--- | :---: | :---: | :---: | :---: | :---: |');
for (const r of results) {
  const sign = parseFloat(r.netPips) >= 0 ? '+' : '';
  console.log(`| **${r.name}** | ${r.totalTrades} | ${r.wr} | ${r.pf} | **${sign}${r.netPips}p** | ${sign}${r.avgPips}p |`);
}
