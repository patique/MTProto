const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const qrcode = require('qrcode-terminal');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

// Función para parsear señales de trading en el texto de un mensaje
function parseTradingSignal(text) {
  if (!text) return null;
  const upper = text.toUpperCase();

  // Detectar si el mensaje contiene indicadores típicos de señal
  const isSignal = upper.includes('SIGNAL') || upper.includes('SELL') || upper.includes('BUY') || upper.includes('ENTRY');
  if (!isSignal) return null;

  const pairMatch = text.match(/(?:PAIR|PAR):\s*([A-Z0-9\/]+)/i) || text.match(/\b(XAU\/?USD|GOLD|EUR\/?USD|GBP\/?USD|BTC\/?USD|US30|NAS100)\b/i);
  const actionMatch = text.match(/\b(SELL NOW|BUY NOW|SELL|BUY)\b/i);
  const entryMatch = text.match(/(?:ENTRY|ENTRADA):\s*([\d\.]+)/i);
  const tp1Match = text.match(/(?:TAKE PROFIT 1|TP1|TP 1):\s*([\d\.]+)/i);
  const tp2Match = text.match(/(?:TAKE PROFIT 2|TP2|TP 2):\s*([\d\.]+)/i);
  const slMatch = text.match(/(?:STOP LOSS|SL):\s*([\d\.]+)/i);

  return {
    pair: pairMatch ? pairMatch[1] : 'Desconocido',
    action: actionMatch ? actionMatch[1].toUpperCase() : 'N/A',
    entry: entryMatch ? entryMatch[1] : 'N/A',
    tp1: tp1Match ? tp1Match[1] : 'N/A',
    tp2: tp2Match ? tp2Match[1] : 'N/A',
    sl: slMatch ? slMatch[1] : 'N/A',
  };
}

(async () => {
  console.log('Iniciando cliente de Telegram...');
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      throw { errorMessage: 'RESTART_AUTH_WITH_QR' };
    },
    qrCode: async (qr) => {
      const token = qr.token.toString('base64url');
      const url = `tg://login?token=${token}`;
      console.log('\n======================================================');
      console.log(' Escanea este código QR con tu app de Telegram:');
      console.log(' (En Telegram: Ajustes > Dispositivos > Vincular dispositivo)');
      console.log('======================================================\n');
      qrcode.generate(url, { small: true });
    },
    password: async () => await input.text('Introduce tu contraseña 2FA (si la tienes): '),
    onError: (err) => console.log('Error:', err),
  });

  console.log('\n✅ ¡Conectado con éxito a Telegram!');

  const dialogs = await client.getDialogs();
  console.log(`📋 Total de diálogos encontrados: ${dialogs.length}`);

  // Buscar canal objetivo
  const targetChannelName = 'Aliens'; // Cambia o busca por cualquier fragmento
  console.log(`\n🔎 Buscando el canal de señales que contenga "${targetChannelName}"...`);

  const targetDialog = dialogs.find((d) => {
    const title = d.title || d.name || '';
    return title.toLowerCase().includes(targetChannelName.toLowerCase());
  });

  if (targetDialog) {
    console.log(`\n🎯 ¡Canal encontrado!: "${targetDialog.title || targetDialog.name}" (ID: ${targetDialog.id})`);
    try {
      const messages = await client.getMessages(targetDialog.entity, { limit: 20 });
      console.log(`\n💬 Últimos ${messages.length} mensajes obtenidos del canal:`);
      console.log('======================================================');
      
      messages.forEach((m, idx) => {
        if (m.message) {
          console.log(`\n--- Mensaje #${idx + 1} [${new Date(m.date * 1000).toLocaleString()}] ---`);
          console.log(m.message);

          const parsedSignal = parseTradingSignal(m.message);
          if (parsedSignal && parsedSignal.action !== 'N/A') {
            console.log(' 📊 [SEÑAL DETECTADA]:', JSON.stringify(parsedSignal, null, 2));
          }
        }
      });
      console.log('======================================================\n');
    } catch (err) {
      console.log('Error al leer mensajes del canal:', err.message);
    }
  } else {
    console.log(`\n⚠️ No se encontró ningún canal que contenga "${targetChannelName}".`);
  }
})();

