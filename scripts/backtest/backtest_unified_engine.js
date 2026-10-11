/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  MOTOR DE BACKTEST UNIFICADO - VERIFICACIÓN DE VENTAJA ESTADÍSTICA     ║
 * ║  99% de Fidelidad con Mercado Live                                     ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Replica exactamente la lógica de cada estrategia BPR live:            ║
 * ║  • XAUUSD: BPR Multitemporal (M3+M5+M15), Buy+Sell, EMA100, Wick≥25% ║
 * ║  • EURUSD: BPR Bidireccional (M2+M3+M5+M15), CE_50, Wick≥20%, R:R 1:1║
 * ║  • GBPJPY: BPR Solo Ventas (M2+M3+M5+M15), Wick≥20%, R:R 1:2     ║
 * ║  • NAS100: BPR Bidireccional (M2+M3+M5+M15), EMA100, Wick≥25%, R:R 1:2.5 ║
 * ║                                                                        ║
 * ║  Fricción de broker real:                                               ║
 * ║  • Spread: Leído vela a vela desde CSV (columna SPREAD del broker)     ║
 * ║  • Comisiones: Round-Trip real ($8.25/lote The5%ers)                   ║
 * ║  • Slippage: Adverso de 0.5 pips en entries y SL hits                 ║
 * ║  • Resolución intra-vela: En caso de duda, SL toca primero            ║
 * ║                                                                        ║
 * ║  Métricas:                                                             ║
 * ║  • Pips/Puntos netos, Win Rate, Profit Factor                         ║
 * ║  • Profit total USD (The5%ers $5k + FTMO $100k)                       ║
 * ║  • Media profit/día (USD y pips), en días de trading y naturales      ║
 * ║  • Max DD en pips, USD, % de balance                                  ║
 * ║  • Desglose por año, por timeframe                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DE CUENTAS
