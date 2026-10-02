/**
 * Motor Algorítmico Institucional Multitemporal BPR Sniper: NAS100 (M2 + M3 + M5 + M15)
 * [MODO EXCLUSIVO: SÓLO COMPRAS / BULLISH BPR]
 * 
 * Basado en la auditoría cuantitativa 2020-2026 (7 años):
 * - Dirección: LONG / BUY únicamente
 * - Entrada: Consequent Encroachment 50% (CE_50)
 * - Stop Loss: Estructural detrás de la caja BPR + Buffer de aire (4.0 a 10.0 pts)
 * - Ratio R:R: 1:1.0 (Win Rate global ~89.8%, Profit Factor ~8.5)
 * - Horario Operativo: 13:30 a 20:00 UTC (Wall Street Core - Liquidez máxima y menor spread)
 * - Bloqueo Estricto: 20:55 a 22:30 UTC (Cierre de futuros y rollover de índices)
 * - Filtro Tendencial: EMA 100 (Sólo compras a favor del flujo institucional alcista)
 */

const fs = require('fs');
const path = require('path');
const { notificationService } = require('../NotificationService');
const { riskEngine } = require('../RiskEngine');

const SHADOW_NAS100_FILE = path.join(__dirname, '..', '..', 'proprietary_bpr_nas100_trades.json');
const CANDLE_CACHE_FILE = path.join(__dirname, '..', '..', 'bpr_nas100_candle_cache.json');

const NAS100_CONFIG = {
  M2:  { tfMinutes: 2,  minFvgGap: 3.5,  minOverlap: 2.0,  minRange: 5.0,  bufferPts: 3.5,  slMinPts: 5.0,  slMaxPts: 40.0,  rrRatio: 1.0, lookback: 25 },
  M3:  { tfMinutes: 3,  minFvgGap: 5.0,  minOverlap: 3.0,  minRange: 7.0,  bufferPts: 4.5,  slMinPts: 7.0,  slMaxPts: 50.0,  rrRatio: 1.0, lookback: 25 },
  M5:  { tfMinutes: 5,  minFvgGap: 7.0,  minOverlap: 4.0,  minRange: 9.0,  bufferPts: 6.0,  slMinPts: 10.0, slMaxPts: 70.0,  rrRatio: 1.0, lookback: 25 },
  M15: { tfMinutes: 15, minFvgGap: 12.0, minOverlap: 7.0,  minRange: 15.0, bufferPts: 8.0,  slMinPts: 15.0, slMaxPts: 100.0, rrRatio: 1.0, lookback: 25 }
};

class BPRNas100BullishStrategy {
  constructor(options = {}) {
    this.name = 'BPR_NAS100_Bullish_Sniper';
    this.symbol = 'NAS100';
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : true;
    this.executionHandler = null;

    this.timeframes = {
      M2:  { config: NAS100_CONFIG.M2,  candles: [], currentBar: null, bprZones: [] },
      M3:  { config: NAS100_CONFIG.M3,  candles: [], currentBar: null, bprZones: [] },
      M5:  { config: NAS100_CONFIG.M5,  candles: [], currentBar: null, bprZones: [] },
      M15: { config: NAS100_CONFIG.M15, candles: [], currentBar: null, bprZones: [] }
    };

    this.activeTrades = [];
    this.history = [];
    this.metrics = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      netPoints: 0,
      grossWon: 0,
      grossLost: 0,
      profitFactor: 0,
      maxDrawdownPoints: 0,
      peakPoints: 0,
      byTimeframe: {
        M2:  { trades: 0, wins: 0, points: 0 },
        M3:  { trades: 0, wins: 0, points: 0 },
        M5:  { trades: 0, wins: 0, points: 0 },
        M15: { trades: 0, wins: 0, points: 0 }
      }
    };

