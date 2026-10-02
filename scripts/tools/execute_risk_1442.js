const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal de Risk Management (14:42:36)
const signal = {
  channelName: 'Risk Management-revealed',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4275.00,
  sl: 4265.00,
  tp1: 4279.00,
  tp2: 4282.00,
  tp3: 4285.00
};

// Precio de mercado en vivo (ej: 4276.50)
const currentMarketPrice = 4276.50;

console.log('🔄 Procesando la nueva señal de Risk Management (14:42)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para Risk Management 14:42:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal de Risk Management enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
