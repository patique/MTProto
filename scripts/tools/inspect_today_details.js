const fs = require('fs');

const snapshots = JSON.parse(fs.readFileSync('market_snapshots.json', 'utf8'));
const todayTrades = snapshots.filter(s => s.utcDate && s.utcDate.startsWith('2026-09-29'));

console.log(JSON.stringify(todayTrades, null, 2));
