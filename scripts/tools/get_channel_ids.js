/**
 * Script para obtener los Channel IDs (Peer IDs) exactos de todos los canales y diálogos en Telegram
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  console.log('📡 Conectando a Telegram para extraer IDs de canales...');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log('✅ Conexión establecida. Obteniendo lista de diálogos...');

  const dialogs = await client.getDialogs({});
  console.log(`📋 Total de diálogos encontrados: ${dialogs.length}\n`);

  const channelsList = [];

  for (const d of dialogs) {
    if (!d.isChannel && !d.isGroup) continue;

    const rawTitle = d.title || (d.entity && (d.entity.title || d.entity.username || d.entity.firstName)) || '';
    const idStr = d.id ? d.id.toString() : '';
    let channelId = '';
    
    if (d.entity && d.entity.id) {
      channelId = d.entity.id.toString();
    } else if (d.id) {
      channelId = d.id.toString().replace(/^-100/, '').replace(/^-/, '');
    }

    const fullPeerId = channelId ? `-100${channelId}` : idStr;
    const username = (d.entity && d.entity.username) ? `@${d.entity.username}` : 'N/A';

    channelsList.push({
      title: rawTitle,
      fullPeerId,
      rawId: channelId,
      username,
      isChannel: !!d.isChannel,
      isGroup: !!d.isGroup
    });
  }

  // Ordenar por título
  channelsList.sort((a, b) => a.title.localeCompare(b.title));

  console.log('========================================================================================');
  console.log('📋 CANALES Y GRUPOS DETECTADOS EN TU CUENTA DE TELEGRAM:');
  console.log('========================================================================================');
  channelsList.forEach((c, idx) => {
    console.log(`${idx + 1}. [${c.fullPeerId}] "${c.title}" (${c.username})`);
  });
  console.log('========================================================================================\n');

  // Guardar en archivo JSON para uso de la configuración
  const outputPath = path.join(__dirname, 'discovered_channels.json');
  fs.writeFileSync(outputPath, JSON.stringify(channelsList, null, 2), 'utf-8');
  console.log(`💾 Lista exportada a: ${outputPath}`);

  await client.disconnect();
  process.exit(0);
})();
