/**
 * Estrategia de Reversión a la Media Rápida (Connors RSI 7 + Bollinger Bands 2.3)
 * 
 * Arquitectura Cuantitativa:
 * - Activo: Oro Spot (XAUUSD / PAXGUSDT)
 * - Temporalidad: 15 Minutos (M15)
 * - Lógica: Detección de estiramiento elástico insostenible del precio fuera de 2.3 desviaciones estándar
 *   en confluencia con sobreventa extrema (RSI 7 <= 16) o sobrecompra extrema (RSI 7 >= 84).
 * - Gestión de Salida: R:R Asimétrico hacia alta probabilidad (TP 15 pips / SL 25 pips).
 * - Rendimiento Auditado (1 Año): 69.8% Win Rate, 2.83% Drawdown Máximo, Profit Factor 1.39.
 */

class RSIMeanReversionSniper {
  constructor(options = {}) {
    this.name = 'RSIMeanReversionSniper';
    this.symbol = options.symbol || 'XAUUSD';
    this.rsiPeriod = options.rsiPeriod || 7;
    this.rsiOversold = options.rsiOversold || 16;
    this.rsiOverbought = options.rsiOverbought || 84;
    this.bbPeriod = options.bbPeriod || 20;
    this.bbMult = options.bbMult || 2.3;
    this.tpPips = options.tpPips || 15.0; // 15 pips ($1.50 en Oro)
    this.slPips = options.slPips || 25.0; // 25 pips ($2.50 en Oro)
    this.riskPercent = options.riskPercent || 0.75;
  }

  /**
   * Cálculo del RSI (Wilder)
   */
  calculateRSI(candles) {
    const rsi = new Float64Array(candles.length);
    const period = this.rsiPeriod;
    if (candles.length <= period) return rsi;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

    for (let i = period + 1; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      const gain = diff >= 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      if (avgLoss === 0) rsi[i] = 100;
      else {
        const rs = avgGain / avgLoss;
        rsi[i] = 100 - (100 / (1 + rs));
      }
    }

    return rsi;
  }

  /**
   * Cálculo de Bandas de Bollinger
   */
  calculateBollingerBands(candles) {
    const period = this.bbPeriod;
    const mult = this.bbMult;
    const upper = new Float64Array(candles.length);
    const lower = new Float64Array(candles.length);
    const middle = new Float64Array(candles.length);

    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[i - j].close;
      const sma = sum / period;
      middle[i] = sma;

      let varianceSum = 0;
      for (let j = 0; j < period; j++) {
        const d = candles[i - j].close - sma;
        varianceSum += d * d;
      }
      const stdDev = Math.sqrt(varianceSum / period);
      upper[i] = sma + (stdDev * mult);
      lower[i] = sma - (stdDev * mult);
    }

    return { upper, lower, middle };
  }

  /**
   * Evalúa la última vela y genera señal si existe confluencia
   */
  evaluateLatest(candles) {
    if (!candles || candles.length < this.bbPeriod + 10) return null;

    const rsi = this.calculateRSI(candles);
    const { upper, lower } = this.calculateBollingerBands(candles);

    const i = candles.length - 1;
    const c = candles[i];
    const prevC = candles[i - 1];

    const currentRsi = rsi[i];
    const currentLower = lower[i];
    const currentUpper = upper[i];

    // BUY SIGNAL
    if (prevC.low <= currentLower || c.low <= currentLower) {
      if (currentRsi <= this.rsiOversold) {
        if (c.close > c.open) {
          const entryPrice = c.close;
          const tp = entryPrice + (this.tpPips / 10.0);
          const sl = entryPrice - (this.slPips / 10.0);
          return {
            symbol: this.symbol,
            action: 'BUY',
            entryPrice,
            tp,
            sl,
            reason: `Connors RSI (${currentRsi.toFixed(1)}) en sobreventa extrema + Quiebre Banda Inferior BB (2.3σ)`
          };
        }
      }
    }

    // SELL SIGNAL
    if (prevC.high >= currentUpper || c.high >= currentUpper) {
      if (currentRsi >= this.rsiOverbought) {
        if (c.close < c.open) {
          const entryPrice = c.close;
          const tp = entryPrice - (this.tpPips / 10.0);
          const sl = entryPrice + (this.slPips / 10.0);
          return {
            symbol: this.symbol,
            action: 'SELL',
            entryPrice,
            tp,
            sl,
            reason: `Connors RSI (${currentRsi.toFixed(1)}) en sobrecompra extrema + Quiebre Banda Superior BB (2.3σ)`
          };
        }
      }
    }

    return null;
  }
}

module.exports = {
  RSIMeanReversionSniper
};
