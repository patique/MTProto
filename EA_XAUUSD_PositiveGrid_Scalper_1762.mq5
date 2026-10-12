//+------------------------------------------------------------------+
//|                               EA_XAUUSD_PositiveGrid_Scalper_1762.mq5 |
//|                     Copyright 2026, Quant Institutional Systems  |
//|                       Estrategia de Piramidación Positiva        |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Quant Institutional Systems"
#property link      "https://t.me/"
#property version   "1.00"
#property description "EA de Scalping con Piramidación en Positivo (Grid a Favor) y Trailing Stop de Riesgo Cero"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- ENUMERADORES ---
enum ENUM_ENTRY_MODE
{
   ENTRY_MOMENTUM_M1,       // Gatillo Momentum M1 (Cierre última vela)
   ENTRY_RANGE_BREAKOUT,    // Rotura de Rango 15m (High/Low de 15 velas M1)
   ENTRY_MOMENTUM_M1_HTF,   // Gatillo Momentum M1 filtrado con Tendencia HTF (H1)
   ENTRY_MANUAL_DIRECTION   // Dirección Fija según InpAllowedDirection
};

enum ENUM_MANUAL_DIR
{
   DIR_BOTH,                // Ambas direcciones (Buy y Sell)
   DIR_BUY,                 // Solo Compras (Buy)
   DIR_SELL                 // Solo Ventas (Sell)
};

//--- PARÁMETROS DE ENTRADA ---
input group "=== 1. MOTOR DE PIRAMIDACIÓN EN POSITIVO (POSITIVE GRID) ===";
input ENUM_ENTRY_MODE    InpEntryMode             = ENTRY_MOMENTUM_M1;  // Modo de Gatillo Inicial
input int                InpRangeLookbackM1       = 15;                 // Periodo de Rotura M1 (si ENTRY_RANGE_BREAKOUT)
input ENUM_MANUAL_DIR    InpAllowedDirection      = DIR_BOTH;           // Dirección Permitida (Ambas, Solo Buy, Solo Sell)
input double             InpPyramidStep_USD       = 2.0;                // Distancia para Re-entrada a Favor ($2.0 en Oro)
input double             InpLockSpread_USD        = 0.30;               // Ganancia mínima de Break-Even en $ ($0.30)
input int                InpMaxPyramidOrders      = 10;                 // Máximo de Posiciones en Pirámide (ej: 10)
input double             InpBasketTargetTP_USD    = 0.0;                // Take Profit de Cesta en $ (0 = Trailing Puro hasta retroceso)

input group "=== 2. GESTIÓN DE CAPITAL (LOT POR BALANCE) ===";
input double             InpBalanceStepEUR        = 100.0;              // Tramo de Balance para 0.01 lotes (100€ = 0.01)
input double             InpBaseLotStep           = 0.01;               // Lote por cada tramo (0.01)

input group "=== 3. CORTACIRCUITOS Y VOLATILIDAD (CIRCUIT BREAKER) ===";
input bool               InpEnableCircuitBreaker  = true;               // Activar Cortacircuitos de Volatilidad Anormal
input double             InpMaxPrevH1RangeUSD     = 45.0;               // Rango Máximo Permitido en última vela H1 ($45.0)
input double             InpMaxDailyRangeUSD      = 100.0;              // Rango Diario Acumulado Máximo en D1 ($100.0)
input bool               InpBlockMonthEndDay      = true;               // Bloquear operativa en Cierre de Mes (Día Completo)
input int                InpMonthEndStartHourES   = 0;                  // Hora inicio bloqueo Fin de Mes España (0 = Todo el día)

input group "=== 4. LISTA NEGRA DE NOTICIAS DE ALTO IMPACTO ===";
input bool               InpEnableNewsBlacklist   = true;               // Activar Bloqueo en Días de Noticias de Alto Impacto
input string             InpCustomNewsDates       = "2026.01.28,2026.01.29,2026.01.30,2026.02.27,2026.03.18,2026.04.07,2026.04.23,2026.04.29,2026.04.30,2026.06.17,2026.07.17"; // Días a Bloquear

