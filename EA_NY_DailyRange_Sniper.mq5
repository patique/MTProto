//+------------------------------------------------------------------+
//|                                   EA_NY_DailyRange_Sniper.mq5    |
//|               Estrategia NY Open Daily Range Sniper (XAUUSD)     |
//|       Optimización y Ejecución Automatizada para Cuentas Fondeadas |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab"
#property link      "https://github.com/telegram-mtproto"
#property version   "1.00"
#property description "Estrategia Cuantitativa de Apertura de Nueva York en M15"
#property description "Opera hacia PDH/PDL o R:R fijo tras retesteo y rechazo de la 1ª vela M15 de NY"

#include <Trade\Trade.mqh>

//--- ENUMERACIONES ---
enum ENUM_SL_MODE
{
   SL_CANDLE_EXTREME,    // Extremo de la 1ª vela M15 (+ buffer)
   SL_FIXED_PIPS         // Stop Loss Fijo en Pips (Recomendado 30-35p en Oro)
};

enum ENUM_TP_MODE
{
   TP_PREVIOUS_DAY_LEVEL, // Objetivo al PDH (Compras) o PDL (Ventas)
   TP_FIXED_RR            // Ratio Riesgo:Beneficio Fijo (ej. 1:2.0)
};

enum ENUM_RISK_MODE
{
   RISK_PERCENT,          // % del Balance por Operación
   RISK_FIXED_LOT         // Lotaje Fijo Manual
};

enum ENUM_STRATEGY_MODE
{
   MODE_NY_OPEN_ONLY,           // Solo Tiro 1: Apertura de NY
   MODE_TURTLE_SOUP_REV_ONLY,   // Solo Tiro 2: Reversión Turtle Soup en PDH/PDL
   MODE_BREAKOUT_RETEST_ONLY,   // Solo Tiro 2: Aceptación de Rotura en PDH/PDL
   MODE_DUAL_BIDIRECTIONAL      // Sistema Completo: Apertura NY + Dual PDH/PDL (Turtle Soup si rechaza, Breakout si acepta)
};

enum ENUM_REV_ENTRY
{
   REV_ENTRY_FVG_RETEST,  // Retesteo a FVG / BPR (Mayor Win Rate & R:R)
   REV_ENTRY_BOS_CLOSE    // Entrada Inmediata al Cierre del BOS
};

enum ENUM_REV_TP
{
   REV_TP_FIXED_RR,       // R:R Fijo (ej. 1:2.0 o 1:2.5)
   REV_TP_MIDPOINT        // 50% Rango Diario (Equilibrio)
};

//--- PARÁMETROS DE ENTRADA ---
input group "=== 1. GESTIÓN DE CAPITAL & PROP FIRM ===";
input ENUM_RISK_MODE     InpRiskMode           = RISK_PERCENT; // Modo de Cálculo de Riesgo
input double             InpRiskPercent        = 0.50;         // Riesgo por Trade (% Balance)
input double             InpFixedLotSize       = 0.01;         // Lotaje Fijo (si RISK_FIXED_LOT)
input double             InpMaxDailyLossPct    = 3.0;          // Pérdida Máxima Diaria Permitida (%)
input int                InpMaxTradesPerDay    = 2;            // Máximo Trades por Día (Permite 2 si Dual)
input double             InpMaxSpreadPips      = 3.5;          // Spread Máximo Permitido (Pips en Oro)

input group "=== 2. MODO ESTRATEGIA: TIRO 1 & DUAL TIRO 2 ===";
input ENUM_STRATEGY_MODE InpStrategyMode       = MODE_DUAL_BIDIRECTIONAL; // Modo Operativo General

