/**
 * Auditoría Cuantitativa: Estrategia Sniper de Extremos de Subasta (VAL/VAH Sweep)
 * Diseñada específicamente para Retos de Prop Firm (R:R asimétrico 1:3 a 1:5)
 * 
 * Principio:
 * Entrar en el POC da un ratio pobre de 1:1 porque estás en medio del área de valor.
 * Para obtener 1:3 a 1:5 diario, entramos en los EXTREMOS (VAL / VAH):
 * - BUY en VAL tras barrido de liquidez y absorción:
 *   • SL: $2.00 (20 pips) bajo el mínimo del barrido.
 *   • TP1: PoC (+1:2 R:R) -> Cierre parcial 50% + Mover SL a Break-Even ($0 riesgo).
 *   • TP2: VAH o Extensión opuesta (+1:4 a 1:5 R:R) -> 50% restante.
 * - SELL en VAH tras barrido de liquidez y rechazo:
 *   • SL: $2.00 sobre el máximo del barrido.
 *   • TP1: PoC (+1:2 R:R) -> Cierre parcial 50% + BE.
 *   • TP2: VAL o Extensión opuesta (+1:4 a 1:5 R:R) -> 50% restante.
 */

const { fetchFullYearData } = require('./multi_tf_volume_profile_1y');
const { VolumeProfileStrategy } = require('../../core/algorithms/VolumeProfileStrategy');

