const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  const dialogs = await client.getDialogs();
  
  console.log('--- BUSCANDO CHATS DE AI PREMIUM PIPS ---');
  for (const dialog of dialogs) {
    const title = dialog.title || '';
    if (title.toLowerCase().includes('ai') || title.toLowerCase().includes('premium')) {
      console.log(`📌 ID: ${dialog.id} | Titulo Exacto: "${title}"`);
      const messages = await client.getMessages(dialog.entity, { limit: 3 });
      console.log('Ultimos mensajes:');
      messages.forEach(m => {
        if (m.message) {
          console.log(`   [${new Date(m.date * 1000).toLocaleString('es-ES')}] ${m.message.replace(/\n/g, ' ')}`);
        }
      });
    }
  }
  process.exit(0);
})();
