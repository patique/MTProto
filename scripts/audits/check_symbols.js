const https = require('https');

function testSymbol(sym) {
  return new Promise((resolve) => {
    https.get(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=5`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve({ sym, ok: Array.isArray(j) && j.length > 0 });
        } catch {
          resolve({ sym, ok: false });
        }
      });
    }).on('error', () => resolve({ sym, ok: false }));
  });
}

async function main() {
  const syms = ['PAXGUSDT', 'EURUSDT', 'GBPUSDT', 'BTCUSDT', 'ETHUSDT'];
  for (const s of syms) {
    const res = await testSymbol(s);
    console.log(`${s}: ${res.ok ? 'AVAILABLE' : 'NOT FOUND'}`);
  }
}

main();
