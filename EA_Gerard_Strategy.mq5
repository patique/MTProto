//+------------------------------------------------------------------+
//|                                           EA_Gerard_Strategy.mq5 |
//|                      Estrategia Institucional "Gerard Strategy"  |
//|               Inducement Sweep + Virgin Origin FVG/BPR Retest    |
//|                   Gestión Cuantitativa por Flotante en Dólares    |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab & Gerard"
#property link      "https://github.com/telegram-mtproto"
#property version   "1.00"
#property strict
#property description "EA Institucional Gerard Strategy para XAUUSD / Forex"
#property description "Liquidación de Inducement + Mitigación de FVG/BPR Virgen de Origen + Cierre por Flotante $"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- ENUMERACIONES ---
enum ENUM_ZONE_TYPE
{
   ZONE_BPR_AND_FVG, // Ambos (Prioridad BPR, fallback FVG)
   ZONE_BPR_ONLY,    // Exclusivamente BPR Virgen (Solape FVG)
   ZONE_FVG_ONLY     // Exclusivamente FVG Virgen
};

enum ENUM_ALLOWED_BIAS
{
   BIAS_BOTH, // Compras y Ventas
   BIAS_BUY,  // Solo Compras
   BIAS_SELL  // Solo Ventas
};

//--- PARÁMETROS DE ENTRADA ---
input group "=== 1. ESTRUCTURA INSTITUCIONAL (GERARD SETUP) ===";
input ENUM_TIMEFRAMES    InpStructureTF           = PERIOD_M5;          // Temporalidad de la Estructura (M5 recomendado)
input int                InpPivotLookback         = 4;                  // Lookback para Swing High/Low (Barras a cada lado)
input int                InpMinImpulses           = 2;                  // Mínimo de Impulsos Estructurales Previos (2 o 3)
input ENUM_ZONE_TYPE     InpZoneType              = ZONE_BPR_AND_FVG;   // Tipo de Zona de Liquidez en el Origen
input double             InpMinFvgSizeUSD         = 0.50;               // Tamaño Mínimo de FVG en $ (0.50$ = 5 pips Oro)
input double             InpMitigationBufferUSD   = 0.25;               // Tolerancia al tocar la zona virgen ($)
input ENUM_ALLOWED_BIAS  InpAllowedBias           = BIAS_BOTH;          // Dirección Operativa Permitida

input group "=== 2. GESTIÓN DE LOTAJE & 2ª ENTRADA (SWEEP) ===";
input double             InpBaseLot               = 0.01;               // Lotaje Entrada 1 (Al tocar FVG/BPR virgen)
input bool               InpEnableSweepReentry    = true;               // Activar 2ª Entrada si el precio barre el Alto/Bajo Original
input double             InpSweepLotMultiplier    = 1.5;                // Multiplicador de Lotaje para la 2ª Entrada (1.5x)
input double             InpSweepMinDistUSD       = 0.50;               // Distancia mínima tras romper el Alto/Bajo para entrar ($)

input group "=== 3. SALIDAS Y FLOTANTE POR OPERACIÓN ===";
input double             InpTargetProfitUSD       = 4.0;                // Ganancia Flotante Objetivo en $ por Operación/Cesta (TP)
input double             InpTradeMaxLossUSD       = 15.0;               // Pérdida Flotante Máxima en $ por Operación (SL Flotante)

input group "=== 4. CORTACIRCUITOS DIARIO (CONGELACIÓN HASTA MAÑANA) ===";
input double             InpDailyTargetUSD        = 100.0;              // Meta Diaria de Ganancia Máxima en $ (+100$)
input double             InpDailyMaxLossUSD       = 30.0;               // Límite Diario de Pérdida Máxima en $ (-30$)

input group "=== 5. ZONAS HORARIAS DE ALTA LIQUIDEZ (ESPAÑA) ===";
input bool               InpUseSafeHoursOnly      = true;               // Operar únicamente en Horas de Liquidez
input int                InpServerOffsetFromSpain = 1;                  // Diferencia Servidor vs España (+1h en FTMO)
input int                InpMorningStartHourES    = 9;                  // Apertura Londres España (09:00)
input int                InpEveningEndHourES      = 21;                 // Cierre New York España (21:30)
input int                InpEveningEndMinES       = 30;                 // Minuto Cierre New York

input group "=== 6. IDENTIFICACIÓN Y PANEL ===";
input ulong              InpMagicNumber           = 777176;             // Magic Number Gerard Strategy
input string             InpTradeComment          = "Gerard_Strategy";  // Comentario de Trade
input bool               InpShowDashboard         = true;               // Mostrar Panel Visual en Gráfico
input bool               InpDrawChartZones        = true;               // Dibujar Zonas y Líneas de Inducement en Gráfico
input color              InpDashboardColor        = C'12,20,32';        // Color de Fondo del Panel

