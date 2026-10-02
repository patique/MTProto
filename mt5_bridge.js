/**
 * Puente HTTP Local para MetaTrader 5 (MT5 Bridge)
 * - Comunicación ultrarrápida (0ms de latencia local) entre Node.js y el EA de MT5
 * - Servidor REST: GET /orders, POST /orders, POST /trade-closed (Feedback Loop MT5)
 * - Servidor Web Dashboard: http://127.0.0.1:3000
 * - Integrado con PendingOrderManager, AnalyticsEngine y NewsFilter
 */

const http = require('http');
const https = require('https');
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
const { bprStrategyMultiTF } = require('./core/algorithms/BPRInstitutionalMultiTimeframeStrategy');
const { bprStrategyEURUSD } = require('./core/algorithms/BPREurusdMultiTimeframeStrategy');
const { bprStrategyGBPJPY } = require('./core/algorithms/BPRGbpjpyBearishStrategy');
const { bprStrategyNAS100 } = require('./core/algorithms/BPRNas100BullishStrategy');

let pendingOrders = [];
let recentProvisionalOrders = new Map();
let serverStarted = false;
let latestTick = { bid: 0, ask: 0, time: 0 };
let latestTickEURUSD = { bid: 0, ask: 0, time: 0 };
let latestTickGBPJPY = { bid: 0, ask: 0, time: 0 };
let latestTickNAS100 = { bid: 0, ask: 0, time: 0 };
let lastEURUSDTickTime = 0;
let lastGBPJPYTickTime = 0;
let lastNAS100TickTime = 0;
let evaluationTargetHalted = false;
let primaryAccountId = null;

// =====================================================================
// 🏦 REGISTRO MULTI-CUENTA DE TERMINALES MT5
// =====================================================================
const connectedAccounts = new Map();
const ACCOUNTS_CONFIG_FILE = path.join(__dirname, 'config', 'accounts_config.json');
const DAILY_TRACKING_FILE = path.join(__dirname, 'daily_account_tracking.json');

function loadDailyTracking() {
  try {
    if (fs.existsSync(DAILY_TRACKING_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAILY_TRACKING_FILE, 'utf8'));
      const today = new Date().toISOString().split('T')[0];
      if (data.date === today) {
        return data;
      }
    }
  } catch (e) {}
  return { date: new Date().toISOString().split('T')[0], accounts: {} };
}

function saveDailyTracking(tracking) {
  try {
    fs.writeFileSync(DAILY_TRACKING_FILE, JSON.stringify(tracking, null, 2), 'utf8');
  } catch (e) {}
}

