const http = require('http');

console.log('🔒 Solicitando cierre inmediato de todas las posiciones a MT5...');

http.get('http://127.0.0.1:3000/api/close-all', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('\n======================================================');
      console.log('✅ RESPUESTA DEL PUENTE MT5:');
      console.log(JSON.stringify(json, null, 2));
      console.log('======================================================\n');
    } catch (e) {
      console.log('Respuesta recibida:', data);
    }
  });
}).on('error', (err) => {
  console.error('❌ Error contactando al bot en http://127.0.0.1:3000:', err.message);
});
