const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const channelUsername = 'ViP_Gold_Signals_786';
  const entity = await client.getEntity(channelUsername);
  const messages = await client.getMessages(entity, { limit: 150 });

  const signals = [];
  const signalRegex = /XAUUSD\s+(BUY|SELL)\s+(\d{4}(?:\.\d+)?)/i;

  for (const msg of messages) {
    if (!msg.message) continue;
    const match = msg.message.match(signalRegex);
    if (match) {
      const type = match[1].toUpperCase();
      const entry = parseFloat(match[2]);
      
      const slMatch = msg.message.match(/SL\s+(\d{4}(?:\.\d+)?)/i);
      const tpMatches = [...msg.message.matchAll(/TP\s+(?:\d\s+)?(\d{4}(?:\.\d+)?)/gi)];
      
      const tps = tpMatches.map(m => parseFloat(m[1])).filter(v => !isNaN(v));
      const sl = slMatch ? parseFloat(slMatch[1]) : null;

      let riskUSD = sl ? Math.abs(entry - sl) : 0;
      let tp1USD = tps.length > 0 ? Math.abs(tps[0] - entry) : 0;
      let tpFinalUSD = tps.length > 0 ? Math.abs(tps[tps.length - 1] - entry) : 0;

      signals.push({
        id: msg.id,
        date: new Date(msg.date * 1000).toISOString(),
        action: type,
        entry,
        sl,
        tps,
        riskUSD: riskUSD.toFixed(1),
        tp1USD: tp1USD.toFixed(1),
        rrTP1: riskUSD > 0 ? (tp1USD / riskUSD).toFixed(2) : '0',
        rrTPFinal: riskUSD > 0 ? (tpFinalUSD / riskUSD).toFixed(2) : '0'
      });
    }
  }

  console.log(`\n📊 SEÑALES DETECTADAS EN LOS ÚLTIMOS 150 MENSAJES: ${signals.length}`);
  console.log(JSON.stringify(signals, null, 2));

  await client.disconnect();
}

main().catch(console.error);
