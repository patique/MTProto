const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal de Ai Premium Pips (14:42:44)
const signal = {
  channelName: 'Ai Premium Pips',
  pair: 'XAUUSD',
  action: 'SELL',
  entry: 4287.00,
  sl: 4295.00,
  tp1: 4281.00,
  tp2: 4265.00,
  tp3: 4230.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4288.00;

console.log('🔄 Procesando la nueva señal de Ai Premium Pips (14:42)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para Ai Premium Pips:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
