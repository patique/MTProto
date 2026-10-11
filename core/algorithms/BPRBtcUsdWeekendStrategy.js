/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  Motor Algorítmico Institucional BPR Sniper: BTCUSD (M15 - 24/7)       ║
 * ║  Operativa Continua Cripto Institucional (Fines de Semana y Diario)     ║
 * ║                                                                        ║
 * ║  Ventaja Estadística Verificada:                                       ║
 * ║  • Timeframe: M15                                                      ║
 * ║  • Ratio Riesgo:Beneficio: 1:3.0 (Asimetría Matemática)                ║
 * ║  • Filtro Tendencial: EMA 100 periodos (Buy > EMA, Sell < EMA)         ║
 * ║  • Rechazo de Mecha: ≥ 25% del rango de la vela                        ║
 * ║  • Buffer de Stop Loss: 40.0 USD detrás de la caja BPR                 ║
 * ║  • Operativa: 24/7 (Sábados, Domingos y Días Hábiles)                  ║
 * ║  • Ejecución: Stop Loss Fijo | Take Profit Completo (Sin BE/Trailing)  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');
const { notificationService } = require('../NotificationService');
const { riskEngine } = require('../RiskEngine');

const SHADOW_BTCUSD_FILE = path.join(__dirname, '..', '..', 'proprietary_bpr_btcusd_trades.json');
const CANDLE_CACHE_FILE = path.join(__dirname, '..', '..', 'bpr_btcusd_candle_cache.json');

const BTCUSD_CONFIG = {
  M15: {
    tfMinutes: 15,
    minFvgGap: 120.0,    // Gap mínimo de $120 en vela M15
    minOverlap: 60.0,    // Solapamiento de cajas BPR mínimo $60
    minRange: 150.0,     // Rango mínimo de vela para validez institucional
    bufferPts: 40.0,     // Buffer de holgura detrás de la zona
    slMinPts: 100.0,     // SL mínimo $100
    slMaxPts: 900.0,     // SL máximo $900
    rrRatio: 3.0,        // R:R 1:3.0 institucional
    lookback: 25,
    wickPct: 0.25
  }
};

