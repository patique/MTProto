//+------------------------------------------------------------------+
//|                                EA_Crypto_Institutional_BPR.mq5   |
//|          Estrategia Cuantitativa Institucional Cripto (BTC/ETH)  |
//|       Optimización Genética en MT5 Strategy Tester (Prop Firms)  |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab"
#property link      "https://github.com/telegram-mtproto"
#property version   "3.10"
#property description "EA Institucional BPR/BOS Especializado para Criptoactivos (BTCUSD / ETHUSD)"
#property description "Diseñado para Optimización Genética Rápida en MT5 Strategy Tester"

#include <Trade\Trade.mqh>

//--- ENUMS ---
enum ENUM_ENTRY_TRIGGER
{
   ENTRY_TOUCH_BPR,   // Retest al borde de la caja BPR
   ENTRY_CE_50        // Consequent Encroachment 50% de la caja BPR
};

enum ENUM_RISK_MODE
{
   RISK_PERCENT,      // Porcentaje de Riesgo (% Balance)
   RISK_FIXED_LOT     // Lotaje Fijo
};

enum ENUM_CRYPTO_SCHEDULE
{
   CRYPTO_24_7,          // Operar 24/7 (Lunes a Domingo continuo)
   CRYPTO_WEEKDAYS_ONLY, // Solo días de semana (Lunes a Viernes, evita spreads de fin de semana)
   CRYPTO_WEEKENDS_ONLY  // Solo fines de semana (Sábado y Domingo, laboratorio de testing)
};

enum ENUM_BOS_BIAS
{
   BIAS_NONE,
   BIAS_BULLISH,
   BIAS_BEARISH
};

//--- INPUT PARAMETERS (Optimizables en Tester) ---
// 1. GESTIÓN DE RIESGO
input group "=== 1. GESTIÓN DE RIESGO & CAPITAL ===";
input ENUM_RISK_MODE       InpRiskMode             = RISK_PERCENT;     // Modo de Riesgo
input double               InpRiskPercent          = 0.50;             // Riesgo por Operación (% Balance)
input double               InpFixedLotSize         = 0.01;             // Lotaje Fijo (si RISK_FIXED_LOT)
input double               InpRiskRewardRatio      = 2.5;              // Ratio R:R (1:2.5 óptimo inicial)
input int                  InpMaxOpenTrades        = 1;                // Máximo operaciones simultáneas
input double               InpMaxSpreadPoints      = 3500.0;           // Spread máximo en puntos (ej. 3500 pts = $35 en BTC)
input double               InpSpreadAtrMaxMult     = 0.15;             // Spread máximo como fracción de ATR (0 = desactiva)

// 2. HORARIO Y FILTRO CRIPTO
input group "=== 2. CALENDARIO Y SESIÓN CRIPTO ===";
input ENUM_CRYPTO_SCHEDULE InpCryptoSchedule       = CRYPTO_WEEKDAYS_ONLY; // Régimen Operativo Cripto
input bool                 InpUseHourFilter        = true;             // Activar filtro horario diario
input int                  InpStartHourServer      = 4;                // Hora Inicio Servidor (04:00 Broker = 03:00 AM España)
input int                  InpEndHourServer        = 23;               // Hora Fin Servidor (23:55 Broker = 22:55 PM España)

// 3. MECÁNICA ICT BSL/SSL + BOS + BPR
input group "=== 3. ICT SETUP: BSL/SSL + BOS + BPR ===";
input bool                 InpRequireLiquiditySweep= true;             // Exigir Barrido Previo de Liquidez (BSL/SSL)
input int                  InpSwingLookback        = 8;                // Lookback para Swings (Fractales)
input ENUM_ENTRY_TRIGGER   InpEntryTrigger         = ENTRY_CE_50;      // Gatillo de Entrada (CE 50% vs Toque)
input bool                 InpRequireRejectionWick = true;             // Exigir Vela de Rechazo
input double               InpMinWickPercent       = 20.0;             // Mecha mínima de rechazo (%)
input ENUM_TIMEFRAMES      InpWickTimeframe        = PERIOD_M2;        // Temporalidad confirmación de mecha
input int                  InpAtrPeriod            = 14;               // Periodo ATR
input double               InpMinFvgAtrMult        = 0.25;             // Tamaño mínimo de cada FVG (ATR)
input double               InpMinOverlapAtrMult    = 0.18;             // Solape mínimo BPR (ATR)
input double               InpSlBufferAtrMult      = 0.20;             // Buffer de SL tras el Swing (ATR)
input int                  InpZoneExpirationBars   = 120;              // Caducidad de la zona en barras

