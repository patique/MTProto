/**
 * Gestor de Vigilancia y Re-evaluación en Drawdown / Descuento (SignalWatchlistManager)
 * 
 * Reglas de funcionamiento:
 * - Cuando una señal de canal es rechazada exclusivamente por ratio R:R insuficiente (< minRiskReward),
 *   entra en la cola de vigilancia.
 * - Ventana máxima de vida: 15 minutos.
 * - Intervalo de re-evaluación: Cada 5 minutos (Exactamente 3 intentos: +5m, +10m y +15m).
 * - Protección estricta anti-duplicados:
 *   * Solo 1 orden por señal/mensaje de Telegram.
 *   * Si se dispara a mercado, se purga de la lista inmediatamente y se bloquea contra re-ejecución.
 * - Criterios en cada re-evaluación:
 *   1. Si el precio actual ya tocó el TP proyectado -> CANCELAR (oportunidad expirada).
 *   2. Si el precio actual ya tocó el SL -> CANCELAR (señal invalidada).
 *   3. Si el precio retrocedió favorablemente (Drawdown inicial) y el nuevo R:R >= minRiskReward:
 *      -> DISPARAR A MERCADO EN PRECIO DE DESCUENTO.
 *   4. Si tras el 3er intento (15 min) no cumple R:R -> EXPIRAR DEFINITIVAMENTE.
 */

const { getLatestTick, executeTradePlan } = require('../mt5_bridge');
const { riskEngine } = require('./RiskEngine');

class SignalWatchlistManager {
  constructor() {
    this.watchlist = new Map(); // key -> watchItem
    this.executedKeys = new Set(); // Identificadores ya disparados a MT5
    this.inFlightLocks = new Set(); // Mutex para evitar carreras asíncronas
    this.checkInterval = null;
    this.startWatchdog();
  }

  /**
   * Genera clave única inmutable por señal
   */
  getSignalKey(channelId, messageId, symbol, action) {
    if (messageId) {
      return `${channelId}:${messageId}`;
    }
    return `${channelId}:${symbol}:${action}`;
  }

  /**
   * Añade una señal rechazada por R:R a la cola de vigilancia
   */
  addToWatchlist({
    channelId,
    channelName,
    messageId,
    signal,
    strategy,
    channelCfg,
    initialRR = 0,
    targetTP = null
  }) {
    if (!signal || !signal.sl || (!targetTP && !signal.tp1 && !signal.tp2 && !signal.tp)) {
      return false;
    }

    const key = this.getSignalKey(channelId, messageId, signal.symbol, signal.action);

    // Si ya fue ejecutada antes o está en proceso de disparo, omitir
    if (this.executedKeys.has(key) || this.inFlightLocks.has(key)) {
      return false;
    }

    // Si ya está en la lista de vigilancia, no duplicar la entrada
    if (this.watchlist.has(key)) {
      return false;
    }

    const resolvedTP = targetTP || strategy.resolveTargetTP(signal) || signal.tp1;
    const minRR = channelCfg?.minRiskReward || strategy?.minRiskReward || 1.0;
    const now = Date.now();

    const item = {
      key,
      channelId,
      channelName,
      messageId,
      signal,
      strategy,
      channelCfg,
      targetTP: resolvedTP,
      minRiskReward: minRR,
      initialRR,
      createdAt: now,
      attemptsDone: 0,
      maxAttempts: 3,
      // Primer intento exactamente a los 5 minutos del rechazo inicial
      nextEvaluationTime: now + 5 * 60 * 1000,
      expiryTime: now + 15 * 60 * 1000 + 5000, // 15 minutos de margen
      status: 'WATCHING'
    };

    this.watchlist.set(key, item);

    console.log(`\n📥 [Signal Watcher - PULLBACK DESCUENTO REGISTRADO]`);
    console.log(`   Canal: "${channelName}" | Par: ${signal.symbol} ${signal.action}`);
    console.log(`   R:R inicial rechazado: 1:${Number(initialRR).toFixed(2)} (Mínimo exigido: 1:${minRR.toFixed(2)})`);
    console.log(`   ⏱️ Vigilancia programada: 3 re-evaluaciones (cada 5 min, hasta 15 min máx).`);
    console.log(`   Próximo reintento: ${new Date(item.nextEvaluationTime).toLocaleTimeString('es-ES')}\n`);

    return true;
  }

  /**
   * Marca una clave como ya ejecutada para que el Watchlist nunca la relance
   */
  markAsExecuted(channelId, messageId, symbol, action) {
    const key = this.getSignalKey(channelId, messageId, symbol, action);
    this.executedKeys.add(key);
    this.watchlist.delete(key);
  }

  /**
   * Watchdog periódico que examina si corresponde evaluar algún intento (cada 5s)
   */
  startWatchdog() {
    if (this.checkInterval) clearInterval(this.checkInterval);

    this.checkInterval = setInterval(async () => {
      if (this.watchlist.size === 0) return;

      const now = Date.now();
      for (const [key, item] of this.watchlist.entries()) {
        if (item.status !== 'WATCHING') continue;

        // ¿Llegó el momento del siguiente intento?
        if (now >= item.nextEvaluationTime) {
          await this.evaluateCandidate(key, item);
        }
      }
    }, 5000);
  }

