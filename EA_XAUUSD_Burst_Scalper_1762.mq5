//+------------------------------------------------------------------+
//|                               EA_XAUUSD_Burst_Scalper_1762.mq5   |
//|               Estrategia XAUUSD Breakout Burst Scalper (#1762)    |
//|       Versión 1 Original + Filtro Cuantitativo de Zonas Seguras   |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab"
#property link      "https://github.com/telegram-mtproto"
#property version   "3.50"
#property description "EA de Scalping Dinámico de Alta Frecuencia para XAUUSD"
#property description "Versión 1 Original (#1762) operando ÚNICAMENTE en las Zonas Seguras de bajo riesgo"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- ENUMERACIONES ---
enum ENUM_ENTRY_MODE
{
   ENTRY_BREAKOUT_M15,    // Rotura de Rango 15m (Configuración Original #1762)
   ENTRY_MOMENTUM_M1,     // Momentum de vela M1
   ENTRY_MOMENTUM_M1_HTF, // Gatillo 3: Momentum M1 + Filtro Institucional HTF (H1)
   ENTRY_MANUAL_DIRECTION // Dirección manual fija
};

enum ENUM_MANUAL_DIR
{
   DIR_BOTH, // Ambos sentidos (según rotura)
   DIR_BUY,  // Solo Compras
   DIR_SELL  // Solo Ventas
};

//--- PARÁMETROS DE ENTRADA ---
input group "=== 1. CONFIGURACIÓN DEL CICLO ORIGINAL (#1762) ===";
input ENUM_ENTRY_MODE    InpEntryMode             = ENTRY_MOMENTUM_M1;  // Gatillo de Entrada (Momentum M1)
input int                InpRangeLookbackM1       = 15;                 // Periodo de Rango en M1 (minutos)
input ENUM_MANUAL_DIR    InpAllowedDirection      = DIR_BOTH;           // Dirección Permitida
input double             InpBasketTP_USD          = 2.0;                // Take Profit de Cesta en $ (2.0$ en Oro)
input double             InpReentryStep_USD       = 3.5;                // Distancia para Re-entrada en $ (3.5$ en Oro)
input int                InpMinReentrySeconds     = 60;                 // Tiempo mínimo entre órdenes (segundos)

input group "=== 2. CORTACIRCUITOS DE VOLATILIDAD (CIRCUIT BREAKER) ===";
input bool               InpEnableCircuitBreaker  = true;               // Activar Cortacircuitos de Volatilidad Anormal
input double             InpMaxPrevH1RangeUSD     = 45.0;               // Rango Máximo Permitido en última vela H1 ($45.0)
input double             InpMaxDailyRangeUSD      = 100.0;              // Rango Diario Acumulado Máximo en D1 ($100.0)
input bool               InpBlockMonthEndDay      = true;               // Bloquear operativa en Cierre de Mes (Último día)
input int                InpMonthEndStartHourES   = 12;                 // Hora inicio bloqueo Fin de Mes España (12:00)

input group "=== 3. FILTRO INSTITUCIONAL HTF (GATILLO 3) ===";
input ENUM_TIMEFRAMES    InpHTFTimeframe          = PERIOD_H1;          // Temporalidad Mayor HTF (Recomendado H1)
input int                InpHTF_EMA_Period        = 50;                 // Periodo EMA Institucional HTF (ej: 50)

input group "=== 4. GESTIÓN DE LOTAJE ===";
input double             InpBaseLot               = 0.01;               // Lote Base Inicial
input double             InpLotMultiplier         = 2.0;                // Multiplicador de Lote por Orden (x2.0)
input int                InpMaxOrders             = 6;                  // Máximo de Órdenes por Cesta (6)
input bool               InpScaleWithBalance      = false;              // Escalar lote base al duplicar balance

input group "=== 3. ZONAS SEGURAS CUANTITATIVAS (HORA ESPAÑA) ===";
input bool               InpUseSafeHoursOnly      = true;               // Operar ÚNICAMENTE en Zonas Seguras
input int                InpServerOffsetFromSpain = 1;                  // Diferencia Servidor vs España (+1h en FTMO)

// Ventana 1: Mañana Europea Tranquila (09:00 a 12:30 España / 10:00 a 13:30 Servidor)
input bool               InpEnableWindow1         = true;               // Activar Ventana 1 (Mañana Europa)
input int                InpWin1StartHourES       = 9;                  // Inicio Ventana 1 Hora España (09:00)
input int                InpWin1StartMinES        = 0;                  // Minuto Inicio Ventana 1
input int                InpWin1EndHourES         = 12;                 // Fin Ventana 1 Hora España (12:30)
input int                InpWin1EndMinES          = 30;                 // Minuto Fin Ventana 1

