/**
 * Motor de Gestión de Riesgo Modular (RiskEngine)
 * - Soporta modos 'PERSONAL' y 'PROP_FIRM'
 * - Cálculo dinámico de lotaje por distancia al Stop Loss
 * - Control de reducción automática de riesgo para canales en racha perdedora
 * - 🛑 CIRCUITO DE FRENO DE EMERGENCIA & STOP TRADING:
 *   - Meta Diaria de Beneficio alcanzada -> Stop Trading automático
 *   - Límite Máximo de Pérdida Diaria alcanzado -> Freno de Emergencia automático
 *   - Botón de Pánico Manual (Pausar / Reanudar)
 */

const CONFIG = {
  MODE: 'PROP_FIRM', // 'PERSONAL' | 'PROP_FIRM' (Predeterminado: PROP_FIRM institucional)
  accountBalance: 5263.49, // Saldo real auditado The5%ers ($5,263.49 USD)

  PERSONAL: {
    riskPercent: 2.0,
    maxSlippagePips: 5.0,
    maxStopLossPips: 100, // Máximo 100 pips de riesgo admitidos por operación
  },

  PROP_FIRM: {
    riskPercent: 0.75, // Riesgo por trade en fase de examen (0.75%)
    maxOpenTrades: 2, // 🛡️ Regla 2: Máximo 2 posiciones simultáneas en toda la cuenta
    maxTotalRiskPercent: 1.5, // 🛡️ Regla 3: Máximo 1.5% de riesgo acumulado en mercado
    antiHedging: true, // Regla 1: Prohibido operar direcciones opuestas en el mismo par
    breakEvenSlotRelease: true, // Regla 4: Al entrar en BE, el riesgo es 0 y se libera slot
    newsBufferMinutes: 15, // Reglas 5 y 6: Cerrar 15 min antes y bloquear 15 min después de noticia roja
    dailyMaxDrawdownPercent: 2.5, // 🛡️ Límite interno conservador 2.5% como colchón preventivo ante el 5% de la prop firm
    totalMaxDrawdownPercent: 10.0, // Regla 7: Límite de pérdida total 10.0%
    dailyProfitTargetUSD: 300.0, // Regla 8: Take Profit diario configurable (+$300/día)
    targetEvaluationBalance: 5500.0, // 🎯 Meta Global Fase 1: $5,500 USD (+10%). Al alcanzarse se congela la operativa.
    maxSlippagePips: 3.0,
    maxStopLossPips: 100,
    maxLotSize: 2.0
  }
};

class RiskEngine {
  constructor(config = CONFIG) {
    this.config = config;
    this.startDayBalance = null; // Se inicializa con el primer saldo real recibido de MT5
    this.currentDay = new Date().toISOString().split('T')[0];

    // Parámetros de Stop Trading Diario según modo
    const isProp = this.config.MODE === 'PROP_FIRM';
    this.dailyTargetProfitUSD = isProp ? (this.config.PROP_FIRM.dailyProfitTargetUSD || 300.0) : 25.0;
    this.dailyMaxLossUSD = isProp ? 300.0 : 20.0; // $300 en 10k (3.0% buffer de seguridad preventivo)
    this.activePositionsCount = 0; // Conteo en vivo de órdenes activas reportado por MT5
    this.tradingPaused = false;
    this.pauseReason = '';
  }

  get currentBalance() {
    return this.config.accountBalance;
  }

