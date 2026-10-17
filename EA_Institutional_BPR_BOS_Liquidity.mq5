//+------------------------------------------------------------------+
//|                                EA_Institutional_BPR_BOS_Liquidity.mq5 |
//|          Estrategia Cuantitativa Institucional: BSL/SSL + BOS + BPR |
//|           Diseñado para Optimización en MT5 Strategy Tester (Prop Firms) |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab"
#property link      "https://github.com/telegram-mtproto"
#property version   "3.00"
#property description "EA Institucional para Backtesting en MT5"
#property description "Mecánica ICT: Barrido de Liquidez (BSL/SSL) + BOS + Retest BPR (CE 50%)"
#property description "Parámetros optimizables: Ratios R:R, Break-Even, Trailing y Sesiones"

#include <Trade\Trade.mqh>

//--- ENUMS ---
enum ENUM_ENTRY_TRIGGER
{
   ENTRY_TOUCH_BPR,   // Retest al borde de la caja BPR
   ENTRY_CE_50        // Consequent Encroachment 50% de la caja BPR (Mayor R:R)
};

enum ENUM_RISK_MODE
{
   RISK_PERCENT,      // Porcentaje de Riesgo (% Balance)
   RISK_FIXED_LOT     // Lotaje Fijo
};

enum ENUM_BOS_BIAS
{
   BIAS_NONE,
   BIAS_BULLISH,
   BIAS_BEARISH
};

//--- INPUT PARAMETERS ---
// 1. GESTIÓN DE RIESGO Y CAPITAL
input group "=== 1. GESTIÓN DE RIESGO & CAPITAL ===";
input ENUM_RISK_MODE InpRiskMode             = RISK_PERCENT;  // Modo de Riesgo
input double         InpRiskPercent          = 1.0;           // Riesgo por Operación (% Balance)
input double         InpFixedLotSize         = 0.01;          // Lotaje Fijo (si modo es RISK_FIXED_LOT)
input double         InpRiskRewardRatio      = 2.0;           // Ratio Riesgo/Beneficio (1:2.0 Calibrado)
input int            InpMaxOpenTrades        = 1;             // Máximo de operaciones activas simultáneas
input double         InpMaxSpreadPoints      = 40.0;          // Spread máximo permitido (en puntos)

// 2. FILTROS INSTITUCIONALES (BSL / SSL + BOS + BPR)
input group "=== 2. MECÁNICA ICT: BSL/SSL + BOS + BPR ===";
input bool           InpRequireLiquiditySweep= true;          // Exigir Barrido de Liquidez Previo (BSL/SSL Sweep)
input int            InpSwingLookback        = 8;             // Lookback para Swings BSL / SSL (Fractales)
input ENUM_ENTRY_TRIGGER InpEntryTrigger     = ENTRY_CE_50;   // Tipo de Entrada (CE 50% o Toque de Caja)
input bool           InpRequireRejectionWick = true;          // Exigir Vela de Rechazo (Mecha >= 20%)
input double         InpMinWickPercent       = 20.0;          // Porcentaje Mínimo de Mecha de Rechazo (%)
input ENUM_TIMEFRAMES InpWickTimeframe       = PERIOD_CURRENT;// Temporalidad de Gatillo de Mecha (PERIOD_CURRENT o PERIOD_M2)
input int            InpAtrPeriod            = 14;            // Periodo ATR
input double         InpMinFvgAtrMult        = 0.20;          // Tamaño mínimo de cada FVG (en múltiplos ATR)
input double         InpMinOverlapAtrMult    = 0.15;          // Solape mínimo BPR entre FVG Alcista y Bajista (ATR)
input double         InpSlBufferAtrMult      = 0.20;          // Buffer de aire tras la caja BPR (en ATR)
input double         InpMinSlPoints          = 150.0;         // SL Mínimo en puntos (150 pts = 15 pips Oro, 50 pts Forex)
input double         InpMaxSlPoints          = 300.0;         // SL Máximo en puntos (300 pts = 30 pips Oro, 120 pts Forex)
input int            InpZoneExpirationBars   = 150;           // Caducidad de la zona BPR en barras si no es mitigada (150 barras)

