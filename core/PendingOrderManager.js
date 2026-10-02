/**
 * Gestor de Ciclo de Vida y Expiración (TTL) de Órdenes Pendientes
 * - Evita que órdenes BUY_LIMIT / SELL_LIMIT queden olvidadas durante horas o días
 *   y terminen saltando el SL cuando el mercado regresa en contra.
 * - Monitorea el tiempo de vida (TTL en minutos) de cada orden pendiente.
 * - Despacha comandos de cancelación automática a MT5 si la orden expira.
 */

class PendingOrderManager {
  constructor(options = {}) {
    this.checkIntervalMs = options.checkIntervalMs || 15000; // Revisar cada 15s
    this.trackedOrders = new Map(); // orderId -> { id, symbol, action, entryPrice, channelId, channelName, createdAt, ttlMinutes, expiresAt }
    this.cancelCallback = null; // Callback para enviar la orden de cancelación a MT5 Bridge
    this.timer = null;
  }

  /**
   * Configura el despachador de cancelaciones hacia MT5
   */
  setCancelDispatcher(callback) {
    this.cancelCallback = callback;
  }

  /**
   * Inicia el vigilante periódico de expiración
   */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkExpiredOrders(), this.checkIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Registra una orden pendiente colocada en MT5
   */
  registerPendingOrder(order, channelId, channelName, ttlMinutes = 30) {
    const orderId = order.id ? order.id.toString() : `${Date.now()}_${Math.random()}`;
    const now = Date.now();
    const effectiveTTL = ttlMinutes > 0 ? ttlMinutes : 30;
    const expiresAt = now + effectiveTTL * 60000;

    this.trackedOrders.set(orderId, {
      id: orderId,
      symbol: order.symbol || 'XAUUSD',
      action: order.action,
      entryPrice: order.entryPrice || order.entry,
      channelId,
      channelName,
      createdAt: now,
      ttlMinutes: effectiveTTL,
      expiresAt
    });

    console.log(`⏱️ [Pending Watchdog] Orden pendiente #${orderId} (${order.action} en ${order.entryPrice}) registrada con TTL de ${effectiveTTL} min. Expiración programada: ${new Date(expiresAt).toLocaleTimeString('es-ES')}`);
  }

  /**
   * Marca una orden como ya ejecutada o eliminada manualmente
   */
  removeOrder(orderId) {
    this.trackedOrders.delete(orderId.toString());
  }

  /**
   * Cancela todas las órdenes pendientes asociadas a un canal específico (ej: ante mensaje "CANCEL LIMITS")
   */
  async cancelOrdersForChannel(channelId, symbol = 'XAUUSD') {
    const toDelete = [];
    for (const [id, ord] of this.trackedOrders.entries()) {
      if (ord.channelId === channelId) {
        toDelete.push(id);
      }
    }

    console.log(`🗑️ [Pending Watchdog] Cancelando ${toDelete.length} órdenes pendientes del canal ${channelId}...`);
    for (const id of toDelete) {
      this.trackedOrders.delete(id);
    }

    if (this.cancelCallback) {
      await this.cancelCallback({
        symbol,
        action: 'CANCEL_ALL_PENDING',
        targetType: 'ALL'
      });
    }
  }

  /**
   * Revisa órdenes expiradas y despacha cancelación a MT5
   */
  async checkExpiredOrders() {
    const now = Date.now();
    const expiredList = [];

    for (const [id, ord] of this.trackedOrders.entries()) {
      if (now >= ord.expiresAt) {
        expiredList.push(ord);
        this.trackedOrders.delete(id);
      }
    }

    if (expiredList.length > 0) {
      console.log(`\n⏰ [Pending Watchdog] ¡ATENCIÓN! Detectadas ${expiredList.length} órdenes pendientes expiradas por inactividad (> TTL).`);
      for (const exp of expiredList) {
        console.log(`   ⛔ Expirada: Orden #${exp.id} (${exp.action} en ${exp.entryPrice}) de "${exp.channelName}". Cancelando para evitar SL tardío.`);
        if (this.cancelCallback) {
          await this.cancelCallback({
            symbol: exp.symbol,
            action: 'CANCEL_ALL_PENDING',
            targetType: exp.action.includes('BUY') ? 'BUY_LIMIT' : 'SELL_LIMIT'
          });
        }
      }
    }
  }
}

// Instancia singleton
const pendingOrderManager = new PendingOrderManager();

module.exports = {
  PendingOrderManager,
  pendingOrderManager
};
