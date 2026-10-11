//+------------------------------------------------------------------+
//|                               EA_XAUUSD_Burst_Scalper_1762.mq5   |
//|               Estrategia Dual-Engine: Rango + Expansión           |
//|          Compensación Cruzada en Breakeven (Cross-Close)          |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab"
#property link      "https://github.com/telegram-mtproto"
#property version   "4.00"
#property description "EA Dual-Engine de Alta Frecuencia para XAUUSD"
#property description "Motor 1 (Rango con mult suave 1.4x) + Motor 2 (Expansión) + Cierre Cruzado en Breakeven"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- ENUMERACIONES ---
enum ENUM_ENTRY_MODE
{
   ENTRY_BREAKOUT_M15,    // Rotura de Rango 15m
   ENTRY_MOMENTUM_M1,     // Momentum de vela M1 (Recomendado)
   ENTRY_MOMENTUM_M1_HTF, // Gatillo 3: Momentum M1 + Filtro Institucional HTF (H1)
   ENTRY_MANUAL_DIRECTION // Dirección manual fija
};

enum ENUM_MANUAL_DIR
{
   DIR_BOTH, // Ambos sentidos
   DIR_BUY,  // Solo Compras
   DIR_SELL  // Solo Ventas
};

//--- PARÁMETROS DE ENTRADA ---
input group "=== 1. MOTOR 1: RANGO / MICRO-BURST (SCALPING) ===";
input ENUM_ENTRY_MODE    InpEntryMode             = ENTRY_MOMENTUM_M1;  // Gatillo Motor Rango (Momentum M1)
input int                InpRangeLookbackM1       = 15;                 // Periodo de Rango en M1 (minutos)
input ENUM_MANUAL_DIR    InpAllowedDirection      = DIR_BOTH;           // Dirección Permitida
input double             InpBasketTP_USD          = 2.5;                // Take Profit de Cesta Rango en $ (2.5$)
input double             InpReentryStep_USD       = 2.5;                // Distancia para Re-entrada en $ (2.5$)
input int                InpMinReentrySeconds     = 180;                // Pausa mínima entre órdenes (180s = 3 min)
input double             InpBaseLot               = 0.01;               // Lote Base Inicial
input double             InpLotMultiplier         = 1.4;                // Multiplicador Suave (1.4x en vez de 2.0x)
input int                InpMaxOrders             = 6;                  // Máximo de Órdenes en Rango (6)

input group "=== 2. MOTOR 2: EXPANSIÓN (A FAVOR DE ROTURA) ===";
input bool               InpEnableTrendEngine     = true;               // Activar Motor 2 de Expansión
input int                InpTrendTriggerOrders    = 3;                  // Activar Expansión si Rango acumula N órdenes (ej: 3)
input double             InpTrendLotFactor        = 1.5;                // Factor de Lote Expansión vs Rango (1.5x = Delta positivo)
input double             InpTrendTakeProfitUSD    = 15.0;               // TP Individual de Expansión en $ (15$)

input group "=== 3. COMPENSACIÓN CRUZADA (CROSS-CLOSE BREAKEVEN) ===";
input bool               InpEnableCrossClose      = true;               // Activar Cierre Combinado en Breakeven
input double             InpCombinedTargetUSD     = 1.5;                // Ganancia Neta Combinada para Cerrar Ambos (+1.5$)

input group "=== 4. FILTRO INSTITUCIONAL HTF (OPCIONAL) ===";
input ENUM_TIMEFRAMES    InpHTFTimeframe          = PERIOD_H1;          // Temporalidad Mayor HTF (ej: H1)
input int                InpHTF_EMA_Period        = 50;                 // Periodo EMA Institucional HTF

input group "=== 5. ZONAS SEGURAS CUANTITATIVAS (HORA ESPAÑA) ===";
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

input group "=== 6. CIERRE NO OVERNIGHT & CIERRE DE VIERNES ===";
input bool               InpEnableNightClose      = true;               // Activar Cierre Nocturno Diario (No Overnight)
input int                InpNightCloseHourES      = 21;                 // Hora Cierre Diario España (21:45)
input int                InpNightCloseMinES       = 45;                 // Minuto Cierre Diario España

