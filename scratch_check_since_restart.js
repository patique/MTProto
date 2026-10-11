const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\Administrator\\.pm2\\logs\\trading-bot-out.log', 'utf-8');
const lines = content.split('\n');

// Find restart at 12:22
let startIndex = 0;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('SISTEMA COMPLETO ACTIVO Y OPERANDO EN TIEMPO REAL')) {
    startIndex = i;
    break;
  }
}

console.log(`Analyzing logs from restart line ${startIndex} to ${lines.length}...`);
const restartLines = lines.slice(startIndex);

for (const l of restartLines) {
  if (
    l.includes('Señal Detectada') ||
    l.includes('Orden a Mercado') ||
    l.includes('Despachando') ||
    l.includes('FEEDBACK LOOP') ||
    l.includes('Operación Cerrada') ||
    l.includes('STOP_LOSS') ||
    l.includes('TAKE_PROFIT') ||
    l.includes('Orden ejecutada') ||
    l.includes('BPR') && (l.includes('CERRADO') || l.includes('BUY') || l.includes('SELL'))
  ) {
    console.log(l.trim());
  }
}