class BPRBtcUsdWeekendStrategy {
  constructor(options = {}) {
    this.name = 'BPR_BTCUSD_Weekend_Sniper';
    this.symbol = 'BTCUSD';
    this.isLiveExecution = options.isLiveExecution !== undefined ? options.isLiveExecution : true;
    this.executionHandler = null;

    this.timeframes = {
      M15: {
        config: BTCUSD_CONFIG.M15,
        candles: [],
        currentBar: null,
        bprZones: []
      }
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
      peakPoints: 0
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
      if (fs.existsSync(SHADOW_BTCUSD_FILE)) {
        const data = JSON.parse(fs.readFileSync(SHADOW_BTCUSD_FILE, 'utf-8'));
        this.history = data.history || [];
        this.metrics = data.metrics || this.metrics;
        this.activeTrades = data.activeTrades || [];
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar estado de BPR BTCUSD:', e.message);
    }
    this.loadCandleCache();
  }

  loadCandleCache() {
    try {
      if (fs.existsSync(CANDLE_CACHE_FILE)) {
        const raw = fs.readFileSync(CANDLE_CACHE_FILE, 'utf-8');
        const cache = JSON.parse(raw);
        if (Array.isArray(cache.M15) && cache.M15.length > 0) {
          const tfObj = this.timeframes.M15;
          tfObj.candles = cache.M15.slice(-450);
          this.calculateEma100(tfObj);
          this.scanAllBprZones(tfObj);
          console.log(`💻 [BPR BTCUSD Cache] ${tfObj.candles.length} velas restauradas. Zonas BPR listas.`);
        }
      }
    } catch (e) {
      console.warn('⚠️ No se pudo cargar caché de velas BTCUSD:', e.message);
    }
  }

  saveState() {
    try {
      fs.writeFileSync(SHADOW_BTCUSD_FILE, JSON.stringify({
        lastUpdate: new Date().toISOString(),
        metrics: this.metrics,
        activeTrades: this.activeTrades,
        history: this.history.slice(-300)
      }, null, 2));

      fs.writeFileSync(CANDLE_CACHE_FILE, JSON.stringify({
        M15: this.timeframes.M15.candles.slice(-450)
      }));
    } catch (e) {
      console.error('❌ Error guardando estado BPR BTCUSD:', e.message);
    }
  }

  calculateEma100(tfObj) {
    const period = 100;
    const k = 2 / (period + 1);
    const candles = tfObj.candles;
    if (candles.length < period) return;

    let sum = 0;
    for (let i = 0; i < period; i++) sum += candles[i].close;
    let ema = sum / period;
    candles[period - 1].ema100 = ema;

    for (let i = period; i < candles.length; i++) {
      ema = (candles[i].close - ema) * k + ema;
      candles[i].ema100 = ema;
    }
  }

  processTick(tick) {
    const price = tick.bid;
    if (!price || price <= 0) return;

    const spreadPts = Math.abs(tick.ask - tick.bid);
    this.manageActiveTrades(price, spreadPts);

    const tfObj = this.timeframes.M15;
    const barIntervalMs = 15 * 60 * 1000;
    const barStartTime = Math.floor(tick.time / barIntervalMs) * barIntervalMs;

    if (!tfObj.currentBar || tfObj.currentBar.time !== barStartTime) {
      if (tfObj.currentBar) {
        this.closeBar(tfObj, tfObj.currentBar);
      }
      tfObj.currentBar = {
        time: barStartTime,
        open: price,
        high: price,
        low: price,
        close: price,
        spread: spreadPts,
        ticks: 1
      };
    } else {
      tfObj.currentBar.high = Math.max(tfObj.currentBar.high, price);
      tfObj.currentBar.low = Math.min(tfObj.currentBar.low, price);
      tfObj.currentBar.close = price;
      tfObj.currentBar.spread = spreadPts;
      tfObj.currentBar.ticks++;
    }
  }

  closeBar(tfObj, bar) {
    tfObj.candles.push({ ...bar });
    if (tfObj.candles.length > 500) tfObj.candles.shift();

    this.calculateEma100(tfObj);
    this.scanBprZones(tfObj);
    this.checkSignal(tfObj, bar);
    this.saveState();
  }

  scanBprZones(tfObj) {
    const candles = tfObj.candles;
    const n = candles.length;
    if (n < 4) return;

    const cfg = tfObj.config;
    const c0 = candles[n - 1];
    const c2 = candles[n - 3];

    const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
    const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;

    if (isBearishFVG) c0._isBearish = true;
    if (isBullishFVG) c0._isBullish = true;

    // Detectar Bullish BPR (FVG bajista previo rellenado por FVG alcista)
    if (isBullishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - cfg.lookback); i--) {
        if (candles[i]._isBearish) {
          const bearTop = candles[i - 2] ? candles[i - 2].low : candles[i].high + cfg.minFvgGap;
          const bearBottom = candles[i].high;
          const bullTop = c0.low;
          const bullBottom = c2.high;
          const cLow = Math.max(bearBottom, bullBottom);
          const cHigh = Math.min(bearTop, bullTop);

          if (cHigh > cLow + cfg.minOverlap) {
            tfObj.bprZones.push({
              id: `BPR_BTC_BULL_${Date.now()}`,
              type: 'BULLISH',
              top: cHigh,
              bottom: cLow,
              ce50: (cHigh + cLow) / 2,
              createdIndex: n - 1,
              tested: false
            });
            break;
          }
        }
      }
    }

    // Detectar Bearish BPR (FVG alcista previo rellenado por FVG bajista)
    if (isBearishFVG) {
      for (let i = n - 2; i >= Math.max(0, n - cfg.lookback); i--) {
        if (candles[i]._isBullish) {
          const bullTop = candles[i].low;
          const bullBottom = candles[i - 2] ? candles[i - 2].high : candles[i].low - cfg.minFvgGap;
          const bearTop = c2.low;
          const bearBottom = c0.high;
          const cLow = Math.max(bullBottom, bearBottom);
          const cHigh = Math.min(bullTop, bearTop);

          if (cHigh > cLow + cfg.minOverlap) {
            tfObj.bprZones.push({
              id: `BPR_BTC_BEAR_${Date.now()}`,
              type: 'BEARISH',
              top: cHigh,
              bottom: cLow,
              ce50: (cHigh + cLow) / 2,
              createdIndex: n - 1,
              tested: false
            });
            break;
          }
        }
      }
    }

