/**
 * Puente HTTP Local para MetaTrader 5 (MT5 Bridge)
 * - Comunicación ultrarrápida (0ms de latencia local) entre Node.js y el EA de MT5
 * - Servidor REST: GET /orders, POST /orders, POST /trade-closed (Feedback Loop MT5)
 * - Servidor Web Dashboard: http://127.0.0.1:3000
 * - Integrado con PendingOrderManager, AnalyticsEngine y NewsFilter
 */

const http = require('http');
const urlModule = require('url');
const fs = require('fs');
const path = require('path');
const { riskEngine } = require('./core/RiskEngine');
const { pendingOrderManager } = require('./core/PendingOrderManager');
const { analyticsEngine } = require('./core/AnalyticsEngine');
const { newsFilter } = require('./core/NewsFilter');
const { CHANNELS_CONFIG, findChannelConfig } = require('./config/channels.config');
const { marketSnapshotCollector } = require('./core/MarketSnapshotCollector');
const { notificationService } = require('./core/NotificationService');
const { shadowStrategyComparator } = require('./core/ShadowStrategyComparator');
const { proprietaryStrategyManager } = require('./core/ProprietaryStrategyManager');
const { bprStrategyMultiTF } = require('./core/algorithms/BPRInstitutionalMultiTimeframeStrategy');
const { bprStrategyEURUSD } = require('./core/algorithms/BPREurusdMultiTimeframeStrategy');
const { bprStrategyGBPJPY } = require('./core/algorithms/BPRGbpjpyBearishStrategy');
const { bprStrategyNAS100 } = require('./core/algorithms/BPRNas100BullishStrategy');

let pendingOrders = [];
let recentProvisionalOrders = new Map();
let serverStarted = false;
let latestTick = { bid: 0, ask: 0, time: 0 };
const latestTicksBySymbol = new Map();
let evaluationTargetHalted = false;
let primaryAccountId = null;
const recentBridgeDispatches = new Map();

// =====================================================================
// 🏦 REGISTRO MULTI-CUENTA DE TERMINALES MT5
// =====================================================================
const connectedAccounts = new Map();
const ACCOUNTS_CONFIG_PATH = path.join(__dirname, 'config', 'accounts_config.json');
const LAST_ACCOUNTS_CACHE_PATH = path.join(__dirname, 'config', 'last_accounts_cache.json');

