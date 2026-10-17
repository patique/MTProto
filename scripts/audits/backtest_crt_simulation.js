/**
 * Backtest Exhaustivo de Candle Range Theory (CRT) en Datos Reales de XAUUSD (2020-2026)
 * Datos: Velas H1 y H4 con precios reales de Open, High, Low, Close, Spread
 */

const fs = require('fs');
const readline = require('readline');

async function loadData(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  const candles = [];
  let header = true;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    candles.push({
      date: parts[0],
      time: parts[1],
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spread: parseFloat(parts[8] || '20') / 10 // en dólares/puntos
    });
  }
  return candles;
}

// Convertir velas H1 a D1 (Daily)
function buildDailyCandles(h1Candles) {
  const daily = [];
  let currentDay = null;
  let curCandle = null;

  for (const c of h1Candles) {
    if (c.date !== currentDay) {
      if (curCandle) daily.push(curCandle);
      currentDay = c.date;
      curCandle = {
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        spread: c.spread
      };
    } else {
      curCandle.high = Math.max(curCandle.high, c.high);
      curCandle.low = Math.min(curCandle.low, c.low);
      curCandle.close = c.close;
    }
  }
  if (curCandle) daily.push(curCandle);
  return daily;
}

// Función de Simulación CRT
function runCRTBacktest(candles, options = {}) {
  const {
    targetType = 'OPPOSITE', // 'OPPOSITE' (100% rango) o 'EQUILIBRIUM' (50% rango)
    useTrendFilter = false,  // Filtro EMA 50
    minWickPips = 5,         // Mecha mínima de barrido en puntos (0.5$ = 5 pips)
    maxWickPips = 80,        // Mecha máxima de barrido (evitar velas de noticias extremas)
    trailBE = true           // Si toca el 50%, mover SL a Break-Even
  } = options;

  let wins = 0;
  let losses = 0;
  let beCount = 0;
  let totalTrades = 0;
  let totalProfitPips = 0;
  let totalLossPips = 0;
  let realizedRRs = [];
  let theoreticalRRs = [];

  // Calcular EMA si se solicita
  const ema50 = [];
  if (useTrendFilter) {
    const k = 2 / (50 + 1);
    let prevEma = candles[0].close;
    ema50.push(prevEma);
    for (let i = 1; i < candles.length; i++) {
      const curEma = candles[i].close * k + prevEma * (1 - k);
      ema50.push(curEma);
      prevEma = curEma;
    }
  }

  // Iterar velas
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1]; // Vela N-1 (Rango de referencia)
    const cur = candles[i];     // Vela N (Vela del setup)
    const next = candles[i + 1]; // Vela N+1 (Resolución de trade)

    const prevRange = prev.high - prev.low;
    if (prevRange < 2.0) continue; // Descartar días feriados o rango muerto (< 20 pips)

    const prevEQ = (prev.high + prev.low) / 2;

    // 1. SETUP VENTA: Cur barre High previo pero cierra por debajo
    const sweptHigh = cur.high > prev.high;
    const closedBelowHigh = cur.close < prev.high;
    const highWick = cur.high - prev.high;

    // 2. SETUP COMPRA: Cur barre Low previo pero cierra por encima
    const sweptLow = cur.low < prev.low;
    const closedAboveLow = cur.close > prev.low;
    const lowWick = prev.low - cur.low;

    let trade = null;

    if (sweptHigh && closedBelowHigh && highWick >= (minWickPips / 10) && highWick <= (maxWickPips / 10)) {
      if (!useTrendFilter || (useTrendFilter && cur.close < ema50[i])) {
        // Venta al cierre de Vela N (o retesteo de prev.high)
        const entry = cur.close;
        const sl = cur.high + 0.5; // SL sobre la mecha + buffer
        const tp = targetType === 'OPPOSITE' ? prev.low : prevEQ;
        const risk = Math.abs(sl - entry);
        const reward = Math.abs(entry - tp);

        if (risk > 0 && reward > 0) {
          trade = {
            type: 'SELL',
            entry,
            sl,
            tp,
            eq: prevEQ,
            risk,
            reward,
            theorRR: reward / risk,
            candleIndex: i
          };
        }
      }
    } else if (sweptLow && closedAboveLow && lowWick >= (minWickPips / 10) && lowWick <= (maxWickPips / 10)) {
      if (!useTrendFilter || (useTrendFilter && cur.close > ema50[i])) {
        // Compra al cierre de Vela N
        const entry = cur.close;
        const sl = cur.low - 0.5; // SL bajo la mecha - buffer
        const tp = targetType === 'OPPOSITE' ? prev.high : prevEQ;
        const risk = Math.abs(entry - sl);
        const reward = Math.abs(tp - entry);

        if (risk > 0 && reward > 0) {
          trade = {
            type: 'BUY',
            entry,
            sl,
            tp,
            eq: prevEQ,
            risk,
            reward,
            theorRR: reward / risk,
            candleIndex: i
          };
        }
      }
    }

    if (!trade) continue;

    totalTrades++;
    theoreticalRRs.push(trade.theorRR);

    // Evaluar trade en las velas siguientes (hasta un máximo de 12 velas o SL/TP)
    let outcome = 'OPEN';
    let hitEQ = false;
    let currentSL = trade.sl;

    for (let j = i + 1; j < Math.min(candles.length, i + 15); j++) {
      const c = candles[j];

      if (trade.type === 'SELL') {
        // Verificar si toca EQ para Break-Even
        if (trailBE && !hitEQ && c.low <= trade.eq) {
          hitEQ = true;
          currentSL = trade.entry; // BE
        }

        // SL hit
        if (c.high >= currentSL) {
          outcome = hitEQ ? 'BE' : 'SL';
          break;
        }
        // TP hit
        if (c.low <= trade.tp) {
          outcome = 'TP';
          break;
        }
      } else {
        // BUY
        if (trailBE && !hitEQ && c.high >= trade.eq) {
          hitEQ = true;
          currentSL = trade.entry; // BE
        }

        if (c.low <= currentSL) {
          outcome = hitEQ ? 'BE' : 'SL';
          break;
        }
        if (c.high >= trade.tp) {
          outcome = 'TP';
          break;
        }
      }
    }

    if (outcome === 'TP') {
      wins++;
      totalProfitPips += trade.reward * 10;
      realizedRRs.push(trade.theorRR);
    } else if (outcome === 'BE') {
      beCount++;
    } else {
      losses++;
      totalLossPips += trade.risk * 10;
    }
  }

  const avgTheorRR = theoreticalRRs.length > 0 ? (theoreticalRRs.reduce((a, b) => a + b, 0) / theoreticalRRs.length) : 0;
  const avgRealizedRR = realizedRRs.length > 0 ? (realizedRRs.reduce((a, b) => a + b, 0) / realizedRRs.length) : 0;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const lossRate = totalTrades > 0 ? (losses / totalTrades * 100) : 0;
  const beRate = totalTrades > 0 ? (beCount / totalTrades * 100) : 0;
  const profitFactor = totalLossPips > 0 ? (totalProfitPips / totalLossPips) : 999;
  const netPips = totalProfitPips - totalLossPips;

  return {
    totalTrades,
    wins,
    losses,
    beCount,
    winRate: winRate.toFixed(1) + '%',
    lossRate: lossRate.toFixed(1) + '%',
    beRate: beRate.toFixed(1) + '%',
    avgTheoreticalRR: '1:' + avgTheorRR.toFixed(2),
    avgRealizedRR: '1:' + avgRealizedRR.toFixed(2),
    profitFactor: profitFactor.toFixed(2),
    netPips: netPips.toFixed(1)
  };
}

