/**
 * Modelos de Dominio y Contratos de Datos Unificados
 */

class SignalData {
  constructor({
    channelId = '',
    channelName = 'Canal Desconocido',
    messageId = null,
    pair = null,
    symbol = 'XAUUSD',
    action = 'BUY', // BUY, SELL, BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP
    entry = null,
    entryRange = null, // { min, max }
    sl = null,
    tp1 = null,
    tp2 = null,
    tp3 = null,
    tp4 = null,
    tp5 = null,
    tps = [],
    lastTP = null,
    rawText = '',
    timestamp = Date.now(),
    isCancelEvent = false,
    cancelTarget = 'ALL',
    isBreakEvenEvent = false
  }) {
    this.channelId = channelId ? channelId.toString() : '';
    this.channelName = channelName;
    this.messageId = messageId;
    const resolvedSym = pair || symbol || 'XAUUSD';
    this.symbol = resolvedSym ? resolvedSym.replace('/', '').toUpperCase() : 'XAUUSD';
    this.pair = this.symbol;
    this.action = action ? action.toUpperCase() : 'BUY';
    this.entry = typeof entry === 'number' ? entry : (entry ? parseFloat(entry) : null);
    this.entryRange = entryRange;
    this.sl = typeof sl === 'number' ? sl : (sl ? parseFloat(sl) : null);
    this.tp1 = typeof tp1 === 'number' ? tp1 : (tp1 ? parseFloat(tp1) : null);
    this.tp2 = typeof tp2 === 'number' ? tp2 : (tp2 ? parseFloat(tp2) : null);
    this.tp3 = typeof tp3 === 'number' ? tp3 : (tp3 ? parseFloat(tp3) : null);
    this.tp4 = typeof tp4 === 'number' ? tp4 : (tp4 ? parseFloat(tp4) : null);
    this.tp5 = typeof tp5 === 'number' ? tp5 : (tp5 ? parseFloat(tp5) : null);
    this.tps = Array.isArray(tps) ? tps : [];
    this.lastTP = typeof lastTP === 'number' ? lastTP : (lastTP ? parseFloat(lastTP) : (this.tp5 || this.tp4 || this.tp3 || this.tp2 || this.tp1 || null));
    this.rawText = rawText;
    this.timestamp = timestamp;
    this.isCancelEvent = isCancelEvent;
    this.cancelTarget = cancelTarget;
    this.isBreakEvenEvent = isBreakEvenEvent;
  }
}

class TradeOrder {
  constructor({
    id = null,
    symbol = 'XAUUSD',
    action = 'BUY',
    entryPrice = null,
    volume = 0.01,
    sl = 0,
    tp = 0,
    comment = '',
    ttlMinutes = 30,
    timestamp = Date.now()
  }) {
    this.id = id || Date.now() + Math.floor(Math.random() * 1000);
    this.symbol = symbol;
    this.action = action;
    this.entryPrice = entryPrice;
    this.entry = entryPrice;
    this.volume = parseFloat(volume.toFixed(2));
    this.sl = sl ? parseFloat(sl.toFixed(2)) : 0;
    this.tp = tp ? parseFloat(tp.toFixed(2)) : 0;
    this.comment = comment || '';
    this.ttlMinutes = ttlMinutes;
    this.timestamp = timestamp;
    this.expirationTimestamp = ttlMinutes > 0 ? (timestamp + ttlMinutes * 60000) : null;
  }
}

class ExecutionPlan {
  constructor({
    valid = true,
    reason = '',
    channelId = '',
    channelName = 'Canal',
    symbol = 'XAUUSD',
    action = 'BUY',
    entryPrice = null,
    slPrice = null,
    targetTP = null,
    totalLotSize = 0.01,
    isPendingOrder = false,
    isGrid = false,
    orderType = 'BUY',
    orders = [],
    ttlMinutes = 30,
    isCancelAction = false,
    isProvisionalSL = false,
    comment = '',
    tp2 = null,
    breakEvenTrigger = null
  }) {
    this.valid = valid;
    this.reason = reason;
    this.channelId = channelId ? channelId.toString() : '';
    this.channelName = channelName;
    this.symbol = symbol ? symbol.replace('/', '').toUpperCase() : 'XAUUSD';
    this.action = action;
    this.orderType = orderType;
    this.entryPrice = entryPrice;
    this.slPrice = slPrice;
    this.sl = slPrice;
    this.targetTP = targetTP;
    this.tp = targetTP;
    this.tp2 = tp2;
    this.breakEvenTrigger = breakEvenTrigger;
    this.totalLotSize = totalLotSize;
    this.volume = totalLotSize;
    this.isPendingOrder = isPendingOrder;
    this.isGrid = isGrid;
    this.orders = orders;
    this.ttlMinutes = ttlMinutes;
    this.isCancelAction = isCancelAction;
    this.isProvisionalSL = isProvisionalSL;
    this.comment = comment;
    this.createdAt = Date.now();
  }
}

module.exports = {
  SignalData,
  TradeOrder,
  ExecutionPlan
};
