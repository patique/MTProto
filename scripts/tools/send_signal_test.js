const http = require('http');
const { processSignalForExecution } = require('./risk_engine');

const testSignal = {
  channelName: 'Risk Management-revealed 🐬',
  action: 'BUY',
  pair: 'XAUUSD',
  entry: 4330,
  sl: 4320,
  tp1: 4334,
  tp2: 4337,
  tp3: 4340
};

console.log('⚡ Procesando señal de prueba de "Risk Management-revealed"...');
const plan = processSignalForExecution(testSignal);

console.log('📦 Plan de Ejecución Generado:', JSON.stringify(plan, null, 2));

const postData = JSON.stringify(plan.orders);

const req = http.request({
  hostname: '127.0.0.1',
  port: 3000,
  path: '/orders',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
}, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('✅ Orden inyectada en el Servidor Local HTTP con éxito:', data);
  });
});

req.on('error', (e) => {
  console.error('❌ Error enviando la orden:', e.message);
});

req.write(postData);
req.end();