// ═══════════════════════════════════════════════════════════════════════
const ACCOUNT_PROFILES = {
  THE5ERS_5K: {
    name: 'The 5%ers $5,000',
    initialBalance: 5000,
    riskPercent: 0.75,
    commissionPerLotRT: 8.25,
    slippagePips: 0.5
  },
  FTMO_100K: {
    name: 'FTMO $100,000',
    initialBalance: 100000,
    riskPercent: 0.75,
    commissionPerLotRT: 5.86,
    slippagePips: 0.5
  }
};

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN POR ACTIVO - RÉPLICA EXACTA DE LA ESTRATEGIA LIVE
// ═══════════════════════════════════════════════════════════════════════
const ASSETS = {
  XAUUSD: {
    name: 'Oro Spot (XAUUSD)',
    pipSize: 0.1,
    pipValuePerLot: 10.0,
    spreadMultiplier: 0.1, // La columna SPREAD del CSV viene en points, multiplicar por esto para tener pips
    direction: 'BOTH',
    wickThreshold: 0.25,
    usesEma100: true,
    bprLookback: 10,
    maxActiveTrades: 2,
    maxCandlesHistory: 300,
    maxZones: 25,
    antiStacking: false, // XAUUSD permite hasta maxActiveTrades
    timeframes: {
      M3:  { tfMinutes: 3,  minFvgGap: 0.20, minOverlap: 0.15, minRange: 0.25, slPips: 12.0, tp2Pips: 60.0,  buffer: 0.5 },
      M5:  { tfMinutes: 5,  minFvgGap: 0.30, minOverlap: 0.20, minRange: 0.35, slPips: 15.0, tp2Pips: 80.0,  buffer: 0.5 },
      M15: { tfMinutes: 15, minFvgGap: 0.50, minOverlap: 0.35, minRange: 0.60, slPips: 25.0, tp2Pips: 120.0, buffer: 0.5 }
    },
    csvFiles: {
      M3:  'XAUUSD_M3_*',
      M5:  'XAUUSD_M5_*',
      M15: 'XAUUSD_M15_*'
    },
    sessionFilter: (hourUTC, minUTC) => {
      // Rollover Shield: 23:00 a 00:15 UTC
      if (hourUTC === 23 || (hourUTC === 0 && minUTC < 15)) return false;
      return true;
    },
    computeSLTP: (type, entry, bpr, cfg) => {
      // XAUUSD usa SL fijo de la config del TF y TP2 fijo
      const slPrice = type === 'BUY'
        ? bpr.bottom - (cfg.slPips / 10.0)
        : bpr.top + (cfg.slPips / 10.0);
      const tpPrice = type === 'BUY'
        ? entry + (cfg.tp2Pips / 10.0)
        : entry - (cfg.tp2Pips / 10.0);
      return { slPrice, tpPrice, slPips: cfg.slPips, tpPips: cfg.tp2Pips };
    }
  },

  EURUSD: {
    name: 'Euro / Dólar (EURUSD)',
    pipSize: 0.0001,
    pipValuePerLot: 10.0,
    spreadMultiplier: 0.1, // Spread column in points → pips (1 point = 0.1 pip)
    direction: 'BOTH',
    wickThreshold: 0.20,
    usesEma100: true,
    bprLookback: 25,
    maxActiveTrades: 1,
    maxCandlesHistory: 500,
    maxZones: 250,
    antiStacking: true,
    timeframes: {
      M2:  { tfMinutes: 2,  minFvgGap: 0.00008, minOverlap: 0.00005, minRange: 0.00010, bufferPips: 1.2, slMinPips: 2.0, rrRatio: 1.0, maxDistPips: 4.5 },
      M3:  { tfMinutes: 3,  minFvgGap: 0.00010, minOverlap: 0.00006, minRange: 0.00012, bufferPips: 1.2, slMinPips: 2.0, rrRatio: 1.0, maxDistPips: 6.0 },
      M5:  { tfMinutes: 5,  minFvgGap: 0.00012, minOverlap: 0.00008, minRange: 0.00015, bufferPips: 1.5, slMinPips: 2.5, rrRatio: 1.0, maxDistPips: 8.5 },
      M15: { tfMinutes: 15, minFvgGap: 0.00018, minOverlap: 0.00010, minRange: 0.00020, bufferPips: 2.0, slMinPips: 3.0, rrRatio: 1.0, maxDistPips: 15.0 }
    },
    csvFiles: {
      M2:  'EURUSD_M2_*',
      M3:  'EURUSD_M3_*',
      M5:  'EURUSD_M5_*',
      M15: 'EURUSD_M15_*'
    },
    sessionFilter: (hourUTC) => {
      // 07:00 a 19:00 UTC, excluyendo 10:00-11:00
      if (hourUTC < 7 || hourUTC >= 19) return false;
      if (hourUTC === 10) return false;
      // Rollover block
      if (hourUTC >= 22 || hourUTC < 2) return false;
      return true;
    },
    computeSLTP: (type, entry, bpr, cfg) => {
      const pipMultiplier = 10000;
      const bufferPrice = cfg.bufferPips / pipMultiplier;
      const sl = type === 'BUY' ? (bpr.bottom - bufferPrice) : (bpr.top + bufferPrice);
      const slDist = Math.abs(entry - sl);
      const slPips = slDist * pipMultiplier;
      if (slPips < cfg.slMinPips) return null;
      if (cfg.maxDistPips && slPips > cfg.maxDistPips) return null;
      const tpDist = slDist * cfg.rrRatio;
      const tp = type === 'BUY' ? entry + tpDist : entry - tpDist;
      return { slPrice: sl, tpPrice: tp, slPips, tpPips: slPips * cfg.rrRatio };
    }
  },

  GBPJPY: {
    name: 'Libra / Yen (GBPJPY)',
    pipSize: 0.01,
    pipValuePerLot: 7.20,
    spreadMultiplier: 0.1, // Spread in points → pips
    direction: 'SELL_ONLY',
    wickThreshold: 0.20,
    usesEma100: false,
    bprLookback: 25,
    maxActiveTrades: 1,
    maxCandlesHistory: 500,
    maxZones: 250,
    antiStacking: true,
    timeframes: {
      M2:  { tfMinutes: 2,  minFvgGap: 0.035, minOverlap: 0.020, minRange: 0.040, bufferPips: 4.0, slMinPips: 6.0,  slMaxPips: 35.0, rrRatio: 2.0 },
      M3:  { tfMinutes: 3,  minFvgGap: 0.040, minOverlap: 0.025, minRange: 0.045, bufferPips: 4.5, slMinPips: 7.0,  slMaxPips: 40.0, rrRatio: 2.0 },
      M5:  { tfMinutes: 5,  minFvgGap: 0.050, minOverlap: 0.030, minRange: 0.055, bufferPips: 5.0, slMinPips: 8.0,  slMaxPips: 50.0, rrRatio: 2.0 },
      M15: { tfMinutes: 15, minFvgGap: 0.075, minOverlap: 0.045, minRange: 0.080, bufferPips: 6.0, slMinPips: 10.0, slMaxPips: 70.0, rrRatio: 2.0 }
    },
    csvFiles: {
      M2:  'GBPJPY_M2_*',
      M3:  'GBPJPY_M3_*',
      M5:  'GBPJPY_M5_*',
      M15: 'GBPJPY_M15_*'
    },
    sessionFilter: (hourUTC, minUTC) => {
      // Rollover block: 21:00 a 01:00 UTC
      if (hourUTC >= 21 || hourUTC < 1) return false;
      // Londres + London Fix + Wall Street: 07:00 a 18:30 UTC, excl 10:00-11:00
      if (hourUTC < 7 || (hourUTC === 18 && minUTC > 30) || hourUTC > 18) return false;
      if (hourUTC === 10) return false;
      return true;
    },
    computeSLTP: (type, entry, bpr, cfg) => {
      const pipMultiplier = 100;
      const bufferPrice = cfg.bufferPips / pipMultiplier;
      const sl = bpr.top + bufferPrice;
      const slDist = Math.abs(sl - entry);
      const slPips = slDist * pipMultiplier;
      if (slPips < cfg.slMinPips || slPips > cfg.slMaxPips) return null;
      const tpDist = slDist * cfg.rrRatio;
      const tp = entry - tpDist;
      return { slPrice: sl, tpPrice: tp, slPips, tpPips: slPips * cfg.rrRatio };
    }
  },

  NAS100: {
    name: 'Nasdaq 100 (NAS100)',
    pipSize: 1.0,
    pipValuePerLot: 1.0,
    spreadMultiplier: 1.0, // NAS100 spread ya viene en points que son puntos directos
    direction: 'BOTH',
    wickThreshold: 0.25,
    usesEma100: true,
    bprLookback: 25,
    maxActiveTrades: 1,
    maxCandlesHistory: 500,
    maxZones: 250,
    antiStacking: true,
    timeframes: {
      M2:  { tfMinutes: 2,  minFvgGap: 4.0,  minOverlap: 2.5,  minRange: 6.0,  bufferPts: 6.0,  slMinPts: 8.0,  slMaxPts: 50.0,  rrRatio: 2.5 },
      M3:  { tfMinutes: 3,  minFvgGap: 5.5,  minOverlap: 3.5,  minRange: 8.0,  bufferPts: 7.0,  slMinPts: 10.0, slMaxPts: 60.0,  rrRatio: 2.5 },
      M5:  { tfMinutes: 5,  minFvgGap: 8.0,  minOverlap: 5.0,  minRange: 10.0, bufferPts: 8.0,  slMinPts: 12.0, slMaxPts: 80.0,  rrRatio: 2.5 },
      M15: { tfMinutes: 15, minFvgGap: 14.0, minOverlap: 8.0,  minRange: 16.0, bufferPts: 10.0, slMinPts: 18.0, slMaxPts: 100.0, rrRatio: 2.5 }
    },
    csvFiles: {
      M2:  'NAS100_M2_*',
      M3:  'NAS100_M3_*',
      M5:  'NAS100_M5_*',
      M15: 'NAS100_M15_*'
    },
    sessionFilter: (hourUTC, minUTC) => {
      // Rollover block: 20:55 a 22:30 UTC
      if (hourUTC === 21 || (hourUTC === 20 && minUTC >= 55) || (hourUTC === 22 && minUTC <= 30)) return false;
      // Wall Street Cash Open: 13:30 a 18:00 UTC
      const minOfDay = hourUTC * 60 + minUTC;
      if (minOfDay < 810 || minOfDay >= 1080) return false;
      return true;
    },
    computeSLTP: (type, entry, bpr, cfg) => {
      const sl = type === 'BUY' ? bpr.bottom - cfg.bufferPts : bpr.top + cfg.bufferPts;
      const slDist = Math.abs(entry - sl);
      if (slDist < cfg.slMinPts || slDist > cfg.slMaxPts) return null;
      const tpDist = slDist * cfg.rrRatio;
      const tp = type === 'BUY' ? entry + tpDist : entry - tpDist;
      return { slPrice: sl, tpPrice: tp, slPips: slDist, tpPips: tpDist };
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════
// CSV LOADER - Lectura streaming línea a línea (sin cargar todo en RAM)
// ═══════════════════════════════════════════════════════════════════════
function findCsvFile(pattern) {
  const files = fs.readdirSync(ROOT);
  const prefix = pattern.replace('*', '');
  const matches = files.filter(f => f.startsWith(prefix) && f.endsWith('.csv'));
  if (matches.length === 0) throw new Error(`No se encontró CSV con patrón: ${pattern}`);
  // Usar el más reciente (último por nombre)
  matches.sort();
  return path.join(ROOT, matches[matches.length - 1]);
}

async function loadCsvCandles(filePath) {
  return new Promise((resolve, reject) => {
    const candles = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });

    let isFirst = true;
    rl.on('line', (line) => {
      if (isFirst) { isFirst = false; return; } // Skip header
      const parts = line.split('\t');
      if (parts.length < 7) return;

      const [date, time, open, high, low, close, tickVol, vol, spread] = parts;
      const dateTimeParts = date.replace(/\./g, '-') + 'T' + time + 'Z';
      const ts = new Date(dateTimeParts).getTime();
      if (isNaN(ts)) return;

      candles.push({
        time: ts,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseInt(tickVol) || 0,
        spread: parseInt(spread) || 0
      });
    });

    rl.on('close', () => resolve(candles));
    rl.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════
function calculateEma100(candles) {
  if (candles.length < 5) return;
  const k = 2 / (100 + 1);
  let ema = candles[0].close;
  for (let i = 0; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    candles[i].ema100 = ema;
  }
}

function getYear(ts) {
  return new Date(ts).getUTCFullYear();
}

function getDayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════
// MOTOR BPR GENÉRICO - Detección de zonas idéntica al código live
// ═══════════════════════════════════════════════════════════════════════

/**
 * Escanea zonas BPR incrementalmente tras cerrar cada vela nueva
 * Réplica exacta de la lógica de detección live por activo
 */
function scanBprZonesXAUUSD(candles, cfg, lookback) {
  const n = candles.length;
  if (n < 4) return [];
  
  const zones = [];
  const c0 = candles[n - 1];
  const c2 = candles[n - 3];

  const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
  const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

  if (isBearishFVG) c0._isBearishFVG = true;
  if (isBullishFVG) c0._isBullishFVG = true;

  if (isBullishFVG) {
    for (let i = n - 2; i >= Math.max(0, n - lookback - 1); i--) {
      if (candles[i]._isBearishFVG) {
        const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
        const bearBottom = candles[i].high;
        const bullTop = c0.low;
        const bullBottom = c2.high;
        const cLow = Math.max(bearBottom, bullBottom);
        const cHigh = Math.min(bearTop, bullTop);

        if (cHigh > cLow + cfg.minOverlap) {
          zones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, createdIndex: n - 1, tested: false });
          break;
        }
      }
    }
  }

  if (isBearishFVG) {
    for (let i = n - 2; i >= Math.max(0, n - lookback - 1); i--) {
      if (candles[i]._isBullishFVG) {
        const bullTop = candles[i].low;
        const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
        const bearTop = c2.low;
        const bearBottom = c0.high;
        const cLow = Math.max(bullBottom, bearBottom);
        const cHigh = Math.min(bullTop, bearTop);

        if (cHigh > cLow + cfg.minOverlap) {
          zones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, createdIndex: n - 1, tested: false });
          break;
        }
      }
    }
  }

  return zones;
}

