/**
 * Motor Institucional Unificado BPR + BOS + Liquidez (XAUUSD, EURUSD, GBPJPY)
 * Réplica en Node.js del EA validado en MT5 (EA_Institutional_BPR_BOS_Liquidity.mq5)
 * 
 * Reglas Institucionales:
 * 1. Detección de Swings BSL / SSL y Ruptura Estructural (BOS).
 * 2. Formación de Balanced Price Range (BPR): solape de FVG Alcista y Bajista.
 * 3. Entrada: Consequent Encroachment 50% (CE 50%).
 * 4. Ratio Asimétrico: 1:3.0 (R:R 3.0).
 * 5. Break-Even: Activado a 1.0R (Entrada + Buffer).
 * 6. Liberación de Slot en BE: Al asegurar riesgo $0, libera el slot para una nueva oportunidad.
 * 7. Cortafuegos de Precio y Símbolo: Control estricto de cotización para evitar contaminación cruzada.
 * 8. Persistencia Relacional: Escribe y consulta directamente en SQLite (trading_data.db).
 */

const { riskEngine } = require('../RiskEngine');
const { notificationService } = require('../NotificationService');
const { databaseService } = require('../DatabaseService');

const ASSET_PROFILES = {
  XAUUSD: {
    symbol: 'XAUUSD',
    aliases: ['XAUUSD', 'XAUUSD-VIP', 'GOLD'],
    minValidPrice: 1500.0,
    maxValidPrice: 6500.0,
    pipValue: 0.10,
    pointValue: 0.01,
    digits: 2,
    maxSpreadPips: 35.0,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 1.0,
    minWickRatio: 0.20,
    usesEma100: false
  },
  EURUSD: {
    symbol: 'EURUSD',
    aliases: ['EURUSD', 'EURUSD-VIP'],
    minValidPrice: 0.8500,
    maxValidPrice: 1.4500,
    pipValue: 0.00010,
    pointValue: 0.00001,
    digits: 5,
    maxSpreadPips: 3.0,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 0.8,
    minWickRatio: 0.20,
    usesEma100: false
  },
  GBPJPY: {
    symbol: 'GBPJPY',
    aliases: ['GBPJPY', 'GBPJPY-VIP'],
    minValidPrice: 140.0,
    maxValidPrice: 250.0,
    pipValue: 0.01,
    pointValue: 0.001,
    digits: 3,
    maxSpreadPips: 4.5,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 1.5,
    minWickRatio: 0.20,
    usesEma100: false
  },
  USDCAD: {
    symbol: 'USDCAD',
    aliases: ['USDCAD', 'USDCAD-VIP'],
    minValidPrice: 1.1500,
    maxValidPrice: 1.6000,
    pipValue: 0.00010,
    pointValue: 0.00001,
    digits: 5,
    maxSpreadPips: 3.5,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 0.8,
    minWickRatio: 0.20,
    usesEma100: false
  },
  GBPUSD: {
    symbol: 'GBPUSD',
    aliases: ['GBPUSD', 'GBPUSD-VIP'],
    minValidPrice: 1.1000,
    maxValidPrice: 1.5500,
    pipValue: 0.00010,
    pointValue: 0.00001,
    digits: 5,
    maxSpreadPips: 3.5,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 0.8,
    minWickRatio: 0.20,
    usesEma100: false
  },
  AUDUSD: {
    symbol: 'AUDUSD',
    aliases: ['AUDUSD', 'AUDUSD-VIP'],
    minValidPrice: 0.5000,
    maxValidPrice: 0.9000,
    pipValue: 0.00010,
    pointValue: 0.00001,
    digits: 5,
    maxSpreadPips: 2.5,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 0.8,
    minWickRatio: 0.20,
    usesEma100: false
  },
  USDJPY: {
    symbol: 'USDJPY',
    aliases: ['USDJPY', 'USDJPY-VIP'],
    minValidPrice: 100.0,
    maxValidPrice: 200.0,
    pipValue: 0.010,
    pointValue: 0.001,
    digits: 3,
    maxSpreadPips: 3.0,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 1.2,
    minWickRatio: 0.20,
    usesEma100: false
  },
  XAGUSD: {
    symbol: 'XAGUSD',
    aliases: ['XAGUSD', 'XAGUSD-VIP', 'SILVER'],
    minValidPrice: 15.0,
    maxValidPrice: 65.0,
    pipValue: 0.01,
    pointValue: 0.001,
    digits: 3,
    maxSpreadPips: 6.0,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 1.0,
    minWickRatio: 0.20,
    usesEma100: false
  },
  EURJPY: {
    symbol: 'EURJPY',
    aliases: ['EURJPY', 'EURJPY-VIP'],
    minValidPrice: 110.0,
    maxValidPrice: 200.0,
    pipValue: 0.010,
    pointValue: 0.001,
    digits: 3,
    maxSpreadPips: 3.5,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 1.2,
    minWickRatio: 0.20,
    usesEma100: false
  },
  BTCUSD: {
    symbol: 'BTCUSD',
    aliases: ['BTCUSD', 'BTCUSD-VIP', 'BTCUSDT', 'BITCOIN'],
    minValidPrice: 15000.0,
    maxValidPrice: 200000.0,
    pipValue: 1.00,
    pointValue: 0.01,
    digits: 2,
    maxSpreadPips: 80.0,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 15.0,
    minWickRatio: 0.20,
    usesEma100: false
  },
  ETHUSD: {
    symbol: 'ETHUSD',
    aliases: ['ETHUSD', 'ETHUSD-VIP', 'ETHUSDT', 'ETHEREUM'],
    minValidPrice: 1000.0,
    maxValidPrice: 10000.0,
    pipValue: 0.10,
    pointValue: 0.01,
    digits: 2,
    maxSpreadPips: 15.0,
    atrPeriod: 14,
    minFvgAtrMult: 0.20,
    minOverlapAtrMult: 0.15,
    slBufferAtrMult: 0.20,
    zoneExpirationBars: 150,
    rrRatio: 3.0,
    beTriggerR: 1.0,
    beBufferPips: 2.0,
    minWickRatio: 0.20,
    usesEma100: false
  }
};

