/**
 * Test de Integración y Validación del Pipeline Completo (Node.js -> HTTP Server -> JSON Queue -> MT5 Endpoints)
 * Simula eventos reales de Telegram de varios canales y valida la respuesta del servidor y el formateo de órdenes.
 */

const http = require('http');
const { processSignalForExecution } = require('../../risk_engine');
const { startLocalServer } = require('../../mt5_bridge');

// Asegurar servidor iniciado en puerto 3000
startLocalServer(3000);

// Helper para hacer peticiones HTTP al servidor
function makeRequest(path, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: body });
        }
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTestSuite() {
  console.log('\n========================================================================================');
  console.log('🧪 INICIANDO BATERÍA DE TEST DE INTEGRACIÓN PIPELINE TELEGRAM -> MT5 BRIDGE');
  console.log('========================================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS]: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL]: ${message}`);
      failed++;
    }
  }

  try {
    // --------------------------------------------------------------------------------------------------
    // TEST 1: Señal Estándar a Mercado (Williams Tradershub - Gold Buy Now 4339)
    // --------------------------------------------------------------------------------------------------
    console.log('🔹 Test 1: Parseo y Despacho de Orden a Mercado (Gold Buy Now 4339)');
    const signal1 = {
      action: 'BUY',
      pair: 'GOLD',
      entry: 4339,
      sl: 4326,
      tp1: 4342,
      tp2: 4345,
      rawText: 'GOLD BUY NOW 4339',
      channelName: 'Williams tradershub'
    };

    const plan1 = processSignalForExecution(signal1, 4339);
    assert(plan1.valid === true, 'El plan de ejecución debe ser válido');
    assert(plan1.action === 'BUY', 'La acción debe ser BUY a mercado');
    assert(plan1.symbol === 'GOLD', 'El símbolo debe ser GOLD (resoluble por MT5 a XAUUSD)');

    // Enviar al servidor HTTP local
    const postRes1 = await makeRequest('/orders', 'POST', plan1);
    assert(postRes1.statusCode === 200 && postRes1.data.success === true, 'El servidor HTTP debe aceptar el POST de la orden');

    // Simular consulta GET del EA de MT5
    const getRes1 = await makeRequest('/orders?balance=100000&bid=4339&ask=4339.5', 'GET');
    assert(getRes1.statusCode === 200, 'El EA debe recibir status 200 OK');
    assert(Array.isArray(getRes1.data) && getRes1.data.length === 1, 'El EA debe recibir exactamente 1 orden');
    assert(getRes1.data[0].action === 'BUY', 'La orden entregada al EA debe ser action BUY exacto');

    // --------------------------------------------------------------------------------------------------
    // TEST 2: Señal Pendiente EXPLÍCITA (FX PRO SIGNAL TEAM - SELL_LIMIT en 4336)
    // --------------------------------------------------------------------------------------------------
    console.log('\n🔹 Test 2: Parseo y Despacho de Orden Pendiente (SELL_LIMIT)');
    const signal2 = {
      action: 'SELL',
      pair: 'XAUUSD',
      entry: 4336,
      sl: 4345,
      tp1: 4333,
      tp2: 4330,
      tp3: 4327,
      rawText: '📊 #XAUUSD Sell Now 4336 limit 4339🕯\nSL.4345',
      channelName: '𝙁𝙓 𝙋𝙍𝙊 𝙎𝙄𝙂𝙉𝘼𝙇 𝙏𝙀𝘼𝙈 ♛'
    };

    const plan2 = processSignalForExecution(signal2, 4335); // Mercado en 4335, entrada en 4336 => SELL_LIMIT
    assert(plan2.valid === true, 'Plan 2 debe ser válido');
    assert(plan2.isPendingOrder === true, 'Debe marcarse como orden pendiente');
    assert(plan2.orderType === 'SELL_LIMIT', 'orderType debe ser SELL_LIMIT exacto');

    await makeRequest('/orders', 'POST', plan2);
    const getRes2 = await makeRequest('/orders?balance=100000&bid=4335&ask=4335.5', 'GET');
    assert(getRes2.data.length === 1, 'El EA debe recibir la orden pendiente');
    assert(getRes2.data[0].orderType === 'SELL_LIMIT', 'El EA debe recibir orderType SELL_LIMIT exacto');

    // --------------------------------------------------------------------------------------------------
    // TEST 3: Estrategia de Rejilla Multi-Nivel (G.S Market Analysis - Entry 4310-4305)
    // --------------------------------------------------------------------------------------------------
    console.log('\n🔹 Test 3: Estrategia Rejilla (Grid Breakdown 4310-4305)');
    const signal3 = {
      action: 'BUY',
      pair: 'XAUUSD',
      entryRange: { min: 4305, max: 4310 },
      sl: 4300,
      tp1: 4320,
      tp2: 4340,
      rawText: 'BUY LIMIT Entry: 4310-4305 Stop Loss: 4300',
      channelName: 'G.S Market Analysis'
    };

    const plan3 = processSignalForExecution(signal3, 4315);
    assert(plan3.valid === true, 'Plan Rejilla debe ser válido');
    assert(plan3.isGrid === true, 'Debe identificar estructura de rejilla');
    assert(plan3.orders.length === 6, 'Debe desglosar 6 sub-órdenes independientes (4305 a 4310)');
    assert(plan3.orders.every(o => o.symbol === 'XAUUSD' && o.action === 'BUY_LIMIT'), 'Cada sub-orden debe tener symbol y action válidos');

    await makeRequest('/orders', 'POST', plan3.orders);
    const getRes3 = await makeRequest('/orders?balance=100000&bid=4315&ask=4315.5', 'GET');
    assert(getRes3.data.length === 6, 'El EA de MT5 debe recibir las 6 sub-órdenes de la rejilla');

    // --------------------------------------------------------------------------------------------------
    // TEST 3.5: Verificación de Canal No-G.S. Market (No debe crear Rejilla aunque tenga rango)
    // --------------------------------------------------------------------------------------------------
    console.log('\n🔹 Test 3.5: Señal con Rango de Canal Estándar (Ej. Marco Trading Hub - No debe hacer Rejilla)');
    const signal3_5 = {
      action: 'BUY',
      pair: 'XAUUSD',
      entry: 4310,
      entryRange: { min: 4306, max: 4310 },
      sl: 4298,
      tp1: 4314,
      tp2: 4318,
      rawText: 'OPEN GOLD BUY 4310 - 4306',
      channelName: 'MARCO TRADING HUB🏅'
    };

    const plan3_5 = processSignalForExecution(signal3_5, 4310);
    assert(plan3_5.valid === true, 'Plan Marco Trading Hub debe ser válido');
    assert(!plan3_5.isGrid, 'NO debe activar rejilla (isGrid = false/undefined)');
    assert(!plan3_5.isPendingOrder && plan3_5.action === 'BUY', 'Debe ejecutarse como orden A MERCADO inmediata (BUY)');

    // --------------------------------------------------------------------------------------------------
    // TEST 4: Comando de Cancelación Selectiva (CANCEL_ALL_PENDING / targetType)
    // --------------------------------------------------------------------------------------------------
    console.log('\n🔹 Test 4: Cancelación de Órdenes Pendientes sin Afectar Trades Activos');
    const cancelCmd = {
      action: 'CANCEL_ALL_PENDING',
      symbol: 'XAUUSD',
      targetType: 'BUY_LIMIT',
      reason: 'NO TP HIT update'
    };

    await makeRequest('/orders', 'POST', cancelCmd);
    const getRes4 = await makeRequest('/orders?balance=100000&bid=4315&ask=4315.5', 'GET');
    assert(getRes4.data.length === 1, 'Debe despachar el comando de cancelación al EA');
    assert(getRes4.data[0].targetType === 'BUY_LIMIT', 'Debe especificar el filtro de orden a cancelar');

    // --------------------------------------------------------------------------------------------------
    // RESUMEN FINAL
    // --------------------------------------------------------------------------------------------------
    console.log('\n========================================================================================');
    console.log(`📊 RESULTADOS DE LA BATERÍA DE TEST: ${passed} PASADOS | ${failed} FALLADOS`);
    console.log('========================================================================================\n');

    if (failed === 0) {
      console.log('✨ TODO EL PIPELINE ESTÁ 100% FUNCIONAL Y VERIFICADO. SISTEMA LISTO PARA PRODUCCIÓN.\n');
    }

  } catch (err) {
    console.error('❌ Error ejecutando test:', err);
  } finally {
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTestSuite();
