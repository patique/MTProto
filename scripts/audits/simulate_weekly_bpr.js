const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function loadWeekData() {
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
        
        // Monday 28 Sep 00:00 UTC is ts >= 1790553600000
        // We include 500 prior candles for warmup of EMA 100
        if (ts >= 1790553600000 - (500 * 60000)) {
            const spreadPoints = p.length >= 9 ? parseFloat(p[8]) : 50.0;
            candles.push({
                ts,
                dateStr: p[0] + ' ' + p[1],
                open: parseFloat(p[2]),
                high: parseFloat(p[3]),
                low: parseFloat(p[4]),
                close: parseFloat(p[5]),
                spreadPips: spreadPoints / 10.0,
                spreadPrice: spreadPoints / 100.0
            });
        }
    }
    
    // Add Wednesday data from market snapshots and BPR trades
    const snapsPath = path.join(__dirname, '../../market_snapshots.json');
    if (fs.existsSync(snapsPath)) {
        try {
            const snaps = JSON.parse(fs.readFileSync(snapsPath, 'utf8'));
            for (const s of snaps) {
                if (s.timestamp > candles[candles.length - 1].ts) {
                    const price = s.marketSnapshot?.price || s.order?.entry || 4175.0;
                    const high = Math.max(price, s.candleAnatomyM5?.high || price);
                    const low = Math.min(price, s.candleAnatomyM5?.low || price);
                    candles.push({
                        ts: s.timestamp,
                        dateStr: s.utcDate ? s.utcDate.substring(0, 16).replace('T', ' ') : '',
                        open: price,
                        high,
                        low,
                        close: price,
                        spreadPips: 5.0,
                        spreadPrice: 0.50
                    });
                }
            }
        } catch(e) {}
    }
    
    candles.sort((a, b) => a.ts - b.ts);
    console.log(`Loaded ${candles.length} candles for this week (from ${candles[0].dateStr} to ${candles[candles.length - 1].dateStr}).`);
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
                spreadPips: c.spreadPips,
                spreadPrice: c.spreadPrice
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

