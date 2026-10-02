/**
 * Estrategia Algorítmica Institucional Propia: XAUUSD Smart Money Concepts (SMC) + Liquidity Sweep
 * 
 * Principios Cuantitativos:
 * 1. Detección de Rango de Liquidez Asiático (00:00 - 07:00 UTC) -> Asian High (Buy-Side Liquidity) / Asian Low (Sell-Side Liquidity).
 * 2. Caza de Liquidez (Liquidity Sweep / Judas Swing) durante aperturas de Londres (07:00 - 11:30 UTC) o New York (12:30 - 16:30 UTC).
 * 3. Cambio de Estructura de Mercado (Market Structure Shift / MSS) o Imbalance (Fair Value Gap - FVG).
 * 4. Stop Loss milimétrico en el extremo del sweep (15 - 25 pips).
 * 5. Objetivos de Take Profit asimétricos (R:R mínimo 1:1.5 para TP1, 1:2.5 para TP2, 1:4+ para TP3/Opposing Pool).
 */

class GoldSMCStrategy {
  constructor(options = {}) {
    this.name = 'GoldSMC_Institutional';
    this.symbol = options.symbol || 'XAUUSD';
    this.minSweepPips = options.minSweepPips || 5.0; // Mínimo 5 pips de barrido
    this.maxSweepPips = options.maxSweepPips || 35.0; // Máximo 35 pips para no entrar en tendencia desbocada
    this.slBufferPips = options.slBufferPips || 4.0; // Margen de seguridad sobre el extremo del sweep
    this.riskRewardTP1 = options.riskRewardTP1 || 1.5;
    this.riskRewardTP2 = options.riskRewardTP2 || 2.5;
    this.riskRewardTP3 = options.riskRewardTP3 || 4.0;
  }

  /**
   * Determina la sesión de una fecha en UTC
   */
  getSession(dateObj) {
    const hours = dateObj.getUTCHours();
    const minutes = dateObj.getUTCMinutes();
    const timeVal = hours + minutes / 60.0;

    if (timeVal >= 0.0 && timeVal < 7.0) return 'ASIA';
    if (timeVal >= 7.0 && timeVal < 12.0) return 'LONDON';
    if (timeVal >= 12.0 && timeVal < 18.0) return 'NEW_YORK';
    return 'OFF_SESSION';
  }