function loadAccountsConfig() {
  try {
    if (fs.existsSync(ACCOUNTS_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(ACCOUNTS_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveAccountsConfig(cfg) {
  try {
    fs.writeFileSync(ACCOUNTS_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {}
}

function getOrCreateAccount(accountId, broker = 'Unknown', balance = null, equity = null, openPositions = 0, openBuy = 0, openSell = 0) {
  const id = String(accountId || 'default').trim();
  let acc = connectedAccounts.get(id);
  const now = Date.now();

  const cfg = loadAccountsConfig();
  const accCustom = cfg[id] || {};

  // Modo de cuenta: 'PERSONAL' (Capital Propio) o 'PROP_FIRM' (Fondeo)
  let resolvedMode = accCustom.mode;
  if (!resolvedMode) {
    const brokerLower = (broker || '').toLowerCase();
    if (brokerLower.includes('ftmo') || brokerLower.includes('five percent') || (balance && balance >= 4000)) {
      resolvedMode = 'PROP_FIRM';
    } else {
      resolvedMode = 'PERSONAL'; // Brokers de capital propio o cuentas pequeñas (ej. 100€)
    }
  }
  const resolvedRisk = accCustom.riskPercent || (resolvedMode === 'PERSONAL' ? 2.0 : 0.75);

  if (!acc) {
    const dailyData = loadDailyTracking();
    const accTracking = dailyData.accounts[id] || {};
    const dayStartBal = accTracking.dayStartBalance || (balance && balance > 0 ? balance : 5000);
    const isHaltedToday = (id === '1514787530') ? true : !!accTracking.dailyHalted;
    const haltMsg = accTracking.haltReason || (isHaltedToday ? 'Límite preventivo de 3% alcanzado. Cuenta FTMO congelada hoy.' : '');

    acc = {
      id,
      broker: (broker && broker !== 'Unknown') ? broker : 'MetaTrader 5',
      balance: (balance !== null && !isNaN(balance) && balance > 0) ? balance : (riskEngine.currentBalance || 5000),
      equity: (equity !== null && !isNaN(equity) && equity > 0) ? equity : (balance || riskEngine.currentBalance || 5000),
      openPositions: openPositions || 0,
      openBuy: openBuy || 0,
      openSell: openSell || 0,
      mode: resolvedMode,
      riskPercent: resolvedRisk,
      label: accCustom.label || (resolvedMode === 'PERSONAL' ? 'Capital Propio' : 'Prop Firm'),
      lastSeen: now,
      evaluationTargetHalted: false,
      dailyHalted: isHaltedToday,
      haltReason: haltMsg,
      dayStartBalance: dayStartBal,
      initialBalance: null,
      targetProfitBalance: null,
      pendingOrders: []
    };
    connectedAccounts.set(id, acc);
    console.log(`🔌 [Multi-Account] Terminal MT5 vinculada: Cuenta #${id} (${acc.broker}) | Modo: ${acc.mode} (${acc.riskPercent}%) | Balance: $${acc.balance.toFixed(2)} USD${isHaltedToday ? ' [🛑 CONGELADA HOY]' : ''}`);
  } else {
    const dailyData = loadDailyTracking();
    const accTracking = dailyData.accounts[id] || {};
    if (broker && broker !== 'Unknown') acc.broker = broker;
    if (balance !== null && !isNaN(balance) && balance > 0) acc.balance = balance;
    if (equity !== null && !isNaN(equity) && equity > 0) acc.equity = equity;
    if (openPositions !== undefined && !isNaN(openPositions)) acc.openPositions = openPositions;
    if (openBuy !== undefined && !isNaN(openBuy)) acc.openBuy = openBuy;
    if (openSell !== undefined && !isNaN(openSell)) acc.openSell = openSell;
    acc.mode = resolvedMode;
    acc.riskPercent = resolvedRisk;
    acc.label = accCustom.label || (resolvedMode === 'PERSONAL' ? 'Capital Propio' : 'Prop Firm');
    acc.lastSeen = now;
    if (id === '1514787530') {
      acc.dailyHalted = true;
      acc.haltReason = accTracking.haltReason || 'Límite preventivo de 3% alcanzado. Cuenta FTMO congelada hoy.';
    } else if (accTracking.dailyHalted !== undefined) {
      acc.dailyHalted = accTracking.dailyHalted;
      acc.haltReason = accTracking.haltReason || '';
    }
    if (accTracking.dayStartBalance) {
      acc.dayStartBalance = accTracking.dayStartBalance;
    }
  }

  // Detectar tramo inicial de evaluación EXCLUSIVAMENTE para cuentas de Prop Firm (Freno de Meta +10%)
  if (acc.mode === 'PROP_FIRM') {
    if (acc.balance > 0 && !acc.initialBalance) {
      const b = acc.balance;
      if (b >= 4000 && b <= 7000) acc.initialBalance = 5000;
      else if (b >= 8000 && b <= 14000) acc.initialBalance = 10000;
      else if (b >= 20000 && b <= 35000) acc.initialBalance = 25000;
      else if (b >= 40000 && b <= 70000) acc.initialBalance = 50000;
      else if (b >= 80000 && b <= 140000) acc.initialBalance = 100000;
      else if (b >= 160000 && b <= 250000) acc.initialBalance = 200000;
      else acc.initialBalance = b;

      acc.targetProfitBalance = Math.round(acc.initialBalance * 1.10);
    }
  } else {
    // Cuenta PERSONAL (Capital Propio): sin frenos de examen (+10%), opera libre para crecimiento compuesto
    acc.targetProfitBalance = null;
    acc.evaluationTargetHalted = false;
  }

  return acc;
}

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
  const activeTargets = getActiveAccounts();
  for (const acc of activeTargets) {
    acc.pendingOrders.push({
      ...orderPayload,
      id: Date.now() + Math.floor(Math.random() * 1000)
    });
  }
}

function getLatestTick() {
  return latestTick;
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

// 📡 Stream de Cotizaciones en Vivo para EURUSD (Garantía de actualización continua si el EA no transmite)

function fetchLiveEURUSDTick() {
  if (Date.now() - lastEURUSDTickTime < 2500) return;

  const req = https.get('https://api.binance.com/api/v3/ticker/bookTicker?symbol=EURUSDT', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 2000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        const bid = parseFloat(j.bidPrice);
        const ask = parseFloat(j.askPrice);
        if (bid > 0 && ask > 0) {
          latestTickEURUSD = { bid, ask, time: Date.now() };
          bprStrategyEURUSD.processTick({ bid, ask, time: Date.now(), symbol: 'EURUSD' });
        }
      } catch (e) {}
    });
  });
  req.on('error', () => {});
}

setInterval(fetchLiveEURUSDTick, 1500);
fetchLiveEURUSDTick();

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
        openBuy: a.openBuy || 0,
        openSell: a.openSell || 0,
        mode: a.mode || 'PROP_FIRM',
        riskPercent: a.riskPercent || 0.75,
        label: a.label || (a.mode === 'PERSONAL' ? 'Capital Propio' : 'Prop Firm'),
        lastSeenSecondsAgo: Math.round((Date.now() - a.lastSeen) / 1000),
        isOnline: (Date.now() - a.lastSeen) < 15000,
        targetHalted: a.evaluationTargetHalted,
        initialBalance: a.initialBalance,
        targetProfitBalance: a.targetProfitBalance,
        dailyHalted: !!a.dailyHalted,
        haltReason: a.haltReason || '',
        dayStartBalance: a.dayStartBalance || a.balance,
        dailyLossUSD: parseFloat(((a.dayStartBalance || a.balance) - a.balance).toFixed(2)),
        dailyLossPercent: parseFloat(((((a.dayStartBalance || a.balance) - a.balance) / (a.dayStartBalance || a.balance)) * 100).toFixed(2)),
        goldLot: riskEngine.calculateLotSize(null, null, 'XAUUSD', false, a.balance, a.mode, a.riskPercent),
        forexLot: riskEngine.calculateLotSize(null, null, 'EURUSD', false, a.balance, a.mode, a.riskPercent),
        gbpjpyLot: riskEngine.calculateLotSize(null, null, 'GBPJPY', false, a.balance, a.mode, a.riskPercent),
        nas100Lot: riskEngine.calculateLotSize(null, null, 'NAS100', false, a.balance, a.mode, a.riskPercent)
      }));

      const payload = {
        balance: riskEngine.currentBalance,
        mode: riskEngine.config.MODE,
        riskPercent: riskEngine.currentRiskPercent,
        tick: latestTick,
        tickEURUSD: latestTickEURUSD,
        tickGBPJPY: latestTickGBPJPY,
        tickNAS100: latestTickNAS100,
        totalResolved,
        globalWinRate,
        totalPips,
        dailyPnL: riskEngine.dailyPnL,
        dailyPnLPercent: riskEngine.dailyPnLPercent,
        dailyTargetProfitUSD: riskEngine.dailyTargetProfitUSD,
        dailyMaxLossUSD: riskEngine.dailyMaxLossUSD,
        tradingPaused: riskEngine.tradingPaused,
        pauseReason: riskEngine.pauseReason,
        news: upcomingNews,
        accounts: accountsData,
        pendingOrders: Array.from(pendingOrderManager.trackedOrders.values())
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

    // 4b. API para Estrategia Algorítmica Institucional BPR Multi-TF (M1 + M2 + M3 + M5 + M15)
    if (parsedUrl.pathname === '/api/bpr-strategy' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: bprStrategyMultiTF.name,
        symbol: bprStrategyMultiTF.symbol,
        metrics: bprStrategyMultiTF.metrics,
        activeTrades: bprStrategyMultiTF.activeTrades,
        checklist: bprStrategyMultiTF.getConfirmationChecklist(latestTick.bid || latestTick.ask),
        recentZones: {
          M2: (bprStrategyMultiTF.timeframes.M2 ? bprStrategyMultiTF.timeframes.M2.bprZones.slice(-5) : []),
          M3: (bprStrategyMultiTF.timeframes.M3 ? bprStrategyMultiTF.timeframes.M3.bprZones.slice(-5) : []),
          M5: (bprStrategyMultiTF.timeframes.M5 ? bprStrategyMultiTF.timeframes.M5.bprZones.slice(-5) : []),
          M15: (bprStrategyMultiTF.timeframes.M15 ? bprStrategyMultiTF.timeframes.M15.bprZones.slice(-5) : [])
        },
        history: bprStrategyMultiTF.history.slice(-30)
      }, null, 2));
    }

    // 4c. API para Estrategia Algorítmica Institucional BPR EURUSD Multi-TF (M2 + M3 + M5 + M15)
    if (parsedUrl.pathname === '/api/bpr-eurusd' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: bprStrategyEURUSD.name,
        symbol: bprStrategyEURUSD.symbol,
        metrics: bprStrategyEURUSD.metrics,
        activeTrades: bprStrategyEURUSD.activeTrades,
        checklist: bprStrategyEURUSD.getConfirmationChecklist(latestTickEURUSD.bid || latestTickEURUSD.ask || 0),
        recentZones: {
          M2: bprStrategyEURUSD.timeframes.M2.bprZones.slice(-5),
          M3: bprStrategyEURUSD.timeframes.M3.bprZones.slice(-5),
          M5: bprStrategyEURUSD.timeframes.M5.bprZones.slice(-5),
          M15: bprStrategyEURUSD.timeframes.M15.bprZones.slice(-5)
        },
        history: bprStrategyEURUSD.history.slice(-30)
      }, null, 2));
    }

    // 4d. API para Estrategia Algorítmica Institucional BPR GBPJPY Multi-TF (M2 + M3 + M5 + M15) - SÓLO VENTAS
    if (parsedUrl.pathname === '/api/bpr-gbpjpy' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: bprStrategyGBPJPY.name,
        symbol: bprStrategyGBPJPY.symbol,
        direction: 'BEARISH_ONLY',
        metrics: bprStrategyGBPJPY.metrics,
        activeTrades: bprStrategyGBPJPY.activeTrades,
        checklist: bprStrategyGBPJPY.getConfirmationChecklist(latestTickGBPJPY.bid || latestTickGBPJPY.ask || 0),
        recentZones: {
          M2: bprStrategyGBPJPY.timeframes.M2.bprZones.slice(-5),
          M3: bprStrategyGBPJPY.timeframes.M3.bprZones.slice(-5),
          M5: bprStrategyGBPJPY.timeframes.M5.bprZones.slice(-5),
          M15: bprStrategyGBPJPY.timeframes.M15.bprZones.slice(-5)
        },
        history: bprStrategyGBPJPY.history.slice(-30)
      }, null, 2));
    }

    // 4e. API para Estrategia Algorítmica Institucional BPR NAS100 Multi-TF (M2 + M3 + M5 + M15) - SÓLO COMPRAS
    if (parsedUrl.pathname === '/api/bpr-nas100' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify({
        strategy: bprStrategyNAS100.name,
        symbol: bprStrategyNAS100.symbol,
        direction: 'BULLISH_ONLY',
        metrics: bprStrategyNAS100.metrics,
        activeTrades: bprStrategyNAS100.activeTrades,
        checklist: bprStrategyNAS100.getConfirmationChecklist(latestTickNAS100.bid || latestTickNAS100.ask || 0),
        recentZones: {
          M2: bprStrategyNAS100.timeframes.M2.bprZones.slice(-5),
          M3: bprStrategyNAS100.timeframes.M3.bprZones.slice(-5),
          M5: bprStrategyNAS100.timeframes.M5.bprZones.slice(-5),
          M15: bprStrategyNAS100.timeframes.M15.bprZones.slice(-5)
        },
        history: bprStrategyNAS100.history.slice(-30)
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

    // 4b. API para Cambiar Modo de Cuenta (PERSONAL / PROP_FIRM) desde Dashboard
    if (parsedUrl.pathname === '/api/accounts/mode' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const { accountId, mode, riskPercent } = JSON.parse(body);
          const id = String(accountId).trim();
          const acc = connectedAccounts.get(id);
          const cfg = loadAccountsConfig();
          if (!cfg[id]) cfg[id] = {};
          if (mode) cfg[id].mode = mode;
          if (riskPercent) cfg[id].riskPercent = parseFloat(riskPercent);
          saveAccountsConfig(cfg);

          if (acc) {
            if (mode) acc.mode = mode;
            if (riskPercent) acc.riskPercent = parseFloat(riskPercent);
            if (acc.mode === 'PERSONAL') {
              acc.targetProfitBalance = null;
              acc.evaluationTargetHalted = false;
              acc.label = cfg[id].label || 'Capital Propio';
            } else {
              acc.label = cfg[id].label || 'Prop Firm';
            }
          }
          console.log(`🏦 [Cuenta #${id} Actualizada]: Modo -> ${mode || acc?.mode} | Riesgo -> ${(riskPercent || acc?.riskPercent)}%`);
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, account: acc || cfg[id] }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 4. Endpoint GET /orders (Consulta del EA de MT5)
    if (parsedUrl.pathname === '/orders' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');

      const accountId = parsedUrl.query.account ? String(parsedUrl.query.account).trim() : 'default';
      const broker = parsedUrl.query.broker ? String(parsedUrl.query.broker).trim() : 'Unknown';
      const liveBal = parsedUrl.query.balance ? parseFloat(parsedUrl.query.balance) : null;
      const liveEq = parsedUrl.query.equity ? parseFloat(parsedUrl.query.equity) : null;
      const openPos = parsedUrl.query.openPositions !== undefined ? parseInt(parsedUrl.query.openPositions, 10) : 0;
      const openBuy = parsedUrl.query.openBuy !== undefined ? parseInt(parsedUrl.query.openBuy, 10) : 0;
      const openSell = parsedUrl.query.openSell !== undefined ? parseInt(parsedUrl.query.openSell, 10) : 0;

      const acc = getOrCreateAccount(accountId, broker, liveBal, liveEq, openPos, openBuy, openSell);

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
        if (accountId === primaryAccountId || !primaryAccountId) {
          riskEngine.currentBalance = liveBal;
          if (openPos !== undefined && !isNaN(openPos)) {
            riskEngine.activePositionsCount = openPos;
          }
        }

        // 🎯 FRENO DE META CUMPLIDA POR CUENTA (solo en cuentas PROP_FIRM de evaluación)
        if (acc.mode === 'PROP_FIRM' && acc.targetProfitBalance && acc.balance >= acc.targetProfitBalance && !acc.evaluationTargetHalted) {
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
        const sym = (parsedUrl.query.symbol || 'XAUUSD').toUpperCase();
        if (!isNaN(bid) && bid > 0 && !isNaN(ask) && ask > 0) {
          latestTick = { bid, ask, time: Date.now() };
          try {
            if (sym.includes('EUR')) {
              latestTickEURUSD = { bid, ask, time: Date.now() };
              bprStrategyEURUSD.processTick({ bid, ask, time: Date.now(), symbol: 'EURUSD' });
            } else if (sym.includes('GBP') || sym.includes('JPY')) {
              latestTickGBPJPY = { bid, ask, time: Date.now() };
              bprStrategyGBPJPY.processTick({ bid, ask, time: Date.now(), symbol: 'GBPJPY' });
            } else if (sym.includes('NAS') || sym.includes('US100') || sym.includes('USTEC') || sym.includes('NDX')) {
              latestTickNAS100 = { bid, ask, time: Date.now() };
              bprStrategyNAS100.processTick({ bid, ask, time: Date.now(), symbol: 'NAS100' });
            } else {
              bprStrategyMultiTF.processTick(latestTick);
            }
          } catch (e) {
            // Ignorar silenciosamente para no interrumpir el puente
          }
        }
      }

      // Procesar tick empaquetado de EURUSD desde el EA si está activo en Market Watch
      if (parsedUrl.query.eurusdBid && parsedUrl.query.eurusdAsk) {
        const eBid = parseFloat(parsedUrl.query.eurusdBid);
        const eAsk = parseFloat(parsedUrl.query.eurusdAsk);
        if (!isNaN(eBid) && eBid > 0 && !isNaN(eAsk) && eAsk > 0) {
          lastEURUSDTickTime = Date.now();
          latestTickEURUSD = { bid: eBid, ask: eAsk, time: Date.now() };
          try {
            bprStrategyEURUSD.processTick({ bid: eBid, ask: eAsk, time: Date.now(), symbol: 'EURUSD' });
          } catch (e) {}
        }
      }

      // Procesar tick empaquetado de GBPJPY desde el EA si está activo en Market Watch
      if (parsedUrl.query.gbpjpyBid && parsedUrl.query.gbpjpyAsk) {
        const gBid = parseFloat(parsedUrl.query.gbpjpyBid);
        const gAsk = parseFloat(parsedUrl.query.gbpjpyAsk);
        if (!isNaN(gBid) && gBid > 0 && !isNaN(gAsk) && gAsk > 0) {
          lastGBPJPYTickTime = Date.now();
          latestTickGBPJPY = { bid: gBid, ask: gAsk, time: Date.now() };
          try {
            bprStrategyGBPJPY.processTick({ bid: gBid, ask: gAsk, time: Date.now(), symbol: 'GBPJPY' });
          } catch (e) {}
        }
      }

      // Procesar tick empaquetado de NAS100 desde el EA si está activo en Market Watch
      if (parsedUrl.query.nas100Bid && parsedUrl.query.nas100Ask) {
        const nBid = parseFloat(parsedUrl.query.nas100Bid);
        const nAsk = parseFloat(parsedUrl.query.nas100Ask);
        if (!isNaN(nBid) && nBid > 0 && !isNaN(nAsk) && nAsk > 0) {
          lastNAS100TickTime = Date.now();
          latestTickNAS100 = { bid: nBid, ask: nAsk, time: Date.now() };
          try {
            bprStrategyNAS100.processTick({ bid: nBid, ask: nAsk, time: Date.now(), symbol: 'NAS100' });
          } catch (e) {}
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

          let pipsEst = 0;
          if (typeof data.pips === 'number' && !isNaN(data.pips) && data.pips !== 0) {
            pipsEst = parseFloat(data.pips.toFixed(1));
          } else {
            const vol = parseFloat(data.volume) || (matchedSnapshot?.order?.lotSize) || 0.01;
            const pipsPerDollar = vol * 10.0;
            pipsEst = pipsPerDollar > 0 ? parseFloat((profit / pipsPerDollar).toFixed(1)) : parseFloat(((profit || 0) * 10).toFixed(1));
          }
          // Registrar en el motor de analíticas y snapshots
          analyticsEngine.recordOutcome(targetChannelId, outcome || (profit >= 0 ? 'WIN' : 'LOSS'), pipsEst, position);
          marketSnapshotCollector.resolveSnapshot(targetChannelId, outcome || (profit >= 0 ? 'WIN' : 'LOSS'), pipsEst, profit);
          
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

          const matchedAcc = connectedAccounts.get(String(account)) || null;
          const brokerName = (matchedAcc && matchedAcc.broker) ? matchedAcc.broker : (broker || 'MetaTrader 5');
          const humanChannel = findChannelConfig(targetChannelId)?.name || targetChannelId || 'Canal MT5';

          // Notificación Push al móvil
          notificationService.notifyTradeClosed({
            position,
            symbol: symbol || 'XAUUSD',
            outcome: outcome || (profit >= 0 ? 'WIN' : 'LOSS'),
            profitUSD: profit || 0,
            pips: pipsEst,
            balance: (matchedAcc && matchedAcc.balance) || balance || riskEngine.currentBalance,
            accountId: account,
            broker: brokerName,
            channelName: humanChannel,
            initialBalance: matchedAcc?.initialBalance,
            targetProfitBalance: matchedAcc?.targetProfitBalance
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
            pendingOrders.push(...newOrders);
          } else {
            pendingOrders.push(newOrders);
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
    const opts = { bypassTimeShields: !!(options.bypassTimeShields || plan.bypassTimeShields || process.env.NODE_ENV === 'test') };
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

  if (process.env.NODE_ENV !== 'test') {
    startLocalServer();
  }

  const dispAction = plan.action || plan.orderType || 'BUY';
  const dispEntry = plan.entryPrice || 'MERCADO';
  const dispSL = plan.slPrice || plan.sl || 'SIN SL';
  const dispLot = plan.totalLotSize || plan.volume || 0.01;
  const dispChannel = plan.channelName || 'Canal';
  const dispSymbol = plan.symbol || 'XAUUSD';

  const activeAccs = getActiveAccounts();
  const targetAccounts = activeAccs.length > 0 ? activeAccs : [{
    id: 'default',
    broker: 'Default MT5',
    balance: riskEngine.currentBalance || 5000,
    pendingOrders
  }];

  // Si todas las cuentas conectadas han completado su objetivo de evaluación (+10%), omitir nuevas operaciones
  if (!plan.isCancelAction && dispAction !== 'CANCEL_ALL_PENDING' && dispAction !== 'MODIFY') {
    const availableAccounts = targetAccounts.filter(acc => !acc.evaluationTargetHalted);
    if (availableAccounts.length === 0 && targetAccounts.length > 0) {
      console.log(`⏸️ [Multi-Account] Todas las cuentas conectadas (${targetAccounts.length}) han aprobado su evaluación (+10%). Operativa congelada.`);
      return false;
    }
  }

  // Sanity check de coherencia de TP para órdenes a mercado:
  // Evita que el TP quede del lado equivocado del precio de entrada (ej: TP arriba de entry en un SELL)
  if (!plan.isPendingOrder && typeof dispEntry === 'number' && typeof dispSL === 'number') {
    const slDist = Math.abs(dispEntry - dispSL);
    const decimals = dispSymbol.includes('JPY') ? 3 : (dispSymbol === 'XAUUSD' ? 2 : (dispSymbol === 'NAS100' ? 1 : 5));
    if (dispAction === 'BUY' && plan.targetTP && plan.targetTP <= dispEntry) {
      console.warn(`⚠️ [Sanity Guard] TP corregido en BUY: ${plan.targetTP} era menor o igual al precio de entrada ${dispEntry}. Reajustando a 1:1.0.`);
      plan.targetTP = parseFloat((dispEntry + slDist).toFixed(decimals));
      if (plan.orders && plan.orders[0]) plan.orders[0].tp = plan.targetTP;
    } else if (dispAction === 'SELL' && plan.targetTP && plan.targetTP >= dispEntry) {
      console.warn(`⚠️ [Sanity Guard] TP corregido en SELL: ${plan.targetTP} era mayor o igual al precio de entrada ${dispEntry}. Reajustando a 1:1.0.`);
      plan.targetTP = parseFloat((dispEntry - slDist).toFixed(decimals));
      if (plan.orders && plan.orders[0]) plan.orders[0].tp = plan.targetTP;
    }
  }

  console.log(`\n🚀 [MT5 Despacho] ${dispAction} ${dispSymbol} @ ${dispEntry} | SL: ${dispSL} | TP: ${plan.targetTP || plan.tp || 'N/A'} (Canal: "${dispChannel}")`);

  // Captura de fotografía técnica completa de mercado (Market Snapshot Collector)
  if (!plan.isCancelAction && dispAction !== 'CANCEL_ALL_PENDING' && dispAction !== 'MODIFY') {
    marketSnapshotCollector.captureSnapshot(originalSignal || plan, plan, latestTick.ask || latestTick.bid).catch(() => {});
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

  // Caso 1.5: Cierre forzado de mercado para canal o estrategia específica
  if (dispAction === 'CLOSE_CHANNEL' || dispAction === 'CLOSE_SPECIFIC') {
    const closeItem = {
      id: Date.now(),
      symbol: dispSymbol,
      action: 'CLOSE_CHANNEL',
      channelId: plan.channelId || '',
      comment: plan.comment || plan.channelId || '',
      timestamp: Date.now()
    };
    broadcastToAllAccounts(closeItem);
    console.log(`   🛑 [Cierre de Seguridad] Cierre de mercado para "${dispChannel}" enviado a todas las cuentas MT5.`);
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
      comment: plan.comment || plan.channelId || `BE by ${dispChannel}`,
      channelId: plan.channelId || '',
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
  const provKey = `${plan.channelId}:${dispSymbol}:${dispAction}`;
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
  const accountAllocations = [];
  for (const acc of targetAccounts) {
    if (acc.evaluationTargetHalted) {
      console.log(`   ⏸️ [Multi-Account] Cuenta #${acc.id} (${acc.broker}) omitida: Examen ya aprobado / Operativa congelada.`);
      continue;
    }

    // 🛡️ COMPROBACIÓN PREVIA: Si la cuenta está congelada para el día de hoy por límite preventivo
    if (acc.dailyHalted) {
      console.warn(`   🛑 [CUENTA CONGELADA HOY] Cuenta #${acc.id} (${acc.broker}) omitida: ${acc.haltReason || 'Límite preventivo de 3% alcanzado hoy.'}`);
      continue;
    }

    // 🛡️ REGLA 1: Anti-Hedging Estricto para cuentas PROP_FIRM (The5ers, FTMO)
    // En Capital Propio (PERSONAL) se permite el Hedging libre si el usuario lo desea.
    if (acc.mode === 'PROP_FIRM') {
      const antiHedgingCheck = riskEngine.checkAntiHedging(dispSymbol, dispAction, acc.openBuy, acc.openSell, acc.mode);
      if (!antiHedgingCheck.allowed) {
        console.warn(`   🛑 [PROP FIRM ANTI-HEDGING] Cuenta #${acc.id} (${acc.broker}) omitida: ${antiHedgingCheck.reason}`);
        continue;
      }

      // 🛡️ REGLA 1.5: Anti-Stacking Estricto y Límite de Posiciones Abiertas para cuentas PROP_FIRM
      const currentOpen = (acc.openBuy || 0) + (acc.openSell || 0);
      if (currentOpen >= 2) {
        console.warn(`   🛑 [PROP FIRM MAX TRADES] Cuenta #${acc.id} (${acc.broker}) omitida: Límite de 2 operaciones activas simultáneas alcanzado (${currentOpen} abiertas).`);
        continue;
      }
      if (currentOpen >= 1) {
        console.warn(`   🛑 [PROP FIRM ANTI-STACKING] Cuenta #${acc.id} (${acc.broker}) omitida: Ya existe una operación activa en mercado (${currentOpen} abierta). Prohibido apilar riesgo.`);
        continue;
      }

      // 🛡️ REGLA 1.6: Freno de Emergencia por Pérdida Diaria Individual (3.0% drawdown preventivo)
      const dayStart = acc.dayStartBalance || acc.balance;
      const curLoss = dayStart - acc.balance;
      const maxAllowedLoss = dayStart * 0.03; // 3.0% max preventivo
      if (curLoss >= maxAllowedLoss) {
        acc.dailyHalted = true;
        acc.haltReason = `Pérdida diaria (-$${curLoss.toFixed(2)} USD, ${(curLoss / dayStart * 100).toFixed(2)}%) ha alcanzado el límite de seguridad de 3.0%.`;
        const dt = loadDailyTracking();
        dt.accounts[acc.id] = {
          dayStartBalance: dayStart,
          dailyLoss: curLoss,
          dailyLossPercent: parseFloat((curLoss / dayStart * 100).toFixed(2)),
          dailyHalted: true,
          haltReason: acc.haltReason
        };
        saveDailyTracking(dt);
        console.warn(`   🚨 [ACCOUNT DAILY LOSS LIMIT] Cuenta #${acc.id} (${acc.broker}) CONGELADA hoy: ${acc.haltReason}`);
        continue;
      }
    }

    const accBal = acc.balance || riskEngine.currentBalance || 5000;
    // Cálculo proporcional de lotaje por cuenta respetando su propio modo (PERSONAL vs PROP_FIRM)
    const tailoredLot = riskEngine.calculateLotSize(
      dispEntry,
      dispSL,
      dispSymbol,
      plan.isReducedRisk,
      accBal,
      acc.mode || 'PROP_FIRM',
      acc.riskPercent
    );

    accountAllocations.push({
      id: acc.id,
      broker: acc.broker,
      balance: accBal,
      mode: acc.mode || 'PROP_FIRM',
      riskPercent: acc.riskPercent || 0.75,
      lot: tailoredLot
    });

    console.log(`   👤 [Cuenta #${acc.id} (${acc.broker}) | ${acc.mode || 'PROP_FIRM'} (${acc.riskPercent || 0.75}%)] Balance: $${accBal.toFixed(2)} USD -> Volumen asignado: ${tailoredLot} lotes`);

    // Caso 3: Rejilla de órdenes pendientes (Grid)
    if (plan.isPendingOrder && plan.isGrid && Array.isArray(plan.orders) && plan.orders.length > 0) {
      const totalPlanLot = plan.totalLotSize || plan.orders.reduce((s, o) => s + (o.volume || 0), 0) || 0.10;
      const scaleRatio = tailoredLot / totalPlanLot;
      for (let i = 0; i < plan.orders.length; i++) {
        const o = plan.orders[i];
        const subLot = Math.max(0.01, parseFloat(((o.volume || 0.01) * scaleRatio).toFixed(2)));
        const itemPayload = {
          id: Date.now() + i,
          symbol: o.symbol || dispSymbol,
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
        symbol: dispSymbol,
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
          symbol: order.symbol || dispSymbol,
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
        symbol: baseOrder.symbol || dispSymbol,
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
  notificationService.notifyTradeExecuted(plan, accountAllocations).catch(() => {});

  return true;
}

// ⚡ Conectar Estrategia Propia BPR Multi-TF (M3 + M5 + M15) a la Ejecución REAL de MT5
bprStrategyMultiTF.setExecutionHandler(async (plan) => {
  return await executeTradePlan(plan);
});
bprStrategyMultiTF.setLiveExecution(true);
console.log('⚡ [MT5 Bridge] Estrategia Propia BPR Multi-TF (XAUUSD) vinculada a Operativa REAL en MT5.');

// ⚡ Conectar Estrategia Propia BPR EURUSD (M2 + M3 + M5 + M15) a la Ejecución REAL de MT5
bprStrategyEURUSD.setExecutionHandler(async (plan) => {
  return await executeTradePlan(plan);
});
bprStrategyEURUSD.setLiveExecution(true);
console.log('⚡ [MT5 Bridge] Estrategia Propia BPR EURUSD (M2+M3+M5+M15) vinculada a Operativa REAL en MT5.');

// ⚡ Conectar Estrategia Propia BPR GBPJPY (M2 + M3 + M5 + M15) SÓLO VENTAS a la Ejecución REAL de MT5
bprStrategyGBPJPY.setExecutionHandler(async (plan) => {
  return await executeTradePlan(plan);
});
bprStrategyGBPJPY.setLiveExecution(true);
console.log('⚡ [MT5 Bridge] Estrategia Propia BPR GBPJPY Bearish (M2+M3+M5+M15) vinculada a Operativa REAL en MT5.');

// ⚡ Conectar Estrategia Propia BPR NAS100 (M2 + M3 + M5 + M15) SÓLO COMPRAS a la Ejecución REAL de MT5
bprStrategyNAS100.setExecutionHandler(async (plan) => {
  return await executeTradePlan(plan);
});
bprStrategyNAS100.setLiveExecution(true);
console.log('⚡ [MT5 Bridge] Estrategia Propia BPR NAS100 Bullish (M2+M3+M5+M15) vinculada a Operativa REAL en MT5.');

module.exports = {
  initMT5Bridge,
  executeTradePlan,
  getLatestTick,
  startLocalServer,
  connectedAccounts,
  getOrCreateAccount
};
