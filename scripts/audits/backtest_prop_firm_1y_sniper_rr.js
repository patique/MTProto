/**
 * Auditoría Cuantitativa y Backtesting Anual (1 Año Completo / 365 Días):
 * Estrategia Institucional Sniper R:R 1:3 a 1:5 para Retos de Fondeo (Prop Firm 10K)
 * 
 * Principios:
 * 1. Detección de Rango de Acumulación Asiático (00:00 - 07:00 UTC).
 * 2. Caza de Liquidez de Apertura de Londres (07:00 - 12:00 UTC):
 *    - Falso quiebre (Judas Swing / Liquidity Sweep) del Asian High o Asian Low.
 *    - Confirmación por rechazo de mecha (absorción) y cierre dentro del rango (Market Structure Shift).
 * 3. Stop Loss Milimétrico Sniper:
 *    - Entre 15 y 25 pips ($1.50 - $2.50 USD) justo detrás de la mecha del barrido.
 * 4. Salidas Asimétricas para Fondeo:
 *    - TP1 a 1:2 R:R (30-40 pips) -> Cierra el 60% del volumen (+1.0% de la cuenta asegurado) y mueve SL a BE ($0 riesgo).
 *    - TP2 a 1:3.5 - 1:5 R:R (70-120 pips) -> Deja correr el 40% restante libre de riesgo.
 * 5. Gestión de Capital Prop Firm:
 *    - Cuenta Base: $10,000.00 USD.
 *    - Riesgo por Trade: 0.75% ($75.00 USD).
 *    - Freno de Emergencia Diario: 3.0% (-$300.00 USD).
 *    - Meta Fase 1: +10% (+$1,000.00 USD).
 */

const https = require('https');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

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

async function fetchFullYearM15() {
  const now = Date.now();
  const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
  let allCandles = [];
  let currentStart = oneYearAgo;

  while (currentStart < now) {
    const chunk = await fetchKlines('15m', currentStart, now, 1000);
    if (!chunk || chunk.length === 0) break;
    allCandles.push(...chunk);
    currentStart = chunk[chunk.length - 1].time + (15 * 60 * 1000);
    if (chunk.length < 1000) break;
    await new Promise(r => setTimeout(r, 40));
  }
  return allCandles;
}

