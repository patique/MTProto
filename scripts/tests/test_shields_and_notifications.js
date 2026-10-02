/**
 * Test Suite: Rollover Shield, Friday Close Guard & Push Notification Service
 */

const assert = require('assert');
const { riskEngine } = require('../../core/RiskEngine');
const { notificationService } = require('../../core/NotificationService');
const { initMT5Bridge, executeTradePlan } = require('../../mt5_bridge');

async function runTests() {
  console.log('========================================================================================');
  console.log('🧪 TEST: ESCUDOS TEMPORALES (ROLLOVER & VIERNES) + SERVICIO DE NOTIFICACIONES PUSH');
  console.log('========================================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ [PASS]: ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ❌ [FAIL]: ${name} ->`, e.message);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS]: ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ❌ [FAIL]: ${name} ->`, e.message);
      failed++;
    }
  }

  // ----------------------------------------------------
  // 1. Rollover Shield (22:55 - 00:10 CET)
  // ----------------------------------------------------
  console.log('🔹 1. Verificación Matemática del Rollover Shield (22:55 a 00:10 CET)');

  test('Debe detectar ventana activa a las 22:56 CET', () => {
    // 2026-09-24 20:56 UTC = 22:56 CEST (Madrid)
    const inRollover = riskEngine.isRolloverWindow(new Date('2026-09-24T20:56:00Z'));
    assert.strictEqual(inRollover, true);
  });

  test('Debe detectar ventana activa a las 00:05 CET', () => {
    // 2026-09-24 22:05 UTC = 00:05 CEST
    const inRollover = riskEngine.isRolloverWindow(new Date('2026-09-24T22:05:00Z'));
    assert.strictEqual(inRollover, true);
  });

  test('Debe detectar ventana INACTIVA a las 22:50 CET', () => {
    // 2026-09-24 20:50 UTC = 22:50 CEST
    const inRollover = riskEngine.isRolloverWindow(new Date('2026-09-24T20:50:00Z'));
    assert.strictEqual(inRollover, false);
  });

  test('Debe detectar ventana INACTIVA a las 00:15 CET', () => {
    // 2026-09-24 22:15 UTC = 00:15 CEST
    const inRollover = riskEngine.isRolloverWindow(new Date('2026-09-24T22:15:00Z'));
    assert.strictEqual(inRollover, false);
  });

  test('checkTradingAllowed debe bloquear apertura durante Rollover', () => {
    const check = riskEngine.checkTradingAllowed(new Date('2026-09-24T20:58:00Z'));
    assert.strictEqual(check.allowed, false);
    assert.ok(check.reason.includes('ROLLOVER SHIELD'));
  });

  // ----------------------------------------------------
  // 2. Friday Close Guard (Viernes 21:30 CET a Domingo 23:00 CET)
  // ----------------------------------------------------
  console.log('\n🔹 2. Verificación del Friday Close Guard (Cierre Fin de Semana)');

  test('Debe permitir trading el viernes a las 21:25 CET', () => {
    // 2026-09-25 19:25 UTC = 21:25 CEST
    const isFridayClose = riskEngine.isFridayCloseWindow(new Date('2026-09-25T19:25:00Z'));
    assert.strictEqual(isFridayClose, false);
  });

  test('Debe congelar trading el viernes a las 21:35 CET', () => {
    // 2026-09-25 19:35 UTC = 21:35 CEST
    const isFridayClose = riskEngine.isFridayCloseWindow(new Date('2026-09-25T19:35:00Z'));
    assert.strictEqual(isFridayClose, true);
  });

  test('Debe mantener congelado el sábado completo', () => {
    // 2026-09-26 12:00 UTC = 14:00 CEST (Sábado)
    const isFridayClose = riskEngine.isFridayCloseWindow(new Date('2026-09-26T10:00:00Z'));
    assert.strictEqual(isFridayClose, true);
  });

  test('Debe mantener congelado el domingo a las 22:30 CET', () => {
    // 2026-09-27 20:30 UTC = 22:30 CEST (Domingo)
    const isFridayClose = riskEngine.isFridayCloseWindow(new Date('2026-09-27T20:30:00Z'));
    assert.strictEqual(isFridayClose, true);
  });

  test('Debe liberar trading tras reapertura domingo a las 23:05 CET', () => {
    // 2026-09-27 21:05 UTC = 23:05 CEST (Domingo noche)
    const isFridayClose = riskEngine.isFridayCloseWindow(new Date('2026-09-27T21:05:00Z'));
    assert.strictEqual(isFridayClose, false);
  });

  test('checkTradingAllowed debe bloquear apertura durante fin de semana', () => {
    const check = riskEngine.checkTradingAllowed(new Date('2026-09-25T19:40:00Z'));
    assert.strictEqual(check.allowed, false);
    assert.ok(check.reason.includes('FRIDAY CLOSE GUARD'));
  });

  // ----------------------------------------------------
  // 2b. Daily NY Close Guard (Lunes a Jueves 21:45 CET a 22:55 CET - No Overnight)
  // ----------------------------------------------------
  console.log('\n🔹 2b. Verificación del Daily NY Close Guard (No Overnight Lunes a Jueves)');

  test('Debe permitir trading el martes a las 21:40 CET', () => {
    // 2026-09-29 19:40 UTC = 21:40 CEST
    const isDaily = riskEngine.isDailyCloseWindow(new Date('2026-09-29T19:40:00Z'));
    assert.strictEqual(isDaily, false);
  });

  test('Debe congelar trading y forzar cierre el martes a las 21:46 CET', () => {
    // 2026-09-29 19:46 UTC = 21:46 CEST
    const isDaily = riskEngine.isDailyCloseWindow(new Date('2026-09-29T19:46:00Z'));
    assert.strictEqual(isDaily, true);
  });

  test('checkTradingAllowed debe bloquear apertura durante Daily Close Window', () => {
    const check = riskEngine.checkTradingAllowed(new Date('2026-09-29T19:50:00Z'));
    assert.strictEqual(check.allowed, false);
    assert.ok(check.reason.includes('DAILY NY CLOSE GUARD'));
  });

  // ----------------------------------------------------
  // 3. Servicio de Notificaciones Push (NotificationService)
  // ----------------------------------------------------
  console.log('\n🔹 3. Verificación de Formateo y Entrega de Notificaciones Push');

  await testAsync('Notificación de Orden Ejecutada (Trade Open)', async () => {
    const plan = {
      symbol: 'XAUUSD',
      action: 'BUY',
      channelName: 'MARCO TRADING HUB',
      entryPrice: 2685.20,
      slPrice: 2677.20,
      targetTP: 2695.50,
      totalLotSize: 0.15,
      isProvisionalSL: false
    };
    const res = await notificationService.notifyTradeExecuted(plan);
    assert.strictEqual(typeof res, 'boolean');
  });

  await testAsync('Notificación de Protección Break-Even', async () => {
    const res = await notificationService.notifyBreakEven('XAUUSD', 'Craig Percoco', 2685.20);
    assert.strictEqual(typeof res, 'boolean');
  });

  await testAsync('Notificación de Trade Cerrado (WIN con Pips y $USD)', async () => {
    const res = await notificationService.notifyTradeClosed({
      position: 78910,
      symbol: 'XAUUSD',
      outcome: 'WIN',
      profitUSD: 145.80,
      pips: 85.0,
      balance: 10450.80,
      channelName: 'Williams tradershub'
    });
    assert.strictEqual(typeof res, 'boolean');
  });

  await testAsync('Notificación de Alerta de Noticias (News Guard)', async () => {
    const res = await notificationService.notifyNewsGuard('US Non-Farm Payrolls (NFP)', '14:30 CET', 10);
    assert.strictEqual(typeof res, 'boolean');
  });

  await testAsync('Notificación de Rollover Shield', async () => {
    const res = await notificationService.notifyRolloverShield(true);
    assert.strictEqual(typeof res, 'boolean');
  });

  await testAsync('Notificación de Friday Close Guard', async () => {
    const res = await notificationService.notifyFridayClose(true);
    assert.strictEqual(typeof res, 'boolean');
  });

  console.log('\n========================================================================================');
  console.log(`📊 RESULTADOS: ${passed} PASADOS | ${failed} FALLADOS`);
  console.log('========================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Error fatal:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
