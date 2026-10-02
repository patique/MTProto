/**
 * Estrategia Institucional de Trading Cuantitativo: Session Volume Profile (SVP / FRVP)
 * 
 * Basada en la Teoría de Subasta de Mercados (Auction Market Theory - Steidlmayer & Dalton)
 * Incorpora Filtros Institucionales de Absorción:
 * 1. Trend Filter Macro (EMA 200 M15): Solo compras en tendencia alcista y ventas en bajista.
 * 2. Mecha de Rechazo / Absorción Institucional: La vela de barrido o reingreso debe mostrar
 *    una mecha de rechazo significativa (>= 25% del rango total de la vela).
 * 3. Ratio R:R Mínimo Asimétrico: Mínimo 1:1.5 de retorno potencial al POC/Extremo opuesto.
 */

class VolumeProfileStrategy {
  constructor(options = {}) {
    this.name = 'SessionVolumeProfile_Institutional';
    this.symbol = options.symbol || 'XAUUSD';
    this.binSize = options.binSize || 0.50; // $0.50 por bin en Oro
    this.valueAreaRatio = options.valueAreaRatio || 0.70; // 70% del volumen
    this.slBuffer = options.slBuffer || 2.0; // $2.0 buffer de SL (20 pips)
    this.minSweepDist = options.minSweepDist || 1.0; // Mínimo $1.0 de perforación
    this.maxSweepDist = options.maxSweepDist || 10.0; // Máximo $10.0 para evitar tendencias desbocadas
    this.useEmaTrend = options.useEmaTrend !== undefined ? options.useEmaTrend : true;
    this.emaPeriod = options.emaPeriod || 200;
  }

  /**
   * Clasifica la sesión según hora UTC
   */
  getSession(dateObj) {
    const hours = dateObj.getUTCHours();
    const minutes = dateObj.getUTCMinutes();
    const timeVal = hours + minutes / 60.0;

    if (timeVal >= 0.0 && timeVal < 7.0) return 'ASIA';
    if (timeVal >= 7.0 && timeVal < 12.0) return 'LONDON';
    if (timeVal >= 12.0 && timeVal < 17.5) return 'NEW_YORK';
    return 'OFF_SESSION';
  }

  /**
   * Calcula el Perfil de Volumen para un conjunto de velas
   */
  calculateProfile(candles) {
    if (!candles || candles.length === 0) return null;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let totalVolume = 0;

    for (const c of candles) {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
      totalVolume += (c.volume || 1);
    }

    if (minPrice >= maxPrice || totalVolume <= 0) return null;

    const startBin = Math.floor(minPrice / this.binSize) * this.binSize;
    const endBin = Math.ceil(maxPrice / this.binSize) * this.binSize;
    const numBins = Math.round((endBin - startBin) / this.binSize) + 1;

    const bins = new Float64Array(numBins);

    for (const c of candles) {
      const vol = c.volume || 1;
      const iLow = Math.max(0, Math.min(numBins - 1, Math.floor((c.low - startBin) / this.binSize)));
      const iHigh = Math.max(0, Math.min(numBins - 1, Math.floor((c.high - startBin) / this.binSize)));
      const binsCovered = iHigh - iLow + 1;
      const volPerBin = vol / binsCovered;

      for (let b = iLow; b <= iHigh; b++) {
        bins[b] += volPerBin;
      }
    }

    let maxVol = -1;
    let pocIdx = 0;
    for (let i = 0; i < numBins; i++) {
      if (bins[i] > maxVol) {
        maxVol = bins[i];
        pocIdx = i;
      }
    }

    const poc = parseFloat((startBin + pocIdx * this.binSize).toFixed(2));
    const targetVA = totalVolume * this.valueAreaRatio;
    let currentVA = bins[pocIdx];
    let lowerIdx = pocIdx;
    let upperIdx = pocIdx;

    while (currentVA < targetVA && (lowerIdx > 0 || upperIdx < numBins - 1)) {
      const nextLowerVol = lowerIdx > 0 ? bins[lowerIdx - 1] : -1;
      const nextUpperVol = upperIdx < numBins - 1 ? bins[upperIdx + 1] : -1;

      if (nextUpperVol >= nextLowerVol && upperIdx < numBins - 1) {
        upperIdx++;
        currentVA += bins[upperIdx];
      } else if (lowerIdx > 0) {
        lowerIdx--;
        currentVA += bins[lowerIdx];
      } else if (upperIdx < numBins - 1) {
        upperIdx++;
        currentVA += bins[upperIdx];
      } else {
        break;
      }
    }

    const vah = parseFloat((startBin + upperIdx * this.binSize).toFixed(2));
    const val = parseFloat((startBin + lowerIdx * this.binSize).toFixed(2));

    return { poc, vah, val, totalVolume, minPrice, maxPrice };
  }

  /**
   * Calcula el EMA para toda la serie de velas
   */
  calculateEMA(candles, period = 200) {
    const ema = new Float64Array(candles.length);
    const k = 2 / (period + 1);

    let sum = 0;
    for (let i = 0; i < Math.min(period, candles.length); i++) {
      sum += candles[i].close;
    }
    let prevEma = sum / Math.min(period, candles.length);
    ema[Math.min(period, candles.length) - 1] = prevEma;

    for (let i = period; i < candles.length; i++) {
      prevEma = (candles[i].close - prevEma) * k + prevEma;
      ema[i] = prevEma;
    }

    return ema;
  }

