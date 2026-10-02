const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function testNegativeRR() {
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
        const spreadPoints = p.length >= 9 ? parseFloat(p[8]) : 45.0;
        candles.push({
            ts: Date.UTC(y, m - 1, d, h - 2, min, s),
            open: parseFloat(p[2]),
            high: parseFloat(p[3]),
            low: parseFloat(p[4]),
            close: parseFloat(p[5]),
            spreadPips: spreadPoints / 10.0,
            spreadPrice: spreadPoints / 100.0
        });
    }

    const testCandles = candles.slice(-50000);
    console.log(`Testing Negative RR on M1 across ${testCandles.length} candles with REAL spread...`);

    // Precalculate EMA 100 on M1 and HTF (1500 periods)
    const k100 = 2 / 101;
    const k1500 = 2 / 1501;
    let ema100 = testCandles[0].close;
    let ema1500 = testCandles[0].close;
    const ema100Arr = [];
    const ema1500Arr = [];
    for (let i = 0; i < testCandles.length; i++) {
        ema100 = testCandles[i].close * k100 + ema100 * (1 - k100);
        ema1500 = testCandles[i].close * k1500 + ema1500 * (1 - k1500);
        ema100Arr.push(ema100);
        ema1500Arr.push(ema1500);
    }

    const configurations = [
        // Control: Positive RR (SL 11p, TP 22p)
        { name: 'Control (Positivo 1:2)', slPips: 11.0, tpPips: 22.0, autoBe: 12.0 },
        
        // Negative RR models: Wider SL to absorb spread, tighter TP to capture quick institutional bounce
        { name: 'Negativo 1.5:1 (SL 15p / TP 10p)', slPips: 15.0, tpPips: 10.0, autoBe: 8.0 },
        { name: 'Negativo 1.5:1 (SL 18p / TP 12p)', slPips: 18.0, tpPips: 12.0, autoBe: 9.0 },
        { name: 'Negativo 2:1   (SL 20p / TP 10p)', slPips: 20.0, tpPips: 10.0, autoBe: 8.0 },
        { name: 'Negativo 2.5:1 (SL 25p / TP 10p)', slPips: 25.0, tpPips: 10.0, autoBe: 8.0 },
        { name: 'Negativo 3:1   (SL 30p / TP 10p)', slPips: 30.0, tpPips: 10.0, autoBe: 8.0 },
        { name: 'Negativo 2:1 Puro (Sin Auto-BE)',  slPips: 20.0, tpPips: 10.0, autoBe: 999.0 },
        { name: 'Negativo 2.5:1 Puro (Sin Auto-BE)', slPips: 25.0, tpPips: 10.0, autoBe: 999.0 }
    ];

    const results = [];

    for (const cfg of configurations) {
        let bprZones = [];
        let trades = [];

        for (let i = 1500; i < testCandles.length - 100; i++) {
            const c0 = testCandles[i];
            const c1 = testCandles[i - 1];
            const c3 = testCandles[i - 3];

            const d = new Date(c0.ts);
            const h = d.getUTCHours();
            // Session filter: London & NY (07:00 - 18:00 UTC)
            if (h < 7 || h >= 18) continue;

            const isBearishFVG = (c3.low - c1.high) >= 0.18;
            const isBullishFVG = (c1.low - c3.high) >= 0.18;
            if (isBearishFVG) c1.isBearishFVG = true;
            if (isBullishFVG) c1.isBullishFVG = true;

            if (isBullishFVG) {
                for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
                    if (testCandles[j].isBearishFVG) {
                        const bearTop = testCandles[j - 2]?.low || testCandles[j].high;
                        const bearBottom = testCandles[j].high;
                        const bullTop = c1.low;
                        const bullBottom = c3.high;
                        const cLow = Math.max(bearBottom, bullBottom);
                        const cHigh = Math.min(bearTop, bullTop);
                        if (cHigh > cLow + 0.12) {
                            bprZones.push({ type: 'BULLISH', top: cHigh, bottom: cLow, createdIdx: i, tested: false });
                            break;
                        }
                    }
                }
            }

            if (isBearishFVG) {
                for (let j = i - 2; j >= Math.max(0, i - 12); j--) {
                    if (testCandles[j].isBullishFVG) {
                        const bullTop = testCandles[j].low;
                        const bullBottom = testCandles[j - 2]?.high || testCandles[j].low;
                        const bearTop = c3.low;
                        const bearBottom = c1.high;
                        const cLow = Math.max(bullBottom, bearBottom);
                        const cHigh = Math.min(bullTop, bearTop);
                        if (cHigh > cLow + 0.12) {
                            bprZones.push({ type: 'BEARISH', top: cHigh, bottom: cLow, createdIdx: i, tested: false });
                            break;
                        }
                    }
                }
            }

            const candleRange = c0.high - c0.low;
            if (candleRange < 0.22) continue;

            for (const bpr of bprZones) {
                if (bpr.tested || (i - bpr.createdIdx > 20)) continue;

                if (bpr.type === 'BULLISH') {
                    if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.4) {
                        const lowerWick = Math.min(c0.open, c0.close) - c0.low;
                        if ((lowerWick / candleRange) >= 0.35 && c0.close > ema100Arr[i] && c0.close > ema1500Arr[i]) {
                            bpr.tested = true;
                            // Real BUY execution at Ask
                            const entry = bpr.top + c0.spreadPrice;
                            const sl = bpr.bottom - (cfg.slPips / 10.0);
                            const tp = entry + (cfg.tpPips / 10.0);

                            let pips = 0;
                            let outcome = 'STOP_LOSS';
                            let beActive = false;

                            for (let k = i + 1; k < Math.min(testCandles.length, i + 100); k++) {
                                const f = testCandles[k];
                                if (f.high >= entry + (cfg.autoBe / 10.0)) beActive = true;
                                if (f.high >= tp) {
                                    outcome = 'WIN';
                                    pips = cfg.tpPips;
                                    break;
                                }
                                const curSl = beActive ? entry + 0.10 : sl;
                                if (f.low <= curSl) {
                                    if (beActive) {
                                        outcome = 'BREAK_EVEN';
                                        pips = 1.0;
                                    } else {
                                        outcome = 'STOP_LOSS';
                                        pips = (sl - entry) * 10;
                                    }
                                    break;
                                }
                            }
                            trades.push({ outcome, pips });
                            break;
                        }
                    }
                } else if (bpr.type === 'BEARISH') {
                    if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.4) {
                        const upperWick = c0.high - Math.max(c0.open, c0.close);
                        if ((upperWick / candleRange) >= 0.35 && c0.close < ema100Arr[i] && c0.close < ema1500Arr[i]) {
                            bpr.tested = true;
                            // Real SELL execution at Bid
                            const entry = bpr.bottom;
                            const sl = bpr.top + (cfg.slPips / 10.0);
                            const tp = entry - (cfg.tpPips / 10.0);

                            let pips = 0;
                            let outcome = 'STOP_LOSS';
                            let beActive = false;

                            for (let k = i + 1; k < Math.min(testCandles.length, i + 100); k++) {
                                const f = testCandles[k];
                                const curAsk = f.low + f.spreadPrice;
                                const curAskHigh = f.high + f.spreadPrice;

                                if (curAsk <= entry - (cfg.autoBe / 10.0)) beActive = true;
                                if (curAsk <= tp) {
                                    outcome = 'WIN';
                                    pips = cfg.tpPips;
                                    break;
                                }
                                const curSl = beActive ? entry - 0.10 : sl;
                                if (curAskHigh >= curSl) {
                                    if (beActive) {
                                        outcome = 'BREAK_EVEN';
                                        pips = 1.0;
                                    } else {
                                        outcome = 'STOP_LOSS';
                                        pips = (entry - sl) * 10;
                                    }
                                    break;
                                }
                            }
                            trades.push({ outcome, pips });
                            break;
                        }
                    }
                }
            }
            if (bprZones.length > 50) bprZones.splice(0, 10);
        }

        const wins = trades.filter(t => t.pips > 2.0).length;
        const losses = trades.filter(t => t.pips < 0).length;
        const bes = trades.filter(t => t.pips >= 0 && t.pips <= 2.0).length;
        const netPips = trades.reduce((s, t) => s + t.pips, 0);
        const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) + '%' : '0.0%';

        const grossWon = trades.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
        const grossLost = Math.abs(trades.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
        const profitFactor = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';

        // Calculate max consecutive losses
        let maxConsLoss = 0;
        let curLoss = 0;
        for (const t of trades) {
            if (t.pips < 0) {
                curLoss++;
                if (curLoss > maxConsLoss) maxConsLoss = curLoss;
            } else if (t.pips > 2.0) {
                curLoss = 0;
            }
        }

        results.push({
            modelo: cfg.name,
            trades: trades.length,
            wins,
            losses,
            bes,
            winRate,
            netPips: (netPips >= 0 ? '+' : '') + netPips.toFixed(1),
            profitFactor,
            maxConsLoss
        });
    }

    console.table(results);
}

testNegativeRR().catch(console.error);
