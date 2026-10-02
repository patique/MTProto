const { processSignalForExecution } = require('../../risk_engine');
const { executeTradePlan } = require('../../mt5_bridge');

console.log('🧪 === PROBANDO PIPELINE DE AUTOMATIZACIÓN (SEÑAL -> RIESGO -> MT5) ===\n');

// 1. Probar señal del canal "Aliens- Royal fx"
const signal1 = {
  channelName: 'Aliens- Royal fx',
  pair: 'XAU/USD',
  action: 'SELL NOW',
  entry: 4352,
  sl: 4356,
  tp1: 4347,
  tp2: 4337
};

console.log('1️⃣ Procesando señal de "Aliens- Royal fx"...');
const plan1 = processSignalForExecution(signal1);
executeTradePlan(plan1);

// 2. Probar señal del canal "Elite Gold Mines" (Ultra-Scalping 100% TP1)
const signal2 = {
  channelName: 'Elite Gold Mines',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4330,
  sl: 4325,
  tp1: 4335,
  tp2: 4340
};

console.log('2️⃣ Procesando señal de "Elite Gold Mines"...');
const plan2 = processSignalForExecution(signal2);
executeTradePlan(plan2);

// 3. Probar señal del canal "Risk Management-revealed"
const signal3 = {
  channelName: 'Risk Management-revealed',
  pair: 'XAUUSD',
  action: 'BUY',
  entry: 4335,
  sl: 4325,
  tp1: 4340,
  tp2: 4343,
  tp3: 4346
};

console.log('3️⃣ Procesando señal de "Risk Management-revealed"...');
const plan3 = processSignalForExecution(signal3);
executeTradePlan(plan3);
