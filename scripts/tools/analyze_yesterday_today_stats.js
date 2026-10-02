const fs = require('fs');
const http = require('http');

function checkSnapshots() {
  const snapshots = JSON.parse(fs.readFileSync('market_snapshots.json', 'utf8'));
  console.log(`Total snapshots in database: ${snapshots.length}`);

  // Filtrar por 2026-09-28 y 2026-09-29
  const yesterdayTrades = snapshots.filter(s => s.utcDate && s.utcDate.startsWith('2026-09-28'));
  const todayTrades = snapshots.filter(s => s.utcDate && s.utcDate.startsWith('2026-09-29'));

  console.log(`\n📅 OPERACIONES DE AYER (28/09/2026): ${yesterdayTrades.length}`);
  yesterdayTrades.forEach(t => {
    console.log(`   • [${t.timeStr}] Canal: ${t.channel.name} | ${t.order.action} ${t.order.symbol} @ ${t.order.entry} | SL: ${t.order.sl} | TP2: ${t.order.tp2} | Outcome: ${t.outcome.status} (${t.outcome.profitUSD >= 0 ? '+' : ''}$${t.outcome.profitUSD} USD, ${t.outcome.pipsGained} pips)`);
  });

  console.log(`\n📅 OPERACIONES DE HOY (29/09/2026): ${todayTrades.length}`);
  todayTrades.forEach(t => {
    console.log(`   • [${t.timeStr}] Canal: ${t.channel.name} | ${t.order.action} ${t.order.symbol} @ ${t.order.entry} | SL: ${t.order.sl} | TP2: ${t.order.tp2} | Outcome: ${t.outcome.status} (${t.outcome.profitUSD >= 0 ? '+' : ''}$${t.outcome.profitUSD} USD, ${t.outcome.pipsGained} pips)`);
  });
}

function checkLiveStatus() {
  http.get('http://127.0.0.1:3000/api/status', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        console.log('\n📊 ESTADO EN VIVO EN MT5:');
        console.log(`   • Balance: $${j.balance} USD`);
        console.log(`   • PnL Diario: $${j.dailyPnL} USD (${j.dailyPnLPercent})`);
        console.log(`   • Win Rate Global: ${j.globalWinRate}`);
        console.log(`   • Total Pips Ganados: ${j.totalPips}`);
        console.log(`   • Tick Actual: Bid ${j.tick.bid} / Ask ${j.tick.ask}`);
      } catch (e) {
        console.error('Error parsing live status:', e.message);
      }
    });
  });
}

checkSnapshots();
checkLiveStatus();
