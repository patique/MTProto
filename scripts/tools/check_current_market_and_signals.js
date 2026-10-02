const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { parseSignal, normalizeTitle } = require('./bot_listener');
const https = require('https');

const stringSessionStr = '1BAAOMTQ5LjE1NC4xNjcuOTEAUK8k+ReJGKes0X1H/3s3guUWASnmFJwoicG1bCRGYCBwT04+OcLzR5C79CU2X0J/KexVKZPnkpzqitvKlGAHqj09jSem8HPWKYDWDGkPXQbV0ik2LN0T+uQZwRRNg/+3qefzJR/FtW+C+S2jIQ7xdBu8OeloaE683AtIUCJQOiqloKModRGz8kkU0lT6me7k5zsCrsYTJBt7AVfu0zDygEdqWvBclVF8l0PW3/SntH4Se1dKJKrUR0xsMFzngZdsf79w+LKc9SkzYXRhq09muE2Hseclm5PJ8l9X5h6Aa+8TQm/+qT1aj54eVv/AK9HAhBXGpok3TdqR4xYPQB/J2Tw=';
const apiId = 25677000;
const apiHash = 'e49356f9d8dbb478b5ffc575a632ac55';

const APPROVED_CHANNELS = [
  'aliens', 'smart pips', 'xauusd forex', 'fx pro signal',
  'risk management', 'marco', 'marcotradinhub', 'fx community',
  'community', 'g.s market', 'williams', 'ai premium',
  'attaullah', 'mr.qi', 'mr qi', 'candlelogiclab1', 'candle logic', 'candle'
];

function fetchLiveGoldPrice() {
  return new Promise((resolve) => {
    // 1. Intentar obtener el tick real en tiempo real transmitido por MT5 (XAUUSD-STD)
    const req = http.request({ hostname: '127.0.0.1', port: 3000, path: '/orders', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const tick = getLatestTick();
        if (tick && tick.bid > 0) {
          return resolve(tick.bid);
        }
        // Fallback a API de cotizaciones CFD
        https.get('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', (res2) => {
          let data2 = '';
          res2.on('data', chunk => data2 += chunk);
          res2.on('end', () => {
            try { resolve(parseFloat(JSON.parse(data2).price)); } catch (e) { resolve(4284.0); }
          });
        }).on('error', () => resolve(4284.0));
      });
    });
    req.on('error', () => resolve(4284.0));
    req.end();
  });
}

