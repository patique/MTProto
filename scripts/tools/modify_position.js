const http = require('http');

const modifyCommand = [{
  action: 'MODIFY',
  symbol: 'XAUUSD',
  sl: 4330.00,
  tp: 4315.00
}];

(async () => {
  console.log('🔄 Enviando orden de MODIFICACIÓN (SL: 4330.00 | TP: 4315.00) a MT5...');

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
      console.log('✅ Comando MODIFY puesto en cola para MT5:', data);
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
