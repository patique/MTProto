const signalsTodayReal = [
  { channel: 'Candle Logic Lab', time: '05:49', action: 'BUY', entry: 4355, sl: 4348, tp1: 4360, tp2: 4365, outcome: 'TP2' },
  { channel: 'Attaullah Trading Zone', time: '05:10', action: 'SELL', entry: 4350, sl: 4359, tp1: 4345, tp2: 4340, outcome: 'TP2' },
  { channel: 'Craig Percoco Daily Trades', time: '04:04', action: 'BUY', entry: 4345, sl: 4335, tp1: 4349, tp2: 4353, outcome: 'TP2' },
  { channel: 'FX PRO SIGNAL TEAM', time: '04:07', action: 'BUY', entry: 4348, sl: 4339, tp1: 4351, tp2: 4354, outcome: 'TP2' },
  { channel: 'MARCO TRADING HUB', time: '06:35', action: 'SELL', entry: 4360, sl: 4373, tp1: 4356, tp2: 4352, outcome: 'TP2' },
  { channel: 'Attaullah Trading Zone', time: '08:49', action: 'SELL', entry: 4394, sl: 4409, tp1: 4390, tp2: 4385, outcome: 'TP2' },
  { channel: 'Williams tradershub', time: '08:52', action: 'SELL', entry: 4396, sl: 4406, tp1: 4389, tp2: 4386, outcome: 'TP2' },
  { channel: 'FX PRO SIGNAL TEAM', time: '08:55', action: 'BUY', entry: 4390, sl: 4381, tp1: 4393, tp2: 4396, outcome: 'SL' }, // Retracción rápida a 4380
  { channel: 'XAUUSD FOREX TRADING', time: '08:56', action: 'SELL', entry: 4395, sl: 4410, tp1: 4390, tp2: 4385, outcome: 'TP2' },
  { channel: 'Candle Logic Lab', time: '09:57', action: 'SELL', entry: 4395, sl: 4405, tp1: 4390, tp2: 4385, outcome: 'TP2' },
  { channel: 'Smart Pips Alerts', time: '10:21', action: 'BUY', entry: 4392, sl: 4380, tp1: 4395, tp2: 4398, outcome: 'SL' }, // Tocó 4379
  { channel: 'Aliens- Royal fx', time: '10:52', action: 'BUY', entry: 4387, sl: 4382, tp1: 4391, tp2: 4395, outcome: 'TP2' },
  { channel: 'MARCO TRADING HUB', time: '11:15', action: 'SELL', entry: 4397, sl: 4410, tp1: 4393, tp2: 4389, outcome: 'TP2' },
  { channel: 'MARCO TRADING HUB', time: '14:38', action: 'SELL', entry: 4372, sl: 4385, tp1: 4368, tp2: 4364, outcome: 'TP2' },
  { channel: 'Smart Pips Alerts', time: '15:00', action: 'SELL', entry: 4370, sl: 4382, tp1: 4367, tp2: 4364, outcome: 'TP2' },
  { channel: 'Craig Percoco Daily Trades', time: '15:38', action: 'SELL', entry: 4373, sl: 4388, tp1: 4370, tp2: 4367, outcome: 'TP2' },
  { channel: 'FX PRO SIGNAL TEAM', time: '16:14', action: 'SELL', entry: 4355, sl: 4365, tp1: 4352, tp2: 4349, outcome: 'TP2' }
];

const FIXED_LOT = 0.01;
const SLIPPAGE_PIPS = 2.5;

console.log('========================================================================================');
console.log('📊 AUDITORÍA REAL DE OPERACIONES DE HOY VIERNES 18 DE SEPTIEMBRE (CUENTA $100 | 0.01 LOTES)');
console.log('========================================================================================\n');

let winCount = 0;
let lossCount = 0;
let totalProfitToday = 0;
let currentBalance = 100.0;

signalsTodayReal.forEach((s, idx) => {
  const pipsSL = Math.abs(s.entry - s.sl);
  const pipsTP2Real = Math.max(0.5, Math.abs(s.tp2 - s.entry) - SLIPPAGE_PIPS);

  let p = 0;
  if (s.outcome === 'TP2') {
    winCount++;
    p = FIXED_LOT * pipsTP2Real * 100;
  } else {
    lossCount++;
    p = -(FIXED_LOT * pipsSL * 100);
  }

  totalProfitToday += p;
  currentBalance += p;

  console.log(`[#${idx+1}] (${s.time}) ${s.channel} | ${s.action} ${s.entry} -> Resultado: ${s.outcome} | Beneficio: ${p >= 0 ? '+' : ''}$${p.toFixed(2)} | Saldo Acumulado: $${currentBalance.toFixed(2)}`);
});

console.log('\n========================================================================================');
console.log('🏆 RESUMEN GENERAL DE HOY (VIERNES 18 DE SEPTIEMBRE)');
console.log('========================================================================================');
console.log(`• Total Señales Recibidas: ${signalsTodayReal.length}`);
console.log(`• Operaciones Ganadas a TP2: ${winCount} (${((winCount/signalsTodayReal.length)*100).toFixed(1)}%)`);
console.log(`• Operaciones Perdidas en SL: ${lossCount} (${((lossCount/signalsTodayReal.length)*100).toFixed(1)}%)`);
console.log(`• Saldo Inicial del Día: $100.00 USD`);
console.log(`• Saldo Acumulado Final: $${currentBalance.toFixed(2)} USD`);
console.log(`• Beneficio Neto de Hoy: +$${totalProfitToday.toFixed(2)} USD (+${totalProfitToday.toFixed(1)}% de rentabilidad en la jornada)`);
console.log('========================================================================================');
