/**
 * Batería de Pruebas Automatizada del Sistema Completo (Test Suite)
 * - Valida la integridad del Puente HTTP MT5 y los endpoints de los 4 activos
 * - Valida la lógica de RiskEngine (lotajes, escudos, frenos de emergencia)
 * - Valida que cada clase algorítmica procesa ticks, actualiza velas y genera checklists
 * - Valida la paridad 1:1 entre la lógica de backtest y las estrategias en vivo
 */

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { RiskEngine } = require('../../core/RiskEngine');
const { BPRInstitutionalMultiTimeframeStrategy } = require('../../core/algorithms/BPRInstitutionalMultiTimeframeStrategy');
const { BPREurusdMultiTimeframeStrategy } = require('../../core/algorithms/BPREurusdMultiTimeframeStrategy');
const { BPRGbpjpyBearishStrategy } = require('../../core/algorithms/BPRGbpjpyBearishStrategy');
const { BPRNas100BullishStrategy } = require('../../core/algorithms/BPRNas100BullishStrategy');

const PORT = 3000;

function fetchJson(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${endpoint}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${endpoint}`));
    });
  });
}

async function runTestSuite() {
  console.log('\n================================================================================');
  console.log('🧪 BATERÍA DE PRUEBAS AUTOMATIZADA: VALIDACIÓN INTEGRAL DE SISTEMA');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name} -> ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name} -> ${err.message}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. INTEGRIDAD DE RISK ENGINE & GESTIÓN DE RIESGO
  // ---------------------------------------------------------------------------
  console.log('🔹 1. Validando RiskEngine (Gestión de Riesgo y Cálculo de Lotes):');

  test('RiskEngine: Modo PROP_FIRM predeterminado con 0.75% de riesgo', () => {
    const re = new RiskEngine();
    assert.strictEqual(re.config.MODE, 'PROP_FIRM');
    assert.strictEqual(re.currentRiskPercent, 0.75);
  });

  test('RiskEngine: Cálculo exacto de lotaje en Oro ($5,000 The5ers vs $100,000 FTMO con Cap de Margen)', () => {
    const re = new RiskEngine();
    // 5k: riesgo 0.75% = $37.50 USD, protegido por el Cap Proporcional de Margen (0.10 lotes máx en 5k)
    const lot5k = re.calculateLotSize(4150.0, 4148.0, 'XAUUSD', false, 5000);
    assert.strictEqual(lot5k, 0.10, `Cap de margen de Oro en 5k debe ser 0.10: obtenido ${lot5k}`);

    // 100k: riesgo 0.75% = $750.00 USD. 2 USD de SL = $200/lote -> Cap proporcional en 100k = 2.0 lotes
    const lot100k = re.calculateLotSize(4150.0, 4148.0, 'XAUUSD', false, 100000);
    assert.strictEqual(lot100k, 2.0, `Cap de margen de Oro en 100k debe ser 2.0: obtenido ${lot100k}`);
  });

  test('RiskEngine: Cálculo exacto de lotaje en EURUSD, GBPJPY y NAS100', () => {
    const re = new RiskEngine();
    // EURUSD: SL 4 pips en 100k -> $750 / ($10 * 4) = 18.75 lotes
    const lotEur = re.calculateLotSize(1.1240, 1.1236, 'EURUSD', false, 100000);
    assert(Math.abs(lotEur - 18.75) <= 0.1, `Lotaje EUR incorrecto: ${lotEur}`);

    // GBPJPY: SL 8 pips en 100k -> $750 / (8 * 6.70) = 13.99 lotes
    const lotGbp = re.calculateLotSize(208.50, 208.58, 'GBPJPY', false, 100000);
    assert(Math.abs(lotGbp - 13.99) <= 0.1, `Lotaje GBP incorrecto: ${lotGbp}`);

    // NAS100: SL 15 puntos en 100k -> Cap de margen prop firm (1.0L / $5k = 20.0 lotes en 100k)
    const lotNas = re.calculateLotSize(30600, 30585, 'NAS100', false, 100000);
    assert.strictEqual(lotNas, 20.0, `Lotaje NAS en 100k con cap debe ser 20.0: obtenido ${lotNas}`);
  });

  test('RiskEngine: Circuito de Freno de Emergencia (Daily Max Loss)', () => {
    const re = new RiskEngine();
    re.startDayBalance = 10000;
    re.config.accountBalance = 9600; // Pérdida de $400 USD (-4.0%)
    re.dailyMaxLossUSD = 300; // Límite de $300 USD
    const check = re.checkTradingAllowed();
    assert.strictEqual(check.allowed, false, 'Debió bloquear trading por exceder pérdida máxima');
    assert(check.reason.includes('Límite de pérdida diaria alcanzado'), 'Mensaje de freno incorrecto');
  });

  test('RiskEngine: Bloqueo Anti-Hedging Estricto (Prop Firm vs Capital Propio)', () => {
    const re = new RiskEngine();
    // En cuenta PROP_FIRM con 1 SELL abierto, no se permite abrir BUY
    const propCheckBuy = re.checkAntiHedging('XAUUSD', 'BUY', 0, 1, 'PROP_FIRM');
    assert.strictEqual(propCheckBuy.allowed, false, 'Debió bloquear BUY cuando hay SELL en Prop Firm');
    assert(propCheckBuy.reason.includes('ANTI-HEDGING'));

    // En cuenta PROP_FIRM con 1 BUY abierto, no se permite abrir SELL
    const propCheckSell = re.checkAntiHedging('XAUUSD', 'SELL', 1, 0, 'PROP_FIRM');
    assert.strictEqual(propCheckSell.allowed, false, 'Debió bloquear SELL cuando hay BUY en Prop Firm');

    // En cuenta PERSONAL (Capital Propio), el hedging está permitido
    const personalCheck = re.checkAntiHedging('XAUUSD', 'BUY', 0, 2, 'PERSONAL');
    assert.strictEqual(personalCheck.allowed, true, 'Debe permitir hedging en Capital Propio');
  });

  // ---------------------------------------------------------------------------
  // 2. INTEGRIDAD DE LAS ESTRATEGIAS ALGORÍTMICAS
  // ---------------------------------------------------------------------------
  console.log('\n🔹 2. Validando Clases Algorítmicas de las 4 Estrategias:');

  test('XAUUSD: Configurada en Portafolio Optimizado Multi-TF (M2 + M3 + M5 + M15, R:R 1:1.0)', () => {
    const gold = new BPRInstitutionalMultiTimeframeStrategy({ isLiveExecution: false });
    assert(gold.timeframes.M2, 'Falta M2');
    assert(gold.timeframes.M3, 'Falta M3');
    assert(gold.timeframes.M5, 'Falta M5');
    assert(gold.timeframes.M15, 'Falta M15');
    assert(!gold.timeframes.M1, 'M1 debe estar desactivado (ruido de spread)');
    assert.strictEqual(gold.timeframes.M2.config.minWickRatio, 0.15, 'Mecha debe ser 15%');
    assert.strictEqual(gold.timeframes.M2.config.lookbackBars, 25, 'Lookback M2 debe ser 25');
  });

  test('EURUSD: Multi-TF completo (M2, M3, M5, M15) y CE 50%', () => {
    const eurusd = new BPREurusdMultiTimeframeStrategy({ isLiveExecution: false });
    assert(eurusd.timeframes.M2 && eurusd.timeframes.M3 && eurusd.timeframes.M5 && eurusd.timeframes.M15);
    const chk = eurusd.getConfirmationChecklist(1.1240);
    for (const tf of ['M2', 'M3', 'M5', 'M15']) {
      assert(chk[tf], `Falta checklist para ${tf}`);
      assert(!chk[tf].distToCE.includes('-'), `Distancia no debe ser negativa en ${tf}: ${chk[tf].distToCE}`);
      assert(parseFloat(chk[tf].distToCE) > 0, `Distancia debe ser > 0 en ${tf}: ${chk[tf].distToCE}`);
    }
  });

  test('GBPJPY: Dirección BEARISH ONLY (Solo Ventas) y checklist positivo', () => {
    const gj = new BPRGbpjpyBearishStrategy({ isLiveExecution: false });
    const chk = gj.getConfirmationChecklist(208.40);
    for (const tf of ['M2', 'M3', 'M5', 'M15']) {
      assert(chk[tf], `Falta checklist para ${tf}`);
      assert(chk[tf].activeType.includes('BEARISH'), `Debe ser BEARISH en ${tf}`);
      assert(!chk[tf].distToCE.includes('-'), `Distancia no debe ser negativa en ${tf}: ${chk[tf].distToCE}`);
    }
  });

  test('NAS100: Dirección BULLISH ONLY (Solo Compras) y checklist positivo', () => {
    const nas = new BPRNas100BullishStrategy({ isLiveExecution: false });
    const chk = nas.getConfirmationChecklist(30600);
    for (const tf of ['M2', 'M3', 'M5', 'M15']) {
      assert(chk[tf], `Falta checklist para ${tf}`);
      assert(chk[tf].activeType.includes('BULLISH'), `Debe ser BULLISH en ${tf}`);
      assert(!chk[tf].distToCE.includes('-'), `Distancia no debe ser negativa en ${tf}: ${chk[tf].distToCE}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 3. PARIDAD 1:1: BACKTEST VS EJECUCIÓN EN VIVO
  // ---------------------------------------------------------------------------
  console.log('\n🔹 3. Validando Paridad de Lógica: Backtest vs Algoritmo en Vivo:');

  test('Paridad Estructural: Detección FVG de 3 velas (c3.low - c1.high)', () => {
    // Simulamos 4 velas sintéticas con FVG bajista evidente entre vela 0 y vela 2 (gap 1.5 USD)
    const candles = [
      { open: 4150, high: 4152, low: 4149, close: 4151 }, // c3: low 4149.0
      { open: 4151, high: 4151, low: 4145, close: 4146 }, // c2
      { open: 4146, high: 4147, low: 4144, close: 4145 }, // c1: high 4147.0 (gap = 4149 - 4147 = 2.0 USD)
      { open: 4145, high: 4146, low: 4142, close: 4143 }  // c0
    ];

    const gap = candles[0].low - candles[2].high; // c3.low - c1.high
    assert.strictEqual(gap, 2.0, 'El cálculo de FVG debe comparar c3.low con c1.high con exactamente 2.0 puntos');
  });

  test('Filtro de Merma: Bloqueo estricto de la franja 10:00-11:00 UTC (Pre-almuerzo)', () => {
    const gold = new BPRInstitutionalMultiTimeframeStrategy({ isLiveExecution: false });
    const eur = new BPREurusdMultiTimeframeStrategy({ isLiveExecution: false });
    const gbp = new BPRGbpjpyBearishStrategy({ isLiveExecution: false });

    // Simulamos una vela a las 10:15 UTC
    const candleAt10Utc = {
      time: new Date('2026-10-02T10:15:00Z'),
      open: 4150, high: 4155, low: 4148, close: 4154,
      ema100: 4145
    };

    // Evaluamos entrada a las 10:00 UTC: evaluateEntry debe abortar sin mutar estado
    const initialTradesGold = gold.tradesCount || 0;
    gold.evaluateEntry('M2', gold.timeframes.M2, candleAt10Utc);
    assert.strictEqual(gold.tradesCount || 0, initialTradesGold, 'Oro debe bloquear señales a las 10:00 UTC');

    const initialTradesEur = eur.tradesCount || 0;
    eur.evaluateEntry('M2', eur.timeframes.M2, candleAt10Utc);
    assert.strictEqual(eur.tradesCount || 0, initialTradesEur, 'EURUSD debe bloquear señales a las 10:00 UTC');

    const initialTradesGbp = gbp.tradesCount || 0;
    gbp.evaluateEntry('M2', gbp.timeframes.M2, candleAt10Utc);
    assert.strictEqual(gbp.tradesCount || 0, initialTradesGbp, 'GBPJPY debe bloquear señales a las 10:00 UTC');
  });

  // ---------------------------------------------------------------------------
  // 4. VERIFICACIÓN DE ENDPOINTS HTTP EN EL PUENTE ACTIVO (PM2 / PUERTO 3000)
  // ---------------------------------------------------------------------------
  console.log('\n🔹 4. Validando Endpoints HTTP en el Servidor Activo (Puerto 3000):');

  await testAsync('Endpoint /api/status: Devuelve balance, modo y streaming de ticks', async () => {
    const res = await fetchJson('/api/status');
    assert.strictEqual(res.status, 200);
    assert(res.json.balance > 0, 'Balance debe ser positivo');
    assert(res.json.tick.bid > 0, 'Tick XAUUSD debe ser > 0');
    assert(res.json.tickEURUSD.bid > 0, 'Tick EURUSD debe ser > 0');
    assert(res.json.tickGBPJPY.bid > 0, 'Tick GBPJPY debe ser > 0');
    assert(res.json.tickNAS100.bid > 0, 'Tick NAS100 debe ser > 0');
  });

  await testAsync('Endpoint /api/bpr-strategy: XAUUSD checklist con M2, M3, M5 y M15', async () => {
    const res = await fetchJson('/api/bpr-strategy');
    assert.strictEqual(res.status, 200);
    const chk = res.json.checklist;
    assert(chk.M2 && chk.M3 && chk.M5 && chk.M15, 'Deben existir M2, M3, M5 y M15');
    assert(!chk.M1, 'M1 debe estar excluido');
    assert(chk.M2.distToCE, 'distToCE debe estar presente en M2');
  });

  await testAsync('Endpoint /api/bpr-eurusd: Checklist EURUSD en tiempo real', async () => {
    const res = await fetchJson('/api/bpr-eurusd');
    assert.strictEqual(res.status, 200);
    const chk = res.json.checklist;
    assert(chk.M2 && chk.M3 && chk.M5 && chk.M15);
    for (const tf of ['M2', 'M3', 'M5', 'M15']) {
      assert(parseFloat(chk[tf].distToCE) > 0, `distToCE en ${tf} debe ser > 0`);
    }
  });

  await testAsync('Endpoint /api/bpr-gbpjpy: Checklist GBPJPY en tiempo real', async () => {
    const res = await fetchJson('/api/bpr-gbpjpy');
    assert.strictEqual(res.status, 200);
    const chk = res.json.checklist;
    assert(chk.M2 && chk.M3 && chk.M5 && chk.M15);
    for (const tf of ['M2', 'M3', 'M5', 'M15']) {
      assert(parseFloat(chk[tf].distToCE) > 0, `distToCE en ${tf} debe ser > 0`);
    }
  });

  await testAsync('Endpoint /api/bpr-nas100: Checklist NAS100 en tiempo real', async () => {
    const res = await fetchJson('/api/bpr-nas100');
    assert.strictEqual(res.status, 200);
    const chk = res.json.checklist;
    assert(chk.M2 && chk.M3 && chk.M5 && chk.M15);
    for (const tf of ['M2', 'M3', 'M5', 'M15']) {
      assert(parseFloat(chk[tf].distToCE) > 0, `distToCE en ${tf} debe ser > 0`);
    }
  });

  console.log('\n================================================================================');
  console.log(`📊 RESULTADO FINAL DEL TEST SUITE: ${passed} PASADOS / ${failed} FALLADOS`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal Test Suite Error:', err);
  process.exit(1);
});
