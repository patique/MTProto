//+------------------------------------------------------------------+
//|                                  EA_XAUUSD_BPR_BOS_Sniper.mq5    |
//|               Quantitative Institutional BOS + Real BPR Retest   |
//|                 Optimized for Prop Firms (FTMO / The5%ers)       |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab"
#property link      "https://github.com/telegram-mtproto"
#property version   "2.00"
#property strict
#property description "XAUUSD M5/M3 Structural BOS + Real BPR Overlap EA"
#property description "Real FVG Overlap + Structural Pivot Origin SL + R:R 1:4.0"

#include <Trade\Trade.mqh>

//--- INPUT PARAMETERS ---
// 1. RISK & MONEY MANAGEMENT
input group "=== 1. RISK & MONEY MANAGEMENT ===";
input double   InpRiskPercent          = 1.0;       // Riesgo por Operación (% de Balance)
input double   InpRRRatio              = 4.0;       // Ratio Riesgo:Beneficio (R:R 1:4.0 = +4.0% por Win)
input int      InpMaxTradesPerDay      = 2;         // Máx operaciones por día (0 = Ilimitado / Sin restricción)
input double   InpMaxSpreadPoints      = 40.0;      // Spread máximo permitido en puntos (ej. 40 pts = 4.0 pips Oro)

// 2. BOS & INSTITUTIONAL BPR PARAMETERS
input group "=== 2. ESTRUCTURA BOS & BPR REAL ===";
input int      InpPivotLookback        = 5;         // Lookback para Swing High / Low (Fuerza del Pivot)
input int      InpAtrPeriod            = 14;        // Periodo ATR
input double   InpMinFvgAtr            = 0.25;      // Tamaño mínimo de cada FVG individual (en ATR)
input double   InpMinOverlapAtr        = 0.20;      // Solape mínimo entre FVG Alcista y Bajista (BPR Real en ATR)
input double   InpAtrBuffer            = 0.25;      // Buffer de protección tras el Swing Origin (en ATR)
input int      InpMaxZoneBars          = 120;       // Caducidad de zona BPR en barras si no es mitigada

// 3. HORARIO DE TRADING (SESSIONS)
input group "=== 3. HORARIO OPERATIVO (SERVER TIME) ===";
input bool     InpUseTimeFilter        = true;      // Activar Filtro Horario
input int      InpStartHour            = 8;         // Hora de Inicio (Apertura Londres)
input int      InpEndHour              = 20;        // Hora de Fin (Cierre New York)

// 4. GESTIÓN AVANZADA & PROTECCIÓN
input group "=== 4. GESTIÓN DE POSICIÓN ===";
input bool     InpEnableAutoBE         = false;     // Mover a Break-Even tras avanzar 1:2 R
input double   InpBETriggerR           = 2.0;       // R de beneficio para activar BE
input ulong    InpMagicNumber          = 100502;    // Magic Number EA XAUUSD
input string   InpTradeComment         = "XAU_BPR_BOS_Sniper"; // Comentario de orden
input bool     InpDrawZones            = true;      // Dibujar BPR Zones y Pivots en gráfico

//--- STRUCTS & ENUMS ---
enum ENUM_BOS_STATE
{
   BOS_NONE,
   BOS_BULLISH,
   BOS_BEARISH
};

struct FVGItem
{
   bool     isBullish;
   double   top;
   double   bottom;
   datetime time;
};

struct BPRZone
{
   bool              active;
   ENUM_ORDER_TYPE   bias;          // ORDER_TYPE_BUY o ORDER_TYPE_SELL
   double            top;           // Límite superior del solape BPR
   double            bottom;        // Límite inferior del solape BPR
   double            swingOrigin;   // Pivote origen que causó el BOS (Nivel de SL)
   double            slPrice;       // SL estructural calculado
   datetime          creationTime;  // Momento de creación
   string            objName;       // Nombre del objeto gráfico
};

struct SwingPivot
{
   bool     isHigh;
   double   price;
   datetime time;
   int      barIndex;
};

