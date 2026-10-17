/**
 * Backtest Real de Setup Institucional CRT / SMC en Sesión de New York:
 * - Marco Temporal de Ejecución: M15 (Order Block tras quiebre de estructura)
 * - Sesión: New York (15:00 a 19:30 Servidor)
 * - Rango Objetivo HTF: Diario (50% Equilibrium vs Extremo Pendiente PDH/PDL)
 * - Activo: XAUUSD (2020 - 2026 / 159,571 velas M15)
 */

const fs = require('fs');
const readline = require('readline');

async function loadM15Data() {
  const fileStream = fs.createReadStream('XAUUSD_M15_202001020600_202610011115.csv');
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
      spread: parseFloat(parts[8] || '20') / 10
    });
  }
  return candles;
}

function runNYSessionM15Backtest(m15Candles, options = {}) {
  const {
    targetMode = 'EQUILIBRIUM_ONLY', // 'EQUILIBRIUM_ONLY', 'FINAL_EXTREME_ONLY', 'HYBRID_50_AND_EXTREME'
    minDisplacementPips = 15.0,     // Desplazamiento mínimo para validar el OB (1.5$ en Oro)
    obRetestLevel = 'OPEN',         // 'OPEN' del OB o 'MID' (50% del cuerpo)
    maxSLPips = 45.0,               // SL máximo permitido para evitar OBs gigantes
    minSLPips = 10.0,               // SL mínimo para absorber spread
    bufferPips = 3.0                // Buffer adicional tras el OB
  } = options;

  // Agrupar velas por día para calcular PDH, PDL y Rango Diario
  const daysMap = new Map();
  for (let i = 0; i < m15Candles.length; i++) {
    const c = m15Candles[i];
    if (!daysMap.has(c.date)) {
      daysMap.set(c.date, []);
    }
    daysMap.get(c.date).push({ ...c, index: i });
  }

  const daysArray = Array.from(daysMap.keys());
  
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let beTrades = 0;
  let totalProfitPips = 0;
  let totalLossPips = 0;
  let realizedRRs = [];
  let riskPipsList = [];
  let rewardPipsList = [];

  // Recorrer días a partir del 2º día (para tener PDH/PDL del día anterior)
  for (let d = 1; d < daysArray.length; d++) {
    const prevDate = daysArray[d - 1];
    const curDate = daysArray[d];

    const prevCandles = daysMap.get(prevDate);
    const curCandles = daysMap.get(curDate);

    // Calcular PDH y PDL
    let pdh = -Infinity;
    let pdl = Infinity;
    for (const c of prevCandles) {
      if (c.high > pdh) pdh = c.high;
      if (c.low < pdl) pdl = c.low;
    }
    const prevDailyRange = pdh - pdl;
    if (prevDailyRange < 4.0) continue; // Descartar días muertos

    const dailyEQ = (pdh + pdl) / 2;

    // Analizar la sesión de NY (15:00 a 19:30 Servidor)
    // En las velas previas de hoy (Asia + Londres), ver qué liquidez se barrió
    let todayHighBeforeNY = -Infinity;
    let todayLowBeforeNY = Infinity;

    const nyCandles = [];
    for (const c of curCandles) {
      const hour = parseInt(c.time.split(':')[0]);
      const minute = parseInt(c.time.split(':')[1]);
      const timeVal = hour + minute / 60;

      if (timeVal < 15.0) {
        if (c.high > todayHighBeforeNY) todayHighBeforeNY = c.high;
        if (c.low < todayLowBeforeNY) todayLowBeforeNY = c.low;
      } else if (timeVal >= 15.0 && timeVal <= 19.5) {
        nyCandles.push(c);
      }
    }

    if (nyCandles.length < 4) continue;

    // Determinar Sesgo Diario y Objetivo Pendiente de Liquidar
    // Si Londres barrió el PDH, el Draw on Liquidity pendiente es el 50% Daily o PDL
    // Si Londres barrió el PDL, el Draw on Liquidity pendiente es el 50% Daily o PDH
    let bias = 'NEUTRAL';
    let targetPrice = null;
    let targetFinal = null;

    if (todayHighBeforeNY >= pdh && todayLowBeforeNY > pdl) {
      // PDH ya fue liquidado arriba -> Sesgo bajista en NY buscando EQ y PDL
      bias = 'SELL';
      targetPrice = dailyEQ;
      targetFinal = pdl;
    } else if (todayLowBeforeNY <= pdl && todayHighBeforeNY < pdh) {
      // PDL ya fue liquidado abajo -> Sesgo alcista en NY buscando EQ y PDH
      bias = 'BUY';
      targetPrice = dailyEQ;
      targetFinal = pdh;
    } else {
      // No hubo barrido aún -> El precio está en rango interno.
      // Si está por encima del 50%, busca vender hacia el 50% / PDL.
      // Si está por debajo del 50%, busca comprar hacia el 50% / PDH.
      const firstNYPrice = nyCandles[0].open;
      if (firstNYPrice > dailyEQ) {
        bias = 'SELL';
        targetPrice = dailyEQ;
        targetFinal = pdl;
      } else {
        bias = 'BUY';
        targetPrice = dailyEQ;
        targetFinal = pdh;
      }
    }

    // Buscar Order Block M15 dentro de la ventana de NY
    // Un OB alcista es la última vela bajista antes de una vela de desplazamiento alcista fuerte
    // Un OB bajista es la última vela alcista antes de una vela de desplazamiento bajista fuerte
    let tradeExecutedToday = false;

    for (let k = 1; k < nyCandles.length - 1; k++) {
      if (tradeExecutedToday) break;

      const prevBar = nyCandles[k - 1];
      const curBar = nyCandles[k];

      if (bias === 'BUY') {
        const isBearishCandle = prevBar.close < prevBar.open;
        const isBullishImpulse = (curBar.close - curBar.open) >= (minDisplacementPips / 10);
        const breaksStructure = curBar.close > prevBar.high;

        if (isBearishCandle && isBullishImpulse && breaksStructure) {
          // OB Validado: prevBar
          const obOpen = prevBar.open;
          const obMid = (prevBar.high + prevBar.low) / 2;
          const entryPrice = obRetestLevel === 'OPEN' ? obOpen : obMid;
          const slPrice = prevBar.low - (bufferPips / 10);
          const risk = entryPrice - slPrice;

          if (risk * 10 < minSLPips || risk * 10 > maxSLPips) continue;

          const chosenTP = targetMode === 'EQUILIBRIUM_ONLY' ? targetPrice
                         : targetMode === 'FINAL_EXTREME_ONLY' ? targetFinal
                         : targetFinal; // Híbrido maneja salida intermedia

          const reward = chosenTP - entryPrice;
          if (reward <= (risk * 0.5)) continue; // Descartar si el TP está demasiado cerca

          // Simular si el precio retestea el OB en las siguientes velas de la sesión
          const startIdx = curBar.index + 1;
          let entryHit = false;
          let entryIdx = -1;

          for (let m = startIdx; m < Math.min(m15Candles.length, startIdx + 12); m++) {
            const checkC = m15Candles[m];
            if (checkC.low <= entryPrice && checkC.high >= entryPrice) {
              entryHit = true;
              entryIdx = m;
              break;
            }
          }

          if (entryHit) {
            tradeExecutedToday = true;
            totalTrades++;
            riskPipsList.push(risk * 10);
            rewardPipsList.push(reward * 10);

            // Evaluar resolución
            let outcome = 'OPEN';
            let hitEQ = false;
            let curSL = slPrice;

            for (let m = entryIdx + 1; m < Math.min(m15Candles.length, entryIdx + 40); m++) {
              const resC = m15Candles[m];

              // Si toca EQ, mover a BE en modo final o híbrido
              if (targetMode !== 'EQUILIBRIUM_ONLY' && !hitEQ && resC.high >= dailyEQ) {
                hitEQ = true;
                curSL = entryPrice; // Break-Even
              }

              if (resC.low <= curSL) {
                outcome = hitEQ ? 'BE' : 'SL';
                break;
              }
              if (resC.high >= chosenTP) {
                outcome = 'TP';
                break;
              }
            }

            const tradeRR = reward / risk;

            if (outcome === 'TP') {
              wins++;
              totalProfitPips += reward * 10;
              realizedRRs.push(tradeRR);
            } else if (outcome === 'BE') {
              beTrades++;
            } else {
              losses++;
              totalLossPips += risk * 10;
            }
          }
        }
      } else if (bias === 'SELL') {
        const isBullishCandle = prevBar.close > prevBar.open;
        const isBearishImpulse = (curBar.open - curBar.close) >= (minDisplacementPips / 10);
        const breaksStructure = curBar.close < prevBar.low;

        if (isBullishCandle && isBearishImpulse && breaksStructure) {
          // OB Validado
          const obOpen = prevBar.open;
          const obMid = (prevBar.high + prevBar.low) / 2;
          const entryPrice = obRetestLevel === 'OPEN' ? obOpen : obMid;
          const slPrice = prevBar.high + (bufferPips / 10);
          const risk = slPrice - entryPrice;

          if (risk * 10 < minSLPips || risk * 10 > maxSLPips) continue;

          const chosenTP = targetMode === 'EQUILIBRIUM_ONLY' ? targetPrice
                         : targetMode === 'FINAL_EXTREME_ONLY' ? targetFinal
                         : targetFinal;

          const reward = entryPrice - chosenTP;
          if (reward <= (risk * 0.5)) continue;

          const startIdx = curBar.index + 1;
          let entryHit = false;
          let entryIdx = -1;

          for (let m = startIdx; m < Math.min(m15Candles.length, startIdx + 12); m++) {
            const checkC = m15Candles[m];
            if (checkC.high >= entryPrice && checkC.low <= entryPrice) {
              entryHit = true;
              entryIdx = m;
              break;
            }
          }

          if (entryHit) {
            tradeExecutedToday = true;
            totalTrades++;
            riskPipsList.push(risk * 10);
            rewardPipsList.push(reward * 10);

            let outcome = 'OPEN';
            let hitEQ = false;
            let curSL = slPrice;

            for (let m = entryIdx + 1; m < Math.min(m15Candles.length, entryIdx + 40); m++) {
              const resC = m15Candles[m];

              if (targetMode !== 'EQUILIBRIUM_ONLY' && !hitEQ && resC.low <= dailyEQ) {
                hitEQ = true;
                curSL = entryPrice; // Break-Even
              }

              if (resC.high >= curSL) {
                outcome = hitEQ ? 'BE' : 'SL';
                break;
              }
              if (resC.low <= chosenTP) {
                outcome = 'TP';
                break;
              }
            }

            const tradeRR = reward / risk;

            if (outcome === 'TP') {
              wins++;
              totalProfitPips += reward * 10;
              realizedRRs.push(tradeRR);
            } else if (outcome === 'BE') {
              beTrades++;
            } else {
              losses++;
              totalLossPips += risk * 10;
            }
          }
        }
      }
    }
  }

  const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const beRate = totalTrades > 0 ? (beTrades / totalTrades * 100) : 0;
  const lossRate = totalTrades > 0 ? (losses / totalTrades * 100) : 0;
  const avgRisk = riskPipsList.length > 0 ? (riskPipsList.reduce((a, b) => a + b, 0) / riskPipsList.length) : 0;
  const avgReward = rewardPipsList.length > 0 ? (rewardPipsList.reduce((a, b) => a + b, 0) / rewardPipsList.length) : 0;
  const avgRR = realizedRRs.length > 0 ? (realizedRRs.reduce((a, b) => a + b, 0) / realizedRRs.length) : 0;
  const profitFactor = totalLossPips > 0 ? (totalProfitPips / totalLossPips) : 999;
  const netPips = totalProfitPips - totalLossPips;

  return {
    totalTrades,
    wins,
    losses,
    beTrades,
    winRate: winRate.toFixed(1) + '%',
    beRate: beRate.toFixed(1) + '%',
    lossRate: lossRate.toFixed(1) + '%',
    avgRiskPips: avgRisk.toFixed(1) + ' pips',
    avgRewardPips: avgReward.toFixed(1) + ' pips',
    avgRealizedRR: '1:' + avgRR.toFixed(2),
    profitFactor: profitFactor.toFixed(2),
    netPips: netPips.toFixed(1)
  };
}

