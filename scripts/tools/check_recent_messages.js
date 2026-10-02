const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const channelsToInspect = [
  { name: 'MARCO TRADING HUB', identifier: 'Marcotradinhub' },
  { name: 'Aliens- Royal fx', identifier: '-1003915769321' },
  { name: 'Fx Community', identifier: '3740495617' },
  { name: 'Smart Pips Alerts', identifier: 'Smartpipsalrets71' },
  { name: 'XAUUSD FOREX TRADING', identifier: 'kingFxGoldTeam786' },
  { name: 'FX PRO SIGNAL TEAM', identifier: 'XAUFxproSignalS' },
  { name: 'G.S Market Analysis', identifier: 'GSmarketanalysis' },
  { name: 'Risk Management-revealed', identifier: 'Risk_Management_revealed' },
];

const APPROVED_CHANNELS = [
  'aliens',
  'smart pips',
  'xauusd forex',
  'fx pro signal',
  'risk management',
  'marco',
  'marcotradinhub',
  'fx community',
  'community',
  'g.s market'
];

function normalizeTitle(str) {
  if (!str) return '';
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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
    entryVal = parseFloat(entryMatch[1]);
  }

  // SL match: "SL 4350", "SL: 4350", "STOP LOSS: 4350", "STOP LOSS 4350"
  const slMatch = text.match(/(?:STOP LOSS|STOPLOSS|SL)[\s:]+([\d\.]+)/i);
  
  // TP1 match: "TP1: 4330", "TP 4330", "TAKE PROFIT 1: 4330", "TARGET 1: 4330"
  const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TARGET 1|TP 1|TP)[\s:]+([\d\.]+)/i);
  const tp2Match = text.match(/(?:TAKE PROFIT 2|TP2|TARGET 2|TP 2)[\s:]+([\d\.]+)/i);
  const tp3Match = text.match(/(?:TAKE PROFIT 3|TP3|TARGET 3|TP 3)[\s:]+([\d\.]+)/i);

  if (!actionMatch || !slMatch) return null;

  return {
    action: actionMatch[0].toUpperCase().includes('BUY') ? 'BUY' : 'SELL',
    pair: pairMatch ? pairMatch[1].toUpperCase() : 'XAUUSD',
    entry: entryVal,
    sl: parseFloat(slMatch[1]),
    tp1: tp1Match ? parseFloat(tp1Match[1]) : null,
    tp2: tp2Match ? parseFloat(tp2Match[1]) : null,
    tp3: tp3Match ? parseFloat(tp3Match[1]) : null,
  };
}

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('🔍 === PRUEBA DE NORMALIZACIÓN Y DETECCIÓN EN TODOS LOS CANALES ===\n');

  for (const ch of channelsToInspect) {
    try {
      let entity;
      if (ch.identifier.startsWith('-') || ch.identifier.match(/^\d+$/)) {
        const dialogs = await client.getDialogs({});
        const found = dialogs.find((d) => d.id.toString().includes(ch.identifier.replace('-100', '')));
        if (found) entity = found.entity;
        else entity = await client.getEntity(ch.identifier);
      } else {
        entity = await client.getEntity(ch.identifier);
      }

      const rawTitle = entity.title || entity.username || ch.name;
      const normalized = normalizeTitle(rawTitle);
      const isApproved = APPROVED_CHANNELS.some((approved) => normalized.includes(approved));

      console.log(`---------------------------------------------------------`);
      console.log(`📌 Canal: "${rawTitle}" -> Normalizado: "${normalized}"`);
      console.log(`   Estado Filtro Aprobado: ${isApproved ? '✅ APROBADO' : '❌ RECHAZADO'}`);
      console.log(`---------------------------------------------------------`);

      const msgs = await client.getMessages(entity, { limit: 5 });
      msgs.forEach((m) => {
        const text = m.message || '';
        const date = new Date(m.date * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
        const parsed = parseSignal(text);

        if (parsed) {
          console.log(`[ID: ${m.id} | ${date}] ✅ SEÑAL DETECTADA:`, parsed);
        }
      });

    } catch (e) {
      console.log(`Error al inspeccionar ${ch.name}: ${e.message}`);
    }
  }

  process.exit(0);
})();
