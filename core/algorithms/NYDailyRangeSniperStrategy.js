/**
 * Motor Algorítmico Institucional: NY Daily Range Sniper (XAUUSD / NAS100)
 * 
 * Estrategia de Apertura de Nueva York en M15 & Reversión de Liquidez (PDH / PDL)
 * Integrada en el pipeline en tiempo real de Node.js (ProprietaryStrategyManager).
 * 
 * Reglas Operativas:
 * 1. NIVELES D1: Cálculo y seguimiento continuo de PDH (Previous Day High) y PDL (Previous Day Low).
 * 2. TIRO 1 (APERTURA NY - EXPANSIÓN M15):
 *    - Horario: 15:30 Server para XAUUSD / 16:30 Server para NAS100 (Wall Street Bell).
 *    - Primera vela M15 cerrada define el sesgo: Alcista -> BUY | Bajista -> SELL.
 *    - Retesteo: Espera retroceso al Consequent Encroachment 50% (CE 50%) de la 1ª vela M15.
 *    - Entrada a mercado al detectar toque y rechazo.
 *    - Stop Loss calibrado: 30 pips en Oro / 30 pts en Nasdaq.
 *    - Take Profit: Ratio R:R 1:2.0 asimétrico.
 * 3. TIRO 2 (REVERSIÓN TRAS BARRIDO DE PDH / PDL):
 *    - Purga de liquidez (Sweep de PDH o PDL).
 *    - Rechazo / Cierre de vuelta por dentro del rango + BOS + Fair Value Gap (FVG).
 *    - Entrada al retesteo del FVG con R:R 1:2.0 hacia el centro del rango diario.
 */

const fs = require('fs');
const path = require('path');
const { riskEngine } = require('../RiskEngine');
const { notificationService } = require('../NotificationService');

const ASSET_CONFIGS = {
  XAUUSD: {
    symbol: 'XAUUSD',
    aliases: ['XAUUSD', 'XAUUSD-VIP', 'GOLD'],
    pipMultiplier: 10.0,
    openHour: 15,
    openMinute: 30,
    slPips: 30.0,
    tpRR: 2.0,
    sweepBufferPips: 5.0,
    maxSlPips: 55.0,
    minSlPips: 15.0
  },
  NAS100: {
    symbol: 'NAS100',
    aliases: ['NAS100', 'NAS100-VIP', 'US100', 'USTEC', 'NDX'],
    pipMultiplier: 1.0,
    openHour: 16,
    openMinute: 30,
    slPips: 30.0,
    tpRR: 2.0,
    sweepBufferPips: 8.0,
    maxSlPips: 80.0,
    minSlPips: 15.0
  }
};

class NYDailyRangeSniperStrategy {
  constructor(symbol = 'XAUUSD') {
    this.symbol = symbol;
    this.cfg = ASSET_CONFIGS[symbol] || ASSET_CONFIGS.XAUUSD;
    this.name = `NY Daily Range Sniper ${this.symbol}`;

    this.isLiveExecution = true;
    this.executionHandler = null;

    // Estado diario
    this.currentDayStr = '';
    this.pdh = 0.0;
    this.pdl = 0.0;

    // Estado Tiro 1 (Apertura NY)
    this.nyCandleIdentified = false;
    this.nyCandleTime = 0;
    this.nyOpen = 0.0;
    this.nyHigh = 0.0;
    this.nyLow = 0.0;
    this.nyClose = 0.0;
    this.nyBias = null; // 'BUY' | 'SELL'
    this.retestLevel = 0.0;
    this.trade1TakenToday = false;

    // Estado Tiro 2 (Reversión PDH / PDL)
    this.sweepHigh = null;
    this.sweepLow = null;
    this.trade2TakenToday = false;

    // Velas M15 generadas en memoria
    this.currentM15Bar = null;
    this.m15History = [];
  }

  setExecutionHandler(handler) {
    this.executionHandler = handler;
  }

  setLiveExecution(live) {
    this.isLiveExecution = !!live;
  }

  setExitManagement(cfg) {}
  setRiskControls(cfg) {}

  /**
   * Procesa cada tick recibido en tiempo real
   */
  processTick(tick) {
    const price = tick.bid || tick.ask || tick.price;
    if (!price || isNaN(price) || price <= 0) return;

    const tickTime = tick.time ? new Date(tick.time) : new Date();
    const dayStr = tickTime.toISOString().split('T')[0];

    // Nuevo día detectado: reset de banderas y niveles diarios
    if (this.currentDayStr !== dayStr) {
      this.currentDayStr = dayStr;
      this.pdh = 0.0;
      this.pdl = 0.0;
      this.nyCandleIdentified = false;
      this.nyCandleTime = 0;
      this.nyBias = null;
      this.trade1TakenToday = false;
      this.trade2TakenToday = false;
      this.sweepHigh = null;
      this.sweepLow = null;
    }

    // Sincronizar PDH (Previous Day High) y PDL (Previous Day Low) oficiales de MT5 una sola vez por día
    if (tick.pdh && tick.pdl && !isNaN(tick.pdh) && !isNaN(tick.pdl) && tick.pdh > 0 && tick.pdl > 0) {
      if (this.pdh === 0.0 || this.pdl === 0.0) {
        this.pdh = tick.pdh;
        this.pdl = tick.pdl;
        console.log(`🎯 [NY Sniper ${this.symbol}] Niveles D1 oficiales MT5 fijados para ${dayStr} -> PDH (Ayer High): ${this.pdh} | PDL (Ayer Low): ${this.pdl}`);
      }
    }

    // Actualizar vela M15 en curso
    this.updateM15Bar(price, tickTime);

    // 1. Evaluar Tiro 1 (Apertura de NY)
    this.evaluateNYOpenTrade(price, tickTime);

    // 2. Evaluar Tiro 2 (Reversión PDH / PDL)
    this.evaluateReversalTrade(price, tickTime);
  }