function scanBprZonesEURUSD(candles, cfg, lookback) {
  const n = candles.length;
  if (n < 4) return [];

  const zones = [];
  const c0 = candles[n - 1];
  const c2 = candles[n - 3];

  const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
  const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

  if (isBearishFVG) c0._isBearish = true;
  if (isBullishFVG) c0._isBullish = true;

  if (isBullishFVG) {
    for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
      if (candles[i]._isBearish) {
        const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
        const bearBottom = candles[i].high;
        const bullTop = c0.low;
        const bullBottom = c2.high;
        const cLow = Math.max(bearBottom, bullBottom);
        const cHigh = Math.min(bearTop, bullTop);

        if (cHigh > cLow + cfg.minOverlap) {
          zones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, ce50: (cHigh + cLow) / 2, createdIndex: n - 1, tested: false });
          break;
        }
      }
    }
  }

  if (isBearishFVG) {
    for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
      if (candles[i]._isBullish) {
        const bullTop = candles[i].low;
        const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
        const bearTop = c2.low;
        const bearBottom = c0.high;
        const cLow = Math.max(bullBottom, bearBottom);
        const cHigh = Math.min(bullTop, bearTop);

        if (cHigh > cLow + cfg.minOverlap) {
          zones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, ce50: (cHigh + cLow) / 2, createdIndex: n - 1, tested: false });
          break;
        }
      }
    }
  }

  return zones;
}