//--- ESTRUCTURAS DE DATOS ---
struct SwingPoint
{
   bool     isHigh;
   double   price;
   datetime time;
   int      barIndex;
};

struct VirginZone
{
   bool     active;
   bool     isBullish;  // true = zona en Low (para BUY), false = zona en High (para SELL)
   double   top;
   double   bottom;
   double   originPrice;// El H0 o L0 exacto
   datetime creationTime;
   bool     isBpr;
   string   objName;
};

//--- GLOBALES ---
CTrade            m_trade;
CPositionInfo     m_pos;
datetime          m_lastDayCheck        = 0;
bool              m_dailyHalted         = false;
string            m_dailyHaltReason     = "";
datetime          m_lastEvaluatedBar    = 0;

// Estado de la estrategia
VirginZone        m_activeSellZone;     // Zona virgen en H0 esperando ser mitigada
VirginZone        m_activeBuyZone;      // Zona virgen en L0 esperando ser mitigada
double            m_lastLH_Price        = 0.0;// Último Lower High (Inducement a liquidar)
double            m_lastHL_Price        = 0.0;// Último Higher Low (Inducement a liquidar)
datetime          m_lastLH_Time         = 0;
datetime          m_lastHL_Time         = 0;
bool              m_sweepOrderTaken     = false;// Control de la 2ª entrada por barrida de H0/L0

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   m_trade.SetExpertMagicNumber(InpMagicNumber);
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(_Symbol);

   m_lastDayCheck     = TimeCurrent();
   m_dailyHalted      = false;
   m_dailyHaltReason  = "";
   m_lastEvaluatedBar = 0;
   m_sweepOrderTaken  = false;

   ZeroMemory(m_activeSellZone);
   ZeroMemory(m_activeBuyZone);

   double realizedToday = GetDailyRealizedProfit(m_lastDayCheck);
   if(InpDailyTargetUSD > 0.0 && realizedToday >= InpDailyTargetUSD)
   {
      m_dailyHalted = true;
      m_dailyHaltReason = StringFormat("CONGELADO: META DIARIA +$%.2f ALCANZADA", InpDailyTargetUSD);
   }
   else if(InpDailyMaxLossUSD > 0.0 && realizedToday <= -InpDailyMaxLossUSD)
   {
      m_dailyHalted = true;
      m_dailyHaltReason = StringFormat("CONGELADO: LÍMITE PÉRDIDA -$%.2f ALCANZADO", InpDailyMaxLossUSD);
   }

   PrintFormat("🚀 [EA_Gerard_Strategy] Inicializado con éxito | TF: %s | Target: +$%.2f | MaxLoss: -$%.2f | Meta Diaria: +$%.2f | Límite: -$%.2f",
               EnumToString(InpStructureTF), InpTargetProfitUSD, InpTradeMaxLossUSD, InpDailyTargetUSD, InpDailyMaxLossUSD);

   if(InpShowDashboard)
      CreateDashboard();

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(InpShowDashboard)
      DestroyDashboard();

   if(InpDrawChartZones)
   {
      ObjectsDeleteAll(0, "GERARD_");
   }
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime now = TimeCurrent();

   // 1. Control de medianoche (reseteo diario)
   MqlDateTime dt_now, dt_last;
   TimeToStruct(now, dt_now);
   TimeToStruct(m_lastDayCheck, dt_last);
   if(dt_now.day != dt_last.day)
   {
      m_lastDayCheck    = now;
      m_dailyHalted     = false;
      m_dailyHaltReason = "";
      PrintFormat("🌅 [NUEVO DÍA %04d.%02d.%02d] Gerard Strategy desbloqueada para la nueva sesión.",
                  dt_now.year, dt_now.mon, dt_now.day);
   }

   // 2. Si la operativa del día ya está congelada
   if(m_dailyHalted)
   {
      if(CountOpenOrders() > 0)
         CloseAllOrders();
      UpdateDashboard(m_dailyHaltReason);
      return;
   }

   // 3. Inspeccionar PnL ya cerrado hoy
   double realizedToday = GetDailyRealizedProfit(now);

   if(InpDailyTargetUSD > 0.0 && realizedToday >= InpDailyTargetUSD)
   {
      m_dailyHalted = true;
      m_dailyHaltReason = StringFormat("CONGELADO: META DIARIA +$%.2f ALCANZADA", InpDailyTargetUSD);
      if(CountOpenOrders() > 0) CloseAllOrders();
      UpdateDashboard(m_dailyHaltReason);
      return;
   }

   if(InpDailyMaxLossUSD > 0.0 && realizedToday <= -InpDailyMaxLossUSD)
   {
      m_dailyHalted = true;
      m_dailyHaltReason = StringFormat("CONGELADO: LÍMITE PÉRDIDA -$%.2f ALCANZADO", InpDailyMaxLossUSD);
      if(CountOpenOrders() > 0) CloseAllOrders();
      UpdateDashboard(m_dailyHaltReason);
      return;
   }

   // 4. Obtener estado de las posiciones abiertas de este EA
   int openCount = 0;
   long cycleType = -1;
   double totalLots = 0.0;
   double floatingProfit = 0.0;
   double weightedEntry = 0.0;
   GetOrdersState(openCount, cycleType, totalLots, weightedEntry, floatingProfit);

   // 5. GESTIÓN CUANTITATIVA DE SALIDAS EN FLOTANTE $ (CUANDO HAY OPERACIONES ACTIVAS)
   if(openCount > 0)
   {
      double totalDailyPnL = realizedToday + floatingProfit;

      // 5.1 Cortacircuitos Global Diario (+$100 o -$30 en Flotante)
      if(InpDailyTargetUSD > 0.0 && totalDailyPnL >= InpDailyTargetUSD)
      {
         PrintFormat("🎯 [META DIARIA TOTAL ALCANZADA] Flotante: $%.2f | PnL Hoy: $%.2f -> Cerrando y Congelando.", floatingProfit, totalDailyPnL);
         CloseAllOrders();
         m_dailyHalted = true;
         m_dailyHaltReason = StringFormat("CONGELADO: META DIARIA +$%.2f ALCANZADA", InpDailyTargetUSD);
         m_sweepOrderTaken = false;
         UpdateDashboard(m_dailyHaltReason);
         return;
      }

      if(InpDailyMaxLossUSD > 0.0 && totalDailyPnL <= -InpDailyMaxLossUSD)
      {
         PrintFormat("🛑 [LÍMITE PÉRDIDA DIARIA TOTAL] Flotante: $%.2f | PnL Hoy: $%.2f -> Cerrando y Congelando.", floatingProfit, totalDailyPnL);
         CloseAllOrders();
         m_dailyHalted = true;
         m_dailyHaltReason = StringFormat("CONGELADO: LÍMITE PÉRDIDA -$%.2f ALCANZADO", InpDailyMaxLossUSD);
         m_sweepOrderTaken = false;
         UpdateDashboard(m_dailyHaltReason);
         return;
      }

      // 5.2 Salida por Target de la Operación en $ (TP Flotante)
      if(floatingProfit >= InpTargetProfitUSD)
      {
         PrintFormat("💰 [TARGET ALCANZADO] Flotante $%.2f >= Meta $%.2f -> Cerrando ciclo con éxito.", floatingProfit, InpTargetProfitUSD);
         CloseAllOrders();
         m_sweepOrderTaken = false;
         UpdateDashboard(StringFormat("Ciclo ganado: +$%.2f", floatingProfit));
         return;
      }

      // 5.3 Salida por Pérdida Máxima de la Operación en $ (SL Flotante)
      if(InpTradeMaxLossUSD > 0.0 && floatingProfit <= -InpTradeMaxLossUSD)
      {
         PrintFormat("🛑 [MAX LOSS POR TRADE] Flotante $%.2f <= -$%.2f -> Cortando operación por gestión de riesgo.", floatingProfit, InpTradeMaxLossUSD);
         CloseAllOrders();
         m_sweepOrderTaken = false;
         UpdateDashboard(StringFormat("Operación cortada por SL Flotante: $%.2f", floatingProfit));
         return;
      }

      // 5.4 Evaluación de 2ª ENTRADA POR BARRIDA (SWEEP RE-ENTRY)
      if(InpEnableSweepReentry && !m_sweepOrderTaken && openCount == 1)
      {
         double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

         // En SELL: El precio rompe y dilata por encima del Alto Inicial H0
         if(cycleType == POSITION_TYPE_SELL && m_activeSellZone.active && m_activeSellZone.originPrice > 0)
         {
            if(currentAsk >= (m_activeSellZone.originPrice + InpSweepMinDistUSD))
            {
               double lot2 = NormalizeLot(InpBaseLot * InpSweepLotMultiplier);
               PrintFormat("⚡ [GERARD 2ª ENTRADA SELL] Precio barrió el Alto Original H0 (%.2f -> %.2f) | Añadiendo SELL %.2f lotes a mejor precio",
                           m_activeSellZone.originPrice, currentAsk, lot2);
               if(m_trade.Sell(lot2, _Symbol, currentAsk, 0, 0, InpTradeComment + "_Sweep_H0"))
               {
                  m_sweepOrderTaken = true;
               }
            }
         }
         // En BUY: El precio rompe y dilata por debajo del Bajo Inicial L0
         else if(cycleType == POSITION_TYPE_BUY && m_activeBuyZone.active && m_activeBuyZone.originPrice > 0)
         {
            if(currentBid <= (m_activeBuyZone.originPrice - InpSweepMinDistUSD))
            {
               double lot2 = NormalizeLot(InpBaseLot * InpSweepLotMultiplier);
               PrintFormat("⚡ [GERARD 2ª ENTRADA BUY] Precio barrió el Bajo Original L0 (%.2f -> %.2f) | Añadiendo BUY %.2f lotes a mejor precio",
                           m_activeBuyZone.originPrice, currentBid, lot2);
               if(m_trade.Buy(lot2, _Symbol, currentBid, 0, 0, InpTradeComment + "_Sweep_L0"))
               {
                  m_sweepOrderTaken = true;
               }
            }
         }
      }

      UpdateDashboard("");
      return;
   }

   // 6. NO HAY OPERACIONES ABIERTAS: EVALUAR ESTRUCTURA INSTITUCIONAL DE GERARD
   m_sweepOrderTaken = false;

   // 6.1 Filtro Horario de Liquidez
   if(InpUseSafeHoursOnly && !IsWithinOperatingHours())
   {
      UpdateDashboard("FUERA DE HORARIO DE LIQUIDEZ");
      return;
   }

   // 6.2 Escanear estructura en nueva barra o cambio
   datetime currentBar = iTime(_Symbol, InpStructureTF, 0);
   if(currentBar != m_lastEvaluatedBar)
   {
      ScanGerardStructure();
      m_lastEvaluatedBar = currentBar;
   }

   // 6.3 Evaluación de Gatillo en Vivo (Tick a Tick):
   // ¿Está el precio liquidando el Inducement y tocando la Zona Virgen de Origen?
   CheckAndTriggerEntry();

   UpdateDashboard("");
}

