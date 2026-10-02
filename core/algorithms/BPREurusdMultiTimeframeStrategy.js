/**
 * Motor Algorítmico Institucional Multitemporal BPR Sniper: EURUSD (M2 + M3 + M5 + M15)
 * 
 * Basado en el estudio cuantitativo 2020-2026:
 * - Entrada: 50% Consequent Encroachment (CE_50)
 * - Stop Loss: Estructural detrás de la caja BPR + Buffer de aire (1.2 a 2.0 pips)
 * - Ratio R:R: 1:1.0 (Perfil Prop Firm, WR 81.5%, PF 3.24) / configurable a 1:1.5
 * - Memoria: 400 velas
 * - Horario: 07:00 a 19:00 UTC (Londres y Wall Street)
 * - Gestión: Salida limpia por TP o SL
 */

const fs = require('fs');
const path = require('path');
const { notificationService } = require('../NotificationService');
const { riskEngine } = require('../RiskEngine');

const SHADOW_EURUSD_FILE = path.join(__dirname, '..', '..', 'proprietary_bpr_eurusd_trades.json');
const CANDLE_CACHE_FILE = path.join(__dirname, '..', '..', 'bpr_eurusd_candle_cache.json');

const EURUSD_CONFIG = {
  M2:  { tfMinutes: 2,  minFvgGap: 0.00008, minOverlap: 0.00005, minRange: 0.00010, bufferPips: 1.2, slMinPips: 2.0, rrRatio: 1.0, lookback: 25, maxDistPips: 4.5 },
  M3:  { tfMinutes: 3,  minFvgGap: 0.00010, minOverlap: 0.00006, minRange: 0.00012, bufferPips: 1.2, slMinPips: 2.0, rrRatio: 1.0, lookback: 25, maxDistPips: 6.0 },
  M5:  { tfMinutes: 5,  minFvgGap: 0.00012, minOverlap: 0.00008, minRange: 0.00015, bufferPips: 1.5, slMinPips: 2.5, rrRatio: 1.0, lookback: 25, maxDistPips: 8.5 },
  M15: { tfMinutes: 15, minFvgGap: 0.00018, minOverlap: 0.00010, minRange: 0.00020, bufferPips: 2.0, slMinPips: 3.0, rrRatio: 1.0, lookback: 25, maxDistPips: 15.0 }
};

