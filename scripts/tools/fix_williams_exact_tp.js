const http = require('http');

// Ajustar el Stop Loss a 4267.00 y eliminar el TP (TP = 0.00) para dejar el TP ABIERTO tal como indico Williams ("TP @ open")
const modifyCommand = [{
  action: 'MODIFY',
  symbol: 'XAUUSD',
  sl: 4267.00,
  tp: 0.00
}];

(async () => {
  console.log('🛡️ Enviando modificación exacta según canal Williams (SL: 4267.00 | TP: 0.00 / ABIERTO)...');

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
      console.log('✅ Comando MODIFY exacto (SL: 4267.00 | TP: ABIERTO) enviado a MT5:', data);
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
