/**
 * Auditoria reproducible de ejecucion real MT5 por cuenta, simbolo y estrategia.
 *
 * Lee history_exports/history_positions_*.json y history_deals_*.json.
 * Uso: node scripts/audits/audit_real_execution_by_strategy.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HISTORY_DIR = path.join(ROOT, 'history_exports');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function round(value, digits = 2) {
  return Number((value || 0).toFixed(digits));
}

function normalizeSource(comment) {
  const raw = String(comment || '').trim();
  if (!raw) return 'UNTAGGED';
  if (/^\[?sl\s/i.test(raw)) return 'BROKER_SL_COMMENT';
  if (/^\[?tp\s/i.test(raw)) return 'BROKER_TP_COMMENT';
  return raw;
}

function summarizeRows(rows) {
  const acc = {
    trades: 0,
    wins: 0,
    losses: 0,
    be: 0,
    net: 0,
    gross: 0,
    commission: 0,
    swap: 0,
    pips: 0,
    volume: 0
  };

  for (const row of rows) {
    const net = Number(row.NetProfit) || 0;
    acc.trades++;
    acc.net += net;
    acc.gross += Number(row.GrossProfit) || 0;
    acc.commission += Number(row.Commission) || 0;
    acc.swap += Number(row.Swap) || 0;
    acc.pips += Number(row.Pips) || 0;
    acc.volume += Number(row.Volume) || 0;
    if (net > 0) acc.wins++;
    else if (net < 0) acc.losses++;
    else acc.be++;
  }

  const grossWon = rows.filter(r => Number(r.NetProfit) > 0).reduce((s, r) => s + Number(r.NetProfit), 0);
  const grossLost = Math.abs(rows.filter(r => Number(r.NetProfit) < 0).reduce((s, r) => s + Number(r.NetProfit), 0));

  return {
    trades: acc.trades,
    winRate: acc.trades ? round((acc.wins / acc.trades) * 100, 1) : 0,
    profitFactor: grossLost > 0 ? round(grossWon / grossLost, 2) : (grossWon > 0 ? 99 : 0),
    net: round(acc.net),
    gross: round(acc.gross),
    commission: round(acc.commission),
    swap: round(acc.swap),
    pips: round(acc.pips, 1),
    avgNet: acc.trades ? round(acc.net / acc.trades) : 0,
    avgVolume: acc.trades ? round(acc.volume / acc.trades, 2) : 0,
    wins: acc.wins,
    losses: acc.losses,
    be: acc.be
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()]
    .map(([key, values]) => ({ key, ...summarizeRows(values) }))
    .sort((a, b) => a.net - b.net);
}

function loadAccount(account) {
  const positionsFile = path.join(HISTORY_DIR, `history_positions_${account}.json`);
  const dealsFile = path.join(HISTORY_DIR, `history_deals_${account}.json`);
  const positions = readJson(positionsFile);
  const deals = readJson(dealsFile);
  const entryCommentByPosition = new Map();

  for (const deal of deals) {
    if (deal.Entry === 'IN' && deal.PositionID) {
      entryCommentByPosition.set(String(deal.PositionID), normalizeSource(deal.Comment));
    }
  }

  return positions.map(pos => ({
    ...pos,
    EntryComment: entryCommentByPosition.get(String(pos.PositionID)) || 'UNMATCHED_ENTRY'
  }));
}

function main() {
  const accounts = fs.readdirSync(HISTORY_DIR)
    .map(file => file.match(/^history_positions_(\d+)\.json$/))
    .filter(Boolean)
    .map(match => match[1])
    .sort();

  const report = {
    generatedAt: new Date().toISOString(),
    accounts: {}
  };

  for (const account of accounts) {
    const rows = loadAccount(account);
    report.accounts[account] = {
      summary: summarizeRows(rows),
      bySymbol: groupBy(rows, row => row.Symbol || 'UNKNOWN'),
      byStrategy: groupBy(rows, row => row.EntryComment),
      byCloseComment: groupBy(rows, row => normalizeSource(row.CloseComment)),
      worstDays: groupBy(rows, row => String(row.CloseTime || '').slice(0, 10)).slice(0, 10)
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main();
}
