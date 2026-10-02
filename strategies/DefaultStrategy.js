/**
 * Estrategia Genérica / Respaldo (DefaultStrategy)
 * Se utiliza para canales estándar de la lista aprobada que siguen convenciones comunes de BUY/SELL.
 */

const BaseStrategy = require('./BaseStrategy');

class DefaultStrategy extends BaseStrategy {
  constructor(config = {}) {
    super({
      ...config,
      preferredTP: config.preferredTP || 'TP2',
      allowGrid: false,
      pendingOrderTTLMinutes: config.pendingOrderTTLMinutes || 30
    });
  }
}

module.exports = DefaultStrategy;