input bool               InpEnableFridayClose     = true;               // Activar Cierre Forzoso de Viernes (Fin de Semana)
input int                InpFridayCloseHourES     = 21;                 // Hora Cierre Viernes España (21:15)
input int                InpFridayCloseMinES      = 15;                 // Minuto Cierre Viernes España

input group "=== 7. PROTECCIONES Y SEGURIDAD ===";
input double             InpMaxSpreadUSD          = 0.60;               // Spread Máximo Permitido en $
input double             InpMinMarginLevelPct     = 150.0;              // Nivel Mínimo de Margen Libre (%)
input double             InpEmergencyBasketSL     = 0.0;                // SL de Emergencia en $ (0 = Desactivado)
input double             InpDailyTargetUSD        = 0.0;                // Meta Diaria de Beneficio en $ (0 = Ilimitado)

input group "=== 8. IDENTIFICACIÓN & CONTROL ===";
input ulong              InpMagicRange            = 176201;             // Magic Number Motor 1 (Rango)
input ulong              InpMagicTrend            = 176202;             // Magic Number Motor 2 (Expansión)
input string             InpTradeComment          = "XAU_DualEngine";   // Comentario de Trade
input bool               InpShowDashboard         = true;               // Mostrar Panel Visual en Gráfico
input color              InpDashboardColor        = C'15,25,38';        // Color de Fondo del Panel

