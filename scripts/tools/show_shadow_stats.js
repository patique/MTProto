/**
 * Consulta Rápida de la Comparativa de Estrategias en la Sombra
 * Muestra el acumulado de:
 * 1. Estrategia de la Mañana (100% TP2)
 * 2. En Vivo Real (50/50 - Tu cuenta actual)
 * 3. Nueva Propuesta (70/30)
 */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../../shadow_comparison.json');

if (!fs.existsSync(file)) {
  console.log('No hay datos registrados aún en shadow_comparison.json');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = data.summary;

console.log('\n================================================================================================================');
console.log(`📊 COMPARATIVA EN TIEMPO REAL EN LA SOMBRA (TOTAL: ${s.totalTrades} OPERACIONES REGISTRADAS)`);
console.log('================================================================================================================\n');

console.log(`${'Estrategia Auditada'.padEnd(35)} | ${'Profit Acumulado ($)'.padStart(22)} | ${'Pips Acumulados'.padStart(18)} | ${'Trades Ganados'.padStart(15)}`);
console.log('-'.repeat(96));

const op1 = s.option1_morning;
const op2 = s.option2_live5050;
const op3 = s.option3_new7030;

console.log(`${op1.name.padEnd(35)} | ${(op1.profitUSD >= 0 ? '+' : '') + '$' + op1.profitUSD.toFixed(2) + ' USD'}`.padEnd(59) + ` | ${(op1.pips >= 0 ? '+' : '') + op1.pips.toFixed(1) + ' p'}`.padEnd(20) + ` | ${op1.wins} / ${s.totalTrades}`);
console.log(`${(op2.name + ' [CUENTA REAL]').padEnd(35)} | ${(op2.profitUSD >= 0 ? '+' : '') + '$' + op2.profitUSD.toFixed(2) + ' USD'}`.padEnd(59) + ` | ${(op2.pips >= 0 ? '+' : '') + op2.pips.toFixed(1) + ' p'}`.padEnd(20) + ` | ${op2.wins} / ${s.totalTrades}`);
console.log(`${op3.name.padEnd(35)} | ${(op3.profitUSD >= 0 ? '+' : '') + '$' + op3.profitUSD.toFixed(2) + ' USD'}`.padEnd(59) + ` | ${(op3.pips >= 0 ? '+' : '') + op3.pips.toFixed(1) + ' p'}`.padEnd(20) + ` | ${op3.wins} / ${s.totalTrades}`);

console.log('================================================================================================================\n');

console.log('Últimas Operaciones Registradas:');
const recent = data.history.slice(-5);
recent.forEach(r => {
  console.log(`[${r.dateStr}] #${r.position} ${r.channel}:`);
  console.log(`   • 1. Mañana (100% TP2):  +$${r.option1_morning.profitUSD.toFixed(2)} USD (+${r.option1_morning.pips.toFixed(1)}p)`);
  console.log(`   • 2. Real (50/50):        +$${r.option2_live5050.profitUSD.toFixed(2)} USD (+${r.option2_live5050.pips.toFixed(1)}p)  👉 [EJECUTADO]`);
  console.log(`   • 3. Nueva (70/30):       +$${r.option3_new7030.profitUSD.toFixed(2)} USD (+${r.option3_new7030.pips.toFixed(1)}p)`);
});
console.log('\n');
