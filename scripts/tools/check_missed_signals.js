/**
 * Script de Auditoría de Señales Omitidas mientras el bot estuvo apagado
 * Analiza todos los canales aprobados en channels.config.js y extrae mensajes recientes
 * desde el viernes 25 de septiembre hasta hoy lunes 28 de septiembre.
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CHANNELS_CONFIG, findChannelConfig } = require('../../config/channels.config');
const { strategyFactory } = require('../../core/StrategyFactory');
const { riskEngine } = require('../../core/RiskEngine');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

// Definir fecha de corte: desde el viernes 2026-09-25 a las 12:00 UTC (14:00 CET)
const CUTOFF_TIMESTAMP = Date.parse('2026-09-25T12:00:00Z');

async function main() {
  console.log('========================================================================================');
  console.log('🔍 AUDITORÍA DE SEÑALES OMITIDAS (TELEGRAM MTPROTO)');
  console.log(`📅 Ventana analizada: Desde ${new Date(CUTOFF_TIMESTAMP).toLocaleString('es-ES')} hasta AHORA (${new Date().toLocaleString('es-ES')})`);
  console.log('========================================================================================\n');

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    timeout: 15000
  });

  await client.connect();
  console.log('✅ Conectado a Telegram. Recuperando diálogos...\n');

  const dialogs = await client.getDialogs({});
  console.log(`📋 Total diálogos analizados: ${dialogs.length}`);

  const missedSignals = [];
  const informationalUpdates = [];
  const channelStats = {};

  for (const d of dialogs) {
    if (!d.isChannel && !d.isGroup) continue;

    const title = d.title || (d.entity && (d.entity.title || d.entity.username)) || '';
    let rawId = '';
    if (d.entity && d.entity.id) rawId = d.entity.id.toString();
    else if (d.id) rawId = d.id.toString().replace(/^-100/, '').replace(/^-/, '');

    const fullPeerId = `-100${rawId}`;
    const cfg = findChannelConfig(fullPeerId, title) || findChannelConfig(rawId, title);

    // Si no está configurado en channels.config, comprobar si el título sugiere señales
    const isSignalChannel = cfg || title.toLowerCase().includes('gold') || title.toLowerCase().includes('trade') || title.toLowerCase().includes('forex') || title.toLowerCase().includes('pip');
    if (!isSignalChannel) continue;

    const channelName = cfg ? cfg.name : title;
    const isApproved = !!(cfg && cfg.enabled);

    try {
      const messages = await client.getMessages(d.entity, { limit: 50 });
      for (const m of messages) {
        if (!m || !m.message) continue;
        const msgTime = m.date * 1000;
        if (msgTime < CUTOFF_TIMESTAMP) continue;

        const dateObj = new Date(msgTime);
        const timeCET = dateObj.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' });
        const dateCET = dateObj.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });

        const strategy = strategyFactory.getStrategy(cfg ? cfg.id : fullPeerId, channelName);
        const signal = strategy.parse(m.message, { messageId: m.id });

        // Comprobar si cayó en horario de mercado o fin de semana
        const inWeekend = riskEngine.isFridayCloseWindow(dateObj);
        const inRollover = riskEngine.isRolloverWindow(dateObj);

        if (signal && signal.action && signal.action !== 'N/A') {
          missedSignals.push({
            dateCET,
            timeCET,
            timestamp: msgTime,
            channelName,
            channelId: fullPeerId,
            isApproved,
            action: signal.action,
            symbol: signal.symbol || 'XAUUSD',
            entry: signal.entry || 'MERCADO',
            sl: signal.sl || 'SIN SL',
            tp1: signal.tp1 || 'N/A',
            tp2: signal.tp2 || 'N/A',
            isPending: !!signal.isPendingOrder,
            inWeekend,
            inRollover,
            rawText: m.message.replace(/\n+/g, ' ').substring(0, 100)
          });
        } else {
          // Detectar si fue un mensaje de actualización (TP hit, SL hit, BE)
          const upper = m.message.toUpperCase();
          if (upper.includes('TP HIT') || upper.includes('TARGET') || upper.includes('PROFIT') || upper.includes('PIPS') || upper.includes('BREAK EVEN') || upper.includes('CLOSE')) {
            informationalUpdates.push({
              dateCET,
              timeCET,
              channelName,
              text: m.message.replace(/\n+/g, ' ').substring(0, 90)
            });
          }
        }
      }
    } catch (eChat) {
      // Ignorar canales con permisos restringidos
    }
  }

  // Ordenar señales cronológicamente
  missedSignals.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\n========================================================================================`);
  console.log(`📊 RESULTADO DEL ANÁLISIS:`);
  console.log(`   🎯 Total de Señales Emitidas Detectadas: ${missedSignals.length}`);
  console.log(`   🌟 En Canales VIP Aprobados (Activos): ${missedSignals.filter(s => s.isApproved).length}`);
  console.log(`   🔒 Emitidas en Fin de Semana (Mercado Cerrado): ${missedSignals.filter(s => s.inWeekend).length}`);
  console.log(`   ⚡ Emitidas en Horario Operable de Mercado: ${missedSignals.filter(s => !s.inWeekend).length}`);
  console.log('========================================================================================\n');

  if (missedSignals.length > 0) {
    console.log('📋 DETALLE CRONOLÓGICO DE SEÑALES DETECTADAS:');
    console.log('----------------------------------------------------------------------------------------');
    missedSignals.forEach((s, idx) => {
      const statusIcon = s.isApproved ? (s.inWeekend ? '🔒 [FIN DE SEMANA]' : '🟢 [OPERABLE]') : '⚪ [CANAL PAUSADO]';
      console.log(`#${idx + 1} | [${s.dateCET} ${s.timeCET} CET] ${statusIcon}`);
      console.log(`   📢 Canal: "${s.channelName}"`);
      console.log(`   🎯 Operación: ${s.action} ${s.symbol} | Entrada: ${s.entry} | SL: ${s.sl} | TP1: ${s.tp1} | TP2: ${s.tp2}`);
      console.log(`   💬 Texto: "${s.rawText}..."`);
      console.log('----------------------------------------------------------------------------------------');
    });
  }

  // Desconexión limpia
  try {
    await client.disconnect();
  } catch (e) {}

  return { missedSignals, informationalUpdates };
}

if (require.main === module) {
  main().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Error analizando señales:', err);
    process.exit(1);
  });
}

module.exports = { main };
