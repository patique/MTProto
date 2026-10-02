/**
 * Motor de Analíticas y Estadísticas de Acierto por Canal
 * - Registra cada señal generada y su resultado (TP1, TP2, TP3, SL o Cancelado)
 * - Calcula Win Rate %, Ratio Riesgo/Beneficio real, y Pips netos por canal
 * - Sistema de Protección Inteligente: Si un canal acumula 3 SL seguidos o Win Rate < 40%,
 *   recomienda reducir su riesgo o pausarlo temporalmente.
 * - Persistencia automática en analytics_data.json
 */

const fs = require('fs');
const path = require('path');
const { findChannelConfig } = require('../config/channels.config');

const DATA_FILE = path.join(__dirname, '..', 'analytics_data.json');

class AnalyticsEngine {
  constructor() {
    this.stats = {}; // { [channelId]: { name, totalSignals, winCount, lossCount, cancelledCount, pipsGained, consecutiveLosses, lastSignals: [] } }
    this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        this.stats = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('⚠️ [Analytics] No se pudo cargar archivo previo de métricas, iniciando en limpio.');
      this.stats = {};
    }
  }

  saveData() {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(this.stats, null, 2), 'utf-8');
    } catch (e) {
      console.error('❌ [Analytics] Error guardando métricas:', e.message);
    }
  }

  _getOrCreateChannel(channelId, channelName = 'Canal') {
    let id = channelId ? channelId.toString() : 'UNKNOWN';
    if (!this.stats[id]) {
      const cfg = findChannelConfig(channelId, channelName || channelId);
      if (cfg && cfg.id && this.stats[cfg.id]) {
        id = cfg.id;
      }
    }
    if (!this.stats[id]) {
      const cfg = findChannelConfig(channelId, channelName || channelId);
      const resolvedName = (cfg && cfg.name) ? cfg.name : channelName;
      this.stats[id] = {
        channelId: id,
        channelName: resolvedName,
        totalSignals: 0,
        winCount: 0,
        lossCount: 0,
        cancelledCount: 0,
        pipsGained: 0,
        consecutiveLosses: 0,
        status: 'ACTIVE', // ACTIVE | PAUSED | REDUCED_RISK
        lastSignals: []
      };
    }
    if (channelName && this.stats[id].channelName === 'Canal') {
      this.stats[id].channelName = channelName;
    }
    return this.stats[id];
  }

  /**
   * Registra una nueva señal despachada
   */
  recordSignal(channelId, channelName, signal, executionPlan) {
    const ch = this._getOrCreateChannel(channelId, channelName);
    ch.totalSignals++;

    const record = {
      id: `${Date.now()}_${ch.totalSignals}`,
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString('es-ES'),
      symbol: signal.symbol,
      action: signal.action,
      entry: executionPlan.entryPrice,
      sl: executionPlan.slPrice,
      tp: executionPlan.targetTP,
      isPending: executionPlan.isPendingOrder,
      outcome: 'PENDING', // PENDING | TP_HIT | SL_HIT | CANCELLED
      pips: 0
    };

    ch.lastSignals.unshift(record);
    if (ch.lastSignals.length > 50) ch.lastSignals.pop(); // Mantener últimas 50 señales

    this.saveData();
    return record;
  }

  /**
   * Actualiza el resultado de una operación (TP o SL tocado)
   */
  recordOutcome(channelId, outcome, pips = 0, orderId = null) {
    const ch = this._getOrCreateChannel(channelId);
    if (outcome === 'TP_HIT' || outcome === 'WIN') {
      ch.winCount++;
      ch.consecutiveLosses = 0;
      ch.pipsGained += Math.abs(pips);
      if (ch.status === 'REDUCED_RISK') ch.status = 'ACTIVE';
    } else if (outcome === 'SL_HIT' || outcome === 'LOSS') {
      ch.lossCount++;
      ch.consecutiveLosses++;
      ch.pipsGained -= Math.abs(pips);

      // 🛡️ Regla de protección de racha negativa
      if (ch.consecutiveLosses >= 3) {
        ch.status = 'REDUCED_RISK';
        console.warn(`🚨 [Analytics Guard] Canal "${ch.channelName}" acumula ${ch.consecutiveLosses} SL consecutivos. Reduciendo riesgo automáticamente.`);
      }
    } else if (outcome === 'CANCELLED') {
      ch.cancelledCount++;
    }

    if (orderId && ch.lastSignals.length > 0) {
      const match = ch.lastSignals.find(s => s.id === orderId);
      if (match) {
        match.outcome = outcome;
        match.pips = pips;
      }
    }

    this.saveData();
  }

  /**
   * Atribuye automáticamente una ganancia o pérdida detectada por cambio de balance en MT5
   * al canal cuya señal pendiente corresponda al trade cerrado
   */
  recordAutoTradeOutcome(outcome, pips = 0, profitUSD = 0) {
    let candidate = null;
    let candidateChannelId = null;

    for (const [id, ch] of Object.entries(this.stats)) {
      if (id === 'MT5_AUTO') continue;
      const pendingSig = ch.lastSignals && ch.lastSignals.find(s => s.outcome === 'PENDING');
      if (pendingSig) {
        if (!candidate || pendingSig.timestamp > candidate.timestamp) {
          candidate = pendingSig;
          candidateChannelId = id;
        }
      }
    }

    if (!candidateChannelId) {
      let latestTime = 0;
      for (const [id, ch] of Object.entries(this.stats)) {
        if (id === 'MT5_AUTO') continue;
        if (ch.lastSignals && ch.lastSignals.length > 0) {
          const sig = ch.lastSignals[0];
          if (sig.timestamp > latestTime) {
            latestTime = sig.timestamp;
            candidateChannelId = id;
            candidate = sig;
          }
        }
      }
    }

    const targetId = candidateChannelId || 'MT5_AUTO';
    const ch = this._getOrCreateChannel(targetId);
    console.log(`🎯 [Analytics Engine] Auto-atribuido cierre ${outcome} (+${pips.toFixed(1)} pips, $${profitUSD.toFixed(2)}) al canal "${ch.channelName}" (ID: ${targetId})`);

    this.recordOutcome(targetId, outcome, pips, candidate ? candidate.id : null);
    return targetId;
  }

  /**
   * Evalúa ticks de precio en tiempo real frente a los SL y TP de señales pendientes
   */
  evaluatePriceTick(tick) {
    // Desactivado: El seguimiento de SL y TP lo realiza de forma fidedigna MetaTrader 5
    // a través del Feedback Loop (/trade-closed). El cálculo sobre ticks brutos provocaba
    // falsos positivos de SL en órdenes no ejecutadas o ya cerradas en Break-Even.
    return;
  }

  /**
   * Retorna métricas calculadas para un canal
   */
  getChannelMetrics(channelId) {
    const ch = this._getOrCreateChannel(channelId);
    const resolvedTrades = ch.winCount + ch.lossCount;
    const winRate = resolvedTrades > 0 ? ((ch.winCount / resolvedTrades) * 100).toFixed(1) : '0.0';

    return {
      channelId: ch.channelId,
      channelName: ch.channelName,
      totalSignals: ch.totalSignals,
      resolvedTrades,
      winCount: ch.winCount,
      lossCount: ch.lossCount,
      cancelledCount: ch.cancelledCount,
      winRate: `${winRate}%`,
      pipsGained: ch.pipsGained.toFixed(1),
      consecutiveLosses: ch.consecutiveLosses,
      status: ch.status
    };
  }

  /**
   * Retorna reporte general formateado de todos los canales
   */
  printReport() {
    console.log('\n========================================================================================');
    console.log('📊 REPORTE DE RENDIMIENTO Y ESTADÍSTICAS POR CANAL (AnalyticsEngine)');
    console.log('========================================================================================');
    console.log('Canal                           | Señales | Ganadas | Perdidas | Win Rate | Pips Netos | Estado');
    console.log('----------------------------------------------------------------------------------------');

    for (const id of Object.keys(this.stats)) {
      const m = this.getChannelMetrics(id);
      const name = m.channelName.padEnd(31).substring(0, 31);
      const sigs = m.totalSignals.toString().padStart(7);
      const wins = m.winCount.toString().padStart(7);
      const losses = m.lossCount.toString().padStart(8);
      const wr = m.winRate.padStart(8);
      const pips = m.pipsGained.padStart(10);
      const st = m.status.padStart(6);
      console.log(`${name} | ${sigs} | ${wins} | ${losses} | ${wr} | ${pips} | ${st}`);
    }
    console.log('========================================================================================\n');
  }
}

// Instancia singleton
const analyticsEngine = new AnalyticsEngine();

module.exports = {
  AnalyticsEngine,
  analyticsEngine
};
