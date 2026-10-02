const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function testSpreadImpact() {
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
            spreadPips: spreadPoints / 10.0, // In Gold, 10 points = 1 pip ($0.10)
            spreadPrice: spreadPoints / 100.0 // In Gold, price difference = points * 0.01
        });
    }

    const testCandles = candles.slice(-50000);
    console.log(`Analyzing spread impact on ${testCandles.length} candles with REAL broker spread data...`);
    console.log(`Average spread: ${(testCandles.reduce((s, c) => s + c.spreadPips, 0) / testCandles.length).toFixed(2)} pips\n`);

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

    const slTestConfigs = [
        { slPips: 11.0, tp1Pips: 22.0, tp2Pips: 44.0, autoBe: 12.0 },
        { slPips: 15.0, tp1Pips: 30.0, tp2Pips: 60.0, autoBe: 18.0 },
        { slPips: 20.0, tp1Pips: 35.0, tp2Pips: 70.0, autoBe: 22.0 },
        { slPips: 25.0, tp1Pips: 40.0, tp2Pips: 80.0, autoBe: 25.0 },
        { slPips: 30.0, tp1Pips: 50.0, tp2Pips: 100.0, autoBe: 30.0 }
    ];

    const results = [];

    for (const cfg of slTestConfigs) {
        // Run with ZERO spread (Idealized) vs REAL BROKER SPREAD
        const ideal = runSimulation(testCandles, ema100Arr, ema1500Arr, cfg, false);
        const real = runSimulation(testCandles, ema100Arr, ema1500Arr, cfg, true);

        results.push({
            slDistance: `${cfg.slPips} pips ($${(cfg.slPips/10).toFixed(2)})`,
            idealWR: ideal.winRate,
            realWR: real.winRate,
            wrDrop: (parseFloat(ideal.winRate) - parseFloat(real.winRate)).toFixed(1) + '%',
            idealPF: ideal.profitFactor,
            realPF: real.profitFactor,
            realNetPips: real.netPips,
            spreadImpactPctOnSL: ((4.44 / cfg.slPips) * 100).toFixed(1) + '% del SL comido por el spread'
        });
    }

    console.table(results);
}

function runSimulation(candles, ema100Arr, ema1500Arr, cfg, applyRealSpread) {
    const { slPips, tp1Pips, tp2Pips, autoBe } = cfg;
    let bprZones = [];
    let trades = [];

    for (let i = 1500; i < candles.length - 100; i++) {
        const c0 = candles[i];
        const c1 = candles[i - 1];
        const c3 = candles[i - 3];

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
                if (candles[j].isBearishFVG) {
                    const bearTop = candles[j - 2]?.low || candles[j].high;
                    const bearBottom = candles[j].high;
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
                if (candles[j].isBullishFVG) {
                    const bullTop = candles[j].low;
                    const bullBottom = candles[j - 2]?.high || candles[j].low;
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

            const spreadPrice = applyRealSpread ? c0.spreadPrice : 0;

            if (bpr.type === 'BULLISH') {
                if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.4) {
                    const lowerWick = Math.min(c0.open, c0.close) - c0.low;
                    if ((lowerWick / candleRange) >= 0.35 && c0.close > ema100Arr[i] && c0.close > ema1500Arr[i]) {
                        bpr.tested = true;
                        // BUY enters at Ask (Bid + spread)
                        const entry = bpr.top + spreadPrice;
                        const sl = bpr.bottom - (slPips / 10.0);
                        const tp1 = entry + (tp1Pips / 10.0);
                        const tp2 = entry + (tp2Pips / 10.0);

                        let pips = 0;
                        let outcome = 'STOP_LOSS';
                        let tp1Hit = false;
                        let beActive = false;

                        for (let k = i + 1; k < Math.min(candles.length, i + 100); k++) {
                            const f = candles[k];
                            // BUY exits on Bid
                            if (f.high >= entry + (autoBe / 10.0)) beActive = true;
                            if (f.high >= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && f.high >= tp2) {
                                outcome = 'TP2_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry + 0.20 : sl;
                            if (f.low <= curSl) {
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
                        trades.push({ outcome, pips });
                        break;
                    }
                }
            } else if (bpr.type === 'BEARISH') {
                if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.4) {
                    const upperWick = c0.high - Math.max(c0.open, c0.close);
                    if ((upperWick / candleRange) >= 0.35 && c0.close < ema100Arr[i] && c0.close < ema1500Arr[i]) {
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

                        for (let k = i + 1; k < Math.min(candles.length, i + 100); k++) {
                            const f = candles[k];
                            const curSpreadPrice = applyRealSpread ? f.spreadPrice : 0;
                            // SELL TP triggers on Ask (Bid + spread)
                            const curAsk = f.low + curSpreadPrice;
                            const curAskHigh = f.high + curSpreadPrice;

                            if (curAsk <= entry - (autoBe / 10.0)) beActive = true;
                            if (curAsk <= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && curAsk <= tp2) {
                                outcome = 'TP2_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry - 0.20 : sl;
                            // SELL SL is hit by ASK HIGH!
                            if (curAskHigh >= curSl) {
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
                        trades.push({ outcome, pips });
                        break;
                    }
                }
            }
        }
        if (bprZones.length > 50) bprZones.splice(0, 10);
    }

    const wins = trades.filter(t => t.pips > 5.0).length;
    const losses = trades.filter(t => t.pips < 0).length;
    const netPips = trades.reduce((s, t) => s + t.pips, 0);
    const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) + '%' : '0.0%';

    const grossWon = trades.filter(t => t.pips > 0).reduce((s, t) => s + t.pips, 0);
    const grossLost = Math.abs(trades.filter(t => t.pips < 0).reduce((s, t) => s + t.pips, 0));
    const profitFactor = grossLost > 0 ? (grossWon / grossLost).toFixed(2) : '99.0';

    return { winRate, profitFactor, netPips: (netPips >= 0 ? '+' : '') + netPips.toFixed(1) };
}

testSpreadImpact().catch(console.error);