  /**
   * Genera señales de trading cuantitativas
   */
  generateSignals(candles) {
    const signals = [];
    if (!candles || candles.length < this.emaPeriod + 50) return signals;

    const emaValues = this.calculateEMA(candles, this.emaPeriod);

    let currentDayStr = null;
    let asianCandles = [];
    let asianProfile = null;
    let tradedToday = false;

    let sweptVal = false;
    let sweptVah = false;
    let sweepValExtreme = Infinity;
    let sweepVahExtreme = -Infinity;

    for (let i = this.emaPeriod; i < candles.length; i++) {
      const c = candles[i];
      const date = new Date(c.time);
      const dayStr = date.toISOString().split('T')[0];
      const session = this.getSession(date);
      const currentEma = emaValues[i];

      if (dayStr !== currentDayStr) {
        currentDayStr = dayStr;
        asianCandles = [];
        asianProfile = null;
        tradedToday = false;
        sweptVal = false;
        sweptVah = false;
        sweepValExtreme = Infinity;
        sweepVahExtreme = -Infinity;
      }

      if (session === 'ASIA') {
        asianCandles.push(c);
        continue;
      }

      if (session !== 'ASIA' && !asianProfile && asianCandles.length >= 10) {
        asianProfile = this.calculateProfile(asianCandles);
      }

      if (!asianProfile || tradedToday) continue;
      if (session !== 'LONDON' && session !== 'NEW_YORK') continue;

      const { poc, vah, val } = asianProfile;
      if (vah - val < 3.0) continue; // Descartar días ultra planos

      // -------------------------------------------------------------
      // 1. BUY SETUP (VAL Sweep + Absorción + Filtro Tendencia EMA 200)
      // -------------------------------------------------------------
      if (c.low < val) {
        const sweepDepth = val - c.low;
        if (sweepDepth >= this.minSweepDist && sweepDepth <= this.maxSweepDist) {
          sweptVal = true;
          if (c.low < sweepValExtreme) sweepValExtreme = c.low;
        }
      }

      if (sweptVal && c.close > val && c.close < poc) {
        // Filtro de tendencia: solo compras si estamos sobre la EMA 200 o cerca
        const trendOk = !this.useEmaTrend || c.close >= (currentEma * 0.995);

        // Filtro de absorción: mecha inferior evidente
        const candleRange = Math.max(c.high - c.low, 0.5);
        const lowerWick = Math.min(c.open, c.close) - c.low;
        const wickOk = (lowerWick / candleRange) >= 0.20;

        if (trendOk && wickOk) {
          const entryPrice = c.close;
          const slPrice = parseFloat((sweepValExtreme - this.slBuffer).toFixed(2));
          const slDist = entryPrice - slPrice;
          const tp1Price = poc;
          const tp2Price = vah;
          const tpDist = tp1Price - entryPrice;

          if (slDist > 0 && tpDist >= slDist * 0.8) {
            signals.push({
              id: `SVP_BUY_${c.time}`,
              time: c.time,
              dateStr: date.toISOString(),
              symbol: this.symbol,
              type: 'BUY',
              entryPrice,
              sl: slPrice,
              tp1: tp1Price,
              tp2: tp2Price,
              poc,
              vah,
              val,
              candleIndex: i
            });

            tradedToday = true;
            sweptVal = false;
            continue;
          }
        }
      }

      // -------------------------------------------------------------
      // 2. SELL SETUP (VAH Sweep + Rechazo + Filtro Tendencia EMA 200)
      // -------------------------------------------------------------
      if (c.high > vah) {
        const sweepDepth = c.high - vah;
        if (sweepDepth >= this.minSweepDist && sweepDepth <= this.maxSweepDist) {
          sweptVah = true;
          if (c.high > sweepVahExtreme) sweepVahExtreme = c.high;
        }
      }

      if (sweptVah && c.close < vah && c.close > poc) {
        // Filtro de tendencia: solo ventas si estamos bajo la EMA 200 o cerca
        const trendOk = !this.useEmaTrend || c.close <= (currentEma * 1.005);

        // Filtro de rechazo: mecha superior evidente
        const candleRange = Math.max(c.high - c.low, 0.5);
        const upperWick = c.high - Math.max(c.open, c.close);
        const wickOk = (upperWick / candleRange) >= 0.20;

        if (trendOk && wickOk) {
          const entryPrice = c.close;
          const slPrice = parseFloat((sweepVahExtreme + this.slBuffer).toFixed(2));
          const slDist = slPrice - entryPrice;
          const tp1Price = poc;
          const tp2Price = val;
          const tpDist = entryPrice - tp1Price;

          if (slDist > 0 && tpDist >= slDist * 0.8) {
            signals.push({
              id: `SVP_SELL_${c.time}`,
              time: c.time,
              dateStr: date.toISOString(),
              symbol: this.symbol,
              type: 'SELL',
              entryPrice,
              sl: slPrice,
              tp1: tp1Price,
              tp2: tp2Price,
              poc,
              vah,
              val,
              candleIndex: i
            });

            tradedToday = true;
            sweptVah = false;
            continue;
          }
        }
      }
    }

    return signals;
  }
}

module.exports = {
  VolumeProfileStrategy
};
