const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function loadCandlesM3() {
    console.log('📂 Cargando velas reales M3 desde Febrero 2026...');
    const csvPath = path.join(__dirname, '../../XAUUSD_M3_202511201233_202609291057.csv');
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
    const candles = [];
    let isHeader = true;

    for await (const line of rl) {
        if (isHeader) { isHeader = false; continue; }
        const p = line.split('\t');
        if (p.length < 6) continue;

        // Cargar desde mediados de enero para inicializar la EMA 100 antes de Febrero 1
        if (p[0] < '2026.01.15') continue;

        const [y, m, d] = p[0].split('.').map(Number);
        const [h, min, s] = p[1].split(':').map(Number);
        const ts = Date.UTC(y, m - 1, d, h - 2, min, s);
        const spreadPoints = p.length >= 9 ? parseFloat(p[8]) : 50.0;

        candles.push({
            ts,
            dateStr: p[0] + ' ' + p[1],
            dateDay: p[0],
            open: parseFloat(p[2]),
            high: parseFloat(p[3]),
            low: parseFloat(p[4]),
            close: parseFloat(p[5]),
            spreadPips: spreadPoints / 10.0,
            spreadPrice: spreadPoints / 100.0
        });
    }

    // Agregar datos de fin de Septiembre desde market_snapshots
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
                        dateDay: s.utcDate ? s.utcDate.substring(0, 10).replace(/-/g, '.') : '',
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
    console.log(`✅ ${candles.length.toLocaleString()} velas M3 cargadas. Rango: ${candles[0].dateStr} a ${candles[candles.length - 1].dateStr}.\n`);
    return candles;
}

