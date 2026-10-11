/**
 * Simulación de Portafolio Consolidado (2 Slots Vivos Simultáneos & Sin BE)
 * 
 * Estrategias Incluidas (Todas las validadas con Alpha positivo):
 * 1. NY Open Expansion - XAUUSD (SL 30p, TP 1:2.0) [15:30 Server]
 * 2. NY Open Expansion - NAS100 (SL 30pts, TP 1:2.0) [16:30 Server]
 * 3. NY Open Expansion - EURUSD (SL 8p, TP 1:2.0) [15:30 Server]
 * 4. PDH/PDL Reversal - XAUUSD (FVG Retest, TP 1:2.0) [09:00 - 19:00 Server]
 * 5. PDH/PDL Reversal - EURUSD (FVG Retest, TP 1:2.5) [09:00 - 19:00 Server]
 * 6. PDH/PDL Reversal - GBPJPY (FVG Retest, TP 50% Midpoint) [09:00 - 19:00 Server]
 * 
 * Restricciones Rigurosas de Cuenta Fondeada:
 * - Balance Inicial: $100,000 USD (Cuenta FTMO 100k)
 * - Riesgo por Trade: 0.50% ($500 USD por trade)
 * - Máximo de 2 Operaciones Vivas Simultáneas (2 slots)
 * - Si hay 2 trades abiertos, cualquier nueva señal se DESCARTA (sin sobreexposición)
 * - Sin BE (cada trade corre íntegro a SL (-1R = -$500) o TP (+2R = +$1,000 o +2.5R = +$1,250))
 */

const fs = require('fs');
const path = require('path');

// 1. Cargar datos M15 de los activos clave
const assetsConfig = {
  XAUUSD: { file: 'XAUUSD_M15_202001020600_202610011115.csv', mult: 10.0, buffer: 5, slPips: 30, tpRR: 2.0 },
  NAS100: { file: 'NAS100_M15_202001010300_202610011015.csv', mult: 1.0, buffer: 8, slPips: 30, tpRR: 2.0 },
  EURUSD: { file: 'EURUSD_M15_202001020600_202610011015.csv', mult: 10000.0, buffer: 2, slPips: 8, tpRR: 2.0 },
  GBPJPY: { file: 'GBPJPY_M15_202001020600_202610011015.csv', mult: 100.0, buffer: 4, slPips: 20, tpRR: 2.0 }
};

const loadedData = {};
for (const [sym, cfg] of Object.entries(assetsConfig)) {
  const filePath = path.join(__dirname, '..', cfg.file);
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

      if (!daysMap.has(dateStr)) daysMap.set(dateStr, []);
      daysMap.get(dateStr).push({ dateStr, timeStr, open, high, low, close });
    }
  }
  loadedData[sym] = { daysMap, dates: Array.from(daysMap.keys()).sort() };
}

// 2. Extraer todas las señales con su Timestamp de Entrada y Timestamp de Salida
const allTradeEvents = [];

