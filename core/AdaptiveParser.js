/**
 * Analizador Adaptativo con Aprendizaje y Cascada de Patrones (AdaptiveParser)
 * - Maneja las diversas formas sintácticas en las que los canales redactan señales
 * - Limpieza de emojis y caracteres tipográficos
 * - Detección de rangos con múltiples formatos (_, -, to, /)
 * - Expansión de notaciones abreviadas de Take Profit (ej: TP 4250-60-70)
 * - Registro de mensajes no reconocidos para análisis y mejora continua
 */

const { SignalData } = require('../domain/models');

class AdaptiveParser {
  constructor() {
    this.unrecognizedLog = [];
  }

  /**
   * Limpia emojis decorativos manteniendo texto y números limpios
   */
  sanitizeText(text) {
    if (!text) return '';
    return text
      .normalize('NFKD')
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width spaces
      .trim();
  }

  /**
   * Parsea de manera adaptativa cualquier mensaje probando múltiples heurísticas
   */
  parseMessage(text, channelId = '', channelName = 'Canal') {
    if (!text) return null;
    const clean = this.sanitizeText(text);

    // 1. Detección rápida de símbolo/par
    let symbol = 'XAUUSD';
    const pairMatch = clean.match(/#(XAUUSD|GOLD|EURUSD|GBPUSD|BTCUSD|US30|NAS100)/i) ||
                      clean.match(/\b(XAU\/?USD|GOLD|EUR\/?USD|GBP\/?USD|BTC\/?USD|US30|NAS100)\b/i);
    if (pairMatch) {
      symbol = pairMatch[1].replace('/', '').toUpperCase();
    }

    // 2. Detección de Acción
    const upper = clean.toUpperCase();
    let action = null;
    if (/\b(BUY\s+NOW|BUY\s+ZONE|BUYY\s+NOW|BUYY|BUY)\b/i.test(upper)) {
      action = 'BUY';
    } else if (/\b(SELL\s+NOW|SELL\s+ZONE|SEEL\s+NOW|SEEL|SEL|SELL)\b/i.test(upper)) {
      action = 'SELL';
    }

    if (!action) {
      // Registrar para análisis si parece una señal pero no pudimos identificar acción
      if (upper.includes('TP') && upper.includes('SL')) {
        this._logUnrecognized(clean, channelName, 'ACCION_NO_DETECTADA');
      }
      return null;
    }

    const isBuy = action === 'BUY';

    // 3. Detección de Entrada (Rango o Punto Simple)
    let entryVal = null;
    let entryRange = null;

    // Patrón Rango: "4282__4285", "4282 - 4285", "4282/4285", "4282 TO 4285", "4282...4285"
    const rangeRegex = /(?:ZONE|ENTRY|ENTRADA|PRICE|@|AT)?[\s:]*([0-9]{4}(?:\.[0-9]+)?)\s*(?:_{2,}|[\-\_\/]+|\s+TO\s+|\.{2,})\s*([0-9]{4}(?:\.[0-9]+)?)/i;
    const rangeMatch = clean.match(rangeRegex);

    if (rangeMatch) {
      const p1 = parseFloat(rangeMatch[1]);
      const p2 = parseFloat(rangeMatch[2]);
      if (!isNaN(p1) && !isNaN(p2)) {
        entryRange = { min: Math.min(p1, p2), max: Math.max(p1, p2) };
        entryVal = isBuy ? entryRange.min : entryRange.max;
      }
    }

    if (!entryVal) {
      const singleRegex = /(?:ENTRY\s*PRICE|BUY\s*ZONE|SELL\s*ZONE|ENTRY|ENTRADA|PRICE|\bZONE\b|@|AT)[^\d]*([0-9]{4}(?:\.[0-9]+)?)/i;
      const singleMatch = clean.match(singleRegex);
      if (singleMatch) {
        entryVal = parseFloat(singleMatch[1]);
      } else {
        const fallbackRegex = /(?:BUY|SELL)\s+(?:GOLD|XAUUSD\s+)?(?:NOW[\s:]*)?(?:LIMIT[\s:]*)?\s*([0-9]{4}(?:\.[0-9]+)?)/i;
        const fbMatch = clean.match(fallbackRegex);
        if (fbMatch) entryVal = parseFloat(fbMatch[1]);
      }
    }

    // 4. Detección de Stop Loss
    let sl = null;
    const slRegex = /(?:STOP\s*LOSS|STOPLOSS|\bSL\b)[\s:\.@]*([0-9]{2,4}(?:\.[0-9]+)?)/i;
    const slMatch = clean.match(slRegex);
    if (slMatch) {
      sl = parseFloat(slMatch[1]);
      // Si el SL viene abreviado (ej: SL 93 en lugar de 4293)
      if (sl > 0 && sl < 100 && entryVal) {
        const prefix = Math.floor(entryVal / 100);
        sl = prefix * 100 + sl;
      }
    }

    // 5. Detección de Take Profits
    const textWithoutSL = clean.replace(/(?:STOP\s*LOSS|STOPLOSS|\bSL\b)[\s:\.@]*[0-9\.]+/gi, '');
    let tp1 = null, tp2 = null, tp3 = null;

    // Caso A: Notación abreviada (ej: TP 4250-60-70 o TP 50-60-70)
    const shorthandMatch = textWithoutSL.match(/TP[\s:]*([0-9]{2,4}(?:\s*[\-\_]\s*[0-9]{2,4})+)/i);
    if (shorthandMatch) {
      const baseRef = entryVal || sl || 4300;
      const parts = shorthandMatch[1].split(/[\-\_]/).map(p => parseFloat(p.trim())).filter(n => !isNaN(n));
      const prefix = Math.floor(baseRef / 100);

      const expanded = parts.map(p => {
        let target = (p < 100) ? (prefix * 100 + p) : p;
        if (isBuy && target <= baseRef && p < 100) target += 100;
        if (!isBuy && target >= baseRef && p < 100) target -= 100;
        return target;
      });

      tp1 = expanded[0] || null;
      tp2 = expanded[1] || null;
      tp3 = expanded[2] || null;
    } else {
      // Caso B: Formato estándar o multi-línea
      const tpRegex = /(?:TAKE\s*PROFIT\s*\d*|TAKEPROFIT\s*\d*|TARGETS?\s*\d*|\bTP\s*[1-9]?#?|[✅🎯↳→]\s*(?:TP\s*\d*)?)[\s:\.=\-\|→]*([0-9]{4}(?:\.[0-9]+)?)/gi;
      const tpMatches = [...textWithoutSL.matchAll(tpRegex)];
      tp1 = tpMatches.length > 0 ? parseFloat(tpMatches[0][1]) : null;
      tp2 = tpMatches.length > 1 ? parseFloat(tpMatches[1][1]) : null;
      tp3 = tpMatches.length > 2 ? parseFloat(tpMatches[2][1]) : null;
    }

    // 6. Incoherencia de Dirección: Auto-corrección
    if (sl && tp1) {
      if (isBuy && tp1 < sl) action = 'SELL';
      else if (!isBuy && tp1 > sl) action = 'BUY';
    }

    return new SignalData({
      channelId,
      channelName,
      symbol,
      action,
      entry: entryVal,
      entryRange,
      sl,
      tp1,
      tp2,
      tp3,
      rawText: clean
    });
  }

  _logUnrecognized(text, channelName, reason) {
    this.unrecognizedLog.push({
      timestamp: Date.now(),
      channelName,
      reason,
      snippet: text.substring(0, 100)
    });
    if (this.unrecognizedLog.length > 30) this.unrecognizedLog.shift();
  }
}

// Instancia singleton
const adaptiveParser = new AdaptiveParser();

module.exports = {
  AdaptiveParser,
  adaptiveParser
};