// 3. GESTIÓN DINÁMICA DE SALIDA (BREAK-EVEN & TRAILING)
input group "=== 3. GESTIÓN DE SALIDA & PROTECCIÓN ===";
input bool           InpUseBreakEven         = false;         // Activar Break-Even (false = permitir desarrollo completo a TP)
input double         InpBreakEvenTriggerR    = 1.0;           // R de beneficio para mover a BE (ej. 1.0R)
input double         InpBreakEvenBufferPts   = 10.0;          // Buffer de ganancia sobre la entrada en BE (en puntos)
input bool           InpUseTrailing          = false;         // Activar Trailing Stop dinámico
input double         InpTrailingStartR       = 1.5;           // R de beneficio para activar el Trailing
input double         InpTrailingStepPoints   = 50.0;          // Distancia de paso del Trailing (en puntos)

// 4. FILTRO DE SESIONES HORARIAS
input group "=== 4. FILTRO DE SESIONES (SERVER TIME) ===";
input bool           InpUseSessionFilter     = true;          // Activar Filtro de Horario Operativo
input int            InpSessionStartHour     = 8;             // Hora Inicio Servidor (08:00 Broker = Sesión Europea)
input int            InpSessionEndHour       = 22;            // Hora Fin Servidor (22:00 Broker = Cierre Wall Street)

// 5. AJUSTES TÉCNICOS
input group "=== 5. AJUSTES GENERALES ===";
input ulong          InpMagicNumber          = 777001;        // Magic Number
input string         InpTradeComment         = "EA_BPR_BOS_ICT"; // Comentario de Orden
input bool           InpDrawVisuals          = true;          // Dibujar Zonas BPR y Niveles en el Gráfico

//--- STRUCTS INTERNAS ---
struct SwingPoint
{
   bool     isHigh;
   double   price;
   datetime time;
   int      barIndex;
   bool     swept;
};

struct FVGData
{
   bool     isBullish;
   double   top;
   double   bottom;
   datetime time;
};

struct BPRZoneData
{
   bool     active;
   bool     isBuy;            // true = BUY (BPR Alcista), false = SELL (BPR Bajista)
   double   top;
   double   bottom;
   double   ce50;             // Consequent Encroachment 50%
   double   slPrice;
   double   tpPrice;
   datetime creationTime;
   int      creationBar;
   string   graphicName;
};

//--- VARIABLES GLOBALES ---
CTrade         trade;
int            atrHandle;
datetime       lastProcessedBarTime = 0;
SwingPoint     activeBSL;     // Buy-Side Liquidity más reciente
SwingPoint     activeSSL;     // Sell-Side Liquidity más reciente
bool           bslSweptRecent = false;
bool           sslSweptRecent = false;
ENUM_BOS_BIAS  currentBosBias = BIAS_NONE;
BPRZoneData    bprZones[];

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetMarginMode();
   trade.SetTypeFillingBySymbol(_Symbol);

   atrHandle = iATR(_Symbol, PERIOD_CURRENT, InpAtrPeriod);
   if(atrHandle == INVALID_HANDLE)
   {
      Print("❌ Error al crear indicador ATR");
      return INIT_FAILED;
   }

   ArrayResize(bprZones, 0);
   Print("🚀 [EA BPR BOS Liquidity] Inicializado con éxito en ", _Symbol, " | R:R objetivo: 1:", DoubleToString(InpRiskRewardRatio, 1));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(atrHandle);
   if(InpDrawVisuals)
   {
      ObjectsDeleteAll(0, "BPR_");
   }
}

//+------------------------------------------------------------------+
//| Cálculo Dinámico de Lotaje por Distancia al Stop Loss            |
//+------------------------------------------------------------------+
double CalculateLotSize(double entryPrice, double slPrice)
{
   if(InpRiskMode == RISK_FIXED_LOT)
   {
      return InpFixedLotSize;
   }

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskUSD = balance * (InpRiskPercent / 100.0);
   double slPoints = MathAbs(entryPrice - slPrice) / _Point;

   if(slPoints <= 0.0) return SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double pointVal  = (tickSize > 0) ? (tickValue * (_Point / tickSize)) : tickValue;

   if(pointVal <= 0.0) pointVal = 1.0;

   double riskPerLot = slPoints * pointVal;
   if(riskPerLot <= 0.0) return SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   double calculatedLot = riskUSD / riskPerLot;

   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   calculatedLot = MathFloor(calculatedLot / lotStep) * lotStep;
   if(calculatedLot < minLot) calculatedLot = minLot;
   if(calculatedLot > maxLot) calculatedLot = maxLot;

   return NormalizeDouble(calculatedLot, 2);
}

