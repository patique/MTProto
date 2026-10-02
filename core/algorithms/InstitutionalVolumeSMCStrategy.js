/**
 * ESTRATEGIA ALGORÍTMICA MAESTRA INSTITUCIONAL:
 * Institutional Volume Profile & Smart Money Confluence Strategy (IVP-SMC)
 * 
 * Diseñada para Cuentas Propias y Cuentas de Fondeo (Prop Firms).
 * 
 * PILARES DE CONFLUENCIA INSTITUCIONAL:
 * 1. Volume Profile Session Auction (POC, VAH, VAL en H1/M30).
 * 2. Filtro Macro de Tendencia Multi-Temporal (EMA 50 / 100 / 200).
 * 3. Filtro de Amplitud de Rango Asiático (Filtro Anti-Choppiness y Anti-Desbocado).
 * 4. Gestión de Órdenes Límite Sniper en el POC con Expiración Horaria (Pre-Wall Street).
 * 5. Salidas Asimétricas con Auto Break-Even y Expansión Institucional (TP1 50% + TP2 50%).
 * 6. Motor Dual de Gestión de Capital: Riesgo Fijo de Fondeo vs Interés Compuesto Dinámico.
 */

class InstitutionalVolumeSMCStrategy {
  constructor(options = {}) {
    this.name = 'InstitutionalVolumeSMC_Master';
    this.symbol = options.symbol || 'XAUUSD';
    
    // Parámetros de Subasta de Volumen
    this.binSize = options.binSize || 0.50; // $0.50 por bin en Oro
    this.valueAreaRatio = options.valueAreaRatio || 0.70; // 70% del volumen negociado
    this.minAreaSpan = options.minAreaSpan || 4.0; // Descartar días planos (< $4.00)
    this.maxAreaSpan = options.maxAreaSpan || 18.0; // Descartar días desbocados (> $18.00)

    // Parámetros de Stop Loss y Toma de Beneficios
    this.slAir = options.slAir || 1.50; // Margen de seguridad sobre VAL/VAH ($1.50 = 15 pips)
    this.tp2Extension = options.tp2Extension || 1.40; // 1.40x expansión sobre el área de valor
    this.tp1VolumeRatio = options.tp1VolumeRatio !== undefined ? options.tp1VolumeRatio : 0.50; // 50% en TP1

    // Filtros de Tendencia y Tiempo
    this.useTrendFilter = options.useTrendFilter !== undefined ? options.useTrendFilter : true;
    this.emaPeriod = options.emaPeriod || 100;
    this.maxFillHourUTC = options.maxFillHourUTC || 14; // Cancelar límites si no se llenan a las 14:00 UTC

    // Modo de Gestión de Capital
    this.compounding = options.compounding || false; // true = Interés compuesto dinámico
    this.riskPercent = options.riskPercent || 0.75; // 0.75% por trade
  }

  /**
   * Calcula el Perfil de Volumen de una serie de velas
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
   * Calcula la Media Móvil Exponencial (EMA)
   */
  calculateEMA(candles, period) {
    const ema = new Float64Array(candles.length);
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < Math.min(period, candles.length); i++) sum += candles[i].close;
    let prevEma = sum / Math.min(period, candles.length);
    ema[Math.min(period, candles.length) - 1] = prevEma;
    for (let i = period; i < candles.length; i++) {
      prevEma = (candles[i].close - prevEma) * k + prevEma;
      ema[i] = prevEma;
    }
    return ema;
  }

  /**
   * Evalúa la sesión diaria y genera la orden límite institucional
   */
  evaluateDaySetup(dayCandles, emaValue) {
    // 1. Filtrar acumulación asiática (00:00 - 07:00 UTC)
    const asianCandles = dayCandles.filter(c => {
      const h = new Date(c.time).getUTCHours();
      return h >= 0 && h < 7;
    });

    if (asianCandles.length < 3) return null;

    const profile = this.calculateProfile(asianCandles);
    if (!profile) return null;

    const { poc, vah, val } = profile;
    const valueAreaSpan = vah - val;

    // Filtros de amplitud
    if (valueAreaSpan < this.minAreaSpan || valueAreaSpan > this.maxAreaSpan) return null;

    // 2. Apertura de Londres (07:00 UTC)
    const londonOpenCandle = dayCandles.find(c => new Date(c.time).getUTCHours() === 7);
    if (!londonOpenCandle) return null;

    let orderType = null;
    let limitPrice = poc;
    let slPrice = 0;
    let tp1Price = 0;
    let tp2Price = 0;

    // Intención compradora (Precio > POC)
    if (londonOpenCandle.close >= poc) {
      if (this.useTrendFilter && londonOpenCandle.close < emaValue) return null; // Filtro de tendencia

      orderType = 'BUY_LIMIT';
      slPrice = parseFloat((val - this.slAir).toFixed(2));
      tp1Price = vah;
      const baseSpan = vah - poc;
      tp2Price = parseFloat((poc + baseSpan * this.tp2Extension).toFixed(2));
    } else {
      // Intención vendedora (Precio < POC)
      if (this.useTrendFilter && londonOpenCandle.close > emaValue) return null;

      orderType = 'SELL_LIMIT';
      slPrice = parseFloat((vah + this.slAir).toFixed(2));
      tp1Price = val;
      const baseSpan = poc - val;
      tp2Price = parseFloat((poc - baseSpan * this.tp2Extension).toFixed(2));
    }

    const slDistance = Math.abs(limitPrice - slPrice);
    if (slDistance <= 0) return null;

    return {
      orderType,
      limitPrice,
      slPrice,
      tp1Price,
      tp2Price,
      slDistance,
      poc,
      vah,
      val,
      londonOpenCandle
    };
  }
}

module.exports = {
  InstitutionalVolumeSMCStrategy
};
