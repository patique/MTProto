/**
 * Fachada de Compatibilidad para el Motor de Gestión de Riesgo
 * Conecta las llamadas heredadas con la nueva arquitectura modular
 */

const { CONFIG, riskEngine } = require('./core/RiskEngine');
const { strategyFactory } = require('./core/StrategyFactory');
const { SignalData } = require('./domain/models');

function calculateLotSize(balance, riskPercent, entryPrice, slPrice, symbol = 'XAUUSD') {
  if (balance && balance > 0) riskEngine.currentBalance = balance;
  return riskEngine.calculateLotSize(entryPrice, slPrice, symbol);
}

function processSignalForExecution(signalInput, currentMarketPrice = null) {
  const signal = signalInput instanceof SignalData ? signalInput : new SignalData(signalInput);
  const strategy = strategyFactory.getStrategy(signal.channelId, signal.channelName);
  
  let livePrice = null;
  if (typeof currentMarketPrice === 'number' && currentMarketPrice > 0) {
    livePrice = currentMarketPrice;
  } else if (currentMarketPrice && typeof currentMarketPrice === 'object') {
    livePrice = signal.action.toUpperCase().includes('BUY') 
      ? (currentMarketPrice.ask || currentMarketPrice.bid)
      : (currentMarketPrice.bid || currentMarketPrice.ask);
  }

  return strategy.createExecutionPlan(signal, livePrice, riskEngine);
}

module.exports = {
  CONFIG,
  calculateLotSize,
  processSignalForExecution,
  riskEngine
};