// Ventana 2: Tarde Americana Tranquila (18:00 a 21:30 España / 19:00 a 22:30 Servidor)
input bool               InpEnableWindow2         = true;               // Activar Ventana 2 (Tarde USA Post-Europa)
input int                InpWin2StartHourES       = 18;                 // Inicio Ventana 2 Hora España (18:00)
input int                InpWin2StartMinES        = 0;                  // Minuto Inicio Ventana 2
input int                InpWin2EndHourES         = 21;                 // Fin Ventana 2 Hora España (21:30)
input int                InpWin2EndMinES          = 30;                 // Minuto Fin Ventana 2

input group "=== 4. CIERRE NO OVERNIGHT & CIERRE DE VIERNES ===";
input bool               InpEnableNightClose      = true;               // Activar Cierre Nocturno Diario (No Overnight)
input int                InpNightCloseHourES      = 21;                 // Hora Cierre Diario España (21:45)
input int                InpNightCloseMinES       = 45;                 // Minuto Cierre Diario España

input bool               InpEnableFridayClose     = true;               // Activar Cierre Forzoso de Viernes (Fin de Semana)
input int                InpFridayCloseHourES     = 21;                 // Hora Cierre Viernes España (21:15)
input int                InpFridayCloseMinES      = 15;                 // Minuto Cierre Viernes España

input group "=== 6. PROTECCIONES Y SEGURIDAD ===";
input double             InpMaxSpreadUSD          = 0.60;               // Spread Máximo Permitido en $
input double             InpMinMarginLevelPct     = 150.0;              // Nivel Mínimo de Margen Libre (%)
input double             InpEmergencyBasketSL     = 0.0;                // SL de Emergencia en $ (0 = Desactivado)
input double             InpDailyTargetUSD        = 0.0;                // Meta Diaria de Beneficio en $ (0 = Ilimitado)
input bool               InpEnableHedgingLock     = false;              // Candado de Cobertura (Step 7 Hedging Lock) - OFF
input double             InpHedgeStepOffsetUSD    = 3.5;                // Distancia tras Orden 6 para activar Hedge ($3.5 = Step 7)
input double             InpHedgeReleaseHystUSD   = 0.5;                // Histéresis de rebote para liberar Hedge ($0.50)

input group "=== 7. IDENTIFICACIÓN & CONTROL ===";
input ulong              InpMagicNumber           = 176200;             // Magic Number
input string             InpTradeComment          = "XAU_Burst_Safe";   // Comentario de Trade
input bool               InpShowDashboard         = true;               // Mostrar Panel Visual en Gráfico
input color              InpDashboardColor        = C'15,25,38';        // Color de Fondo del Panel

