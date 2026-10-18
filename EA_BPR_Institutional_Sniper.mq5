//+------------------------------------------------------------------+
//|                                EA_BPR_Institutional_Sniper.mq5   |
//|                 Algorithmic Limit Trading System (BPR Multi-TF)  |
//|                 Balanced Price Range + Confluence + MFE Scaler   |
//+------------------------------------------------------------------+
#property copyright   "Antigravity Quantitative Trading"
#property link        "https://t.me/WarriorTraderClub"
#property version     "1.00"
#property description "EA institucional basado en órdenes Limit al 50% CE de BPRs con Confluencia MTF y Escalado Asimétrico de Parciales."

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

enum ENUM_BPR_FILTER_MODE
{
   FILTER_ALL_BPRS,          // Operar Todos los BPRs Válidos
   FILTER_MTF_CONFLUENCE_ONLY// Operar Únicamente BPRs con Confluencia MTF (Alta Probabilidad)
};

//--- PARÁMETROS DE ENTRADA (INPUTS) ---
input group "=== 🎯 1. PARÁMETROS DEL BPR (WARRIOR TRADING CLUB) ===";
input ENUM_TIMEFRAMES      InpWorkTimeframe        = PERIOD_M15;           // Temporalidad Base de Trabajo
input int                  InpBarsSince            = 10;                   // Barras de Lookback entre FVGs (bars_since)
input double               InpBprThreshold         = 0.0;                  // Umbral Mínimo de Solape en Puntos
input bool                 InpOnlyCleanBpr         = false;                // Solo BPRs Limpios (Sin mechas previas)
input ENUM_BPR_FILTER_MODE InpFilterMode           = FILTER_ALL_BPRS;      // Filtro de Selección de BPRs
input bool                 InpCheckConfluence      = true;                 // Detectar Confluencias con Timeframes Superiores
input ENUM_TIMEFRAMES      InpHigherTF_1           = PERIOD_M30;           // Temporalidad Superior 1 (ej. M30)
input ENUM_TIMEFRAMES      InpHigherTF_2           = PERIOD_H1;            // Temporalidad Superior 2 (ej. H1)

input group "=== ⚖️ 2. GESTIÓN DE RIESGO ASIMÉTRICO (0.3% - 0.5%) ===";
input ENUM_RISK_MODE       InpRiskMode             = RISK_PERCENT_BALANCE; // Modo de Gestión de Capital
input double               InpRiskPercent          = 0.30;                 // Riesgo por Operación (% recomendado: 0.3% o 0.5%)
input double               InpFixedRiskUSD         = 30.0;                 // Riesgo Fijo en USD (si modo Fixed USD)
input double               InpFixedLotSize         = 0.01;                 // Lotaje Fijo Manual (si modo Fixed Lot)
input double               InpSLBufferUnits        = 1.00;                 // Holgura tras el Extremo del BPR (1.00$ en Oro / Pips en FX)
input int                  InpMaxActiveTrades      = 1;                    // Máximo de Operaciones Simultáneas

input group "=== 💰 3. ESCALADO DE PARCIALES & BREAK-EVEN ===";
input bool                 InpEnablePartials       = true;                 // Activar Cierre Parcial en Niveles R
input double               InpPartial1_R           = 3.0;                  // Parcial 1: Ratio R para Primer Cobro (1:3R)
input double               InpPartial1_Pct         = 40.0;                 // Parcial 1: % del Lote a Cerrar (40%)
input bool                 InpAutoBE_AtPartial1    = true;                 // Mover Stop Loss a Break-Even al Alcanzar Parcial 1
input double               InpBEOffsetPips         = 0.5;                  // Offset de Ganancia Asegurada en Break-Even (pips)
input double               InpPartial2_R           = 6.0;                  // Parcial 2: Ratio R para Segundo Cobro (1:6R)
input double               InpPartial2_Pct         = 30.0;                 // Parcial 2: % del Lote a Cerrar (30%)
input double               InpFinalTarget_R        = 15.0;                 // Runner TP Final: Ratio R Objetivo (1:15R a 1:20R)

