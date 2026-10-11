/**
 * Laboratorio Cuantitativo: PDH / PDL Liquidity Sweep & Reversal (BOS + FVG / BPR)
 * 
 * Estrategia:
 * 1. El precio barre o alcanza el PDH (Previous Day High) o PDL (Previous Day Low).
 * 2. Purga de liquidez (BSL / SSL).
 * 3. Patrón de reversión:
 *    - Rechazo / Cierre de nuevo por dentro del rango.
 *    - BOS (Break of Structure): Quiebre del swing / mínimo de la vela que barrió.
 *    - FVG (Fair Value Gap) / Desplazamiento institucional.
 * 4. Entrada:
 *    - Entrada por Confirmación (cierre de vela BOS/FVG)
 *    - Entrada por Retesteo (retroceso al FVG / CE 50%)
 * 5. SL en el extremo del barrido (Sweep High / Sweep Low) + buffer.
 * 6. TP:
 *    - R:R Fijo 1:2.0
 *    - R:R Fijo 1:2.5
 *    - R:R Fijo 1:3.0
 *    - Target 50% Equilibrio Diario (Midpoint)
 *    - Target Opuesto (PDL si vende en PDH, PDH si compra en PDL)
 */

const fs = require('fs');
const path = require('path');

const ASSETS = [
  {
    symbol: 'XAUUSD',
    file: 'XAUUSD_M15_202001020600_202610011115.csv',
    pipMultiplier: 10.0,
    pipName: 'pips',
    bufferPips: 5,
    maxSlPips: 60,
    minSlPips: 15
  },
  {
    symbol: 'NAS100',
    file: 'NAS100_M15_202001010300_202610011015.csv',
    pipMultiplier: 1.0,
    pipName: 'pts',
    bufferPips: 8,
    maxSlPips: 100,
    minSlPips: 20
  },
  {
    symbol: 'EURUSD',
    file: 'EURUSD_M15_202001020600_202610011015.csv',
    pipMultiplier: 10000.0,
    pipName: 'pips',
    bufferPips: 2,
    maxSlPips: 25,
    minSlPips: 6
  },
  {
    symbol: 'GBPJPY',
    file: 'GBPJPY_M15_202001020600_202610011015.csv',
    pipMultiplier: 100.0,
    pipName: 'pips',
    bufferPips: 4,
    maxSlPips: 45,
    minSlPips: 12
  }
];

function loadData(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split(/\r?\n/);
  const daysMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length >= 6) {
      const dateStr = parts[0];
      const timeStr = parts[1];
      const open = parseFloat(parts[2]);
      const high = parseFloat(parts[3]);
      const low = parseFloat(parts[4]);
      const close = parseFloat(parts[5]);

      if (!daysMap.has(dateStr)) {
        daysMap.set(dateStr, []);
      }
      daysMap.get(dateStr).push({ dateStr, timeStr, open, high, low, close });
    }
  }

  return { daysMap, dates: Array.from(daysMap.keys()).sort() };
}

