/**
 * Motor de Analíticas y Evaluación Pura de Señales de Telegram (AnalyticsEngine)
 * 
 * Filosofía del Sistema:
 * - Evalúa EXCLUSIVAMENTE el acierto técnico de la señal enviada por el canal en el mercado real.
 * - Desacoplado 100% de terminales MT5: No se ve afectado por cierres manuales del usuario,
 *   cierres por Friday Guard, filtros de riesgo o multiplicadores multi-cuenta.
 * - El resultado (WIN o LOSS) y los pips se calculan directamente contra los ticks de mercado:
 *   * WIN: El precio de mercado tocó el Take Profit antes que el Stop Loss.
 *   * LOSS: El precio de mercado tocó el Stop Loss antes que el Take Profit.
 * - Cálculo estricto de Pips de mercado según el activo (Oro 0.10, Forex 0.0001, JPY 0.01).
 * - Persistencia limpia en analytics_data.json.
 */

const fs = require('fs');
const path = require('path');
const { findChannelConfig } = require('../config/channels.config');

const DATA_FILE = path.join(__dirname, '..', 'analytics_data.json');

function normalizeSymbol(symbol = '') {
  let s = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s === 'GOLD' || s.startsWith('XAU')) return 'XAUUSD';
  if (s === 'SILVER' || s.startsWith('XAG')) return 'XAGUSD';
  return s;
}

function getPipSize(symbol = '') {
  const s = normalizeSymbol(symbol);
  if (s === 'XAUUSD') return 0.10; // 1 pip = 0.10 $ en Oro
  if (s === 'XAGUSD') return 0.01;
  if (s.includes('JPY')) return 0.01;
  if (s.includes('BTC') || s.includes('NAS') || s.includes('US30') || s.includes('SPX')) return 1.0;
  return 0.0001; // Forex estándar (EURUSD, GBPUSD, etc.)
}

