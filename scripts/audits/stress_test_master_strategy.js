/**
 * Banco de Pruebas de Estrés Cuantitativo y Auditoría de Interés Compuesto:
 * Institutional Volume Profile & Smart Money Confluence Strategy (IVP-SMC)
 * 
 * Evalúa:
 * 1. Impacto del Interés Compuesto (Lote Fijo $10,000 vs Compuesto Dinámico).
 * 2. Confluencia de Medias Móviles (EMA 50 vs EMA 100 vs EMA 200).
 * 3. Prueba de Estrés de Deslizamiento (Slippage) y Spread agresivo (1.5 pips vs 3.5 pips vs 5.0 pips).
 * 4. Extensión de Beneficios Asimétricos (1.25x vs 1.40x vs 1.60x).
 * 5. Robustez en Cuenta de Fondeo de $10,000 USD durante 1 Año Completo.
 */

const { fetchFullYearData } = require('./multi_tf_volume_profile_1y');
const { InstitutionalVolumeSMCStrategy } = require('../../core/algorithms/InstitutionalVolumeSMCStrategy');

function runStressSimulation(candles, strategyConfig, executionOptions = {}) {
  const {
    compounding = false,
    spreadSlippagePips = 1.5, // 1.5 pips en condiciones normales
    initialBalance = 10000.0,
    riskPercent = 0.75
  } = executionOptions;

  const strategy = new InstitutionalVolumeSMCStrategy(strategyConfig);
  const emaValues = strategy.calculateEMA(candles, strategy.emaPeriod);

  let balance = initialBalance;
  let peakBalance = balance;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  let fullWins = 0;
  let partialWins = 0;
  let totalLosses = 0;
  let totalGrossProfit = 0;
  let totalGrossLoss = 0;

  const spreadUSD = spreadSlippagePips / 10.0;
  const days = {};

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dayStr = new Date(c.time).toISOString().split('T')[0];
    if (!days[dayStr]) days[dayStr] = [];
    days[dayStr].push({ ...c, index: i });
  }

  const tradeHistory = [];

  for (const [dayStr, dayCandles] of Object.entries(days)) {
    const londonOpenCandle = dayCandles.find(c => new Date(c.time).getUTCHours() === 7);
    if (!londonOpenCandle) continue;

    const currentEma = emaValues[londonOpenCandle.index];
    const setup = strategy.evaluateDaySetup(dayCandles, currentEma);
    if (!setup) continue;

    const { orderType, limitPrice, slPrice, tp1Price, tp2Price, slDistance } = setup;

    // Buscar si se activa durante la ventana permitida (hasta maxFillHourUTC)
    const localStartIdx = dayCandles.findIndex(c => c.index === londonOpenCandle.index);
    if (localStartIdx < 0) continue;

    let filled = false;
    let fillIndex = -1;

    for (let j = localStartIdx + 1; j < dayCandles.length; j++) {
      const c = dayCandles[j];
      const h = new Date(c.time).getUTCHours();
      if (h >= strategy.maxFillHourUTC) break;

      if (orderType === 'BUY_LIMIT' && c.low <= limitPrice) {
        filled = true;
        fillIndex = c.index;
        break;
      } else if (orderType === 'SELL_LIMIT' && c.high >= limitPrice) {
        filled = true;
        fillIndex = c.index;
        break;
      }
    }

    if (!filled) continue;

    // Gestión de Capital: Lote Fijo sobre balance inicial vs Compuesto Dinámico
    const baseEquity = compounding ? balance : initialBalance;
    const riskUSD = (baseEquity * riskPercent) / 100.0;
    const lotSize = riskUSD / (slDistance * 100.0);

    let hitTP1 = false;
    let hitTP2 = false;
    let hitSL = false;
    let hitBE = false;

    // Recorrer velas futuras hasta resolver
    for (let k = fillIndex + 1; k < Math.min(candles.length, fillIndex + 48); k++) {
      const c = candles[k];

      if (orderType === 'BUY_LIMIT') {
        if (!hitTP1 && (c.high - spreadUSD) >= tp1Price) hitTP1 = true;
        if (hitTP1 && (c.high - spreadUSD) >= tp2Price) { hitTP2 = true; break; }

        const activeSL = hitTP1 ? limitPrice + spreadUSD : slPrice;
        if ((c.low + spreadUSD) <= activeSL) {
          if (hitTP1) hitBE = true; else hitSL = true;
          break;
        }
      } else {
        if (!hitTP1 && (c.low + spreadUSD) <= tp1Price) hitTP1 = true;
        if (hitTP1 && (c.low + spreadUSD) <= tp2Price) { hitTP2 = true; break; }

        const activeSL = hitTP1 ? limitPrice - spreadUSD : slPrice;
        if ((c.high - spreadUSD) >= activeSL) {
          if (hitTP1) hitBE = true; else hitSL = true;
          break;
        }
      }
    }

    let profitUSD = 0;
    if (hitTP2) {
      const p1 = (Math.abs(tp1Price - limitPrice) * 100.0) * (lotSize * strategy.tp1VolumeRatio);
      const p2 = (Math.abs(tp2Price - limitPrice) * 100.0) * (lotSize * (1 - strategy.tp1VolumeRatio));
      profitUSD = (p1 + p2) - (spreadUSD * 100.0 * lotSize);
      fullWins++;
      totalGrossProfit += profitUSD;
    } else if (hitTP1) {
      const p1 = (Math.abs(tp1Price - limitPrice) * 100.0) * (lotSize * strategy.tp1VolumeRatio);
      profitUSD = p1 - (spreadUSD * 100.0 * lotSize * strategy.tp1VolumeRatio);
      partialWins++;
      totalGrossProfit += profitUSD;
    } else {
      profitUSD = -(riskUSD + (spreadUSD * 100.0 * lotSize));
      totalLosses++;
      totalGrossLoss += Math.abs(profitUSD);
    }

    balance += profitUSD;
    if (balance > peakBalance) peakBalance = balance;
    const currentDD = peakBalance - balance;
    const currentDDPct = (currentDD / peakBalance) * 100.0;
    if (currentDD > maxDrawdownUSD) maxDrawdownUSD = currentDD;
    if (currentDDPct > maxDrawdownPct) maxDrawdownPct = currentDDPct;

    tradeHistory.push({ dayStr, profitUSD, balance });
  }

  const totalClosed = fullWins + partialWins + totalLosses;
  const profitableTrades = fullWins + partialWins;
  const winRate = totalClosed > 0 ? ((profitableTrades / totalClosed) * 100).toFixed(1) : 0;
  const netProfitUSD = balance - initialBalance;
  const netProfitPct = ((netProfitUSD / initialBalance) * 100).toFixed(2);
  const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'Inf';

  return {
    totalClosed,
    fullWins,
    partialWins,
    totalLosses,
    winRate,
    netProfitUSD,
    netProfitPct,
    profitFactor,
    maxDrawdownUSD,
    maxDrawdownPct,
    balance,
    tradeHistory
  };
}

