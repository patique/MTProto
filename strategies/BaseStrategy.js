/**
 * Base Abstract Strategy (Patrón Strategy)
 * Proporciona métodos compartidos de parseo, filtros de seguridad anti-falsas entradas y detección de cancelaciones.
 */

const { SignalData, ExecutionPlan, TradeOrder } = require('../domain/models');

class BaseStrategy {
  constructor(config = {}) {
    this.config = config;
    this.channelName = config.name || 'Canal';
    this.channelId = config.id || '';
    this.preferredTP = config.preferredTP || 'TP2';
    this.allowGrid = !!config.allowGrid;
    this.pendingOrderTTLMinutes = config.pendingOrderTTLMinutes || 30;
    this.maxSlippagePips = config.maxSlippagePips || 5.0;
  }

  /**
   * Limpia zonas unidas por puntos o guiones (ej: 4330.4326 -> 4330)
   */
  cleanEntry(rawEntry) {
    if (!rawEntry) return null;
    let s = rawEntry.toString().trim();
    if (s.includes('.')) {
      const parts = s.split('.');
      if (parts[0].length === 4 && parts[1].length === 4) {
        return parseFloat(parts[0]);
      }
    }
    return parseFloat(s);
  }

  /**
   * 🛡️ FILTRO ANTI-ACTUALIZACIONES:
   * Detecta si el mensaje es un reporte de resultados (ej. "TP1 HIT 🔥", "PIPS SECURED")
   * y NO una nueva orden de entrada.
   */
  isUpdateOrResult(text) {
    if (!text) return true;
    const upper = text.toUpperCase();

    // 1. Filtro de mensajes educativos / explicaciones post-mortem (ej. "REASON BUY XAUUSD", "WHY WE TOOK")
    if (/\b(REASON\s+(?:BUY|SELL)|WHY\s+(?:I|WE)\s+TOOK|REASON\s+FOR|LESSON|EDUCATIONAL|SETUP\s+EXPLANATION|EXPLAINING|POST[\s\-]MORTEM)\b/i.test(upper)) {
      return true;
    }

    // 2. Filtro de resúmenes de ganancias / recap de pips (ej. "1st sell + 191 PIPS", "RESULTS 💯")
    if (/\b(?:\d+(?:st|nd|rd|th)\s+(?:sell|buy)|trade\s+results?|amazing\s+trade|recap\s+results?)\b/i.test(upper)) {
      return true;
    }

    // 3. Filtro de charla / hype sin niveles técnicos (ej. "Inshallah Gold Big Flying")
    if (/\b(INSHALLAH|FLYING|JUST\s+WAIT|HOLD\s+TIGHT|BE\s+PATIENT|MOON|ROCKET)\b/i.test(upper) && !/(?:STOP LOSS|SL)[\s:\.@]*([\d\.]+)/i.test(text) && !/(?:BUY\s+NOW|SELL\s+NOW)\s+[\d\.]+/i.test(text)) {
      return true;
    }

    // Palabras típicas de actualización de trade o festejo
    const hasResultKeyword = /\b(DONE|RUNNING|PIPS|PROFIT|PROFITS|HIT|REACHED|SECURE|SECURED|CLOSED?|BREAKEVEN|BREAK\s+EVEN|MOVE\s+SL|RESULTS?|WINNER|BOOM|ALL\s+TP|TP\s*\d+\s*DONE)\b/i.test(upper) ||
                             /[\+\d]+\s*PIPS|\d+\s*\+|\bTP\s*\d+\s*(?:HIT|DONE|✅)|✔️|🔥/i.test(upper);

    if (hasResultKeyword) {
      // Solo permitimos si tiene explícitamente tanto SL como ENTRADA nuevos, de lo contrario es una simple notificación
      const hasExplicitSL = /(?:STOP LOSS|STOPLOSS|SL)[\s:\.@]*([\d\.]+)/i.test(text);
      const hasExplicitEntry = /(?:ENTRY PRICE|BUY ZONE|SELL ZONE|ENTRY|ENTRADA|\bZONE\b|@|AT|BUY NOW|SELL NOW)[^\d]*([\d\.]+)/i.test(text);
      if (!hasExplicitSL || !hasExplicitEntry) {
        return true; // Es una actualización, IGNORAR
      }
    }

    // Filtro de spam / publicidad
    if (/\b(VIP|PREMIUM\s+CHANNEL|JOIN\s+VIP|CONTACT\s+ME|EQUITY|LOOSER|GUARANTEE|CRYPTO\s+PUMP)\b/i.test(upper)) {
      return true;
    }

    return false;
  }