function simulateBPRTimeframe(candles, m15Candles, cfg) {
    const { tfName, minFvgGap, minOverlap, slPips, tp1Pips, tp2Pips, autoBe, minRange, minWickRatio, useSessionFilter, useHtfEma } = cfg;
    
    // EMA 100
    const k = 2 / 101;
    let ema = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
        ema = candles[i].close * k + ema * (1 - k);
        candles[i].ema100 = ema;
    }
    
    // M15 EMA if needed
    if (useHtfEma && m15Candles) {
        let ema15 = m15Candles[0].close;
        for (let i = 0; i < m15Candles.length; i++) {
            ema15 = m15Candles[i].close * k + ema15 * (1 - k);
            m15Candles[i].ema100 = ema15;
        }
    }
    
    const mondayTs = 1790553600000; // Monday 28 Sep 00:00 UTC
    let bprZones = [];
    let trades = [];
    
    for (let i = 4; i < candles.length - 20; i++) {
        const c0 = candles[i];
        const c1 = candles[i - 1];
        const c3 = candles[i - 3];
        
        // FVG
        const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
        const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
        if (isBearishFVG) c1.isBearishFVG = true;
        if (isBullishFVG) c1.isBullishFVG = true;
        
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
                        bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, createdIdx: i, tested: false });
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
                        bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, createdIdx: i, tested: false });
                        break;
                    }
                }
            }
        }
        
        // Filter only trades after Monday 00:00 UTC
        if (c0.ts < mondayTs) continue;
        
        // Session filter
        const d = new Date(c0.ts);
        const h = d.getUTCHours();
        const m = d.getUTCMinutes();
        if (h === 23 || (h === 0 && m < 15)) continue;
        if (useSessionFilter && (h < 7 || h >= 18)) continue;
        
        const candleRange = c0.high - c0.low;
        if (candleRange < minRange) continue;
        const wickMin = minWickRatio || 0.25;
        
        // HTF EMA check
        let htfEmaVal = null;
        if (useHtfEma && m15Candles) {
            const m15Match = m15Candles.filter(m => m.ts <= c0.ts);
            if (m15Match.length > 0) htfEmaVal = m15Match[m15Match.length - 1].ema100;
        }
        
        for (const bpr of bprZones) {
            if (bpr.tested || (i - bpr.createdIdx > 20)) continue;
            
            if (bpr.type === 'BULLISH') {
                if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.5) {
                    const lowerWick = Math.min(c0.open, c0.close) - c0.low;
                    if ((lowerWick / candleRange) >= wickMin && c0.close > c0.ema100) {
                        if (htfEmaVal && c0.close < htfEmaVal) continue;
                        
                        bpr.tested = true;
                        // BUY enters at Ask (Bid + spread)
                        const entry = bpr.top + (c0.spreadPrice || 0.50);
                        const sl = bpr.bottom - (slPips / 10.0);
                        const tp1 = entry + (tp1Pips / 10.0);
                        const tp2 = entry + (tp2Pips / 10.0);
                        
                        let pips = 0;
                        let outcome = 'STOP_LOSS';
                        let tp1Hit = false;
                        let beActive = false;
                        
                        for (let k = i + 1; k < Math.min(candles.length, i + 80); k++) {
                            const f = candles[k];
                            if (f.high >= entry + (autoBe / 10.0)) beActive = true;
                            if (f.high >= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && f.high >= tp2) {
                                outcome = 'TP2_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry + 0.10 : sl;
                            if (f.low <= curSl) {
                                if (tp1Hit) {
                                    outcome = 'TP1_THEN_BE';
                                    pips = (tp1Pips + 1.0) / 2;
                                } else if (beActive) {
                                    outcome = 'BREAK_EVEN';
                                    pips = 1.0;
                                } else {
                                    outcome = 'STOP_LOSS';
                                    pips = (sl - entry) * 10;
                                }
                                break;
                            }
                        }
                        trades.push({ tf: tfName, type: 'BUY', date: c0.dateStr, pips, outcome, slPips });
                        break;
                    }
                }
            } else if (bpr.type === 'BEARISH') {
                if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.5) {
                    const upperWick = c0.high - Math.max(c0.open, c0.close);
                    if ((upperWick / candleRange) >= wickMin && c0.close < c0.ema100) {
                        if (htfEmaVal && c0.close > htfEmaVal) continue;
                        
                        bpr.tested = true;
                        // SELL enters at Bid
                        const entry = bpr.bottom;
                        const sl = bpr.top + (slPips / 10.0);
                        const tp1 = entry - (tp1Pips / 10.0);
                        const tp2 = entry - (tp2Pips / 10.0);
                        
                        let pips = 0;
                        let outcome = 'STOP_LOSS';
                        let tp1Hit = false;
                        let beActive = false;
                        
                        for (let k = i + 1; k < Math.min(candles.length, i + 80); k++) {
                            const f = candles[k];
                            const curAsk = f.low + (f.spreadPrice || 0.50);
                            const curAskHigh = f.high + (f.spreadPrice || 0.50);
                            
                            if (curAsk <= entry - (autoBe / 10.0)) beActive = true;
                            if (curAsk <= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && curAsk <= tp2) {
                                outcome = 'TP2_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry - 0.10 : sl;
                            if (curAskHigh >= curSl) {
                                if (tp1Hit) {
                                    outcome = 'TP1_THEN_BE';
                                    pips = (tp1Pips + 1.0) / 2;
                                } else if (beActive) {
                                    outcome = 'BREAK_EVEN';
                                    pips = 1.0;
                                } else {
                                    outcome = 'STOP_LOSS';
                                    pips = (entry - sl) * 10;
                                }
                                break;
                            }
                        }
                        trades.push({ tf: tfName, type: 'SELL', date: c0.dateStr, pips, outcome, slPips });
                        break;
                    }
                }
            }
        }
        if (bprZones.length > 40) bprZones.splice(0, 10);
    }
    
    return trades;
}