async function main() {
  console.log('\n========================================================================================================');
  console.log('🏛️  BANCO DE PRUEBAS DE ESTRÉS CUANTITATIVO Y AUDITORÍA DE PARÁMETROS MAESTROS');
  console.log('    ESTRATEGIA: InstitutionalVolumeSMC (IVP-SMC) - CUENTA PROP FIRM $10,000 USD (1 AÑO)');
  console.log('========================================================================================================\n');

  console.log('📡 Descargando datos H1 de 1 año (8.760 velas)...');
  const candlesH1 = await fetchFullYearData('1h', 60 * 60 * 1000);
  console.log(`✅ Velas H1 cargadas: ${candlesH1.length}.\n`);

  // --------------------------------------------------------------------------------------------------
  // TEST 1: IMPACTO DEL INTERÉS COMPUESTO (Lote Fijo sobre 10k vs Compuesto Dinámico)
  // --------------------------------------------------------------------------------------------------
  console.log('🔬 TEST 1: LOTE FIJO vs INTERÉS COMPUESTO DINÁMICO');
  console.log('| Modo de Capital | Trades | Win Rate | Beneficio Neto (10k) | Rentabilidad (%) | Max Drawdown (%) | Profit Factor |');
  console.log('|---|---|---|---|---|---|---|');

  const baseConfig = { emaPeriod: 100, slAir: 1.50, tp2Extension: 1.40, maxFillHourUTC: 15, maxAreaSpan: 18.0 };

  const resFixed = runStressSimulation(candlesH1, baseConfig, { compounding: false });
  const resComp = runStressSimulation(candlesH1, baseConfig, { compounding: true });

  console.log(`| Lote Fijo (Base $10,000)   | ${resFixed.totalClosed}     | ${resFixed.winRate}%    | +$${resFixed.netProfitUSD.toFixed(2)}          | +${resFixed.netProfitPct}%           | ${resFixed.maxDrawdownPct.toFixed(2)}%            | ${resFixed.profitFactor}          |`);
  console.log(`| Interés Compuesto Dinámico | ${resComp.totalClosed}     | ${resComp.winRate}%    | +$${resComp.netProfitUSD.toFixed(2)}          | +${resComp.netProfitPct}%           | ${resComp.maxDrawdownPct.toFixed(2)}%            | ${resComp.profitFactor}          |`);

  // --------------------------------------------------------------------------------------------------
  // TEST 2: CONFLUENCIA DE MEDIAS MÓVILES (EMA 50 vs EMA 100 vs EMA 200)
  // --------------------------------------------------------------------------------------------------
  console.log('\n🔬 TEST 2: ANÁLISIS DE FILTRO DE TENDENCIA (EMA 50 vs EMA 100 vs EMA 200)');
  console.log('| Filtro Tendencia | Trades | Win Rate | Beneficio Neto (10k) | Rentabilidad (%) | Max Drawdown (%) | Profit Factor |');
  console.log('|---|---|---|---|---|---|---|');

  for (const ema of [50, 100, 200]) {
    const res = runStressSimulation(candlesH1, { ...baseConfig, emaPeriod: ema }, { compounding: true });
    console.log(`| EMA ${ema} H1           | ${res.totalClosed}     | ${res.winRate}%    | +$${res.netProfitUSD.toFixed(2)}          | +${res.netProfitPct}%           | ${res.maxDrawdownPct.toFixed(2)}%            | ${res.profitFactor}          |`);
  }

  // --------------------------------------------------------------------------------------------------
  // TEST 3: PRUEBA DE ESTRÉS DE SLIPPAGE Y SPREAD (1.5 pips vs 3.5 pips vs 5.0 pips)
  // --------------------------------------------------------------------------------------------------
  console.log('\n🔬 TEST 3: PRUEBA DE ESTRÉS DE SPREAD Y DESLIZAMIENTO BRUTAL (SLIPPAGE)');
  console.log('| Condición de Mercado | Spread/Slip | Trades | Win Rate | Beneficio Neto (10k) | Rentabilidad (%) | Max DD (%) | Profit Factor |');
  console.log('|---|---|---|---|---|---|---|---|');

  const slipTests = [
    { label: 'Broker ECN Óptimo', pips: 1.5 },
    { label: 'Horario Volátil / Alta Spread', pips: 3.5 },
    { label: 'Deslizamiento Severo / Noticias', pips: 5.0 }
  ];

  for (const st of slipTests) {
    const res = runStressSimulation(candlesH1, baseConfig, { compounding: true, spreadSlippagePips: st.pips });
    console.log(`| ${st.label.padEnd(30)} | ${st.pips} pips    | ${res.totalClosed}     | ${res.winRate}%    | +$${res.netProfitUSD.toFixed(2)}          | +${res.netProfitPct}%           | ${res.maxDrawdownPct.toFixed(2)}%      | ${res.profitFactor}          |`);
  }

  // --------------------------------------------------------------------------------------------------
  // TEST 4: EXTENSIÓN ASIMÉTRICA DE TP2 (1.25x vs 1.40x vs 1.60x vs 1.80x)
  // --------------------------------------------------------------------------------------------------
  console.log('\n🔬 TEST 4: RATIO DE EXPANSIÓN ASIMÉTRICA DEL BENEFICIO (TP2)');
  console.log('| Extensión TP2 | Trades | Full TP2 | Parcial + BE | Losses | Win Rate | Beneficio Neto (10k) | Max DD (%) | Profit Factor |');
  console.log('|---|---|---|---|---|---|---|---|---|');

  for (const ext of [1.25, 1.40, 1.60, 1.80]) {
    const res = runStressSimulation(candlesH1, { ...baseConfig, tp2Extension: ext }, { compounding: true });
    console.log(`| Expansión ${ext}x | ${res.totalClosed}     | ${res.fullWins} Full    | ${res.partialWins} BE        | ${res.totalLosses}     | ${res.winRate}%    | +$${res.netProfitUSD.toFixed(2)}           | ${res.maxDrawdownPct.toFixed(2)}%      | ${res.profitFactor}          |`);
  }

  console.log('\n========================================================================================================\n');
}

main().catch(console.error);
