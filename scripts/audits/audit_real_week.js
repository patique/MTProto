const weeklySignalsReal = [
  // LUNES 14 SEP
  { date: '14/09', channel: 'Candle Logic Lab', action: 'SELL', entry: 4295, sl: 4305, tp1: 4290, tp2: 4285, outcome: 'TP2' },
  { date: '14/09', channel: 'Attaullah Trading Zone', action: 'BUY', entry: 4330, sl: 4323, tp1: 4335, tp2: 4340, outcome: 'TP2' },
  { date: '14/09', channel: 'Attaullah Trading Zone', action: 'BUY', entry: 4281, sl: 4272, tp1: 4285, tp2: 4290, outcome: 'TP2' },
  { date: '14/09', channel: 'Williams tradershub', action: 'BUY', entry: 4322, sl: 4309, tp1: 4326, tp2: 4329, outcome: 'TP2' },
  { date: '14/09', channel: 'Aliens- Royal fx', action: 'BUY', entry: 4330, sl: 4326, tp1: 4334, tp2: 4338, outcome: 'TP2' },
  { date: '14/09', channel: 'Aliens- Royal fx', action: 'SELL', entry: 4393, sl: 4398, tp1: 4389, tp2: 4385, outcome: 'SL' },
  { date: '14/09', channel: 'XAUUSD FOREX TRADING', action: 'SELL', entry: 4335, sl: 4350, tp1: 4330, tp2: 4325, outcome: 'TP2' },

  // MARTES 15 SEP
  { date: '15/09', channel: 'Attaullah Trading Zone', action: 'BUY', entry: 4312, sl: 4307, tp1: 4316, tp2: 4320, outcome: 'TP2' },
  { date: '15/09', channel: 'Williams tradershub', action: 'BUY', entry: 4263, sl: 4246, tp1: 4270, tp2: 4275, outcome: 'TP2' },
  { date: '15/09', channel: 'Aliens- Royal fx', action: 'SELL', entry: 4304, sl: 4308, tp1: 4300, tp2: 4296, outcome: 'TP2' },
  { date: '15/09', channel: 'Aliens- Royal fx', action: 'SELL', entry: 4282, sl: 4286, tp1: 4278, tp2: 4275, outcome: 'TP2' },
  { date: '15/09', channel: 'XAUUSD FOREX TRADING', action: 'BUY', entry: 4285, sl: 4270, tp1: 4290, tp2: 4295, outcome: 'TP2' },

  // MIÉRCOLES 16 SEP
  { date: '16/09', channel: 'Attaullah Trading Zone', action: 'BUY', entry: 4323, sl: 4317, tp1: 4330, tp2: 4334, outcome: 'TP2' },
  { date: '16/09', channel: 'Attaullah Trading Zone', action: 'SELL', entry: 4331, sl: 4339, tp1: 4325, tp2: 4320, outcome: 'TP2' },
  { date: '16/09', channel: 'Attaullah Trading Zone', action: 'SELL', entry: 4348, sl: 4361, tp1: 4330, tp2: 4320, outcome: 'TP2' },
  { date: '16/09', channel: 'Williams tradershub', action: 'SELL', entry: 4332, sl: 4345, tp1: 4328, tp2: 4324, outcome: 'TP2' },
  { date: '16/09', channel: 'Williams tradershub', action: 'SELL', entry: 4348, sl: 4363, tp1: 4344, tp2: 4340, outcome: 'TP2' },
  { date: '16/09', channel: 'Williams tradershub', action: 'BUY', entry: 4325, sl: 4317, tp1: 4330, tp2: 4335, outcome: 'TP2' },
  { date: '16/09', channel: 'Aliens- Royal fx', action: 'BUY', entry: 4327, sl: 4321, tp1: 4332, tp2: 4337, outcome: 'TP2' },
  { date: '16/09', channel: 'XAUUSD FOREX TRADING', action: 'BUY', entry: 4320, sl: 4305, tp1: 4325, tp2: 4330, outcome: 'TP2' },
  { date: '16/09', channel: 'XAUUSD FOREX TRADING', action: 'SELL', entry: 4360, sl: 4375, tp1: 4355, tp2: 4350, outcome: 'TP2' },
  { date: '16/09', channel: 'XAUUSD FOREX TRADING', action: 'BUY', entry: 4345, sl: 4330, tp1: 4350, tp2: 4355, outcome: 'SL' },

  // JUEVES 17 SEP (HOY)
  { date: '17/09', channel: 'Williams tradershub', action: 'BUY', entry: 4293, sl: 4279, tp1: 4297, tp2: 4302, outcome: 'TP2' },
  { date: '17/09', channel: 'Williams tradershub', action: 'SELL', entry: 4309, sl: 4322, tp1: 4306, tp2: 4303, outcome: 'TP2' },
  { date: '17/09', channel: 'Williams tradershub', action: 'SELL', entry: 4332, sl: 4345, tp1: 4329, tp2: 4326, outcome: 'SL_REJECTED' },
  { date: '17/09', channel: 'XAUUSD FOREX TRADING', action: 'BUY', entry: 4310, sl: 4295, tp1: 4315, tp2: 4320, outcome: 'TP2' },
  { date: '17/09', channel: 'Attaullah Trading Zone', action: 'BUY', entry: 4276, sl: 4259, tp1: 4280, tp2: 4285, outcome: 'TP2' },
  { date: '17/09', channel: 'Attaullah Trading Zone', action: 'SELL', entry: 4308, sl: 4317, tp1: 4303, tp2: 4300, outcome: 'TP2' },
  { date: '17/09', channel: 'Attaullah Trading Zone', action: 'SELL', entry: 4334, sl: 4353, tp1: 4325, tp2: 4320, outcome: 'TP2' },
  { date: '17/09', channel: 'MARCO TRADING HUB', action: 'SELL', entry: 4329, sl: 4341, tp1: 4325, tp2: 4321, outcome: 'TP2' },
  { date: '17/09', channel: 'Candle Logic Lab', action: 'BUY', entry: 4304, sl: 4298, tp1: 4307, tp2: 4310, outcome: 'TP2' },
  { date: '17/09', channel: 'Aliens- Royal fx', action: 'SELL', entry: 4330, sl: 4335, tp1: 4325, tp2: 4321, outcome: 'SL' },
  { date: '17/09', channel: 'Aliens- Royal fx', action: 'BUY', entry: 4366, sl: 4360, tp1: 4371, tp2: 4378, outcome: 'TP2' },
  { date: '17/09', channel: 'Smart Pips Alerts', action: 'BUY', entry: 4310, sl: 4300, tp1: 4314, tp2: 4318, outcome: 'SL' },
  { date: '17/09', channel: 'Smart Pips Alerts', action: 'BUY', entry: 4300, sl: 4290, tp1: 4304, tp2: 4308, outcome: 'TP2' },
  { date: '17/09', channel: 'Smart Pips Alerts', action: 'BUY', entry: 4308, sl: 4297, tp1: 4312, tp2: 4315, outcome: 'TP2' },
  { date: '17/09', channel: 'FX PRO SIGNAL TEAM', action: 'BUY', entry: 4285, sl: 4276, tp1: 4288, tp2: 4291, outcome: 'TP2' }
];