//+------------------------------------------------------------------+
//| Escaneo Estructural: Detección de H0/L0, Impulsos e Inducement   |
//+------------------------------------------------------------------+
void ScanGerardStructure()
{
   int totalBars = 200;
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, InpStructureTF, 0, totalBars, rates) < totalBars)
      return;

   // 1. Identificar Swing Points confirmados
   SwingPoint pivots[];
   ArrayResize(pivots, 0);

   for(int i = InpPivotLookback + 1; i < totalBars - InpPivotLookback - 1; i++)
   {
      bool isHigh = true;
      bool isLow  = true;

      for(int k = 1; k <= InpPivotLookback; k++)
      {
         if(rates[i].high <= rates[i - k].high || rates[i].high <= rates[i + k].high)
            isHigh = false;
         if(rates[i].low >= rates[i - k].low || rates[i].low >= rates[i + k].low)
            isLow = false;
      }

      if(isHigh)
      {
         int s = ArraySize(pivots);
         ArrayResize(pivots, s + 1);
         pivots[s].isHigh    = true;
         pivots[s].price     = rates[i].high;
         pivots[s].time      = rates[i].time;
         pivots[s].barIndex  = i;
      }
      else if(isLow)
      {
         int s = ArraySize(pivots);
         ArrayResize(pivots, s + 1);
         pivots[s].isHigh    = false;
         pivots[s].price     = rates[i].low;
         pivots[s].time      = rates[i].time;
         pivots[s].barIndex  = i;
      }
   }

   int pivotCount = ArraySize(pivots);
   if(pivotCount < 5) return;

   // 2. BUSCAR SECUENCIA BAJISTA PARA SELL:
   // Estructura: H0 (Alto Inicial con Zona Virgen) -> L1 -> LH1 (Inducement) -> LL1 -> LL2
   if(InpAllowedBias == BIAS_BOTH || InpAllowedBias == BIAS_SELL)
   {
      for(int i = 0; i < pivotCount - 4; i++)
      {
         if(!pivots[i].isHigh)
         {
            double llPrice = pivots[i].price;
            datetime llTime = pivots[i].time;

            for(int j = i + 1; j < pivotCount - 2; j++)
            {
               if(pivots[j].isHigh)
               {
                  double lhPrice = pivots[j].price;
                  datetime lhTime = pivots[j].time;

                  for(int k = j + 1; k < pivotCount; k++)
                  {
                     if(pivots[k].isHigh && pivots[k].price > lhPrice)
                     {
                        int h0Index = pivots[k].barIndex;

                        VirginZone zone;
                        if(FindVirginZoneAtOrigin(rates, totalBars, h0Index, false, zone))
                        {
                           m_activeSellZone   = zone;
                           m_lastLH_Price     = lhPrice;
                           m_lastLH_Time      = lhTime;

                           if(InpDrawChartZones)
                              DrawVisualSetup("SELL", m_activeSellZone, m_lastLH_Price, m_lastLH_Time);

                           break;
                        }
                     }
                  }
                  break;
               }
            }
            break;
         }
      }
   }

   // 3. BUSCAR SECUENCIA ALCISTA PARA BUY:
   // Estructura: L0 (Bajo Inicial con Zona Virgen) -> H1 -> HL1 (Inducement) -> HH1 -> HH2
   if(InpAllowedBias == BIAS_BOTH || InpAllowedBias == BIAS_BUY)
   {
      for(int i = 0; i < pivotCount - 4; i++)
      {
         if(pivots[i].isHigh)
         {
            double hhPrice = pivots[i].price;

            for(int j = i + 1; j < pivotCount - 2; j++)
            {
               if(!pivots[j].isHigh)
               {
                  double hlPrice = pivots[j].price;
                  datetime hlTime = pivots[j].time;

                  for(int k = j + 1; k < pivotCount; k++)
                  {
                     if(!pivots[k].isHigh && pivots[k].price < hlPrice)
                     {
                        int l0Index = pivots[k].barIndex;

                        VirginZone zone;
                        if(FindVirginZoneAtOrigin(rates, totalBars, l0Index, true, zone))
                        {
                           m_activeBuyZone    = zone;
                           m_lastHL_Price     = hlPrice;
                           m_lastHL_Time      = hlTime;

                           if(InpDrawChartZones)
                              DrawVisualSetup("BUY", m_activeBuyZone, m_lastHL_Price, m_lastHL_Time);

                           break;
                        }
                     }
                  }
                  break;
               }
            }
            break;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Busca un FVG o BPR Virgen en el Origen del Movimiento            |
//+------------------------------------------------------------------+
bool FindVirginZoneAtOrigin(const MqlRates &rates[], int totalBars, int originBarIndex, bool isBullish, VirginZone &zone)
{
   ZeroMemory(zone);

   int startScan = MathMax(2, originBarIndex - 3);
   int endScan   = MathMin(totalBars - 3, originBarIndex + 5);

   for(int b = startScan; b <= endScan; b++)
   {
      if(!isBullish)
      {
         // Bearish FVG: High de vela b < Low de vela b+2
         if(rates[b].high < rates[b + 2].low)
         {
            double top    = rates[b + 2].low;
            double bottom = rates[b].high;
            double gap    = top - bottom;

            if(gap >= InpMinFvgSizeUSD)
            {
               bool isVirgin = true;
               for(int check = b - 1; check >= 1; check--)
               {
                  if(rates[check].high >= top)
                  {
                     isVirgin = false;
                     break;
                  }
               }

               if(isVirgin)
               {
                  zone.active       = true;
                  zone.isBullish    = false;
                  zone.top          = top;
                  zone.bottom       = bottom;
                  zone.originPrice  = rates[originBarIndex].high;
                  zone.creationTime = rates[b].time;
                  zone.isBpr        = false;

                  for(int prev = b + 1; prev <= b + 8 && prev < totalBars - 2; prev++)
                  {
                     if(rates[prev].low > rates[prev + 2].high)
                     {
                        double bullTop = rates[prev].low;
                        double bullBot = rates[prev + 2].high;
                        if(bullTop > bottom && bullBot < top)
                        {
                           zone.top    = MathMin(top, bullTop);
                           zone.bottom = MathMax(bottom, bullBot);
                           zone.isBpr  = true;
                           break;
                        }
                     }
                  }

                  if(InpZoneType == ZONE_BPR_ONLY && !zone.isBpr)
                     continue;

                  return true;
               }
            }
         }
      }
      else
      {
         // Bullish FVG: Low de vela b > High de vela b+2
         if(rates[b].low > rates[b + 2].high)
         {
            double top    = rates[b].low;
            double bottom = rates[b + 2].high;
            double gap    = top - bottom;

            if(gap >= InpMinFvgSizeUSD)
            {
               bool isVirgin = true;
               for(int check = b - 1; check >= 1; check--)
               {
                  if(rates[check].low <= bottom)
                  {
                     isVirgin = false;
                     break;
                  }
               }

               if(isVirgin)
               {
                  zone.active       = true;
                  zone.isBullish    = true;
                  zone.top          = top;
                  zone.bottom       = bottom;
                  zone.originPrice  = rates[originBarIndex].low;
                  zone.creationTime = rates[b].time;
                  zone.isBpr        = false;

                  for(int prev = b + 1; prev <= b + 8 && prev < totalBars - 2; prev++)
                  {
                     if(rates[prev].high < rates[prev + 2].low)
                     {
                        double bearTop = rates[prev + 2].low;
                        double bearBot = rates[prev].high;
                        if(bearTop > bottom && bearBot < top)
                        {
                           zone.top    = MathMin(top, bearTop);
                           zone.bottom = MathMax(bottom, bearBot);
                           zone.isBpr  = true;
                           break;
                        }
                     }
                  }

                  if(InpZoneType == ZONE_BPR_ONLY && !zone.isBpr)
                     continue;

                  return true;
               }
            }
         }
      }
   }

   return false;
}

//+------------------------------------------------------------------+
//| Evalúa el Gatillo: Liquidación de Inducement + Mitigación Virgen |
//+------------------------------------------------------------------+
void CheckAndTriggerEntry()
{
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   // A) EVALUAR ENTRADA SELL (SECUENCIA BAJISTA)
   if((InpAllowedBias == BIAS_BOTH || InpAllowedBias == BIAS_SELL) && m_activeSellZone.active)
   {
      bool inducementLiquidated = (m_lastLH_Price > 0 && currentBid >= m_lastLH_Price);
      bool inVirginZone = (currentAsk >= (m_activeSellZone.bottom - InpMitigationBufferUSD) &&
                           currentBid <= (m_activeSellZone.top + InpMitigationBufferUSD));

      if(inducementLiquidated && inVirginZone)
      {
         PrintFormat("🎯 [GERARD SETUP SELL DISPARADO] Inducement LH1 (%.2f) liquidado | Precio tocando %s Virgen en H0 (%.2f - %.2f) | Bid: %.2f",
                     m_lastLH_Price, (m_activeSellZone.isBpr ? "BPR" : "FVG"), m_activeSellZone.bottom, m_activeSellZone.top, currentBid);

         if(m_trade.Sell(InpBaseLot, _Symbol, currentBid, 0, 0, InpTradeComment + "_Entry1_SELL"))
         {
            m_activeSellZone.active = false; // Zona mitigada
            m_sweepOrderTaken       = false;
         }
         return;
      }
   }

   // B) EVALUAR ENTRADA BUY (SECUENCIA ALCISTA)
   if((InpAllowedBias == BIAS_BOTH || InpAllowedBias == BIAS_BUY) && m_activeBuyZone.active)
   {
      bool inducementLiquidated = (m_lastHL_Price > 0 && currentAsk <= m_lastHL_Price);
      bool inVirginZone = (currentBid <= (m_activeBuyZone.top + InpMitigationBufferUSD) &&
                           currentAsk >= (m_activeBuyZone.bottom - InpMitigationBufferUSD));

      if(inducementLiquidated && inVirginZone)
      {
         PrintFormat("🎯 [GERARD SETUP BUY DISPARADO] Inducement HL1 (%.2f) liquidado | Precio tocando %s Virgen en L0 (%.2f - %.2f) | Ask: %.2f",
                     m_lastHL_Price, (m_activeBuyZone.isBpr ? "BPR" : "FVG"), m_activeBuyZone.bottom, m_activeBuyZone.top, currentAsk);

         if(m_trade.Buy(InpBaseLot, _Symbol, currentAsk, 0, 0, InpTradeComment + "_Entry1_BUY"))
         {
            m_activeBuyZone.active  = false; // Zona mitigada
            m_sweepOrderTaken       = false;
         }
         return;
      }
   }
}

//+------------------------------------------------------------------+
//| Dibuja los Rectángulos y Líneas de Inducement en Gráfico         |
//+------------------------------------------------------------------+
void DrawVisualSetup(string bias, const VirginZone &zone, double inducementPrice, datetime inducementTime)
{
   string prefix = "GERARD_";
   datetime now = TimeCurrent();

   if(bias == "SELL")
   {
      string boxName = prefix + "ZONE_SELL";
      ObjectDelete(0, boxName);
      ObjectCreate(0, boxName, OBJ_RECTANGLE, 0, zone.creationTime, zone.top, now + 7200, zone.bottom);
      ObjectSetInteger(0, boxName, OBJPROP_COLOR, (zone.isBpr ? clrMagenta : clrTomato));
      ObjectSetInteger(0, boxName, OBJPROP_STYLE, STYLE_SOLID);
      ObjectSetInteger(0, boxName, OBJPROP_FILL, true);
      ObjectSetInteger(0, boxName, OBJPROP_BACK, true);

      string lineName = prefix + "INDUCEMENT_LH";
      ObjectDelete(0, lineName);
      ObjectCreate(0, lineName, OBJ_TREND, 0, inducementTime, inducementPrice, now + 7200, inducementPrice);
      ObjectSetInteger(0, lineName, OBJPROP_COLOR, clrOrange);
      ObjectSetInteger(0, lineName, OBJPROP_STYLE, STYLE_DASHDOT);
      ObjectSetInteger(0, lineName, OBJPROP_WIDTH, 1);
   }
   else
   {
      string boxName = prefix + "ZONE_BUY";
      ObjectDelete(0, boxName);
      ObjectCreate(0, boxName, OBJ_RECTANGLE, 0, zone.creationTime, zone.top, now + 7200, zone.bottom);
      ObjectSetInteger(0, boxName, OBJPROP_COLOR, (zone.isBpr ? clrAqua : clrMediumSeaGreen));
      ObjectSetInteger(0, boxName, OBJPROP_STYLE, STYLE_SOLID);
      ObjectSetInteger(0, boxName, OBJPROP_FILL, true);
      ObjectSetInteger(0, boxName, OBJPROP_BACK, true);

      string lineName = prefix + "INDUCEMENT_HL";
      ObjectDelete(0, lineName);
      ObjectCreate(0, lineName, OBJ_TREND, 0, inducementTime, inducementPrice, now + 7200, inducementPrice);
      ObjectSetInteger(0, lineName, OBJPROP_COLOR, clrGold);
      ObjectSetInteger(0, lineName, OBJPROP_STYLE, STYLE_DASHDOT);
      ObjectSetInteger(0, lineName, OBJPROP_WIDTH, 1);
   }
}

//+------------------------------------------------------------------+
//| Filtro Horario de Sesión Activa (Londres & New York)             |
//+------------------------------------------------------------------+
bool IsWithinOperatingHours()
{
   datetime now = TimeCurrent();
   MqlDateTime dt;
   TimeToStruct(now, dt);

   if(dt.day_of_week == 6 || dt.day_of_week == 0)
      return false;

   int spainHour = dt.hour - InpServerOffsetFromSpain;
   if(spainHour < 0)  spainHour += 24;
   if(spainHour >= 24) spainHour -= 24;

   int spainMinutes = (spainHour * 60) + dt.min;
   int startMinutes = (InpMorningStartHourES * 60);
   int endMinutes   = (InpEveningEndHourES * 60) + InpEveningEndMinES;

   return (spainMinutes >= startMinutes && spainMinutes <= endMinutes);
}

//+------------------------------------------------------------------+
//| Calcula el PnL cerrado hoy (Profit + Swap + Comm + Fee)          |
//+------------------------------------------------------------------+
double GetDailyRealizedProfit(datetime currentTime)
{
   MqlDateTime dt;
   TimeToStruct(currentTime, dt);
   dt.hour = 0;
   dt.min  = 0;
   dt.sec  = 0;
   datetime startOfDay = StructToTime(dt);

   if(!HistorySelect(startOfDay, currentTime))
      return 0.0;

   double profit = 0.0;
   int totalDeals = HistoryDealsTotal();

   for(int i = 0; i < totalDeals; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket > 0)
      {
         if(HistoryDealGetInteger(ticket, DEAL_MAGIC) == InpMagicNumber)
         {
            long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
            if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_INOUT || entry == DEAL_ENTRY_OUT_BY)
            {
               profit += HistoryDealGetDouble(ticket, DEAL_PROFIT)
                       + HistoryDealGetDouble(ticket, DEAL_SWAP)
                       + HistoryDealGetDouble(ticket, DEAL_COMMISSION)
                       + HistoryDealGetDouble(ticket, DEAL_FEE);
            }
         }
      }
   }
   return NormalizeDouble(profit, 2);
}

//+------------------------------------------------------------------+
//| Obtiene las métricas de órdenes abiertas                         |
//+------------------------------------------------------------------+
void GetOrdersState(int &count, long &posType, double &totalLots, double &weightedPrice, double &floatingProfit)
{
   count = 0;
   posType = -1;
   totalLots = 0.0;
   weightedPrice = 0.0;
   floatingProfit = 0.0;
   double priceLotSum = 0.0;

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
         }
      }
   }

   if(totalLots > 0.0)
      weightedPrice = priceLotSum / totalLots;
}