  set currentBalance(val) {
    if (typeof val === 'number' && val > 0) {
      const today = new Date().toISOString().split('T')[0];
      if (this.currentDay !== today || this.startDayBalance === null) {
        this.currentDay = today;
        this.startDayBalance = val;
        this.tradingPaused = false;
        this.pauseReason = '';
        if (this.config.MODE === 'PROP_FIRM') {
          this.dailyMaxLossUSD = (val * (this.config.PROP_FIRM.dailyMaxDrawdownPercent || 3.0)) / 100;
        }
      } else if (this.startDayBalance !== null && Math.abs(val - this.startDayBalance) > (this.startDayBalance * 0.3)) {
        console.log(`🔄 [Cuenta Modificada / Saldo Reiniciado]: Detectado cambio de saldo base (${this.startDayBalance} -> ${val}). Reiniciando métricas del día.`);
        this.startDayBalance = val;
        this.tradingPaused = false;
        this.pauseReason = '';
        if (this.config.MODE === 'PROP_FIRM') {
          this.dailyMaxLossUSD = (val * (this.config.PROP_FIRM.dailyMaxDrawdownPercent || 3.0)) / 100;
        }
      }
      this.config.accountBalance = val;
    }
  }

  get currentRiskPercent() {
    const modeConfig = this.config[this.config.MODE] || this.config.PERSONAL;
    return modeConfig.riskPercent || 2.0;
  }

  get dailyPnL() {
    if (this.startDayBalance === null) return 0.0;
    return parseFloat((this.config.accountBalance - this.startDayBalance).toFixed(2));
  }

  get dailyPnLPercent() {
    if (!this.startDayBalance || this.startDayBalance <= 0) return '0.0%';
    const pct = ((this.dailyPnL / this.startDayBalance) * 100).toFixed(2);
    return `${pct}%`;
  }

  /**
   * Obtiene la hora actual en zona horaria europea CET/CEST (Madrid)
   */
  getMadridTime(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Madrid',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(date);

    let weekday = '';
    let hour = 0;
    let minute = 0;
    for (const p of parts) {
      if (p.type === 'weekday') weekday = p.value;
      if (p.type === 'hour') hour = parseInt(p.value, 10);
      if (p.type === 'minute') minute = parseInt(p.value, 10);
    }
    return { weekday, hour, minute, totalMinutes: hour * 60 + minute };
  }

  /**
   * 🌙 Comprueba si estamos en la ventana de Rollover Shield (22:55 - 00:10 CET)
   * Durante esta ventana los spreads de Oro y divisas se ensanchan exponencialmente por liquidación interbancaria.
   */
  isRolloverWindow(date = new Date()) {
    const { totalMinutes } = this.getMadridTime(date);
    // 22:55 = 1375 minutos | 00:10 = 10 minutos
    return totalMinutes >= 1375 || totalMinutes <= 10;
  }

  /**
   * 🔒 Comprueba si estamos en la ventana de Friday Close Guard
   * Desde viernes 21:30 CET hasta reapertura domingo 23:00 CET.
   */
  isFridayCloseWindow(date = new Date()) {
    const { weekday, totalMinutes } = this.getMadridTime(date);
    if (weekday === 'Fri' && totalMinutes >= 1290) return true;
    if (weekday === 'Sat') return true;
    if (weekday === 'Sun' && totalMinutes < 1380) return true;
    return false;
  }

  /**
   * 🔒 Comprueba si estamos en la ventana de Cierre Diario Preventivo / No Overnight (Lunes a Jueves 21:45 a 22:55 CET)
   * En Prop Firms con regla "No Overnight Holding", liquida y bloquea operaciones antes del cierre de NY,
   * entregando el relevo al Rollover Shield a las 22:55 CET.
   */
  isDailyCloseWindow(date = new Date()) {
    const { weekday, totalMinutes } = this.getMadridTime(date);
    // Viernes y fin de semana están gobernados por isFridayCloseWindow
    if (weekday === 'Fri' && totalMinutes >= 1290) return false;
    if (weekday === 'Sat' || weekday === 'Sun') return false;

    // Lunes a Jueves: 21:45 CET (1305 min) hasta 22:55 CET (1375 min)
    return totalMinutes >= 1305 && totalMinutes < 1375;
  }