  /**
   * 🚫 DETECTOR DE EVENTOS DE CANCELACIÓN:
   * Detecta mensajes como "CANCEL LIMITS", "NO TP HIT", "DELETE ORDERS"
   */
  isCancelMessage(text) {
    if (!text) return false;
    const upper = text.toUpperCase();
    return /\b(NO\s+TP\s+HIT|UPDATE\s+NO\s+ENTRY)\b/i.test(upper) ||
           /\b(CANCEL|REMOVE|DELETE)\s+(?:ALL\s+)?(?:PENDING\s+)?(?:LIMITS?|ORDERS?)\b/i.test(upper) ||
           /\bCANCEL\s+PENDING\b/i.test(upper);
  }

  /**
   * 🛡️ DETECTOR DE BREAK-EVEN:
   * Detecta mensajes para mover el SL a precio de entrada
   */
  isBreakEvenMessage(text) {
    if (!text) return false;
    const upper = text.toUpperCase();
    return /\b(MOVE\s+(?:YOUR\s+)?SL\s+TO\s+(?:BE|ENTRY|BREAK\s*EVEN)|SL\s+(?:TO|AT)\s+(?:ENTRY|BE|BREAK\s*EVEN)|SET\s+SL\s+TO\s+(?:BE|ENTRY)|SECURE\s+(?:TRADE\s+)?(?:WITH\s+)?(?:BE|BREAK\s*EVEN))\b/i.test(upper);
  }

