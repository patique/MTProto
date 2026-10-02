const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Señal de G.S Market Analysis (15:41:00)
const signal = {
  channelName: 'G.S Market Analysis',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4265.00,
  sl: 4255.00,
  tp1: 4275.00,
  tp2: 4295.00
};

// Precio de mercado en vivo
const currentMarketPrice = 4272.00;

console.log('🔄 Procesando la nueva señal BUY LIMIT de G.S Market Analysis (15:41)...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecución para G.S Market Analysis:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Señal de G.S Market enviada con éxito a MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar señal:', err.message);
    });
} else {
  console.log('⚠️ Señal omitida:', plan.reason);
}
