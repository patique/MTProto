/**
 * Auditoría Cuantitativa y Test de Estrés Forense: Portfolio Multi-Activo Sniper
 * Activos: XAUUSD (Oro), EURUSD, GBPUSD, BTCUSDT
 * Estrategia: Connors RSI(7) + Bollinger Bands (2.3σ) M15
 * 
 * OBJETIVOS:
 * 1. Alcanzar alta frecuencia real: 2 a 4 operaciones por día (400 a 700+ ops/año).
 * 2. FORZAR EL FALLO:
 *    - ¿Qué ocurre en Shocks de Correlación del Dólar (DXY), donde caen Oro, Euro y Libra simultáneamente?
 *    - ¿Cuántos trades simultáneos se abren a la vez?
 *    - ¿Cuál es el riesgo máximo permitido por activo antes de quebrar el límite del 5% de la Prop Firm?
 * 3. Crear las 2 versiones solicitadas por el usuario:
 *    - VERSIÓN CONSERVADORA (Para Prop Firms: control obsesivo de DD < 3.5%, Kill-Switch diario).
 *    - VERSIÓN AGRESIVA-RENTABLE (Para Capital Propio: maximizar rentabilidad +50% a +80%+).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchKlines(symbol, interval, startTime, endTime, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          if (!Array.isArray(raw)) return resolve([]);
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
    }).on('error', reject);
  });
}

async function loadOrFetchAsset(symbol) {
  const cacheFile = path.join(__dirname, `cache_${symbol.toLowerCase()}_15m_1y.json`);
  if (fs.existsSync(cacheFile)) {
    console.log(`📦 Cargando ${symbol} desde caché local...`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  console.log(`🌐 Descargando 1 Año de ${symbol} M15 desde Binance (~35.000 velas)...`);
  const now = Date.now();
  const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
  const stepMs = 1000 * 15 * 60 * 1000;
  let allCandles = [];
  let currentStart = oneYearAgo;

  while (currentStart < now) {
    const currentEnd = Math.min(currentStart + stepMs, now);
    try {
      const batch = await fetchKlines(symbol, '15m', currentStart, currentEnd, 1000);
      if (batch.length === 0) break;
      allCandles.push(...batch);
      currentStart = batch[batch.length - 1].time + (15 * 60 * 1000);
      await new Promise(r => setTimeout(r, 60));
    } catch (err) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify(allCandles));
  console.log(`✅ ${symbol}: ${allCandles.length} velas guardadas en caché.`);
  return allCandles;
}

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

// Genera trades para cualquier activo M15
function generateAssetTrades(candles, symbol, config = {}) {
  const {
    rsiPeriod = 7,
    rsiOversold = 16,
    rsiOverbought = 84,
    bbMult = 2.3,
    tpPercent = 0.00075, // 0.075% del precio (ej. en Oro = $1.50, en EURUSD = 8 pips, en BTC = $45)
    slPercent = 0.00125  // 0.125% del precio (R:R 1:0.60 clásico de alta probabilidad)
  } = config;

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

    // Filtro de sesión: Forex/Oro operar de 07 a 19 UTC. Cripto (BTC) puede 24/7 o misma sesión
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
        if (fc.high >= tpPrice) {
          resolved = true;
          isWin = true;
          finalExitPrice = tpPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
        if (fc.low <= slPrice) {
          resolved = true;
          isWin = false;
          finalExitPrice = slPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
      } else {
        if (fc.low <= tpPrice) {
          resolved = true;
          isWin = true;
          finalExitPrice = tpPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
        if (fc.high >= slPrice) {
          resolved = true;
          isWin = false;
          finalExitPrice = slPrice;
          finalExitTime = fc.time;
          exitIdx = j;
          break;
        }
      }
    }

    if (!resolved) {
      const lastC = candles[Math.min(candles.length - 1, i + 32)];
      const diff = signal === 'BUY' ? lastC.close - entryPrice : entryPrice - lastC.close;
      isWin = diff > 0;
      finalExitPrice = lastC.close;
      finalExitTime = lastC.time;
      exitIdx = i + 32;
      resolved = true;
    }

    trades.push({
      symbol,
      type: signal,
      entryTime: c.time,
      exitTime: finalExitTime,
      entryPrice,
      exitPrice: finalExitPrice,
      tpPercent,
      slPercent,
      result: isWin ? 'WIN' : 'LOSS'
    });
    inTrade = true;
  }

  return trades;
}

/**
 * MOTOR DE AUDITORÍA FORENSE DE PORTFOLIO
 */