//+------------------------------------------------------------------+
//| Conteo de órdenes abiertas                                       |
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
//| Cierra todas las posiciones a mercado                            |
//+------------------------------------------------------------------+
void CloseAllOrders()
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
//| Normaliza el volumen según paso y límites del broker             |
//+------------------------------------------------------------------+
double NormalizeLot(double lot)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   lot = MathFloor(lot / lotStep) * lotStep;
   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;
   return NormalizeDouble(lot, 2);
}

//+------------------------------------------------------------------+
//| Creación del Panel Visual (HUD)                                  |
//+------------------------------------------------------------------+
void CreateDashboard()
{
   string prefix = "GERARD_HUD_";
   int x = 20;
   int y = 30;
   int width = 340;
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
   ObjectSetInteger(0, prefix + "TITLE", OBJPROP_COLOR, clrCyan);
   ObjectSetString(0, prefix + "TITLE", OBJPROP_TEXT, "🎯 GERARD STRATEGY (INSTITUTIONAL)");
   ObjectSetString(0, prefix + "TITLE", OBJPROP_FONT, "Segoe UI Semibold");
   ObjectSetInteger(0, prefix + "TITLE", OBJPROP_FONTSIZE, 11);

   ObjectCreate(0, prefix + "SUB", OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_XDISTANCE, x + 12);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_YDISTANCE, y + 32);
   ObjectSetInteger(0, prefix + "SUB", OBJPROP_COLOR, clrSilver);
   ObjectSetString(0, prefix + "SUB", OBJPROP_TEXT, "Inducement Liquidity + Virgin Origin BPR/FVG");
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
   string prefix = "GERARD_HUD_";
   int openCount = 0;
   long cycleType = -1;
   double totalLots = 0.0;
   double weightedEntry = 0.0;
   double floatingProfit = 0.0;

   GetOrdersState(openCount, cycleType, totalLots, weightedEntry, floatingProfit);

   datetime serverTime = TimeCurrent();
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double spreadUSD = currentAsk - currentBid;

   MqlDateTime dt;
   TimeToStruct(serverTime, dt);
   int spainHour = dt.hour - InpServerOffsetFromSpain;
   if(spainHour < 0) spainHour += 24;

   double realizedToday = GetDailyRealizedProfit(serverTime);
   double totalDailyPnL = realizedToday + floatingProfit;

   bool inHours = IsWithinOperatingHours();

   string statusStr = "";
   color statusColor = clrWhite;

   if(m_dailyHalted)
   {
      statusStr = m_dailyHaltReason;
      statusColor = (totalDailyPnL >= 0 ? clrGold : clrTomato);
   }
   else if(openCount > 0)
   {
      statusStr = StringFormat("EN OPERACION: %s (%d ord | %.2f lot)", (cycleType == POSITION_TYPE_BUY ? "BUY" : "SELL"), openCount, totalLots);
      statusColor = (cycleType == POSITION_TYPE_BUY ? clrLime : clrTomato);
   }
   else if(!inHours)
   {
      statusStr = "FUERA DE HORARIO DE LIQUIDEZ";
      statusColor = clrDarkGray;
   }
   else
   {
      if(m_activeSellZone.active)
         statusStr = StringFormat("VIGILANDO SELL: FVG/BPR H0 %.2f | Inducement LH1: %.2f", m_activeSellZone.originPrice, m_lastLH_Price);
      else if(m_activeBuyZone.active)
         statusStr = StringFormat("VIGILANDO BUY: FVG/BPR L0 %.2f | Inducement HL1: %.2f", m_activeBuyZone.originPrice, m_lastHL_Price);
      else
         statusStr = "BUSCANDO ESTRUCTURA INSTITUCIONAL...";
      statusColor = clrAqua;
   }

   if(statusMsg != "")
      statusStr = statusMsg;

   SetLabelText(prefix + "LINE_0", StringFormat("Estado: %s", statusStr), statusColor);
   SetLabelText(prefix + "LINE_1", StringFormat("Zona Sell Activa: %s", (m_activeSellZone.active ? StringFormat("%.2f - %.2f (%s)", m_activeSellZone.bottom, m_activeSellZone.top, (m_activeSellZone.isBpr ? "BPR" : "FVG")) : "Ninguna")), (m_activeSellZone.active ? clrTomato : clrSilver));
   SetLabelText(prefix + "LINE_2", StringFormat("Zona Buy Activa:  %s", (m_activeBuyZone.active  ? StringFormat("%.2f - %.2f (%s)", m_activeBuyZone.bottom, m_activeBuyZone.top, (m_activeBuyZone.isBpr ? "BPR" : "FVG")) : "Ninguna")), (m_activeBuyZone.active ? clrLime : clrSilver));
   SetLabelText(prefix + "LINE_3", StringFormat("Flotante Trade:   $%.2f (Target: +$%.1f | SL: -$%.1f)", floatingProfit, InpTargetProfitUSD, InpTradeMaxLossUSD), (floatingProfit >= 0 ? clrLime : clrOrangeRed));
   SetLabelText(prefix + "LINE_4", StringFormat("Balance: $%.2f | Equidad: $%.2f", balance, equity), clrWhite);
   SetLabelText(prefix + "LINE_5", StringFormat("Hora ES: %02d:%02d | Spread: %.2f$", spainHour, dt.min, spreadUSD), (spreadUSD > 0.60 ? clrRed : clrLightGray));
   SetLabelText(prefix + "LINE_6", StringFormat("Hoy PnL: $%.2f (Meta: +$%.0f | MaxSL: -$%.0f)", totalDailyPnL, InpDailyTargetUSD, InpDailyMaxLossUSD), (totalDailyPnL >= 0 ? clrGold : clrTomato));
}

void SetLabelText(string name, string text, color clr)
{
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
}

void DestroyDashboard()
{
   ObjectsDeleteAll(0, "GERARD_HUD_");
}
//+------------------------------------------------------------------+