//--- OBJETOS Y VARIABLES GLOBALES ---
CTrade            m_trade;
CPositionInfo     m_pos;
datetime          m_lastOrderTime       = 0;
int               m_currentCycleId      = 0;
int               m_closedCyclesCount   = 0;
double            m_closedCyclesProfit  = 0.0;
double            m_dayStartBalance     = 0.0;
datetime          m_lastDayCheck        = 0;
int               m_htfEmaHandle        = INVALID_HANDLE;
bool              m_hedgeActive         = false;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   m_trade.SetExpertMagicNumber(InpMagicNumber);
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(_Symbol);

   m_dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   m_lastDayCheck    = TimeCurrent();

   if(InpEntryMode == ENTRY_MOMENTUM_M1_HTF)
   {
      m_htfEmaHandle = iMA(_Symbol, InpHTFTimeframe, InpHTF_EMA_Period, 0, MODE_EMA, PRICE_CLOSE);
      PrintFormat("📊 [Filtro HTF Activado] Temporalidad: %s | Periodo EMA: %d", EnumToString(InpHTFTimeframe), InpHTF_EMA_Period);
   }

   PrintFormat("🚀 [EA_XAUUSD_Burst_Scalper_1762] Modo: %s | TP: %.2f$ | Step: %.2f$ | Mult: %.2fx",
               EnumToString(InpEntryMode), InpBasketTP_USD, InpReentryStep_USD, InpLotMultiplier);

   if(InpShowDashboard)
      CreateDashboard();

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(m_htfEmaHandle != INVALID_HANDLE)
      IndicatorRelease(m_htfEmaHandle);

   if(InpShowDashboard)
      DestroyDashboard();
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime now = TimeCurrent();

   // 1. Control de reseteo diario
   MqlDateTime dt_now, dt_last;
   TimeToStruct(now, dt_now);
   TimeToStruct(m_lastDayCheck, dt_last);
   if(dt_now.day != dt_last.day)
   {
      m_dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      m_lastDayCheck = now;
   }

   // 2. Control de meta diaria si está configurada
   if(InpDailyTargetUSD > 0.0)
   {
      double currentDailyGain = AccountInfoDouble(ACCOUNT_BALANCE) - m_dayStartBalance;
      if(currentDailyGain >= InpDailyTargetUSD && CountOpenOrders() == 0)
      {
         UpdateDashboard("Meta diaria conseguida. Operativa en pausa.");
         return;
      }
   }

   // 3. CIERRE FORZOSO NOCTURNO Y DE FIN DE SEMANA (NO OVERNIGHT / NO WEEKEND HOLDING)
   if(IsForceCloseTime(now))
   {
      if(CountOpenOrders() > 0)
      {
         PrintFormat("🔒 [CIERRE FORZOSO] Cerrando cesta abierta antes del cierre de mercado (No Overnight / Friday Close)...");
         CloseEntireBasket();
         m_lastOrderTime = now;
      }
      UpdateDashboard("MERCADO CERRADO / NO OVERNIGHT");
      return;
   }

   // 4. Inspeccionar el estado de la cesta actual
   int openCount = 0;
   long cycleType = -1; // 0 = BUY, 1 = SELL
   double totalLots = 0.0;
   double weightedEntry = 0.0;
   double lastOrderPrice = 0.0;
   double totalFloatingProfit = 0.0;

   GetBasketState(openCount, cycleType, totalLots, weightedEntry, lastOrderPrice, totalFloatingProfit);

   // 4. Si hay órdenes abiertas, gestionar Take Profit de Cesta o Re-entradas
   if(openCount > 0)
   {
      double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double currentSpread = currentAsk - currentBid;

      bool tpTriggered = false;
      double targetPrice = 0.0;

      if(cycleType == POSITION_TYPE_BUY)
      {
         targetPrice = weightedEntry + InpBasketTP_USD + currentSpread;
         if(currentBid >= targetPrice)
            tpTriggered = true;
      }
      else if(cycleType == POSITION_TYPE_SELL)
      {
         targetPrice = weightedEntry - InpBasketTP_USD - currentSpread;
         if(currentAsk <= targetPrice)
            tpTriggered = true;
      }

      // Evaluar cierre por TP de cesta
      if(tpTriggered)
      {
         PrintFormat("🎯 [TP Cesta Alcanzado] Ciclo #%d cerrado | Órdenes: %d | Lotes: %.2f | Profit: $%.2f",
                     m_currentCycleId, openCount, totalLots, totalFloatingProfit);
         CloseEntireBasket();
         m_closedCyclesCount++;
         m_closedCyclesProfit += totalFloatingProfit;
         m_lastOrderTime = TimeCurrent();
         UpdateDashboard("Ciclo cerrado en TP con éxito");
         return;
      }

      // Evaluar SL de emergencia si estuviera activo
      if(InpEmergencyBasketSL > 0.0 && totalFloatingProfit <= -InpEmergencyBasketSL)
      {
         PrintFormat("🛑 [SL Emergencia Cesta] Ciclo #%d cerrado por SL | Flotante: $%.2f",
                     m_currentCycleId, totalFloatingProfit);
         CloseEntireBasket();
         m_lastOrderTime = TimeCurrent();
         UpdateDashboard("Cesta cerrada por SL de emergencia");
         return;
      }

      // Evaluar si corresponde añadir una re-entrada consecutiva
      if(openCount < InpMaxOrders && (now - m_lastOrderTime) >= InpMinReentrySeconds)
      {
         bool canAdd = false;
         double lotForNext = CalculateNextLot(openCount);

         if(cycleType == POSITION_TYPE_BUY)
         {
            if((lastOrderPrice - currentAsk) >= InpReentryStep_USD)
               canAdd = true;
         }
         else if(cycleType == POSITION_TYPE_SELL)
         {
            if((currentBid - lastOrderPrice) >= InpReentryStep_USD)
               canAdd = true;
         }

         if(canAdd && CheckFilters(currentSpread))
         {
            ExecuteOrder((ENUM_POSITION_TYPE)cycleType, lotForNext, "Re-entry #" + IntegerToString(openCount + 1));
            m_lastOrderTime = TimeCurrent();
         }
      }

      // Evaluar Candado de Cobertura Dinámico Step 7 (N steps + 1)
      if(InpEnableHedgingLock && openCount >= InpMaxOrders)
      {
         ulong hedgeMagic = InpMagicNumber + 999;
         bool hedgeIsOpen = IsHedgeOpen(hedgeMagic);

         if(cycleType == POSITION_TYPE_BUY)
         {
            double hedgeTriggerPrice = lastOrderPrice - InpHedgeStepOffsetUSD;
            if(!hedgeIsOpen && currentAsk <= hedgeTriggerPrice)
            {
               PrintFormat("🛡️ [HEDGE STEP 7 ON] BUY Cesta 6 órdenes completada | Precio tocó Step 7 (%.2f) | Cobertura SELL %.2f lotes activada",
                           hedgeTriggerPrice, totalLots);
               ExecuteHedgeOrder(POSITION_TYPE_SELL, totalLots, hedgeMagic, "Hedge_Step7");
            }
            else if(hedgeIsOpen && currentBid >= (hedgeTriggerPrice + InpHedgeReleaseHystUSD))
            {
               PrintFormat("🔓 [HEDGE STEP 7 OFF] Precio rebotó a %.2f | Liberando cobertura para que la cesta BUY continúe a TP", currentBid);
               CloseHedgeOrder(hedgeMagic);
            }
         }
         else if(cycleType == POSITION_TYPE_SELL)
         {
            double hedgeTriggerPrice = lastOrderPrice + InpHedgeStepOffsetUSD;
            if(!hedgeIsOpen && currentBid >= hedgeTriggerPrice)
            {
               PrintFormat("🛡️ [HEDGE STEP 7 ON] SELL Cesta 6 órdenes completada | Precio tocó Step 7 (%.2f) | Cobertura BUY %.2f lotes activada",
                           hedgeTriggerPrice, totalLots);
               ExecuteHedgeOrder(POSITION_TYPE_BUY, totalLots, hedgeMagic, "Hedge_Step7");
            }
            else if(hedgeIsOpen && currentAsk <= (hedgeTriggerPrice - InpHedgeReleaseHystUSD))
            {
               PrintFormat("🔓 [HEDGE STEP 7 OFF] Precio rebotó a %.2f | Liberando cobertura para que la cesta SELL continúe a TP", currentAsk);
               CloseHedgeOrder(hedgeMagic);
            }
         }
      }
   }
   else
   {
      // 5. No hay órdenes activas: Verificar FILTRO DE ZONAS SEGURAS antes de buscar nuevo ciclo
      if(InpUseSafeHoursOnly && !IsWithinSafeHours())
      {
         UpdateDashboard("FUERA DE ZONA SEGURA (CONGELADO)");
         return;
      }

      // 5.1 CORTACIRCUITOS DE VOLATILIDAD ANORMAL (CIRCUIT BREAKER)
      string cbReason = "";
      if(IsCircuitBreakerTriggered(cbReason))
      {
         UpdateDashboard(cbReason);
         return;
      }

      double currentSpread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(!CheckFilters(currentSpread))
      {
         UpdateDashboard("Filtro de spread o margen bloqueando entrada");
         return;
      }

      ENUM_POSITION_TYPE triggerDirection;
      if(CheckNewEntrySignal(triggerDirection))
      {
         m_currentCycleId++;
         double startLot = InpBaseLot;
         if(InpScaleWithBalance && m_dayStartBalance > 0.0)
         {
            double scaleFactor = MathMax(1.0, AccountInfoDouble(ACCOUNT_BALANCE) / m_dayStartBalance);
            startLot = NormalizeDouble(InpBaseLot * scaleFactor, 2);
         }

         PrintFormat("⚡ [Nuevo Ciclo #%d] Disparo inicial: %s | Lote: %.2f",
                     m_currentCycleId, EnumToString(triggerDirection), startLot);

         ExecuteOrder(triggerDirection, startLot, "Init Cycle #" + IntegerToString(m_currentCycleId));
         m_lastOrderTime = TimeCurrent();
      }
      else
      {
         string waitMode = (InpEntryMode == ENTRY_MOMENTUM_M1_HTF) ? "ZONA SEGURA: Esperando M1 + HTF" :
                           (InpEntryMode == ENTRY_MOMENTUM_M1)     ? "ZONA SEGURA: Esperando vela M1" :
                                                                     "ZONA SEGURA: Esperando Rotura 15m";
         UpdateDashboard(waitMode);
      }
   }

   // 6. Actualizar panel HUD
   if(InpShowDashboard)
      UpdateDashboard("");
}

