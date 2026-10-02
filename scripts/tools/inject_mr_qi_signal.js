const http = require('http');
const { processSignalForExecution } = require('./risk_engine');

const mrQiSignal = {
  action: 'BUY',
  pair: 'XAUUSD',
  entry: 4329.00,
  sl: 4324.00,
  tp1: 4355.00,
  channelName: 'MR.QI - GOOD LUCK🍀 🌏'
};

(async () => {
  console.log('⚡ Procesando e Inyectando la señal de MR.QI (BUY XAUUSD @ 4329)...');

  const plan = processSignalForExecution(mrQiSignal);
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
      console.log('✅ Orden de MR.QI inyectada con éxito en el Puente MT5:', data);
      process.exit(0);
    });
  });

  req.on('error', err => {
    console.error('❌ Error enviando a puerto 3000 (Asegúrate de que el bridge o MT5 esté activo):', err.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
})();