  /**
   * 🛑 VERIFICADOR DE STOP TRADING:
   * Evalúa botones de pánico, Rollover Shield, Friday Close Guard, Daily Close y reglas de Prop Firm.
   * @param {Date} [checkDate=new Date()]
   * @param {{ bypassTimeShields?: boolean }} [options={}]
   * @returns {{ allowed: boolean, reason: string }}
   */
  checkTradingAllowed(checkDate = new Date(), options = {}) {
    // Si el usuario pausó manualmente desde el botón de pánico
    if (this.tradingPaused) {
      return {
        allowed: false,
        reason: this.pauseReason || 'Trading pausado manualmente por el usuario.'
      };
    }

    // 🔒 FRIDAY CLOSE GUARD (Viernes 21:30 CET hasta Domingo 23:00 CET)
    if (!options.bypassTimeShields && this.isFridayCloseWindow(checkDate)) {
      return {
        allowed: false,
        reason: '🔒 [FRIDAY CLOSE GUARD] Mercado cerrado para fin de semana. Aperturas bloqueadas de Viernes 21:30 a Domingo 23:00 CET para evitar gaps geopolíticos.'
      };
    }

    // 🔒 DAILY NY CLOSE GUARD (Lunes a Jueves 21:45 a 00:30 CET - No Overnight Holding)
    if (!options.bypassTimeShields && this.isDailyCloseWindow(checkDate)) {
      return {
        allowed: false,
        reason: '🔒 [DAILY NY CLOSE GUARD] Cierre diario de sesión activo (21:45 - 00:30 CET). Aperturas bloqueadas para cumplir la regla estricta No Overnight de Prop Firms.'
      };
    }

    // 🌙 ROLLOVER SHIELD (22:55 - 00:10 CET)
    if (!options.bypassTimeShields && this.isRolloverWindow(checkDate)) {
      return {
        allowed: false,
        reason: '🌙 [ROLLOVER SHIELD] Aperturas bloqueadas entre 22:55 y 00:10 CET por ensanchamiento agresivo de spreads interbancarios.'
      };
    }

    // 🛑 REGLA 2: Límite estricto de operaciones activas simultáneas en mercado
    if (this.config.MODE === 'PROP_FIRM' && this.activePositionsCount >= (this.config.PROP_FIRM.maxOpenTrades || 2)) {
      return {
        allowed: false,
        reason: `⚠️ [PROP FIRM - REGLA 2] Límite de ${this.config.PROP_FIRM.maxOpenTrades} operaciones activas alcanzado (${this.activePositionsCount} abiertas). Slot de riesgo no disponible.`
      };
    }

    const pnl = this.dailyPnL;

    // Reglas exclusivas para cuentas de Fondeo (PROP_FIRM):
    // (Nota: La meta global de evaluación +10% se gestiona individualmente por cuenta en mt5_bridge.js)
    // 1. Meta de Ganancia Diaria Alcanzada
    if (this.dailyTargetProfitUSD > 0 && pnl >= this.dailyTargetProfitUSD) {
      this.tradingPaused = true;
      this.pauseReason = `🎯 [PROP FIRM] Meta diaria alcanzada (+$${pnl.toFixed(2)} USD). Trading pausado por reglas de consistencia.`;
      console.log(`🎯 [PROP FIRM STOP]: ${this.pauseReason}`);
      return { allowed: false, reason: this.pauseReason };
    }

    // 2. Límite de Pérdida Diaria (Drawdown Estricto 5.0% / $500 en 10k)
    if (this.dailyMaxLossUSD > 0 && pnl <= -this.dailyMaxLossUSD) {
      this.tradingPaused = true;
      this.pauseReason = `🚨 [PROP FIRM] Límite de pérdida diaria alcanzado (-$${Math.abs(pnl).toFixed(2)} USD). Freno de emergencia activado.`;
      console.log(`🚨 [PROP FIRM FRENO]: ${this.pauseReason}`);
      return { allowed: false, reason: this.pauseReason };
    }

    // Flujo continuo sin freno por metas diarias en MODO PERSONAL
    if (this.config.MODE !== 'PROP_FIRM') {
      return { allowed: true, reason: '' };
    }

    return { allowed: true, reason: '' };
  }

