/**
 * Motor Algorítmico Institucional Multitemporal BPR Sniper: GBPJPY (M2 + M3 + M5 + M15)
 * [MODO EXCLUSIVO: SÓLO VENTAS / BEARISH BPR]
 * 
 * Basado en la auditoría cuantitativa 2020-2026 (7 años):
 * - Dirección: SHORT / SELL únicamente
 * - Entrada: Consequent Encroachment 50% (CE_50)
 * - Stop Loss: Estructural detrás de la caja BPR + Buffer de aire (3.5 a 7.0 pips)
 * - Ratio R:R: 1:1.0 (Win Rate global 75.1%, Profit Factor 3.08)
 * - Horario Operativo: 07:00 a 18:30 UTC (Londres + London Fix + Wall Street)
 * - Bloqueo Estricto: 21:00 a 01:00 UTC (Rollover interbancario con spread > 10 pips)
 */

const fs = require('fs');
const path = require('path');
const { notificationService } = require('../NotificationService');
const { riskEngine } = require('../RiskEngine');

const SHADOW_GBPJPY_FILE = path.join(__dirname, '..', '..', 'proprietary_bpr_gbpjpy_trades.json');
const CANDLE_CACHE_FILE = path.join(__dirname, '..', '..', 'bpr_gbpjpy_candle_cache.json');

const GBPJPY_CONFIG = {
  M2:  { tfMinutes: 2,  minFvgGap: 0.020, minOverlap: 0.012, minRange: 0.025, bufferPips: 3.0, slMinPips: 4.0,  slMaxPips: 25.0, rrRatio: 1.0, lookback: 25 },
  M3:  { tfMinutes: 3,  minFvgGap: 0.025, minOverlap: 0.015, minRange: 0.030, bufferPips: 3.5, slMinPips: 5.0,  slMaxPips: 30.0, rrRatio: 1.0, lookback: 25 },
  M5:  { tfMinutes: 5,  minFvgGap: 0.035, minOverlap: 0.020, minRange: 0.045, bufferPips: 4.0, slMinPips: 6.0,  slMaxPips: 40.0, rrRatio: 1.0, lookback: 25 },
  M15: { tfMinutes: 15, minFvgGap: 0.055, minOverlap: 0.030, minRange: 0.065, bufferPips: 5.0, slMinPips: 8.0,  slMaxPips: 60.0, rrRatio: 1.0, lookback: 25 }
};