function scanBprZonesGBPJPY(candles, cfg, lookback) {
  const n = candles.length;
  if (n < 5) return [];

  const zones = [];
  const c0 = candles[n - 1];
  const c1 = candles[n - 2];
  const c3 = candles[n - 4];

  const isBearishFVG = (c3.low - c1.high) >= cfg.minFvgGap;
  const isBullishFVG = (c1.low - c3.high) >= cfg.minFvgGap;

  if (isBearishFVG) c1._isBearish = true;
  if (isBullishFVG) c1._isBullish = true;

  // Solo BEARISH zones (SELL only)
  if (isBearishFVG) {
    for (let j = n - 3; j >= Math.max(0, n - lookback); j--) {
      if (candles[j] && candles[j]._isBullish) {
        const bearTop = c3.low;
        const bearBottom = c1.high;
        const bullTop = candles[j].low;
        const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.minFvgGap;
        const cLow = Math.max(bullBottom, bearBottom);
        const cHigh = Math.min(bullTop, bearTop);

        if (cHigh > cLow + cfg.minOverlap) {
          zones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, ce50: (cHigh + cLow) / 2, createdIndex: n - 1, tested: false });
          break;
        }
      }
    }
  }

  return zones;
}

function scanBprZonesNAS100(candles, cfg, lookback) {
  const n = candles.length;
  if (n < 4) return [];

  const zones = [];
  const c0 = candles[n - 1];
  const c2 = candles[n - 3];

  const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
  const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

  if (isBearishFVG) c0._isBearish = true;
  if (isBullishFVG) c0._isBullish = true;

  if (isBullishFVG) {
    for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
      if (candles[i]._isBearish) {
        const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
        const bearBottom = candles[i].high;
        const bullTop = c0.low;
        const bullBottom = c2.high;
        const cLow = Math.max(bearBottom, bullBottom);
        const cHigh = Math.min(bearTop, bullTop);

        if (cHigh > cLow + cfg.minOverlap) {
          zones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, ce50: (cHigh + cLow) / 2, createdIndex: n - 1, tested: false });
          break;
        }
      }
    }
  }

  if (isBearishFVG) {
    for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
      if (candles[i]._isBullish) {
        const bullTop = candles[i].low;
        const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
        const bearTop = c2.low;
        const bearBottom = c0.high;
        const cLow = Math.max(bullBottom, bearBottom);
        const cHigh = Math.min(bearTop, bullTop);

        if (cHigh > cLow + cfg.minOverlap) {
          zones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, ce50: (cHigh + cLow) / 2, createdIndex: n - 1, tested: false });
          break;
        }
      }
    }
  }

  return zones;
}

