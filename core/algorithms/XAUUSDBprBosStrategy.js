/**
 * XAUUSD Institutional BOS + Real BPR Retest Strategy (M5/M3)
 * 
 * Estrategia cuantitativa validada para XAUUSD (Oro):
 * - Estructura: Rotura de Swing High / Low (BOS / CHoCH).
 * - Zona: Solape entre FVG Alcista y FVG Bajista (BPR Real >= 0.20 ATR).
 * - SL Estructural: Tras el Swing Origin Pivot que originó el BOS + 0.25 ATR buffer.
 * - TP: Ratio 1:4.0 (+4.0% por cada operación ganada al 1% de riesgo).
 */

const fs = require('fs');
const path = require('path');
const { riskEngine } = require('../RiskEngine');
const { notificationService } = require('../NotificationService');

const STATE_FILE = path.join(__dirname, '..', '..', 'xauusd_bpr_bos_strategy_state.json');

class XAUUSDBprBosStrategy {
  constructor(options = {}) {
    this.name = 'XAUUSD_BPR_BOS_Sniper';
    this.symbol = options.symbol || 'XAUUSD';
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : false;
    this.rrRatio = options.rrRatio || 4.0;
    this.maxActiveTrades = options.maxActiveTrades || 1;
    this.pivotLookback = options.pivotLookback || 5;
    this.executionHandler = null;

    this.minFvgAtr = 0.25;
    this.minOverlapAtr = 0.20;
    this.atrBufferMult = 0.25;

    this.candles = [];
    this.currentBosState = 'NONE'; // 'BULLISH', 'BEARISH'
    this.lastSwingHigh = null;
    this.lastSwingLow = null;
    this.activeZones = [];
    this.activeTrades = [];
    this.pendingTrades = [];
    this.history = [];

    this.loadState();
    this.loadCandleCache();
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        this.activeZones = data.activeZones || [];
        this.activeTrades = data.activeTrades || [];
        this.pendingTrades = data.pendingTrades || [];
        this.history = data.history || [];
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar estado de XAUUSD BPR BOS Strategy:', e.message);
    }
  }

  saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        symbol: this.symbol,
        currentBosState: this.currentBosState,
        activeZones: this.activeZones.slice(-20),
        activeTrades: this.activeTrades,
        pendingTrades: this.pendingTrades,
        history: this.history.slice(-100),
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      console.warn('⚠️ Error guardando estado de XAUUSD BPR BOS Strategy:', e.message);
    }
  }

  setExecutionHandler(handler) {
    this.executionHandler = handler;
  }

  setLiveExecution(isLive) {
    this.isLiveExecution = !!isLive;
  }

  calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let trSum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    return trSum / period;
  }

  loadCandleCache() {
    try {
      const cachePath = path.join(__dirname, '..', '..', 'bpr_candle_cache.json');
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.M5 && Array.isArray(data.M5)) {
          this.candles = data.M5.slice(-200);
          this.scanStructureAndBPR();
          console.log(`💎 [XAUUSD BPR BOS] Cache de velas cargado: ${this.candles.length} velas M5.`);
        }
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar candle cache para XAUUSD BOS:', e.message);
    }
  }

  processTick(tick) {
    if (!tick || !tick.bid || !tick.ask) return null;

    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    const now = Date.now();
    const price = (bid + ask) / 2;

    const barMs = 5 * 60 * 1000;
    const barStart = Math.floor(now / barMs) * barMs;

    if (!this.currentBar) {
      this.currentBar = { time: barStart, open: price, high: price, low: price, close: price, volume: 1 };
    } else if (barStart > this.currentBar.time) {
      this.candles.push(this.currentBar);
      if (this.candles.length > 250) this.candles.shift();
      this.scanStructureAndBPR();
      this.currentBar = { time: barStart, open: price, high: price, low: price, close: price, volume: 1 };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, price);
      this.currentBar.low = Math.min(this.currentBar.low, price);
      this.currentBar.close = price;
      this.currentBar.volume++;
    }

    this.pendingTrades = this.pendingTrades.filter(t => !t.expiresAt || t.expiresAt > now);
    this.evaluateRetestExecution(bid, ask);

    return null;
  }

  updateCandles(candlesArray) {
    if (!Array.isArray(candlesArray) || candlesArray.length < 20) return;
    this.candles = candlesArray;
    this.scanStructureAndBPR();
  }

  scanStructureAndBPR() {
    const k = this.pivotLookback;
    const candles = this.candles;
    const n = candles.length;
    if (n < k * 4 + 10) return;

    const atr = this.calculateATR(candles, 14);
    if (atr <= 0) return;

    // 1. Identificar Swings
    for (let i = k + 1; i <= n - k - 1; i++) {
      let isHigh = true;
      let isLow = true;

      for (let j = 1; j <= k; j++) {
        if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
        if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
      }

      if (isHigh) {
        this.lastSwingHigh = { price: candles[i].high, time: candles[i].time, barIndex: i };
      }
      if (isLow) {
        this.lastSwingLow = { price: candles[i].low, time: candles[i].time, barIndex: i };
      }
    }

    // 2. Evaluar BOS
    const lastBar = candles[n - 1];
    const prevBar = candles[n - 2];

    if (this.lastSwingHigh && lastBar.close > this.lastSwingHigh.price && prevBar.close <= this.lastSwingHigh.price) {
      this.currentBosState = 'BULLISH';
      console.log(`⚡ [XAUUSD BULLISH BOS] Ruptura de Swing High: ${this.lastSwingHigh.price.toFixed(2)} | Origin Low: ${this.lastSwingLow?.price.toFixed(2)}`);
    } else if (this.lastSwingLow && lastBar.close < this.lastSwingLow.price && prevBar.close >= this.lastSwingLow.price) {
      this.currentBosState = 'BEARISH';
      console.log(`⚡ [XAUUSD BEARISH BOS] Ruptura de Swing Low: ${this.lastSwingLow.price.toFixed(2)} | Origin High: ${this.lastSwingHigh?.price.toFixed(2)}`);
    }

    // 3. Solape FVG para BPR Real
    const fvgBull = [];
    const fvgBear = [];
    const scanLimit = Math.min(30, n - 3);

    for (let i = n - 2; i >= n - scanLimit; i--) {
      // Bull FVG: Low[i] > High[i-2]
      if (candles[i].low > candles[i - 2].high) {
        const gap = candles[i].low - candles[i - 2].high;
        if (gap >= this.minFvgAtr * atr) {
          fvgBull.push({ top: candles[i].low, bottom: candles[i - 2].high });
        }
      }
      // Bear FVG: High[i] < Low[i-2]
      if (candles[i].high < candles[i - 2].low) {
        const gap = candles[i - 2].low - candles[i].high;
        if (gap >= this.minFvgAtr * atr) {
          fvgBear.push({ top: candles[i - 2].low, bottom: candles[i].high });
        }
      }
    }

    // Cruzar FVGs para BPR Real
    for (const b of fvgBull) {
      for (const s of fvgBear) {
        const overlapTop = Math.min(b.top, s.top);
        const overlapBottom = Math.max(b.bottom, s.bottom);

        if (overlapTop > overlapBottom && (overlapTop - overlapBottom) >= this.minOverlapAtr * atr) {
          if (this.currentBosState === 'BULLISH' && this.lastSwingLow) {
            const slPrice = this.lastSwingLow.price - (this.atrBufferMult * atr);
            const exists = this.activeZones.some(z => z.active && Math.abs(z.top - overlapTop) < 0.2);

            if (!exists) {
              const zone = {
                id: `XAU_BPR_BUY_${Date.now()}`,
                type: 'BUY',
                top: overlapTop,
                bottom: overlapBottom,
                swingOrigin: this.lastSwingLow.price,
                slPrice,
                active: true,
                createdAt: new Date().toISOString()
              };
              this.activeZones.push(zone);
              console.log(`💎 [XAUUSD BPR REAL ALCISTA] Zona: ${overlapBottom.toFixed(2)} - ${overlapTop.toFixed(2)} | SL Estructural: ${slPrice.toFixed(2)}`);
              this.saveState();
            }
          } else if (this.currentBosState === 'BEARISH' && this.lastSwingHigh) {
            const slPrice = this.lastSwingHigh.price + (this.atrBufferMult * atr);
            const exists = this.activeZones.some(z => z.active && Math.abs(z.bottom - overlapBottom) < 0.2);

            if (!exists) {
              const zone = {
                id: `XAU_BPR_SELL_${Date.now()}`,
                type: 'SELL',
                top: overlapTop,
                bottom: overlapBottom,
                swingOrigin: this.lastSwingHigh.price,
                slPrice,
                active: true,
                createdAt: new Date().toISOString()
              };
              this.activeZones.push(zone);
              console.log(`💎 [XAUUSD BPR REAL BAJISTA] Zona: ${overlapBottom.toFixed(2)} - ${overlapTop.toFixed(2)} | SL Estructural: ${slPrice.toFixed(2)}`);
              this.saveState();
            }
          }
        }
      }
    }
  }

  evaluateRetestExecution(bid, ask) {
    const openTrades = this.activeTrades.filter(t => t.status === 'OPEN');
    const pendingTrades = this.pendingTrades.filter(t => t.status === 'PENDING');
    if (openTrades.length + pendingTrades.length >= this.maxActiveTrades) return;

    for (const zone of this.activeZones) {
      if (!zone.active) continue;

      if (zone.type === 'BUY') {
        if (bid < zone.swingOrigin) {
          zone.active = false; // Roto antes del retest
          continue;
        }
        if (bid <= zone.top && bid >= zone.bottom) {
          zone.active = false;
          this.triggerTrade('BUY', ask, zone.slPrice, zone.top, zone.bottom);
          break;
        }
      } else if (zone.type === 'SELL') {
        if (ask > zone.swingOrigin) {
          zone.active = false; // Roto antes del retest
          continue;
        }
        if (ask >= zone.bottom && ask <= zone.top) {
          zone.active = false;
          this.triggerTrade('SELL', bid, zone.slPrice, zone.top, zone.bottom);
          break;
        }
      }
    }
  }

  triggerTrade(type, entryPrice, stopLoss, zTop, zBottom) {
    const riskDist = Math.abs(entryPrice - stopLoss);
    if (riskDist <= 0) return;

    const tpPrice = type === 'BUY' ? entryPrice + (riskDist * this.rrRatio) : entryPrice - (riskDist * this.rrRatio);
    const lotSize = riskEngine.calculateLotSize(entryPrice, stopLoss, this.symbol);

    const trade = {
      id: `XAU_BPR_BOS_${Date.now()}`,
      symbol: this.symbol,
      type,
      entryPrice,
      stopLoss,
      takeProfit: tpPrice,
      rrRatio: this.rrRatio,
      lotSize,
      status: this.isLiveExecution ? 'PENDING' : 'OPEN',
      openTime: new Date().toISOString()
    };

    if (this.isLiveExecution) {
      this.pendingTrades.push(trade);
    } else {
      this.activeTrades.push(trade);
    }
    this.saveState();

    console.log(`\n🚀 [XAUUSD BPR RETEST] Retest Exitoso en BPR (${zBottom.toFixed(2)} - ${zTop.toFixed(2)})`);
    console.log(`   Entrada: ${entryPrice.toFixed(2)} | SL Estructural: ${stopLoss.toFixed(2)} | TP (1:${this.rrRatio}): ${tpPrice.toFixed(2)} | Lotes: ${lotSize}`);

    if (this.isLiveExecution && this.executionHandler) {
      const plan = {
        valid: true,
        action: type,
        symbol: this.symbol,
        orders: [
          {
            action: type,
            entryPrice: parseFloat(entryPrice.toFixed(2)),
            volume: lotSize,
            sl: parseFloat(stopLoss.toFixed(2)),
            tp: parseFloat(tpPrice.toFixed(2))
          }
        ],
        totalLotSize: lotSize,
        entryPrice: parseFloat(entryPrice.toFixed(2)),
        slPrice: parseFloat(stopLoss.toFixed(2)),
        targetTP: parseFloat(tpPrice.toFixed(2)),
        channelId: 'PROPRIETARY_XAUUSD_BPR_BOS',
        channelName: 'XAUUSD BPR BOS Retest Sniper'
      };

      try {
        this.executionHandler(plan);
        notificationService.sendTradeAlert(plan, `🚀 XAUUSD BPR BOS Retest (R:R 1:${this.rrRatio})`);
      } catch (e) {
        console.error('❌ Error enviando orden a puente MT5:', e.message);
      }
    }
  }
}

module.exports = {
  XAUUSDBprBosStrategy,
  xauusdBprBosStrategy: new XAUUSDBprBosStrategy({ isLiveExecution: false })
};
