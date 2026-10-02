/**
 * Test Completo de Nuevas Funcionalidades:
 * 1. Bucle de Retorno MT5 (POST /trade-closed)
 * 2. Mensajes de Break-Even (MOVE SL TO ENTRY / BE)
 * 3. Filtro de Noticias Económicas (NewsFilter)
 * 4. Dashboard Web & API (/api/status)
 */

const http = require('http');
const { strategyFactory } = require('../../core/StrategyFactory');
const { newsFilter } = require('../../core/NewsFilter');
const { analyticsEngine } = require('../../core/AnalyticsEngine');
const { startLocalServer, executeTradePlan } = require('../../mt5_bridge');

const TEST_PORT = 3005;
startLocalServer(TEST_PORT);

function request(path, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(JSON.stringify(postData));
    req.end();
  });
}

async function run() {
  console.log('\n========================================================================================');
  console.log('🧪 TEST DE NUEVAS FUNCIONALIDADES AVANZADAS (FEEDBACK LOOP, BREAK-EVEN, NEWS, DASHBOARD)');
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

  // 1. Test Feedback Loop desde MT5 (POST /trade-closed)
  console.log('🔹 1. Bucle de Retorno: MT5 informa de trade cerrado en TP (+75 pips)');
  const closePayload = {
    ticket: 998877,
    position: 123456,
    symbol: 'XAUUSD',
    profit: 75.50,
    outcome: 'WIN',
    comment: 'Attaullah Trading Zone'
  };

  const resClose = await request('/trade-closed', 'POST', closePayload);
  assert(resClose.status === 200 && resClose.data.success === true, 'El endpoint /trade-closed debe responder 200 OK');

  const channelMetrics = analyticsEngine.getChannelMetrics('Attaullah Trading Zone');
  assert(channelMetrics.winCount >= 1, 'El AnalyticsEngine debe haber incrementado el conteo de victorias');

  // 2. Test Detección de Break-Even
  console.log('\n🔹 2. Detección y Generación de Orden Break-Even');
  const beMsg = 'MOVE SL TO ENTRY GUYS! SECURE YOUR PROFITS 🎯';
  const strategy = strategyFactory.getStrategy('-1004307971022', 'Attaullah Trading Zone');
  const signalBE = strategy.parse(beMsg);
  assert(signalBE !== null && signalBE.isBreakEvenEvent === true, 'Debe detectar evento de Break-Even');

  const planBE = strategy.createExecutionPlan(signalBE, 4280, {});
  assert(planBE.action === 'MODIFY', 'Acción debe ser MODIFY');
  assert(planBE.orders[0].modifyType === 'BREAK_EVEN', 'Tipo de modificación debe ser BREAK_EVEN');

  const beDispatched = await executeTradePlan(planBE);
  assert(beDispatched === true, 'Comando MODIFY despachado hacia MT5 Bridge exitosamente');

  // 3. Test Filtro de Noticias Económicas
  console.log('\n🔹 3. Filtro de Noticias de Alto Impacto (NewsFilter)');
  await newsFilter.fetchCalendar();
  const upcoming = await newsFilter.getUpcomingEvents(3);
  assert(Array.isArray(upcoming), 'Debe retornar un array con próximas noticias de alto impacto');
  console.log(`     ℹ️ Noticias de alto impacto detectadas para esta semana: ${newsFilter.events.length}`);

  // 4. Test Dashboard y Endpoint /api/status
  console.log('\n🔹 4. Dashboard Web & API de Estado (/api/status)');
  const statusRes = await request('/api/status', 'GET');
  assert(statusRes.status === 200, 'Endpoint /api/status debe responder 200 OK');
  assert(typeof statusRes.data.balance === 'number', 'Debe contener el balance de la cuenta');
  assert(Array.isArray(statusRes.data.channels), 'Debe contener la lista de canales');
  assert(statusRes.data.channels.length > 0, 'La lista de canales debe estar poblada');

  const dashRes = await request('/dashboard', 'GET');
  assert(dashRes.status === 200 && typeof dashRes.raw === 'string' && dashRes.raw.includes('Antigravity MT5 Trading Hub'), 'El Dashboard HTML debe servirse correctamente en /dashboard');

  console.log('\n========================================================================================');
  console.log(`📊 RESULTADOS: ${passed} PASADOS | ${failed} FALLADOS`);
  console.log('========================================================================================\n');

  if (failed === 0) {
    console.log('🎉 ¡TODAS LAS NUEVAS FUNCIONALIDADES ESTÁN VERIFICADAS Y LISTAS!');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