function saveAccountsCache() {
  try {
    const cache = {};
    for (const [id, acc] of connectedAccounts.entries()) {
      cache[id] = {
        id: acc.id,
        broker: acc.broker,
        balance: acc.balance,
        equity: acc.equity,
        openPositions: acc.openPositions || 0,
        currency: acc.currency || 'USD'
      };
    }
    fs.writeFileSync(LAST_ACCOUNTS_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (e) {}
}

function getAccountConfig(accountId) {
  try {
    if (fs.existsSync(ACCOUNTS_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(ACCOUNTS_CONFIG_PATH, 'utf-8'));
      if (cfg[accountId]) return cfg[accountId];
    }
  } catch (e) {}
  return null;
}

function getPrimaryAccountId() {
  try {
    if (fs.existsSync(ACCOUNTS_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(ACCOUNTS_CONFIG_PATH, 'utf-8'));
      for (const [id, accCfg] of Object.entries(cfg)) {
        if (accCfg.enabled !== false && accCfg.primary === true) return id;
      }
    }
  } catch (e) {}
  return '1514879094';
}

primaryAccountId = getPrimaryAccountId();

function getOrCreateAccount(accountId, broker = 'Unknown', balance = null, equity = null, openPositions = 0, currency = 'USD') {
  const id = String(accountId || 'default').trim();
  let acc = connectedAccounts.get(id);
  const now = Date.now();
  if (!acc) {
    acc = {
      id,
      broker: (broker && broker !== 'Unknown') ? broker : 'MetaTrader 5',
      balance: (balance !== null && !isNaN(balance) && balance > 0) ? balance : (riskEngine.currentBalance || 5000),
      equity: (equity !== null && !isNaN(equity) && equity > 0) ? equity : (balance || riskEngine.currentBalance || 5000),
      currency: currency || 'USD',
      openPositions: openPositions || 0,
      lastSeen: now,
      evaluationTargetHalted: false,
      initialBalance: null,
      targetProfitBalance: null,
      pendingOrders: []
    };
    connectedAccounts.set(id, acc);
    console.log(`🔌 [Multi-Account] Terminal MT5 vinculada: Cuenta #${id} (${acc.broker}) | Balance: ${acc.balance.toFixed(2)} ${acc.currency}`);
  } else {
    if (broker && broker !== 'Unknown') acc.broker = broker;
    if (balance !== null && !isNaN(balance) && balance > 0) acc.balance = balance;
    if (equity !== null && !isNaN(equity) && equity > 0) acc.equity = equity;
    if (currency) acc.currency = currency;
    if (openPositions !== undefined && !isNaN(openPositions)) acc.openPositions = openPositions;
    acc.lastSeen = now;
  }

  // Detectar configuración explícita o por heurística
  const explicitCfg = getAccountConfig(id);
  const isPersonal = explicitCfg ? (explicitCfg.mode === 'PERSONAL') : (id === '1290919' || /VT\s*Markets/i.test(acc.broker) || (acc.balance < 1000));
  acc.isPersonal = isPersonal;
  acc.maxOpenTrades = explicitCfg?.maxOpenTrades || (isPersonal ? 10 : 2);
  acc.riskPercent = explicitCfg?.riskPercent || (isPersonal ? 2.0 : 0.75);

  // Detectar tramo inicial de evaluación de Prop Firm para el Freno de Meta (+10%)
  if (acc.balance > 0 && !acc.initialBalance) {
    const b = acc.balance;
    if (!isPersonal) {
      if (b >= 4000 && b <= 7000) acc.initialBalance = 5000;
      else if (b >= 8000 && b <= 14000) acc.initialBalance = 10000;
      else if (b >= 20000 && b <= 35000) acc.initialBalance = 25000;
      else if (b >= 40000 && b <= 70000) acc.initialBalance = 50000;
      else if (b >= 80000 && b <= 140000) acc.initialBalance = 100000;
      else if (b >= 160000 && b <= 250000) acc.initialBalance = 200000;
      else acc.initialBalance = b;

      acc.targetProfitBalance = Math.round(acc.initialBalance * 1.10);
    } else {
      acc.initialBalance = b;
      acc.targetProfitBalance = null; // Cuentas de capital propio NO se congelan al +10%
      acc.evaluationTargetHalted = false;
    }
  }

  return acc;
}

function initPreseededAccounts() {
  try {
    let cached = {};
    if (fs.existsSync(LAST_ACCOUNTS_CACHE_PATH)) {
      try { cached = JSON.parse(fs.readFileSync(LAST_ACCOUNTS_CACHE_PATH, 'utf-8')); } catch (e) {}
    }
    if (fs.existsSync(ACCOUNTS_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(ACCOUNTS_CONFIG_PATH, 'utf-8'));
      for (const [id, accCfg] of Object.entries(cfg)) {
        if (accCfg.enabled !== false) {
          const c = cached[id] || {};
          const fallbackBal = id === '1514879094' ? 101280.82 : (id === '12566162' ? 10000 : (id === '26742940' ? 5120.24 : 126.75));
          const bal = (typeof c.balance === 'number' && c.balance > 0) ? c.balance : fallbackBal;
          const broker = c.broker || accCfg.label || 'MetaTrader 5';
          getOrCreateAccount(id, broker, bal, c.equity || bal, c.openPositions || 0, c.currency || 'USD');
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ [Multi-Account] Error precargando cuentas:', e.message);
  }
}

// Pre-sembrar cuentas activas desde el arranque para evitar carreras de reconexión HTTP
initPreseededAccounts();

function getActiveAccounts(maxInactiveMs = 60000) {
  const now = Date.now();
  const active = [];
  for (const acc of connectedAccounts.values()) {
    if (now - acc.lastSeen < maxInactiveMs) {
      active.push(acc);
    }
  }
  if (active.length === 0 && connectedAccounts.size > 0) {
    return Array.from(connectedAccounts.values());
  }
  return active;
}

function broadcastToAllAccounts(orderPayload) {
  pendingOrders.push({ ...orderPayload, id: Date.now() });
  for (const acc of connectedAccounts.values()) {
    acc.pendingOrders.push({
      ...orderPayload,
      id: Date.now() + Math.floor(Math.random() * 1000)
    });
  }
}

function normalizeMarketSymbol(symbol = '') {
  let s = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s === 'GOLD' || s.startsWith('XAU')) return 'XAUUSD';
  return s;
}

function getLatestTick(symbol = '') {
  const normalized = normalizeMarketSymbol(symbol);
  if (normalized) {
    for (const [key, tick] of latestTicksBySymbol.entries()) {
      if (key === normalized || key.includes(normalized) || normalized.includes(key)) {
        return tick;
      }
    }
  }
  return latestTick;
}

// =====================================================================
// 🛡️ MONITOR EN TIEMPO REAL DE AUTO BREAK-EVEN EN TP2 (CANALES TELEGRAM)
// =====================================================================
const activeChannelTrades = [
  // Registrar las posiciones activas abiertas de XAUUSD FOREX TRADING para Auto-BE en TP2 (4120.0)
  {
    id: 1791452000000,
    channelId: '-1002493671900',
    channelName: 'XAUUSD FOREX TRADING',
    symbol: 'XAUUSD',
    action: 'SELL',
    entryPrice: 4129.75,
    tp2: 4120.0,
    tp3: 4115.0,
    beTriggered: false,
    timestamp: Date.now()
  }
];

function registerChannelTrade(plan, originalSignal) {
  if (!plan || !plan.channelId || String(plan.channelId).startsWith('PROPRIETARY')) return;
  const cfg = CHANNELS_CONFIG[plan.channelId] || findChannelConfig(plan.channelId, plan.channelName);
  if (!cfg || !cfg.enabled) return;

  const beTrigger = plan.breakEvenTrigger || cfg.breakEvenTrigger;
  if (!beTrigger) return;

  const normSym = normalizeMarketSymbol(plan.symbol || 'XAUUSD');
  const isBuy = (plan.action || plan.orderType || 'BUY').toUpperCase().includes('BUY');
  const entryP = typeof plan.entryPrice === 'number' && plan.entryPrice > 0 ? plan.entryPrice : null;
  const tp2P = plan.tp2 || originalSignal?.tp2 || null;

  if (!tp2P) return;

  // Evitar duplicados inmediatos en la misma ventana de 5 minutos
  const existing = activeChannelTrades.find(t => 
    t.channelId === plan.channelId && 
    normalizeMarketSymbol(t.symbol) === normSym &&
    !t.beTriggered &&
    (Date.now() - t.timestamp < 300000)
  );
  if (existing) return;

  activeChannelTrades.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    channelId: plan.channelId,
    channelName: plan.channelName || cfg.name || 'Canal',
    symbol: plan.symbol || 'XAUUSD',
    action: isBuy ? 'BUY' : 'SELL',
    entryPrice: entryP,
    tp2: tp2P,
    tp3: plan.targetTP || plan.tp || null,
    beTriggered: false,
    timestamp: Date.now()
  });

  console.log(`🛡️ [Auto-BE Monitor Registrado] Canal: "${plan.channelName || cfg.name}" | Par: ${plan.symbol} (${isBuy ? 'BUY' : 'SELL'}) | TP2 Trigger: ${tp2P} | Target: ${plan.targetTP || 'TP3'}`);
}

function checkChannelTradesAutoBE(tick) {
  if (!tick || !tick.symbol || !tick.bid || !tick.ask) return;
  const symNorm = normalizeMarketSymbol(tick.symbol);
  const now = Date.now();

  for (const trade of activeChannelTrades) {
    if (trade.beTriggered) continue;
    // Purgar trades de más de 48h
    if (now - trade.timestamp > 48 * 3600 * 1000) {
      trade.beTriggered = true;
      continue;
    }

    if (normalizeMarketSymbol(trade.symbol) !== symNorm) continue;

    let hitTP2 = false;
    if (trade.action === 'BUY') {
      if (trade.tp2 && tick.bid >= trade.tp2) {
        hitTP2 = true;
      }
    } else if (trade.action === 'SELL') {
      if (trade.tp2 && tick.ask <= trade.tp2) {
        hitTP2 = true;
      }
    }

    if (hitTP2) {
      trade.beTriggered = true;
      console.log(`\n======================================================`);
      console.log(`🛡️ [AUTO-BE EN TP2 ACTIVADO] Canal "${trade.channelName}" (${trade.symbol} ${trade.action})`);
      console.log(`   🎯 TP2 (${trade.tp2}) alcanzado con precio actual: ${trade.action === 'BUY' ? tick.bid : tick.ask}`);
      console.log(`   🚀 Moviendo Stop Loss a Precio de Entrada (Break-Even) en todas las cuentas MT5...`);
      console.log(`======================================================\n`);

      const beModItem = {
        id: Date.now(),
        symbol: trade.symbol,
        action: 'MODIFY',
        modifyType: 'BREAK_EVEN',
        entryPrice: trade.entryPrice || 0,
        comment: `Auto-BE TP2 by ${trade.channelName}`,
        timestamp: Date.now()
      };
      broadcastToAllAccounts(beModItem);

      notificationService.notifyBreakEven(trade.symbol, trade.channelName, trade.entryPrice || 'Entrada (TP2 Hit)').catch(() => {});
    }
  }
}

/**
 * Conecta el PendingOrderManager para despachar cancelaciones automáticas a MT5
 */
pendingOrderManager.setCancelDispatcher(async (cancelPayload) => {
  const cancelOrder = {
    id: Date.now(),
    symbol: cancelPayload.symbol || 'XAUUSD',
    action: cancelPayload.action || 'CANCEL_ALL_PENDING',
    targetType: cancelPayload.targetType || 'ALL',
    volume: 0,
    sl: 0,
    tp: 0,
    comment: 'Auto-cancel expired order'
  };
  broadcastToAllAccounts(cancelOrder);
  console.log(`📤 [MT5 Bridge] Orden de cancelación puesta en cola para todas las cuentas MT5 (${cancelOrder.action} - ${cancelOrder.symbol})`);
});

// Iniciar vigilante de expiración de órdenes pendientes
pendingOrderManager.start();

// Vigilante continuo de Escudos Horarios (Daily NY Close, Friday Close Guard y Rollover Shield)
let dailyCloseExecutedDate = null;
let fridayGuardExecuted = false;
let rolloverNotified = false;

function startShieldWatchdog() {
  setInterval(() => {
    // 0. Chequeo Daily NY Close Guard (Lunes a Jueves 21:45 CET - No Overnight Holding)
    const isDailyClose = riskEngine.isDailyCloseWindow();
    const todayStr = new Date().toISOString().split('T')[0];
    if (isDailyClose) {
      if (dailyCloseExecutedDate !== todayStr) {
        dailyCloseExecutedDate = todayStr;
        console.log('\n🔒 [DAILY NY CLOSE GUARD ACTIVO] Cierre diario preventivo No-Overnight para MT5...');
        broadcastToAllAccounts({
          id: Date.now(),
          symbol: 'ALL',
          action: 'CLOSE_ALL_MARKET',
          volume: 0,
          sl: 0,
          tp: 0,
          comment: 'Daily NY Close Guard'
        });
        broadcastToAllAccounts({
          id: Date.now() + 1,
          symbol: 'ALL',
          action: 'CANCEL_ALL_PENDING',
          targetType: 'ALL',
          volume: 0,
          sl: 0,
          tp: 0,
          comment: 'Daily NY Close Guard'
        });
        notificationService.notifyDailyClose(true).catch(() => {});
      }
    }

    // 1. Chequeo Friday Close Guard (Viernes 21:30 CET a Domingo 23:00 CET)
    const isFridayClose = riskEngine.isFridayCloseWindow();
    if (isFridayClose) {
      if (!fridayGuardExecuted) {
        fridayGuardExecuted = true;
        console.log('\n🔒 [FRIDAY CLOSE GUARD ACTIVO] Cierre preventivo de fin de semana para MT5...');
        broadcastToAllAccounts({
          id: Date.now(),
          symbol: 'ALL',
          action: 'CLOSE_ALL_MARKET',
          volume: 0,
          sl: 0,
          tp: 0,
          comment: 'Friday Close Guard'
        });
        broadcastToAllAccounts({
          id: Date.now() + 1,
          symbol: 'ALL',
          action: 'CANCEL_ALL_PENDING',
          targetType: 'ALL',
          volume: 0,
          sl: 0,
          tp: 0,
          comment: 'Friday Close Guard'
        });
        notificationService.notifyFridayClose(true).catch(() => {});
      }
    } else {
      if (fridayGuardExecuted) {
        fridayGuardExecuted = false;
        console.log('☀️ [WEEKEND REOPEN] Fin de semana concluido. Operativa regular restablecida.');
      }
    }

    // 2. Notificación Rollover Shield (22:55 - 00:10 CET)
    const isRollover = riskEngine.isRolloverWindow();
    if (isRollover && !rolloverNotified) {
      rolloverNotified = true;
      notificationService.notifyRolloverShield(true).catch(() => {});
    } else if (!isRollover && rolloverNotified) {
      rolloverNotified = false;
      notificationService.notifyRolloverShield(false).catch(() => {});
    }
  }, 15000);
}

startShieldWatchdog();

// =====================================================================
// ⏱️ MONITOR PERIÓDICO CADA 10 MINUTOS (OPERACIONES VIVAS CUENTA REAL)
// =====================================================================
const PERIODIC_REPORT_ACCOUNTS = new Set(['34614465']);
const PERIODIC_REPORT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos
const lastPeriodicReportTimes = new Map();

function checkAndSendPeriodicAccountReport(acc) {
  if (!acc || !acc.id) return;
  const accCfg = getAccountConfig(acc.id);
  const shouldReport = PERIODIC_REPORT_ACCOUNTS.has(acc.id) || (accCfg && accCfg.sendPeriodicUpdate);
  if (!shouldReport) return;

  // Solo enviar SIEMPRE que haya al menos 1 operación activa
  const openPos = typeof acc.openPositions === 'number' ? acc.openPositions : 0;
  if (openPos <= 0) return;

  const now = Date.now();
  const lastTime = lastPeriodicReportTimes.get(acc.id) || 0;
  if (now - lastTime < PERIODIC_REPORT_INTERVAL_MS) return;

  lastPeriodicReportTimes.set(acc.id, now);

  const bal = acc.balance || 0;
  const eq = acc.equity || bal;
  const floating = eq - bal;
  const floatingEmoji = floating >= 0 ? '🟢' : '🔴';
  const floatingSign = floating >= 0 ? '+' : '';
  const nowTimeStr = new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });

  const msg = [
    `📊 *ACTUALIZACIÓN PERIÓDICA (Cuenta Real #${acc.id})*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 *Balance:* \`$${bal.toFixed(2)} ${acc.currency}\``,
    `📈 *Equidad:* \`$${eq.toFixed(2)} ${acc.currency}\``,
    `${floatingEmoji} *Flotante Vivo:* \`${floatingSign}$${floating.toFixed(2)} ${acc.currency}\``,
    `🎯 *Operaciones Vivas:* \`${openPos}\``,
    `🏦 *Broker:* ${acc.broker}`,
    `⏱️ *Hora:* ${nowTimeStr} CET`,
    `━━━━━━━━━━━━━━━━━━━━`
  ].join('\n');

  console.log(`\n📢 [Reporte Periódico 10m] Enviando actualización de Cuenta #${acc.id} a Telegram...`);
  notificationService.send(msg).catch(err => {
    console.error(`⚠️ Error enviando reporte periódico a Telegram:`, err.message);
  });
}

