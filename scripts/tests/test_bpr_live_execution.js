const assert = require('assert');
const { BPRInstitutionalMultiTimeframeStrategy } = require('../../core/algorithms/BPRInstitutionalMultiTimeframeStrategy');
const { riskEngine } = require('../../core/RiskEngine');

console.log('🧪 Iniciando Test de Ejecución Real en MT5 para BPR Multi-TF...\n');

// 1. Instanciar estrategia de prueba
const bpr = new BPRInstitutionalMultiTimeframeStrategy({ symbol: 'XAUUSD' });
assert.strictEqual(bpr.isLiveExecution, true, 'Por defecto debe tener la ejecución real activa');

// Aislar el estado de test para no persistir en disco
bpr.activeTrades = [];
bpr.saveState = () => {};

// 2. Mock del ExecutionHandler
const dispatchedPlans = [];
bpr.setExecutionHandler(async (plan) => {
  dispatchedPlans.push(plan);
  return true;
});

// 3. Simular disparo de señal M3 BUY
const cfgM3 = {
  tfMinutes: 3,
  slPips: 12.0,
  tp1Pips: 30.0,
  tp2Pips: 60.0,
  autoBe: 20.0
};

const entryPrice = 4180.00;
const stopLoss = entryPrice - (cfgM3.slPips / 10.0); // 4178.80
const expectedLot = riskEngine.calculateLotSize(entryPrice, stopLoss, 'XAUUSD');

console.log(`📊 Parámetros: Entrada=${entryPrice}, SL=${stopLoss}, Lote calculado=${expectedLot}`);
assert(expectedLot > 0, 'El lote debe ser superior a 0');

bpr.openTrade('M3', 'BUY', entryPrice, stopLoss, cfgM3, Date.now());

// 4. Verificar que el plan enviado a MT5 sea correcto
assert.strictEqual(dispatchedPlans.length, 1, 'Debe haber despachado exactamente 1 plan');
const plan = dispatchedPlans[0];
assert.strictEqual(plan.valid, true);
assert.strictEqual(plan.action, 'BUY');
assert.strictEqual(plan.symbol, 'XAUUSD');
assert.strictEqual(plan.totalLotSize, expectedLot);
assert.strictEqual(plan.orders.length, 1);
assert.strictEqual(plan.orders[0].volume, expectedLot);
assert.strictEqual(plan.orders[0].sl, stopLoss);
assert.strictEqual(plan.orders[0].tp, 4186.00, 'TP2 debe ser 4186.00');
assert.strictEqual(plan.orders[0].comment, 'BPR M3');
assert.strictEqual(plan.channelId, 'PROPRIETARY_BPR_M3');
assert.strictEqual(plan.channelName, 'BPR Institutional M3');
console.log('✅ Plan de entrada a mercado generado y validado con éxito para MT5.');

// 5. Verificar activación de Auto-BE en gestión de operaciones
// El precio avanza +21 pips (4182.10)
bpr.manageActiveTrades(4182.10, 1.5);
assert.strictEqual(dispatchedPlans.length, 2, 'Debe haber despachado la orden MODIFY de Auto-BE');
const bePlan = dispatchedPlans[1];
assert.strictEqual(bePlan.action, 'MODIFY');
assert.strictEqual(bePlan.comment, 'BPR M3');
assert.strictEqual(bePlan.modifyOrder.modifyType, 'UPDATE_PARAMS');
assert.strictEqual(bePlan.modifyOrder.sl, 4180.20, 'SL debe estar ajustado a entrada + 0.20');
console.log('✅ Comando MODIFY de Auto-BE generado y validado con éxito para MT5.');

// 6. Verificar cierre por TP2 (+60 pips = 4186.00)
bpr.manageActiveTrades(4186.05, 1.5);
assert.strictEqual(bpr.activeTrades.length, 0, 'La operación debe estar cerrada');
assert.strictEqual(bpr.history[bpr.history.length - 1].reason, 'TP2_FULL_WIN');
console.log('✅ Cierre y cálculo de métricas validado.');

console.log('\n🎉 TODOS LOS TESTS DE EJECUCIÓN REAL MT5 BPR PASARON CORRECTAMENTE.');