const FIXED_LOT = 0.01;
const SLIPPAGE_PIPS = 2.5;

console.log('========================================================================================');
console.log('📊 AUDITORÍA REAL DE SEÑALES DE ESTA SEMANA (LUNES 14 A JUEVES 17 SEP) EN CUENTA $100');
console.log('========================================================================================\n');

let totalWinCount = 0;
let totalLossCount = 0;
let totalProfitTP2 = 0;

let currentBalance = 100.0;

weeklySignalsReal.forEach((s, idx) => {
  if (s.outcome === 'SL_REJECTED') {
    console.log(`[#${idx+1}] (${s.date}) ${s.channel} -> 🛡️ BLOQUEADA POR EL ESCUDO DE RIESGO ($0.00)`);
    return;
  }

  const pipsSL = Math.abs(s.entry - s.sl);
  const pipsTP2Real = Math.max(0.5, Math.abs(s.tp2 - s.entry) - SLIPPAGE_PIPS);

  let p2 = 0;
  if (s.outcome === 'TP2') {
    totalWinCount++;
    p2 = FIXED_LOT * pipsTP2Real * 100;
  } else {
    totalLossCount++;
    p2 = -(FIXED_LOT * pipsSL * 100);
  }

  totalProfitTP2 += p2;
  currentBalance += p2;

  console.log(`[#${idx+1}] (${s.date}) ${s.channel} | ${s.action} ${s.entry} -> Outcome: ${s.outcome} | Beneficio: ${p2 >= 0 ? '+' : ''}$${p2.toFixed(2)} | Saldo Acumulado: $${currentBalance.toFixed(2)}`);
});

console.log('\n========================================================================================');
console.log('🏆 RESUMEN REAL HISTÓRICO DE ESTA SEMANA (DEL LUNES 14 AL JUEVES 17 DE SEPTIEMBRE)');
console.log('========================================================================================');
console.log(`• Total Señales Reales Publicadas: ${weeklySignalsReal.length}`);
console.log(`• Operaciones Ejecutadas: ${totalWinCount + totalLossCount} (${totalWinCount} Ganadas a TP2 / ${totalLossCount} Perdidas en SL / 1 Bloqueada por Escudo)`);
console.log(`• Tasa de Acierto Real a TP2: ${((totalWinCount / (totalWinCount + totalLossCount)) * 100).toFixed(1)}%`);
console.log(`• Saldo Inicial (Lunes 14): $100.00 USD`);
console.log(`• Saldo Final Real Acumulado (Jueves 17): $${currentBalance.toFixed(2)} USD`);
console.log(`• Ganancia Neta Real Esta Semana: +$${totalProfitTP2.toFixed(2)} USD (+${(totalProfitTP2).toFixed(1)}% de rentabilidad neta real)`);
console.log('========================================================================================');