let activePort = null;

/**
 * Inicia el servidor HTTP local para conectar con MT5 y servir el Dashboard
 */
function startLocalServer(port = 3000) {
  if (serverStarted && activePort === port) return;
  activePort = port;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const parsedUrl = urlModule.parse(req.url, true);

    // 1. Dashboard Visual (GET / o GET /dashboard)
    if ((parsedUrl.pathname === '/' || parsedUrl.pathname === '/dashboard') && req.method === 'GET') {
      const htmlPath = path.join(__dirname, 'public', 'dashboard.html');
      if (fs.existsSync(htmlPath)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.writeHead(200);
        return res.end(fs.readFileSync(htmlPath, 'utf-8'));
      }
    }

    // 2. API de Estado en Vivo para el Dashboard (GET /api/status)
    if (parsedUrl.pathname === '/api/status' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      const upcomingNews = await newsFilter.getUpcomingEvents(5);

      let totalWins = 0;
      let totalLosses = 0;
      let totalPips = 0;

      const channelsData = Object.entries(CHANNELS_CONFIG).map(([id, cfg]) => {
        const metrics = analyticsEngine.getChannelMetrics(id);
        totalWins += metrics.winCount;
        totalLosses += metrics.lossCount;
        totalPips += parseFloat(metrics.pipsGained || 0);

        return {
          id,
          name: cfg.name,
          strategy: cfg.strategy,
          enabled: !!cfg.enabled,
          totalSignals: metrics.totalSignals,
          winCount: metrics.winCount,
          lossCount: metrics.lossCount,
          winRate: metrics.winRate,
          pipsGained: metrics.pipsGained,
          status: metrics.status
        };
      });

      const totalResolved = totalWins + totalLosses;
      const globalWinRate = totalResolved > 0 ? `${((totalWins / totalResolved) * 100).toFixed(1)}%` : '0.0%';

      const accountsData = Array.from(connectedAccounts.values()).map(a => ({
        id: a.id,
        broker: a.broker,
        balance: a.balance,
        equity: a.equity,
        openPositions: a.openPositions,
        lastSeenSecondsAgo: Math.round((Date.now() - a.lastSeen) / 1000),
        isOnline: (Date.now() - a.lastSeen) < 15000,
        targetHalted: a.evaluationTargetHalted,
        initialBalance: a.initialBalance,
        targetProfitBalance: a.targetProfitBalance,
        goldLot: riskEngine.calculateLotSize(null, null, 'XAUUSD', false, a.balance)
      }));

      const payload = {
        balance: riskEngine.currentBalance,
        mode: riskEngine.config.MODE,
        riskPercent: riskEngine.currentRiskPercent,
        tick: latestTick,
        tickEURUSD: latestTicksBySymbol.get('EURUSD') || null,
        ticks: Object.fromEntries(latestTicksBySymbol),
        totalResolved,
        globalWinRate,
        totalPips,
        dailyPnL: riskEngine.dailyPnL,
        dailyPnLPercent: riskEngine.dailyPnLPercent,
        dailyTargetProfitUSD: riskEngine.dailyTargetProfitUSD,
        dailyMaxLossUSD: riskEngine.dailyMaxLossUSD,
        tradingPaused: riskEngine.tradingPaused,
        pauseReason: riskEngine.pauseReason,
        channels: channelsData,
        news: upcomingNews,
        accounts: accountsData
      };

      res.writeHead(200);
      return res.end(JSON.stringify(payload));
    }

    // 3. API para Circuito de Stop Trading / Metas Diarias
    if (parsedUrl.pathname === '/api/circuit-breaker' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const { targetProfit, maxLoss, togglePause } = JSON.parse(body);
          if (typeof targetProfit === 'number' || typeof maxLoss === 'number') {
            riskEngine.setDailyTargets({ targetProfitUSD: targetProfit, maxLossUSD: maxLoss });
          }
          if (typeof togglePause === 'boolean') {
            riskEngine.setTradingPaused(togglePause, togglePause ? 'Pausado manualmente desde el Dashboard' : '');
          }
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            tradingPaused: riskEngine.tradingPaused,
            dailyTargetProfitUSD: riskEngine.dailyTargetProfitUSD,
            dailyMaxLossUSD: riskEngine.dailyMaxLossUSD
          }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'JSON Invalido' }));
        }
      });
      return;
    }

    // 4. API para Comparativa de Estrategias en la Sombra
    if (parsedUrl.pathname === '/api/shadow-comparison' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        summary: shadowStrategyComparator.summary,
        history: shadowStrategyComparator.history
      }, null, 2));
    }

    // 4b. API para Estrategia Algorítmica Institucional BPR Multi-TF (XAUUSD)
    // 4b. API Unificada para Radar Institucional BPR (Todos los 7 pares activos)
    if (parsedUrl.pathname === '/api/institutional-radar' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      const radarPairs = proprietaryStrategyManager.entries.map(entry => {
        const strat = entry.strategy;
        const livePrice = latestTicksBySymbol.get(entry.symbol)?.bid || (entry.symbol === 'XAUUSD' ? (latestTick.bid || latestTick.ask) : 0);
        const checklist = typeof strat.getConfirmationChecklist === 'function' ? strat.getConfirmationChecklist(livePrice, 'M5') : {};
        return {
          id: entry.id,
          name: entry.name,
          symbol: entry.symbol,
          livePrice,
          liveExecution: strat.isLiveExecution,
          checklist,
          activeTrades: strat.activeTrades || [],
          activeZones: (strat.bprZones || []).filter(z => z.active),
          metrics: typeof strat.getStatus === 'function' ? strat.getStatus().metrics : null
        };
      });
      res.writeHead(200);
      return res.end(JSON.stringify({ pairs: radarPairs }, null, 2));
    }

    // 4c. Endpoints de compatibilidad para Dashboard (Mapeados al motor institucional unificado)
    if (parsedUrl.pathname === '/api/bpr-strategy' && req.method === 'GET') {
      const entry = proprietaryStrategyManager.entries.find(e => e.symbol === 'XAUUSD');
      const strat = entry ? entry.strategy : bprStrategyMultiTF;
      const livePrice = latestTicksBySymbol.get('XAUUSD')?.bid || latestTick.bid || latestTick.ask || 0;
      const checklist = typeof strat.getConfirmationChecklist === 'function' ? strat.getConfirmationChecklist(livePrice, 'M5') : {};
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: strat.name,
        symbol: 'XAUUSD',
        activeTrades: strat.activeTrades || [],
        checklist,
        history: strat.history ? strat.history.slice(-15) : []
      }, null, 2));
    }

    if (parsedUrl.pathname === '/api/bpr-eurusd' && req.method === 'GET') {
      const entry = proprietaryStrategyManager.entries.find(e => e.symbol === 'EURUSD');
      const strat = entry ? entry.strategy : bprStrategyEURUSD;
      const livePrice = latestTicksBySymbol.get('EURUSD')?.bid || 0;
      const chk = typeof strat.getConfirmationChecklist === 'function' ? strat.getConfirmationChecklist(livePrice) : {};
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: strat.name,
        symbol: 'EURUSD',
        activeTrades: strat.activeTrades || [],
        checklist: { M5: chk, M2: { ...chk, timeframe: 'M2' } },
        history: strat.history ? strat.history.slice(-15) : []
      }, null, 2));
    }

    if (parsedUrl.pathname === '/api/bpr-gbpjpy' && req.method === 'GET') {
      const entry = proprietaryStrategyManager.entries.find(e => e.symbol === 'GBPJPY');
      const strat = entry ? entry.strategy : bprStrategyGBPJPY;
      const livePrice = latestTicksBySymbol.get('GBPJPY')?.bid || 0;
      const chk = typeof strat.getConfirmationChecklist === 'function' ? strat.getConfirmationChecklist(livePrice) : {};
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: strat.name,
        symbol: 'GBPJPY',
        activeTrades: strat.activeTrades || [],
        checklist: { M5: chk, M2: { ...chk, timeframe: 'M2' } },
        history: strat.history ? strat.history.slice(-15) : []
      }, null, 2));
    }

    if (parsedUrl.pathname === '/api/bpr-nas100' && req.method === 'GET') {
      const livePrice = latestTicksBySymbol.get('NAS100')?.bid || 0;
      const chk = typeof bprStrategyNAS100.getConfirmationChecklist === 'function' ? bprStrategyNAS100.getConfirmationChecklist(livePrice) : {};
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: bprStrategyNAS100.name,
        symbol: 'NAS100',
        activeTrades: bprStrategyNAS100.activeTrades || [],
        checklist: { M5: chk },
        history: bprStrategyNAS100.history ? bprStrategyNAS100.history.slice(-15) : []
      }, null, 2));
    }

    // 4. API para Activar/Desactivar Canales desde el Dashboard
    if (parsedUrl.pathname === '/api/channels/toggle' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const { channelId, enabled } = JSON.parse(body);
          if (CHANNELS_CONFIG[channelId]) {
            CHANNELS_CONFIG[channelId].enabled = !!enabled;
            console.log(`🎚️ [Canal Modificado]: "${CHANNELS_CONFIG[channelId].name}" -> ${enabled ? 'ACTIVADO' : 'PAUSADO'}`);
          }
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'JSON Invalido' }));
        }
      });
      return;
    }

    // 4c. API para Disparar Orden de Prueba Multi-Cuenta (GET /api/send-test-trade)
    if (parsedUrl.pathname === '/api/send-test-trade' && (req.method === 'GET' || req.method === 'POST')) {
      const ask = (latestTick && latestTick.ask) ? latestTick.ask : 2650.0;
      const testPlan = {
        valid: true,
        symbol: 'XAUUSD',
        action: 'BUY',
        orderType: 'BUY',
        entryPrice: ask,
        slPrice: parseFloat((ask - 5.0).toFixed(2)),
        targetTP: parseFloat((ask + 10.0).toFixed(2)),
        channelName: 'TEST_ROUTING',
        channelId: 'test_routing',
        comment: 'TEST_MULTI_ACC',
        bypassTimeShields: true
      };
      await executeTradePlan(testPlan, null, { bypassTimeShields: true });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        message: 'Orden de prueba Buy enviada a todas las cuentas MT5 conectadas',
        plan: testPlan
      }, null, 2));
    }

    // 4c2. API para Forzar Envío Manual de Señal Marco (GET o POST /api/execute-marco)
    if (parsedUrl.pathname === '/api/execute-marco' && (req.method === 'GET' || req.method === 'POST')) {
      const bid = (latestTick && latestTick.bid) ? latestTick.bid : (latestTicksBySymbol.get('XAUUSD')?.bid || 4122.5);
      const marcoPlan = {
        valid: true,
        symbol: 'XAUUSD',
        action: 'SELL',
        orderType: 'SELL',
        entryPrice: bid,
        slPrice: 4130.0,
        targetTP: 4104.0, // TP3 preferido
        tp1: 4112.0,
        tp2: 4108.0,
        breakEvenTrigger: 'TP2',
        channelName: 'MARCO TRADING HUB',
        channelId: '-1002157727490',
        comment: 'MARCO_GOLD_SELL',
        bypassTimeShields: true
      };
      const ok = await executeTradePlan(marcoPlan, null, { bypassTimeShields: true });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: ok,
        message: ok ? 'Señal de Marco SELL GOLD despachada exitosamente a todas las cuentas MT5' : 'Filtro de seguridad impidió el despacho',
        plan: marcoPlan
      }, null, 2));
    }

    // 4c3. API para Ejecutar Señal Exness Gold Trader (GET o POST /api/execute-exness)
    if (parsedUrl.pathname === '/api/execute-exness' && (req.method === 'GET' || req.method === 'POST')) {
      const mode = parsedUrl.query.mode || 'limit'; // 'limit' o 'market'
      const ask = (latestTick && latestTick.ask) ? latestTick.ask : (latestTicksBySymbol.get('XAUUSD')?.ask || 4124.5);
      const isLimit = mode === 'limit';
      const entryPrice = isLimit ? 4120.0 : ask;

      const exnessPlan = {
        valid: true,
        symbol: 'XAUUSD',
        action: isLimit ? 'BUY LIMIT' : 'BUY',
        orderType: isLimit ? 'BUY LIMIT' : 'BUY',
        entryPrice: entryPrice,
        slPrice: 4107.0,
        targetTP: 4139.0, // TP3 oficial
        tp1: 4123.0,
        tp2: 4126.0,
        breakEvenTrigger: 'TP2',
        channelName: 'EXNESS GOLD TRADER',
        channelId: '-1004339716486',
        comment: isLimit ? 'EXNESS_BUY_LIMIT' : 'EXNESS_BUY_MARKET',
        isPendingOrder: isLimit,
        isGrid: false,
        orders: isLimit ? [{
          symbol: 'XAUUSD',
          action: 'BUY LIMIT',
          entryPrice: 4120.0,
          sl: 4107.0,
          tp: 4139.0,
          volume: 0.01,
          comment: 'Pending EXNESS TP3'
        }] : undefined,
        bypassTimeShields: true
      };

      const ok = await executeTradePlan(exnessPlan, null, { bypassTimeShields: true });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: ok,
        message: ok ? `Señal de Exness BUY GOLD (${mode.toUpperCase()}) despachada exitosamente a todas las cuentas MT5` : 'Filtro de seguridad impidió el despacho',
        plan: exnessPlan
      }, null, 2));
    }

    // 4c4. API para Enviar/Reintentar Orden Específica a una Cuenta Concreta (GET o POST /api/resend-to-account)
    if (parsedUrl.pathname === '/api/resend-to-account' && (req.method === 'GET' || req.method === 'POST')) {
      const targetAccId = parsedUrl.query.account ? String(parsedUrl.query.account).trim() : '1514879094';
      const acc = connectedAccounts.get(targetAccId);
      if (!acc) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(404);
        return res.end(JSON.stringify({ error: `Cuenta #${targetAccId} no encontrada en cuentas conectadas` }));
      }

      const orderType = parsedUrl.query.type || 'BUY LIMIT';
      const price = parseFloat(parsedUrl.query.price || '4120.0');
      const sl = parseFloat(parsedUrl.query.sl || '4107.0');
      const tp = parseFloat(parsedUrl.query.tp || '4139.0');
      const symbol = parsedUrl.query.symbol || 'XAUUSD';
      const lot = riskEngine.calculateLotSize(price, sl, symbol, false, acc.balance || 100000);

      const orderItem = {
        id: Date.now(),
        symbol: symbol,
        action: orderType,
        entryPrice: price,
        sl: sl,
        tp: tp,
        volume: lot,
        comment: 'RETRY EXNESS FTMO',
        ttlMinutes: 30,
        timestamp: Date.now()
      };

      acc.pendingOrders = acc.pendingOrders || [];
      acc.pendingOrders.push(orderItem);

      console.log(`\n🎯 [Reintento Específico] Despachando orden ${orderType} ${lot}L a Cuenta #${targetAccId} (${acc.broker}) tras activar Algo Trading...`);

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        message: `Orden ${orderType} (${lot} lotes) puesta en cola exitosamente para Cuenta #${targetAccId} (${acc.broker})`,
        order: orderItem
      }, null, 2));
    }

    // 4c. API para Exportar Barras M5 de los 5 Pares (GET /api/export-bars)
    if (parsedUrl.pathname === '/api/export-bars' && (req.method === 'GET' || req.method === 'POST')) {
      broadcastToAllAccounts({
        id: Date.now(),
        symbol: 'ALL',
        action: 'EXPORT_BARS',
        timestamp: Date.now()
      });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        message: 'Comando EXPORT_BARS enviado a todas las terminales MT5 conectadas'
      }, null, 2));
    }

    // 4d. API para Cerrar Todas las Posiciones de Prueba (GET /api/close-all)
    if (parsedUrl.pathname === '/api/close-all' && (req.method === 'GET' || req.method === 'POST')) {
      broadcastToAllAccounts({
        id: Date.now(),
        symbol: 'ALL',
        action: 'CLOSE_ALL_MARKET',
        volume: 0,
        sl: 0,
        tp: 0,
        comment: 'Manual Close All'
      });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        message: 'Comando CLOSE_ALL_MARKET enviado a todas las cuentas MT5 conectadas'
      }, null, 2));
    }

    // 4d2. API para Cerrar Posiciones de un Símbolo Específico (GET /api/close-symbol?symbol=nas100)
    if (parsedUrl.pathname === '/api/close-symbol' && (req.method === 'GET' || req.method === 'POST')) {
      const targetSym = parsedUrl.query.symbol || 'nas100';
      broadcastToAllAccounts({
        id: Date.now(),
        symbol: targetSym,
        action: 'CLOSE_ALL_MARKET',
        volume: 0,
        sl: 0,
        tp: 0,
        comment: `Emergency Close ${targetSym}`
      });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        success: true,
        message: `Comando CLOSE_ALL_MARKET para símbolo ${targetSym} enviado a todas las cuentas MT5 conectadas`
      }, null, 2));
    }

    // 4. Endpoint GET /orders (Consulta del EA de MT5)
    if (parsedUrl.pathname === '/orders' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');

      const accountId = parsedUrl.query.account ? String(parsedUrl.query.account).trim() : 'default';
      const broker = parsedUrl.query.broker ? String(parsedUrl.query.broker).trim() : 'Unknown';
      const liveBal = parsedUrl.query.balance ? parseFloat(parsedUrl.query.balance) : null;
      const liveEq = parsedUrl.query.equity ? parseFloat(parsedUrl.query.equity) : null;
      const openPos = parsedUrl.query.openPositions !== undefined ? parseInt(parsedUrl.query.openPositions, 10) : 0;
      const riskPos = parsedUrl.query.riskPositions !== undefined ? parseInt(parsedUrl.query.riskPositions, 10) : openPos;

      const acc = getOrCreateAccount(accountId, broker, liveBal, liveEq, openPos);
      acc.riskPositions = riskPos;

      // Designar cuenta principal (la primera en conectar) para las métricas globales del Dashboard
      if (!primaryAccountId || primaryAccountId === 'default') {
        if (accountId !== 'default') {
          primaryAccountId = accountId;
          console.log(`⭐ [Multi-Account] Cuenta #${accountId} (${acc.broker}) designada como Cuenta Principal del Dashboard.`);
        }
      }

      // Balance real reportado por el EA: solo la cuenta principal actualiza el balance global en riskEngine
      // para evitar colisiones de tamaño entre cuentas simultáneas (ej: 5k vs 100k)
      if (liveBal && !isNaN(liveBal) && liveBal > 0) {
        if (accountId === primaryAccountId || !primaryAccountId || accountId === 'default') {
          riskEngine.currentBalance = liveBal;
          // Si breakEvenSlotRelease está activo, solo las operaciones sin BE ocupan slot
          const effectivePositions = (riskEngine.config.PROP_FIRM && riskEngine.config.PROP_FIRM.breakEvenSlotRelease)
            ? riskPos
            : openPos;
          riskEngine.activePositionsCount = effectivePositions;
        }
        saveAccountsCache();

        // ⏱️ Reporte periódico cada 10 min de operaciones vivas a Telegram (Cuenta Real)
        checkAndSendPeriodicAccountReport(acc);

        // 🎯 FRENO DE META CUMPLIDA POR CUENTA (10% de ganancia en cuentas de evaluación de Prop Firms)
        if (!acc.isPersonal && acc.targetProfitBalance && acc.balance >= acc.targetProfitBalance && !acc.evaluationTargetHalted) {
          acc.evaluationTargetHalted = true;
          const msg = `🎉 [EXAMEN APROBADO] Cuenta #${acc.id} (${acc.broker}) alcanzó $${acc.balance.toFixed(2)} USD (Meta $${acc.targetProfitBalance.toFixed(2)} / +10%). Operativa congelada.`;
          console.log(`\n🎉🎉🎉 [PROP FIRM TARGET ALCANZADO]: ${msg}\n`);
          acc.pendingOrders.push({
            id: Date.now(),
            symbol: 'ALL',
            action: 'CLOSE_ALL_MARKET',
            volume: 0,
            sl: 0,
            tp: 0,
            comment: `Evaluation Target Reached (${acc.targetProfitBalance.toFixed(2)} USD)`
          });
          acc.pendingOrders.push({
            id: Date.now() + 1,
            symbol: 'ALL',
            action: 'CANCEL_ALL_PENDING',
            targetType: 'ALL',
            volume: 0,
            sl: 0,
            tp: 0,
            comment: `Evaluation Target Reached (${acc.targetProfitBalance.toFixed(2)} USD)`
          });
          notificationService.notifyCircuitBreaker(
            `¡EXAMEN PROP FIRM APROBADO! Cuenta #${acc.id} alcanzó $${acc.balance.toFixed(2)} USD (Meta $${acc.targetProfitBalance.toFixed(2)} USD). Congelada para proteger la cuenta.`,
            riskEngine.dailyPnL,
            acc.balance
          ).catch(() => {});
        }
      }

      if (parsedUrl.query.bid && parsedUrl.query.ask) {
        const bid = parseFloat(parsedUrl.query.bid);
        const ask = parseFloat(parsedUrl.query.ask);
        const symbol = parsedUrl.query.symbol ? String(parsedUrl.query.symbol).trim() : '';
        const pdh = parsedUrl.query.pdh ? parseFloat(parsedUrl.query.pdh) : 0;
        const pdl = parsedUrl.query.pdl ? parseFloat(parsedUrl.query.pdl) : 0;
        if (!isNaN(bid) && bid > 0 && !isNaN(ask) && ask > 0) {
          latestTick = { 
            bid, 
            ask, 
            symbol, 
            pdh: !isNaN(pdh) ? pdh : 0, 
            pdl: !isNaN(pdl) ? pdl : 0, 
            time: Date.now() 
          };
          if (symbol) {
            latestTicksBySymbol.set(normalizeMarketSymbol(symbol), latestTick);
          }
          // Alimentar motores algoritmicos propietarios por simbolo en tiempo real
          try {
            proprietaryStrategyManager.processTick(latestTick);
          } catch (e) {
            // Ignorar silenciosamente para no interrumpir el puente
          }
          checkChannelTradesAutoBE(latestTick);
        }
      }

      // Procesar lote multi-símbolo enviado por el EA (ej. &ticks=XAUUSD:2650.1:2650.3:2660.0:2640.0|EURUSD:1.1234:1.1235:1.1300:1.1200|...)
      if (parsedUrl.query.ticks) {
        const tickBatches = String(parsedUrl.query.ticks).split('|');
        for (const rawItem of tickBatches) {
          const parts = rawItem.split(':');
          if (parts.length >= 3) {
            const sym = parts[0].trim();
            const b = parseFloat(parts[1]);
            const a = parseFloat(parts[2]);
            const symPDH = parts.length >= 4 ? parseFloat(parts[3]) : 0;
            const symPDL = parts.length >= 5 ? parseFloat(parts[4]) : 0;
            if (sym && !isNaN(b) && b > 0 && !isNaN(a) && a > 0) {
              const multiTick = { 
                bid: b, 
                ask: a, 
                symbol: sym, 
                pdh: !isNaN(symPDH) ? symPDH : 0, 
                pdl: !isNaN(symPDL) ? symPDL : 0, 
                time: Date.now() 
              };
              latestTicksBySymbol.set(normalizeMarketSymbol(sym), multiTick);
              try {
                proprietaryStrategyManager.processTick(multiTick);
              } catch (e) {}
              checkChannelTradesAutoBE(multiTick);
            }
          }
        }
      }

      const now = Date.now();
      let activeOrders = (acc.pendingOrders || []).filter(o => !o.timestamp || (now - o.timestamp) < 30000);
      acc.pendingOrders = [];

      // Si la terminal no envió id de cuenta, despachar de la cola global de respaldo
      if (accountId === 'default' && pendingOrders.length > 0) {
        activeOrders.push(...pendingOrders.filter(o => !o.timestamp || (now - o.timestamp) < 30000));
        pendingOrders = [];
      }

      if (activeOrders.length > 0) {
        const payload = JSON.stringify(activeOrders);
        console.log(`📡 [Servidor Local] Despachando ${activeOrders.length} orden(es) a Cuenta #${accountId} (${acc.broker})...`);
        res.writeHead(200);
        return res.end(payload);
      } else {
        res.writeHead(200);
        return res.end('[]');
      }
    }

    // 5. Endpoint POST /trade-closed (FEEDBACK LOOP: Recibe notificaciones de cierre de MT5)
    if (parsedUrl.pathname === '/trade-closed' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { account, broker, position, symbol, profit, outcome, comment, balance: reportedBalance, equity: reportedEquity } = data;
          
          if (account) {
            const acc = getOrCreateAccount(account, broker, parseFloat(reportedBalance), parseFloat(reportedEquity));
            if (reportedBalance !== undefined && !isNaN(parseFloat(reportedBalance)) && parseFloat(reportedBalance) > 0) {
              acc.balance = parseFloat(reportedBalance);
            }
            if (reportedEquity !== undefined && !isNaN(parseFloat(reportedEquity)) && parseFloat(reportedEquity) > 0) {
              acc.equity = parseFloat(reportedEquity);
            }
          }
          if (reportedBalance !== undefined && !isNaN(parseFloat(reportedBalance)) && parseFloat(reportedBalance) > 0) {
            if (!primaryAccountId || account === primaryAccountId) {
              riskEngine.currentBalance = parseFloat(reportedBalance);
            }
          }
          let targetChannelId = comment || 'MT5';
          if (comment) {
            const chCfg = findChannelConfig(comment, comment);
            if (chCfg && chCfg.id) targetChannelId = chCfg.id;
          }

          const pipsEst = typeof data.pips === 'number' ? data.pips : Math.abs(profit || 0) * 10.0;
          // Registrar en el motor de analíticas y snapshots
          analyticsEngine.recordOutcome(targetChannelId, outcome || (profit >= 0 ? 'WIN' : 'LOSS'), pipsEst, position);
          marketSnapshotCollector.resolveSnapshot(targetChannelId, outcome || (profit >= 0 ? 'WIN' : 'LOSS'), pipsEst, profit);
          
          // Marcar operación en monitor Auto-BE como finalizada
          if (comment || targetChannelId) {
            const closedTrade = activeChannelTrades.find(t => 
              (t.channelId === targetChannelId || t.channelName === comment) &&
              normalizeMarketSymbol(t.symbol) === normalizeMarketSymbol(symbol) &&
              !t.beTriggered
            );
            if (closedTrade) closedTrade.beTriggered = true;
          }
          
          // Registro en la sombra: Opción 1 (Mañana 100% TP2) vs Opción 2 (Actual 50/50) vs Opción 3 (70/30)
          const matchedSnapshot = marketSnapshotCollector.snapshots.slice().reverse().find(s => s.channel && s.channel.id === targetChannelId);
          shadowStrategyComparator.recordTradeClosed({
            position,
            symbol: symbol || 'XAUUSD',
            profit,
            outcome: outcome || (profit >= 0 ? 'WIN' : 'LOSS'),
            comment,
            pips: pipsEst,
            channelName: targetChannelId
          }, matchedSnapshot);
          console.log(`\n🎉 [FEEDBACK LOOP MT5] Cuenta #${account || 'MT5'} (${broker || 'Broker'}) | Posición #${position} cerrada para canal [${targetChannelId}]: ${profit >= 0 ? 'WIN ✅' : 'LOSS ❌'} (${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} USD).`);

          // Notificación Push al móvil con desglose de todas las cuentas conectadas
          const allAccSnapshot = Array.from(connectedAccounts.values()).map(a => {
            const cfg = getAccountConfig(a.id);
            return {
              id: a.id,
              broker: a.broker,
              balance: a.balance || 0,
              equity: a.equity || a.balance || 0,
              label: cfg?.label || `Cuenta #${a.id} (${a.broker})`
            };
          });

          notificationService.notifyTradeClosed({
            position,
            symbol: symbol || 'XAUUSD',
            outcome: outcome || (profit >= 0 ? 'WIN' : 'LOSS'),
            profitUSD: profit || 0,
            pips: pipsEst,
            balance: riskEngine.currentBalance,
            channelName: targetChannelId,
            allAccounts: allAccSnapshot
          }).catch(() => {});

          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Error procesando cierre' }));
        }
      });
      return;
    }

    // 6. Endpoint POST /orders (Ingreso manual/externo de órdenes)
    if (req.url === '/orders' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const newOrders = JSON.parse(body);
          if (Array.isArray(newOrders)) {
            newOrders.forEach(o => broadcastToAllAccounts(o));
          } else {
            broadcastToAllAccounts(newOrders);
          }
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, count: pendingOrders.length }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'JSON Invalido' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Endpoint no encontrado' }));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (process.env.NODE_ENV === 'test') {
        return;
      }
      console.error(`🚨 [ERROR CRÍTICO] El puerto ${port} ya está en uso por OTRA instancia activa.`);
      console.error(`🛑 Deteniendo este proceso de inmediato para evitar duplicar órdenes y listeners.`);
      process.exit(1);
    } else {
      console.error(`❌ Error servidor HTTP MT5:`, err.message);
      process.exit(1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`✅ [Puente MT5 + Dashboard] Escuchando en http://127.0.0.1:${port}/ (Panel Web) y /orders (MT5 EA)`);
    serverStarted = true;
  });
}