// Array interno de fechas críticas de alto impacto / FOMC / CPI / OPEX en 2026
const string g_newsDates2026[] = {
   "2026.01.28", // FOMC Rate Decision
   "2026.01.29", // FOMC Post-reaction
   "2026.01.30", // Month-End Rebalancing / Cisne Negro ($586)
   "2026.02.27", // Month-End Rebalancing ($55 surge)
   "2026.03.18", // FOMC Rate Decision & Powell
   "2026.04.07", // Reapertura Londres Post-Pascua (Flash Surge +$50)
   "2026.04.23", // US Flash PMI & Jobless Claims
   "2026.04.29", // FOMC Rate Decision
   "2026.04.30", // Month-End
   "2026.06.17", // FOMC Dot Plot & Powell (-151$ crash)
   "2026.07.17"  // OPEX / Volatilidad Julio
};

input group "=== 5. ZONAS SEGURAS CUANTITATIVAS (HORA ESPAÑA) ===";
input bool               InpUseSafeHoursOnly      = true;               // Operar ÚNICAMENTE en Zonas Seguras
input int                InpServerOffsetFromSpain = 1;                  // Diferencia Servidor vs España (+1h en FTMO)

// Ventana 1: Mañana Europea Tranquila (09:00 a 12:30 España / 10:00 a 13:30 Servidor)
input bool               InpEnableWindow1         = true;               // Activar Ventana 1 (Mañana Europa)
input int                InpWin1StartHourES       = 9;                  // Inicio Ventana 1 Hora España (09:00)
input int                InpWin1StartMinES        = 0;                  // Minuto Inicio Ventana 1
input int                InpWin1EndHourES         = 12;                 // Fin Ventana 1 Hora España (12:30)
input int                InpWin1EndMinES          = 30;                 // Minuto Fin Ventana 1

// Ventana 2: Tarde Americana Tranquila (18:00 a 20:00 España / 19:00 a 21:00 Servidor)
input bool               InpEnableWindow2         = true;               // Activar Ventana 2 (Tarde USA Post-Europa)
input int                InpWin2StartHourES       = 18;                 // Inicio Ventana 2 Hora España (18:00)
input int                InpWin2StartMinES        = 0;                  // Minuto Inicio Ventana 2
input int                InpWin2EndHourES         = 20;                 // Fin Ventana 2 Hora España (20:00)
input int                InpWin2EndMinES          = 0;                  // Minuto Fin Ventana 2

input group "=== 6. PROTECCIÓN FIN DE SEMANA (FRIDAY CLOSE) ===";
input bool               InpEnableFridayClose     = true;               // Activar Cierre Forzoso de Viernes (Fin de Semana)
input int                InpFridayCloseHourES     = 21;                 // Hora Cierre Viernes España (21:15)
input int                InpFridayCloseMinES      = 15;                 // Minuto Cierre Viernes España

input group "=== 7. FILTRO INSTITUCIONAL HTF ===";
input ENUM_TIMEFRAMES    InpHTFTimeframe          = PERIOD_H1;          // Temporalidad Mayor HTF (Recomendado H1)
input int                InpHTF_EMA_Period        = 50;                 // Periodo EMA Institucional HTF (ej: 50)

input group "=== 8. PROTECCIONES Y SEGURIDAD ===";
input double             InpMaxSpreadUSD          = 0.60;               // Spread Máximo Permitido en $
input double             InpMinMarginLevelPct     = 150.0;              // Nivel Mínimo de Margen Libre (%)

input group "=== 9. IDENTIFICACIÓN & CONTROL ===";
input ulong              InpMagicNumber           = 176210;             // Magic Number
input string             InpTradeComment          = "XAU_PosGrid_1762"; // Comentario de Trade
input bool               InpShowDashboard         = true;               // Mostrar Panel Visual en Gráfico
input color              InpDashboardColor        = C'15,25,38';        // Color de Fondo del Panel