// A. Señales de NY Open Expansion
function extractNYOpenSignals(sym, openTime, slPips, tpRR) {
  const cfg = assetsConfig[sym];
  const { daysMap, dates } = loadedData[sym];

  for (let d = 1; d < dates.length; d++) {
    const prevBars = daysMap.get(dates[d - 1]);
    const currBars = daysMap.get(dates[d]);
    if (!prevBars || !currBars || currBars.length < 20) continue;

    const barIdx = currBars.findIndex(b => b.timeStr === openTime);
    if (barIdx === -1 || barIdx + 1 >= currBars.length) continue;

    const firstBar = currBars[barIdx];
    if (firstBar.close === firstBar.open) continue;
    const bias = firstBar.close > firstBar.open ? 'BUY' : 'SELL';

    const retestLevel = bias === 'BUY'
      ? (firstBar.low + (firstBar.high - firstBar.low) * 0.50)
      : (firstBar.high - (firstBar.high - firstBar.low) * 0.50);

    const slPrice = bias === 'BUY'
      ? (retestLevel - (slPips / cfg.mult))
      : (retestLevel + (slPips / cfg.mult));
    const tpPrice = bias === 'BUY'
      ? (retestLevel + ((slPips * tpRR) / cfg.mult))
      : (retestLevel - ((slPips * tpRR) / cfg.mult));

    let entryIdx = -1;
    for (let k = barIdx + 1; k < Math.min(currBars.length, barIdx + 12); k++) {
      const b = currBars[k];
      if (bias === 'BUY' && b.low <= retestLevel && b.close > slPrice) {
        entryIdx = k;
        break;
      }
      if (bias === 'SELL' && b.high >= retestLevel && b.close < slPrice) {
        entryIdx = k;
        break;
      }
    }

    if (entryIdx === -1) continue;

    const entryTimeStr = `${dates[d]} ${currBars[entryIdx].timeStr}`;
    let exitIdx = currBars.length - 1;
    let rReturn = 0;

    for (let k = entryIdx; k < currBars.length; k++) {
      const b = currBars[k];
      if (bias === 'BUY') {
        if (b.low <= slPrice) {
          exitIdx = k;
          rReturn = -1.0;
          break;
        }
        if (b.high >= tpPrice) {
          exitIdx = k;
          rReturn = tpRR;
          break;
        }
      } else {
        if (b.high >= slPrice) {
          exitIdx = k;
          rReturn = -1.0;
          break;
        }
        if (b.low <= tpPrice) {
          exitIdx = k;
          rReturn = tpRR;
          break;
        }
      }
    }

    if (rReturn === 0) {
      const last = currBars[currBars.length - 1];
      const diff = bias === 'BUY' ? (last.close - retestLevel) : (retestLevel - last.close);
      rReturn = (diff * cfg.mult) / slPips;
    }

    const exitTimeStr = `${dates[d]} ${currBars[exitIdx].timeStr}`;

    allTradeEvents.push({
      strategy: `NY_EXP_${sym}`,
      symbol: sym,
      entryDateStr: entryTimeStr,
      exitDateStr: exitTimeStr,
      entryTimestamp: new Date(entryTimeStr.replace(/\./g, '-')).getTime(),
      exitTimestamp: new Date(exitTimeStr.replace(/\./g, '-')).getTime(),
      rReturn
    });
  }
}

// B. Señales de PDH/PDL Reversal
function extractReversalSignals(sym, targetMode, tpRR) {
  const cfg = assetsConfig[sym];
  const { daysMap, dates } = loadedData[sym];

  for (let d = 1; d < dates.length; d++) {
    const prevBars = daysMap.get(dates[d - 1]);
    const currBars = daysMap.get(dates[d]);
    if (!prevBars || !currBars || currBars.length < 20) continue;

    let pdh = -Infinity;
    let pdl = Infinity;
    for (const b of prevBars) {
      if (b.high > pdh) pdh = b.high;
      if (b.low < pdl) pdl = b.low;
    }
    const midpoint = (pdh + pdl) / 2.0;
    let tradeTaken = false;

    for (let i = 2; i < currBars.length - 4; i++) {
      if (tradeTaken) break;
      const bar = currBars[i];
      const hour = parseInt(bar.timeStr.split(':')[0], 10);
      if (hour < 9 || hour > 19) continue;

      // Sweep PDH -> SELL
      if (bar.high > pdh) {
        const sweepHigh = bar.high;
        for (let k = i + 1; k < Math.min(currBars.length - 2, i + 8); k++) {
          const conf = currBars[k];
          if (conf.high > sweepHigh + (cfg.buffer * 2 / cfg.mult)) break;
          if (conf.close < pdh && conf.close < currBars[i].low) {
            // Check FVG
            const b0 = currBars[k - 2];
            if (b0.low > conf.high) {
              const targetRetest = (b0.low + conf.high) / 2.0;
              const slPrice = sweepHigh + (cfg.buffer / cfg.mult);
              const slPips = (slPrice - targetRetest) * cfg.mult;
              if (slPips < 10 || slPips > 70) continue;

              for (let m = k + 1; m < Math.min(currBars.length - 1, k + 6); m++) {
                if (currBars[m].high >= targetRetest && currBars[m].close < slPrice) {
                  // Entró
                  const entryTimeStr = `${dates[d]} ${currBars[m].timeStr}`;
                  let tpPrice = targetMode === 'MIDPOINT' ? midpoint : targetRetest - ((slPips * tpRR) / cfg.mult);
                  if (tpPrice >= targetRetest) break;

                  let exitIdx = currBars.length - 1;
                  let rReturn = 0;
                  for (let n = m; n < currBars.length; n++) {
                    const b = currBars[n];
                    if (b.high >= slPrice) { exitIdx = n; rReturn = -1.0; break; }
                    if (b.low <= tpPrice) { exitIdx = n; rReturn = (targetRetest - tpPrice) / (slPrice - targetRetest); break; }
                  }
                  if (rReturn === 0) {
                    const diff = targetRetest - currBars[currBars.length - 1].close;
                    rReturn = (diff * cfg.mult) / slPips;
                  }
                  const exitTimeStr = `${dates[d]} ${currBars[exitIdx].timeStr}`;
                  allTradeEvents.push({
                    strategy: `REV_${sym}`,
                    symbol: sym,
                    entryDateStr: entryTimeStr,
                    exitDateStr: exitTimeStr,
                    entryTimestamp: new Date(entryTimeStr.replace(/\./g, '-')).getTime(),
                    exitTimestamp: new Date(exitTimeStr.replace(/\./g, '-')).getTime(),
                    rReturn
                  });
                  tradeTaken = true;
                  break;
                }
              }
            }
          }
          if (tradeTaken) break;
        }
      }
    }
  }
}

