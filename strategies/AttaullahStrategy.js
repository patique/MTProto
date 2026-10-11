/**
 * Estrategia Exclusiva para Attaullah Trading Zone (ID: -1004307971022)
 * - Parseo especializado para zonas de entrada ("SELL ZONE 4282__4285")
 * - Soporte para listas multi-línea de Take Profits (Takeprofit 1..5)
 * - NO ejecuta Grid. Crea una sola orden limpia con SL estricto y objetivo TP2
 */

const BaseStrategy = require('./BaseStrategy');
const { SignalData, ExecutionPlan, TradeOrder } = require('../domain/models');

class AttaullahStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      preferredTP: config.preferredTP || 'TP3',
      allowGrid: false, // ¡GRID DESACTIVADA!
      pendingOrderTTLMinutes: config.pendingOrderTTLMinutes || 30
    });
  }

  parse(text, metadata = {}) {
    if (!text) return null;
    const rawText = text.normalize('NFKD');

    // 1. Chequeo de cancelación o actualización
    if (this.isCancelMessage(rawText)) {
      return new SignalData({
        channelId: this.channelId,
        channelName: this.channelName,
        messageId: metadata.messageId,
        rawText,
        isCancelEvent: true
      });
    }

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

    if (this.isUpdateOrResult(rawText)) {
      return null;
    }

    const upper = rawText.toUpperCase();

    // 2. Detección de Acción y Zona: "SELL ZONE 4282__4285" o "BUY ZONE 4280__4277"
    let action = null;
    if (upper.includes('SELL ZONE') || upper.includes('SELL NOW') || upper.includes('SELL')) {
      action = 'SELL';
    } else if (upper.includes('BUY ZONE') || upper.includes('BUY NOW') || upper.includes('BUY')) {
      action = 'BUY';
    }

    if (!action) return null;
    const isBuy = action === 'BUY';

    // 3. Extracción de Par
    const pairMatch = rawText.match(/#(XAUUSD|GOLD|EURUSD|GBPUSD|BTCUSD)/i) || rawText.match(/\b(XAU\/?USD|GOLD)\b/i);
    const symbol = pairMatch ? pairMatch[1].toUpperCase() : 'XAUUSD';

    // 4. Extracción de Rango de Zona: "4282__4285" o "4282 - 4285"
    let entryVal = null;
    let entryRange = null;

    const zoneMatch = rawText.match(/(?:ZONE|ENTRADA|ENTRY)?[\s:]*([0-9]{4}(?:\.[0-9]+)?)\s*(?:_{2,}|[\-\_]+|\s+TO\s+)\s*([0-9]{4}(?:\.[0-9]+)?)/i);
    if (zoneMatch) {
      const p1 = parseFloat(zoneMatch[1]);
      const p2 = parseFloat(zoneMatch[2]);
      if (!isNaN(p1) && !isNaN(p2)) {
        entryRange = { min: Math.min(p1, p2), max: Math.max(p1, p2) };
        // Para BUY la mejor entrada es el mínimo de la zona; para SELL el máximo
        entryVal = isBuy ? entryRange.min : entryRange.max;
      }
    }

    if (!entryVal) {
      const singleMatch = rawText.match(/(?:ZONE|ENTRY|AT|@)?\s*([0-9]{4}(?:\.[0-9]+)?)/i);
      if (singleMatch) entryVal = parseFloat(singleMatch[1]);
    }

    // 5. Extracción de Stoploss
    let sl = null;
    const slMatch = rawText.match(/(?:STOPLOSS|STOP LOSS|SL)[\s:\.@]*([0-9]{4}(?:\.[0-9]+)?)/i);
    if (slMatch) {
      sl = parseFloat(slMatch[1]);
    }

    // 6. Extracción de Take Profits multi-línea (Takeprofit 1..5)
    let tp1 = null, tp2 = null, tp3 = null, tp4 = null;
    const tp1Match = rawText.match(/(?:TAKEPROFIT\s*1|TP\s*1)[\s:\.@]*([0-9]{4}(?:\.[0-9]+)?)/i);
    const tp2Match = rawText.match(/(?:TAKEPROFIT\s*2|TP\s*2)[\s:\.@]*([0-9]{4}(?:\.[0-9]+)?)/i);
    const tp3Match = rawText.match(/(?:TAKEPROFIT\s*3|TP\s*3)[\s:\.@]*([0-9]{4}(?:\.[0-9]+)?)/i);
    const tp4Match = rawText.match(/(?:TAKEPROFIT\s*4|TP\s*4)[\s:\.@]*([0-9]{4}(?:\.[0-9]+)?)/i);

    if (tp1Match) tp1 = parseFloat(tp1Match[1]);
    if (tp2Match) tp2 = parseFloat(tp2Match[1]);
    if (tp3Match) tp3 = parseFloat(tp3Match[1]);
    if (tp4Match) tp4 = parseFloat(tp4Match[1]);

    if (!tp1) {
      // Fallback a regex general de TPs
      const generalTPs = [...rawText.matchAll(/(?:TAKEPROFIT|TP\s*\d*)[\s:\.@]*([0-9]{4}(?:\.[0-9]+)?)/gi)];
      if (generalTPs.length > 0) tp1 = parseFloat(generalTPs[0][1]);
      if (generalTPs.length > 1) tp2 = parseFloat(generalTPs[1][1]);
      if (generalTPs.length > 2) tp3 = parseFloat(generalTPs[2][1]);
      if (generalTPs.length > 3) tp4 = parseFloat(generalTPs[3][1]);
    }

    return new SignalData({
      channelId: this.channelId,
      channelName: this.channelName,
      messageId: metadata.messageId,
      symbol,
      action,
      entry: entryVal,
      entryRange,
      sl,
      tp1,
      tp2,
      tp3,
      tp4,
      rawText
    });
  }

  createExecutionPlan(signal, livePrice = null, riskEngine) {
    // Attaullah NUNCA crea rejilla (grid). Siempre una orden limpia.
    return super.createExecutionPlan(signal, livePrice, riskEngine);
  }
}

module.exports = AttaullahStrategy;
