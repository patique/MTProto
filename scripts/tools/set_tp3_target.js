const http = require('http');

// Aplicar la regla de escalado a TP3 (4305.00) sin dejar la orden abierta sin TP
const modifyCommand = [{
  action: 'MODIFY',
  symbol: 'XAUUSD',
  sl: 4324.00,
  tp: 4305.00
}];

(async () => {
  console.log('🎯 Aplicando escalado automático a TP3 (SL: 4324.00 | TP3: 4305.00)...');

  const postData = JSON.stringify(modifyCommand);

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
      console.log('✅ Comando MODIFY con objetivo TP3 (4305.00) enviado a MT5:', data);
      process.exit(0);
    });
  });

  req.on('error', err => {
    console.error('❌ Error enviando modificación:', err.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
})();
