const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal de Attaullah Trading Zone (11:54:06)
const signal = {
  channelName: 'Attaullah Trading Zone',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4281.00,
  sl: 4272.00,
  tp1: 4285.00,
  tp2: 4290.00,
  tp3: 4295.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4284.00;

console.log('🔄 Procesando la nueva señal de Attaullah Trading Zone...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para Attaullah:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal de Attaullah enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
