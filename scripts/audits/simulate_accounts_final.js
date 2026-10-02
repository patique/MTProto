const fs = require('fs');
const path = require('path');

// Complete list of chronological trades from Monday 2026-09-28 00:00 to Wednesday 2026-09-30 17:35
// for the CURRENT ACTIVE CONFIGURATION:
// - Attaullah Trading Zone
// - Craig Percoco Daily Trades
// - EXNESS GOLD TRADER
// - GOLD PRO SIGNAL
// - XAUUSD FOREX TRADING
// - BPR Strategy Multi-TF

const TRADES = [
    // --- LUNES 28 SEPTIEMBRE ---
    {
        date: '2026-09-28 03:02',
        channel: 'EXNESS GOLD TRADER',
        action: 'BUY',
        entry: 4218,
        sl: 4210,
        tp1: 4223,
        tp2: 4228,
        slPips: 80,
        result: 'STOP_LOSS',
        pips: -80.0,
        details: 'SL Directo en apertura de Asia'
    },
    {
        date: '2026-09-28 03:48',
        channel: 'GOLD PRO SIGNAL',
        action: 'BUY',
        entry: 4211,
        sl: 4200,
        tp1: 4214,
        tp2: 4218,
        slPips: 110,
        result: 'STOP_LOSS',
        pips: -110.0,
        details: 'SL Directo por retroceso'
    },
    {
        date: '2026-09-28 04:11',
        channel: 'Attaullah Trading Zone',
        action: 'SELL',
        entry: 4117,
        sl: 4123,
        tp1: 4111,
        tp2: 4108,
        slPips: 60,
        result: 'STOP_LOSS',
        pips: -60.0,
        details: 'SL Directo por rebote'
    },
    {
        date: '2026-09-28 07:25',
        channel: 'GOLD PRO SIGNAL',
        action: 'BUY',
        entry: 4186,
        sl: 4176,
        tp1: 4189,
        tp2: 4192,
        slPips: 100,
        result: 'STOP_LOSS',
        pips: -100.0,
        details: 'SL en sesión de Londres'
    },
    {
        date: '2026-09-28 09:55',
        channel: 'Attaullah Trading Zone',
        action: 'BUY',
        entry: 4150,
        sl: 4143,
        tp1: 4157,
        tp2: 4163,
        slPips: 70,
        result: 'STOP_LOSS',
        pips: -70.0,
        details: 'Barrido previo a expansión'
    },
    {
        date: '2026-09-28 09:57',
        channel: 'GOLD PRO SIGNAL',
        action: 'BUY',
        entry: 4153,
        sl: 4143,
        tp1: 4156,
        tp2: 4159,
        slPips: 100,
        result: 'STOP_LOSS',
        pips: -100.0,
        details: 'Barrido de liquidez'
    },
    {
        date: '2026-09-28 11:04',
        channel: 'Attaullah Trading Zone',
        action: 'BUY',
        entry: 4140,
        sl: 4133,
        tp1: 4150,
        tp2: 4155,
        slPips: 70,
        result: 'TP2_FULL_WIN',
        pips: 125.0,
        details: '50% TP1 (+100p) + 50% TP2 (+150p)'
    },
    {
        date: '2026-09-28 11:25',
        channel: 'EXNESS GOLD TRADER',
        action: 'BUY',
        entry: 4140,
        sl: 4132,
        tp1: 4145,
        tp2: 4150,
        slPips: 80,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: '50% TP1 (+50p) + 50% TP2 (+100p)'
    },
    {
        date: '2026-09-28 13:21',
        channel: 'XAUUSD FOREX TRADING',
        action: 'SELL',
        entry: 4155,
        sl: 4175,
        tp1: 4150,
        tp2: 4145,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: '50% TP1 (+50p) + 50% TP2 (+100p)'
    },
    {
        date: '2026-09-28 16:54',
        channel: 'XAUUSD FOREX TRADING',
        action: 'BUY',
        entry: 4115,
        sl: 4105,
        tp1: 4120,
        tp2: 4125,
        slPips: 100,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: '50% TP1 (+50p) + 50% TP2 (+100p)'
    },

    // --- MARTES 29 SEPTIEMBRE ---
    {
        date: '2026-09-29 02:50',
        channel: 'Attaullah Trading Zone',
        action: 'SELL',
        entry: 4126,
        sl: 4131,
        tp1: 4119,
        tp2: 4115,
        slPips: 50,
        result: 'STOP_LOSS',
        pips: -50.0,
        details: 'Retroceso menor'
    },
    {
        date: '2026-09-29 04:04',
        channel: 'GOLD PRO SIGNAL',
        action: 'SELL',
        entry: 4135,
        sl: 4146,
        tp1: 4132,
        tp2: 4129,
        slPips: 100,
        result: 'TP2_FULL_WIN',
        pips: 45.0,
        details: '50% TP1 (+30p) + 50% TP2 (+60p)'
    },
    {
        date: '2026-09-29 04:34',
        channel: 'Attaullah Trading Zone',
        action: 'SELL',
        entry: 4140,
        sl: 4145,
        tp1: 4132,
        tp2: 4128,
        slPips: 50,
        result: 'BREAK_EVEN',
        pips: 2.0,
        details: 'Auto-BE activado a +25p y cerrado a +2p'
    },
    {
        date: '2026-09-29 05:04',
        channel: 'EXNESS GOLD TRADER',
        action: 'BUY',
        entry: 4135,
        sl: 4127,
        tp1: 4140,
        tp2: 4145,
        slPips: 80,
        result: 'STOP_LOSS',
        pips: -80.0,
        details: 'SL Directo'
    },
    {
        date: '2026-09-29 05:08',
        channel: 'XAUUSD FOREX TRADING',
        action: 'SELL',
        entry: 4140,
        sl: 4155,
        tp1: 4135,
        tp2: 4130,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: '50% TP1 (+50p) + 50% TP2 (+100p)'
    },
    {
        date: '2026-09-29 11:17',
        channel: 'XAUUSD FOREX TRADING',
        action: 'SELL',
        entry: 4155,
        sl: 4165,
        tp1: 4145,
        tp2: 4135,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 138.0,
        details: 'Ejecutado y verificado en Shadow Trader'
    },
    {
        date: '2026-09-29 12:09',
        channel: 'Attaullah Trading Zone',
        action: 'BUY',
        entry: 4142,
        sl: 4136,
        tp1: 4150,
        tp2: 4155,
        slPips: 60,
        result: 'TP2_FULL_WIN',
        pips: 105.0,
        details: '50% TP1 (+80p) + 50% TP2 (+130p)'
    },
    {
        date: '2026-09-29 12:17',
        channel: 'GOLD PRO SIGNAL',
        action: 'SELL',
        entry: 4150,
        sl: 4161,
        tp1: 4147,
        tp2: 4144,
        slPips: 100,
        result: 'TP2_FULL_WIN',
        pips: 45.0,
        details: '50% TP1 (+30p) + 50% TP2 (+60p)'
    },
    {
        date: '2026-09-29 14:32',
        channel: 'EXNESS GOLD TRADER',
        action: 'BUY',
        entry: 4155,
        sl: 4147,
        tp1: 4160,
        tp2: 4165,
        slPips: 80,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: 'Rally vespertino Nueva York'
    },
    {
        date: '2026-09-29 15:54',
        channel: 'Craig Percoco Daily Trades',
        action: 'SELL',
        entry: 4150,
        sl: 4159,
        tp1: 4145,
        tp2: 4140,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: '50% TP1 (+50p) + 50% TP2 (+100p)'
    },
    {
        date: '2026-09-29 20:22',
        channel: 'GOLD PRO SIGNAL',
        action: 'SELL',
        entry: 4170,
        sl: 4180,
        tp1: 4167,
        tp2: 4164,
        slPips: 100,
        result: 'STOP_LOSS',
        pips: -100.0,
        details: 'Reversión alcista nocturna'
    },
    {
        date: '2026-09-29 20:54',
        channel: 'XAUUSD FOREX TRADING',
        action: 'BUY',
        entry: 4172,
        sl: 4163,
        tp1: 4178,
        tp2: 4185,
        slPips: 90,
        result: 'BREAK_EVEN',
        pips: 5.9,
        details: 'Cierre Shadow Auto-BE'
    },
    {
        date: '2026-09-29 22:36',
        channel: 'XAUUSD FOREX TRADING',
        action: 'BUY',
        entry: 4182,
        sl: 4173,
        tp1: 4188,
        tp2: 4195,
        slPips: 90,
        result: 'STOP_LOSS',
        pips: -83.2,
        details: 'SL Shadow nocturno'
    },

    // --- MIÉRCOLES 30 SEPTIEMBRE ---
    {
        date: '2026-09-30 00:24',
        channel: 'BPR Institutional Sniper',
        action: 'BUY',
        entry: 4182.14,
        sl: 4180.13,
        tp1: 4185.14,
        tp2: 4188.14,
        slPips: 20,
        result: 'BREAK_EVEN',
        pips: 2.0,
        details: 'Auto-BE ejecutado a +20p -> +2p asegurados'
    },
    {
        date: '2026-09-30 00:39',
        channel: 'BPR Institutional Sniper',
        action: 'SELL',
        entry: 4181.40,
        sl: 4183.28,
        tp1: 4178.40,
        tp2: 4175.40,
        slPips: 19,
        result: 'TP2_FULL_WIN',
        pips: 45.0,
        details: 'TP2 Sniper Directo'
    },
    {
        date: '2026-09-30 02:00',
        channel: 'XAUUSD FOREX TRADING',
        action: 'SELL',
        entry: 4188,
        sl: 4203,
        tp1: 4183,
        tp2: 4178,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 34.1,
        details: 'Verificado Shadow Trader'
    },
    {
        date: '2026-09-30 02:42',
        channel: 'BPR Institutional Sniper',
        action: 'BUY',
        entry: 4175.48,
        sl: 4173.22,
        tp1: 4178.48,
        tp2: 4181.48,
        slPips: 22,
        result: 'TP2_FULL_WIN',
        pips: 45.0,
        details: 'TP2 Sniper Directo'
    },
    {
        date: '2026-09-30 04:46',
        channel: 'Attaullah Trading Zone',
        action: 'BUY',
        entry: 4172,
        sl: 4166,
        tp1: 4180,
        tp2: 4184,
        slPips: 60,
        result: 'TP2_FULL_WIN',
        pips: 153.6,
        details: 'Verificado Shadow Trader'
    },
    {
        date: '2026-09-30 04:57',
        channel: 'GOLD PRO SIGNAL',
        action: 'SELL',
        entry: 4184,
        sl: 4194,
        tp1: 4181,
        tp2: 4178,
        slPips: 100,
        result: 'TP2_FULL_WIN',
        pips: 45.0,
        details: '50% TP1 (+30p) + 50% TP2 (+60p)'
    },
    {
        date: '2026-09-30 05:30',
        channel: 'BPR Institutional Sniper',
        action: 'SELL',
        entry: 4179.62,
        sl: 4182.43,
        tp1: 4175.62,
        tp2: 4171.62,
        slPips: 28,
        result: 'BREAK_EVEN',
        pips: 2.0,
        details: 'Auto-BE ejecutado a +25p -> +2p asegurados'
    },
    {
        date: '2026-09-30 06:16',
        channel: 'Attaullah Trading Zone',
        action: 'BUY',
        entry: 4168,
        sl: 4162,
        tp1: 4176,
        tp2: 4180,
        slPips: 60,
        result: 'TP2_FULL_WIN',
        pips: 204.0,
        details: 'Verificado Shadow Trader (+204p)'
    },
    {
        date: '2026-09-30 06:44',
        channel: 'XAUUSD FOREX TRADING',
        action: 'SELL',
        entry: 4185,
        sl: 4200,
        tp1: 4180,
        tp2: 4175,
        slPips: 90,
        result: 'BREAK_EVEN',
        pips: 13.6,
        details: 'Verificado Shadow Trader'
    },
    {
        date: '2026-09-30 07:28',
        channel: 'Craig Percoco Daily Trades',
        action: 'BUY',
        entry: 4170,
        sl: 4160,
        tp1: 4175,
        tp2: 4180,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 61.0,
        details: 'Verificado Shadow Trader (+61p)'
    },
    {
        date: '2026-09-30 10:31',
        channel: 'XAUUSD FOREX TRADING',
        action: 'SELL',
        entry: 4200,
        sl: 4215,
        tp1: 4195,
        tp2: 4190,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: '50% TP1 (+50p) + 50% TP2 (+100p)'
    },
    {
        date: '2026-09-30 13:23',
        channel: 'Craig Percoco Daily Trades',
        action: 'BUY',
        entry: 4176,
        sl: 4166,
        tp1: 4178,
        tp2: 4180,
        slPips: 90,
        result: 'TP2_FULL_WIN',
        pips: 30.0,
        details: '50% TP1 (+20p) + 50% TP2 (+40p)'
    },
    {
        date: '2026-09-30 14:36',
        channel: 'EXNESS GOLD TRADER',
        action: 'SELL',
        entry: 4217,
        sl: 4225,
        tp1: 4212,
        tp2: 4207,
        slPips: 80,
        result: 'TP2_FULL_WIN',
        pips: 75.0,
        details: '50% TP1 (+50p) + 50% TP2 (+100p)'
    }
];

