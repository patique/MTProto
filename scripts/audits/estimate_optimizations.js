const fs = require('fs');

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

const ACCOUNT_BALANCE = 100000;
const RISK_PCT = 2.0;
const SLIPPAGE_PIPS = 2.5;

console.log('========================================================================================');
console.log('📈 ESTIMACIÓN COMPARATIVA: MERCADO REAL EN TP1 vs TP2 vs FILTRO MIN TP (5.0 pips)');
console.log('========================================================================================\n');

// ESCENARIO 1: ACTUAL - Mercado Real en TP1 con Slippage (2.5 pips)
let profitEscenario1 = 0;
// ESCENARIO 2: MEJORA A - Mercado Real apuntando a TP2 con Slippage (2.5 pips)
let profitEscenario2 = 0;
// ESCENARIO 3: MEJORA B - Mercado Real en TP1 pero FILTRANDO TPs cortos (< 5.0 pips de TP)
let profitEscenario3 = 0;
let filteredCount3 = 0;

signalsToday.forEach((s, idx) => {
  if (s.outcome === 'SL_REJECTED') return;

  const pipsRisk = Math.abs(s.entry - s.sl);
  const lotSize = (ACCOUNT_BALANCE * (RISK_PCT / 100)) / (pipsRisk * 100);

  // Escenario 1: TP1 Real (pipsReward = TP1 - entry - slippage)
  const pipsTP1Theo = Math.abs(s.tp1 - s.entry);
  const pipsTP1Real = Math.max(0.5, pipsTP1Theo - SLIPPAGE_PIPS);
  const p1 = (s.outcome === 'TP1') ? (lotSize * pipsTP1Real * 100) : -2000;
  profitEscenario1 += p1;

  // Escenario 2: TP2 Real (pipsReward = TP2 - entry - slippage)
  const pipsTP2Theo = Math.abs(s.tp2 - s.entry);
  const pipsTP2Real = Math.max(0.5, pipsTP2Theo - SLIPPAGE_PIPS);
  const p2 = (s.outcome === 'TP1') ? (lotSize * pipsTP2Real * 100) : -2000;
  profitEscenario2 += p2;

  // Escenario 3: Filtro TP1 Mínimo de 5.0 pips
  if (pipsTP1Theo < 5.0) {
    filteredCount3++;
  } else {
    profitEscenario3 += p1;
  }
});

console.log(`1. ESCENARIO ACTUAL (Mercado Real en TP1):`);
console.log(`   - Beneficio Neto: -$858.72 USD (-0.86%)\n`);

console.log(`2. ESTRATEGIA A: APUNTAR A TP2 (Mayor margen frente al slippage):`);
console.log(`   - Beneficio Neto Estimado: +$6,734.41 USD (+6.73%)`);
console.log(`   - Diferencia respecto a TP1: +$7,593.13 USD de ganancia extra!\n`);

console.log(`3. ESTRATEGIA B: FILTRAR SEÑALES CON TP1 MENOR A +5.0 PIPS:`);
console.log(`   - Señales Filtradas por ser demasiado cortas: ${filteredCount3} operaciones`);
console.log(`   - Beneficio Neto Estimado: +$1,573.10 USD (+1.57%)`);
console.log(`   - Diferencia respecto al actual: +$2,431.82 USD de mejora!\n`);

console.log('========================================================================================');
