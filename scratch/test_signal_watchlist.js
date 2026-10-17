const { SignalWatchlistManager } = require('../core/SignalWatchlistManager');

async function testWatcher() {
  console.log('--- Testing SignalWatchlistManager ---');
  const watcher = new SignalWatchlistManager();
  clearInterval(watcher.checkInterval); // Stop automatic timer during manual test

  const dummyStrategy = {
    minRiskReward: 1.0,
    resolveTargetTP: (sig) => sig.tp1,
    createExecutionPlan: (sig, price, riskEngine) => ({
      valid: true,
      orderType: sig.action,
      symbol: sig.symbol,
      entryPrice: price,
      slPrice: sig.sl,
      targetTP: sig.tp1,
      totalLotSize: 0.05
    })
  };

  const channelCfg = { minRiskReward: 1.0 };

  // 1. Añadir señal rechazada con RR pobre: BUY a 4170, SL 4150, TP 4185 (RR = 15/20 = 0.75)
  const signal = {
    symbol: 'XAUUSD',
    action: 'BUY',
    entry: 4170,
    sl: 4150,
    tp1: 4185
  };

  const added = watcher.addToWatchlist({
    channelId: '-1004307971022',
    channelName: 'Attaullah Test',
    messageId: 9991,
    signal,
    strategy: dummyStrategy,
    channelCfg,
    initialRR: 0.75,
    targetTP: 4185
  });

  console.log('Señal añadida:', added);
  const key = watcher.getSignalKey('-1004307971022', 9991, 'XAUUSD', 'BUY');
  console.log('Watchlist size:', watcher.watchlist.size);

  // Intentar añadir duplicado
  const dup = watcher.addToWatchlist({
    channelId: '-1004307971022',
    channelName: 'Attaullah Test',
    messageId: 9991,
    signal,
    strategy: dummyStrategy,
    channelCfg,
    initialRR: 0.75,
    targetTP: 4185
  });
  console.log('¿Aceptó duplicado? (debe ser false):', dup);

  console.log('\n✅ Prueba básica superada con éxito.');
}

testWatcher().catch(console.error);
