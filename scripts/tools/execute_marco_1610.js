const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal de MARCO FOREX HUB (16:10:06)
const signal = {
  channelName: 'MARCO FOREX HUB',
  pair: 'XAUUSD',
  action: 'SELL',
  entry: 4268.00,
  sl: 4280.00,
  tp1: 4258.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4268.00;

console.log('🔄 Procesando la señal SELL de MARCO FOREX HUB (16:10)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para MARCO 16:10:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal de MARCO 16:10 enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
