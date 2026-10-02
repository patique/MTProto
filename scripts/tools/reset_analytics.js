/**
 * Script para reiniciar limpiamente el archivo analytics_data.json
 * Inicializa cada canal aprobado con 0 trades para la nueva prueba de 10k
 */

const fs = require('fs');
const path = require('path');
const { CHANNELS_CONFIG } = require('../../config/channels.config');

const analyticsPath = path.join(__dirname, '..', '..', 'analytics_data.json');

const freshAnalytics = {};

for (const [id, cfg] of Object.entries(CHANNELS_CONFIG)) {
  freshAnalytics[id] = {
    channelId: id,
    channelName: cfg.name,
    totalSignals: 0,
    winCount: 0,
    lossCount: 0,
    cancelledCount: 0,
    pipsGained: 0,
    consecutiveLosses: 0,
    status: 'ACTIVE',
    lastSignals: []
  };
}

fs.writeFileSync(analyticsPath, JSON.stringify(freshAnalytics, null, 2), 'utf8');
console.log('✅ [Analytics Reset] analytics_data.json reiniciado a cero con éxito.');