  /**
   * Analiza y extrae la señal desde el texto. Debe ser implementado/extendido por las estrategias hijas.
   */
  parse(text, metadata = {}) {
    if (!text) return null;
    const rawText = text.normalize('NFKD');

    // 1. Chequeo de cancelación
    if (this.isCancelMessage(rawText)) {
      return new SignalData({
        channelId: this.channelId,
        channelName: this.channelName,
        messageId: metadata.messageId,
        rawText,
        isCancelEvent: true,
        cancelTarget: 'ALL'
      });
    }

    // 2. Chequeo de Break-Even
    if (this.isBreakEvenMessage(rawText)) {
      const pairMatch = rawText.match(/#(XAUUSD|GOLD|EURUSD|GBPUSD|BTCUSD)/i) || rawText.match(/\b(XAU\/?USD|GOLD)\b/i);
      return new SignalData({
        channelId: this.channelId,
        channelName: this.channelName,
        messageId: metadata.messageId,
        symbol: pairMatch ? pairMatch[1].toUpperCase() : 'XAUUSD',
        action: 'MODIFY',
        rawText,
        isBreakEvenEvent: true
      });
    }

    // 2. Chequeo anti-actualizaciones
    if (this.isUpdateOrResult(rawText)) {
      return null;
    }

    // 3. Extracción general de acción
    const upper = rawText.toUpperCase();
    let actionMatch = upper.match(/(?:ORDER TYPE:\s*|TYPE:\s*|ACTION:\s*)?(?:WAIT\s+)?\b(SELL NOW AGAIN|BUY NOW AGAIN|SELL AGAIN|BUY AGAIN|ADD SELL|ADD BUY|SELL NOW|BUY NOW|SEEL NOW|SEL NOW|BUYY NOW|SEEL|SELL|SEL|BUYY|BUY)\b/i);
    const pairMatch = rawText.match(/(?:PAIR|PAR):\s*([A-Z0-9\/]+)/i) || rawText.match(/\b(XAU\/?USD|GOLD|EUR\/?USD|GBP\/?USD|BTC\/?USD|US30|NAS100)\b/i);

    if (!actionMatch) return null;

    let isBuy = actionMatch[0].toUpperCase().includes('BUY');

    // 4. Extracción de Entrada (Rango o Precio Simple)
    let entryVal = null;
    let entryRange = null;

    const rangeMatch = rawText.match(/(?:ENTRY PRICE|BUY ZONE|SELL ZONE|ENTRY|ENTRADA|PRICE|\bZONE\b|@|AT)?[\s:\-]*([0-9]{4}(?:\.[0-9]+)?)\s*(?:[\-\_]+|\s+TO\s+)\s*([0-9]{4}(?:\.[0-9]+)?)/i);
    if (rangeMatch) {
      const p1 = parseFloat(rangeMatch[1]);
      const p2 = parseFloat(rangeMatch[2]);
      if (!isNaN(p1) && !isNaN(p2)) {
        entryRange = { min: Math.min(p1, p2), max: Math.max(p1, p2) };
        entryVal = isBuy ? entryRange.min : entryRange.max;
      }
    }

    if (!entryVal) {
      const entryMatch = rawText.match(/(?:ENTRY PRICE|BUY ZONE|SELL ZONE|ENTRY|ENTRADA|PRICE|\bZONE\b|@|AT)[^\d]*([\d\.]+)/i);
      if (entryMatch) {
        entryVal = this.cleanEntry(entryMatch[1]);
      } else {
        const fallbackMatch = rawText.match(/(?:BUY|BUYY|SELL|SEEL|SEL)\s+(?:GOLD|XAU\/?USD\s+)?(?:NOW[\s:]*)?(?:LIMIT[\s:]*)?(?:ALERT[\s:]*)?(?:NOW[\s:]*)?\s*([0-9]{4}(?:\.[0-9]+)?)/i);
        if (fallbackMatch) entryVal = this.cleanEntry(fallbackMatch[1]);
      }
    }

    // 5. Extracción de SL
    let cleanSL = null;
    const slMatch = rawText.match(/(?:STOP LOSS|STOPLOSS|SL)[\s:\.@]*([\d\.]+)/i);
    if (slMatch) {
      cleanSL = parseFloat(slMatch[1]);
      if (cleanSL > 0 && cleanSL < 100) {
        const baseRef = entryVal || 4300;
        const prefix = Math.floor(baseRef / 100);
        cleanSL = prefix * 100 + cleanSL;
      }
    }

    // 6. Extracción de TPs
    const textWithoutSL = rawText.replace(/(?:STOP LOSS|STOPLOSS|\bSL\b)[\s:\.@]*[\d\.]+/gi, '');
    let cleanTP1 = null, cleanTP2 = null, cleanTP3 = null;

    const tpRegex = /(?:TAKE\s*PROFIT\s*\d*|TAKEPROFIT\s*\d*|TARGETS?\s*\d*|\bTP\s*[1-9]?#?|[✅🎯↳→]\s*(?:TP\s*\d*)?)[\s:\.=\-\|→]*([0-9]{4}(?:\.[0-9]+)?)/gi;
    const tpMatches = [...textWithoutSL.matchAll(tpRegex)];
    cleanTP1 = (tpMatches.length > 0) ? parseFloat(tpMatches[0][1]) : null;
    cleanTP2 = (tpMatches.length > 1) ? parseFloat(tpMatches[1][1]) : null;
    cleanTP3 = (tpMatches.length > 2) ? parseFloat(tpMatches[2][1]) : null;

    // 7. Auto-corrección de Dirección Incoherente
    if (cleanSL && cleanTP1) {
      if (isBuy && cleanTP1 < cleanSL) {
        isBuy = false;
      } else if (!isBuy && cleanTP1 > cleanSL) {
        isBuy = true;
      }
    }

    // 8. Validación de Señal Real: Debe tener al menos precio de entrada o Stop Loss explícito
    // Evita que comentarios o análisis sin niveles técnicos se ejecuten como órdenes de mercado
    if (!entryVal && !cleanSL) {
      return null;
    }

    return new SignalData({
      channelId: this.channelId,
      channelName: this.channelName,
      messageId: metadata.messageId,
      symbol: pairMatch ? pairMatch[1].toUpperCase() : 'XAUUSD',
      action: isBuy ? 'BUY' : 'SELL',
      entry: entryVal,
      entryRange,
      sl: cleanSL,
      tp1: cleanTP1,
      tp2: cleanTP2,
      tp3: cleanTP3,
      rawText
    });
  }

  /**
   * Resuelve el Take Profit según la preferencia del canal
   */
  resolveTargetTP(signal) {
    if (this.preferredTP === 'TP1') {
      return signal.tp1 || signal.tp2 || signal.tp3;
    }
    if (this.preferredTP === 'TP3') {
      return signal.tp3 || signal.tp2 || signal.tp1;
    }
    // Por defecto TP2
    return signal.tp2 || signal.tp1 || signal.tp3;
  }

  /**
   * Genera el plan de ejecución estándar a mercado
   */
  createExecutionPlan(signal, livePrice = null, riskEngine) {
    if (signal.isCancelEvent) {
      return new ExecutionPlan({
        valid: true,
        isCancelAction: true,
        isPendingOrder: true,
        orderType: 'CANCEL_ALL_PENDING',
        symbol: signal.symbol || 'XAUUSD',
        channelId: this.channelId,
        channelName: this.channelName,
        comment: `Cancel by ${this.channelName}`
      });
    }

    if (signal.isBreakEvenEvent || signal.action === 'MODIFY') {
      return new ExecutionPlan({
        valid: true,
        channelId: this.channelId,
        channelName: this.channelName,
        symbol: signal.symbol || 'XAUUSD',
        action: 'MODIFY',
        orderType: 'MODIFY',
        comment: `BE by ${this.channelName}`,
        orders: [{
          action: 'MODIFY',
          modifyType: 'BREAK_EVEN',
          symbol: signal.symbol || 'XAUUSD',
          comment: `BE by ${this.channelName}`
        }]
      });
    }

    const currentPrice = livePrice || signal.entry;
    const isBuy = signal.action.toUpperCase().includes('BUY');

    // Gestión de Señales Rápidas sin SL explícito (ej: "GOLD SELL AGAIN 4294-4298")
    // Se asigna SL y TP preventivo predefinido según el histórico del canal
    let isProvisionalSL = false;
    if (!signal.sl || signal.sl <= 0) {
      const defaultSLDistance = (this.defaultSLPips || 80) / 10;
      const defaultTPDistance = (this.defaultTP2Pips || 70) / 10;
      const refEntry = signal.entry || currentPrice;

      signal.sl = isBuy ? parseFloat((refEntry - defaultSLDistance).toFixed(2)) : parseFloat((refEntry + defaultSLDistance).toFixed(2));
      if (!signal.tp2 && !signal.tp1) {
        signal.tp2 = isBuy ? parseFloat((refEntry + defaultTPDistance).toFixed(2)) : parseFloat((refEntry - defaultTPDistance).toFixed(2));
      }
      isProvisionalSL = true;
      console.log(`⚡ [Señal Rápida Detectada] "${this.channelName}" envió orden inmediata sin SL explícito. Asignando SL preventivo: ${signal.sl} (${this.defaultSLPips || 80} pips) y TP preventivo: ${signal.tp2}`);
    }

    // 🛡️ TOPE DE SEGURIDAD MÁXIMO DE STOP LOSS (Cap Máximo a 100 pips):
    // Evita pérdidas catastróficas por canales que envían SLs asimétricos (> 100 pips)
    const MAX_SL_PIPS = 100;
    const refEntry = signal.entry || currentPrice;
    if (signal.sl && refEntry) {
      const symUpper = (signal.symbol || 'XAUUSD').toUpperCase();
      let slDistanceInPips = 0;
      if (symUpper.includes('XAU') || symUpper.includes('GOLD')) {
        slDistanceInPips = Math.abs(refEntry - signal.sl) * 10;
        if (slDistanceInPips > MAX_SL_PIPS) {
          const originalSL = signal.sl;
          const maxDistancePrice = MAX_SL_PIPS / 10; // 10.0 en precio de Oro
          signal.sl = isBuy
            ? parseFloat((refEntry - maxDistancePrice).toFixed(2))
            : parseFloat((refEntry + maxDistancePrice).toFixed(2));
          console.log(`🛡️ [Risk Protection] "${this.channelName}": SL original (${originalSL}, ${slDistanceInPips.toFixed(1)} pips) superaba el máximo permitido (${MAX_SL_PIPS} pips). Acotado a: ${signal.sl}`);
        }
      } else {
        slDistanceInPips = Math.abs(refEntry - signal.sl) * 10000;
        if (slDistanceInPips > MAX_SL_PIPS) {
          const originalSL = signal.sl;
          const maxDistancePrice = MAX_SL_PIPS / 10000;
          signal.sl = isBuy
            ? parseFloat((refEntry - maxDistancePrice).toFixed(5))
            : parseFloat((refEntry + maxDistancePrice).toFixed(5));
          console.log(`🛡️ [Risk Protection] "${this.channelName}": SL original (${originalSL}, ${slDistanceInPips.toFixed(1)} pips) superaba el máximo permitido (${MAX_SL_PIPS} pips). Acotado a: ${signal.sl}`);
        }
      }
    }

    // Validación de SL ya superado por mercado
    if (currentPrice) {
      if (isBuy && currentPrice <= signal.sl) {
        return new ExecutionPlan({
          valid: false,
          reason: `Precio actual (${currentPrice}) ya superó o tocó el SL (${signal.sl}).`
        });
      }
      if (!isBuy && currentPrice >= signal.sl) {
        return new ExecutionPlan({
          valid: false,
          reason: `Precio actual (${currentPrice}) ya superó o tocó el SL (${signal.sl}).`
        });
      }

      // Validación de Slippage excesivo inteligente (zonas y dirección favorable)
      if (signal.entry) {
        let slippage = 0;
        if (signal.entryRange) {
          if (currentPrice >= signal.entryRange.min && currentPrice <= signal.entryRange.max) {
            slippage = 0; // Dentro de la zona recomendada: slippage cero
          } else if (isBuy) {
            // En BUY, si el precio está por debajo del mínimo, es una entrada con descuento (favorable)
            slippage = currentPrice > signal.entryRange.max ? (currentPrice - signal.entryRange.max) : 0;
          } else {
            // En SELL, si el precio está por encima del máximo, es una entrada más alta (favorable)
            slippage = currentPrice < signal.entryRange.min ? (signal.entryRange.min - currentPrice) : 0;
          }
        } else {
          if (isBuy) {
            slippage = currentPrice > signal.entry ? (currentPrice - signal.entry) : 0;
          } else {
            slippage = currentPrice < signal.entry ? (signal.entry - currentPrice) : 0;
          }
        }

        if (slippage > this.maxSlippagePips) {
          return new ExecutionPlan({
            valid: false,
            reason: `Desfase de mercado excesivo (${slippage.toFixed(2)} pips > ${this.maxSlippagePips} pips permitidos).`
          });
        }
      }

      // Validación de TP ya alcanzado por el mercado
      const targetTP = this.resolveTargetTP(signal);
      if (targetTP && currentPrice) {
        if (isBuy && currentPrice >= targetTP) {
          return new ExecutionPlan({
            valid: false,
            reason: `Precio actual (${currentPrice}) ya alcanzó o superó el Take Profit (${targetTP}). Señal expirada.`
          });
        }
        if (!isBuy && currentPrice <= targetTP) {
          return new ExecutionPlan({
            valid: false,
            reason: `Precio actual (${currentPrice}) ya alcanzó o superó el Take Profit (${targetTP}). Señal expirada.`
          });
        }
      }
    }

    const chosenTP = this.resolveTargetTP(signal);
    const targetTP1 = signal.tp1;
    const targetTP2 = signal.tp2 || chosenTP;
    const canSplitOrders = targetTP1 && targetTP2 && targetTP1 !== targetTP2;

    const isExplicitPending = signal.action.includes('LIMIT') || signal.action.includes('STOP') ||
      (signal.rawText && /\b(BUY\s+LIMIT|SELL\s+LIMIT|BUY\s+STOP|SELL\s+STOP|LIMIT|STOP)\b/i.test(signal.rawText.replace(/(?:STOP\s*LOSS|STOPLOSS|\bSL\b)[^\n]*/gi, '')));

    if (isExplicitPending && (signal.entry || currentPrice)) {
      const orderEntry = signal.entry || currentPrice;
      let orderType = signal.action;
      if (!orderType.includes('LIMIT') && !orderType.includes('STOP')) {
        if (isBuy) {
          orderType = (currentPrice && orderEntry < currentPrice) ? 'BUY_LIMIT' : 'BUY_STOP';
        } else {
          orderType = (currentPrice && orderEntry > currentPrice) ? 'SELL_LIMIT' : 'SELL_STOP';
        }
      }

      const lotSize = riskEngine.calculateLotSize(orderEntry, signal.sl, signal.symbol);
      let pendingOrders = [];

      if (canSplitOrders && lotSize >= 0.02) {
        const halfLot1 = parseFloat((Math.floor((lotSize / 2) * 100) / 100).toFixed(2));
        const halfLot2 = parseFloat((lotSize - halfLot1).toFixed(2));

        pendingOrders.push(new TradeOrder({
          symbol: signal.symbol,
          action: orderType,
          entryPrice: orderEntry,
          sl: signal.sl,
          tp: targetTP1,
          volume: halfLot1,
          comment: `Pending ${this.channelName} TP1`,
          ttlMinutes: this.pendingOrderTTLMinutes
        }));

        pendingOrders.push(new TradeOrder({
          symbol: signal.symbol,
          action: orderType,
          entryPrice: orderEntry,
          sl: signal.sl,
          tp: targetTP2,
          volume: halfLot2,
          comment: `Pending ${this.channelName} TP2`,
          ttlMinutes: this.pendingOrderTTLMinutes
        }));

        console.log(`🎯 [Pending Split 50% TP1 + Trailing] ${orderType}: Leg 1 (${halfLot1}L @ TP1: ${targetTP1}) | Leg 2 (${halfLot2}L @ TP2: ${targetTP2})`);
      } else {
        pendingOrders.push(new TradeOrder({
          symbol: signal.symbol,
          action: orderType,
          entryPrice: orderEntry,
          sl: signal.sl,
          tp: chosenTP,
          volume: lotSize,
          comment: `Pending ${this.channelName}`,
          ttlMinutes: this.pendingOrderTTLMinutes
        }));
      }

      return new ExecutionPlan({
        valid: true,
        channelId: this.channelId,
        channelName: this.channelName,
        symbol: signal.symbol,
        action: orderType,
        orderType: orderType,
        entryPrice: orderEntry,
        slPrice: signal.sl,
        targetTP: chosenTP,
        totalLotSize: lotSize,
        isPendingOrder: true,
        isGrid: false,
        orders: pendingOrders,
        ttlMinutes: this.pendingOrderTTLMinutes
      });
    }

    const lotSize = riskEngine.calculateLotSize(currentPrice || signal.entry, signal.sl, signal.symbol);
    let marketOrders = [];

    // 🚀 MODELO 50% PARCIAL EN TP1 + TRAILING STOP EN TP2
    if (canSplitOrders && lotSize >= 0.02) {
      const halfLot1 = parseFloat((Math.floor((lotSize / 2) * 100) / 100).toFixed(2));
      const halfLot2 = parseFloat((lotSize - halfLot1).toFixed(2));

      marketOrders.push(new TradeOrder({
        symbol: signal.symbol,
        action: isBuy ? 'BUY' : 'SELL',
        entryPrice: currentPrice || signal.entry,
        sl: signal.sl,
        tp: targetTP1,
        volume: halfLot1,
        comment: `Order ${this.channelName} TP1`
      }));

      marketOrders.push(new TradeOrder({
        symbol: signal.symbol,
        action: isBuy ? 'BUY' : 'SELL',
        entryPrice: currentPrice || signal.entry,
        sl: signal.sl,
        tp: targetTP2,
        volume: halfLot2,
        comment: `Order ${this.channelName} TP2`
      }));

      console.log(`🎯 [Market Split 50% TP1 + Trailing] ${isBuy ? 'BUY' : 'SELL'}: Leg 1 (${halfLot1}L @ TP1: ${targetTP1}) | Leg 2 (${halfLot2}L @ TP2: ${targetTP2})`);
    } else {
      marketOrders.push(new TradeOrder({
        symbol: signal.symbol,
        action: isBuy ? 'BUY' : 'SELL',
        entryPrice: currentPrice || signal.entry,
        sl: signal.sl,
        tp: chosenTP,
        volume: lotSize,
        comment: `Order ${this.channelName}`
      }));
    }

    return new ExecutionPlan({
      valid: true,
      channelId: this.channelId,
      channelName: this.channelName,
      symbol: signal.symbol,
      action: isBuy ? 'BUY' : 'SELL',
      orderType: isBuy ? 'BUY' : 'SELL',
      entryPrice: currentPrice || signal.entry,
      slPrice: signal.sl,
      targetTP: chosenTP,
      totalLotSize: lotSize,
      isPendingOrder: false,
      isProvisionalSL,
      orders: marketOrders
    });
  }
}

module.exports = BaseStrategy;
