const http = require('http');
const { processSignalForExecution } = require('./risk_engine');

const aliensMsg = `💎 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 𝐆𝐎𝐋𝐃 𝐒𝐈𝐆𝐍𝐀𝐋 💎\n\n🚨 𝐁𝐔𝐘 𝐗𝐀𝐔/𝐔𝐒𝐃 🚨\n\n📍 𝐄𝐍𝐓𝐑𝐘: 4330\n\n🎯 𝐓𝐏𝟏: 4334\n🎯 𝐓𝐏𝟐: 4338\n🎯 𝐓𝐏𝟑: 4343\n\n🛑 𝐒𝐋: 4326`;

function parseSignal(text) {
  if (!text) return null;
  text = text.normalize('NFKD');
  const upper = text.toUpperCase();

  const isSignal = (upper.includes('BUY') || upper.includes('SELL')) &&
                   (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS') || upper.includes('TAKE PROFIT') || upper.includes('TARGET'));

  if (!isSignal) return null;

  const actionMatch = upper.match(/(?:ORDER TYPE:\s*|TYPE:\s*)?(SELL NOW|BUY NOW|SELL|BUY)/i);
  const pairMatch = text.match(/(?:PAIR|PAR):\s*([A-Z0-9\/]+)/i) || text.match(/\b(XAU\/?USD|GOLD|EUR\/?USD|GBP\/?USD|BTC\/?USD|US30|NAS100)\b/i);
  
  let entryVal = null;
  const entryMatch = text.match(/(?:ENTRY PRICE|ENTRY|ENTRADA|PRICE):\s*([\d\.]+)/i) || 
                     text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?(?:[A-Z0-9\/]+\s+)?@?\s*([\d\.]+)/i);
  if (entryMatch) {
    entryVal = parseFloat(entryMatch[1]);
  }

  const slMatch = text.match(/(?:STOP LOSS|STOPLOSS|SL)[\s:\.]*([\d\.]+)/i);
  const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TARGET 1|TP 1|TP)[\s:\.]*([\d\.]+)/i);

  if (!actionMatch || !slMatch) return null;

  return {
    action: actionMatch[0].toUpperCase().includes('BUY') ? 'BUY' : 'SELL',
    pair: pairMatch ? pairMatch[1].toUpperCase() : 'XAUUSD',
    entry: entryVal,
    sl: parseFloat(slMatch[1]),
    tp1: tp1Match ? parseFloat(tp1Match[1]) : null,
  };
}

(async () => {
  console.log('⚡ Procesando e Inyectando la señal de Aliens (Message ID 709)...');

  const parsed = parseSignal(aliensMsg);
  if (!parsed) {
    console.log('❌ Error: no se pudo parsear la señal de Aliens.');
    process.exit(1);
  }

  parsed.channelName = 'Aliens- Royal fx 👑';
  console.log('🎯 Señal Parseada:', parsed);

  const plan = processSignalForExecution(parsed);
  console.log('📦 Plan Generado:', JSON.stringify(plan.orders, null, 2));

  const postData = JSON.stringify(plan.orders);

  const req = http.request({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/orders',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log('✅ Orden de Aliens inyectada en MT5 Bridge:', data);
      process.exit(0);
    });
  });

  req.on('error', err => {
    console.error('Error post:', err.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
})();
