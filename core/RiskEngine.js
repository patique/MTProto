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

const { getSymbolSpec } = require('../config/symbols.config');

const CONFIG = {
  MODE: 'PROP_FIRM', // 'PERSONAL' | 'PROP_FIRM' (Predeterminado: PROP_FIRM institucional)
  accountBalance: 5263.49, // Saldo real auditado The5%ers ($5,263.49 USD)

  PERSONAL: {
    riskPercent: 2.0,
    maxSlippagePips: 5.0,
    maxStopLossPips: 100, // Máximo 100 pips de riesgo admitidos por operación
  },

  PROP_FIRM: {
    riskPercent: 0.75, // Riesgo por trade para fase de examen Challenge (0.75%)
    maxOpenTrades: 2, // Regla 2: Máximo 2 posiciones simultáneas con riesgo vivo (sin BE)
    maxTotalRiskPercent: 1.5, // Máximo 1.5% de riesgo acumulado simultáneo
    antiHedging: true, // Prohibido operar direcciones opuestas en el mismo par
    breakEvenSlotRelease: true, // 🎯 Slot dinámico: al poner BE el riesgo es $0 y se libera el slot para otra entrada
    newsBufferMinutes: 10, // Cerrar 10 min antes y bloquear 10 min después de noticia roja
    dailyMaxDrawdownPercent: 2.25, // 🛑 Circuit Breaker: Freno de emergencia al -2.25% diario (lejos del 5% de FTMO)
    totalMaxDrawdownPercent: 10.0, // Límite de pérdida total 10.0%
    dailyProfitTargetUSD: 3000.0, // Take Profit diario recomendado en 100k
    targetEvaluationBalance: 110000.0, // 🎯 Meta Global Fase 1 FTMO: $110,000 USD (+10%). Al alcanzarse se congela la operativa.
    maxSlippagePips: 3.0,
    maxStopLossPips: 100,
    maxLotSize: 15.0
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
    this.isManualPause = false;
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
   * 🏛️ Comprueba si estamos dentro de la ventana operativa permitida:
   * Operativa Continua desde las 03:00 AM España hasta las 22:55 PM España (Asia + Londres + NY)
   */
  isTradingSessionActive(date = new Date()) {
    const { totalMinutes } = this.getMadridTime(date);
    // 03:00 CET = 180 min | 22:55 CET = 1375 min
    return totalMinutes >= 180 && totalMinutes < 1375;
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
    if (this.tradingPaused && this.isManualPause) {
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

    // 🏛️ CONTROL DE VENTANA OPERATIVA (Operativa continua 03:00 a 22:55 CET)
    if (!options.bypassTimeShields && !this.isTradingSessionActive(checkDate)) {
      const { hour: mHour, minute: mMin } = this.getMadridTime(checkDate);
      return {
        allowed: false,
        reason: `🏛️ [FUERA DE SESIÓN OPERATIVA] Pausa nocturna (${mHour.toString().padStart(2, '0')}:${mMin.toString().padStart(2, '0')} CET). Apertura de sesión a las 03:00 CET.`
      };
    }

    // Reglas de Prop Firm a nivel global (solo si NO se gestiona de forma desacoplada por cuenta en mt5_bridge)
    if (!options.isMultiAccountManaged && this.config.MODE === 'PROP_FIRM') {
      if (this.activePositionsCount >= (this.config.PROP_FIRM.maxOpenTrades || 2)) {
        return {
          allowed: false,
          reason: `⚠️ [PROP FIRM - REGLA 2] Límite de ${this.config.PROP_FIRM.maxOpenTrades} operaciones activas alcanzado (${this.activePositionsCount} abiertas). Slot de riesgo no disponible.`
        };
      }

      const pnl = this.dailyPnL;
      if (this.dailyMaxLossUSD > 0 && pnl <= -this.dailyMaxLossUSD) {
        return {
          allowed: false,
          reason: `🚨 [PROP FIRM] Límite de pérdida diaria alcanzado (-$${Math.abs(pnl).toFixed(2)} USD). Freno de emergencia activado.`
        };
      }
    }

    return { allowed: true, reason: '' };
  }

  /**
   * Pausa o reanuda manualmente el trading
   */
  setTradingPaused(paused, reason = '') {
    this.tradingPaused = !!paused;
    this.isManualPause = !!paused;
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
  calculateLotSize(entryPrice, slPrice, symbol = 'XAUUSD', isReducedRisk = false, targetBalance = null, customRiskPercent = null) {
    let effectiveRiskPercent = (typeof customRiskPercent === 'number' && customRiskPercent > 0)
      ? customRiskPercent
      : this.currentRiskPercent;

    if (isReducedRisk) {
      effectiveRiskPercent = effectiveRiskPercent / 2.0;
    }

    const currentBal = (typeof targetBalance === 'number' && targetBalance > 0) ? targetBalance : this.config.accountBalance;
    const riskAmount = (currentBal * effectiveRiskPercent) / 100;
    const priceRisk = Math.abs(entryPrice - slPrice);
    const symUpper = symbol.toUpperCase();

    if (!entryPrice || !slPrice || isNaN(priceRisk) || priceRisk <= 0) {
      if (symUpper.includes('XAU') || symUpper.includes('GOLD')) {
        return Math.max(0.01, Math.floor((currentBal / 50000.0) * 100) / 100);
      }
      return 0.01;
    }

    const spec = getSymbolSpec(symbol);
    const unitsRisk = priceRisk / spec.pipSize;
    const riskPerLot = unitsRisk * spec.pipValuePerLot;
    let lotSize = riskPerLot > 0 ? riskAmount / riskPerLot : 0.01;

    lotSize = Math.max(0.01, Math.floor(lotSize * 100) / 100);

    // 🛡️ Cap Proporcional de Margen por Balance (Prop Firm & Margen Seguro):
    if (symUpper.includes('XAU') || symUpper.includes('GOLD')) {
      const lotsPerBalance = spec.propFirmMaxLotsPerBalanceUSD || (1 / 50000.0);
      const propFirmGoldLotCap = Math.max(0.01, Math.floor((currentBal * lotsPerBalance) * 100) / 100);
      lotSize = Math.min(lotSize, propFirmGoldLotCap);
    } else {
      // 🛡️ Cap Proporcional de Margen para Forex (EURUSD, GBPUSD, GBPJPY, etc.):
      // Máximo 1.0 lote por cada $33,333 USD de balance (Apalancamiento institucional seguro):
      // • $100,000 -> 3.00 lotes máx
      // • $50,000  -> 1.50 lotes máx
      // • $10,000  -> 0.30 lotes máx
      // • $5,000   -> 0.15 lotes máx
      // • $130     -> 0.01 lotes máx
      const maxForexLotsPerBalance = 1.0 / 33333.33;
      const propFirmForexCap = Math.max(0.01, Math.floor((currentBal * maxForexLotsPerBalance) * 100) / 100);
      lotSize = Math.min(lotSize, propFirmForexCap);
    }

    // 🛡️ Filtro de Margen Físico: El margen requerido no puede superar el 35% del balance de la cuenta
    const marginPerLot = symUpper.includes('XAU') || symUpper.includes('GOLD') ? 4000.0 : 3333.33;
    const maxAffordableLot = Math.max(0.01, Math.floor(((currentBal * 0.35) / marginPerLot) * 100) / 100);
    lotSize = Math.min(lotSize, maxAffordableLot);

    return Math.max(0.01, parseFloat(lotSize.toFixed(2)));
  }
}

// Instancia singleton
const riskEngine = new RiskEngine();

module.exports = {
  CONFIG,
  RiskEngine,
  riskEngine
};