//--- ESTRUCTURA DE POSICIÓN ---
struct SPosInfo
{
   ulong    ticket;
   double   priceOpen;
   double   volume;
   double   sl;
   double   tp;
   ENUM_POSITION_TYPE type;
   datetime openTime;
};

//--- OBJETOS Y VARIABLES GLOBALES ---
CTrade            m_trade;
CPositionInfo     m_pos;
datetime          m_lastOrderTime       = 0;
int               m_currentCycleId      = 0;
int               m_closedCyclesCount   = 0;
double            m_closedCyclesProfit  = 0.0;
int               m_htfEmaHandle        = INVALID_HANDLE;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   m_trade.SetExpertMagicNumber(InpMagicNumber);
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(_Symbol);

   if(InpEntryMode == ENTRY_MOMENTUM_M1_HTF)
   {
      m_htfEmaHandle = iMA(_Symbol, InpHTFTimeframe, InpHTF_EMA_Period, 0, MODE_EMA, PRICE_CLOSE);
      if(m_htfEmaHandle == INVALID_HANDLE)
      {
         Print("❌ Error al crear indicador HTF EMA");
         return INIT_FAILED;
      }
   }

   PrintFormat("🚀 [EA_XAUUSD_PositiveGrid_Scalper_1762] Inicializado | Magic: %d | Paso Pirámide: %.2f$ | Lock: %.2f$",
               InpMagicNumber, InpPyramidStep_USD, InpLockSpread_USD);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(m_htfEmaHandle != INVALID_HANDLE)
      IndicatorRelease(m_htfEmaHandle);

   Comment("");
}

//+------------------------------------------------------------------+
//| Calcula el lotaje proporcional según balance (0.01 por cada 100€)|
//+------------------------------------------------------------------+
double CalculateLotSize()
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   int multiplier = (int)MathFloor(balance / InpBalanceStepEUR);
   if(multiplier < 1) multiplier = 1;

   double lot = multiplier * InpBaseLotStep;
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   lot = MathFloor(lot / lotStep) * lotStep;
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;
   return NormalizeDouble(lot, 2);
}

//+------------------------------------------------------------------+
//| Obtiene la lista ordenada de posiciones abiertas                 |
//+------------------------------------------------------------------+
int GetOpenPositions(SPosInfo &list[])
{
   ArrayResize(list, 0);
   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == InpMagicNumber)
         {
            int sz = ArraySize(list);
            ArrayResize(list, sz + 1);
            list[sz].ticket    = m_pos.Ticket();
            list[sz].priceOpen = m_pos.PriceOpen();
            list[sz].volume    = m_pos.Volume();
            list[sz].sl        = m_pos.StopLoss();
            list[sz].tp        = m_pos.TakeProfit();
            list[sz].type      = m_pos.PositionType();
            list[sz].openTime  = (datetime)m_pos.Time();
         }
      }
   }

   // Ordenar cronológicamente por tiempo de apertura (de más antigua a más nueva)
   int total = ArraySize(list);
   for(int i = 0; i < total - 1; i++)
   {
      for(int j = i + 1; j < total; j++)
      {
         if(list[j].openTime < list[i].openTime)
         {
            SPosInfo tmp = list[i];
            list[i] = list[j];
            list[j] = tmp;
         }
      }
   }
   return total;
}

