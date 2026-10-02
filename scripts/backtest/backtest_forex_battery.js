/**
 * Batería Cuantitativa Institucional BPR para Forex: EURUSD y GBPJPY
 * Periodo: 2020 - 2026 (~7 años de datos reales ECN)
 * 
 * Evalúa:
 * - Temporalidades: M1, M2, M3, M5, M15
 * - Modelos:
 *   A) Ratio Positivo (1:2 - 1:2.5)
 *   B) Asimétrico / R:R Inverso (Alta Probabilidad)
 *   C) Scalping Simétrico (1:1.5)
 * - Fricción Real: Spread real del broker + Deslizamiento (Slippage)
 * - Sesión: 24h vs London+NY (07:00 - 18:00 UTC)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ASSETS = {
  EURUSD: {
    symbol: 'EURUSD',
    pipScale: 0.0001,
    frictionPips: 0.6, // 0.4p spread + 0.2p slippage
    files: {
      M15: path.join(__dirname, '..', '..', 'EURUSD_M15_202001020600_202610011015.csv'),
      M5:  path.join(__dirname, '..', '..', 'EURUSD_M5_202001020600_202610011025.csv'),
      M3:  path.join(__dirname, '..', '..', 'EURUSD_M3_202001020600_202610011027.csv'),
      M2:  path.join(__dirname, '..', '..', 'EURUSD_M2_202001020600_202610011028.csv'),
      M1:  path.join(__dirname, '..', '..', 'EURUSD_M1_202001020600_202610011029.csv')
    },
    configs: {
      M15: {
        minFvgGap: 0.00045, minOverlap: 0.00025,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 15p / TP 35p)', sl: 15.0, tp: 35.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 20p / TP 14p)',     sl: 20.0, tp: 14.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 10p / TP 18p)',       sl: 10.0, tp: 18.0 }
        }
      },
      M5: {
        minFvgGap: 0.00025, minOverlap: 0.00015,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 8p / TP 18p)',  sl: 8.0,  tp: 18.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 12p / TP 8p)',      sl: 12.0, tp: 8.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 6p / TP 10p)',        sl: 6.0,  tp: 10.0 }
        }
      },
      M3: {
        minFvgGap: 0.00018, minOverlap: 0.00010,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 6p / TP 14p)',  sl: 6.0,  tp: 14.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 9p / TP 6p)',       sl: 9.0,  tp: 6.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 5p / TP 8p)',         sl: 5.0,  tp: 8.0 }
        }
      },
      M2: {
        minFvgGap: 0.00015, minOverlap: 0.00008,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 5p / TP 12p)',  sl: 5.0,  tp: 12.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 7p / TP 5p)',       sl: 7.0,  tp: 5.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 4p / TP 7p)',         sl: 4.0,  tp: 7.0 }
        }
      },
      M1: {
        minFvgGap: 0.00012, minOverlap: 0.00006,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 4.5p / TP 10p)', sl: 4.5, tp: 10.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 6p / TP 4p)',        sl: 6.0, tp: 4.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 3.5p / TP 5.5p)',      sl: 3.5, tp: 5.5 }
        }
      }
    }
  },
  GBPJPY: {
    symbol: 'GBPJPY',
    pipScale: 0.01,
    frictionPips: 1.5, // 1.0p spread + 0.5p slippage
    files: {
      M15: path.join(__dirname, '..', '..', 'GBPJPY_M15_202001020600_202610011015.csv'),
      M5:  path.join(__dirname, '..', '..', 'GBPJPY_M5_202001020600_202610011025.csv'),
      M3:  path.join(__dirname, '..', '..', 'GBPJPY_M3_202001020600_202610011027.csv'),
      M2:  path.join(__dirname, '..', '..', 'GBPJPY_M2_202001020600_202610011028.csv'),
      M1:  path.join(__dirname, '..', '..', 'GBPJPY_M1_202001020600_202610011029.csv')
    },
    configs: {
      M15: {
        minFvgGap: 0.12, minOverlap: 0.06,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 35p / TP 85p)', sl: 35.0, tp: 85.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 45p / TP 30p)',     sl: 45.0, tp: 30.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 25p / TP 45p)',       sl: 25.0, tp: 45.0 }
        }
      },
      M5: {
        minFvgGap: 0.06, minOverlap: 0.03,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 20p / TP 48p)', sl: 20.0, tp: 48.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 26p / TP 18p)',     sl: 26.0, tp: 18.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 15p / TP 26p)',       sl: 15.0, tp: 26.0 }
        }
      },
      M3: {
        minFvgGap: 0.045, minOverlap: 0.02,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 15p / TP 36p)', sl: 15.0, tp: 36.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 20p / TP 14p)',     sl: 20.0, tp: 14.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 12p / TP 20p)',       sl: 12.0, tp: 20.0 }
        }
      },
      M2: {
        minFvgGap: 0.035, minOverlap: 0.015,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 12p / TP 28p)', sl: 12.0, tp: 28.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 16p / TP 11p)',     sl: 16.0, tp: 11.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 10p / TP 16p)',       sl: 10.0, tp: 16.0 }
        }
      },
      M1: {
        minFvgGap: 0.025, minOverlap: 0.01,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 10p / TP 22p)', sl: 10.0, tp: 22.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 14p / TP 9p)',      sl: 14.0, tp: 9.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 8p / TP 13p)',        sl: 8.0,  tp: 13.0 }
        }
      }
    }
  }
};

async function loadCandles(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`Archivo no encontrado: ${filePath}`);
    return [];
  }
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
      year: y,
      hour: h,
      minute: min,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5])
    });
  }

  // Precalcular EMA 100
  if (candles.length > 0) {
    let ema = candles[0].close;
    const k = 2 / (100 + 1);
    candles.forEach(c => {
      ema = c.close * k + ema * (1 - k);
      c.ema100 = ema;
    });
  }

  return candles;
}

function findBprZones(candles, minFvgGap, minOverlap) {
  const bprZones = [];
  let lastBearishFVGIdx = -999;
  let lastBullishFVGIdx = -999;

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i];
    const c2 = candles[i - 2];
    const isBearishFVG = (c2.low - c0.high) >= minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= minFvgGap;

    if (isBearishFVG) lastBearishFVGIdx = i;
    if (isBullishFVG) lastBullishFVGIdx = i;

    if (isBullishFVG && (i - lastBearishFVGIdx) <= 10 && (i - lastBearishFVGIdx) > 0) {
      const bearTop = candles[lastBearishFVGIdx - 2].low;
      const bearBottom = candles[lastBearishFVGIdx].high;
      const bullTop = c0.low;
      const bullBottom = c2.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);

      if (cHigh > cLow && (cHigh - cLow) >= minOverlap) {
        bprZones.push({
          type: 'BULLISH_BPR',
          high: cHigh,
          low: cLow,
          barIndex: i,
          mitigated: false
        });
      }
    }

    if (isBearishFVG && (i - lastBullishFVGIdx) <= 10 && (i - lastBullishFVGIdx) > 0) {
      const bullTop = candles[lastBullishFVGIdx].low;
      const bullBottom = candles[lastBullishFVGIdx - 2].high;
      const bearTop = c2.low;
      const bearBottom = c0.high;
      const cLow = Math.max(bearBottom, bullBottom);
      const cHigh = Math.min(bearTop, bullTop);

      if (cHigh > cLow && (cHigh - cLow) >= minOverlap) {
        bprZones.push({
          type: 'BEARISH_BPR',
          high: cHigh,
          low: cLow,
          barIndex: i,
          mitigated: false
        });
      }
    }
  }

  return bprZones;
}

function runSimulation(candles, rawBprZones, params) {
  const { slPips, tpPips, pipScale, frictionPips, sessionFilter } = params;
  const slUnits = slPips * pipScale;
  const tpUnits = tpPips * pipScale;

  // Clonar zonas para que no se contaminen entre ejecuciones de modelos
  const bprZones = rawBprZones.map(z => ({ ...z }));

  let activeTrade = null;
  const trades = [];
  let zoneIdx = 0;

  for (let i = 100; i < candles.length; i++) {
    const c = candles[i];

    // Simular trade activo
    if (activeTrade) {
      if (activeTrade.type === 'BUY') {
        if (c.high >= activeTrade.tpPrice) {
          const rawPips = (activeTrade.tpPrice - activeTrade.entryPrice) / pipScale;
          const netPips = rawPips - frictionPips;
          trades.push({ type: 'BUY', result: 'WIN', pips: netPips, bar: i });
          activeTrade = null;
        } else if (c.low <= activeTrade.slPrice) {
          const rawPips = (activeTrade.slPrice - activeTrade.entryPrice) / pipScale;
          const netPips = rawPips - frictionPips;
          trades.push({ type: 'BUY', result: 'LOSS', pips: netPips, bar: i });
          activeTrade = null;
        }
      } else { // SELL
        if (c.low <= activeTrade.tpPrice) {
          const rawPips = (activeTrade.entryPrice - activeTrade.tpPrice) / pipScale;
          const netPips = rawPips - frictionPips;
          trades.push({ type: 'SELL', result: 'WIN', pips: netPips, bar: i });
          activeTrade = null;
        } else if (c.high >= activeTrade.slPrice) {
          const rawPips = (activeTrade.entryPrice - activeTrade.slPrice) / pipScale;
          const netPips = rawPips - frictionPips;
          trades.push({ type: 'SELL', result: 'LOSS', pips: netPips, bar: i });
          activeTrade = null;
        }
      }
    }

    if (activeTrade) continue;

    // Filtro de sesión (London + NY: 07:00 - 18:00 UTC)
    if (sessionFilter === 'LONDON_NY') {
      if (c.hour < 7 || c.hour >= 18) continue;
    }

    // Rollover Shield (21:55 - 23:15 UTC)
    if (c.hour === 22 || (c.hour === 21 && c.minute >= 55) || (c.hour === 23 && c.minute <= 15)) continue;

    // Evaluar nuevas señales
    while (zoneIdx < bprZones.length && bprZones[zoneIdx].barIndex < (i - 20)) {
      zoneIdx++;
    }

    for (let z = zoneIdx; z < bprZones.length; z++) {
      const zone = bprZones[z];
      if (zone.barIndex >= i) break;
      if (zone.mitigated) continue;

      const candleRange = c.high - c.low;
      if (candleRange <= 0) continue;

      // BULLISH SETUP
      if (zone.type === 'BULLISH_BPR' && c.low <= zone.high && c.close >= zone.low && c.close > c.ema100) {
        const lowerWick = Math.min(c.open, c.close) - c.low;
        if (lowerWick / candleRange >= 0.20) {
          zone.mitigated = true;
          activeTrade = {
            type: 'BUY',
            entryPrice: c.close,
            slPrice: c.close - slUnits,
            tpPrice: c.close + tpUnits
          };
          break;
        }
      }

      // BEARISH SETUP
      if (zone.type === 'BEARISH_BPR' && c.high >= zone.low && c.close <= zone.high && c.close < c.ema100) {
        const upperWick = c.high - Math.max(c.open, c.close);
        if (upperWick / candleRange >= 0.20) {
          zone.mitigated = true;
          activeTrade = {
            type: 'SELL',
            entryPrice: c.close,
            slPrice: c.close + slUnits,
            tpPrice: c.close - tpUnits
          };
          break;
        }
      }
    }
  }

  // Métricas
  const total = trades.length;
  if (total === 0) return { totalTrades: 0, winRate: 0, netPips: 0, profitFactor: 0, maxDd: 0 };

  const wins = trades.filter(t => t.result === 'WIN').length;
  const winRate = (wins / total) * 100.0;
  const totalNet = trades.reduce((acc, t) => acc + t.pips, 0);
  const grossProfit = trades.filter(t => t.pips > 0).reduce((acc, t) => acc + t.pips, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pips < 0).reduce((acc, t) => acc + t.pips, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : 99.0;

  let peak = 0;
  let running = 0;
  let maxDd = 0;
  for (const t of trades) {
    running += t.pips;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    totalTrades: total,
    winRate: parseFloat(winRate.toFixed(1)),
    netPips: parseFloat(totalNet.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDd: parseFloat(maxDd.toFixed(1))
  };
}

async function runBattery() {
  console.log('========================================================================================');
  console.log('🏛️ BATERÍA CUANTITATIVA INSTITUCIONAL BPR FOREX (2020 - 2026)');
  console.log('   Pares: EURUSD (Spread 0.4p + Slip 0.2p) y GBPJPY (Spread 1.0p + Slip 0.5p)');
  console.log('========================================================================================\n');

  for (const [assetKey, assetDef] of Object.entries(ASSETS)) {
    console.log(`\n========================================================================================`);
    console.log(`📊 ANALIZANDO ACTIVO: ${assetDef.symbol} (Fricción Total: ${assetDef.frictionPips} pips)`);
    console.log(`========================================================================================`);

    for (const [tf, cfg] of Object.entries(assetDef.configs)) {
      const filePath = assetDef.files[tf];
      if (!fs.existsSync(filePath)) {
        console.warn(`[${assetDef.symbol} ${tf}] Archivo no encontrado.`);
        continue;
      }

      process.stdout.write(`⏳ Cargando ${assetDef.symbol} ${tf}... `);
      const candles = await loadCandles(filePath);
      console.log(`${candles.length.toLocaleString()} velas cargadas. Trazando BPRs...`);
      const bprZones = findBprZones(candles, cfg.minFvgGap, cfg.minOverlap);

      console.log(`----------------------------------------------------------------------------------------`);
      console.log(`TF: ${tf} | BPRs Detectados: ${bprZones.length}`);
      console.log(`----------------------------------------------------------------------------------------`);

      for (const [modKey, mDef] of Object.entries(cfg.models)) {
        // 1. Sesión London + NY
        const resLondon = runSimulation(candles, bprZones, {
          slPips: mDef.sl,
          tpPips: mDef.tp,
          pipScale: assetDef.pipScale,
          frictionPips: assetDef.frictionPips,
          sessionFilter: 'LONDON_NY'
        });

        // 2. Sesión 24H
        const res24h = runSimulation(candles, bprZones, {
          slPips: mDef.sl,
          tpPips: mDef.tp,
          pipScale: assetDef.pipScale,
          frictionPips: assetDef.frictionPips,
          sessionFilter: '24H'
        });

        console.log(`🔹 [${mDef.name}]`);
        console.log(`   - London+NY : ${resLondon.totalTrades} trades | Win: ${resLondon.winRate}% | Net: ${resLondon.netPips > 0 ? '+' : ''}${resLondon.netPips}p | PF: ${resLondon.profitFactor} | MaxDD: ${resLondon.maxDd}p`);
        console.log(`   - 24 Horas  : ${res24h.totalTrades} trades | Win: ${res24h.winRate}% | Net: ${res24h.netPips > 0 ? '+' : ''}${res24h.netPips}p | PF: ${res24h.profitFactor} | MaxDD: ${res24h.maxDd}p`);
      }
    }
  }

  console.log('\n========================================================================================');
  console.log('✅ Batería Cuantitativa Forex Finalizada con Éxito.');
  console.log('========================================================================================');
}

runBattery().catch(console.error);
