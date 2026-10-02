/**
 * Test Cuantitativo de BPRs (Balanced Price Ranges) en Datos Reales de MT5
 * Extrae la lógica del script de TradingView:
 * 1. Detección de FVG Bajista (low[2] - high > 0)
 * 2. Detección de FVG Alcista (low - high[2] > 0)
 * 3. Solapamiento de ambos dentro de N barras = BPR (Balanced Price Range)
 * 4. Testeo del BPR: ¿Qué porcentaje de veces el precio rebota al retestear la zona?
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M15 = path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv');
const CSV_M5 = path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv');

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
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 3.7
    });
  }

  return candles;
}

function runBPRAudit(candles, timeframeName, barsSince = 10) {
  console.log(`\n========================================================================================`);
  console.log(`🔬 AUDITORÍA CUANTITATIVA DE BPR (BALANCED PRICE RANGE) EN ${timeframeName}`);
  console.log(`========================================================================================`);

  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  let totalBPRs = 0;
  let bullishBPRs = 0;
  let bearishBPRs = 0;

  // 1. Detectar BPRs
  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];

    const isBearishFVG = (c2.low - c0.high) > 0.3; // Al menos 3 pips de gap
    const isBullishFVG = (c0.low - c2.high) > 0.3;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    // Bullish BPR: Hubo un Bearish FVG hace <= barsSince velas y ahora hay un Bullish FVG que solapa
    if (isBullishFVG && (i - lastBearishFVGIdx) <= barsSince && (i - lastBearishFVGIdx) > 0) {
      const bearI = lastBearishFVGIdx;
      const bearTop = candles[bearI - 2].low;
      const bearBottom = candles[bearI].high;

      const bullTop = c0.low;
      const bullBottom = c2.high;

      // Solapamiento
      const combinedLow = Math.max(bearBottom, bullBottom);
      const combinedHigh = Math.min(bearTop, bullTop);

      if (combinedHigh > combinedLow + 0.2) { // Zona de al menos 2 pips
        bprZones.push({
          type: 'BULLISH',
          createdIdx: i,
          top: combinedHigh,
          bottom: combinedLow,
          tested: false,
          bounced: false,
          invalidated: false
        });
        bullishBPRs++;
        totalBPRs++;
      }
    }

    // Bearish BPR: Hubo un Bullish FVG y ahora hay un Bearish FVG que solapa
    if (isBearishFVG && (i - lastBullishFVGIdx) <= barsSince && (i - lastBullishFVGIdx) > 0) {
      const bullI = lastBullishFVGIdx;
      const bullTop = candles[bullI].low;
      const bullBottom = candles[bullI - 2].high;

      const bearTop = c2.low;
      const bearBottom = c0.high;

      const combinedLow = Math.max(bullBottom, bearBottom);
      const combinedHigh = Math.min(bullTop, bearTop);

      if (combinedHigh > combinedLow + 0.2) {
        bprZones.push({
          type: 'BEARISH',
          createdIdx: i,
          top: combinedHigh,
          bottom: combinedLow,
          tested: false,
          bounced: false,
          invalidated: false
        });
        bearishBPRs++;
        totalBPRs++;
      }
    }
  }

  console.log(`📦 BPRs Detectados: ${totalBPRs} (${bullishBPRs} Alcistas / ${bearishBPRs} Bajistas)`);

  // 2. Simular Retesteos de BPR (Entrada al toque del BPR)
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let netPips = 0;
  let grossWon = 0;
  let grossLost = 0;
  let beHits = 0;

  bprZones.forEach(bpr => {
    // Buscar el primer retesteo dentro de las siguientes 40 velas
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 60); k++) {
      const bar = candles[k];
      // Filtro de Sesión Activa de Londres y NY (08:00 a 19:00 broker time)
      if (bar.hour < 8 || bar.hour > 19) continue;

      if (bpr.type === 'BULLISH') {
        // El precio cae hacia la zona BPR para retestearla y deja mecha de rechazo
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.8) {
          const candleRange = bar.high - bar.low;
          if (candleRange <= 0.3) continue;
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < 0.30) continue; // Mecha de rechazo mínima del 30%

          trades++;
          // Entrada en BUY al tocar bpr.top
          const entry = bpr.top;
          const sl = bpr.bottom - 1.5; // SL por debajo del BPR (15 pips de resguardo)
          const slPips = (entry - sl) * 10;
          const tp1 = entry + 3.5; // 35 pips TP1
          const tp2 = entry + 7.0; // 70 pips TP2

          let won = false;
          let pips = 0;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.low <= sl) {
              pips = -slPips - fBar.spreadPips;
              break;
            }
            if (fBar.high >= tp1) {
              won = true;
              pips = 35.0; // Asegura TP1
              if (fBar.high >= tp2) pips = 52.5; // 50% TP1 + 50% TP2 = 52.5p
              break;
            }
          }

          if (pips > 0) { wins++; grossWon += pips; }
          else { losses++; grossLost += Math.abs(pips); }
          netPips += pips;
          break; // Trade resuelto
        }
      } else {
        // Bearish BPR: Precio sube a testear bpr.bottom y deja mecha de rechazo superior
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.8) {
          const candleRange = bar.high - bar.low;
          if (candleRange <= 0.3) continue;
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < 0.30) continue; // Mecha de rechazo mínima del 30%

          trades++;
          const entry = bpr.bottom;
          const sl = bpr.top + 1.5;
          const slPips = (sl - entry) * 10;
          const tp1 = entry - 3.5;
          const tp2 = entry - 7.0;

          let won = false;
          let pips = 0;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.high >= sl) {
              pips = -slPips - fBar.spreadPips;
              break;
            }
            if (fBar.low <= tp1) {
              won = true;
              pips = 35.0;
              if (fBar.low <= tp2) pips = 52.5;
              break;
            }
          }

          if (pips > 0) { wins++; grossWon += pips; }
          else { losses++; grossLost += Math.abs(pips); }
          netPips += pips;
          break;
        }
      }
    }
  });

  const wr = trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0;
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : 'Inf';

  console.log(`📊 RESULTADOS EN RETESTEO DIRECTO:`);
  console.log(`   • Operaciones Retesteadas: ${trades} trades`);
  console.log(`   • Tasa de Acierto (Win Rate): ${wr}% (${wins} Win / ${losses} Loss)`);
  console.log(`   • Pips Netos: ${netPips >= 0 ? '+' : ''}${netPips.toFixed(1)} pips`);
  console.log(`   • Profit Factor: ${pf}`);
  console.log(`========================================================================================\n`);
}

async function main() {
  const candlesM15 = await loadCandles(CSV_M15);
  runBPRAudit(candlesM15, 'XAUUSD M15 (65.000 Velas: 2024-2026)');

  const candlesM5 = await loadCandles(CSV_M5);
  runBPRAudit(candlesM5, 'XAUUSD M5 (100.000 Velas: 2025-2026)');
}

main();
