/**
 * Script de Auditoría Forense: Compara las 29 operaciones ejecutadas hoy
 * contra los mensajes reales emitidos en los canales de Telegram
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

async function main() {
  const analytics = JSON.parse(fs.readFileSync('analytics_data.json', 'utf8'));
  const today = new Date().toISOString().split('T')[0];

  const todayTrades = [];
  for (const [chId, ch] of Object.entries(analytics)) {
    if (!ch.lastSignals) continue;
    for (const s of ch.lastSignals) {
      const sDate = new Date(s.timestamp).toISOString().split('T')[0];
      if (sDate === today) {
        todayTrades.push({
          chId,
          channel: ch.channelName,
          time: s.timeStr,
          timestamp: s.timestamp,
          symbol: s.symbol,
          action: s.action,
          entry: s.entry,
          sl: s.sl,
          tp: s.tp,
          outcome: s.outcome,
          pips: s.pips
        });
      }
    }
  }

  todayTrades.sort((a, b) => a.timestamp - b.timestamp);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    timeout: 15000
  });

  await client.connect();
  const dialogs = await client.getDialogs({});

  console.log(`========================================================================================`);
  console.log(`🔍 AUDITORÍA FORENSE: MENSAJE REAL DE TELEGRAM VS PARSEO DEL BOT (29 OPERACIONES)`);
  console.log(`========================================================================================\n`);

  for (let i = 0; i < todayTrades.length; i++) {
    const t = todayTrades[i];
    const rawId = t.chId.replace(/^-100/, '').replace(/^-/, '');

    const targetDialog = dialogs.find(d => {
      const dId = d.id ? d.id.toString().replace(/^-100/, '').replace(/^-/, '') : '';
      const dEntityId = (d.entity && d.entity.id) ? d.entity.id.toString() : '';
      return dId === rawId || dEntityId === rawId;
    });

    let matchedMessage = null;

    if (targetDialog) {
      try {
        // Buscar mensajes en una ventana de +/- 2 minutos del timestamp registrado
        const msgs = await client.getMessages(targetDialog.entity, { limit: 25 });
        // Buscar el mensaje más cercano en tiempo
        for (const m of msgs) {
          const mTime = m.date * 1000;
          const diffSec = Math.abs(mTime - t.timestamp) / 1000;
          if (diffSec < 180) { // dentro de 3 minutos
            matchedMessage = m;
            break;
          }
        }
      } catch (e) {}
    }

    console.log(`----------------------------------------------------------------------------------------`);
    console.log(`[#${i + 1}] Hora: ${t.time} CET | Canal: "${t.channel}"`);
    console.log(`   🤖 Orden ejecutada por el bot: ${t.action} ${t.symbol} | Entrada: ${t.entry} | SL: ${t.sl} | TP: ${t.tp}`);
    console.log(`   📊 Resultado: ${t.outcome} (${t.pips} pips)`);

    if (matchedMessage && matchedMessage.message) {
      const cleanMsg = matchedMessage.message.replace(/\n+/g, ' \n   │ ');
      console.log(`   💬 Mensaje REAL en Telegram [ID: ${matchedMessage.id}]:`);
      console.log(`   │ ${cleanMsg}`);

      // Comprobar si era señal de trading o informativo/recap
      const upper = matchedMessage.message.toUpperCase();
      const isActualSignal = upper.includes('BUY') || upper.includes('SELL') || upper.includes('ENTRY');
      const isRecap = upper.includes('TP HIT') || upper.includes('RECAP') || upper.includes('VIP RESULT') || upper.includes('FEEDBACK');

      if (isRecap && !isActualSignal) {
        console.log(`   ⚠️ [ERROR DE PARSEO / FALSO POSITIVO]: ¡Era un mensaje de resumen/recap, NO una señal!`);
      } else if (isActualSignal) {
        console.log(`   ✅ [SEÑAL REAL Y LEGÍTIMA]: El canal envió una orden explícita.`);
      } else {
        console.log(`   ❓ [DUDOSA]: Requiere revisión de sintaxis.`);
      }
    } else {
      console.log(`   ⚠️ [MENSAJE NO ENCONTRADO]: Podría haber sido borrado por el canal o desfase temporal.`);
    }
  }

  await client.disconnect();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
