const fs = require('fs');
const readline = require('readline');
const path = require('path');

const CSV_MAP = {
  M2:  path.join(__dirname, '..', '..', 'NAS100_M2_202001010300_202610011028.csv'),
  M3:  path.join(__dirname, '..', '..', 'NAS100_M3_202001010300_202610011027.csv'),
  M5:  path.join(__dirname, '..', '..', 'NAS100_M5_202001010300_202610011025.csv'),
  M15: path.join(__dirname, '..', '..', 'NAS100_M15_202001010300_202610011015.csv')
};

const OUTPUT_CACHE = path.join(__dirname, '..', '..', 'bpr_nas100_candle_cache.json');

async function getLastCandles(filePath, count = 400) {
  const candles = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const [y, m, d] = parts[0].split('.').map(Number);
    const [h, min, s] = parts[1].split(':').map(Number);
    const timeMs = new Date(Date.UTC(y, m - 1, d, h, min, s)).getTime();

    const barId = `${y}-${m}-${d} ${h}:${String(min).padStart(2, '0')}`;

    candles.push({
      barId,
      time: timeMs,
      open: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      close: parseFloat(parts[5]),
      spreadPoints: parts.length >= 9 ? (parseFloat(parts[8]) / 100.0) : 1.0,
      volume: 480
    });

    if (candles.length > count * 2) {
      candles.splice(0, count);
    }
  }

  return candles.slice(-count);
}

async function run() {
  console.log('🌱 Sembrando caché de velas para BPR NAS100 (M2, M3, M5, M15)...');
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
