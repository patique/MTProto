/**
 * Escuchador de Señales para Threads de Meta (threads.net)
 * Inspecciona cuentas públicas de Threads en tiempo real y envía las órdenes al puente de MT5.
 */

const https = require('https');
const { adaptiveParser } = require('./core/AdaptiveParser');
const { strategyFactory } = require('./core/StrategyFactory');
const { riskEngine } = require('./core/RiskEngine');
const { initMT5Bridge, executeTradePlan, getLatestTick } = require('./mt5_bridge');

// Lista de nombres de usuario de Threads públicos a monitorear
const THREADS_PROFILES = [
  'xauusd_trader',
  'muazam_ali'
];

const POLL_INTERVAL_MS = 5000;
const processedPostIds = new Set();

function fetchThreadsProfile(urlOrUsername) {
  return new Promise((resolve, reject) => {
    const targetUrl = urlOrUsername.startsWith('http') 
      ? urlOrUsername 
      : `https://www.threads.net/@${urlOrUsername}`;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache'
      }
    };

    const req = https.get(targetUrl, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchThreadsProfile(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

function extractPostsFromHTML(html) {
  const posts = [];
  try {
    const scriptRegex = /<script type="application\/json"[^>]*>(.*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      const content = match[1];
      if (content.includes('post') || content.includes('caption')) {
        const textMatches = content.match(/"text"\s*:\s*"([^"]+)"/g);
        if (textMatches) {
          for (const tm of textMatches) {
            const raw = tm.replace(/"text"\s*:\s*"/, '').replace(/"$/, '');
            const decoded = JSON.parse(`"${raw}"`);
            posts.push(decoded);
          }
        }
      }
    }
  } catch (e) {}

  if (posts.length === 0) {
    const textBlocks = html.match(/class="[^"]*"[^>]*>([^<]*(?:BUY|SELL|XAUUSD|GOLD|SL|TP)[^<]*)<\/div>/gi);
    if (textBlocks) {
      for (const block of textBlocks) {
        const clean = block.replace(/<[^>]+>/g, '').trim();
        if (clean) posts.push(clean);
      }
    }
  }

  return posts;
}

async function startThreadsListener() {
  console.log('⚡ Iniciando Escuchador de Señales para Threads (Meta)...');
  console.log(`📋 Cuentas registradas (${THREADS_PROFILES.length}): ${THREADS_PROFILES.map(p => '@' + p).join(', ')}`);
  
  await initMT5Bridge();
  const defaultStrategy = strategyFactory.getStrategy('THREADS', 'Threads Signals');

  setInterval(async () => {
    for (const username of THREADS_PROFILES) {
      try {
        const html = await fetchThreadsProfile(username);
        const posts = extractPostsFromHTML(html);

        for (const postText of posts) {
          const postHash = `${username}:${postText.substring(0, 40)}`;
          if (processedPostIds.has(postHash)) continue;
          processedPostIds.add(postHash);

          // Validación de Fecha para señales de Threads
          const dateMatch = postText.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
          if (dateMatch) {
            const today = new Date();
            const postDay = parseInt(dateMatch[1], 10);
            const postMonthStr = dateMatch[2].toLowerCase();
            const postYear = parseInt(dateMatch[3], 10);

            const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            const postMonth = months.indexOf(postMonthStr);

            if (today.getDate() !== postDay || today.getMonth() !== postMonth || today.getFullYear() !== postYear) {
              continue;
            }
          }

          const signal = adaptiveParser.parseMessage(postText, `THREADS_${username}`, `Threads @${username}`);
          if (signal && signal.action && signal.sl) {
            const timeStr = new Date().toLocaleTimeString('es-ES');
            console.log(`\n======================================================`);
            console.log(`📱 [NUEVA SEÑAL EN THREADS] [${timeStr}] Perfil: @${username}`);
            console.log(`💬 Contenido:\n"${postText}"`);
            console.log(`======================================================`);

            const liveTick = getLatestTick();
            const livePrice = signal.action.includes('BUY') ? (liveTick.ask || liveTick.bid) : (liveTick.bid || liveTick.ask);
            const plan = defaultStrategy.createExecutionPlan(signal, livePrice || signal.entry, riskEngine);
            await executeTradePlan(plan);
          }
        }
      } catch (err) {}
    }
  }, POLL_INTERVAL_MS);
}

if (require.main === module) {
  startThreadsListener();
}

module.exports = { startThreadsListener, THREADS_PROFILES };