//+------------------------------------------------------------------+
//| Actualiza la escalera de Trailing Stop según las reglas          |
//+------------------------------------------------------------------+
void UpdatePyramidStopLosses(ENUM_POSITION_TYPE posType)
{
   SPosInfo list[];
   int n = GetOpenPositions(list);
   if(n == 0) return;

   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   // CASO 1: Posición ÚNICA (Regla 5)
   // SL posicionado exactamente a la distancia de re-entrada
   if(n == 1)
   {
      double targetSL = 0.0;
      if(posType == POSITION_TYPE_BUY)
         targetSL = NormalizeDouble(list[0].priceOpen - InpPyramidStep_USD, digits);
      else
         targetSL = NormalizeDouble(list[0].priceOpen + InpPyramidStep_USD, digits);

      if(MathAbs(list[0].sl - targetSL) > (SymbolInfoDouble(_Symbol, SYMBOL_POINT) * 2.0) || list[0].sl == 0.0)
      {
         m_trade.PositionModify(list[0].ticket, targetSL, list[0].tp);
      }
      return;
   }

   // CASO 2: Dos o más posiciones abiertas (Piramidación Activa - Reglas 1, 2, 3 y 4)
   for(int i = 0; i < n; i++)
   {
      double targetSL = 0.0;

      if(posType == POSITION_TYPE_BUY)
      {
         if(i == n - 1)
         {
            // Última posición (la más reciente): SL en su nivel de entrada menos el paso (que es la entrada anterior)
            targetSL = NormalizeDouble(list[n - 1].priceOpen - InpPyramidStep_USD, digits);
         }
         else if(i == n - 2)
         {
            // Penúltima posición: SL a BE + spread/ganancia mínima
            targetSL = NormalizeDouble(list[n - 2].priceOpen + InpLockSpread_USD, digits);
         }
         else
         {
            // Posiciones anteriores: suben su SL al precio de entrada de la posición siguiente (i+1)
            targetSL = NormalizeDouble(list[i + 1].priceOpen, digits);
         }

         // Solo mover SL HACIA ARRIBA en compras
         if(targetSL > list[i].sl + 0.01 || list[i].sl == 0.0)
         {
            m_trade.PositionModify(list[i].ticket, targetSL, list[i].tp);
         }
      }
      else if(posType == POSITION_TYPE_SELL)
      {
         if(i == n - 1)
         {
            // Última posición: SL en su nivel de entrada más el paso
            targetSL = NormalizeDouble(list[n - 1].priceOpen + InpPyramidStep_USD, digits);
         }
         else if(i == n - 2)
         {
            // Penúltima posición: SL a BE - spread/ganancia mínima
            targetSL = NormalizeDouble(list[n - 2].priceOpen - InpLockSpread_USD, digits);
         }
         else
         {
            // Posiciones anteriores: bajan su SL al precio de entrada de la posición siguiente (i+1)
            targetSL = NormalizeDouble(list[i + 1].priceOpen, digits);
         }

         // Solo mover SL HACIA ABAJO en ventas
         if(targetSL < list[i].sl - 0.01 || list[i].sl == 0.0)
         {
            m_trade.PositionModify(list[i].ticket, targetSL, list[i].tp);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime now = TimeCurrent();

   // 1. Verificar Cierre Forzoso de Fin de Semana (Viernes)
   if(InpEnableFridayClose && IsFridayCloseTime(now))
   {
      if(CountOpenOrders() > 0)
      {
         Print("🔒 [CIERRE VIERNES] Cerrando posiciones antes del fin de semana...");
         CloseEntireBasket();
         UpdateDashboard("CIERRE FORZOSO VIERNES");
      }
      return;
   }

   // 2. Obtener estado de las posiciones activas
   SPosInfo openPositions[];
   int openCount = GetOpenPositions(openPositions);

   double totalFloatingProfit = 0.0;
   long cycleType = -1;
   for(int i = 0; i < openCount; i++)
   {
      if(m_pos.SelectByTicket(openPositions[i].ticket))
         totalFloatingProfit += m_pos.Profit() + m_pos.Swap();
      cycleType = openPositions[i].type;
   }

   // 3. Si hay posiciones abiertas: Gestionar PIRAMIDACIÓN EN POSITIVO
   if(openCount > 0)
   {
      double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double currentSpread = currentAsk - currentBid;

      // 3.1 Actualizar y sincronizar escalera de Trailing SL
      UpdatePyramidStopLosses((ENUM_POSITION_TYPE)cycleType);

      // 3.2 Verificar Take Profit global de cesta si estuviera configurado
      if(InpBasketTargetTP_USD > 0.0 && totalFloatingProfit >= InpBasketTargetTP_USD)
      {
         PrintFormat("🎯 [TP Cesta Pirámide Alcanzado] Ciclo #%d | Profit: $%.2f", m_currentCycleId, totalFloatingProfit);
         CloseEntireBasket();
         m_closedCyclesCount++;
         m_closedCyclesProfit += totalFloatingProfit;
         UpdateDashboard("Ciclo cerrado en TP de cesta");
         return;
      }

      // 3.3 Evaluar si el precio avanzó un paso a favor para ABRIR LA SIGUIENTE POSICIÓN (PIRÁMIDE)
      double lastEntryPrice = openPositions[openCount - 1].priceOpen;
      bool canAddPyramid = false;

      if(cycleType == POSITION_TYPE_BUY)
      {
         if((currentBid - lastEntryPrice) >= InpPyramidStep_USD)
            canAddPyramid = true;
      }
      else if(cycleType == POSITION_TYPE_SELL)
      {
         if((lastEntryPrice - currentAsk) >= InpPyramidStep_USD)
            canAddPyramid = true;
      }

      if(canAddPyramid && openCount < InpMaxPyramidOrders && CheckFilters(currentSpread))
      {
         double nextLot = CalculateLotSize();
         PrintFormat("🚀 [PIRÁMIDE #%d] Precio avanzó %.2f$ a favor | Abriendo Posición #%d con %.2f lotes",
                     m_currentCycleId, InpPyramidStep_USD, openCount + 1, nextLot);

         ExecuteOrder((ENUM_POSITION_TYPE)cycleType, nextLot, "Pyramid #" + IntegerToString(openCount + 1));
         m_lastOrderTime = TimeCurrent();

         // Sincronizar inmediatamente la nueva escalera de Stop Losses
         UpdatePyramidStopLosses((ENUM_POSITION_TYPE)cycleType);
         return;
      }
   }
   else
   {
      // 4. No hay órdenes activas: Verificar ZONAS SEGURAS y FILTROS antes de nuevo ciclo
      if(InpUseSafeHoursOnly && !IsWithinSafeHours())
      {
         UpdateDashboard("FUERA DE ZONA SEGURA (CONGELADO)");
         return;
      }

      // 4.1 CORTACIRCUITOS DE VOLATILIDAD & LISTA NEGRA DE NOTICIAS
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

      // 4.2 Evaluar Gatillo para iniciar NUEVA PIRÁMIDE (Ciclo)
      ENUM_POSITION_TYPE triggerDirection;
      if(CheckNewEntrySignal(triggerDirection))
      {
         m_currentCycleId++;
         double startLot = CalculateLotSize();

         PrintFormat("⚡ [Nueva Pirámide #%d] Disparo inicial: %s | Lote: %.2f (Balance: %.2f€)",
                     m_currentCycleId, EnumToString(triggerDirection), startLot, AccountInfoDouble(ACCOUNT_BALANCE));

         if(ExecuteOrder(triggerDirection, startLot, "Init Pyramid #" + IntegerToString(m_currentCycleId)))
         {
            m_lastOrderTime = TimeCurrent();
            // Colocar SL inicial a la distancia de paso
            UpdatePyramidStopLosses(triggerDirection);
         }
      }
      else
      {
         UpdateDashboard("ZONA SEGURA: Esperando gatillo M1");
      }
   }

   // 5. Actualizar panel visual HUD
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
//| Comprueba si es hora de cierre forzoso de Viernes                |
//+------------------------------------------------------------------+
bool IsFridayCloseTime(datetime time)
{
   MqlDateTime dt;
   TimeToStruct(time, dt);
   int spainHour = dt.hour - InpServerOffsetFromSpain;
   if(spainHour < 0) spainHour += 24;
   if(spainHour >= 24) spainHour -= 24;
   int spainTotalMinutes = (spainHour * 60) + dt.min;

   // Fin de semana completo
   if(dt.day_of_week == 6 || dt.day_of_week == 0)
      return true;

   // Viernes por la tarde/noche
   if(dt.day_of_week == 5)
   {
      int friCloseMin = (InpFridayCloseHourES * 60) + InpFridayCloseMinES;
      if(spainTotalMinutes >= friCloseMin)
         return true;
   }

   return false;
}

//+------------------------------------------------------------------+
//| Evalúa si el Cortacircuitos debe bloquear nuevas entradas        |
//+------------------------------------------------------------------+
bool IsCircuitBreakerTriggered(string &reason)
{
   // 1. Comprobar Lista Negra de Días de Noticias de Alto Impacto
   if(InpEnableNewsBlacklist)
   {
      datetime now = TimeCurrent();
      MqlDateTime dt;
      TimeToStruct(now, dt);
      string currentDayStr = StringFormat("%04d.%02d.%02d", dt.year, dt.mon, dt.day);

      int totalNews = ArraySize(g_newsDates2026);
      for(int i = 0; i < totalNews; i++)
      {
         if(currentDayStr == g_newsDates2026[i])
         {
            reason = StringFormat("FILTRO NOTICIAS: Día de Alto Impacto (%s)", currentDayStr);
            return true;
         }
      }

      if(StringLen(InpCustomNewsDates) > 0)
      {
         if(StringFind(InpCustomNewsDates, currentDayStr) >= 0)
         {
            reason = StringFormat("FILTRO NOTICIAS: Fecha en Lista Negra (%s)", currentDayStr);
            return true;
         }
      }
   }

   if(!InpEnableCircuitBreaker)
      return false;

   // 2. Comprobar si la última vela H1 cerrada tuvo un rango anómalo
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

   // 3. Comprobar si el rango acumulado de hoy en D1 ya superó el límite
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

   // 4. Bloqueo en Cierre de Mes
   if(InpBlockMonthEndDay)
   {
      datetime now = TimeCurrent();
      MqlDateTime dt;
      TimeToStruct(now, dt);

      int spainHour = dt.hour - InpServerOffsetFromSpain;
      if(spainHour < 0) spainHour += 24;

      int daysInMonth = 31;
      if(dt.mon == 2)
         daysInMonth = ((dt.year % 4 == 0 && dt.year % 100 != 0) || (dt.year % 400 == 0)) ? 29 : 28;
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
//| Evalúa señal para abrir el primer trade de un nuevo ciclo        |
//+------------------------------------------------------------------+
bool CheckNewEntrySignal(ENUM_POSITION_TYPE &direction)
{
   if(InpEntryMode == ENTRY_RANGE_BREAKOUT)
   {
      MqlRates rates[];
      ArraySetAsSeries(rates, true);
      if(CopyRates(_Symbol, PERIOD_M1, 1, InpRangeLookbackM1, rates) < InpRangeLookbackM1)
         return false;

      double highestHigh = rates[0].high;
      double lowestLow   = rates[0].low;
      for(int i = 1; i < InpRangeLookbackM1; i++)
      {
         if(rates[i].high > highestHigh) highestHigh = rates[i].high;
         if(rates[i].low < lowestLow)   lowestLow   = rates[i].low;
      }

      double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

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
      if(CopyBuffer(m_htfEmaHandle, 0, 1, 1, emaValues) <= 0) return false;

      MqlRates htfRates[];
      ArraySetAsSeries(htfRates, true);
      if(CopyRates(_Symbol, InpHTFTimeframe, 1, 1, htfRates) <= 0) return false;

      bool htfBullish = (htfRates[0].close > emaValues[0]);
      bool htfBearish = (htfRates[0].close < emaValues[0]);

      MqlRates m1Rates[];
      ArraySetAsSeries(m1Rates, true);
      if(CopyRates(_Symbol, PERIOD_M1, 1, 1, m1Rates) <= 0) return false;

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
//| Cierra toda la cesta de órdenes a mercado                        |
//+------------------------------------------------------------------+
void CloseEntireBasket()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(m_pos.SelectByIndex(i))
      {
         if(m_pos.Symbol() == _Symbol && m_pos.Magic() == InpMagicNumber)
         {
            m_trade.PositionClose(m_pos.Ticket());
         }
      }
   }
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
//| Creación y actualización del Panel Visual (HUD)                  |
//+------------------------------------------------------------------+
void UpdateDashboard(string statusText)
{
   string fontName = "Segoe UI";
   int x = 20;
   int y = 30;
   int width = 360;
   int height = 240;

   CreateRectLabel("HUD_BG", x, y, width, height, InpDashboardColor, 1);
   CreateLabel("HUD_TITLE", x + 15, y + 15, "🚀 XAUUSD POSITIVE GRID 1762", fontName, 11, clrWhite);
   CreateLabel("HUD_SUBTITLE", x + 15, y + 35, "Piramidación a Favor con Trailing de Riesgo Cero", fontName, 8, clrLightGray);

   SPosInfo list[];
   int count = GetOpenPositions(list);
   double totalFloating = 0.0;
   double totalVolume = 0.0;
   for(int i = 0; i < count; i++)
   {
      if(m_pos.SelectByTicket(list[i].ticket))
         totalFloating += m_pos.Profit() + m_pos.Swap();
      totalVolume += list[i].volume;
   }

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   double currentLot = CalculateLotSize();

   CreateLabel("HUD_BAL", x + 15, y + 65, StringFormat("Balance: %.2f €  |  Lote Actual: %.2f", balance, currentLot), fontName, 9, clrWhite);
   CreateLabel("HUD_EQUITY", x + 15, y + 85, StringFormat("Equity: %.2f €   |  Flotante: $%.2f", equity, totalFloating), fontName, 9, (totalFloating >= 0 ? clrLime : clrTomato));

   CreateLabel("HUD_ORDERS", x + 15, y + 115, StringFormat("Pirámide: %d / %d órdenes | Lotes: %.2f", count, InpMaxPyramidOrders, totalVolume), fontName, 9, clrKhaki);
   CreateLabel("HUD_STEP", x + 15, y + 135, StringFormat("Paso a Favor: %.2f$  |  Lock BE: +%.2f$", InpPyramidStep_USD, InpLockSpread_USD), fontName, 9, clrSilver);

   CreateLabel("HUD_HIST", x + 15, y + 165, StringFormat("Pirámides Completadas: %d  |  Profit: +$%.2f", m_closedCyclesCount, m_closedCyclesProfit), fontName, 9, clrAqua);

   color stColor = clrLightGreen;
   if(StringFind(statusText, "CORTACIRCUITOS") >= 0 || StringFind(statusText, "FILTRO NOTICIAS") >= 0) stColor = clrOrangeRed;
   else if(StringFind(statusText, "CONGELADO") >= 0) stColor = clrGold;

   CreateLabel("HUD_STATUS", x + 15, y + 195, (statusText == "" ? "ESTADO: Piramidando en vivo" : statusText), fontName, 8, stColor);
}

void CreateRectLabel(string name, int x, int y, int w, int h, color bg, int corner=0)
{
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, corner);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
      ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
      ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
      ObjectSetInteger(0, name, OBJPROP_BGCOLOR, bg);
      ObjectSetInteger(0, name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, name, OBJPROP_COLOR, clrDarkSlateGray);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   }
}

void CreateLabel(string name, int x, int y, string text, string font, int size, color col, int corner=0)
{
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, corner);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   }
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetString(0, name, OBJPROP_FONT, font);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, size);
   ObjectSetInteger(0, name, OBJPROP_COLOR, col);
}
//+------------------------------------------------------------------+
