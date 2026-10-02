/**
 * Estrategia para Williams Tradershub (ID: -1003745883830)
 * Formato típico: "GOLD BUY NOW 4339", "SL: 4326", "TP1: 4342", "TP2: 4345"
 * Ejecución inmediata a mercado, priorizando TP2.
 */

const BaseStrategy = require('./BaseStrategy');

class WilliamsStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      preferredTP: 'TP2',
      allowGrid: false,
      pendingOrderTTLMinutes: config.pendingOrderTTLMinutes || 30
    });
  }
}

module.exports = WilliamsStrategy;
