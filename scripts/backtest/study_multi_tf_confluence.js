const fs = require('fs');
const readline = require('readline');

async function multiTfStudy() {
  console.log('=== ESTUDIO CUANTITATIVO: CONFLUENCIA DE BPRs EN N-TIMEFRAMES ===');
  const csvPath = 'C:/telegram-mtproto/XAUUSD_M15_202001020600_202610011115.csv';
  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const m15Candles = [];
  let lineCount = 0;
  for await (const line of rl) {
    lineCount++;
    if (lineCount === 1) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;
    const dt = parts[0] + ' ' + parts[1];
    m15Candles.push({
      dt,
      o: parseFloat(parts[2]),
      h: parseFloat(parts[3]),
      l: parseFloat(parts[4]),
      c: parseFloat(parts[5]),
      time: new Date(dt.replace(/\./g, '-')).getTime()
    });
  }
  console.log('Velas M15 cargadas:', m15Candles.length);

  // Aggregate into M30, H1, H4
  function aggregate(src, factor) {
    const res = [];
    for (let i = 0; i < src.length; i += factor) {
      let o = src[i].o;
      let h = src[i].h;
      let l = src[i].l;
      let c = src[i].c;
      let dt = src[i].dt;
      let time = src[i].time;
      for (let j = 1; j < factor && (i + j) < src.length; j++) {
        h = Math.max(h, src[i + j].h);
        l = Math.min(l, src[i + j].l);
        c = src[i + j].c;
      }
      res.push({ dt, o, h, l, c, time });
    }
    return res;
  }

  const m30Candles = aggregate(m15Candles, 2);
  const h1Candles = aggregate(m15Candles, 4);
  const h4Candles = aggregate(m15Candles, 16);
  console.log('M30:', m30Candles.length, 'H1:', h1Candles.length, 'H4:', h4Candles.length);

  // Helper to extract BPRs from a series
  function getBprs(series, lookback = 10) {
    const list = [];
    let lastBear = -1, lastBull = -1;
    for (let i = 2; i < series.length; i++) {
      const isBear = (series[i - 2].l - series[i].h > 0);
      const isBull = (series[i].l - series[i - 2].h > 0);
      if (isBear) lastBear = i;
      if (isBull) lastBull = i;

      if (isBull && lastBear !== -1 && (i - lastBear) <= lookback) {
        const cLow = Math.max(series[lastBear].h, series[i - 2].h);
        const cHigh = Math.min(series[lastBear - 2].l, series[i].l);
        if (cHigh > cLow) {
          list.push({ high: cHigh, low: cLow, ce50: (cHigh + cLow)/2, time: series[i].time, idx: i, bull: true });
        }
      }
      if (isBear && lastBull !== -1 && (i - lastBull) <= lookback) {
        const cLow = Math.max(series[lastBull - 2].h, series[i].h);
        const cHigh = Math.min(series[lastBull].l, series[i - 2].l);
        if (cHigh > cLow) {
          list.push({ high: cHigh, low: cLow, ce50: (cHigh + cLow)/2, time: series[i].time, idx: i, bull: false });
        }
      }
    }
    return list;
  }

  console.log('Extrayendo BPRs...');
  const bprM15 = getBprs(m15Candles);
  const bprM30 = getBprs(m30Candles);
  const bprH1  = getBprs(h1Candles);
  const bprH4  = getBprs(h4Candles);
  console.log('BPRs encontrados -> M15:', bprM15.length, 'M30:', bprM30.length, 'H1:', bprH1.length, 'H4:', bprH4.length);

  // Test statistical edge by Confluence Count (1, 2, 3, 4)
  const stats = {
    1: { total: 0, hitLimit: 0, r1: 0, r1_5: 0, r2: 0, r3: 0, r5: 0, slFirst: 0 },
    2: { total: 0, hitLimit: 0, r1: 0, r1_5: 0, r2: 0, r3: 0, r5: 0, slFirst: 0 },
    3: { total: 0, hitLimit: 0, r1: 0, r1_5: 0, r2: 0, r3: 0, r5: 0, slFirst: 0 },
    4: { total: 0, hitLimit: 0, r1: 0, r1_5: 0, r2: 0, r3: 0, r5: 0, slFirst: 0 }
  };

  function overlaps(b1, b2) {
    return Math.max(b1.low, b2.low) < Math.min(b1.high, b2.high);
  }

  for (let k = 0; k < bprM15.length; k++) {
    const b = bprM15[k];
    const m15Idx = b.idx;
    if (m15Idx >= m15Candles.length - 100) continue;

    // Confluence check
    let conf = 1; // M15 itself
    const m30Active = bprM30.filter(x => x.time <= b.time && (b.time - x.time) <= 48 * 3600 * 1000 && overlaps(b, x));
    if (m30Active.length > 0) conf++;
    const h1Active = bprH1.filter(x => x.time <= b.time && (b.time - x.time) <= 72 * 3600 * 1000 && overlaps(b, x));
    if (h1Active.length > 0) conf++;
    const h4Active = bprH4.filter(x => x.time <= b.time && (b.time - x.time) <= 120 * 3600 * 1000 && overlaps(b, x));
    if (h4Active.length > 0) conf++;

    if (conf > 4) conf = 4;
    const bucket = stats[conf];
    bucket.total++;

    const ce50 = b.ce50;
    const buffer = 1.0;
    const isBull = b.bull;
    const sl = isBull ? (b.low - buffer) : (b.high + buffer);
    const rDist = Math.abs(ce50 - sl);
    if (rDist < 0.5) continue;

    let filled = false;
    let maxR = 0;
    let slHit = false;

    for (let f = m15Idx + 1; f < Math.min(m15Idx + 50, m15Candles.length); f++) {
      const c = m15Candles[f];
      if (!filled) {
        if (isBull && c.l <= ce50) filled = true;
        else if (!isBull && c.h >= ce50) filled = true;
      }
      if (filled) {
        if (isBull) {
          if (c.l <= sl) { slHit = true; break; }
          const r = (c.h - ce50) / rDist;
          if (r > maxR) maxR = r;
        } else {
          if (c.h >= sl) { slHit = true; break; }
          const r = (ce50 - c.l) / rDist;
          if (r > maxR) maxR = r;
        }
      }
    }

    if (filled) {
      bucket.hitLimit++;
      if (maxR >= 1.0) bucket.r1++;
      if (maxR >= 1.5) bucket.r1_5++;
      if (maxR >= 2.0) bucket.r2++;
      if (maxR >= 3.0) bucket.r3++;
      if (maxR >= 5.0) bucket.r5++;
      if (slHit && maxR < 1.0) bucket.slFirst++;
    }
  }

  console.log('\n================ RESULTADOS POR CONFLUENCIA (2020-2026 XAUUSD) ===============');
  for (let c = 1; c <= 4; c++) {
    const s = stats[c];
    console.log(`\n--- CONFLUENCIA N = ${c} TF(s) ---`);
    console.log(`Total BPRs formados: ${s.total} | Entradas activadas (filled): ${s.hitLimit}`);
    if (s.hitLimit > 0) {
      console.log(`  Hit 1:1.0R : ${((s.r1/s.hitLimit)*100).toFixed(1)}% (${s.r1})`);
      console.log(`  Hit 1:1.5R : ${((s.r1_5/s.hitLimit)*100).toFixed(1)}% (${s.r1_5}) -> [NIVEL CLAVE BREAK-EVEN]`);
      console.log(`  Hit 1:2.0R : ${((s.r2/s.hitLimit)*100).toFixed(1)}% (${s.r2})`);
      console.log(`  Hit 1:3.0R : ${((s.r3/s.hitLimit)*100).toFixed(1)}% (${s.r3})`);
      console.log(`  Hit 1:5.0R : ${((s.r5/s.hitLimit)*100).toFixed(1)}% (${s.r5})`);
      console.log(`  SL Directo (<1R): ${((s.slFirst/s.hitLimit)*100).toFixed(1)}% (${s.slFirst})`);
    }
  }

  // PnL with Ratchet for N >= 1 and N >= 2
  for (const minConf of [1, 2]) {
    let balance = 1000;
    let peak = 1000;
    let maxDd = 0;
    let wins = 0, bes = 0, losses = 0, total = 0;

    for (let k = 0; k < bprM15.length; k++) {
      const b = bprM15[k];
      if (m15Candles[b.idx].dt < '2024.01.01') continue;

      let conf = 1;
      if (bprM30.some(x => x.time <= b.time && (b.time - x.time) <= 48*3600*1000 && overlaps(b, x))) conf++;
      if (bprH1.some(x => x.time <= b.time && (b.time - x.time) <= 72*3600*1000 && overlaps(b, x))) conf++;
      if (bprH4.some(x => x.time <= b.time && (b.time - x.time) <= 120*3600*1000 && overlaps(b, x))) conf++;

      if (conf < minConf) continue;

      const ce50 = b.ce50;
      const buffer = 1.0;
      const isBull = b.bull;
      const sl = isBull ? (b.low - buffer) : (b.high + buffer);
      const rDist = Math.abs(ce50 - sl);
      if (rDist < 0.5) continue;

      let filled = false;
      let maxR = 0;
      let pnlR = -1.0;

      for (let f = b.idx + 1; f < Math.min(b.idx + 60, m15Candles.length); f++) {
        const c = m15Candles[f];
        if (!filled) {
          if (isBull && c.l <= ce50) filled = true;
          else if (!isBull && c.h >= ce50) filled = true;
        }
        if (filled) {
          const curR = isBull ? (c.h - ce50)/rDist : (ce50 - c.l)/rDist;
          if (curR > maxR) maxR = curR;

          let currentSLR = -1.0;
          if (maxR >= 5.0) currentSLR = 2.5;
          else if (maxR >= 3.0) currentSLR = 1.0;
          else if (maxR >= 1.5) currentSLR = 0.1;

          const isSlHit = isBull ? (c.l <= (ce50 + currentSLR * rDist)) : (c.h >= (ce50 - currentSLR * rDist));
          if (isSlHit) {
            pnlR = currentSLR;
            break;
          }
          if (maxR >= 8.0) {
            pnlR = 8.0;
            break;
          }
        }
      }

      if (filled) {
        total++;
        const pnlUSD = pnlR * 5;
        balance += pnlUSD;
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDd) maxDd = dd;

        if (pnlR > 0.5) wins++;
        else if (pnlR >= 0) bes++;
        else losses++;
      }
    }

    console.log(`\n================ SIMULACION RATCHET PROFIT LOCK (Min Confluencia = ${minConf}) [2024-2026] ================`);
    console.log(`Balance Final: $${balance.toFixed(2)} | Max Drawdown: ${maxDd.toFixed(1)}%`);
    console.log(`Trades: ${total} | Wins: ${wins} | BEs: ${bes} | Losses: ${losses}`);
    console.log(`Tasa de Acierto (Win): ${((wins/total)*100).toFixed(1)}% | Tasa Blindada (Win + BE): ${(((wins+bes)/total)*100).toFixed(1)}%`);
  }
}

multiTfStudy();