// Extraer señales
console.log('⏳ Extrayendo eventos de trading de todas las estrategias...');

function runPortfolioSimulation(name, events, riskUSD, maxSlots) {
  let currentBalance = 100000.0;
  let peakBalance = 100000.0;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  const executed = [];
  const rejected = [];
  const active = [];

  for (const trade of events) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].exitTimestamp <= trade.entryTimestamp) {
        active.splice(i, 1);
      }
    }

    if (active.length >= maxSlots) {
      rejected.push(trade);
      continue;
    }

    const profitUSD = riskUSD * trade.rReturn;
    currentBalance += profitUSD;

    if (currentBalance > peakBalance) peakBalance = currentBalance;
    const ddUSD = peakBalance - currentBalance;
    const ddPct = (ddUSD / 100000.0) * 100.0;
    if (ddUSD > maxDrawdownUSD) maxDrawdownUSD = ddUSD;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    executed.push({ ...trade, profitUSD });
    active.push({ exitTimestamp: trade.exitTimestamp, trade });
  }

  const wins = executed.filter(t => t.profitUSD > 0);
  const losses = executed.filter(t => t.profitUSD < 0);
  const totalProfit = currentBalance - 100000.0;
  const wr = (wins.length / executed.length) * 100.0;
  const grossProfit = wins.reduce((acc, t) => acc + t.profitUSD, 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.profitUSD, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss) : 99;

  return {
    name,
    trades: executed.length,
    rejected: rejected.length,
    wr: wr.toFixed(1) + '%',
    pf: pf.toFixed(2),
    profitUSD: totalProfit.toFixed(2),
    monthlyAvgUSD: (totalProfit / (6.75 * 12)).toFixed(2),
    maxDDUSD: maxDrawdownUSD.toFixed(2),
    maxDDPct: maxDrawdownPct.toFixed(2) + '%'
  };
}

// 1. Matriz completa de 6 estrategias
extractNYOpenSignals('XAUUSD', '15:30:00', 30, 2.0);
extractNYOpenSignals('NAS100', '16:30:00', 30, 2.0);
extractNYOpenSignals('EURUSD', '15:30:00', 8, 2.0);
extractReversalSignals('XAUUSD', 'FIXED_RR', 2.0);
extractReversalSignals('EURUSD', 'FIXED_RR', 2.5);
extractReversalSignals('GBPJPY', 'MIDPOINT', 2.0);

allTradeEvents.sort((a, b) => a.entryTimestamp - b.entryTimestamp);

// 2. Filtro Top 3 Core (XAUUSD NY, NAS100 NY, XAUUSD Reversal)
const top3Events = allTradeEvents.filter(t => 
  t.strategy === 'NY_EXP_XAUUSD' || 
  t.strategy === 'NY_EXP_NAS100' || 
  t.strategy === 'REV_XAUUSD'
);

const sim1 = runPortfolioSimulation('Portafolio Completo (6 Estrategias) | Riesgo 0.50% ($500)', allTradeEvents, 500, 2);
const sim2 = runPortfolioSimulation('Portafolio Completo (6 Estrategias) | Riesgo 0.25% ($250)', allTradeEvents, 250, 2);
const sim3 = runPortfolioSimulation('Top 3 Alpha Core (XAU + NAS) | Riesgo 0.50% ($500)', top3Events, 500, 2);
const sim4 = runPortfolioSimulation('Top 3 Alpha Core (XAU + NAS) | Riesgo 0.35% ($350)', top3Events, 350, 2);

