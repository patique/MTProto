//+------------------------------------------------------------------+
//|                                EA_BPR_Institutional_Sniper.mq5   |
//|                 Algorithmic Limit Trading System (BPR Multi-TF)  |
//|                 Dynamic N-Timeframe Confluence + Ratchet Lock    |
//+------------------------------------------------------------------+
#property copyright   "Antigravity Quantitative Trading"
#property link        "https://t.me/WarriorTraderClub"
#property version     "2.00"
#property description "EA institucional basado en órdenes Limit al 50% CE de BPRs con Confluencia Dinámica N-Timeframe y Trinquete de Beneficios (Ratchet)."

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>
#include <Trade\OrderInfo.mqh>

//--- ENUMERACIONES ---
enum ENUM_RISK_MODE
{
   RISK_PERCENT_BALANCE, // % del Balance (Recomendado 0.3% - 0.5%)
   RISK_PERCENT_EQUITY,  // % de la Equidad
   RISK_FIXED_USD,       // Riesgo Fijo en USD ($)
   RISK_FIXED_LOT        // Lotaje Fijo Manual
};

//--- PARÁMETROS DE ENTRADA (INPUTS) ---
input group "=== 🎯 1. CONFLUENCIA DINÁMICA MULTI-TIMEFRAME ===";
input ENUM_TIMEFRAMES      InpWorkTimeframe        = PERIOD_M15;           // Temporalidad Base de Entrada
input int                  InpBarsSince            = 10;                   // Barras de Lookback entre FVGs (bars_since)
input double               InpBprThreshold         = 0.0;                  // Umbral Mínimo de Solape en Puntos
input bool                 InpOnlyVirginBprs       = true;                 // Solo BPRs Vírgenes (No Mitigados)
input bool                 InpScanM1               = false;                // Incluir M1 en Escáner
input bool                 InpScanM5               = true;                 // Incluir M5 en Escáner
input bool                 InpScanM15              = true;                 // Incluir M15 en Escáner
input bool                 InpScanM30              = true;                 // Incluir M30 en Escáner
input bool                 InpScanH1               = true;                 // Incluir H1 en Escáner
input bool                 InpScanH4               = true;                 // Incluir H4 en Escáner
input int                  InpMinConfluences       = 2;                    // Confluencias Mínimas Requeridas (1=Todos, 2=Recomendado, 3=Ultra Alta Prob)

input group "=== ⚖️ 2. GESTIÓN DE RIESGO ASIMÉTRICO (0.3% - 0.5%) ===";
input ENUM_RISK_MODE       InpRiskMode             = RISK_PERCENT_BALANCE; // Modo de Gestión de Capital
input double               InpRiskPercent          = 0.30;                 // Riesgo por Operación (% recomendado: 0.3% o 0.5%)
input double               InpFixedRiskUSD         = 30.0;                 // Riesgo Fijo en USD (si modo Fixed USD)
input double               InpFixedLotSize         = 0.01;                 // Lotaje Fijo Manual (si modo Fixed Lot)
input double               InpSLBufferUnits        = 1.00;                 // Holgura tras el Extremo del BPR (1.00$ en Oro / Pips en FX)
input int                  InpMaxActiveTrades      = 1;                    // Máximo de Operaciones Simultáneas

input group "=== 🛡️ 3. TRINQUETE DE BENEFICIOS (RATCHET PROFIT LOCK) ===";
input bool                 InpUseRatchetLock       = true;                 // Activar Trinquete Protector de Beneficios
input double               InpBE_Trigger_R         = 1.5;                  // Nivel R para Mover a Break-Even (1:1.5R)
input double               InpBEOffsetPips         = 0.5;                  // Offset de Ganancia Asegurada en Break-Even (pips)
input double               InpLock1_Trigger_R      = 3.0;                  // Nivel R para Asegurar Nivel 1 (1:3.0R)
input double               InpLock1_Secure_R       = 1.0;                  // R Asegurado en Nivel 1 (+1.0R)
input double               InpLock2_Trigger_R      = 5.0;                  // Nivel R para Asegurar Nivel 2 (1:5.0R)
input double               InpLock2_Secure_R       = 2.5;                  // R Asegurado en Nivel 2 (+2.5R)
input double               InpFinalTarget_R        = 8.0;                  // TP Final Objetivo (1:8.0R)

