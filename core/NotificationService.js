/**
 * Servicio Centralizado de Notificaciones Push (NotificationService)
 * - Formato de alta legibilidad, estética profesional y soporte Multi-Cuenta (The5ers & FTMO)
 * - Soporta doble canal:
 *   1. Telegram MTProto directo (Saved Messages / 'me' del usuario autenticado)
 *   2. Telegram Bot API independiente (mediante Bot Token + Chat ID)
 */

const https = require('https');

class NotificationService {
  constructor() {
    this.client = null; // Instancia de TelegramClient (MTProto)
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || null;
    this.chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID || null;
    this.enabled = true;
    this.lastSentMessageTime = 0;
  }

  /**
   * Conecta el cliente MTProto autenticado en bot_listener.js
   */
  setTelegramClient(client) {
    this.client = client;
    console.log('📱 [NotificationService] Cliente MTProto vinculado para notificaciones a Mensajes Guardados.');
  }

  /**
   * Configura credenciales opcionales de Bot API
   */
  configureBot(token, chatId) {
    this.botToken = token;
    this.chatId = chatId;
    console.log(`🤖 [NotificationService] Bot API configurado (Chat ID: ${chatId}).`);
  }

  /**
   * Envía mensaje por Bot API (HTTP POST)
   */
  async sendViaBotApi(text) {
    if (!this.botToken || !this.chatId) return false;

    return new Promise((resolve) => {
      try {
        const payload = JSON.stringify({
          chat_id: this.chatId,
          text: text,
          parse_mode: 'Markdown'
        });

        const req = https.request({
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${this.botToken}/sendMessage`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 4000
        }, (res) => {
          resolve(res.statusCode === 200);
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });

        req.write(payload);
        req.end();
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * Envía mensaje directamente a "Mensajes Guardados" vía MTProto
   */
  async sendViaMTProto(text) {
    if (!this.client || !this.client.connected) return false;

    try {
      await this.client.sendMessage('me', { message: text });
      return true;
    } catch (err) {
      console.log('⚠️ [NotificationService] Error enviando vía MTProto:', err.message);
      return false;
    }
  }

  /**
   * Envía mensaje usando el mejor canal disponible
   */
  async send(text) {
    if (!this.enabled || !text) return false;

    let delivered = false;

    if (this.botToken && this.chatId) {
      delivered = await this.sendViaBotApi(text);
    }

    if (!delivered && this.client) {
      delivered = await this.sendViaMTProto(text);
    }

    return delivered;
  }

  /**
   * Helper para formatear balance de cuenta de forma precisa
   */
  formatBalance(balance) {
    const num = (typeof balance === 'number' && balance > 0) ? balance : 5000.0;
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
  }

  /**
   * Helper para limpiar nombres de canal de caracteres que rompan el markdown
   */
  cleanName(name) {
    if (!name) return 'Canal VIP';
    return String(name).replace(/[_*`]/g, ' ').trim();
  }

  /**
   * Helper para identificar el nombre de la firma según el broker
   */
  getPropFirmLabel(broker = '', balance = 5000) {
    const b = broker.toLowerCase();
    if (b.includes('five') || b.includes('5%') || b.includes('the5ers')) return 'The5ers';
    if (b.includes('ftmo')) return 'FTMO';
    if (balance >= 80000) return 'FTMO (100k)';
    if (balance <= 6000) return 'The5ers (5k)';
    return broker || 'MT5';
  }

  // =====================================================================
  // 🚀 NOTIFICACIONES DE CICLO DE TRADING
  // =====================================================================

  /**
   * 1. Orden Ejecutada (Silenciado: El usuario configuró recibir únicamente resumen corto de cierres)
   */
  async notifyTradeExecuted(plan, accountAllocations = []) {
    return true;
  }

  /**
   * 2. Cierre de Operación (Resumen Corto y de Alta Legibilidad)
   */
  async notifyTradeClosed({ position, symbol, outcome, profitUSD, pips, balance, accountId, broker, channelName, initialBalance, targetProfitBalance }) {
    const isWin = outcome === 'WIN' || profitUSD >= 0;
    const emoji = isWin ? '✅' : '🛑';
    const statusLabel = isWin ? 'WIN' : 'LOSS';
    const sign = profitUSD >= 0 ? '+' : '';
    const formattedBal = this.formatBalance(balance);
    const firm = this.getPropFirmLabel(broker, balance);

    const pipsNum = typeof pips === 'number' ? pips : parseFloat(pips);
    const pipsStr = !isNaN(pipsNum) ? ` (${pipsNum >= 0 ? '+' : ''}${pipsNum.toFixed(1)}p)` : '';

    const lines = [
      `${emoji} *CIERRE | ${symbol || 'XAUUSD'}* — *${statusLabel}*${pipsStr}`,
      `💵 *Resultado:* \`${sign}$${(profitUSD || 0).toFixed(2)} USD\``,
      `🏦 *Cuenta:* ${firm} ➔ \`${formattedBal}\``
    ];

    const msg = lines.join('\n');
    return this.send(msg);
  }

  /**
   * 3. Break-Even Activado (Riesgo $0)
   */
  async notifyBreakEven(symbol, channelName, bePrice) {
    const channel = this.cleanName(channelName);
    const msg = [
      `🛡️ *BREAK-EVEN ACTIVADO | RIESGO $0*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🪙 *Par:* \`${symbol || 'XAUUSD'}\``,
      `📡 *Canal:* ${channel}`,
      `📈 *Estado:* Objetivo de +25 pips alcanzado`,
      `🔒 *SL Asegurado:* \`${bePrice}\` (+2 pips sobre entrada)`,
      `💰 *Riesgo Actual:* \`$0.00 USD\` (Capital 100% blindado)`,
      `🎯 Rumbo a Take Profit 2 con tranquilidad.`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * 4. Parámetros Oficiales Confirmados (actualización tras orden provisional)
   */
  async notifyParamsUpdated(symbol, channelName, sl, tp) {
    const channel = this.cleanName(channelName);
    const msg = [
      `🔄 *PARÁMETROS CONFIRMADOS*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🪙 *Par:* \`${symbol || 'XAUUSD'}\``,
      `📡 *Canal:* ${channel}`,
      `🛑 *Stop Loss Oficial:* \`${sl}\``,
      `🎯 *Take Profit Oficial:* \`${tp || 'Abierto / Dinámico'}\``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * 5. Señal de Estrategia Institucional BPR Multi-TF
   */
  async notifyBprSignal(trade, accountAllocations = []) {
    const action = trade.type.toUpperCase();
    const actionEmoji = action === 'BUY' ? '🟢' : '🔴';
    const tf = trade.timeframe || 'M3';
    const modeTag = trade.isLive ? '⚡ *[OPERATIVA REAL MT5]*' : '🧪 _(Shadow Test)_';

    const lines = [
      `⚡ *ESTRATEGIA INSTITUCIONAL BPR (${tf})* ${modeTag}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🎯 *Acción:* *${action} ${trade.symbol}* ${actionEmoji} @ \`${trade.entryPrice.toFixed(2)}\``,
      `🛑 *Stop Loss:* \`${trade.initialSL.toFixed(2)}\` (-${trade.slPips || 15} pips)`,
      `🎯 *TP1:* \`${trade.tp1Price.toFixed(2)}\` (+${trade.tp1Pips || 30}p) | *TP2:* \`${trade.tp2Price.toFixed(2)}\` (+${trade.tp2Pips || 60}p)`,
      `🛡️ *Auto-BE:* activable a +${trade.autoBePips || 20} pips (Riesgo $0)`,
      `📐 *Filtros:* BPR Retest + EMA 100 + Mecha de rechazo >= 25%`
    ];

    if (Array.isArray(accountAllocations) && accountAllocations.length > 0) {
      lines.push(``);
      lines.push(`🏦 *Asignación por Cuenta:*`);
      for (const acc of accountAllocations) {
        const firm = this.getPropFirmLabel(acc.broker, acc.balance);
        const balStr = `$${Math.round(acc.balance).toLocaleString()}`;
        lines.push(`  • *${firm} (${balStr}):* \`${acc.lot} lotes\``);
      }
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const msg = lines.join('\n');
    return this.send(msg);
  }

  /**
   * 6. Cierre de Trade BPR Multi-TF
   */
  async notifyBprTradeClosed(trade, metrics) {
    const isWin = trade.pips >= 0;
    const emoji = isWin ? '🎉' : '🛑';
    const sign = trade.pips >= 0 ? '+' : '';
    const tf = trade.timeframe || 'M3';
    const modeTag = trade.isLive ? '⚡ *[REAL MT5]*' : '🧪 _(Shadow Test)_';

    const msg = [
      `${emoji} *BPR INSTITUCIONAL CERRADO (${tf})* ${modeTag}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🪙 *Par:* \`${trade.symbol}\``,
      `📊 *Resultado:* \`${sign}${trade.pips} pips\` (${trade.reason})`,
      ``,
      `📈 *Métricas Acumuladas BPR:*`,
      `  • *Win Rate:* \`${metrics.winRate}%\``,
      `  • *Pips Netos:* \`${metrics.netPips >= 0 ? '+' : ''}${metrics.netPips} pips\``,
      `  • *Profit Factor:* \`${metrics.profitFactor}\``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * 7. Alerta News Guard (Noticias de Alto Impacto)
   */
  async notifyNewsGuard(eventName, eventTime, bufferMinutes) {
    const msg = [
      `🚨 *NEWS GUARD | IMPACTO ALTO (USD)*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📅 *Evento:* \`${eventName}\``,
      `⏱️ *Horario Noticia:* \`${eventTime}\``,
      `⏸️ *Acción:* Nuevas entradas en Oro en pausa por ${bufferMinutes} min.`,
      `🛡️ _Protección activa contra slippage y ensanchamiento de spreads bancarios._`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * 8. Rollover Shield (22:55 - 00:10 CET)
   */
  async notifyRolloverShield(active) {
    if (active) {
      const msg = [
        `🌙 *ROLLOVER SHIELD ACTIVADO (22:55 - 00:10 CET)*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🔒 *Estado:* Operativa pausada`,
        `🛡️ _Protección contra el ensanchamiento nocturno de spreads interbancarios._`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`
      ].join('\n');
      return this.send(msg);
    } else {
      const msg = [
        `☀️ *ROLLOVER SHIELD FINALIZADO*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `✅ *Estado:* Spreads interbancarios normalizados`,
        `⚡ _Operativa regular restablecida en todas las cuentas._`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━`
      ].join('\n');
      return this.send(msg);
    }
  }

  /**
   * 9. Daily NY Close Guard (No Overnight)
   */
  async notifyDailyClose(active) {
    const msg = [
      `🔒 *CIERRE DIARIO NY (21:45 CET) | NO OVERNIGHT*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `💼 *Normativa Prop Firm:* Prohibido mantener posiciones overnight.`,
      `🛡️ Todas las operaciones abiertas liquidadas y órdenes pendientes eliminadas.`,
      `💰 *Riesgo $0 nocturno asegurado.*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * 10. Friday Close Guard
   */
  async notifyFridayClose(active) {
    const msg = [
      `🔒 *FRIDAY CLOSE GUARD (21:30 CET)*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🏖️ *Fin de Semana:* Mercado cerrando.`,
      `🛡️ Todas las posiciones liquidadas. Cero riesgo de gaps durante el fin de semana.`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * 11. Circuit Breaker / Stop Trading Diario
   */
  async notifyCircuitBreaker(reason, dailyPnL, balance) {
    const isProfit = (dailyPnL || 0) >= 0;
    const emoji = isProfit ? '🎉' : '🚨';
    const formattedBal = this.formatBalance(balance);

    const msg = [
      `${emoji} *CIRCUIT BREAKER | STOP TRADING DIARIO*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📊 *PnL de la Sesión:* \`${isProfit ? '+' : ''}$${(dailyPnL || 0).toFixed(2)} USD\``,
      `💰 *Saldo Protegido:* \`${formattedBal}\``,
      `🛡️ *Motivo:* ${reason}`,
      `🔒 Operativa suspendida hasta la próxima sesión de mercado.`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    return this.send(msg);
  }
}

const notificationService = new NotificationService();

module.exports = {
  NotificationService,
  notificationService
};
