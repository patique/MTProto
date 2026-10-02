/**
 * Diagnóstico Forense y Auditoría del Talón de Aquiles:
 * Análisis de los trades perdedores en H1 a lo largo de 1 Año (365 días)
 */

const https = require('https');
const { VolumeProfileStrategy } = require('../../core/algorithms/VolumeProfileStrategy');

function fetchKlines(interval, startTime, endTime, limit = 1000) {
  return new Promise((resolve, reject) => {
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          if (!Array.isArray(raw)) return resolve([]);
          const candles = raw.map(c => ({
            time: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
          }));
          resolve(candles);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function fetchFullYearData(interval, stepMs) {
  const now = Date.now();
  const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
  let allCandles = [];
  let currentStart = oneYearAgo;
  while (currentStart < now) {
    const chunk = await fetchKlines(interval, currentStart, now, 1000);
    if (!chunk || chunk.length === 0) break;
    allCandles.push(...chunk);
    currentStart = chunk[chunk.length - 1].time + stepMs;
    if (chunk.length < 1000) break;
    await new Promise(r => setTimeout(r, 50));
  }
  return allCandles;
}

function calculateEMA(candles, period = 100) {
  const ema = new Float64Array(candles.length);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, candles.length); i++) sum += candles[i].close;
  let prevEma = sum / Math.min(period, candles.length);
  ema[Math.min(period, candles.length) - 1] = prevEma;
  for (let i = period; i < candles.length; i++) {
    prevEma = (candles[i].close - prevEma) * k + prevEma;
    ema[i] = prevEma;
  }
  return ema;
}

async function runForensicAudit() {
  console.log('📡 Descargando datos H1 de 1 año...');
  const candles = await fetchFullYearData('1h', 60 * 60 * 1000);
  console.log(`✅ ${candles.length} velas cargadas.\n`);

  const strategy = new VolumeProfileStrategy({ binSize: 0.50, valueAreaRatio: 0.70 });
  const emaValues = calculateEMA(candles, 100);

  const days = {};
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dayStr = new Date(c.time).toISOString().split('T')[0];
    if (!days[dayStr]) days[dayStr] = [];
    days[dayStr].push({ ...c, index: i });
  }

  const lossCauses = {
    lateFillAfter14UTC: 0,      // Se activó tarde (tarde de NY)
    openDriveDirectBlow: 0,     // Londres rompió directo el POC sin frenar
    profilePshapeTrap: 0,       // PoC en extremo superior (P-Shape)
    profileBshapeTrap: 0,       // PoC en extremo inferior (b-Shape)
    mondayOrFridayNoise: 0,     // Ocurrió en lunes o viernes
    hugeAsiaRange: 0            // Asia fue demasiado grande (> $14)
  };

  const dayOfWeekLoss = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const dayOfWeekWin = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const fillHourStats = {};

  let totalLoss = 0;
  let totalWin = 0;

  for (const [dayStr, dayCandles] of Object.entries(days)) {
    const asianCandles = dayCandles.filter(c => {
      const h = new Date(c.time).getUTCHours();
      return h >= 0 && h < 7;
    });

    if (asianCandles.length < 3) continue;

    const profile = strategy.calculateProfile(asianCandles);
    if (!profile) continue;

    const { poc, vah, val } = profile;
    const valueAreaSpan = vah - val;
    if (valueAreaSpan < 4.0) continue;

    const londonOpenCandle = dayCandles.find(c => new Date(c.time).getUTCHours() === 7);
    if (!londonOpenCandle) continue;

    const currentEma = emaValues[londonOpenCandle.index];
    let orderType = null;
    let limitPrice = poc;
    let slPrice = 0;
    let tp1Price = 0;

    if (londonOpenCandle.close >= poc && londonOpenCandle.close >= currentEma) {
      orderType = 'BUY_LIMIT';
      slPrice = parseFloat((val - 1.50).toFixed(2));
      tp1Price = vah;
    } else if (londonOpenCandle.close < poc && londonOpenCandle.close < currentEma) {
      orderType = 'SELL_LIMIT';
      slPrice = parseFloat((vah + 1.50).toFixed(2));
      tp1Price = val;
    } else {
      continue;
    }

    const localStartIdx = dayCandles.findIndex(c => c.index === londonOpenCandle.index);
    if (localStartIdx < 0) continue;

    let filled = false;
    let fillIndex = -1;
    let fillHour = -1;

    for (let j = localStartIdx + 1; j < dayCandles.length; j++) {
      const c = dayCandles[j];
      const h = new Date(c.time).getUTCHours();
      if (h >= 21) break;

      if (orderType === 'BUY_LIMIT' && c.low <= limitPrice) {
        filled = true;
        fillIndex = c.index;
        fillHour = h;
        break;
      } else if (orderType === 'SELL_LIMIT' && c.high >= limitPrice) {
        filled = true;
        fillIndex = c.index;
        fillHour = h;
        break;
      }
    }

    if (!filled) continue;

    let isWin = false;
    for (let k = fillIndex + 1; k < Math.min(candles.length, fillIndex + 60); k++) {
      const c = candles[k];
      if (orderType === 'BUY_LIMIT') {
        if (c.high >= tp1Price) { isWin = true; break; }
        if (c.low <= slPrice) { isWin = false; break; }
      } else {
        if (c.low <= tp1Price) { isWin = true; break; }
        if (c.high >= slPrice) { isWin = false; break; }
      }
    }

    const dObj = new Date(candles[fillIndex].time);
    const dow = dObj.getUTCDay();

    if (isWin) {
      totalWin++;
      if (dayOfWeekWin[dow] !== undefined) dayOfWeekWin[dow]++;
    } else {
      totalLoss++;
      if (dayOfWeekLoss[dow] !== undefined) dayOfWeekLoss[dow]++;

      // Clasificar causas de la pérdida
      if (fillHour >= 14) lossCauses.lateFillAfter14UTC++;
      if (dow === 1 || dow === 5) lossCauses.mondayOrFridayNoise++;
      if (valueAreaSpan > 14.0) lossCauses.hugeAsiaRange++;

      // Forma del perfil
      const pocRelPos = (poc - val) / valueAreaSpan;
      if (orderType === 'BUY_LIMIT' && pocRelPos > 0.75) lossCauses.profilePshapeTrap++;
      if (orderType === 'SELL_LIMIT' && pocRelPos < 0.25) lossCauses.profileBshapeTrap++;
    }

    if (!fillHourStats[fillHour]) fillHourStats[fillHour] = { win: 0, loss: 0 };
    if (isWin) fillHourStats[fillHour].win++;
    else fillHourStats[fillHour].loss++;
  }

  console.log('========================================================================================================');
  console.log(`📊 TOTAL OPERACIONES AUDITADAS: ${totalWin} Ganadoras | ${totalLoss} Perdedoras`);
  console.log('========================================================================================================');
  console.log('\n🔎 1. DISTRIBUCIÓN POR DÍAS DE LA SEMANA:');
  const dowNames = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes' };
  for (let d = 1; d <= 5; d++) {
    const w = dayOfWeekWin[d];
    const l = dayOfWeekLoss[d];
    const tot = w + l;
    const wr = tot > 0 ? ((w / tot) * 100).toFixed(1) : 0;
    console.log(`   📅 ${dowNames[d].padEnd(10)}: ${w}W / ${l}L (Win Rate: ${wr}%) [Total: ${tot}]`);
  }

  console.log('\n⏰ 2. DISTRIBUCIÓN POR HORA DE ENTRADA (UTC):');
  for (const [h, s] of Object.entries(fillHourStats).sort((a,b) => parseInt(a[0]) - parseInt(b[0]))) {
    const tot = s.win + s.loss;
    const wr = tot > 0 ? ((s.win / tot) * 100).toFixed(1) : 0;
    console.log(`   🕐 Hora ${h}:00 UTC: ${s.win}W / ${s.loss}L (Win Rate: ${wr}%) [Total: ${tot}]`);
  }

  console.log('\n🎯 3. ANATOMÍA Y CAUSAS RAÍZ DEL TALÓN DE AQUILES:');
  console.log(`   🚨 Entradas tardías (después de las 14:00 UTC / sesión de NY tardía): ${lossCauses.lateFillAfter14UTC} pérdidas (${((lossCauses.lateFillAfter14UTC/totalLoss)*100).toFixed(1)}%)`);
  console.log(`   🚨 Ruido de Lunes o Viernes: ${lossCauses.mondayOrFridayNoise} pérdidas (${((lossCauses.mondayOrFridayNoise/totalLoss)*100).toFixed(1)}%)`);
  console.log(`   🚨 Trampa de Perfil P-Shape / b-Shape (PoC extremo): ${lossCauses.profilePshapeTrap + lossCauses.profileBshapeTrap} pérdidas`);
  console.log(`   🚨 Rango de Asia sobredimensionado (> $14 USD): ${lossCauses.hugeAsiaRange} pérdidas`);
  console.log('========================================================================================================\n');
}

runForensicAudit().catch(console.error);