function runPortfolioStress(allTrades, options = {}) {
  const {
    initialBalance = 10000.0,
    riskPerTradePct = 0.35, // Riesgo por operación en cada activo
    maxOpenTradesSimultaneous = 3, // Límite de operaciones simultáneas abiertas
    maxDailyLossPct = 2.5,
    enforceDailyCap = true,
    usdShockSimulation = false // Simular caída forzada por salto del Dólar (DXY)
  } = options;

  // Ordenar cronológicamente todos los trades
  allTrades.sort((a, b) => a.entryTime - b.entryTime);

  let balance = initialBalance;
  let peak = balance;
  let maxDDUSD = 0;
  let maxDDPct = 0;

  let currentDay = '';
  let dayStartBal = balance;
  let maxDailyDD = 0;
  let dailyLossHit = false;

  let activeTrades = [];
  let maxSimultaneousOpen = 0;
  let maxSimultaneousLosses = 0;
  let worstDayPnl = 0;
  let worstDayStr = '';
  let consecutiveLossesMax = 0;
  let currentConsecLosses = 0;

  const closedHistory = [];

  for (const t of allTrades) {
    const dayStr = new Date(t.entryTime).toISOString().slice(0, 10);

    if (dayStr !== currentDay) {
      if (currentDay !== '') {
        const dayPnl = balance - dayStartBal;
        if (dayPnl < worstDayPnl) {
          worstDayPnl = dayPnl;
          worstDayStr = currentDay;
        }
      }
      currentDay = dayStr;
      dayStartBal = balance;
      dailyLossHit = false;
    }

    if (enforceDailyCap && dailyLossHit) continue;

    // Limpiar trades expirados
    activeTrades = activeTrades.filter(at => at.exitTime > t.entryTime);

    // Comprobar límite de operaciones simultáneas
    if (activeTrades.length >= maxOpenTradesSimultaneous) {
      continue; // Descartar para proteger la cuenta contra sobre-exposición
    }

    activeTrades.push(t);
    if (activeTrades.length > maxSimultaneousOpen) {
      maxSimultaneousOpen = activeTrades.length;
    }

    // Calcular resultado
    const riskUSD = balance * (riskPerTradePct / 100.0);
    // PnL con R:R 1:0.60
    let pnlUSD = 0;

    // Si simulación de shock USD está activada y hay más de 2 pares USD abiertos en compra, forzar pérdida
    let finalResult = t.result;
    if (usdShockSimulation && t.type === 'BUY' && activeTrades.filter(at => at.type === 'BUY').length >= 2) {
      if (Math.random() < 0.25) finalResult = 'LOSS'; // Shock macro adverso
    }

    if (finalResult === 'WIN') {
      pnlUSD = riskUSD * 0.60; // Ganancia de 0.60R
      currentConsecLosses = 0;
    } else {
      pnlUSD = -riskUSD;
      currentConsecLosses++;
      if (currentConsecLosses > consecutiveLossesMax) consecutiveLossesMax = currentConsecLosses;
    }

    balance += pnlUSD;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDDPct) {
      maxDDPct = dd;
      maxDDUSD = peak - balance;
    }

    const currentDailyDD = ((dayStartBal - balance) / dayStartBal) * 100;
    if (currentDailyDD > maxDailyDD) maxDailyDD = currentDailyDD;

    if (currentDailyDD >= maxDailyLossPct) {
      dailyLossHit = true;
    }

    closedHistory.push({ ...t, pnlUSD, balanceAfter: balance });
  }

  const wins = closedHistory.filter(t => t.pnlUSD > 0);
  const losses = closedHistory.filter(t => t.pnlUSD < 0);
  const total = closedHistory.length;
  const wr = total > 0 ? ((wins.length / total) * 100).toFixed(1) : 0;
  const netUSD = balance - initialBalance;
  const grossWin = wins.reduce((s, t) => s + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'Inf';

  return {
    totalTrades: total,
    opsPerDay: (total / 250).toFixed(2),
    wins: wins.length,
    losses: losses.length,
    winRate: wr,
    finalBalance: balance,
    netProfitUSD: netUSD,
    netProfitPct: ((netUSD / initialBalance) * 100).toFixed(2),
    maxDrawdownPct: maxDDPct,
    maxDrawdownUSD: maxDDUSD,
    maxDailyDD,
    worstDayPnl,
    worstDayStr,
    consecutiveLossesMax,
    maxSimultaneousOpen,
    profitFactor: pf
  };
}

