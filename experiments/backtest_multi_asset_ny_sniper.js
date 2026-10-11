/**
 * Laboratorio Cuantitativo Multi-Activo: NY Open Daily Range Sniper
 * Activos: XAUUSD, EURUSD, GBPJPY, NAS100, XAGUSD
 * Periodo: 2020 - 2026 (Datos históricos M15 completos)
 */

const fs = require('fs');
const path = require('path');

const ASSETS = [
  {
    symbol: 'XAUUSD',
    file: 'XAUUSD_M15_202001020600_202610011115.csv',
    pipMultiplier: 10.0, // 0.10 = 1 pip
    pipName: 'pips',
    openTime: '15:30:00',
    slFixedLevels: [25, 30, 35, 40],
    defaultBuffer: 5
  },
  {
    symbol: 'EURUSD',
    file: 'EURUSD_M15_202001020600_202610011015.csv',
    pipMultiplier: 10000.0, // 0.0001 = 1 pip
    pipName: 'pips',
    openTime: '15:30:00',
    slFixedLevels: [8, 10, 12, 15],
    defaultBuffer: 2
  },
  {
    symbol: 'GBPJPY',
    file: 'GBPJPY_M15_202001020600_202610011015.csv',
    pipMultiplier: 100.0, // 0.01 = 1 pip
    pipName: 'pips',
    openTime: '15:30:00',
    slFixedLevels: [15, 20, 25, 30],
    defaultBuffer: 4
  },
  {
    symbol: 'NAS100',
    file: 'NAS100_M15_202001010300_202610011015.csv',
    pipMultiplier: 1.0, // 1.00 = 1 pt
    pipName: 'pts',
    openTime: '16:30:00', // Apertura Cash Wall Street (16:30 Server / 09:30 EST)
    slFixedLevels: [30, 45, 60, 80],
    defaultBuffer: 10
  },
  {
    symbol: 'XAGUSD',
    file: 'XAGUSD_M15_202001020600_202610011015.csv',
    pipMultiplier: 100.0, // 0.01 = 1 pip (centavos de plata)
    pipName: 'pips',
    openTime: '15:30:00',
    slFixedLevels: [15, 20, 25, 30],
    defaultBuffer: 3
  }
];

function loadData(filePath, pipMultiplier) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split(/\r?\n/);
  const daysMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length >= 6) {
      const dateStr = parts[0];
      const timeStr = parts[1];
      const open = parseFloat(parts[2]);
      const high = parseFloat(parts[3]);
      const low = parseFloat(parts[4]);
      const close = parseFloat(parts[5]);

      if (!daysMap.has(dateStr)) {
        daysMap.set(dateStr, []);
      }
      daysMap.get(dateStr).push({ dateStr, timeStr, open, high, low, close });
    }
  }

  return { daysMap, dates: Array.from(daysMap.keys()).sort() };
}

