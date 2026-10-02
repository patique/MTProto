const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function loadCandlesM1() {
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
        candles.push({
            ts: Date.UTC(y, m - 1, d, h - 2, min, s),
            dateStr: p[0] + ' ' + p[1],
            open: parseFloat(p[2]),
            high: parseFloat(p[3]),
            low: parseFloat(p[4]),
            close: parseFloat(p[5]),
            volume: p.length >= 7 ? parseFloat(p[6]) : 100,
            spreadPips: p.length >= 9 ? parseFloat(p[8]) / 10.0 : 4.0
        });
    }
    return candles;
}

function calculateEMA(candles, period) {
    const k = 2 / (period + 1);
    let ema = candles[0].close;
    const res = [];
    for (let i = 0; i < candles.length; i++) {
        ema = candles[i].close * k + ema * (1 - k);
        res.push(ema);
    }
    return res;
}

function runM1Experiment(candles, options) {
    const {
        name,
        slPips = 8.0,
        tp1Pips = 20.0,
        tp2Pips = 40.0,
        autoBe = 15.0,
        minFvgGap = 0.15,
        minOverlap = 0.10,
        minCandleRange = 0.18,
        minRejectionWickRatio = 0.25,
        useHtfEmaM15 = false,
        useSessionFilter = false, // Only London & NY (07:00 - 17:00 UTC)
        useVolumeFilter = false
    } = options;

    const ema100M1 = calculateEMA(candles, 100);
    // HTF M15 EMA on M1 candles is equivalent to 15 * 100 = 1500 periods on M1!
    const emaHtf = useHtfEmaM15 ? calculateEMA(candles, 1500) : null;

    let trades = [];
    let bprZones = [];

    // Pre-calculate 20-period moving average of tick volume
    const volSMA = [];
    let sumV = 0;
    for (let i = 0; i < candles.length; i++) {
        sumV += candles[i].volume;
        if (i >= 20) sumV -= candles[i - 20].volume;
        volSMA.push(i >= 20 ? sumV / 20 : candles[i].volume);
    }

    for (let i = 1500; i < candles.length - 100; i++) {
        const c0 = candles[i];
        const c1 = candles[i - 1];
        const c3 = candles[i - 3];

        // 1. Session Filter (Skip Asian chop / night rollover, keep prime London + NY 07:00 - 17:30 UTC)
        const d = new Date(c0.ts);
        const h = d.getUTCHours();
        const m = d.getUTCMinutes();
        if (h === 23 || (h === 0 && m < 15)) continue;

        if (useSessionFilter) {
            if (h < 7 || h >= 18) continue;
        }

        // FVG detection
        const isBearishFVG = (c3.low - c1.high) >= minFvgGap;
        const isBullishFVG = (c1.low - c3.high) >= minFvgGap;
        if (isBearishFVG) c1.isBearishFVG = true;
        if (isBullishFVG) c1.isBullishFVG = true;

        // BPR Overlap search (last 10 candles)
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
        if (candleRange < minCandleRange) continue;

        if (useVolumeFilter && c0.volume < volSMA[i] * 1.25) continue;

        for (const bpr of bprZones) {
            if (bpr.tested || (i - bpr.createdIdx > 20)) continue;

            // BULLISH RETEST
            if (bpr.type === 'BULLISH') {
                if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.4) {
                    const lowerWick = Math.min(c0.open, c0.close) - c0.low;
                    const wickRatio = lowerWick / candleRange;
                    if (wickRatio >= minRejectionWickRatio && c0.close > ema100M1[i]) {
                        // Check HTF M15 EMA alignment
                        if (useHtfEmaM15 && c0.close < emaHtf[i]) continue;

                        bpr.tested = true;
                        const entry = bpr.top;
                        const sl = bpr.bottom - (slPips / 10.0);
                        const tp1 = entry + (tp1Pips / 10.0);
                        const tp2 = entry + (tp2Pips / 10.0);

                        let pips = 0;
                        let outcome = 'STOP_LOSS';
                        let tp1Hit = false;
                        let beActive = false;

                        for (let k = i + 1; k < Math.min(candles.length, i + 100); k++) {
                            const f = candles[k];
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
                        trades.push({ type: 'BUY', outcome, pips, date: c0.dateStr });
                        break;
                    }
                }
            } else if (bpr.type === 'BEARISH') {
                if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.4) {
                    const upperWick = c0.high - Math.max(c0.open, c0.close);
                    const wickRatio = upperWick / candleRange;
                    if (wickRatio >= minRejectionWickRatio && c0.close < ema100M1[i]) {
                        if (useHtfEmaM15 && c0.close > emaHtf[i]) continue;

                        bpr.tested = true;
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
                            if (f.low <= entry - (autoBe / 10.0)) beActive = true;
                            if (f.low <= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && f.low <= tp2) {
                                outcome = 'TP2_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry - 0.20 : sl;
                            if (f.high >= curSl) {
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
                        trades.push({ type: 'SELL', outcome, pips, date: c0.dateStr });
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
    const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';

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
        } else if (t.pips > 5.0) {
            curLoss = 0;
        }
    }

    return {
        variant: name,
        trades: trades.length,
        wins,
        losses,
        bes,
        winRate: `${winRate}%`,
        netPips: (netPips >= 0 ? '+' : '') + netPips.toFixed(1),
        profitFactor,
        maxConsLoss
    };
}

async function main() {
    console.log('Loading 60,000 M1 candles for experimental audit...');
    const allCandles = await loadCandlesM1();
    const candles = allCandles.slice(-60000);
    console.log(`Candles range: ${candles[0].dateStr} to ${candles[candles.length - 1].dateStr}\n`);

    const experiments = [
        {
            name: '1. M1 Base (Sin optimizaciones)',
            slPips: 8.0, tp1Pips: 20.0, tp2Pips: 40.0, autoBe: 15.0,
            minFvgGap: 0.15, minOverlap: 0.10, minCandleRange: 0.18, minRejectionWickRatio: 0.25
        },
        {
            name: '2. M1 + Filtro HTF M15 (Alineación con Macro-Tendencia)',
            slPips: 8.0, tp1Pips: 20.0, tp2Pips: 40.0, autoBe: 15.0,
            minFvgGap: 0.15, minOverlap: 0.10, minCandleRange: 0.18, minRejectionWickRatio: 0.25,
            useHtfEmaM15: true
        },
        {
            name: '3. M1 + Filtro Sesiones Prime (Solo Londres & NY 07:00-18:00)',
            slPips: 8.0, tp1Pips: 20.0, tp2Pips: 40.0, autoBe: 15.0,
            minFvgGap: 0.15, minOverlap: 0.10, minCandleRange: 0.18, minRejectionWickRatio: 0.25,
            useSessionFilter: true
        },
        {
            name: '4. M1 + Mecha Fuerte >=35% + Rango >=0.25 (Rechazo Institucional)',
            slPips: 8.0, tp1Pips: 20.0, tp2Pips: 40.0, autoBe: 15.0,
            minFvgGap: 0.18, minOverlap: 0.12, minCandleRange: 0.25, minRejectionWickRatio: 0.35
        },
        {
            name: '5. M1 + SL Ampliado a 11p (Anti-Spread Trap) + Auto-BE 12p',
            slPips: 11.0, tp1Pips: 22.0, tp2Pips: 44.0, autoBe: 12.0,
            minFvgGap: 0.15, minOverlap: 0.10, minCandleRange: 0.18, minRejectionWickRatio: 0.25
        },
        {
            name: '6. M1 SNIPER PRO (HTF M15 + Sesión Londres/NY + Mecha 35% + SL 11p)',
            slPips: 11.0, tp1Pips: 22.0, tp2Pips: 44.0, autoBe: 12.0,
            minFvgGap: 0.18, minOverlap: 0.12, minCandleRange: 0.22, minRejectionWickRatio: 0.35,
            useHtfEmaM15: true,
            useSessionFilter: true
        }
    ];

    const results = [];
    for (const exp of experiments) {
        process.stdout.write(`Running: ${exp.name}... `);
        const res = runM1Experiment(candles, exp);
        results.push(res);
        console.log(`Done! WR: ${res.winRate} | PF: ${res.profitFactor} | Net: ${res.netPips}`);
    }

    console.log('\n========================================================================================');
    console.log('🔬 AUDITORÍA EXPERIMENTAL: CÓMO OPTIMIZAR M1 CON VENTAJA ESTADÍSTICA DEMOSTRADA');
    console.log('========================================================================================');
    console.table(results);
}

main().catch(console.error);