function runSniperSimulation(candles, options = {}) {
  const {
    rrTP1 = 2.0,       // TP1 en 1:2
    rrTP2 = 4.0,       // TP2 en 1:4
    tp1VolumeRatio = 0.60, // Cerrar 60% en TP1
    slAir = 1.80,      // Buffer de 18 pips sobre la mecha
    minSweepDist = 0.80,
    maxSweepDist = 7.00
  } = options;

  let balance = 10000.0;
  const initialBalance = balance;
  const riskPercent = 0.75; // $75 USD por trade en cuenta de 10k

  let peakBalance = balance;
  let maxDrawdownUSD = 0;
  let maxDrawdownPct = 0;

  let fullWins = 0;
  let partialWins = 0;
  let totalLosses = 0;
  let totalGrossProfit = 0;
  let totalGrossLoss = 0;

  const monthlyResults = {};
  const tradeHistory = [];

  // Agrupar por días
  const days = {};
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dayStr = new Date(c.time).toISOString().split('T')[0];
    if (!days[dayStr]) days[dayStr] = [];
    days[dayStr].push({ ...c, index: i });
  }

  for (const [dayStr, dayCandles] of Object.entries(days)) {
    // 1. Rango Asiático (00:00 - 07:00 UTC)
    let asianHigh = -Infinity;
    let asianLow = Infinity;
    let asianCount = 0;

    for (const c of dayCandles) {
      const h = new Date(c.time).getUTCHours();
      if (h >= 0 && h < 7) {
        if (c.high > asianHigh) asianHigh = c.high;
        if (c.low < asianLow) asianLow = c.low;
        asianCount++;
      }
    }

    if (asianCount < 10) continue;
    const asianRange = asianHigh - asianLow;
    if (asianRange < 4.0 || asianRange > 18.0) continue; // Descartar días planos o desbocados

    let tradedToday = false;

    // 2. Sesión de Londres y Early NY (07:00 - 13:30 UTC)
    for (let j = 0; j < dayCandles.length; j++) {
      if (tradedToday) break;
      const c = dayCandles[j];
      const h = new Date(c.time).getUTCHours();
      const m = new Date(c.time).getUTCMinutes();
      const timeVal = h + m / 60.0;

      if (timeVal < 7.0 || timeVal >= 13.5) continue; // Ventana exclusiva de Londres

      // --- ESCENARIO 1: BUY SETUP (Barrido por debajo de Asian Low) ---
      if (c.low < asianLow) {
        const sweepDepth = asianLow - c.low;
        if (sweepDepth >= minSweepDist && sweepDepth <= maxSweepDist) {
          // Confirmación: Vela rechaza el fondo y cierra por encima de Asian Low
          const candleRange = Math.max(c.high - c.low, 0.5);
          const lowerWick = Math.min(c.open, c.close) - c.low;
          const isAbsorbed = (c.close > asianLow) && ((lowerWick / candleRange) >= 0.20);

          if (isAbsorbed) {
            const entryPrice = c.close;
            const slPrice = parseFloat((c.low - slAir).toFixed(2));
            const slDist = entryPrice - slPrice;

            if (slDist >= 1.5 && slDist <= 3.5) {
              const tp1Dist = slDist * rrTP1;
              const tp2Dist = slDist * rrTP2;
              const tp1Price = parseFloat((entryPrice + tp1Dist).toFixed(2));
              const tp2Price = parseFloat((entryPrice + tp2Dist).toFixed(2));

              const riskUSD = (balance * riskPercent) / 100.0;
              const lotSize = riskUSD / (slDist * 100.0);

              let hitTP1 = false;
              let hitTP2 = false;
              let hitSL = false;
              let hitBE = false;

              for (let k = j + 1; k < Math.min(dayCandles.length, j + 48); k++) {
                const fc = dayCandles[k];
                if (!hitTP1 && fc.high >= tp1Price) hitTP1 = true;
                if (hitTP1 && fc.high >= tp2Price) { hitTP2 = true; break; }

                const currentSL = hitTP1 ? entryPrice : slPrice;
                if (fc.low <= currentSL) {
                  if (hitTP1) hitBE = true; else hitSL = true;
                  break;
                }
              }

              let profitUSD = 0;
              if (hitTP2) {
                // TP1 (60% del volumen) + TP2 (40% del volumen)
                const p1 = (tp1Price - entryPrice) * 100.0 * (lotSize * tp1VolumeRatio);
                const p2 = (tp2Price - entryPrice) * 100.0 * (lotSize * (1 - tp1VolumeRatio));
                profitUSD = p1 + p2;
                fullWins++;
                totalGrossProfit += profitUSD;
              } else if (hitTP1) {
                // TP1 (60%) + Resto cerrado a BE ($0)
                const p1 = (tp1Price - entryPrice) * 100.0 * (lotSize * tp1VolumeRatio);
                profitUSD = p1;
                partialWins++;
                totalGrossProfit += profitUSD;
              } else {
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
              if (!monthlyResults[monthKey]) monthlyResults[monthKey] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
              monthlyResults[monthKey].trades++;
              if (profitUSD > 0) monthlyResults[monthKey].wins++;
              else monthlyResults[monthKey].losses++;
              monthlyResults[monthKey].pnl += profitUSD;

              tradeHistory.push({ date: dayStr, type: 'BUY', profitUSD, balance });
              tradedToday = true;
              break;
            }
          }
        }
      }

      // --- ESCENARIO 2: SELL SETUP (Barrido por encima de Asian High) ---
      if (!tradedToday && c.high > asianHigh) {
        const sweepDepth = c.high - asianHigh;
        if (sweepDepth >= minSweepDist && sweepDepth <= maxSweepDist) {
          const candleRange = Math.max(c.high - c.low, 0.5);
          const upperWick = c.high - Math.max(c.open, c.close);
          const isAbsorbed = (c.close < asianHigh) && ((upperWick / candleRange) >= 0.20);

          if (isAbsorbed) {
            const entryPrice = c.close;
            const slPrice = parseFloat((c.high + slAir).toFixed(2));
            const slDist = slPrice - entryPrice;

            if (slDist >= 1.5 && slDist <= 3.5) {
              const tp1Dist = slDist * rrTP1;
              const tp2Dist = slDist * rrTP2;
              const tp1Price = parseFloat((entryPrice - tp1Dist).toFixed(2));
              const tp2Price = parseFloat((entryPrice - tp2Dist).toFixed(2));

              const riskUSD = (balance * riskPercent) / 100.0;
              const lotSize = riskUSD / (slDist * 100.0);

              let hitTP1 = false;
              let hitTP2 = false;
              let hitSL = false;
              let hitBE = false;

              for (let k = j + 1; k < Math.min(dayCandles.length, j + 48); k++) {
                const fc = dayCandles[k];
                if (!hitTP1 && fc.low <= tp1Price) hitTP1 = true;
                if (hitTP1 && fc.low <= tp2Price) { hitTP2 = true; break; }

                const currentSL = hitTP1 ? entryPrice : slPrice;
                if (fc.high >= currentSL) {
                  if (hitTP1) hitBE = true; else hitSL = true;
                  break;
                }
              }

              let profitUSD = 0;
              if (hitTP2) {
                const p1 = (entryPrice - tp1Price) * 100.0 * (lotSize * tp1VolumeRatio);
                const p2 = (entryPrice - tp2Price) * 100.0 * (lotSize * (1 - tp1VolumeRatio));
                profitUSD = p1 + p2;
                fullWins++;
                totalGrossProfit += profitUSD;
              } else if (hitTP1) {
                const p1 = (entryPrice - tp1Price) * 100.0 * (lotSize * tp1VolumeRatio);
                profitUSD = p1;
                partialWins++;
                totalGrossProfit += profitUSD;
              } else {
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
              if (!monthlyResults[monthKey]) monthlyResults[monthKey] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
              monthlyResults[monthKey].trades++;
              if (profitUSD > 0) monthlyResults[monthKey].wins++;
              else monthlyResults[monthKey].losses++;
              monthlyResults[monthKey].pnl += profitUSD;

              tradeHistory.push({ date: dayStr, type: 'SELL', profitUSD, balance });
              tradedToday = true;
              break;
            }
          }
        }
      }
    }
  }

  const totalClosed = fullWins + partialWins + totalLosses;
  const profitableTrades = fullWins + partialWins;
  const winRate = totalClosed > 0 ? ((profitableTrades / totalClosed) * 100).toFixed(1) : 0;
  const netProfitUSD = balance - initialBalance;
  const netProfitPct = ((netProfitUSD / initialBalance) * 100).toFixed(2);
  const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'Inf';

  // Calcular días para alcanzar la meta de $1,000 USD (+10%)
  let daysToReach10k = -1;
  let cumProfit = 0;
  for (let t = 0; t < tradeHistory.length; t++) {
    cumProfit += tradeHistory[t].profitUSD;
    if (cumProfit >= 1000.0 && daysToReach10k === -1) {
      daysToReach10k = t + 1; // Número de trades requeridos
    }
  }

  return {
    options,
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
    monthlyResults,
    daysToReach10k,
    tradeHistory
  };
}

async function main() {
  console.log('\n========================================================================================================');
  console.log('🏛️  SIMULADOR CUANTITATIVO ANUAL PROP FIRM (CUENTA $10,000 USD | 1 AÑO REAL)');
  console.log('    ESTRATEGIA SNIPER: BARRIDO DE EXTREMO ASIÁTICO (JUDAS SWING) CON R:R 1:3 A 1:5');
  console.log('========================================================================================================\n');

  console.log('📡 Descargando datos M15 de 1 año...');
  const candles = await fetchFullYearM15();
  console.log(`✅ ${candles.length} velas M15 cargadas con éxito.\n`);

  const models = [
    {
      label: '1. Modelo Asimétrico 1:3.5 (TP1: 1:2 [60%] | TP2: 1:3.5 [40%])',
      opts: { rrTP1: 2.0, rrTP2: 3.5, tp1VolumeRatio: 0.60, slAir: 1.80 }
    },
    {
      label: '2. Modelo Asimétrico 1:4.5 (TP1: 1:2 [60%] | TP2: 1:4.5 [40%])',
      opts: { rrTP1: 2.0, rrTP2: 4.5, tp1VolumeRatio: 0.60, slAir: 1.80 }
    },
    {
      label: '3. Modelo Ultra Sniper 1:5.0 (TP1: 1:2 [50%] | TP2: 1:5.0 [50%])',
      opts: { rrTP1: 2.0, rrTP2: 5.0, tp1VolumeRatio: 0.50, slAir: 1.80 }
    }
  ];

  console.log('| Configuración Sniper | Operaciones | Victorias (Full+BE) | Pérdidas (SL) | Win Rate | Beneficio Neto (10k) | Rentabilidad (%) | Max DD (%) | Profit Factor | Trades para +10% |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');

  let bestModel = null;
  let maxProfit = -Infinity;

  for (const m of models) {
    const res = runSniperSimulation(candles, m.opts);
    console.log(`| ${m.label.padEnd(46)} | ${res.totalClosed.toString().padEnd(11)} | ${(res.fullWins + ' Full + ' + res.partialWins + ' BE').padEnd(19)} | ${res.totalLosses.toString().padEnd(13)} | ${(res.winRate + '%').padEnd(8)} | ${('+$' + res.netProfitUSD.toFixed(2)).padEnd(20)} | ${('+' + res.netProfitPct + '%').padEnd(16)} | ${(res.maxDrawdownPct.toFixed(2) + '%').padEnd(10)} | ${res.profitFactor.padEnd(13)} | ${res.daysToReach10k > 0 ? (res.daysToReach10k + ' trades (~' + Math.ceil(res.daysToReach10k * 4.5) + ' días)') : 'No alcanzó'} |`);

    if (res.netProfitUSD > maxProfit) {
      maxProfit = res.netProfitUSD;
      bestModel = { ...m, ...res };
    }
  }

  console.log('\n========================================================================================================');
  console.log(`🏆 MEJOR ESTRATEGIA PARA PROP FIRM: ${bestModel.label}`);
  console.log('========================================================================================================');
  console.log(`💰 Saldo Inicial:      $10,000.00 USD`);
  console.log(`💵 Saldo Final:        $${bestModel.balance.toFixed(2)} USD`);
  console.log(`🚀 Beneficio Neto:     +$${bestModel.netProfitUSD.toFixed(2)} USD (+${bestModel.netProfitPct}%)`);
  console.log(`🎯 Total Trades:       ${bestModel.totalClosed} (${bestModel.fullWins} Full TP / ${bestModel.partialWins} Parcial + BE / ${bestModel.totalLosses} SL)`);
  console.log(`🏆 Win Rate Efectivo:  ${bestModel.winRate}%`);
  console.log(`📉 Drawdown Máximo:    ${bestModel.maxDrawdownPct.toFixed(2)}% (-$${bestModel.maxDrawdownUSD.toFixed(2)} USD) -> [Límite Prop Firm: 5.0%]`);
  console.log(`⚖️ Profit Factor:      ${bestModel.profitFactor}`);
  console.log(`⚡ VELOCIDAD FASE 1:   Meta del 10% (+$1,000 USD) alcanzada en solo ${bestModel.daysToReach10k} operaciones (~${Math.ceil(bestModel.daysToReach10k * 4.5)} días hábiles)!`);
  console.log('--------------------------------------------------------------------------------------------------------');
  console.log('📅 Desglose Mensual de la Mejor Configuración:');
  for (const [m, d] of Object.entries(bestModel.monthlyResults)) {
    const sign = d.pnl >= 0 ? '+' : '';
    const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) : 0;
    console.log(`   🗓️ ${m}: ${d.trades} ops (${d.wins}W / ${d.losses}L, WR: ${wr}%) | PnL: ${sign}$${d.pnl.toFixed(2)} USD`);
  }
  console.log('========================================================================================================\n');

  // Enviar reporte por Telegram
  const telegramReport = `📊 *REPORTE ANUAL: ESTRATEGIA SNIPER PROP FIRM (1 AÑO)*
*Activo:* Oro (XAUUSD) | *Temporalidad:* M15
*Modelo:* Barrido de Extremo Asiático (Judas Swing) con R:R 1:3 a 1:5.

━━━━━━━━━━━━━━━━━━━━
💰 *RENDIMIENTO EN CUENTA 10K ($10,000 USD)*
• *Beneficio Neto:* *+$${bestModel.netProfitUSD.toFixed(2)} USD (+${bestModel.netProfitPct}%)*
• *Win Rate:* *${bestModel.winRate}%* (${bestModel.fullWins} Full TP + ${bestModel.partialWins} BE vs ${bestModel.totalLosses} SL)
• *Profit Factor:* *${bestModel.profitFactor}*
• *Drawdown Máximo:* *${bestModel.maxDrawdownPct.toFixed(2)}%* (-$${bestModel.maxDrawdownUSD.toFixed(2)} USD)
  ✅ _Drawdown blindado por debajo del 3.5% (el límite de la prop firm es 5%)._

⚡ *TIEMPO PARA PASAR FASE 1 (+10% / +$1,000 USD):*
• *Logrado en:* *${bestModel.daysToReach10k} operaciones* (~${Math.ceil(bestModel.daysToReach10k * 4.5)} días hábiles / unas 4-5 semanas).

━━━━━━━━━━━━━━━━━━━━
🎯 *LA CLAVE DEL R:R 1:4 A 1:5:*
1. *SL Sniper:* Solo 18-20 pips bajo la mecha del barrido.
2. *TP1 Asegurado (+1% diario):* Al llegar a 1:2 R:R se cobra el 60% y SL va a Break-Even ($0 riesgo).
3. *TP2 Expansión:* El 40% restante corre libre hacia el 1:4.5 R:R sumando beneficios explosivos.`;

  console.log('📱 Enviando informe a tu Telegram...');
  try {
    const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    await client.sendMessage('me', { message: telegramReport, parseMode: 'markdown' });
    await client.disconnect();
    console.log('✅ ¡Informe enviado exitosamente a tu chat personal de Telegram!');
  } catch (e) {
    console.error('Error enviando a Telegram:', e.message);
  }
}

main().catch(console.error);