function runAccountSimulation() {
    let balance5k = 5000.0;
    let balance100k = 100000.0;
    const riskPct = 0.0075; // 0.75% por operación

    let peak5k = balance5k;
    let maxDd5k = 0;
    let peak100k = balance100k;
    let maxDd100k = 0;

    let wins = 0;
    let losses = 0;
    let bes = 0;
    let totalPips = 0;

    const log = [];

    for (const t of TRADES) {
        // Riesgo monetario para cada cuenta
        const riskUSD5k = balance5k * riskPct;     // ~$37.50
        const riskUSD100k = balance100k * riskPct; // ~$750.00

        // Tamaño de lote dinámico basado en SL distance (en pips):
        // 1 lote estándar en XAUUSD = $10 / pip.
        // lot = riskUSD / (slPips * 10)
        let lot5k = Math.max(0.01, Math.min(0.10, Number((riskUSD5k / (t.slPips * 10)).toFixed(2))));
        let lot100k = Math.max(0.10, Math.min(2.00, Number((riskUSD100k / (t.slPips * 10)).toFixed(2))));

        // PnL monetario = pips * lot * 10 USD
        const pnlUSD5k = Number((t.pips * lot5k * 10).toFixed(2));
        const pnlUSD100k = Number((t.pips * lot100k * 10).toFixed(2));

        balance5k += pnlUSD5k;
        balance100k += pnlUSD100k;

        // Drawdown tracking
        if (balance5k > peak5k) peak5k = balance5k;
        const dd5k = ((peak5k - balance5k) / peak5k) * 100;
        if (dd5k > maxDd5k) maxDd5k = dd5k;

        if (balance100k > peak100k) peak100k = balance100k;
        const dd100k = ((peak100k - balance100k) / peak100k) * 100;
        if (dd100k > maxDd100k) maxDd100k = dd100k;

        if (t.pips > 5.0) wins++;
        else if (t.pips < 0) losses++;
        else bes++;
        totalPips += t.pips;

        log.push({
            date: t.date,
            channel: t.channel,
            action: t.action,
            entry: t.entry,
            result: t.result,
            details: t.details,
            pips: (t.pips >= 0 ? '+' : '') + t.pips.toFixed(1),
            lot5k,
            pnlUSD5k: (pnlUSD5k >= 0 ? '+' : '') + '$' + pnlUSD5k.toFixed(2),
            bal5k: '$' + balance5k.toFixed(2),
            lot100k,
            pnlUSD100k: (pnlUSD100k >= 0 ? '+' : '') + '$' + pnlUSD100k.toFixed(2),
            bal100k: '$' + balance100k.toFixed(2)
        });
    }

    const report = {
        totalTrades: TRADES.length,
        wins,
        losses,
        breakEvens: bes,
        winRatePercent: ((wins / (wins + losses)) * 100).toFixed(1) + '%',
        totalNetPips: (totalPips >= 0 ? '+' : '') + totalPips.toFixed(1),
        account5k: {
            initial: "$5,000.00",
            final: "$" + balance5k.toFixed(2),
            netProfitUSD: (balance5k >= 5000 ? '+' : '') + '$' + (balance5k - 5000).toFixed(2),
            roiPercent: (((balance5k - 5000) / 5000) * 100).toFixed(2) + '%',
            maxDrawdownPercent: maxDd5k.toFixed(2) + '%'
        },
        account100k: {
            initial: "$100,000.00",
            final: "$" + balance100k.toFixed(2),
            netProfitUSD: (balance100k >= 100000 ? '+' : '') + '$' + (balance100k - 100000).toFixed(2),
            roiPercent: (((balance100k - 100000) / 100000) * 100).toFixed(2) + '%',
            maxDrawdownPercent: maxDd100k.toFixed(2) + '%'
        },
        log
    };

    fs.writeFileSync(path.join(__dirname, 'simulation_official_report.json'), JSON.stringify(report, null, 2), 'utf8');
    return report;
}

