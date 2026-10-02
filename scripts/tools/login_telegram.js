const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const qrcode = require('qrcode-terminal');

const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

(async () => {
  console.log('--- GENERADOR DE NUEVA SESIÓN TELEGRAM ---');
  const stringSession = new StringSession('');
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

  const newSession = client.session.save();
  console.log('\n======================================================');
  console.log('✅ ¡AUTENTICACIÓN EXITOSA!');
  console.log('Tu nuevo StringSession es:\n');
  console.log(newSession);
  console.log('======================================================\n');
  process.exit(0);
})();
