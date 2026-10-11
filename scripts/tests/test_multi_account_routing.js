const assert = require('assert');
const { riskEngine } = require('../../core/RiskEngine');
const { executeTradePlan, connectedAccounts, getOrCreateAccount } = require('../../mt5_bridge');

async function runMultiAccountTest() {
  console.log('🧪 ========================================================');
  console.log('🧪 TEST: ENRUTAMIENTO MULTI-CUENTA Y TAMAÑO DE LOTE PROPORCIONAL');
  console.log('🧪 ========================================================\n');

  // 1. Simular dos cuentas conectadas
  const acc5k = getOrCreateAccount('555001', 'The 5%ers 5k', 5000.0, 5000.0, 0);
  const acc100k = getOrCreateAccount('100001', 'FTMO 100k', 100000.0, 100000.0, 0);

  assert.strictEqual(acc5k.id, '555001');
  assert.strictEqual(acc100k.id, '100001');
  assert.strictEqual(acc5k.initialBalance, 5000);
  assert.strictEqual(acc100k.initialBalance, 100000);
  assert.strictEqual(acc5k.targetProfitBalance, 5500);
  assert.strictEqual(acc100k.targetProfitBalance, 110000);

  console.log('✅ Paso 1: Registro de terminales y metas (+10%) validado con éxito.');
  console.log(`   - Cuenta #${acc5k.id}: Saldo $${acc5k.balance} | Meta: $${acc5k.targetProfitBalance}`);
  console.log(`   - Cuenta #${acc100k.id}: Saldo $${acc100k.balance} | Meta: $${acc100k.targetProfitBalance}\n`);

  // 2. Limpiar colas pendientes previas si hubiera
  acc5k.pendingOrders = [];
  acc100k.pendingOrders = [];

  // 3. Crear una señal institucional BPR en Oro (XAUUSD) con SL de 3.5 puntos (35 pips)
  const tradePlan = {
    valid: true,
    action: 'BUY',
    symbol: 'XAUUSD',
    entryPrice: 2650.00,
    slPrice: 2646.50, // 35 pips de riesgo
    targetTP: 2660.00,
    tp: 2660.00,
    totalLotSize: 0.10,
    channelId: 'PROPRIETARY_BPR_M3',
    channelName: 'BPR Institutional M3',
    bypassTimeShields: true
  };

  console.log('🚀 Despachando señal a través de executeTradePlan()...');
  await executeTradePlan(tradePlan, null, { bypassTimeShields: true });

  // 4. Verificar qué recibió cada cuenta
  console.log(`\n📦 Órdenes en cola para Cuenta #${acc5k.id}: ${acc5k.pendingOrders.length}`);
  console.log(`📦 Órdenes en cola para Cuenta #${acc100k.id}: ${acc100k.pendingOrders.length}`);

  assert.strictEqual(acc5k.pendingOrders.length, 1, 'Cuenta 5k debe tener 1 orden en su cola');
  assert.strictEqual(acc100k.pendingOrders.length, 1, 'Cuenta 100k debe tener 1 orden en su cola');

  const order5k = acc5k.pendingOrders[0];
  const order100k = acc100k.pendingOrders[0];

  console.log(`\n🔍 Verificando lotaje proporcional:`);
  console.log(`   - Cuenta 5k:   Lote asignado = ${order5k.volume} Lotes (Esperado: 0.10)`);
  console.log(`   - Cuenta 100k: Lote asignado = ${order100k.volume} Lotes (Esperado: 2.00)`);

  assert.strictEqual(order5k.volume, 0.10, 'El lotaje para la cuenta de 5k debe ser estrictamente 0.10 lotes');
  assert.strictEqual(order100k.volume, 2.00, 'El lotaje para la cuenta de 100k debe ser estrictamente 2.00 lotes (20x proporcional)');
  assert.strictEqual(order5k.symbol, 'XAUUSD');
  assert.strictEqual(order100k.symbol, 'XAUUSD');
  assert.strictEqual(order5k.sl, 2646.50);
  assert.strictEqual(order100k.sl, 2646.50);

  console.log('✅ Paso 2: Lotaje proporcional exacto (0.10 vs 2.00) comprobado con éxito.\n');

  // 5. Simular cierre de una cuenta aprobando el examen
  console.log('🎯 Simulando que Cuenta 5k alcanza los $5,500 USD (+10% de ganancia)...');
  acc5k.balance = 5510.0;
  // Simular consulta de la cuenta 5k
  acc5k.pendingOrders = [];
  acc100k.pendingOrders = [];

  // Al simular el freno:
  if (acc5k.balance >= acc5k.targetProfitBalance) {
    acc5k.evaluationTargetHalted = true;
  }

  assert.strictEqual(acc5k.evaluationTargetHalted, true);

  // Despachar una nueva señal
  await executeTradePlan(tradePlan, null, { bypassTimeShields: true });

  console.log(`\n📦 Tras Freno de Meta (+10%):`);
  console.log(`   - Cuenta 5k (Aprobada): ${acc5k.pendingOrders.length} ordenes recibidas (Esperado: 0, congelada)`);
  console.log(`   - Cuenta 100k (En curso): ${acc100k.pendingOrders.length} ordenes recibidas (Esperado: 1, activa)`);

  assert.strictEqual(acc5k.pendingOrders.length, 0, 'La cuenta 5k ya aprobó y no debe recibir órdenes');
  assert.strictEqual(acc100k.pendingOrders.length, 1, 'La cuenta 100k debe seguir operando normalmente');
  assert.strictEqual(acc100k.pendingOrders[0].volume, 2.00);

  console.log('\n🎉 ========================================================');
  console.log('🎉 TODOS LOS TESTS DE ENRUTAMIENTO MULTI-CUENTA PASARON (100%)');
  console.log('🎉 ========================================================\n');
  process.exit(0);
}

runMultiAccountTest().catch(err => {
  console.error('❌ Error en test multi-cuenta:', err);
  process.exit(1);
});