(async () => {
  console.log('🔍 [1/3] Obteniendo precio en vivo de XAUUSD / ORO...');
  const livePrice = await fetchLiveGoldPrice();
  console.log(`💰 Precio actual aproximado de Mercado XAUUSD: $${livePrice ? livePrice.toFixed(2) : 'Desconocido'}\n`);

  console.log('📡 [2/3] Conectando a Telegram y revisando canales aprobados...');
  const client = new TelegramClient(new StringSession(stringSessionStr), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  const dialogs = await client.getDialogs({});
  const approvedDialogs = dialogs.filter(d => {
    if (!d.name) return false;
    const norm = normalizeTitle(d.name);
    return APPROVED_CHANNELS.some(c => norm.includes(c));
  });

  console.log(`📋 Encontrados ${approvedDialogs.length} canales aprobados activos.\n`);
  console.log('🎯 [3/3] Evaluando señales publicadas en las últimas 12 horas:');
  console.log('========================================================================\n');

  const activeSignals = [];
  const now = Date.now();

  for (const d of approvedDialogs) {
    try {
      const msgs = await client.getMessages(d.entity, { limit: 15 });
      for (const m of msgs) {
        if (!m.message) continue;
        const msgTime = m.date * 1000;
        const ageHours = (now - msgTime) / (1000 * 3600);

        // Filtrar mensajes de las ultimas 12 horas
        if (ageHours > 12) continue;

        const parsed = parseSignal(m.message);
        if (parsed && parsed.action && parsed.sl) {
          parsed.channelTitle = d.name;
          parsed.date = new Date(msgTime);
          parsed.text = m.message;
          activeSignals.push(parsed);
        }
      }
    } catch (err) {
      console.log(`Error leyendo ${d.name}:`, err.message);
    }
  }

  await client.disconnect();

  if (activeSignals.length === 0) {
    console.log('ℹ️ No se detectaron señales en las últimas 12 horas.');
    return;
  }

  // Ordenar de más reciente a más antigua
  activeSignals.sort((a, b) => b.date - a.date);

  for (const s of activeSignals) {
    const timeStr = s.date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const isBuy = s.action === 'BUY';
    const entry = s.entry;
    const sl = s.sl;
    const tp1 = s.tp1 || (isBuy ? (entry ? entry + 3.0 : null) : (entry ? entry - 3.0 : null));

    console.log(`------------------------------------------------------------------------`);
    console.log(`📢 Canal: "${s.channelTitle}" | Hora: ${timeStr} | Acción: ${s.action} ${s.pair}`);
    console.log(`   Entrada original: ${entry || 'A MERCADO'} | SL: ${sl} | TP1: ${tp1 || 'No definido'}`);

    if (livePrice && entry) {
      const diffPips = ((livePrice - entry) * (isBuy ? 1 : -1) * 10).toFixed(1);
      
      // Evaluar estado respecto al precio actual
      let status = '';
      if (isBuy) {
        if (tp1 && livePrice >= tp1) {
          status = `🎯 TP1 ALCANZADO (Precio actual ${livePrice} >= TP1 ${tp1})`;
        } else if (sl && livePrice <= sl) {
          status = `🛑 STOP LOSS ALCANZADO (Precio actual ${livePrice} <= SL ${sl})`;
        } else if (Math.abs(livePrice - entry) <= 2.5) {
          status = `🟢 EN RANGO DE ENTRADA ACTIVO (Diferencia: ${diffPips} pips del punto de entrada)`;
        } else if (livePrice > entry && (!tp1 || livePrice < tp1)) {
          status = `📈 EN GANANCIA (+${diffPips} pips), SIN TOCAR TP1 TODAVÍA (Faltan ${(tp1 - livePrice).toFixed(2)}$)`;
        } else if (livePrice < entry && livePrice > sl) {
          status = `📉 EN DRAWDOWN CONTROLADO (${diffPips} pips), DENTRO DEL RANGO`;
        }
      } else {
        // SELL
        if (tp1 && livePrice <= tp1) {
          status = `🎯 TP1 ALCANZADO (Precio actual ${livePrice} <= TP1 ${tp1})`;
        } else if (sl && livePrice >= sl) {
          status = `🛑 STOP LOSS ALCANZADO (Precio actual ${livePrice} >= SL ${sl})`;
        } else if (Math.abs(livePrice - entry) <= 2.5) {
          status = `🟢 EN RANGO DE ENTRADA ACTIVO (Diferencia: ${diffPips} pips del punto de entrada)`;
        } else if (livePrice < entry && (!tp1 || livePrice > tp1)) {
          status = `📈 EN GANANCIA (+${diffPips} pips), SIN TOCAR TP1 TODAVÍA (Faltan ${(livePrice - tp1).toFixed(2)}$)`;
        } else if (livePrice > entry && livePrice < sl) {
          status = `📉 EN DRAWDOWN CONTROLADO (${diffPips} pips), DENTRO DEL RANGO`;
        }
      }
      console.log(`   📊 Diagnóstico en Vivo: ${status}`);
    } else if (livePrice && !entry) {
      console.log(`   ℹ️ Entrada fue a mercado puro. Si fue SELL a mercado con SL ${sl}:`);
      if (s.action === 'SELL') {
        if (tp1 && livePrice <= tp1) console.log(`   🎯 TP1 ${tp1} ya alcanzado.`);
        else if (livePrice < sl) console.log(`   🟢 Activa por debajo del SL (${sl}). Precio actual: ${livePrice}`);
        else console.log(`   🛑 Superó el SL ${sl}.`);
      } else {
        if (tp1 && livePrice >= tp1) console.log(`   🎯 TP1 ${tp1} ya alcanzado.`);
        else if (livePrice > sl) console.log(`   🟢 Activa por encima del SL (${sl}). Precio actual: ${livePrice}`);
        else console.log(`   🛑 Perdió el SL ${sl}.`);
      }
    }
  }
  console.log(`========================================================================\n`);
})();