    if (tfObj.bprZones.length > 50) {
      tfObj.bprZones = tfObj.bprZones.slice(-50);
    }
  }

  scanAllBprZones(tfObj) {
    tfObj.bprZones = [];
    const candles = tfObj.candles;
    const cfg = tfObj.config;
    for (let idx = 4; idx < candles.length; idx++) {
      const c0 = candles[idx];
      const c2 = candles[idx - 2];
      const isBearishFVG = (c2.low - c0.high) >= cfg.minFvgGap;
      const isBullishFVG = (c0.low - c2.high) >= cfg.minFvgGap;
      if (isBearishFVG) c0._isBearish = true;
      if (isBullishFVG) c0._isBullish = true;

      if (isBullishFVG) {
        for (let j = idx - 1; j >= Math.max(0, idx - cfg.lookback); j--) {
          if (candles[j]._isBearish) {
            const bearTop = candles[j - 2] ? candles[j - 2].low : candles[j].high + cfg.minFvgGap;
            const bearBottom = candles[j].high;
            const bullTop = c0.low;
            const bullBottom = c2.high;
            const cLow = Math.max(bearBottom, bullBottom);
            const cHigh = Math.min(bearTop, bullTop);
            if (cHigh > cLow + cfg.minOverlap) {
              tfObj.bprZones.push({
                id: `BPR_BTC_BULL_${idx}`,
                type: 'BULLISH',
                top: cHigh,
                bottom: cLow,
                ce50: (cHigh + cLow) / 2,
                createdIndex: idx,
                tested: false
              });
              break;
            }
          }
        }
      }

      if (isBearishFVG) {
        for (let j = idx - 1; j >= Math.max(0, idx - cfg.lookback); j--) {
          if (candles[j]._isBullish) {
            const bullTop = candles[j].low;
            const bullBottom = candles[j - 2] ? candles[j - 2].high : candles[j].low - cfg.minFvgGap;
            const bearTop = c2.low;
            const bearBottom = c0.high;
            const cLow = Math.max(bullBottom, bearBottom);
            const cHigh = Math.min(bullTop, bearTop);
            if (cHigh > cLow + cfg.minOverlap) {
              tfObj.bprZones.push({
                id: `BPR_BTC_BEAR_${idx}`,
                type: 'BEARISH',
                top: cHigh,
                bottom: cLow,
                ce50: (cHigh + cLow) / 2,
                createdIndex: idx,
                tested: false
              });
              break;
            }
          }
        }
      }
    }
  }

  checkBOS(candles, targetDirection, options = {}) {
    const lookbackBars = options.lookbackBars || 45;
    const pivotBars = options.pivotBars || 2;
    const decimals = 1;

    if (!candles || candles.length < (pivotBars * 2 + 5)) {
      return { ok: false, detail: 'Insuficientes velas para BOS' };
    }

    const n = candles.length;
    const startIdx = Math.max(pivotBars, n - lookbackBars);
    const endIdx = n - pivotBars - 1;

    const swingHighs = [];
    const swingLows = [];

    for (let i = startIdx; i <= endIdx; i++) {
      let isHigh = true;
      let isLow = true;
      for (let j = 1; j <= pivotBars; j++) {
        if (candles[i].high < candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
        if (candles[i].low > candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
      }
      if (isHigh) {
        swingHighs.push({ price: candles[i].high, time: candles[i].time, index: i });
      }
      if (isLow) {
        swingLows.push({ price: candles[i].low, time: candles[i].time, index: i });
      }
    }

    const isBuy = targetDirection === 'BUY' || targetDirection === 'BULLISH';
    const isSell = targetDirection === 'SELL' || targetDirection === 'BEARISH';

    if (isBuy) {
      let validBos = null;

      for (let s = swingHighs.length - 1; s >= 0; s--) {
        const sh = swingHighs[s];
        for (let i = sh.index + 1; i < n; i++) {
          if (candles[i].close > sh.price) {
            const priorLows = swingLows.filter(sl => sl.index <= i && sl.index >= sh.index - 15);
            const originLow = priorLows.length > 0 ? priorLows.reduce((min, cur) => cur.price < min.price ? cur : min, priorLows[0]) : null;

            let invalidated = false;
            if (originLow) {
              for (let k = i + 1; k < n; k++) {
                if (candles[k].close < originLow.price) {
                  invalidated = true;
                  break;
                }
              }
            }

            if (!invalidated) {
              validBos = {
                brokenHigh: sh,
                breakIndex: i,
                originLow
              };
              break;
            }
          }
        }
        if (validBos) break;
      }

      if (!validBos) {
        const lastSh = swingHighs[swingHighs.length - 1];
        return {
          ok: false,
          detail: lastSh ? `Pendiente BOS Alcista (Swing ${lastSh.price.toFixed(decimals)})` : 'Sin Swing High previo',
          pivotPrice: lastSh ? lastSh.price : 0
        };
      }

      return {
        ok: true,
        detail: `Confirmado BOS Alcista (Rotura ${validBos.brokenHigh.price.toFixed(decimals)})`,
        pivotPrice: validBos.brokenHigh.price,
        originLow: validBos.originLow ? validBos.originLow.price : null
      };
    }

    if (isSell) {
      let validBos = null;

      for (let s = swingLows.length - 1; s >= 0; s--) {
        const sl = swingLows[s];
        for (let i = sl.index + 1; i < n; i++) {
          if (candles[i].close < sl.price) {
            const priorHighs = swingHighs.filter(sh => sh.index <= i && sh.index >= sl.index - 15);
            const originHigh = priorHighs.length > 0 ? priorHighs.reduce((max, cur) => cur.price > max.price ? cur : max, priorHighs[0]) : null;

            let invalidated = false;
            if (originHigh) {
              for (let k = i + 1; k < n; k++) {
                if (candles[k].close > originHigh.price) {
                  invalidated = true;
                  break;
                }
              }
            }

            if (!invalidated) {
              validBos = {
                brokenLow: sl,
                breakIndex: i,
                originHigh
              };
              break;
            }
          }
        }
        if (validBos) break;
      }

      if (!validBos) {
        const lastSl = swingLows[swingLows.length - 1];
        return {
          ok: false,
          detail: lastSl ? `Pendiente BOS Bajista (Swing ${lastSl.price.toFixed(decimals)})` : 'Sin Swing Low previo',
          pivotPrice: lastSl ? lastSl.price : 0
        };
      }

      return {
        ok: true,
        detail: `Confirmado BOS Bajista (Rotura ${validBos.brokenLow.price.toFixed(decimals)})`,
        pivotPrice: validBos.brokenLow.price,
        originHigh: validBos.originHigh ? validBos.originHigh.price : null
      };
    }

    return { ok: false, detail: 'Dirección no válida' };
  }

  checkSignal(tfObj, candle) {
    const cfg = tfObj.config;
    const candleRange = candle.high - candle.low;
    if (candleRange < cfg.minRange) return;

    for (let z = tfObj.bprZones.length - 1; z >= 0; z--) {
      const bpr = tfObj.bprZones[z];
      if (bpr.tested) continue;
      const age = tfObj.candles.length - 1 - bpr.createdIndex;
      if (age > 200) { bpr.tested = true; continue; }

      // Señal BUY (Retesteo Bullish BPR)
      if (bpr.type === 'BULLISH') {
        if (candle.low <= bpr.top && candle.low >= bpr.bottom - cfg.bufferPts) {
          const lowerWick = Math.min(candle.open, candle.close) - candle.low;
          if ((lowerWick / candleRange) < cfg.wickPct) continue;
          if (candle.ema100 && candle.close < candle.ema100) continue; // Filtro tendencial

          // 🛡️ CONTROL BOS INSTITUCIONAL PREVIO A ENTRAR EN BPR
          const bosCheck = this.checkBOS(tfObj.candles, 'BULLISH', { symbol: 'BTCUSD' });
          if (!bosCheck.ok) {
            continue;
          }

          bpr.tested = true;
          const entry = candle.close;
          const sl = bpr.bottom - cfg.bufferPts;
          const slDist = Math.abs(entry - sl);

          if (slDist < cfg.slMinPts || slDist > cfg.slMaxPts) continue;

          const tpDist = slDist * cfg.rrRatio;
          const tp = entry + tpDist;

          this.openTrade('BUY', entry, sl, tp, slDist, candle.time);
          break;
        }
      }

      // Señal SELL (Retesteo Bearish BPR)
      if (bpr.type === 'BEARISH') {
        if (candle.high >= bpr.bottom && candle.high <= bpr.top + cfg.bufferPts) {
          const upperWick = candle.high - Math.max(candle.open, candle.close);
          if ((upperWick / candleRange) < cfg.wickPct) continue;
          if (candle.ema100 && candle.close > candle.ema100) continue; // Filtro tendencial

          // 🛡️ CONTROL BOS INSTITUCIONAL PREVIO A ENTRAR EN BPR
          const bosCheck = this.checkBOS(tfObj.candles, 'SELL', { symbol: 'BTCUSD' });
          if (!bosCheck.ok) {
            continue;
          }

          bpr.tested = true;
          const entry = candle.close;
          const sl = bpr.top + cfg.bufferPts;
          const slDist = Math.abs(sl - entry);

          if (slDist < cfg.slMinPts || slDist > cfg.slMaxPts) continue;

          const tpDist = slDist * cfg.rrRatio;
          const tp = entry - tpDist;

          this.openTrade('SELL', entry, sl, tp, slDist, candle.time);
          break;
        }
      }
    }
  }

  openTrade(type, entryPrice, stopLoss, takeProfit, slPts, timeMs) {
    const hasAnyActiveTrade = this.activeTrades.some(t => 
      (t.symbol === 'BTCUSD' || t.symbol === 'BTCUSDT') && t.status === 'OPEN'
    );
    if (hasAnyActiveTrade) {
      console.log(`\n⚠️ [BPR BTCUSD Anti-Stacking] Señal ${type} OMITIDA: Ya existe una operación activa en BTCUSD.`);
      return;
    }

    const tradeId = `BPR_BTCUSD_M15_${Date.now()}`;
    const tpPts = slPts * BTCUSD_CONFIG.M15.rrRatio;

    const trade = {
      id: tradeId,
      timeframe: 'M15',
      symbol: 'BTCUSD',
      type: type,
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
    console.log(`\n🪙 [BPR BTCUSD M15] SEÑAL ${type} DETECTADA: ${type} @ ${trade.entryPrice} | SL: ${trade.initialSL} (${trade.slPoints} pts) | TP: ${trade.tpPrice} (${trade.tpPoints} pts) | R:R 1:${BTCUSD_CONFIG.M15.rrRatio}`);

    if (this.isLiveExecution && this.executionHandler) {
      try {
        const orderPayload = {
          valid: true,
          action: type,
          symbol: 'BTCUSD',
          entryPrice: trade.entryPrice,
          slPrice: trade.initialSL,
          tp1Price: trade.tpPrice,
          targetTP: trade.tpPrice,
          channelId: 'BPR_BTCUSD_M15',
          channelName: 'BPR Sniper BTCUSD [M15 Weekend]',
          comment: `BPR BTCUSD M15`,
          isReducedRisk: false
        };

        this.executionHandler(orderPayload).then(success => {
          if (success) {
            console.log(`🚀 [BPR BTCUSD M15] Orden ${type} despachada a MT5 con éxito.`);
          }
        }).catch(err => {
          console.error(`❌ [BPR BTCUSD M15] Error en executionHandler:`, err.message);
        });
      } catch (err) {
        console.error(`❌ [BPR BTCUSD M15] Fallo despachando a MT5:`, err.message);
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

      if (trade.type === 'BUY') {
        if (currentPrice >= trade.tpPrice) {
          closed = true;
          outcome = 'WIN';
          points = trade.tpPoints;
        } else if (currentPrice <= trade.currentSL) {
          closed = true;
          outcome = 'LOSS';
          points = -trade.slPoints;
        }
      } else { // SELL
        if (currentPrice <= trade.tpPrice) {
          closed = true;
          outcome = 'WIN';
          points = trade.tpPoints;
        } else if (currentPrice >= trade.currentSL) {
          closed = true;
          outcome = 'LOSS';
          points = -trade.slPoints;
        }
      }

      if (closed) {
        trade.status = outcome;
        trade.closePrice = currentPrice;
        trade.closeTime = new Date().toISOString();
        trade.points = parseFloat(points.toFixed(1));

        this.history.push(trade);
        this.updateMetrics(trade);

        console.log(`\n🔔 [BPR BTCUSD M15] Trade cerrado: ${outcome} (${points > 0 ? '+' : ''}${trade.points} pts)`);
      } else {
        remainingTrades.push(trade);
      }
    }

    this.activeTrades = remainingTrades;
    if (this.activeTrades.length === 0) this.saveState();
  }

  updateMetrics(trade) {
    this.metrics.totalTrades++;
    if (trade.status === 'WIN') {
      this.metrics.wins++;
      this.metrics.grossWon += trade.points;
    } else {
      this.metrics.losses++;
      this.metrics.grossLost += Math.abs(trade.points);
    }

    this.metrics.winRate = parseFloat(((this.metrics.wins / this.metrics.totalTrades) * 100).toFixed(1));
    this.metrics.netPoints = parseFloat((this.metrics.grossWon - this.metrics.grossLost).toFixed(1));
    this.metrics.profitFactor = this.metrics.grossLost > 0
      ? parseFloat((this.metrics.grossWon / this.metrics.grossLost).toFixed(2))
      : 99.0;

    if (this.metrics.netPoints > this.metrics.peakPoints) {
      this.metrics.peakPoints = this.metrics.netPoints;
    }
    const currentDd = this.metrics.peakPoints - this.metrics.netPoints;
    if (currentDd > this.metrics.maxDrawdownPoints) {
      this.metrics.maxDrawdownPoints = currentDd;
    }
  }
}

const bprStrategyBTCUSD = new BPRBtcUsdWeekendStrategy({ isLiveExecution: true });

module.exports = {
  BPRBtcUsdWeekendStrategy,
  bprStrategyBTCUSD
};