async function runSniperBacktest() {
  console.log('📡 Descargando datos M15 de 1 año (35.000+ velas)...');
  const candles = await fetchFullYearData('15m', 15 * 60 * 1000);
  console.log(`✅ ${candles.length} velas M15 cargadas.\n`);

  const strategy = new VolumeProfileStrategy({ binSize: 0.50, valueAreaRatio: 0.70 });

  // Agrupar por días
  const days = {};
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dayStr = new Date(c.time).toISOString().split('T')[0];
    if (!days[dayStr]) days[dayStr] = [];
    days[dayStr].push({ ...c, index: i });
  }

  // Evaluamos diferentes multiplicadores de TP2 (1:3, 1:4, 1:5)
  const rrConfigs = [
    { label: 'R:R 1:3 (TP1 en PoC 1:1.5 | TP2 en VAH 1:3)', tp2Multiplier: 1.0, slAir: 1.80 },
    { label: 'R:R 1:4 (TP1 en PoC 1:2.0 | TP2 en Expansión 1:4)', tp2Multiplier: 1.35, slAir: 1.80 },
    { label: 'R:R 1:5 (TP1 en PoC 1:2.0 | TP2 en Expansión 1:5)', tp2Multiplier: 1.70, slAir: 1.80 }
  ];

  console.log('| Configuración Sniper | Operaciones | Ganadas (Full+BE) | Pérdidas (SL) | Win Rate | Beneficio Neto (10k) | Rentabilidad (%) | Max DD (%) | Profit Factor | Tiempo Estimado Fase 1 (10%) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');

  for (const cfg of rrConfigs) {
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

    for (const [dayStr, dayCandles] of Object.entries(days)) {
      const asianCandles = dayCandles.filter(c => {
        const h = new Date(c.time).getUTCHours();
        return h >= 0 && h < 7;
      });

      if (asianCandles.length < 10) continue;

      const profile = strategy.calculateProfile(asianCandles);
      if (!profile) continue;

      const { poc, vah, val } = profile;
      const valueAreaSpan = vah - val;
      if (valueAreaSpan < 4.0 || valueAreaSpan > 18.0) continue;

      // Buscar barridos de extremo en Londres/NY (07:00 - 14:00 UTC)
      let tradedToday = false;

      for (let j = 0; j < dayCandles.length; j++) {
        if (tradedToday) break;
        const c = dayCandles[j];
        const h = new Date(c.time).getUTCHours();
        if (h < 7 || h >= 14) continue;

        // 1. BUY SETUP: Barrido bajo VAL + Reingreso con mecha
        if (c.low < val) {
          const sweepDepth = val - c.low;
          if (sweepDepth >= 0.8 && sweepDepth <= 6.0) {
            // Vela cierra por encima de VAL (absorción)
            if (c.close > val && c.close < poc) {
              const candleRange = Math.max(c.high - c.low, 0.5);
              const lowerWick = Math.min(c.open, c.close) - c.low;
              if ((lowerWick / candleRange) >= 0.20) {
                // Entrada BUY
                const entryPrice = c.close;
                const slPrice = parseFloat((c.low - cfg.slAir).toFixed(2));
                const slDist = entryPrice - slPrice;
                const tp1Price = poc; // PoC como primer parcial
                const baseReward = vah - entryPrice;
                const tp2Price = parseFloat((entryPrice + baseReward * cfg.tp2Multiplier).toFixed(2));

                if (slDist >= 1.2 && slDist <= 3.5 && (tp1Price - entryPrice) >= slDist * 0.8) {
                  const riskUSD = (balance * riskPercent) / 100.0;
                  const lotSize = riskUSD / (slDist * 100.0);

                  let hitTP1 = false;
                  let hitTP2 = false;
                  let hitSL = false;
                  let hitBE = false;

                  for (let k = j + 1; k < Math.min(dayCandles.length, j + 40); k++) {
                    const fc = dayCandles[k];
                    if (!hitTP1 && fc.high >= tp1Price) hitTP1 = true;
                    if (hitTP1 && fc.high >= tp2Price) { hitTP2 = true; break; }
                    const activeSL = hitTP1 ? entryPrice : slPrice;
                    if (fc.low <= activeSL) {
                      if (hitTP1) hitBE = true; else hitSL = true;
                      break;
                    }
                  }

                  let profitUSD = 0;
                  if (hitTP2) {
                    const p1 = (tp1Price - entryPrice) * 100.0 * (lotSize * 0.5);
                    const p2 = (tp2Price - entryPrice) * 100.0 * (lotSize * 0.5);
                    profitUSD = p1 + p2;
                    fullWins++;
                    totalGrossProfit += profitUSD;
                  } else if (hitTP1) {
                    const p1 = (tp1Price - entryPrice) * 100.0 * (lotSize * 0.5);
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

                  tradedToday = true;
                  break;
                }
              }
            }
          }
        }

        // 2. SELL SETUP: Barrido sobre VAH + Reingreso con mecha
        if (!tradedToday && c.high > vah) {
          const sweepDepth = c.high - vah;
          if (sweepDepth >= 0.8 && sweepDepth <= 6.0) {
            if (c.close < vah && c.close > poc) {
              const candleRange = Math.max(c.high - c.low, 0.5);
              const upperWick = c.high - Math.max(c.open, c.close);
              if ((upperWick / candleRange) >= 0.20) {
                const entryPrice = c.close;
                const slPrice = parseFloat((c.high + cfg.slAir).toFixed(2));
                const slDist = slPrice - entryPrice;
                const tp1Price = poc;
                const baseReward = entryPrice - val;
                const tp2Price = parseFloat((entryPrice - baseReward * cfg.tp2Multiplier).toFixed(2));

                if (slDist >= 1.2 && slDist <= 3.5 && (entryPrice - tp1Price) >= slDist * 0.8) {
                  const riskUSD = (balance * riskPercent) / 100.0;
                  const lotSize = riskUSD / (slDist * 100.0);

                  let hitTP1 = false;
                  let hitTP2 = false;
                  let hitSL = false;
                  let hitBE = false;

                  for (let k = j + 1; k < Math.min(dayCandles.length, j + 40); k++) {
                    const fc = dayCandles[k];
                    if (!hitTP1 && fc.low <= tp1Price) hitTP1 = true;
                    if (hitTP1 && fc.low <= tp2Price) { hitTP2 = true; break; }
                    const activeSL = hitTP1 ? entryPrice : slPrice;
                    if (fc.high >= activeSL) {
                      if (hitTP1) hitBE = true; else hitSL = true;
                      break;
                    }
                  }

                  let profitUSD = 0;
                  if (hitTP2) {
                    const p1 = (entryPrice - tp1Price) * 100.0 * (lotSize * 0.5);
                    const p2 = (entryPrice - tp2Price) * 100.0 * (lotSize * 0.5);
                    profitUSD = p1 + p2;
                    fullWins++;
                    totalGrossProfit += profitUSD;
                  } else if (hitTP1) {
                    const p1 = (entryPrice - tp1Price) * 100.0 * (lotSize * 0.5);
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

                  tradedToday = true;
                  break;
                }
              }
            }
          }
        }
      }
    }

    const totalClosed = fullWins + partialWins + totalLosses;
    const winRate = totalClosed > 0 ? (((fullWins + partialWins) / totalClosed) * 100).toFixed(1) : 0;
    const netProfitUSD = balance - initialBalance;
    const netProfitPct = ((netProfitUSD / initialBalance) * 100).toFixed(2);
    const profitFactor = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss).toFixed(2) : 'Inf';

    // Estimación de tiempo para pasar fase 1 (hacer $1,000 USD / +10%)
    const monthlyAvgProfit = netProfitUSD / 12.0;
    const monthsToPass = monthlyAvgProfit > 0 ? (1000.0 / monthlyAvgProfit).toFixed(1) : 'N/A';

    console.log(`| ${cfg.label.padEnd(22)} | ${totalClosed.toString().padEnd(11)} | ${(fullWins + ' Full + ' + partialWins + ' BE').padEnd(17)} | ${totalLosses.toString().padEnd(13)} | ${(winRate + '%').padEnd(8)} | ${('+$' + netProfitUSD.toFixed(2)).padEnd(20)} | ${('+' + netProfitPct + '%').padEnd(16)} | ${(maxDrawdownPct.toFixed(2) + '%').padEnd(10)} | ${profitFactor.padEnd(13)} | ~${monthsToPass} Meses (${(parseFloat(monthsToPass)*30).toFixed(0)} días) |`);
  }
  console.log('\n========================================================================================================\n');
}

runSniperBacktest().catch(console.error);
