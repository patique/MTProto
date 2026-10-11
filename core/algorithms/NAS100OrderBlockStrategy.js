/**
 * NAS100 Institutional Order Block Mitigation Strategy (M5 + H1 EMA 50)
 * 
 * Estrategia cuantitativa validada para NAS100 (US100 / USTEC):
 * - Tendencia Macro: H1 Cierre frente a EMA 50.
 * - Patrón: Desplazamiento impulsivo (Cuerpo >= 1.78 ATR).
 * - Zona: 50% Mean Threshold del Order Block (última vela contraria previa).
 * - SL: Detrás del Order Block + 0.18 ATR buffer.
 * - TP: Ratio 1:5.4 (+5.4% por cada operación ganada al 1% de riesgo).
 */

const fs = require('fs');
const path = require('path');
const { riskEngine } = require('../RiskEngine');
const { notificationService } = require('../NotificationService');

const STATE_FILE = path.join(__dirname, '..', '..', 'nas100_ob_strategy_state.json');

class NAS100OrderBlockStrategy {
  constructor(options = {}) {
    this.name = 'NAS100_OB_Sniper';
    this.symbol = options.symbol || 'NAS100';
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : false;
    this.rrRatio = options.rrRatio || 5.4;
    this.maxActiveTrades = options.maxActiveTrades || 1;
    this.executionHandler = null;

    // Configuración técnica
    this.dispAtrMult = 1.78;
    this.atrBufferMult = 0.18;
    this.emaHtfPeriod = 50;

    // Buffers de velas en memoria
    this.m5Candles = [];
    this.h1Candles = [];
    this.h1EmaHistory = [];
    this.activeZones = [];
    this.activeTrades = [];
    this.pendingTrades = [];
    this.history = [];

    this.loadState();
    this.loadCandleCache();
  }