input group "=== ⏱️ 4. FILTRO DE HORARIOS & EXPIRACIÓN LIMIT ===";
input bool                 InpUseSessionFilter     = true;                 // Operar Solo en Killzones
input int                  InpStartHour            = 8;                    // Hora Inicio (08:00 CET - Londres)
input int                  InpEndHour              = 21;                   // Hora Fin (21:00 CET - Cierre NY)
input int                  InpMaxBarsOrderPending  = 24;                   // Expiración de Orden Limit sin Tocar (Barras)

input group "=== 🎨 5. IDENTIFICACIÓN Y GRÁFICO ===";
input ulong                InpMagicNumber          = 991100;               // Magic Number
input string               InpTradeComment         = "BPR_SNIPER";         // Comentario
input bool                 InpDrawVisuals          = true;                 // Dibujar Zonas BPR en Gráfico
input color                InpBprBaseColor         = C'100,116,139';       // Color BPR Neutro Base
input color                InpConfluenceColor      = C'245,158,11';        // Color BPR Confluencia MTF
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
   bool     partial1Done;
   bool     partial2Done;
   bool     beMoved;
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
   PrintFormat("🚀 [EA_BPR_Institutional_Sniper] Iniciado en %s | TF: %s | Riesgo: %.2f%% | Parciales 1:%.0fR / 1:%.0fR / 1:%.0fR",
               _Symbol, EnumToString(InpWorkTimeframe), InpRiskPercent, InpPartial1_R, InpPartial2_R, InpFinalTarget_R);
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
//| Timer function (250ms): Gestión reactiva de Parciales y BE      |
//+------------------------------------------------------------------+
void OnTimer()
{
   // 1. Gestionar parciales y Break-Even
   ManagePartialsAndBreakEven();

   // 2. Cancelar órdenes Limit obsoletas o expiradas
   ManagePendingLimitOrders();

   // 3. Actualizar HUD cada segundo
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
   // 1. Evaluar si hay nueva vela en la temporalidad de trabajo
   datetime currentBar = iTime(_Symbol, InpWorkTimeframe, 0);
   if(currentBar != m_lastBarTime)
   {
      m_lastBarTime = currentBar;
      ScanAndEvaluateBPRs();
   }

   // 2. Gestionar salidas activas
   ManagePartialsAndBreakEven();
}

