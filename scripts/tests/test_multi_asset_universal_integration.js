const assert = require('assert');
const { proprietaryStrategyManager } = require('../../core/ProprietaryStrategyManager');
const { bprStrategyBTCUSD } = require('../../core/algorithms/BPRBtcUsdWeekendStrategy');
const { bprStrategyNAS100 } = require('../../core/algorithms/BPRNas100BullishStrategy');
const { bprStrategyGBPJPY } = require('../../core/algorithms/BPRGbpjpyBearishStrategy');
const { bprStrategyMultiTF } = require('../../core/algorithms/BPRInstitutionalMultiTimeframeStrategy');

console.log('🧪 Iniciando Test de Integración Universal Multi-Activo (BPR Live & Weekend)...\n');

// 1. Verificar carga de todas las estrategias en el Manager
const activeNames = proprietaryStrategyManager.getActiveNames ? proprietaryStrategyManager.getActiveNames() : [];
const entries = proprietaryStrategyManager.entries;
console.log(`📋 Estrategias registradas (${entries.length}):`);
for (const entry of entries) {
  console.log(`  • [${entry.id}] ${entry.name} (${entry.symbol})`);
}
assert(entries.length >= 5, 'Debe haber al menos 5 estrategias registradas (XAUUSD, EURUSD, GBPJPY, NAS100, BTCUSD)');

const hasBtc = entries.some(e => e.symbol === 'BTCUSD');
assert(hasBtc, 'BPR_BTCUSD debe estar presente en el Manager');
console.log('✅ Verificación de catálogo: Todas las estrategias registradas con éxito.');

// 2. Simular enrutamiento de ticks por símbolo
const testTicks = [
  { symbol: 'XAUUSD', bid: 2650.50, ask: 2650.75, time: Date.now() },
  { symbol: 'NAS100', bid: 20100.0, ask: 20101.5, time: Date.now() },
  { symbol: 'BTCUSD', bid: 63500.0, ask: 63515.0, time: Date.now() },
  { symbol: 'GBPJPY', bid: 195.200, ask: 195.225, time: Date.now() },
  { symbol: 'EURUSD', bid: 1.10500, ask: 1.10515, time: Date.now() }
];

for (const t of testTicks) {
  const count = proprietaryStrategyManager.processTick(t);
  assert(count >= 1, `Debe enrutar el tick de ${t.symbol} a su estrategia`);
  console.log(`  ✓ Tick ${t.symbol} @ ${t.bid} enrutado correctamente (${count} match)`);
}
console.log('✅ Enrutamiento multi-símbolo validado.');

// 3. Verificar generación de orden en BPR BTCUSD con R:R 1:3.0
const dispatchedPlans = [];
bprStrategyBTCUSD.setExecutionHandler(async (plan) => {
  dispatchedPlans.push(plan);
  return true;
});

// Mock de trade BTCUSD BUY
bprStrategyBTCUSD.openTrade('BUY', 63500, 63300, 64100, 200, Date.now());
assert(dispatchedPlans.length === 1, 'Debe despachar orden para BTCUSD');
const btcPlan = dispatchedPlans[0];
assert.strictEqual(btcPlan.symbol, 'BTCUSD');
assert.strictEqual(btcPlan.action, 'BUY');
assert.strictEqual(btcPlan.entryPrice, 63500);
assert.strictEqual(btcPlan.slPrice, 63300);
assert.strictEqual(btcPlan.tp1Price, 64100); // 63500 + 200*3 = 64100 (R:R 1:3.0)
console.log(`✅ BTCUSD M15 Orden generada con R:R 1:3.0 exacto: SL ${btcPlan.slPrice} | TP ${btcPlan.tp1Price}`);

// 4. Limpiar trade de prueba
bprStrategyBTCUSD.activeTrades = [];

console.log('\n🎉 TODOS LOS TESTS DE INTEGRACIÓN UNIVERSAL MULTI-ACTIVO PASARON CON ÉXITO.');
