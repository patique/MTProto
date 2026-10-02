/**
 * Auditoría Cuantitativa Anual (1 Año Completo / 365 Días):
 * Estrategia de Perfil de Volumen por Sesiones (SVP - PoC Limit + Parciales + Expansión)
 * 
 * Estudio Multi-Temporalidad: M15 vs M30 vs H1
 * 
 * Reglas Optimizadas:
 * 1. Construcción del Perfil de Volumen en Sesión Asiática (00:00 - 07:00 UTC).
 * 2. Filtro de Rango Mínimo: Amplitud de Value Area (VAH - VAL) >= $4.00 USD.
 * 3. Filtro de Tendencia Macro: EMA 100 de la temporalidad analizada.
 * 4. Gestión de Órdenes Límite:
 *    • BUY LIMIT en el PoC (si precio > PoC y precio > EMA 100).
 *      SL: VAL - $1.50 USD (15 pips de aire).
 *    • SELL LIMIT en el PoC (si precio < PoC y precio < EMA 100).
 *      SL: VAH + $1.50 USD (15 pips de aire).
 * 5. Salidas Asimétricas Institucionales (50/50):
 *    • TP1: Al alcanzar VAH/VAL exacto, se liquida el 50% de la posición y el SL va a Break-Even.
 *    • TP2: El 50% restante busca la Expansión 1.5x del Área de Valor.
 * 6. Gestión de Capital Prop Firm:
 *    • Saldo Inicial: $5,000.00 USD.
 *    • Riesgo Fijo por Operación: 0.75% ($37.50 USD).
 */

const https = require('https');
const { VolumeProfileStrategy } = require('../../core/algorithms/VolumeProfileStrategy');

function fetchKlines(interval, startTime, endTime, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
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

async function fetchFullYearData(interval, stepMs) {
  const now = Date.now();
  const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
  let allCandles = [];
  let currentStart = oneYearAgo;

  while (currentStart < now) {
    const chunk = await fetchKlines(interval, currentStart, now, 1000);
    if (!chunk || chunk.length === 0) break;
    allCandles.push(...chunk);
    currentStart = chunk[chunk.length - 1].time + stepMs;
    if (chunk.length < 1000) break;
    await new Promise(r => setTimeout(r, 60));
  }
  return allCandles;
}

function calculateEMA(candles, period = 100) {
  const ema = new Float64Array(candles.length);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, candles.length); i++) sum += candles[i].close;
  let prevEma = sum / Math.min(period, candles.length);
  ema[Math.min(period, candles.length) - 1] = prevEma;
  for (let i = period; i < candles.length; i++) {
    prevEma = (candles[i].close - prevEma) * k + prevEma;
    ema[i] = prevEma;
  }
  return ema;
}

