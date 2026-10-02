const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function loadCandlesM1() {
    console.log('Loading M1 candles...');
    const csvPath = path.join(__dirname, '../../XAUUSD_M1_202606171851_202609291057.csv');
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
    const candles = [];
    let isHeader = true;
    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }
        const p = line.split('\t');
        if (p.length < 6) continue;
        const [y, m, d] = p[0].split('.').map(Number);
        const [h, min, s] = p[1].split(':').map(Number);
        const ts = Date.UTC(y, m - 1, d, h - 2, min, s);
        candles.push({
            ts,
            dateStr: p[0] + ' ' + p[1],
            open: parseFloat(p[2]),
            high: parseFloat(p[3]),
            low: parseFloat(p[4]),
            close: parseFloat(p[5]),
            spreadPips: p.length >= 9 ? parseFloat(p[8]) / 10.0 : 4.0
        });
    }
    console.log(`Loaded ${candles.length} M1 candles.`);
    return candles;
}

function aggregateCandles(m1Candles, tfMinutes) {
    if (tfMinutes === 1) return m1Candles;
    const agg = [];
    let cur = null;
    for (const c of m1Candles) {
        const d = new Date(c.ts);
        const m = d.getUTCMinutes();
        const startM = Math.floor(m / tfMinutes) * tfMinutes;
        const barId = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()} ${d.getUTCHours()}:${startM}`;
        if (!cur || cur.barId !== barId) {
            if (cur) agg.push(cur);
            cur = {
                barId,
                ts: c.ts,
                dateStr: c.dateStr,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                spreadPips: c.spreadPips
            };
        } else {
            if (c.high > cur.high) cur.high = c.high;
            if (c.low < cur.low) cur.low = c.low;
            cur.close = c.close;
        }
    }
    if (cur) agg.push(cur);
    return agg;
}

function simulateBPR(candles, config) {
    const { tfName, minFvgGap, minOverlap, slPips, tp1Pips, tp2Pips, autoBe, minRange } = config;
    
    // 1. Calculate EMA 100
    const k = 2 / (100 + 1);
    let ema = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
        ema = candles[i].close * k + ema * (1 - k);
        candles[i].ema100 = ema;
    }
    
    // 2. Scan BPR & simulate trades
    let trades = [];
    let bprZones = [];
    
    for (let i = 4; i < candles.length - 100; i++) {
        const c0 = candles[i];
        const c1 = candles[i - 1];
        const c2 = candles[i - 2];
        const c3 = candles[i - 3];
        
        // FVG detection
        const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
        const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
        if (isBearishFVG) c1.isBearishFVG = true;
        if (isBullishFVG) c1.isBullishFVG = true;
        
        // Check BPR Overlap
        if (isBullishFVG) {
            for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
                if (candles[j].isBearishFVG) {
                    const bearTop = candles[j - 2]?.low || candles[j].high;
                    const bearBottom = candles[j].high;
                    const bullTop = c1.low;
                    const bullBottom = c3.high;
                    const cLow = Math.max(bearBottom, bullBottom);
                    const cHigh = Math.min(bearTop, bullTop);
                    if (cHigh > cLow + minOverlap) {
                        bprZones.push({
                            type: 'BULLISH',
                            top: cHigh,
                            bottom: cLow,
                            createdIdx: i,
                            tested: false
                        });
                        break;
                    }
                }
            }
        }
        
        if (isBearishFVG) {
            for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
                if (candles[j].isBullishFVG) {
                    const bullTop = candles[j].low;
                    const bullBottom = candles[j - 2]?.high || candles[j].low;
                    const bearTop = c3.low;
                    const bearBottom = c1.high;
                    const cLow = Math.max(bullBottom, bearBottom);
                    const cHigh = Math.min(bullTop, bearTop);
                    if (cHigh > cLow + minOverlap) {
                        bprZones.push({
                            type: 'BEARISH',
                            top: cHigh,
                            bottom: cLow,
                            createdIdx: i,
                            tested: false
                        });
                        break;
                    }
                }
            }
        }
        
        // Entry Evaluation
        const candleRange = c0.high - c0.low;
        if (candleRange < minRange) continue;
        
        // Time filter: skip 22:50 to 00:15 UTC (rollover)
        const d = new Date(c0.ts);
        const h = d.getUTCHours();
        const m = d.getUTCMinutes();
        if (h === 23 || (h === 0 && m < 15)) continue;
        
        for (const bpr of bprZones) {
            if (bpr.tested || (i - bpr.createdIdx > 25)) continue;
            
            // Bullish Retest
            if (bpr.type === 'BULLISH') {
                if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.5) {
                    const lowerWick = Math.min(c0.open, c0.close) - c0.low;
                    if (lowerWick / candleRange >= 0.25 && c0.close > c0.ema100) {
                        bpr.tested = true;
                        const entry = bpr.top;
                        const sl = bpr.bottom - (slPips / 10.0);
                        const tp1 = entry + (tp1Pips / 10.0);
                        const tp2 = entry + (tp2Pips / 10.0);
                        
                        // Replay forward
                        let pips = 0;
                        let outcome = 'STOP_LOSS';
                        let tp1Hit = false;
                        let beActive = false;
                        
                        for (let k = i + 1; k < Math.min(candles.length, i + 120); k++) {
                            const fCandle = candles[k];
                            if (fCandle.high >= entry + (autoBe / 10.0)) beActive = true;
                            if (fCandle.high >= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && fCandle.high >= tp2) {
                                outcome = 'TP2_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry + 0.20 : sl;
                            if (fCandle.low <= curSl) {
                                if (tp1Hit) {
                                    outcome = 'TP1_THEN_BE';
                                    pips = (tp1Pips + 2.0) / 2;
                                } else if (beActive) {
                                    outcome = 'BREAK_EVEN';
                                    pips = 2.0;
                                } else {
                                    outcome = 'STOP_LOSS';
                                    pips = (sl - entry) * 10;
                                }
                                break;
                            }
                        }
                        trades.push({ type: 'BUY', entry, sl, outcome, pips, date: c0.dateStr });
                        break;
                    }
                }
            } else if (bpr.type === 'BEARISH') {
                if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.5) {
                    const upperWick = c0.high - Math.max(c0.open, c0.close);
                    if (upperWick / candleRange >= 0.25 && c0.close < c0.ema100) {
                        bpr.tested = true;
                        const entry = bpr.bottom;
                        const sl = bpr.top + (slPips / 10.0);
                        const tp1 = entry - (tp1Pips / 10.0);
                        const tp2 = entry - (tp2Pips / 10.0);
                        
                        let pips = 0;
                        let outcome = 'STOP_LOSS';
                        let tp1Hit = false;
                        let beActive = false;
                        
                        for (let k = i + 1; k < Math.min(candles.length, i + 120); k++) {
                            const fCandle = candles[k];
                            if (fCandle.low <= entry - (autoBe / 10.0)) beActive = true;
                            if (fCandle.low <= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && fCandle.low <= tp2) {
                                outcome = 'TP2_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry - 0.20 : sl;
                            if (fCandle.high >= curSl) {
                                if (tp1Hit) {
                                    outcome = 'TP1_THEN_BE';
                                    pips = (tp1Pips + 2.0) / 2;
                                } else if (beActive) {
                                    outcome = 'BREAK_EVEN';
                                    pips = 2.0;
                                } else {
                                    outcome = 'STOP_LOSS';
                                    pips = (entry - sl) * 10;
                                }
                                break;
                            }
                        }
                        trades.push({ type: 'SELL', entry, sl, outcome, pips, date: c0.dateStr });
                        break;
                    }
                }
            }
        }
        if (bprZones.length > 50) bprZones.splice(0, 10);
    }
    
    const wins = trades.filter(t => t.pips > 5.0).length;
    const bes = trades.filter(t => t.pips >= 0 && t.pips <= 5.0).length;
    const losses = trades.filter(t => t.pips < 0).length;
    const netPips = trades.reduce((s, t) => s + t.pips, 0);
    const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : 0;
    
    const grossWon = trades.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
    const grossLost = Math.abs(trades.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
    const profitFactor = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';
    
    return {
        tfName,
        totalTrades: trades.length,
        wins,
        losses,
        bes,
        winRate: `${winRate}%`,
        netPips: (netPips >= 0 ? '+' : '') + netPips.toFixed(1),
        profitFactor
    };
}

async function main() {
    const m1Candles = await loadCandlesM1();
    
    // Last ~60,000 M1 candles (~2.5 months of continuous broker data)
    const recentM1 = m1Candles.slice(-60000);
    console.log(`Auditing 60,000 M1 candles (from ${recentM1[0].dateStr} to ${recentM1[recentM1.length - 1].dateStr})...\n`);
    
    const configs = [
        { tfName: 'M1', minutes: 1, minFvgGap: 0.15, minOverlap: 0.10, slPips: 8.0,  tp1Pips: 20.0, tp2Pips: 40.0,  autoBe: 15.0, minRange: 0.18 },
        { tfName: 'M2', minutes: 2, minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0,  autoBe: 18.0, minRange: 0.22 },
        { tfName: 'M3', minutes: 3, minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0,  autoBe: 20.0, minRange: 0.25 },
        { tfName: 'M5', minutes: 5, minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0,  autoBe: 25.0, minRange: 0.35 },
        { tfName: 'M15', minutes: 15, minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60 }
    ];
    
    const results = [];
    for (const cfg of configs) {
        const agg = aggregateCandles(recentM1, cfg.minutes);
        const res = simulateBPR(agg, cfg);
        results.push(res);
    }
    
    console.log('========================================================================================');
    console.log('📊 COMPARATIVA RIGUROSA DE TEMPORALIDADES BPR SNIPER CON EMA 100 EN XAUUSD');
    console.log('========================================================================================');
    console.table(results);
}

main().catch(console.error);
