/**
 * Configuración Centralizada de Canales por Telegram Peer ID e Identidad Inmutable
 */

const CHANNELS_CONFIG = {
  // 1. G.S Market Analysis (Estrategia Rejilla / Grid adaptada a TP3 con BE en TP2)
  '-1003102563197': {
    name: 'G.S Market Analysis',
    username: '@GSmarketanalysis',
    strategy: 'GSMarketStrategy',
    enabled: false, // Desactivado por solicitud: canal de rejilla enfocado en TP1/TP2 donde casi nunca toca TP3 (0% hit rate)
    preferredTP: 'TP3',
    breakEvenTrigger: null,
    allowSplit: false,
    defaultSLPips: 100,
    defaultTP1Pips: 100,
    defaultTP2Pips: 200,
    maxSlippagePips: 6.0,
    allowGrid: false,
    gridStepPips: 1.0,
    pendingOrderTTLMinutes: 45
  },

  // 2. Attaullah Trading Zone (Zonas de Entrada sin Grid, ejecución limpia a mercado/orden)
  '-1004307971022': {
    name: 'Attaullah Trading Zone',
    username: '@tradewithattaullah',
    strategy: 'AttaullahStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 80,
    defaultTP1Pips: 30,
    defaultTP2Pips: 70,
    maxSlippagePips: 8.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 3. Williams tradershub
  '-1003745883830': {
    name: 'Williams tradershub',
    username: 'N/A',
    strategy: 'WilliamsStrategy',
    enabled: false, // Desactivado: reemplazado por Craig Percoco (mayor consistencia y winrate)
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 100,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 8.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 4. Marco Trading Hub
  '-1002157727490': {
    name: 'MARCO TRADING HUB',
    username: '@Marcotradinghubb',
    strategy: 'MarcoStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 10.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 5. Aliens- Royal fx
  '-1003915769321': {
    name: 'Aliens- Royal fx',
    username: 'N/A',
    strategy: 'DefaultStrategy',
    enabled: false, // Desactivado: señales emitidas con desfase que no entran a mercado
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 70,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 6. Candle Logic Lab
  '-1002235039984': {
    name: 'Candle Logic Lab',
    username: '@CandleLogicLab1',
    strategy: 'DefaultStrategy',
    enabled: false, // Deshabilitado: filtrado para evitar sobre-operativa y drawdown
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 7. Craig Percoco Daily Trades
  '-1001823957090': {
    name: 'Craig Percoco Daily Trades',
    username: '@Craig_James_percoco1',
    strategy: 'DefaultStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 8. Exness Gold Trader
  '-1004339716486': {
    name: 'EXNESS GOLD TRADER',
    username: '@Exness_Gold_EducationHub',
    strategy: 'DefaultStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 80,
    defaultTP1Pips: 50,
    defaultTP2Pips: 100,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 9. Gold Pro Signal
  '-1002429125771': {
    name: 'GOLD PRO SIGNAL',
    username: '@Gold_pro_s11',
    strategy: 'DefaultStrategy',
    enabled: true, // Activado: Estrategia de recorrido a último TP (con BE en TP2)
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 100,
    defaultTP1Pips: 30,
    defaultTP2Pips: 60,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 10. Meta Trader 5 Officiall
  '-1002176496064': {
    name: 'META TRADER 5 OFFICIALL',
    username: '@metrader5oficiall',
    strategy: 'DefaultStrategy',
    enabled: false, // Deshabilitado para evitar sobre-operativa
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 90,
    defaultTP1Pips: 30,
    defaultTP2Pips: 60,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 11. The Traders Club (Aron Luce)
  '-1001891914408': {
    name: 'THE TRADERS CLUB – FWA',
    username: '@Forexwitharonluce',
    strategy: 'DefaultStrategy',
    enabled: false, // Deshabilitado por envío de recaps y promociones
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 12. Smart Pips Alerts
  '-1003669486746': {
    name: 'Smart Pips Alerts',
    username: '@Smartpipsalrets71',
    strategy: 'DefaultStrategy',
    enabled: false, // Deshabilitado por filtro de rendimiento (0% WR / pérdidas netas)
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 13. XAUUSD Forex Trading (kingFxGoldTeam786)
  '-1002493671900': {
    name: 'XAUUSD FOREX TRADING',
    username: '@kingFxGoldTeam786',
    strategy: 'DefaultStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 14. Gold BTC Trader
  '-1001936020052': {
    name: 'GOLD BTC TRADER',
    username: '@Gold_Btctrader21',
    strategy: 'DefaultStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 15. Risk Management-revealed
  '-1002206734647': {
    name: 'Risk Management-revealed',
    username: '@Risk_Management_revealed',
    strategy: 'DefaultStrategy',
    enabled: false, // Desactivado: Solo la estrategia Institucional BPR opera en LIVE
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 16. Ai Premium Pips
  '-1003862726389': {
    name: 'Ai Premium Pips',
    username: 'N/A',
    strategy: 'DefaultStrategy',
    enabled: false, // Deshabilitado por filtro de rendimiento (R:R negativo / pérdidas netas)
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 5.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 17. TRADE WITH RAJA
  '-1002912763769': {
    name: 'TRADE WITH RAJA',
    username: '@tradewithraja08',
    strategy: 'DefaultStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 90,
    defaultTP1Pips: 30,
    defaultTP2Pips: 60,
    maxSlippagePips: 6.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 18. VIP GOLD SIGNALS
  '-1002174340947': {
    name: 'VIP GOLD SIGNALS',
    username: '@ViP_Gold_Signals_786',
    strategy: 'DefaultStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 100,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 6.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  },

  // 19. GOLD PIPS HUNTER
  '-1002402499107': {
    name: 'GOLD PIPS HUNTER',
    username: '@goldfree8361',
    strategy: 'DefaultStrategy',
    enabled: true,
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    allowSplit: false,
    minRiskReward: 1.0,
    defaultSLPips: 90,
    defaultTP1Pips: 30,
    defaultTP2Pips: 60,
    maxSlippagePips: 6.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  }
};

/**
 * Normaliza cualquier texto a minúsculas y caracteres simples
 */
function normalizeString(str) {
  if (!str) return '';
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Resuelve la configuración de un canal por su ID (O(1)) o por fallback de nombre
 */
function findChannelConfig(channelId, channelTitle = '') {
  if (channelId) {
    const idStr = channelId.toString();
    const cleanId = idStr.startsWith('-100') ? idStr : `-100${idStr.replace(/^-/, '')}`;
    if (CHANNELS_CONFIG[cleanId]) {
      return { id: cleanId, ...CHANNELS_CONFIG[cleanId] };
    }
    if (CHANNELS_CONFIG[idStr]) {
      return { id: idStr, ...CHANNELS_CONFIG[idStr] };
    }
    // Si channelId no es numérico, tratarlo como título
    if (isNaN(Number(idStr)) && (!channelTitle || channelTitle === 'Canal')) {
      channelTitle = idStr;
    }
  }

  // Fallback por coincidencia de nombre si el ID no vino
  if (channelTitle) {
    const normTitle = normalizeString(channelTitle);
    for (const [id, cfg] of Object.entries(CHANNELS_CONFIG)) {
      const normCfg = normalizeString(cfg.name);
      if (normTitle.includes(normCfg) || normCfg.includes(normTitle)) {
        return { id, ...cfg };
      }
    }
  }

  // Perfil por defecto para canales no registrados
  return {
    id: channelId ? channelId.toString() : 'UNKNOWN',
    name: channelTitle || 'Canal Desconocido',
    strategy: 'DefaultStrategy',
    enabled: false, // Desactivado por defecto si no está explícitamente en la lista
    preferredTP: 'LAST_TP',
    breakEvenTrigger: null,
    defaultSLPips: 90,
    defaultTP1Pips: 40,
    defaultTP2Pips: 80,
    maxSlippagePips: 8.0,
    allowGrid: false,
    pendingOrderTTLMinutes: 30
  };
}

module.exports = {
  CHANNELS_CONFIG,
  findChannelConfig,
  normalizeString
};
