const { databaseService } = require('../../core/DatabaseService');

const before = databaseService.getActiveProprietaryTrades();
console.log('Open trades before cleanup:', before);

const res = databaseService.db.prepare(
  "UPDATE proprietary_trades SET status = 'CLOSED', close_time = datetime('now') WHERE status = 'OPEN'"
).run();

console.log('Stale trades closed in SQLite:', res.changes);

const after = databaseService.getActiveProprietaryTrades();
console.log('Open trades after cleanup:', after);