(async () => {
  console.log('================================================================');
  console.log('📊 AUDITORÍA EMPÍRICA REAL DE CANDLE RANGE THEORY (CRT)');
  console.log('   Activo: XAUUSD | Periodo: 2020.01 - 2026.10 (6.7 Años)');
  console.log('================================================================\n');

  const h1Data = await loadData('XAUUSD_H1_202001020600_202610011100.csv');
  const h4Data = await loadData('XAUUSD_H4_202001020400_202610010800.csv');
  const d1Data = buildDailyCandles(h1Data);

  console.log(`Cargadas: H1 (${h1Data.length} velas) | H4 (${h4Data.length} velas) | D1 (${d1Data.length} velas)\n`);

  const tests = [
    { tf: 'D1 (Diario)', data: d1Data, target: 'OPPOSITE', trend: false, be: true, label: 'D1 CRT Puro al Extremo Opuesto (con BE en 50%)' },
    { tf: 'D1 (Diario)', data: d1Data, target: 'EQUILIBRIUM', trend: false, be: false, label: 'D1 CRT Conservador a Equilibrium (50%)' },
    { tf: 'D1 (Diario)', data: d1Data, target: 'OPPOSITE', trend: true, be: true, label: 'D1 CRT con Filtro Tendencial EMA 50' },
    
    { tf: 'H4', data: h4Data, target: 'OPPOSITE', trend: false, be: true, label: 'H4 CRT Puro al Extremo Opuesto (con BE en 50%)' },
    { tf: 'H4', data: h4Data, target: 'EQUILIBRIUM', trend: false, be: false, label: 'H4 CRT Conservador a Equilibrium (50%)' },
    { tf: 'H4', data: h4Data, target: 'OPPOSITE', trend: true, be: true, label: 'H4 CRT con Filtro Tendencial EMA 50' },

    { tf: 'H1', data: h1Data, target: 'OPPOSITE', trend: false, be: true, label: 'H1 CRT Puro al Extremo Opuesto (con BE en 50%)' },
    { tf: 'H1', data: h1Data, target: 'EQUILIBRIUM', trend: false, be: false, label: 'H1 CRT a Equilibrium (50%)' },
    { tf: 'H1', data: h1Data, target: 'OPPOSITE', trend: true, be: true, label: 'H1 CRT con Filtro Tendencial EMA 50' }
  ];

  for (const t of tests) {
    const res = runCRTBacktest(t.data, { targetType: t.target, useTrendFilter: t.trend, trailBE: t.be });
    console.log(`🔹 [${t.tf}] ${t.label}`);
    console.log(`   Trades: ${res.totalTrades} | WinRate: ${res.winRate} | BE: ${res.beRate} | Pérdidas: ${res.lossRate}`);
    console.log(`   R:R Teórico Medio: ${res.avgTheoreticalRR} | R:R Real Ganador: ${res.avgRealizedRR}`);
    console.log(`   Profit Factor: ${res.profitFactor} | Pips Netos: ${res.netPips}\n`);
  }
})();