input group "=== 3. TIRO 1: APERTURA NY (HORARIO SERVIDOR) ===";
input int                InpNYOpenHour         = 15;           // Hora Apertura NY Servidor (Ej: 15 para 15:30)
input int                InpNYOpenMinute       = 30;           // Minuto Apertura NY Servidor (30)
input int                InpSessionDurationMin = 240;          // Ventana de búsqueda de entrada (minutos)
input ENUM_SL_MODE       InpSLMode             = SL_FIXED_PIPS; // Modo de Stop Loss (Tiro 1)
input double             InpFixedSLPips        = 30.0;          // SL Fijo en Pips (Tiro 1)
input double             InpCandleSLBufferPips = 5.0;           // Buffer adicional tras vela M15 (Pips)
input ENUM_TP_MODE       InpTPMode             = TP_FIXED_RR;   // Modo de Take Profit (Tiro 1)
input double             InpFixedRR            = 2.0;           // Ratio R:R (Tiro 1)
input double             InpMinTargetPips      = 25.0;          // Distancia mínima requerida a PDH/PDL (Pips)
input double             InpRetestPercent      = 50.0;          // Nivel de Retesteo 1ª vela (% rango)
input bool               InpRequireWickReject  = true;          // Exigir Mecha de Rechazo
input double             InpMinWickPercent     = 25.0;          // Mecha mínima de rechazo (%)
input bool               InpFilterPremDisc     = false;         // Filtro ICT Discount/Premium

input group "=== 4. TIRO 2: DUAL PDH / PDL (TURTLE SOUP & BREAKOUT RETEST) ===";
input ENUM_REV_ENTRY     InpRevEntryType       = REV_ENTRY_FVG_RETEST; // Gatillo de Entrada Reversión
input ENUM_REV_TP        InpRevTPMode          = REV_TP_FIXED_RR;      // Objetivo de Reversión
input double             InpRevFixedRR         = 2.0;                  // Ratio R:R Fijo (1:2.0 Validado)
input double             InpSweepBufferPips    = 3.0;                  // Buffer sobre mecha del barrido (Pips)
input double             InpMinSweepPips       = 5.0;                  // Barrido Mínimo para Turtle Soup (Pips)
input double             InpMaxSweepPips       = 35.0;                 // Barrido Máximo para Turtle Soup (Pips)
input int                InpMaxBarsOutside     = 3;                    // Velas M15 máx fuera de rango (Turtle Soup)
input double             InpMaxReversalSLPips  = 45.0;                 // SL Máximo permitido (Pips)
input double             InpMinReversalSLPips  = 15.0;                 // SL Mínimo permitido (Pips)
input int                InpBreakoutBarsAccept = 3;                    // Velas M15 consecutivas fuera para confirmar Aceptación

input group "=== 5. CONTROL Y GRÁFICOS ===";
input ulong              InpMagicNumber        = 778899;        // Magic Number
input string             InpTradeComment       = "NY_Sniper_Dual"; // Comentario
input bool               InpDrawVisualLines    = true;          // Dibujar niveles en gráfico

//--- VARIABLES GLOBALES ---
CTrade         m_trade;
datetime       m_lastTradeDay        = 0;
int            m_tradesToday         = 0;
double         m_dayStartBalance     = 0.0;
double         m_pdh                 = 0.0;
double         m_pdl                 = 0.0;
bool           m_nyCandleIdentified  = false;
datetime       m_nyCandleTime        = 0;
double         m_nyOpen              = 0.0;
double         m_nyHigh              = 0.0;
double         m_nyLow               = 0.0;
double         m_nyClose             = 0.0;
int            m_nyBias              = 0; // +1 = BUY, -1 = SELL, 0 = NEUTRO
double         m_retestPrice         = 0.0;
double         m_pipSize             = 0.0001;

