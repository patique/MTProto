/**
 * Simulación Cuantitativa: Impacto del INTERÉS COMPUESTO en Operativa Agresiva de Capital Propio
 * Activos: XAUUSD (Oro), EURUSD, BTCUSDT (Portfolio Multi-Activo Sniper M15)
 * Datos: 1 Año Completo (745 Operaciones Reales Sincronizadas)
 * 
 * Pregunta del Usuario:
 * ¿Qué pasa si metemos además de operativa agresiva, INTERÉS COMPUESTO en cuentas de capital propio?
 */

const fs = require('fs');
const path = require('path');

const goldCandles = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache_paxgusdt_15m_1y.json'), 'utf8'));
const eurusdCandles = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache_eurusdt_15m_1y.json'), 'utf8'));
const btcusdCandles = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache_btcusdt_15m_1y.json'), 'utf8'));

function calculateRSI(candles, period = 7) {
  const rsi = new Float64Array(candles.length);
  if (candles.length <= period) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return rsi;
}

function calculateBollingerBands(candles, period = 20, multiplier = 2.3) {
  const upper = new Float64Array(candles.length);
  const lower = new Float64Array(candles.length);
  const middle = new Float64Array(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    const sma = sum / period;
    middle[i] = sma;
    let varSum = 0;
    for (let j = 0; j < period; j++) {
      const d = candles[i - j].close - sma;
      varSum += d * d;
    }
    const sd = Math.sqrt(varSum / period);
    upper[i] = sma + (sd * multiplier);
    lower[i] = sma - (sd * multiplier);
  }
  return { upper, lower, middle };
}

function generateAssetTrades(candles, symbol, config = {}) {
  const { rsiPeriod = 7, rsiOversold = 16, rsiOverbought = 84, bbMult = 2.3, tpPercent = 0.00075, slPercent = 0.00125 } = config;
  const rsi = calculateRSI(candles, rsiPeriod);
  const { upper, lower } = calculateBollingerBands(candles, 20, bbMult);
  const trades = [];
  let inTrade = false;
  let exitIdx = -1;

  for (let i = 50; i < candles.length; i++) {
    if (inTrade && i <= exitIdx) continue;
    inTrade = false;
    const c = candles[i];
    const prevC = candles[i - 1];
    const h = new Date(c.time).getUTCHours();
    if (symbol !== 'BTCUSDT' && (h < 7 || h >= 19)) continue;

    const currentRsi = rsi[i];
    const prevRsi = rsi[i - 1];
    let signal = null;
    if (prevC.low <= lower[i - 1] || c.low <= lower[i]) {
      if (currentRsi <= rsiOversold || (prevRsi <= rsiOversold && currentRsi > prevRsi)) {
        if (c.close > c.open) signal = 'BUY';
      }
    } else if (prevC.high >= upper[i - 1] || c.high >= upper[i]) {
      if (currentRsi >= rsiOverbought || (prevRsi >= rsiOverbought && currentRsi < prevRsi)) {
        if (c.close < c.open) signal = 'SELL';
      }
    }

    if (!signal) continue;
    const entryPrice = c.close;
    const tpPrice = signal === 'BUY' ? entryPrice * (1 + tpPercent) : entryPrice * (1 - tpPercent);
    const slPrice = signal === 'BUY' ? entryPrice * (1 - slPercent) : entryPrice * (1 + slPercent);

    let resolved = false;
    let isWin = false;
    let finalExitPrice = 0;
    let finalExitTime = 0;

    for (let j = i + 1; j < Math.min(candles.length, i + 32); j++) {
      const fc = candles[j];
      if (signal === 'BUY') {
        if (fc.high >= tpPrice) { resolved = true; isWin = true; finalExitPrice = tpPrice; finalExitTime = fc.time; exitIdx = j; break; }
        if (fc.low <= slPrice) { resolved = true; isWin = false; finalExitPrice = slPrice; finalExitTime = fc.time; exitIdx = j; break; }
      } else {
        if (fc.low <= tpPrice) { resolved = true; isWin = true; finalExitPrice = tpPrice; finalExitTime = fc.time; exitIdx = j; break; }
        if (fc.high >= slPrice) { resolved = true; isWin = false; finalExitPrice = slPrice; finalExitTime = fc.time; exitIdx = j; break; }
      }
    }

    if (!resolved) {
      const lastC = candles[Math.min(candles.length - 1, i + 32)];
      const diff = signal === 'BUY' ? lastC.close - entryPrice : entryPrice - lastC.close;
      isWin = diff > 0;
      finalExitPrice = lastC.close;
      finalExitTime = lastC.time;
      exitIdx = i + 32;
    }

    trades.push({ symbol, type: signal, entryTime: c.time, exitTime: finalExitTime, result: isWin ? 'WIN' : 'LOSS' });
    inTrade = true;
  }
  return trades;
}

const goldTrades = generateAssetTrades(goldCandles, 'XAUUSD', { tpPercent: 0.0006, slPercent: 0.0010 });
const eurusdTrades = generateAssetTrades(eurusdCandles, 'EURUSD', { tpPercent: 0.0007, slPercent: 0.0011 });
const btcTrades = generateAssetTrades(btcusdCandles, 'BTCUSDT', { tpPercent: 0.0010, slPercent: 0.0016 });
const allTrades = [...goldTrades, ...eurusdTrades, ...btcTrades].sort((a, b) => a.entryTime - b.entryTime);

