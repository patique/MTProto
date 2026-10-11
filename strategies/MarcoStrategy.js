/**
 * Estrategia para MARCO TRADING HUB (ID: -1002157727490)
 * Formato típico: "BUY 4310-4306", "SL 4299", "TP1 4314", "TP2 4318"
 * Ejecución inmediata a mercado (sin órdenes pendientes que queden olvidadas).
 */

const BaseStrategy = require('./BaseStrategy');

class MarcoStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      preferredTP: config.preferredTP || 'TP3',
      allowGrid: false,
      pendingOrderTTLMinutes: config.pendingOrderTTLMinutes || 30
    });
  }
}

module.exports = MarcoStrategy;