  /**
   * Analiza una serie temporal de velas M5/M15 y genera señales algorítmicas de alta probabilidad
   * @param {Array} candles - Array de objetos { time, open, high, low, close, volume }
   * @returns {Array} Array de señales generadas
   */
  analyzeCandles(candles) {
    const signals = [];
    if (!candles || candles.length < 50) return signals;

    let currentAsianHigh = null;
    let currentAsianLow = null;
    let currentDayStr = null;
    let sessionCandles = { ASIA: [], LONDON: [], NEW_YORK: [] };
    let sweptHigh = false;
    let sweptLow = false;
    let sweepHighCandle = null;
    let sweepLowCandle = null;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const date = new Date(c.time);
      const dayStr = date.toISOString().split('T')[0];
      const session = this.getSession(date);

      // Nuevo día de trading: Reiniciar niveles clave
      if (dayStr !== currentDayStr) {
        currentDayStr = dayStr;
        currentAsianHigh = null;
        currentAsianLow = null;
        sweptHigh = false;
        sweptLow = false;
        sweepHighCandle = null;
        sweepLowCandle = null;
        sessionCandles = { ASIA: [], LONDON: [], NEW_YORK: [] };
      }

      // 1. Acumular y calcular rango de liquidez asiático
      if (session === 'ASIA') {
        sessionCandles.ASIA.push(c);
        if (currentAsianHigh === null || c.high > currentAsianHigh) currentAsianHigh = c.high;
        if (currentAsianLow === null || c.low < currentAsianLow) currentAsianLow = c.low;
        continue;
      }

      // Si no tenemos rango asiático completo (mínimo 6 velas M15 o 18 M5), saltar
      if (!currentAsianHigh || !currentAsianLow || sessionCandles.ASIA.length < 10) {
        continue;
      }

      // 2. Durante sesiones activas (Londres o NY), buscar barridos de liquidez (Sweeps)
      if (session === 'LONDON' || session === 'NEW_YORK') {
        // --- ESCENARIO VENTA (BEARISH SMC): BARRIDO DE MÁXIMOS ASIÁTICOS ---
        if (!sweptHigh && c.high > currentAsianHigh) {
          const sweepDist = (c.high - currentAsianHigh) * 10.0;
          if (sweepDist >= this.minSweepPips && sweepDist <= this.maxSweepPips) {
            sweptHigh = true;
            sweepHighCandle = c;
          }
        }

        // Si barrió el máximo y la vela actual o siguiente cierra por debajo con rechazo (MSS)
        if (sweptHigh && sweepHighCandle && (i - candles.indexOf(sweepHighCandle)) <= 4) {
          const prevCandle = candles[i - 1];
          // Confirmación: Cierre por debajo de la apertura de la vela de impulso o vela envolvente bajista
          const isBearishRejection = (c.close < c.open && c.close < currentAsianHigh) ||
                                     (c.close < prevCandle.low && c.open >= c.close);

          if (isBearishRejection) {
            const entryPrice = c.close;
            const slPrice = parseFloat((sweepHighCandle.high + (this.slBufferPips / 10.0)).toFixed(2));
            const riskPips = Math.abs(slPrice - entryPrice) * 10.0;

            // Filtro de riesgo estricto (10 a 35 pips de SL)
            if (riskPips >= 10.0 && riskPips <= 35.0) {
              const tp1Dist = (riskPips * this.riskRewardTP1) / 10.0;
              const tp2Dist = (riskPips * this.riskRewardTP2) / 10.0;
              const tp3Dist = (riskPips * this.riskRewardTP3) / 10.0;

              signals.push({
                index: i,
                time: c.time,
                timeStr: date.toISOString().replace('T', ' ').substring(0, 19),
                session,
                type: 'SMC_LIQUIDITY_SWEEP_BEARISH',
                symbol: this.symbol,
                action: 'SELL',
                entry: entryPrice,
                sl: slPrice,
                tp1: parseFloat((entryPrice - tp1Dist).toFixed(2)),
                tp2: parseFloat((entryPrice - tp2Dist).toFixed(2)),
                tp3: parseFloat((entryPrice - tp3Dist).toFixed(2)),
                riskPips: parseFloat(riskPips.toFixed(1)),
                asianHigh: currentAsianHigh,
                asianLow: currentAsianLow,
                reason: `Barrido de liquidez asiática (+${((sweepHighCandle.high - currentAsianHigh)*10).toFixed(1)}p) + Cierre bajista MSS`
              });

              sweptHigh = false; // Evitar disparos repetidos sobre el mismo sweep
              sweepHighCandle = null;
            }
          }
        }

        // --- ESCENARIO COMPRA (BULLISH SMC): BARRIDO DE MÍNIMOS ASIÁTICOS ---
        if (!sweptLow && c.low < currentAsianLow) {
          const sweepDist = (currentAsianLow - c.low) * 10.0;
          if (sweepDist >= this.minSweepPips && sweepDist <= this.maxSweepPips) {
            sweptLow = true;
            sweepLowCandle = c;
          }
        }

        // Si barrió el mínimo y cierra por encima con rechazo (MSS alcista)
        if (sweptLow && sweepLowCandle && (i - candles.indexOf(sweepLowCandle)) <= 4) {
          const prevCandle = candles[i - 1];
          const isBullishRejection = (c.close > c.open && c.close > currentAsianLow) ||
                                     (c.close > prevCandle.high && c.close >= c.open);

          if (isBullishRejection) {
            const entryPrice = c.close;
            const slPrice = parseFloat((sweepLowCandle.low - (this.slBufferPips / 10.0)).toFixed(2));
            const riskPips = Math.abs(entryPrice - slPrice) * 10.0;

            if (riskPips >= 10.0 && riskPips <= 35.0) {
              const tp1Dist = (riskPips * this.riskRewardTP1) / 10.0;
              const tp2Dist = (riskPips * this.riskRewardTP2) / 10.0;
              const tp3Dist = (riskPips * this.riskRewardTP3) / 10.0;

              signals.push({
                index: i,
                time: c.time,
                timeStr: date.toISOString().replace('T', ' ').substring(0, 19),
                session,
                type: 'SMC_LIQUIDITY_SWEEP_BULLISH',
                symbol: this.symbol,
                action: 'BUY',
                entry: entryPrice,
                sl: slPrice,
                tp1: parseFloat((entryPrice + tp1Dist).toFixed(2)),
                tp2: parseFloat((entryPrice + tp2Dist).toFixed(2)),
                tp3: parseFloat((entryPrice + tp3Dist).toFixed(2)),
                riskPips: parseFloat(riskPips.toFixed(1)),
                asianHigh: currentAsianHigh,
                asianLow: currentAsianLow,
                reason: `Barrido de liquidez asiática (-${((currentAsianLow - sweepLowCandle.low)*10).toFixed(1)}p) + Cierre alcista MSS`
              });

              sweptLow = false;
              sweepLowCandle = null;
            }
          }
        }
      }
    }

    return signals;
  }
}

module.exports = {
  GoldSMCStrategy
};