//+------------------------------------------------------------------+
//| Obtener tamaño de 1 Pip según la clase de activo                 |
//+------------------------------------------------------------------+
double GetSymbolPipSize()
{
   string sym = _Symbol;
   StringToUpper(sym);

   if (StringFind(sym, "XAU") >= 0 || StringFind(sym, "GOLD") >= 0)
   {
      return 0.10; // 1 pip en Oro = $0.10
   }
   if (StringFind(sym, "XAG") >= 0 || StringFind(sym, "SILVER") >= 0)
   {
      return 0.01; // 1 pip en Plata = $0.01
   }
   if (StringFind(sym, "NAS") >= 0 || StringFind(sym, "US100") >= 0 || StringFind(sym, "USTEC") >= 0 || StringFind(sym, "NDX") >= 0)
   {
      return 1.0;  // 1 punto de índice
   }
   if (StringFind(sym, "JPY") >= 0)
   {
      return 0.01; // 1 pip en pares JPY = 0.01
   }

   // Divisas estándar (EURUSD, GBPUSD, etc.)
   if (_Digits == 5 || _Digits == 3)
   {
      return _Point * 10.0; // 0.0001
   }

   return (_Point > 0.0) ? _Point : 0.0001;
}

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   m_trade.SetExpertMagicNumber(InpMagicNumber);
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(_Symbol);

   m_pipSize         = GetSymbolPipSize();
   m_dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   m_lastTradeDay    = 0;
   m_tradesToday     = 0;

   // Auto-ajuste de hora de sesión si es Nasdaq / US100
   string sym = _Symbol;
   StringToUpper(sym);
   if ((StringFind(sym, "NAS") >= 0 || StringFind(sym, "US100") >= 0 || StringFind(sym, "USTEC") >= 0) && InpNYOpenHour == 15 && InpNYOpenMinute == 30)
   {
      Print("ℹ️ [NY Sniper] Detectado Índice NASDAQ/US100. Se recomienda sesión Wall Street 16:30 server.");
   }

   PrintFormat("🚀 [NY Sniper] Inicializado con éxito en %s. PipSize: %.5f | Modo SL: %s, Modo TP: %s",
               _Symbol, m_pipSize, EnumToString(InpSLMode), EnumToString(InpTPMode));

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if (InpDrawVisualLines)
   {
      ObjectsDeleteAll(0, "NYS_");
   }
}