async function initMT5Bridge() {
  startLocalServer();
  return true;
}

/**
 * Despacha un ExecutionPlan hacia MetaTrader 5
 */
async function executeTradePlan(plan, originalSignal = null, options = {}) {
  if (!plan || !plan.valid) {
    console.log(`⚠️ [MT5 Bridge] Plan rechazado: ${plan?.reason || 'Plan inválido'}`);
    return false;
  }

  // 🛑 CIRCUITO DE FRENO DE EMERGENCIA & STOP TRADING
  if (!plan.isCancelAction && plan.action !== 'MODIFY') {
    const opts = { 
      bypassTimeShields: !!(options.bypassTimeShields || plan.bypassTimeShields || process.env.NODE_ENV === 'test'),
      isMultiAccountManaged: true 
    };
    const tradingCheck = riskEngine.checkTradingAllowed(new Date(), opts);
    if (!tradingCheck.allowed) {
      console.log(`🛑 [STOP TRADING ACTIVO] Operación cancelada: ${tradingCheck.reason}`);
      return false;
    }
  }

  // 🛡️ FILTRO DE NOTICIAS DE ALTO IMPACTO (News Guard)
  // No aplica para cancelaciones o modificaciones a Break-Even
  if (!plan.isCancelAction && plan.action !== 'MODIFY') {
    const newsCheck = await newsFilter.checkNewsRisk(15);
    if (newsCheck.blocked) {
      console.log(`🚨 [NEWS GUARD ACTIVO] Operación cancelada por seguridad: Noticia de alto impacto "${newsCheck.eventName}" a las ${newsCheck.eventTime}`);
      notificationService.notifyNewsGuard(newsCheck.eventName, newsCheck.eventTime, 10).catch(() => {});
      return false;
    }
  }

  // ⚖️ FILTRO UNIVERSAL DE RATIO RIESGO / BENEFICIO MÍNIMO (Mínimo 1:1.3)
  // Aplica a TODAS las fuentes: Canales de Telegram y Estrategias Algorítmicas
  if (!plan.isCancelAction && plan.action !== 'MODIFY') {
    const entryP = plan.entryPrice || plan.entry;
    const slP = plan.slPrice || plan.sl;
    const tpP = plan.targetTP || plan.tp;
    if (entryP && slP && tpP) {
      const riskDist = Math.abs(entryP - slP);
      const rewardDist = Math.abs(tpP - entryP);
      if (riskDist > 0) {
        const rr = rewardDist / riskDist;
        if (rr < 1.3) {
          console.log(`⚠️ [MT5 Bridge - FILTRO R:R UNIVERSAL BLOQUEADO] "${plan.channelName || plan.symbol}": Ratio 1:${rr.toFixed(2)} es inferior al mínimo 1:1.3. Riesgo: ${riskDist.toFixed(2)} | Recompensa: ${rewardDist.toFixed(2)}. Operación cancelada.`);
          return false;
        }
      }
    }
  }

  // 🛡️ CONTROL DE ESTRATEGIAS PROPIETARIAS (Permitir exclusivamente la nueva estrategia institucional BPR)
  if (plan.channelId && (plan.channelId.startsWith('PROPRIETARY_') || plan.channelId.includes('PROPRIETARY'))) {
    const isInstitutionalLive = plan.channelId.startsWith('PROPRIETARY_BPR_INSTITUTIONAL_') || plan.channelId.startsWith('PROPRIETARY_NY_SNIPER_');
    if (!isInstitutionalLive) {
      console.warn(`🛡️ [PROPRIETARY SHIELD] Bloqueando orden de estrategia no autorizada: "${plan.channelName || plan.channelId}". Solo las estrategias institucionales BPR y NY Sniper están autorizadas en LIVE.`);
      return false;
    }
  }

  if (process.env.NODE_ENV !== 'test') {
    startLocalServer();
  }

  const dispAction = plan.action || plan.orderType || 'BUY';
  const dispEntry = plan.entryPrice || 'MERCADO';
  const dispSL = plan.slPrice || plan.sl || 'SIN SL';
  const dispLot = plan.totalLotSize || plan.volume || 0.01;
  const dispChannel = plan.channelName || 'Canal';
  const dispSymbol = plan.symbol || 'XAUUSD';

  // 🛡️ ANTI-DUPLICADO UNIVERSAL EN EL PUENTE (Ventana de 60 segundos por canal, símbolo y dirección)
  if (!options.forceDispatch && !plan.isCancelAction && dispAction !== 'CANCEL_ALL_PENDING' && dispAction !== 'MODIFY') {
    const normAction = (dispAction || 'BUY').includes('BUY') ? 'BUY' : 'SELL';
    const normSym = normalizeMarketSymbol(dispSymbol);
    const bridgeDupKey = `${plan.channelId}:${normSym}:${normAction}`;
    const lastBridgeExec = recentBridgeDispatches.get(bridgeDupKey);
    if (lastBridgeExec && (Date.now() - lastBridgeExec) < 60000) {
      console.log(`⚠️ [MT5 Bridge - ANTI-DUPLICATE GUARD] Bloqueando orden duplicada de "${dispChannel}" (${normSym} ${normAction}) emitida hace ${((Date.now() - lastBridgeExec)/1000).toFixed(1)}s.`);
      return false;
    }
    recentBridgeDispatches.set(bridgeDupKey, Date.now());
  }

  let activeAccs = getActiveAccounts();
  if (Array.isArray(options.targetAccountIds) && options.targetAccountIds.length > 0) {
    activeAccs = activeAccs.filter(a => options.targetAccountIds.includes(a.id));
  }
  const targetAccounts = activeAccs.length > 0 ? activeAccs : [{
    id: 'default',
    broker: 'Default MT5',
    balance: riskEngine.currentBalance || 5000,
    pendingOrders
  }];

  console.log(`\n🚀 [MT5 Bridge] DESPACHANDO A ${targetAccounts.length} TERMINAL(ES) CONECTADA(S)...`);
  console.log(`------------------------------------------------------`);
  console.log(`   Simbolo: ${dispSymbol} | Acción: ${dispAction}`);
  console.log(`   Precio Entrada: ${dispEntry} | Stop Loss: ${dispSL} | TP: ${plan.targetTP || plan.tp || 'N/A'}`);
  console.log(`   Canal: "${dispChannel}"`);
  console.log(`------------------------------------------------------`);

  // Captura de fotografía técnica completa de mercado (Market Snapshot Collector)
  if (!plan.isCancelAction && dispAction !== 'CANCEL_ALL_PENDING' && dispAction !== 'MODIFY') {
    if (marketSnapshotCollector && typeof marketSnapshotCollector.captureSnapshot === 'function') {
      const livePrice = (latestTick && (latestTick.ask || latestTick.bid)) ? (latestTick.ask || latestTick.bid) : (plan.entryPrice || 0);
      marketSnapshotCollector.captureSnapshot(originalSignal || plan, plan, livePrice).catch(() => {});
    }
  }

  // Caso 1: Cancelación de órdenes pendientes
  if (plan.isCancelAction || dispAction === 'CANCEL_ALL_PENDING') {
    const cancelItem = {
      id: Date.now(),
      symbol: dispSymbol,
      action: 'CANCEL_ALL_PENDING',
      targetType: 'ALL',
      volume: 0,
      sl: 0,
      tp: 0,
      comment: plan.comment || `Cancel by ${dispChannel}`
    };
    broadcastToAllAccounts(cancelItem);
    console.log(`   🗑️ Solicitud de cancelación enviada a todas las cuentas MT5.`);
    console.log(`======================================================\n`);
    return true;
  }

  // Caso 2: Comando MODIFY (ej: Break-Even)
  if (dispAction === 'MODIFY' || plan.action === 'MODIFY') {
    const modOrder = plan.modifyOrder || plan.orders?.[0] || {};
    const modItem = {
      id: Date.now(),
      symbol: dispSymbol,
      action: 'MODIFY',
      modifyType: modOrder.modifyType || 'BREAK_EVEN',
      entryPrice: plan.entryPrice || 0,
      sl: modOrder.sl || 0,
      tp: modOrder.tp || 0,
      comment: plan.comment || `BE by ${dispChannel}`,
      timestamp: Date.now()
    };
    broadcastToAllAccounts(modItem);
    console.log(`   🛡️ Comando MODIFY (${modItem.modifyType}) puesto en cola para todas las cuentas MT5.`);
    if (modItem.modifyType === 'BREAK_EVEN') {
      notificationService.notifyBreakEven(dispSymbol, dispChannel, modItem.sl || 'Entrada').catch(() => {});
    }
    console.log(`======================================================\n`);
    return true;
  }

  // Caso 2.5: Si ya existe una orden provisional para este canal y símbolo (llegó el mensaje con SL/TP oficiales)
  const normAction = (dispAction || 'BUY').includes('BUY') ? 'BUY' : 'SELL';
  const normSymbol = (dispSymbol || 'XAUUSD').toUpperCase().replace('GOLD', 'XAUUSD');
  const provKey = `${plan.channelId}:${normSymbol}:${normAction}`;
  if (!plan.isProvisionalSL && recentProvisionalOrders.has(provKey)) {
    const prevOrder = recentProvisionalOrders.get(provKey);
    if ((Date.now() - prevOrder.timestamp) < 300000) { // 5 minutos de ventana
      const modItem = {
        id: Date.now(),
        symbol: dispSymbol,
        action: 'MODIFY',
        modifyType: 'UPDATE_PARAMS',
        entryPrice: prevOrder.entryPrice || dispEntry,
        sl: dispSL,
        tp: plan.targetTP || 0,
        comment: dispChannel,
        channelId: plan.channelId,
        timestamp: Date.now()
      };
      broadcastToAllAccounts(modItem);
      recentProvisionalOrders.delete(provKey);
      console.log(`   🔄 [Parámetros Confirmados] Actualizando posición previa de "${dispChannel}" con SL oficial: ${modItem.sl} y TP: ${modItem.tp} en todas las cuentas.`);
      notificationService.notifyParamsUpdated(dispSymbol, dispChannel, modItem.sl, modItem.tp).catch(() => {});
      console.log(`======================================================\n`);
      return true;
    }
  }

  if (plan.isProvisionalSL) {
    recentProvisionalOrders.set(provKey, {
      timestamp: Date.now(),
      entryPrice: dispEntry
    });
  }

  // Casos 3, 4 y 5: Generar y encolar órdenes proporcionales para CADA cuenta conectada
  for (const acc of targetAccounts) {
    const explicitCfg = getAccountConfig(acc.id);
    if (explicitCfg && explicitCfg.enabled === false) {
      console.log(`   ⛔ [Multi-Account] Cuenta #${acc.id} (${acc.broker}) omitida: ${explicitCfg.frozenReason || 'Desactivada por seguridad en configuración'}.`);
      continue;
    }

    if (acc.evaluationTargetHalted) {
      console.log(`   ⏸️ [Multi-Account] Cuenta #${acc.id} (${acc.broker}) omitida: Examen ya aprobado / Operativa congelada.`);
      continue;
    }

    // 🛡️ REGLA PROP FIRM: PROTECCIÓN DE DRAWDOWN Y MÁXIMO 2 OPERACIONES
    const isProp = !acc.isPersonal;
    if (isProp) {
      // 🚨 FRENO DE DRAWDOWN MÁXIMO POR CUENTA (Protección Estricta Prop Firm)
      if (acc.initialBalance && acc.balance) {
        const maxDrawdownUSD = acc.initialBalance * 0.08; // 8% límite interno preventivo ante el 10% de la firma
        const lossUSD = acc.initialBalance - acc.balance;
        if (lossUSD >= maxDrawdownUSD) {
          console.log(`🚨 [PROTECCIÓN MÁXIMA PROP FIRM] Cuenta #${acc.id} (${acc.broker}) CONGELADA: Pérdida acumulada -$${lossUSD.toFixed(2)} USD superó el límite de seguridad (-$${maxDrawdownUSD.toFixed(2)} USD / 8%). Aperturas bloqueadas.`);
          continue;
        }
      }

      const maxTrades = explicitCfg?.maxOpenTrades || acc.maxOpenTrades || 2;
      const pendingCount = (acc.pendingOrders || []).filter(o => !o.isCancelAction && o.action !== 'MODIFY').length;
      const useBESlotRelease = explicitCfg?.breakEvenSlotRelease ?? riskEngine.config.PROP_FIRM.breakEvenSlotRelease;
      const basePositions = useBESlotRelease ? (acc.riskPositions !== undefined ? acc.riskPositions : (acc.openPositions || 0)) : (acc.openPositions || 0);
      const effectivePositions = basePositions + pendingCount;
      if (effectivePositions >= maxTrades) {
        console.log(`   ⛔ [Multi-Account] Cuenta #${acc.id} (${acc.broker}) omitida: Límite Prop Firm alcanzado (${effectivePositions} operaciones con riesgo activo/pendientes >= ${maxTrades}). Slot de riesgo no disponible.`);
        continue;
      }
    }

    const accBal = acc.balance || riskEngine.currentBalance || 5000;
    // Cálculo proporcional de lotaje por cuenta
    const tailoredLot = riskEngine.calculateLotSize(
      dispEntry,
      dispSL,
      dispSymbol,
      plan.isReducedRisk,
      accBal,
      explicitCfg?.riskPercent
    );

    console.log(`   👤 [Cuenta #${acc.id} (${acc.broker})] Balance: $${accBal.toFixed(2)} USD -> Volumen asignado: ${tailoredLot} lotes`);

    // Helper para resolver sufijo o alias específico de la cuenta (ej. USDJPY -> USDJPY-VIP)
    const resolveForAcc = (sym) => {
      const base = sym || dispSymbol;
      if (explicitCfg?.symbolAliases?.[base]) return explicitCfg.symbolAliases[base];
      if (explicitCfg?.symbolSuffix && !base.endsWith(explicitCfg.symbolSuffix)) return base + explicitCfg.symbolSuffix;
      return base;
    };

    // Caso 3: Rejilla de órdenes pendientes (Grid)
    if (plan.isPendingOrder && plan.isGrid && Array.isArray(plan.orders) && plan.orders.length > 0) {
      const totalPlanLot = plan.totalLotSize || plan.orders.reduce((s, o) => s + (o.volume || 0), 0) || 0.10;
      const scaleRatio = tailoredLot / totalPlanLot;
      for (let i = 0; i < plan.orders.length; i++) {
        const o = plan.orders[i];
        const subLot = Math.max(0.01, parseFloat(((o.volume || 0.01) * scaleRatio).toFixed(2)));
        const itemPayload = {
          id: Date.now() + i,
          symbol: resolveForAcc(o.symbol || dispSymbol),
          action: o.action,
          entryPrice: o.entryPrice,
          entry: o.entryPrice,
          volume: subLot,
          sl: o.sl || dispSL,
          tp: o.tp || plan.targetTP,
          comment: plan.channelId || o.comment || `Grid #${i + 1}`,
          channelId: plan.channelId,
          timestamp: Date.now()
        };

        acc.pendingOrders.push(itemPayload);
        pendingOrderManager.registerPendingOrder(
          itemPayload,
          plan.channelId,
          dispChannel,
          plan.ttlMinutes || 45
        );
        console.log(`      📦 Grid #${i + 1} (${o.action}): ${subLot} Lotes @ ${o.entryPrice} | SL: ${o.sl} | TP: ${o.tp}`);
      }
    }
    // Caso 4: Orden pendiente individual
    else if (plan.isPendingOrder) {
      const itemPayload = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        symbol: resolveForAcc(dispSymbol),
        action: plan.orderType || dispAction,
        entryPrice: plan.entryPrice,
        entry: plan.entryPrice,
        volume: tailoredLot,
        sl: dispSL,
        tp: plan.targetTP || plan.tp || 0,
        comment: plan.channelId || plan.comment || '',
        channelId: plan.channelId,
        timestamp: Date.now()
      };

      acc.pendingOrders.push(itemPayload);
      pendingOrderManager.registerPendingOrder(
        itemPayload,
        plan.channelId,
        dispChannel,
        plan.ttlMinutes || 30
      );
      console.log(`      📦 Orden Pendiente ${itemPayload.action}: ${itemPayload.volume} Lotes @ ${itemPayload.entryPrice} | SL: ${itemPayload.sl} | TP: ${itemPayload.tp}`);
    }
    // Caso 5: Múltiples órdenes a mercado (ej: TP1 50% / TP2 50%)
    else if (plan.orders && Array.isArray(plan.orders) && plan.orders.length > 1) {
      const totalPlanLot = plan.totalLotSize || plan.orders.reduce((s, o) => s + (o.volume || 0), 0) || 0.10;
      let allocated = 0;
      for (let i = 0; i < plan.orders.length; i++) {
        const order = plan.orders[i];
        let subLot;
        if (i === plan.orders.length - 1) {
          subLot = parseFloat((tailoredLot - allocated).toFixed(2));
          if (subLot < 0.01) subLot = 0.01;
        } else {
          const ratio = (order.volume || 0.01) / totalPlanLot;
          subLot = Math.max(0.01, parseFloat((tailoredLot * ratio).toFixed(2)));
          allocated += subLot;
        }
        const itemPayload = {
          id: Date.now() + i,
          symbol: resolveForAcc(order.symbol || dispSymbol),
          action: order.action || dispAction,
          volume: subLot,
          sl: order.sl || dispSL,
          tp: order.tp || plan.targetTP || 0,
          comment: plan.channelId || order.comment || '',
          channelId: plan.channelId,
          timestamp: Date.now()
        };

        acc.pendingOrders.push(itemPayload);
        console.log(`      📦 Parcial a Mercado #${i + 1}: ${subLot} Lotes ${itemPayload.action} | SL: ${itemPayload.sl} | TP: ${itemPayload.tp}`);
      }
    }
    // Caso 6: Orden a mercado única
    else {
      const baseOrder = (plan.orders && plan.orders[0]) || {};
      const itemPayload = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        symbol: resolveForAcc(baseOrder.symbol || dispSymbol),
        action: baseOrder.action || dispAction,
        volume: tailoredLot,
        sl: baseOrder.sl || dispSL,
        tp: baseOrder.tp || plan.targetTP || 0,
        comment: plan.channelId || baseOrder.comment || '',
        channelId: plan.channelId,
        timestamp: Date.now()
      };

      acc.pendingOrders.push(itemPayload);
      console.log(`      📦 Orden a Mercado: ${tailoredLot} Lotes ${itemPayload.action} | SL: ${itemPayload.sl} | TP: ${itemPayload.tp}`);
    }
  }

  // Registrar en analíticas
  analyticsEngine.recordSignal(plan.channelId, dispChannel, plan, plan);

  // Enviar notificación push de ejecución
  notificationService.notifyTradeExecuted(plan).catch(() => {});

  // Registrar para monitor de Auto-BE en TP2 si aplica
  registerChannelTrade(plan, originalSignal);

  console.log(`======================================================\n`);
  return true;
}

// Activación en LIVE de la nueva estrategia institucional unificada
proprietaryStrategyManager.setExecutionHandler(async (plan) => {
  return await executeTradePlan(plan);
});
proprietaryStrategyManager.setLiveExecution(true);
console.log(`🚀 [MT5 Bridge] Estrategia BPR Institucional M5 ACTIVADA EN VIVO (LIVE REAL): ${proprietaryStrategyManager.getActiveNames().join(', ')}`);

module.exports = {
  initMT5Bridge,
  executeTradePlan,
  getLatestTick,
  startLocalServer,
  connectedAccounts,
  getOrCreateAccount,
  checkChannelTradesAutoBE,
  registerChannelTrade,
  activeChannelTrades
};
