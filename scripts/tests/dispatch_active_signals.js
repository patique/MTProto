const http = require('http');
const https = require('https');
const { processSignalForExecution } = require('./risk_engine');

function getLivePrice() {
  return new Promise((resolve) => {
    https.get('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(parseFloat(JSON.parse(data).price));
        } catch(e) { resolve(4293.0); }
      });
    }).on('error', () => resolve(4293.0));
  });
}

function postOrder(order) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(order);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/orders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => resolve(resData));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const currentPrice = await getLivePrice();
  console.log(`\n💰 Precio actual de mercado XAUUSD: $${currentPrice.toFixed(2)}`);

  // Señal activa de Smart Pips:
  // #𝗫𝗔𝗨𝗨𝗦𝗗 Buy 4290/4286 | TP 4294, 4297, 4300 | SL 4280
  const smartPipsSignal = {
    channelName: 'Smart Pips Alerts',
    pair: 'XAUUSD',
    action: 'BUY',
    entry: 4290,
    sl: 4280,
    tp1: 4294,
    tp2: 4297,
    tp3: 4300
  };

  console.log(`📋 Procesando señal de Smart Pips con el motor de riesgo...`);
  
  // Si el precio actual está muy cerca de 4294 (ej > 4292.50), usar TP2 (4297) para que el broker no rechace por StopsLevel
  if (currentPrice >= 4292.50) {
    console.log(`ℹ️ Precio actual (${currentPrice}) muy cerca de TP1 (4294). Seleccionando TP seguro (4297)...`);
    smartPipsSignal.tp1 = 4297;
  }

  const plan = processSignalForExecution(smartPipsSignal, currentPrice);
  console.log('🎯 Plan Generado:', JSON.stringify(plan, null, 2));

  if (!plan.valid) {
    console.log('❌ Plan no válido:', plan.reason);
    return;
  }

  const orderToSend = {
    id: Date.now(),
    symbol: plan.symbol,
    action: plan.action,
    volume: 0.01, // Volumen seguro para cuenta pequeña
    sl: plan.orders[0].sl,
    tp: plan.orders[0].tp,
    comment: ""
  };

  console.log(`\n🚀 Enviando orden a MT5 vía HTTP POST...`);
  console.log(JSON.stringify(orderToSend, null, 2));

  try {
    const res = await postOrder(orderToSend);
    console.log(`\n✅ Respuesta del servidor HTTP local:`, res);
    console.log(`\n⏳ Esperando que el EA de MT5 la lea en su siguiente pulso (250 ms)...`);
  } catch (err) {
    console.log(`❌ Error enviando a MT5:`, err.message);
  }
})();