async function main() {
    const m1Candles = await loadWeekData();
    const m2Candles = aggregateCandles(m1Candles, 2);
    const m3Candles = aggregateCandles(m1Candles, 3);
    const m5Candles = aggregateCandles(m1Candles, 5);
    const m15Candles = aggregateCandles(m1Candles, 15);
    
    const configs = [
        { tfName: 'M1',  minutes: 1,  minFvgGap: 0.18, minOverlap: 0.12, slPips: 16.0, tp1Pips: 10.0, tp2Pips: 12.0,  autoBe: 8.0,  minRange: 0.22, minWickRatio: 0.35, useSessionFilter: true, useHtfEma: true },
        { tfName: 'M2',  minutes: 2,  minFvgGap: 0.18, minOverlap: 0.12, slPips: 10.0, tp1Pips: 25.0, tp2Pips: 50.0,  autoBe: 18.0, minRange: 0.22, minWickRatio: 0.25 },
        { tfName: 'M3',  minutes: 3,  minFvgGap: 0.20, minOverlap: 0.15, slPips: 12.0, tp1Pips: 30.0, tp2Pips: 60.0,  autoBe: 20.0, minRange: 0.25, minWickRatio: 0.25 },
        { tfName: 'M5',  minutes: 5,  minFvgGap: 0.30, minOverlap: 0.20, slPips: 15.0, tp1Pips: 40.0, tp2Pips: 80.0,  autoBe: 25.0, minRange: 0.35, minWickRatio: 0.25 },
        { tfName: 'M15', minutes: 15, minFvgGap: 0.50, minOverlap: 0.35, slPips: 25.0, tp1Pips: 60.0, tp2Pips: 120.0, autoBe: 40.0, minRange: 0.60, minWickRatio: 0.25 }
    ];
    
    const allTradesByTf = {};
    const tableSummary = [];
    
    let totalCombinedPips = 0;
    let totalCombinedWins = 0;
    let totalCombinedLosses = 0;
    let totalCombinedBes = 0;
    let totalCombinedTrades = 0;
    let totalUSD5k = 0;
    let totalUSD100k = 0;
    
    for (const cfg of configs) {
        let candlesForTf = m1Candles;
        if (cfg.minutes === 2) candlesForTf = m2Candles;
        if (cfg.minutes === 3) candlesForTf = m3Candles;
        if (cfg.minutes === 5) candlesForTf = m5Candles;
        if (cfg.minutes === 15) candlesForTf = m15Candles;
        
        const trades = simulateBPRTimeframe(candlesForTf, m15Candles, cfg);
        allTradesByTf[cfg.tfName] = trades;
        
        const wins = trades.filter(t => t.pips > 2.0).length;
        const losses = trades.filter(t => t.pips < 0).length;
        const bes = trades.filter(t => t.pips >= 0 && t.pips <= 2.0).length;
        const netPips = trades.reduce((s, t) => s + t.pips, 0);
        const wr = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) + '%' : '0.0%';
        
        // PnL on 5k account (0.10 lots cap)
        // PnL = pips * 0.10 * 10 USD = pips * 1 USD
        const pnl5k = netPips * 1.0;
        
        // PnL on 100k account (1.97 lots cap)
        // PnL = pips * 1.97 * 10 USD = pips * 19.7 USD
        const pnl100k = netPips * 19.7;
        
        totalCombinedPips += netPips;
        totalCombinedWins += wins;
        totalCombinedLosses += losses;
        totalCombinedBes += bes;
        totalCombinedTrades += trades.length;
        totalUSD5k += pnl5k;
        totalUSD100k += pnl100k;
        
        tableSummary.push({
            temporalidad: cfg.tfName,
            operaciones: trades.length,
            ganadas: wins,
            perdidas: losses,
            breakEven: bes,
            winRate: wr,
            pipsNetos: (netPips >= 0 ? '+' : '') + netPips.toFixed(1) + ' p',
            pnlCuenta5k: (pnl5k >= 0 ? '+' : '') + '$' + pnl5k.toFixed(2),
            pnlCuenta100k: (pnl100k >= 0 ? '+' : '') + '$' + pnl100k.toFixed(2)
        });
    }
    
    console.log('\n========================================================================================');
    console.log('🏛️ RESUMEN ESTADÍSTICO SEMANAL BPR MULTI-TF (LUNES 28 A MIÉRCOLES 30 SEPTIEMBRE)');
    console.log('========================================================================================');
    console.table(tableSummary);
    
    console.log('\n--- RENDIMIENTO CONSOLIDADO SEMANAL DE LAS 5 TEMPORALIDADES BPR ---');
    console.log(`Total Operaciones Ejecutadas: ${totalCombinedTrades}`);
    console.log(`Ganadas: ${totalCombinedWins} | Perdidas: ${totalCombinedLosses} | Break-Evens: ${totalCombinedBes}`);
    console.log(`Win Rate Global: ${((totalCombinedWins / (totalCombinedWins + totalCombinedLosses)) * 100).toFixed(1)}%`);
    console.log(`Pips Netos Acumulados: ${totalCombinedPips >= 0 ? '+' : ''}${totalCombinedPips.toFixed(1)} pips`);
    console.log(`\n💰 Cuenta 5k (The5ers):  +$${totalUSD5k.toFixed(2)} USD (+${((totalUSD5k / 5000) * 100).toFixed(2)}% ROI semanal)`);
    console.log(`💰 Cuenta 100k (FTMO):   +$${totalUSD100k.toFixed(2)} USD (+${((totalUSD100k / 100000) * 100).toFixed(2)}% ROI semanal)`);
}

main().catch(console.error);
