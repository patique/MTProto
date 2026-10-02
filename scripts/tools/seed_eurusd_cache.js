const fs = require('fs');
const readline = require('readline');
const path = require('path');

const CSV_MAP = {
  M2:  path.join(__dirname, '..', '..', 'EURUSD_M2_202001020600_202610011028.csv'),
  M3:  path.join(__dirname, '..', '..', 'EURUSD_M3_202001020600_202610011027.csv'),
  M5:  path.join(__dirname, '..', '..', 'EURUSD_M5_202001020600_202610011025.csv'),
  M15: path.join(__dirname, '..', '..', 'EURUSD_M15_202001020600_202610011015.csv')
};

const OUTPUT_CACHE = path.join(__dirname, '..', '..', 'bpr_eurusd_candle_cache.json');

async function getLastCandles(filePath, count = 400) {
  const candles = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split(/[\t,;]+/);
    if (parts.length < 6) continue;

    const dateStr = parts[0].trim();
    const timeStr = parts[1].trim();
    const open = parseFloat(parts[2]);
    const high = parseFloat(parts[3]);
    const low = parseFloat(parts[4]);
    const close = parseFloat(parts[5]);
    const spreadPips = parts.length >= 9 ? (parseFloat(parts[8]) / 10.0) : 0.4;

    let dt;
    if (dateStr.includes('.')) {
      const dp = dateStr.split('.');
      const tp = timeStr.split(':');
      dt = new Date(Date.UTC(parseInt(dp[0]), parseInt(dp[1]) - 1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1])));
    } else {
      dt = new Date(`${dateStr}T${timeStr}Z`);
    }

    const barId = `${dt.getUTCFullYear()}-${dt.getUTCMonth() + 1}-${dt.getUTCDate()} ${dt.getUTCHours()}:${String(dt.getUTCMinutes()).padStart(2, '0')}`;

    candles.push({
      barId,
      time: dt.getTime(),
      open,
      high,
      low,
      close,
      spreadPips,
      volume: 480
    });

    if (candles.length > count * 2) {
      candles.splice(0, count);
    }
  }

  return candles.slice(-count);
}

async function run() {
  console.log('🌱 Sembrando caché de velas para BPR EURUSD (M2, M3, M5, M15)...');
  const cache = {};

  for (const [tf, file] of Object.entries(CSV_MAP)) {
    if (fs.existsSync(file)) {
      const candles = await getLastCandles(file, 400);
      cache[tf] = candles;
      console.log(`   ✅ ${tf}: ${candles.length} velas sembradas (Última: ${candles[candles.length - 1]?.barId})`);
    } else {
      console.warn(`   ⚠️ Archivo no encontrado para ${tf}: ${file}`);
    }
  }

  fs.writeFileSync(OUTPUT_CACHE, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`📦 Caché guardado exitosamente en: ${OUTPUT_CACHE}`);
}

run().catch(console.error);
