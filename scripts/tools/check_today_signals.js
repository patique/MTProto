const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { strategyFactory } = require('../../core/StrategyFactory');
const { CHANNELS_CONFIG } = require('../../config/channels.config');
const http = require('http');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

function fetchLiveStatus() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:3000/api/status', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
      });
    }).on('error', () => resolve({}));
  });
}

async function checkSignals() {
  const status = await fetchLiveStatus();
  const liveGoldPrice = status.tick?.bid || 4123.65;
  console.log(`\n======================================================`);
  console.log(`📡 AUDITORÍA DE CANALES TELEGRAM (Hoy 07/10/2026)`);
  console.log(`💰 Precio actual Oro (MT5): ${liveGoldPrice}`);
  console.log(`======================================================\n`);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 3,
    timeout: 10000
  });
  await client.connect();

  const dialogs = await client.getDialogs({});

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfDayTs = startOfDay.getTime();

  for (const [id, cfg] of Object.entries(CHANNELS_CONFIG)) {
    if (!cfg.enabled) continue;

    const rawId = id.replace(/^-100/, '').replace(/^-/, '');
    const dialog = dialogs.find(d => {
      const dId = d.id ? d.id.toString().replace(/^-100/, '').replace(/^-/, '') : '';
      const dEntityId = (d.entity && d.entity.id) ? d.entity.id.toString() : '';
      return dId === rawId || dEntityId === rawId;
    });

    if (!dialog) {
      console.log(`⚠️ Canal no encontrado en sesión: "${cfg.name}" (${id})`);
      continue;
    }

    try {
      const msgs = await client.getMessages(dialog.entity, { limit: 15 });
      const todayMsgs = msgs.filter(m => (m.date * 1000) >= startOfDayTs);

      console.log(`📢 Canal: "${cfg.name}" -> ${todayMsgs.length} mensajes hoy`);

      const strategy = strategyFactory.getStrategy(id, cfg.name);

      for (const m of todayMsgs) {
        if (!m.message) continue;
        const sig = strategy.parse(m.message, { messageId: m.id });
        if (sig && !sig.isCancelEvent && !sig.isBreakEvenEvent) {
          const mTime = new Date(m.date * 1000).toLocaleTimeString('es-ES');
          console.log(`\n   🎯 SEÑAL DETECTADA [${mTime}] en "${cfg.name}":`);
          console.log(`      Acción: ${sig.action} ${sig.symbol}`);
          console.log(`      Entrada: ${sig.entry || 'MERCADO'} | Rango: ${sig.entryRange ? `${sig.entryRange.min} - ${sig.entryRange.max}` : 'N/A'}`);
          console.log(`      SL: ${sig.sl} | TP1: ${sig.tp1} | TP2: ${sig.tp2} | TP3: ${sig.tp3}`);

          // Comprobar si está en zona respecto al precio actual
          if (sig.symbol.includes('XAU') || sig.symbol.includes('GOLD')) {
            let inZone = false;
            let dist = null;
            if (sig.entryRange) {
              inZone = liveGoldPrice >= sig.entryRange.min && liveGoldPrice <= sig.entryRange.max;
              dist = liveGoldPrice < sig.entryRange.min ? (sig.entryRange.min - liveGoldPrice) : (liveGoldPrice - sig.entryRange.max);
            } else if (sig.entry) {
              dist = Math.abs(liveGoldPrice - sig.entry);
              inZone = dist <= 3.0; // dentro de 3 USD (30 pips)
            }
            console.log(`      📍 Estado Zona: ${inZone ? '✅ ¡EN ZONA AHORA MISMO!' : `❌ Fuera de zona (Distancia: ${dist ? dist.toFixed(2) : 'N/A'} USD)`}`);
          }
          console.log(`      Texto Original:\n      "${m.message.replace(/\n/g, '\n      ')}"`);
        }
      }
    } catch (e) {
      console.log(`   Error en canal ${cfg.name}:`, e.message);
    }
  }

  await client.destroy();
  console.log(`\n======================================================\n`);
}

checkSignals().catch(console.error);
