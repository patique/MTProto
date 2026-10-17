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
    this.preferredTP = config.preferredTP || 'LAST_TP';
    this.allowSplit = !!config.allowSplit; // Por defecto desactivado: orden única limpia al TP preferido
    this.allowGrid = !!config.allowGrid;
    this.pendingOrderTTLMinutes = config.pendingOrderTTLMinutes || 30;
    this.maxSlippagePips = config.maxSlippagePips || 5.0;
    this.minRiskReward = typeof config.minRiskReward === 'number' ? config.minRiskReward : 1.0;
    this.requireTP3 = !!config.requireTP3;
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
    let cleanTP1 = null, cleanTP2 = null, cleanTP3 = null, cleanTP4 = null, cleanTP5 = null;

    const tpRegex = /(?:TAKE\s*PROFIT\s*\d*|TAKEPROFIT\s*\d*|TARGETS?\s*\d*|\bTP\s*[1-9]?#?|[✅🎯↳→]\s*(?:TP\s*\d*)?)[\s:\.=\-\|→]*([0-9]{4}(?:\.[0-9]+)?)/gi;
    const tpMatches = [...textWithoutSL.matchAll(tpRegex)];
    const tpValues = tpMatches.map(m => parseFloat(m[1])).filter(v => !isNaN(v) && v > 0);
    cleanTP1 = tpValues[0] || null;
    cleanTP2 = tpValues[1] || null;
    cleanTP3 = tpValues[2] || null;
    cleanTP4 = tpValues[3] || null;
    cleanTP5 = tpValues[4] || null;
    const lastTP = tpValues.length > 0 ? tpValues[tpValues.length - 1] : null;

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
      tp4: cleanTP4,
      tp5: cleanTP5,
      tps: tpValues,
      lastTP,
      rawText
    });
  }

  /**
   * Resuelve el Take Profit según la preferencia del canal
   */
  resolveTargetTP(signal) {
    if (this.preferredTP === 'LAST_TP' || this.config?.preferredTP === 'LAST_TP') {
      return signal.lastTP || signal.tp5 || signal.tp4 || signal.tp3 || signal.tp2 || signal.tp1 || null;
    }
    if (this.requireTP3 || this.config?.requireTP3) {
      return signal.tp3 || null;
    }
    if (this.preferredTP === 'TP1') {
      return signal.tp1 || signal.tp2 || signal.tp3;
    }
    if (this.preferredTP === 'TP2') {
      return signal.tp2 || signal.tp3 || signal.tp1;
    }
    if (this.preferredTP === 'TP4') {
      return signal.tp4 || signal.tp3 || signal.tp2 || signal.tp1;
    }
    if (this.preferredTP === 'TP5') {
      return signal.tp5 || signal.tp4 || signal.tp3 || signal.tp2 || signal.tp1;
    }
    // SIEMPRE último TP disponible como prioridad absoluta
    return signal.lastTP || signal.tp5 || signal.tp4 || signal.tp3 || signal.tp2 || signal.tp1;
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

    // 🎯 FILTRO ESTRICTO DE TP3: Si el canal está configurado con TP3 obligatorio, descartar si no hay TP3
    if ((this.requireTP3 || this.config?.requireTP3) && !signal.tp3) {
      console.log(`⚠️ [Filtro TP3 Obligatorio] "${this.channelName}": Señal descartada porque no incluye TP3 explícito.`);
      return new ExecutionPlan({
        valid: false,
        reason: 'Señal sin TP3 explícito (el canal exige TP3 obligatorio).'
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

    // Se respeta íntegramente el SL original enviado por el canal.
    // El tamaño del lote se adapta matemáticamente mediante RiskEngine en función de la distancia del SL.

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
            reason: `Señal tardía: El precio actual (${currentPrice}) ya alcanzó el Take Profit (${targetTP}). Señal expirada.`
          });
        }
      }

      // Validación de SL ya alcanzado por el mercado al llegar la señal (Señal tardía / inválida)
      if (signal.sl && currentPrice) {
        if (isBuy && currentPrice <= signal.sl) {
          return new ExecutionPlan({
            valid: false,
            reason: `Señal tardía: El precio actual (${currentPrice}) ya perforó el Stop Loss (${signal.sl}). Señal descartada.`
          });
        }
        if (!isBuy && currentPrice >= signal.sl) {
          return new ExecutionPlan({
            valid: false,
            reason: `Señal tardía: El precio actual (${currentPrice}) ya perforó el Stop Loss (${signal.sl}). Señal descartada.`
          });
        }
      }
    }

    const chosenTP = this.resolveTargetTP(signal);

    // ⚖️ FILTRO DE RATIO RIESGO / BENEFICIO MÍNIMO (Mínimo 1:1.3 o configurable por canal):
    // Descarta automáticamente operaciones donde el riesgo supere o no compense el potencial beneficio
    const orderEntryPrice = signal.entry || currentPrice;
    if (signal.sl && chosenTP && orderEntryPrice) {
      const riskDistance = Math.abs(orderEntryPrice - signal.sl);
      const rewardDistance = Math.abs(chosenTP - orderEntryPrice);
      if (riskDistance > 0) {
        const currentRR = rewardDistance / riskDistance;
        if (currentRR < this.minRiskReward) {
          console.log(`⚠️ [Filtro R:R Rechazado] "${this.channelName}": Ratio 1:${currentRR.toFixed(2)} es inferior al mínimo exigido (1:${this.minRiskReward}). Riesgo: ${riskDistance.toFixed(2)} pts | Recompensa: ${rewardDistance.toFixed(2)} pts. Señal descartada.`);
          const rejectedPlan = new ExecutionPlan({
            valid: false,
            reason: `Ratio R:R proyectado (1:${currentRR.toFixed(2)}) es inferior al mínimo exigido (1:${this.minRiskReward}).`
          });
          rejectedPlan.isRRReject = true;
          rejectedPlan.currentRR = currentRR;
          rejectedPlan.targetTP = chosenTP;
          return rejectedPlan;
        }
      }
    }

    const targetTP1 = signal.tp1;
    const targetTP2 = (chosenTP && chosenTP !== targetTP1) ? chosenTP : (signal.tp2 || chosenTP);
    const canSplitOrders = this.allowSplit && targetTP1 && targetTP2 && targetTP1 !== targetTP2;

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

      const leg1Lot = parseFloat(Math.max(0.01, Math.round(lotSize * 0.60 * 100) / 100).toFixed(2));
      const leg2Lot = parseFloat((lotSize - leg1Lot).toFixed(2));

      if (canSplitOrders && lotSize >= 0.02 && leg1Lot >= 0.01 && leg2Lot >= 0.01) {
        pendingOrders.push(new TradeOrder({
          symbol: signal.symbol,
          action: orderType,
          entryPrice: orderEntry,
          sl: signal.sl,
          tp: targetTP1,
          volume: leg1Lot,
          comment: `Pending ${this.channelName} TP1`,
          ttlMinutes: this.pendingOrderTTLMinutes
        }));

        pendingOrders.push(new TradeOrder({
          symbol: signal.symbol,
          action: orderType,
          entryPrice: orderEntry,
          sl: signal.sl,
          tp: targetTP2,
          volume: leg2Lot,
          comment: `Pending ${this.channelName} TP2`,
          ttlMinutes: this.pendingOrderTTLMinutes
        }));

        console.log(`🎯 [Pending Split 60/40 TP1 + Trailing] ${orderType}: Leg 1 (${leg1Lot}L @ TP1: ${targetTP1}) | Leg 2 (${leg2Lot}L @ TP2: ${targetTP2})`);
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

      const resolvedTP2Pending = signal.tp2 || (this.config.defaultTP2Pips
        ? (isBuy ? parseFloat((orderEntry + this.config.defaultTP2Pips / 10).toFixed(2))
                 : parseFloat((orderEntry - this.config.defaultTP2Pips / 10).toFixed(2)))
        : null);

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
        tp2: resolvedTP2Pending,
        breakEvenTrigger: this.config.breakEvenTrigger || 'TP2',
        totalLotSize: lotSize,
        isPendingOrder: true,
        isGrid: false,
        orders: pendingOrders,
        ttlMinutes: this.pendingOrderTTLMinutes
      });
    }

    const lotSize = riskEngine.calculateLotSize(currentPrice || signal.entry, signal.sl, signal.symbol);
    let marketOrders = [];

    // 🚀 MODELO 60% PARCIAL EN TP1 (ALTA CERTEZA) + 40% RUNNER EN TP2 (O 50/50 EN LOTAJE MÍNIMO)
    const leg1Lot = parseFloat(Math.max(0.01, Math.round(lotSize * 0.60 * 100) / 100).toFixed(2));
    const leg2Lot = parseFloat((lotSize - leg1Lot).toFixed(2));

    if (canSplitOrders && lotSize >= 0.02 && leg1Lot >= 0.01 && leg2Lot >= 0.01) {
      marketOrders.push(new TradeOrder({
        symbol: signal.symbol,
        action: isBuy ? 'BUY' : 'SELL',
        entryPrice: currentPrice || signal.entry,
        sl: signal.sl,
        tp: targetTP1,
        volume: leg1Lot,
        comment: `Order ${this.channelName} TP1`
      }));

      marketOrders.push(new TradeOrder({
        symbol: signal.symbol,
        action: isBuy ? 'BUY' : 'SELL',
        entryPrice: currentPrice || signal.entry,
        sl: signal.sl,
        tp: targetTP2,
        volume: leg2Lot,
        comment: `Order ${this.channelName} TP2`
      }));

      console.log(`🎯 [Market Split 60/40 TP1 + Trailing] ${isBuy ? 'BUY' : 'SELL'}: Leg 1 (${leg1Lot}L @ TP1: ${targetTP1}) | Leg 2 (${leg2Lot}L @ TP2: ${targetTP2})`);
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

    const resolvedTP2Market = signal.tp2 || (this.config.defaultTP2Pips
      ? (isBuy ? parseFloat(((currentPrice || signal.entry) + this.config.defaultTP2Pips / 10).toFixed(2))
               : parseFloat(((currentPrice || signal.entry) - this.config.defaultTP2Pips / 10).toFixed(2)))
      : null);

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
      tp2: resolvedTP2Market,
      breakEvenTrigger: this.config.breakEvenTrigger || 'TP2',
      totalLotSize: lotSize,
      isPendingOrder: false,
      isProvisionalSL,
      orders: marketOrders
    });
  }
}

module.exports = BaseStrategy;