//+------------------------------------------------------------------+
//| Verifica si la hora actual está dentro de las Zonas Seguras      |
//+------------------------------------------------------------------+
bool IsWithinSafeHours()
{
   datetime serverTime = TimeCurrent();
   MqlDateTime dt;
   TimeToStruct(serverTime, dt);

   // Calcular minutos del día en hora de España
   int spainHour = dt.hour - InpServerOffsetFromSpain;
   if(spainHour < 0) spainHour += 24;
   if(spainHour >= 24) spainHour -= 24;
   int spainTimeMinutes = (spainHour * 60) + dt.min;

   // Ventana 1 (Mañana Europa)
   if(InpEnableWindow1)
   {
      int startMin1 = (InpWin1StartHourES * 60) + InpWin1StartMinES;
      int endMin1   = (InpWin1EndHourES * 60) + InpWin1EndMinES;
      if(spainTimeMinutes >= startMin1 && spainTimeMinutes <= endMin1)
         return true;
   }

   // Ventana 2 (Tarde USA Post-Europa)
   if(InpEnableWindow2)
   {
      int startMin2 = (InpWin2StartHourES * 60) + InpWin2StartMinES;
      int endMin2   = (InpWin2EndHourES * 60) + InpWin2EndMinES;
      if(spainTimeMinutes >= startMin2 && spainTimeMinutes <= endMin2)
         return true;
   }

   return false;
}