async function main() {
  console.log(`========================================================================================================`);
  console.log(`🚀 AUDITORÍA FORENSE Y TEST DE ESTRÉS: PORTFOLIO MULTI-ACTIVO SNIPER M15`);
  console.log(`Activos Auditados: XAUUSD (Oro), EURUSD, GBPUSD, BTCUSDT`);
  console.log(`========================================================================================================\n`);

  const goldCandles = await loadOrFetchAsset('PAXGUSDT');
  const eurusdCandles = await loadOrFetchAsset('EURUSDT');
  const gbpusdCandles = await loadOrFetchAsset('GBPUSDT');
  const btcusdCandles = await loadOrFetchAsset('BTCUSDT');

  const goldTrades = generateAssetTrades(goldCandles, 'XAUUSD', { tpPercent: 0.0006, slPercent: 0.0010 });
  const eurusdTrades = generateAssetTrades(eurusdCandles, 'EURUSD', { tpPercent: 0.0007, slPercent: 0.0011 });
  const gbpusdTrades = generateAssetTrades(gbpusdCandles, 'GBPUSD', { tpPercent: 0.0008, slPercent: 0.0013 });
  const btcTrades = generateAssetTrades(btcusdCandles, 'BTCUSDT', { tpPercent: 0.0010, slPercent: 0.0016 });

  console.log(`\n📊 Operaciones Individuales Generadas en 1 Año:`);
  console.log(`   🥇 XAUUSD (Oro):   ${goldTrades.length} trades | Win Rate: ${((goldTrades.filter(t=>t.result==='WIN').length/goldTrades.length)*100).toFixed(1)}%`);
  console.log(`   💶 EURUSD:         ${eurusdTrades.length} trades | Win Rate: ${((eurusdTrades.filter(t=>t.result==='WIN').length/eurusdTrades.length)*100).toFixed(1)}%`);
  console.log(`   💷 GBPUSD:         ${gbpusdTrades.length} trades | Win Rate: ${((gbpusdTrades.filter(t=>t.result==='WIN').length/gbpusdTrades.length)*100).toFixed(1)}%`);
  console.log(`   🪙 BTCUSDT:        ${btcTrades.length} trades | Win Rate: ${((btcTrades.filter(t=>t.result==='WIN').length/btcTrades.length)*100).toFixed(1)}%`);

  const allTrades = [...goldTrades, ...eurusdTrades, ...gbpusdTrades, ...btcTrades];
  console.log(`\n🎯 TOTAL OPERACIONES EN EL PORTFOLIO: ${allTrades.length} operaciones (~${(allTrades.length/250).toFixed(1)} trades por día hábil)!`);

  const scenarios = [
    // 1. VERSIÓN CONSERVADORA (PROP FIRMS)
    {
      label: '🛡️ 1. PROP FIRM CONSERVADORA (Riesgo 0.35% / trade | Max 2 abiertos | Kill-Switch)',
      opts: { riskPerTradePct: 0.35, maxOpenTradesSimultaneous: 2, maxDailyLossPct: 2.0, enforceDailyCap: true, usdShockSimulation: false }
    },
    {
      label: '🛡️ 2. PROP FIRM MODERADA (Riesgo 0.50% / trade | Max 3 abiertos | Kill-Switch)',
      opts: { riskPerTradePct: 0.50, maxOpenTradesSimultaneous: 3, maxDailyLossPct: 2.5, enforceDailyCap: true, usdShockSimulation: false }
    },
    // TEST DE ESTRÉS / FORZAR EL FALLO
    {
      label: '⚠️ 3. ESTRÉS CORRELACIÓN DÓLAR (Shock DXY simultáneo | Riesgo 0.50%)',
      opts: { riskPerTradePct: 0.50, maxOpenTradesSimultaneous: 4, maxDailyLossPct: 4.0, enforceDailyCap: false, usdShockSimulation: true }
    },
    {
      label: '❌ 4. ESTRÉS RUPTURA PROP (Riesgo 0.85% / trade | Sin límite simultáneos)',
      opts: { riskPerTradePct: 0.85, maxOpenTradesSimultaneous: 5, maxDailyLossPct: 5.0, enforceDailyCap: false, usdShockSimulation: true }
    },
    // VERSIÓN AGRESIVA (CAPITAL PROPIO)
    {
      label: '🚀 5. CAPITAL PROPIO AGRESIVA (Riesgo 1.00% / trade | Max 3 abiertos | Sin Cap Prop)',
      opts: { riskPerTradePct: 1.00, maxOpenTradesSimultaneous: 3, maxDailyLossPct: 10.0, enforceDailyCap: false, usdShockSimulation: false }
    },
    {
      label: '🔥 6. CAPITAL PROPIO ULTRA-PROFIT (Riesgo 1.50% / trade | Rebalanceo Libre)',
      opts: { riskPerTradePct: 1.50, maxOpenTradesSimultaneous: 4, maxDailyLossPct: 15.0, enforceDailyCap: false, usdShockSimulation: false }
    }
  ];

  console.log('\n| Escenario de Auditoría | Trades | Ops/Día | Win Rate | Beneficio Neto (10k) | Rentabilidad | Max DD Total | DD Diario | Peor Día | Racha L | PF |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');

  for (const sc of scenarios) {
    const r = runPortfolioStress(allTrades, sc.opts);
    const sign = r.netProfitUSD >= 0 ? '+' : '';
    console.log(`| ${sc.label.padEnd(52)} | ${r.totalTrades.toString().padEnd(6)} | ${r.opsPerDay.toString().padEnd(7)} | ${(r.winRate + '%').padEnd(8)} | ${(sign + '$' + r.netProfitUSD.toFixed(2)).padEnd(16)} | ${(sign + r.netProfitPct + '%').padEnd(12)} | ${(r.maxDrawdownPct.toFixed(2) + '%').padEnd(12)} | ${(r.maxDailyDD.toFixed(2) + '%').padEnd(9)} | ${('-$' + Math.abs(r.worstDayPnl).toFixed(2)).padEnd(9)} | ${r.consecutiveLossesMax.toString().padEnd(7)} | ${r.profitFactor.padEnd(3)} |`);
  }

  console.log('\n========================================================================================================');
}

main().catch(console.error);