function runSimulation(candles, timeframeLabel, options = {}) {
  const {
    slAir = 1.50,
    minAreaSpan = 4.0,
    tp2Extension = 1.5,
    emaPeriod = 100
  } = options;

  const strategy = new VolumeProfileStrategy({ binSize: 0.50, valueAreaRatio: 0.70 });
  const emaValues = calculateEMA(candles, emaPeriod);

  let balance = 5000.0;
  const initialBalance = balance;
  const riskPercent = options.riskPercent || 0.75; // Porcentaje de riesgo configurable

  let peakBalance = balance;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  let totalLimitPlaced = 0;
  let totalLimitFilled = 0;
  let fullWins = 0; // Tocaron TP1 y TP2
  let partialWins = 0; // Tocaron TP1 y salieron a Break-Even
  let totalLosses = 0; // Tocaron SL directo
  let totalGrossProfit = 0;
  let totalGrossLoss = 0;

  const monthlyResults = {};

  // Agrupar por días
  const days = {};
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dayStr = new Date(c.time).toISOString().split('T')[0];
    if (!days[dayStr]) days[dayStr] = [];
    days[dayStr].push({ ...c, index: i });
  }

  for (const [dayStr, dayCandles] of Object.entries(days)) {
    // 1. Filtrar sesión asiática (00:00 - 07:00 UTC)
    const asianCandles = dayCandles.filter(c => {
      const h = new Date(c.time).getUTCHours();
      return h >= 0 && h < 7;
    });

    if (asianCandles.length < 3) continue;

    const profile = strategy.calculateProfile(asianCandles);
    if (!profile) continue;

    const { poc, vah, val } = profile;
    const valueAreaSpan = vah - val;
    if (valueAreaSpan < minAreaSpan) continue; // Descartar días planos
    if (options.maxAreaSpan && valueAreaSpan > options.maxAreaSpan) continue; // Descartar Asia sobredimensionada

    // 2. Vela de apertura de Londres (07:00 UTC)
    const londonOpenCandle = dayCandles.find(c => new Date(c.time).getUTCHours() === 7);
    if (!londonOpenCandle) continue;

    const currentEma = emaValues[londonOpenCandle.index];
    let orderType = null;
    let limitPrice = poc;
    let slPrice = 0;
    let tp1Price = 0;
    let tp2Price = 0;

    if (londonOpenCandle.close >= poc && londonOpenCandle.close >= currentEma) {
      // BUY LIMIT alineado con tendencia alcista
      orderType = 'BUY_LIMIT';
      slPrice = parseFloat((val - slAir).toFixed(2));
      tp1Price = vah;
      const baseSpan = vah - poc;
      tp2Price = parseFloat((poc + baseSpan * tp2Extension).toFixed(2));
    } else if (londonOpenCandle.close < poc && londonOpenCandle.close < currentEma) {
      // SELL LIMIT alineado con tendencia bajista
      orderType = 'SELL_LIMIT';
      slPrice = parseFloat((vah + slAir).toFixed(2));
      tp1Price = val;
      const baseSpan = poc - val;
      tp2Price = parseFloat((poc - baseSpan * tp2Extension).toFixed(2));
    } else {
      // No alineado con tendencia -> Descartar
      continue;
    }

    const slDistance = Math.abs(limitPrice - slPrice);
    if (slDistance <= 0) continue;

    totalLimitPlaced++;

    const localStartIdx = dayCandles.findIndex(c => c.index === londonOpenCandle.index);
    if (localStartIdx < 0) continue;

    let filled = false;
    let fillIndex = -1;

    // Buscar si se activa durante Londres/NY (07:00 - 20:00 UTC)
    for (let j = localStartIdx + 1; j < dayCandles.length; j++) {
      const c = dayCandles[j];
      const h = new Date(c.time).getUTCHours();
      if (h >= (options.maxFillHour || 21)) break;

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
    totalLimitFilled++;

    const riskUSD = (balance * riskPercent) / 100.0;
    const lotSize = riskUSD / (slDistance * 100.0);

    let hitTP1 = false;
    let hitTP2 = false;
    let hitSL = false;
    let hitBE = false;

    // Recorrer velas futuras hasta resolver
    for (let k = fillIndex + 1; k < Math.min(candles.length, fillIndex + 60); k++) {
      const c = candles[k];

      if (orderType === 'BUY_LIMIT') {
        // Comprobar TP1 (VAH)
        if (!hitTP1 && c.high >= tp1Price) {
          hitTP1 = true;
        }

        // Comprobar TP2 (Expansión)
        if (hitTP1 && c.high >= tp2Price) {
          hitTP2 = true;
          break;
        }

        // Comprobar Stop Loss o Break-Even
        const activeSL = hitTP1 ? limitPrice : slPrice;
        if (c.low <= activeSL) {
          if (hitTP1) hitBE = true;
          else hitSL = true;
          break;
        }
      } else {
        // SELL_LIMIT
        if (!hitTP1 && c.low <= tp1Price) {
          hitTP1 = true;
        }

        if (hitTP1 && c.low <= tp2Price) {
          hitTP2 = true;
          break;
        }

        const activeSL = hitTP1 ? limitPrice : slPrice;
        if (c.high >= activeSL) {
          if (hitTP1) hitBE = true;
          else hitSL = true;
          break;
        }
      }
    }

    let profitUSD = 0;
    if (hitTP2) {
      // 50% liquidado en TP1 + 50% en TP2
      const p1 = (Math.abs(tp1Price - limitPrice) * 100.0) * (lotSize * 0.5);
      const p2 = (Math.abs(tp2Price - limitPrice) * 100.0) * (lotSize * 0.5);
      profitUSD = p1 + p2;
      fullWins++;
      totalGrossProfit += profitUSD;
    } else if (hitTP1 && hitBE) {
      // 50% en TP1 + 50% en BE ($0)
      const p1 = (Math.abs(tp1Price - limitPrice) * 100.0) * (lotSize * 0.5);
      profitUSD = p1;
      partialWins++;
      totalGrossProfit += profitUSD;
    } else if (hitTP1) {
      // Cerrado al final de sesión con TP1 asegurado
      const p1 = (Math.abs(tp1Price - limitPrice) * 100.0) * (lotSize * 0.5);
      profitUSD = p1;
      partialWins++;
      totalGrossProfit += profitUSD;
    } else {
      // SL directo
      profitUSD = -riskUSD;
      totalLosses++;
      totalGrossLoss += Math.abs(profitUSD);
    }

    balance += profitUSD;
    if (balance > peakBalance) peakBalance = balance;
    const currentDD = peakBalance - balance;
    const currentDDPct = (currentDD / peakBalance) * 100.0;
    if (currentDD > maxDrawdownUSD) maxDrawdownUSD = currentDD;
    if (currentDDPct > maxDrawdownPct) maxDrawdownPct = currentDDPct;

    const monthKey = dayStr.slice(0, 7);
    if (!monthlyResults[monthKey]) {
      monthlyResults[monthKey] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    }
    monthlyResults[monthKey].trades++;
    if (profitUSD > 0) monthlyResults[monthKey].wins++;
    else monthlyResults[monthKey].losses++;
    monthlyResults[monthKey].pnl += profitUSD;
  }

  const totalClosed = fullWins + partialWins + totalLosses;
  const profitableTrades = fullWins + partialWins;
  const winRate = totalClosed > 0 ? ((profitableTrades / totalClosed) * 100).toFixed(1) : 0;
  const netProfitUSD = balance - initialBalance;
  const netProfitPct = ((netProfitUSD / initialBalance) * 100).toFixed(2);
  const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'Inf';

  return {
    timeframe: timeframeLabel,
    totalLimitPlaced,
    totalLimitFilled,
    fillRate: totalLimitPlaced > 0 ? ((totalLimitFilled / totalLimitPlaced) * 100).toFixed(1) : 0,
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
    monthlyResults
  };
}

