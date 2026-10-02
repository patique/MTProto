const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal original de Risk Management (13:24:00)
const signal = {
  channelName: 'Risk Management-revealed',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4294.00,
  sl: 4284.00,
  tp1: 4298.00,
  tp2: 4302.00,
  tp3: 4306.00
};

// Precio de mercado en vivo (ej: 4295.50)
const currentMarketPrice = 4295.50;

console.log('🔄 Procesando la nueva señal de Risk Management (13:24)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para Risk Management:', JSON.stringify(plan, null, 2));

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