//--- GLOBALS ---
BPRZone        activeBprZones[];
CTrade         trade;
int            hAtr;
datetime       lastBarTime = 0;
ENUM_BOS_STATE currentBosState = BOS_NONE;
SwingPivot     lastSwingHigh;
SwingPivot     lastSwingLow;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetMarginMode();
   trade.SetTypeFillingBySymbol(_Symbol);

   hAtr = iATR(_Symbol, PERIOD_CURRENT, InpAtrPeriod);
   if(hAtr == INVALID_HANDLE)
   {
      Print("❌ Error al crear handle de ATR para XAUUSD");
      return(INIT_FAILED);
   }

   ArrayResize(activeBprZones, 0);
   lastSwingHigh.price = 0;
   lastSwingLow.price = 0;

   Print("======================================================");
   Print("🚀 EA XAUUSD BPR + BOS Sniper V2.0 Inicializado");
   Print("📊 Símbolo: ", _Symbol, " | Timeframe: ", EnumToString(Period()));
   Print("🎯 Risk: ", InpRiskPercent, "% | Target R:R: 1:", InpRRRatio);
   Print("🔒 Límite Diario: ", (InpMaxTradesPerDay > 0 ? IntegerToString(InpMaxTradesPerDay) + " trades/día" : "ILIMITADO"));
   Print("======================================================");

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(hAtr);

   if(InpDrawZones)
   {
      ObjectsDeleteAll(0, "XAU_BPR_");
      ObjectsDeleteAll(0, "XAU_BOS_");
   }
   Comment("");
}

//+------------------------------------------------------------------+
//| Conteo de operaciones ejecutadas hoy para el MagicNumber         |
//+------------------------------------------------------------------+
int GetTradesCountToday()
{
   MqlDateTime dt;
   TimeCurrent(dt);
   dt.hour = 0;
   dt.min  = 0;
   dt.sec  = 0;
   datetime dayStart = StructToTime(dt);

   if(!HistorySelect(dayStart, TimeCurrent()))
      return 0;

   int count = 0;
   int dealsTotal = HistoryDealsTotal();
   for(int i = 0; i < dealsTotal; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket > 0)
      {
         if(HistoryDealGetInteger(ticket, DEAL_MAGIC) == (long)InpMagicNumber &&
            HistoryDealGetString(ticket, DEAL_SYMBOL) == _Symbol &&
            (ENUM_DEAL_ENTRY)HistoryDealGetInteger(ticket, DEAL_ENTRY) == DEAL_ENTRY_IN)
         {
            count++;
         }
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Comprueba si ya hay una posición abierta del EA                  |
//+------------------------------------------------------------------+
bool HasOpenPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == (long)InpMagicNumber)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Cálculo dinámico de lotes basado en 1% del Balance y distancia SL|
//+------------------------------------------------------------------+
double CalculateLotSize(double slDistancePrice)
{
   if(slDistancePrice <= 0.0) return 0.0;

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney = balance * (InpRiskPercent / 100.0);

   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double lotStep   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double minLot    = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot    = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);

   if(tickSize <= 0.0 || tickValue <= 0.0)
   {
      Print("❌ Error obteniendo especificaciones de tick del símbolo XAUUSD");
      return minLot;
   }

   double ticksAtRisk = slDistancePrice / tickSize;
   double moneyPerLot = ticksAtRisk * tickValue;

   if(moneyPerLot <= 0.0) return minLot;

   double lot = riskMoney / moneyPerLot;

   lot = MathFloor(lot / lotStep) * lotStep;

   if(lot < minLot) lot = minLot;
   if(lot > maxLot) lot = maxLot;

   return NormalizeDouble(lot, 2);
}

//+------------------------------------------------------------------+
//| Comprobación de Filtro Horario                                   |
//+------------------------------------------------------------------+
bool IsTradingAllowedByTime()
{
   if(!InpUseTimeFilter) return true;

   MqlDateTime dt;
   TimeCurrent(dt);

   if(InpStartHour <= InpEndHour)
      return (dt.hour >= InpStartHour && dt.hour < InpEndHour);
   else
      return (dt.hour >= InpStartHour || dt.hour < InpEndHour);
}