async function main() {
  console.log('\n========================================================================================================');
  console.log('🏛️  ESTUDIO ANUAL COMPLETO (1 AÑO / 365 DÍAS) - COMPARATIVA MULTI-TEMPORALIDAD');
  console.log('    ESTRATEGIA OPTIMIZADA: POC LIMIT + PARCIALES 50/50 + EXPANSIÓN 1.5x + FILTRO TENDENCIA');
  console.log('========================================================================================================\n');

  console.log('📥 [1/3] Descargando histórico M15 de 1 año (35.000+ velas)...');
  const candlesM15 = await fetchFullYearData('15m', 15 * 60 * 1000);
  console.log(`       ✅ ${candlesM15.length} velas M15 cargadas.`);

  console.log('📥 [2/3] Descargando histórico M30 de 1 año (17.500+ velas)...');
  const candlesM30 = await fetchFullYearData('30m', 30 * 60 * 1000);
  console.log(`       ✅ ${candlesM30.length} velas M30 cargadas.`);

  console.log('📥 [3/3] Descargando histórico H1 de 1 año (8.700+ velas)...');
  const candlesH1 = await fetchFullYearData('1h', 60 * 60 * 1000);
  console.log(`       ✅ ${candlesH1.length} velas H1 cargadas.\n`);

  console.log('========================================================================================================');
  console.log('📊 RESULTADOS COMPARATIVOS ANUALES POR TEMPORALIDAD (Cuenta $5,000 USD | Riesgo 0.75%)');
  console.log('========================================================================================================');
  console.log('| Temporalidad | Límites | Llenados | Tasa Llenado | Wins Totales (Full+BE) | Losses | Win Rate | Beneficio Neto ($) | Beneficio (%) | Max DD (%) | Profit Factor |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');

  const tfDatasets = [
    { label: 'M15 (15 Minutos)', candles: candlesM15 },
    { label: 'M30 (30 Minutos)', candles: candlesM30 },
    { label: 'H1  (1 Hora)',     candles: candlesH1 }
  ];

  const results = [];

  for (const item of tfDatasets) {
    const res = runSimulation(item.candles, item.label, {
      slAir: 1.50,
      minAreaSpan: 4.0,
      tp2Extension: 1.5,
      emaPeriod: 100
    });
    results.push(res);
    const sign = res.netProfitUSD >= 0 ? '+' : '';
    console.log(`| ${res.timeframe.padEnd(16)} | ${res.totalLimitPlaced.toString().padEnd(7)} | ${res.totalLimitFilled.toString().padEnd(8)} | ${(res.fillRate + '%').padEnd(12)} | ${(res.fullWins + ' Full + ' + res.partialWins + ' BE').padEnd(22)} | ${res.totalLosses.toString().padEnd(6)} | ${(res.winRate + '%').padEnd(8)} | ${(sign + '$' + res.netProfitUSD.toFixed(2)).padEnd(18)} | ${(sign + res.netProfitPct + '%').padEnd(13)} | ${(res.maxDrawdownPct.toFixed(2) + '%').padEnd(10)} | ${res.profitFactor} |`);
  }

  console.log('\n========================================================================================================');
  console.log('📅 DESGLOSE MENSUAL DETALLADO DE CADA TEMPORALIDAD:');
  console.log('========================================================================================================');

  for (const r of results) {
    console.log(`\n📌 [${r.timeframe}] - Rendimiento Mensual:`);
    let greenMonths = 0;
    let redMonths = 0;
    for (const [m, d] of Object.entries(r.monthlyResults)) {
      const sign = d.pnl >= 0 ? '+' : '';
      if (d.pnl >= 0) greenMonths++; else redMonths++;
      const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) : 0;
      console.log(`   🗓️ ${m}: ${d.trades} ops (${d.wins}W / ${d.losses}L, WR: ${wr}%) | PnL: ${sign}$${d.pnl.toFixed(2)} USD`);
    }
    console.log(`   🏆 Consistencia: ${greenMonths} meses positivos / ${redMonths} meses negativos.`);
  }

  console.log('\n========================================================================================================\n');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  fetchFullYearData,
  runSimulation
};