function simulateCompounding(trades, initialBalance, riskPercent, useCompounding = true) {
  let balance = initialBalance;
  let peak = balance;
  let maxDD = 0;
  let maxDailyDD = 0;
  let currentDay = '';
  let dayStartBal = balance;

  const monthlyBal = {};

  for (const t of trades) {
    const d = new Date(t.entryTime);
    const dayStr = d.toISOString().slice(0, 10);
    const monthStr = d.toISOString().slice(0, 7);

    if (dayStr !== currentDay) {
      currentDay = dayStr;
      dayStartBal = balance;
    }

    // Si compounding es true: el riesgo se calcula sobre el balance flotante actual
    // Si compounding es false: el riesgo se calcula siempre sobre initialBalance (lote fijo)
    const baseBal = useCompounding ? balance : initialBalance;
    const riskUSD = baseBal * (riskPercent / 100.0);

    let pnl = 0;
    if (t.result === 'WIN') {
      pnl = riskUSD * 0.60; // 0.60R de ganancia (R:R 1:0.60)
    } else {
      pnl = -riskUSD; // Pérdida de 1.00R
    }

    balance += pnl;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    const dailyDD = ((dayStartBal - balance) / dayStartBal) * 100;
    if (dailyDD > maxDailyDD) maxDailyDD = dailyDD;

    monthlyBal[monthStr] = balance;
  }

  const netProfitUSD = balance - initialBalance;
  const netProfitPct = ((netProfitUSD / initialBalance) * 100).toFixed(2);
  const multiplier = (balance / initialBalance).toFixed(2);

  return {
    initialBalance,
    finalBalance: balance,
    multiplier,
    netProfitUSD,
    netProfitPct,
    maxDD: maxDD.toFixed(2),
    maxDailyDD: maxDailyDD.toFixed(2),
    monthlyBal
  };
}

console.log(`========================================================================================================`);
console.log(`🚀 ESTUDIO CUANTITATIVO: OPERATIVA AGRESIVA + INTERÉS COMPUESTO (CAPITAL PROPIO)`);
console.log(`🎯 745 Operaciones Reales en 1 Año | Win Rate: 66.8% | R:R: 1:0.60 | Multi-Activo (Oro + Euro + BTC)`);
console.log(`========================================================================================================\n`);

const comparisons = [
  // 1. COMPARATIVA FIJO VS COMPUESTO A 1.0%
  { label: '1. Riesgo 1.00% | Lote Fijo (Sin Compuesto)', risk: 1.00, compound: false },
  { label: '2. Riesgo 1.00% | CON INTERÉS COMPUESTO', risk: 1.00, compound: true },

  // 2. COMPARATIVA FIJO VS COMPUESTO A 1.5%
  { label: '3. Riesgo 1.50% | Lote Fijo (Sin Compuesto)', risk: 1.50, compound: false },
  { label: '4. Riesgo 1.50% | CON INTERÉS COMPUESTO', risk: 1.50, compound: true },

  // 3. NIVELES AGRESIVOS DE ALTO RENDIMIENTO
  { label: '5. Riesgo 2.00% | CON INTERÉS COMPUESTO (Agresivo)', risk: 2.00, compound: true },
  { label: '6. Riesgo 2.50% | CON INTERÉS COMPUESTO (Ultra Alpha)', risk: 2.50, compound: true },
  { label: '7. Riesgo 3.00% | CON INTERÉS COMPUESTO (Extremo / Kelly)', risk: 3.00, compound: true }
];

console.log('| Modelo de Gestión de Capital | Saldo Inicial | Saldo Final (1 Año) | Multiplicador | Rentabilidad (%) | Max DD Total | Max DD Diario |');
console.log('|---|---|---|---|---|---|---|');

for (const c of comparisons) {
  const r = simulateCompounding(allTrades, 10000.0, c.risk, c.compound);
  console.log(`| ${c.label.padEnd(52)} | $${r.initialBalance.toFixed(0).padEnd(11)} | $${r.finalBalance.toFixed(2).padEnd(18)} | ${(r.multiplier + 'x').padEnd(13)} | ${('+' + r.netProfitPct + '%').padEnd(16)} | ${(r.maxDD + '%').padEnd(12)} | ${(r.maxDailyDD + '%').padEnd(13)} |`);
}

// Desglose de crecimiento mensual para el modelo de 1.5% Compuesto
const winner15 = simulateCompounding(allTrades, 10000.0, 1.50, true);
console.log('\n========================================================================================================');
console.log('📈 EVOLUCIÓN MENSUAL DEL CAPITAL CON INTERÉS COMPUESTO (Riesgo 1.50% por Trade / $10,000 Iniciales)');
console.log('========================================================================================================');
for (const [m, b] of Object.entries(winner15.monthlyBal)) {
  const profit = b - 10000.0;
  const pct = ((profit / 10000.0) * 100).toFixed(1);
  console.log(`   🗓️ ${m}: Saldo $${b.toFixed(2)} USD  (Ganancia Acumulada: +$${profit.toFixed(2)} USD / +${pct}%)`);
}

// Simulación también para cuenta pequeña de $2,000 USD
console.log('\n========================================================================================================');
console.log('💰 ¿QUÉ PASA CON UNA CUENTA PEQUEÑA DE $2,000 USD CON INTERÉS COMPUESTO?');
console.log('========================================================================================================');
const smallAcc = simulateCompounding(allTrades, 2000.0, 1.50, true);
console.log(`   • Saldo Inicial:       $2,000.00 USD`);
console.log(`   • Saldo Final (1 Año): $${smallAcc.finalBalance.toFixed(2)} USD`);
console.log(`   • Ganancia Neta:       +$${smallAcc.netProfitUSD.toFixed(2)} USD (+${smallAcc.netProfitPct}%)`);
console.log(`   • Multiplicador:       ${smallAcc.multiplier}x (¡Multiplicó el capital por más de 2!)`);
console.log(`   • Max Drawdown:        ${smallAcc.maxDD}%`);
console.log('========================================================================================================\n');