  /**
   * Agrupa ticks en velas de 15 minutos (M15)
   */
  updateM15Bar(price, date) {
    const minutes = date.getUTCMinutes();
    const roundedMin = Math.floor(minutes / 15) * 15;
    const barTimestamp = new Date(date);
    barTimestamp.setUTCMinutes(roundedMin, 0, 0);
    const barKey = barTimestamp.getTime();

    if (!this.currentM15Bar || this.currentM15Bar.time !== barKey) {
      if (this.currentM15Bar) {
        this.m15History.push({ ...this.currentM15Bar });
        if (this.m15History.length > 50) this.m15History.shift();

        // Actualizar PDH / PDL con velas del día si superan el rango
        if (this.currentM15Bar.high > this.pdh && this.pdh > 0) this.sweepHigh = this.currentM15Bar.high;
        if (this.currentM15Bar.low < this.pdl && this.pdl > 0) this.sweepLow = this.currentM15Bar.low;
      }
      this.currentM15Bar = {
        time: barKey,
        date: barTimestamp,
        open: price,
        high: price,
        low: price,
        close: price
      };
    } else {
      if (price > this.currentM15Bar.high) this.currentM15Bar.high = price;
      if (price < this.currentM15Bar.low) this.currentM15Bar.low = price;
      this.currentM15Bar.close = price;
    }
  }

  /**
   * Mecánica del Tiro 1: NY Open Expansion
   */
  evaluateNYOpenTrade(currentPrice, date) {
    if (this.trade1TakenToday) return;

    // Comprobar si estamos en la ventana de apertura de NY
    // Server time suele ser UTC+2 / UTC+3. La apertura de NY ocurre a las 13:30 UTC (Forex/Metales) y 14:30 UTC (Wall Street)
    const utcHours = date.getUTCHours();
    const utcMinutes = date.getUTCMinutes();

    // 13:30 UTC = 15:30 Server (Oro) | 14:30 UTC = 16:30 Server (Nasdaq)
    const targetUtcHour = this.cfg.openHour === 15 ? 13 : 14;
    const targetUtcMin = 30;

    // A las targetUtcHour:45 (15 minutos tras la apertura), la 1ª vela M15 ha cerrado
    if (!this.nyCandleIdentified) {
      if (utcHours > targetUtcHour || (utcHours === targetUtcHour && utcMinutes >= targetUtcMin + 15)) {
        if (this.m15History.length >= 1) {
          const firstBar = this.m15History[this.m15History.length - 1];
          this.nyOpen = firstBar.open;
          this.nyHigh = firstBar.high;
          this.nyLow = firstBar.low;
          this.nyClose = firstBar.close;

          if (this.nyClose > this.nyOpen) {
            this.nyBias = 'BUY';
            this.retestLevel = this.nyLow + (this.nyHigh - this.nyLow) * (1.0 - 0.50);
          } else if (this.nyClose < this.nyOpen) {
            this.nyBias = 'SELL';
            this.retestLevel = this.nyHigh - (this.nyHigh - this.nyLow) * (1.0 - 0.50);
          } else {
            return;
          }

          this.nyCandleIdentified = true;
          console.log(`🎯 [NY Sniper ${this.symbol}] 1ª Vela M15 Identificada. Dirección: ${this.nyBias} | Retest 50%: ${this.retestLevel}`);
        }
      }
      return;
    }

    if (!this.nyBias || !this.retestLevel) return;

    // Esperar retesteo al 50%
    if (this.nyBias === 'BUY') {
      if (currentPrice <= this.retestLevel && currentPrice > (this.retestLevel - (this.cfg.slPips / this.cfg.pipMultiplier))) {
        this.dispatchTrade('BUY', currentPrice, 'NY_EXP_T1');
        this.trade1TakenToday = true;
      }
    } else {
      if (currentPrice >= this.retestLevel && currentPrice < (this.retestLevel + (this.cfg.slPips / this.cfg.pipMultiplier))) {
        this.dispatchTrade('SELL', currentPrice, 'NY_EXP_T1');
        this.trade1TakenToday = true;
      }
    }
  }

