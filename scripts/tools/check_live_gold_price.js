const http = require('http');
const https = require('https');

function getBinancePrice() {
  return new Promise((resolve) => {
    https.get('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(parseFloat(j.price));
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

function getMT5BridgeStatus() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:3000/api/analytics', (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function main() {
  const binancePrice = await getBinancePrice();
  console.log(`Live Binance PAXG/XAU Price: ${binancePrice}`);
  const bridgeData = await getMT5BridgeStatus();
  console.log('Bridge Status:', bridgeData ? 'CONNECTED' : 'NOT RESPONDING');
}

main();