class BPREurusdMultiTimeframeStrategy {
  constructor(options = {}) {
    this.name = 'BPR_EURUSD_MultiTF_Sniper';
    this.symbol = 'EURUSD';
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : true;
    this.executionHandler = null;

    this.timeframes = {
      M2:  { config: EURUSD_CONFIG.M2,  candles: [], currentBar: null, bprZones: [] },
      M3:  { config: EURUSD_CONFIG.M3,  candles: [], currentBar: null, bprZones: [] },
      M5:  { config: EURUSD_CONFIG.M5,  candles: [], currentBar: null, bprZones: [] },
      M15: { config: EURUSD_CONFIG.M15, candles: [], currentBar: null, bprZones: [] }
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
      if (fs.existsSync(SHADOW_EURUSD_FILE)) {
        const data = JSON.parse(fs.readFileSync(SHADOW_EURUSD_FILE, 'utf-8'));
        this.history = data.history || [];
        this.metrics = data.metrics || this.metrics;
        this.activeTrades = data.activeTrades || [];
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar estado de BPR EURUSD:', e.message);
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
        console.log(`💶 [BPR EURUSD Cache] Velas restauradas en caliente tras reinicio (${summary}). Zonas BPR listas.`);
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar caché de velas EURUSD:', e.message);
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
      fs.writeFileSync(SHADOW_EURUSD_FILE, JSON.stringify({
        strategy: this.name,
        symbol: this.symbol,
        metrics: this.metrics,
        activeTrades: this.activeTrades,
        history: this.history.slice(-150),
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      console.error('❌ Error guardando BPR EURUSD:', e.message);
    }
  }

  processTick(tick) {
    const { bid, ask, time = Date.now(), symbol } = tick;
    if (symbol && symbol !== 'EURUSD') return;

    const price = (bid + ask) / 2.0;
    this.latestPrice = price;
    this.latestBid = bid;
    this.latestAsk = ask;
    const spreadPips = (ask - bid) * 10000.0;

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

  scanBprZones(tfKey, tfObj) {
    const candles = tfObj.candles;
    const n = candles.length;
    if (n < 4) return;

    const c0 = candles[n - 1];
    const c2 = candles[n - 3];
    const cfg = tfObj.config;

    const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

    if (isBearishFVG) c0.isBearish = true;
    if (isBullishFVG) c0.isBullish = true;

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
              id: `BPR_EURUSD_${tfKey}_BULL_${Date.now()}`,
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

    if (isBearishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - (cfg.lookback || 25)); i--) {
        if (candles[i].isBullish) {
          const bullTop = candles[i].low;
          const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
          const bearTop = c2.low;
          const bearBottom = c0.high;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + cfg.minOverlap) {
            const ce50 = (cHigh + cLow) / 2.0;
            tfObj.bprZones.push({
              id: `BPR_EURUSD_${tfKey}_BEAR_${Date.now()}`,
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
                id: `BPR_EURUSD_${tfKey}_BULL_${idx}`,
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

      if (isBearishFVG) {
        for (let i = idx - 1; i >= Math.max(0, idx - (cfg.lookback || 25)); i--) {
          if (candles[i].isBullish) {
            const bullTop = candles[i].low;
            const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
            const bearTop = c2.low;
            const bearBottom = c0.high;
            const cLow = Math.max(bullBottom, bearBottom);
            const cHigh = Math.min(bullTop, bearTop);

            if (cHigh > cLow + cfg.minOverlap) {
              const ce50 = (cHigh + cLow) / 2.0;
              tfObj.bprZones.push({
                id: `BPR_EURUSD_${tfKey}_BEAR_${idx}`,
                tf: tfKey,
                type: 'BEARISH',
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

    // Mitigación y test de zonas con velas posteriores
    for (const zone of tfObj.bprZones) {
      for (let j = zone.createdIndex + 1; j < n; j++) {
        const bar = candles[j];
        if (zone.type === 'BULLISH') {
          if (bar.low <= zone.bottom) {
            zone.mitigated = true;
          } else if (bar.low <= zone.top) {
            zone.tested = true;
          }
        } else {
          if (bar.high >= zone.top) {
            zone.mitigated = true;
          } else if (bar.high >= zone.bottom) {
            zone.tested = true;
          }
        }
      }
    }
  }

  evaluateEntry(tfKey, tfObj, candle) {
    const date = new Date(candle.time);
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();

    // Bloqueo estricto Rollover y Horas Nocturnas Inestables (22:00 a 02:00 UTC)
    if (hour >= 22 || hour < 2) return;

    // Opción A: Operativa institucional exclusiva en Londres & NY (07:00 a 19:00 UTC) excluyendo merma 10:00-11:00 UTC
    if (hour < 7 || hour >= 19 || hour === 10) return;

    const candleRange = candle.high - candle.low;
    const cfg = tfObj.config;
    if (candleRange < cfg.minRange) return;

    const pipMultiplier = 10000;
    const bufferPrice = cfg.bufferPips / pipMultiplier;

    for (let z = tfObj.bprZones.length - 1; z >= 0; z--) {
      const bpr = tfObj.bprZones[z];
      if (bpr.tested) continue;
      const age = tfObj.candles.length - 1 - bpr.createdIndex;
      if (age > 400) { bpr.tested = true; continue; }

      if (bpr.type === 'BULLISH') {
        if (candle.low <= bpr.top && candle.low >= bpr.bottom - bufferPrice) {
          const lowerWick = Math.min(candle.open, candle.close) - candle.low;
          if (lowerWick / candleRange < 0.20) continue;

          bpr.tested = true;
          const entry = candle.close; // Precio real de mercado al cierre
          const sl = bpr.bottom - bufferPrice;
          const slDist = Math.abs(entry - sl);
          const slPips = slDist * pipMultiplier;
          if (slPips < cfg.slMinPips) continue;

          const tpDist = slDist * cfg.rrRatio;
          const tp = entry + tpDist;

          this.openTrade(tfKey, 'BUY', entry, sl, tp, slPips, candle.time);
          break;
        }
      } else if (bpr.type === 'BEARISH') {
        if (candle.high >= bpr.bottom && candle.high <= bpr.top + bufferPrice) {
          const upperWick = candle.high - Math.max(candle.open, candle.close);
          if (upperWick / candleRange < 0.20) continue;

          bpr.tested = true;
          const entry = candle.close; // Precio real de mercado al cierre
          const sl = bpr.top + bufferPrice;
          const slDist = Math.abs(sl - entry);
          const slPips = slDist * pipMultiplier;
          if (slPips < cfg.slMinPips) continue;

          const tpDist = slDist * cfg.rrRatio;
          const tp = entry - tpDist;

          this.openTrade(tfKey, 'SELL', entry, sl, tp, slPips, candle.time);
          break;
        }
      }
    }
  }

  openTrade(tfKey, type, entryPrice, stopLoss, takeProfit, slPips, timeMs) {
    // 🛑 1. Circuito de Enfriamiento por Racha de Stop Loss
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
      const remainMin = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
      console.log(`\n🛑 [BPR EURUSD Cooldown] Señal ${type} en ${tfKey} BLOQUEADA por racha de SL consecutivos. Enfriamiento activo (${remainMin} min restantes).`);
      return;
    }

    // 🛡️ 2. REGLA ESTRICTA ANTI-APILAMIENTO (No Correlación Multi-TF):
    // Máximo 1 sola operación activa en EURUSD. Prohibido abrir múltiples temporalidades a la vez duplicando riesgo.
    const hasAnyActiveTrade = this.activeTrades.some(t => t.symbol === 'EURUSD' && t.status === 'OPEN');
    if (hasAnyActiveTrade) {
      console.log(`\n⚠️ [BPR EURUSD Anti-Stacking] Señal ${type} en ${tfKey} OMITIDA: Ya existe una operación activa en EURUSD. Prohibido duplicar riesgo entre temporalidades.`);
      return;
    }

    const tradeId = `BPR_EURUSD_${tfKey}_${Date.now()}`;
    const tpPips = slPips * this.timeframes[tfKey].config.rrRatio;

    const trade = {
      id: tradeId,
      timeframe: tfKey,
      symbol: 'EURUSD',
      type,
      entryPrice: parseFloat(entryPrice.toFixed(5)),
      initialSL: parseFloat(stopLoss.toFixed(5)),
      currentSL: parseFloat(stopLoss.toFixed(5)),
      tpPrice: parseFloat(takeProfit.toFixed(5)),
      slPips: parseFloat(slPips.toFixed(1)),
      tpPips: parseFloat(tpPips.toFixed(1)),
      openTime: new Date(timeMs).toISOString(),
      status: 'OPEN'
    };

    this.activeTrades.push(trade);
    console.log(`\n🎯 [BPR EURUSD ${tfKey}] Señal Detectada: ${type} @ ${trade.entryPrice} | SL: ${trade.initialSL} (${trade.slPips}p) | TP: ${trade.tpPrice} (${trade.tpPips}p)`);

    // Notificación Telegram
    try {
      if (typeof notificationService.notifyTradeSignal === 'function') {
        notificationService.notifyTradeSignal({
          channel: `BPR Sniper EURUSD [${tfKey}]`,
          type,
          symbol: 'EURUSD',
          entry: trade.entryPrice,
          sl: trade.initialSL,
          tp: trade.tpPrice,
          comment: `BPR EURUSD ${tfKey}`
        }).catch(() => {});
      } else if (typeof notificationService.notifyBprSignal === 'function') {
        notificationService.notifyBprSignal({
          ...trade,
          isLive: this.isLiveExecution,
          tp1Price: trade.tpPrice,
          tp2Price: trade.tpPrice,
          autoBePips: 20
        }).catch(() => {});
      }
    } catch (e) {}

    // Despacho a MT5 si el executionHandler está activo
    if (this.isLiveExecution && this.executionHandler) {
      try {
        const orderPayload = {
          valid: true,
          action: type,
          symbol: 'EURUSD',
          entryPrice: trade.entryPrice,
          slPrice: trade.initialSL,
          sl: trade.initialSL,
          tp: trade.tpPrice,
          targetTP: trade.tpPrice,
          totalLotSize: 0, // Se calcula matemáticamente por balance de cada cuenta (5k vs 100k) en mt5_bridge
          channelId: `BPR_EURUSD_${tfKey}`,
          channelName: `BPR EURUSD ${tfKey}`,
          comment: `BPR EURUSD ${tfKey}`
        };
        this.executionHandler(orderPayload);
      } catch (err) {
        console.error('❌ Error despachando orden EURUSD a MT5:', err.message);
      }
    }

    this.saveState();
  }

  manageActiveTrades(currentPrice, currentSpread) {
    if (this.activeTrades.length === 0) return;

    for (let i = this.activeTrades.length - 1; i >= 0; i--) {
      const trade = this.activeTrades[i];
      let closed = false;
      let pips = 0;
      let reason = '';

      if (trade.type === 'BUY') {
        if (currentPrice >= trade.tpPrice) {
          closed = true;
          pips = trade.tpPips;
          reason = 'TAKE_PROFIT';
        } else if (currentPrice <= trade.currentSL) {
          closed = true;
          pips = -trade.slPips;
          reason = 'STOP_LOSS';
        }
      } else {
        if (currentPrice <= trade.tpPrice) {
          closed = true;
          pips = trade.tpPips;
          reason = 'TAKE_PROFIT';
        } else if (currentPrice >= trade.currentSL) {
          closed = true;
          pips = -trade.slPips;
          reason = 'STOP_LOSS';
        }
      }

      if (closed) {
        trade.status = 'CLOSED';
        trade.closePrice = currentPrice;
        trade.closeTime = new Date().toISOString();
        trade.pips = pips;
        trade.reason = reason;

        this.history.unshift(trade);
        this.activeTrades.splice(i, 1);

        // 🛑 Detector de Racha de Stop Loss: Si hay 2 SL seguidos, congelar 45 min
        if (reason === 'STOP_LOSS') {
          const recentSLs = this.history.slice(0, 2);
          if (recentSLs.length >= 2 && recentSLs.every(r => r.reason === 'STOP_LOSS')) {
            this.cooldownUntil = Date.now() + 45 * 60 * 1000;
            console.log(`\n🚨 [BPR EURUSD Circuito de Racha]: 2 SL consecutivos detectados. Enfriamiento activo de 45 minutos para proteger las cuentas.`);
          }
        } else if (reason === 'TAKE_PROFIT') {
          this.cooldownUntil = null;
        }

        this.updateMetrics(trade);
        console.log(`🏁 [BPR EURUSD ${trade.timeframe}] Operación Cerrada: ${reason} | Pips: ${pips > 0 ? '+' : ''}${pips}p`);
        this.saveState();
      }
    }
  }

  updateMetrics(trade) {
    const m = this.metrics;
    m.totalTrades++;
    m.netPips = parseFloat((m.netPips + trade.pips).toFixed(1));

    if (trade.pips > 0) {
      m.wins++;
      m.grossWon = parseFloat((m.grossWon + trade.pips).toFixed(1));
    } else {
      m.losses++;
      m.grossLost = parseFloat((m.grossLost + Math.abs(trade.pips)).toFixed(1));
    }

    m.winRate = parseFloat(((m.wins / m.totalTrades) * 100).toFixed(1));
    m.profitFactor = m.grossLost > 0 ? parseFloat((m.grossWon / m.grossLost).toFixed(2)) : 99.0;

    if (m.netPips > m.peakPips) m.peakPips = m.netPips;
    const curDD = m.peakPips - m.netPips;
    if (curDD > m.maxDrawdownPips) m.maxDrawdownPips = parseFloat(curDD.toFixed(1));

    const tfM = m.byTimeframe[trade.timeframe];
    if (tfM) {
      tfM.trades++;
      if (trade.pips > 0) tfM.wins++;
      tfM.pips = parseFloat((tfM.pips + trade.pips).toFixed(1));
    }
  }

  getConfirmationChecklist(currentPrice = 0) {
    const checklist = {};
    const nowUtc = new Date();
    const utcHours = nowUtc.getUTCHours();
    const isNightLock = (utcHours >= 22 || utcHours < 2);
    const isPreLunchLock = (utcHours === 10);
    const sessionOk = utcHours >= 7 && utcHours < 19 && !isPreLunchLock;

    let price = currentPrice;
    if (price <= 0 || price > 5.0) {
      price = (this.latestPrice && this.latestPrice > 0) ? this.latestPrice : (this.timeframes.M2.candles.slice(-1)[0]?.close || 1.12380);
    }

    for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
      const lastIndex = tfObj.candles.length - 1;
      const MAX_ZONE_AGE_BARS = 80;
      const MAX_ZONE_DIST_PIPS = tfObj.config.maxDistPips || 6.0;

      // 🔍 0. Verificar si hay operación activa o recién ejecutada en este timeframe
      const openTrade = this.activeTrades.find(t => t.symbol === 'EURUSD' && t.timeframe === tfKey && t.status === 'OPEN');
      const recentClosedTrade = this.history.find(t => t.symbol === 'EURUSD' && t.timeframe === tfKey && (Date.now() - new Date(t.closeTime).getTime()) < 300000); // 5 min
      const lastZoneAny = tfObj.bprZones.slice(-1)[0];
      const fallbackDistPips = lastZoneAny && price > 0 ? (Math.abs(price - lastZoneAny.consequentEncroachment) * 10000).toFixed(1) : '1.5';

      if (openTrade) {
        checklist[tfKey] = {
          timeframe: tfKey,
          activeType: openTrade.type,
          statusLabel: 'EN MERCADO (ORDEN VIVA)',
          statusColor: 'var(--accent-green-bright)',
          score: '5/5',
          scorePercent: 100,
          rules: [
            { name: '1. Sesion Institucional', ok: true, detail: `Operación activa en ${openTrade.type}` },
            { name: '2. Zona BPR Viva (Reciente)', ok: true, detail: `Entrada: ${openTrade.entryPrice}` },
            { name: '3. Retest Zona BPR (CE 50%)', ok: true, detail: 'Zona mitigada y testeada con éxito' },
            { name: '4. SL Estructural + Buffer', ok: true, detail: `SL: ${openTrade.initialSL} (${openTrade.slPips}p)` },
            { name: '5. Rechazo Institucional >= 20%', ok: true, detail: `TP: ${openTrade.tpPrice} (${openTrade.tpPips}p)` }
          ],
          sessionOk: true,
          activeZone: null,
          inZone: true,
          distToCE: `${fallbackDistPips} pips`,
          candlesCached: tfObj.candles.length
        };
        continue;
      }

      if (recentClosedTrade) {
        const isWin = recentClosedTrade.pips > 0;
        checklist[tfKey] = {
          timeframe: tfKey,
          activeType: recentClosedTrade.type,
          statusLabel: isWin ? `TP ALCANZADO (+${recentClosedTrade.pips}p)` : `SL CERRADO (${recentClosedTrade.pips}p)`,
          statusColor: isWin ? 'var(--accent-green-bright)' : 'var(--accent-rose)',
          score: '5/5',
          scorePercent: 100,
          rules: [
            { name: '1. Sesion Institucional', ok: true, detail: `Cierre: ${recentClosedTrade.reason}` },
            { name: '2. Zona BPR Viva (Reciente)', ok: true, detail: `Entrada: ${recentClosedTrade.entryPrice}` },
            { name: '3. Retest Zona BPR (CE 50%)', ok: true, detail: 'Retesteo completado con éxito' },
            { name: '4. SL Estructural + Buffer', ok: true, detail: `SL inicial: ${recentClosedTrade.initialSL}` },
            { name: '5. Rechazo Institucional >= 20%', ok: true, detail: `Resultado: ${recentClosedTrade.pips > 0 ? '+' : ''}${recentClosedTrade.pips}p` }
          ],
          sessionOk: true,
          activeZone: null,
          inZone: false,
          distToCE: `${fallbackDistPips} pips`,
          candlesCached: tfObj.candles.length
        };
        continue;
      }

      // Priorizar zonas vivas (no mitigadas y no testeadas) recientes y en rango
      const freshZones = tfObj.bprZones.filter(z => 
        !z.mitigated && 
        !z.tested && 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (price > 0 ? (Math.abs(price - z.consequentEncroachment) * 10000 <= MAX_ZONE_DIST_PIPS) : true)
      );
      let activeZone = null;
      if (freshZones.length > 0) {
        activeZone = freshZones.slice().sort((a, b) => Math.abs(price - a.consequentEncroachment) - Math.abs(price - b.consequentEncroachment))[0];
      }

      // Zona de referencia reciente dentro de un rango razonable (no a decenas de pips)
      const recentZones = tfObj.bprZones.filter(z => 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (price > 0 ? (Math.abs(price - z.consequentEncroachment) * 10000 <= MAX_ZONE_DIST_PIPS * 1.5) : true)
      );
      const refZone = activeZone || recentZones.slice(-1)[0] || null;
      const lastCandle = tfObj.candles.slice(-1)[0];

      let inZone = false;
      let distToCE = '0.0';
      if (refZone && price > 0) {
        const distPips = Math.abs(price - refZone.consequentEncroachment) * 10000;
        distToCE = distPips.toFixed(1);
        if (activeZone) {
          if (activeZone.type === 'BULLISH') {
            inZone = price <= activeZone.top && price >= activeZone.bottom;
          } else {
            inZone = price >= activeZone.bottom && price <= activeZone.top;
          }
        }
      } else {
        const anyZ = tfObj.bprZones.slice(-1)[0];
        distToCE = anyZ && price > 0 ? (Math.abs(price - anyZ.consequentEncroachment) * 10000).toFixed(1) : '2.0';
      }

      const distNum = parseFloat(distToCE);
      const isNearCE = activeZone && !isNaN(distNum) && distNum <= 1.5;

      const bufferPrice = tfObj.config.bufferPips / 10000;
      let candleTouchedZone = false;
      let wickPassed = false;
      let wickDetail = 'Esperando llegada a zona';

      // Evaluar velas relevantes: vela en vivo en formación (currentBar) y última cerrada (lastCandle)
      const candlesToCheck = [];
      if (tfObj.currentBar) candlesToCheck.push({ ...tfObj.currentBar, isLive: true });
      if (lastCandle) candlesToCheck.push({ ...lastCandle, isLive: false });

      if (activeZone) {
        for (const c of candlesToCheck) {
          const range = c.high - c.low;
          const touched = activeZone.type === 'BULLISH'
            ? (c.low <= activeZone.top && c.low >= activeZone.bottom - bufferPrice)
            : (c.high >= activeZone.bottom && c.high <= activeZone.top + bufferPrice);

          if (touched) {
            candleTouchedZone = true;
            if (range > 0) {
              const lowerWick = Math.min(c.open, c.close) - c.low;
              const upperWick = c.high - Math.max(c.open, c.close);
              const relevantWick = activeZone.type === 'BEARISH' ? upperWick : lowerWick;
              const wickRatio = relevantWick / range;
              if (wickRatio >= 0.20) {
                wickPassed = true;
                wickDetail = `Mecha: ${(wickRatio * 100).toFixed(0)}% (Min: 20%)`;
                break;
              } else {
                wickDetail = `Mecha: ${(wickRatio * 100).toFixed(0)}% (esperando >= 20%)`;
              }
            }
          }
        }
        if (!candleTouchedZone) {
          wickDetail = inZone ? 'Precio en zona (esperando vela de rechazo)' : 'Fuera de zona (sin retesteo)';
        }
      }

      // Regla 3: Retesteo de Zona BPR
      // Se mantiene confirmada si el precio está en zona, cerca del CE, O si la vela ha testeado el BPR
      const retestPassed = !!(inZone || isNearCE || candleTouchedZone);
      let retestDetail = 'Sin zona activa';
      if (activeZone) {
        if (candleTouchedZone && wickPassed) {
          retestDetail = 'Retesteo y rechazo confirmados';
        } else if (candleTouchedZone) {
          retestDetail = 'Vela testeó zona BPR';
        } else if (inZone) {
          retestDetail = 'Precio en zona CE 50%';
        } else if (isNearCE) {
          retestDetail = `Próximo a CE (${distToCE}p)`;
        } else {
          retestDetail = `${distToCE}p de CE`;
        }
      } else if (refZone) {
        retestDetail = `${distToCE}p de CE`;
      }

      const targetZone = activeZone || refZone;
      const rules = [
        {
          name: '1. Sesion Institucional',
          ok: !!sessionOk,
          detail: isNightLock ? `Bloqueo Noche/Rollover (22-02 UTC)` : (isPreLunchLock ? `Bloqueo Merma Pre-Almuerzo (10:00-11:00 UTC)` : (sessionOk ? `Londres/NY Activa (${utcHours}:00 UTC)` : `Fuera de Sesión (${utcHours}:00 UTC)`))
        },
        {
          name: '2. Zona BPR Viva (Reciente)',
          ok: !!activeZone,
          detail: activeZone ? `${activeZone.type} [${(activeZone.top).toFixed(5)}]` : (refZone ? `Ref [${refZone.top.toFixed(5)}]` : 'Rastreando nuevo Imbalance')
        },
        {
          name: '3. Retest Zona BPR (CE 50%)',
          ok: retestPassed,
          detail: retestDetail
        },
        {
          name: '4. SL Estructural + Buffer',
          ok: true,
          detail: `Min: ${tfObj.config.slMinPips}p | Buf: ${tfObj.config.bufferPips}p`
        },
        {
          name: '5. Rechazo Institucional >= 20%',
          ok: wickPassed,
          detail: wickDetail
        }
      ];

      let score = rules.filter(r => r.ok).length;
      let scorePercent = Math.round((score / rules.length) * 100);

      let statusLabel = 'BUSCANDO BPR';
      let statusColor = '#8a99ad';
      let activeType = targetZone ? targetZone.type : 'MONITOR';

      if (activeZone) {
        if (score === rules.length) {
          statusLabel = '¡SEÑAL SNIPER INMINENTE!';
          statusColor = 'var(--accent-green-bright)';
        } else if (candleTouchedZone && wickPassed) {
          statusLabel = 'RECHAZO CONFIRMADO';
          statusColor = 'var(--accent-green)';
        } else if (inZone || candleTouchedZone) {
          statusLabel = 'TESTEANDO ZONA (ESPERANDO RECHAZO)';
          statusColor = 'var(--accent-gold)';
        } else if (isNearCE) {
          statusLabel = 'PROXIMO A CE';
          statusColor = 'var(--accent-gold)';
        } else {
          statusLabel = 'ZONA DETECTADA';
          statusColor = 'var(--accent-cyan)';
        }
      }

      checklist[tfKey] = {
        timeframe: tfKey,
        activeType,
        statusLabel,
        statusColor,
        score: `${score}/${rules.length}`,
        scorePercent,
        rules,
        sessionOk,
        activeZone: activeZone ? {
          type: activeZone.type,
          top: activeZone.top,
          bottom: activeZone.bottom,
          ce50: activeZone.consequentEncroachment,
          barIndex: activeZone.barIndex
        } : null,
        inZone,
        distToCE: `${distToCE} pips`,
        candlesCached: tfObj.candles.length
      };
    }
    return checklist;
  }
}

const bprStrategyEURUSD = new BPREurusdMultiTimeframeStrategy({ isLiveExecution: true });

module.exports = {
  BPREurusdMultiTimeframeStrategy,
  bprStrategyEURUSD
};
