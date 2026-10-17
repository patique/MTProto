const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const stringSessionStr = process.env.TELEGRAM_SESSION || '1BAAOMTQ5LjE1NC4xNjcuOTEAUGYACNtv9yPGXZJfDRuJY9r0iKUbmrHVPLW/J9O0InWWf0nnf2PIqawqdIE6hSwAZ12JXXPZfhIXa/p8ojq7BhqvQ1oHxZ6Vrb6YntossRASwVrIo3CDLL8XisiudFRhsUfe/bfusFNSCZtcrH781FscrTQ6AhBK/bqosPsQxWUfCzjMr3xx2b5qvMYYRC6DCcz4PwRQyig5gWI7G9XJ+AFOaBnixOq1wmEScNeXifbmRMYVaUcwEm4Isu2XVagBncvsOrrwPoh9WgxvLxExdWB2cAL/YOJCHLjhPMPGCFR4BB09IUA2FqsQSlJ47n/NvUT34yT3IwKjq8DdMPKR870=';
const stringSession = new StringSession(stringSessionStr);
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const channelUsername = 'ViP_Gold_Signals_786';
  const entity = await client.getEntity(channelUsername);
  const messages = await client.getMessages(entity, { limit: 300 });

  // Agrupar mensajes en orden cronológico
  messages.reverse();

  let totalSignals = 0;
  let reachedTP1 = 0;
  let reachedTP2 = 0;
  let reachedTP3 = 0;
  let reachedTP4 = 0;
  let reachedTP5 = 0;
  let failedBeforeTP2 = 0;

  let currentSignal = null;

  for (const m of messages) {
    const text = m.message || '';
    if (/XAUUSD\s+(BUY|SELL)\s+\d{4}/i.test(text)) {
      totalSignals++;
      currentSignal = {
        id: m.id,
        text,
        maxTP: 0
      };
    } else if (currentSignal) {
      if (/TP\s*1\s*HIT/i.test(text) && currentSignal.maxTP < 1) currentSignal.maxTP = 1;
      if (/TP\s*2\s*HIT/i.test(text) && currentSignal.maxTP < 2) currentSignal.maxTP = 2;
      if (/TP\s*3\s*HIT/i.test(text) && currentSignal.maxTP < 3) currentSignal.maxTP = 3;
      if (/TP\s*4\s*HIT/i.test(text) && currentSignal.maxTP < 4) currentSignal.maxTP = 4;
      if ((/TP\s*5\s*HIT/i.test(text) || /Target Complete/i.test(text)) && currentSignal.maxTP < 5) currentSignal.maxTP = 5;
    }
  }

  // Ahora contemos estadísticamente entre señales auditadas
  const signalOutcomes = [];
  let tempSig = null;

  for (const m of messages) {
    const text = m.message || '';
    if (/XAUUSD\s+(BUY|SELL)\s+\d{4}/i.test(text)) {
      if (tempSig) signalOutcomes.push(tempSig);
      tempSig = { id: m.id, text: text.split('\n')[0], maxTP: 0 };
    } else if (tempSig) {
      if (/TP\s*1\s*HIT/i.test(text) && tempSig.maxTP < 1) tempSig.maxTP = 1;
      if (/TP\s*2\s*HIT/i.test(text) && tempSig.maxTP < 2) tempSig.maxTP = 2;
      if (/TP\s*3\s*HIT/i.test(text) && tempSig.maxTP < 3) tempSig.maxTP = 3;
      if (/TP\s*4\s*HIT/i.test(text) && tempSig.maxTP < 4) tempSig.maxTP = 4;
      if ((/TP\s*5\s*HIT/i.test(text) || /Target Complete/i.test(text)) && tempSig.maxTP < 5) tempSig.maxTP = 5;
    }
  }
  if (tempSig) signalOutcomes.push(tempSig);

  console.log(`\n======================================================`);
  console.log(`📊 AUDITORÍA REAL DE SEÑALES (${signalOutcomes.length} analizadas)`);
  console.log(`======================================================`);

  let tp5Count = 0;
  let beCount = 0; // Llegó a TP2 pero no a TP5 (habría cerrado en BE)
  let slCount = 0; // No llegó a TP2 (habría tocado SL completo)

  for (const s of signalOutcomes) {
    if (s.maxTP >= 5) tp5Count++;
    else if (s.maxTP >= 2) beCount++;
    else slCount++;

    console.log(`Trade #${s.id} [${s.text}]: Max Nivel Alcanzado = TP ${s.maxTP}`);
  }

  console.log(`\n------------------------------------------------------`);
  console.log(`🎯 RESULTADOS CON EL MODELO [TP FINAL + BE EN TP2]:`);
  console.log(`• Ganadoras Plenas (TP Final / +20$ promedio): ${tp5Count} (${((tp5Count/signalOutcomes.length)*100).toFixed(1)}%)`);
  console.log(`• Protegidas en Break-Even (0$ / Riesgo cancelado): ${beCount} (${((beCount/signalOutcomes.length)*100).toFixed(1)}%)`);
  console.log(`• Pérdidas por Stop Loss (No llegaron a TP2):     ${slCount} (${((slCount/signalOutcomes.length)*100).toFixed(1)}%)`);
  console.log(`------------------------------------------------------\n`);

  await client.disconnect();
}

main().catch(console.error);