function runReversalBacktest(asset, daysMap, dates, options) {
  const {
    entryType = 'FVG_RETEST', // 'FVG_RETEST' | 'BOS_CLOSE'
    targetMode = 'RR_2',      // 'RR_2' | 'RR_2_5' | 'RR_3' | 'MIDPOINT' | 'OPPOSITE_LEVEL'
    fixedRR = 2.0,
    requireFVG = true,
    sessionFilter = true      // Solo barridos y entradas entre 09:00 y 20:00 server (Londres + NY)
  } = options;

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let netPips = 0;
  let grossWinPips = 0;
  let grossLossPips = 0;
  let netR = 0;

  for (let d = 1; d < dates.length; d++) {
    const prevBars = daysMap.get(dates[d - 1]);
    const currBars = daysMap.get(dates[d]);

    if (!prevBars || prevBars.length < 20 || !currBars || currBars.length < 20) continue;

    // 1. Niveles del día anterior
    let pdh = -Infinity;
    let pdl = Infinity;
    for (const b of prevBars) {
      if (b.high > pdh) pdh = b.high;
      if (b.low < pdl) pdl = b.low;
    }
    const prevRange = pdh - pdl;
    const midpoint = (pdh + pdl) / 2.0;

    let tradeTakenToday = false;

    // Recorrer barras del día actual
    for (let i = 2; i < currBars.length - 4; i++) {
      if (tradeTakenToday) break;

      const bar = currBars[i];

      // Filtro de sesión (evitar horas muertas asiáticas)
      if (sessionFilter) {
        const hour = parseInt(bar.timeStr.split(':')[0], 10);
        if (hour < 9 || hour > 19) continue;
      }

      // -------------------------------------------------------------
      // CASO A: BARRIDO DE PDH -> BUSCAR REVERSIÓN A VENTAS (SHORT)
      // -------------------------------------------------------------
      if (bar.high > pdh) {
        // Encontramos un barrido de liquidez alcista
        const sweepHigh = bar.high;
        const sweepBarIdx = i;

        // Buscar en las siguientes 1 a 6 barras (próximos 15-90 min):
        // 1. Cierre de vuelta por debajo del PDH
        // 2. BOS: quiebre a la baja del mínimo de la vela del barrido
        // 3. FVG bajista: bar[k-2].low > bar[k].high
        for (let k = sweepBarIdx + 1; k < Math.min(currBars.length - 2, sweepBarIdx + 8); k++) {
          const confBar = currBars[k];
          const prevConfBar = currBars[k - 1];

          // Si el precio sigue disparado hacia arriba haciendo un nuevo máximo mucho mayor, cancelar
          if (confBar.high > sweepHigh + (asset.bufferPips * 2 / asset.pipMultiplier)) break;

          // Condición de rechazo: cierre por debajo de PDH
          const closedBelowPDH = confBar.close < pdh;
          // Condición de BOS: quiebre a la baja del Low de la vela de sweep
          const bosConfirmed = confBar.close < currBars[sweepBarIdx].low;

          if (!closedBelowPDH || !bosConfirmed) continue;

          // Verificar FVG bajista
          let hasFvg = false;
          let fvgTop = 0;
          let fvgBottom = 0;

          if (k >= 2) {
            const bar0 = currBars[k - 2];
            const bar2 = confBar;
            if (bar0.low > bar2.high) {
              hasFvg = true;
              fvgTop = bar0.low;
              fvgBottom = bar2.high;
            }
          }

          if (requireFVG && !hasFvg) continue;

          // Parámetros de la orden
          const bufferPrice = asset.bufferPips / asset.pipMultiplier;
          const slPrice = Math.max(sweepHigh, prevConfBar.high) + bufferPrice;
          let entryPrice = 0;
          let entryBarIdx = -1;

          if (entryType === 'BOS_CLOSE') {
            entryPrice = confBar.close;
            entryBarIdx = k;
          } else {
            // FVG Retest: esperar retroceso al FVG en las siguientes barras
            const targetRetest = hasFvg ? (fvgTop + fvgBottom) / 2.0 : confBar.high;
            for (let m = k + 1; m < Math.min(currBars.length - 1, k + 6); m++) {
              if (currBars[m].high >= targetRetest && currBars[m].close < slPrice) {
                entryPrice = targetRetest;
                entryBarIdx = m;
                break;
              }
            }
          }

          if (entryBarIdx === -1 || entryPrice <= 0) continue;

          const slDistPips = (slPrice - entryPrice) * asset.pipMultiplier;
          if (slDistPips < asset.minSlPips || slDistPips > asset.maxSlPips) continue;

          // Determinar Take Profit
          let tpPrice = 0;
          if (targetMode === 'MIDPOINT') {
            tpPrice = midpoint;
            if (tpPrice >= entryPrice) continue;
          } else if (targetMode === 'OPPOSITE_LEVEL') {
            tpPrice = pdl;
            if (tpPrice >= entryPrice) continue;
          } else {
            const tpDistPrice = (slDistPips * fixedRR) / asset.pipMultiplier;
            tpPrice = entryPrice - tpDistPrice;
          }

          // Simular trade
          const sim = evaluateTrade(currBars, entryBarIdx, 'SELL', entryPrice, slPrice, tpPrice, slDistPips, asset.pipMultiplier);
          recordTrade(sim);
          tradeTakenToday = true;
          break;
        }
      }

      if (tradeTakenToday) break;

      // -------------------------------------------------------------
      // CASO B: BARRIDO DE PDL -> BUSCAR REVERSIÓN A COMPRAS (BUY)
      // -------------------------------------------------------------
      if (bar.low < pdl) {
        const sweepLow = bar.low;
        const sweepBarIdx = i;

        for (let k = sweepBarIdx + 1; k < Math.min(currBars.length - 2, sweepBarIdx + 8); k++) {
          const confBar = currBars[k];
          const prevConfBar = currBars[k - 1];

          if (confBar.low < sweepLow - (asset.bufferPips * 2 / asset.pipMultiplier)) break;

          const closedAbovePDL = confBar.close > pdl;
          const bosConfirmed = confBar.close > currBars[sweepBarIdx].high;

          if (!closedAbovePDL || !bosConfirmed) continue;

          let hasFvg = false;
          let fvgBottom = 0;
          let fvgTop = 0;

          if (k >= 2) {
            const bar0 = currBars[k - 2];
            const bar2 = confBar;
            if (bar2.low > bar0.high) {
              hasFvg = true;
              fvgBottom = bar0.high;
              fvgTop = bar2.low;
            }
          }

          if (requireFVG && !hasFvg) continue;

          const bufferPrice = asset.bufferPips / asset.pipMultiplier;
          const slPrice = Math.min(sweepLow, prevConfBar.low) - bufferPrice;
          let entryPrice = 0;
          let entryBarIdx = -1;

          if (entryType === 'BOS_CLOSE') {
            entryPrice = confBar.close;
            entryBarIdx = k;
          } else {
            const targetRetest = hasFvg ? (fvgTop + fvgBottom) / 2.0 : confBar.low;
            for (let m = k + 1; m < Math.min(currBars.length - 1, k + 6); m++) {
              if (currBars[m].low <= targetRetest && currBars[m].close > slPrice) {
                entryPrice = targetRetest;
                entryBarIdx = m;
                break;
              }
            }
          }

          if (entryBarIdx === -1 || entryPrice <= 0) continue;

          const slDistPips = (entryPrice - slPrice) * asset.pipMultiplier;
          if (slDistPips < asset.minSlPips || slDistPips > asset.maxSlPips) continue;

          let tpPrice = 0;
          if (targetMode === 'MIDPOINT') {
            tpPrice = midpoint;
            if (tpPrice <= entryPrice) continue;
          } else if (targetMode === 'OPPOSITE_LEVEL') {
            tpPrice = pdh;
            if (tpPrice <= entryPrice) continue;
          } else {
            const tpDistPrice = (slDistPips * fixedRR) / asset.pipMultiplier;
            tpPrice = entryPrice + tpDistPrice;
          }

          const sim = evaluateTrade(currBars, entryBarIdx, 'BUY', entryPrice, slPrice, tpPrice, slDistPips, asset.pipMultiplier);
          recordTrade(sim);
          tradeTakenToday = true;
          break;
        }
      }
    }
  }

  function evaluateTrade(bars, startIdx, bias, entry, sl, tp, slDistPips, mult) {
    let result = null;
    let pips = 0;
    let r = 0;

    for (let idx = startIdx; idx < bars.length; idx++) {
      const b = bars[idx];
      if (bias === 'BUY') {
        if (b.low <= sl) {
          result = 'LOSS';
          pips = -slDistPips;
          r = -1.0;
          break;
        }
        if (b.high >= tp) {
          result = 'WIN';
          pips = Math.abs(tp - entry) * mult;
          r = pips / slDistPips;
          break;
        }
      } else {
        if (b.high >= sl) {
          result = 'LOSS';
          pips = -slDistPips;
          r = -1.0;
          break;
        }
        if (b.low <= tp) {
          result = 'WIN';
          pips = Math.abs(entry - tp) * mult;
          r = pips / slDistPips;
          break;
        }
      }
    }

    if (!result) {
      const last = bars[bars.length - 1];
      const diff = bias === 'BUY' ? (last.close - entry) : (entry - last.close);
      pips = diff * mult;
      r = pips / slDistPips;
      result = pips >= 0 ? 'WIN' : 'LOSS';
    }

    return { result, pips, r };
  }

  function recordTrade(sim) {
    totalTrades++;
    netPips += sim.pips;
    netR += sim.r;
    if (sim.pips > 0) {
      wins++;
      grossWinPips += sim.pips;
    } else {
      losses++;
      grossLossPips += Math.abs(sim.pips);
    }
  }

  const wr = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const pf = grossLossPips > 0 ? (grossWinPips / grossLossPips) : (grossWinPips > 0 ? 99 : 0);
  const avgR = totalTrades > 0 ? (netR / totalTrades) : 0;

  return {
    totalTrades,
    wins,
    losses,
    wr: wr.toFixed(1) + '%',
    pf: pf.toFixed(2),
    netPips: netPips.toFixed(1),
    netR: (netR >= 0 ? '+' : '') + netR.toFixed(1) + 'R',
    avgR: (avgR >= 0 ? '+' : '') + avgR.toFixed(2) + 'R'
  };
}

