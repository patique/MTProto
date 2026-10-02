const http = require('http');
const { processSignalForExecution } = require('./risk_engine');

function cleanEntry(rawEntry) {
  if (!rawEntry) return null;
  let s = rawEntry.toString().trim();
  if (s.includes('.')) {
    const parts = s.split('.');
    if (parts[0].length === 4 && parts[1].length === 4) {
      return parseFloat(parts[0]);
    }
  }
  return parseFloat(s);
}

function parseSignal(text) {
  if (!text) return null;
  const upper = text.toUpperCase();

  const isSignal = (upper.includes('BUY') || upper.includes('SELL')) &&
                   (upper.includes('TP') || upper.includes('SL') || upper.includes('STOP LOSS') || upper.includes('TAKE PROFIT') || upper.includes('TARGET'));

  if (!isSignal) return null;

  const actionMatch = upper.match(/(?:ORDER TYPE:\s*|TYPE:\s*)?(SELL NOW|BUY NOW|SELL|BUY)/i);
  const pairMatch = text.match(/(?:PAIR|PAR):\s*([A-Z0-9\/]+)/i) || text.match(/\b(XAU\/?USD|GOLD|EUR\/?USD|GBP\/?USD|BTC\/?USD|US30|NAS100)\b/i);
  
  // Entry match
  let entryVal = null;
  const entryMatch = text.match(/(?:ENTRY PRICE|ENTRY|ENTRADA|PRICE):\s*([\d\.]+)/i) || 
                     text.match(/(?:BUY|SELL)\s+(?:NOW\s+)?(?:[A-Z0-9\/]+\s+)?@?\s*([\d\.]+)/i);
  if (entryMatch) {
    entryVal = cleanEntry(entryMatch[1]);
  }

  // SL match: "SL. 4309", "SL 4316", "STOP LOSS: 4316"
  const slMatch = text.match(/(?:STOP LOSS|STOPLOSS|SL)[\s:\.]*([\d\.]+)/i);
  
  // TP1 match: "TP1. 4326", "TP 4330", "TAKE PROFIT 1:4366"
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

const rawMsgs = [
  {
    channelName: 'Williams tradershub 👑',
    text: `XAUUSD BUY 4322 /4319\nBuying gold\nTP1. 4326\nTP2.4329\nTP3.4333\nTP4.4349\n\nSL. 4309\nUse money management`
  },
  {
    channelName: 'Ai Premium Pips 🤖',
    text: `GOLD BUY  4324/4323\n\nTP 4330\nTP 4340\nTP 4370\n\nSL 4316`
  },
  {
    channelName: 'Ai Premium Pips 🤖',
    text: `‼️SIGNAL ALERT‼️\n\nPAIR: XAUUSD\nORDER TYPE: BUY\nENTRY PRICE: 4336- 4326\n\n❌STOP LOSS: 4316\n\n✅TAKE PROFIT 1:4366\n✅TAKE PROFIT 2:4396`
  }
];

(async () => {
  console.log('⚡ Procesando e Inyectando Señales de Williams Tradershub y Ai Premium Pips...\n');

  for (const item of rawMsgs) {
    const parsed = parseSignal(item.text);
    if (!parsed) {
      console.log(`❌ No se pudo parsear:`, item.text);
      continue;
    }

    parsed.channelName = item.channelName;
    console.log(`🎯 Señal Parseada:`, parsed);

    const plan = processSignalForExecution(parsed);
    console.log(`📦 Plan Generado (${plan.orders.length} ordenes):`, JSON.stringify(plan.orders, null, 2));

    const postData = JSON.stringify(plan.orders);

    await new Promise((resolve) => {
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
          console.log(`✅ Orden Inyectada al Servidor HTTP:`, data);
          resolve();
        });
      });
      req.on('error', err => {
        console.error('Error post:', err.message);
        resolve();
      });
      req.write(postData);
      req.end();
    });

    console.log('---------------------------------------------------------');
  }

  process.exit(0);
})();