//+------------------------------------------------------------------+
//| Escanear BPRs en la temporalidad de trabajo y buscar Confluencias|
//+------------------------------------------------------------------+
void ScanAndEvaluateBPRs()
{
   ArrayResize(m_activeBprs, 0);

   int barsToScan = 300;
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   if(CopyRates(_Symbol, InpWorkTimeframe, 0, barsToScan, rates) < InpBarsSince + 5)
      return;

   int lastBear = -1;
   int lastBull = -1;

   for(int i = 3; i < ArraySize(rates) - 1; i++)
   {
      bool isBear = (rates[i - 2].low - rates[i].high > 0);
      bool isBull = (rates[i].low - rates[i - 2].high > 0);

      if(isBear) lastBear = i;
      if(isBull) lastBull = i;

      // Bullish Genesis BPR
      if(isBull && lastBear != -1 && (i - lastBear) <= InpBarsSince)
      {
         double cLow  = MathMax(rates[lastBear].high, rates[i - 2].high);
         double cHigh = MathMin(rates[lastBear - 2].low, rates[i].low);

         if(cHigh > cLow && (cHigh - cLow >= InpBprThreshold * _Point))
         {
            BPRZone bpr;
            bpr.high             = cHigh;
            bpr.low              = cLow;
            bpr.ce50             = NormalizeDouble((cHigh + cLow) / 2.0, _Digits);
            bpr.creationTime     = rates[i].time;
            bpr.isBullishGenesis = true;
            bpr.confluenceCount  = 0;
            bpr.confluenceInfo   = "";
            bpr.isMitigated      = false;

            // Comprobar mitigación
            for(int m = i + 1; m < ArraySize(rates); m++)
            {
               if(rates[m].low < cLow)
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
         double cLow  = MathMax(rates[lastBull - 2].high, rates[i].high);
         double cHigh = MathMin(rates[lastBull].low, rates[i - 2].low);

         if(cHigh > cLow && (cHigh - cLow >= InpBprThreshold * _Point))
         {
            BPRZone bpr;
            bpr.high             = cHigh;
            bpr.low              = cLow;
            bpr.ce50             = NormalizeDouble((cHigh + cLow) / 2.0, _Digits);
            bpr.creationTime     = rates[i].time;
            bpr.isBullishGenesis = false;
            bpr.confluenceCount  = 0;
            bpr.confluenceInfo   = "";
            bpr.isMitigated      = false;

            // Comprobar mitigación
            for(int m = i + 1; m < ArraySize(rates); m++)
            {
               if(rates[m].high > cHigh)
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

   // 2. Confluencia con Timeframes Superiores
   if(InpCheckConfluence && ArraySize(m_activeBprs) > 0)
   {
      BPRZone htf1[];
      BPRZone htf2[];
      ScanHigherTFBprs(InpHigherTF_1, htf1);
      ScanHigherTFBprs(InpHigherTF_2, htf2);

      for(int b = 0; b < ArraySize(m_activeBprs); b++)
      {
         for(int k = 0; k < ArraySize(htf1); k++)
         {
            if(m_activeBprs[b].high >= htf1[k].low && m_activeBprs[b].low <= htf1[k].high)
            {
               m_activeBprs[b].confluenceCount++;
               m_activeBprs[b].confluenceInfo += EnumToString(InpHigherTF_1) + " ";
               break;
            }
         }
         for(int k = 0; k < ArraySize(htf2); k++)
         {
            if(m_activeBprs[b].high >= htf2[k].low && m_activeBprs[b].low <= htf2[k].high)
            {
               m_activeBprs[b].confluenceCount++;
               m_activeBprs[b].confluenceInfo += EnumToString(InpHigherTF_2) + " ";
               break;
            }
         }
      }
   }

   // 3. Dibujar visualmente
   if(InpDrawVisuals)
      DrawBprsOnChart();

   // 4. Evaluar colocación de órdenes Limit
   EvaluateLimitOrderPlacement();
}

//+------------------------------------------------------------------+
//| Escanear BPRs en Timeframe Superior                              |
//+------------------------------------------------------------------+
void ScanHigherTFBprs(ENUM_TIMEFRAMES tf, BPRZone &outZones[])
{
   ArrayResize(outZones, 0);
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(_Symbol, tf, 0, 200, rates);
   if(copied < InpBarsSince + 5) return;

   int lastBear = -1, lastBull = -1;
   for(int i = 3; i < copied - 1; i++)
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
//| Colocación de Órdenes Limit en el CE 50% de los BPRs Válidos    |
//+------------------------------------------------------------------+
void EvaluateLimitOrderPlacement()
{
   if(InpUseSessionFilter && !IsInSession()) return;

   int currentActive = GetActivePositionsAndOrdersCount();
   if(currentActive >= InpMaxActiveTrades) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   // Buffer de aire tras el extremo del BPR
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
      // Filtro de confluencia
      if(InpFilterMode == FILTER_MTF_CONFLUENCE_ONLY && m_activeBprs[i].confluenceCount == 0)
         continue;

      double ce50 = m_activeBprs[i].ce50;
      double high = m_activeBprs[i].high;
      double low  = m_activeBprs[i].low;

      // -------------------------------------------------------------
      // CASO A: El precio viene por DEBAJO del BPR -> SELL LIMIT en CE50
      // Esperamos que suba a tocar el 50% y reaccione en Venta a favor del retroceso
      // -------------------------------------------------------------
      if(ask < ce50 && (ce50 - ask) >= 15 * _Point)
      {
         // Verificar que no tengamos ya orden en ese nivel
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
                  PrintFormat("🎯 [SELL LIMIT COLOCADO] CE 50%%: %.2f | SL: %.2f (+%.2f$) | TP (1:%.0fR): %.2f | Lote: %.2f",
                              ce50, sl, InpSLBufferUnits, InpFinalTarget_R, tp, lot);
                  return;
               }
            }
         }
      }

      // -------------------------------------------------------------
      // CASO B: El precio viene por ENCIMA del BPR -> BUY LIMIT en CE50
      // Esperamos que baje a tocar el 50% y reaccione en Compra
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
                  PrintFormat("🎯 [BUY LIMIT COLOCADO] CE 50%%: %.2f | SL: %.2f (-%.2f$) | TP (1:%.0fR): %.2f | Lote: %.2f",
                              ce50, sl, InpSLBufferUnits, InpFinalTarget_R, tp, lot);
                  return;
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Gestión Dinámica de Parciales y Break-Even por Multiplos R      |
//+------------------------------------------------------------------+
void ManagePartialsAndBreakEven()
{
   if(!InpEnablePartials) return;

   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;

      if(PositionGetInteger(POSITION_MAGIC) != InpMagicNumber || PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      // Obtener o registrar tracker para este trade
      int tIdx = GetOrCreateTracker(ticket);
      if(tIdx < 0) continue;

      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSL = PositionGetDouble(POSITION_SL);
      double currentTP = PositionGetDouble(POSITION_TP);
      double currentLot= PositionGetDouble(POSITION_VOLUME);
      ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double curPrice = (type == POSITION_TYPE_BUY) ? bid : ask;

      double riskPts = m_trackers[tIdx].riskPoints;
      if(riskPts <= 0) continue;

      double profitPts = (type == POSITION_TYPE_BUY) ? (curPrice - openPrice) / _Point : (openPrice - curPrice) / _Point;
      double currentR = profitPts / riskPts;

      // -------------------------------------------------------------
      // 1. NIVEL PARCIAL 1 (ej. 1:3.0R) -> Cerrar 40% y Mover a BE
      // -------------------------------------------------------------
      if(currentR >= InpPartial1_R && !m_trackers[tIdx].partial1Done)
      {
         double closeLot = NormalizeLot(m_trackers[tIdx].initialLot * (InpPartial1_Pct / 100.0));
         if(closeLot >= SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN) && currentLot > closeLot)
         {
            if(m_trade.PositionClosePartial(ticket, closeLot))
            {
               m_trackers[tIdx].partial1Done = true;
               PrintFormat("💰 [PARCIAL 1 COBRADO] Ticket #%d a 1:%.1fR | Cerrado: %.2f lotes (%.0f%%) | Beneficio asegurado.",
                           ticket, currentR, closeLot, InpPartial1_Pct);
            }
         }
         else
         {
            m_trackers[tIdx].partial1Done = true; // Si lote es muy pequeño para partir, marcar hecho
         }

         // Mover a Break-Even
         if(InpAutoBE_AtPartial1 && !m_trackers[tIdx].beMoved)
         {
            double beOffset = InpBEOffsetPips * ((_Digits == 3 || _Digits == 5) ? (10 * _Point) : _Point);
            double bePrice  = (type == POSITION_TYPE_BUY) ? (openPrice + beOffset) : (openPrice - beOffset);
            bePrice = NormalizeDouble(bePrice, _Digits);

            if((type == POSITION_TYPE_BUY && currentSL < bePrice) || (type == POSITION_TYPE_SELL && (currentSL > bePrice || currentSL == 0)))
            {
               if(m_trade.PositionModify(ticket, bePrice, currentTP))
               {
                  m_trackers[tIdx].beMoved = true;
                  PrintFormat("🛡️ [BREAK-EVEN ACTIVADO] Ticket #%d con SL movido a Entrada + Buffer: %.2f (Riesgo Cero).", ticket, bePrice);
               }
            }
         }
      }

      // -------------------------------------------------------------
      // 2. NIVEL PARCIAL 2 (ej. 1:6.0R) -> Cerrar 30% adicional
      // -------------------------------------------------------------
      if(currentR >= InpPartial2_R && !m_trackers[tIdx].partial2Done)
      {
         double closeLot = NormalizeLot(m_trackers[tIdx].initialLot * (InpPartial2_Pct / 100.0));
         if(closeLot >= SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN) && currentLot > closeLot)
         {
            if(m_trade.PositionClosePartial(ticket, closeLot))
            {
               m_trackers[tIdx].partial2Done = true;
               PrintFormat("🚀 [PARCIAL 2 COBRADO] Ticket #%d a 1:%.1fR | Cerrado: %.2f lotes (%.0f%%) | Runner restante al TP Final.",
                           ticket, currentR, closeLot, InpPartial2_Pct);
            }
         }
         else
         {
            m_trackers[tIdx].partial2Done = true;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Cancelar órdenes Limit que hayan quedado lejos o expiradas       |
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
         PrintFormat("⏰ [ORDEN LIMIT EXPIRADA] Ticket #%d cancelado tras %d barras sin tocar el CE 50%%.", ticket, barsPassed);
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
   tr.partial1Done = false;
   tr.partial2Done = false;
   tr.beMoved      = false;
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
   return (dt.hour >= InpStartHour && dt.hour < InpEndHour);
}

//+------------------------------------------------------------------+
//| Dibujar BPRs en Gráfico                                          |
//+------------------------------------------------------------------+
void DrawBprsOnChart()
{
   datetime chartEnd = TimeCurrent() + PeriodSeconds(InpWorkTimeframe) * 20;

   for(int i = 0; i < ArraySize(m_activeBprs); i++)
   {
      if(m_activeBprs[i].isMitigated) continue;

      bool hasConf = (m_activeBprs[i].confluenceCount > 0);
      color col = hasConf ? InpConfluenceColor : InpBprBaseColor;

      string bName  = StringFormat("%sBOX_%d", m_objPrefix, (int)m_activeBprs[i].creationTime);
      string ceName = StringFormat("%sCE_%d", m_objPrefix, (int)m_activeBprs[i].creationTime);

      if(ObjectFind(0, bName) < 0)
      {
         ObjectCreate(0, bName, OBJ_RECTANGLE, 0, m_activeBprs[i].creationTime, m_activeBprs[i].high, chartEnd, m_activeBprs[i].low);
         ObjectSetInteger(0, bName, OBJPROP_COLOR, col);
         ObjectSetInteger(0, bName, OBJPROP_BGCOLOR, col);
         ObjectSetInteger(0, bName, OBJPROP_FILL, true);
         ObjectSetInteger(0, bName, OBJPROP_BACK, true);
      }
      else
      {
         ObjectSetInteger(0, bName, OBJPROP_TIME, 1, chartEnd);
         ObjectSetInteger(0, bName, OBJPROP_COLOR, col);
         ObjectSetInteger(0, bName, OBJPROP_BGCOLOR, col);
      }

      if(ObjectFind(0, ceName) < 0)
      {
         ObjectCreate(0, ceName, OBJ_TREND, 0, m_activeBprs[i].creationTime, m_activeBprs[i].ce50, chartEnd, m_activeBprs[i].ce50);
         ObjectSetInteger(0, ceName, OBJPROP_COLOR, col);
         ObjectSetInteger(0, ceName, OBJPROP_STYLE, STYLE_DASH);
         ObjectSetInteger(0, ceName, OBJPROP_WIDTH, hasConf ? 2 : 1);
         ObjectSetInteger(0, ceName, OBJPROP_RAY_RIGHT, true);
      }
      else
      {
         ObjectSetInteger(0, ceName, OBJPROP_TIME, 1, chartEnd);
         ObjectSetInteger(0, ceName, OBJPROP_COLOR, col);
      }
   }
}

//+------------------------------------------------------------------+
//| Panel HUD en Gráfico                                             |
//+------------------------------------------------------------------+
void CreateHUD()
{
   string prefix = m_objPrefix + "HUD_";
   ObjectsDeleteAll(0, prefix);

   int x = 20, y = 30;
   CreateLabel(prefix + "BG", " ", x, y, 290, 160, C'15,23,42', C'51,65,85');
   CreateLabel(prefix + "TITLE", "⚡ BPR INSTITUTIONAL SNIPER", x + 12, y + 10, 0, 0, clrWhite, clrNONE, 10, true);
   CreateLabel(prefix + "INFO", StringFormat("TF: %s | Riesgo: %.2f%% | SL +%.2f$", EnumToString(InpWorkTimeframe), InpRiskPercent, InpSLBufferUnits), x + 12, y + 32, 0, 0, C'56,189,248', clrNONE, 9);
   CreateLabel(prefix + "TARGETS", StringFormat("Parciales: 1:%.0fR (%.0f%%) | 1:%.0fR (%.0f%%) | 1:%.0fR", InpPartial1_R, InpPartial1_Pct, InpPartial2_R, InpPartial2_Pct, InpFinalTarget_R), x + 12, y + 52, 0, 0, C'74,222,128', clrNONE, 9);
   CreateLabel(prefix + "BPRS", "BPRs Vivos: 0 | Confluencias MTF: 0", x + 12, y + 72, 0, 0, C'245,158,11', clrNONE, 9);
   CreateLabel(prefix + "TRADES", "Posiciones Vivas: 0 | Límites: 0", x + 12, y + 92, 0, 0, clrLightGray, clrNONE, 9);
   CreateLabel(prefix + "STATUS", "Escaneando zonas y gestionando límites...", x + 12, y + 115, 0, 0, clrGold, clrNONE, 9);
}

void UpdateHUD()
{
   string prefix = m_objPrefix + "HUD_";

   int liveCount = 0;
   int liveConf  = 0;
   for(int i = 0; i < ArraySize(m_activeBprs); i++)
   {
      if(!m_activeBprs[i].isMitigated)
      {
         liveCount++;
         if(m_activeBprs[i].confluenceCount > 0)
            liveConf++;
      }
   }

   int posCount = 0, ordCount = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(PositionGetTicket(i) > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && PositionGetString(POSITION_SYMBOL) == _Symbol)
         posCount++;

   for(int i = OrdersTotal() - 1; i >= 0; i--)
      if(OrderGetTicket(i) > 0 && OrderGetInteger(ORDER_MAGIC) == InpMagicNumber && OrderGetString(ORDER_SYMBOL) == _Symbol)
         ordCount++;

   ObjectSetString(0, prefix + "BPRS", OBJPROP_TEXT, StringFormat("BPRs Vivos: %d | Confluencias MTF: %d zonas", liveCount, liveConf));
   ObjectSetString(0, prefix + "TRADES", OBJPROP_TEXT, StringFormat("Posiciones Vivas: %d | Órdenes Limit: %d", posCount, ordCount));

   string stat = (posCount > 0) ? StringFormat("🚀 %d POSICIÓN GESTIONANDO PARCIALES", posCount) : (ordCount > 0 ? "🎯 ÓRDENES LIMIT AL 50% CE ACTIVAS" : "⚪ ESCANEANDO BPRs...");
   color col = (posCount > 0) ? C'74,222,128' : (ordCount > 0 ? C'245,158,11' : clrGold);

   ObjectSetString(0, prefix + "STATUS", OBJPROP_TEXT, stat);
   ObjectSetInteger(0, prefix + "STATUS", OBJPROP_COLOR, col);
}

void DestroyHUD()
{
   ObjectsDeleteAll(0, m_objPrefix + "HUD_");
}

void CreateLabel(string name, string text, int x, int y, int w, int h, color col, color bgCol, int fontSize = 9, bool isBold = false)
{
   if(w > 0 && h > 0)
   {
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
      ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
      ObjectSetInteger(0, name, OBJPROP_YSIZE, h);
      ObjectSetInteger(0, name, OBJPROP_BGCOLOR, col);
      ObjectSetInteger(0, name, OBJPROP_BORDER_COLOR, bgCol);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   }
   else
   {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
      ObjectSetString(0, name, OBJPROP_TEXT, text);
      ObjectSetString(0, name, OBJPROP_FONT, "Segoe UI");
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fontSize);
      ObjectSetInteger(0, name, OBJPROP_COLOR, col);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   }
}
//+------------------------------------------------------------------+