//+------------------------------------------------------------------+
//| Comprueba si es hora de cierre forzoso (No Overnight o Viernes)  |
//+------------------------------------------------------------------+
bool IsForceCloseTime(datetime time)
{
   MqlDateTime dt;
   TimeToStruct(time, dt);
   int spainHour = dt.hour - InpServerOffsetFromSpain;
   if(spainHour < 0) spainHour += 24;
   if(spainHour >= 24) spainHour -= 24;
   int spainTotalMinutes = (spainHour * 60) + dt.min;

   // 1. Fin de semana completo (Sábado = 6, Domingo = 0)
   if(dt.day_of_week == 6 || dt.day_of_week == 0)
      return true;

   // 2. Viernes por la tarde/noche (Friday Close Guard)
   if(InpEnableFridayClose && dt.day_of_week == 5)
   {
      int friCloseMin = (InpFridayCloseHourES * 60) + InpFridayCloseMinES;
      if(spainTotalMinutes >= friCloseMin)
         return true;
   }

   // 3. Lunes a Jueves: Cierre diario nocturno No Overnight (21:45 España hasta las 03:00 de la madrugada)
   if(InpEnableNightClose && (dt.day_of_week >= 1 && dt.day_of_week <= 4))
   {
      int nightCloseMin = (InpNightCloseHourES * 60) + InpNightCloseMinES;
      if(spainTotalMinutes >= nightCloseMin || spainTotalMinutes < 180) // 180 min = 03:00 AM
         return true;
   }

   return false;
}

//+------------------------------------------------------------------+
//| Evalúa si el Cortacircuitos de Volatilidad debe bloquear la entrada|
//+------------------------------------------------------------------+
bool IsCircuitBreakerTriggered(string &reason)
{
   if(!InpEnableCircuitBreaker)
      return false;

   // 1. Comprobar si la última vela H1 cerrada tuvo un rango anómalo
   if(InpMaxPrevH1RangeUSD > 0.0)
   {
      MqlRates h1Rates[];
      ArraySetAsSeries(h1Rates, true);
      if(CopyRates(_Symbol, PERIOD_H1, 1, 1, h1Rates) > 0)
      {
         double prevH1Range = h1Rates[0].high - h1Rates[0].low;
         if(prevH1Range > InpMaxPrevH1RangeUSD)
         {
            reason = StringFormat("CORTACIRCUITOS H1: %.1f$ > %.1f$", prevH1Range, InpMaxPrevH1RangeUSD);
            return true;
         }
      }
   }

   // 2. Comprobar si el rango acumulado de hoy en D1 ya superó el límite
   if(InpMaxDailyRangeUSD > 0.0)
   {
      MqlRates d1Rates[];
      ArraySetAsSeries(d1Rates, true);
      if(CopyRates(_Symbol, PERIOD_D1, 0, 1, d1Rates) > 0)
      {
         double todayRange = d1Rates[0].high - d1Rates[0].low;
         if(todayRange > InpMaxDailyRangeUSD)
         {
            reason = StringFormat("CORTACIRCUITOS D1: %.1f$ > %.1f$", todayRange, InpMaxDailyRangeUSD);
            return true;
         }
      }
   }

   // 3. Bloqueo en Cierre de Mes (Month-End Rebalancing institucional)
   if(InpBlockMonthEndDay)
   {
      datetime now = TimeCurrent();
      MqlDateTime dt;
      TimeToStruct(now, dt);

      int spainHour = dt.hour - InpServerOffsetFromSpain;
      if(spainHour < 0) spainHour += 24;

      // Calcular días del mes actual
      int daysInMonth = 31;
      if(dt.mon == 2) daysInMonth = 28;
      else if(dt.mon == 4 || dt.mon == 6 || dt.mon == 9 || dt.mon == 11) daysInMonth = 30;

      bool isLastDay = (dt.day == daysInMonth);
      bool isLastFriday = (dt.day_of_week == 5 && dt.day >= (daysInMonth - 2));

      if((isLastDay || isLastFriday) && spainHour >= InpMonthEndStartHourES)
      {
         reason = "CORTACIRCUITOS: Cierre Mensual Institucional";
         return true;
      }
   }

   return false;
}