  loadCandleCache() {
    try {
      const cachePath = path.join(__dirname, '..', '..', 'bpr_nas100_candle_cache.json');
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.M5 && Array.isArray(data.M5)) {
          this.m5Candles = data.M5.slice(-200);
        }
        if (data.M15 && Array.isArray(data.M15)) {
          this.h1Candles = this.buildH1FromM15(data.M15);
          this.h1EmaHistory = this.calculateEMA(this.h1Candles, this.emaHtfPeriod);
        }
        this.scanForNewOrderBlocks();
        console.log(`💎 [NAS100 OB] Cache de velas cargado: ${this.m5Candles.length} M5 y ${this.h1Candles.length} H1.`);
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar candle cache para NAS100 OB:', e.message);
    }
  }

  buildH1FromM15(m15Candles) {
    const grouped = new Map();
    for (const c of m15Candles) {
      const h1Start = Math.floor(c.time / (3600 * 1000)) * (3600 * 1000);
      if (!grouped.has(h1Start)) {
        grouped.set(h1Start, { time: h1Start, open: c.open, high: c.high, low: c.low, close: c.close });
      } else {
        const bar = grouped.get(h1Start);
        bar.high = Math.max(bar.high, c.high);
        bar.low = Math.min(bar.low, c.low);
        bar.close = c.close;
      }
    }
    return Array.from(grouped.values()).sort((a, b) => a.time - b.time);
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
      console.warn('⚠️ No se pudo cargar estado de NAS100 OB Strategy:', e.message);
    }
  }

  saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        symbol: this.symbol,
        activeZones: this.activeZones.slice(-20),
        activeTrades: this.activeTrades,
        pendingTrades: this.pendingTrades,
        history: this.history.slice(-100),
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (e) {
      console.warn('⚠️ Error guardando estado de NAS100 OB Strategy:', e.message);
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

  calculateEMA(candles, period = 50) {
    if (candles.length < period) return [];
    const k = 2 / (period + 1);
    let emaArray = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += candles[i].close;
    let prevEma = sum / period;
    emaArray.push(prevEma);

    for (let i = period; i < candles.length; i++) {
      prevEma = (candles[i].close * k) + (prevEma * (1 - k));
      emaArray.push(prevEma);
    }
    return emaArray;
  }

  processTick(tick) {
    if (!tick || !tick.bid || !tick.ask) return null;
    if (tick.symbol) {
      const sym = String(tick.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const valid = ['NAS100', 'NAS100CASH', 'US100', 'USTEC', 'NDX'];
      if (!valid.some(v => sym.includes(v))) return null;
    }

    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    const now = Date.now();
    const price = (bid + ask) / 2;

    const barMs = 5 * 60 * 1000;
    const barStart = Math.floor(now / barMs) * barMs;

    if (!this.currentBar) {
      this.currentBar = { time: barStart, open: price, high: price, low: price, close: price, volume: 1 };
    } else if (barStart > this.currentBar.time) {
      this.m5Candles.push(this.currentBar);
      if (this.m5Candles.length > 250) this.m5Candles.shift();

      const h1Start = Math.floor(now / (3600 * 1000)) * (3600 * 1000);
      const lastH1 = this.h1Candles[this.h1Candles.length - 1];
      if (!lastH1 || h1Start > lastH1.time) {
        this.h1Candles.push({ time: h1Start, open: price, high: price, low: price, close: price });
        if (this.h1Candles.length > 100) this.h1Candles.shift();
        this.h1EmaHistory = this.calculateEMA(this.h1Candles, this.emaHtfPeriod);
      } else {
        lastH1.high = Math.max(lastH1.high, price);
        lastH1.low = Math.min(lastH1.low, price);
        lastH1.close = price;
      }

      this.scanForNewOrderBlocks();
      this.currentBar = { time: barStart, open: price, high: price, low: price, close: price, volume: 1 };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, price);
      this.currentBar.low = Math.min(this.currentBar.low, price);
      this.currentBar.close = price;
      this.currentBar.volume++;
    }

    // 1. Limpieza de órdenes pendientes caducadas
    this.pendingTrades = this.pendingTrades.filter(t => !t.expiresAt || t.expiresAt > now);

    // 2. Procesar retest / mitigación en zonas activas
    this.evaluateZoneMitigation(bid, ask);

    return null;
  }

  updateCandles(m5Array, h1Array) {
    if (Array.isArray(m5Array) && m5Array.length > 0) this.m5Candles = m5Array;
    if (Array.isArray(h1Array) && h1Array.length > 0) {
      this.h1Candles = h1Array;
      this.h1EmaHistory = this.calculateEMA(this.h1Candles, this.emaHtfPeriod);
    }
    this.scanForNewOrderBlocks();
  }

  scanForNewOrderBlocks() {
    if (this.m5Candles.length < 5 || this.h1Candles.length < 55) return;

    const atr = this.calculateATR(this.m5Candles, 14);
    if (atr <= 0) return;

    const lastH1 = this.h1Candles[this.h1Candles.length - 1];
    const lastH1Ema = this.h1EmaHistory[this.h1EmaHistory.length - 1];

    const htfBullish = lastH1.close > lastH1Ema;
    const htfBearish = lastH1.close < lastH1Ema;

    const candle1 = this.m5Candles[this.m5Candles.length - 1]; // Vela recién cerrada
    const candle2 = this.m5Candles[this.m5Candles.length - 2]; // Vela de Order Block
    const body1 = Math.abs(candle1.close - candle1.open);
    const minDisp = this.dispAtrMult * atr;

    // Detectar Order Block Alcista
    if (htfBullish && candle1.close > candle1.open && body1 >= minDisp && candle2.close < candle2.open) {
      const meanThreshold = (candle2.high + candle2.low) * 0.5;
      const slPrice = candle2.low - (this.atrBufferMult * atr);

      const exists = this.activeZones.some(z => z.active && Math.abs(z.meanThreshold - meanThreshold) < 1.0);
      if (!exists) {
        const zone = {
          id: `NAS_OB_BUY_${Date.now()}`,
          type: 'BUY',
          high: candle2.high,
          low: candle2.low,
          meanThreshold,
          slPrice,
          active: true,
          createdAt: new Date().toISOString()
        };
        this.activeZones.push(zone);
        console.log(`🟢 [NAS100 OB ALCISTA] 50% MT: ${meanThreshold.toFixed(2)} | SL: ${slPrice.toFixed(2)}`);
        this.saveState();
      }
    }

    // Detectar Order Block Bajista
    if (htfBearish && candle1.close < candle1.open && body1 >= minDisp && candle2.close > candle2.open) {
      const meanThreshold = (candle2.high + candle2.low) * 0.5;
      const slPrice = candle2.high + (this.atrBufferMult * atr);

      const exists = this.activeZones.some(z => z.active && Math.abs(z.meanThreshold - meanThreshold) < 1.0);
      if (!exists) {
        const zone = {
          id: `NAS_OB_SELL_${Date.now()}`,
          type: 'SELL',
          high: candle2.high,
          low: candle2.low,
          meanThreshold,
          slPrice,
          active: true,
          createdAt: new Date().toISOString()
        };
        this.activeZones.push(zone);
        console.log(`🔴 [NAS100 OB BAJISTA] 50% MT: ${meanThreshold.toFixed(2)} | SL: ${slPrice.toFixed(2)}`);
        this.saveState();
      }
    }
  }

  evaluateZoneMitigation(bid, ask) {
    const openTrades = this.activeTrades.filter(t => t.status === 'OPEN');
    const pendingTrades = this.pendingTrades.filter(t => t.status === 'PENDING');
    if (openTrades.length + pendingTrades.length >= this.maxActiveTrades) return;

    for (const zone of this.activeZones) {
      if (!zone.active) continue;

      // Check Buy Mitigation
      if (zone.type === 'BUY') {
        if (bid < zone.low) {
          zone.active = false; // Roto antes de mitigar
          continue;
        }
        if (bid <= zone.meanThreshold && bid >= zone.low) {
          zone.active = false;
          this.triggerTrade('BUY', ask, zone.slPrice, zone.meanThreshold);
          break;
        }
      }

      // Check Sell Mitigation
      if (zone.type === 'SELL') {
        if (ask > zone.high) {
          zone.active = false; // Roto antes de mitigar
          continue;
        }
        if (ask >= zone.meanThreshold && ask <= zone.high) {
          zone.active = false;
          this.triggerTrade('SELL', bid, zone.slPrice, zone.meanThreshold);
          break;
        }
      }
    }
  }

  triggerTrade(type, entryPrice, stopLoss, mtLevel) {
    const riskDist = Math.abs(entryPrice - stopLoss);
    if (riskDist <= 0) return;

    const tpPrice = type === 'BUY' ? entryPrice + (riskDist * this.rrRatio) : entryPrice - (riskDist * this.rrRatio);
    const lotSize = riskEngine.calculateLotSize(entryPrice, stopLoss, this.symbol);

    const trade = {
      id: `NAS100_OB_${Date.now()}`,
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

    console.log(`\n🎯 [NAS100 OB SNIPER] Disparo de Orden ${type} en 50% MT: ${mtLevel.toFixed(2)}`);
    console.log(`   Entrada: ${entryPrice.toFixed(2)} | SL: ${stopLoss.toFixed(2)} | TP (1:${this.rrRatio}): ${tpPrice.toFixed(2)} | Lotes: ${lotSize}`);

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
        channelId: 'PROPRIETARY_NAS100_OB',
        channelName: 'NAS100 Order Block Sniper'
      };

      try {
        this.executionHandler(plan);
        notificationService.sendTradeAlert(plan, `🎯 NAS100 OB Sniper Mitigación (R:R 1:${this.rrRatio})`);
      } catch (e) {
        console.error('❌ Error enviando orden a puente MT5:', e.message);
      }
    }
  }
}

module.exports = {
  NAS100OrderBlockStrategy,
  nas100OrderBlockStrategy: new NAS100OrderBlockStrategy({ isLiveExecution: false })
};
