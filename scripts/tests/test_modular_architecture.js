/**
 * Batería de Pruebas Unitarias e Integración para la Nueva Arquitectura Modular
 */

const { strategyFactory } = require('../../core/StrategyFactory');
const { riskEngine } = require('../../core/RiskEngine');
const { pendingOrderManager } = require('../../core/PendingOrderManager');
const { analyticsEngine } = require('../../core/AnalyticsEngine');
const { executeTradePlan } = require('../../mt5_bridge');

async function runTests() {
  console.log('\n========================================================================================');
  console.log('🧪 EJECUTANDO BATERÍA DE PRUEBAS DE LA ARQUITECTURA MODULAR');
  console.log('========================================================================================\n');

  // Limpiar estado previo de tests para aislamiento
  analyticsEngine.stats = {};

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ [PASS]: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL]: ${testName}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // TEST 1: Señal de Attaullah Trading Zone (Verificar: NO GRID, Sin 'undefined', TP2)
  // -------------------------------------------------------------------------
  console.log('🔹 Test 1: Attaullah Trading Zone (Zonas de entrada sin Grid)');
  const attaullahMsg = `#XAUUSD  (GOLD)  

🟢 SELL ZONE 4282__4285

🔸 Stoploss:  4293

🔹 Takeprofit 1: 4275
🔹 Takeprofit 2: 4270
🔹 Takeprofit 3: 4265
🔹 Takeprofit 4: 4260
🔹 Takeprofit 5: 4252`;

  const attaullahStrategy = strategyFactory.getStrategy('-1004307971022', 'Attaullah Trading Zone');
  const signalAttaullah = attaullahStrategy.parse(attaullahMsg, { messageId: 101 });

  assert(signalAttaullah !== null, 'Señal de Attaullah parseada con éxito');
  assert(signalAttaullah.action === 'SELL', 'Acción debe ser SELL');
  assert(signalAttaullah.sl === 4293, `Stop Loss debe ser 4293 (obtenido: ${signalAttaullah.sl})`);
  assert(signalAttaullah.tp1 === 4275, `TP1 debe ser 4275 (obtenido: ${signalAttaullah.tp1})`);
  assert(signalAttaullah.tp2 === 4270, `TP2 debe ser 4270 (obtenido: ${signalAttaullah.tp2})`);

  const planAttaullah = attaullahStrategy.createExecutionPlan(signalAttaullah, 4284, riskEngine);
  assert(planAttaullah.valid === true, 'Plan de Attaullah debe ser válido');
  assert(planAttaullah.isGrid === false, 'Attaullah NUNCA debe generar Grid/Rejilla');
  assert(planAttaullah.targetTP === 4270, `TP objetivo debe ser TP2 (4270) (obtenido: ${planAttaullah.targetTP})`);
  assert(planAttaullah.symbol === 'XAUUSD', 'Símbolo no debe ser undefined');
  assert(planAttaullah.action === 'SELL', 'Acción no debe ser undefined');

  // Probar despacho hacia el MT5 Bridge
  const bridgeOk1 = await executeTradePlan(planAttaullah);
  assert(bridgeOk1 === true, 'Despacho hacia MT5 Bridge exitoso sin errores ni undefined');

  // -------------------------------------------------------------------------
  // TEST 2: G.S Market Analysis (Verificar: GRID exclusivo con TP1)
  // -------------------------------------------------------------------------
  console.log('\n🔹 Test 2: G.S Market Analysis (Estrategia Rejilla / Grid con TP1)');
  const gsMsg = `GOLD BUY 4310-4306
SL 4295
TP1 4320
TP2 4340`;

  const gsStrategy = strategyFactory.getStrategy('-1003102563197', 'G.S Market Analysis');
  const signalGS = gsStrategy.parse(gsMsg, { messageId: 102 });

  assert(signalGS !== null, 'Señal de G.S Market parseada');
  assert(signalGS.action === 'BUY', 'Acción debe ser BUY');

  const planGS = gsStrategy.createExecutionPlan(signalGS, 4308, riskEngine);
  assert(planGS.valid === true, 'Plan de G.S Market debe ser válido');
  assert(planGS.isGrid === true, 'G.S Market SÍ debe generar Grid para rangos');
  assert(planGS.orders.length === 5, `Debe generar 5 sub-órdenes de rejilla (obtenido: ${planGS.orders.length})`);
  assert(planGS.targetTP === 4320, `G.S Market debe priorizar TP1 (4320) (obtenido: ${planGS.targetTP})`);

  const bridgeOk2 = await executeTradePlan(planGS);
  assert(bridgeOk2 === true, 'Despacho de Grid al MT5 Bridge exitoso');

  // -------------------------------------------------------------------------
  // TEST 3: Filtro Anti-Actualizaciones (Evitar entradas falsas por festejos de TP)
  // -------------------------------------------------------------------------
  console.log('\n🔹 Test 3: Filtro Anti-Actualizaciones (TP1 HIT 🔥)');
  const updateMsg = `🔥 TP1 HIT RUNNING +40 PIPS SECURED! BOOM ENJOY PROFITS 🔥`;
  const signalUpdate = attaullahStrategy.parse(updateMsg);
  assert(signalUpdate === null, 'El mensaje de actualización puro debe ser descartado (no generar entrada falsa)');

  const beMsg = `🔥 TP1 HIT! MOVE SL TO ENTRY / BREAKEVEN`;
  const signalBE = attaullahStrategy.parse(beMsg);
  assert(signalBE !== null && signalBE.action === 'MODIFY', 'Mensaje con instrucción de Break-Even debe generar orden MODIFY');

  // -------------------------------------------------------------------------
  // TEST 4: Detección y Gestión de Cancelaciones ("CANCEL LIMITS")
  // -------------------------------------------------------------------------
  console.log('\n🔹 Test 4: Mensaje de Cancelación');
  const cancelMsg = `CANCEL ALL PENDING ORDERS / LIMITS`;
  const signalCancel = gsStrategy.parse(cancelMsg);
  assert(signalCancel !== null && signalCancel.isCancelEvent === true, 'Debe detectar evento de cancelación');

  const planCancel = gsStrategy.createExecutionPlan(signalCancel, null, riskEngine);
  assert(planCancel.isCancelAction === true, 'El plan debe ser de acción de cancelación');
  assert(planCancel.orderType === 'CANCEL_ALL_PENDING', 'Tipo de orden debe ser CANCEL_ALL_PENDING');

  // -------------------------------------------------------------------------
  // TEST 5: Watchdog de Expiración TTL para Órdenes Pendientes
  // -------------------------------------------------------------------------
  console.log('\n🔹 Test 5: Watchdog de Expiración (TTL) de Órdenes Pendientes');
  let cancelCalled = false;
  pendingOrderManager.setCancelDispatcher(async () => {
    cancelCalled = true;
  });

  const simulatedOrder = {
    id: 'test_order_999',
    symbol: 'XAUUSD',
    action: 'BUY_LIMIT',
    entryPrice: 4280,
    sl: 4270,
    tp: 4295
  };

  // Registrar orden con TTL de 0.001 minutos (expiración inmediata)
  pendingOrderManager.registerPendingOrder(simulatedOrder, '-1003102563197', 'G.S Market Analysis', 0.0001);
  // Forzar chequeo tras esperar 20ms
  await new Promise(r => setTimeout(r, 20));
  await pendingOrderManager.checkExpiredOrders();
  assert(cancelCalled === true, 'La orden expirada debe disparar el despachador de cancelación');

  // -------------------------------------------------------------------------
  // TEST 6: Motor de Analíticas y Win Rate por Canal
  // -------------------------------------------------------------------------
  console.log('\n🔹 Test 6: Motor de Analíticas y Win Rate por Canal');
  analyticsEngine.recordOutcome('-1004307971022', 'WIN', 40);
  analyticsEngine.recordOutcome('-1004307971022', 'WIN', 50);
  analyticsEngine.recordOutcome('-1004307971022', 'LOSS', 30);

  const metrics = analyticsEngine.getChannelMetrics('-1004307971022');
  assert(metrics.winCount === 2, 'Debe registrar 2 victorias');
  assert(metrics.lossCount === 1, 'Debe registrar 1 pérdida');
  assert(metrics.winRate === '66.7%', `Win Rate debe ser 66.7% (obtenido: ${metrics.winRate})`);

  console.log('\n========================================================================================');
  console.log(`📊 RESULTADOS FINALES: ${passed} PASADOS, ${failed} FALLIDOS`);
  console.log('========================================================================================\n');

  analyticsEngine.printReport();

  if (failed === 0) {
    console.log('🎉 ¡TODOS LOS TESTS DE LA NUEVA ARQUITECTURA PASARON CON ÉXITO!');
    process.exit(0);
  } else {
    console.error('❌ Algunos tests fallaron.');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Error ejecutando tests:', err);
  process.exit(1);
});
