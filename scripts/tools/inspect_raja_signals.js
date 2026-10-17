const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const entity = await client.getEntity('tradewithraja08');
  const msgs = await client.getMessages(entity, { limit: 30 });
  for (const m of msgs) {
    if (m.message && (m.message.includes('XAUUSD') || m.message.includes('GOLD') || m.message.includes('BUY') || m.message.includes('SELL'))) {
      console.log(`\n--- MSG #${m.id} (${new Date(m.date * 1000).toISOString()}) ---`);
      console.log(m.message);
    }
  }

  await client.disconnect();
}

main().catch(console.error);
