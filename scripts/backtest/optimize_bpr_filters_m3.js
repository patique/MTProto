/**
 * Optimización de Filtros Adicionales para BPR en M3 (100.000 Velas Reales de MT5)
 * Explora el impacto de:
 * 1. Filtro de Tendencia (EMA 100 / EMA 200)
 * 2. Filtro RSI (Retroceso con RSI saludable: 35-50 en compras, 50-65 en ventas)
 * 3. Filtro de Rango / Premium vs Discount (Solo comprar en descuento, vender en premium)
 * 4. Filtro de Tamaño del BPR (Cajas de tamaño óptimo vs cajas demasiado pequeñas/grandes)
 * 5. Filtro de Apertura de Sesiones (London Open 08:00-11:30 y NY Open 13:30-17:00)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CSV_M3 = path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv');

async function loadCandlesM3() {
  const fileStream = fs.createReadStream(CSV_M3);
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

  // Precalcular EMA 100 y EMA 200
  let ema100 = candles[0].close;
  let ema200 = candles[0].close;
  const k100 = 2 / (100 + 1);
  const k200 = 2 / (200 + 1);

  // Precalcular RSI 14
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    ema100 = c.close * k100 + ema100 * (1 - k100);
    ema200 = c.close * k200 + ema200 * (1 - k200);
    c.ema100 = ema100;
    c.ema200 = ema200;

    if (i === 0) { c.rsi = 50; continue; }
    const diff = c.close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    if (i <= 14) {
      avgGain += gain / 14;
      avgLoss += loss / 14;
      c.rsi = 50;
    } else {
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      c.rsi = 100 - (100 / (1 + rs));
    }
  }

  return candles;
}

function detectBPRs(candles, minGap = 0.20, barsSince = 10) {
  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];

    const isBearishFVG = (c2.low - c0.high) >= minGap;
    const isBullishFVG = (c0.low - c2.high) >= minGap;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    // Bullish BPR
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
          bottom: combinedLow,
          boxSizePips: (combinedHigh - combinedLow) * 10
        });
      }
    }

    // Bearish BPR
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
          bottom: combinedLow,
          boxSizePips: (combinedHigh - combinedLow) * 10
        });
      }
    }
  }
  return bprZones;
}

function evaluateFilter(name, candles, bprZones, filterFn) {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let netPips = 0;
  let grossWon = 0;
  let grossLost = 0;
  let beHits = 0;
  let maxDD = 0;
  let peak = 0;
  let lastTradeIdx = -100;

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 50); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      // Sesión estándar
      if (bar.hour < 8 || bar.hour > 19) continue;
      const candleRange = bar.high - bar.low;
      if (candleRange <= 0.25) continue;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.6) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < 0.25) continue;

          // APLICAR FILTRO ESPECÍFICO
          if (!filterFn(bar, bpr, 'BUY', candles, k)) continue;

          trades++;
          lastTradeIdx = k;
          const entry = bpr.top;
          const sl = bpr.bottom - 1.2;
          const targetTP1 = 30.0;
          const targetTP2 = 60.0;

          let pips = 0;
          let tp1Hit = false;
          let currentSL = sl;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.low <= currentSL) {
              const diff = (currentSL - entry) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (targetTP1 * 0.5 + diff * 0.5) : diff;
              if (currentSL >= entry) beHits++;
              break;
            }
            if (!tp1Hit && fBar.high >= entry + 3.0) {
              tp1Hit = true;
              currentSL = entry + 0.2;
            }
            if (!tp1Hit && fBar.high >= entry + 2.0) {
              if (currentSL < entry + 0.2) currentSL = entry + 0.2;
            }
            if (fBar.high >= entry + 6.0) {
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
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.6) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < 0.25) continue;

          if (!filterFn(bar, bpr, 'SELL', candles, k)) continue;

          trades++;
          lastTradeIdx = k;
          const entry = bpr.bottom;
          const sl = bpr.top + 1.2;
          const targetTP1 = 30.0;
          const targetTP2 = 60.0;

          let pips = 0;
          let tp1Hit = false;
          let currentSL = sl;

          for (let m = k + 1; m < Math.min(candles.length, k + 80); m++) {
            const fBar = candles[m];
            if (fBar.high >= currentSL) {
              const diff = (entry - currentSL) * 10 - fBar.spreadPips;
              pips = tp1Hit ? (targetTP1 * 0.5 + diff * 0.5) : diff;
              if (currentSL <= entry) beHits++;
              break;
            }
            if (!tp1Hit && fBar.low <= entry - 3.0) {
              tp1Hit = true;
              currentSL = entry - 0.2;
            }
            if (!tp1Hit && fBar.low <= entry - 2.0) {
              if (currentSL > entry - 0.2) currentSL = entry - 0.2;
            }
            if (fBar.low <= entry - 6.0) {
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

  const wr = trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0;
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : 'Inf';
  const opsMonth = (trades / 10.3).toFixed(1);

  return { name, trades, opsMonth, wr, netPips, pf, maxDD };
}

async function runOptimization() {
  console.log('📂 Cargando velas M3 y precalculando indicadores...');
  const candles = await loadCandlesM3();
  console.log(`✅ ${candles.length.toLocaleString()} velas M3 listas.`);

  console.log('⚙️ Extrayendo cajas BPR...');
  const bprZones = detectBPRs(candles, 0.20, 10);
  console.log(`✅ ${bprZones.length} cajas BPR listas.`);

  console.log(`\n========================================================================================================================`);
  console.log(`🔬 BENCHMARK DE FILTROS ADICIONALES PARA BPR EN M3 (XAUUSD, 10.3 MESES)`);
  console.log(`========================================================================================================================\n`);

  const tests = [
    // 0. Base (Sin filtros extra)
    { name: '0. BASE: BPR Puro (Solo Mecha >= 25% y Horario 08-19)', fn: () => true },

    // 1. Filtro Tendencia EMA 100 (Precio sobre/bajo EMA100)
    { name: '1. TENDENCIA: EMA 100 (BUY > EMA100 | SELL < EMA100)', fn: (bar, bpr, action) => {
      return action === 'BUY' ? bar.close > bar.ema100 : bar.close < bar.ema100;
    }},

    // 2. Filtro Tendencia EMA 200 (Mayor rigor direccional)
    { name: '2. TENDENCIA: EMA 200 (BUY > EMA200 | SELL < EMA200)', fn: (bar, bpr, action) => {
      return action === 'BUY' ? bar.close > bar.ema200 : bar.close < bar.ema200;
    }},

    // 3. Filtro RSI Saludable (Evita comprar en sobrecompra >65 o vender en sobreventa <35)
    { name: '3. RSI SALUDABLE: BUY (RSI 30-60) | SELL (RSI 40-70)', fn: (bar, bpr, action) => {
      if (action === 'BUY') return bar.rsi >= 30 && bar.rsi <= 60;
      return bar.rsi >= 40 && bar.rsi <= 70;
    }},

    // 4. Filtro de Tamaño de Caja BPR (Evitar cajas gigantes > 80p o minúsculas < 15p)
    { name: '4. TAMAÑO DE CAJA: BPR entre 15 y 60 pips de amplitud', fn: (bar, bpr) => {
      return bpr.boxSizePips >= 15 && bpr.boxSizePips <= 60;
    }},

    // 5. Horas Punta Institucionales (08:30-11:30 Londres y 13:30-17:00 Nueva York)
    { name: '5. VENTANA KILLZONES: Londres (08:30-11:30) y NY (13:30-17:00)', fn: (bar) => {
      const minOfDay = bar.hour * 60 + bar.minute;
      const isLondonKZ = minOfDay >= (8 * 60 + 30) && minOfDay <= (11 * 60 + 30);
      const isNYKZ = minOfDay >= (13 * 60 + 30) && minOfDay <= (17 * 60);
      return isLondonKZ || isNYKZ;
    }},

    // 6. COMBO MAESTRO: Tendencia EMA 100 + RSI Saludable + Tamaño de Caja
    { name: '6. COMBO INSTITUCIONAL: EMA 100 + RSI Saludable + Caja 15-60p', fn: (bar, bpr, action) => {
      const trendOk = action === 'BUY' ? bar.close > bar.ema100 : bar.close < bar.ema100;
      const rsiOk = action === 'BUY' ? (bar.rsi >= 30 && bar.rsi <= 62) : (bar.rsi >= 38 && bar.rsi <= 70);
      const boxOk = bpr.boxSizePips >= 15 && bpr.boxSizePips <= 60;
      return trendOk && rsiOk && boxOk;
    }},

    // 7. COMBO FRANCOTIRADOR (SNIPER): Killzones + EMA 100 + RSI Saludable
    { name: '7. COMBO SNIPER: Killzones Londres/NY + EMA 100 + RSI Saludable', fn: (bar, bpr, action) => {
      const minOfDay = bar.hour * 60 + bar.minute;
      const isLondonKZ = minOfDay >= (8 * 60 + 30) && minOfDay <= (11 * 60 + 30);
      const isNYKZ = minOfDay >= (13 * 60 + 30) && minOfDay <= (17 * 60);
      const trendOk = action === 'BUY' ? bar.close > bar.ema100 : bar.close < bar.ema100;
      const rsiOk = action === 'BUY' ? (bar.rsi >= 30 && bar.rsi <= 62) : (bar.rsi >= 38 && bar.rsi <= 70);
      return (isLondonKZ || isNYKZ) && trendOk && rsiOk;
    }}
  ];

  console.log(`${'Filtro Evaluado'.padEnd(52)} | ${'Trades'.padStart(6)} | ${'Ops/Mes'.padStart(7)} | ${'WinRate'.padStart(8)} | ${'Pips Netos'.padStart(12)} | ${'PF'.padStart(5)} | ${'MaxDD'.padStart(10)}`);
  console.log('-'.repeat(115));

  tests.forEach(t => {
    const res = evaluateFilter(t.name, candles, bprZones, t.fn);
    console.log(`${res.name.padEnd(52)} | ${String(res.trades).padStart(6)} | ${String(res.opsMonth).padStart(7)} | ${(res.wr + '%').padStart(8)} | ${(res.netPips >= 0 ? '+' : '') + res.netPips.toFixed(1).padStart(10)}p | ${res.pf.padStart(5)} | ${('-' + res.maxDD.toFixed(1) + 'p').padStart(10)}`);
  });

  console.log('========================================================================================================================\n');
}

runOptimization();
