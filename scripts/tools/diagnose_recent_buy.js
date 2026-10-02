const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CHANNELS_CONFIG, findChannelConfig } = require('../../config/channels.config');
const { strategyFactory } = require('../../core/StrategyFactory');
const { riskEngine } = require('../../core/RiskEngine');

const stringSession = new StringSession('1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=');
const client = new TelegramClient(stringSession, 25677000, 'e49356f9d8dbb478b5ffc575a632ac55', { connectionRetries: 5 });

async function run() {
  await client.connect();
  const dialogs = await client.getDialogs({});
  const now = Date.now();
  console.log('--- BUSCANDO SEÑALES DE LOS ÚLTIMOS 30 MINUTOS ---');

  for (const d of dialogs) {
    if (!d.isChannel && !d.isGroup) continue;
    const title = d.title || (d.entity && (d.entity.title || d.entity.username)) || '';
    let rawId = '';
    if (d.entity && d.entity.id) rawId = d.entity.id.toString();
    else if (d.id) rawId = d.id.toString().replace(/^-100/, '').replace(/^-/, '');
    const fullId = '-100' + rawId;

    const cfg = findChannelConfig(fullId, title) || findChannelConfig(rawId, title);
    if (!cfg) continue;

    try {
      const msgs = await client.getMessages(d.entity, { limit: 10 });
      for (const m of msgs) {
        if (!m || !m.message) continue;
        const mTime = m.date * 1000;
        const ageMin = (now - mTime) / 60000;
        if (ageMin <= 30) {
          console.log('\n📢 Canal:', cfg.name, '| Habilitado:', cfg.enabled, '| ID:', fullId);
          console.log('⏰ Hora:', new Date(mTime).toLocaleTimeString('es-ES'));
          console.log('💬 Mensaje:\n' + m.message);

          const strategy = strategyFactory.getStrategy(fullId, cfg.name);
          const signal = strategy.parse(m.message, { messageId: m.id });
          console.log('🔍 Parser result:', signal ? {
            action: signal.action,
            symbol: signal.symbol,
            entry: signal.entry,
            sl: signal.sl,
            tp1: signal.tp1,
            tp2: signal.tp2
          } : 'NULL (Rechazado/No detectado)');

          if (signal) {
            const check = riskEngine.checkTradingAllowed();
            console.log('🛑 RiskEngine checkAllowed:', check);
          }
        }
      }
    } catch (e) {}
  }

  await client.disconnect();
}

run().catch(console.error);