input group "=== ⏱️ 4. FILTRO DE HORARIOS & EXPIRACIÓN LIMIT ===";
input bool                 InpUseSessionFilter     = true;                 // Operar Solo en Killzones
input int                  InpStartHour            = 8;                    // Hora Inicio (08:00 CET - Londres)
input int                  InpEndHour              = 21;                   // Hora Fin (21:00 CET - Cierre NY)
input int                  InpMaxBarsOrderPending  = 24;                   // Expiración de Orden Limit sin Tocar (Barras)

input group "=== 🎨 5. IDENTIFICACIÓN Y GRÁFICO ===";
input ulong                InpMagicNumber          = 991100;               // Magic Number
input string               InpTradeComment         = "BPR_SNIPER";         // Comentario
input bool                 InpDrawVisuals          = true;                 // Dibujar Zonas BPR en Gráfico
input color                InpBprBaseColor         = C'100,116,139';       // Color BPR Base (Gris Pizarra)
input color                InpConfluenceColor      = C'245,158,11';        // Color BPR Confluencia MTF (Ámbar/Oro)
input bool                 InpShowHUD              = true;                 // Mostrar Panel HUD

//--- ESTRUCTURAS INTERNAS ---
struct BPRZone
{
   double   high;
   double   low;
   double   ce50;
   datetime creationTime;
   bool     isBullishGenesis;
   int      confluenceCount;
   string   confluenceInfo;
   bool     isMitigated;
};

struct TradeTracker
{
   ulong    ticket;
   double   entryPrice;
   double   initialSL;
   double   initialLot;
   double   riskPoints;
   int      ratchetStep; // 0=Inicio, 1=BE (1.5R), 2=Lock1 (3R), 3=Lock2 (5R)
};

//--- VARIABLES GLOBALES ---
CTrade         m_trade;
CPositionInfo  m_pos;
CAccountInfo   m_acc;
COrderInfo     m_order;

BPRZone        m_activeBprs[];
TradeTracker   m_trackers[];
datetime       m_lastBarTime = 0;
string         m_objPrefix = "BPR_EA_";

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   m_trade.SetExpertMagicNumber(InpMagicNumber);
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(_Symbol);

   ArrayResize(m_activeBprs, 0);
   ArrayResize(m_trackers, 0);

   if(InpDrawVisuals)
      ObjectsDeleteAll(0, m_objPrefix);

   if(InpShowHUD)
      CreateHUD();

   EventSetMillisecondTimer(250);
   PrintFormat("🚀 [EA_BPR_Institutional_Sniper v2.0] Iniciado en %s | Base: %s | Min Confluencias: %d | Ratchet: %s",
               _Symbol, EnumToString(InpWorkTimeframe), InpMinConfluences, InpUseRatchetLock ? "ACTIVADO" : "DESACTIVADO");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   if(InpDrawVisuals)
      ObjectsDeleteAll(0, m_objPrefix);

   if(InpShowHUD)
      DestroyHUD();
}

//+------------------------------------------------------------------+
//| Timer function (250ms): Gestión reactiva de Trinquete y Órdenes  |
//+------------------------------------------------------------------+
void OnTimer()
{
   ManageRatchetAndProtections();
   ManagePendingLimitOrders();

   static datetime lastHud = 0;
   if(TimeCurrent() - lastHud >= 1)
   {
      lastHud = TimeCurrent();
      if(InpShowHUD)
         UpdateHUD();
   }
}

//+------------------------------------------------------------------+
//| Tick function                                                    |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. Monitoreo por vela en la temporalidad de trabajo
   datetime currentBar = iTime(_Symbol, InpWorkTimeframe, 0);
   if(currentBar != m_lastBarTime)
   {
      m_lastBarTime = currentBar;
      ScanAndEvaluateBPRs();
   }

   // 2. Gestión activa del Ratchet en cada tick (crucial para backtests y vivo)
   ManageRatchetAndProtections();
}