//+------------------------------------------------------------------+
//| Evalúa la señal de rotura de rango (Configuración #1762)         |
//+------------------------------------------------------------------+
bool CheckNewEntrySignal(ENUM_POSITION_TYPE &direction)
{
   if(InpEntryMode == ENTRY_BREAKOUT_M15)
   {
      MqlRates rates[];
      ArraySetAsSeries(rates, true);
      int copied = CopyRates(_Symbol, PERIOD_M1, 1, InpRangeLookbackM1, rates);
      if(copied < InpRangeLookbackM1)
         return false;

      double highestHigh = -1.0;
      double lowestLow   = 9999999.0;

      for(int i = 0; i < copied; i++)
      {
         if(rates[i].high > highestHigh) highestHigh = rates[i].high;
         if(rates[i].low < lowestLow)    lowestLow   = rates[i].low;
      }

      double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

      if(currentBid >= highestHigh && (InpAllowedDirection == DIR_BOTH || InpAllowedDirection == DIR_BUY))
      {
         direction = POSITION_TYPE_BUY;
         return true;
      }
      if(currentAsk <= lowestLow && (InpAllowedDirection == DIR_BOTH || InpAllowedDirection == DIR_SELL))
      {
         direction = POSITION_TYPE_SELL;
         return true;
      }
   }
   else if(InpEntryMode == ENTRY_MOMENTUM_M1)
   {
      MqlRates rates[];
      ArraySetAsSeries(rates, true);
      if(CopyRates(_Symbol, PERIOD_M1, 1, 1, rates) > 0)
      {
         if(rates[0].close > rates[0].open && (InpAllowedDirection == DIR_BOTH || InpAllowedDirection == DIR_BUY))
         {
            direction = POSITION_TYPE_BUY;
            return true;
         }
         else if(rates[0].close < rates[0].open && (InpAllowedDirection == DIR_BOTH || InpAllowedDirection == DIR_SELL))
         {
            direction = POSITION_TYPE_SELL;
            return true;
         }
      }
   }
   else if(InpEntryMode == ENTRY_MOMENTUM_M1_HTF)
   {
      // 1. Obtener tendencia HTF (ej: H1 con EMA 50)
      if(m_htfEmaHandle == INVALID_HANDLE)
         m_htfEmaHandle = iMA(_Symbol, InpHTFTimeframe, InpHTF_EMA_Period, 0, MODE_EMA, PRICE_CLOSE);

      double emaValues[];
      ArraySetAsSeries(emaValues, true);
      if(CopyBuffer(m_htfEmaHandle, 0, 1, 1, emaValues) <= 0)
         return false;

      MqlRates htfRates[];
      ArraySetAsSeries(htfRates, true);
      if(CopyRates(_Symbol, InpHTFTimeframe, 1, 1, htfRates) <= 0)
         return false;

      bool htfBullish = (htfRates[0].close > emaValues[0]);
      bool htfBearish = (htfRates[0].close < emaValues[0]);

      // 2. Obtener momentum M1 (última vela cerrada)
      MqlRates m1Rates[];
      ArraySetAsSeries(m1Rates, true);
      if(CopyRates(_Symbol, PERIOD_M1, 1, 1, m1Rates) <= 0)
         return false;

      bool m1Bullish = (m1Rates[0].close > m1Rates[0].open);
      bool m1Bearish = (m1Rates[0].close < m1Rates[0].open);

      // 3. Gatillo: Solo disparamos M1 en la misma dirección que la tendencia HTF
      if(htfBullish && m1Bullish && (InpAllowedDirection == DIR_BOTH || InpAllowedDirection == DIR_BUY))
      {
         direction = POSITION_TYPE_BUY;
         return true;
      }
      else if(htfBearish && m1Bearish && (InpAllowedDirection == DIR_BOTH || InpAllowedDirection == DIR_SELL))
      {
         direction = POSITION_TYPE_SELL;
         return true;
      }
   }
   else if(InpEntryMode == ENTRY_MANUAL_DIRECTION)
   {
      if(InpAllowedDirection == DIR_BUY)
      {
         direction = POSITION_TYPE_BUY;
         return true;
      }
      else if(InpAllowedDirection == DIR_SELL)
      {
         direction = POSITION_TYPE_SELL;
         return true;
      }
   }

   return false;
}

//+------------------------------------------------------------------+
//| Calcula el lotaje de la siguiente orden según multiplicador     |
//+------------------------------------------------------------------+
double CalculateNextLot(int currentOrderIndex)
{
   double lot = InpBaseLot * MathPow(InpLotMultiplier, currentOrderIndex);
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   lot = MathFloor(lot / lotStep) * lotStep;
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;
   return NormalizeDouble(lot, 2);
}

