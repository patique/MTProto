const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const channelTarget = 'Risk_Management_revealed';
  console.log(`🔎 Buscando canal por username o título: "${channelTarget}"...`);

  let targetEntity = null;
  let targetTitle = channelTarget;

  try {
    // Intentar resolver directamente por username o enlace
    targetEntity = await client.getEntity(channelTarget);
    targetTitle = targetEntity.title || targetEntity.username || channelTarget;
    console.log(`🎯 Canal localizado vía API: "${targetTitle}"`);
  } catch (e) {
    console.log(`Buscando en diálogos locales... (${e.message})`);
    const dialogs = await client.getDialogs();
    const found = dialogs.find((d) => {
      const t = d.title || d.name || '';
      const u = d.entity?.username || '';
      return t.toLowerCase().includes('risk') || u.toLowerCase().includes('risk');
    });
    if (found) {
      targetEntity = found.entity;
      targetTitle = found.title || found.name;
      console.log(`🎯 Canal localizado en diálogos: "${targetTitle}"`);
    }
  }

  if (!targetEntity) {
    console.log('⚠️ No se pudo acceder al canal. Verifica si estás unído al canal o si es público/privado.');
    process.exit(1);
  }

  console.log(`Leyendo historial completo de "${targetTitle}"...`);

  let allMessages = [];
  let offsetId = 0;
  const limit = 100;

  for (let i = 0; i < 10; i++) {
    const msgs = await client.getMessages(targetEntity, { limit, offsetId });
    if (!msgs || msgs.length === 0) break;
    allMessages.push(...msgs);
    offsetId = msgs[msgs.length - 1].id;
    if (msgs.length < limit) break;
  }

  console.log(`Total mensajes recuperados: ${allMessages.length}`);

  // Analizar mensajes
  console.log('\n--- Muestra de los últimos 10 mensajes del canal ---');
  allMessages.slice(0, 10).forEach((m, idx) => {
    if (m.message) {
      console.log(`\n[#${idx + 1}] [${new Date(m.date * 1000).toLocaleString()}]`);
      console.log(m.message);
    }
  });

  process.exit(0);
})();
