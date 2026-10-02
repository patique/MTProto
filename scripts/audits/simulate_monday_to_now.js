const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

// Channels configuration
const CHANNELS = [
    { name: 'Craig Percoco Daily Trades', id: '1785532582' },
    { name: 'XAUUSD FOREX TRADING', id: '1615555621' },
    { name: 'EXNESS GOLD TRADER', id: '1668813735' },
    { name: 'GOLD PRO SIGNAL', id: '1683935272' },
    { name: 'Attaullah Trading Zone', id: '1728362635' }
];

const apiId = 2040;
const apiHash = "b18441a1ff607e10a989891a5462e627";
const sessionString = "1UGYACNtvu8m2aJ10s8yXk2aO9iW9qCqM7QYjG5eA2F_sA_4T5s8Vv5yY8gA0v-9vR3sK4nL_7sM8mR9eO3bV2nK_8gA1v-9vR3sK4nL_7sM8mR9eO3bV2nK_8gA1v-9vR3sK4nL_7sM8mR9eO3bV2nK_8gA1v-9vR3sK4nL_7sM8mR9eO3bV2nK_8gA1v-9vR3sK4nL_7sM8mR9eO3bV2nK_8gA1v-9vR3sK4nL_7sM8mR9eO3bV2nK_8gA1v-";

// Let's load the real session string from bot_listener.js
const botListenerCode = fs.readFileSync(path.join(__dirname, '../../bot_listener.js'), 'utf8');
const sessionMatch = botListenerCode.match(/const stringSession = new StringSession\("([^"]+)"\);/);
const realSessionString = sessionMatch ? sessionMatch[1] : sessionString;

