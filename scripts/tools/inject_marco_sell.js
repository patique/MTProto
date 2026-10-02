const http = require('http');
const { processSignalForExecution } = require('./risk_engine');

const marcoSellSignal = {
  action: 'SELL',
  pair: 'XAUUSD',
  entry: 4318.00,
  sl: 4330.00,
  tp1: 4315.00,
  channelName: 'MARCO FOREX HUB / TRADING HUB'
};

(async () => {
  console.log('⚡ Procesando e Inyectando la VENTA activa de MARCO (09:47 AM)...');

  const plan = processSignalForExecution(marcoSellSignal);
  console.log('🎯 Plan de Riesgo Generado:');
  console.log(JSON.stringify(plan, null, 2));

  if (!plan.valid) {
    console.error('❌ Plan invalido:', plan.reason);
    process.exit(1);
  }

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
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('✅ Señal de VENTA de MARCO inyectada con éxito en el Puente MT5:', data);
      process.exit(0);
    });
  });

  req.on('error', err => {
    console.error('❌ Error inyectando orden:', err.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
})();