function runSimulation(asset, daysMap, dates, options) {
  const {
    nyOpenTime = asset.openTime,
    slMode = 'FIXED_PIPS', // 'CANDLE_EXTREME' | 'FIXED_PIPS'
    fixedSlPips = 30,
    tpMode = 'FIXED_RR',   // 'PREVIOUS_DAY_LEVEL' | 'FIXED_RR'
    fixedRR = 2.0,
    retestDepth = 0.50
  } = options;

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let netPips = 0;
  let grossWinPips = 0;
  let grossLossPips = 0;
  let netR = 0;

  for (let d = 1; d < dates.length; d++) {
    const prevBars = daysMap.get(dates[d - 1]);
    const currBars = daysMap.get(dates[d]);

    if (!prevBars || prevBars.length < 20 || !currBars || currBars.length < 20) continue;

    // Calcular PDH y PDL
    let pdh = -Infinity;
    let pdl = Infinity;
    for (const b of prevBars) {
      if (b.high > pdh) pdh = b.high;
      if (b.low < pdl) pdl = b.low;
    }

    // 1ª vela M15 tras la apertura
    const nyBarIndex = currBars.findIndex(b => b.timeStr === nyOpenTime);
    if (nyBarIndex === -1 || nyBarIndex + 1 >= currBars.length) continue;

    const firstBar = currBars[nyBarIndex];
    const isBullish = firstBar.close > firstBar.open;
    const isBearish = firstBar.close < firstBar.open;

    if (!isBullish && !isBearish) continue;

    const bias = isBullish ? 'BUY' : 'SELL';

    // Nivel de retesteo (50% de la 1ª vela M15)
    const retestLevel = isBullish
      ? (firstBar.low + (firstBar.high - firstBar.low) * (1 - retestDepth))
      : (firstBar.high - (firstBar.high - firstBar.low) * (1 - retestDepth));

    // Determinar SL
    let slPrice = 0;
    let slDistancePips = 0;

    if (slMode === 'CANDLE_EXTREME') {
      const bufferPrice = asset.defaultBuffer / asset.pipMultiplier;
      if (bias === 'BUY') {
        slPrice = firstBar.low - bufferPrice;
        slDistancePips = (retestLevel - slPrice) * asset.pipMultiplier;
      } else {
        slPrice = firstBar.high + bufferPrice;
        slDistancePips = (slPrice - retestLevel) * asset.pipMultiplier;
      }
    } else {
      slDistancePips = fixedSlPips;
      const slDistPrice = fixedSlPips / asset.pipMultiplier;
      slPrice = bias === 'BUY' ? (retestLevel - slDistPrice) : (retestLevel + slDistPrice);
    }

    if (slDistancePips <= 0) continue;

    // Determinar TP
    let tpPrice = 0;
    if (tpMode === 'PREVIOUS_DAY_LEVEL') {
      tpPrice = bias === 'BUY' ? pdh : pdl;
      const targetPips = Math.abs(tpPrice - retestLevel) * asset.pipMultiplier;
      if (targetPips < (slDistancePips * 0.8)) continue; // Descartar si el nivel está demasiado pegado
      if (bias === 'BUY' && firstBar.high >= pdh) continue; // Ya superado
      if (bias === 'SELL' && firstBar.low <= pdl) continue;
    } else {
      const tpDistPrice = (slDistancePips * fixedRR) / asset.pipMultiplier;
      tpPrice = bias === 'BUY' ? (retestLevel + tpDistPrice) : (retestLevel - tpDistPrice);
    }

    // Buscar retesteo y rechazo en las siguientes 12 barras M15 (3 horas)
    let entered = false;
    let entryBarIdx = -1;
    let entryPrice = retestLevel;

    const maxWaitBars = Math.min(currBars.length, nyBarIndex + 12);
    for (let k = nyBarIndex + 1; k < maxWaitBars; k++) {
      const bar = currBars[k];
      if (bias === 'BUY') {
        if (bar.low <= retestLevel && bar.close > slPrice) {
          entered = true;
          entryBarIdx = k;
          break;
        }
      } else {
        if (bar.high >= retestLevel && bar.close < slPrice) {
          entered = true;
          entryBarIdx = k;
          break;
        }
      }
    }

    if (!entered) continue;

    totalTrades++;
    let tradeResult = null;
    let pipsResult = 0;
    let rResult = 0;

    for (let k = entryBarIdx; k < currBars.length; k++) {
      const bar = currBars[k];
      if (bias === 'BUY') {
        if (bar.low <= slPrice) {
          tradeResult = 'LOSS';
          pipsResult = -slDistancePips;
          rResult = -1.0;
          break;
        }
        if (bar.high >= tpPrice) {
          tradeResult = 'WIN';
          pipsResult = Math.abs(tpPrice - entryPrice) * asset.pipMultiplier;
          rResult = pipsResult / slDistancePips;
          break;
        }
      } else {
        if (bar.high >= slPrice) {
          tradeResult = 'LOSS';
          pipsResult = -slDistancePips;
          rResult = -1.0;
          break;
        }
        if (bar.low <= tpPrice) {
          tradeResult = 'WIN';
          pipsResult = Math.abs(entryPrice - tpPrice) * asset.pipMultiplier;
          rResult = pipsResult / slDistancePips;
          break;
        }
      }
    }

    // Cierre de fin de sesión si no tocó SL ni TP
    if (!tradeResult) {
      const lastBar = currBars[currBars.length - 1];
      const diff = bias === 'BUY' ? (lastBar.close - entryPrice) : (entryPrice - lastBar.close);
      pipsResult = diff * asset.pipMultiplier;
      rResult = pipsResult / slDistancePips;
      tradeResult = pipsResult >= 0 ? 'WIN' : 'LOSS';
    }

    netPips += pipsResult;
    netR += rResult;
    if (pipsResult > 0) {
      wins++;
      grossWinPips += pipsResult;
    } else {
      losses++;
      grossLossPips += Math.abs(pipsResult);
    }
  }

  const wr = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const pf = grossLossPips > 0 ? (grossWinPips / grossLossPips) : (grossWinPips > 0 ? 99 : 0);
  const avgR = totalTrades > 0 ? (netR / totalTrades) : 0;

  return {
    totalTrades,
    wins,
    losses,
    wr: wr.toFixed(1) + '%',
    pf: pf.toFixed(2),
    netPips: netPips.toFixed(1),
    netR: (netR >= 0 ? '+' : '') + netR.toFixed(1) + 'R',
    avgR: (avgR >= 0 ? '+' : '') + avgR.toFixed(2) + 'R'
  };
}