  /**
   * 🛡️ REGLA 1: Comprobación Estricta de Anti-Hedging (Prop Firms vs Capital Propio)
   * En cuentas PROP_FIRM, está terminantemente prohibido abrir posiciones en sentido opuesto
   * en el mismo activo. En cuentas PERSONAL (Capital Propio) sí está permitido si el usuario lo desea.
   */
  checkAntiHedging(symbol, action, openBuy = 0, openSell = 0, mode = 'PROP_FIRM') {
    if (mode !== 'PROP_FIRM') {
      return { allowed: true, reason: '' };
    }

    const isBuy = action === 'BUY' || action === 'BUY_LIMIT' || action === 'BUY_STOP' || action === 'BUY NOW';
    const isSell = action === 'SELL' || action === 'SELL_LIMIT' || action === 'SELL_STOP' || action === 'SELL NOW';

    if (isBuy && openSell > 0) {
      return {
        allowed: false,
        reason: `⚠️ [PROP FIRM - REGLA 1 ANTI-HEDGING] Prohibido abrir BUY en ${symbol}: existen ${openSell} posiciones de SELL abiertas.`
      };
    }

    if (isSell && openBuy > 0) {
      return {
        allowed: false,
        reason: `⚠️ [PROP FIRM - REGLA 1 ANTI-HEDGING] Prohibido abrir SELL en ${symbol}: existen ${openBuy} posiciones de BUY abiertas.`
      };
    }

    return { allowed: true, reason: '' };
  }

  /**
   * Pausa o reanuda manualmente el trading
   */
  setTradingPaused(paused, reason = '') {
    this.tradingPaused = !!paused;
    this.pauseReason = paused ? (reason || 'Pausado manualmente por el usuario') : '';
  }

  /**
   * Actualiza los objetivos de ganancia y pérdida desde el Dashboard
   */
  setDailyTargets({ targetProfitUSD, maxLossUSD }) {
    if (typeof targetProfitUSD === 'number' && targetProfitUSD >= 0) {
      this.dailyTargetProfitUSD = targetProfitUSD;
    }
    if (typeof maxLossUSD === 'number' && maxLossUSD >= 0) {
      this.dailyMaxLossUSD = maxLossUSD;
    }
    console.log(`🎯 [Objetivos Actualizados]: Meta Ganancia: +$${this.dailyTargetProfitUSD} USD | Máx Pérdida: -$${this.dailyMaxLossUSD} USD`);
  }

