/**
 * Backtest Exhaustivo de BPR (Balanced Price Range) en M2 y M3 (Datos Reales de MT5)
 * Archivos:
 * - XAUUSD_M2 (100.000 velas: Marzo 2026 - Septiembre 2026, ~7 meses)
 * - XAUUSD_M3 (100.000 velas: Noviembre 2025 - Septiembre 2026, ~10 meses)
 * 
 * Reglas Institucionales de BPR:
 * 1. FVG Bajista seguido de FVG Alcista (o viceversa) en <= 10 velas.
 * 2. Solapamiento de desequilibrios = Caja BPR.
 * 3. Entrada en retesteo dentro de Sesión de Londres / NY (08:00 a 19:00 broker).
 * 4. Confirmación con mecha de rechazo (>= 25%).
 * 5. Gestión: TP1 (30p) + Auto-BE (20p) + TP2 (60p) con SL ceñido tras la caja BPR (12-15p).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M2 = path.join(__dirname, '..', '..', 'XAUUSD_M2_202603051240_202609291056.csv');
const CSV_M3 = path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv');

async function loadCandles(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const [y, m, d] = parts[0].split('.').map(Number);
    const [h, min, s] = parts[1].split(':').map(Number);
    const timestamp = Date.UTC(y, m - 1, d, h - 2, min, s);

    candles.push({
      dateStr: `${parts[0]} ${parts[1]}`,
      timestamp,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  return candles;
}

function testBPRTimeframe(name, candles, timeframeMonths, minGapUSD = 0.20, barsSince = 10) {
  console.log(`\n========================================================================================`);
  console.log(`🚀 AUDITORÍA BPR EN ${name} (${candles.length.toLocaleString()} VELAS, ~${timeframeMonths} MESES)`);
  console.log(`========================================================================================`);

  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  let totalBPRs = 0;
  let bullCount = 0;
  let bearCount = 0;

  // 1. Detectar BPRs
  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];

    const isBearishFVG = (c2.low - c0.high) >= minGapUSD;
    const isBullishFVG = (c0.low - c2.high) >= minGapUSD;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    // Bullish BPR (Bearish FVG seguido de Bullish FVG solapado)
    if (isBullishFVG && (i - lastBearishFVGIdx) <= barsSince && (i - lastBearishFVGIdx) > 0) {
      const bearI = lastBearishFVGIdx;
      const bearTop = candles[bearI - 2].low;
      const bearBottom = candles[bearI].high;

      const bullTop = c0.low;
      const bullBottom = c2.high;

      const combinedLow = Math.max(bearBottom, bullBottom);
      const combinedHigh = Math.min(bearTop, bullTop);

      if (combinedHigh > combinedLow + 0.15) {
        bprZones.push({
          type: 'BULLISH',
          createdIdx: i,
          top: combinedHigh,
          bottom: combinedLow
        });
        bullCount++;
        totalBPRs++;
      }
    }

    // Bearish BPR (Bullish FVG seguido de Bearish FVG solapado)
    if (isBearishFVG && (i - lastBullishFVGIdx) <= barsSince && (i - lastBullishFVGIdx) > 0) {
      const bullI = lastBullishFVGIdx;
      const bullTop = candles[bullI].low;
      const bullBottom = candles[bullI - 2].high;

      const bearTop = c2.low;
      const bearBottom = c0.high;

      const combinedLow = Math.max(bullBottom, bearBottom);
      const combinedHigh = Math.min(bullTop, bearTop);

      if (combinedHigh > combinedLow + 0.15) {
        bprZones.push({
          type: 'BEARISH',
          createdIdx: i,
          top: combinedHigh,
          bottom: combinedLow
        });
        bearCount++;
        totalBPRs++;
      }
    }
  }

  console.log(`📦 BPRs Detectados en histórico: ${totalBPRs} (${bullCount} Alcistas / ${bearCount} Bajistas)`);

  // 2. Simular Retesteos con 2 Modelos:
  // A: Gestión 50/50 Institucional (TP1: 30p, Auto-BE: 20p, TP2: 60p, SL ceñido a 15p tras caja BPR)
  // B: Gestión 1:2 R:R Fijo (SL tras la caja, TP = 2x SL)

  const res5050 = simulateBPRTrades(candles, bprZones, '50_50', 30.0, 20.0, 60.0);
  const resFixed = simulateBPRTrades(candles, bprZones, 'FIXED_RR', 30.0, 20.0, 60.0);

  printSummary('A. Gestión 50/50 Institucional (TP1 30p + Auto-BE 20p + TP2 60p)', res5050, timeframeMonths);
  printSummary('B. Gestión R:R Fijo 1:2 (SL tras caja BPR + TP 2x Riesgo)', resFixed, timeframeMonths);
}

function simulateBPRTrades(candles, bprZones, mode, tp1Pips, bePips, tp2Pips) {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let beHits = 0;
  let tp2Hits = 0;
  let netPips = 0;
  let grossWon = 0;
  let grossLost = 0;
  let peak = 0;
  let maxDD = 0;
  let lastTradeIdx = -100;

  bprZones.forEach(bpr => {
    // Buscar retesteo en las siguientes 50 velas
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 50); k++) {
      if (k - lastTradeIdx < 4) continue; // Separación mínima

      const bar = candles[k];
      // Solo sesiones activas (08:00 a 19:00 broker time)
      if (bar.hour < 8 || bar.hour > 19) continue;

      const candleRange = bar.high - bar.low;
      if (candleRange <= 0.25) continue;

      if (bpr.type === 'BULLISH') {
        // Retesteo Alcista: Precio toca la parte superior del BPR
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.6) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < 0.25) continue; // Confirmación de rechazo (mecha >= 25%)

          trades++;
          lastTradeIdx = k;
          const entry = bpr.top;
          const sl = bpr.bottom - 1.2; // 12 pips bajo el mínimo del BPR
          const slPips = (entry - sl) * 10;
          const targetTP1 = mode === 'FIXED_RR' ? (slPips * 2.0) : tp1Pips;
          const targetTP2 = mode === 'FIXED_RR' ? (slPips * 3.0) : tp2Pips;

          let won = false;
          let pips = 0;
          let tp1Hit = false;
          let isBE = false;
          let currentSL = sl;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];

            // 1. SL Hit
            if (fBar.low <= currentSL) {
              const diff = (currentSL - entry) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (targetTP1 * 0.5 + diff * 0.5) : diff;
              if (currentSL >= entry) beHits++;
              break;
            }

            // 2. TP1
            if (!tp1Hit && fBar.high >= entry + (targetTP1 * 0.1)) {
              tp1Hit = true;
              currentSL = entry + 0.2; // Mover a BE + comisiones
            }

            // 3. Auto-BE a los 20 pips
            if (!isBE && fBar.high >= entry + (bePips * 0.1)) {
              isBE = true;
              if (currentSL < entry + 0.2) currentSL = entry + 0.2;
            }

            // 4. TP2
            if (fBar.high >= entry + (targetTP2 * 0.1)) {
              won = true;
              tp2Hits++;
              pips = tp1Hit ? (targetTP1 * 0.5 + targetTP2 * 0.5) : targetTP2;
              break;
            }
          }

          if (pips === 0 && tp1Hit) pips = targetTP1 * 0.5;

          if (pips > 0) { wins++; grossWon += pips; }
          else { losses++; grossLost += Math.abs(pips); }
          netPips += pips;
          if (netPips > peak) peak = netPips;
          if (peak - netPips > maxDD) maxDD = peak - netPips;
          break;
        }
      } else {
        // Retesteo Bajista: Precio toca la parte inferior del BPR
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.6) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < 0.25) continue;

          trades++;
          lastTradeIdx = k;
          const entry = bpr.bottom;
          const sl = bpr.top + 1.2;
          const slPips = (sl - entry) * 10;
          const targetTP1 = mode === 'FIXED_RR' ? (slPips * 2.0) : tp1Pips;
          const targetTP2 = mode === 'FIXED_RR' ? (slPips * 3.0) : tp2Pips;

          let won = false;
          let pips = 0;
          let tp1Hit = false;
          let isBE = false;
          let currentSL = sl;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];

            if (fBar.high >= currentSL) {
              const diff = (entry - currentSL) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (targetTP1 * 0.5 + diff * 0.5) : diff;
              if (currentSL <= entry) beHits++;
              break;
            }

            if (!tp1Hit && fBar.low <= entry - (targetTP1 * 0.1)) {
              tp1Hit = true;
              currentSL = entry - 0.2;
            }

            if (!isBE && fBar.low <= entry - (bePips * 0.1)) {
              isBE = true;
              if (currentSL > entry - 0.2) currentSL = entry - 0.2;
            }

            if (fBar.low <= entry - (targetTP2 * 0.1)) {
              won = true;
              tp2Hits++;
              pips = tp1Hit ? (targetTP1 * 0.5 + targetTP2 * 0.5) : targetTP2;
              break;
            }
          }

          if (pips === 0 && tp1Hit) pips = targetTP1 * 0.5;

          if (pips > 0) { wins++; grossWon += pips; }
          else { losses++; grossLost += Math.abs(pips); }
          netPips += pips;
          if (netPips > peak) peak = netPips;
          if (peak - netPips > maxDD) maxDD = peak - netPips;
          break;
        }
      }
    }
  });

  const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0;
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : 'Inf';

  return { trades, wins, losses, winRate, netPips, pf, maxDD, beHits, tp2Hits };
}

function printSummary(label, r, months) {
  const tradesPerMonth = (r.trades / months).toFixed(1);
  const tradesPerDay = (tradesPerMonth / 21).toFixed(1);
  const profitUSD_005 = (r.netPips * 0.5).toFixed(2); // con 0.05 lotes base
  const profitUSD_010 = (r.netPips * 1.0).toFixed(2); // con 0.10 lotes estándar

  console.log(`\n📌 ${label}`);
  console.log(`   -------------------------------------------------------------------------------------`);
  console.log(`   • Total Operaciones:   ${r.trades} trades (~${tradesPerMonth} ops/mes | ~${tradesPerDay} ops/día)`);
  console.log(`   • Tasa de Acierto:     ${r.winRate}% (${r.wins} Win / ${r.losses} Loss | ${r.beHits} salvados en BE)`);
  console.log(`   • TP2 Alcanzados:      ${r.tp2Hits} trades`);
  console.log(`   • Beneficio Neto:      +${r.netPips.toFixed(1)} pips`);
  console.log(`   • Retorno en USD:      +$${profitUSD_005} (0.05L)  |  +$${profitUSD_010} (0.10L)`);
  console.log(`   • Profit Factor:       ${r.pf}`);
  console.log(`   • Drawdown Máximo:     -${r.maxDD.toFixed(1)} pips`);
  console.log(`   -------------------------------------------------------------------------------------`);
}

async function main() {
  // Test en M3 (10 meses, ~100.000 velas)
  console.log('📂 Cargando velas reales de M3...');
  const candlesM3 = await loadCandles(CSV_M3);
  testBPRTimeframe('XAUUSD M3 (3 Minutos)', candlesM3, 10.3, 0.20, 10);

  // Test en M2 (7 meses, ~100.000 velas)
  console.log('\n📂 Cargando velas reales de M2...');
  const candlesM2 = await loadCandles(CSV_M2);
  testBPRTimeframe('XAUUSD M2 (2 Minutos)', candlesM2, 6.8, 0.18, 10);
}

main();
