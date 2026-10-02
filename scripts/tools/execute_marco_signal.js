const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal original de MARCO FOREX HUB
const signal = {
  channelName: 'MARCO FOREX HUB',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4282.00,
  sl: 4272.00,
  tp1: 4287.00,
  tp2: 4297.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4284.00;

console.log('🔄 Procesando la nueva señal de MARCO FOREX HUB...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para MARCO:', JSON.stringify(plan, null, 2));

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
