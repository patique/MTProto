/**
 * Batería Cuantitativa Institucional BPR para Metales: XAUUSD (Oro) y XAGUSD (Plata)
 * Periodo Completo: 2020 a 2026 (~7 años de datos reales del broker)
 * 
 * Evalúa:
 * - Temporalidades: M1, M2, M3, M5, M15
 * - Modelos de Riesgo:
 *   A) Ratio Positivo Institucional (1:2 - 1:2.5)
 *   B) Asimétrico / R:R Inverso Alta Probabilidad (Rechazo Inmediato)
 *   C) Scalping Simétrico (1:1.5 - 1:1.8)
 * - Fricción Real:
 *   XAUUSD: 0.35$ (3.5 pips)
 *   XAGUSD: 0.035$ (3.5 pips)
 * - Sesión: 24 Horas vs London+NY Core (07:00 - 18:00 UTC)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const METALS = {
  XAUUSD: {
    symbol: 'XAUUSD',
    name: 'Oro (Gold)',
    pipScale: 0.10, // 1 pip = 0.10$
    frictionPips: 3.5, // 0.35$ total (spread 3.0p + slip 0.5p)
    files: {
      M15: path.join(__dirname, '..', '..', 'XAUUSD_M15_202001020600_202610011115.csv'),
      M5:  path.join(__dirname, '..', '..', 'XAUUSD_M5_202001020600_202610011120.csv'),
      M3:  path.join(__dirname, '..', '..', 'XAUUSD_M3_202001020600_202610011121.csv'),
      M2:  path.join(__dirname, '..', '..', 'XAUUSD_M2_202001020600_202610011120.csv'),
      M1:  path.join(__dirname, '..', '..', 'XAUUSD_M1_202001020600_202610011121.csv')
    },
    configs: {
      M15: {
        minFvgGap: 0.50, minOverlap: 0.30,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 25p / TP 60p)', sl: 25.0, tp: 60.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 35p / TP 25p)',     sl: 35.0, tp: 25.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 20p / TP 35p)',       sl: 20.0, tp: 35.0 }
        }
      },
      M5: {
        minFvgGap: 0.30, minOverlap: 0.18,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 15p / TP 40p)', sl: 15.0, tp: 40.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 22p / TP 16p)',     sl: 22.0, tp: 16.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 12p / TP 20p)',       sl: 12.0, tp: 20.0 }
        }
      },
      M3: {
        minFvgGap: 0.20, minOverlap: 0.12,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 12p / TP 30p)', sl: 12.0, tp: 30.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 18p / TP 12p)',     sl: 18.0, tp: 12.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 10p / TP 16p)',       sl: 10.0, tp: 16.0 }
        }
      },
      M2: {
        minFvgGap: 0.18, minOverlap: 0.10,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 10p / TP 25p)', sl: 10.0, tp: 25.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 15p / TP 10p)',     sl: 15.0, tp: 10.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 8p / TP 14p)',        sl: 8.0,  tp: 14.0 }
        }
      },
      M1: {
        minFvgGap: 0.15, minOverlap: 0.08,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 10p / TP 22p)', sl: 10.0, tp: 22.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 14p / TP 9p)',      sl: 14.0, tp: 9.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 8p / TP 12p)',        sl: 8.0,  tp: 12.0 }
        }
      }
    }
  },
  XAGUSD: {
    symbol: 'XAGUSD',
    name: 'Plata (Silver)',
    pipScale: 0.01, // 1 pip = 0.01$ (1 centavo)
    frictionPips: 3.5, // 0.035$ total (spread 3.0p + slip 0.5p)
    files: {
      M15: path.join(__dirname, '..', '..', 'XAGUSD_M15_202001020600_202610011015.csv'),
      M5:  path.join(__dirname, '..', '..', 'XAGUSD_M5_202001020600_202610011025.csv'),
      M3:  path.join(__dirname, '..', '..', 'XAGUSD_M3_202001020600_202610011027.csv'),
      M2:  path.join(__dirname, '..', '..', 'XAGUSD_M2_202001020600_202610011028.csv'),
      M1:  path.join(__dirname, '..', '..', 'XAGUSD_M1_202001020600_202610011029.csv')
    },
    configs: {
      M15: {
        minFvgGap: 0.06, minOverlap: 0.03,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 35p / TP 85p)', sl: 35.0, tp: 85.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 45p / TP 30p)',     sl: 45.0, tp: 30.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 25p / TP 45p)',       sl: 25.0, tp: 45.0 }
        }
      },
      M5: {
        minFvgGap: 0.035, minOverlap: 0.02,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 20p / TP 50p)', sl: 20.0, tp: 50.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 28p / TP 18p)',     sl: 28.0, tp: 18.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 15p / TP 28p)',       sl: 15.0, tp: 28.0 }
        }
      },
      M3: {
        minFvgGap: 0.025, minOverlap: 0.015,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 15p / TP 38p)', sl: 15.0, tp: 38.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 22p / TP 14p)',     sl: 22.0, tp: 14.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 12p / TP 22p)',       sl: 12.0, tp: 22.0 }
        }
      },
      M2: {
        minFvgGap: 0.020, minOverlap: 0.010,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 12p / TP 30p)', sl: 12.0, tp: 30.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 18p / TP 11p)',     sl: 18.0, tp: 11.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 10p / TP 18p)',       sl: 10.0, tp: 18.0 }
        }
      },
      M1: {
        minFvgGap: 0.015, minOverlap: 0.008,
        models: {
          'A_POS_RR':    { name: 'A) Ratio Positivo (SL 10p / TP 22p)', sl: 10.0, tp: 22.0 },
          'B_ASYMM_NEG': { name: 'B) Asimétrico (SL 14p / TP 9p)',      sl: 14.0, tp: 9.0 },
          'C_SCALP_SYM': { name: 'C) Scalping (SL 8p / TP 14p)',        sl: 8.0,  tp: 14.0 }
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

    // Filtro de sesión (London + NY Core: 07:00 - 18:00 UTC)
    if (sessionFilter === 'LONDON_NY') {
      if (c.hour < 7 || c.hour >= 18) continue;
    }

    // Rollover Shield (21:55 - 23:15 UTC)
    if (c.hour === 22 || (c.hour === 21 && c.minute >= 55) || (c.hour === 23 && c.minute <= 15)) continue;

    // Evaluar nuevas señales dentro de las últimas 20 barras
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

async function runMetalsBattery() {
  console.log('========================================================================================');
  console.log('🏛️ BATERÍA CUANTITATIVA INSTITUCIONAL BPR METALES PRECIOSOS (2020 - 2026)');
  console.log('   Activos: XAUUSD (Oro) y XAGUSD (Plata) | Fricción Real Spread + Slippage');
  console.log('========================================================================================\n');

  for (const [metalKey, mDef] of Object.entries(METALS)) {
    console.log(`\n========================================================================================`);
    console.log(`📊 ANALIZANDO: ${mDef.name} [${mDef.symbol}] (Fricción: ${mDef.frictionPips} pips / ${mDef.frictionPips * mDef.pipScale}$)`);
    console.log(`========================================================================================`);

    for (const [tf, cfg] of Object.entries(mDef.configs)) {
      const filePath = mDef.files[tf];
      if (!fs.existsSync(filePath)) {
        console.warn(`[${mDef.symbol} ${tf}] Archivo no encontrado.`);
        continue;
      }

      process.stdout.write(`⏳ Cargando ${mDef.symbol} ${tf}... `);
      const candles = await loadCandles(filePath);
      console.log(`${candles.length.toLocaleString()} velas cargadas. Trazando BPRs...`);
      const bprZones = findBprZones(candles, cfg.minFvgGap, cfg.minOverlap);

      console.log(`----------------------------------------------------------------------------------------`);
      console.log(`TF: ${tf} | BPRs Detectados: ${bprZones.length}`);
      console.log(`----------------------------------------------------------------------------------------`);

      for (const [modKey, modelDef] of Object.entries(cfg.models)) {
        // 1. London + NY Core
        const resLondon = runSimulation(candles, bprZones, {
          slPips: modelDef.sl,
          tpPips: modelDef.tp,
          pipScale: mDef.pipScale,
          frictionPips: mDef.frictionPips,
          sessionFilter: 'LONDON_NY'
        });

        // 2. 24 Horas
        const res24h = runSimulation(candles, bprZones, {
          slPips: modelDef.sl,
          tpPips: modelDef.tp,
          pipScale: mDef.pipScale,
          frictionPips: mDef.frictionPips,
          sessionFilter: '24H'
        });

        console.log(`🔹 [${modelDef.name}]`);
        console.log(`   - London+NY : ${resLondon.totalTrades} trades | Win: ${resLondon.winRate}% | Net: ${resLondon.netPips > 0 ? '+' : ''}${resLondon.netPips}p | PF: ${resLondon.profitFactor} | MaxDD: ${resLondon.maxDd}p`);
        console.log(`   - 24 Horas  : ${res24h.totalTrades} trades | Win: ${res24h.winRate}% | Net: ${res24h.netPips > 0 ? '+' : ''}${res24h.netPips}p | PF: ${res24h.profitFactor} | MaxDD: ${res24h.maxDd}p`);
      }
    }
  }

  console.log('\n========================================================================================');
  console.log('✅ Batería Cuantitativa Metales (XAUUSD y XAGUSD) Finalizada con Éxito.');
  console.log('========================================================================================');
}

runMetalsBattery().catch(console.error);
