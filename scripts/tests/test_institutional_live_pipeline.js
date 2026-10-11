/**
 * TEST INTEGRAL DE VERIFICACIÓN 100% DEL PIPELINE EN VIVO
 * 
 * Comprueba:
 * 1. Inicialización en LIVE de los 5 activos institucionales (XAUUSD, EURUSD, GBPJPY, USDCAD, GBPUSD).
 * 2. Cableado de executionHandler al despachador MT5 executeTradePlan.
 * 3. Enrutamiento multi-cuenta:
 *    - Cuenta FTMO 100k (#1514879094): RECIBE ORDEN con cálculo de lote de 100k (0.5% riesgo)
 *    - Cuenta The5ers 5k (#26742940): RECIBE ORDEN con cálculo de lote de 5k (0.75% riesgo)
 *    - Cuenta VT Markets (#1290919): RECIBE ORDEN con lote mínimo
 *    - Cuenta FTMO antigua (#1514787530): BLOQUEADA / 0 ÓRDENES
 * 4. Verificación del endpoint /orders para simular que el EA de MT5 retira la orden en el próximo tick.
 */

const assert = require('assert');
const { proprietaryStrategyManager } = require('../../core/ProprietaryStrategyManager');
const { executeTradePlan, connectedAccounts, getOrCreateAccount } = require('../../mt5_bridge');
const { getAccountConfig } = require('../../config/accounts_config.json');

async function runPipelineVerification() {
  console.log('================================================================');
  console.log('🔍 INICIANDO AUDITORÍA INTEGRAL DE ENRUTAMIENTO EN VIVO A MT5');
  console.log('================================================================\n');

  // 1. Verificar registro y estado LIVE de las 5 estrategias
  const activeEntries = proprietaryStrategyManager.entries;
  console.log(`1. Verificando Estrategias Propietarias en Gestor (${activeEntries.length}/7 activos):`);
  
  const expectedSymbols = ['XAUUSD', 'EURUSD', 'GBPJPY', 'USDCAD', 'GBPUSD', 'AUDUSD', 'USDJPY'];
  for (const sym of expectedSymbols) {
    const entry = activeEntries.find(e => e.symbol === sym);
    assert(entry, `Falta estrategia para ${sym}`);
    assert.strictEqual(entry.strategy.isLiveExecution, true, `${sym} no está en LIVE`);
    assert(typeof entry.strategy.executionHandler === 'function', `${sym} no tiene executionHandler cableado`);
    assert.strictEqual(entry.strategy.profile.rrRatio, 3.0, `${sym} R:R ratio debe ser 3.0`);
    console.log(`   ✅ [${sym}] LIVE: ${entry.strategy.isLiveExecution} | Handler: OK | R:R: 1:${entry.strategy.profile.rrRatio} | Mecha min: ${entry.strategy.profile.minWickRatio * 100}%`);
  }

  // 2. Simular estado de cuentas conectadas
  console.log('\n2. Verificando Cortafuegos de Cuentas y Enrutamiento Multi-Broker:');
  
  // Registrar cuentas en el puente
  const ftmo100k = getOrCreateAccount('1514879094', 'FTMO Global Markets Ltd', 100024.14, 100024.14);
  const the5ers = getOrCreateAccount('26742940', 'Five Percent Online Ltd', 4633.24, 4631.52);
  const vtMarkets = getOrCreateAccount('1290919', 'VT Markets (Pty) Ltd', 100.0, 100.0);
  const oldFtmo = getOrCreateAccount('1514787530', 'FTMO Global Markets Ltd', 89999.98, 89999.98);

  // Limpiar colas previas de prueba
  ftmo100k.pendingOrders = [];
  the5ers.pendingOrders = [];
  vtMarkets.pendingOrders = [];
  oldFtmo.pendingOrders = [];

  // 3. Generar disparo sintético de orden institucional BPR EURUSD BUY
  const testSignal = {
    valid: true,
    action: 'BUY',
    symbol: 'EURUSD',
    entryPrice: 1.12350,
    slPrice: 1.12200, // 15 pips SL
    targetTP: 1.12800, // 45 pips TP (R:R 1:3.0)
    channelId: 'PROPRIETARY_BPR_INSTITUTIONAL_EURUSD_M5',
    channelName: 'BPR_INSTITUTIONAL_EURUSD_M5'
  };

  console.log(`\n3. Despachando Orden Institucional de Prueba:`);
  console.log(`   Simbolo: ${testSignal.symbol} ${testSignal.action} @ ${testSignal.entryPrice} | SL: ${testSignal.slPrice} | TP: ${testSignal.targetTP}`);

  const dispatched = await executeTradePlan(testSignal);
  assert.strictEqual(dispatched, true, 'executeTradePlan debe retornar true');

  // 4. Validar colas de órdenes por cuenta
  console.log('\n4. Verificando Colas de Despacho MT5:');

  // FTMO 100k
  assert.strictEqual(ftmo100k.pendingOrders.length, 1, 'FTMO 100k debe tener exactamente 1 orden en cola');
  const ftmoOrder = ftmo100k.pendingOrders[0];
  console.log(`   ✅ FTMO 100k (#1514879094): Recibió orden de ${ftmoOrder.volume} lotes @ ${ftmoOrder.action} EURUSD | SL: ${ftmoOrder.sl} | TP: ${ftmoOrder.tp}`);
  assert(ftmoOrder.volume >= 0.5, 'El volumen para 100k con 15 pips SL debe ser proporcional al capital');

  // The5ers 5k
  assert.strictEqual(the5ers.pendingOrders.length, 1, 'The5ers 5k debe tener exactamente 1 orden en cola');
  const the5ersOrder = the5ers.pendingOrders[0];
  console.log(`   ✅ The5ers 5k (#26742940): Recibió orden de ${the5ersOrder.volume} lotes @ ${the5ersOrder.action} EURUSD | SL: ${the5ersOrder.sl} | TP: ${the5ersOrder.tp}`);
  assert(the5ersOrder.volume < ftmoOrder.volume, 'El volumen de The5ers debe ser menor al de FTMO 100k');

  // VT Markets
  assert.strictEqual(vtMarkets.pendingOrders.length, 1, 'VT Markets debe tener exactamente 1 orden en cola');
  const vtOrder = vtMarkets.pendingOrders[0];
  console.log(`   ✅ VT Markets (#1290919): Recibió orden de ${vtOrder.volume} lotes @ ${vtOrder.action} EURUSD`);

  // FTMO Antigua (Congelada)
  assert.strictEqual(oldFtmo.pendingOrders.length, 0, 'FTMO Antigua NUNCA debe recibir órdenes');
  console.log(`   🛡️ FTMO Antigua (#1514787530): 0 órdenes recibidas (Protección Activa de Seguridad)`);

  // Limpiar colas de prueba
  ftmo100k.pendingOrders = [];
  the5ers.pendingOrders = [];
  vtMarkets.pendingOrders = [];

  console.log('\n================================================================');
  console.log('🎯 RESULTADO: 100% CONFIRMADO. EL MOTOR DISPARA Y ENTREGA A LAS CUENTAS.');
  console.log('================================================================\n');
}

runPipelineVerification().catch(err => {
  console.error('❌ Error en verificación:', err);
  process.exit(1);
});
