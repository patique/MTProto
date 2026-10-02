const signalsToday = [
  { channel: 'Williams tradershub', time: '06:38', action: 'BUY', entry: 4293, sl: 4279, tp1: 4297, tp2: 4302, outcome: 'TP1' },
  { channel: 'Williams tradershub', time: '11:37', action: 'SELL', entry: 4309, sl: 4322, tp1: 4306, tp2: 4303, outcome: 'TP1' },
  { channel: 'Williams tradershub', time: '13:49', action: 'SELL', entry: 4332, sl: 4345, tp1: 4329, tp2: 4326, outcome: 'SL_REJECTED' },
  { channel: 'XAUUSD FOREX TRADING', time: '10:58', action: 'BUY', entry: 4310, sl: 4295, tp1: 4315, tp2: 4320, outcome: 'TP1' },
  { channel: 'Attaullah Trading Zone', time: '05:05', action: 'BUY', entry: 4276, sl: 4259, tp1: 4280, tp2: 4285, outcome: 'TP1' },
  { channel: 'Attaullah Trading Zone', time: '08:22', action: 'SELL', entry: 4308, sl: 4317, tp1: 4303, tp2: 4300, outcome: 'TP1' },
  { channel: 'Attaullah Trading Zone', time: '09:42', action: 'SELL', entry: 4334, sl: 4353, tp1: 4325, tp2: 4320, outcome: 'TP1' },
  { channel: 'MARCO TRADING HUB', time: '09:28', action: 'SELL', entry: 4329, sl: 4341, tp1: 4325, tp2: 4321, outcome: 'TP1' },
  { channel: 'Candle Logic Lab', time: '11:31', action: 'BUY', entry: 4304, sl: 4298, tp1: 4307, tp2: 4310, outcome: 'TP1' },
  { channel: 'Aliens- Royal fx', time: '10:00', action: 'SELL', entry: 4330, sl: 4335, tp1: 4325, tp2: 4321, outcome: 'SL' },
  { channel: 'Smart Pips Alerts', time: '03:48', action: 'BUY', entry: 4310, sl: 4300, tp1: 4314, tp2: 4318, outcome: 'SL' },
  { channel: 'Smart Pips Alerts', time: '04:03', action: 'BUY', entry: 4300, sl: 4290, tp1: 4304, tp2: 4308, outcome: 'TP1' },
  { channel: 'Smart Pips Alerts', time: '08:50', action: 'BUY', entry: 4308, sl: 4297, tp1: 4312, tp2: 4315, outcome: 'TP1' },
  { channel: 'FX PRO SIGNAL TEAM', time: '02:33', action: 'BUY', entry: 4285, sl: 4276, tp1: 4288, tp2: 4291, outcome: 'TP1' }
];

const FIXED_LOT = 0.01;
const SLIPPAGE_PIPS = 2.5;

console.log('========================================================================================');
console.log('📊 AUDITORÍA CUENTA DE $100 USD (LOTES FIJOS 0.01) - HOY Y PROYECCIÓN SEMANAL A TP2');
console.log('========================================================================================\n');

let profitTodayTP1 = 0;
let profitTodayTP2 = 0;

signalsToday.forEach((s, idx) => {
  if (s.outcome === 'SL_REJECTED') return;

  const pipsSL = Math.abs(s.entry - s.sl);
  const pipsTP1Real = Math.max(0.5, Math.abs(s.tp1 - s.entry) - SLIPPAGE_PIPS);
  const pipsTP2Real = Math.max(0.5, Math.abs(s.tp2 - s.entry) - SLIPPAGE_PIPS);

  let p1 = 0, p2 = 0;
  if (s.outcome === 'TP1') {
    p1 = FIXED_LOT * pipsTP1Real * 100;
    p2 = FIXED_LOT * pipsTP2Real * 100;
  } else {
    p1 = -(FIXED_LOT * pipsSL * 100);
    p2 = -(FIXED_LOT * pipsSL * 100);
  }

  profitTodayTP1 += p1;
  profitTodayTP2 += p2;

  console.log(`[#${idx+1}] ${s.channel} | ${s.action} 0.01 lotes | SL: -${pipsSL.toFixed(1)}p ($${(pipsSL).toFixed(2)})`);
  console.log(`     • Mercado Real TP1: ${p1 >= 0 ? '+' : ''}$${p1.toFixed(2)} (${pipsTP1Real.toFixed(1)}p)`);
  console.log(`     • Mercado Real TP2: ${p2 >= 0 ? '+' : ''}$${p2.toFixed(2)} (${pipsTP2Real.toFixed(1)}p)\n`);
});

const weeklyMultiplier = 4.2; // 4.2 días de volumen equivalente semanal
const weeklyProfitTP2 = profitTodayTP2 * weeklyMultiplier;

console.log('========================================================================================');
console.log('🏆 RESUMEN GENERAL PARA CUENTA DE $100 USD (LOTE MÍNIMO 0.01)');
console.log('========================================================================================');
console.log(`1. RESULTADO DE HOY (17 SEP):`);
console.log(`   - En TP1 Real: ${profitTodayTP1 >= 0 ? '+' : ''}$${profitTodayTP1.toFixed(2)} USD`);
console.log(`   - En TP2 Real (Configuración Activa): ${profitTodayTP2 >= 0 ? '+' : ''}$${profitTodayTP2.toFixed(2)} USD (+${(profitTodayTP2).toFixed(1)}% de la cuenta)\n`);

console.log(`2. ESTIMACIÓN DE LA SEMANA A TP2 (Mercado Real desfasado 2.5p):`);
console.log(`   - Beneficio Neto Estimado Semana: +$${weeklyProfitTP2.toFixed(2)} USD`);
console.log(`   - Crecimiento Estimado de la Cuenta: +${weeklyProfitTP2.toFixed(1)}% (Pasando la cuenta de $100$ a ~$1${(100 + weeklyProfitTP2).toFixed(0)}$)`);
console.log('========================================================================================');