//+------------------------------------------------------------------+
//| Filtros de seguridad (Spread y Margen)                           |
//+------------------------------------------------------------------+
bool CheckFilters(double spreadUSD)
{
   if(spreadUSD > InpMaxSpreadUSD)
      return false;

   double marginLevel = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   if(marginLevel > 0.0 && marginLevel < InpMinMarginLevelPct)
      return false;

   return true;
}

//+------------------------------------------------------------------+
//| Ejecuta una orden a mercado                                      |
//+------------------------------------------------------------------+
bool ExecuteOrder(ENUM_POSITION_TYPE type, double lot, string comment)
{
   string fullComment = InpTradeComment + "_" + comment;
   if(type == POSITION_TYPE_BUY)
   {
      double price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      return m_trade.Buy(lot, _Symbol, price, 0.0, 0.0, fullComment);
   }
   else
   {
      double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      return m_trade.Sell(lot, _Symbol, price, 0.0, 0.0, fullComment);
   }
}

//+------------------------------------------------------------------+
//| Ejecuta una orden de cobertura candado (Hedging Lock)            |
//+------------------------------------------------------------------+
bool ExecuteHedgeOrder(ENUM_POSITION_TYPE type, double lot, ulong magic, string comment)
{
   CTrade hedgeTrade;
   hedgeTrade.SetExpertMagicNumber(magic);
   hedgeTrade.SetMarginMode();
   hedgeTrade.SetTypeFillingBySymbol(_Symbol);

   string fullComment = InpTradeComment + "_" + comment;
   if(type == POSITION_TYPE_BUY)
   {
      double price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      return hedgeTrade.Buy(lot, _Symbol, price, 0.0, 0.0, fullComment);
   }
   else
   {
      double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      return hedgeTrade.Sell(lot, _Symbol, price, 0.0, 0.0, fullComment);
   }
}

//+------------------------------------------------------------------+
//| Verifica si existe una orden de cobertura activa                 |
//+------------------------------------------------------------------+
bool IsHedgeOpen(ulong magic)
{
   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == magic)
            return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Cierra la orden de cobertura candado                             |
//+------------------------------------------------------------------+
void CloseHedgeOrder(ulong magic)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == magic)
         {
            m_trade.PositionClose(m_pos.Ticket());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Cierra toda la cesta de órdenes y coberturas a mercado           |
//+------------------------------------------------------------------+
void CloseEntireBasket()
{
   ulong hedgeMagic = InpMagicNumber + 999;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && (m_pos.Magic() == InpMagicNumber || m_pos.Magic() == hedgeMagic))
         {
            m_trade.PositionClose(m_pos.Ticket());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Obtiene las métricas acumuladas de la cesta activa               |
//+------------------------------------------------------------------+
void GetBasketState(int &count, long &posType, double &totalLots, double &weightedPrice, double &lastPrice, double &floatingProfit)
{
   count = 0;
   posType = -1;
   totalLots = 0.0;
   weightedPrice = 0.0;
   lastPrice = 0.0;
   floatingProfit = 0.0;
   double priceLotSum = 0.0;
   datetime lastTime = 0;

   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == InpMagicNumber)
         {
            count++;
            posType = m_pos.PositionType();
            double lots = m_pos.Volume();
            double openPrice = m_pos.PriceOpen();
            totalLots += lots;
            priceLotSum += (openPrice * lots);
            floatingProfit += m_pos.Profit() + m_pos.Swap();

            datetime posTime = (datetime)m_pos.Time();
            if(posTime >= lastTime)
            {
               lastTime = posTime;
               lastPrice = openPrice;
            }
         }
      }
   }

   if(totalLots > 0.0)
      weightedPrice = priceLotSum / totalLots;
}

//+------------------------------------------------------------------+
//| Cuenta las órdenes abiertas activas                              |
//+------------------------------------------------------------------+
int CountOpenOrders()
{
   int count = 0;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == InpMagicNumber)
            count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Creación del Panel Visual (HUD)                                  |