//+------------------------------------------------------------------+
//| Escaneo Dinámico Multi-Timeframe de BPRs                         |
//+------------------------------------------------------------------+
void ScanAndEvaluateBPRs()
{
   ArrayResize(m_activeBprs, 0);

   // 1. Extraer BPRs de la temporalidad de trabajo
   int barsToScan = 200;
   MqlRates workRates[];
   ArraySetAsSeries(workRates, false);
   if(CopyRates(_Symbol, InpWorkTimeframe, 0, barsToScan, workRates) < InpBarsSince + 5)
      return;

   int lastBear = -1;
   int lastBull = -1;

   for(int i = 3; i < ArraySize(workRates) - 1; i++)
   {
      bool isBear = (workRates[i - 2].low - workRates[i].high > 0);
      bool isBull = (workRates[i].low - workRates[i - 2].high > 0);

      if(isBear) lastBear = i;
      if(isBull) lastBull = i;

      // Bullish Genesis BPR
      if(isBull && lastBear != -1 && (i - lastBear) <= InpBarsSince)
      {
         double cLow  = MathMax(workRates[lastBear].high, workRates[i - 2].high);
         double cHigh = MathMin(workRates[lastBear - 2].low, workRates[i].low);

         if(cHigh > cLow && (cHigh - cLow >= InpBprThreshold * _Point))
         {
            BPRZone bpr;
            bpr.high             = cHigh;
            bpr.low              = cLow;
            bpr.ce50             = NormalizeDouble((cHigh + cLow) / 2.0, _Digits);
            bpr.creationTime     = workRates[i].time;
            bpr.isBullishGenesis = true;
            bpr.confluenceCount  = 1; // Cuenta la temporalidad base
            bpr.confluenceInfo   = EnumToString(InpWorkTimeframe);
            bpr.isMitigated      = false;

            // Comprobar si ya fue mitigado por velas posteriores
            for(int m = i + 1; m < ArraySize(workRates); m++)
            {
               if(workRates[m].close < cLow)
               {
                  bpr.isMitigated = true;
                  break;
               }
            }

            int sz = ArraySize(m_activeBprs);
            ArrayResize(m_activeBprs, sz + 1);
            m_activeBprs[sz] = bpr;
         }
      }

      // Bearish Genesis BPR
      if(isBear && lastBull != -1 && (i - lastBull) <= InpBarsSince)
      {
         double cLow  = MathMax(workRates[lastBull - 2].high, workRates[i].high);
         double cHigh = MathMin(workRates[lastBull].low, workRates[i - 2].low);

         if(cHigh > cLow && (cHigh - cLow >= InpBprThreshold * _Point))
         {
            BPRZone bpr;
            bpr.high             = cHigh;
            bpr.low              = cLow;
            bpr.ce50             = NormalizeDouble((cHigh + cLow) / 2.0, _Digits);
            bpr.creationTime     = workRates[i].time;
            bpr.isBullishGenesis = false;
            bpr.confluenceCount  = 1;
            bpr.confluenceInfo   = EnumToString(InpWorkTimeframe);
            bpr.isMitigated      = false;

            for(int m = i + 1; m < ArraySize(workRates); m++)
            {
               if(workRates[m].close > cHigh)
               {
                  bpr.isMitigated = true;
                  break;
               }
            }

            int sz = ArraySize(m_activeBprs);
            ArrayResize(m_activeBprs, sz + 1);
            m_activeBprs[sz] = bpr;
         }
      }
   }

   // 2. Evaluar Confluencia Dinámica con todas las demás temporalidades activadas
   CheckDynamicMultiTFConfluences();

   // 3. Dibujar visuales si está activado
   if(InpDrawVisuals)
      RenderVisuals();

   // 4. Evaluar colocación de órdenes Limit
   EvaluateLimitOrderPlacement();
}