  /**
   * Calcula el lotaje óptimo según balance y distancia al SL
   */
  calculateLotSize(entryPrice, slPrice, symbol = 'XAUUSD', isReducedRisk = false, targetBalance = null, accountMode = null, customRiskPercent = null) {
    const activeMode = accountMode || this.config.MODE;
    let effectiveRiskPercent = (typeof customRiskPercent === 'number' && customRiskPercent > 0)
      ? customRiskPercent
      : ((activeMode === 'PERSONAL') ? (this.config.PERSONAL.riskPercent || 2.0) : this.currentRiskPercent);

    if (isReducedRisk) {
      effectiveRiskPercent = effectiveRiskPercent / 2.0;
    }

    const currentBal = (typeof targetBalance === 'number' && targetBalance > 0) ? targetBalance : this.config.accountBalance;
    const riskAmount = (currentBal * effectiveRiskPercent) / 100;
    const pipsRisk = Math.abs(entryPrice - slPrice);
    const symUpper = symbol.toUpperCase();

    if (!entryPrice || !slPrice || isNaN(pipsRisk) || pipsRisk <= 0) {
      if (symUpper.includes('XAU') || symUpper.includes('GOLD')) {
        if (activeMode === 'PERSONAL') {
          const defaultLotGold = riskAmount / 200.0; // SL típico de 2.0 USD ($200/lote)
          return Math.max(0.01, Math.floor(defaultLotGold * 100) / 100);
        }
        return Math.max(0.01, Math.floor((currentBal / 50000.0) * 100) / 100);
      }
      if (symUpper.includes('JPY')) {
        const defaultPipRiskJPY = 8.0;
        const defaultLotJPY = riskAmount / (defaultPipRiskJPY * 6.70);
        if (activeMode === 'PERSONAL') {
          return Math.max(0.01, Math.floor(defaultLotJPY * 100) / 100);
        }
        const jpyCap = Math.max(0.01, Math.floor((currentBal / 5000.0) * 100) / 100);
        return Math.max(0.01, Math.min(Math.floor(defaultLotJPY * 100) / 100, jpyCap));
      }
      if (symUpper.includes('NAS') || symUpper.includes('US100') || symUpper.includes('USTEC')) {
        const defaultPointRiskNAS = 15.0;
        const defaultLotNAS = riskAmount / (defaultPointRiskNAS * 1.0);
        if (activeMode === 'PERSONAL') {
          return Math.max(0.01, Math.min(Math.floor(defaultLotNAS * 100) / 100, 20.0));
        }
        const nasCap = Math.max(0.01, Math.floor((currentBal / 5000.0) * 100) / 100);
        return Math.max(0.01, Math.min(Math.floor(defaultLotNAS * 100) / 100, nasCap, 20.0));
      }
      const defaultPipRisk = 4.0;
      const defaultLot = riskAmount / (defaultPipRisk * 10.0);
      if (activeMode === 'PERSONAL') {
        return Math.max(0.01, Math.floor(defaultLot * 100) / 100);
      }
      const forexCap = Math.max(0.01, Math.floor((currentBal / 5000.0) * 100) / 100);
      return Math.max(0.01, Math.min(Math.floor(defaultLot * 100) / 100, forexCap));
    }

    let lotSize = 0.01;

    if (symUpper.includes('XAU') || symUpper.includes('GOLD')) {
      const riskPerLot = pipsRisk * 100;
      lotSize = riskAmount / riskPerLot;
    } else if (symUpper.includes('JPY')) {
      // En pares con JPY: 1 pip = 0.01 (2º decimal)
      // Valor del pip por lote estándar = 1,000 JPY / USDJPY (aprox $6.70 USD)
      const pips = pipsRisk * 100.0;
      const pipValuePerLot = 6.70;
      lotSize = riskAmount / (pips * pipValuePerLot);
    } else if (symUpper.includes('NAS') || symUpper.includes('US100') || symUpper.includes('USTEC')) {
      // En Índices (NAS100): 1 punto = $1 USD por lote estándar
      const points = pipsRisk;
      lotSize = riskAmount / (points * 1.0);
    } else {
      const pipValuePerLot = 10;
      const pips = pipsRisk * 10000;
      lotSize = riskAmount / (pips * pipValuePerLot);
    }

    lotSize = Math.max(0.01, Math.floor(lotSize * 100) / 100);

    if (activeMode === 'PROP_FIRM') {
      // 🛡️ Cap Proporcional de Margen para Prop Firms en Metales (Oro / The5ers):
      // Con apalancamiento 1:25 en Oro, el límite seguro de margen es 0.10 lotes por cada $5,000 USD de balance:
      if (symUpper.includes('XAU') || symUpper.includes('GOLD')) {
        const propFirmGoldLotCap = Math.max(0.01, Math.floor((currentBal / 50000.0) * 100) / 100);
        lotSize = Math.min(lotSize, propFirmGoldLotCap);
      } else {
        // 🛡️ Cap Proporcional de Margen en Forex / Índices (EURUSD / GBPJPY / NAS100): Máximo 1.00 lote por cada $5,000 de balance
        const propFirmLotCap = Math.max(0.01, Math.floor((currentBal / 5000.0) * 100) / 100);
        lotSize = Math.min(lotSize, propFirmLotCap);
      }
    } else {
      // MODO PERSONAL: sin caps de prop firms, limitado únicamente al techo general seguro
      lotSize = Math.min(lotSize, 20.0);
    }

    return lotSize;
  }
}

// Instancia singleton
const riskEngine = new RiskEngine();

module.exports = {
  CONFIG,
  RiskEngine,
  riskEngine
};
