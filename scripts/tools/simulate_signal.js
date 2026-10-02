/**
 * Simulación de Entrada en Tiempo Real para Señal de Telegram
 * Procesa el mensaje exactamente como si el evento de GramJS acabara de llegar
 * y lo despacha al puente local de MetaTrader 5 (puerto 3000).
 */

const http = require('http');
const { strategyFactory } = require('../../core/StrategyFactory');
const { riskEngine } = require('../../core/RiskEngine');

const MARCO_MESSAGE = `GOLD BUY NOW 4271 - 4267

TP 4275 - TP 4279 - TP 4283 TP 4295

SL : 4256`;

const CHANNEL_ID = '-1002157727490';
const CHANNEL_NAME = 'MARCO TRADING HUB🏅';

(async () => {
  console.log('\n========================================================================================');
  console.log('📡 [SIMULADOR DE EVENTO TELEGRAM EN VIVO]');
  console.log(`Canal: "${CHANNEL_NAME}" (ID: ${CHANNEL_ID})`);
  console.log('Mensaje recibido:\n');
  console.log(MARCO_MESSAGE);
  console.log('========================================================================================\n');

  // 1. Obtener estrategia asignada a Marco
  const strategy = strategyFactory.getStrategy(CHANNEL_ID, CHANNEL_NAME);

  // 2. Parsear el mensaje
  const signal = strategy.parse(MARCO_MESSAGE, { messageId: 2151 });

  if (!signal) {
    console.error('❌ Error: La señal no pudo ser parseada.');
    process.exit(1);
  }

  console.log('🎯 [SEÑAL PARSEADA CORRECTAMENTE]:');
  console.log(`   Acción: ${signal.action}`);
  console.log(`   Símbolo: ${signal.symbol}`);
  console.log(`   Entrada recomendada: ${signal.entry}`);
  console.log(`   Stop Loss: ${signal.sl}`);
  console.log(`   TP1: ${signal.tp1} | TP2: ${signal.tp2} | TP3: ${signal.tp3}`);

  // 3. Crear Plan de Ejecución
  const executionPlan = strategy.createExecutionPlan(signal, signal.entry, riskEngine);

  console.log('\n📋 [PLAN DE EJECUCIÓN GENERADO]:');
  console.log(`   Válido: ${executionPlan.valid}`);
  console.log(`   Tipo de Orden: ${executionPlan.action} A MERCADO (Sin Grid: ${!executionPlan.isGrid})`);
  console.log(`   TP Objetivo (Prioridad Canal): ${executionPlan.targetTP}`);
  console.log(`   SL Calculado: ${executionPlan.slPrice}`);
  console.log(`   Volumen: ${executionPlan.totalLotSize} lotes`);

  // 4. Enviar al Servidor HTTP del EA de MT5 (puerto 3000)
  const payload = JSON.stringify(executionPlan);
  const options = {
    hostname: '127.0.0.1',
    port: 3000,
    path: '/orders',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log('\n🚀 [DESPACHO EXITOSO AL PUENTE MT5]:');
      console.log(`   Status HTTP: ${res.statusCode}`);
      console.log(`   Respuesta servidor: ${body}`);
      console.log('   ✅ La orden está en la cola para que el EA de MT5 la ejecute de inmediato.');
      console.log('========================================================================================\n');
      process.exit(0);
    });
  });

  req.on('error', (err) => {
    console.error('❌ Error conectando con el servidor MT5 en puerto 3000:', err.message);
    console.log('💡 Asegúrate de que el servidor esté activo con `node start.js`');
    process.exit(1);
  });

  req.write(payload);
  req.end();
})();
