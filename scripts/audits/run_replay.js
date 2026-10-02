const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function testSignals() {
    const csvPath = path.join(__dirname, '../../XAUUSD_M1_202606171851_202609291057.csv');
    const csvStream = fs.createReadStream(csvPath);
    const rl = readline.createInterface({ input: csvStream, crlfDelay: Infinity });
    const candles = [];
    let header = true;
    for await (const line of rl) {
        if (header) { header = false; continue; }
        const p = line.split('\t');
        if (!p[0].startsWith('2026.09.28') && !p[0].startsWith('2026.09.29')) continue;
        const [y, m, d] = p[0].split('.').map(Number);
        const [h, min, s] = p[1].split(':').map(Number);
        // Broker is UTC+2
        const ts = Date.UTC(y, m - 1, d, h - 2, min, s);
        candles.push({
            ts,
            dateStr: p[0] + ' ' + p[1],
            open: parseFloat(p[2]),
            high: parseFloat(p[3]),
            low: parseFloat(p[4]),
            close: parseFloat(p[5])
        });
    }
    console.log('Candles loaded for 28-29 Sep:', candles.length, 'First:', candles[0].dateStr, 'Last:', candles[candles.length-1].dateStr);
    
    // Signals from Monday and Tuesday morning
    const signals = [
        // 28 Sep (Monday)
        { ch: 'Attaullah Trading Zone', act: 'SELL', dt: '2026-09-28T04:11:30Z', entry: 4117, sl: 4123, tp1: 4111, tp2: 4108 },
        { ch: 'Attaullah Trading Zone', act: 'BUY',  dt: '2026-09-28T09:55:45Z', entry: 4150, sl: 4143, tp1: 4157, tp2: 4163 },
        { ch: 'Attaullah Trading Zone', act: 'BUY',  dt: '2026-09-28T11:04:11Z', entry: 4140, sl: 4133, tp1: 4150, tp2: 4155 },
        { ch: 'EXNESS GOLD TRADER',     act: 'BUY',  dt: '2026-09-28T03:02:31Z', entry: 4218, sl: 4210, tp1: 4223, tp2: 4228 },
        { ch: 'EXNESS GOLD TRADER',     act: 'BUY',  dt: '2026-09-28T11:25:50Z', entry: 4140, sl: 4132, tp1: 4145, tp2: 4150 },
        { ch: 'GOLD PRO SIGNAL',        act: 'BUY',  dt: '2026-09-28T03:48:18Z', entry: 4211, sl: 4200, tp1: 4214, tp2: 4218 },
        { ch: 'GOLD PRO SIGNAL',        act: 'BUY',  dt: '2026-09-28T07:25:54Z', entry: 4186, sl: 4176, tp1: 4189, tp2: 4192 },
        { ch: 'GOLD PRO SIGNAL',        act: 'BUY',  dt: '2026-09-28T09:57:36Z', entry: 4153, sl: 4143, tp1: 4156, tp2: 4159 },
        { ch: 'XAUUSD FOREX TRADING',   act: 'SELL', dt: '2026-09-28T13:21:17Z', entry: 4155, sl: 4175, tp1: 4150, tp2: 4145 },
        { ch: 'XAUUSD FOREX TRADING',   act: 'BUY',  dt: '2026-09-28T16:54:22Z', entry: 4115, sl: 4105, tp1: 4120, tp2: 4125 },
        // 29 Sep morning (Tuesday up to 10:57)
        { ch: 'Attaullah Trading Zone', act: 'SELL', dt: '2026-09-29T02:50:04Z', entry: 4126, sl: 4131, tp1: 4119, tp2: 4115 },
        { ch: 'Attaullah Trading Zone', act: 'SELL', dt: '2026-09-29T04:34:52Z', entry: 4140, sl: 4145, tp1: 4132, tp2: 4128 },
        { ch: 'EXNESS GOLD TRADER',     act: 'BUY',  dt: '2026-09-29T05:04:15Z', entry: 4135, sl: 4127, tp1: 4140, tp2: 4145 },
        { ch: 'GOLD PRO SIGNAL',        act: 'SELL', dt: '2026-09-29T04:04:43Z', entry: 4135, sl: 4146, tp1: 4132, tp2: 4129 },
        { ch: 'XAUUSD FOREX TRADING',   act: 'SELL', dt: '2026-09-29T05:08:32Z', entry: 4140, sl: 4155, tp1: 4135, tp2: 4130 }
    ];
    
    const results = [];
    
    for (const s of signals) {
        const sigTs = new Date(s.dt).getTime();
        const post = candles.filter(c => c.ts >= sigTs);
        if (!post.length) {
            console.log(s.ch, s.act, s.dt, 'No candles found');
            continue;
        }
        let tp1Hit = false;
        let beActive = false;
        let finalResult = 'PENDING';
        let pips = 0;
        
        for (const c of post) {
            if (s.act === 'BUY') {
                if (c.high >= s.entry + 2.5) beActive = true;
                if (c.high >= s.tp1) tp1Hit = true;
                if (tp1Hit && c.high >= s.tp2) {
                    finalResult = 'TP2_FULL_WIN';
                    pips = ((s.tp1 - s.entry) + (s.tp2 - s.entry)) / 2 * 10;
                    break;
                }
                const curSl = (tp1Hit || beActive) ? s.entry + 0.2 : s.sl;
                if (c.low <= curSl) {
                    if (tp1Hit) {
                        finalResult = 'TP1_THEN_BE';
                        pips = (((s.tp1 - s.entry) * 10) + 2) / 2;
                    } else if (beActive) {
                        finalResult = 'BREAK_EVEN';
                        pips = 2;
                    } else {
                        finalResult = 'STOP_LOSS';
                        pips = (s.sl - s.entry) * 10;
                    }
                    break;
                }
            } else { // SELL
                if (c.low <= s.entry - 2.5) beActive = true;
                if (c.low <= s.tp1) tp1Hit = true;
                if (tp1Hit && c.low <= s.tp2) {
                    finalResult = 'TP2_FULL_WIN';
                    pips = ((s.entry - s.tp1) + (s.entry - s.tp2)) / 2 * 10;
                    break;
                }
                const curSl = (tp1Hit || beActive) ? s.entry - 0.2 : s.sl;
                if (c.high >= curSl) {
                    if (tp1Hit) {
                        finalResult = 'TP1_THEN_BE';
                        pips = (((s.entry - s.tp1) * 10) + 2) / 2;
                    } else if (beActive) {
                        finalResult = 'BREAK_EVEN';
                        pips = 2;
                    } else {
                        finalResult = 'STOP_LOSS';
                        pips = (s.entry - s.sl) * 10;
                    }
                    break;
                }
            }
        }
        
        results.push({
            date: s.dt.substring(0, 16).replace('T', ' '),
            channel: s.ch,
            action: s.act,
            entry: s.entry,
            sl: s.sl,
            result: finalResult,
            pips
        });
        
        console.log(`${s.dt.substring(5, 16)} | ${s.ch.padEnd(25)} | ${s.act} @ ${s.entry} -> ${finalResult.padEnd(14)} | Pips: ${pips > 0 ? '+' : ''}${pips.toFixed(1)}`);
    }
    
    return results;
}

testSignals().catch(console.error);
