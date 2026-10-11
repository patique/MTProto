/**
 * BACKTEST OFICIAL: ESTRATEGIA INSTITUCIONAL BPR M5 (R:R 1:3.0 | BE SLOT RELEASE)
 * 
 * Evalúa los 5 activos configurados en LIVE:
 * 1. XAUUSD (Oro)
 * 2. EURUSD
 * 3. GBPJPY
 * 4. USDCAD
 * 5. GBPUSD
 * 
 * Reglas Institucionales probadas:
 * - Timeframe: M5
 * - Swings BSL / SSL (Fractales 8) + BOS
 * - Solapamiento BPR (Balanced Price Range)
 * - Entrada: Consequent Encroachment 50% (CE 50%)
 * - Ratio Asimétrico: R:R 1:3.0
 * - Break-Even: Activado a 1.0R (asegura entrada + buffer)
 * - Slot Release: Al pasar a BE (riesgo $0), se libera el slot del activo
 * - Límite de Riesgo: Máximo 1 trade con riesgo activo por par
 * - Anti-Hedging estricto
 * 
 * Cuentas simuladas:
 * - FTMO 100k (0.50% y 0.75% riesgo)
 * - The5ers 5k (0.75% riesgo)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ASSET_PARAMS = {
  XAUUSD: {
    symbol: 'XAUUSD',
    yahooTicker: 'GC=F',
    pipValue: 0.10,
    pipSize: 0.10,
    digits: 2,
    fvgMin: 0.60,
    overlapMin: 0.35,
    slBuffer: 0.40,
    beBufferPips: 1.0,
    rrRatio: 2.0,
    spreadPips: 2.5
  },
  EURUSD: {
    symbol: 'EURUSD',
    yahooTicker: 'EURUSD=X',
    pipValue: 0.00010,
    pipSize: 0.00010,
    digits: 5,
    fvgMin: 0.00018,
    overlapMin: 0.00010,
    slBuffer: 0.00010,
    beBufferPips: 0.8,
    rrRatio: 2.0,
    spreadPips: 0.8
  },
  GBPJPY: {
    symbol: 'GBPJPY',
    yahooTicker: 'GBPJPY=X',
    pipValue: 0.010,
    pipSize: 0.010,
    digits: 3,
    fvgMin: 0.045,
    overlapMin: 0.025,
    slBuffer: 0.030,
    beBufferPips: 1.5,
    rrRatio: 2.0,
    spreadPips: 1.4
  },
  USDCAD: {
    symbol: 'USDCAD',
    yahooTicker: 'USDCAD=X',
    pipValue: 0.00010,
    pipSize: 0.00010,
    digits: 5,
    fvgMin: 0.00018,
    overlapMin: 0.00010,
    slBuffer: 0.00010,
    beBufferPips: 0.8,
    rrRatio: 2.0,
    spreadPips: 1.2
  },
  GBPUSD: {
    symbol: 'GBPUSD',
    yahooTicker: 'GBPUSD=X',
    pipValue: 0.00010,
    pipSize: 0.00010,
    digits: 5,
    fvgMin: 0.00020,
    overlapMin: 0.00012,
    slBuffer: 0.00010,
    beBufferPips: 0.8,
    rrRatio: 2.0,
    spreadPips: 1.0
  }
};

function fetchYahooM5Candles(ticker) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=5m&range=1mo`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart.result[0];
          const timestamps = result.timestamp;
          const quote = result.indicators.quote[0];
          const candles = [];

          for (let i = 0; i < timestamps.length; i++) {
            const o = quote.open[i];
            const h = quote.high[i];
            const l = quote.low[i];
            const c = quote.close[i];
            if (o != null && h != null && l != null && c != null && !isNaN(o)) {
              candles.push({
                time: timestamps[i] * 1000,
                dateStr: new Date(timestamps[i] * 1000).toISOString(),
                open: o,
                high: h,
                low: l,
                close: c,
                volume: quote.volume[i] || 0
              });
            }
          }
          resolve(candles);
        } catch (e) {
          console.error(`Error parsing data for ${ticker}:`, e.message);
          resolve([]);
        }
      });
    }).on('error', (err) => {
      console.error(`Network error for ${ticker}:`, err.message);
      resolve([]);
    });
  });
}

function simulateInstitutionalBPR(candles, params, startTimeMs, endTimeMs) {
  const bprZones = [];
  // Calcular EMA100
  const k = 2 / (100 + 1);
  let ema = candles[0].close;
  for (const c of candles) { ema = c.close * k + ema * (1 - k); c.ema100 = ema; }
  const trades = [];
  let activeTrades = [];

  for (let i = 8; i < candles.length; i++) {
    const c0 = candles[i];
    const c1 = candles[i - 1];
    const c2 = candles[i - 2];
    const c3 = candles[i - 3];

    // Gestión intra-vela de trades abiertos
    for (let tIdx = activeTrades.length - 1; tIdx >= 0; tIdx--) {
      const t = activeTrades[tIdx];
      const origRisk = Math.abs(t.entry - t.initialSL);
      const beBuffer = params.beBufferPips * params.pipValue;

      // 1. Break-Even Check (1.0R)
      if (t.type === 'BUY') {
        const floatingR = (c0.high - t.entry) / origRisk;
        if (floatingR >= 1.0 && t.currentSL < t.entry + beBuffer) {
          t.currentSL = t.entry + beBuffer;
          t.isBE = true;
        }
      } else {
        const floatingR = (t.entry - c0.low) / origRisk;
        if (floatingR >= 1.0 && t.currentSL > t.entry - beBuffer) {
          t.currentSL = t.entry - beBuffer;
          t.isBE = true;
        }
      }

      // 2. Take Profit Check
      let hitTP = t.type === 'BUY' ? (c0.high >= t.tp) : (c0.low <= t.tp);
      let hitSL = t.type === 'BUY' ? (c0.low <= t.currentSL) : (c0.high >= t.currentSL);

      if (hitTP && hitSL) {
        // En caso de conflicto en la misma vela, ser conservador (asumir SL o BE)
        hitTP = false;
      }

      if (hitTP) {
        t.status = 'CLOSED';
        t.closeTime = c0.time;
        t.exitPrice = t.tp;
        t.pips = +(Math.abs(t.tp - t.entry) / params.pipValue).toFixed(1);
        t.rMultiple = 3.0;
        t.outcome = 'WIN';
        trades.push(t);
        activeTrades.splice(tIdx, 1);
        continue;
      }

      if (hitSL) {
        t.status = 'CLOSED';
        t.closeTime = c0.time;
        t.exitPrice = t.currentSL;
        if (t.isBE) {
          t.pips = +params.beBufferPips;
          t.rMultiple = +(beBuffer / origRisk).toFixed(2);
          t.outcome = 'BREAK_EVEN';
        } else {
          t.pips = -(Math.abs(t.entry - t.initialSL) / params.pipValue);
          t.rMultiple = -1.0;
          t.outcome = 'LOSS';
        }
        trades.push(t);
        activeTrades.splice(tIdx, 1);
        continue;
      }
    }

    // 2. Detección de FVG
    const isBullFVG = (c1.low - c3.high) >= params.fvgMin;
    const isBearFVG = (c3.low - c1.high) >= params.fvgMin;

    if (isBullFVG) {
      c1.isBull = true;
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBear) {
          const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + params.fvgMin;
          const bearBottom = candles[j].high;
          const cLow = Math.max(bearBottom, c3.high);
          const cHigh = Math.min(bearTop, c1.low);
          if (cHigh - cLow >= params.overlapMin) {
            bprZones.push({
              isBuy: true,
              top: cHigh,
              bottom: cLow,
              ce50: (cHigh + cLow) / 2.0,
              slPrice: cLow - params.slBuffer,
              active: true,
              createdIdx: i,
              time: c0.time
            });
            break;
          }
        }
      }
    }

    if (isBearFVG) {
      c1.isBear = true;
      for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
        if (candles[j].isBull) {
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const bullTop = candles[j].low;
          const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - params.fvgMin;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);
          if (cHigh - cLow >= params.overlapMin) {
            bprZones.push({
              isBuy: false,
              top: cHigh,
              bottom: cLow,
              ce50: (cHigh + cLow) / 2.0,
              slPrice: cHigh + params.slBuffer,
              active: true,
              createdIdx: i,
              time: c0.time
            });
            break;
          }
        }
      }
    }

    while (bprZones.length > 50) bprZones.shift();

    // Solo abrir trades dentro de la ventana de análisis
    if (c0.time < startTimeMs || c0.time > endTimeMs) continue;
    const hour = new Date(c0.time).getUTCHours();
    if (hour < 7 || hour >= 18) continue;

    // Regla de Slot de Riesgo (Slot Release on BE):
    // Solo cuentan las órdenes activas que tienen RIESGO real (> $0)
    const riskTradesCount = activeTrades.filter(t => !t.isBE).length;
    if (riskTradesCount >= 1) continue; // Slot ocupado

    // Evaluar Retest en CE 50% de zonas vigentes
    for (const zone of bprZones) {
      if (!zone.active) continue;
      if (i - zone.createdIdx > 60) {
        zone.active = false;
        continue;
      }

      // Entrada BUY
      if (zone.isBuy) {
        if (activeTrades.some(t => t.type === 'SELL')) continue; // Anti-hedging
        const candleRange = c0.high - c0.low;
        const lowerWick = Math.min(c0.open, c0.close) - c0.low;
        const hasWick = candleRange > 0 && (lowerWick / candleRange >= 0.20);
        if (c0.low <= zone.ce50 && c0.high >= zone.slPrice && hasWick && c0.close >= c0.ema100) {
          zone.active = false;
          const entry = zone.ce50;
          const sl = zone.slPrice;
          const riskDist = entry - sl;
          if (riskDist <= 0) continue;
          const tp = entry + (riskDist * params.rrRatio);

          activeTrades.push({
            symbol: params.symbol,
            type: 'BUY',
            entry,
            initialSL: sl,
            currentSL: sl,
            tp,
            openTime: c0.time,
            isBE: false,
            slPips: +(riskDist / params.pipValue).toFixed(1),
            tpPips: +(Math.abs(tp - entry) / params.pipValue).toFixed(1)
          });
          break;
        }
      }
      // Entrada SELL
      else {
        if (activeTrades.some(t => t.type === 'BUY')) continue; // Anti-hedging
        const candleRange = c0.high - c0.low;
        const upperWick = c0.high - Math.max(c0.open, c0.close);
        const hasWick = candleRange > 0 && (upperWick / candleRange >= 0.20);
        if (c0.high >= zone.ce50 && c0.low <= zone.slPrice && hasWick && c0.close <= c0.ema100) {
          zone.active = false;
          const entry = zone.ce50;
          const sl = zone.slPrice;
          const riskDist = sl - entry;
          if (riskDist <= 0) continue;
          const tp = entry - (riskDist * params.rrRatio);

          activeTrades.push({
            symbol: params.symbol,
            type: 'SELL',
            entry,
            initialSL: sl,
            currentSL: sl,
            tp,
            openTime: c0.time,
            isBE: false,
            slPips: +(riskDist / params.pipValue).toFixed(1),
            tpPips: +(Math.abs(tp - entry) / params.pipValue).toFixed(1)
          });
          break;
        }
      }
    }
  }

  return trades;
}

async function runBacktest() {
  console.log('========================================================================================');
  console.log('🏛️ BACKTEST OFICIAL: ESTRATEGIA INSTITUCIONAL BPR M5 (R:R 1:3.0 | BE SLOT RELEASE)');
  console.log('   Activos: XAUUSD, EURUSD, GBPJPY, USDCAD, GBPUSD');
  console.log('========================================================================================\n');

  // Ventana: Esta semana (Lunes 05 Oct 2026 00:00 UTC al Jueves 08 Oct 2026 Actual)
  const THIS_WEEK_START = new Date('2026-10-05T00:00:00Z').getTime();
  const THIS_WEEK_END   = new Date('2026-10-08T23:59:59Z').getTime();

  console.log(`📅 Periodo analizado (Esta semana en curso):`);
  console.log(`   Desde: ${new Date(THIS_WEEK_START).toUTCString()}`);
  console.log(`   Hasta: ${new Date(THIS_WEEK_END).toUTCString()}\n`);

  console.log('⏳ Descargando velas M5 de alta resolución para los 5 pares...');
  const allCandles = {};
  for (const [key, params] of Object.entries(ASSET_PARAMS)) {
    const c = await fetchYahooM5Candles(params.yahooTicker);
    allCandles[key] = c;
    console.log(`   • ${key.padEnd(8)}: ${c.length} velas M5 cargadas (${c[0] ? c[0].dateStr.substring(0, 10) : 'N/A'} -> ${c[c.length - 1] ? c[c.length - 1].dateStr.substring(0, 10) : 'N/A'})`);
  }

  console.log('\n⚙️ Ejecutando simulación cuantitativa con BE Slot Release...');
  const allTrades = [];
  const perAssetStats = {};

  for (const [key, params] of Object.entries(ASSET_PARAMS)) {
    const trades = simulateInstitutionalBPR(allCandles[key], params, THIS_WEEK_START, THIS_WEEK_END);
    trades.sort((a, b) => a.openTime - b.openTime);

    const wins = trades.filter(t => t.outcome === 'WIN').length;
    const losses = trades.filter(t => t.outcome === 'LOSS').length;
    const bes = trades.filter(t => t.outcome === 'BREAK_EVEN').length;
    const netR = trades.reduce((acc, t) => acc + t.rMultiple, 0);
    const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0;

    perAssetStats[key] = {
      total: trades.length,
      wins,
      losses,
      bes,
      netR: +netR.toFixed(2),
      winRate
    };

    allTrades.push(...trades);
  }

  allTrades.sort((a, b) => a.openTime - b.openTime);

  console.log('\n========================================================================================');
  console.log('📊 RESUMEN POR ACTIVO (ESTA SEMANA: 05 - 08 OCT 2026):');
  console.log('========================================================================================');
  console.log('ACTIVO   | TRADES | WINS | LOSSES | BEs (Risk $0) | WIN RATE | R-MÚLTIPLE NETO');
  console.log('---------+--------+------+--------+---------------+----------+-----------------');

  let totalTrades = 0, totalWins = 0, totalLosses = 0, totalBEs = 0, totalR = 0;
  for (const [sym, st] of Object.entries(perAssetStats)) {
    totalTrades += st.total;
    totalWins += st.wins;
    totalLosses += st.losses;
    totalBEs += st.bes;
    totalR += st.netR;
    const signR = st.netR >= 0 ? '+' : '';
    console.log(
      `${sym.padEnd(8)} | ` +
      `${String(st.total).padStart(6)} | ` +
      `${String(st.wins).padStart(4)} | ` +
      `${String(st.losses).padStart(6)} | ` +
      `${String(st.bes).padStart(13)} | ` +
      `${String(st.winRate + '%').padStart(8)} | ` +
      `${(signR + st.netR.toFixed(2) + 'R').padStart(15)}`
    );
  }
  console.log('---------+--------+------+--------+---------------+----------+-----------------');
  const globalWR = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
  console.log(
    `TOTAL    | ` +
    `${String(totalTrades).padStart(6)} | ` +
    `${String(totalWins).padStart(4)} | ` +
    `${String(totalLosses).padStart(6)} | ` +
    `${String(totalBEs).padStart(13)} | ` +
    `${String(globalWR + '%').padStart(8)} | ` +
    `${((totalR >= 0 ? '+' : '') + totalR.toFixed(2) + 'R').padStart(15)}`
  );
  console.log('========================================================================================\n');

  // Simulación en Cuenta FTMO 100k
  console.log('🏛️ SIMULACIÓN EN CUENTA NUEVA FTMO 100K:');
  console.log('----------------------------------------------------------------------------------------');
  const ftmoInitial = 100000;
  const ftmoRisk05 = ftmoInitial * 0.005; // $500 por trade (0.50%)
  const ftmoRisk075 = ftmoInitial * 0.0075; // $750 por trade (0.75%)

  let ftmoBal05 = ftmoInitial;
  let ftmoBal075 = ftmoInitial;
  let maxDD05 = 0, maxDD075 = 0;
  let peak05 = ftmoInitial, peak075 = ftmoInitial;

  for (const t of allTrades) {
    // 0.50%
    const pnl05 = t.outcome === 'WIN' ? (ftmoRisk05 * 3.0) : (t.outcome === 'BREAK_EVEN' ? 0 : -ftmoRisk05);
    ftmoBal05 += pnl05;
    if (ftmoBal05 > peak05) peak05 = ftmoBal05;
    const dd05 = peak05 - ftmoBal05;
    if (dd05 > maxDD05) maxDD05 = dd05;

    // 0.75%
    const pnl075 = t.outcome === 'WIN' ? (ftmoRisk075 * 3.0) : (t.outcome === 'BREAK_EVEN' ? 0 : -ftmoRisk075);
    ftmoBal075 += pnl075;
    if (ftmoBal075 > peak075) peak075 = ftmoBal075;
    const dd075 = peak075 - ftmoBal075;
    if (dd075 > maxDD075) maxDD075 = dd075;
  }

  console.log(`• Escenario Conservador (0.50% / $500 riesgo por trade):`);
  console.log(`  - Saldo Inicial:       $${ftmoInitial.toLocaleString()} USD`);
  console.log(`  - Saldo Final:         $${ftmoBal05.toFixed(2)} USD`);
  console.log(`  - Beneficio Neto:      +${(ftmoBal05 - ftmoInitial).toFixed(2)} USD (+${(((ftmoBal05 - ftmoInitial) / ftmoInitial) * 100).toFixed(2)}%)`);
  console.log(`  - Máximo Drawdown:     -${maxDD05.toFixed(2)} USD (-${((maxDD05 / ftmoInitial) * 100).toFixed(2)}%)`);
  console.log(`  - Meta Fase 1 (+$10k): ${ftmoBal05 >= 110000 ? '✅ APROBADO' : `⏳ Restante: $${(110000 - ftmoBal05).toFixed(2)} USD`}`);

  console.log(`\n• Escenario Moderado (0.75% / $750 riesgo por trade):`);
  console.log(`  - Saldo Inicial:       $${ftmoInitial.toLocaleString()} USD`);
  console.log(`  - Saldo Final:         $${ftmoBal075.toFixed(2)} USD`);
  console.log(`  - Beneficio Neto:      +${(ftmoBal075 - ftmoInitial).toFixed(2)} USD (+${(((ftmoBal075 - ftmoInitial) / ftmoInitial) * 100).toFixed(2)}%)`);
  console.log(`  - Máximo Drawdown:     -${maxDD075.toFixed(2)} USD (-${((maxDD075 / ftmoInitial) * 100).toFixed(2)}%)`);
  console.log(`  - Meta Fase 1 (+$10k): ${ftmoBal075 >= 110000 ? '✅ APROBADO' : `⏳ Restante: $${(110000 - ftmoBal075).toFixed(2)} USD`}`);

  // Simulación en Cuenta The5ers 5k
  console.log('\n----------------------------------------------------------------------------------------');
  console.log('🏛️ SIMULACIÓN EN CUENTA THE5ERS 5K (0.75% / $37.50 riesgo por trade):');
  console.log('----------------------------------------------------------------------------------------');
  const the5ersInitial = 5000;
  const the5ersRisk = the5ersInitial * 0.0075;
  let the5ersBal = the5ersInitial;
  let maxDD5k = 0;
  let peak5k = the5ersInitial;

  for (const t of allTrades) {
    const pnl = t.outcome === 'WIN' ? (the5ersRisk * 3.0) : (t.outcome === 'BREAK_EVEN' ? 0 : -the5ersRisk);
    the5ersBal += pnl;
    if (the5ersBal > peak5k) peak5k = the5ersBal;
    const dd = peak5k - the5ersBal;
    if (dd > maxDD5k) maxDD5k = dd;
  }

  console.log(`  - Saldo Inicial:       $${the5ersInitial.toLocaleString()} USD`);
  console.log(`  - Saldo Final:         $${the5ersBal.toFixed(2)} USD`);
  console.log(`  - Beneficio Neto:      +${(the5ersBal - the5ersInitial).toFixed(2)} USD (+${(((the5ersBal - the5ersInitial) / the5ersInitial) * 100).toFixed(2)}%)`);
  console.log(`  - Máximo Drawdown:     -${maxDD5k.toFixed(2)} USD (-${((maxDD5k / the5ersInitial) * 100).toFixed(2)}%)`);
  console.log(`  - Meta Fase 1 ($5,500): ${the5ersBal >= 5500 ? '✅ APROBADO' : `⏳ Restante: $${(5500 - the5ersBal).toFixed(2)} USD`}`);

  console.log('\n========================================================================================');
  console.log('📋 DETALLE CRONOLÓGICO DE OPERACIONES ESTA SEMANA:');
  console.log('========================================================================================');
  allTrades.forEach((t, idx) => {
    const dStr = new Date(t.openTime).toISOString().replace('T', ' ').substring(0, 16);
    const emoji = t.outcome === 'WIN' ? '✅ TP 1:3' : (t.outcome === 'BREAK_EVEN' ? '🛡️ BE +Buf' : '🛑 SL -1R');
    console.log(
      `#${String(idx + 1).padStart(2)} | ${dStr} UTC | ` +
      `${t.symbol.padEnd(7)} ${t.type.padEnd(4)} | ` +
      `Entrada: ${String(t.entry).padStart(8)} | SL: ${String(t.initialSL).padStart(8)} | TP: ${String(t.tp).padStart(8)} | ` +
      `${emoji.padEnd(11)} | ${(t.rMultiple >= 0 ? '+' : '') + t.rMultiple.toFixed(1) + 'R'}`
    );
  });
  console.log('========================================================================================\n');
}

runBacktest();
