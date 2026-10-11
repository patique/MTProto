const http = require('http');

console.log('🚀 Solicitando envío de orden de prueba BUY a todas las cuentas MT5...');

http.get('http://127.0.0.1:3000/api/send-test-trade', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('\n======================================================');
      console.log('✅ RESPUESTA DEL PUENTE MT5:');
      console.log(JSON.stringify(json, null, 2));
      console.log('======================================================');
      console.log('👉 Mira ahora tus 2 terminales MT5:');
      console.log('   1. The5ers ($5k)   -> Debería abrir ~0.10 lotes.');
      console.log('   2. FTMO ($100k)    -> Debería abrir ~2.00 lotes.');
      console.log('======================================================\n');
    } catch (e) {
      console.log('Respuesta recibida:', data);
    }
  });
}).on('error', (err) => {
  console.error('❌ Error contactando al bot en http://127.0.0.1:3000:', err.message);
});
