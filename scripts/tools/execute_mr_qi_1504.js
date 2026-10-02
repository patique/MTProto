const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal de Mr. QI (15:04:12)
const signal = {
  channelName: 'MR.QI - GOOD LUCK',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4262.00,
  sl: 4250.00,
  tp1: 4288.00,
  tp2: 4300.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4262.00;

console.log('🔄 Procesando la nueva señal de Mr. QI (15:04)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para Mr. QI 15:04:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal de Mr. QI enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
