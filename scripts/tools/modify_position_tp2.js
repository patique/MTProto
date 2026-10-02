const http = require('http');

// Asignar TP2 (4310.00) o TP3 (4305.00) que estan por debajo del precio de mercado actual
const modifyCommand = [{
  action: 'MODIFY',
  symbol: 'XAUUSD',
  sl: 4330.00,
  tp: 4305.00
}];

(async () => {
  console.log('🔄 Enviando modificación ajustada (SL: 4330.00 | TP: 4305.00)...');

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
      console.log('✅ Comando MODIFY con TP3 (4305.00) enviado a MT5:', data);
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
