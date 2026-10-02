const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  console.log('Obteniendo lista completa de diálogos...');
  const dialogs = await client.getDialogs({});
  console.log(`Analizando ${dialogs.length} diálogos en tu cuenta...\n`);

  const signalChannels = [];

  for (let i = 0; i < dialogs.length; i++) {
    const d = dialogs[i];
    const title = d.title || d.name || 'Sin nombre';

    // Solo analizar canales o grupos (o chats de bots)
    if (!d.isChannel && !d.isGroup) continue;

    try {
      // Obtener los últimos 15 mensajes de cada chat
      const msgs = await client.getMessages(d.entity, { limit: 15 });
      if (!msgs || msgs.length === 0) continue;

      let signalScore = 0;
      let sampleSignal = null;

      msgs.forEach((m) => {
        const text = (m.message || '').toUpperCase();
        if (!text) return;

        const hasAction = text.includes('BUY') || text.includes('SELL');
        const hasTpSl = text.includes('TP') || text.includes('SL') || text.includes('TAKE PROFIT') || text.includes('STOP LOSS');
        const hasPair = text.includes('XAUUSD') || text.includes('GOLD') || text.includes('EURUSD') || text.includes('GBPUSD') || text.includes('BTCUSD') || text.includes('US30') || text.includes('NAS100');
        const hasKeywords = text.includes('SIGNAL') || text.includes('ENTRY') || text.includes('PIPS');

        if ((hasAction && hasTpSl) || (hasPair && (hasAction || hasTpSl)) || (hasKeywords && hasTpSl)) {
          signalScore++;
          if (!sampleSignal) sampleSignal = m.message;
        }
      });

      if (signalScore >= 1) {
        signalChannels.push({
          id: d.id,
          title,
          username: d.entity?.username || 'Privado/Sin username',
          signalScore,
          sampleSignal
        });
      }
    } catch (err) {
      // Ignorar canales donde no se tengan permisos de lectura
    }
  }

  console.log('======================================================');
  console.log(`🎯 CANALES DE SEÑALES DE TRADING DETECTADOS (${signalChannels.length})`);
  console.log('======================================================\n');

  signalChannels.sort((a, b) => b.signalScore - a.signalScore);

  signalChannels.forEach((c, idx) => {
    console.log(`[${idx + 1}] "${c.title}"`);
    console.log(`    Username: ${c.username} | ID: ${c.id}`);
    console.log(`    Puntuación de señales: ${c.signalScore}/15 mensajes recientes`);
    console.log(`    Ejemplo de mensaje:`);
    const preview = (c.sampleSignal || '').split('\n').slice(0, 3).join(' ');
    console.log(`    ↳ "${preview.substring(0, 120)}..."\n`);
  });

  process.exit(0);
})();