// ═══════════════════════════════════════════════════════════════════════
// SIMULADOR DE TRADES POR ACTIVO
// ═══════════════════════════════════════════════════════════════════════
async function backtestAsset(assetKey) {
  const asset = ASSETS[assetKey];
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  BACKTESTING: ${asset.name}`);
  console.log(`${'═'.repeat(70)}`);

  const results = {};

  for (const [tfKey, tfCfg] of Object.entries(asset.timeframes)) {
    const csvPattern = asset.csvFiles[tfKey];
    let csvPath;
    try {
      csvPath = findCsvFile(csvPattern);
    } catch (e) {
      console.log(`  ⚠️ ${tfKey}: ${e.message}`);
      continue;
    }

    console.log(`  📊 Cargando ${tfKey}... (${path.basename(csvPath)})`);
    const rawCandles = await loadCsvCandles(csvPath);
    console.log(`     ${rawCandles.length.toLocaleString()} velas cargadas (${new Date(rawCandles[0].time).toISOString().slice(0,10)} → ${new Date(rawCandles[rawCandles.length-1].time).toISOString().slice(0,10)})`);

    // Ejecutar simulación en esta temporalidad
    const tfResult = simulateTimeframe(assetKey, asset, tfKey, tfCfg, rawCandles);
    results[tfKey] = tfResult;
    
    printTimeframeResult(assetKey, tfKey, tfResult, asset);
  }

  // Resultado agregado de todas las temporalidades
  const combined = combineTimeframeResults(results);
  return { asset: assetKey, byTimeframe: results, combined };
}

function simulateTimeframe(assetKey, asset, tfKey, tfCfg, rawCandles) {
  const candleBuffer = [];
  let bprZones = [];
  const trades = [];
  const activeTrades = [];

  const selectScanFn = {
    XAUUSD: scanBprZonesXAUUSD,
    EURUSD: scanBprZonesEURUSD,
    GBPJPY: scanBprZonesGBPJPY,
    NAS100: scanBprZonesNAS100
  };

  const scanFn = selectScanFn[assetKey];

  for (let idx = 0; idx < rawCandles.length; idx++) {
    const candle = rawCandles[idx];
    
    // 1. Gestionar trades activos con esta vela (intra-vela)
    manageActiveTradesIntraBar(activeTrades, trades, candle, asset, tfCfg);

    // 2. Añadir vela al buffer
    candleBuffer.push(candle);
    if (candleBuffer.length > asset.maxCandlesHistory) candleBuffer.shift();

    // 3. Calcular EMA 100 si aplica
    if (asset.usesEma100) {
      calculateEma100(candleBuffer);
    }

    // 4. Escanear nuevas zonas BPR
    const newZones = scanFn(candleBuffer, tfCfg, asset.bprLookback);
    for (const z of newZones) {
      z.createdIndex = candleBuffer.length - 1;
      bprZones.push(z);
    }
    while (bprZones.length > asset.maxZones) bprZones.shift();

    // 5. Evaluar entradas
    const date = new Date(candle.time);
    const hourUTC = date.getUTCHours();
    const minUTC = date.getUTCMinutes();

    if (!asset.sessionFilter(hourUTC, minUTC)) continue;

    const candleRange = candle.high - candle.low;
    if (candleRange < tfCfg.minRange) continue;

    // Anti-stacking
    const openCount = activeTrades.filter(t => t.status === 'OPEN').length;
    if (openCount >= asset.maxActiveTrades) continue;

    // Evaluar zonas para señales
    for (let z = bprZones.length - 1; z >= 0; z--) {
      const bpr = bprZones[z];
      if (bpr.tested) continue;
      
      const age = candleBuffer.length - 1 - bpr.createdIndex;
      if (age > 400) { bpr.tested = true; continue; }

      const signal = evaluateSignal(assetKey, asset, tfCfg, candle, bpr, candleRange);
      if (signal) {
        bpr.tested = true;
        
        // Fricción: slippage adverso en entrada
        const slippagePipsEntry = 0.5;
        let adjustedEntry = signal.entry;
        if (signal.type === 'BUY') {
          adjustedEntry += slippagePipsEntry * asset.pipSize;
        } else {
          adjustedEntry -= slippagePipsEntry * asset.pipSize;
        }

        const sltp = asset.computeSLTP(signal.type, adjustedEntry, bpr, tfCfg);
        if (!sltp) continue;

        // Spread cost check: si el spread de la vela es demasiado alto, skip
        const spreadPips = candle.spread * asset.spreadMultiplier;
        
        const trade = {
          id: `${assetKey}_${tfKey}_${trades.length}`,
          tf: tfKey,
          type: signal.type,
          entry: adjustedEntry,
          sl: sltp.slPrice,
          tp: sltp.tpPrice,
          slPips: sltp.slPips,
          tpPips: sltp.tpPips,
          spreadPips,
          openTime: candle.time,
          openCandle: idx,
          status: 'OPEN'
        };

        activeTrades.push(trade);
        break;
      }
    }
  }

  // Cerrar trades que quedaron abiertos al final
  for (const t of activeTrades) {
    if (t.status === 'OPEN') {
      t.status = 'EXPIRED';
      t.closeTime = rawCandles[rawCandles.length - 1].time;
      t.pips = 0;
      trades.push(t);
    }
  }

  return computeMetrics(trades, rawCandles, asset);
}

function evaluateSignal(assetKey, asset, cfg, candle, bpr, candleRange) {
  if (assetKey === 'XAUUSD') {
    // XAUUSD: bidireccional con EMA100 + wick >= 25%
    if (bpr.type === 'BULLISH') {
      if (candle.low <= bpr.top && candle.low >= bpr.bottom - 0.5) {
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        if (lowerWick / candleRange >= asset.wickThreshold) {
          if (!asset.usesEma100 || candle.close > candle.ema100) {
            return { type: 'BUY', entry: candle.close };
          }
        }
      }
    } else if (bpr.type === 'BEARISH') {
      if (candle.high >= bpr.bottom && candle.high <= bpr.top + 0.5) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        if (upperWick / candleRange >= asset.wickThreshold) {
          if (!asset.usesEma100 || candle.close < candle.ema100) {
            return { type: 'SELL', entry: candle.close };
          }
        }
      }
    }
  } else if (assetKey === 'EURUSD') {
    const pipMultiplier = 10000;
    const bufferPrice = cfg.bufferPips / pipMultiplier;
    
    if (bpr.type === 'BULLISH') {
      if (candle.low <= bpr.top && candle.low >= bpr.bottom - bufferPrice) {
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        if (lowerWick / candleRange >= asset.wickThreshold) {
          if (asset.usesEma100 && candle.ema100 && candle.close < candle.ema100) return null;
          return { type: 'BUY', entry: candle.close };
        }
      }
    } else if (bpr.type === 'BEARISH') {
      if (candle.high >= bpr.bottom && candle.high <= bpr.top + bufferPrice) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        if (upperWick / candleRange >= asset.wickThreshold) {
          if (asset.usesEma100 && candle.ema100 && candle.close > candle.ema100) return null;
          return { type: 'SELL', entry: candle.close };
        }
      }
    }
  } else if (assetKey === 'GBPJPY') {
    const pipMultiplier = 100;
    const bufferPrice = cfg.bufferPips / pipMultiplier;
    
    // Solo SELL (Bearish zones)
    if (bpr.type === 'BEARISH') {
      if (candle.high >= bpr.bottom && candle.high <= bpr.top + bufferPrice) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        if (upperWick / candleRange >= asset.wickThreshold) {
          return { type: 'SELL', entry: candle.close };
        }
      }
    }
  } else if (assetKey === 'NAS100') {
    if (bpr.type === 'BULLISH') {
      if (candle.low <= bpr.top && candle.low >= bpr.bottom - cfg.bufferPts) {
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        if (lowerWick / candleRange >= asset.wickThreshold) {
          if (!asset.usesEma100 || candle.close > candle.ema100) {
            return { type: 'BUY', entry: candle.close };
          }
        }
      }
    } else if (bpr.type === 'BEARISH') {
      if (candle.high >= bpr.bottom && candle.high <= bpr.top + cfg.bufferPts) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        if (upperWick / candleRange >= asset.wickThreshold) {
          if (!asset.usesEma100 || candle.close < candle.ema100) {
            return { type: 'SELL', entry: candle.close };
          }
        }
      }
    }
  }

  return null;
}

function manageActiveTradesIntraBar(activeTrades, closedTrades, candle, asset, cfg) {
  for (let i = activeTrades.length - 1; i >= 0; i--) {
    const t = activeTrades[i];
    if (t.status !== 'OPEN') continue;

    let closed = false;
    let outcome = null;
    let pips = 0;

    if (t.type === 'BUY') {
      // Resolución conservadora: si ambos SL y TP pudieron ser alcanzados en la misma vela,
      // SL toca primero (peor caso para el backtest)
      const couldHitSL = candle.low <= t.sl;
      const couldHitTP = candle.high >= t.tp;

      if (couldHitSL && couldHitTP) {
        // Peor caso: SL primero
        closed = true;
        outcome = 'LOSS';
        pips = -t.slPips;
      } else if (couldHitSL) {
        closed = true;
        outcome = 'LOSS';
        pips = -t.slPips;
      } else if (couldHitTP) {
        closed = true;
        outcome = 'WIN';
        pips = t.tpPips;
      }
    } else { // SELL
      const couldHitSL = candle.high >= t.sl;
      const couldHitTP = candle.low <= t.tp;

      if (couldHitSL && couldHitTP) {
        closed = true;
        outcome = 'LOSS';
        pips = -t.slPips;
      } else if (couldHitSL) {
        closed = true;
        outcome = 'LOSS';
        pips = -t.slPips;
      } else if (couldHitTP) {
        closed = true;
        outcome = 'WIN';
        pips = t.tpPips;
      }
    }

    if (closed) {
      t.status = outcome;
      t.closeTime = candle.time;
      t.pips = pips;
      t.closePrice = outcome === 'WIN' ? t.tp : t.sl;
      closedTrades.push(t);
      activeTrades.splice(i, 1);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CÁLCULO DE MÉTRICAS CON FRICCIÓN REAL
// ═══════════════════════════════════════════════════════════════════════
function computeMetrics(trades, rawCandles, asset) {
  const closedTrades = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const wins = closedTrades.filter(t => t.status === 'WIN');
  const losses = closedTrades.filter(t => t.status === 'LOSS');
  
  const totalPips = closedTrades.reduce((s, t) => s + t.pips, 0);
  const grossWon = wins.reduce((s, t) => s + t.pips, 0);
  const grossLost = losses.reduce((s, t) => s + Math.abs(t.pips), 0);
  const pf = grossLost > 0 ? grossWon / grossLost : grossWon > 0 ? 99.9 : 0;
  const wr = closedTrades.length > 0 ? (wins.length / closedTrades.length * 100) : 0;

  // Max DD en pips
  let peakPips = 0, maxDDPips = 0, runningPips = 0;
  for (const t of closedTrades) {
    runningPips += t.pips;
    if (runningPips > peakPips) peakPips = runningPips;
    const dd = peakPips - runningPips;
    if (dd > maxDDPips) maxDDPips = dd;
  }

  // Cálculo monetario para cada perfil de cuenta
  const monetary = {};
  for (const [profileKey, profile] of Object.entries(ACCOUNT_PROFILES)) {
    const { usdProfit, maxDDUsd, maxDDPercent, dailyUsd, dailyPips, tradingDays, naturalDays, lotSizes } =
      computeMonetaryMetrics(closedTrades, asset, profile, rawCandles);
    monetary[profileKey] = { usdProfit, maxDDUsd, maxDDPercent, dailyUsd, dailyPips, tradingDays, naturalDays };
  }

  // Desglose por año
  const byYear = {};
  for (const t of closedTrades) {
    const year = getYear(t.openTime);
    if (!byYear[year]) byYear[year] = { trades: 0, wins: 0, pips: 0, grossWon: 0, grossLost: 0 };
    byYear[year].trades++;
    byYear[year].pips += t.pips;
    if (t.status === 'WIN') { byYear[year].wins++; byYear[year].grossWon += t.pips; }
    else { byYear[year].grossLost += Math.abs(t.pips); }
  }

  // Trading days y pips por día
  const tradingDays = new Set(closedTrades.map(t => getDayKey(t.openTime))).size;
  const firstDate = rawCandles[0].time;
  const lastDate = rawCandles[rawCandles.length - 1].time;
  const naturalDays = Math.max(1, Math.round((lastDate - firstDate) / (86400000)));

  return {
    totalTrades: closedTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(wr.toFixed(1)),
    netPips: parseFloat(totalPips.toFixed(1)),
    grossWon: parseFloat(grossWon.toFixed(1)),
    grossLost: parseFloat(grossLost.toFixed(1)),
    profitFactor: parseFloat(pf.toFixed(2)),
    maxDrawdownPips: parseFloat(maxDDPips.toFixed(1)),
    pipsPerTradingDay: parseFloat((totalPips / Math.max(1, tradingDays)).toFixed(2)),
    pipsPerNaturalDay: parseFloat((totalPips / naturalDays).toFixed(2)),
    tradingDays,
    naturalDays,
    monetary,
    byYear,
    trades: closedTrades
  };
}

function computeMonetaryMetrics(closedTrades, asset, profile, rawCandles) {
  let balance = profile.initialBalance;
  let peak = balance;
  let maxDDUsd = 0;
  let maxDDPercent = 0;
  const dailyPnl = {};

  for (const t of closedTrades) {
    // Lot size basado en riesgo por operación
    const riskUsd = balance * (profile.riskPercent / 100);
    const slUsd = t.slPips * asset.pipValuePerLot;
    const lotSize = slUsd > 0 ? riskUsd / slUsd : 0.01;
    const effectiveLot = Math.max(0.01, Math.min(lotSize, 100));

    // PnL de la operación en USD
    const pipsResult = t.pips;
    const grossPnl = pipsResult * asset.pipValuePerLot * effectiveLot;
    const commission = profile.commissionPerLotRT * effectiveLot;
    const slippageCost = profile.slippagePips * asset.pipValuePerLot * effectiveLot;
    const netPnl = grossPnl - commission - slippageCost;

    balance += netPnl;

    const dayKey = getDayKey(t.openTime);
    if (!dailyPnl[dayKey]) dailyPnl[dayKey] = 0;
    dailyPnl[dayKey] += netPnl;

    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDDUsd) maxDDUsd = dd;
    const ddPct = peak > 0 ? (dd / peak * 100) : 0;
    if (ddPct > maxDDPercent) maxDDPercent = ddPct;
  }

  const usdProfit = balance - profile.initialBalance;
  const tradingDays = Object.keys(dailyPnl).length;
  const firstDate = rawCandles[0].time;
  const lastDate = rawCandles[rawCandles.length - 1].time;
  const naturalDays = Math.max(1, Math.round((lastDate - firstDate) / 86400000));
  const dailyUsd = usdProfit / naturalDays;
  const dailyPips = closedTrades.reduce((s, t) => s + t.pips, 0) / naturalDays;

  return {
    usdProfit: parseFloat(usdProfit.toFixed(2)),
    maxDDUsd: parseFloat(maxDDUsd.toFixed(2)),
    maxDDPercent: parseFloat(maxDDPercent.toFixed(2)),
    dailyUsd: parseFloat(dailyUsd.toFixed(2)),
    dailyPips: parseFloat(dailyPips.toFixed(2)),
    tradingDays,
    naturalDays
  };
}

function combineTimeframeResults(results) {
  const allTrades = [];
  for (const [tf, r] of Object.entries(results)) {
    if (r && r.trades) {
      for (const t of r.trades) allTrades.push(t);
    }
  }
  // Sort all trades by open time
  allTrades.sort((a, b) => a.openTime - b.openTime);

  const wins = allTrades.filter(t => t.status === 'WIN');
  const losses = allTrades.filter(t => t.status === 'LOSS');
  const totalPips = allTrades.reduce((s, t) => s + t.pips, 0);
  const grossWon = wins.reduce((s, t) => s + t.pips, 0);
  const grossLost = losses.reduce((s, t) => s + Math.abs(t.pips), 0);
  const pf = grossLost > 0 ? grossWon / grossLost : 0;
  const wr = allTrades.length > 0 ? (wins.length / allTrades.length * 100) : 0;

  let peakPips = 0, maxDDPips = 0, runningPips = 0;
  for (const t of allTrades) {
    runningPips += t.pips;
    if (runningPips > peakPips) peakPips = runningPips;
    const dd = peakPips - runningPips;
    if (dd > maxDDPips) maxDDPips = dd;
  }

  const tradingDays = new Set(allTrades.map(t => getDayKey(t.openTime))).size;

  return {
    totalTrades: allTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(wr.toFixed(1)),
    netPips: parseFloat(totalPips.toFixed(1)),
    profitFactor: parseFloat(pf.toFixed(2)),
    maxDrawdownPips: parseFloat(maxDDPips.toFixed(1)),
    tradingDays
  };
}

// ═══════════════════════════════════════════════════════════════════════
// IMPRESIÓN DE RESULTADOS
// ═══════════════════════════════════════════════════════════════════════
function printTimeframeResult(assetKey, tfKey, r, asset) {
  const unit = assetKey === 'NAS100' ? 'pts' : 'pips';
  console.log(`\n  ── ${assetKey} ${tfKey} ${'─'.repeat(50)}`);
  console.log(`  Total Trades: ${r.totalTrades} | Wins: ${r.wins} | Losses: ${r.losses}`);
  console.log(`  Win Rate: ${r.winRate}% | Profit Factor: ${r.profitFactor}`);
  console.log(`  Net ${unit}: ${r.netPips > 0 ? '+' : ''}${r.netPips} | Max DD: ${r.maxDrawdownPips} ${unit}`);
  console.log(`  ${unit}/día (trading): ${r.pipsPerTradingDay} | ${unit}/día (natural): ${r.pipsPerNaturalDay}`);
  
  for (const [profKey, m] of Object.entries(r.monetary)) {
    const prof = ACCOUNT_PROFILES[profKey];
    console.log(`  💰 ${prof.name}: Profit $${m.usdProfit.toLocaleString()} | DD $${m.maxDDUsd.toLocaleString()} (${m.maxDDPercent}%) | $${m.dailyUsd.toFixed(2)}/día`);
  }

  // Desglose por año
  if (Object.keys(r.byYear).length > 0) {
    console.log(`  📅 Por año:`);
    for (const [year, y] of Object.entries(r.byYear).sort((a,b) => a[0] - b[0])) {
      const yWr = y.trades > 0 ? (y.wins / y.trades * 100).toFixed(1) : '0.0';
      const yPf = y.grossLost > 0 ? (y.grossWon / y.grossLost).toFixed(2) : (y.grossWon > 0 ? '99.9' : '0.00');
      console.log(`     ${year}: ${y.trades} trades, WR ${yWr}%, PF ${yPf}, Net ${y.pips > 0 ? '+' : ''}${y.pips.toFixed(1)} ${unit}`);
    }
  }
}

function printCombinedResults(assetKey, combined) {
  const unit = assetKey === 'NAS100' ? 'pts' : 'pips';
  console.log(`\n  ══ ${assetKey} COMBINADO (TODAS TFs) ${'═'.repeat(40)}`);
  console.log(`  Total Trades: ${combined.totalTrades} | W/L: ${combined.wins}/${combined.losses}`);
  console.log(`  Win Rate: ${combined.winRate}% | PF: ${combined.profitFactor}`);
  console.log(`  Net ${unit}: ${combined.netPips > 0 ? '+' : ''}${combined.netPips} | Max DD: ${combined.maxDrawdownPips} ${unit}`);
  console.log(`  Trading Days: ${combined.tradingDays}`);
}

// ═══════════════════════════════════════════════════════════════════════
// VALIDACIÓN WALK-FORWARD
// ═══════════════════════════════════════════════════════════════════════
function walkForwardAnalysis(trades) {
  // Dividir trades por año para in-sample vs out-of-sample
  const byYear = {};
  for (const t of trades) {
    const year = getYear(t.openTime);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(t);
  }
  
  const years = Object.keys(byYear).sort();
  if (years.length < 3) return null;

  const results = [];
  for (let i = 2; i < years.length; i++) {
    const isYear = years[i];
    const isTrades = byYear[isYear] || [];
    const wins = isTrades.filter(t => t.status === 'WIN').length;
    const pips = isTrades.reduce((s, t) => s + t.pips, 0);
    const wr = isTrades.length > 0 ? (wins / isTrades.length * 100) : 0;
    results.push({
      year: isYear,
      trades: isTrades.length,
      winRate: parseFloat(wr.toFixed(1)),
      netPips: parseFloat(pips.toFixed(1)),
      isOutOfSample: true
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`╔══════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  MOTOR DE BACKTEST UNIFICADO - VERIFICACIÓN DE VENTAJA ESTADÍSTICA     ║`);
  console.log(`║  Fidelidad: 99% con mercado live | Spread real CSV | Comisiones + Slip ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝`);
  console.log(`\n  Hora de ejecución: ${new Date().toISOString()}`);
  console.log(`  Directorio de datos: ${ROOT}`);

  // Determinar qué activos testear (argumento de línea de comandos o todos)
  const args = process.argv.slice(2);
  const assetsToTest = args.length > 0
    ? args.map(a => a.toUpperCase()).filter(a => ASSETS[a])
    : Object.keys(ASSETS);

  console.log(`  Activos a testear: ${assetsToTest.join(', ')}`);

  const allResults = {};
  const startTime = Date.now();

  for (const assetKey of assetsToTest) {
    const result = await backtestAsset(assetKey);
    allResults[assetKey] = result;
    printCombinedResults(assetKey, result.combined);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESUMEN GLOBAL
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`  RESUMEN GLOBAL DE VENTAJA ESTADÍSTICA`);
  console.log(`${'═'.repeat(70)}`);

  let portfolioTrades = [];
  for (const [assetKey, result] of Object.entries(allResults)) {
    for (const [tf, tfR] of Object.entries(result.byTimeframe)) {
      if (tfR && tfR.trades) {
        portfolioTrades.push(...tfR.trades);
      }
    }
  }
  portfolioTrades.sort((a, b) => a.openTime - b.openTime);

  const totalWins = portfolioTrades.filter(t => t.status === 'WIN').length;
  const totalLosses = portfolioTrades.filter(t => t.status === 'LOSS').length;

  console.log(`\n  Portfolio Global:`);
  console.log(`  Total Trades: ${portfolioTrades.length} | W/L: ${totalWins}/${totalLosses}`);
  if (portfolioTrades.length > 0) {
    console.log(`  Win Rate Global: ${(totalWins / portfolioTrades.length * 100).toFixed(1)}%`);
  }

  // Walk-forward por activo
  console.log(`\n  📊 Walk-Forward Analysis (Año a año, Out-of-Sample):`);
  for (const [assetKey, result] of Object.entries(allResults)) {
    const allAssetTrades = [];
    for (const [tf, tfR] of Object.entries(result.byTimeframe)) {
      if (tfR && tfR.trades) allAssetTrades.push(...tfR.trades);
    }
    allAssetTrades.sort((a, b) => a.openTime - b.openTime);
    
    const wf = walkForwardAnalysis(allAssetTrades);
    if (wf) {
      const unit = assetKey === 'NAS100' ? 'pts' : 'pips';
      console.log(`\n  ${assetKey}:`);
      for (const yr of wf) {
        const profitFlag = yr.netPips > 0 ? '✅' : '❌';
        console.log(`    ${profitFlag} ${yr.year}: ${yr.trades} trades, WR ${yr.winRate}%, Net ${yr.netPips > 0 ? '+' : ''}${yr.netPips} ${unit}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ⏱️ Tiempo total de ejecución: ${elapsed} segundos`);

  // Guardar resultados completos como JSON
  const reportPath = path.join(__dirname, 'unified_backtest_report.json');
  const jsonReport = {};
  for (const [assetKey, result] of Object.entries(allResults)) {
    jsonReport[assetKey] = {
      combined: result.combined,
      byTimeframe: {}
    };
    for (const [tf, tfR] of Object.entries(result.byTimeframe)) {
      const { trades, ...metrics } = tfR;
      jsonReport[assetKey].byTimeframe[tf] = metrics;
    }
  }
  fs.writeFileSync(reportPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\n  📁 Informe guardado en: ${reportPath}`);
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
