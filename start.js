/**
 * Master Runner / Orquestador Unificado (Antigravity MT5 Trading System)
 * - Inicia el Servidor HTTP MT5 + Dashboard Web (http://127.0.0.1:3000)
 * - Inicia el Escuchador de Telegram en Tiempo Real (bot_listener.js)
 * - Inicia el Escuchador de Threads de Meta (threads_listener.js)
 * - Inicia el Filtro de Noticias Económicas de Alto Impacto (NewsFilter)
 * - Monitorea caídas y garantiza reanudación limpia automática
 */

const fs = require('fs');
const path = require('path');
const { initMT5Bridge } = require('./mt5_bridge');
const { newsFilter } = require('./core/NewsFilter');
const { startListener } = require('./bot_listener');

const LOCK_FILE = path.join(__dirname, '.app.lock');

function acquireSingleInstanceLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const pidStr = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid !== process.pid) {
        // Verificar si el proceso con ese PID sigue vivo
        process.kill(pid, 0);
        console.error(`\n🚨 [BLOQUEO DE INSTANCIA ÚNICA ACTIVO]`);
        console.error(`   Ya existe un proceso "node start.js" corriendo en segundo plano con PID ${pid}.`);
        console.error(`   🛑 Abortando este proceso para evitar la duplicación de órdenes y listeners en MT5.\n`);
        process.exit(1);
      }
    } catch (e) {
      // Si process.kill(pid, 0) lanza error ESRCH significa que el proceso ya no existe (stale lock)
    }
  }

  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
  } catch (err) {}

  const releaseLock = () => {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const curPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
        if (curPid === process.pid) {
          fs.unlinkSync(LOCK_FILE);
        }
      }
    } catch (e) {}
  };

  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
}

async function main() {
  acquireSingleInstanceLock();
  console.clear();
  console.log('========================================================================================');
  console.log('⚡ ANTIGRAVITY MT5 TRADING SYSTEM - ORQUESTADOR MAESTRO INSTITUCIONAL');
  console.log('========================================================================================');
  console.log('🚀 Inicializando componentes core...');

  // 1. Iniciar Puente MT5 y Dashboard Web
  console.log('\n[1/4] 🌐 Levantando Puente HTTP MT5 y Dashboard...');
  await initMT5Bridge();
  console.log('      👉 Dashboard disponible en: http://127.0.0.1:3000');

  // 2. Cargar Calendario de Noticias de Alto Impacto
  console.log('\n[2/4] 📰 Consultando Calendario Económico de Noticias (USD / Oro)...');
  await newsFilter.fetchCalendar();

  console.log('\n[3/3] 📡 Conectando a Telegram MTProto (Escucha en vivo por Peer IDs)...');
  try {
    startListener();
  } catch (e) {
    console.error('⚠️ Error iniciando Telegram Listener:', e.message);
  }

  console.log('\n========================================================================================');
  console.log('✅ SISTEMA COMPLETO ACTIVO Y OPERANDO EN TIEMPO REAL');
  console.log('   Panel de Control en Vivo: http://127.0.0.1:3000');
  console.log('   Presiona Ctrl + C para detener el sistema.');
  console.log('========================================================================================\n');
}

// Captura de terminación limpia
process.on('SIGINT', () => {
  console.log('\n🛑 Deteniendo sistema ordenadamente...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Deteniendo sistema ordenadamente...');
  process.exit(0);
});

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Error fatal en Master Runner:', err);
  });
}

module.exports = { main };
