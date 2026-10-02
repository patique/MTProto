const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal de MARCO FOREX HUB (14:03:57)
const signal = {
  channelName: 'MARCO FOREX HUB',
  pair: 'XAUUSD',
  action: 'SELL',
  entry: 4292.00,
  sl: 4311.00,
  tp1: 4235.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4292.00;

console.log('🔄 Procesando la señal de MARCO FOREX HUB (14:03)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para MARCO 14:03:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal de MARCO enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