class BPRGbpjpyBearishStrategy {
  constructor(options = {}) {
    this.name = 'BPR_GBPJPY_Bearish_Sniper';
    this.symbol = 'GBPJPY';
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : true;
    this.executionHandler = null;

    this.timeframes = {
      M2:  { config: GBPJPY_CONFIG.M2,  candles: [], currentBar: null, bprZones: [] },
      M3:  { config: GBPJPY_CONFIG.M3,  candles: [], currentBar: null, bprZones: [] },
      M5:  { config: GBPJPY_CONFIG.M5,  candles: [], currentBar: null, bprZones: [] },
      M15: { config: GBPJPY_CONFIG.M15, candles: [], currentBar: null, bprZones: [] }
    };

    this.activeTrades = [];
    this.history = [];
    this.metrics = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      netPips: 0,
      grossWon: 0,
      grossLost: 0,
      profitFactor: 0,
      maxDrawdownPips: 0,
      peakPips: 0,
      byTimeframe: {
        M2:  { trades: 0, wins: 0, pips: 0 },
        M3:  { trades: 0, wins: 0, pips: 0 },
        M5:  { trades: 0, wins: 0, pips: 0 },
        M15: { trades: 0, wins: 0, pips: 0 }
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
      if (fs.existsSync(SHADOW_GBPJPY_FILE)) {
        const data = JSON.parse(fs.readFileSync(SHADOW_GBPJPY_FILE, 'utf-8'));
        this.history = data.history || [];
        this.metrics = data.metrics || this.metrics;
        this.activeTrades = data.activeTrades || [];
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar estado de BPR GBPJPY:', e.message);
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
            this.scanAllBprZones(tfKey, tfObj);
          }
        }
        const summary = Object.keys(this.timeframes).map(k => `${k}:${this.timeframes[k].candles.length}v(${this.timeframes[k].bprZones.filter(z=>!z.mitigated).length}z)`).join(' ');
        console.log(`💷 [BPR GBPJPY Cache] Velas restauradas (${summary}). Zonas BPR Bearish listas.`);
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar caché de velas GBPJPY:', e.message);
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
      fs.writeFileSync(SHADOW_GBPJPY_FILE, JSON.stringify({
        strategy: this.name,
        symbol: this.symbol,
        metrics: this.metrics,
        activeTrades: this.activeTrades,
        history: this.history.slice(-150),
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      console.error('❌ Error guardando BPR GBPJPY:', e.message);
    }
  }

  processTick(tick) {
    const { bid, ask, time = Date.now(), symbol } = tick;
    if (symbol && !symbol.toUpperCase().includes('GBP') && !symbol.toUpperCase().includes('JPY')) return;

    const price = (bid + ask) / 2.0;
    this.latestPrice = price;
    this.latestBid = bid;
    this.latestAsk = ask;
    const spreadPips = (ask - bid) * 100.0; // 1 pip = 0.01

    for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
      this.updateTimeframeBar(tfKey, tfObj, price, spreadPips, time);
    }

    this.manageActiveTrades(price, spreadPips);
  }

  updateTimeframeBar(tfKey, tfObj, price, spreadPips, time) {
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
        spreadPips,
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

    this.scanBprZones(tfKey, tfObj);
    this.evaluateEntry(tfKey, tfObj, candle);
    this.saveCandleCache();
  }

  /**
   * Escaneo incremental de zonas BEARISH BPR
   */
  scanBprZones(tfKey, tfObj) {
    const candles = tfObj.candles;
    const n = candles.length;
    if (n < 4) return;

    const c0 = candles[n - 1];
    const c1 = candles[n - 2];
    const c2 = candles[n - 3];
    const c3 = candles[n - 4];
    const cfg = tfObj.config;

    const isBearishFVG = (c3.low - c1.high) >= cfg.minFvgGap;
    const isBullishFVG = (c1.low - c3.high) >= cfg.minFvgGap;

    if (isBearishFVG) c1.isBearish = true;
    if (isBullishFVG) c1.isBullish = true;

    // Solo creamos zonas BEARISH para buscar ventas institucionales
    if (isBearishFVG) {
      for (let j = n - 3; j >= Math.max(0, n - (cfg.lookback || 25)); j--) {
        if (candles[j] && candles[j].isBullish) {
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const bullTop = candles[j].low;
          const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.minFvgGap;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + cfg.minOverlap) {
            const ce50 = (cHigh + cLow) / 2.0;
            tfObj.bprZones.push({
              id: `BPR_GBPJPY_${tfKey}_BEAR_${Date.now()}`,
              tf: tfKey,
              type: 'BEARISH',
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

    for (let i = 3; i < n; i++) {
      const c0 = candles[i], c1 = candles[i - 1], c2 = candles[i - 2], c3 = candles[i - 3];
      const isBearishFVG = (c3.low - c1.high) >= cfg.minFvgGap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.minFvgGap;
      if (isBearishFVG) c1.isBearish = true;
      if (isBullishFVG) c1.isBullish = true;

      if (isBearishFVG) {
        for (let j = i - 2; j >= Math.max(0, i - (cfg.lookback || 25)); j--) {
          if (candles[j].isBullish) {
            const bearTop = c3.low;
            const bearBottom = c1.high;
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.minFvgGap;
            const cLow = Math.max(bullBottom, bearBottom);
            const cHigh = Math.min(bullTop, bearTop);

            if (cHigh > cLow + cfg.minOverlap) {
              const ce50 = (cHigh + cLow) / 2.0;
              tfObj.bprZones.push({
                id: `BPR_GBPJPY_${tfKey}_BEAR_${i}`,
                tf: tfKey,
                type: 'BEARISH',
                top: cHigh,
                bottom: cLow,
                consequentEncroachment: ce50,
                tested: false,
                mitigated: false,
                createdIndex: i,
                createdTime: c0.time,
                barIndex: i
              });
              break;
            }
          }
        }
      }
    }
    while (tfObj.bprZones.length > 250) tfObj.bprZones.shift();

    // Mitigaciones
    for (const zone of tfObj.bprZones) {
      for (let j = zone.createdIndex + 1; j < n; j++) {
        const bar = candles[j];
        if (bar.high >= zone.top) {
          zone.mitigated = true;
        } else if (bar.high >= zone.bottom) {
          zone.tested = true;
        }
      }
    }
  }

  evaluateEntry(tfKey, tfObj, candle) {
    const date = new Date(candle.time);
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();

    // 🔴 Bloqueo estricto Rollover (21:00 a 01:00 UTC)
    if (hour >= 21 || hour < 1) return;

    // 🟢 Sesión activa óptima: Londres + London Fix + Wall Street (07:00 a 18:30 UTC, excluyendo merma 10:00-11:00 UTC)
    if (hour < 7 || (hour === 18 && min > 30) || hour > 18 || hour === 10) return;

    const candleRange = candle.high - candle.low;
    const cfg = tfObj.config;
    if (candleRange < cfg.minRange) return;

    const pipMultiplier = 100; // 1 pip = 0.01 en JPY
    const bufferPrice = cfg.bufferPips / pipMultiplier;

    for (let z = tfObj.bprZones.length - 1; z >= 0; z--) {
      const bpr = tfObj.bprZones[z];
      if (bpr.tested) continue;
      const age = tfObj.candles.length - 1 - bpr.createdIndex;
      if (age > 300) { bpr.tested = true; continue; }

      // ENTRADA SELL INSTITUCIONAL (Retesteo a la zona Bearish BPR)
      if (candle.high >= bpr.bottom && candle.high <= bpr.top + bufferPrice) {
        // Mecha superior de rechazo >= 20% del rango de la vela
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        if (upperWick / candleRange < 0.20) continue;

        bpr.tested = true;
        const entry = candle.close; // Precio real de mercado al cierre
        const sl = bpr.top + bufferPrice;
        const slDist = Math.abs(sl - entry);
        const slPips = slDist * pipMultiplier;

        if (slPips < cfg.slMinPips || slPips > cfg.slMaxPips) continue;

        const tpDist = slDist * cfg.rrRatio;
        const tp = entry - tpDist;

        this.openTrade(tfKey, 'SELL', entry, sl, tp, slPips, candle.time);
        break;
      }
    }
  }

  openTrade(tfKey, type, entryPrice, stopLoss, takeProfit, slPips, timeMs) {
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
      const remainMin = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
      console.log(`\n🛑 [BPR GBPJPY Cooldown] Señal SELL en ${tfKey} BLOQUEADA por racha de SL. Enfriamiento activo (${remainMin} min restantes).`);
      return;
    }

    const hasAnyActiveTrade = this.activeTrades.some(t => t.symbol === 'GBPJPY' && t.status === 'OPEN');
    if (hasAnyActiveTrade) {
      console.log(`\n⚠️ [BPR GBPJPY Anti-Stacking] Señal SELL en ${tfKey} OMITIDA: Ya existe una operación activa en GBPJPY.`);
      return;
    }

    const tradeId = `BPR_GBPJPY_${tfKey}_${Date.now()}`;
    const tpPips = slPips * this.timeframes[tfKey].config.rrRatio;

    const trade = {
      id: tradeId,
      timeframe: tfKey,
      symbol: 'GBPJPY',
      type: 'SELL',
      entryPrice: parseFloat(entryPrice.toFixed(3)),
      initialSL: parseFloat(stopLoss.toFixed(3)),
      currentSL: parseFloat(stopLoss.toFixed(3)),
      tpPrice: parseFloat(takeProfit.toFixed(3)),
      slPips: parseFloat(slPips.toFixed(1)),
      tpPips: parseFloat(tpPips.toFixed(1)),
      openTime: new Date(timeMs).toISOString(),
      status: 'OPEN'
    };

    this.activeTrades.push(trade);
    console.log(`\n🎯 [BPR GBPJPY ${tfKey}] SEÑAL SHORT DETECTADA: SELL @ ${trade.entryPrice} | SL: ${trade.initialSL} (${trade.slPips}p) | TP: ${trade.tpPrice} (${trade.tpPips}p)`);

    // Notificación Telegram segura
    try {
      if (typeof notificationService.notifyTradeExecuted === 'function') {
        notificationService.notifyTradeExecuted({
          symbol: 'GBPJPY',
          action: 'SELL',
          entryPrice: trade.entryPrice,
          slPrice: trade.initialSL,
          tp1Price: trade.tpPrice,
          channelName: `BPR Sniper GBPJPY [${tfKey}]`
        }).catch(() => {});
      }
    } catch (e) {}

    // Despacho a MT5 si el executionHandler está activo
    if (this.isLiveExecution && this.executionHandler) {
      try {
        const orderPayload = {
          valid: true,
          action: 'SELL',
          symbol: 'GBPJPY',
          entryPrice: trade.entryPrice,
          slPrice: trade.initialSL,
          tp1Price: trade.tpPrice,
          targetTP: trade.tpPrice,
          channelId: `BPR_GBPJPY_${tfKey}`,
          channelName: `BPR Sniper GBPJPY [${tfKey}]`,
          comment: `BPR GBPJPY ${tfKey}`,
          isReducedRisk: false
        };

        this.executionHandler(orderPayload).then(success => {
          if (success) {
            console.log(`🚀 [BPR GBPJPY ${tfKey}] Orden SELL despachada a MT5 con éxito.`);
          }
        }).catch(err => {
          console.error(`❌ [BPR GBPJPY ${tfKey}] Error en executionHandler:`, err.message);
        });
      } catch (err) {
        console.error(`❌ [BPR GBPJPY ${tfKey}] Fallo despachando a MT5:`, err.message);
      }
    }

    this.saveState();
  }

  manageActiveTrades(currentPrice, spreadPips) {
    if (this.activeTrades.length === 0) return;

    const remainingTrades = [];
    const pipMultiplier = 100;

    for (const trade of this.activeTrades) {
      let closed = false;
      let outcome = null;
      let pips = 0;

      // Trade es SELL
      if (currentPrice <= trade.tpPrice) {
        closed = true;
        outcome = 'WIN';
        pips = trade.tpPips;
      } else if (currentPrice >= trade.currentSL) {
        closed = true;
        outcome = 'LOSS';
        pips = -trade.slPips;
      }

      if (closed) {
        trade.status = outcome;
        trade.closePrice = currentPrice;
        trade.closeTime = new Date().toISOString();
        trade.pips = parseFloat(pips.toFixed(1));

        this.history.push(trade);
        this.updateMetrics(trade);

        console.log(`\n🔔 [BPR GBPJPY ${trade.timeframe}] Trade cerrado: ${outcome} (${pips > 0 ? '+' : ''}${trade.pips} pips)`);
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
      this.metrics.grossWon += trade.pips;
    } else {
      this.metrics.losses++;
      this.metrics.grossLost += Math.abs(trade.pips);
    }

    this.metrics.winRate = parseFloat(((this.metrics.wins / this.metrics.totalTrades) * 100).toFixed(1));
    this.metrics.netPips = parseFloat((this.metrics.grossWon - this.metrics.grossLost).toFixed(1));
    this.metrics.profitFactor = this.metrics.grossLost > 0 ? parseFloat((this.metrics.grossWon / this.metrics.grossLost).toFixed(2)) : 99.9;

    const tf = trade.timeframe;
    if (this.metrics.byTimeframe[tf]) {
      this.metrics.byTimeframe[tf].trades++;
      if (isWin) this.metrics.byTimeframe[tf].wins++;
      this.metrics.byTimeframe[tf].pips = parseFloat((this.metrics.byTimeframe[tf].pips + trade.pips).toFixed(1));
    }

    if (this.metrics.netPips > this.metrics.peakPips) {
      this.metrics.peakPips = this.metrics.netPips;
    }
    const currentDD = this.metrics.peakPips - this.metrics.netPips;
    if (currentDD > this.metrics.maxDrawdownPips) {
      this.metrics.maxDrawdownPips = parseFloat(currentDD.toFixed(1));
    }
  }

  /**
   * Genera checklist en tiempo real para el Dashboard
   */
  getConfirmationChecklist(currentPrice) {
    const result = {};
    const pipMultiplier = 100;

    for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
      // 🔍 0. Verificar si hay operación activa o recién ejecutada en este timeframe
      const openTrade = this.activeTrades.find(t => t.symbol === 'GBPJPY' && t.timeframe === tfKey && t.status === 'OPEN');
      const recentClosedTrade = this.history.find(t => t.symbol === 'GBPJPY' && t.timeframe === tfKey && (Date.now() - new Date(t.closeTime).getTime()) < 300000); // 5 min

      if (openTrade) {
        result[tfKey] = {
          score: '4/4',
          scorePercent: 100,
          activeType: 'BEARISH (VENTAS)',
          statusLabel: 'EN MERCADO (ORDEN VIVA)',
          statusColor: '#00e676',
          distToCE: 'En ejecución',
          rules: [
            { name: 'Bearish BPR Activo', ok: true, detail: `Entrada: ${openTrade.entryPrice}` },
            { name: 'Horario Institucional', ok: true, detail: `Operación activa en ${openTrade.type}` },
            { name: 'Proximidad CE 50%', ok: true, detail: `SL: ${openTrade.initialSL} | TP: ${openTrade.tpPrice}` },
            { name: 'Rango Mínimo Vela', ok: true, detail: `SL Pips: ${openTrade.slPips}p` }
          ]
        };
        continue;
      }

      if (recentClosedTrade) {
        const isWin = recentClosedTrade.pips > 0;
        result[tfKey] = {
          score: '4/4',
          scorePercent: 100,
          activeType: 'BEARISH (VENTAS)',
          statusLabel: isWin ? `TP ALCANZADO (+${recentClosedTrade.pips}p)` : `SL CERRADO (${recentClosedTrade.pips}p)`,
          statusColor: isWin ? '#00e676' : '#ef4444',
          distToCE: `${recentClosedTrade.reason} (${recentClosedTrade.pips > 0 ? '+' : ''}${recentClosedTrade.pips}p)`,
          rules: [
            { name: 'Bearish BPR Activo', ok: true, detail: `Entrada: ${recentClosedTrade.entryPrice}` },
            { name: 'Horario Institucional', ok: true, detail: `Cierre: ${recentClosedTrade.reason}` },
            { name: 'Proximidad CE 50%', ok: true, detail: `Resultado: ${recentClosedTrade.pips > 0 ? '+' : ''}${recentClosedTrade.pips}p` },
            { name: 'Rango Mínimo Vela', ok: true, detail: 'Completado con éxito' }
          ]
        };
        continue;
      }

      const lastCandle = tfObj.candles[tfObj.candles.length - 1];
      const effPrice = (currentPrice > 0) ? currentPrice : (lastCandle ? lastCandle.close : 0);
      const lastIndex = tfObj.candles.length - 1;
      const MAX_ZONE_AGE_BARS = 80;
      const MAX_ZONE_DIST_PIPS = 35.0;

      // Priorizar zonas Bearish vivas no mitigadas, no testeadas, recientes y en rango
      const freshZones = tfObj.bprZones.filter(z => 
        !z.mitigated && 
        !z.tested && 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (effPrice > 0 ? (Math.abs(effPrice - z.consequentEncroachment) * pipMultiplier <= MAX_ZONE_DIST_PIPS) : true)
      );
      let activeZone = null;
      if (freshZones.length > 0) {
        activeZone = freshZones.slice().sort((a, b) => Math.abs(effPrice - a.consequentEncroachment) - Math.abs(effPrice - b.consequentEncroachment))[0];
      }

      // Zona de referencia reciente
      const recentZones = tfObj.bprZones.filter(z => 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (effPrice > 0 ? (Math.abs(effPrice - z.consequentEncroachment) * pipMultiplier <= MAX_ZONE_DIST_PIPS * 1.5) : true)
      );
      const refZone = activeZone || recentZones.slice(-1)[0] || null;

      let score = 0;
      const rules = [];

      // Regla 1: Zona Bearish BPR activa
      if (activeZone) {
        score++;
        rules.push({ name: 'Bearish BPR Activo', ok: true, detail: `Zona: ${activeZone.bottom.toFixed(3)} - ${activeZone.top.toFixed(3)}` });
      } else if (refZone) {
        rules.push({ name: 'Bearish BPR Activo', ok: false, detail: `Zona reciente: ${refZone.bottom.toFixed(3)} - ${refZone.top.toFixed(3)}` });
      } else {
        rules.push({ name: 'Bearish BPR Activo', ok: false, detail: 'Sin zonas Bearish en rango (rastreando)' });
      }

      // Regla 2: Filtro de Sesión Óptima (07:00 a 18:30 UTC, excluyendo merma 10:00 UTC)
      const now = new Date();
      const h = now.getUTCHours();
      const m = now.getUTCMinutes();
      const isPreLunchLock = (h === 10);
      const isOptimalSession = (h >= 7 && (h < 18 || (h === 18 && m <= 30))) && !isPreLunchLock;
      const isBlockedSession = (h >= 21 || h < 1);
      if (isPreLunchLock) {
        rules.push({ name: 'Horario Institucional', ok: false, detail: 'Bloqueo Merma Pre-Almuerzo (10:00-11:00 UTC)' });
      } else if (isOptimalSession) {
        score++;
        rules.push({ name: 'Horario Institucional', ok: true, detail: 'Londres / Wall St (07:00-18:30 UTC)' });
      } else if (isBlockedSession) {
        rules.push({ name: 'Horario Institucional', ok: false, detail: '🔴 Bloqueo Rollover (21:00-01:00 UTC)' });
      } else {
        rules.push({ name: 'Horario Institucional', ok: false, detail: 'Fuera de sesión óptima' });
      }

      // Regla 3: Distancia al CE 50%
      let distStr = '0.0 pips';
      if (refZone && effPrice > 0) {
        const distPips = Math.abs(refZone.consequentEncroachment - effPrice) * pipMultiplier;
        distStr = `${distPips.toFixed(1)} pips`;
        if (distPips <= (tfObj.config.minRange * pipMultiplier * 1.5)) {
          score++;
          rules.push({ name: 'Proximidad CE 50%', ok: true, detail: `A ${distStr} (${activeZone ? 'Zona Activa' : 'Ref Reciente'})` });
        } else {
          rules.push({ name: 'Proximidad CE 50%', ok: false, detail: `Distancia: ${distStr}` });
        }
      } else if (lastCandle && effPrice > 0) {
        const distPips = Math.abs(lastCandle.high - effPrice) * pipMultiplier;
        distStr = `${distPips.toFixed(1)} pips`;
        rules.push({ name: 'Proximidad CE 50%', ok: false, detail: `Buscando zona en rango (Swing: ${distStr})` });
      } else {
        distStr = '0.0 pips';
        rules.push({ name: 'Proximidad CE 50%', ok: false, detail: 'Buscando zona en rango' });
      }

      // Regla 4: Volatilidad y Spread
      const candleRangePips = lastCandle ? ((lastCandle.high - lastCandle.low) * pipMultiplier).toFixed(1) : 0;
      if (candleRangePips >= (tfObj.config.minRange * pipMultiplier)) {
        score++;
        rules.push({ name: 'Rango Mínimo Vela', ok: true, detail: `${candleRangePips} pips (Min: ${(tfObj.config.minRange * pipMultiplier).toFixed(1)}p)` });
      } else {
        rules.push({ name: 'Rango Mínimo Vela', ok: false, detail: `${candleRangePips} pips (Insuficiente)` });
      }

      const scorePercent = Math.round((score / 4) * 100);
      result[tfKey] = {
        score: `${score}/4`,
        scorePercent,
        activeType: activeZone ? 'BEARISH (VENTAS)' : 'BEARISH (MONITOR)',
        statusLabel: activeZone ? 'ZONA BEARISH' : 'BUSCANDO BPR',
        statusColor: activeZone ? (scorePercent === 100 ? '#00e676' : '#ffb300') : '#888',
        distToCE: distStr,
        rules
      };
    }

    return result;
  }
}

const bprStrategyGBPJPY = new BPRGbpjpyBearishStrategy({ isLiveExecution: true });

module.exports = {
  BPRGbpjpyBearishStrategy,
  bprStrategyGBPJPY
};