//+------------------------------------------------------------------+
void CreateDashboard()
{
   string prefix = "XAU1762_";
   int x = 20;
   int y = 30;
   int width = 320;
   int height = 230;

   ObjectCreate(0, prefix + "BG", OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, prefix + "BG", OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, prefix + "BG", OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, prefix + "BG", OBJPROP_XSIZE, width);
   ObjectSetInteger(0, prefix + "BG", OBJPROP_YSIZE, height);
   ObjectSetInteger(0, prefix + "BG", OBJPROP_BGCOLOR, InpDashboardColor);
   ObjectSetInteger(0, prefix + "BG", OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, prefix + "BG", OBJPROP_CORNER, CORNER_LEFT_UPPER);

   ObjectCreate(0, prefix + "TITLE", OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, prefix + "TITLE", OBJPROP_XDISTANCE, x + 12);
   ObjectSetInteger(0, prefix + "TITLE", OBJPROP_YDISTANCE, y + 10);
   ObjectSetInteger(0, prefix + "TITLE", OBJPROP_COLOR, clrGold);
   ObjectSetString(0, prefix + "TITLE", OBJPROP_TEXT, "⚡ XAUUSD BURST SCALPER #1762");
   ObjectSetString(0, prefix + "TITLE", OBJPROP_FONT, "Segoe UI Semibold");
   ObjectSetInteger(0, prefix + "TITLE", OBJPROP_FONTSIZE, 11);

   ObjectCreate(0, prefix + "SUB", OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_XDISTANCE, x + 12);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_YDISTANCE, y + 32);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_COLOR, clrSilver);
   ObjectSetString(0, prefix + "SUB", OBJPROP_TEXT, "Zonas Seguras: 09:00-12:30 y 18:00-21:30 ES");
   ObjectSetString(0, prefix + "SUB", OBJPROP_FONT, "Segoe UI");
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_FONTSIZE, 8);

   for(int i = 0; i < 7; i++)
   {
      string name = prefix + "LINE_" + IntegerToString(i);
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x + 12);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y + 55 + (i * 22));
      ObjectSetInteger(0, name, OBJPROP_COLOR, clrWhite);
      ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 9);
   }
}

//+------------------------------------------------------------------+
//| Actualización del Panel Visual (HUD)                             |
//+------------------------------------------------------------------+
void UpdateDashboard(string statusMsg)
{
   string prefix = "XAU1762_";
   int openCount = 0;
   long cycleType = -1;
   double totalLots = 0.0;
   double weightedEntry = 0.0;
   double lastOrderPrice = 0.0;
   double floatingProfit = 0.0;

   GetBasketState(openCount, cycleType, totalLots, weightedEntry, lastOrderPrice, floatingProfit);

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   double marginLvl = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double spreadUSD = currentAsk - currentBid;

   datetime serverTime = TimeCurrent();
   MqlDateTime dt;
   TimeToStruct(serverTime, dt);
   int spainHour = dt.hour - InpServerOffsetFromSpain;
   if(spainHour < 0) spainHour += 24;

   bool inSafe = IsWithinSafeHours();
   string dirStr = (openCount == 0) ? (inSafe ? "ZONA SEGURA: BUSCANDO" : "CONGELADO (FUERA ZONA)") : (cycleType == POSITION_TYPE_BUY ? "BUY (COMPRAS)" : "SELL (VENTAS)");
   color dirColor = (openCount == 0) ? (inSafe ? clrAqua : clrDarkGray) : (cycleType == POSITION_TYPE_BUY ? clrLime : clrTomato);

   string targetDistStr = "---";
   if(openCount > 0)
   {
      double dist = (cycleType == POSITION_TYPE_BUY) ? (weightedEntry + InpBasketTP_USD - currentBid) : (currentAsk - (weightedEntry - InpBasketTP_USD));
      targetDistStr = StringFormat("%.2f$ (%.1fp)", dist, dist * 10);
   }

   SetLabelText(prefix + "LINE_0", StringFormat("Estado: %s", (statusMsg != "" ? statusMsg : dirStr)), dirColor);
   SetLabelText(prefix + "LINE_1", StringFormat("Cesta: %d/%d ordenes | Lotes: %.2f", openCount, InpMaxOrders, totalLots), clrWhite);
   SetLabelText(prefix + "LINE_2", StringFormat("P. Medio: %.2f | Distancia TP: %s", weightedEntry, targetDistStr), clrAqua);
   SetLabelText(prefix + "LINE_3", StringFormat("Flotante: $%.2f (%+.2f%%)", floatingProfit, (balance > 0 ? floatingProfit/balance*100.0 : 0.0)), (floatingProfit >= 0 ? clrLime : clrOrangeRed));
   SetLabelText(prefix + "LINE_4", StringFormat("Balance: $%.2f | Equidad: $%.2f", balance, equity), clrWhite);
   SetLabelText(prefix + "LINE_5", StringFormat("Hora ES: %02d:%02d | Spread: %.2f$", spainHour, dt.min, spreadUSD), (spreadUSD > InpMaxSpreadUSD ? clrRed : clrLightGray));
   SetLabelText(prefix + "LINE_6", StringFormat("Ciclos Ganados: %d | Ganancia: $%.2f", m_closedCyclesCount, m_closedCyclesProfit), clrGold);
}

void SetLabelText(string name, string text, color clr)
{
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
}

void DestroyDashboard()
{
   ObjectsDeleteAll(0, "XAU1762_");
}
//+------------------------------------------------------------------+
