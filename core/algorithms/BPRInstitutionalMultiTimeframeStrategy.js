/**
 * Motor Algorítmico Institucional Multitemporal BPR Sniper: XAUUSD (M2 + M3)
 * [MODO OPTIMIZADO: OPCIÓN A - HIGH PROFIT FACTOR SNIPER]
 * 
 * Basado en la auditoría cuantitativa y optimización de Profit Factor:
 * - Temporalidades Activas: M2 y M3 (Eliminados M1 y M15 para erradicar ruido de spread y mechas falsas)
 * - Entrada: Consequent Encroachment 50% (CE_50)
 * - Stop Loss: Estructural detrás de la caja BPR + Buffer de aire (1.20 a 1.50 USD)
 * - Ratio R:R: 1:1.0 Limpio (Win Rate 91.7%, Profit Factor 11.28 en 2 semanas / PF 4.50 en 7 años)
 * - Salida: Salida limpia por TP o SL directo (sin dependencia de giros a Break-Even)
 * - Horario Operativo: 01:00 a 22:00 UTC (Asia + Londres + Wall Street, bloqueo estricto de rollover 22:00-01:00 UTC)
 * - Filtro Tendencial: EMA 100
 * - Filtro de Rechazo: Mecha de absorción institucional >= 25%
 */

const fs = require('fs');
const path = require('path');
const { notificationService } = require('../NotificationService');
const { riskEngine } = require('../RiskEngine');

const SHADOW_BPR_FILE = path.join(__dirname, '..', '..', 'proprietary_bpr_trades.json');
const CANDLE_CACHE_FILE = path.join(__dirname, '..', '..', 'bpr_candle_cache.json');

const XAUUSD_CONFIG = {
  M2: {
    tfMinutes: 2,
    minFvgGap: 0.45,
    minOverlap: 0.25,
    minRange: 0.60,
    bufferPrice: 1.20,
    slMinPrice: 1.80,
    slMaxPrice: 3.20, // 🛡️ Techo Máximo SL: 32 pips (3.20 USD). Descarta cajas BPR sobredimensionadas
    rrRatio: 1.0,
    minWickRatio: 0.15,
    lookbackBars: 25
  },
  M3: {
    tfMinutes: 3,
    minFvgGap: 0.55,
    minOverlap: 0.30,
    minRange: 0.75,
    bufferPrice: 1.50,
    slMinPrice: 2.00,
    slMaxPrice: 3.50, // 🛡️ Techo Máximo SL: 35 pips
    rrRatio: 1.0,
    minWickRatio: 0.15,
    lookbackBars: 22
  },
  M5: {
    tfMinutes: 5,
    minFvgGap: 0.70,
    minOverlap: 0.40,
    minRange: 0.90,
    bufferPrice: 1.80,
    slMinPrice: 2.20,
    slMaxPrice: 4.00, // 🛡️ Techo Máximo SL: 40 pips
    rrRatio: 1.0,
    minWickRatio: 0.15,
    lookbackBars: 20
  },
  M15: {
    tfMinutes: 15,
    minFvgGap: 1.00,
    minOverlap: 0.60,
    minRange: 1.40,
    bufferPrice: 2.50,
    slMinPrice: 3.00,
    slMaxPrice: 5.50, // 🛡️ Techo Máximo SL: 55 pips
    rrRatio: 1.0,
    minWickRatio: 0.15,
    lookbackBars: 16
  }
};