//+------------------------------------------------------------------+
//| Reset diario de métricas y niveles D1                            |
//+------------------------------------------------------------------+
void CheckNewDay()
{
   MqlDateTime dt;
   TimeCurrent(dt);
   datetime todayStart = StringToTime(StringFormat("%04d.%02d.%02d 00:00:00", dt.year, dt.mon, dt.day));

   if (m_lastTradeDay != todayStart)
   {
      m_lastTradeDay       = todayStart;
      m_tradesToday        = 0;
      m_dayStartBalance    = AccountInfoDouble(ACCOUNT_BALANCE);
      m_nyCandleIdentified = false;
      m_nyCandleTime       = 0;
      m_nyBias             = 0;

      // Obtener Alto y Mínimo de la vela Diaria anterior (D1)
      MqlRates d1Rates[];
      ArraySetAsSeries(d1Rates, true);
      if (CopyRates(_Symbol, PERIOD_D1, 1, 1, d1Rates) >= 1)
      {
         m_pdh = d1Rates[0].high;
         m_pdl = d1Rates[0].low;

         PrintFormat("📅 [NY Sniper] Nuevo Día detectado. PDH: %.4f | PDL: %.4f | Rango D1: %.1f pips",
                     m_pdh, m_pdl, (m_pdh - m_pdl) / m_pipSize);

         if (InpDrawVisualLines)
         {
            DrawHorizontalLine("NYS_PDH", m_pdh, clrLimeGreen, STYLE_DASH, 2, "PDH (Prev Day High)");
            DrawHorizontalLine("NYS_PDL", m_pdl, clrCrimson,   STYLE_DASH, 2, "PDL (Prev Day Low)");
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   CheckNewDay();

   // 1. Control de drawdown diario de Prop Firm
   double currentEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   if (m_dayStartBalance > 0.0)
   {
      double dailyDrawdownPct = ((m_dayStartBalance - currentEquity) / m_dayStartBalance) * 100.0;
      if (dailyDrawdownPct >= InpMaxDailyLossPct)
      {
         return;
      }
   }

   // 2. Control de operaciones por día y posiciones abiertas
   if (m_tradesToday >= InpMaxTradesPerDay) return;
   if (HasOpenPosition()) return;

   // 3. Verificar Spread
   double spreadPips = (double)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) * _Point / m_pipSize;
   if (spreadPips > InpMaxSpreadPips) return;

   // 4. Identificar la 1ª vela M15 de la apertura de Nueva York
   MqlDateTime dt;
   TimeCurrent(dt);

   datetime nyTargetTime = StringToTime(StringFormat("%04d.%02d.%02d %02d:%02d:00",
                                        dt.year, dt.mon, dt.day, InpNYOpenHour, InpNYOpenMinute));

   if (TimeCurrent() < nyTargetTime + 15 * 60)
   {
      return;
   }

   if (TimeCurrent() > nyTargetTime + InpSessionDurationMin * 60)
   {
      return;
   }

   if (!m_nyCandleIdentified && (InpStrategyMode == MODE_NY_OPEN_ONLY || InpStrategyMode == MODE_DUAL_BIDIRECTIONAL))
   {
      MqlRates m15Rates[];
      ArraySetAsSeries(m15Rates, true);
      int copied = CopyRates(_Symbol, PERIOD_M15, 0, 30, m15Rates);
      if (copied > 0)
      {
         int nyBarIdx = -1;
         for (int i = 0; i < copied; i++)
         {
            if (m15Rates[i].time == nyTargetTime)
            {
               nyBarIdx = i;
               break;
            }
         }

         if (nyBarIdx > 0)
         {
            m_nyCandleTime = m15Rates[nyBarIdx].time;
            m_nyOpen       = m15Rates[nyBarIdx].open;
            m_nyHigh       = m15Rates[nyBarIdx].high;
            m_nyLow        = m15Rates[nyBarIdx].low;
            m_nyClose      = m15Rates[nyBarIdx].close;

            if (m_nyClose > m_nyOpen)
            {
               m_nyBias = 1; // ALCISTA -> BUY hacia PDH
            }
            else if (m_nyClose < m_nyOpen)
            {
               m_nyBias = -1; // BAJISTA -> SELL hacia PDL
            }
            else
            {
               m_nyBias = 0;
            }

            if (m_nyBias != 0)
            {
               double candleRange = m_nyHigh - m_nyLow;
               if (m_nyBias == 1)
               {
                  m_retestPrice = m_nyLow + candleRange * (1.0 - InpRetestPercent / 100.0);
               }
               else
               {
                  m_retestPrice = m_nyHigh - candleRange * (1.0 - InpRetestPercent / 100.0);
               }

               m_nyCandleIdentified = true;

               PrintFormat("🎯 [NY Sniper - Tiro 1] 1ª Vela M15 NY (%s). Dirección: %s | Retest 50%%: %.4f",
                           TimeToString(m_nyCandleTime), m_nyBias == 1 ? "BUY" : "SELL", m_retestPrice);

               if (InpDrawVisualLines)
               {
                  DrawHorizontalLine("NYS_RETEST", m_retestPrice, clrGold, STYLE_DOT, 1, "Retest Level T1");
               }
            }
         }
      }
   }

   // Ejecutar Tiro 1 (Apertura NY) si corresponde
   if (InpStrategyMode == MODE_NY_OPEN_ONLY || InpStrategyMode == MODE_DUAL_BIDIRECTIONAL)
   {
      EvaluateEntry();
      if (HasOpenPosition()) return;
   }

   // Ejecutar Tiro 2 (Dual PDH / PDL: Turtle Soup si rechaza, Breakout si acepta)
   if (InpStrategyMode != MODE_NY_OPEN_ONLY)
   {
      EvaluatePDHPDLDual();
   }
}

//+------------------------------------------------------------------+
//| Evaluar condiciones de entrada al retesteo y rechazo             |
//+------------------------------------------------------------------+
void EvaluateEntry()
{
   if (!m_nyCandleIdentified || m_nyBias == 0) return;

   double prevMid = (m_pdh + m_pdl) / 2.0;
   if (InpFilterPremDisc)
   {
      if (m_nyBias == 1 && m_nyClose > prevMid) return;
      if (m_nyBias == -1 && m_nyClose < prevMid) return;
   }

   MqlRates currentM15[];
   ArraySetAsSeries(currentM15, true);
   if (CopyRates(_Symbol, PERIOD_M15, 1, 2, currentM15) < 2) return;

   MqlRates lastClosedBar = currentM15[0];
   if (lastClosedBar.time <= m_nyCandleTime) return;

   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   // COMPRA (BUY):
   if (m_nyBias == 1)
   {
      bool didTouchRetest = (lastClosedBar.low <= m_retestPrice);
      if (!didTouchRetest) return;

      if (InpRequireWickReject)
      {
         double barRange = lastClosedBar.high - lastClosedBar.low;
         if (barRange > 0.0)
         {
            double lowerWick = MathMin(lastClosedBar.open, lastClosedBar.close) - lastClosedBar.low;
            double wickPct = (lowerWick / barRange) * 100.0;
            if (wickPct < InpMinWickPercent) return;
         }
      }

      double slPrice = 0.0;
      double slDistancePips = 0.0;

      if (InpSLMode == SL_CANDLE_EXTREME)
      {
         slPrice = m_nyLow - (InpCandleSLBufferPips * m_pipSize);
         slDistancePips = (currentAsk - slPrice) / m_pipSize;
      }
      else
      {
         slDistancePips = InpFixedSLPips;
         slPrice = currentAsk - (InpFixedSLPips * m_pipSize);
      }

      if (slDistancePips <= 0) return;

      double tpPrice = 0.0;
      if (InpTPMode == TP_PREVIOUS_DAY_LEVEL)
      {
         tpPrice = m_pdh;
         double targetPips = (tpPrice - currentAsk) / m_pipSize;
         if (targetPips < InpMinTargetPips) return;
      }
      else
      {
         tpPrice = currentAsk + (slDistancePips * InpFixedRR * m_pipSize);
      }

      double lots = CalculateLotSize(slDistancePips);
      if (lots <= 0.0) return;

      if (m_trade.Buy(lots, _Symbol, currentAsk, slPrice, tpPrice, InpTradeComment))
      {
         m_tradesToday++;
         PrintFormat("✅ [NY Sniper] BUY Ejecutado! Lotes: %.2f | Entry: %.4f | SL: %.4f (%0.1fp) | TP: %.4f",
                     lots, currentAsk, slPrice, slDistancePips, tpPrice);
      }
   }
   // VENTA (SELL):
   else if (m_nyBias == -1)
   {
      bool didTouchRetest = (lastClosedBar.high >= m_retestPrice);
      if (!didTouchRetest) return;

      if (InpRequireWickReject)
      {
         double barRange = lastClosedBar.high - lastClosedBar.low;
         if (barRange > 0.0)
         {
            double upperWick = lastClosedBar.high - MathMax(lastClosedBar.open, lastClosedBar.close);
            double wickPct = (upperWick / barRange) * 100.0;
            if (wickPct < InpMinWickPercent) return;
         }
      }

      double slPrice = 0.0;
      double slDistancePips = 0.0;

      if (InpSLMode == SL_CANDLE_EXTREME)
      {
         slPrice = m_nyHigh + (InpCandleSLBufferPips * m_pipSize);
         slDistancePips = (slPrice - currentBid) / m_pipSize;
      }
      else
      {
         slDistancePips = InpFixedSLPips;
         slPrice = currentBid + (InpFixedSLPips * m_pipSize);
      }

      if (slDistancePips <= 0) return;

      double tpPrice = 0.0;
      if (InpTPMode == TP_PREVIOUS_DAY_LEVEL)
      {
         tpPrice = m_pdl;
         double targetPips = (currentBid - tpPrice) / m_pipSize;
         if (targetPips < InpMinTargetPips) return;
      }
      else
      {
         tpPrice = currentBid - (slDistancePips * InpFixedRR * m_pipSize);
      }

      double lots = CalculateLotSize(slDistancePips);
      if (lots <= 0.0) return;

      if (m_trade.Sell(lots, _Symbol, currentBid, slPrice, tpPrice, InpTradeComment))
      {
         m_tradesToday++;
         PrintFormat("✅ [NY Sniper] SELL Ejecutado! Lotes: %.2f | Entry: %.4f | SL: %.4f (%0.1fp) | TP: %.4f",
                     lots, currentBid, slPrice, slDistancePips, tpPrice);
      }
   }
}

//+------------------------------------------------------------------+
//| Tiro 2: Dual PDH / PDL (Turtle Soup si rechaza, Breakout si acepta)|
//+------------------------------------------------------------------+
void EvaluatePDHPDLDual()
{
   if (HasOpenPosition()) return;
   if (m_pdh <= 0.0 || m_pdl <= 0.0) return;

   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(_Symbol, PERIOD_M15, 0, 15, rates);
   if (copied < 8) return;

   MqlRates currentBar = rates[1];
   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double currentAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double midpoint   = (m_pdh + m_pdl) / 2.0;

   bool allowTurtle   = (InpStrategyMode == MODE_TURTLE_SOUP_REV_ONLY || InpStrategyMode == MODE_DUAL_BIDIRECTIONAL);
   bool allowBreakout = (InpStrategyMode == MODE_BREAKOUT_RETEST_ONLY || InpStrategyMode == MODE_DUAL_BIDIRECTIONAL);

   // =================================================================
   // 1. ANÁLISIS EN PDH (MÁXIMO DEL DÍA ANTERIOR)
   // =================================================================
   int sweepHighIdx = -1;
   double sweepHigh = -1.0;
   for (int i = 1; i < MathMin(copied, 8); i++)
   {
      if (rates[i].high > m_pdh)
      {
         if (rates[i].high > sweepHigh)
         {
            sweepHigh = rates[i].high;
            sweepHighIdx = i;
         }
      }
   }

   // --- SUB-ESCENARIO 1.A: TURTLE SOUP SELL (RECHAZO DENTRO DE 3 VELAS) ---
   if (allowTurtle && sweepHighIdx > 0 && sweepHighIdx <= InpMaxBarsOutside + 1)
   {
      double sweepDepthPips = (sweepHigh - m_pdh) / m_pipSize;
      if (sweepDepthPips >= InpMinSweepPips && sweepDepthPips <= InpMaxSweepPips)
      {
         bool closedBelowPDH = (currentBar.close < m_pdh);
         bool bosConfirmed   = (currentBar.close < rates[sweepHighIdx].low);

         if (closedBelowPDH && bosConfirmed)
         {
            bool hasFvg = false;
            double fvgTop = 0.0, fvgBottom = 0.0;
            if (rates[3].low > rates[1].high)
            {
               hasFvg = true;
               fvgTop = rates[3].low;
               fvgBottom = rates[1].high;
            }

            double slPrice = sweepHigh + (InpSweepBufferPips * m_pipSize);
            double entryPrice = 0.0;

            if (InpRevEntryType == REV_ENTRY_FVG_RETEST)
            {
               if (hasFvg && currentBid >= fvgBottom && currentBid <= slPrice)
                  entryPrice = currentBid;
               else if (!hasFvg)
                  entryPrice = currentBid;
            }
            else
            {
               entryPrice = currentBid;
            }

            if (entryPrice > 0.0)
            {
               double slDistancePips = (slPrice - entryPrice) / m_pipSize;
               if (slDistancePips >= InpMinReversalSLPips && slDistancePips <= InpMaxReversalSLPips)
               {
                  double tpPrice = (InpRevTPMode == REV_TP_MIDPOINT)
                                    ? midpoint
                                    : entryPrice - (slDistancePips * InpRevFixedRR * m_pipSize);

                  if (tpPrice > 0.0 && tpPrice < entryPrice)
                  {
                     double lots = CalculateLotSize(slDistancePips);
                     if (lots > 0.0 && m_trade.Sell(lots, _Symbol, entryPrice, slPrice, tpPrice, InpTradeComment + "_TurtlePDH"))
                     {
                        m_tradesToday++;
                        PrintFormat("🎯 [NY Sniper - Turtle Soup] SELL PDH! Lotes: %.2f | Entry: %.4f | SL: %.4f (%0.1fp) | TP: %.4f",
                                    lots, entryPrice, slPrice, slDistancePips, tpPrice);
                        return;
                     }
                  }
               }
            }
         }
      }
   }

   // --- SUB-ESCENARIO 1.B: TREND ACCEPTANCE BUY (BREAKOUT & RETEST PDH) ---
   if (allowBreakout)
   {
      bool acceptAbove = (rates[1].close > m_pdh && rates[2].close > m_pdh && rates[3].close > m_pdh);
      if (acceptAbove)
      {
         if (currentBid <= m_pdh + (4.0 * m_pipSize) && currentBid >= m_pdh - (2.5 * m_pipSize))
         {
            double entryPrice = currentAsk;
            double slPrice = m_pdh - (18.0 * m_pipSize);
            double slDistancePips = (entryPrice - slPrice) / m_pipSize;

            if (slDistancePips >= InpMinReversalSLPips && slDistancePips <= InpMaxReversalSLPips)
            {
               double tpPrice = entryPrice + (slDistancePips * InpRevFixedRR * m_pipSize);
               double lots = CalculateLotSize(slDistancePips);
               if (lots > 0.0 && m_trade.Buy(lots, _Symbol, entryPrice, slPrice, tpPrice, InpTradeComment + "_BrkPDH"))
               {
                  m_tradesToday++;
                  PrintFormat("🚀 [NY Sniper - Breakout Retest] BUY PDH ACEPTADO! Lotes: %.2f | Entry: %.4f | SL: %.4f (%0.1fp) | TP: %.4f",
                              lots, entryPrice, slPrice, slDistancePips, tpPrice);
                  return;
               }
            }
         }
      }
   }

   // =================================================================
   // 2. ANÁLISIS EN PDL (MÍNIMO DEL DÍA ANTERIOR)
   // =================================================================
   int sweepLowIdx = -1;
   double sweepLow = 9999999.0;
   for (int i = 1; i < MathMin(copied, 8); i++)
   {
      if (rates[i].low < m_pdl)
      {
         if (rates[i].low < sweepLow)
         {
            sweepLow = rates[i].low;
            sweepLowIdx = i;
         }
      }
   }

   // --- SUB-ESCENARIO 2.A: TURTLE SOUP BUY (RECHAZO DENTRO DE 3 VELAS) ---
   if (allowTurtle && sweepLowIdx > 0 && sweepLowIdx <= InpMaxBarsOutside + 1)
   {
      double sweepDepthPips = (m_pdl - sweepLow) / m_pipSize;
      if (sweepDepthPips >= InpMinSweepPips && sweepDepthPips <= InpMaxSweepPips)
      {
         bool closedAbovePDL = (currentBar.close > m_pdl);
         bool bosConfirmed   = (currentBar.close > rates[sweepLowIdx].high);

         if (closedAbovePDL && bosConfirmed)
         {
            bool hasFvg = false;
            double fvgTop = 0.0, fvgBottom = 0.0;
            if (rates[1].low > rates[3].high)
            {
               hasFvg = true;
               fvgBottom = rates[3].high;
               fvgTop = rates[1].low;
            }

            double slPrice = sweepLow - (InpSweepBufferPips * m_pipSize);
            double entryPrice = 0.0;

            if (InpRevEntryType == REV_ENTRY_FVG_RETEST)
            {
               if (hasFvg && currentAsk <= fvgTop && currentAsk >= slPrice)
                  entryPrice = currentAsk;
               else if (!hasFvg)
                  entryPrice = currentAsk;
            }
            else
            {
               entryPrice = currentAsk;
            }

            if (entryPrice > 0.0)
            {
               double slDistancePips = (entryPrice - slPrice) / m_pipSize;
               if (slDistancePips >= InpMinReversalSLPips && slDistancePips <= InpMaxReversalSLPips)
               {
                  double tpPrice = (InpRevTPMode == REV_TP_MIDPOINT)
                                    ? midpoint
                                    : entryPrice + (slDistancePips * InpRevFixedRR * m_pipSize);

                  if (tpPrice > 0.0 && tpPrice > entryPrice)
                  {
                     double lots = CalculateLotSize(slDistancePips);
                     if (lots > 0.0 && m_trade.Buy(lots, _Symbol, entryPrice, slPrice, tpPrice, InpTradeComment + "_TurtlePDL"))
                     {
                        m_tradesToday++;
                        PrintFormat("🎯 [NY Sniper - Turtle Soup] BUY PDL! Lotes: %.2f | Entry: %.4f | SL: %.4f (%0.1fp) | TP: %.4f",
                                    lots, entryPrice, slPrice, slDistancePips, tpPrice);
                        return;
                     }
                  }
               }
            }
         }
      }
   }

   // --- SUB-ESCENARIO 2.B: TREND ACCEPTANCE SELL (BREAKOUT & RETEST PDL) ---
   if (allowBreakout)
   {
      bool acceptBelow = (rates[1].close < m_pdl && rates[2].close < m_pdl && rates[3].close < m_pdl);
      if (acceptBelow)
      {
         if (currentAsk >= m_pdl - (4.0 * m_pipSize) && currentAsk <= m_pdl + (2.5 * m_pipSize))
         {
            double entryPrice = currentBid;
            double slPrice = m_pdl + (18.0 * m_pipSize);
            double slDistancePips = (slPrice - entryPrice) / m_pipSize;

            if (slDistancePips >= InpMinReversalSLPips && slDistancePips <= InpMaxReversalSLPips)
            {
               double tpPrice = entryPrice - (slDistancePips * InpRevFixedRR * m_pipSize);
               double lots = CalculateLotSize(slDistancePips);
               if (lots > 0.0 && m_trade.Sell(lots, _Symbol, entryPrice, slPrice, tpPrice, InpTradeComment + "_BrkPDL"))
               {
                  m_tradesToday++;
                  PrintFormat("🚀 [NY Sniper - Breakout Retest] SELL PDL ACEPTADO! Lotes: %.2f | Entry: %.4f | SL: %.4f (%0.1fp) | TP: %.4f",
                              lots, entryPrice, slPrice, slDistancePips, tpPrice);
                  return;
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Cálculo Dinámico de Tamaño de Lote según Riesgo                  |
//+------------------------------------------------------------------+
double CalculateLotSize(double slPips)
{
   if (InpRiskMode == RISK_FIXED_LOT)
   {
      return InpFixedLotSize;
   }

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmount = balance * (InpRiskPercent / 100.0);

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);

   if (tickSize <= 0.0 || tickValue <= 0.0 || slPips <= 0.0) return 0.01;

   double slDistancePrice = slPips * m_pipSize;
   double riskPerLot = (slDistancePrice / tickSize) * tickValue;

   if (riskPerLot <= 0.0) return 0.01;

   double lots = riskAmount / riskPerLot;

   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   lots = MathFloor(lots / lotStep) * lotStep;
   lots = MathMax(minLot, MathMin(maxLot, lots));

   return lots;
}

//+------------------------------------------------------------------+
//| Verificar si ya existe posición abierta con este MagicNumber     |
//+------------------------------------------------------------------+
bool HasOpenPosition()
{
   for (int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if (PositionGetSymbol(i) == _Symbol)
      {
         if (PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
         {
            return true;
         }
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Dibujar líneas horizontales visuales                             |
//+------------------------------------------------------------------+
void DrawHorizontalLine(string name, double price, color col, ENUM_LINE_STYLE style, int width, string text)
{
   if (ObjectFind(0, name) < 0)
   {
      ObjectCreate(0, name, OBJ_HLINE, 0, 0, price);
   }
   ObjectSetDouble(0, name, OBJPROP_PRICE, price);
   ObjectSetInteger(0, name, OBJPROP_COLOR, col);
   ObjectSetInteger(0, name, OBJPROP_STYLE, style);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, width);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
}
