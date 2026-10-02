const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('🔎 Buscando el canal "Marcotradinhub"...');

  try {
    const entity = await client.getEntity('Marcotradinhub');
    const title = entity.title || entity.username || 'Marcotradinhub';
    console.log(`🎯 ¡Canal localizado!: "${title}" (ID: ${entity.id})`);

    const msgs = await client.getMessages(entity, { limit: 10 });
    console.log(`\n💬 ÚLTIMOS MENSAJES DE "${title}":`);
    console.log('======================================================');
    msgs.forEach((m, idx) => {
      if (m.message) {
        console.log(`\n--- Mensaje #${idx + 1} [${new Date(m.date * 1000).toLocaleString()}] ---`);
        console.log(m.message);
      }
    });
    console.log('======================================================\n');
  } catch (err) {
    console.log('Error al acceder al canal:', err.message);
  }

  process.exit(0);
})();