console.log('========================================================================================');
console.log('🔬 BACKTEST MULTI-ACTIVO: NY OPEN DAILY RANGE SNIPER (2020 - 2026)');
console.log('========================================================================================\n');

for (const asset of ASSETS) {
  const filePath = path.join(__dirname, '..', asset.file);
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️ Archivo no encontrado para ${asset.symbol}: ${asset.file}`);
    continue;
  }

  console.log(`\n======================================================`);
  console.log(`📊 ANALIZANDO ACTIVO: ${asset.symbol} (Sesión NY: ${asset.openTime})`);
  console.log(`======================================================`);

  const { daysMap, dates } = loadData(filePath, asset.pipMultiplier);
  console.log(`Días cargados: ${dates.length} (${dates[0]} a ${dates[dates.length - 1]})`);

  // Matriz de tests para este activo:
  const tests = [
    // 1. Objetivo PDH / PDL (Regla original solicitada)
    { name: `1. SL Extremo M15 | TP PDH/PDL`, slMode: 'CANDLE_EXTREME', tpMode: 'PREVIOUS_DAY_LEVEL' },
    { name: `2. SL Fijo (${asset.slFixedLevels[1]}${asset.pipName}) | TP PDH/PDL`, slMode: 'FIXED_PIPS', fixedSlPips: asset.slFixedLevels[1], tpMode: 'PREVIOUS_DAY_LEVEL' },
    
    // 2. Objetivos con R:R Fijo (1:1.5 y 1:2.0) a través de SL proporcionales
    { name: `3. SL Extremo M15 | TP R:R 1:1.5`, slMode: 'CANDLE_EXTREME', tpMode: 'FIXED_RR', fixedRR: 1.5 },
    { name: `4. SL Extremo M15 | TP R:R 1:2.0`, slMode: 'CANDLE_EXTREME', tpMode: 'FIXED_RR', fixedRR: 2.0 },
    
    // 3. Proporcional Fixed SLs al R:R 1:2.0
    { name: `5. SL ${asset.slFixedLevels[0]}${asset.pipName} | TP R:R 1:2.0`, slMode: 'FIXED_PIPS', fixedSlPips: asset.slFixedLevels[0], tpMode: 'FIXED_RR', fixedRR: 2.0 },
    { name: `6. SL ${asset.slFixedLevels[1]}${asset.pipName} | TP R:R 1:2.0`, slMode: 'FIXED_PIPS', fixedSlPips: asset.slFixedLevels[1], tpMode: 'FIXED_RR', fixedRR: 2.0 },
    { name: `7. SL ${asset.slFixedLevels[2]}${asset.pipName} | TP R:R 1:2.0`, slMode: 'FIXED_PIPS', fixedSlPips: asset.slFixedLevels[2], tpMode: 'FIXED_RR', fixedRR: 2.0 },
    { name: `8. SL ${asset.slFixedLevels[3]}${asset.pipName} | TP R:R 1:2.0`, slMode: 'FIXED_PIPS', fixedSlPips: asset.slFixedLevels[3], tpMode: 'FIXED_RR', fixedRR: 2.0 },

    // 4. Proporcional Fixed SLs al R:R 1:1.5
    { name: `9. SL ${asset.slFixedLevels[1]}${asset.pipName} | TP R:R 1:1.5`, slMode: 'FIXED_PIPS', fixedSlPips: asset.slFixedLevels[1], tpMode: 'FIXED_RR', fixedRR: 1.5 }
  ];

  console.log('\n| Configuración | Trades | Win Rate | Profit Factor | Resultado Neto | Retorno Total (R) | Exp / Trade |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const t of tests) {
    const res = runSimulation(asset, daysMap, dates, t);
    const sign = parseFloat(res.netPips) >= 0 ? '+' : '';
    console.log(`| **${t.name}** | ${res.totalTrades} | ${res.wr} | ${res.pf} | ${sign}${res.netPips} ${asset.pipName} | **${res.netR}** | ${res.avgR} |`);
  }
}
