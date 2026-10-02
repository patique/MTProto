const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal, normalizeTitle } = require('../../bot_listener');
const { processSignalForExecution } = require('../../risk_engine');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const APPROVED_CHANNELS = [
  'aliens',
  'smart pips',
  'xauusd forex',
  'fx pro signal',
  'risk management',
  'marco',
  'marcotradinhub',
  'fx community',
  'community',
  'g.s market',
  'williams',
  'ai premium',
  'attaullah',
  'mr qi'
];

(async () => {
  console.log('🧪 === INICIANDO TEST DE INTEGRACIÓN REAL DE TODOS LOS CANALES ===\n');

  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs({});
  const report = [];

  for (const d of dialogs) {
    if (!d.name) continue;
    const rawTitle = d.name;
    const normalized = normalizeTitle(rawTitle);
    const isApproved = APPROVED_CHANNELS.some(c => normalized.includes(c));

    if (!isApproved) continue;

    console.log(`📡 Inspeccionando canal: "${rawTitle}" (ID: ${d.id.toString()})...`);

    const msgs = await client.getMessages(d.entity, { limit: 30 });
    let totalMsgsChecked = 0;
    let validSignalsDetected = 0;
    let unparsedSignalDrafts = 0;
    const sampleSignals = [];

    for (const m of msgs) {
      if (!m.message) continue;
      totalMsgsChecked++;
      const text = m.message;
      const parsed = parseSignal(text);

      if (parsed) {
        validSignalsDetected++;
        const plan = processSignalForExecution(parsed);
        sampleSignals.push({
          msgId: m.id,
          date: new Date(m.date * 1000).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }),
          rawText: text,
          parsed,
          planValid: plan.valid
        });
      } else {
        // Verificar si era un borrador de señal que el parser omitió
        const upper = text.normalize('NFKD').toUpperCase();
        if ((upper.includes('BUY') || upper.includes('SELL') || upper.includes('SEEL')) && (upper.includes('SL') || upper.includes('TP'))) {
          unparsedSignalDrafts++;
          console.log(`   ⚠️ POSIBLE SEÑAL NO RECONOCIDA en ID ${m.id}:\n${text}\n---`);
        }
      }
    }

    report.push({
      channelName: rawTitle,
      normalizedTitle: normalized,
      isApproved: true,
      totalMsgsChecked,
      validSignalsDetected,
      unparsedSignalDrafts,
      sampleSignals
    });
  }

  console.log('\n========================================================================================');
  console.log('📋 === RESUMEN FINAL DEL TEST DE INTEGRACIÓN Y COMPATIBILIDAD DE CANALES ===');
  console.log('========================================================================================\n');

  report.forEach((r, idx) => {
    console.log(`[${idx + 1}] CANAL: "${r.channelName}"`);
    console.log(`    Título Normalizado: "${r.normalizedTitle}" -> Status Filtro: ✅ APROBADO`);
    console.log(`    Mensajes Escaneados: ${r.totalMsgsChecked} | Señales Válidas Detectadas: ${r.validSignalsDetected}`);
    console.log(`    Borradores No Parseados con palabras de señal: ${r.unparsedSignalDrafts}`);

    if (r.sampleSignals.length > 0) {
      const last = r.sampleSignals[0];
      console.log(`    🎯 Último Ejemplo Parseado Exitosamente (ID ${last.msgId} | ${last.date}):`);
      console.log(`       Acción: ${last.parsed.action} | Par: ${last.parsed.pair} | Entrada: ${last.parsed.entry} | SL: ${last.parsed.sl} | TP1: ${last.parsed.tp1}`);
      console.log(`       Plan de Riesgo: ${last.planValid ? '✅ VÁLIDO' : '❌ RECHAZADO'}`);
    }
    console.log('----------------------------------------------------------------------------------------');
  });

  process.exit(0);
})();