class InstitutionalBPRStrategy {
  constructor(assetKey, options = {}) {
    const profile = ASSET_PROFILES[assetKey] || ASSET_PROFILES.XAUUSD;
    this.profile = { ...profile, ...options };
    this.symbol = this.profile.symbol;
    this.name = `BPR_INSTITUTIONAL_${this.symbol}_M5`;
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : false;
    this.maxActiveRiskTrades = options.maxActiveRiskTrades || 1;
    this.executionHandler = null;

    // Memoria de Velas M5 (Contexto BPR Institucional)
    this.candlesM5 = [];
    this.currentBar = null;
    this.lastClosedBarM5 = null;
    this.ema100 = null;

    // Zonas BPR e Historial de Swings (Macro M5)
    this.bprZones = [];
    this.activeTrades = [];
    this.history = [];

    // Swings de Liquidez (Fractales lookback = 8 para M5)
    this.swingHighs = [];
    this.swingLows = [];
    this.currentBosBias = null;

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
      this.activeTrades = databaseService.getActiveProprietaryTrades(this.symbol);
      this.history = databaseService.getRecentProprietaryTrades({ symbol: this.symbol, status: 'CLOSED', limit: 30 });
    } catch (e) {
      this.activeTrades = [];
      this.history = [];
    }
    this.preloadHistoricalCandles();
  }

  preloadHistoricalCandles() {
    try {
      const fs = require('fs');
      const path = require('path');
      const cacheDir = path.join(__dirname, '..', '..', 'data');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const cacheFile = path.join(cacheDir, `candles_m5_${this.symbol}.json`);

      let parsed = [];

      // 1. Verificar si hay caché JSON reciente
      if (fs.existsSync(cacheFile)) {
        try {
          const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          if (Array.isArray(cachedData) && cachedData.length >= 20) {
            parsed = cachedData;
          }
        } catch (e) {}
      }

      // 2. Si no hay suficiente caché, cargar desde Common/Files de MT5 (los más frescos de la terminal)
      if (parsed.length < 50) {
        const commonDir = 'C:\\Users\\Administrator\\AppData\\Roaming\\MetaQuotes\\Terminal\\Common\\Files';
        const mt5File = path.join(commonDir, `M5_${this.symbol}_THIS_WEEK.csv`);
        if (fs.existsSync(mt5File)) {
          const content = fs.readFileSync(mt5File, 'utf16le');
          const lines = content.trim().split(/\r?\n/);
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split('\t');
            if (parts.length >= 6) {
              const o = parseFloat(parts[2]);
              const h = parseFloat(parts[3]);
              const l = parseFloat(parts[4]);
              const c = parseFloat(parts[5]);
              if (!isNaN(o) && !isNaN(c) && o > 0) {
                let candleTime = Date.now() - ((lines.length - i) * 300000);
                if (parts[0] && parts[1]) {
                  const dStr = parts[0].replace(/\./g, '-');
                  const pt = new Date(`${dStr}T${parts[1]}Z`).getTime();
                  if (!isNaN(pt) && pt > 0) candleTime = pt;
                }
                parsed.push({
                  time: candleTime,
                  open: o,
                  high: h,
                  low: l,
                  close: c,
                  volume: parseInt(parts[6] || '1', 10),
                  spread: parseFloat(parts[8] || '0')
                });
              }
            }
          }
        }
      }

      // 3. Fallback a CSVs históricos del workspace
      if (parsed.length < 50) {
        const wsDir = path.join(__dirname, '..', '..');
        const files = fs.readdirSync(wsDir).filter(f => f.startsWith(`${this.symbol}_M5_`) && f.endsWith('.csv'));
        if (files.length > 0) {
          const content = fs.readFileSync(path.join(wsDir, files[0]), 'utf-8');
          const lines = content.trim().split(/\r?\n/);
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split('\t');
            if (parts.length >= 6) {
              const o = parseFloat(parts[2]);
              const h = parseFloat(parts[3]);
              const l = parseFloat(parts[4]);
              const c = parseFloat(parts[5]);
              if (!isNaN(o) && !isNaN(c) && o > 0) {
                let candleTime = Date.now() - ((lines.length - i) * 300000);
                if (parts[0] && parts[1]) {
                  const dStr = parts[0].replace(/\./g, '-');
                  const pt = new Date(`${dStr}T${parts[1]}Z`).getTime();
                  if (!isNaN(pt) && pt > 0) candleTime = pt;
                }
                parsed.push({
                  time: candleTime,
                  open: o,
                  high: h,
                  low: l,
                  close: c,
                  volume: parseInt(parts[6] || '1', 10),
                  spread: parseFloat(parts[8] || '0')
                });
              }
            }
          }
        }
      }

      if (parsed.length > 0) {
        const slice = parsed.slice(-300);
        for (const candle of slice) {
          this.candlesM5.push(candle);
          if (this.candlesM5.length > 350) this.candlesM5.shift();

          const k = 2 / (100 + 1);
          if (this.ema100 === null) {
            this.ema100 = candle.close;
          } else {
            this.ema100 = (candle.close * k) + (this.ema100 * (1 - k));
          }

          if (this.candlesM5.length >= 17) {
            this.scanFractalSwings();
            this.scanBOSAndBPR();
          }
        }
        console.log(`🕯️ [${this.name}] Precargadas ${slice.length} velas M5. Swings: ${this.swingHighs.length}H / ${this.swingLows.length}L | Zonas BPR: ${this.bprZones.length}`);
      }
    } catch (e) {
      console.warn(`⚠️ [${this.name}] Error precargando velas históricas:`, e.message);
    }
  }

  saveState() {
    try {
      for (const t of this.activeTrades) {
        databaseService.upsertProprietaryTrade(t, this.name, this.isLiveExecution);
      }
      for (const t of this.history.slice(-10)) {
        databaseService.upsertProprietaryTrade(t, this.name, this.isLiveExecution);
      }
      if (this.candlesM5.length > 0) {
        const fs = require('fs');
        const path = require('path');
        const cacheDir = path.join(__dirname, '..', '..', 'data');
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, `candles_m5_${this.symbol}.json`), JSON.stringify(this.candlesM5.slice(-250)));
      }
    } catch (e) {}
  }

  // --- CORTAFUEGOS DE PRECIO Y SÍMBOLO ---
  validateTickSanity(tick) {
    if (!tick || !tick.bid || !tick.ask) return false;

    // 1. Control estricto de símbolo
    if (tick.symbol) {
      const sym = String(tick.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const isMatch = this.profile.aliases.some(alias => sym.includes(alias.replace(/[^A-Z0-9]/g, '')));
      if (!isMatch) return false;
    }

    const bid = Number(tick.bid);
    const ask = Number(tick.ask);

    // 2. Control estricto de rango de precio por activo
    if (bid < this.profile.minValidPrice || bid > this.profile.maxValidPrice) return false;
    if (ask < this.profile.minValidPrice || ask > this.profile.maxValidPrice) return false;

    // 3. Control de spread máximo
    const spreadPips = (ask - bid) / this.profile.pipValue;
    if (spreadPips > this.profile.maxSpreadPips) return false;

    return true;
  }

  processTick(tick) {
    if (!this.validateTickSanity(tick)) return;

    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    const price = (bid + ask) / 2.0;
    const now = tick.time || Date.now();

    // 1. Construir Velas M5 y M2 en tiempo real
    this.updateCandles(price, ask - bid, now);

    // 2. Gestionar Break-Even y salida de trades abiertos
    this.manageOpenTrades(bid, ask);

    // 3. Evaluar Retest y Entrada en Zonas BPR Activas con Control de Rechazo
    this.checkRetestAndExecute(bid, ask);
  }

  updateCandles(price, spread, time) {
    // 1. Barra M5 (Estructura y Zonas BPR)
    const barMsM5 = 5 * 60 * 1000;
    const barStartM5 = Math.floor(time / barMsM5) * barMsM5;

    if (!this.currentBar || barStartM5 > this.currentBar.time) {
      if (this.currentBar) {
        this.lastClosedBarM5 = { ...this.currentBar };
        this.onM5CandleClosed(this.currentBar);
      }
      this.currentBar = {
        time: barStartM5,
        open: price,
        high: price,
        low: price,
        close: price,
        spread,
        volume: 1
      };
    } else {
      this.currentBar.high = Math.max(this.currentBar.high, price);
      this.currentBar.low = Math.min(this.currentBar.low, price);
      this.currentBar.close = price;
      this.currentBar.volume++;
    }
  }

  onM5CandleClosed(candle) {
    this.candlesM5.push(candle);
    if (this.candlesM5.length > 300) this.candlesM5.shift();

    // Actualizar EMA 100 en M5
    const k = 2 / (100 + 1);
    if (this.ema100 === null) {
      this.ema100 = candle.close;
    } else {
      this.ema100 = (candle.close * k) + (this.ema100 * (1 - k));
    }

    if (this.candlesM5.length < 17) return;

    // 1. Escanear Swings Fractales (Lookback 8)
    this.scanFractalSwings();

    // 2. Detectar BOS y Zonas BPR
    this.scanBOSAndBPR();
  }

  calculateATR(period = 14) {
    if (this.candlesM5.length < period + 1) return this.profile.pipValue * 15;
    let trSum = 0;
    for (let i = this.candlesM5.length - period; i < this.candlesM5.length; i++) {
      const high = this.candlesM5[i].high;
      const low = this.candlesM5[i].low;
      const prevClose = this.candlesM5[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    return trSum / period;
  }

  scanFractalSwings() {
    const lookback = 8;
    const len = this.candlesM5.length;
    if (len < lookback * 2 + 1) return;

    const idx = len - 1 - lookback;
    const testCandle = this.candlesM5[idx];

    let isHigh = true;
    let isLow = true;

    for (let i = 1; i <= lookback; i++) {
      if (this.candlesM5[idx - i].high >= testCandle.high || this.candlesM5[idx + i].high > testCandle.high) isHigh = false;
      if (this.candlesM5[idx - i].low <= testCandle.low || this.candlesM5[idx + i].low < testCandle.low) isLow = false;
    }

    if (isHigh) {
      this.swingHighs.push({ price: testCandle.high, time: testCandle.time, swept: false });
      if (this.swingHighs.length > 20) this.swingHighs.shift();
    }
    if (isLow) {
      this.swingLows.push({ price: testCandle.low, time: testCandle.time, swept: false });
      if (this.swingLows.length > 20) this.swingLows.shift();
    }
  }

  scanBOSAndBPR() {
    const len = this.candlesM5.length;
    const c1 = this.candlesM5[len - 1]; // Vela recién cerrada
    const atr = this.calculateATR(this.profile.atrPeriod);

    // Detectar Ruptura de Estructura (BOS)
    // 1. BOS Alcista: Vela cierra con cuerpo por encima del último Swing High
    const recentHigh = this.swingHighs.slice().reverse().find(sh => !sh.swept);
    if (recentHigh && c1.close > recentHigh.price) {
      recentHigh.swept = true;
      this.currentBosBias = 'BULLISH';
    }

    // 2. BOS Bajista: Vela cierra con cuerpo por debajo del último Swing Low
    const recentLow = this.swingLows.slice().reverse().find(sl => !sl.swept);
    if (recentLow && c1.close < recentLow.price) {
      recentLow.swept = true;
      this.currentBosBias = 'BEARISH';
    }

    // Escanear BPRs en la ventana de 150 velas según el sesgo BOS activo
    if (this.currentBosBias === 'BULLISH') {
      this.findAndRegisterBPR(true, atr, c1);
    } else if (this.currentBosBias === 'BEARISH') {
      this.findAndRegisterBPR(false, atr, c1);
    }
  }

  findAndRegisterBPR(isBuy, atr, originCandle) {
    const len = this.candlesM5.length;
    if (len < 5) return;

    // Buscar FVG solapados en las últimas 150 velas (ampliado a petición para escaneo institucional)
    const scanDepth = Math.min(150, len - 3);
    const bullishFvgs = [];
    const bearishFvgs = [];

    for (let i = len - 1; i >= len - scanDepth; i--) {
      // Bullish FVG (low[i] > high[i-2])
      if (this.candlesM5[i].low > this.candlesM5[i - 2].high) {
        const gap = this.candlesM5[i].low - this.candlesM5[i - 2].high;
        if (gap >= this.profile.minFvgAtrMult * atr) {
          bullishFvgs.push({ top: this.candlesM5[i].low, bottom: this.candlesM5[i - 2].high, barIndex: i });
        }
      }
      // Bearish FVG (high[i] < low[i-2])
      if (this.candlesM5[i].high < this.candlesM5[i - 2].low) {
        const gap = this.candlesM5[i - 2].low - this.candlesM5[i].high;
        if (gap >= this.profile.minFvgAtrMult * atr) {
          bearishFvgs.push({ top: this.candlesM5[i - 2].low, bottom: this.candlesM5[i].high, barIndex: i });
        }
      }
    }

    if (bullishFvgs.length === 0 || bearishFvgs.length === 0) return;

    // Buscar el solape BPR que cumpla el umbral ATR
    for (const b of bullishFvgs) {
      for (const s of bearishFvgs) {
        const overlapTop = Math.min(b.top, s.top);
        const overlapBottom = Math.max(b.bottom, s.bottom);

        if (overlapTop > overlapBottom) {
          const overlapSize = overlapTop - overlapBottom;
          if (overlapSize >= this.profile.minOverlapAtrMult * atr) {
            const ce50 = (overlapTop + overlapBottom) / 2.0;
            const slBuffer = this.profile.slBufferAtrMult * atr;
            const recentLow = this.swingLows.slice().reverse().find(sl => sl.price > 0);
            const recentHigh = this.swingHighs.slice().reverse().find(sh => sh.price > 0);
            const slRef = isBuy ? (recentLow ? recentLow.price : overlapBottom) : (recentHigh ? recentHigh.price : overlapTop);
            let slPrice = isBuy ? (slRef - slBuffer) : (slRef + slBuffer);

            // Distancia mínima de seguridad institucional (evita micro-SLs de ruido inferiores a 8 pips en Forex / 15 pips en Oro)
            const minSlPips = (this.symbol === 'XAUUSD') ? 15.0 : 8.0;
            const minSlDist = minSlPips * this.profile.pipValue;
            if (isBuy && (ce50 - slPrice) < minSlDist) {
              slPrice = ce50 - minSlDist;
            } else if (!isBuy && (slPrice - ce50) < minSlDist) {
              slPrice = ce50 + minSlDist;
            }

            // Evitar registrar la misma zona si ya existe una similar activa
            const isDup = this.bprZones.some(z => z.active && z.isBuy === isBuy && Math.abs(z.ce50 - ce50) < (this.profile.pipValue * 5));
            if (isDup) continue;

            const zone = {
              id: `BPR_${this.symbol}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
              isBuy,
              top: overlapTop,
              bottom: overlapBottom,
              ce50,
              slPrice,
              creationBar: len - 1,
              active: true,
              createdAt: new Date().toISOString()
            };

            this.bprZones.push(zone);
            if (this.bprZones.length > 15) this.bprZones.shift();

            const typeStr = isBuy ? 'COMPRA' : 'VENTA';
            console.log(`💎 [${this.name}] Nueva Zona BPR ${typeStr}: [${overlapBottom.toFixed(this.profile.digits)} - ${overlapTop.toFixed(this.profile.digits)}] | CE 50%: ${ce50.toFixed(this.profile.digits)} | SL: ${slPrice.toFixed(this.profile.digits)}`);
            return;
          }
        }
      }
    }
  }

  // --- COMPROBACIÓN DE SLOTS ACTIVOS Y BREAK-EVEN ---
  canOpenNewTrade(isBuyOrder) {
    let activeRiskTrades = 0;
    let hasOpposite = false;

    for (const t of this.activeTrades) {
      if (t.status !== 'OPEN') continue;

      if ((isBuyOrder && t.type === 'SELL') || (!isBuyOrder && t.type === 'BUY')) {
        hasOpposite = true;
      }

      // Comprobar si está asegurada en Break-Even
      let isRiskFree = false;
      if (t.type === 'BUY' && t.currentSL >= t.entryPrice) isRiskFree = true;
      if (t.type === 'SELL' && t.currentSL <= t.entryPrice) isRiskFree = true;

      if (!isRiskFree) {
        activeRiskTrades++;
      }
    }

    // Regla 1: Anti-Hedging
    if (hasOpposite) return false;

    // Regla 2: Máximo de operaciones con riesgo real activo
    if (activeRiskTrades >= this.maxActiveRiskTrades) return false;

    // Regla 3: Ventana operativa permitida (03:00 - 08:00 CET y 09:00 - 22:55 CET)
    if (!riskEngine.isTradingSessionActive()) return false;

    return true;
  }

  checkRetestAndExecute(bid, ask) {
    for (const zone of this.bprZones) {
      if (!zone.active) continue;

      zone.creationBar++;
      if (zone.creationBar > this.profile.zoneExpirationBars) {
        zone.active = false;
        continue;
      }

      // Marcar si el precio ha penetrado o tocado el CE 50% de la zona
      if (zone.isBuy && bid <= zone.ce50 && ask >= zone.slPrice) {
        zone.tested = true;
      } else if (!zone.isBuy && ask >= zone.ce50 && bid <= zone.slPrice) {
        zone.tested = true;
      }

      if (!zone.tested) continue;

      // 🛡️ CONTROL DE MECHA DE RECHAZO (M5) + FILTRO TENDENCIAL EMA 100
      const confirmation = this.evaluateRejectionWick(zone, bid, ask);
      if (!confirmation.passed) continue;

      // Retest BUY en CE 50% con rechazo confirmado
      if (zone.isBuy) {
        if (!this.canOpenNewTrade(true)) continue;

        zone.active = false;
        console.log(`🎯 [${this.name}] RECHAZO CONFIRMADO (COMPRA M5): ${confirmation.detail}`);
        this.executeTrade('BUY', ask, zone.slPrice, zone.ce50);
        return;
      }
      // Retest SELL en CE 50% con rechazo confirmado
      else {
        if (!this.canOpenNewTrade(false)) continue;

        zone.active = false;
        console.log(`🎯 [${this.name}] RECHAZO CONFIRMADO (VENTA M5): ${confirmation.detail}`);
        this.executeTrade('SELL', bid, zone.slPrice, zone.ce50);
        return;
      }
    }
  }

  evaluateRejectionWick(zone, bid, ask) {
    // 1. Filtro Tendencial EMA 100 (si está habilitado y calculado)
    if (this.profile.usesEma100 && this.ema100 !== null) {
      if (zone.isBuy && bid < this.ema100) {
        return { passed: false, detail: `Filtrado por EMA100 (Precio ${bid} < EMA ${this.ema100.toFixed(this.profile.digits)})` };
      }
      if (!zone.isBuy && ask > this.ema100) {
        return { passed: false, detail: `Filtrado por EMA100 (Precio ${ask} > EMA ${this.ema100.toFixed(this.profile.digits)})` };
      }
    }

    // 2. Evaluar velas candidatas (M5 en formación o cerrada)
    const candidateBars = [this.currentBar, this.lastClosedBarM5].filter(Boolean);
    const minWickRatio = this.profile.minWickRatio || 0.20;

    for (const bar of candidateBars) {
      const range = bar.high - bar.low;
      if (range <= 0) continue;

      if (zone.isBuy) {
        // En Compra: la vela debe haber penetrado hacia la zona y dejar mecha inferior
        if (bar.low <= zone.ce50) {
          const lowerWick = Math.min(bar.open, bar.close) - bar.low;
          const wickRatio = lowerWick / range;
          if (wickRatio >= minWickRatio) {
            return {
              passed: true,
              detail: `Mecha Inferior: ${(wickRatio * 100).toFixed(1)}% >= ${(minWickRatio * 100)}% en TF ${bar.volume > 1 ? 'M2/M5' : 'Bar'}`
            };
          }
        }
      } else {
        // En Venta: la vela debe haber penetrado hacia la zona y dejar mecha superior
        if (bar.high >= zone.ce50) {
          const upperWick = bar.high - Math.max(bar.open, bar.close);
          const wickRatio = upperWick / range;
          if (wickRatio >= minWickRatio) {
            return {
              passed: true,
              detail: `Mecha Superior: ${(wickRatio * 100).toFixed(1)}% >= ${(minWickRatio * 100)}% en TF ${bar.volume > 1 ? 'M2/M5' : 'Bar'}`
            };
          }
        }
      }
    }

    return { passed: false, detail: 'Esperando formación de mecha de rechazo >= 20%' };
  }

  executeTrade(type, entryPrice, slPrice, ceLevel) {
    const riskDist = Math.abs(entryPrice - slPrice);
    if (riskDist <= 0) return;

    const tpPrice = type === 'BUY'
      ? (entryPrice + (riskDist * this.profile.rrRatio))
      : (entryPrice - (riskDist * this.profile.rrRatio));

    const slPips = +(riskDist / this.profile.pipValue).toFixed(1);
    const tpPips = +(Math.abs(tpPrice - entryPrice) / this.profile.pipValue).toFixed(1);

    const trade = {
      id: `${this.name}_${Date.now()}`,
      strategy: this.name,
      timeframe: 'M5',
      symbol: this.symbol,
      type,
      entryPrice: +entryPrice.toFixed(this.profile.digits),
      initialSL: +slPrice.toFixed(this.profile.digits),
      currentSL: +slPrice.toFixed(this.profile.digits),
      tpPrice: +tpPrice.toFixed(this.profile.digits),
      slPips,
      tpPips,
      openTime: new Date().toISOString(),
      closeTime: null,
      status: 'OPEN',
      pips: null,
      grossProfit: null,
      lotSize: 0.01,
      isLive: this.isLiveExecution ? 1 : 0
    };

    this.activeTrades.push(trade);
    this.saveState();

    console.log(`\n🚀 [${this.name}] DISPARO INSTITUCIONAL CE 50% (${type}):`);
    console.log(`   • Entrada: ${trade.entryPrice} | SL: ${trade.initialSL} (${slPips}p) | TP (1:${this.profile.rrRatio}): ${trade.tpPrice} (${tpPips}p)`);
    console.log(`   • Modo: ${this.isLiveExecution ? '🔴 LIVE REAL' : '🧪 SHADOW (Paper-Trading)'}\n`);

    // Notificación informativa
    notificationService.sendTradeAlert({
      action: type,
      symbol: this.symbol,
      entryPrice: trade.entryPrice,
      slPrice: trade.initialSL,
      targetTP: trade.tpPrice,
      channelName: this.name
    }, `🎯 ${this.symbol} M5 Institutional BPR CE 50% (R:R 1:${this.profile.rrRatio})`);

    // Si estuviese en LIVE y tiene handler, despachar al puente
    if (this.isLiveExecution && typeof this.executionHandler === 'function') {
      this.executionHandler({
        valid: true,
        action: type,
        symbol: this.symbol,
        entryPrice: trade.entryPrice,
        slPrice: trade.initialSL,
        targetTP: trade.tpPrice,
        channelId: `PROPRIETARY_${this.name}`,
        channelName: this.name
      });
    }
  }

  manageOpenTrades(bid, ask) {
    const beBuffer = this.profile.beBufferPips * this.profile.pipValue;

    for (let i = this.activeTrades.length - 1; i >= 0; i--) {
      const t = this.activeTrades[i];
      if (t.status !== 'OPEN') continue;

      const currentPrice = t.type === 'BUY' ? bid : ask;
      const originalRisk = Math.abs(t.entryPrice - t.initialSL);
      const profitDist = t.type === 'BUY' ? (currentPrice - t.entryPrice) : (t.entryPrice - currentPrice);
      const currentR = originalRisk > 0 ? (profitDist / originalRisk) : 0;

      // 1. Break-Even Check (Gatillo a 1.0R)
      if (currentR >= this.profile.beTriggerR) {
        const targetBE = t.type === 'BUY' ? (t.entryPrice + beBuffer) : (t.entryPrice - beBuffer);
        const shouldMove = t.type === 'BUY' ? (t.currentSL < targetBE) : (t.currentSL > targetBE);

        if (shouldMove) {
          t.currentSL = +targetBE.toFixed(this.profile.digits);
          console.log(`🛡️ [${this.name}] BREAK-EVEN ACTIVADO en Trade #${t.id} -> SL asegurado a ${t.currentSL} (+${this.profile.beBufferPips}p ganancia). Slot de riesgo liberado.`);
          this.saveState();

          if (this.isLiveExecution && typeof this.executionHandler === 'function') {
            this.executionHandler({
              action: 'MODIFY',
              modifyOrder: {
                modifyType: 'BREAK_EVEN',
                sl: t.currentSL,
                tp: t.tpPrice
              },
              symbol: this.symbol,
              entryPrice: t.entryPrice,
              channelId: `PROPRIETARY_${this.name}`,
              channelName: this.name
            });
          }
        }
      }

      // 2. Take Profit Check
      const hitTP = t.type === 'BUY' ? (bid >= t.tpPrice) : (ask <= t.tpPrice);
      if (hitTP) {
        t.status = 'CLOSED';
        t.closeTime = new Date().toISOString();
        t.pips = t.tpPips;
        t.reason = 'TAKE_PROFIT';
        this.activeTrades.splice(i, 1);
        this.history.unshift(t);
        this.saveState();
        console.log(`🏁 [${this.name}] TAKE PROFIT ALCANZADO: +${t.pips} pips (R:R 1:${this.profile.rrRatio})`);
        continue;
      }

      // 3. Stop Loss Check
      const hitSL = t.type === 'BUY' ? (bid <= t.currentSL) : (ask >= t.currentSL);
      if (hitSL) {
        t.status = 'CLOSED';
        t.closeTime = new Date().toISOString();
        const isBE = t.type === 'BUY' ? (t.currentSL >= t.entryPrice) : (t.currentSL <= t.entryPrice);
        t.pips = isBE ? +this.profile.beBufferPips : -t.slPips;
        t.reason = isBE ? 'BREAK_EVEN' : 'STOP_LOSS';
        this.activeTrades.splice(i, 1);
        this.history.unshift(t);
        this.saveState();
        console.log(`🛑 [${this.name}] SALIDA POR SL / BE: ${t.pips > 0 ? '+' : ''}${t.pips} pips (${t.reason})`);
        continue;
      }
    }
  }

  getConfirmationChecklist(currentPrice = 0, tf = 'M5') {
    const targetZones = this.bprZones;
    const targetSwingHighs = this.swingHighs;
    const targetSwingLows = this.swingLows;
    const targetCandles = this.candlesM5;
    const targetBosBias = this.currentBosBias;

    const madridTime = riskEngine.getMadridTime();
    const { hour: mHour, minute: mMin, totalMinutes: mTotalMin } = madridTime;
    const isRollover = (mTotalMin >= 1375 || mTotalMin <= 10); // 22:55 - 00:10 CET
    const isTradingSession = (mTotalMin >= 180 && mTotalMin < 1375); // 03:00 - 22:55 CET (Continuo sin pausas)
    const sessionOk = isTradingSession && !isRollover;

    let sessionDetail = '';
    if (isRollover) {
      sessionDetail = `Rollover Interbancario (${mHour.toString().padStart(2,'0')}:${mMin.toString().padStart(2,'0')} CET: Spreads altos)`;
    } else if (isTradingSession) {
      if (mTotalMin < 480) {
        sessionDetail = `Sesión Asiática Activa (${mHour.toString().padStart(2,'0')}:${mMin.toString().padStart(2,'0')} CET)`;
      } else if (mTotalMin < 780) {
        sessionDetail = `Sesión de Londres Activa (${mHour.toString().padStart(2,'0')}:${mMin.toString().padStart(2,'0')} CET)`;
      } else {
        sessionDetail = `Sesión Nueva York Activa (${mHour.toString().padStart(2,'0')}:${mMin.toString().padStart(2,'0')} CET)`;
      }
    } else {
      sessionDetail = `Pausa Nocturna (${mHour.toString().padStart(2,'0')}:${mMin.toString().padStart(2,'0')} CET: Apertura a las 03:00)`;
    }

    let price = currentPrice;
    if (price <= 0) {
      price = this.currentBar ? this.currentBar.close : (targetCandles.slice(-1)[0]?.close || 0);
    }

    const openTrade = this.activeTrades.find(t => t.status === 'OPEN');
    if (openTrade) {
      const entryPrice = openTrade.entryPrice || openTrade.entry_price || 0;
      const currentSL = openTrade.currentSL || openTrade.current_sl || 0;
      const tpPrice = openTrade.tpPrice || openTrade.tp_price || 0;
      const isRiskFree = (openTrade.type === 'BUY' && currentSL >= entryPrice) ||
                         (openTrade.type === 'SELL' && currentSL <= entryPrice);
      return {
        statusLabel: isRiskFree ? 'ORDEN PROTEGIDA (BREAK-EVEN $0)' : 'EN MERCADO (ORDEN ACTIVA)',
        statusColor: isRiskFree ? '#10b981' : '#3b82f6',
        activeType: openTrade.type,
        score: '6/6',
        scorePercent: 100,
        rules: [
          { name: '1. Sesión Institucional', ok: true, detail: `Operando en ${openTrade.type}` },
          { name: '2. Barrido BSL / SSL', ok: true, detail: 'Liquidez fractal barrida' },
          { name: '3. Ruptura BOS', ok: true, detail: 'Desplazamiento confirmado' },
          { name: '4. Mitigación CE 50%', ok: true, detail: `Entrada: ${entryPrice}` },
          { name: '5. Filtro EMA 100', ok: true, detail: `Tendencia favorable` },
          { name: '6. Mecha Rechazo >=20%', ok: true, detail: `SL: ${currentSL} | TP: ${tpPrice}` }
        ],
        activeZone: null,
        distToCE: '0.0 pips',
        candlesCached: targetCandles.length,
        timeframe: tf
      };
    }

    const activeZone = targetZones.slice().reverse().find(z => z.active);
    const lastZone = activeZone || targetZones.slice(-1)[0];

    const hasZone = !!activeZone;
    let distPips = 0;
    if (lastZone && price > 0) {
      distPips = Math.abs(price - lastZone.ce50) / this.profile.pipValue;
    }

    const recentHigh = targetSwingHighs.slice().reverse().find(sh => !sh.swept);
    const recentLow = targetSwingLows.slice().reverse().find(sl => !sl.swept);
    const lastSweptHigh = targetSwingHighs.slice().reverse().find(sh => sh.swept);
    const lastSweptLow = targetSwingLows.slice().reverse().find(sl => sl.swept);
    const hasSweep = !!(lastSweptHigh || lastSweptLow || hasZone);

    let sweepDetail = `Buscando liquidez swing (${tf})`;
    if (hasSweep) {
      if (lastSweptHigh) {
        sweepDetail = `BSL Barrido (${lastSweptHigh.price.toFixed(this.profile.digits)})`;
      } else if (lastSweptLow) {
        sweepDetail = `SSL Barrido (${lastSweptLow.price.toFixed(this.profile.digits)})`;
      } else {
        sweepDetail = `Swings fractales barridos (${tf})`;
      }
    } else if (recentHigh || recentLow) {
      const bslStr = recentHigh ? recentHigh.price.toFixed(this.profile.digits) : '---';
      const sslStr = recentLow ? recentLow.price.toFixed(this.profile.digits) : '---';
      sweepDetail = `Pendiente (BSL: ${bslStr} | SSL: ${sslStr})`;
    }

    const bosOk = hasZone;
    const bosDetail = hasZone 
      ? `BOS ${activeZone.isBuy ? 'Alcista' : 'Bajista'} confirmado (${tf})` 
      : `Esperando quiebre fractal ${tf}`;

    let emaOk = true;
    let emaDetail = 'Tendencia Neutral';
    if (this.ema100 !== null && price > 0) {
      const diffPipsNum = (price - this.ema100) / this.profile.pipValue;
      const diffPipsStr = `${diffPipsNum >= 0 ? '+' : ''}${diffPipsNum.toFixed(1)}p`;
      if (activeZone) {
        if (activeZone.isBuy) {
          emaOk = price >= this.ema100;
          emaDetail = emaOk ? `Sobre EMA100 (${diffPipsStr})` : `Bajo EMA100 (${diffPipsStr})`;
        } else {
          emaOk = price <= this.ema100;
          emaDetail = emaOk ? `Bajo EMA100 (${diffPipsStr})` : `Sobre EMA100 (${diffPipsStr})`;
        }
      } else {
        emaDetail = price >= this.ema100 
          ? `Sobre EMA ${this.ema100.toFixed(this.profile.digits)} (${diffPipsStr})` 
          : `Bajo EMA ${this.ema100.toFixed(this.profile.digits)} (${diffPipsStr})`;
      }
    }

    // Comprobación de Mecha
    let wickOk = false;
    let wickDetail = 'Esperando toque CE 50%';
    if (activeZone) {
      const confirmation = this.evaluateRejectionWick(activeZone, price, price);
      wickOk = confirmation.passed;
      wickDetail = confirmation.detail;
    }

    let ceDetail = `Sin caja BPR activa (${tf})`;
    if (hasZone) {
      ceDetail = `CE: ${activeZone.ce50.toFixed(this.profile.digits)} (a ${distPips.toFixed(1)}p)`;
    } else if (lastZone) {
      ceDetail = `Última caja a ${distPips.toFixed(1)}p (Mitigada)`;
    }

    const rules = [
      {
        name: '1. Sesión Institucional',
        ok: sessionOk,
        detail: sessionDetail
      },
      {
        name: '2. Barrido BSL / SSL',
        ok: hasSweep,
        detail: sweepDetail
      },
      {
        name: '3. Ruptura Estructura (BOS)',
        ok: bosOk,
        detail: bosDetail
      },
      {
        name: '4. Mitigación CE 50%',
        ok: hasZone && distPips <= 2.0,
        detail: ceDetail
      },
      {
        name: '5. Sesgo Direccional ICT',
        ok: !!targetBosBias,
        detail: targetBosBias ? `Sesgo ${targetBosBias === 'BULLISH' ? 'Alcista (COMPRAS)' : 'Bajista (VENTAS)'}` : `Esperando Sesgo ${tf}`
      },
      {
        name: '6. Mecha Rechazo >=20%',
        ok: wickOk,
        detail: wickDetail
      }
    ];

    const passedCount = rules.filter(r => r.ok).length;
    const scorePercent = Math.round((passedCount / rules.length) * 100);

    let statusLabel = `ESCANEANDO ESTRUCTURA (${tf})`;
    let statusColor = '#94a3b8';
    if (hasZone) {
      if (distPips <= 2.0) {
        statusLabel = wickOk ? `¡GATILLO CONFIRMADO (${tf})!` : `ZONA EN MITIGACIÓN (${tf})`;
        statusColor = wickOk ? '#10b981' : '#f59e0b';
      } else {
        statusLabel = `BPR ACTIVA ${tf} (${activeZone.isBuy ? 'COMPRA' : 'VENTA'})`;
        statusColor = '#06b6d4';
      }
    } else if (hasSweep) {
      statusLabel = `SWEEPS DETECTADOS (${tf})`;
      statusColor = '#c084fc';
    }

    return {
      statusLabel,
      statusColor,
      activeType: activeZone ? (activeZone.isBuy ? 'BULLISH BPR' : 'BEARISH BPR') : 'MONITOR',
      score: `${passedCount}/${rules.length}`,
      scorePercent,
      rules,
      activeZone: activeZone ? {
        top: activeZone.top,
        bottom: activeZone.bottom,
        ce50: activeZone.ce50,
        isBuy: activeZone.isBuy
      } : null,
      distToCE: `${distPips.toFixed(1)} pips`,
      candlesCached: targetCandles.length,
      timeframe: tf
    };
  }

  getStatus() {
    return {
      name: this.name,
      symbol: this.symbol,
      isLiveExecution: this.isLiveExecution,
      candlesM5: this.candlesM5.length,
      activeZones: this.bprZones.filter(z => z.active).length,
      activeTrades: this.activeTrades,
      recentHistory: this.history.slice(0, 5),
      metrics: databaseService.getProprietaryMetrics(this.symbol)
    };
  }
}

const institutionalBprXAUUSD = new InstitutionalBPRStrategy('XAUUSD');
const institutionalBprEURUSD = new InstitutionalBPRStrategy('EURUSD');
const institutionalBprGBPJPY = new InstitutionalBPRStrategy('GBPJPY');
const institutionalBprUSDCAD = new InstitutionalBPRStrategy('USDCAD');
const institutionalBprGBPUSD = new InstitutionalBPRStrategy('GBPUSD');
const institutionalBprAUDUSD = new InstitutionalBPRStrategy('AUDUSD');
const institutionalBprUSDJPY = new InstitutionalBPRStrategy('USDJPY');
const institutionalBprXAGUSD = new InstitutionalBPRStrategy('XAGUSD');
const institutionalBprEURJPY = new InstitutionalBPRStrategy('EURJPY');
const institutionalBprBTCUSD = new InstitutionalBPRStrategy('BTCUSD');
const institutionalBprETHUSD = new InstitutionalBPRStrategy('ETHUSD');

module.exports = {
  InstitutionalBPRStrategy,
  ASSET_PROFILES,
  institutionalBprXAUUSD,
  institutionalBprEURUSD,
  institutionalBprGBPJPY,
  institutionalBprUSDCAD,
  institutionalBprGBPUSD,
  institutionalBprAUDUSD,
  institutionalBprUSDJPY,
  institutionalBprXAGUSD,
  institutionalBprEURJPY,
  institutionalBprBTCUSD,
  institutionalBprETHUSD
};
