const { processSignalForExecution } = require('./risk_engine');
const { executeTradePlan } = require('./mt5_bridge');

// Re-evaluar la señal reciente con el motor de riesgo actualizado
const signal = {
  channelName: 'Risk Management',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4280.00,
  sl: 4267.00,
  tp1: 4283.00,
  tp2: 4290.00,
  tp3: 4305.00
};

// Asumimos el precio actual de mercado (ej: 4281.50)
const currentMarketPrice = 4281.50;

console.log('🔄 Re-calculando riesgo y re-evaluando ejecucion de orden...');
const plan = processSignalForExecution(signal, currentMarketPrice);

console.log('📋 Plan de Ejecucion Calculado:', JSON.stringify(plan, null, 2));

if (plan.valid) {
  executeTradePlan(plan)
    .then(res => {
      console.log('✅ Orden re-enviada con exito a la cola HTTP de MT5:', res);
    })
    .catch(err => {
      console.error('❌ Error al enviar orden:', err.message);
    });
} else {
  console.log('⚠️ La orden fue descartada por el motor de riesgo:', plan.reason);
}
