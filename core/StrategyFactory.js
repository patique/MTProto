/**
 * Factory Pattern: Resuelve y gestiona instancias de Estrategias por Canal
 */

const { findChannelConfig } = require('../config/channels.config');
const GSMarketStrategy = require('../strategies/GSMarketStrategy');
const AttaullahStrategy = require('../strategies/AttaullahStrategy');
const WilliamsStrategy = require('../strategies/WilliamsStrategy');
const MarcoStrategy = require('../strategies/MarcoStrategy');
const DefaultStrategy = require('../strategies/DefaultStrategy');

const STRATEGY_MAP = {
  GSMarketStrategy,
  AttaullahStrategy,
  WilliamsStrategy,
  MarcoStrategy,
  DefaultStrategy
};

class StrategyFactory {
  constructor() {
    this.instances = new Map();
  }

  /**
   * Obtiene la estrategia adecuada para un canal dado su Peer ID o Título
   * @param {string|number} channelId
   * @param {string} channelTitle
   * @returns {BaseStrategy}
   */
  getStrategy(channelId, channelTitle = '') {
    const config = findChannelConfig(channelId, channelTitle);
    const cacheKey = config.id || channelTitle;

    if (this.instances.has(cacheKey)) {
      return this.instances.get(cacheKey);
    }

    const StrategyClass = STRATEGY_MAP[config.strategy] || DefaultStrategy;
    const instance = new StrategyClass(config);
    this.instances.set(cacheKey, instance);

    return instance;
  }
}

// Instancia singleton para uso en toda la app
const strategyFactory = new StrategyFactory();

module.exports = {
  StrategyFactory,
  strategyFactory
};
