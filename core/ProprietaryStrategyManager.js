/**
 * Gestor central de estrategias propietarias.
 *
 * Su responsabilidad es cablear estrategias por activo al feed de ticks MT5
 * y exponer un estado uniforme para dashboard/auditoria.
 */

const { PROPRIETARY_STRATEGIES } = require('../config/proprietary_strategies.config');

function normalizeSymbol(symbol = '') {
  return String(symbol)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

class ProprietaryStrategyManager {
  constructor(configs = PROPRIETARY_STRATEGIES) {
    this.entries = configs
      .filter(cfg => cfg.enabled)
      .map(cfg => {
        const mod = require(cfg.modulePath);
        const strategy = mod[cfg.exportName];
        if (!strategy) {
          throw new Error(`No se encontro ${cfg.exportName} en ${cfg.modulePath}`);
        }
        if (typeof strategy.setExitManagement === 'function') {
          strategy.setExitManagement(cfg.exitManagement || {});
        }
        if (typeof strategy.setRiskControls === 'function') {
          strategy.setRiskControls(cfg.riskControls || {});
        }
        if (typeof strategy.setLiveExecution === 'function' && cfg.liveExecution !== undefined) {
          strategy.setLiveExecution(cfg.liveExecution);
        }

        return {
          ...cfg,
          strategy,
          normalizedAliases: (cfg.aliases || [cfg.symbol]).map(normalizeSymbol)
        };
      });
  }

  setExecutionHandler(handler) {
    for (const entry of this.entries) {
      if (typeof entry.strategy.setExecutionHandler === 'function') {
        entry.strategy.setExecutionHandler(handler);
      }
    }
  }

  setLiveExecution(defaultLiveExecution = true) {
    for (const entry of this.entries) {
      const live = entry.liveExecution !== undefined ? entry.liveExecution : defaultLiveExecution;
      if (typeof entry.strategy.setLiveExecution === 'function') {
        entry.strategy.setLiveExecution(live);
      }
    }
  }

  findEntriesForSymbol(symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) {
      return this.entries.filter(entry => entry.symbol === 'XAUUSD');
    }

    return this.entries.filter(entry => {
      if (entry.normalizedAliases.includes(normalized)) return true;
      return entry.normalizedAliases.some(alias => normalized.includes(alias) || alias.includes(normalized));
    });
  }

  processTick(tick) {
    const entries = this.findEntriesForSymbol(tick.symbol);
    for (const entry of entries) {
      entry.strategy.processTick({
        ...tick,
        symbol: entry.symbol
      });
    }
    return entries.length;
  }

  getStatus() {
    return this.entries.map(entry => {
      const strategy = entry.strategy;
      return {
        id: entry.id,
        name: entry.name,
        symbol: entry.symbol,
        liveExecution: strategy.isLiveExecution,
        riskControls: {
          maxActiveTrades: strategy.maxActiveTrades || null
        },
        metrics: strategy.metrics || null,
        activeTrades: strategy.activeTrades || [],
        timeframes: strategy.timeframes
          ? Object.fromEntries(Object.entries(strategy.timeframes).map(([tf, tfObj]) => [
              tf,
              {
                candleCount: tfObj.candles ? tfObj.candles.length : 0,
                currentBar: tfObj.currentBar || null,
                recentZones: tfObj.bprZones ? tfObj.bprZones.slice(-5) : []
              }
            ]))
          : {},
        history: strategy.history ? strategy.history.slice(-30) : []
      };
    });
  }

  getStrategy(id) {
    return this.entries.find(entry => entry.id === id)?.strategy || null;
  }

  getActiveNames() {
    return this.entries.map(entry => `${entry.symbol}:${entry.name}`);
  }
}

const proprietaryStrategyManager = new ProprietaryStrategyManager();

module.exports = {
  ProprietaryStrategyManager,
  proprietaryStrategyManager,
  normalizeSymbol
};