//+------------------------------------------------------------------+
//| Detección de Swings, BOS y Creación de BPR Real en Nueva Barra   |
//+------------------------------------------------------------------+
void UpdateStructureAndScanBPR()
{
   int requiredBars = InpPivotLookback * 4 + 20;
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_CURRENT, 0, requiredBars, rates) < requiredBars) return;

   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(hAtr, 0, 0, 3, atr) < 3) return;

   // 1. Identificar Swing Highs y Swing Lows confirmados
   for(int i = InpPivotLookback + 1; i <= InpPivotLookback * 3; i++)
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

      if(isHigh && (lastSwingHigh.price == 0 || rates[i].time > lastSwingHigh.time))
      {
         lastSwingHigh.isHigh = true;
         lastSwingHigh.price = rates[i].high;
         lastSwingHigh.time = rates[i].time;
         lastSwingHigh.barIndex = i;
      }

      if(isLow && (lastSwingLow.price == 0 || rates[i].time > lastSwingLow.time))
      {
         lastSwingLow.isHigh = false;
         lastSwingLow.price = rates[i].low;
         lastSwingLow.time = rates[i].time;
         lastSwingLow.barIndex = i;
      }
   }

   // 2. Comprobar Break of Structure (BOS) con cierre de la barra 1
   bool isBullishBos = false;
   bool isBearishBos = false;

   if(lastSwingHigh.price > 0 && rates[1].close > lastSwingHigh.price && rates[2].close <= lastSwingHigh.price)
   {
      isBullishBos = true;
      currentBosState = BOS_BULLISH;
      Print("⚡ [BULLISH BOS DETECTADO] Ruptura de Swing High: ", lastSwingHigh.price, " | Origin Pivot Low: ", lastSwingLow.price);

      if(InpDrawZones)
      {
         string bosName = "XAU_BOS_H_" + TimeToString(rates[1].time, TIME_DATE|TIME_MINUTES);
         ObjectCreate(0, bosName, OBJ_TREND, 0, lastSwingHigh.time, lastSwingHigh.price, rates[1].time, lastSwingHigh.price);
         ObjectSetInteger(0, bosName, OBJPROP_COLOR, clrLimeGreen);
         ObjectSetInteger(0, bosName, OBJPROP_STYLE, STYLE_SOLID);
         ObjectSetInteger(0, bosName, OBJPROP_WIDTH, 2);
      }
   }
   else if(lastSwingLow.price > 0 && rates[1].close < lastSwingLow.price && rates[2].close >= lastSwingLow.price)
   {
      isBearishBos = true;
      currentBosState = BOS_BEARISH;
      Print("⚡ [BEARISH BOS DETECTADO] Ruptura de Swing Low: ", lastSwingLow.price, " | Origin Pivot High: ", lastSwingHigh.price);

      if(InpDrawZones)
      {
         string bosName = "XAU_BOS_L_" + TimeToString(rates[1].time, TIME_DATE|TIME_MINUTES);
         ObjectCreate(0, bosName, OBJ_TREND, 0, lastSwingLow.time, lastSwingLow.price, rates[1].time, lastSwingLow.price);
         ObjectSetInteger(0, bosName, OBJPROP_COLOR, clrOrangeRed);
         ObjectSetInteger(0, bosName, OBJPROP_STYLE, STYLE_SOLID);
         ObjectSetInteger(0, bosName, OBJPROP_WIDTH, 2);
      }
   }

   // 3. Detectar FVGs recientes y encontrar el solape BPR Real
   FVGItem fvgBullish[];
   FVGItem fvgBearish[];
   ArrayResize(fvgBullish, 0);
   ArrayResize(fvgBearish, 0);

   int scanBars = MathMin(30, requiredBars - 3);
   for(int i = 1; i < scanBars; i++)
   {
      // Bullish FVG: Low de vela i > High de vela i+2
      if(rates[i].low > rates[i + 2].high)
      {
         double gap = rates[i].low - rates[i + 2].high;
         if(gap >= InpMinFvgAtr * atr[1])
         {
            int s = ArraySize(fvgBullish);
            ArrayResize(fvgBullish, s + 1);
            fvgBullish[s].isBullish = true;
            fvgBullish[s].top       = rates[i].low;
            fvgBullish[s].bottom    = rates[i + 2].high;
            fvgBullish[s].time      = rates[i].time;
         }
      }

      // Bearish FVG: High de vela i < Low de vela i+2
      if(rates[i].high < rates[i + 2].low)
      {
         double gap = rates[i + 2].low - rates[i].high;
         if(gap >= InpMinFvgAtr * atr[1])
         {
            int s = ArraySize(fvgBearish);
            ArrayResize(fvgBearish, s + 1);
            fvgBearish[s].isBullish = false;
            fvgBearish[s].top       = rates[i + 2].low;
            fvgBearish[s].bottom    = rates[i].high;
            fvgBearish[s].time      = rates[i].time;
         }
      }
   }

   // 4. Cruzar FVGs para hallar BPR REAL (Balanced Price Range Overlap)
   for(int b = 0; b < ArraySize(fvgBullish); b++)
   {
      for(int s = 0; s < ArraySize(fvgBearish); s++)
      {
         double overlapTop = MathMin(fvgBullish[b].top, fvgBearish[s].top);
         double overlapBottom = MathMax(fvgBullish[b].bottom, fvgBearish[s].bottom);

         if(overlapTop > overlapBottom && (overlapTop - overlapBottom) >= InpMinOverlapAtr * atr[1])
         {
            // Solo registrar si está alineado con la estructura BOS reciente
            if(currentBosState == BOS_BULLISH && lastSwingLow.price > 0)
            {
               // Verificar que no esté ya registrada una zona idéntica
               bool exists = false;
               for(int z = 0; z < ArraySize(activeBprZones); z++)
               {
                  if(activeBprZones[z].active && MathAbs(activeBprZones[z].top - overlapTop) < 0.1)
                  {
                     exists = true;
                     break;
                  }
               }

               if(!exists)
               {
                  BPRZone bpr;
                  bpr.active        = true;
                  bpr.bias          = ORDER_TYPE_BUY;
                  bpr.top           = overlapTop;
                  bpr.bottom        = overlapBottom;
                  bpr.swingOrigin   = lastSwingLow.price;
                  bpr.slPrice       = NormalizeDouble(bpr.swingOrigin - (InpAtrBuffer * atr[1]), _Digits);
                  bpr.creationTime  = TimeCurrent();
                  bpr.objName       = "XAU_BPR_BUY_" + TimeToString(rates[1].time, TIME_DATE|TIME_MINUTES);

                  int size = ArraySize(activeBprZones);
                  ArrayResize(activeBprZones, size + 1);
                  activeBprZones[size] = bpr;

                  Print("💎 [BPR REAL ALCISTA DETECTADO] Zona: ", overlapBottom, " - ", overlapTop, " | SL Estructural: ", bpr.slPrice);

                  if(InpDrawZones)
                  {
                     ObjectCreate(0, bpr.objName, OBJ_RECTANGLE, 0, rates[1].time, bpr.top, TimeCurrent() + 7200, bpr.bottom);
                     ObjectSetInteger(0, bpr.objName, OBJPROP_COLOR, clrDarkCyan);
                     ObjectSetInteger(0, bpr.objName, OBJPROP_FILL, true);
                     ObjectSetInteger(0, bpr.objName, OBJPROP_BACK, true);
                  }
               }
            }
            else if(currentBosState == BOS_BEARISH && lastSwingHigh.price > 0)
            {
               bool exists = false;
               for(int z = 0; z < ArraySize(activeBprZones); z++)
               {
                  if(activeBprZones[z].active && MathAbs(activeBprZones[z].bottom - overlapBottom) < 0.1)
                  {
                     exists = true;
                     break;
                  }
               }

               if(!exists)
               {
                  BPRZone bpr;
                  bpr.active        = true;
                  bpr.bias          = ORDER_TYPE_SELL;
                  bpr.top           = overlapTop;
                  bpr.bottom        = overlapBottom;
                  bpr.swingOrigin   = lastSwingHigh.price;
                  bpr.slPrice       = NormalizeDouble(bpr.swingOrigin + (InpAtrBuffer * atr[1]), _Digits);
                  bpr.creationTime  = TimeCurrent();
                  bpr.objName       = "XAU_BPR_SELL_" + TimeToString(rates[1].time, TIME_DATE|TIME_MINUTES);

                  int size = ArraySize(activeBprZones);
                  ArrayResize(activeBprZones, size + 1);
                  activeBprZones[size] = bpr;

                  Print("💎 [BPR REAL BAJISTA DETECTADO] Zona: ", overlapBottom, " - ", overlapTop, " | SL Estructural: ", bpr.slPrice);

                  if(InpDrawZones)
                  {
                     ObjectCreate(0, bpr.objName, OBJ_RECTANGLE, 0, rates[1].time, bpr.top, TimeCurrent() + 7200, bpr.bottom);
                     ObjectSetInteger(0, bpr.objName, OBJPROP_COLOR, clrDarkMagenta);
                     ObjectSetInteger(0, bpr.objName, OBJPROP_FILL, true);
                     ObjectSetInteger(0, bpr.objName, OBJPROP_BACK, true);
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Chequeo de Retest y Ejecución Sniper en Zona BPR Real            |
//+------------------------------------------------------------------+
void CheckRetestAndExecution()
{
   if(HasOpenPosition()) return;

   // Control de Límite Diario Parametrizable (0 = Ilimitado)
   if(InpMaxTradesPerDay > 0)
   {
      int tradesToday = GetTradesCountToday();
      if(tradesToday >= InpMaxTradesPerDay)
         return;
   }

   if(!IsTradingAllowedByTime()) return;

   double spread = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / _Point;
   if(spread > InpMaxSpreadPoints) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   int totalZones = ArraySize(activeBprZones);
   for(int i = 0; i < totalZones; i++)
   {
      if(!activeBprZones[i].active) continue;

      // 1. Invalidación Estructural: Si el precio vulnera el Swing Origin antes del retest
      if(activeBprZones[i].bias == ORDER_TYPE_BUY)
      {
         if(bid < activeBprZones[i].swingOrigin)
         {
            activeBprZones[i].active = false;
            if(InpDrawZones) ObjectSetInteger(0, activeBprZones[i].objName, OBJPROP_COLOR, clrGray);
            continue;
         }

         // Retest Alcista: El precio entra en la franja BPR (entre bottom y top)
         if(bid <= activeBprZones[i].top && bid >= activeBprZones[i].bottom)
         {
            double entryPrice = ask;
            double sl = activeBprZones[i].slPrice;
            double riskDist = entryPrice - sl;

            if(riskDist > 0.0)
            {
               double tp = NormalizeDouble(entryPrice + (riskDist * InpRRRatio), _Digits);
               double lots = CalculateLotSize(riskDist);

               if(lots > 0.0)
               {
                  Print("🚀 [SNIPER BPR RETEST BUY] Retest exitoso en franja BPR!");
                  Print("📈 Entrada: ", entryPrice, " | SL Estructural: ", sl, " | TP (1:", InpRRRatio, "): ", tp, " | Lotes: ", lots);

                  if(trade.Buy(lots, _Symbol, entryPrice, sl, tp, InpTradeComment))
                  {
                     activeBprZones[i].active = false;
                     if(InpDrawZones) ObjectSetInteger(0, activeBprZones[i].objName, OBJPROP_COLOR, clrSeaGreen);
                     return;
                  }
               }
            }
         }
      }
      else if(activeBprZones[i].bias == ORDER_TYPE_SELL)
      {
         if(ask > activeBprZones[i].swingOrigin)
         {
            activeBprZones[i].active = false;
            if(InpDrawZones) ObjectSetInteger(0, activeBprZones[i].objName, OBJPROP_COLOR, clrGray);
            continue;
         }

         // Retest Bajista: El precio sube hacia la franja BPR
         if(ask >= activeBprZones[i].bottom && ask <= activeBprZones[i].top)
         {
            double entryPrice = bid;
            double sl = activeBprZones[i].slPrice;
            double riskDist = sl - entryPrice;

            if(riskDist > 0.0)
            {
               double tp = NormalizeDouble(entryPrice - (riskDist * InpRRRatio), _Digits);
               double lots = CalculateLotSize(riskDist);

               if(lots > 0.0)
               {
                  Print("🚀 [SNIPER BPR RETEST SELL] Retest exitoso en franja BPR!");
                  Print("📉 Entrada: ", entryPrice, " | SL Estructural: ", sl, " | TP (1:", InpRRRatio, "): ", tp, " | Lotes: ", lots);

                  if(trade.Sell(lots, _Symbol, entryPrice, sl, tp, InpTradeComment))
                  {
                     activeBprZones[i].active = false;
                     if(InpDrawZones) ObjectSetInteger(0, activeBprZones[i].objName, OBJPROP_COLOR, clrFireBrick);
                     return;
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Gestión de Auto Break-Even                                       |
//+------------------------------------------------------------------+
void ManageBreakEven()
{
   if(!InpEnableAutoBE) return;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == (long)InpMagicNumber && PositionGetString(POSITION_SYMBOL) == _Symbol)
      {
         double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         double currentSL = PositionGetDouble(POSITION_SL);
         double currentTP = PositionGetDouble(POSITION_TP);
         ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         double priceCurrent = PositionGetDouble(POSITION_PRICE_CURRENT);

         if(type == POSITION_TYPE_BUY)
         {
            double riskDist = openPrice - currentSL;
            if(riskDist > 0 && priceCurrent >= openPrice + (riskDist * InpBETriggerR) && currentSL < openPrice)
            {
               double bePrice = NormalizeDouble(openPrice + (2.0 * _Point), _Digits);
               Print("🛡️ [AUTO BREAK-EVEN] BUY #", ticket, " asegurando posición en BE.");
               trade.PositionModify(ticket, bePrice, currentTP);
            }
         }
         else if(type == POSITION_TYPE_SELL)
         {
            double riskDist = currentSL - openPrice;
            if(riskDist > 0 && priceCurrent <= openPrice - (riskDist * InpBETriggerR) && (currentSL > openPrice || currentSL == 0))
            {
               double bePrice = NormalizeDouble(openPrice - (2.0 * _Point), _Digits);
               Print("🛡️ [AUTO BREAK-EVEN] SELL #", ticket, " asegurando posición en BE.");
               trade.PositionModify(ticket, bePrice, currentTP);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Actualizar Dashboard en pantalla                                 |
//+------------------------------------------------------------------+
void UpdateDashboard()
{
   int tradesToday = GetTradesCountToday();
   string dailyLimitStr = (InpMaxTradesPerDay == 0) ? "ILIMITADO" : (IntegerToString(tradesToday) + " / " + IntegerToString(InpMaxTradesPerDay));
   string bosStr = (currentBosState == BOS_BULLISH) ? "🟢 ALCISTA" : (currentBosState == BOS_BEARISH ? "🔴 BAJISTA" : "⚪ NEUTRO");

   string dashboard = "==========================================\n";
   dashboard += "🥇 XAUUSD BPR + BOS SNIPER (V2.0 PRO)\n";
   dashboard += "==========================================\n";
   dashboard += "💰 Balance: " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + " " + AccountInfoString(ACCOUNT_CURRENCY) + "\n";
   dashboard += "🎯 Riesgo / Trade: " + DoubleToString(InpRiskPercent, 1) + "% | Target R:R: 1:" + DoubleToString(InpRRRatio, 1) + "\n";
   dashboard += "📅 Trades Hoy: " + dailyLimitStr + "\n";
   dashboard += "⚡ Estructura BOS: " + bosStr + "\n";
   dashboard += "⏰ Sesión Activa: " + (IsTradingAllowedByTime() ? "✅ SÍ (" + IntegerToString(InpStartHour) + ":00 - " + IntegerToString(InpEndHour) + ":00)" : "⏸️ FUERA DE HORA") + "\n";
   dashboard += "💎 Zonas BPR Activas: " + IntegerToString(ArraySize(activeBprZones)) + "\n";
   dashboard += "==========================================";

   Comment(dashboard);
}

//+------------------------------------------------------------------+
//| OnTick function                                                  |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. Detección de nueva barra M5/M3 para actualizar estructura Swings, BOS y BPR
   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime != lastBarTime)
   {
      lastBarTime = currentBarTime;
      UpdateStructureAndScanBPR();
   }

   // 2. Chequeo de retest en la franja BPR en tiempo real (Tick a Tick)
   CheckRetestAndExecution();

   // 3. Gestión de posición (Break-Even si está configurado)
   ManageBreakEven();

   // 4. Panel visual
   UpdateDashboard();
}
//+------------------------------------------------------------------+
