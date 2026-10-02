const fs = require('fs');

const signalsToday = [
  { channel: 'Williams tradershub', time: '06:38', action: 'BUY', entry: 4293, sl: 4279, tp1: 4297, outcome: 'TP1' },
  { channel: 'Williams tradershub', time: '11:37', action: 'SELL', entry: 4309, sl: 4322, tp1: 4306, outcome: 'TP1' },
  { channel: 'Williams tradershub', time: '13:49', action: 'SELL', entry: 4332, sl: 4345, tp1: 4329, outcome: 'SL_REJECTED' },
  { channel: 'XAUUSD FOREX TRADING', time: '10:58', action: 'BUY', entry: 4310, sl: 4295, tp1: 4315, outcome: 'TP1' },
  { channel: 'Attaullah Trading Zone', time: '05:05', action: 'BUY', entry: 4276, sl: 4259, tp1: 4280, outcome: 'TP1' },
  { channel: 'Attaullah Trading Zone', time: '08:22', action: 'SELL', entry: 4308, sl: 4317, tp1: 4303, outcome: 'TP1' },
  { channel: 'Attaullah Trading Zone', time: '09:42', action: 'SELL', entry: 4334, sl: 4353, tp1: 4325, outcome: 'TP1' },
  { channel: 'MARCO TRADING HUB', time: '09:28', action: 'SELL', entry: 4329, sl: 4341, tp1: 4325, outcome: 'TP1' },
  { channel: 'Candle Logic Lab', time: '11:31', action: 'BUY', entry: 4304, sl: 4298, tp1: 4307, outcome: 'TP1' },
  { channel: 'Aliens- Royal fx', time: '10:00', action: 'SELL', entry: 4330, sl: 4335, tp1: 4325, outcome: 'SL' },
  { channel: 'Smart Pips Alerts', time: '03:48', action: 'BUY', entry: 4310, sl: 4300, tp1: 4314, outcome: 'SL' },
  { channel: 'Smart Pips Alerts', time: '04:03', action: 'BUY', entry: 4300, sl: 4290, tp1: 4304, outcome: 'TP1' },
  { channel: 'Smart Pips Alerts', time: '08:50', action: 'BUY', entry: 4308, sl: 4297, tp1: 4312, outcome: 'TP1' },
  { channel: 'FX PRO SIGNAL TEAM', time: '02:33', action: 'BUY', entry: 4285, sl: 4276, tp1: 4288, outcome: 'TP1' }
];

const ACCOUNT_BALANCE = 100000;
const RISK_PCT = 2.0;
const SLIPPAGE_PIPS = 2.5;

let winNoSlip = 0, lossNoSlip = 0, totalProfitNoSlip = 0;
let winWithSlip = 0, lossWithSlip = 0, totalProfitWithSlip = 0;

console.log('====================================================================');
console.log('📊 AUDITORÍA DE OPERACIONES DE HOY (17 SEP) - CUENTA $100,000 (RIESGO 2.0%)');
console.log('====================================================================\n');

signalsToday.forEach((s, idx) => {
  if (s.outcome === 'SL_REJECTED') {
    console.log(`[#${idx+1}] ${s.channel} (${s.time}) -> 🛡️ BLOQUEADA POR EL ESCUDO DE RIESGO ($0.00)`);
    return;
  }

  const pipsRiskTheoretical = Math.abs(s.entry - s.sl);
  const pipsRewardTheoretical = Math.abs(s.tp1 - s.entry);
  const lotSize = (ACCOUNT_BALANCE * (RISK_PCT / 100)) / (pipsRiskTheoretical * 100);

  let pNoSlip = 0;
  if (s.outcome === 'TP1') {
    winNoSlip++;
    pNoSlip = lotSize * (pipsRewardTheoretical * 100);
  } else {
    lossNoSlip++;
    pNoSlip = -2000;
  }
  totalProfitNoSlip += pNoSlip;

  const pipsRewardReal = Math.max(0.5, pipsRewardTheoretical - SLIPPAGE_PIPS);
  let pWithSlip = 0;
  if (s.outcome === 'TP1') {
    winWithSlip++;
    pWithSlip = lotSize * (pipsRewardReal * 100);
  } else {
    lossWithSlip++;
    pWithSlip = -2000;
  }
  totalProfitWithSlip += pWithSlip;

  console.log(`[#${idx+1}] ${s.channel} (${s.time}) ${s.action} ${s.entry} | SL:${s.sl} TP1:${s.tp1} | Lotes: ${lotSize.toFixed(2)}`);
  console.log(`     • Teórico (Sin Slippage):   ${pNoSlip >= 0 ? '+' : ''}$${pNoSlip.toFixed(2)} (${pipsRewardTheoretical.toFixed(1)} pips)`);
  console.log(`     • Mercado Real (Desfase 2.5p): ${pWithSlip >= 0 ? '+' : ''}$${pWithSlip.toFixed(2)} (${pipsRewardReal.toFixed(1)} pips efectivos)`);
});

console.log('\n====================================================================');
console.log('🏆 RESUMEN COMPARATIVO DE RENTABILIDAD GLOBAL DE HOY');
console.log('====================================================================');
console.log(`1. TEÓRICO PERFECTO (Sin Desfase de Mercado):`);
console.log(`   - Operaciones Totales: 13 (11 Ganadas / 2 Perdidas)`);
console.log(`   - Tasa de Acierto (Win Rate): ${((winNoSlip / (winNoSlip + lossNoSlip)) * 100).toFixed(1)}%`);
console.log(`   - Beneficio Neto Teórico: +$${totalProfitNoSlip.toFixed(2)} USD (+${(totalProfitNoSlip / 1000).toFixed(2)}% de la cuenta)\n`);

console.log(`2. EJECUCIÓN A MERCADO REAL (Con Desfase Promedio de 2.5 pips):`);
console.log(`   - Operaciones Totales: 13 (11 Ganadas / 2 Perdidas)`);
console.log(`   - Tasa de Acierto Real: ${((winWithSlip / (winWithSlip + lossWithSlip)) * 100).toFixed(1)}%`);
console.log(`   - Beneficio Neto Real Estimado: +$${totalProfitWithSlip.toFixed(2)} USD (+${(totalProfitWithSlip / 1000).toFixed(2)}% de la cuenta)`);
console.log(`   - Impacto del Desfase de Mercado: -$${(totalProfitNoSlip - totalProfitWithSlip).toFixed(2)} USD`);
console.log('====================================================================');
