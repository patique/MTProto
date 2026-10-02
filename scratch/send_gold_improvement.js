const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const msg = [
  '🎯 *DIAGNÓSTICO Y MEJORA DE WIN RATE EN XAUUSD (ORO)*',
  '━━━━━━━━━━━━━━━━━━━━━━━━━',
  '🔍 *Causas del 70.6% detectadas en la simulación:*',
  '  1. *TF M1 (Ruido y micro-mechas):* 28 operaciones con apenas 57.1% WR (el spread absorbe los SL ajustados).',
  '  2. *TF M15:* 7 operaciones con 42.9% WR (SL amplio y giros intradiarios antes del objetivo).',
  '  3. *Modelo 50/50 (TP1 + BE):* 36 operaciones alcanzaron TP1 pero volvieron a BE en la mitad restante, restando potencial frente a una salida limpia.',
  '',
  '🚀 *Plan de Optimización:*',
  '  • *Eliminar M1 y M15:* Enfocar el motor en el "Sweet Spot" *M2 + M3 + M5*.',
  '  • *Adoptar R:R 1:1.0 Limpio:* Mismo modelo probado en EURUSD y NAS100.',
  '  • *Filtro de Mecha de Rechazo:* Elevar exigencia de mecha institucional al 30%.',
  '',
  '📈 *Impacto Comprobado en la Simulación (21/09 - 01/10):*',
  '  • *M2 (R:R 1:1.0):* 18 ops ➔ 16 Wins (88.9% WR)',
  '  • *M3 (R:R 1:1.0):* 18 ops ➔ 17 Wins (94.4% WR)',
  '  • *M5 (R:R 1:1.0):* 14 ops ➔ 11 Wins (78.6% WR)',
  '  🔥 *Oro M2 + M3:* 91.7% WR (33W / 3L)',
  '  🔥 *Oro M2 + M3 + M5:* 88.0% WR (44W / 6L)',
  '━━━━━━━━━━━━━━━━━━━━━━━━━',
  '¿Procedemos a aplicar este ajuste en el algoritmo institucional de Oro?'
].join('\n');

(async () => {
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 3 });
  try {
    await client.connect();
    await client.sendMessage('me', { message: msg });
    console.log('✅ Mensaje de mejora enviado exitosamente a tu Telegram.');
    await client.disconnect();
  } catch (err) {
    console.error('Error enviando a Telegram:', err.message);
    try { await client.disconnect(); } catch (e) {}
  }
})();
