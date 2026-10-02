/**
 * Estrategia Exclusiva para G.S Market Analysis (ID: -1003102563197)
 * - Soporte para Desglose de Rejilla (Grid) en Rangos de Entrada
 * - Prioridad estricta en TP1
 * - Expiración TTL controlada en órdenes pendientes (45 min)
 */

const BaseStrategy = require('./BaseStrategy');
const { SignalData, ExecutionPlan, TradeOrder } = require('../domain/models');

class GSMarketStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      preferredTP: 'TP1',
      allowGrid: true,
      pendingOrderTTLMinutes: config.pendingOrderTTLMinutes || 45
    });
  }

  parse(text, metadata = {}) {
    const baseSignal = super.parse(text, metadata);
    if (!baseSignal || baseSignal.isCancelEvent) return baseSignal;

    // Ajustar si el formato incluye zonas tipo: "BUY ZONE 4310 - 4305" o "4310_4305"
    return baseSignal;
  }

  createExecutionPlan(signal, livePrice = null, riskEngine) {
    if (!signal) {
      return new ExecutionPlan({ valid: false, reason: 'Señal vacía o no válida' });
    }

    if (signal.isCancelEvent) {
      return super.createExecutionPlan(signal, livePrice, riskEngine);
    }

    if (!signal.sl || signal.sl <= 0) {
      return new ExecutionPlan({
        valid: false,
        reason: 'Rechazo: Señal de G.S Market sin Stop Loss explícito.'
      });
    }

    const chosenTP = this.resolveTargetTP(signal);
    const isBuy = signal.action.toUpperCase().includes('BUY');

    // 🌐 ESTRATEGIA DE REJILLA (GRID) EXCLUSIVA PARA G.S MARKET
    if (this.allowGrid && signal.entryRange && signal.entryRange.min && signal.entryRange.max) {
      const minP = Math.floor(signal.entryRange.min);
      const maxP = Math.floor(signal.entryRange.max);
      const totalLevels = Math.abs(maxP - minP) + 1;

      if (totalLevels >= 2) {
        const baseLot = riskEngine.calculateLotSize(maxP, signal.sl, signal.symbol);
        const levelLot = Math.max(0.01, Math.floor((baseLot / totalLevels) * 100) / 100);
        const ordersList = [];

        for (let priceLevel = minP; priceLevel <= maxP; priceLevel++) {
          let levelOrderType = isBuy ? 'BUY_LIMIT' : 'SELL_LIMIT';
          if (livePrice) {
            if (isBuy) levelOrderType = (priceLevel < livePrice) ? 'BUY_LIMIT' : 'BUY_STOP';
            else levelOrderType = (priceLevel > livePrice) ? 'SELL_LIMIT' : 'SELL_STOP';
          }

          ordersList.push(new TradeOrder({
            symbol: signal.symbol,
            action: levelOrderType,
            entryPrice: priceLevel,
            sl: signal.sl,
            tp: chosenTP,
            volume: levelLot,
            comment: `GS Grid ${priceLevel}`,
            ttlMinutes: this.pendingOrderTTLMinutes
          }));
        }

        console.log(`🌐 [ESTRATEGIA REJILLA ACTIVADA (G.S Market)] Creadas ${ordersList.length} órdenes pendientes entre ${minP} y ${maxP} (Lotaje/nivel: ${levelLot})`);

        return new ExecutionPlan({
          valid: true,
          channelId: this.channelId,
          channelName: this.channelName,
          symbol: signal.symbol,
          action: isBuy ? 'BUY' : 'SELL',
          orderType: ordersList[0]?.action || 'BUY_LIMIT',
          entryPrice: signal.entryRange.min,
          slPrice: signal.sl,
          targetTP: chosenTP,
          totalLotSize: baseLot,
          isPendingOrder: true,
          isGrid: true,
          orders: ordersList,
          ttlMinutes: this.pendingOrderTTLMinutes
        });
      }
    }

    // Si no es un rango, ejecutar con plan estándar
    return super.createExecutionPlan(signal, livePrice, riskEngine);
  }
}

module.exports = GSMarketStrategy;
