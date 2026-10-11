//+------------------------------------------------------------------+
//|                                EA_NAS100_OrderBlock_Sniper.mq5   |
//|               Quantitative Institutional Order Block Mitigation  |
//|                 Optimized for Prop Firms (FTMO / The5%ers)       |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab"
#property link      "https://github.com/telegram-mtproto"
#property version   "2.00"
#property strict
#property description "NAS100 M5 Institutional Order Block Mitigation EA"
#property description "HTF H1 EMA 50 Filter + 50% Mean Threshold + R:R 1:5.4"

#include <Trade\Trade.mqh>

//--- INPUT PARAMETERS ---
// 1. RISK & MONEY MANAGEMENT
input group "=== 1. RISK & MONEY MANAGEMENT ===";
input double   InpRiskPercent          = 1.0;       // Riesgo por Operación (% de Balance)
input double   InpRRRatio              = 5.4;       // Ratio Riesgo:Beneficio (R:R 1:5.4 = +5.4% por Win)
input int      InpMaxTradesPerDay      = 2;         // Máx operaciones por día (0 = Ilimitado / Sin restricción)
input double   InpMaxSpreadPoints      = 150.0;     // Spread máximo permitido en puntos

// 2. TIMEFRAME & INSTITUTIONAL FILTERS
input group "=== 2. INSTITUTIONAL STRATEGY FILTERS ===";
input ENUM_TIMEFRAMES InpHtfPeriod     = PERIOD_H1; // Timeframe de Tendencia Mayor (HTF)
input int      InpHtfEmaPeriod         = 50;        // Periodo EMA HTF (Filtro Tendencia H1)
input int      InpAtrPeriod            = 14;        // Periodo ATR M5
input double   InpDispAtrMult          = 1.78;      // Multiplicador ATR para Vela de Desplazamiento (1.78)
input double   InpMeanThreshold        = 0.50;      // Nivel de Mitigación OB (0.50 = 50% Mean Threshold)
input double   InpAtrBuffer            = 0.18;      // Buffer de Stop Loss (en múltiplos de ATR)
input int      InpMaxObAgeBars         = 100;       // Máxima antigüedad del OB en velas antes de expirar

// 3. HORARIO DE TRADING (SESSIONS)
input group "=== 3. HORARIO OPERATIVO (SERVER TIME) ===";
input bool     InpUseTimeFilter        = true;      // Activar Filtro Horario
input int      InpStartHour            = 10;        // Hora de Inicio (Londres / NY Open)
input int      InpEndHour              = 20;        // Hora de Fin (Cierre NY)

// 4. GESTIÓN AVANZADA & PROTECCIÓN
input group "=== 4. GESTIÓN DE POSICIÓN ===";
input bool     InpEnableAutoBE         = false;     // Mover a Break-Even tras avanzar 1:2 R
input double   InpBETriggerR           = 2.0;       // R de beneficio para activar BE
input ulong    InpMagicNumber          = 100501;    // Magic Number EA NAS100
input string   InpTradeComment         = "NAS100_OB_Sniper"; // Comentario de orden
input bool     InpDrawZones            = true;      // Dibujar Order Blocks y 50% MT en gráfico

//--- STRUCTS & VARIABLES ---
struct OrderBlockZone
{
   bool              active;
   ENUM_ORDER_TYPE   type;          // ORDER_TYPE_BUY o ORDER_TYPE_SELL
   double            high;          // Máximo de la vela OB
   double            low;           // Mínimo de la vela OB
   double            meanThreshold; // 50% Mean Threshold
   double            slPrice;       // SL calculado detrás del OB + buffer
   datetime          creationTime;  // Momento de creación
   int               creationBar;   // Barra de creación
   string            objNameBox;    // Nombre del objeto gráfico
   string            objNameLine;
};