console.log('\n========================================================================================');
console.log('📊 COMPARATIVA DE PORTAFOLIOS CON 2 SLOTS SIMULTÁNEOS (CUENTA FTMO 100k)');
console.log('========================================================================================\n');

console.log('| Configuración | Trades | Señales Descartadas | Win Rate | Profit Factor | Beneficio Total | Promedio / Mes | Max Drawdown |');
console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');
for (const s of [sim1, sim2, sim3, sim4]) {
  console.log(`| **${s.name}** | ${s.trades} | ${s.rejected} | ${s.wr} | ${s.pf} | **+$${parseFloat(s.profitUSD).toLocaleString('en-US')}** | +$${s.monthlyAvgUSD}/m | **${s.maxDDPct}** ($${parseFloat(s.maxDDUSD).toLocaleString('en-US')}) |`);
}
process.exit(0);

// Estadísticas
const wins = executedTrades.filter(t => t.profitUSD > 0);
const losses = executedTrades.filter(t => t.profitUSD < 0);
const totalProfitUSD = currentBalance - INITIAL_BALANCE;
const winRate = (wins.length / executedTrades.length) * 100.0;

const grossProfit = wins.reduce((acc, t) => acc + t.profitUSD, 0);
const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.profitUSD, 0));
const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : 99;

// Agrupar por año
const yearlyStats = {};
for (const t of executedTrades) {
  const year = t.entryDateStr.substring(0, 4);
  if (!yearlyStats[year]) {
    yearlyStats[year] = { trades: 0, wins: 0, profitUSD: 0 };
  }
  yearlyStats[year].trades++;
  if (t.profitUSD > 0) yearlyStats[year].wins++;
  yearlyStats[year].profitUSD += t.profitUSD;
}

console.log('========================================================================================');
console.log('🏆 RESULTADOS DEL PORTAFOLIO CONSOLIDADO (CUENTA FTMO $100,000 USD)');
console.log('   REGLAS: MÁXIMO 2 SLOTS SIMULTÁNEOS | 0.50% RIESGO POR TRADE | SIN BREAK-EVEN');
console.log('========================================================================================\n');

console.log(`💰 Balance Inicial:              $${INITIAL_BALANCE.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`);
console.log(`📈 Balance Final:                $${currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD`);
console.log(`💵 Beneficio Neto Total:         +$${totalProfitUSD.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD (+${((totalProfitUSD/INITIAL_BALANCE)*100).toFixed(1)}%)`);
console.log(`🎯 Profit Factor:                ${profitFactor.toFixed(2)}`);
console.log(`🛡️ Drawdown Máximo Histórico:    ${maxDrawdownPct.toFixed(2)}% ($${maxDrawdownUSD.toFixed(2)} USD) [¡Muy por debajo del límite del 10%!]`);
console.log(`🎲 Total Señales Procesadas:     ${allTradeEvents.length}`);
console.log(`✅ Operaciones Ejecutadas:       ${executedTrades.length}`);
console.log(`🛑 Señales Descartadas (2 Slots): ${rejectedDueToSlots.length} (${((rejectedDueToSlots.length/allTradeEvents.length)*100).toFixed(1)}% protegidas de sobreoperar)`);
console.log(`🏆 Win Rate Global:              ${winRate.toFixed(1)}% (${wins.length} Ganadas / ${losses.length} Perdidas)`);

console.log('\n📅 DESGLOSE POR AÑOS (Rendimiento Anual en Cuenta de $100,000):');
console.log('| Año | Trades Ejecutados | Win Rate | Beneficio USD | Retorno Anual % | Beneficio Promedio / Mes |');
console.log('| :---: | :---: | :---: | :---: | :---: | :---: |');
for (const [y, stat] of Object.entries(yearlyStats)) {
  const wr = ((stat.wins / stat.trades) * 100).toFixed(1);
  const ret = ((stat.profitUSD / INITIAL_BALANCE) * 100).toFixed(1);
  const monthlyAvg = (stat.profitUSD / 12).toFixed(2);
  console.log(`| **${y}** | ${stat.trades} | ${wr}% | **+$${stat.profitUSD.toLocaleString('en-US', { minimumFractionDigits: 2 })}** | +${ret}% | +$${monthlyAvg} / mes |`);
}