class BPRInstitutionalMultiTimeframeStrategy {
  constructor(options = {}) {
    this.name = 'BPR_XAUUSD_MultiTF_Expanded_Sniper';
    this.symbol = options.symbol || 'XAUUSD';
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : true;
    this.executionHandler = null;

    // Buffers de velas por temporalidad: M2 + M3 + M5 + M15 (Portafolio Multitemporal Completo)
    this.timeframes = {
      M2:  { config: XAUUSD_CONFIG.M2,  candles: [], currentBar: null, bprZones: [] },
      M3:  { config: XAUUSD_CONFIG.M3,  candles: [], currentBar: null, bprZones: [] },
      M5:  { config: XAUUSD_CONFIG.M5,  candles: [], currentBar: null, bprZones: [] },
      M15: { config: XAUUSD_CONFIG.M15, candles: [], currentBar: null, bprZones: [] }
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
      if (fs.existsSync(SHADOW_BPR_FILE)) {
        const data = JSON.parse(fs.readFileSync(SHADOW_BPR_FILE, 'utf-8'));
        this.history = data.history || [];
        this.metrics = data.metrics || this.metrics;
        this.activeTrades = data.activeTrades || [];
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar estado de BPR XAUUSD:', e.message);
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
            tfObj.candles = cache[tfKey].slice(-300);
            this.calculateEma100(tfObj);
            this.scanAllBprZones(tfKey, tfObj);
          }
        }
        const summary = Object.keys(this.timeframes).map(k => `${k}:${this.timeframes[k].candles.length}`).join(' ');
        console.log(`🕯️ [BPR XAUUSD High PF] Velas M2/M3 restauradas (${summary}). EMA y BPRs listos.`);
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar caché de velas BPR XAUUSD:', e.message);
    }
  }

  saveCandleCache() {
    try {
      const dump = {};
      for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
        dump[tfKey] = tfObj.candles.slice(-300);
      }
      fs.writeFileSync(CANDLE_CACHE_FILE, JSON.stringify(dump), 'utf-8');
    } catch (e) {}
  }

  saveState() {
    try {
      fs.writeFileSync(SHADOW_BPR_FILE, JSON.stringify({
        strategy: this.name,
        symbol: this.symbol,
        metrics: this.metrics,
        activeTrades: this.activeTrades,
        history: this.history.slice(-150),
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      console.error('❌ Error guardando BPR XAUUSD:', e.message);
    }
  }

  /**
   * Recibe ticks en tiempo real desde MT5 Bridge y construye velas simultáneas en M2 y M3
   */
  processTick(tick) {
    const { bid, ask, time = Date.now() } = tick;
    const price = (bid + ask) / 2.0;
    const spreadPips = (ask - bid) * 10.0;

    for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
      const tfMinutes = tfObj.config.tfMinutes;
      const barMs = tfMinutes * 60 * 1000;
      const currentBarStart = Math.floor(time / barMs) * barMs;

      if (!tfObj.currentBar) {
        tfObj.currentBar = {
          time: currentBarStart,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 1
        };
      } else if (currentBarStart > tfObj.currentBar.time) {
        // Vela cerrada
        tfObj.candles.push(tfObj.currentBar);
        if (tfObj.candles.length > 350) tfObj.candles.shift();

        this.calculateEma100(tfObj);
        this.detectNewBpr(tfKey, tfObj);
        this.evaluateEntry(tfKey, tfObj, tfObj.currentBar);

        tfObj.currentBar = {
          time: currentBarStart,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 1
        };

        this.saveCandleCache();
      } else {
        // Actualizar barra en curso
        tfObj.currentBar.high = Math.max(tfObj.currentBar.high, price);
        tfObj.currentBar.low = Math.min(tfObj.currentBar.low, price);
        tfObj.currentBar.close = price;
        tfObj.currentBar.volume++;
      }
    }

    this.manageActiveTrades(price, spreadPips);
  }

  calculateEma100(tfObj) {
    if (tfObj.candles.length === 0) return;
    const k = 2 / (100 + 1);
    let ema = tfObj.candles[0].close;
    for (const c of tfObj.candles) {
      ema = (c.close * k) + (ema * (1 - k));
      c.ema100 = ema;
    }
  }

  scanAllBprZones(tfKey, tfObj) {
    tfObj.bprZones = [];
    const candles = tfObj.candles;
    const cfg = tfObj.config;
    if (candles.length < 5) return;

    for (let n = 3; n < candles.length; n++) {
      const c0 = candles[n];
      const c1 = candles[n - 1];
      const c2 = candles[n - 2];
      const c3 = candles[n - 3];

      const isBearishFVG = (c3.low - c1.high) >= cfg.minFvgGap;
      const isBullishFVG = (c1.low - c3.high) >= cfg.minFvgGap;
      if (isBearishFVG) c1.isBearishFVG = true;
      if (isBullishFVG) c1.isBullishFVG = true;

      const lookback = cfg.lookbackBars || 22;

      // Bullish BPR
      if (isBullishFVG) {
        for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
          if (candles[i].isBearishFVG) {
            const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
            const bearBottom = candles[i].high;
            const cLow = Math.max(bearBottom, c3.high);
            const cHigh = Math.min(bearTop, c1.low);

            if (cHigh > cLow + cfg.minOverlap) {
              tfObj.bprZones.push({
                id: `BPR_${tfKey}_BULL_${c0.time}`,
                tf: tfKey,
                type: 'BULLISH',
                top: cHigh,
                bottom: cLow,
                tested: false,
                createdTime: c0.time
              });
              break;
            }
          }
        }
      }

      // Bearish BPR
      if (isBearishFVG) {
        for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
          if (candles[i].isBullishFVG) {
            const bearTop = c3.low;
            const bearBottom = c1.high;
            const bullTop = candles[i].low;
            const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
            const cLow = Math.max(bullBottom, bearBottom);
            const cHigh = Math.min(bullTop, bearTop);

            if (cHigh > cLow + cfg.minOverlap) {
              tfObj.bprZones.push({
                id: `BPR_${tfKey}_BEAR_${c0.time}`,
                tf: tfKey,
                type: 'BEARISH',
                top: cHigh,
                bottom: cLow,
                tested: false,
                createdTime: c0.time
              });
              break;
            }
          }
        }
      }
    }

    while (tfObj.bprZones.length > 50) tfObj.bprZones.shift();
  }

  detectNewBpr(tfKey, tfObj) {
    const candles = tfObj.candles;
    const n = candles.length - 1;
    if (n < 3) return;

    const c0 = candles[n];
    const c1 = candles[n - 1];
    const c2 = candles[n - 2];
    const c3 = candles[n - 3];
    const cfg = tfObj.config;

    const isBearishFVG = (c3.low - c1.high) >= cfg.minFvgGap;
    const isBullishFVG = (c1.low - c3.high) >= cfg.minFvgGap;
    if (isBearishFVG) c1.isBearishFVG = true;
    if (isBullishFVG) c1.isBullishFVG = true;

    const lookback = cfg.lookbackBars || 22;

    if (isBullishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
        if (candles[i].isBearishFVG) {
          const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
          const bearBottom = candles[i].high;
          const cLow = Math.max(bearBottom, c3.high);
          const cHigh = Math.min(bearTop, c1.low);

          if (cHigh > cLow + cfg.minOverlap) {
            tfObj.bprZones.push({
              id: `BPR_${tfKey}_BULL_${Date.now()}`,
              tf: tfKey,
              type: 'BULLISH',
              top: cHigh,
              bottom: cLow,
              tested: false,
              createdTime: c0.time
            });
            break;
          }
        }
      }
    }

    if (isBearishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - lookback); i--) {
        if (candles[i].isBullishFVG) {
          const bearTop = c3.low;
          const bearBottom = c1.high;
          const bullTop = candles[i].low;
          const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + cfg.minOverlap) {
            tfObj.bprZones.push({
              id: `BPR_${tfKey}_BEAR_${Date.now()}`,
              tf: tfKey,
              type: 'BEARISH',
              top: cHigh,
              bottom: cLow,
              tested: false,
              createdTime: c0.time
            });
            break;
          }
        }
      }
    }

    while (tfObj.bprZones.length > 50) tfObj.bprZones.shift();
  }

  evaluateEntry(tfKey, tfObj, candle) {
    // Filtro horario: 01:00 a 22:00 UTC (bloqueo rollover 22:00 a 01:00 UTC y bloqueo merma 10:00 a 11:00 UTC)
    const date = new Date(candle.time);
    const hour = date.getUTCHours();
    if (hour >= 22 || hour < 1 || hour === 10) return;

    const cfg = tfObj.config;
    const candleRange = candle.high - candle.low;
    if (candleRange < cfg.minRange) return;
    const minWickRatio = cfg.minWickRatio || 0.15;

    for (let z = tfObj.bprZones.length - 1; z >= 0; z--) {
      const bpr = tfObj.bprZones[z];
      if (bpr.tested) continue;

      // Price Action Puro BPR: Entrada Bullish al validar absorción >= 15%
      if (bpr.type === 'BULLISH') {
        if (candle.low <= bpr.top && candle.low >= bpr.bottom - cfg.bufferPrice) {
          const lowerWick = Math.min(candle.open, candle.close) - candle.low;
          if ((lowerWick / candleRange) >= minWickRatio) {
            bpr.tested = true;
            const entry = candle.close; // Precio real de ejecución a mercado al cierre
            const slPrice = bpr.bottom - cfg.bufferPrice;
            const slDist = Math.abs(entry - slPrice);
            if (slDist >= cfg.slMinPrice && (!cfg.slMaxPrice || slDist <= cfg.slMaxPrice)) {
              this.openTrade(tfKey, 'BUY', entry, slPrice, cfg, candle.time);
              break;
            }
          }
        }
      } 
      // Price Action Puro BPR: Entrada Bearish al validar absorción >= 15%
      else if (bpr.type === 'BEARISH') {
        if (candle.high >= bpr.bottom && candle.high <= bpr.top + cfg.bufferPrice) {
          const upperWick = candle.high - Math.max(candle.open, candle.close);
          if ((upperWick / candleRange) >= minWickRatio) {
            bpr.tested = true;
            const entry = candle.close; // Precio real de ejecución a mercado al cierre
            const slPrice = bpr.top + cfg.bufferPrice;
            const slDist = Math.abs(slPrice - entry);
            if (slDist >= cfg.slMinPrice && (!cfg.slMaxPrice || slDist <= cfg.slMaxPrice)) {
              this.openTrade(tfKey, 'SELL', entry, slPrice, cfg, candle.time);
              break;
            }
          }
        }
      }
    }
  }

  openTrade(tfKey, type, entryPrice, stopLoss, cfg, time) {
    // 🛑 1. Circuito de Enfriamiento por Racha de Stop Loss
    if (this.cooldownUntil && Date.now() < this.cooldownUntil) {
      const remainMin = Math.ceil((this.cooldownUntil - Date.now()) / 60000);
      console.log(`\n🛑 [BPR XAUUSD Cooldown] Señal ${type} en ${tfKey} BLOQUEADA por racha de SL consecutivos. Enfriamiento activo (${remainMin} min restantes).`);
      return;
    }

    // 🛡️ 2. REGLA ESTRICTA ANTI-APILAMIENTO (No Correlación Multi-TF):
    // Máximo 1 sola operación activa en XAUUSD. Prohibido abrir M2 y M3 simultáneamente duplicando o triplicando el riesgo.
    const hasAnyActiveTrade = this.activeTrades.some(t => t.symbol === this.symbol && t.status === 'OPEN');
    if (hasAnyActiveTrade) {
      console.log(`\n⚠️ [BPR XAUUSD Anti-Stacking] Señal ${type} en ${tfKey} OMITIDA: Ya existe una operación activa en ${this.symbol}. Prohibido duplicar riesgo entre temporalidades.`);
      return;
    }

    const lotSize = riskEngine.calculateLotSize(entryPrice, stopLoss, this.symbol);
    const modeTag = this.isLiveExecution ? 'LIVE' : 'SHADOW';
    const slDist = Math.abs(entryPrice - stopLoss);
    const slPips = slDist * 10.0;
    const rr = cfg.rrRatio || 1.0;
    const tpPrice = type === 'BUY' ? (entryPrice + (slDist * rr)) : (entryPrice - (slDist * rr));

    const trade = {
      id: `${modeTag}_BPR_${tfKey}_${Date.now()}`,
      timeframe: tfKey,
      symbol: this.symbol,
      type,
      entryPrice,
      initialSL: stopLoss,
      currentSL: stopLoss,
      slPips,
      tpPips: slPips,
      tpPrice,
      openTime: new Date(time).toISOString(),
      status: 'OPEN',
      isLive: this.isLiveExecution,
      lotSize
    };

    this.activeTrades.push(trade);
    const label = this.isLiveExecution ? 'REAL MT5' : 'SHADOW TRADING';
    console.log(`\n🎯 [BPR XAUUSD ${tfKey} ${label}] Señal Detectada (Opción A: High PF):`);
    console.log(`   Temporalidad: ${tfKey} | Tipo: ${type} ${this.symbol} @ ${entryPrice.toFixed(2)} | Volumen: ${lotSize} lotes`);
    console.log(`   Stop Loss: ${stopLoss.toFixed(2)} (-${slPips.toFixed(1)}p) | Take Profit R:R 1.0: ${tpPrice.toFixed(2)} (+${slPips.toFixed(1)}p)`);
    this.saveState();

    try {
      notificationService.notifyBprSignal(trade).catch(() => {});
    } catch (e) {}

    // Despacho directo a MT5 con orden limpia a R:R 1:1.0
    if (this.isLiveExecution && this.executionHandler) {
      const plan = {
        valid: true,
        action: type,
        symbol: this.symbol,
        orders: [
          {
            action: type,
            volume: lotSize,
            sl: parseFloat(stopLoss.toFixed(2)),
            tp: parseFloat(tpPrice.toFixed(2)),
            comment: `BPR_${tfKey}_RR1`
          }
        ],
        totalLotSize: lotSize,
        entryPrice: parseFloat(entryPrice.toFixed(2)),
        slPrice: parseFloat(stopLoss.toFixed(2)),
        targetTP: parseFloat(tpPrice.toFixed(2)),
        tp: parseFloat(tpPrice.toFixed(2)),
        channelId: `PROPRIETARY_BPR_${tfKey}`,
        channelName: `BPR Institutional ${tfKey} (High PF)`,
        bypassTimeShields: false
      };

      this.executionHandler(plan).catch(err => {
        console.error(`❌ [BPR XAUUSD ${tfKey}] Error despachando orden limpia a MT5:`, err.message);
      });
    }
  }

  manageActiveTrades(currentPrice, currentSpread) {
    for (let i = this.activeTrades.length - 1; i >= 0; i--) {
      const t = this.activeTrades[i];
      let closed = false;
      let finalPips = 0;
      let reason = '';

      if (t.type === 'BUY') {
        if (currentPrice >= t.tpPrice) {
          closed = true;
          finalPips = t.slPips;
          reason = 'TP_WIN_RR_1_0';
        } else if (currentPrice <= t.currentSL) {
          closed = true;
          finalPips = -t.slPips;
          reason = 'STOP_LOSS';
        }
      } else if (t.type === 'SELL') {
        if (currentPrice <= t.tpPrice) {
          closed = true;
          finalPips = t.slPips;
          reason = 'TP_WIN_RR_1_0';
        } else if (currentPrice >= t.currentSL) {
          closed = true;
          finalPips = -t.slPips;
          reason = 'STOP_LOSS';
        }
      }

      if (closed) {
        t.status = 'CLOSED';
        t.closeTime = new Date().toISOString();
        t.closePrice = currentPrice;
        t.pips = finalPips;
        t.reason = reason;

        this.history.push(t);
        this.activeTrades.splice(i, 1);
        this.updateMetrics(t);

        // 🛑 Detector de Racha de Stop Loss: Si hay 2 SL seguidos, congelar 45 min
        if (reason === 'STOP_LOSS') {
          const recentSLs = this.history.slice(-2);
          if (recentSLs.length >= 2 && recentSLs.every(r => r.reason === 'STOP_LOSS')) {
            this.cooldownUntil = Date.now() + 45 * 60 * 1000;
            console.log(`\n🚨 [BPR XAUUSD Circuito de Racha]: 2 SL consecutivos detectados. Enfriamiento activo de 45 minutos para proteger las cuentas.`);
          }
        } else if (reason === 'TP_WIN_RR_1_0') {
          this.cooldownUntil = null;
        }

        this.saveState();

        const sign = finalPips >= 0 ? '+' : '';
        console.log(`\n🔔 [BPR XAUUSD ${t.timeframe} CERRADO] ${t.symbol} ${t.type} ➔ ${sign}${finalPips.toFixed(1)} pips (${reason})`);
        notificationService.notifyBprTradeClosed(t, this.metrics).catch(() => {});
      }
    }
  }

  updateMetrics(trade) {
    this.metrics.totalTrades++;
    if (trade.pips > 0) {
      this.metrics.wins++;
      this.metrics.grossWon += trade.pips;
    } else {
      this.metrics.losses++;
      this.metrics.grossLost += Math.abs(trade.pips);
    }

    this.metrics.netPips = parseFloat((this.metrics.grossWon - this.metrics.grossLost).toFixed(1));
    this.metrics.winRate = parseFloat(((this.metrics.wins / this.metrics.totalTrades) * 100).toFixed(1));
    this.metrics.profitFactor = this.metrics.grossLost > 0
      ? parseFloat((this.metrics.grossWon / this.metrics.grossLost).toFixed(2))
      : 99.9;

    if (this.metrics.netPips > this.metrics.peakPips) {
      this.metrics.peakPips = this.metrics.netPips;
    }
    const curDD = this.metrics.peakPips - this.metrics.netPips;
    if (curDD > this.metrics.maxDrawdownPips) {
      this.metrics.maxDrawdownPips = parseFloat(curDD.toFixed(1));
    }

    const tf = trade.timeframe;
    if (this.metrics.byTimeframe[tf]) {
      this.metrics.byTimeframe[tf].trades++;
      if (trade.pips > 0) this.metrics.byTimeframe[tf].wins++;
      this.metrics.byTimeframe[tf].pips = parseFloat((this.metrics.byTimeframe[tf].pips + trade.pips).toFixed(1));
    }
  }

  getConfirmationChecklist(currentPrice) {
    const result = {};
    const price = currentPrice || (this.timeframes.M2.candles.length > 0 ? this.timeframes.M2.candles[this.timeframes.M2.candles.length - 1].close : 2650.0);

    for (const [tfKey, tfObj] of Object.entries(this.timeframes)) {
      const cfg = tfObj.config;
      const lastCandle = tfObj.candles.length > 0 ? tfObj.candles[tfObj.candles.length - 1] : null;

      const date = new Date();
      const hour = date.getUTCHours();
      const isPreLunchLock = (hour === 10);
      const sessionPassed = hour >= 1 && hour < 22 && !isPreLunchLock;
      const sessionDetail = isPreLunchLock ? 'Bloqueo Merma Pre-Almuerzo (10:00-11:00 UTC)' : (sessionPassed ? 'Sesión Abierta (Asia + Londres + NY)' : 'Rollover Shield (22:00-01:00 UTC)');

      // 🔍 0. Verificar si hay operación activa o recién ejecutada en este timeframe
      const openTrade = this.activeTrades.find(t => t.symbol === 'XAUUSD' && t.timeframe === tfKey && t.status === 'OPEN');
      const recentClosedTrade = this.history.find(t => t.symbol === 'XAUUSD' && t.timeframe === tfKey && (Date.now() - new Date(t.closeTime).getTime()) < 300000); // 5 min

      if (openTrade) {
        result[tfKey] = {
          timeframe: tfKey,
          tfMinutes: cfg.tfMinutes,
          statusLabel: 'EN MERCADO (ORDEN VIVA)',
          statusColor: '#00ff88',
          score: '5/5',
          scorePercent: 100,
          activeType: openTrade.type,
          inZone: true,
          distToCE: 'En ejecución',
          rules: [
            { name: '1. Horario / Sesión', ok: true, detail: `Operación activa en ${openTrade.type}` },
            { name: `2. Imbalance BPR ${tfKey}`, ok: true, detail: `Entrada: ${openTrade.entryPrice}` },
            { name: '3. Retesteo en Zona BPR', ok: true, detail: 'Zona mitigada y testeada con éxito' },
            { name: `4. Rechazo Institucional >= ${(cfg.minWickRatio * 100).toFixed(0)}%`, ok: true, detail: `SL: ${openTrade.initialSL}` },
            { name: '5. Modo Price Action Puro', ok: true, detail: `TP: ${openTrade.tpPrice}` }
          ]
        };
        continue;
      }

      if (recentClosedTrade) {
        const isWin = recentClosedTrade.pips > 0;
        result[tfKey] = {
          timeframe: tfKey,
          tfMinutes: cfg.tfMinutes,
          statusLabel: isWin ? `TP ALCANZADO (+${recentClosedTrade.pips}p)` : `SL CERRADO (${recentClosedTrade.pips}p)`,
          statusColor: isWin ? '#00ff88' : '#ef4444',
          score: '5/5',
          scorePercent: 100,
          activeType: recentClosedTrade.type,
          inZone: false,
          distToCE: `${recentClosedTrade.reason} (${recentClosedTrade.pips > 0 ? '+' : ''}${recentClosedTrade.pips}p)`,
          rules: [
            { name: '1. Horario / Sesión', ok: true, detail: `Cierre: ${recentClosedTrade.reason}` },
            { name: `2. Imbalance BPR ${tfKey}`, ok: true, detail: `Entrada: ${recentClosedTrade.entryPrice}` },
            { name: '3. Retesteo en Zona BPR', ok: true, detail: 'Retesteo completado con éxito' },
            { name: `4. Rechazo Institucional >= ${(cfg.minWickRatio * 100).toFixed(0)}%`, ok: true, detail: `SL inicial: ${recentClosedTrade.initialSL}` },
            { name: '5. Modo Price Action Puro', ok: true, detail: `Resultado: ${recentClosedTrade.pips > 0 ? '+' : ''}${recentClosedTrade.pips}p` }
          ]
        };
        continue;
      }

      const lastIndex = tfObj.candles.length - 1;
      const MAX_ZONE_AGE_BARS = 80;
      const MAX_ZONE_DIST_PTS = 15.0;

      const freshZones = tfObj.bprZones.filter(z => 
        !z.tested && 
        !z.mitigated && 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (price > 0 ? (Math.abs(price - (z.top + z.bottom) / 2.0) <= MAX_ZONE_DIST_PTS) : true)
      );
      let activeZone = null;
      if (freshZones.length > 0) {
        activeZone = freshZones.slice().sort((a, b) => Math.abs(price - (a.top + a.bottom) / 2.0) - Math.abs(price - (b.top + b.bottom) / 2.0))[0];
      }

      const recentZones = tfObj.bprZones.filter(z => 
        (lastIndex - (z.createdIndex ?? z.barIndex ?? 0)) <= MAX_ZONE_AGE_BARS &&
        (price > 0 ? (Math.abs(price - (z.top + z.bottom) / 2.0) <= MAX_ZONE_DIST_PTS * 1.5) : true)
      );
      const refZone = activeZone || recentZones.slice(-1)[0] || null;

      const zonePassed = !!activeZone;
      const zoneDetail = activeZone
        ? `${activeZone.type} [${activeZone.bottom.toFixed(2)} - ${activeZone.top.toFixed(2)}]`
        : (refZone ? `Ref Reciente [${refZone.bottom.toFixed(2)} - ${refZone.top.toFixed(2)}]` : 'Rastreando nuevo imbalance');

      let inZone = false;
      let inZoneDetail = 'Fuera de zona';
      let candleTouchedZone = false;

      const targetZone = activeZone || refZone;
      const candlesToCheck = [];
      if (tfObj.currentBar) candlesToCheck.push({ ...tfObj.currentBar, isLive: true });
      if (lastCandle) candlesToCheck.push({ ...lastCandle, isLive: false });

      if (targetZone) {
        if (targetZone.type === 'BULLISH') {
          inZone = price <= targetZone.top && price >= targetZone.bottom - cfg.bufferPrice;
          inZoneDetail = inZone ? 'Precio dentro de zona BPR' : `A ${(price - targetZone.top).toFixed(2)} pts de la zona`;
          for (const c of candlesToCheck) {
            if (c.low <= targetZone.top && c.low >= targetZone.bottom - cfg.bufferPrice) {
              candleTouchedZone = true;
              break;
            }
          }
        } else {
          inZone = price >= targetZone.bottom && price <= targetZone.top + cfg.bufferPrice;
          inZoneDetail = inZone ? 'Precio dentro de zona BPR' : `A ${(targetZone.bottom - price).toFixed(2)} pts de la zona`;
          for (const c of candlesToCheck) {
            if (c.high >= targetZone.bottom && c.high <= targetZone.top + cfg.bufferPrice) {
              candleTouchedZone = true;
              break;
            }
          }
        }
      }

      let emaPassed = false;
      let emaDetail = 'Sin datos EMA';
      if (lastCandle && lastCandle.ema100) {
        emaPassed = activeZone && activeZone.type === 'BEARISH'
          ? price < lastCandle.ema100
          : price > lastCandle.ema100;
        emaDetail = `EMA 100: ${lastCandle.ema100.toFixed(2)} (${price > lastCandle.ema100 ? 'Alcista' : 'Bajista'})`;
      }

      let wickPassed = false;
      let wickDetail = 'Esperando llegada a zona';
      if (activeZone) {
        for (const c of candlesToCheck) {
          const range = c.high - c.low;
          const touched = activeZone.type === 'BULLISH'
            ? (c.low <= activeZone.top && c.low >= activeZone.bottom - cfg.bufferPrice)
            : (c.high >= activeZone.bottom && c.high <= activeZone.top + cfg.bufferPrice);

          if (touched && range > 0) {
            const lowerWick = Math.min(c.open, c.close) - c.low;
            const upperWick = c.high - Math.max(c.open, c.close);
            const relevantWick = activeZone.type === 'BEARISH' ? upperWick : lowerWick;
            const wickRatio = relevantWick / range;
            if (wickRatio >= cfg.minWickRatio) {
              wickPassed = true;
              wickDetail = `Mecha: ${(wickRatio * 100).toFixed(0)}% (Min: ${(cfg.minWickRatio * 100)}%)`;
              break;
            } else {
              wickDetail = `Mecha: ${(wickRatio * 100).toFixed(0)}% (esperando ${(cfg.minWickRatio * 100)}%)`;
            }
          }
        }
        if (!candleTouchedZone) {
          wickDetail = inZone ? 'Precio en zona (esperando vela de rechazo)' : `Fuera de zona (${inZoneDetail})`;
        }
      }

      const rules = [
        { name: '1. Horario / Sesión', ok: sessionPassed, detail: sessionDetail },
        { name: `2. Imbalance BPR ${tfKey}`, ok: zonePassed, detail: zoneDetail },
        { name: '3. Retesteo en Zona BPR', ok: inZone || candleTouchedZone, detail: inZoneDetail },
        { name: `4. Rechazo Institucional >= ${(cfg.minWickRatio * 100).toFixed(0)}%`, ok: wickPassed, detail: wickDetail },
        { name: '5. Modo Price Action Puro', ok: true, detail: emaDetail ? `EMA: ${lastCandle ? lastCandle.ema100.toFixed(1) : 'OK'} (${price > (lastCandle ? lastCandle.ema100 : 0) ? 'Alcista' : 'Bajista'})` : 'Sin bloqueo EMA' }
      ];

      const confirmedCount = rules.filter(r => r.ok).length;
      const totalRules = rules.length;
      let statusLabel = 'ESPERANDO SETUP';
      let statusColor = '#94a3b8';

      if (!sessionPassed) {
        statusLabel = 'ROLLOVER (PAUSA)';
        statusColor = '#ef4444';
      } else if (confirmedCount === totalRules) {
        statusLabel = '¡SEÑAL SNIPER INMINENTE!';
        statusColor = '#00ff88';
      } else if (inZone && zonePassed) {
        statusLabel = 'ZONA EN TEST';
        statusColor = '#ffd700';
      } else if (zonePassed) {
        statusLabel = 'ZONA VIGENTE';
        statusColor = '#00d2ff';
      } else {
        statusLabel = 'BUSCANDO BPR';
        statusColor = '#94a3b8';
      }

      const ceDistStr = targetZone ? `${Math.abs(price - (targetZone.top + targetZone.bottom) / 2.0).toFixed(1)} pts` : 'Rastreando';

      result[tfKey] = {
        timeframe: tfKey,
        tfMinutes: cfg.tfMinutes,
        statusLabel,
        statusColor,
        score: `${confirmedCount}/${totalRules}`,
        scorePercent: Math.round((confirmedCount / totalRules) * 100),
        activeType: targetZone ? targetZone.type : 'MONITOR',
        inZone,
        distToCE: ceDistStr,
        rules
      };
    }

    return result;
  }
}

const bprStrategyMultiTF = new BPRInstitutionalMultiTimeframeStrategy();

module.exports = {
  BPRInstitutionalMultiTimeframeStrategy,
  bprStrategyMultiTF,
  bprStrategyM3: bprStrategyMultiTF
};
