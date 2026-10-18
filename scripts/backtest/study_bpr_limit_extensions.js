const fs = require('fs');
const readline = require('readline');

async function runBprStudy() {
  console.log('=== ESTUDIO CUANTITATIVO: EXTENSIONES Y MFE DE BPRs EN LIMIT 50% ===');
  const csvPath = 'C:/telegram-mtproto/XAUUSD_M15_202001020600_202610011115.csv';
  
  if (!fs.existsSync(csvPath)) {
    console.error('CSV no encontrado:', csvPath);
    return;
  }

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const candles = [];
  let lineCount = 0;

  for await (const line of rl) {
    lineCount++;
    if (lineCount === 1) continue; // header
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    
    // Format: <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE>
    const dt = parts[0] + ' ' + parts[1];
    const o = parseFloat(parts[2]);
    const h = parseFloat(parts[3]);
    const l = parseFloat(parts[4]);
    const c = parseFloat(parts[5]);
    if (!isNaN(o) && !isNaN(h) && !isNaN(l) && !isNaN(c)) {
      candles.push({ dt, o, h, l, c });
    }
  }

  console.log(`Total velas M15 cargadas: ${candles.length} (Enero 2020 a Octubre 2026)`);

  const BARS_SINCE = 10;
  const SL_BUFFER = 1.0; // 1.0$ de aire en Oro
  const bprs = [];

  let lastBearFvg = -1;
  let lastBullFvg = -1;

  for (let i = 2; i < candles.length; i++) {
    const isBearFvg = (candles[i - 2].l - candles[i].h > 0);
    const isBullFvg = (candles[i].l - candles[i - 2].h > 0);

    if (isBearFvg) lastBearFvg = i;
    if (isBullFvg) lastBullFvg = i;

    // 1. Bullish genesis BPR
    if (isBullFvg && lastBearFvg !== -1 && (i - lastBearFvg) <= BARS_SINCE) {
      const bearFvgTop = candles[lastBearFvg - 2].l;
      const bearFvgBtm = candles[lastBearFvg].h;
      const bullFvgTop = candles[i].l;
      const bullFvgBtm = candles[i - 2].h;

      const cLow = Math.max(bearFvgBtm, bullFvgBtm);
      const cHigh = Math.min(bearFvgTop, bullFvgTop);

      if (cHigh > cLow) {
        bprs.push({
          barIdx: i,
          dt: candles[i].dt,
          high: cHigh,
          low: cLow,
          ce50: (cHigh + cLow) / 2.0,
          range: cHigh - cLow
        });
      }
    }

    // 2. Bearish genesis BPR
    if (isBearFvg && lastBullFvg !== -1 && (i - lastBullFvg) <= BARS_SINCE) {
      const bullFvgTop = candles[lastBullFvg].l;
      const bullFvgBtm = candles[lastBullFvg - 2].h;
      const bearFvgTop = candles[i - 2].l;
      const bearFvgBtm = candles[i].h;

      const cLow = Math.max(bullFvgBtm, bearFvgBtm);
      const cHigh = Math.min(bullFvgTop, bearFvgTop);

      if (cHigh > cLow) {
        bprs.push({
          barIdx: i,
          dt: candles[i].dt,
          high: cHigh,
          low: cLow,
          ce50: (cHigh + cLow) / 2.0,
          range: cHigh - cLow
        });
      }
    }
  }

  console.log(`Total BPRs detectados en M15: ${bprs.length}`);

  // Simular la ejecución de órdenes Limit en el CE 50%:
  // Si el precio viene de abajo -> SELL LIMIT en CE50. SL = high + SL_BUFFER.
  // Si el precio viene de arriba -> BUY LIMIT en CE50. SL = low - SL_BUFFER.
  const trades = [];

  for (const bpr of bprs) {
    const startIdx = bpr.barIdx + 1;
    let filled = false;
    let tradeType = null;
    let fillIdx = -1;
    let sl = 0;
    let slDist = 0;

    // Buscar el primer toque al CE50
    for (let k = startIdx; k < Math.min(candles.length, startIdx + 300); k++) {
      const prevC = candles[k - 1].c;
      const curH = candles[k].h;
      const curL = candles[k].l;

      // Llegando desde abajo (subiendo hacia el CE50) -> SELL
      if (prevC < bpr.ce50 && curH >= bpr.ce50) {
        tradeType = 'SELL';
        fillIdx = k;
        sl = bpr.high + SL_BUFFER;
        slDist = sl - bpr.ce50;
        filled = true;
        break;
      }
      // Llegando desde arriba (cayendo hacia el CE50) -> BUY
      else if (prevC > bpr.ce50 && curL <= bpr.ce50) {
        tradeType = 'BUY';
        fillIdx = k;
        sl = bpr.low - SL_BUFFER;
        slDist = bpr.ce50 - sl;
        filled = true;
        break;
      }
    }

    if (!filled || slDist <= 0.1) continue;

    // Evaluar la excursión de precio tras el llenado de la orden Limit
    let maxFavorablePts = 0;
    let stoppedOut = false;
    let maxR = 0;

    for (let m = fillIdx; m < Math.min(candles.length, fillIdx + 500); m++) {
      const c = candles[m];

      if (tradeType === 'SELL') {
        // Stop loss hit?
        if (c.h >= sl) {
          stoppedOut = true;
          break;
        }
        // Favorable excursion
        const favPts = bpr.ce50 - c.l;
        if (favPts > maxFavorablePts) {
          maxFavorablePts = favPts;
        }
      } else {
        // BUY: Stop loss hit?
        if (c.l <= sl) {
          stoppedOut = true;
          break;
        }
        // Favorable excursion
        const favPts = c.h - bpr.ce50;
        if (favPts > maxFavorablePts) {
          maxFavorablePts = favPts;
        }
      }
    }

    maxR = maxFavorablePts / slDist;
    trades.push({
      dt: candles[fillIdx].dt,
      type: tradeType,
      ce50: bpr.ce50,
      slDist,
      maxR
    });
  }

  console.log(`\n===============================================================`);
  console.log(`📊 RESULTADOS DEL ESTUDIO EMPÍRICO DE TRADES A LIMIT EN CE 50%`);
  console.log(`===============================================================`);
  console.log(`Total operaciones simuladas a Limit: ${trades.length}`);

  const rTiers = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30];
  
  console.log(`\n| Nivel R Mínimo | Trades que lo Alcanzan | % de Éxito Acumulado |`);
  console.log(`| :--- | :--- | :--- |`);

  for (const tier of rTiers) {
    const hits = trades.filter(t => t.maxR >= tier).length;
    const pct = ((hits / trades.length) * 100).toFixed(1);
    console.log(`| **1:${tier}** | ${hits} / ${trades.length} | **${pct}%** |`);
  }

  // Análisis de Parciales Sugeridos
  console.log(`\n🎯 Hallazgos para la Estrategia de Parciales:`);
  const hit3R = trades.filter(t => t.maxR >= 3).length;
  const hit5R = trades.filter(t => t.maxR >= 5).length;
  const hit10R = trades.filter(t => t.maxR >= 10).length;
  const hit20R = trades.filter(t => t.maxR >= 20).length;

  console.log(`- 1:3R es alcanzado por el ${((hit3R/trades.length)*100).toFixed(1)}% de las entradas.`);
  console.log(`- 1:5R es alcanzado por el ${((hit5R/trades.length)*100).toFixed(1)}% de las entradas.`);
  console.log(`- 1:10R es alcanzado por el ${((hit10R/trades.length)*100).toFixed(1)}% de las entradas.`);
  console.log(`- 1:20R (Mega Ratios) es alcanzado por el ${((hit20R/trades.length)*100).toFixed(1)}% de las entradas.`);
}

runBprStudy();
