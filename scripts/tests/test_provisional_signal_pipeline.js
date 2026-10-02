/**
 * Test de Señales Rápidas con SL Provisional y Actualización Dinámica
 */
process.env.NODE_ENV = 'test';
const assert = require('assert');
const { AdaptiveParser } = require('../../core/AdaptiveParser');
const { processSignalForExecution } = require('../../risk_engine');
const { executeTradePlan } = require('../../mt5_bridge');

async function testProvisionalSignalWorkflow() {
  console.log('\n========================================================================================');
  console.log('🧪 TEST: FLUJO DE SEÑAL RÁPIDA (FALLBACK SL) + CONFIRMACIÓN POSTERIOR DE PARÁMETROS');
  console.log('========================================================================================\n');

  const parser = new AdaptiveParser();

  // 1. Mensaje Rápido sin SL ("GOLD SELL AGAIN 4294 - 4298")
  console.log('🔹 1. Parseo de señal rápida sin SL...');
  const msg1 = "GOLD SELL AGAIN 4294 - 4298";
  const sig1 = parser.parseMessage(msg1, "-1002157727490", "MARCO TRADING HUB");
  assert(sig1 !== null, 'Debe parsear la señal rápida');
  assert(sig1.action === 'SELL', 'Acción debe ser SELL');
  assert(sig1.sl === null, 'SL original debe ser null');

  const plan1 = processSignalForExecution(sig1, 4296);
  assert(plan1.valid === true, 'El plan debe ser válido con SL preventivo');
  assert(plan1.isProvisionalSL === true, 'Debe marcarse como isProvisionalSL = true');
  assert(plan1.slPrice > 4296, 'El SL preventivo debe ser coherente para un SELL (mayor que el precio)');
  console.log(`  ✅ [PASS]: SL Preventivo asignado correctamente: ${plan1.slPrice} (Entrada: ${plan1.entryPrice})`);

  const dispatched1 = await executeTradePlan(plan1);
  assert(dispatched1 === true, 'Debe despachar la orden a mercado con SL provisional');
  console.log('  ✅ [PASS]: Orden a mercado con SL provisional despachada');

  // 2. Mensaje Confirmatorio con Parámetros 2 minutos después
  console.log('\n🔹 2. Llegada de parámetros oficiales...');
  const msg2 = "GOLD SELL NOW 4294 - 4298\n\nTP 4290 - TP 4286 - TP 4282 TP 4270\n\nSL : 4304";
  const sig2 = parser.parseMessage(msg2, "-1002157727490", "MARCO TRADING HUB");
  assert(sig2.sl === 4304, 'Debe parsear el SL oficial 4304');
  assert(sig2.tp1 === 4290 && sig2.tp2 === 4286, 'Debe parsear los TPs oficiales');

  const plan2 = processSignalForExecution(sig2, 4296);
  assert(plan2.isProvisionalSL === false, 'El plan 2 tiene SL oficial, no provisional');

  const dispatched2 = await executeTradePlan(plan2);
  assert(dispatched2 === true, 'Debe despachar la actualización dinámica de parámetros');
  console.log('  ✅ [PASS]: Actualización dinámica UPDATE_PARAMS despachada exitosamente hacia MT5');

  console.log('\n========================================================================================');
  console.log('📊 RESULTADOS: FLUJO PROVISIONAL -> CONFIRMADO VERIFICADO AL 100%');
  console.log('========================================================================================\n');
}

testProvisionalSignalWorkflow().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
