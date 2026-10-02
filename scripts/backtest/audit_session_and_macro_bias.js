/**
 * Auditoría Cuantitativa Rigurosa:
 * 1. IMPACTO DE SESIÓN: 24h vs Solo Londres/NY (07:00-18:00 UTC) vs Noche Asiática (22:00-07:00 UTC)
 * 2. IMPACTO DE SESGO MACRO: Sin Filtro Macro vs Filtro HTF M15/H1 EMA 100
 * 
 * Evaluado en todas las temporalidades: M2, M3, M5, M15 con datos reales de broker y spread.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILES = {
  M2:  path.join(__dirname, '..', '..', 'XAUUSD_M2_202603051240_202609291056.csv'),
  M3:  path.join(__dirname, '..', '..', 'XAUUSD_M3_202511201233_202609291057.csv'),
  M5:  path.join(__dirname, '..', '..', 'XAUUSD_M5_202504291430_202609291055.csv'),
  M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202401020100_202609291045.csv')
};

const TF_CONFIG = {
  M2:  { tfMinutes: 2,  minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0,  autoBe: 18.0, minRange: 0.22, minWickRatio: 0.25 },
  M3:  { tfMinutes: 3,  minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0,  autoBe: 20.0, minRange: 0.25, minWickRatio: 0.25 },
  M5:  { tfMinutes: 5,  minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0,  autoBe: 25.0, minRange: 0.35, minWickRatio: 0.25 },
  M15: { tfMinutes: 15, minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60, minWickRatio: 0.25 }
};

async function loadCandles(filePath) {
  if (!fs.existsSync(filePath)) return [];
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
    const timeMs = new Date(Date.UTC(y, m - 1, d, h, min, s)).getTime();

    candles.push({
      dateStr: parts[0],
      timeStr: parts[1],
      fullDate: `${parts[0]} ${parts[1]}`,
      timeMs,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPips: parts.length >= 9 ? parseFloat(parts[8]) / 10.0 : 4.4
    });
  }

  if (candles.length > 0) {
    let ema100 = candles[0].close;
    const k100 = 2 / (100 + 1);
    candles.forEach(c => {
      ema100 = c.close * k100 + ema100 * (1 - k100);
      c.ema100 = ema100;
    });
  }

  return candles;
}

// Construye velas H1 a partir de M15 para calcular EMA 100 de H1
function buildH1Candles(m15Candles) {
  const h1Bars = [];
  let currentH1 = null;

  m15Candles.forEach(c => {
    const h1StartHour = c.hour;
    const h1DateStr = c.dateStr;
    const key = `${h1DateStr}_${h1StartHour}`;

    if (!currentH1 || currentH1.key !== key) {
      if (currentH1) h1Bars.push(currentH1);
      currentH1 = {
        key,
        dateStr: c.dateStr,
        hour: c.hour,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        timeMs: c.timeMs
      };
    } else {
      currentH1.high = Math.max(currentH1.high, c.high);
      currentH1.low = Math.min(currentH1.low, c.low);
      currentH1.close = c.close;
    }
  });
  if (currentH1) h1Bars.push(currentH1);

  // EMA 100 de H1
  if (h1Bars.length > 0) {
    let ema = h1Bars[0].close;
    const k = 2 / (100 + 1);
    h1Bars.forEach(b => {
      ema = b.close * k + ema * (1 - k);
      b.ema100 = ema;
    });
  }

  return h1Bars;
}

function findBprZones(candles, cfg) {
  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    if (isBullishFVG && (i - lastBearishFVGIdx) <= 10 && (i - lastBearishFVGIdx) > 0) {
      const bearTop = candles[lastBearishFVGIdx - 2].low;
      const bearBottom = candles[lastBearishFVGIdx].high;
      const bullTop = c0.low;
      const bullBottom = c2.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);
      if (cHigh > cLow + cfg.minOverlap) {
        bprZones.push({ type: 'BULLISH', createdIdx: i, top: cHigh, bottom: cLow, timeMs: c0.timeMs });
      }
    }

    if (isBearishFVG && (i - lastBullishFVGIdx) <= 10 && (i - lastBullishFVGIdx) > 0) {
      const bullTop = candles[lastBullishFVGIdx].low;
      const bullBottom = candles[lastBullishFVGIdx - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const cLow = Math.max(bullBottom, bearBottom);
      const cHigh = Math.min(bullTop, bearTop);
      if (cHigh > cLow + cfg.minOverlap) {
        bprZones.push({ type: 'BEARISH', createdIdx: i, top: cHigh, bottom: cLow, timeMs: c0.timeMs });
      }
    }
  }
  return bprZones;
}

function getLatestMacroBar(macroCandles, timeMs) {
  let low = 0, high = macroCandles.length - 1, best = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (macroCandles[mid].timeMs <= timeMs) {
      best = macroCandles[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function runBacktest(candles, bprZones, cfg, options = {}) {
  const {
    sessionMode = '24H', // '24H' | 'PRIME' (07:00-18:00) | 'ASIA' (22:00-07:00)
    macroFilter = 'NONE', // 'NONE' | 'M15_EMA' | 'H1_EMA'
    m15Candles = null,
    h1Candles = null
  } = options;

  let lastTradeIdx = -100;
  const trades = [];

  bprZones.forEach(bpr => {
    for (let k = bpr.createdIdx + 1; k < Math.min(candles.length, bpr.createdIdx + 45); k++) {
      if (k - lastTradeIdx < 4) continue;
      const bar = candles[k];

      // Anti-rollover
      if (bar.hour === 23 || (bar.hour === 0 && bar.minute < 15)) continue;

      // Filtro de Sesión
      if (sessionMode === 'PRIME' && (bar.hour < 7 || bar.hour >= 18)) continue;
      if (sessionMode === 'ASIA' && (bar.hour >= 7 && bar.hour < 22)) continue;

      const candleRange = bar.high - bar.low;
      if (candleRange < cfg.minRange) continue;
      const minWick = cfg.minWickRatio || 0.25;

      if (bpr.type === 'BULLISH') {
        if (bar.low <= bpr.top && bar.low >= bpr.bottom - 0.5) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          if (lowerWick / candleRange < minWick) continue;
          if (bar.close < bar.ema100) continue;

          // Filtro Macro M15
          if (macroFilter === 'M15_EMA' && m15Candles) {
            const mBar = getLatestMacroBar(m15Candles, bar.timeMs);
            if (mBar && bar.close < mBar.ema100) continue;
          }
          // Filtro Macro H1
          if (macroFilter === 'H1_EMA' && h1Candles) {
            const hBar = getLatestMacroBar(h1Candles, bar.timeMs);
            if (hBar && bar.close < hBar.ema100) continue;
          }

          lastTradeIdx = k;
          trades.push(evaluateTrade('BUY', k, bar, bpr.top, bpr.bottom - (cfg.slPips / 10.0), cfg, candles));
          break;
        }
      } else { // BEARISH
        if (bar.high >= bpr.bottom && bar.high <= bpr.top + 0.5) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          if (upperWick / candleRange < minWick) continue;
          if (bar.close > bar.ema100) continue;

          // Filtro Macro M15
          if (macroFilter === 'M15_EMA' && m15Candles) {
            const mBar = getLatestMacroBar(m15Candles, bar.timeMs);
            if (mBar && bar.close > mBar.ema100) continue;
          }
          // Filtro Macro H1
          if (macroFilter === 'H1_EMA' && h1Candles) {
            const hBar = getLatestMacroBar(h1Candles, bar.timeMs);
            if (hBar && bar.close > hBar.ema100) continue;
          }

          lastTradeIdx = k;
          trades.push(evaluateTrade('SELL', k, bar, bpr.bottom, bpr.top + (cfg.slPips / 10.0), cfg, candles));
          break;
        }
      }
    }
  });

  const totalTrades = trades.length;
  const wins = trades.filter(t => t.pips > 0).length;
  const losses = totalTrades - wins;
  const netPips = trades.reduce((a, b) => a + b.pips, 0);
  const grossWon = trades.filter(t => t.pips > 0).reduce((a, b) => a + b.pips, 0);
  const grossLost = trades.filter(t => t.pips <= 0).reduce((a, b) => a + Math.abs(b.pips), 0);
  const wr = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pf = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';

  let peak = 0, maxDD = 0, running = 0;
  trades.forEach(t => {
    running += t.pips;
    if (running > peak) peak = running;
    if (peak - running > maxDD) maxDD = peak - running;
  });

  return {
    trades: totalTrades,
    wins,
    losses,
    winRate: `${wr}%`,
    netPips: parseFloat(netPips.toFixed(1)),
    profitFactor: parseFloat(pf),
    maxDrawdownPips: parseFloat(maxDD.toFixed(1)),
    avgPipsTrade: totalTrades > 0 ? parseFloat((netPips / totalTrades).toFixed(1)) : 0
  };
}

function evaluateTrade(type, k, bar, entry, sl, cfg, candles) {
  let currentSL = sl;
  let tp1Hit = false;
  let pips = 0;

  for (let m = k + 1; m < Math.min(candles.length, k + 100); m++) {
    const fBar = candles[m];

    if (type === 'BUY') {
      if (fBar.low <= currentSL) {
        const diff = (currentSL - entry) * 10 - fBar.spreadPips;
        pips = tp1Hit ? (cfg.tp1Pips * 0.5 + diff * 0.5) : diff;
        break;
      }
      if (!tp1Hit && fBar.high >= entry + (cfg.tp1Pips / 10.0)) {
        tp1Hit = true;
        currentSL = entry + 0.2;
      }
      if (!tp1Hit && fBar.high >= entry + (cfg.autoBe / 10.0)) {
        if (currentSL < entry + 0.2) currentSL = entry + 0.2;
      }
      if (fBar.high >= entry + (cfg.tp2Pips / 10.0)) {
        pips = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
        break;
      }
    } else {
      if (fBar.high >= currentSL) {
        const diff = (entry - currentSL) * 10 - fBar.spreadPips;
        pips = tp1Hit ? (cfg.tp1Pips * 0.5 + diff * 0.5) : diff;
        break;
      }
      if (!tp1Hit && fBar.low <= entry - (cfg.tp1Pips / 10.0)) {
        tp1Hit = true;
        currentSL = entry - 0.2;
      }
      if (!tp1Hit && fBar.low <= entry - (cfg.autoBe / 10.0)) {
        if (currentSL > entry - 0.2) currentSL = entry - 0.2;
      }
      if (fBar.low <= entry - (cfg.tp2Pips / 10.0)) {
        pips = tp1Hit ? (cfg.tp1Pips * 0.5 + cfg.tp2Pips * 0.5) : cfg.tp2Pips;
        break;
      }
    }
  }

  if (pips === 0 && tp1Hit) pips = cfg.tp1Pips * 0.5;
  return { pips };
}

async function main() {
  console.log('⏳ Cargando velas...');
  const [candlesM2, candlesM3, candlesM5, candlesM15] = await Promise.all([
    loadCandles(FILES.M2),
    loadCandles(FILES.M3),
    loadCandles(FILES.M5),
    loadCandles(FILES.M15)
  ]);

  const h1Candles = buildH1Candles(candlesM15);

  const zonesM2  = findBprZones(candlesM2,  TF_CONFIG.M2);
  const zonesM3  = findBprZones(candlesM3,  TF_CONFIG.M3);
  const zonesM5  = findBprZones(candlesM5,  TF_CONFIG.M5);
  const zonesM15 = findBprZones(candlesM15, TF_CONFIG.M15);

  console.log('========================================================================================');
  console.log('📊 TEST 1: IMPACTO DE LA SESIÓN HORARIA (¿OPERAR ASIA/NOCHE O SOLO LONDRES/NY?)');
  console.log('   Comparación rigurosa de 3 modalidades sobre M2, M3, M5, M15:');
  console.log('   A) 24 Horas (Todo el día)');
  console.log('   B) Prime Sessions (07:00 a 18:00 UTC - Londres y NY)');
  console.log('   C) Noche Asiática (22:00 a 07:00 UTC)');
  console.log('========================================================================================\n');

  const sessionAudit = [];
  const tfs = [
    { name: 'M2',  candles: candlesM2,  zones: zonesM2,  cfg: TF_CONFIG.M2 },
    { name: 'M3',  candles: candlesM3,  zones: zonesM3,  cfg: TF_CONFIG.M3 },
    { name: 'M5',  candles: candlesM5,  zones: zonesM5,  cfg: TF_CONFIG.M5 },
    { name: 'M15', candles: candlesM15, zones: zonesM15, cfg: TF_CONFIG.M15 }
  ];

  tfs.forEach(item => {
    const res24H   = runBacktest(item.candles, item.zones, item.cfg, { sessionMode: '24H' });
    const resPrime = runBacktest(item.candles, item.zones, item.cfg, { sessionMode: 'PRIME' });
    const resAsia  = runBacktest(item.candles, item.zones, item.cfg, { sessionMode: 'ASIA' });

    sessionAudit.push({
      Timeframe: item.name,
      'Modo': '24 Horas (Actual)',
      Trades: res24H.trades,
      WinRate: res24H.winRate,
      NetPips: res24H.netPips,
      PF: res24H.profitFactor,
      MaxDD: res24H.maxDrawdownPips,
      'Avg Pip/Tr': res24H.avgPipsTrade
    });
    sessionAudit.push({
      Timeframe: item.name,
      'Modo': 'Solo Londres/NY (07-18h)',
      Trades: resPrime.trades,
      WinRate: resPrime.winRate,
      NetPips: resPrime.netPips,
      PF: resPrime.profitFactor,
      MaxDD: resPrime.maxDrawdownPips,
      'Avg Pip/Tr': resPrime.avgPipsTrade
    });
    sessionAudit.push({
      Timeframe: item.name,
      'Modo': 'Solo Noche/Asia (22-07h)',
      Trades: resAsia.trades,
      WinRate: resAsia.winRate,
      NetPips: resAsia.netPips,
      PF: resAsia.profitFactor,
      MaxDD: resAsia.maxDrawdownPips,
      'Avg Pip/Tr': resAsia.avgPipsTrade
    });
  });

  console.table(sessionAudit);

  console.log('\n========================================================================================');
  console.log('📈 TEST 2: IMPACTO DEL FILTRO DE SESGO MACRO (HTF TREND FILTER)');
  console.log('   Evaluando si filtrar por la tendencia mayor elimina pérdidas a contratendencia:');
  console.log('   A) Sin Filtro Macro (Solo EMA 100 de su propia temporalidad)');
  console.log('   B) Con Filtro Macro M15 (Operar solo si la vela respeta la EMA 100 de M15)');
  console.log('   C) Con Filtro Macro H1  (Operar solo si la vela respeta la EMA 100 de H1)');
  console.log('========================================================================================\n');

  const macroAudit = [];
  tfs.forEach(item => {
    const resNone = runBacktest(item.candles, item.zones, item.cfg, { macroFilter: 'NONE' });
    const resM15  = runBacktest(item.candles, item.zones, item.cfg, { macroFilter: 'M15_EMA', m15Candles: candlesM15 });
    const resH1   = runBacktest(item.candles, item.zones, item.cfg, { macroFilter: 'H1_EMA', h1Candles });

    macroAudit.push({
      Timeframe: item.name,
      'Filtro Macro': 'A) Ninguno (Solo EMA local)',
      Trades: resNone.trades,
      WinRate: resNone.winRate,
      NetPips: resNone.netPips,
      PF: resNone.profitFactor,
      MaxDD: resNone.maxDrawdownPips,
      'Avg Pip/Tr': resNone.avgPipsTrade
    });
    macroAudit.push({
      Timeframe: item.name,
      'Filtro Macro': 'B) + Filtro M15 EMA 100',
      Trades: resM15.trades,
      WinRate: resM15.winRate,
      NetPips: resM15.netPips,
      PF: resM15.profitFactor,
      MaxDD: resM15.maxDrawdownPips,
      'Avg Pip/Tr': resM15.avgPipsTrade
    });
    macroAudit.push({
      Timeframe: item.name,
      'Filtro Macro': 'C) + Filtro H1 EMA 100',
      Trades: resH1.trades,
      WinRate: resH1.winRate,
      NetPips: resH1.netPips,
      PF: resH1.profitFactor,
      MaxDD: resH1.maxDrawdownPips,
      'Avg Pip/Tr': resH1.avgPipsTrade
    });
  });

  console.table(macroAudit);
}

main().catch(console.error);