OrderBlockZone activeZones[];
CTrade         trade;
int            hAtr;
int            hEmaHtf;
datetime       lastBarTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetMarginMode();
   trade.SetTypeFillingBySymbol(_Symbol);

   // Inicializar Indicadores
   hAtr = iATR(_Symbol, PERIOD_CURRENT, InpAtrPeriod);
   if(hAtr == INVALID_HANDLE)
   {
      Print("❌ Error al crear handle de ATR M5");
      return(INIT_FAILED);
   }

   hEmaHtf = iMA(_Symbol, InpHtfPeriod, InpHtfEmaPeriod, 0, MODE_EMA, PRICE_CLOSE);
   if(hEmaHtf == INVALID_HANDLE)
   {
      Print("❌ Error al crear handle de EMA HTF");
      return(INIT_FAILED);
   }

   ArrayResize(activeZones, 0);

   Print("======================================================");
   Print("🚀 EA NAS100 Order Block Sniper V2.0 Inicializado con éxito");
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
   IndicatorRelease(hEmaHtf);
   
   if(InpDrawZones)
   {
      ObjectsDeleteAll(0, "NAS_OB_");
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
      Print("❌ Error obteniendo especificaciones de tick del símbolo");
      return minLot;
   }

   double ticksAtRisk = slDistancePrice / tickSize;
   double moneyPerLot = ticksAtRisk * tickValue;

   if(moneyPerLot <= 0.0) return minLot;

   double lot = riskMoney / moneyPerLot;

   // Redondeo al paso del broker
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
//| Detección de Nuevos Order Blocks en Apertura de Vela             |
//+------------------------------------------------------------------+
void ScanForOrderBlocks()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_CURRENT, 0, 5, rates) < 5) return;

   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(hAtr, 0, 0, 3, atr) < 3) return;

   double emaHtf[];
   ArraySetAsSeries(emaHtf, true);
   if(CopyBuffer(hEmaHtf, 0, 0, 2, emaHtf) < 2) return;

   MqlRates htfRates[];
   ArraySetAsSeries(htfRates, true);
   if(CopyRates(_Symbol, InpHtfPeriod, 0, 2, htfRates) < 2) return;

   bool htfBullish = (htfRates[1].close > emaHtf[1]);
   bool htfBearish = (htfRates[1].close < emaHtf[1]);

   // Vela 1 es la vela recién cerrada (Desplazamiento potencial)
   // Vela 2 es la vela previa (Candidata a Order Block)
   double body1 = MathAbs(rates[1].close - rates[1].open);
   double minDisp = InpDispAtrMult * atr[1];

   // 1. CONDICIÓN ALCISTA: Vela 1 alcista y potente, Vela 2 bajista, HTF Bullish
   if(htfBullish && rates[1].close > rates[1].open && body1 >= minDisp && rates[2].close < rates[2].open)
   {
      OrderBlockZone ob;
      ob.active        = true;
      ob.type          = ORDER_TYPE_BUY;
      ob.high          = rates[2].high;
      ob.low           = rates[2].low;
      ob.meanThreshold = NormalizeDouble((ob.high + ob.low) * 0.5, _Digits);
      ob.slPrice       = NormalizeDouble(ob.low - (InpAtrBuffer * atr[1]), _Digits);
      ob.creationTime  = rates[2].time;
      ob.creationBar   = 1;
      ob.objNameBox    = "NAS_OB_BUY_" + TimeToString(rates[2].time, TIME_DATE|TIME_MINUTES);
      ob.objNameLine   = "NAS_MT_BUY_" + TimeToString(rates[2].time, TIME_DATE|TIME_MINUTES);

      int size = ArraySize(activeZones);
      ArrayResize(activeZones, size + 1);
      activeZones[size] = ob;

      Print("🟢 [BULLISH OB DETECTADO] Alto: ", ob.high, " | Bajo: ", ob.low, " | 50% MT: ", ob.meanThreshold, " | SL: ", ob.slPrice);

      if(InpDrawZones)
      {
         ObjectCreate(0, ob.objNameBox, OBJ_RECTANGLE, 0, ob.creationTime, ob.high, TimeCurrent() + 7200, ob.low);
         ObjectSetInteger(0, ob.objNameBox, OBJPROP_COLOR, clrDodgerBlue);
         ObjectSetInteger(0, ob.objNameBox, OBJPROP_FILL, true);
         ObjectSetInteger(0, ob.objNameBox, OBJPROP_BACK, true);

         ObjectCreate(0, ob.objNameLine, OBJ_TREND, 0, ob.creationTime, ob.meanThreshold, TimeCurrent() + 7200, ob.meanThreshold);
         ObjectSetInteger(0, ob.objNameLine, OBJPROP_COLOR, clrAqua);
         ObjectSetInteger(0, ob.objNameLine, OBJPROP_STYLE, STYLE_DASH);
         ObjectSetInteger(0, ob.objNameLine, OBJPROP_WIDTH, 1);
      }
   }

   // 2. CONDICIÓN BAJISTA: Vela 1 bajista y potente, Vela 2 alcista, HTF Bearish
   if(htfBearish && rates[1].close < rates[1].open && body1 >= minDisp && rates[2].close > rates[2].open)
   {
      OrderBlockZone ob;
      ob.active        = true;
      ob.type          = ORDER_TYPE_SELL;
      ob.high          = rates[2].high;
      ob.low           = rates[2].low;
      ob.meanThreshold = NormalizeDouble((ob.high + ob.low) * 0.5, _Digits);
      ob.slPrice       = NormalizeDouble(ob.high + (InpAtrBuffer * atr[1]), _Digits);
      ob.creationTime  = rates[2].time;
      ob.creationBar   = 1;
      ob.objNameBox    = "NAS_OB_SELL_" + TimeToString(rates[2].time, TIME_DATE|TIME_MINUTES);
      ob.objNameLine   = "NAS_MT_SELL_" + TimeToString(rates[2].time, TIME_DATE|TIME_MINUTES);

      int size = ArraySize(activeZones);
      ArrayResize(activeZones, size + 1);
      activeZones[size] = ob;

      Print("🔴 [BEARISH OB DETECTADO] Alto: ", ob.high, " | Bajo: ", ob.low, " | 50% MT: ", ob.meanThreshold, " | SL: ", ob.slPrice);

      if(InpDrawZones)
      {
         ObjectCreate(0, ob.objNameBox, OBJ_RECTANGLE, 0, ob.creationTime, ob.high, TimeCurrent() + 7200, ob.low);
         ObjectSetInteger(0, ob.objNameBox, OBJPROP_COLOR, clrCrimson);
         ObjectSetInteger(0, ob.objNameBox, OBJPROP_FILL, true);
         ObjectSetInteger(0, ob.objNameBox, OBJPROP_BACK, true);

         ObjectCreate(0, ob.objNameLine, OBJ_TREND, 0, ob.creationTime, ob.meanThreshold, TimeCurrent() + 7200, ob.meanThreshold);
         ObjectSetInteger(0, ob.objNameLine, OBJPROP_COLOR, clrOrangeRed);
         ObjectSetInteger(0, ob.objNameLine, OBJPROP_STYLE, STYLE_DASH);
         ObjectSetInteger(0, ob.objNameLine, OBJPROP_WIDTH, 1);
      }
   }
}