class AnalyticsEngine {
  constructor() {
    this.stats = {};
    this.recordedMessageKeys = new Set();
    this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        this.stats = JSON.parse(raw);
        for (const ch of Object.values(this.stats)) {
          if (ch.lastSignals) {
            for (const s of ch.lastSignals) {
              if (s.messageKey) this.recordedMessageKeys.add(s.messageKey);
            }
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ [Analytics] Archivo previo no encontrado o corrupto, iniciando limpio.');
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

  /**
   * Resetea completamente el historial a cero
   */
  clearHistory() {
    this.stats = {};
    this.recordedMessageKeys.clear();
    this.saveData();
    console.log('🧹 [AnalyticsEngine] Historial de métricas reseteado a cero (Análisis limpio activado).');
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
        validSignalsCount: 0,
        invalidSignalsCount: 0,
        winCount: 0,
        lossCount: 0,
        cancelledCount: 0,
        pipsGained: 0,
        consecutiveLosses: 0,
        status: 'ACTIVE',
        lastSignals: []
      };
    }
    if (channelName && this.stats[id].channelName === 'Canal') {
      this.stats[id].channelName = channelName;
    }
    return this.stats[id];
  }

  /**
   * Registra una señal original recibida del canal para su auditoría pura en mercado
   */
  recordSignal(channelId, channelName, signal, executionPlanOrLevels = {}) {
    if (!signal || !signal.action || (!signal.sl && !executionPlanOrLevels.slPrice)) {
      return null;
    }

    const messageKey = `${channelId}:${signal.messageId || signal.id || Date.now()}`;
    if (this.recordedMessageKeys.has(messageKey)) {
      return null; // Evitar duplicar la misma señal si se re-evalúa
    }
    this.recordedMessageKeys.add(messageKey);

    const ch = this._getOrCreateChannel(channelId, channelName);
    ch.totalSignals++;

    const entryPrice = executionPlanOrLevels.entryPrice || signal.entry || 0;
    const slPrice = executionPlanOrLevels.slPrice || signal.sl || 0;
    const targetTP = executionPlanOrLevels.targetTP || signal.tp1 || signal.tp2 || signal.tp || 0;

    const isValid = executionPlanOrLevels.valid !== false;
    const validationReason = executionPlanOrLevels.reason || (isValid ? 'VÁLIDA (Entrada a tiempo)' : 'No cumple filtros de entrada');
    const entryDiffPips = executionPlanOrLevels.entryDiffPips || 0;

    if (isValid) {
      ch.validSignalsCount = (ch.validSignalsCount || 0) + 1;
    } else {
      ch.invalidSignalsCount = (ch.invalidSignalsCount || 0) + 1;
    }

    const record = {
      id: `${Date.now()}_${ch.totalSignals}`,
      messageKey,
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString('es-ES'),
      symbol: normalizeSymbol(signal.symbol || 'XAUUSD'),
      action: signal.action.toUpperCase(),
      entry: entryPrice,
      sl: slPrice,
      tp: targetTP,
      isValid,
      validationReason,
      entryDiffPips: +(Number(entryDiffPips).toFixed(1)),
      outcome: 'PENDING', // PENDING | WIN | LOSS | CANCELLED
      pips: 0,
      closedPrice: null,
      closedAt: null
    };

    ch.lastSignals.unshift(record);
    if (ch.lastSignals.length > 50) ch.lastSignals.pop();

    this.saveData();

    const statusIcon = isValid ? '✅ VÁLIDA' : '⚠️ DESCARTADA';
    console.log(`📈 [Analytics Signal Tracked] [${statusIcon}] "${ch.channelName}": ${record.symbol} ${record.action} | Entrada: ${record.entry} | SL: ${record.sl} | TP: ${record.tp}`);
    if (!isValid) {
      console.log(`   Motivo descarte / retraso: "${validationReason}"`);
    }
    return record;
  }

  /**
   * Evalúa ticks en tiempo real contra los TP y SL de las señales PENDING
   */
  evaluatePriceTick(tick) {
    if (!tick || !tick.symbol || (!tick.bid && !tick.ask)) return;

    const symNorm = normalizeSymbol(tick.symbol);
    const now = Date.now();
    let hasChanges = false;

    for (const ch of Object.values(this.stats)) {
      if (!ch.lastSignals || ch.lastSignals.length === 0) continue;

      for (const sig of ch.lastSignals) {
        if (sig.outcome !== 'PENDING') continue;
        if (sig.symbol !== symNorm) continue;

        const isBuy = sig.action.includes('BUY');
        const currentPrice = isBuy ? (tick.bid || tick.ask) : (tick.ask || tick.bid);
        if (!currentPrice || currentPrice <= 0) continue;

        // TTL de seguridad: Si la señal lleva más de 48h pendiente sin tocar TP ni SL, expirar
        if (now - sig.timestamp > 48 * 3600 * 1000) {
          sig.outcome = 'CANCELLED';
          ch.cancelledCount++;
          hasChanges = true;
          continue;
        }

        const pipSize = getPipSize(sig.symbol);
        let outcome = null;
        let pips = 0;

        if (isBuy) {
          // Si compra: Ganamos si el precio sube al TP; perdemos si baja al SL
          if (sig.tp > 0 && currentPrice >= sig.tp) {
            outcome = 'WIN';
            pips = sig.entry > 0 ? (sig.tp - sig.entry) / pipSize : (currentPrice - sig.sl) / pipSize;
          } else if (sig.sl > 0 && currentPrice <= sig.sl) {
            outcome = 'LOSS';
            pips = sig.entry > 0 ? (sig.sl - sig.entry) / pipSize : -Math.abs(sig.tp - sig.sl) / pipSize;
          }
        } else {
          // Si venta: Ganamos si el precio baja al TP; perdemos si sube al SL
          if (sig.tp > 0 && currentPrice <= sig.tp) {
            outcome = 'WIN';
            pips = sig.entry > 0 ? (sig.entry - sig.tp) / pipSize : (sig.sl - currentPrice) / pipSize;
          } else if (sig.sl > 0 && currentPrice >= sig.sl) {
            outcome = 'LOSS';
            pips = sig.entry > 0 ? (sig.entry - sig.sl) / pipSize : -Math.abs(sig.sl - sig.tp) / pipSize;
          }
        }

        if (outcome) {
          sig.outcome = outcome;
          sig.pips = +(pips.toFixed(1));
          sig.closedPrice = currentPrice;
          sig.closedAt = now;

          if (outcome === 'WIN') {
            ch.winCount++;
            ch.consecutiveLosses = 0;
            ch.pipsGained = +(ch.pipsGained + sig.pips).toFixed(1);
            if (ch.status === 'REDUCED_RISK') ch.status = 'ACTIVE';
          } else {
            ch.lossCount++;
            ch.consecutiveLosses++;
            ch.pipsGained = +(ch.pipsGained + sig.pips).toFixed(1);
            if (ch.consecutiveLosses >= 3) {
              ch.status = 'REDUCED_RISK';
              console.warn(`🚨 [Analytics Guard] Canal "${ch.channelName}" acumula ${ch.consecutiveLosses} SL consecutivos.`);
            }
          }

          console.log(`\n🎯 [AUDITORÍA DE SEÑAL PURA - ${outcome} ${outcome === 'WIN' ? '✅' : '❌'}]`);
          console.log(`   Canal: "${ch.channelName}" | ${sig.symbol} ${sig.action}`);
          console.log(`   Entrada: ${sig.entry} -> Salida: ${currentPrice} | TP: ${sig.tp} | SL: ${sig.sl}`);
          console.log(`   Pips Netos Señal: ${sig.pips >= 0 ? '+' : ''}${sig.pips} pips\n`);

          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      this.saveData();
    }
  }

  /**
   * Métricas calculadas para un canal
   */
  getChannelMetrics(channelId) {
    const ch = this._getOrCreateChannel(channelId);
    const resolvedTrades = ch.winCount + ch.lossCount;
    const winRate = resolvedTrades > 0 ? ((ch.winCount / resolvedTrades) * 100).toFixed(1) : '0.0';
    const totalSigs = ch.totalSignals || 0;
    const valids = ch.validSignalsCount || 0;
    const invalids = ch.invalidSignalsCount || 0;
    const validRate = totalSigs > 0 ? ((valids / totalSigs) * 100).toFixed(1) : '0.0';

    return {
      channelId: ch.channelId,
      channelName: ch.channelName,
      totalSignals: totalSigs,
      validSignalsCount: valids,
      invalidSignalsCount: invalids,
      timelinessRate: `${validRate}%`,
      resolvedTrades,
      winCount: ch.winCount,
      lossCount: ch.lossCount,
      cancelledCount: ch.cancelledCount,
      winRate: `${winRate}%`,
      pipsGained: Number(ch.pipsGained || 0).toFixed(1),
      consecutiveLosses: ch.consecutiveLosses,
      status: ch.status,
      lastSignals: ch.lastSignals || []
    };
  }

  printReport() {
    console.log('\n========================================================================================');
    console.log('📊 REPORTE DE CALIDAD PURA Y PUNTUALIDAD DE SEÑALES (Ticks en Vivo)');
    console.log('========================================================================================');
    console.log('Canal                           | Señales | Válidas | A Tiempo% | Ganadas | Perdidas | Win Rate | Pips Netos');
    console.log('----------------------------------------------------------------------------------------');

    for (const id of Object.keys(this.stats)) {
      const m = this.getChannelMetrics(id);
      const name = m.channelName.padEnd(31).substring(0, 31);
      const sigs = m.totalSignals.toString().padStart(7);
      const valids = m.validSignalsCount.toString().padStart(7);
      const valRate = m.timelinessRate.padStart(9);
      const wins = m.winCount.toString().padStart(7);
      const losses = m.lossCount.toString().padStart(8);
      const wr = m.winRate.padStart(8);
      const pips = m.pipsGained.padStart(10);
      console.log(`${name} | ${sigs} | ${valids} | ${valRate} | ${wins} | ${losses} | ${wr} | ${pips}`);
    }
    console.log('========================================================================================\n');
  }
}

const analyticsEngine = new AnalyticsEngine();

module.exports = {
  AnalyticsEngine,
  analyticsEngine,
  getPipSize,
  normalizeSymbol
};