const res = runAccountSimulation();
console.log('=== SIMULACIÓN EXACTA LUNES 00:00 A HOY CON CONFIGURACIÓN ACTUAL ===');
console.log('Total Operaciones:', res.totalTrades);
console.log('Ganadas:', res.wins, '| Perdidas:', res.losses, '| Break-Evens:', res.breakEvens);
console.log('Win Rate Efectivo:', res.winRatePercent);
console.log('Pips Netos Acumulados:', res.totalNetPips);
console.log('\n--- CUENTA $5,000 USD ---');
console.log('Balance Inicial:    ', res.account5k.initial);
console.log('Balance Final:      ', res.account5k.final);
console.log('Beneficio Neto:     ', res.account5k.netProfitUSD);
console.log('Rentabilidad (ROI): ', res.account5k.roiPercent);
console.log('Max Drawdown:       ', res.account5k.maxDrawdownPercent);
console.log('\n--- CUENTA $100,000 USD ---');
console.log('Balance Inicial:    ', res.account100k.initial);
console.log('Balance Final:      ', res.account100k.final);
console.log('Beneficio Neto:     ', res.account100k.netProfitUSD);
console.log('Rentabilidad (ROI): ', res.account100k.roiPercent);
console.log('Max Drawdown:       ', res.account100k.maxDrawdownPercent);
