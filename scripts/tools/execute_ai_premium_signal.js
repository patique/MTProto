const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal original de Ai Premium Pips (13:35:19)
const signal = {
  channelName: 'Ai Premium Pips',
  pair: 'XAUUSD',
  action: 'SELL',
  entry: 4296.00,
  sl: 4303.00,
  tp1: 4290.00,
  tp2: 4280.00,
  tp3: 4250.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4296.00;

console.log('🔄 Procesando la nueva señal de Ai Premium Pips (13:35)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para Ai Premium Pips:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal de Ai Premium Pips enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
