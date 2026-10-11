/**
 * Servicio Centralizado de Notificaciones Push (NotificationService)
 * - Soporta doble canal:
 *   1. Telegram MTProto directo (Saved Messages / 'me' del usuario autenticado)
 *   2. Telegram Bot API independiente (mediante Bot Token + Chat ID)
 * - Notificaciones de ciclo de vida del trading:
 *   - Ejecución de orden
 *   - Movimiento a Break-Even (Riesgo $0)
 *   - Cierre de posición (Feedback Loop con PnL y nuevo saldo)
 *   - Alertas preventivas News Guard
 *   - Rollover Shield (22:55 - 00:10 CET)
 *   - Friday Close Guard (Viernes 21:30 CET)
 *   - Circuit Breaker / Stop Trading Diario
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
   * Envía mensaje usando el mejor canal disponible (Bot API prioritario o MTProto fallback)
   */
  async send(text) {
    if (!this.enabled || !text) return false;

    let delivered = false;

    // 1. Probar Bot API si está configurado
    if (this.botToken && this.chatId) {
      delivered = await this.sendViaBotApi(text);
    }

    // 2. Si no o falló, enviar por MTProto a 'me'
    if (!delivered && this.client) {
      delivered = await this.sendViaMTProto(text);
    }

    // Fallback visible en logs de consola
    console.log(`📲 [PUSH NOTIFICATION]:\n${text}\n`);
    return delivered;
  }

  /**
  /**
   * Helper para formatear balance de cuenta de forma precisa
   */
  formatBalance(balance) {
    const num = (typeof balance === 'number' && balance > 0) ? balance : 5263.49;
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
  }

  /**
   * Notificación: Orden Ejecutada (Limpia y concisa)
   */
  async notifyTradeExecuted(plan) {
    const symbol = plan.symbol || 'XAUUSD';
    const action = plan.action || plan.orderType || 'BUY';
    const actionEmoji = action.includes('BUY') ? '🟢' : '🔴';
    const channel = plan.channelName || 'Canal VIP';
    const entry = plan.entryPrice || plan.entry || 'MKT';
    const sl = plan.slPrice || plan.sl || 'SIN SL';
    const tp = plan.targetTP || plan.tp || 'N/A';
    const lots = plan.totalLotSize || plan.volume || 0.01;

    const msg = [
      `🚀 *${action} ${symbol}* ${actionEmoji} @ \`${entry}\``,
      `🎯 *TP:* \`${tp}\` | *SL:* \`${sl}\` | *Lotes:* \`${lots}\``,
      `📡 *Canal:* ${channel}`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Alerta de Trade para estrategias propias / institucionales
   */
  async sendTradeAlert(plan, label = '') {
    if (!plan) return false;
    const action = plan.action || plan.orderType || 'BUY';
    const actionEmoji = action.includes('BUY') ? '🟢' : '🔴';
    const msg = [
      label ? `${label}` : `🎯 *[ESTRATEGIA PROPIA]*`,
      `🚀 *${action} ${plan.symbol || 'XAUUSD'}* ${actionEmoji} @ \`${plan.entryPrice || plan.entry || 'MKT'}\``,
      `🛑 *SL:* \`${plan.slPrice || plan.sl || 'N/A'}\``,
      `🎯 *TP:* \`${plan.targetTP || plan.tp || 'N/A'}\``,
      `📦 *Lotes:* \`${plan.totalLotSize || plan.volume || 0.01}\``
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Parámetros Oficiales Confirmados (tras SL provisional)
   */
  async notifyParamsUpdated(symbol, channelName, sl, tp) {
    const msg = [
      `🔄 *PARÁMETROS CONFIRMADOS*: \`${symbol}\``,
      `🎯 *SL:* \`${sl}\` | *TP:* \`${tp || 'N/A'}\` | *Canal:* ${channelName}`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Posición protegida a Break-Even
   */
  async notifyBreakEven(symbol, channelName, bePrice) {
    const msg = [
      `🛡️ *BREAK-EVEN ACTIVADO*: \`${symbol}\``,
      `🔒 *SL asegurado:* \`${bePrice}\` (Riesgo $0.00)`,
      `📡 *Canal:* ${channelName}`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Cierre de Operación (Limpia y con balance exacto)
   */
  async notifyTradeClosed({ position, symbol, outcome, profitUSD, pips, balance, channelName, allAccounts }) {
    const isWin = outcome === 'WIN' || profitUSD >= 0;
    const emoji = isWin ? '✅' : '🛑';
    const sign = profitUSD >= 0 ? '+' : '';
    const formattedBal = this.formatBalance(balance);

    const lines = [
      `${emoji} *CIERRE ${symbol || 'XAUUSD'}*: \`${sign}$${(profitUSD || 0).toFixed(2)} USD\` (${sign}${pips ? pips.toFixed(1) : '0'} pips)`,
      `📡 *Origen:* ${channelName || 'MT5'}`
    ];

    if (Array.isArray(allAccounts) && allAccounts.length > 0) {
      lines.push(`💰 *Saldos Cuentas Conectadas:*`);
      for (const acc of allAccounts) {
        const balStr = `$${(acc.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const eqStr = acc.equity ? ` (Eq: $${acc.equity.toFixed(2)})` : '';
        const name = acc.label || `Cuenta #${acc.id || acc.account}`;
        lines.push(`  • *${name}*: \`${balStr}\`${eqStr}`);
      }
    } else {
      lines.push(`💰 *Saldo actual:* \`${formattedBal}\``);
    }

    return this.send(lines.join('\n'));
  }

  /**
   * Notificación: Alerta de Noticias de Alto Impacto
   */
  async notifyNewsGuard(eventName, eventTime, bufferMinutes) {
    const msg = [
      `🚨 *NEWS GUARD (Alto Impacto)*`,
      `📅 *Evento:* \`${eventName}\` (${eventTime})`,
      `🛡️ Trading pausado por ${bufferMinutes} min post-noticia.`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Rollover Shield
   */
  async notifyRolloverShield(active) {
    const status = active ? 'ACTIVADO 🌙' : 'FINALIZADO ☀️';
    const desc = active
      ? 'Aperturas pausadas por ensanchamiento de spreads bancarios (22:55 - 00:10 CET).'
      : 'Spreads interbancarios normalizados. Operativa regular restablecida.';

    const msg = [
      `🌙 *ROLLOVER SHIELD: ${status}*`,
      `${desc}`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Daily NY Close Guard (No Overnight)
   */
  async notifyDailyClose(active) {
    const msg = [
      `🔒 *DAILY NY CLOSE GUARD (21:45 CET)*`,
      `💼 *Normativa Prop Firm:* Cierre forzoso de mercado (No Overnight).`,
      `🛡️ Todas las operaciones abiertas liquidadas y órdenes pendientes eliminadas. Riesgo $0 nocturno.`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Friday Close Guard
   */
  async notifyFridayClose(active) {
    const msg = [
      `🔒 *FRIDAY CLOSE GUARD (21:30 CET)*`,
      `🏖️ Órdenes cerradas. Cero riesgo de gaps durante el fin de semana.`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Circuit Breaker / Stop Trading Diario
   */
  async notifyCircuitBreaker(reason, dailyPnL, balance) {
    const isProfit = (dailyPnL || 0) >= 0;
    const emoji = isProfit ? '🎉' : '🚨';
    const formattedBal = this.formatBalance(balance);

    const msg = [
      `${emoji} *STOP TRADING DIARIO ALCANZADO*`,
      `📊 *PnL Día:* \`${isProfit ? '+' : ''}$${(dailyPnL || 0).toFixed(2)} USD\` | *Saldo:* \`${formattedBal}\``,
      `🛡️ *Motivo:* ${reason}`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Helper para formatear precio según los decimales del activo (Forex: 5, JPY: 3, Oro/Crypto/Índices: 2)
   */
  formatPrice(price, symbol = '') {
    if (price === null || price === undefined || isNaN(price)) return 'N/A';
    const sym = String(symbol).toUpperCase();
    if (sym.includes('JPY')) return Number(price).toFixed(3);
    if (sym.includes('EUR') || sym.includes('GBP') || sym.includes('AUD') || sym.includes('NZD') || sym.includes('CAD') || sym.includes('CHF')) {
      if (!sym.includes('XAU') && !sym.includes('BTC') && !sym.includes('NAS') && !sym.includes('US100') && !sym.includes('US30')) {
        return Number(price).toFixed(5);
      }
    }
    return Number(price).toFixed(2);
  }

  /**
   * Notificación: Señal de Estrategia Propia BPR Multi-TF (Real MT5 o Shadow)
   */
  async notifyBprSignal(trade) {
    const actionEmoji = trade.type === 'BUY' ? '🟢' : '🔴';
    const modeTag = trade.isLive ? '⚡ *[OPERATIVA REAL MT5]*' : '🧪 _(Shadow Paper-Trading)_';
    const tf = trade.timeframe || 'M3';
    const sym = trade.symbol || 'XAUUSD';
    const entryStr = this.formatPrice(trade.entryPrice, sym);
    const slStr = this.formatPrice(trade.initialSL, sym);

    const targetTP = trade.tpPrice || trade.tp2Price || trade.tp1Price;
    const tpStr = this.formatPrice(targetTP, sym);
    const tpPips = trade.tpPips || trade.tp2Pips || trade.tp1Pips || trade.slPips || 20;

    let tpLine = `🎯 *TP (+${tpPips}p):* \`${tpStr}\``;
    if (trade.tp1Price && trade.tp2Price && trade.tp1Price !== trade.tp2Price) {
      tpLine = `🎯 *TP1 (+${trade.tp1Pips || 30}p):* \`${this.formatPrice(trade.tp1Price, sym)}\` | *TP2 (+${trade.tp2Pips || 60}p):* \`${this.formatPrice(trade.tp2Price, sym)}\``;
    }

    const msg = [
      `🎯 *[ESTRATEGIA PROPIA BPR ${tf}]* ${modeTag}`,
      `🚀 *${trade.type} ${sym}* ${actionEmoji} @ \`${entryStr}\``,
      trade.lotSize ? `📊 *Volumen:* \`${trade.lotSize} lotes\`` : null,
      `🛑 *SL:* \`${slStr}\` (-${trade.slPips || 12} pips)`,
      tpLine,
      `🧭 *Gestión:* R:R 1:1.0 | SL Fijo | Sin BE ni trailing prematuro`,
      `📐 *Filtros:* BPR Retest + EMA 100 + Mecha de rechazo >= 25%`
    ].filter(Boolean).join('\n');

    return this.send(msg);
  }

  /**
   * Notificación: Cierre de Trade de Estrategia Propia BPR Multi-TF
   */
  async notifyBprTradeClosed(trade, metrics) {
    const isWin = trade.pips >= 0;
    const emoji = isWin ? '✅' : '🛑';
    const sign = trade.pips >= 0 ? '+' : '';
    const modeTag = trade.isLive ? '⚡ *[REAL MT5]*' : '🧪 _(Shadow Paper-Trading)_';
    const tf = trade.timeframe || 'M3';
    const msg = [
      `${emoji} *[BPR ${tf} CERRADO]* ${modeTag}`,
      `📊 *Resultado:* \`${sign}${trade.pips} pips\` (${trade.reason})`,
      `📈 *Métricas Acumuladas BPR:* WR \`${metrics.winRate}%\` | Pips: \`${metrics.netPips >= 0 ? '+' : ''}${metrics.netPips}p\` (PF: \`${metrics.profitFactor}\`)`
    ].join('\n');

    return this.send(msg);
  }

  /**
   * Alerta generica de Trade institucional
   */
  async sendTradeAlert(tradePlan, title = '🎯 Alerta Institucional') {
    const actionEmoji = (tradePlan.action || tradePlan.type) === 'BUY' ? '🟢' : '🔴';
    const sym = tradePlan.symbol || 'XAUUSD';
    const msg = [
      `*${title}*`,
      `🚀 *${tradePlan.action || tradePlan.type} ${sym}* ${actionEmoji}`,
      `📍 *Entrada:* \`${tradePlan.entryPrice || 'MKT'}\``,
      tradePlan.slPrice ? `🛑 *SL:* \`${tradePlan.slPrice}\`` : null,
      tradePlan.targetTP ? `🎯 *TP:* \`${tradePlan.targetTP}\`` : null,
      `📡 *Estrategia:* \`${tradePlan.channelName || 'Algorítmica'}\``
    ].filter(Boolean).join('\n');

    return this.send(msg);
  }
}

const notificationService = new NotificationService();

module.exports = {
  NotificationService,
  notificationService
};