// 4. FILTRO DE TENDENCIA INSTITUCIONAL (EMA)
input group "=== 4. FILTRO DE MACRO TENDENCIA ===";
input bool                 InpUseEmaTrendFilter    = true;             // Filtrar compras/ventas por EMA Macro
input int                  InpEmaPeriod            = 200;              // Periodo de la EMA Macro

// 5. GESTIÓN DE SALIDA & PROTECCIÓN
input group "=== 5. PROTECCIÓN & TRAILING ===";
input bool                 InpUseBreakEven         = true;             // Activar Break-Even
input double               InpBreakEvenTriggerR    = 1.0;              // R para mover a Break-Even (ej. 1.0R)
input double               InpBreakEvenBufferPts   = 100.0;            // Buffer en puntos sobre la entrada
input bool                 InpUseTrailing          = false;            // Activar Trailing Stop
input double               InpTrailingStartR       = 1.8;              // R para iniciar Trailing
input double               InpTrailingStepPoints   = 500.0;            // Distancia de paso del Trailing

// 6. AJUSTES GENERALES
input group "=== 6. AJUSTES GENERALES ===";
input ulong                InpMagicNumber          = 777099;           // Magic Number
input string               InpTradeComment         = "BPR_CRYPTO_ICT"; // Comentario
input bool                 InpDrawVisuals          = true;             // Dibujar zonas en el gráfico

//--- STRUCTS ---
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
   bool     isBuy;
   double   top;
   double   bottom;
   double   ce50;
   double   slPrice;
   double   tpPrice;
   datetime creationTime;
   int      creationBar;
   string   graphicName;
};

//--- GLOBALES ---
CTrade         trade;
int            atrHandle;
int            emaHandle;
datetime       lastProcessedBarTime = 0;
SwingPoint     activeBSL;
SwingPoint     activeSSL;
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
   trade.SetDeviationInPoints(200);
   trade.SetTypeFillingBySymbol(_Symbol);

   atrHandle = iATR(_Symbol, PERIOD_CURRENT, InpAtrPeriod);
   if(atrHandle == INVALID_HANDLE)
   {
      Print("❌ Error al crear indicador ATR");
      return INIT_FAILED;
   }

   if(InpUseEmaTrendFilter)
   {
      emaHandle = iMA(_Symbol, PERIOD_CURRENT, InpEmaPeriod, 0, MODE_EMA, PRICE_CLOSE);
      if(emaHandle == INVALID_HANDLE)
      {
         Print("❌ Error al crear indicador EMA");
         return INIT_FAILED;
      }
   }

   activeBSL.price = 0; activeBSL.swept = false;
   activeSSL.price = 0; activeSSL.swept = false;
   ArrayResize(bprZones, 0);

   Print("🚀 [EA CRYPTO INSTITUTIONAL BPR] Inicializado correctamente en ", _Symbol);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(atrHandle != INVALID_HANDLE) IndicatorRelease(atrHandle);
   if(emaHandle != INVALID_HANDLE) IndicatorRelease(emaHandle);
   if(InpDrawVisuals) ObjectsDeleteAll(0, "BPR_CRYPTO_");
}