//+------------------------------------------------------------------+
//| Comprobación de Filtro Horario                                   |
//+------------------------------------------------------------------+
bool IsInTradingSession()
{
   if(!InpUseSessionFilter) return true;

   MqlDateTime dt;
   TimeCurrent(dt);

   if(InpSessionStartHour <= InpSessionEndHour)
      return (dt.hour >= InpSessionStartHour && dt.hour <= InpSessionEndHour);
   else
      return (dt.hour >= InpSessionStartHour || dt.hour <= InpSessionEndHour);
}

//+------------------------------------------------------------------+
//| Conteo de Operaciones Activas del EA                             |
//+------------------------------------------------------------------+
int CountOpenPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol)
      {
         ulong magic = PositionGetInteger(POSITION_MAGIC);
         if(magic == InpMagicNumber) count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Gestión de Break-Even y Trailing Stop                            |
//+------------------------------------------------------------------+
void ManageOpenTrades()
{
   if(!InpUseBreakEven && !InpUseTrailing) return;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;

      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != InpMagicNumber)
         continue;

      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSL = PositionGetDouble(POSITION_SL);
      double currentTP = PositionGetDouble(POSITION_TP);
      ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double originalRiskPts = 0.0;
      if(currentSL > 0) originalRiskPts = MathAbs(openPrice - currentSL) / _Point;
      if(originalRiskPts <= 0) continue;

      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double currentPrice = (type == POSITION_TYPE_BUY) ? bid : ask;
      double profitPoints = (type == POSITION_TYPE_BUY) ? (currentPrice - openPrice) / _Point : (openPrice - currentPrice) / _Point;

      double currentR = profitPoints / originalRiskPts;

      // 1. Break-Even Check
      if(InpUseBreakEven && currentR >= InpBreakEvenTriggerR)
      {
         double bePrice = 0.0;
         if(type == POSITION_TYPE_BUY)
         {
            bePrice = NormalizeDouble(openPrice + (InpBreakEvenBufferPts * _Point), _Digits);
            if(currentSL < bePrice)
            {
               trade.PositionModify(ticket, bePrice, currentTP);
               Print("🛡️ [BREAK-EVEN ACTIVADO] BUY Ticket #", ticket, " SL movido a Entrada + Buffer: ", bePrice);
            }
         }
         else if(type == POSITION_TYPE_SELL)
         {
            bePrice = NormalizeDouble(openPrice - (InpBreakEvenBufferPts * _Point), _Digits);
            if(currentSL > bePrice || currentSL == 0.0)
            {
               trade.PositionModify(ticket, bePrice, currentTP);
               Print("🛡️ [BREAK-EVEN ACTIVADO] SELL Ticket #", ticket, " SL movido a Entrada + Buffer: ", bePrice);
            }
         }
      }

      // 2. Trailing Stop Check
      if(InpUseTrailing && currentR >= InpTrailingStartR)
      {
         double trailingStep = InpTrailingStepPoints * _Point;
         if(type == POSITION_TYPE_BUY)
         {
            double newSL = NormalizeDouble(bid - trailingStep, _Digits);
            if(newSL > currentSL && newSL > openPrice)
            {
               trade.PositionModify(ticket, newSL, currentTP);
            }
         }
         else if(type == POSITION_TYPE_SELL)
         {
            double newSL = NormalizeDouble(ask + trailingStep, _Digits);
            if((newSL < currentSL || currentSL == 0.0) && newSL < openPrice)
            {
               trade.PositionModify(ticket, newSL, currentTP);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Detección de BSL / SSL, BOS y BPR al Completar Cada Vela         |
//+------------------------------------------------------------------+
void OnNewBarScan()
{
   int requiredBars = InpSwingLookback * 4 + 160;
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_CURRENT, 0, requiredBars, rates) < requiredBars) return;

   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(atrHandle, 0, 0, 3, atr) < 3) return;

   // 1. Escaneo de Swings BSL (Highs) y SSL (Lows)
   for(int i = InpSwingLookback + 1; i <= InpSwingLookback * 3; i++)
   {
      bool isHigh = true;
      bool isLow  = true;

      for(int k = 1; k <= InpSwingLookback; k++)
      {
         if(rates[i].high <= rates[i - k].high || rates[i].high <= rates[i + k].high) isHigh = false;
         if(rates[i].low >= rates[i - k].low || rates[i].low >= rates[i + k].low)   isLow = false;
      }

      if(isHigh && (activeBSL.price == 0 || rates[i].time > activeBSL.time))
      {
         activeBSL.isHigh   = true;
         activeBSL.price    = rates[i].high;
         activeBSL.time     = rates[i].time;
         activeBSL.barIndex = i;
         activeBSL.swept    = false;
      }

      if(isLow && (activeSSL.price == 0 || rates[i].time > activeSSL.time))
      {
         activeSSL.isHigh   = false;
         activeSSL.price    = rates[i].low;
         activeSSL.time     = rates[i].time;
         activeSSL.barIndex = i;
         activeSSL.swept    = false;
      }
   }

   // 2. Comprobar Barrido de Liquidez (Liquidity Sweep) en la vela 1 o 2
   if(activeBSL.price > 0 && !activeBSL.swept)
   {
      if(rates[1].high > activeBSL.price)
      {
         bslSweptRecent = true;
         activeBSL.swept = true;
         Print("🎯 [BSL BARRIDO] Buy-Side Liquidity tomada en ", activeBSL.price, " por mecha de vela");
      }
   }

   if(activeSSL.price > 0 && !activeSSL.swept)
   {
      if(rates[1].low < activeSSL.price)
      {
         sslSweptRecent = true;
         activeSSL.swept = true;
         Print("🎯 [SSL BARRIDO] Sell-Side Liquidity tomada en ", activeSSL.price, " por mecha de vela");
      }
   }

   // 3. Comprobar Ruptura de Estructura (BOS)
   if(activeBSL.price > 0 && rates[1].close > activeBSL.price && rates[2].close <= activeBSL.price)
   {
      // BOS Alcista: Si se requiere barrido de SSL previo, verificar
      if(!InpRequireLiquiditySweep || sslSweptRecent)
      {
         currentBosBias = BIAS_BULLISH;
         Print("⚡ [BOS ALCISTA CONFIRMADO] Ruptura de BSL previa tras barrido SSL. Sesgo: COMPRAS");
      }
   }
   else if(activeSSL.price > 0 && rates[1].close < activeSSL.price && rates[2].close >= activeSSL.price)
   {
      // BOS Bajista: Si se requiere barrido de BSL previo, verificar
      if(!InpRequireLiquiditySweep || bslSweptRecent)
      {
         currentBosBias = BIAS_BEARISH;
         Print("⚡ [BOS BAJISTA CONFIRMADO] Ruptura de SSL previa tras barrido BSL. Sesgo: VENTAS");
      }
   }

   // 4. Detección de Fair Value Gaps (FVG)
   FVGData fvgBullish[];
   FVGData fvgBearish[];
   ArrayResize(fvgBullish, 0);
   ArrayResize(fvgBearish, 0);

   int scanDepth = MathMin(150, requiredBars - 3);
   for(int i = 1; i < scanDepth; i++)
   {
      // Bullish FVG
      if(rates[i].low > rates[i + 2].high)
      {
         double gap = rates[i].low - rates[i + 2].high;
         if(gap >= InpMinFvgAtrMult * atr[1])
         {
            int s = ArraySize(fvgBullish);
            ArrayResize(fvgBullish, s + 1);
            fvgBullish[s].isBullish = true;
            fvgBullish[s].top       = rates[i].low;
            fvgBullish[s].bottom    = rates[i + 2].high;
            fvgBullish[s].time      = rates[i].time;
         }
      }

      // Bearish FVG
      if(rates[i].high < rates[i + 2].low)
      {
         double gap = rates[i + 2].low - rates[i].high;
         if(gap >= InpMinFvgAtrMult * atr[1])
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

   // 5. Creación de Zona BPR Real (Solape entre FVG Alcista y Bajista)
   for(int b = 0; b < ArraySize(fvgBullish); b++)
   {
      for(int s = 0; s < ArraySize(fvgBearish); s++)
      {
         double overlapTop = MathMin(fvgBullish[b].top, fvgBearish[s].top);
         double overlapBottom = MathMax(fvgBullish[b].bottom, fvgBearish[s].bottom);

         if(overlapTop > overlapBottom && (overlapTop - overlapBottom) >= InpMinOverlapAtrMult * atr[1])
         {
            // Solo registrar si concuerda con el sesgo BOS activo
            bool isBuyBpr = (currentBosBias == BIAS_BULLISH);
            bool isSellBpr = (currentBosBias == BIAS_BEARISH);

            if(isBuyBpr || isSellBpr)
            {
               // Evitar registrar zonas duplicadas
               bool duplicate = false;
               for(int z = 0; z < ArraySize(bprZones); z++)
               {
                  if(bprZones[z].active && MathAbs(bprZones[z].top - overlapTop) < (5 * _Point))
                  {
                     duplicate = true;
                     break;
                  }
               }

               if(!duplicate)
               {
                  BPRZoneData zone;
                  zone.active       = true;
                  zone.isBuy        = isBuyBpr;
                  zone.top          = overlapTop;
                  zone.bottom       = overlapBottom;
                  zone.ce50         = NormalizeDouble((overlapTop + overlapBottom) / 2.0, _Digits);
                  zone.creationTime = TimeCurrent();
                  zone.creationBar  = 0;

                  // Stop Loss anclado directamente a la caja BPR + Buffer ATR
                  double buffer = InpSlBufferAtrMult * atr[1];
                  double minSlDist = InpMinSlPoints * _Point;
                  double maxSlDist = InpMaxSlPoints * _Point;

                  if(isBuyBpr)
                  {
                     double slRef = overlapBottom;
                     zone.slPrice = NormalizeDouble(slRef - buffer, _Digits);

                     double currentDist = MathAbs(zone.ce50 - zone.slPrice);
                     if(currentDist < minSlDist) zone.slPrice = NormalizeDouble(zone.ce50 - minSlDist, _Digits);
                     else if(currentDist > maxSlDist) zone.slPrice = NormalizeDouble(zone.ce50 - maxSlDist, _Digits);

                     double riskDist = MathAbs(zone.ce50 - zone.slPrice);
                     zone.tpPrice = NormalizeDouble(zone.ce50 + (riskDist * InpRiskRewardRatio), _Digits);
                     zone.graphicName = "BPR_BUY_" + TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES);
                  }
                  else
                  {
                     double slRef = overlapTop;
                     zone.slPrice = NormalizeDouble(slRef + buffer, _Digits);

                     double currentDist = MathAbs(zone.slPrice - zone.ce50);
                     if(currentDist < minSlDist) zone.slPrice = NormalizeDouble(zone.ce50 + minSlDist, _Digits);
                     else if(currentDist > maxSlDist) zone.slPrice = NormalizeDouble(zone.ce50 - maxSlDist, _Digits);

                     double riskDist = MathAbs(zone.slPrice - zone.ce50);
                     zone.tpPrice = NormalizeDouble(zone.ce50 - (riskDist * InpRiskRewardRatio), _Digits);
                     zone.graphicName = "BPR_SELL_" + TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES);
                  }

                  int size = ArraySize(bprZones);
                  ArrayResize(bprZones, size + 1);
                  bprZones[size] = zone;

                  Print("💎 [BPR REAL CREADO] Tipo: ", isBuyBpr ? "BUY" : "SELL",
                        " | Rango: ", overlapBottom, " - ", overlapTop,
                        " | CE 50%: ", zone.ce50,
                        " | SL: ", zone.slPrice,
                        " | TP (R:R 1:", DoubleToString(InpRiskRewardRatio, 1), "): ", zone.tpPrice);

                  if(InpDrawVisuals)
                  {
                     ObjectCreate(0, zone.graphicName, OBJ_RECTANGLE, 0, rates[1].time, zone.top, TimeCurrent() + 14400, zone.bottom);
                     ObjectSetInteger(0, zone.graphicName, OBJPROP_COLOR, isBuyBpr ? clrTeal : clrMaroon);
                     ObjectSetInteger(0, zone.graphicName, OBJPROP_STYLE, STYLE_SOLID);
                     ObjectSetInteger(0, zone.graphicName, OBJPROP_FILL, true);
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Ejecución de Retest a Mercado de Zonas BPR en Cada Tick         |
//+------------------------------------------------------------------+
void CheckRetestAndExecute()
{
   if(!IsInTradingSession()) return;
   if(CountOpenPositions() >= InpMaxOpenTrades) return;

   long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if((double)spread > InpMaxSpreadPoints) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   for(int z = 0; z < ArraySize(bprZones); z++)
   {
      if(!bprZones[z].active) continue;

      // Caducidad de zona
      bprZones[z].creationBar++;
      if(bprZones[z].creationBar > InpZoneExpirationBars)
      {
         bprZones[z].active = false;
         continue;
      }

      double entryTriggerPrice = (InpEntryTrigger == ENTRY_CE_50) ? bprZones[z].ce50 : (bprZones[z].isBuy ? bprZones[z].top : bprZones[z].bottom);

      // Filtro de Mecha de Rechazo Institucional (M2 / M3 / M5)
      if(InpRequireRejectionWick)
      {
         MqlRates wickRates[2];
         ENUM_TIMEFRAMES tfToUse = InpWickTimeframe;
         int copied = CopyRates(_Symbol, tfToUse, 0, 2, wickRates);
         if(copied < 2)
         {
            tfToUse = PERIOD_CURRENT;
            copied = CopyRates(_Symbol, tfToUse, 0, 2, wickRates);
         }

         if(copied >= 2)
         {
            bool hasWickRejection = false;
            for(int r = 0; r < copied; r++)
            {
               double candleRange = wickRates[r].high - wickRates[r].low;
               if(candleRange > 0)
               {
                  if(bprZones[z].isBuy)
                  {
                     double lowerWick = MathMin(wickRates[r].open, wickRates[r].close) - wickRates[r].low;
                     if((lowerWick / candleRange) * 100.0 >= InpMinWickPercent) hasWickRejection = true;
                  }
                  else
                  {
                     double upperWick = wickRates[r].high - MathMax(wickRates[r].open, wickRates[r].close);
                     if((upperWick / candleRange) * 100.0 >= InpMinWickPercent) hasWickRejection = true;
                  }
               }
            }
            if(!hasWickRejection) continue; // Esperar a que se confirme el rechazo institucional
         }
      }

      // RETEST COMPRA (BUY)
      if(bprZones[z].isBuy)
      {
         if(bid <= entryTriggerPrice && ask >= bprZones[z].slPrice)
         {
            double lot = CalculateLotSize(ask, bprZones[z].slPrice);
            if(lot > 0)
            {
               double riskDist = MathAbs(ask - bprZones[z].slPrice);
               double tpPrice = NormalizeDouble(ask + (riskDist * InpRiskRewardRatio), _Digits);

               if(trade.Buy(lot, _Symbol, ask, bprZones[z].slPrice, tpPrice, InpTradeComment))
               {
                  Print("🚀 [ORDEN BUY EJECUTADA] BPR CE 50% con Rechazo Confirmado: ", ask, " | SL: ", bprZones[z].slPrice, " | TP: ", tpPrice, " | Lotes: ", lot);
                  bprZones[z].active = false;
                  sslSweptRecent = false; // Reset de liquidez usada
                  return;
               }
            }
         }
      }
      // RETEST VENTA (SELL)
      else
      {
         if(ask >= entryTriggerPrice && bid <= bprZones[z].slPrice)
         {
            double lot = CalculateLotSize(bid, bprZones[z].slPrice);
            if(lot > 0)
            {
               double riskDist = MathAbs(bprZones[z].slPrice - bid);
               double tpPrice = NormalizeDouble(bid - (riskDist * InpRiskRewardRatio), _Digits);

               if(trade.Sell(lot, _Symbol, bid, bprZones[z].slPrice, tpPrice, InpTradeComment))
               {
                  Print("🚀 [ORDEN SELL EJECUTADA] BPR CE 50% con Rechazo Confirmado: ", bid, " | SL: ", bprZones[z].slPrice, " | TP: ", tpPrice, " | Lotes: ", lot);
                  bprZones[z].active = false;
                  bslSweptRecent = false; // Reset de liquidez usada
                  return;
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. Gestionar Break-Even y Trailing en Posiciones Abiertas
   ManageOpenTrades();

   // 2. Ejecutar Retests de Zonas BPR Vigentes
   CheckRetestAndExecute();

   // 3. Al Abrirse una Nueva Barra, Actualizar BSL/SSL, BOS y Zonas BPR
   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime != lastProcessedBarTime)
   {
      lastProcessedBarTime = currentBarTime;
      OnNewBarScan();
   }
}
//+------------------------------------------------------------------+