//+------------------------------------------------------------------+
//| Evaluar Confluencias con el Espectro N-Timeframe                 |
//+------------------------------------------------------------------+
void CheckDynamicMultiTFConfluences()
{
   ENUM_TIMEFRAMES tfs[];
   int count = 0;

   if(InpScanM1  && InpWorkTimeframe != PERIOD_M1)  { ArrayResize(tfs, count + 1); tfs[count++] = PERIOD_M1;  }
   if(InpScanM5  && InpWorkTimeframe != PERIOD_M5)  { ArrayResize(tfs, count + 1); tfs[count++] = PERIOD_M5;  }
   if(InpScanM15 && InpWorkTimeframe != PERIOD_M15) { ArrayResize(tfs, count + 1); tfs[count++] = PERIOD_M15; }
   if(InpScanM30 && InpWorkTimeframe != PERIOD_M30) { ArrayResize(tfs, count + 1); tfs[count++] = PERIOD_M30; }
   if(InpScanH1  && InpWorkTimeframe != PERIOD_H1)  { ArrayResize(tfs, count + 1); tfs[count++] = PERIOD_H1;  }
   if(InpScanH4  && InpWorkTimeframe != PERIOD_H4)  { ArrayResize(tfs, count + 1); tfs[count++] = PERIOD_H4;  }

   if(count == 0) return;

   for(int t = 0; t < count; t++)
   {
      ENUM_TIMEFRAMES currentTf = tfs[t];
      BPRZone otherZones[];
      ExtractBprsFromTF(currentTf, 150, otherZones);

      for(int i = 0; i < ArraySize(m_activeBprs); i++)
      {
         for(int j = 0; j < ArraySize(otherZones); j++)
         {
            // Solape de cajas: max(low1, low2) < min(high1, high2)
            double overlapLow  = MathMax(m_activeBprs[i].low, otherZones[j].low);
            double overlapHigh = MathMin(m_activeBprs[i].high, otherZones[j].high);

            if(overlapHigh > overlapLow)
            {
               m_activeBprs[i].confluenceCount++;
               m_activeBprs[i].confluenceInfo += (" + " + EnumToString(currentTf));
               break; // Una confluencia por timeframe es suficiente
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Extraer BPRs de cualquier Timeframe                              |
//+------------------------------------------------------------------+
void ExtractBprsFromTF(ENUM_TIMEFRAMES tf, int count, BPRZone &outZones[])
{
   ArrayResize(outZones, 0);
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   if(CopyRates(_Symbol, tf, 0, count, rates) < InpBarsSince + 5)
      return;

   int lastBear = -1;
   int lastBull = -1;

   for(int i = 3; i < ArraySize(rates) - 1; i++)
   {
      bool isBear = (rates[i - 2].low - rates[i].high > 0);
      bool isBull = (rates[i].low - rates[i - 2].high > 0);
      if(isBear) lastBear = i;
      if(isBull) lastBull = i;

      if(isBull && lastBear != -1 && (i - lastBear) <= InpBarsSince)
      {
         double cLow  = MathMax(rates[lastBear].high, rates[i - 2].high);
         double cHigh = MathMin(rates[lastBear - 2].low, rates[i].low);
         if(cHigh > cLow)
         {
            int sz = ArraySize(outZones);
            ArrayResize(outZones, sz + 1);
            outZones[sz].high = cHigh;
            outZones[sz].low  = cLow;
            outZones[sz].ce50 = (cHigh + cLow) / 2.0;
         }
      }
      if(isBear && lastBull != -1 && (i - lastBull) <= InpBarsSince)
      {
         double cLow  = MathMax(rates[lastBull - 2].high, rates[i].high);
         double cHigh = MathMin(rates[lastBull].low, rates[i - 2].low);
         if(cHigh > cLow)
         {
            int sz = ArraySize(outZones);
            ArrayResize(outZones, sz + 1);
            outZones[sz].high = cHigh;
            outZones[sz].low  = cLow;
            outZones[sz].ce50 = (cHigh + cLow) / 2.0;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Colocación de Órdenes Limit en el CE 50% con Reglas Robustas    |
//+------------------------------------------------------------------+
void EvaluateLimitOrderPlacement()
{
   if(InpUseSessionFilter && !IsInSession()) return;

   int currentActive = GetActivePositionsAndOrdersCount();
   if(currentActive >= InpMaxActiveTrades) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double bufferPts = InpSLBufferUnits;
   if(_Digits == 2 || _Digits == 3) // Oro o JPY
      bufferPts = InpSLBufferUnits / point;
   else
      bufferPts = (InpSLBufferUnits * 10) / point; // Pips a puntos

   double bufferPrice = bufferPts * _Point;

   // Iterar desde los BPRs más recientes
   for(int i = ArraySize(m_activeBprs) - 1; i >= 0; i--)
   {
      // 1. Filtro de confluencia mínima
      if(m_activeBprs[i].confluenceCount < InpMinConfluences)
         continue;

      // 2. Filtro de BPR virgen (no mitigado)
      if(InpOnlyVirginBprs && m_activeBprs[i].isMitigated)
         continue;

      double ce50 = m_activeBprs[i].ce50;
      double high = m_activeBprs[i].high;
      double low  = m_activeBprs[i].low;

      // -------------------------------------------------------------
      // CASO A: El precio viene por DEBAJO -> SELL LIMIT en CE50
      // -------------------------------------------------------------
      if(ask < ce50 && (ce50 - ask) >= 15 * _Point)
      {
         if(!HasExistingOrderNear(ce50))
         {
            double sl = NormalizeDouble(high + bufferPrice, _Digits);
            double slDist = sl - ce50;

            if(slDist > 10 * _Point)
            {
               double tp = NormalizeDouble(ce50 - (slDist * InpFinalTarget_R), _Digits);
               double lot = CalculateLotSize(ce50, sl);

               string comment = StringFormat("%s_SELL_LMT", InpTradeComment);
               if(m_trade.SellLimit(lot, ce50, _Symbol, sl, tp, ORDER_TIME_GTC, 0, comment))
               {
                  PrintFormat("🎯 [SELL LIMIT] CE 50%%: %.2f | SL: %.2f | TP: %.2f | Lote: %.2f | Confluencias: %d (%s)",
                              ce50, sl, tp, lot, m_activeBprs[i].confluenceCount, m_activeBprs[i].confluenceInfo);
                  return;
               }
            }
         }
      }

      // -------------------------------------------------------------
      // CASO B: El precio viene por ENCIMA -> BUY LIMIT en CE50
      // -------------------------------------------------------------
      if(bid > ce50 && (bid - ce50) >= 15 * _Point)
      {
         if(!HasExistingOrderNear(ce50))
         {
            double sl = NormalizeDouble(low - bufferPrice, _Digits);
            double slDist = ce50 - sl;

            if(slDist > 10 * _Point)
            {
               double tp = NormalizeDouble(ce50 + (slDist * InpFinalTarget_R), _Digits);
               double lot = CalculateLotSize(ce50, sl);

               string comment = StringFormat("%s_BUY_LMT", InpTradeComment);
               if(m_trade.BuyLimit(lot, ce50, _Symbol, sl, tp, ORDER_TIME_GTC, 0, comment))
               {
                  PrintFormat("🎯 [BUY LIMIT] CE 50%%: %.2f | SL: %.2f | TP: %.2f | Lote: %.2f | Confluencias: %d (%s)",
                              ce50, sl, tp, lot, m_activeBprs[i].confluenceCount, m_activeBprs[i].confluenceInfo);
                  return;
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Trinquete Protector de Beneficios (Ratchet Profit Lock)          |
//+------------------------------------------------------------------+
void ManageRatchetAndProtections()
{
   if(!InpUseRatchetLock) return;

   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;

      if(PositionGetInteger(POSITION_MAGIC) != InpMagicNumber || PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      int tIdx = GetOrCreateTracker(ticket);
      if(tIdx < 0) continue;

      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSL = PositionGetDouble(POSITION_SL);
      double currentTP = PositionGetDouble(POSITION_TP);
      ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double curPrice = (type == POSITION_TYPE_BUY) ? bid : ask;

      double riskPts = m_trackers[tIdx].riskPoints;
      if(riskPts <= 0) continue;

      double profitPts = (type == POSITION_TYPE_BUY) ? (curPrice - openPrice) / _Point : (openPrice - curPrice) / _Point;
      double currentR = profitPts / riskPts;

      // Calcular distancia mínima de stops permitida por el broker
      double minStopDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
      if(minStopDist <= 0) minStopDist = 10 * _Point;

      // -------------------------------------------------------------
      // ESCALÓN 3: 1:5.0R -> Asegurar +2.5R
      // -------------------------------------------------------------
      if(currentR >= InpLock2_Trigger_R && m_trackers[tIdx].ratchetStep < 3)
      {
         double lockDist = riskPts * _Point * InpLock2_Secure_R;
         double targetSL = (type == POSITION_TYPE_BUY) ? (openPrice + lockDist) : (openPrice - lockDist);
         targetSL = NormalizeDouble(targetSL, _Digits);

         bool canModify = (type == POSITION_TYPE_BUY) ? (targetSL > currentSL && (curPrice - targetSL) >= minStopDist)
                                                      : (targetSL < currentSL && (targetSL - curPrice) >= minStopDist);

         if(canModify)
         {
            if(m_trade.PositionModify(ticket, targetSL, currentTP))
            {
               m_trackers[tIdx].ratchetStep = 3;
               PrintFormat("🏆 [RATCHET NIVEL 2] Ticket #%d a 1:%.1fR -> SL asegurado a +%.1fR (%.2f)", ticket, currentR, InpLock2_Secure_R, targetSL);
            }
         }
      }
      // -------------------------------------------------------------
      // ESCALÓN 2: 1:3.0R -> Asegurar +1.0R
      // -------------------------------------------------------------
      else if(currentR >= InpLock1_Trigger_R && m_trackers[tIdx].ratchetStep < 2)
      {
         double lockDist = riskPts * _Point * InpLock1_Secure_R;
         double targetSL = (type == POSITION_TYPE_BUY) ? (openPrice + lockDist) : (openPrice - lockDist);
         targetSL = NormalizeDouble(targetSL, _Digits);

         bool canModify = (type == POSITION_TYPE_BUY) ? (targetSL > currentSL && (curPrice - targetSL) >= minStopDist)
                                                      : (targetSL < currentSL && (targetSL - curPrice) >= minStopDist);

         if(canModify)
         {
            if(m_trade.PositionModify(ticket, targetSL, currentTP))
            {
               m_trackers[tIdx].ratchetStep = 2;
               PrintFormat("💰 [RATCHET NIVEL 1] Ticket #%d a 1:%.1fR -> SL asegurado a +%.1fR (%.2f)", ticket, currentR, InpLock1_Secure_R, targetSL);
            }
         }
      }
      // -------------------------------------------------------------
      // ESCALÓN 1: 1:1.5R -> Mover a Break-Even + Pequeño Buffer
      // -------------------------------------------------------------
      else if(currentR >= InpBE_Trigger_R && m_trackers[tIdx].ratchetStep < 1)
      {
         double beOffset = InpBEOffsetPips * ((_Digits == 3 || _Digits == 5) ? (10 * _Point) : _Point);
         if(beOffset < minStopDist) beOffset = minStopDist;

         double targetSL = (type == POSITION_TYPE_BUY) ? (openPrice + beOffset) : (openPrice - beOffset);
         targetSL = NormalizeDouble(targetSL, _Digits);

         bool canModify = (type == POSITION_TYPE_BUY) ? (targetSL > currentSL && (curPrice - targetSL) >= minStopDist)
                                                      : (targetSL < currentSL && (targetSL - curPrice) >= minStopDist);

         if(canModify)
         {
            if(m_trade.PositionModify(ticket, targetSL, currentTP))
            {
               m_trackers[tIdx].ratchetStep = 1;
               PrintFormat("🛡️ [BREAK-EVEN ACTIVADO] Ticket #%d a 1:%.1fR -> SL en Entrada + Buffer: %.2f (Riesgo Cero)", ticket, currentR, targetSL);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Cancelar órdenes Limit expiradas                                 |
//+------------------------------------------------------------------+
void ManagePendingLimitOrders()
{
   int total = OrdersTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket <= 0) continue;

      if(OrderGetInteger(ORDER_MAGIC) != InpMagicNumber || OrderGetString(ORDER_SYMBOL) != _Symbol)
         continue;

      datetime setupTime = (datetime)OrderGetInteger(ORDER_TIME_SETUP);
      int barsPassed = iBarShift(_Symbol, InpWorkTimeframe, setupTime);

      if(barsPassed > InpMaxBarsOrderPending)
      {
         PrintFormat("⏰ [ORDEN LIMIT EXPIRADA] Ticket #%d cancelado tras %d barras.", ticket, barsPassed);
         m_trade.OrderDelete(ticket);
      }
   }
}

//+------------------------------------------------------------------+
//| Auxiliares de Trackers y Gestión de Lote                         |
//+------------------------------------------------------------------+
int GetOrCreateTracker(ulong ticket)
{
   for(int i = 0; i < ArraySize(m_trackers); i++)
   {
      if(m_trackers[i].ticket == ticket)
         return i;
   }

   if(!PositionSelectByTicket(ticket)) return -1;

   TradeTracker tr;
   tr.ticket       = ticket;
   tr.entryPrice   = PositionGetDouble(POSITION_PRICE_OPEN);
   tr.initialSL    = PositionGetDouble(POSITION_SL);
   tr.initialLot   = PositionGetDouble(POSITION_VOLUME);
   tr.ratchetStep  = 0;
   tr.riskPoints   = MathAbs(tr.entryPrice - tr.initialSL) / _Point;

   int sz = ArraySize(m_trackers);
   ArrayResize(m_trackers, sz + 1);
   m_trackers[sz] = tr;
   return sz;
}

double CalculateLotSize(double entryPrice, double slPrice)
{
   if(InpRiskMode == RISK_FIXED_LOT)
      return InpFixedLotSize;

   double riskUSD = 0.0;
   if(InpRiskMode == RISK_PERCENT_BALANCE)
      riskUSD = AccountInfoDouble(ACCOUNT_BALANCE) * (InpRiskPercent / 100.0);
   else if(InpRiskMode == RISK_PERCENT_EQUITY)
      riskUSD = AccountInfoDouble(ACCOUNT_EQUITY) * (InpRiskPercent / 100.0);
   else if(InpRiskMode == RISK_FIXED_USD)
      riskUSD = InpFixedRiskUSD;

   double slPoints = MathAbs(entryPrice - slPrice) / _Point;
   if(slPoints <= 0.0) return SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double pointVal  = (tickSize > 0) ? (tickValue * (_Point / tickSize)) : tickValue;
   if(pointVal <= 0.0) pointVal = 1.0;

   double calculatedLot = riskUSD / (slPoints * pointVal);
   return NormalizeLot(calculatedLot);
}

double NormalizeLot(double lot)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   double normLot = MathFloor(lot / lotStep) * lotStep;
   if(normLot < minLot) normLot = minLot;
   if(normLot > maxLot) normLot = maxLot;
   return NormalizeDouble(normLot, 2);
}

bool HasExistingOrderNear(double price)
{
   int total = OrdersTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0 && OrderGetInteger(ORDER_MAGIC) == InpMagicNumber && OrderGetString(ORDER_SYMBOL) == _Symbol)
      {
         double orderPrice = OrderGetDouble(ORDER_PRICE_OPEN);
         if(MathAbs(orderPrice - price) <= 20 * _Point)
            return true;
      }
   }
   return false;
}

int GetActivePositionsAndOrdersCount()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetTicket(i) > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && PositionGetString(POSITION_SYMBOL) == _Symbol)
         count++;
   }
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      if(OrderGetTicket(i) > 0 && OrderGetInteger(ORDER_MAGIC) == InpMagicNumber && OrderGetString(ORDER_SYMBOL) == _Symbol)
         count++;
   }
   return count;
}

bool IsInSession()
{
   MqlDateTime dt;
   TimeCurrent(dt);
   if(InpStartHour <= InpEndHour)
      return (dt.hour >= InpStartHour && dt.hour < InpEndHour);
   else
      return (dt.hour >= InpStartHour || dt.hour < InpEndHour);
}

//+------------------------------------------------------------------+
//| Visualización de Zonas BPR en el Gráfico                         |
//+------------------------------------------------------------------+
void RenderVisuals()
{
   for(int i = 0; i < ArraySize(m_activeBprs); i++)
   {
      string nameBox = StringFormat("%sBOX_%d", m_objPrefix, i);
      string nameCe  = StringFormat("%sCE_%d", m_objPrefix, i);

      datetime tStart = m_activeBprs[i].creationTime;
      datetime tEnd   = TimeCurrent() + PeriodSeconds(InpWorkTimeframe) * 10;
      color col       = (m_activeBprs[i].confluenceCount >= InpMinConfluences) ? InpConfluenceColor : InpBprBaseColor;

      // Caja BPR
      if(ObjectFind(0, nameBox) < 0)
      {
         ObjectCreate(0, nameBox, OBJ_RECTANGLE, 0, tStart, m_activeBprs[i].high, tEnd, m_activeBprs[i].low);
         ObjectSetInteger(0, nameBox, OBJPROP_COLOR, col);
         ObjectSetInteger(0, nameBox, OBJPROP_FILL, true);
         ObjectSetInteger(0, nameBox, OBJPROP_BACK, true);
         ObjectSetString(0, nameBox, OBJPROP_TOOLTIP, StringFormat("BPR [%s] Conf: %d (%s)",
                         EnumToString(InpWorkTimeframe), m_activeBprs[i].confluenceCount, m_activeBprs[i].confluenceInfo));
      }
      else
      {
         ObjectSetInteger(0, nameBox, OBJPROP_TIME, 1, tEnd);
         ObjectSetInteger(0, nameBox, OBJPROP_COLOR, col);
      }

      // Línea CE 50%
      if(ObjectFind(0, nameCe) < 0)
      {
         ObjectCreate(0, nameCe, OBJ_TREND, 0, tStart, m_activeBprs[i].ce50, tEnd, m_activeBprs[i].ce50);
         ObjectSetInteger(0, nameCe, OBJPROP_COLOR, col);
         ObjectSetInteger(0, nameCe, OBJPROP_STYLE, STYLE_DOT);
         ObjectSetInteger(0, nameCe, OBJPROP_WIDTH, 1);
         ObjectSetInteger(0, nameCe, OBJPROP_RAY_RIGHT, false);
      }
      else
      {
         ObjectSetInteger(0, nameCe, OBJPROP_TIME, 1, tEnd);
         ObjectSetInteger(0, nameCe, OBJPROP_COLOR, col);
      }
   }
}

//+------------------------------------------------------------------+
//| Panel HUD en Pantalla                                            |
//+------------------------------------------------------------------+
void CreateHUD()
{
   string name = m_objPrefix + "HUD_BG";
   if(ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, 20);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, 50);
      ObjectSetInteger(0, name, OBJPROP_XSIZE, 300);
      ObjectSetInteger(0, name, OBJPROP_YSIZE, 130);
      ObjectSetInteger(0, name, OBJPROP_BGCOLOR, C'15,23,42');
      ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, C'245,158,11');
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   }

   string labelName = m_objPrefix + "HUD_TXT";
   if(ObjectFind(0, labelName) < 0)
   {
      ObjectCreate(0, labelName, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, labelName, OBJPROP_XDISTANCE, 30);
      ObjectSetInteger(0, labelName, OBJPROP_YDISTANCE, 60);
      ObjectSetInteger(0, labelName, OBJPROP_COLOR, clrWhite);
      ObjectSetInteger(0, labelName, OBJPROP_FONTSIZE, 9);
      ObjectSetString(0, labelName, OBJPROP_FONT, "Segoe UI");
      ObjectSetString(0, labelName, OBJPROP_TEXT, "Iniciando BPR Sniper v2.0...");
   }
}

void UpdateHUD()
{
   string labelName = m_objPrefix + "HUD_TXT";
   if(ObjectFind(0, labelName) < 0) return;

   int confCount = 0;
   for(int i = 0; i < ArraySize(m_activeBprs); i++)
   {
      if(m_activeBprs[i].confluenceCount >= InpMinConfluences)
         confCount++;
   }

   string text = StringFormat("🎯 BPR SNIPER v2.0 (MULTI-TF)\n"
                              "━━━━━━━━━━━━━━━━━━━━━━\n"
                              "Par: %s | Base: %s\n"
                              "BPRs Activos: %d | Confluencias (≥%d TF): %d\n"
                              "Riesgo: %.2f%% | Ratchet Lock: %s\n"
                              "Trades Vivos: %d / %d",
                              _Symbol, EnumToString(InpWorkTimeframe),
                              ArraySize(m_activeBprs), InpMinConfluences, confCount,
                              InpRiskPercent, InpUseRatchetLock ? "ACTIVO" : "OFF",
                              GetActivePositionsAndOrdersCount(), InpMaxActiveTrades);

   ObjectSetString(0, labelName, OBJPROP_TEXT, text);
}

void DestroyHUD()
{
   ObjectsDeleteAll(0, m_objPrefix);
}
//+------------------------------------------------------------------+
