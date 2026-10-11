/**
 * Servicio Centralizado de Base de Datos SQLite (trading_data.db)
 * Motor nativo node:sqlite de Node.js (Node 22+)
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'trading_data.db');

class DatabaseService {
  constructor(dbPath = DB_PATH) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(this.dbPath);
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proprietary_trades (
        id TEXT PRIMARY KEY,
        strategy_name TEXT,
        timeframe TEXT,
        symbol TEXT,
        type TEXT,
        entry_price REAL,
        initial_sl REAL,
        current_sl REAL,
        sl_pips REAL,
        tp_pips REAL,
        tp_price REAL,
        open_time TEXT,
        close_time TEXT,
        status TEXT,
        profit_pips REAL,
        gross_profit REAL,
        lot_size REAL,
        is_live INTEGER,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_prop_sym ON proprietary_trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_prop_status ON proprietary_trades(status);
      CREATE INDEX IF NOT EXISTS idx_prop_close ON proprietary_trades(close_time);

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        channel_id TEXT,
        channel_name TEXT,
        action TEXT,
        symbol TEXT,
        entry REAL,
        sl REAL,
        tp1 REAL,
        tp2 REAL,
        tp3 REAL,
        current_price REAL,
        spread_pips REAL,
        market_bias TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_snap_sym ON market_snapshots(symbol);
      CREATE INDEX IF NOT EXISTS idx_snap_time ON market_snapshots(timestamp);
    `);

    try {
      this.db.exec(`ALTER TABLE proprietary_trades ADD COLUMN reason TEXT;`);
    } catch (e) {
      // Columna ya existe
    }
  }

  upsertProprietaryTrade(trade, strategyName = '', isLive = false) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO proprietary_trades (
          id, strategy_name, timeframe, symbol, type,
          entry_price, initial_sl, current_sl, sl_pips,
          tp_pips, tp_price, open_time, close_time,
          status, profit_pips, gross_profit, lot_size, is_live, reason
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          current_sl = excluded.current_sl,
          close_time = excluded.close_time,
          status = excluded.status,
          profit_pips = excluded.profit_pips,
          gross_profit = excluded.gross_profit,
          reason = excluded.reason;
      `);

      stmt.run(
        String(trade.id),
        strategyName || trade.strategy || '',
        trade.timeframe || '',
        trade.symbol || '',
        trade.type || '',
        trade.entryPrice != null ? Number(trade.entryPrice) : null,
        trade.initialSL != null ? Number(trade.initialSL) : null,
        (trade.currentSL ?? trade.initialSL) != null ? Number(trade.currentSL ?? trade.initialSL) : null,
        trade.slPips != null ? Number(trade.slPips) : null,
        trade.tpPips != null ? Number(trade.tpPips) : null,
        trade.tpPrice != null ? Number(trade.tpPrice) : null,
        trade.openTime || new Date().toISOString(),
        trade.closeTime || null,
        trade.status || 'OPEN',
        trade.pips != null ? Number(trade.pips) : (trade.profitPips != null ? Number(trade.profitPips) : null),
        trade.grossProfit != null ? Number(trade.grossProfit) : (trade.profitUSD != null ? Number(trade.profitUSD) : null),
        trade.lotSize != null ? Number(trade.lotSize) : (trade.lots != null ? Number(trade.lots) : null),
        isLive ? 1 : 0,
        trade.reason || null
      );
    } catch (err) {
      console.error('❌ Error en DatabaseService.upsertProprietaryTrade:', err.message);
    }
  }

  getActiveProprietaryTrades(symbol = null) {
    try {
      if (symbol) {
        return this.db.prepare(
          `SELECT * FROM proprietary_trades WHERE status = 'OPEN' AND symbol = ? ORDER BY open_time ASC`
        ).all(symbol);
      }
      return this.db.prepare(
        `SELECT * FROM proprietary_trades WHERE status = 'OPEN' ORDER BY open_time ASC`
      ).all();
    } catch (e) {
      return [];
    }
  }

  getRecentProprietaryTrades(options = {}) {
    const { symbol, limit = 20, status } = options;
    let sql = `SELECT * FROM proprietary_trades WHERE 1=1`;
    const params = [];
    if (symbol) {
      sql += ` AND symbol = ?`;
      params.push(symbol);
    }
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY COALESCE(close_time, open_time) DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  getProprietaryMetrics(symbol = null) {
    try {
      let sql = `
        SELECT 
          COUNT(*) as totalTrades,
          SUM(CASE WHEN profit_pips > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN profit_pips <= 0 THEN 1 ELSE 0 END) as losses,
          ROUND(AVG(CASE WHEN profit_pips > 0 THEN 1.0 ELSE 0.0 END) * 100, 1) as winRate,
          ROUND(SUM(profit_pips), 1) as netPips,
          ROUND(SUM(CASE WHEN profit_pips > 0 THEN profit_pips ELSE 0 END), 1) as grossWonPips,
          ROUND(SUM(CASE WHEN profit_pips < 0 THEN ABS(profit_pips) ELSE 0 END), 1) as grossLostPips
        FROM proprietary_trades
        WHERE status = 'CLOSED'
      `;
      const params = [];
      if (symbol) {
        sql += ` AND symbol = ?`;
        params.push(symbol);
      }
      const res = this.db.prepare(sql).get(...params) || {};
      const won = res.grossWonPips || 0;
      const lost = res.grossLostPips || 0;
      res.profitFactor = lost > 0 ? +(won / lost).toFixed(2) : (won > 0 ? 99.0 : 0.0);
      return res;
    } catch (e) {
      return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, netPips: 0, profitFactor: 0 };
    }
  }

  saveMarketSnapshot(s) {
    try {
      const sig = s.originalSignal || {};
      const stmt = this.db.prepare(`
        INSERT INTO market_snapshots (
          timestamp, channel_id, channel_name, action, symbol,
          entry, sl, tp1, tp2, tp3, current_price, spread_pips, market_bias, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        s.timestamp || new Date().toISOString(),
        s.channelId || sig.channelId || '',
        s.channelName || sig.channelName || '',
        s.action || sig.action || '',
        s.symbol || sig.symbol || '',
        sig.entry != null ? Number(sig.entry) : null,
        sig.sl != null ? Number(sig.sl) : null,
        sig.tp1 != null ? Number(sig.tp1) : null,
        sig.tp2 != null ? Number(sig.tp2) : null,
        sig.tp3 != null ? Number(sig.tp3) : null,
        s.currentPrice != null ? Number(s.currentPrice) : (s.livePrice != null ? Number(s.livePrice) : null),
        s.spreadPips != null ? Number(s.spreadPips) : null,
        s.marketBias || null,
        JSON.stringify(s)
      );
    } catch (err) {
      console.error('❌ Error guardando snapshot en SQLite:', err.message);
    }
  }

  query(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  getOne(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }
}

const databaseService = new DatabaseService();

module.exports = {
  DatabaseService,
  databaseService
};
