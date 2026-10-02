/**
 * Backtest Cuantitativo 1 Año: Intraday Session Liquidity Sweep (Judas Swing / Caza de Liquidez)
 * 
 * Concepto Sniper:
 * - Sesión Asiática (00:00 - 06:30 UTC): Construye el rango de liquidez (Asia High & Asia Low).
 * - London Open (07:00 - 10:30 UTC): Caza de stop-loss (Judas Swing).
 *   • Si el precio perfora Asia High por 5 a 25 pips y una vela M5 cierra de vuelta POR DEBAJO de Asia High -> SELL SNIPER.
 *   • Si el precio perfora Asia Low por 5 a 25 pips y una vela M5 cierra de vuelta POR ENCIMA de Asia Low -> BUY SNIPER.
 * - NY Open (12:30 - 15:30 UTC): Caza del rango matutino de Londres (London High / Low).
 * 
 * Frecuencia esperada: 1 a 2 operaciones por día (250 a 450 operaciones al año).
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache_paxg_5m_1y.json');
const candles = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

function runSessionSweepBacktest(opts = {}) {
  const {
    name = 'Session Sweep',
    sweepMinPips = 5.0,  // Mínima penetración para considerar sweep ($0.50)
    sweepMaxPips = 30.0, // Máxima penetración antes de considerar que es una ruptura tendencial ($3.00)
    tpPips = 20.0,       // 20 pips ($2.00 USD)
    slPips = 20.0,       // 20 pips ($2.00 USD | R:R 1:1)
    riskPercent = 0.50,
    includeNY = true
  } = opts;

  let balance = 10000.0;
  let peak = balance;
  let maxDD = 0;
  let maxDailyDD = 0;

  let currentDay = '';
  let dayStartBal = balance;
  let trades = [];

  // Variables de sesión del día
  let asiaHigh = -Infinity;
  let asiaLow = Infinity;
  let asiaFormed = false;

  let londonHigh = -Infinity;
  let londonLow = Infinity;
  let londonFormed = false;

  let tradesToday = 0;
  let inTrade = null;
  let passTrade = null;

  for (let i = 50; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.time);
    const dayStr = d.toISOString().slice(0, 10);
    const hour = d.getUTCHours();
    const min = d.getUTCMinutes();
    const timeDec = hour + (min / 60);

    // Cambio de día
    if (dayStr !== currentDay) {
      currentDay = dayStr;
      dayStartBal = balance;
      asiaHigh = -Infinity;
      asiaLow = Infinity;
      asiaFormed = false;
      londonHigh = -Infinity;
      londonLow = Infinity;
      londonFormed = false;
      tradesToday = 0;
    }

    // Actualizar trade activo
    if (inTrade) {
      let closed = false;
      let exitPrice = 0;
      let res = '';

      if (inTrade.type === 'BUY') {
        if (c.low <= inTrade.sl) {
          exitPrice = inTrade.sl;
          res = 'LOSS';
          closed = true;
        } else if (c.high >= inTrade.tp) {
          exitPrice = inTrade.tp;
          res = 'WIN';
          closed = true;
        }
      } else {
        if (c.high >= inTrade.sl) {
          exitPrice = inTrade.sl;
          res = 'LOSS';
          closed = true;
        } else if (c.low <= inTrade.tp) {
          exitPrice = inTrade.tp;
          res = 'WIN';
          closed = true;
        }
      }

      if (closed) {
        const diff = inTrade.type === 'BUY' ? (exitPrice - inTrade.entry) : (inTrade.entry - exitPrice);
        const pnl = diff * inTrade.lotSize * 100;
        balance += pnl;
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDD) maxDD = dd;

        const dailyDD = ((dayStartBal - balance) / dayStartBal) * 100;
        if (dailyDD > maxDailyDD) maxDailyDD = dailyDD;

        trades.push({ res, pnl, exitTime: c.time });
        if (balance >= 11000.0 && passTrade === null) passTrade = trades.length;
        inTrade = null;
      }
      continue;
    }

    // 1. Sesión Asiática (00:00 - 06:30 UTC): Construir rango
    if (timeDec >= 0 && timeDec < 6.5) {
      if (c.high > asiaHigh) asiaHigh = c.high;
      if (c.low < asiaLow) asiaLow = c.low;
      continue;
    }

    if (timeDec >= 6.5 && !asiaFormed && asiaHigh > -Infinity && (asiaHigh - asiaLow) >= 2.0) {
      asiaFormed = true;
    }

    // 2. Acumular rango de Londres (07:00 - 12:00 UTC)
    if (timeDec >= 7.0 && timeDec < 12.0) {
      if (c.high > londonHigh) londonHigh = c.high;
      if (c.low < londonLow) londonLow = c.low;
    }
    if (timeDec >= 12.0 && !londonFormed && londonHigh > -Infinity) {
      londonFormed = true;
    }

    if (tradesToday >= 2) continue; // Máximo 2 trades por día

    let signal = null;
    let sweepLevel = 0;

    // A. London Sweep de Asia (07:00 - 11:30 UTC)
    if (asiaFormed && timeDec >= 7.0 && timeDec <= 11.5) {
      // Barrido de Asia High (Judas Swing alcista falso -> Short)
      if (c.high >= asiaHigh + (sweepMinPips / 10.0) && c.high <= asiaHigh + (sweepMaxPips / 10.0)) {
        if (c.close < asiaHigh && c.close < c.open) { // Cierra de vuelta por debajo del nivel
          signal = 'SELL';
          sweepLevel = c.high;
        }
      }
      // Barrido de Asia Low (Judas Swing bajista falso -> Long)
      else if (c.low <= asiaLow - (sweepMinPips / 10.0) && c.low >= asiaLow - (sweepMaxPips / 10.0)) {
        if (c.close > asiaLow && c.close > c.open) { // Cierra de vuelta por encima del nivel
          signal = 'BUY';
          sweepLevel = c.low;
        }
      }
    }

    // B. NY Sweep de Londres (12:30 - 16:00 UTC)
    if (!signal && includeNY && londonFormed && timeDec >= 12.5 && timeDec <= 16.0) {
      if (c.high >= londonHigh + (sweepMinPips / 10.0) && c.high <= londonHigh + (sweepMaxPips / 10.0)) {
        if (c.close < londonHigh && c.close < c.open) {
          signal = 'SELL';
          sweepLevel = c.high;
        }
      } else if (c.low <= londonLow - (sweepMinPips / 10.0) && c.low >= londonLow - (sweepMaxPips / 10.0)) {
        if (c.close > londonLow && c.close > c.open) {
          signal = 'BUY';
          sweepLevel = c.low;
        }
      }
    }

    if (signal) {
      const entry = c.close;
      const tpDist = tpPips / 10.0;
      const slDist = slPips / 10.0;
      const riskUSD = balance * (riskPercent / 100);
      const lotSize = Math.max(0.01, Math.round((riskUSD / ((slDist + 0.15) * 100)) * 100) / 100);

      inTrade = {
        type: signal,
        entry,
        tp: signal === 'BUY' ? entry + tpDist : entry - tpDist,
        sl: signal === 'BUY' ? entry - slDist : entry + slDist,
        lotSize
      };

      tradesToday++;
    }
  }

  const wins = trades.filter(t => t.res === 'WIN');
  const losses = trades.filter(t => t.res === 'LOSS');
  const total = trades.length;
  const wr = total > 0 ? ((wins.length / total) * 100).toFixed(1) : '0';
  const netUSD = balance - 10000.0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'Inf';

  return {
    name,
    trades: total,
    opsPerDay: (total / 250).toFixed(2),
    wins: wins.length,
    losses: losses.length,
    winRate: wr,
    netProfitUSD: netUSD,
    netPct: ((netUSD / 10000.0) * 100).toFixed(2),
    maxDD: maxDD.toFixed(2),
    maxDailyDD: maxDailyDD.toFixed(2),
    pf,
    passTrades: passTrade
  };
}

const sweepVariations = [
  { name: '1. Sweep Conservador (TP 20p / SL 20p | R:R 1:1)', tpPips: 20.0, slPips: 20.0, sweepMinPips: 5.0, sweepMaxPips: 30.0 },
  { name: '2. Sweep Rápido Asimétrico (TP 15p / SL 20p | R:R 1:0.75)', tpPips: 15.0, slPips: 20.0, sweepMinPips: 5.0, sweepMaxPips: 25.0 },
  { name: '3. Sweep Micro-Scalp (TP 12p / SL 16p | R:R 1:0.75)', tpPips: 12.0, slPips: 16.0, sweepMinPips: 4.0, sweepMaxPips: 20.0 },
  { name: '4. Sweep Expansión (TP 25p / SL 25p | R:R 1:1)', tpPips: 25.0, slPips: 25.0, sweepMinPips: 6.0, sweepMaxPips: 35.0 },
  { name: '5. Sweep Solo Londres (TP 18p / SL 20p)', tpPips: 18.0, slPips: 20.0, sweepMinPips: 5.0, sweepMaxPips: 30.0, includeNY: false },
  { name: '6. Sweep Asimétrico Alta Prob. (TP 15p / SL 25p | R:R 1:0.60)', tpPips: 15.0, slPips: 25.0, sweepMinPips: 4.0, sweepMaxPips: 25.0 }
];

console.log('| Modelo Session Sweep Sniper | Ops | Ops/Día | Win Rate | Beneficio Neto (10k) | Rentabilidad | Max DD | DD Diario | PF | Pase (+10%) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');

for (const v of sweepVariations) {
  const r = runSessionSweepBacktest(v);
  const sign = r.netProfitUSD >= 0 ? '+' : '';
  const pass = r.passTrades ? `${r.passTrades} ops (~${Math.ceil(r.passTrades / parseFloat(r.opsPerDay))} días)` : 'No alcanzó';
  console.log(`| ${v.name.padEnd(52)} | ${r.trades.toString().padEnd(3)} | ${r.opsPerDay.toString().padEnd(7)} | ${(r.winRate + '%').padEnd(8)} | ${(sign + '$' + r.netProfitUSD.toFixed(2)).padEnd(20)} | ${(sign + r.netPct + '%').padEnd(12)} | ${(r.maxDD + '%').padEnd(6)} | ${(r.maxDailyDD + '%').padEnd(9)} | ${r.pf.padEnd(4)} | ${pass} |`);
}