console.log('========================================================================================');
console.log('🎯 BACKTEST: LIQUIDEZ PDH/PDL + REVERSIÓN INSTITUCIONAL (BOS + FVG) [2020 - 2026]');
console.log('========================================================================================\n');

for (const asset of ASSETS) {
  const filePath = path.join(__dirname, '..', asset.file);
  if (!fs.existsSync(filePath)) continue;

  console.log(`\n======================================================`);
  console.log(`📊 ACTIVO: ${asset.symbol}`);
  console.log(`======================================================`);

  const { daysMap, dates } = loadData(filePath);

  const setups = [
    // 1. Variantes con FVG Retest
    { name: '1. FVG Retest | R:R 1:2.0', entryType: 'FVG_RETEST', targetMode: 'RR_2', fixedRR: 2.0, requireFVG: true },
    { name: '2. FVG Retest | R:R 1:2.5', entryType: 'FVG_RETEST', targetMode: 'RR_2_5', fixedRR: 2.5, requireFVG: true },
    { name: '3. FVG Retest | R:R 1:3.0', entryType: 'FVG_RETEST', targetMode: 'RR_3', fixedRR: 3.0, requireFVG: true },
    { name: '4. FVG Retest | TP 50% Midpoint Diario', entryType: 'FVG_RETEST', targetMode: 'MIDPOINT', requireFVG: true },
    { name: '5. FVG Retest | TP Extremo Opuesto (PDH->PDL)', entryType: 'FVG_RETEST', targetMode: 'OPPOSITE_LEVEL', requireFVG: true },

    // 2. Variantes con Entrada Directa al Cierre de BOS
    { name: '6. Entrada Cierre BOS | R:R 1:2.0', entryType: 'BOS_CLOSE', targetMode: 'RR_2', fixedRR: 2.0, requireFVG: false },
    { name: '7. Entrada Cierre BOS | R:R 1:2.5', entryType: 'BOS_CLOSE', targetMode: 'RR_2_5', fixedRR: 2.5, requireFVG: false },
    { name: '8. Entrada Cierre BOS | TP 50% Midpoint', entryType: 'BOS_CLOSE', targetMode: 'MIDPOINT', requireFVG: false }
  ];

  console.log('\n| Setup de Reversión | Trades | Win Rate | Profit Factor | Resultado Neto | Retorno Total (R) | Exp / Trade |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const s of setups) {
    const res = runReversalBacktest(asset, daysMap, dates, s);
    const sign = parseFloat(res.netPips) >= 0 ? '+' : '';
    console.log(`| **${s.name}** | ${res.totalTrades} | ${res.wr} | ${res.pf} | ${sign}${res.netPips} ${asset.pipName} | **${res.netR}** | ${res.avgR} |`);
  }
}
