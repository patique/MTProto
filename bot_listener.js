/**
 * Escuchador en Tiempo Real de Canales de Telegram (GramJS MTProto)
 * - Identificación determinista de canales por Peer ID numérico inmutable (-100xxxx)
 * - Arquitectura Modular: Patrón Strategy por Canal
 * - Watchdog de Expiración (TTL) y Anti-Actualizaciones falsas
 * - Registro continuo en AnalyticsEngine
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { findChannelConfig } = require('./config/channels.config');
const { strategyFactory } = require('./core/StrategyFactory');
const { riskEngine } = require('./core/RiskEngine');
const { initMT5Bridge, executeTradePlan, getLatestTick } = require('./mt5_bridge');
const { analyticsEngine } = require('./core/AnalyticsEngine');
const { notificationService } = require('./core/NotificationService');

const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const dialogsMap = new Map(); // idStr -> { title, entity }
const processedMessageKeys = new Set();

/**
 * Normaliza títulos de chat
 */
function normalizeTitle(str) {
  if (!str) return '';
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Precarga y mapea todos los diálogos por su ID numérico real
 */
async function preloadDialogs(client) {
  try {
    const dialogs = await client.getDialogs({});
    console.log(`📋 [Caché Canales] ${dialogs.length} diálogos analizados.`);
    dialogsMap.clear();

    for (const d of dialogs) {
      if (!d.isChannel && !d.isGroup) continue;

      const title = d.title || (d.entity && (d.entity.title || d.entity.username)) || '';
      let rawId = '';
      if (d.entity && d.entity.id) rawId = d.entity.id.toString();
      else if (d.id) rawId = d.id.toString().replace(/^-100/, '').replace(/^-/, '');

      const fullId = `-100${rawId}`;
      const channelCfg = findChannelConfig(fullId, title);

      if (channelCfg && channelCfg.enabled) {
        dialogsMap.set(fullId, { title: channelCfg.name, entity: d.entity, config: channelCfg });
        dialogsMap.set(rawId, { title: channelCfg.name, entity: d.entity, config: channelCfg });
      }
    }

    console.log(`✅ [Canales Aprobados Registrados]: ${dialogsMap.size / 2} canales activos con estrategia asignada.`);
  } catch (e) {
    console.log('⚠️ [Caché Canales] Error precargando diálogos:', e.message);
  }
}

/**
 * Resuelve el ID canónico (-100xxxx) y el título del mensaje
 */
function resolveChannelIdentity(message) {
  if (!message) return { channelId: '', title: 'Chat Desconocido' };

  let rawId = '';
  if (message.peerId) {
    if (message.peerId.channelId) rawId = message.peerId.channelId.toString();
    else if (message.peerId.chatId) rawId = message.peerId.chatId.toString();
    else if (message.peerId.userId) rawId = message.peerId.userId.toString();
  } else if (message.chatId) {
    rawId = message.chatId.toString().replace(/^-100/, '').replace(/^-/, '');
  }

  const fullId = rawId ? `-100${rawId}` : '';
  const cached = dialogsMap.get(fullId) || dialogsMap.get(rawId);

  const title = cached ? cached.title : (message.chat?.title || 'Canal Desconocido');
  return { channelId: fullId || rawId, title };
}

/**
 * Función puente compatible con llamadas anteriores de parseo
 */
function parseSignal(text, channelName = null, channelId = null) {
  const strategy = strategyFactory.getStrategy(channelId, channelName);
  return strategy.parse(text, {});
}

async function startListener() {
  console.log('⚡ Iniciando Escuchador Modular en Tiempo Real (GramJS + Strategy Pattern)...');
  await initMT5Bridge();

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 999999,
    autoReconnect: true,
    useWSS: false,
    pingInterval: 10000,
    timeout: 15000
  });

  try {
    await client.connect();
  } catch (errConnect) {
    console.error('⚠️ [Error Conexión] Reintentando conexión en 10 segundos...', errConnect.message);
    setTimeout(startListener, 10000);
    return;
  }

  await preloadDialogs(client);
  notificationService.setTelegramClient(client);
  console.log('✅ Cliente Telegram conectado. Escuchando eventos con detección por Peer ID...\n');

  // 1. Manejador de Eventos en Tiempo Real
  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message || !message.message) return;

    try {
      const { channelId, title } = resolveChannelIdentity(message);
      const channelCfg = findChannelConfig(channelId, title);

      // Si el canal no está en la lista de aprobados o está deshabilitado, omitir
      if (!channelCfg || !channelCfg.enabled) return;

      const msgKey = `${channelId}:${message.id}`;
      if (processedMessageKeys.has(msgKey)) return;
      processedMessageKeys.add(msgKey);

      // Obtener estrategia asignada al canal
      const strategy = strategyFactory.getStrategy(channelId, channelCfg.name);
      const signal = strategy.parse(message.message, { messageId: message.id });

      if (signal) {
        if (!signal.rawText) signal.rawText = message.message;
        const timeStr = new Date().toLocaleTimeString('es-ES');
        console.log(`\n🎯 [SEÑAL VÁLIDA] [${timeStr}] Canal: "${channelCfg.name}"`);
        console.log(`   ${signal.action} ${signal.symbol} | Entrada: ${signal.entry || 'MERCADO'} | SL: ${signal.sl} | TP1: ${signal.tp1} | TP2: ${signal.tp2}`);

        // Obtener precio en vivo del broker
        const liveTick = getLatestTick();
        const livePrice = signal.action.includes('BUY') ? (liveTick.ask || liveTick.bid) : (liveTick.bid || liveTick.ask);

        // Crear plan de ejecución específico de la estrategia del canal
        const plan = strategy.createExecutionPlan(signal, livePrice || signal.entry, riskEngine);

        // Despachar a MT5 con la señal original para telemetría
        await executeTradePlan(plan, signal);
      }
    } catch (err) {
      console.log('Error procesando evento:', err.message);
    }
  });

  // 2. Malla de Seguridad Forzada (Poller de Respaldo cada 60s)
  const forcedPollerInterval = setInterval(async () => {
    try {
      const now = Date.now();
      for (const { title, entity, config } of dialogsMap.values()) {
        if (!entity || !config || !config.enabled) continue;

        try {
          const msgs = await client.getMessages(entity, { limit: 2 });
          for (const m of msgs) {
            if (!m || !m.message) continue;
            const msgTime = m.date * 1000;
            const ageMinutes = (now - msgTime) / 60000;
            if (ageMinutes > 15) continue; // Descartar mensajes de más de 15 minutos

            const msgKey = `${config.id}:${m.id}`;
            if (processedMessageKeys.has(msgKey)) continue;
            processedMessageKeys.add(msgKey);

            const strategy = strategyFactory.getStrategy(config.id, config.name);
            const signal = strategy.parse(m.message, { messageId: m.id });

            if (signal) {
              if (!signal.rawText) signal.rawText = m.message;
              const timeStr = new Date(msgTime).toLocaleTimeString('es-ES');
              console.log(`\n🔄 [POLLER RESPALDO] [${timeStr}] Señal recuperada de "${config.name}":`);
              console.log(`   ${signal.action} ${signal.symbol} | Entrada: ${signal.entry || 'MERCADO'} | SL: ${signal.sl} | TP1: ${signal.tp1} | TP2: ${signal.tp2}`);

              const liveTick = getLatestTick();
              const livePrice = signal.action.includes('BUY') ? (liveTick.ask || liveTick.bid) : (liveTick.bid || liveTick.ask);
              const plan = strategy.createExecutionPlan(signal, livePrice || signal.entry, riskEngine);
              await executeTradePlan(plan, signal);
            }
          }
        } catch (eChat) {}
      }
    } catch (errPoll) {
      console.log('⚠️ [Poller Forzado] Error:', errPoll.message);
    }
  }, 60000);

  // 3. Watchdog Guardián Keep-Alive
  const watchdogInterval = setInterval(async () => {
    try {
      const isOk = await Promise.race([
        client.checkAuthorization(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('PING_TIMEOUT')), 5000))
      ]);
    } catch (err) {
      console.log(`⚠️ [Watchdog Guardián] Socket inactivo. Reiniciando conexión...`);
      clearInterval(watchdogInterval);
      clearInterval(forcedPollerInterval);
      try { await client.destroy(); } catch (e) {}
      setTimeout(startListener, 2000);
    }
  }, 30000);
}

process.on('uncaughtException', (err) => {
  console.error('🛡️ [UncaughtException Interceptada]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('🛡️ [UnhandledRejection Interceptada]:', reason);
});

if (require.main === module) {
  startListener().catch(err => {
    console.error('⚠️ Error al iniciar listener. Reiniciando en 5s...', err.message);
    setTimeout(startListener, 5000);
  });
}

module.exports = {
  parseSignal,
  normalizeTitle,
  startListener
};
