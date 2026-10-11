const assert = require('assert');
const { BPRInstitutionalMultiTimeframeStrategy } = require('../../core/algorithms/BPRInstitutionalMultiTimeframeStrategy');
const { riskEngine } = require('../../core/RiskEngine');

console.log('🧪 Iniciando Test de Ejecución Real en MT5 para BPR Multi-TF...\n');

// 1. Instanciar estrategia de prueba
const bpr = new BPRInstitutionalMultiTimeframeStrategy({ symbol: 'XAUUSD' });
assert.strictEqual(bpr.isLiveExecution, true, 'Por defecto debe tener la ejecución real activa');

// Aislar el estado de test para no persistir en disco
bpr.activeTrades = [];
bpr.pendingTrades = [];
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

bpr.openTrade('M3', 'BUY', entryPrice, stopLoss, cfgM3, Date.now(), { currentPrice: 4180.50 });

// 4. Verificar que el plan enviado a MT5 sea correcto
assert.strictEqual(dispatchedPlans.length, 1, 'Debe haber despachado exactamente 1 plan');
const plan = dispatchedPlans[0];
assert.strictEqual(plan.valid, true);
assert.strictEqual(plan.action, 'BUY_LIMIT');
assert.strictEqual(plan.orderType, 'BUY_LIMIT');
assert.strictEqual(plan.isPendingOrder, true);
assert.strictEqual(plan.symbol, 'XAUUSD');
assert.strictEqual(plan.totalLotSize, expectedLot);
assert.strictEqual(plan.orders[0].volume, expectedLot);
assert.strictEqual(plan.orders[0].action, 'BUY_LIMIT');
assert.strictEqual(plan.orders[0].entryPrice, entryPrice);
assert.strictEqual(plan.orders[0].sl, stopLoss);
assert.strictEqual(plan.orders[0].comment, 'BPR M3');
assert.strictEqual(plan.ttlMinutes, 9);
assert.strictEqual(plan.channelId, 'PROPRIETARY_BPR_M3');
assert.strictEqual(plan.channelName, 'BPR Institutional M3');
assert.strictEqual(bpr.activeTrades.length, 0, 'Una limit pendiente no debe marcarse como operación abierta interna');
assert.strictEqual(bpr.pendingTrades.length, 1, 'Debe registrar 1 orden pendiente interna');
console.log('✅ Plan BUY_LIMIT generado y validado con éxito para MT5.');

// 4.5. Verificar limite de 2 operaciones simultaneas contando pendientes
bpr.openTrade('M5', 'BUY', entryPrice + 0.10, stopLoss + 0.10, cfgM3, Date.now(), { currentPrice: 4180.80 });
assert.strictEqual(dispatchedPlans.length, 2, 'Debe permitir una segunda orden pendiente');
assert.strictEqual(bpr.pendingTrades.length, 2, 'Debe haber 2 órdenes pendientes');
bpr.openTrade('M15', 'BUY', entryPrice + 0.20, stopLoss + 0.20, cfgM3, Date.now(), { currentPrice: 4181.00 });
assert.strictEqual(dispatchedPlans.length, 2, 'No debe despachar una tercera orden');
assert.strictEqual(bpr.pendingTrades.length, 2, 'Debe mantener el límite de 2 pendientes/activas');
console.log('✅ Límite de concurrencia validado: 2 órdenes pendientes/activas máximo.');

// 5. Verificar que NO se activa Auto-BE en gestion shadow de operaciones abiertas
bpr.setLiveExecution(false);
bpr.activeTrades = [];
bpr.pendingTrades = [];
bpr.openTrade('M3', 'BUY', entryPrice, stopLoss, cfgM3, Date.now());
// El precio avanza +21 pips (4182.10), pero la politica actual es sin BE/trailing.
bpr.manageActiveTrades(4182.10, 1.5);
assert.strictEqual(dispatchedPlans.length, 2, 'No debe despachar MODIFY de Auto-BE');
assert.strictEqual(bpr.activeTrades[0].currentSL, stopLoss, 'El SL interno debe mantenerse fijo');
console.log('✅ Sin Auto-BE ni trailing: no se generó MODIFY y el SL permanece fijo.');

// 6. Verificar cierre por TP2 (+60 pips desde ambas entradas)
bpr.manageActiveTrades(4186.15, 1.5);
assert.strictEqual(bpr.activeTrades.length, 0, 'La operación debe estar cerrada');
assert.strictEqual(bpr.history[bpr.history.length - 1].reason, 'TP2_FULL_WIN');
console.log('✅ Cierre y cálculo de métricas validado.');

console.log('\n🎉 TODOS LOS TESTS DE EJECUCIÓN REAL MT5 BPR PASARON CORRECTAMENTE.');