  /**
   * Evalúa una señal candidata en su intervalo correspondiente
   */
  async evaluateCandidate(key, item) {
    // Protección estricta contra concurrencia
    if (this.inFlightLocks.has(key)) return;
    this.inFlightLocks.add(key);

    try {
      item.attemptsDone++;
      const attemptNum = item.attemptsDone;
      const { signal, strategy, targetTP, minRiskReward, channelName } = item;
      const isBuy = signal.action.includes('BUY');

      // 1. Obtener precio actual de MT5
      const tick = getLatestTick(signal.symbol);
      const currentPrice = isBuy ? (tick.ask || tick.bid) : (tick.bid || tick.ask);

      if (!currentPrice) {
        console.warn(`⚠️ [Signal Watcher - Intento ${attemptNum}/3] "${channelName}": Sin precio disponible para ${signal.symbol}. Pospuesto.`);
        item.nextEvaluationTime = Date.now() + 5 * 60 * 1000;
        this.inFlightLocks.delete(key);
        return;
      }

      const timeStr = new Date().toLocaleTimeString('es-ES');
      console.log(`\n🔍 [Signal Watcher - RE-EVALUACIÓN INTENTO ${attemptNum}/3] [${timeStr}]`);
      console.log(`   Canal: "${channelName}" | ${signal.symbol} ${signal.action}`);
      console.log(`   Precio actual: ${currentPrice} | SL: ${signal.sl} | TP Objetivo: ${targetTP}`);

      // 2. ¿Precio ya tocó el TP?
      const tpHit = isBuy ? (currentPrice >= targetTP) : (currentPrice <= targetTP);
      if (tpHit) {
        console.log(`   ❌ [OPORTUNIDAD EXPIRADA]: El precio actual (${currentPrice}) ya alcanzó el TP (${targetTP}). Señal cancelada de la lista.\n`);
        this.watchlist.delete(key);
        this.inFlightLocks.delete(key);
        return;
      }

      // 3. ¿Precio ya tocó o perforó el SL?
      const slHit = isBuy ? (currentPrice <= signal.sl) : (currentPrice >= signal.sl);
      if (slHit) {
        console.log(`   ❌ [SEÑAL INVALIDADA]: El precio actual (${currentPrice}) tocó el Stop Loss (${signal.sl}). Señal eliminada de la lista.\n`);
        this.watchlist.delete(key);
        this.inFlightLocks.delete(key);
        return;
      }

      // 4. Calcular nuevo ratio R:R desde el precio de mercado actual
      const riskDistance = Math.abs(currentPrice - signal.sl);
      const rewardDistance = Math.abs(targetTP - currentPrice);

      if (riskDistance <= 0) {
        console.log(`   ⚠️ Distancia a SL nula o inválida. Purgando.`);
        this.watchlist.delete(key);
        this.inFlightLocks.delete(key);
        return;
      }

      const currentRR = rewardDistance / riskDistance;
      console.log(`   📊 R:R recalculado al precio actual: 1:${currentRR.toFixed(2)} (Mínimo exigido: 1:${minRiskReward.toFixed(2)})`);

      // 5. ¿Cumple el R:R mínimo gracias al retroceso / Drawdown inicial?
      if (currentRR >= minRiskReward) {
        console.log(`   🎯 ¡DISPARO A MERCADO EN PRECIO DE DESCUENTO! R:R cumplido (1:${currentRR.toFixed(2)} >= 1:${minRiskReward.toFixed(2)})`);
        
        // Bloquear y purgar inmediatamente del watchlist para prevenir re-lanzamientos
        item.status = 'EXECUTED';
        this.watchlist.delete(key);
        this.executedKeys.add(key);

        // Generar plan de ejecución con el precio actual como nueva entrada
        const updatedSignal = { ...signal, entry: currentPrice };
        const plan = strategy.createExecutionPlan(updatedSignal, currentPrice, riskEngine);

        if (plan && plan.valid) {
          plan.comment = `Watcher_Att${attemptNum}_RR${currentRR.toFixed(2)}`;
          console.log(`   🚀 Enviando orden a MT5: ${plan.orderType} ${plan.symbol} a ${currentPrice} | Lote: ${plan.totalLotSize} | SL: ${plan.slPrice} | TP: ${plan.targetTP}\n`);
          await executeTradePlan(plan, updatedSignal);
        } else {
          console.warn(`   ⚠️ Plan recalculado no válido: ${plan?.reason || 'Error desconocido'}`);
        }

        this.inFlightLocks.delete(key);
        return;
      }

      // 6. Si no cumplió el R:R:
      if (attemptNum >= item.maxAttempts || Date.now() >= item.expiryTime) {
        console.log(`   ⌛ [EXPIRACIÓN DEFINITIVA]: Completados los 3 intentos (15 min) sin alcanzar el R:R mínimo. Señal retirada.\n`);
        this.watchlist.delete(key);
      } else {
        // Programar siguiente re-evaluación a los 5 minutos
        item.nextEvaluationTime = Date.now() + 5 * 60 * 1000;
        console.log(`   ⏳ R:R aún insuficiente. Próxima re-evaluación (Intento ${attemptNum + 1}/3) a las: ${new Date(item.nextEvaluationTime).toLocaleTimeString('es-ES')}\n`);
      }

    } catch (err) {
      console.error(`❌ [Signal Watcher] Error evaluando señal ${key}:`, err.message);
    } finally {
      this.inFlightLocks.delete(key);
    }
  }

  /**
   * Resumen para telemetría y dashboard
   */
  getStatusSummary() {
    return {
      activeWatchingCount: this.watchlist.size,
      totalExecutedCount: this.executedKeys.size,
      items: Array.from(this.watchlist.values()).map(it => ({
        key: it.key,
        channel: it.channelName,
        symbol: it.signal.symbol,
        action: it.signal.action,
        initialRR: it.initialRR,
        attemptsDone: it.attemptsDone,
        nextAttemptInMs: Math.max(0, it.nextEvaluationTime - Date.now())
      }))
    };
  }
}

const signalWatchlistManager = new SignalWatchlistManager();

module.exports = {
  signalWatchlistManager,
  SignalWatchlistManager
};