function runBPRSimulation(candles) {
    // Parámetros probados de BPR M3
    const slPips = 14.0;
    const tp1Pips = 30.0;
    const tp2Pips = 60.0;
    const autoBePips = 20.0;
    const minFvgGap = 0.20;
    const minOverlap = 0.15;
    const minRange = 0.25;

    // Calcular EMA 100
    const k = 2 / 101;
    let ema = candles[0].close;
    for (let i = 0; i < candles.length; i++) {
        ema = candles[i].close * k + ema * (1 - k);
        candles[i].ema100 = ema;
    }

    const feb1Ts = Date.UTC(2026, 1, 1, 0, 0, 0); // 2026-02-01 00:00 UTC
    let bprZones = [];
    const trades = [];

    for (let i = 4; i < candles.length - 80; i++) {
        const c0 = candles[i];
        const c1 = candles[i - 1];
        const c3 = candles[i - 3];

        // FVG Detection
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

        if (c0.ts < feb1Ts) continue;

        // Filtro de horario anti-rollover (22:55 a 00:10 UTC)
        const d = new Date(c0.ts);
        const h = d.getUTCHours();
        const m = d.getUTCMinutes();
        if (h === 23 || (h === 0 && m < 15)) continue;

        const candleRange = c0.high - c0.low;
        if (candleRange < minRange) continue;

        for (const bpr of bprZones) {
            if (bpr.tested || (i - bpr.createdIdx > 20)) continue;

            if (bpr.type === 'BULLISH') {
                if (c0.low <= bpr.top && c0.low >= bpr.bottom - 0.5) {
                    const lowerWick = Math.min(c0.open, c0.close) - c0.low;
                    if ((lowerWick / candleRange) >= 0.25 && c0.close > c0.ema100) {
                        bpr.tested = true;
                        // BUY entra en Ask
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
                            if (f.high >= entry + (autoBePips / 10.0)) beActive = true;
                            if (f.high >= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && f.high >= tp2) {
                                outcome = 'TP2_FULL_WIN';
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
                        trades.push({ date: c0.dateStr, month: c0.dateStr.substring(0, 7), type: 'BUY', entry, sl, outcome, pips });
                        break;
                    }
                }
            } else if (bpr.type === 'BEARISH') {
                if (c0.high >= bpr.bottom && c0.high <= bpr.top + 0.5) {
                    const upperWick = c0.high - Math.max(c0.open, c0.close);
                    if ((upperWick / candleRange) >= 0.25 && c0.close < c0.ema100) {
                        bpr.tested = true;
                        // SELL entra en Bid
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

                            if (curAsk <= entry - (autoBePips / 10.0)) beActive = true;
                            if (curAsk <= tp1) { tp1Hit = true; beActive = true; }
                            if (tp1Hit && curAsk <= tp2) {
                                outcome = 'TP2_FULL_WIN';
                                pips = (tp1Pips + tp2Pips) / 2;
                                break;
                            }
                            const curSl = (tp1Hit || beActive) ? entry - 0.20 : sl;
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
                        trades.push({ date: c0.dateStr, month: c0.dateStr.substring(0, 7), type: 'SELL', entry, sl, outcome, pips });
                        break;
                    }
                }
            }
        }
        if (bprZones.length > 50) bprZones.splice(0, 10);
    }

    return trades;
}

async function main() {
    const candles = await loadCandlesM3();
    const trades = runBPRSimulation(candles);

    console.log(`========================================================================================`);
    console.log(`🚀 RESULTADOS DEL BACKTEST: CUENTA DE $100 USD (1 FEBRERO 2026 A HOY)`);
    console.log(`========================================================================================\n`);

    // 1. Simulación A: Micro-Lote Fijo Conservador (0.01 lotes fijos sin interés compuesto)
    let balanceFixed = 100.0;
    let peakFixed = 100.0;
    let maxDdFixed = 0;

    // 2. Simulación B: Interés Compuesto Dinámico (1.5% de riesgo por trade, escalando lotes)
    let balanceCompound = 100.0;
    let peakCompound = 100.0;
    let maxDdCompound = 0;

    const monthlyBreakdown = {};

    let wins = 0;
    let losses = 0;
    let bes = 0;
    let totalPips = 0;

    for (const t of trades) {
        const m = t.month;
        if (!monthlyBreakdown[m]) {
            monthlyBreakdown[m] = {
                trades: 0,
                wins: 0,
                losses: 0,
                bes: 0,
                pips: 0,
                pnlFixed: 0,
                pnlCompound: 0,
                endBalanceFixed: 0,
                endBalanceCompound: 0
            };
        }

        // PnL Lote Fijo (0.01 lotes = $0.10 por pip)
        const pnlFixed = t.pips * 0.01 * 10.0; // t.pips * 0.10 USD
        balanceFixed += pnlFixed;
        if (balanceFixed > peakFixed) peakFixed = balanceFixed;
        const ddFixed = ((peakFixed - balanceFixed) / peakFixed) * 100;
        if (ddFixed > maxDdFixed) maxDdFixed = ddFixed;

        // PnL Interés Compuesto (1.5% de riesgo sobre el balance actual)
        // Lote = (Balance * 0.015) / (14 pips * 10) = (Balance * 0.015) / 140
        let lotCompound = Math.max(0.01, Math.floor(((balanceCompound * 0.015) / 140.0) * 100) / 100);
        // Límite de apalancamiento conservador (máximo 1 lote por cada $5,000)
        const maxLotCap = Math.max(0.01, Math.floor((balanceCompound / 5000.0) * 100) / 100);
        lotCompound = Math.min(lotCompound, Math.max(0.01, maxLotCap));

        const pnlCompound = t.pips * lotCompound * 10.0;
        balanceCompound += pnlCompound;
        if (balanceCompound > peakCompound) peakCompound = balanceCompound;
        const ddCompound = ((peakCompound - balanceCompound) / peakCompound) * 100;
        if (ddCompound > maxDdCompound) maxDdCompound = ddCompound;

        if (t.pips > 2.0) wins++;
        else if (t.pips < 0) losses++;
        else bes++;
        totalPips += t.pips;

        monthlyBreakdown[m].trades++;
        if (t.pips > 2.0) monthlyBreakdown[m].wins++;
        else if (t.pips < 0) monthlyBreakdown[m].losses++;
        else monthlyBreakdown[m].bes++;
        monthlyBreakdown[m].pips += t.pips;
        monthlyBreakdown[m].pnlFixed += pnlFixed;
        monthlyBreakdown[m].pnlCompound += pnlCompound;
        monthlyBreakdown[m].endBalanceFixed = balanceFixed;
        monthlyBreakdown[m].endBalanceCompound = balanceCompound;
    }

    const tableMonths = Object.entries(monthlyBreakdown).map(([mes, d]) => ({
        mes,
        operaciones: d.trades,
        ganadas: d.wins,
        perdidas: d.losses,
        winRate: ((d.wins / (d.wins + d.losses)) * 100).toFixed(1) + '%',
        pipsNetos: (d.pips >= 0 ? '+' : '') + d.pips.toFixed(1) + ' p',
        saldoLoteFijo: '$' + d.endBalanceFixed.toFixed(2),
        saldoCompuesto: '$' + d.endBalanceCompound.toFixed(2)
    }));

    console.table(tableMonths);

    console.log('\n========================================================================================');
    console.log('🏆 RESUMEN GLOBAL AUDITADO (1 DE FEBRERO A 30 DE SEPTIEMBRE 2026)');
    console.log('========================================================================================');
    console.log(`Total Operaciones BPR: ${trades.length}`);
    console.log(`Ganadas: ${wins} | Perdidas: ${losses} | Break-Evens: ${bes}`);
    console.log(`Win Rate Global: ${((wins / (wins + losses)) * 100).toFixed(1)}%`);
    console.log(`Pips Netos Totales: ${totalPips >= 0 ? '+' : ''}${totalPips.toFixed(1)} pips`);
    console.log(`\n1️⃣ MODELO A: LOTE FIJO MÍNIMO (0.01 lotes fijos sin riesgo de quiebra)`);
    console.log(`   • Inversión Inicial: $100.00 USD`);
    console.log(`   • Balance Final:     $${balanceFixed.toFixed(2)} USD`);
    console.log(`   • Beneficio Neto:    +$${(balanceFixed - 100).toFixed(2)} USD`);
    console.log(`   • Retorno Total:     +${(((balanceFixed - 100) / 100) * 100).toFixed(1)}%`);
    console.log(`   • Max Drawdown:      ${maxDdFixed.toFixed(2)}%`);
    console.log(`\n2️⃣ MODELO B: INTERÉS COMPUESTO INSTITUCIONAL (Reinvirtiendo beneficios con 1.5% de riesgo)`);
    console.log(`   • Inversión Inicial: $100.00 USD`);
    console.log(`   • Balance Final:     $${balanceCompound.toFixed(2)} USD`);
    console.log(`   • Beneficio Neto:    +$${(balanceCompound - 100).toFixed(2)} USD`);
    console.log(`   • Retorno Total:     +${(((balanceCompound - 100) / 100) * 100).toFixed(1)}%`);
    console.log(`   • Max Drawdown:      ${maxDdCompound.toFixed(2)}%`);
}

main().catch(console.error);
