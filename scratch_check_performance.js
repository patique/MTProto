const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('trading_data.db');

console.log('=== CLOSED DEALS TODAY (2026.10.07) ===');
const deals = db.prepare(`SELECT ticket, time, symbol, type, entry, volume, price, profit, comment FROM closed_deals WHERE time >= '2026.10.07' ORDER BY ticket ASC`).all();
console.log('Total deals count today:', deals.length);
let win = 0, loss = 0, sumProfit = 0;
for (const d of deals) {
  if (d.entry === 'OUT') {
    sumProfit += d.profit;
    if (d.profit > 0) win++;
    else if (d.profit < 0) loss++;
    console.log(`${d.time} | ${d.symbol} | ${d.type} | Vol: ${d.volume} | Profit: ${d.profit.toFixed(2)} | ${d.comment}`);
  }
}
console.log(`Summary TODAY: Wins: ${win}, Losses: ${loss}, Sum: ${sumProfit.toFixed(2)}`);

console.log('\n=== RECENT CLOSED DEALS (LAST 20 OUT) ===');
const recent = db.prepare(`SELECT ticket, time, symbol, type, entry, volume, price, profit, comment FROM closed_deals WHERE entry = 'OUT' ORDER BY ticket DESC LIMIT 20`).all();
for (const d of recent) {
  console.log(`${d.time} | ${d.symbol} | ${d.type} | Vol: ${d.volume} | Profit: ${d.profit.toFixed(2)} | ${d.comment}`);
}
