const http = require('http');
const { processSignalForExecution, CONFIG } = require('./risk_engine');

CONFIG.accountBalance = 100000;
CONFIG.riskPercent = 1.0;

console.log('🧪 === PROCESANDO SEÑAL RECIENTE DE "FX COMMUNITY" PARA MT5 ===\n');

// Señal real recibida de Fx Community
const fxCommunitySignal = {
  channelName: 'Fx Community',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4336.00,
  sl: 4316.00,
  tp1: 4366.00,
  tp2: 4396.00
};

const plan = processSignalForExecution(fxCommunitySignal);

if (!plan.valid) {
  console.log('❌ Error plan de riesgo:', plan.reason);
  process.exit(1);
}

const orders = plan.orders.map((o, idx) => ({
  id: Date.now() + idx,
  symbol: plan.symbol,
  action: plan.action,
  volume: o.volume,
  sl: plan.slPrice,
  tp: o.tp,
  comment: o.comment
}));

const postData = JSON.stringify(orders);

const options = {
  hostname: '127.0.0.1',
  port: 3000,
  path: '/orders',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log(`📡 Saldo de Cuenta: $${CONFIG.accountBalance.toLocaleString()} USD | Riesgo (1%): $${(CONFIG.accountBalance * CONFIG.riskPercent / 100).toLocaleString()} USD`);
console.log(`   Acción: ${plan.action} | Símbolo: ${plan.symbol} | Entrada: ${plan.entryPrice} | SL: ${plan.slPrice}`);
console.log(`   Volumen Total Calculado (100% TP1): ${plan.totalLotSize} Lotes`);
orders.forEach((o, i) => console.log(`   📦 Orden: ${o.volume} Lotes | TP1: ${o.tp} (${o.comment})`));

const req = http.request(options, (res) => {
  let responseBody = '';
  res.on('data', (chunk) => responseBody += chunk);
  res.on('end', () => {
    console.log(`\n✅ Respuesta del Servidor: Status ${res.statusCode} | Body: ${responseBody}`);
    console.log('👉 La orden de Fx Community ha sido enviada a tu MT5.');
  });
});

req.on('error', (e) => {
  console.error(`❌ Error conectando con el servidor local: ${e.message}`);
});

req.write(postData);
req.end();