//+------------------------------------------------------------------+
//| Chequeo en tiempo real de Mitigación en el 50% Mean Threshold    |
//+------------------------------------------------------------------+
void CheckMitigationAndExecution()
{
   if(HasOpenPosition()) return;

   // Control de Límite Diario Parametrizable (si InpMaxTradesPerDay == 0 -> Sin límite)
   if(InpMaxTradesPerDay > 0)
   {
      int tradesToday = GetTradesCountToday();
      if(tradesToday >= InpMaxTradesPerDay)
         return; // Máximo diario alcanzado
   }

   if(!IsTradingAllowedByTime()) return;

   double spread = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / _Point;
   if(spread > InpMaxSpreadPoints) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   int totalZones = ArraySize(activeZones);
   for(int i = 0; i < totalZones; i++)
   {
      if(!activeZones[i].active) continue;

      // 1. Invalidación por ruptura estructural previa a mitigación
      if(activeZones[i].type == ORDER_TYPE_BUY)
      {
         if(bid < activeZones[i].low)
         {
            activeZones[i].active = false;
            if(InpDrawZones) ObjectSetInteger(0, activeZones[i].objNameBox, OBJPROP_COLOR, clrGray);
            continue;
         }

         // Mitigación Alcista: Precio toca o penetra hacia el 50% Mean Threshold
         if(bid <= activeZones[i].meanThreshold && bid >= activeZones[i].low)
         {
            double entryPrice = ask;
            double sl = activeZones[i].slPrice;
            double riskDist = entryPrice - sl;

            if(riskDist > 0.0)
            {
               double tp = NormalizeDouble(entryPrice + (riskDist * InpRRRatio), _Digits);
               double lots = CalculateLotSize(riskDist);

               if(lots > 0.0)
               {
                  Print("⚡ [SNIPER ENTRY BUY] Mitigación Mean Threshold alcanzada!");
                  Print("📈 Entrada: ", entryPrice, " | SL: ", sl, " | TP (1:", InpRRRatio, "): ", tp, " | Lotes: ", lots);
                  
                  if(trade.Buy(lots, _Symbol, entryPrice, sl, tp, InpTradeComment))
                  {
                     activeZones[i].active = false; // Zona mitigada exitosamente
                     if(InpDrawZones) ObjectSetInteger(0, activeZones[i].objNameBox, OBJPROP_COLOR, clrDarkGreen);
                     return;
                  }
               }
            }
         }
      }
      else if(activeZones[i].type == ORDER_TYPE_SELL)
      {
         if(ask > activeZones[i].high)
         {
            activeZones[i].active = false;
            if(InpDrawZones) ObjectSetInteger(0, activeZones[i].objNameBox, OBJPROP_COLOR, clrGray);
            continue;
         }

         // Mitigación Bajista: Precio sube y toca el 50% Mean Threshold
         if(ask >= activeZones[i].meanThreshold && ask <= activeZones[i].high)
         {
            double entryPrice = bid;
            double sl = activeZones[i].slPrice;
            double riskDist = sl - entryPrice;

            if(riskDist > 0.0)
            {
               double tp = NormalizeDouble(entryPrice - (riskDist * InpRRRatio), _Digits);
               double lots = CalculateLotSize(riskDist);

               if(lots > 0.0)
               {
                  Print("⚡ [SNIPER ENTRY SELL] Mitigación Mean Threshold alcanzada!");
                  Print("📉 Entrada: ", entryPrice, " | SL: ", sl, " | TP (1:", InpRRRatio, "): ", tp, " | Lotes: ", lots);

                  if(trade.Sell(lots, _Symbol, entryPrice, sl, tp, InpTradeComment))
                  {
                     activeZones[i].active = false; // Zona mitigada
                     if(InpDrawZones) ObjectSetInteger(0, activeZones[i].objNameBox, OBJPROP_COLOR, clrDarkRed);
                     return;
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Gestión de Break-Even dinámico si está activado                  |
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
               Print("🛡️ [AUTO BREAK-EVEN] BUY #", ticket, " asegurando posición en BE (+comisión).");
               trade.PositionModify(ticket, bePrice, currentTP);
            }
         }
         else if(type == POSITION_TYPE_SELL)
         {
            double riskDist = currentSL - openPrice;
            if(riskDist > 0 && priceCurrent <= openPrice - (riskDist * InpBETriggerR) && (currentSL > openPrice || currentSL == 0))
            {
               double bePrice = NormalizeDouble(openPrice - (2.0 * _Point), _Digits);
               Print("🛡️ [AUTO BREAK-EVEN] SELL #", ticket, " asegurando posición en BE (-comisión).");
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
   
   string dashboard = "==========================================\n";
   dashboard += "🏛️ NAS100 ORDER BLOCK SNIPER (V2.0 PRO)\n";
   dashboard += "==========================================\n";
   dashboard += "💰 Balance: " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + " " + AccountInfoString(ACCOUNT_CURRENCY) + "\n";
   dashboard += "🎯 Riesgo / Trade: " + DoubleToString(InpRiskPercent, 1) + "% | Target R:R: 1:" + DoubleToString(InpRRRatio, 1) + "\n";
   dashboard += "📅 Trades Hoy: " + dailyLimitStr + "\n";
   dashboard += "⏰ Sesión Activa: " + (IsTradingAllowedByTime() ? "✅ SÍ (" + IntegerToString(InpStartHour) + ":00 - " + IntegerToString(InpEndHour) + ":00)" : "⏸️ FUERA DE HORA") + "\n";
   dashboard += "📡 Zonas OB Registradas: " + IntegerToString(ArraySize(activeZones)) + "\n";
   dashboard += "==========================================";

   Comment(dashboard);
}

//+------------------------------------------------------------------+
//| OnTick function                                                  |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. Detección de nueva barra M5 para escanear nuevos Order Blocks
   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime != lastBarTime)
   {
      lastBarTime = currentBarTime;
      ScanForOrderBlocks();
   }

   // 2. Chequeo de mitigación y disparo de órdenes en tiempo real
   CheckMitigationAndExecution();

   // 3. Gestión de posición (Break-Even si está configurado)
   ManageBreakEven();

   // 4. Panel visual
   UpdateDashboard();
}
//+------------------------------------------------------------------+
