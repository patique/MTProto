const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const TARGET_CHANNELS = [
  'tradewithraja08',
  'tradewithattaullah',
  'kingFxGoldTeam786',
  'ViP_Gold_Signals_786'
];

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  for (const handle of TARGET_CHANNELS) {
    try {
      const entity = await client.getEntity(handle);
      console.log(`\n=================================================`);
      console.log(`HANDLE: @${handle}`);
      console.log(`TITLE: ${entity.title}`);
      console.log(`ID: ${entity.id}`);
      console.log(`FULL PEER ID: -100${entity.id}`);
      console.log(`USERNAME: @${entity.username || 'N/A'}`);
      
      const msgs = await client.getMessages(entity, { limit: 5 });
      console.log(`--- ÚLTIMOS MENSAJES ---`);
      for (const m of msgs) {
        if (m.message && m.message.trim().length > 0) {
          console.log(`[#${m.id}] ${m.message.slice(0, 150).replace(/\n/g, ' ')}...`);
        }
      }
    } catch (err) {
      console.error(`❌ Error con @${handle}:`, err.message);
    }
  }

  await client.disconnect();
}

main().catch(console.error);
