const http = require('http');

// Ajustar el Stop Loss a 4324.00 para garantizar que el riesgo maximo sea exactamente del 2% ($2,000 USD)
const modifyCommand = [{
  action: 'MODIFY',
  symbol: 'XAUUSD',
  sl: 4324.00,
  tp: 4305.00
}];

(async () => {
  console.log('🛡️ Enviando modificación para reducir el riesgo al 2% exacto (SL: 4324.00 | TP: 4305.00)...');

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
      console.log('✅ Comando MODIFY con SL al 2% (4324.00) enviado a MT5:', data);
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
