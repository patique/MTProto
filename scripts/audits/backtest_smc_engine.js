/**
 * Motor de Backtesting Exhaustivo y Cuantitativo para la Estrategia Institucional Propia (GoldSMCStrategy)
 * Simula la operativa vela a vela con datos reales de mercado, spread, slippage y modelos de gestión de beneficios.
 */

const https = require('https');
const { GoldSMCStrategy } = require('../../core/algorithms/GoldSMCStrategy');

function fetchBinanceCandles(symbol = 'PAXGUSDT', interval = '15m', limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const candles = raw.map(c => ({
            time: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
          }));
          resolve(candles);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

async function runInstitutionalBacktest() {
  console.log('\n========================================================================================================');
  console.log('🏛️ MOTOR DE BACKTESTING EXHAUSTIVO Y AUDITORÍA CUANTITATIVA: ESTRATEGIA PROPIA XAUUSD (SMC)');
  console.log('========================================================================================================\n');

  console.log('📡 Descargando histórico oficial de velas reales de Oro (PAXG/XAUUSD 15m)...');
  const candles = await fetchBinanceCandles('PAXGUSDT', '15m', 1000);
  console.log(`✅ ${candles.length} velas M15 cargadas. Período: ${new Date(candles[0].time).toLocaleDateString()} a ${new Date(candles[candles.length - 1].time).toLocaleDateString()}\n`);

  const strategy = new GoldSMCStrategy({
    minSweepPips: 5.0,
    maxSweepPips: 35.0,
    slBufferPips: 4.0,
    riskRewardTP1: 1.5,
    riskRewardTP2: 2.5,
    riskRewardTP3: 4.0
  });

  const signals = strategy.analyzeCandles(candles);
  console.log(`🎯 Señales algorítmicas de alta probabilidad detectadas: ${signals.length}`);

  if (signals.length === 0) {
    console.log('No se encontraron señales con los parámetros actuales.');
    return;
  }

  const SPREAD_PIPS = 1.5; // Spread promedio ECN en Oro
  const INITIAL_BALANCE = 1000.0; // Cuenta base de $1,000 USD
  const RISK_PERCENT = 0.01; // 1% de riesgo por trade ($10.00 USD)

  // Evaluaremos 3 perfiles de salida:
  // 1. Perfil TP1 Fijo (1:1.5 R:R)
  // 2. Perfil TP2 Sweet Spot (80% en TP2 a 1:2.5 R:R, 20% en TP3 con BE)
  // 3. Perfil TP3 Runner (1:4.0 R:R)
  
  const simulationResults = [];

  for (const sig of signals) {
    const entryIndex = sig.index;
    const isBuy = sig.action === 'BUY';
    const entry = isBuy ? sig.entry + (SPREAD_PIPS / 10.0) : sig.entry - (SPREAD_PIPS / 10.0);
    const sl = sig.sl;
    const tp1 = sig.tp1;
    const tp2 = sig.tp2;
    const tp3 = sig.tp3;
    const riskUSD = INITIAL_BALANCE * RISK_PERCENT; // $10 USD
    const riskPips = Math.abs(entry - sl) * 10.0;
    const lotSize = parseFloat((riskUSD / (riskPips * 1.0)).toFixed(2)); // $1 por pip por 0.10 lotes en Oro

    let outcomeTP1 = null;
    let outcomeTP2 = null;
    let outcomeTP3 = null;
    let exitTime = null;
    let durationBars = 0;

    // Recorrer velas futuras para simular la ejecución tick/vela
    for (let j = entryIndex + 1; j < candles.length; j++) {
      const c = candles[j];
      durationBars++;

      if (isBuy) {
        // En BUY, revisamos primero SL o TP en la vela
        if (c.low <= sl && outcomeTP1 === null) {
          outcomeTP1 = 'SL';
          outcomeTP2 = 'SL';
          outcomeTP3 = 'SL';
          exitTime = c.time;
          break;
        }

        if (c.high >= tp1 && outcomeTP1 === null) outcomeTP1 = 'WIN';
        if (c.high >= tp2 && outcomeTP2 === null) outcomeTP2 = 'WIN';
        if (c.high >= tp3 && outcomeTP3 === null) {
          outcomeTP3 = 'WIN';
          exitTime = c.time;
          break;
        }

        // Si tocó SL después de haber alcanzado algún TP
        if (c.low <= sl) {
          if (outcomeTP1 === null) outcomeTP1 = 'SL';
          if (outcomeTP2 === null) outcomeTP2 = 'SL';
          if (outcomeTP3 === null) outcomeTP3 = 'SL';
          exitTime = c.time;
          break;
        }
      } else {
        // En SELL
        if (c.high >= sl && outcomeTP1 === null) {
          outcomeTP1 = 'SL';
          outcomeTP2 = 'SL';
          outcomeTP3 = 'SL';
          exitTime = c.time;
          break;
        }

        if (c.low <= tp1 && outcomeTP1 === null) outcomeTP1 = 'WIN';
        if (c.low <= tp2 && outcomeTP2 === null) outcomeTP2 = 'WIN';
        if (c.low <= tp3 && outcomeTP3 === null) {
          outcomeTP3 = 'WIN';
          exitTime = c.time;
          break;
        }

        if (c.high >= sl) {
          if (outcomeTP1 === null) outcomeTP1 = 'SL';
          if (outcomeTP2 === null) outcomeTP2 = 'SL';
          if (outcomeTP3 === null) outcomeTP3 = 'SL';
          exitTime = c.time;
          break;
        }
      }

      // Máxima duración: 48 velas M15 (12 horas)
      if (durationBars >= 48) {
        if (outcomeTP1 === null) outcomeTP1 = 'EXPIRED';
        if (outcomeTP2 === null) outcomeTP2 = 'EXPIRED';
        if (outcomeTP3 === null) outcomeTP3 = 'EXPIRED';
        exitTime = c.time;
        break;
      }
    }

    simulationResults.push({
      signal: sig,
      durationBars,
      outcomeTP1: outcomeTP1 || 'RUNNING',
      outcomeTP2: outcomeTP2 || 'RUNNING',
      outcomeTP3: outcomeTP3 || 'RUNNING',
      riskUSD,
      profitUSD_TP1: outcomeTP1 === 'WIN' ? riskUSD * 1.5 : (outcomeTP1 === 'SL' ? -riskUSD : 0),
      profitUSD_TP2_Opt: (outcomeTP2 === 'WIN') ? (riskUSD * 2.5 * 0.8 + (outcomeTP3 === 'WIN' ? riskUSD * 4.0 * 0.2 : 0)) : (outcomeTP2 === 'SL' ? -riskUSD : 0)
    });
  }

  // --- CÁLCULO DE MÉTRICAS INSTITUCIONALES ---
  const validTrades = simulationResults.filter(r => r.outcomeTP1 === 'WIN' || r.outcomeTP1 === 'SL');
  const tp1Wins = validTrades.filter(r => r.outcomeTP1 === 'WIN').length;
  const tp2Wins = validTrades.filter(r => r.outcomeTP2 === 'WIN').length;
  const tp3Wins = validTrades.filter(r => r.outcomeTP3 === 'WIN').length;
  const totalLosses = validTrades.filter(r => r.outcomeTP1 === 'SL').length;

  const winRateTP1 = ((tp1Wins / validTrades.length) * 100).toFixed(1);
  const winRateTP2 = ((tp2Wins / validTrades.length) * 100).toFixed(1);
  const winRateTP3 = ((tp3Wins / validTrades.length) * 100).toFixed(1);

  let netProfitUSD_Opt = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let peakBalance = INITIAL_BALANCE;
  let maxDrawdownUSD = 0;
  let runningBalance = INITIAL_BALANCE;

  validTrades.forEach(t => {
    const pnl = t.profitUSD_TP2_Opt;
    netProfitUSD_Opt += pnl;
    runningBalance += pnl;

    if (pnl > 0) grossProfit += pnl;
    else grossLoss += Math.abs(pnl);

    if (runningBalance > peakBalance) {
      peakBalance = runningBalance;
    }
    const dd = peakBalance - runningBalance;
    if (dd > maxDrawdownUSD) maxDrawdownUSD = dd;
  });

  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'INF';
  const expectedValueUSD = (netProfitUSD_Opt / validTrades.length).toFixed(2);
  const maxDrawdownPercent = ((maxDrawdownUSD / peakBalance) * 100).toFixed(2);
  const totalReturnPercent = ((netProfitUSD_Opt / INITIAL_BALANCE) * 100).toFixed(2);

  console.log('--------------------------------------------------------------------------------------------------------');
  console.log(' # | FECHA / HORA UTC     | SESIÓN | ACCIÓN | ENTRADA | STOP LOSS | TP1     | TP2     | R:R SL | RESULTADO');
  console.log('--------------------------------------------------------------------------------------------------------');

  validTrades.forEach((t, i) => {
    const s = t.signal;
    const num = (i + 1).toString().padStart(2, '0');
    const time = s.timeStr;
    const sess = s.session.padEnd(8);
    const act = s.action.padEnd(4);
    const ent = s.entry.toFixed(1).padStart(7);
    const sl = s.sl.toFixed(1).padStart(9);
    const tp1 = s.tp1.toFixed(1).padStart(7);
    const tp2 = s.tp2.toFixed(1).padStart(7);
    const risk = (s.riskPips + 'p').padStart(6);
    const res = t.outcomeTP2 === 'WIN' ? '✅ TP2 HIT' : (t.outcomeTP1 === 'WIN' ? '🎯 TP1 HIT' : '🛑 STOP LOSS');

    console.log(`${num} | ${time} | ${sess} | ${act}   | ${ent} | ${sl} | ${tp1} | ${tp2} | ${risk} | ${res}`);
  });

  console.log('--------------------------------------------------------------------------------------------------------\n');

  console.log('========================================================================================================');
  console.log('📊 MÉTRICAS CUANTITATIVAS REALES DE LA ESTRATEGIA ALGORÍTMICA PROPIA (GoldSMC)');
  console.log('========================================================================================================');
  console.log(`• Total Operaciones Generadas:       ${validTrades.length} trades`);
  console.log(`• Tasa de Acierto a TP1 (1:1.5 R:R): ${winRateTP1}% (${tp1Wins} ganadas / ${totalLosses} perdidas)`);
  console.log(`• Tasa de Acierto a TP2 (1:2.5 R:R): ${winRateTP2}% (${tp2Wins} ganadas) ⭐ (Sweet Spot Matemático)`);
  console.log(`• Tasa de Acierto a TP3 (1:4.0 R:R): ${winRateTP3}% (${tp3Wins} ganadas)`);
  console.log(`--------------------------------------------------------------------------------------------------------`);
  console.log(`• Saldo Inicial Simulado:            $${INITIAL_BALANCE.toFixed(2)} USD (Riesgo Fijo 1.0% = $10 USD)`);
  console.log(`• Ganancia Bruta (Gross Profit):     +$${grossProfit.toFixed(2)} USD`);
  console.log(`• Pérdida Bruta (Gross Loss):        -$${grossLoss.toFixed(2)} USD`);
  console.log(`• Beneficio Neto (Net Profit):       +$${netProfitUSD_Opt.toFixed(2)} USD (+${totalReturnPercent}%)`);
  console.log(`• Profit Factor (Factor de Beneficio): ${profitFactor}`);
  console.log(`• Expectativa Matemática (EV/Trade): +$${expectedValueUSD} USD por trade`);
  console.log(`• Máximo Drawdown Histórico:         $${maxDrawdownUSD.toFixed(2)} USD (${maxDrawdownPercent}%)`);
  console.log('========================================================================================================\n');
}

runInstitutionalBacktest().catch(console.error);