  /**
   * Mecánica del Tiro 2: Reversión PDH / PDL (BOS + FVG)
   */
  evaluateReversalTrade(currentPrice, date) {
    if (this.trade2TakenToday || this.pdh <= 0 || this.pdl <= 0) return;
    if (this.m15History.length < 3) return;

    const lastBar = this.m15History[this.m15History.length - 1];
    const prevBar = this.m15History[this.m15History.length - 2];
    const bar0 = this.m15History[this.m15History.length - 3];

    // A. Reversión Bajista (tras barrido de PDH)
    if (this.sweepHigh && this.sweepHigh > this.pdh) {
      // Rechazo y cierre por debajo de PDH
      if (lastBar.close < this.pdh && lastBar.close < prevBar.low) {
        // Bearish FVG: bar0.low > lastBar.high
        if (bar0.low > lastBar.high) {
          const fvgBottom = lastBar.high;
          const fvgTop = bar0.low;
          // Retesteo al FVG
          if (currentPrice >= fvgBottom && currentPrice <= fvgTop) {
            const slPrice = this.sweepHigh + (this.cfg.sweepBufferPips / this.cfg.pipMultiplier);
            const slPips = (slPrice - currentPrice) * this.cfg.pipMultiplier;
            if (slPips >= this.cfg.minSlPips && slPips <= this.cfg.maxSlPips) {
              this.dispatchTrade('SELL', currentPrice, 'REV_PDH_T2', slPrice, slPips);
              this.trade2TakenToday = true;
              return;
            }
          }
        }
      }
    }

    // B. Reversión Alcista (tras barrido de PDL)
    if (this.sweepLow && this.sweepLow < this.pdl) {
      if (lastBar.close > this.pdl && lastBar.close > prevBar.high) {
        // Bullish FVG: lastBar.low > bar0.high
        if (lastBar.low > bar0.high) {
          const fvgTop = lastBar.low;
          const fvgBottom = bar0.high;
          if (currentPrice <= fvgTop && currentPrice >= fvgBottom) {
            const slPrice = this.sweepLow - (this.cfg.sweepBufferPips / this.cfg.pipMultiplier);
            const slPips = (currentPrice - slPrice) * this.cfg.pipMultiplier;
            if (slPips >= this.cfg.minSlPips && slPips <= this.cfg.maxSlPips) {
              this.dispatchTrade('BUY', currentPrice, 'REV_PDL_T2', slPrice, slPips);
              this.trade2TakenToday = true;
              return;
            }
          }
        }
      }
    }
  }

  /**
   * Construye y despacha el ExecutionPlan hacia el pipeline en vivo
   */
  dispatchTrade(bias, entryPrice, setupType, customSL = null, customSlPips = null) {
    if (!this.isLiveExecution || typeof this.executionHandler !== 'function') return;

    const slPips = customSlPips || this.cfg.slPips;
    const slDistPrice = slPips / this.cfg.pipMultiplier;
    const tpDistPrice = (slPips * this.cfg.tpRR) / this.cfg.pipMultiplier;

    let slPrice = customSL;
    let tpPrice = 0.0;

    if (bias === 'BUY') {
      if (!slPrice) slPrice = entryPrice - slDistPrice;
      tpPrice = entryPrice + tpDistPrice;
    } else {
      if (!slPrice) slPrice = entryPrice + slDistPrice;
      tpPrice = entryPrice - tpDistPrice;
    }

    const plan = {
      id: `NY_SNIPER_${this.symbol}_${Date.now()}`,
      channelId: `PROPRIETARY_NY_SNIPER_${this.symbol}`,
      channelName: `NY Daily Range Sniper ${this.symbol}`,
      symbol: this.symbol,
      action: bias,
      orderType: 'MARKET',
      entryPrice,
      entry: entryPrice,
      slPrice,
      sl: slPrice,
      targetTP: tpPrice,
      tp: tpPrice,
      isProvisionalSL: false,
      valid: true,
      comment: `${this.name} [${setupType}]`,
      strategyType: 'NY_DAILY_RANGE_SNIPER'
    };

    console.log(`\n🚀 [NY Sniper Strategy] DISPARANDO SEÑAL EN VIVO: ${this.symbol} ${bias} @ ${entryPrice.toFixed(2)} | SL: ${slPrice.toFixed(2)} | TP: ${tpPrice.toFixed(2)}`);
    this.executionHandler(plan);
  }

  getStatus() {
    return {
      name: this.name,
      symbol: this.symbol,
      isLiveExecution: this.isLiveExecution,
      pdh: this.pdh,
      pdl: this.pdl,
      nyBias: this.nyBias,
      trade1Taken: this.trade1TakenToday,
      trade2Taken: this.trade2TakenToday,
      m15Candles: this.m15History.length
    };
  }
}

const nySniperXAUUSD = new NYDailyRangeSniperStrategy('XAUUSD');
const nySniperNAS100 = new NYDailyRangeSniperStrategy('NAS100');

module.exports = {
  NYDailyRangeSniperStrategy,
  nySniperXAUUSD,
  nySniperNAS100
};
