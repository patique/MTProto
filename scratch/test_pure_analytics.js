const { analyticsEngine, getPipSize } = require('../core/AnalyticsEngine');

async function testPureSignalAnalytics() {
  console.log('--- Testing Pure Signal Analytics ---');
  analyticsEngine.clearHistory();

  // Test 1: Signal Buy on XAUUSD
  const sigBuy = {
    symbol: 'XAUUSD',
    action: 'BUY',
    entry: 4170.0,
    sl: 4150.0,
    tp1: 4190.0,
    messageId: 101
  };

  analyticsEngine.recordSignal('-1004307971022', 'Attaullah Zone', sigBuy, {
    entryPrice: 4170.0,
    slPrice: 4150.0,
    targetTP: 4190.0
  });

  const mBefore = analyticsEngine.getChannelMetrics('-1004307971022');
  console.log('Antes del tick:');
  console.log('Total:', mBefore.totalSignals, '| Win:', mBefore.winCount, '| Loss:', mBefore.lossCount, '| Pips:', mBefore.pipsGained);

  // Simular tick que no toca nada (4175.0)
  analyticsEngine.evaluatePriceTick({ symbol: 'XAUUSD', bid: 4175.0, ask: 4175.2 });
  const mBetween = analyticsEngine.getChannelMetrics('-1004307971022');
  console.log('Tick intermedio 4175: Win:', mBetween.winCount, 'Loss:', mBetween.lossCount);

  // Simular tick que toca TP (4191.0)
  analyticsEngine.evaluatePriceTick({ symbol: 'XAUUSD', bid: 4191.0, ask: 4191.2 });
  const mWin = analyticsEngine.getChannelMetrics('-1004307971022');
  console.log('Tick TP alcanzado (4191):');
  console.log('Total:', mWin.totalSignals, '| Win:', mWin.winCount, '| Loss:', mWin.lossCount, '| Pips:', mWin.pipsGained, '| WinRate:', mWin.winRate);

  // Test 2: Signal Sell on EURUSD
  const sigSell = {
    symbol: 'EURUSD',
    action: 'SELL',
    entry: 1.1000,
    sl: 1.1030,
    tp1: 1.0950,
    messageId: 102
  };
  analyticsEngine.recordSignal('-1004307971022', 'Attaullah Zone', sigSell, {
    entryPrice: 1.1000,
    slPrice: 1.1030,
    targetTP: 1.0950
  });

  // Simular tick que toca SL (1.1032)
  analyticsEngine.evaluatePriceTick({ symbol: 'EURUSD', bid: 1.1032, ask: 1.1033 });
  const mFinal = analyticsEngine.getChannelMetrics('-1004307971022');
  console.log('Tick SL alcanzado en EURUSD:');
  console.log('Total:', mFinal.totalSignals, '| Win:', mFinal.winCount, '| Loss:', mFinal.lossCount, '| Pips:', mFinal.pipsGained, '| WinRate:', mFinal.winRate);

  // Limpiar para dejar el sistema listo para producción
  analyticsEngine.clearHistory();
  console.log('✅ Prueba completada con éxito. Archivo limpiado.');
}

testPureSignalAnalytics().catch(console.error);