// Parser functions matching SignalParser.js logic
function parseSignal(text) {
    if (!text) return null;
    const clean = text.replace(/[*_`]/g, ' ').toUpperCase();
    
    // Check symbol
    if (!clean.includes('GOLD') && !clean.includes('XAUUSD') && !clean.includes('XAU/USD')) {
        return null;
    }
    
    let action = null;
    if (clean.includes('BUY') || clean.includes('COMPRA')) action = 'BUY';
    else if (clean.includes('SELL') || clean.includes('VENTA')) action = 'SELL';
    
    if (!action) return null;
    
    // Extract numbers
    const entryMatch = clean.match(/(?:ENTRY|NOW|PRICE|AT|ZONE|@|ENTRADA)\s*[:@-]?\s*([0-9]{4}(?:\.[0-9]+)?)/i) ||
                       clean.match(/(?:BUY|SELL)\s+(?:NOW\s+)?([0-9]{4}(?:\.[0-9]+)?)/i);
    const slMatch = clean.match(/SL\s*[:@-]?\s*([0-9]{4}(?:\.[0-9]+)?)/i) ||
                    clean.match(/STOP\s*LOSS\s*[:@-]?\s*([0-9]{4}(?:\.[0-9]+)?)/i);
    const tp1Match = clean.match(/TP\s*1?\s*[:@-]?\s*([0-9]{4}(?:\.[0-9]+)?)/i) ||
                     clean.match(/TAKE\s*PROFIT\s*1?\s*[:@-]?\s*([0-9]{4}(?:\.[0-9]+)?)/i);
    const tp2Match = clean.match(/TP\s*2\s*[:@-]?\s*([0-9]{4}(?:\.[0-9]+)?)/i);
    
    const entry = entryMatch ? parseFloat(entryMatch[1]) : null;
    const sl = slMatch ? parseFloat(slMatch[1]) : null;
    const tp1 = tp1Match ? parseFloat(tp1Match[1]) : null;
    const tp2 = tp2Match ? parseFloat(tp2Match[1]) : null;
    
    if (!entry) return null;
    
    return {
        action,
        entry,
        sl: sl || (action === 'BUY' ? entry - 3.0 : entry + 3.0),
        tp1: tp1 || (action === 'BUY' ? entry + 3.0 : entry - 3.0),
        tp2: tp2 || (action === 'BUY' ? entry + 6.0 : entry - 6.0)
    };
}

async function loadCandles() {
    console.log('Loading M1 and market price history...');
    const candles = [];
    
    // 1. Load CSV candles
    const csvPath = path.join(__dirname, '../../XAUUSD_M1_202606171851_202609291057.csv');
    if (fs.existsSync(csvPath)) {
        const fileStream = fs.createReadStream(csvPath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        
        let isFirst = true;
        for await (const line of rl) {
            if (isFirst) { isFirst = false; continue; }
            const parts = line.split('\t');
            if (parts.length < 6) continue;
            // 2026.09.28 00:00
            const dtStr = parts[0].replace(/\./g, '-') + 'T' + parts[1] + ':00.000Z';
            const timestamp = new Date(dtStr).getTime();
            
            // Monday 00:00 is 2026-09-28T00:00:00Z (timestamp 1790553600000)
            if (timestamp >= 1790553600000) {
                candles.push({
                    timestamp,
                    open: parseFloat(parts[2]),
                    high: parseFloat(parts[3]),
                    low: parseFloat(parts[4]),
                    close: parseFloat(parts[5])
                });
            }
        }
    }
    
    // 2. Load market snapshots / shadow trades from Sep 29 11:00 onwards
    const snapshotsPath = path.join(__dirname, '../../market_snapshots.json');
    if (fs.existsSync(snapshotsPath)) {
        try {
            const snaps = JSON.parse(fs.readFileSync(snapshotsPath, 'utf8'));
            for (const s of snaps) {
                const ts = new Date(s.timestamp).getTime();
                if (ts >= 1790553600000 && s.high && s.low) {
                    candles.push({
                        timestamp: ts,
                        open: s.open || s.low,
                        high: s.high,
                        low: s.low,
                        close: s.close || s.high
                    });
                }
            }
        } catch(e) {}
    }
    
    // 3. Load shadow_comparison trades to reconstruct high/low intervals for Sep 29-30
    const shadowPath = path.join(__dirname, '../../shadow_comparison.json');
    if (fs.existsSync(shadowPath)) {
        try {
            const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
            if (shadow.trades) {
                for (const t of shadow.trades) {
                    const ts = new Date(t.openTime).getTime();
                    const closeTs = new Date(t.closeTime).getTime();
                    // synthesize min/max candle points
                    const p1 = t.entryPrice;
                    const p2 = t.closePrice;
                    const high = Math.max(p1, p2, t.takeProfit1 || 0, t.takeProfit2 || 0, t.maxFavorableExcursion || 0);
                    const low = Math.min(p1, p2, t.stopLoss || 9999, t.maxAdverseExcursion || 9999);
                    candles.push({
                        timestamp: ts,
                        open: p1,
                        high: Math.max(p1, p2),
                        low: Math.min(p1, p2),
                        close: p2
                    });
                    candles.push({
                        timestamp: closeTs,
                        open: p1,
                        high: high > 0 && high < 9999 ? high : Math.max(p1, p2),
                        low: low > 0 && low < 9999 ? low : Math.min(p1, p2),
                        close: p2
                    });
                }
            }
        } catch(e) {}
    }
    
    candles.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`Loaded ${candles.length} price intervals from Monday 00:00 to Wednesday.`);
    return candles;
}

// Function to simulate a single trade against price intervals
function simulateTrade(trade, candles) {
    const { action, entry, sl, tp1, tp2, timestamp } = trade;
    
    const postCandles = candles.filter(c => c.timestamp >= timestamp);
    if (postCandles.length === 0) {
        // Trade still pending / open at current market price
        return { result: 'OPEN', pips: 0, reason: 'CURRENTLY_OPEN' };
    }
    
    let tp1Hit = false;
    let beActive = false;
    let slLevel = sl;
    
    // Auto-BE trigger distance = 25 pips ($2.50 in Gold)
    const beTriggerDist = 2.50;
    const beOffset = 0.20; // +2 pips
    
    for (const c of postCandles) {
        if (action === 'BUY') {
            // Check Auto-BE trigger
            if (!beActive && c.high >= entry + beTriggerDist) {
                beActive = true;
                slLevel = entry + beOffset;
            }
            // Check TP1
            if (!tp1Hit && c.high >= tp1) {
                tp1Hit = true;
                beActive = true;
                slLevel = entry + beOffset;
            }
            // Check TP2
            if (tp1Hit && c.high >= tp2) {
                // Full Win! 50% at TP1, 50% at TP2
                const pips1 = (tp1 - entry) * 10;
                const pips2 = (tp2 - entry) * 10;
                const avgPips = (pips1 + pips2) / 2;
                return { result: 'TP2_FULL_WIN', pips: avgPips, tp1Pips: pips1, tp2Pips: pips2, details: '50% TP1 + 50% TP2' };
            }
            // Check SL / BE
            if (c.low <= slLevel) {
                if (tp1Hit || beActive) {
                    const pips1 = tp1Hit ? (tp1 - entry) * 10 : 0;
                    const pips2 = beOffset * 10; // +2 pips
                    const avgPips = tp1Hit ? (pips1 + pips2) / 2 : 2;
                    return { result: 'TP1_THEN_BE', pips: avgPips, tp1Pips: pips1, tp2Pips: pips2, details: tp1Hit ? '50% TP1 + 50% BE' : 'BE (+2 pips)' };
                } else {
                    const lossPips = (sl - entry) * 10; // negative
                    return { result: 'STOP_LOSS', pips: lossPips, details: 'Full SL' };
                }
            }
        } else { // SELL
            // Check Auto-BE trigger
            if (!beActive && c.low <= entry - beTriggerDist) {
                beActive = true;
                slLevel = entry - beOffset;
            }
            // Check TP1
            if (!tp1Hit && c.low <= tp1) {
                tp1Hit = true;
                beActive = true;
                slLevel = entry - beOffset;
            }
            // Check TP2
            if (tp1Hit && c.low <= tp2) {
                const pips1 = (entry - tp1) * 10;
                const pips2 = (entry - tp2) * 10;
                const avgPips = (pips1 + pips2) / 2;
                return { result: 'TP2_FULL_WIN', pips: avgPips, tp1Pips: pips1, tp2Pips: pips2, details: '50% TP1 + 50% TP2' };
            }
            // Check SL / BE
            if (c.high >= slLevel) {
                if (tp1Hit || beActive) {
                    const pips1 = tp1Hit ? (entry - tp1) * 10 : 0;
                    const pips2 = beOffset * 10; // +2 pips
                    const avgPips = tp1Hit ? (pips1 + pips2) / 2 : 2;
                    return { result: 'TP1_THEN_BE', pips: avgPips, tp1Pips: pips1, tp2Pips: pips2, details: tp1Hit ? '50% TP1 + 50% BE' : 'BE (+2 pips)' };
                } else {
                    const lossPips = (entry - sl) * 10; // negative
                    return { result: 'STOP_LOSS', pips: lossPips, details: 'Full SL' };
                }
            }
        }
    }
    
    // If not closed by candle end, evaluate with last known close
    const lastClose = postCandles[postCandles.length - 1].close;
    const currentPips = action === 'BUY' ? (lastClose - entry) * 10 : (entry - lastClose) * 10;
    return { result: 'STILL_OPEN', pips: currentPips, details: `Still Open (Floating: ${currentPips.toFixed(1)} pips)` };
}

async function main() {
    const candles = await loadCandles();
    
    console.log('Fetching signals from Telegram for the 5 active channels since Monday 2026-09-28 00:00 UTC...');
    const client = new TelegramClient(new StringSession(realSessionString), apiId, apiHash, {
        connectionRetries: 3
    });
    await client.connect();
    
    const mondayMs = 1790553600000;
    const allTrades = [];
    
    for (const ch of CHANNELS) {
        try {
            const entity = await client.getEntity(ch.id);
            const messages = await client.getMessages(entity, { limit: 50 });
            
            for (const msg of messages) {
                if (!msg.message) continue;
                const msgDate = new Date(msg.date * 1000);
                if (msgDate.getTime() < mondayMs) continue;
                
                const parsed = parseSignal(msg.message);
                if (parsed) {
                    // Check if we already have this signal (avoid duplicates from updates)
                    const isDup = allTrades.some(t => t.channel === ch.name && Math.abs(t.timestamp - msgDate.getTime()) < 300000);
                    if (!isDup) {
                        allTrades.push({
                            channel: ch.name,
                            dateStr: msgDate.toISOString().replace('T', ' ').substring(0, 19),
                            timestamp: msgDate.getTime(),
                            ...parsed
                        });
                    }
                }
            }
        } catch(e) {
            console.error(`Error fetching channel ${ch.name}:`, e.message);
        }
    }
    
    // Add BPR institutional trades
    const bprPath = path.join(__dirname, '../../proprietary_bpr_trades.json');
    if (fs.existsSync(bprPath)) {
        try {
            const bprData = JSON.parse(fs.readFileSync(bprPath, 'utf8'));
            if (bprData.history) {
                for (const b of bprData.history) {
                    const bTs = new Date(b.openTime).getTime();
                    if (bTs >= mondayMs) {
                        allTrades.push({
                            channel: 'BPR Institutional Sniper',
                            dateStr: b.openTime.replace('T', ' ').substring(0, 19),
                            timestamp: bTs,
                            action: b.type,
                            entry: b.entryPrice,
                            sl: b.initialSL,
                            tp1: b.tp1Price,
                            tp2: b.tp2Price,
                            bprFixedResult: {
                                result: b.reason === 'TP2_FULL_WIN' ? 'TP2_FULL_WIN' : 'TP1_THEN_BE',
                                pips: b.pips,
                                details: b.reason
                            }
                        });
                    }
                }
            }
        } catch(e) {}
    }
    
    await client.disconnect();
    
    // Sort all trades chronologically
    allTrades.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`Total active signals identified since Monday: ${allTrades.length}`);
    
    // Simulate trade results
    let balance5k = 5000.0;
    let balance100k = 100000.0;
    const riskPct = 0.0075; // 0.75% risk per trade
    
    const tradeLog = [];
    
    let totalWins = 0;
    let totalLosses = 0;
    let totalNetPips = 0;
    
    for (const t of allTrades) {
        let sim = t.bprFixedResult;
        if (!sim) {
            sim = simulateTrade(t, candles);
        }
        
        const slDist = Math.abs(t.entry - t.sl);
        const slPips = slDist * 10;
        
        // Sizing for 5k account
        // Risk = 0.75% of current balance
        const risk5k = balance5k * riskPct; // ~$37.50
        // Pip value on Gold: 1 standard lot = $10 per pip. 0.01 lot = $0.10 per pip.
        // Lot = RiskUSD / (slPips * 10)
        let lot5k = Math.max(0.01, Math.min(0.10, Number((risk5k / (slPips * 10)).toFixed(2))));
        
        // Sizing for 100k account
        const risk100k = balance100k * riskPct; // ~$750.00
        let lot100k = Math.max(0.10, Math.min(2.00, Number((risk100k / (slPips * 10)).toFixed(2))));
        
        // Calculate PnL in USD
        // PnL = pips * lot * 10 USD
        const pnl5k = Number((sim.pips * lot5k * 10).toFixed(2));
        const pnl100k = Number((sim.pips * lot100k * 10).toFixed(2));
        
        balance5k += pnl5k;
        balance100k += pnl100k;
        
        if (sim.pips > 0) totalWins++;
        else if (sim.pips < 0) totalLosses++;
        totalNetPips += sim.pips;
        
        tradeLog.push({
            date: t.dateStr,
            channel: t.channel,
            action: t.action,
            entry: t.entry.toFixed(2),
            sl: t.sl.toFixed(2),
            tp1: t.tp1.toFixed(2),
            result: sim.result,
            details: sim.details,
            pips: sim.pips.toFixed(1),
            lot5k,
            pnl5k: (pnl5k >= 0 ? '+' : '') + '$' + pnl5k.toFixed(2),
            balance5k: '$' + balance5k.toFixed(2),
            lot100k,
            pnl100k: (pnl100k >= 0 ? '+' : '') + '$' + pnl100k.toFixed(2),
            balance100k: '$' + balance100k.toFixed(2)
        });
    }
    
    const summary = {
        period: "Desde Lunes 2026-09-28 00:00 UTC hasta Hoy 2026-09-30 17:35 UTC",
        activePortfolio: [
            "Craig Percoco Daily Trades",
            "XAUUSD FOREX TRADING",
            "EXNESS GOLD TRADER",
            "GOLD PRO SIGNAL",
            "Attaullah Trading Zone",
            "BPR Institutional Sniper"
        ],
        excludedChannels: [
            "META TRADER 5 OFFICIALL (Causante de 8 SL seguidos)",
            "MARCO TRADING HUB (Causante de 6 SL seguidos con SL de 176 pips)"
        ],
        totalTrades: allTrades.length,
        wins: totalWins,
        losses: totalLosses,
        winRate: (totalWins / (totalWins + totalLosses) * 100).toFixed(1) + '%',
        totalNetPips: totalNetPips.toFixed(1),
        account5k: {
            initialBalance: "$5,000.00",
            currentSimulatedBalance: '$' + balance5k.toFixed(2),
            netProfitUSD: (balance5k >= 5000 ? '+' : '') + '$' + (balance5k - 5000).toFixed(2),
            roiPct: (((balance5k - 5000) / 5000) * 100).toFixed(2) + '%'
        },
        account100k: {
            initialBalance: "$100,000.00",
            currentSimulatedBalance: '$' + balance100k.toFixed(2),
            netProfitUSD: (balance100k >= 100000 ? '+' : '') + '$' + (balance100k - 100000).toFixed(2),
            roiPct: (((balance100k - 100000) / 100000) * 100).toFixed(2) + '%'
        },
        trades: tradeLog
    };
    
    fs.writeFileSync(path.join(__dirname, 'simulation_current_config_results.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log('Simulation complete! Summary:');
    console.log(JSON.stringify({
        account5k: summary.account5k,
        account100k: summary.account100k,
        winRate: summary.winRate,
        totalNetPips: summary.totalNetPips,
        totalTrades: summary.totalTrades
    }, null, 2));
}

main().catch(console.error);