//--- OBJETOS Y VARIABLES GLOBALES ---
CPositionInfo     m_pos;
datetime          m_lastOrderTime       = 0;
int               m_currentCycleId      = 0;
int               m_closedCyclesCount   = 0;
double            m_closedCyclesProfit  = 0.0;
double            m_dayStartBalance     = 0.0;
datetime          m_lastDayCheck        = 0;
int               m_htfEmaHandle        = INVALID_HANDLE;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   m_dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   m_lastDayCheck    = TimeCurrent();

   if(InpEntryMode == ENTRY_MOMENTUM_M1_HTF)
   {
      m_htfEmaHandle = iMA(_Symbol, InpHTFTimeframe, InpHTF_EMA_Period, 0, MODE_EMA, PRICE_CLOSE);
      PrintFormat("📊 [Filtro HTF Activado] Temporalidad: %s | Periodo EMA: %d", EnumToString(InpHTFTimeframe), InpHTF_EMA_Period);
   }

   PrintFormat("🚀 [EA Dual-Engine XAUUSD] Rango Mult: %.2fx | Expansión Trigger: %d órdenes | Cross-Close: %.2f$",
               InpLotMultiplier, InpTrendTriggerOrders, InpCombinedTargetUSD);

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
      if(currentDailyGain >= InpDailyTargetUSD && CountTotalOpenOrders() == 0)
      {
         UpdateDashboard("Meta diaria conseguida. Operativa en pausa.");
         return;
      }
   }

   // 3. CIERRE FORZOSO NOCTURNO Y DE FIN DE SEMANA (NO OVERNIGHT / NO WEEKEND HOLDING)
   if(IsForceCloseTime(now))
   {
      if(CountTotalOpenOrders() > 0)
      {
         PrintFormat("🔒 [CIERRE FORZOSO] Cerrando ambas operativas antes del cierre de mercado (No Overnight / Friday Close)...");
         CloseBothEngines();
         m_lastOrderTime = now;
      }
      UpdateDashboard("MERCADO CERRADO / NO OVERNIGHT");
      return;
   }

   // 4. Inspeccionar el estado de ambos motores
   int rangeCount = 0;
   long rangeType = -1;
   double rangeLots = 0.0, rangeWeighted = 0.0, rangeLastPrice = 0.0, rangeProfit = 0.0;
   GetEngineState(InpMagicRange, rangeCount, rangeType, rangeLots, rangeWeighted, rangeLastPrice, rangeProfit);

   int trendCount = 0;
   long trendType = -1;
   double trendLots = 0.0, trendWeighted = 0.0, trendLastPrice = 0.0, trendProfit = 0.0;
   GetEngineState(InpMagicTrend, trendCount, trendType, trendLots, trendWeighted, trendLastPrice, trendProfit);

   double netCombinedProfit = rangeProfit + trendProfit;

   // 4.1 COMPENSACIÓN CRUZADA (CROSS-CLOSE BREAKEVEN)
   // En cuanto la suma de flotantes Rango + Expansión supere el objetivo (+1.5$), liquidar ambos
   if(InpEnableCrossClose && rangeCount > 0 && trendCount > 0)
   {
      if(netCombinedProfit >= InpCombinedTargetUSD)
      {
         PrintFormat("🎯 [COMPENSACIÓN CRUZADA EXITOSA] Rango: $%.2f | Expansión: $%.2f | Neto Total: +$%.2f. ¡Cerrando ambos motores!",
                     rangeProfit, trendProfit, netCombinedProfit);
         CloseBothEngines();
         m_closedCyclesCount++;
         m_closedCyclesProfit += netCombinedProfit;
         m_lastOrderTime = TimeCurrent();
         UpdateDashboard(StringFormat("Compensación Cruzada Ganada (+%.2f$)", netCombinedProfit));
         return;
      }
   }

   // 4.2 GESTIÓN DEL MOTOR 1 (RANGO)
   if(rangeCount > 0)
   {
      double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double currentSpread = currentAsk - currentBid;

      bool tpTriggered = false;
      if(rangeType == POSITION_TYPE_BUY)
      {
         double targetPrice = rangeWeighted + InpBasketTP_USD + currentSpread;
         if(currentBid >= targetPrice) tpTriggered = true;
      }
      else if(rangeType == POSITION_TYPE_SELL)
      {
         double targetPrice = rangeWeighted - InpBasketTP_USD - currentSpread;
         if(currentAsk <= targetPrice) tpTriggered = true;
      }

      // Si el Motor de Rango resuelve por sí solo en su Take Profit:
      if(tpTriggered)
      {
         PrintFormat("🎯 [TP Rango Solitario Alcanzado] Ciclo #%d | Órdenes: %d | Lotes: %.2f | Profit: $%.2f",
                     m_currentCycleId, rangeCount, rangeLots, rangeProfit);
         CloseBasketByMagic(InpMagicRange);
         if(trendCount > 0) CloseBasketByMagic(InpMagicTrend);
         m_closedCyclesCount++;
         m_closedCyclesProfit += rangeProfit;
         m_lastOrderTime = TimeCurrent();
         UpdateDashboard("TP Rango ganado con éxito");
         return;
      }

      // Re-entradas suaves del Motor de Rango (con multiplicador suave y pausa)
      if(rangeCount < InpMaxOrders && (now - m_lastOrderTime) >= InpMinReentrySeconds)
      {
         bool canAdd = false;
         double lotForNext = CalculateNextLot(rangeCount);

         if(rangeType == POSITION_TYPE_BUY && (rangeLastPrice - currentAsk) >= InpReentryStep_USD)
            canAdd = true;
         else if(rangeType == POSITION_TYPE_SELL && (currentBid - rangeLastPrice) >= InpReentryStep_USD)
            canAdd = true;

         if(canAdd && CheckFilters(currentSpread))
         {
            ExecuteOrder((ENUM_POSITION_TYPE)rangeType, lotForNext, InpMagicRange, "Range #" + IntegerToString(rangeCount + 1));
            m_lastOrderTime = TimeCurrent();
         }
      }

      // 4.3 ACTIVACIÓN DEL MOTOR 2 (EXPANSIÓN)
      // Si la cesta de rango acumula >= InpTrendTriggerOrders y la expansión aún no está dentro:
      if(InpEnableTrendEngine && rangeCount >= InpTrendTriggerOrders && trendCount == 0)
      {
         ENUM_POSITION_TYPE trendDir = (rangeType == POSITION_TYPE_BUY) ? POSITION_TYPE_SELL : POSITION_TYPE_BUY;
         double trendLot = NormalizeDouble(rangeLots * InpTrendLotFactor, 2);
         double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
         double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
         if(trendLot < minLot) trendLot = minLot;
         if(trendLot > maxLot) trendLot = maxLot;

         PrintFormat("🚀 [MOTOR EXPANSIÓN DISPARADO] Rango en orden %d (%.2f lotes) | Entrando a favor de la rotura: %s %.2f lotes",
                     rangeCount, rangeLots, EnumToString(trendDir), trendLot);
         ExecuteOrder(trendDir, trendLot, InpMagicTrend, "Trend_Expansion");
      }
   }
   else
   {
      // 5. No hay órdenes activas en rango: Buscar nueva oportunidad en Zonas Seguras
      if(InpUseSafeHoursOnly && !IsWithinSafeHours())
      {
         UpdateDashboard("FUERA DE ZONA SEGURA (CONGELADO)");
         return;
      }

      double currentSpread = SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(!CheckFilters(currentSpread))
      {
         UpdateDashboard("Filtro de spread o margen bloqueando");
         return;
      }

      ENUM_POSITION_TYPE triggerDirection;
      if(CheckNewEntrySignal(triggerDirection))
      {
         m_currentCycleId++;
         double startLot = InpBaseLot;
         PrintFormat("⚡ [Nuevo Ciclo Rango #%d] Disparo inicial: %s | Lote: %.2f",
                     m_currentCycleId, EnumToString(triggerDirection), startLot);
         ExecuteOrder(triggerDirection, startLot, InpMagicRange, "Init #" + IntegerToString(m_currentCycleId));
         m_lastOrderTime = TimeCurrent();
      }
      else
      {
         UpdateDashboard("ZONA SEGURA: Buscando Momentum M1");
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

   if(dt.day_of_week == 6 || dt.day_of_week == 0)
      return true;

   if(InpEnableFridayClose && dt.day_of_week == 5)
   {
      int friCloseMin = (InpFridayCloseHourES * 60) + InpFridayCloseMinES;
      if(spainTotalMinutes >= friCloseMin)
         return true;
   }

   if(InpEnableNightClose && (dt.day_of_week >= 1 && dt.day_of_week <= 4))
   {
      int nightCloseMin = (InpNightCloseHourES * 60) + InpNightCloseMinES;
      if(spainTotalMinutes >= nightCloseMin || spainTotalMinutes < 180)
         return true;
   }

   return false;
}

//+------------------------------------------------------------------+
//| Evalúa la señal de rotura o momentum                             |
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

      MqlRates m1Rates[];
      ArraySetAsSeries(m1Rates, true);
      if(CopyRates(_Symbol, PERIOD_M1, 1, 1, m1Rates) <= 0)
         return false;

      bool m1Bullish = (m1Rates[0].close > m1Rates[0].open);
      bool m1Bearish = (m1Rates[0].close < m1Rates[0].open);

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
//| Ejecuta una orden asignada a un Magic Number específico          |
//+------------------------------------------------------------------+
bool ExecuteOrder(ENUM_POSITION_TYPE type, double lot, ulong magic, string comment)
{
   CTrade trade;
   trade.SetExpertMagicNumber(magic);
   trade.SetMarginMode();
   trade.SetTypeFillingBySymbol(_Symbol);

   string fullComment = InpTradeComment + "_" + comment;
   if(type == POSITION_TYPE_BUY)
   {
      double price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      return trade.Buy(lot, _Symbol, price, 0.0, 0.0, fullComment);
   }
   else
   {
      double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      return trade.Sell(lot, _Symbol, price, 0.0, 0.0, fullComment);
   }
}

//+------------------------------------------------------------------+
//| Cierra todas las posiciones asociadas a un Magic Number          |
//+------------------------------------------------------------------+
void CloseBasketByMagic(ulong magic)
{
   CTrade trade;
   trade.SetExpertMagicNumber(magic);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == magic)
         {
            trade.PositionClose(m_pos.Ticket());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Cierra simultáneamente ambos motores (Rango + Expansión)         |
//+------------------------------------------------------------------+
void CloseBothEngines()
{
   CloseBasketByMagic(InpMagicRange);
   CloseBasketByMagic(InpMagicTrend);
}

//+------------------------------------------------------------------+
//| Obtiene el estado acumulado de un motor por su Magic Number      |
//+------------------------------------------------------------------+
void GetEngineState(ulong magic, int &count, long &posType, double &totalLots, double &weightedPrice, double &lastPrice, double &floatingProfit)
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
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == magic)
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
//| Cuenta total de órdenes abiertas por ambos motores               |
//+------------------------------------------------------------------+
int CountTotalOpenOrders()
{
   int count = 0;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && (m_pos.Magic() == InpMagicRange || m_pos.Magic() == InpMagicTrend))
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
   string prefix = "XAUDUAL_";
   int x = 20;
   int y = 30;
   int width = 340;
   int height = 240;

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
   ObjectSetString(0, prefix + "TITLE", OBJPROP_TEXT, "⚡ XAUUSD DUAL-ENGINE (RANGO + EXPANSIÓN)");
   ObjectSetString(0, prefix + "TITLE", OBJPROP_FONT, "Segoe UI Semibold");
   ObjectSetInteger(0, prefix + "TITLE", OBJPROP_FONTSIZE, 10);

   ObjectCreate(0, prefix + "SUB", OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_XDISTANCE, x + 12);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_YDISTANCE, y + 30);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_COLOR, clrSilver);
   ObjectSetString(0, prefix + "SUB", OBJPROP_TEXT, "Cierre Cruzado en Breakeven (+1.5$) | Mult 1.4x");
   ObjectSetString(0, prefix + "SUB", OBJPROP_FONT, "Segoe UI");
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_FONTSIZE, 8);

   for(int i = 0; i < 7; i++)
   {
      string name = prefix + "LINE_" + IntegerToString(i);
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x + 12);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y + 52 + (i * 22));
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
   string prefix = "XAUDUAL_";

   int rangeCount = 0;
   long rangeType = -1;
   double rangeLots = 0.0, rangeWeighted = 0.0, rangeLastPrice = 0.0, rangeProfit = 0.0;
   GetEngineState(InpMagicRange, rangeCount, rangeType, rangeLots, rangeWeighted, rangeLastPrice, rangeProfit);

   int trendCount = 0;
   long trendType = -1;
   double trendLots = 0.0, trendWeighted = 0.0, trendLastPrice = 0.0, trendProfit = 0.0;
   GetEngineState(InpMagicTrend, trendCount, trendType, trendLots, trendWeighted, trendLastPrice, trendProfit);

   double netProfit = rangeProfit + trendProfit;
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity    = AccountInfoDouble(ACCOUNT_EQUITY);
   double currentAsk= SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid= SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double spreadUSD = currentAsk - currentBid;

   datetime serverTime = TimeCurrent();
   MqlDateTime dt;
   TimeToStruct(serverTime, dt);
   int spainHour = dt.hour - InpServerOffsetFromSpain;
   if(spainHour < 0) spainHour += 24;

   bool inSafe = IsWithinSafeHours();
   string dirStr = (rangeCount == 0 && trendCount == 0) ? (inSafe ? "ZONA SEGURA: BUSCANDO" : "CONGELADO (FUERA ZONA)") :
                   StringFormat("M1: %s (%d) | M2: %s (%d)", 
                                (rangeType == POSITION_TYPE_BUY ? "BUY" : (rangeType == POSITION_TYPE_SELL ? "SELL" : "---")), rangeCount,
                                (trendType == POSITION_TYPE_BUY ? "BUY" : (trendType == POSITION_TYPE_SELL ? "SELL" : "---")), trendCount);

   color statusClr = (rangeCount == 0 && trendCount == 0) ? (inSafe ? clrAqua : clrDarkGray) : (netProfit >= 0 ? clrLime : clrOrange);

   SetLabelText(prefix + "LINE_0", StringFormat("Estado: %s", (statusMsg != "" ? statusMsg : dirStr)), statusClr);
   SetLabelText(prefix + "LINE_1", StringFormat("M1 (Rango): %d ord | %.2f lot | P&L: $%.2f", rangeCount, rangeLots, rangeProfit), clrWhite);
   SetLabelText(prefix + "LINE_2", StringFormat("M2 (Trend): %d ord | %.2f lot | P&L: $%.2f", trendCount, trendLots, trendProfit), (trendCount > 0 ? clrAqua : clrDarkGray));
   SetLabelText(prefix + "LINE_3", StringFormat("Neto Combinado: $%.2f (%+.2f%%)", netProfit, (balance > 0 ? netProfit/balance*100.0 : 0.0)), (netProfit >= InpCombinedTargetUSD ? clrLime : (netProfit >= 0 ? clrAqua : clrOrangeRed)));
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
   ObjectsDeleteAll(0, "XAUDUAL_");
}
//+------------------------------------------------------------------+