(async () => {
  console.log('================================================================');
  console.log('📊 AUDITORÍA EMPÍRICA: NY SESSION M15 ORDER BLOCK + DAILY RANGE TARGETS');
  console.log('   Activo: XAUUSD | Periodo: 2020.01 - 2026.10 (159,571 Velas M15)');
  console.log('================================================================\n');

  const m15Data = await loadM15Data();
  console.log(`Cargadas ${m15Data.length} velas M15.\n`);

  const configs = [
    {
      label: 'Opción 1: Target Exclusivo al 50% Diario (Equilibrium)',
      opts: { targetMode: 'EQUILIBRIUM_ONLY', minDisplacementPips: 15.0, obRetestLevel: 'OPEN' }
    },
    {
      label: 'Opción 2: Target al 50% Diario con entrada profunda en 50% del OB',
      opts: { targetMode: 'EQUILIBRIUM_ONLY', minDisplacementPips: 15.0, obRetestLevel: 'MID' }
    },
    {
      label: 'Opción 3: Target al Extremo Final Diario (PDH/PDL) con BE en 50%',
      opts: { targetMode: 'FINAL_EXTREME_ONLY', minDisplacementPips: 15.0, obRetestLevel: 'OPEN' }
    },
    {
      label: 'Opción 4: Target al Extremo Final con entrada profunda en 50% del OB',
      opts: { targetMode: 'FINAL_EXTREME_ONLY', minDisplacementPips: 15.0, obRetestLevel: 'MID' }
    },
    {
      label: 'Opción 5: Mayor Exigencia de Desplazamiento (Filtro Institucional 25 pips)',
      opts: { targetMode: 'EQUILIBRIUM_ONLY', minDisplacementPips: 25.0, obRetestLevel: 'OPEN' }
    }
  ];

  for (const c of configs) {
    const res = runNYSessionM15Backtest(m15Data, c.opts);
    console.log(`🔹 [${c.label}]`);
    console.log(`   Trades: ${res.totalTrades} | WinRate: ${res.winRate} | BE: ${res.beRate} | Pérdidas: ${res.lossRate}`);
    console.log(`   Riesgo Medio (SL): ${res.avgRiskPips} | Objetivo Medio (TP): ${res.avgRewardPips}`);
    console.log(`   R:R Realizado: ${res.avgRealizedRR} | Profit Factor: ${res.profitFactor} | Pips Netos: ${res.netPips}\n`);
  }
})();