//+------------------------------------------------------------------+
//| Filtro de Horario y Calendario Cripto                            |
//+------------------------------------------------------------------+
bool IsCryptoTradingAllowed()
{
   MqlDateTime dt;
   TimeCurrent(dt);

   // 1. Filtro de Días (Régimen Operativo Cripto)
   // day_of_week: 0 = Domingo, 6 = Sábado
   bool isWeekend = (dt.day_of_week == 0 || dt.day_of_week == 6);

   if(InpCryptoSchedule == CRYPTO_WEEKDAYS_ONLY && isWeekend)
      return false;

   if(InpCryptoSchedule == CRYPTO_WEEKENDS_ONLY && !isWeekend)
      return false;

   // 2. Filtro Horario Intradiario
   if(InpUseHourFilter)
   {
      if(InpStartHourServer <= InpEndHourServer)
      {
         if(dt.hour < InpStartHourServer || dt.hour > InpEndHourServer) return false;
      }
      else
      {
         if(dt.hour < InpStartHourServer && dt.hour > InpEndHourServer) return false;
      }
   }

   return true;
}

//+------------------------------------------------------------------+
//| Cálculo Dinámico de Lotaje                                       |
//+------------------------------------------------------------------+
double CalculateLotSize(double entryPrice, double slPrice)
{
   if(InpRiskMode == RISK_FIXED_LOT) return InpFixedLotSize;

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
//| Conteo de Operaciones Activas del EA                             |
//+------------------------------------------------------------------+
int CountOpenPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol)
      {
         if(PositionGetInteger(POSITION_MAGIC) == InpMagicNumber) count++;
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
         double beTargetPrice = (type == POSITION_TYPE_BUY) ? 
            openPrice + (InpBreakEvenBufferPts * _Point) : 
            openPrice - (InpBreakEvenBufferPts * _Point);

         bool needsBE = (type == POSITION_TYPE_BUY) ? (currentSL < openPrice) : (currentSL > openPrice || currentSL == 0);

         if(needsBE)
         {
            trade.PositionModify(ticket, NormalizeDouble(beTargetPrice, _Digits), currentTP);
            Print("🛡️ [CRYPTO BREAK-EVEN ACTIVADO] Ticket #", ticket, " asegurado a +", InpBreakEvenBufferPts, " pts");
            continue;
         }
      }

      // 2. Trailing Stop
      if(InpUseTrailing && currentR >= InpTrailingStartR)
      {
         double newSL = 0.0;
         if(type == POSITION_TYPE_BUY)
         {
            newSL = NormalizeDouble(bid - (InpTrailingStepPoints * _Point), _Digits);
            if(newSL > currentSL && newSL > openPrice)
               trade.PositionModify(ticket, newSL, currentTP);
         }
         else
         {
            newSL = NormalizeDouble(ask + (InpTrailingStepPoints * _Point), _Digits);
            if((newSL < currentSL || currentSL == 0) && newSL < openPrice)
               trade.PositionModify(ticket, newSL, currentTP);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Detección de Swings BSL / SSL                                    |
//+------------------------------------------------------------------+
void DetectSwings(const MqlRates &rates[], int totalBars)
{
   int k = InpSwingLookback;
   for(int i = k + 1; i < totalBars - k - 1; i++)
   {
      bool isHigh = true;
      bool isLow  = true;

      for(int j = 1; j <= k; j++)
      {
         if(rates[i].high <= rates[i - j].high || rates[i].high <= rates[i + j].high) isHigh = false;
         if(rates[i].low >= rates[i - j].low || rates[i].low >= rates[i + j].low) isLow = false;
      }

      if(isHigh && (rates[i].high > activeBSL.price || activeBSL.price == 0))
      {
         activeBSL.isHigh   = true;
         activeBSL.price    = rates[i].high;
         activeBSL.time     = rates[i].time;
         activeBSL.barIndex = i;
         activeBSL.swept    = false;
      }

      if(isLow && (rates[i].low < activeSSL.price || activeSSL.price == 0))
      {
         activeSSL.isHigh   = false;
         activeSSL.price    = rates[i].low;
         activeSSL.time     = rates[i].time;
         activeSSL.barIndex = i;
         activeSSL.swept    = false;
      }
   }
}

//+------------------------------------------------------------------+
//| Escaneo Cuantitativo en Nueva Barra                              |
//+------------------------------------------------------------------+
void OnNewBarScan()
{
   if(!IsCryptoTradingAllowed()) return;

   int barsToScan = 80;
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_CURRENT, 0, barsToScan, rates) < barsToScan) return;

   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(atrHandle, 0, 0, 5, atr) < 5) return;

   double emaVal = 0.0;
   if(InpUseEmaTrendFilter)
   {
      double emaBuf[];
      ArraySetAsSeries(emaBuf, true);
      if(CopyBuffer(emaHandle, 0, 0, 2, emaBuf) >= 2)
         emaVal = emaBuf[1];
   }

   // 1. Detección de Swings
   DetectSwings(rates, barsToScan);

   // 2. Barrido de Liquidez
   if(activeBSL.price > 0 && !activeBSL.swept)
   {
      if(rates[1].high > activeBSL.price && rates[1].close < activeBSL.price)
      {
         activeBSL.swept = true;
         bslSweptRecent = true;
         sslSweptRecent = false;
      }
   }

   if(activeSSL.price > 0 && !activeSSL.swept)
   {
      if(rates[1].low < activeSSL.price && rates[1].close > activeSSL.price)
      {
         activeSSL.swept = true;
         sslSweptRecent = true;
         bslSweptRecent = false;
      }
   }

   // 3. Estructura BOS
   if(sslSweptRecent || !InpRequireLiquiditySweep)
   {
      if(rates[1].close > rates[2].high && rates[2].close > rates[3].high)
      {
         if(!InpUseEmaTrendFilter || (emaVal > 0 && rates[1].close > emaVal))
            currentBosBias = BIAS_BULLISH;
      }
   }

   if(bslSweptRecent || !InpRequireLiquiditySweep)
   {
      if(rates[1].close < rates[2].low && rates[2].close < rates[3].low)
      {
         if(!InpUseEmaTrendFilter || (emaVal > 0 && rates[1].close < emaVal))
            currentBosBias = BIAS_BEARISH;
      }
   }

   // 4. Identificación de FVGs
   FVGData fvgBullish[];
   FVGData fvgBearish[];
   ArrayResize(fvgBullish, 0);
   ArrayResize(fvgBearish, 0);

   for(int i = 1; i < 25; i++)
   {
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

   // 5. Creación de BPR (Solape)
   for(int b = 0; b < ArraySize(fvgBullish); b++)
   {
      for(int s = 0; s < ArraySize(fvgBearish); s++)
      {
         double overlapTop = MathMin(fvgBullish[b].top, fvgBearish[s].top);
         double overlapBottom = MathMax(fvgBullish[b].bottom, fvgBearish[s].bottom);

         if(overlapTop > overlapBottom && (overlapTop - overlapBottom) >= InpMinOverlapAtrMult * atr[1])
         {
            bool isBuyBpr = (currentBosBias == BIAS_BULLISH);
            bool isSellBpr = (currentBosBias == BIAS_BEARISH);

            if(isBuyBpr || isSellBpr)
            {
               bool duplicate = false;
               for(int z = 0; z < ArraySize(bprZones); z++)
               {
                  if(bprZones[z].active && MathAbs(bprZones[z].top - overlapTop) < (50 * _Point))
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

                  double buffer = InpSlBufferAtrMult * atr[1];
                  if(isBuyBpr)
                  {
                     double slRef = (activeSSL.price > 0) ? activeSSL.price : overlapBottom;
                     zone.slPrice = NormalizeDouble(slRef - buffer, _Digits);
                     double riskDist = MathAbs(zone.ce50 - zone.slPrice);
                     zone.tpPrice = NormalizeDouble(zone.ce50 + (riskDist * InpRiskRewardRatio), _Digits);
                     zone.graphicName = "BPR_CRYPTO_BUY_" + TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES);
                  }
                  else
                  {
                     double slRef = (activeBSL.price > 0) ? activeBSL.price : overlapTop;
                     zone.slPrice = NormalizeDouble(slRef + buffer, _Digits);
                     double riskDist = MathAbs(zone.slPrice - zone.ce50);
                     zone.tpPrice = NormalizeDouble(zone.ce50 - (riskDist * InpRiskRewardRatio), _Digits);
                     zone.graphicName = "BPR_CRYPTO_SELL_" + TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES);
                  }

                  int size = ArraySize(bprZones);
                  ArrayResize(bprZones, size + 1);
                  bprZones[size] = zone;

                  if(InpDrawVisuals)
                  {
                     color boxColor = isBuyBpr ? clrDodgerBlue : clrCrimson;
                     ObjectCreate(0, zone.graphicName, OBJ_RECTANGLE, 0, zone.creationTime, zone.top, zone.creationTime + (PeriodSeconds() * InpZoneExpirationBars), zone.bottom);
                     ObjectSetInteger(0, zone.graphicName, OBJPROP_COLOR, boxColor);
                     ObjectSetInteger(0, zone.graphicName, OBJPROP_FILL, true);
                     ObjectSetInteger(0, zone.graphicName, OBJPROP_BACK, true);
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Retest y Ejecución de Órdenes                                    |
//+------------------------------------------------------------------+
void CheckRetestAndExecute()
{
   if(!IsCryptoTradingAllowed()) return;
   if(CountOpenPositions() >= InpMaxOpenTrades) return;

   double spread = (double)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPoints) return;

   if(InpSpreadAtrMaxMult > 0.0)
   {
      double atrVal[];
      ArraySetAsSeries(atrVal, true);
      if(CopyBuffer(atrHandle, 0, 0, 1, atrVal) >= 1 && atrVal[0] > 0)
      {
         double spreadInPrice = spread * _Point;
         if(spreadInPrice > (InpSpreadAtrMaxMult * atrVal[0])) return;
      }
   }

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   for(int z = 0; z < ArraySize(bprZones); z++)
   {
      if(!bprZones[z].active) continue;

      bprZones[z].creationBar++;
      if(bprZones[z].creationBar > InpZoneExpirationBars)
      {
         bprZones[z].active = false;
         continue;
      }

      double entryTriggerPrice = (InpEntryTrigger == ENTRY_CE_50) ? bprZones[z].ce50 : (bprZones[z].isBuy ? bprZones[z].top : bprZones[z].bottom);

      // Confirmación de Mecha de Rechazo
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
            if(!hasWickRejection) continue;
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
                  Print("🚀 [CRYPTO BUY EJECUTADA] BPR CE 50%: ", ask, " | SL: ", bprZones[z].slPrice, " | TP: ", tpPrice, " | Lotes: ", lot);
                  bprZones[z].active = false;
                  sslSweptRecent = false;
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
                  Print("🚀 [CRYPTO SELL EJECUTADA] BPR CE 50%: ", bid, " | SL: ", bprZones[z].slPrice, " | TP: ", tpPrice, " | Lotes: ", lot);
                  bprZones[z].active = false;
                  bslSweptRecent = false;
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
   ManageOpenTrades();
   CheckRetestAndExecute();

   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime != lastProcessedBarTime)
   {
      lastProcessedBarTime = currentBarTime;
      OnNewBarScan();
   }
}

//+------------------------------------------------------------------+
//| Tester function para Optimización Genética                       |
//+------------------------------------------------------------------+
double OnTester()
{
   // Métrica de Optimización Personalizada: Profit Factor * (Net Profit / Max Drawdown)
   double netProfit = TesterStatistics(STAT_PROFIT);
   double maxDD     = TesterStatistics(STAT_EQUITY_DD);
   double trades    = TesterStatistics(STAT_TRADES);
   double profitFac = TesterStatistics(STAT_PROFIT_FACTOR);

   if(trades < 15 || maxDD <= 0 || netProfit <= 0) return 0.0;

   double recoveryFactor = netProfit / maxDD;
   return NormalizeDouble(recoveryFactor * profitFac, 4);
}
//+------------------------------------------------------------------+