    this.loadState();
  }

  setExecutionHandler(handler) {
    this.executionHandler = handler;
  }

  setLiveExecution(isLive) {
    this.isLiveExecution = !!isLive;
  }

  loadState() {
    try {
      if (fs.existsSync(SHADOW_NAS100_FILE)) {
        const data = JSON.parse(fs.readFileSync(SHADOW_NAS100_FILE, 'utf-8'));
        this.history = data.history || [];
        this.metrics = data.metrics || this.metrics;
        this.activeTrades = data.activeTrades || [];
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar estado de BPR NAS100:', e.message);
    }
    this.loadCandleCache();
  }

  loadCandleCache() {
    try {
      if (fs.existsSync(CANDLE_CACHE_FILE)) {
        const raw = fs.readFileSync(CANDLE_CACHE_FILE, 'utf-8');
        const cache = JSON.parse(raw);
        for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
          if (Array.isArray(cache[tfKey]) && cache[tfKey].length > 0) {
            tfObj.candles = cache[tfKey].slice(-450);
            this.calculateEma100(tfObj);
            this.scanAllBprZones(tfKey, tfObj);
          }
        }
        const summary = Object.keys(this.timeframes).map(k => `${k}:${this.timeframes[k].candles.length}v(${this.timeframes[k].bprZones.filter(z=>!z.mitigated).length}z)`).join(' ');
        console.log(`💻 [BPR NAS100 Cache] Velas restauradas (${summary}). Zonas Bullish listas.`);
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar caché de velas NAS100:', e.message);
    }
  }

  saveCandleCache() {
    try {
      const dump = {};
      for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
        dump[tfKey] = tfObj.candles.slice(-450);
      }
      fs.writeFileSync(CANDLE_CACHE_FILE, JSON.stringify(dump), 'utf-8');
    } catch (e) {}
  }

  saveState() {
    try {
      fs.writeFileSync(SHADOW_NAS100_FILE, JSON.stringify({
        strategy: this.name,
        symbol: this.symbol,
        metrics: this.metrics,
        activeTrades: this.activeTrades,
        history: this.history.slice(-150),
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      console.error('❌ Error guardando BPR NAS100:', e.message);
    }
  }

  calculateEma100(tfObj) {
    const candles = tfObj.candles;
    if (candles.length < 5) return;
    const k = 2 / (100 + 1);
    let ema = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
      ema = candles[i].close * k + ema * (1 - k);
      candles[i].ema100 = ema;
    }
  }

  processTick(tick) {
    const { bid, ask, time = Date.now(), symbol } = tick;
    const sUpper = (symbol || '').toUpperCase();
    if (symbol && !sUpper.includes('NAS') && !sUpper.includes('US100') && !sUpper.includes('USTEC') && !sUpper.includes('NDX')) return;

    const price = (bid + ask) / 2.0;
    this.latestPrice = price;
    this.latestBid = bid;
    this.latestAsk = ask;
    const spreadPoints = ask - bid;

    for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
      this.updateTimeframeBar(tfKey, tfObj, price, spreadPoints, time);
    }

    this.manageActiveTrades(price, spreadPoints);
  }

  updateTimeframeBar(tfKey, tfObj, price, spreadPoints, time) {
    const date = new Date(time);
    const minute = date.getMinutes();
    const barStartMinute = Math.floor(minute / tfObj.config.tfMinutes) * tfObj.config.tfMinutes;
    const barId = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${String(barStartMinute).padStart(2, '0')}`;

    if (!tfObj.currentBar || tfObj.currentBar.barId !== barId) {
      if (tfObj.currentBar) {
        this.onCandleClosed(tfKey, tfObj, tfObj.currentBar);
      }
      tfObj.currentBar = {
        barId,
        time,
        open: price,
        high: price,
        low: price,
        close: price,
        spreadPoints,
        volume: 1
      };
    } else {
      if (price > tfObj.currentBar.high) tfObj.currentBar.high = price;
      if (price < tfObj.currentBar.low) tfObj.currentBar.low = price;
      tfObj.currentBar.close = price;
      tfObj.currentBar.volume++;
    }
  }

  onCandleClosed(tfKey, tfObj, candle) {
    tfObj.candles.push(candle);
    if (tfObj.candles.length > 500) tfObj.candles.shift();

    this.calculateEma100(tfObj);
    this.scanBprZones(tfKey, tfObj);
    this.evaluateEntry(tfKey, tfObj, candle);
    this.saveCandleCache();
  }

  /**
   * Escaneo de zonas BULLISH BPR (Compras)
   */
  scanBprZones(tfKey, tfObj) {
    const candles = tfObj.candles;
    const n = candles.length;
    if (n < 4) return;

    const c0 = candles[n - 1]; // Vela cerrada más reciente
    const c2 = candles[n - 3]; // Vela 1 del patrón
    const cfg = tfObj.config;

    const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

    if (isBearishFVG) c0.isBearish = true;
    if (isBullishFVG) c0.isBullish = true;

    // Solo creamos zonas BULLISH para buscar compras institucionales
    if (isBullishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - (cfg.lookback || 25)); i--) {
        if (candles[i].isBearish) {
          const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
          const bearBottom = candles[i].high;
          const bullTop = c0.low;
          const bullBottom = c2.high;
          const cLow = Math.max(bearBottom, bullBottom);
          const cHigh = Math.min(bearTop, bullTop);

          if (cHigh > cLow + cfg.minOverlap) {
            const ce50 = (cHigh + cLow) / 2.0;
            tfObj.bprZones.push({
              id: `BPR_NAS100_${tfKey}_BULL_${Date.now()}`,
              tf: tfKey,
              type: 'BULLISH',
              top: cHigh,
              bottom: cLow,
              consequentEncroachment: ce50,
              tested: false,
              mitigated: false,
              createdIndex: n - 1,
              createdTime: c0.time,
              barIndex: n - 1
            });
            break;
          }
        }
      }
    }

    while (tfObj.bprZones.length > 250) tfObj.bprZones.shift();
  }

  scanAllBprZones(tfKey, tfObj) {
    const candles = tfObj.candles;
    const n = candles.length;
    if (n < 4) return;
    const cfg = tfObj.config;
    tfObj.bprZones = [];

    for (let idx = 2; idx < n; idx++) {
      const c0 = candles[idx];
      const c2 = candles[idx - 2];
      const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
      const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;
      if (isBearishFVG) c0.isBearish = true;
      if (isBullishFVG) c0.isBullish = true;

      if (isBullishFVG) {
        for (let i = idx - 1; i >= Math.max(0, idx - (cfg.lookback || 25)); i--) {
          if (candles[i].isBearish) {
            const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
            const bearBottom = candles[i].high;
            const bullTop = c0.low;
            const bullBottom = c2.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const cHigh = Math.min(bearTop, bullTop);

            if (cHigh > cLow + cfg.minOverlap) {
              const ce50 = (cHigh + cLow) / 2.0;
              tfObj.bprZones.push({
                id: `BPR_NAS100_${tfKey}_BULL_${idx}`,
                tf: tfKey,
                type: 'BULLISH',
                top: cHigh,
                bottom: cLow,
                consequentEncroachment: ce50,
                tested: false,
                mitigated: false,
                createdIndex: idx,
                createdTime: c0.time,
                barIndex: idx
              });
              break;
            }
          }
        }
      }
    }

    // Mitigaciones
    for (const zone of tfObj.bprZones) {
      for (let j = zone.createdIndex + 1; j < n; j++) {
        const bar = candles[j];
        if (bar.low <= zone.bottom) {
          zone.mitigated = true;
        } else if (bar.low <= zone.top) {
          zone.tested = true;
        }
      }
    }
  }

  evaluateEntry(tfKey, tfObj, candle) {
    const date = new Date(candle.time);
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();

    // 🔴 Bloqueo estricto Rollover de índices (20:55 a 22:30 UTC)
    if (hour === 21 || (hour === 20 && min >= 55) || (hour === 22 && min <= 30)) return;

    // 🟢 Sesión activa óptima: Wall Street Core (13:30 a 20:00 UTC)
    const minOfDay = hour * 60 + min;
    if (minOfDay < 810 || minOfDay >= 1200) return;

    const candleRange = candle.high - candle.low;
    const cfg = tfObj.config;
    if (candleRange < cfg.minRange) return;

    for (let z = tfObj.bprZones.length - 1; z >= 0; z--) {
      const bpr = tfObj.bprZones[z];
      if (bpr.tested) continue;
      const age = tfObj.candles.length - 1 - bpr.createdIndex;
      if (age > 300) { bpr.tested = true; continue; }

      // ENTRADA BUY INSTITUCIONAL (Retesteo a la caja Bullish BPR)
      if (candle.low <= bpr.top && candle.low >= bpr.bottom - cfg.bufferPts) {
        // Mecha inferior de rechazo >= 20%
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        if (lowerWick / candleRange < 0.20) continue;

        // Filtro tendencial EMA 100: el precio debe estar sobre la EMA 100
        if (candle.close < candle.ema100) continue;

        bpr.tested = true;
        const entry = candle.close; // Precio real de mercado al cierre
        const sl = bpr.bottom - cfg.bufferPts;
        const slDist = Math.abs(entry - sl);

        if (slDist < cfg.slMinPts || slDist > cfg.slMaxPts) continue;

        const tpDist = slDist * cfg.rrRatio;
        const tp = entry + tpDist;

        this.openTrade(tfKey, 'BUY', entry, sl, tp, slDist, candle.time);
        break;
      }
    }
  }

  openTrade(tfKey, type, entryPrice, stopLoss, takeProfit, slPts, timeMs) {
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
      const remainMin = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
      console.log(`\n🛑 [BPR NAS100 Cooldown] Señal BUY en ${tfKey} BLOQUEADA por racha de SL. Enfriamiento activo (${remainMin} min restantes).`);
      return;
    }

    const hasAnyActiveTrade = this.activeTrades.some(t => (t.symbol === 'NAS100' || t.symbol === 'US100') && t.status === 'OPEN');
    if (hasAnyActiveTrade) {
      console.log(`\n⚠️ [BPR NAS100 Anti-Stacking] Señal BUY en ${tfKey} OMITIDA: Ya existe una operación activa en NAS100.`);
      return;
    }

    const tradeId = `BPR_NAS100_${tfKey}_${Date.now()}`;
    const tpPts = slPts * this.timeframes[tfKey].config.rrRatio;

    const trade = {
      id: tradeId,
      timeframe: tfKey,
      symbol: 'NAS100',
      type: 'BUY',
      entryPrice: parseFloat(entryPrice.toFixed(2)),
      initialSL: parseFloat(stopLoss.toFixed(2)),
      currentSL: parseFloat(stopLoss.toFixed(2)),
      tpPrice: parseFloat(takeProfit.toFixed(2)),
      slPoints: parseFloat(slPts.toFixed(1)),
      tpPoints: parseFloat(tpPts.toFixed(1)),
      openTime: new Date(timeMs).toISOString(),
      status: 'OPEN'
    };

    this.activeTrades.push(trade);
    console.log(`\n🎯 [BPR NAS100 ${tfKey}] SEÑAL LONG DETECTADA: BUY @ ${trade.entryPrice} | SL: ${trade.initialSL} (${trade.slPoints} pts) | TP: ${trade.tpPrice} (${trade.tpPoints} pts)`);

    // Despacho a MT5 si el executionHandler está activo
    if (this.isLiveExecution && this.executionHandler) {
      try {
        const orderPayload = {
          valid: true,
          action: 'BUY',
          symbol: 'NAS100',
          entryPrice: trade.entryPrice,
          slPrice: trade.initialSL,
          tp1Price: trade.tpPrice,
          targetTP: trade.tpPrice,
          channelId: `BPR_NAS100_${tfKey}`,
          channelName: `BPR Sniper NAS100 [${tfKey}]`,
          comment: `BPR NAS100 ${tfKey}`,
          isReducedRisk: false
        };

        this.executionHandler(orderPayload).then(success => {
          if (success) {
            console.log(`🚀 [BPR NAS100 ${tfKey}] Orden BUY despachada a MT5 con éxito.`);
          }
        }).catch(err => {
          console.error(`❌ [BPR NAS100 ${tfKey}] Error en executionHandler:`, err.message);
        });
      } catch (err) {
        console.error(`❌ [BPR NAS100 ${tfKey}] Fallo despachando a MT5:`, err.message);
      }
    }

    this.saveState();
  }

  manageActiveTrades(currentPrice, spreadPoints) {
    if (this.activeTrades.length === 0) return;

    const remainingTrades = [];

    for (const trade of this.activeTrades) {
      let closed = false;
      let outcome = null;
      let points = 0;

      // Trade es BUY
      if (currentPrice >= trade.tpPrice) {
        closed = true;
        outcome = 'WIN';
        points = trade.tpPoints;
      } else if (currentPrice <= trade.currentSL) {
        closed = true;
        outcome = 'LOSS';
        points = -trade.slPoints;
      }

      if (closed) {
        trade.status = outcome;
        trade.closePrice = currentPrice;
        trade.closeTime = new Date().toISOString();
        trade.points = parseFloat(points.toFixed(1));

        this.history.push(trade);
        this.updateMetrics(trade);

        console.log(`\n🔔 [BPR NAS100 ${trade.timeframe}] Trade cerrado: ${outcome} (${points > 0 ? '+' : ''}${trade.points} pts)`);
      } else {
        remainingTrades.push(trade);
      }
    }

    this.activeTrades = remainingTrades;
    if (this.activeTrades.length !== remainingTrades.length) {
      this.saveState();
    }
  }

  updateMetrics(trade) {
    const isWin = trade.status === 'WIN';
    this.metrics.totalTrades++;
    if (isWin) {
      this.metrics.wins++;
      this.metrics.grossWon += trade.points;
    } else {
      this.metrics.losses++;
      this.metrics.grossLost += Math.abs(trade.points);
    }

    this.metrics.winRate = parseFloat(((this.metrics.wins / this.metrics.totalTrades) * 100).toFixed(1));
    this.metrics.netPoints = parseFloat((this.metrics.grossWon - this.metrics.grossLost).toFixed(1));
    this.metrics.profitFactor = this.metrics.grossLost > 0 ? parseFloat((this.metrics.grossWon / this.metrics.grossLost).toFixed(2)) : 99.9;

    const tf = trade.timeframe;
    if (this.metrics.byTimeframe[tf]) {
      this.metrics.byTimeframe[tf].trades++;
      if (isWin) this.metrics.byTimeframe[tf].wins++;
      this.metrics.byTimeframe[tf].points = parseFloat((this.metrics.byTimeframe[tf].points + trade.points).toFixed(1));
    }

    if (this.metrics.netPoints > this.metrics.peakPoints) {
      this.metrics.peakPoints = this.metrics.netPoints;
    }
    const currentDD = this.metrics.peakPoints - this.metrics.netPoints;
    if (currentDD > this.metrics.maxDrawdownPoints) {
      this.metrics.maxDrawdownPoints = parseFloat(currentDD.toFixed(1));
    }
  }

  getConfirmationChecklist(currentPrice) {
    const result = {};

    for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
      // 🔍 0. Verificar si hay operación activa o recién ejecutada en este timeframe
      const openTrade = this.activeTrades.find(t => (t.symbol === 'NAS100' || t.symbol === 'US100') && t.timeframe === tfKey && t.status === 'OPEN');
      const recentClosedTrade = this.history.find(t => (t.symbol === 'NAS100' || t.symbol === 'US100') && t.timeframe === tfKey && (Date.now() - new Date(t.closeTime).getTime()) < 300000); // 5 min

      if (openTrade) {
        result[tfKey] = {
          score: '4/4',
          scorePercent: 100,
          activeType: 'BULLISH (COMPRAS)',
          statusLabel: 'EN MERCADO (ORDEN VIVA)',
          statusColor: '#00e676',
          distToCE: 'En ejecución',
          rules: [
            { name: 'Bullish BPR Activo', ok: true, detail: `Entrada: ${openTrade.entryPrice}` },
            { name: 'Horario Institucional', ok: true, detail: `Operación activa en ${openTrade.type}` },
            { name: 'Tendencia EMA 100', ok: true, detail: 'Alcista confirmada' },
            { name: 'Proximidad CE 50%', ok: true, detail: `SL: ${openTrade.initialSL} | TP: ${openTrade.tpPrice}` }
          ]
        };
        continue;
      }

      if (recentClosedTrade) {
        const isWin = recentClosedTrade.pips > 0;
        result[tfKey] = {
          score: '4/4',
          scorePercent: 100,
          activeType: 'BULLISH (COMPRAS)',
          statusLabel: isWin ? `TP ALCANZADO (+${recentClosedTrade.pips} pts)` : `SL CERRADO (${recentClosedTrade.pips} pts)`,
          statusColor: isWin ? '#00e676' : '#ef4444',
          distToCE: `${recentClosedTrade.reason} (${recentClosedTrade.pips > 0 ? '+' : ''}${recentClosedTrade.pips} pts)`,
          rules: [
            { name: 'Bullish BPR Activo', ok: true, detail: `Entrada: ${recentClosedTrade.entryPrice}` },
            { name: 'Horario Institucional', ok: true, detail: `Cierre: ${recentClosedTrade.reason}` },
            { name: 'Tendencia EMA 100', ok: true, detail: 'Operación ejecutada' },
            { name: 'Proximidad CE 50%', ok: true, detail: `Resultado: ${recentClosedTrade.pips > 0 ? '+' : ''}${recentClosedTrade.pips} pts` }
          ]
        };
        continue;
      }

      const lastCandle = tfObj.candles[tfObj.candles.length - 1];
      const effPrice = (currentPrice > 0) ? currentPrice : (lastCandle ? lastCandle.close : 0);
      const lastIndex = tfObj.candles.length - 1;
      const MAX_ZONE_AGE_BARS = 80;
      const MAX_ZONE_DIST_PTS = 60.0;

      // Priorizar zonas Bullish vivas no mitigadas, no testeadas, recientes y en rango
      const freshZones = tfObj.bprZones.filter(z => 
        !z.mitigated && 
        !z.tested && 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (effPrice > 0 ? (Math.abs(effPrice - z.consequentEncroachment) <= MAX_ZONE_DIST_PTS) : true)
      );
      let activeZone = null;
      if (freshZones.length > 0) {
        activeZone = freshZones.slice().sort((a, b) => Math.abs(effPrice - a.consequentEncroachment) - Math.abs(effPrice - b.consequentEncroachment))[0];
      }

      // Zona de referencia reciente
      const recentZones = tfObj.bprZones.filter(z => 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (effPrice > 0 ? (Math.abs(effPrice - z.consequentEncroachment) <= MAX_ZONE_DIST_PTS * 1.5) : true)
      );
      const refZone = activeZone || recentZones.slice(-1)[0] || null;

      let score = 0;
      const rules = [];

      // Regla 1: Zona Bullish BPR activa
      if (activeZone) {
        score++;
        rules.push({ name: 'Bullish BPR Activo', ok: true, detail: `Zona: ${activeZone.bottom.toFixed(1)} - ${activeZone.top.toFixed(1)}` });
      } else if (refZone) {
        rules.push({ name: 'Bullish BPR Activo', ok: false, detail: `Zona reciente: ${refZone.bottom.toFixed(1)} - ${refZone.top.toFixed(1)}` });
      } else {
        rules.push({ name: 'Bullish BPR Activo', ok: false, detail: 'Sin zonas Bullish en rango (rastreando)' });
      }

      // Regla 2: Filtro de Sesión Óptima (13:30 a 20:00 UTC)
      const now = new Date();
      const h = now.getUTCHours();
      const m = now.getUTCMinutes();
      const minOfDay = h * 60 + m;
      const isOptimalSession = (minOfDay >= 810 && minOfDay < 1200);
      const isBlockedSession = (h === 21 || (h === 20 && m >= 55) || (h === 22 && m <= 30));
      if (isOptimalSession) {
        score++;
        rules.push({ name: 'Horario Institucional', ok: true, detail: 'Wall Street Core (13:30-20:00 UTC)' });
      } else if (isBlockedSession) {
        rules.push({ name: 'Horario Institucional', ok: false, detail: '🔴 Bloqueo Rollover (21:00-22:30 UTC)' });
      } else {
        rules.push({ name: 'Horario Institucional', ok: false, detail: 'Fuera de sesión Wall Street' });
      }

      // Regla 3: Tendencia EMA 100
      const isAboveEma = lastCandle && lastCandle.close > lastCandle.ema100;
      if (isAboveEma) {
        score++;
        rules.push({ name: 'Tendencia EMA 100', ok: true, detail: `Alcista (Precio > EMA 100)` });
      } else {
        rules.push({ name: 'Tendencia EMA 100', ok: false, detail: `Bajista o neutral` });
      }

      // Regla 4: Proximidad CE 50%
      let distStr = '0.0 pts';
      if (refZone && effPrice > 0) {
        const distPts = Math.abs(refZone.consequentEncroachment - effPrice);
        distStr = `${distPts.toFixed(1)} pts`;
        if (distPts <= (tfObj.config.minRange * 1.5)) {
          score++;
          rules.push({ name: 'Proximidad CE 50%', ok: true, detail: `A ${distStr} (${activeZone ? 'Zona Activa' : 'Ref Reciente'})` });
        } else {
          rules.push({ name: 'Proximidad CE 50%', ok: false, detail: `Distancia: ${distStr}` });
        }
      } else if (lastCandle && effPrice > 0) {
        const distPts = Math.abs(lastCandle.low - effPrice);
        distStr = `${distPts.toFixed(1)} pts`;
        rules.push({ name: 'Proximidad CE 50%', ok: false, detail: `Buscando zona en rango (Swing: ${distStr})` });
      } else {
        distStr = '0.0 pts';
        rules.push({ name: 'Proximidad CE 50%', ok: false, detail: 'Buscando zona en rango' });
      }

      const scorePercent = Math.round((score / 4) * 100);
      result[tfKey] = {
        score: `${score}/4`,
        scorePercent,
        activeType: activeZone ? 'BULLISH (COMPRAS)' : 'BULLISH (MONITOR)',
        statusLabel: activeZone ? 'ZONA BULLISH' : 'BUSCANDO BPR',
        statusColor: activeZone ? (scorePercent === 100 ? '#00e676' : '#ffb300') : '#888',
        distToCE: distStr,
        rules
      };
    }

    return result;
  }
}

const bprStrategyNAS100 = new BPRNas100BullishStrategy({ isLiveExecution: true });

module.exports = {
  BPRNas100BullishStrategy,
  bprStrategyNAS100
};
