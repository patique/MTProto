//+------------------------------------------------------------------+
//|                                     Ind_BPR_WarriorTrader.mq5    |
//|                 Réplica Exacta del Indicador BPR WarriorTrader   |
//|                    Neutral Directional + Multi-Timeframe (MTF)   |
//+------------------------------------------------------------------+
#property copyright   "Antigravity Quantitative Trading"
#property link        "https://t.me/WarriorTraderClub"
#property version     "2.00"
#property description "BPR sin sesgo direccional + Detección automática de Confluencias Multi-Temporalidad (M15, M30, H1)."
#property indicator_chart_window
#property indicator_plots 0

//--- ENUMERACIONES ---
enum ENUM_DISPLAY_MODE
{
   DISPLAY_ALL_ACTIVE_AND_MITIGATED, // Mostrar Históricos y Activos
   DISPLAY_ONLY_ACTIVE_BPR           // Mostrar Únicamente BPRs Activos Vivos
};

//--- PARÁMETROS DE ENTRADA (INPUTS) ---
input group "=== 🎯 1. PARÁMETROS DEL BPR (PINE SCRIPT WARRIOR) ===";
input int                InpBarsSince         = 10;                // Bars to Look Back for BPR (bars_since)
input double             InpBprThreshold      = 0.0;               // BPR Threshold en Puntos (0 = cualquier solape)
input bool               InpOnlyCleanBpr      = false;             // Only Clean BPR (Sin mechas previas que violen zona)
input ENUM_DISPLAY_MODE  InpDisplayMode       = DISPLAY_ALL_ACTIVE_AND_MITIGATED; // Modo de Visualización
input int                InpMaxBarsScan       = 1000;              // Historial Máximo de Barras a Escanear

input group "=== 🎨 2. ESTILO Y CONFLUENCIA MULTI-TIMEFRAME (MTF) ===";
input color              InpBprColor          = C'100,116,139';    // Color BPR Neutro Base (Slate / Sin sesgo direccional)
input color              InpConfluenceColor   = C'245,158,11';     // Color BPR Confluencia MTF (Oro / Alta Probabilidad)
input bool               InpCheckConfluence   = true;              // Detectar Confluencia con Temporalidades Superiores
input ENUM_TIMEFRAMES    InpHigherTF_1        = PERIOD_M30;        // Temporalidad Superior 1
input ENUM_TIMEFRAMES    InpHigherTF_2        = PERIOD_H1;         // Temporalidad Superior 2
input bool               InpShowCE50          = true;              // Dibujar Línea Central CE 50% (Gatillo Limit)
input bool               InpShowHUD           = true;              // Mostrar Panel de Información en Gráfico

//--- ESTRUCTURAS DE DATOS ---
struct BprRecord
{
   bool     isBullish;
   double   high;
   double   low;
   double   ce50;
   int      startBarIdx;
   datetime startTime;
   int      endBarIdx;
   datetime endTime;
   bool     isMitigated;
   datetime mitigationTime;
   int      confluenceCount;
   string   confluenceInfo;
   string   boxName;
   string   ceLineName;
};

//--- VARIABLES GLOBALES ---
BprRecord m_bprs[];
datetime  m_lastCalcBarTime = 0;
string    m_prefix = "WTC_BPR_";

//+------------------------------------------------------------------+
//| Custom indicator initialization function                         |
//+------------------------------------------------------------------+
int OnInit()
{
   ArrayResize(m_bprs, 0);
   m_lastCalcBarTime = 0;

   // Limpiar objetos gráficos previos de este indicador
   ObjectsDeleteAll(0, m_prefix);

   if(InpShowHUD)
      CreateHUD();

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Custom indicator deinitialization function                       |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   ObjectsDeleteAll(0, m_prefix);
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| Escaneo rápido de BPRs en una temporalidad específica           |
//+------------------------------------------------------------------+
void ScanBprsForTimeframe(ENUM_TIMEFRAMES tf, BprRecord &outBprs[])
{
   ArrayResize(outBprs, 0);
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(_Symbol, tf, 0, MathMin(InpMaxBarsScan, 300), rates);
   if(copied < InpBarsSince + 5) return;

   int lastBear = -1;
   int lastBull = -1;

   for(int i = 3; i < copied - 1; i++)
   {
      bool new_fvg_bearish = (rates[i - 2].low - rates[i].high > 0);
      bool new_fvg_bullish = (rates[i].low - rates[i - 2].high > 0);

      if(new_fvg_bearish) lastBear = i;
      if(new_fvg_bullish) lastBull = i;

      // Bullish BPR en HTF
      if(new_fvg_bullish && lastBear != -1 && (i - lastBear) <= InpBarsSince)
      {
         double cLow  = MathMax(rates[lastBear].high, rates[i - 2].high);
         double cHigh = MathMin(rates[lastBear - 2].low, rates[i].low);
         if(cHigh > cLow)
         {
            int sz = ArraySize(outBprs);
            ArrayResize(outBprs, sz + 1);
            outBprs[sz].high = cHigh;
            outBprs[sz].low  = cLow;
            outBprs[sz].ce50 = (cHigh + cLow) / 2.0;
         }
      }

      // Bearish BPR en HTF
      if(new_fvg_bearish && lastBull != -1 && (i - lastBull) <= InpBarsSince)
      {
         double cLow  = MathMax(rates[lastBull - 2].high, rates[i].high);
         double cHigh = MathMin(rates[lastBull].low, rates[i - 2].low);
         if(cHigh > cLow)
         {
            int sz = ArraySize(outBprs);
            ArrayResize(outBprs, sz + 1);
            outBprs[sz].high = cHigh;
            outBprs[sz].low  = cLow;
            outBprs[sz].ce50 = (cHigh + cLow) / 2.0;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Custom indicator iteration function                              |
//+------------------------------------------------------------------+
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(rates_total < InpBarsSince + 5)
      return(0);

   datetime currentBarTime = time[rates_total - 1];
   bool isNewBar = (currentBarTime != m_lastCalcBarTime);

   if(prev_calculated == 0 || isNewBar)
   {
      m_lastCalcBarTime = currentBarTime;
      CalculateAndDrawBPRs(rates_total, time, high, low, open, close);
   }
   else
   {
      UpdateLiveExtensions(rates_total, time, high, low);
   }

   if(InpShowHUD)
      UpdateHUD(rates_total, high, low, close);

   return(rates_total);
}

//+------------------------------------------------------------------+
//| Cálculo del BPR según la formulación exacta de WarriorTraderClub |
//+------------------------------------------------------------------+
void CalculateAndDrawBPRs(const int rates_total,
                          const datetime &time[],
                          const double &high[],
                          const double &low[],
                          const double &open[],
                          const double &close[])
{
   // Limpiar objetos y array
   ObjectsDeleteAll(0, m_prefix + "BOX_");
   ObjectsDeleteAll(0, m_prefix + "CE_");
   ArrayResize(m_bprs, 0);

   int startIdx = MathMax(3, rates_total - InpMaxBarsScan);

   int lastBearFvgBar = -1;
   int lastBullFvgBar = -1;

   for(int i = startIdx; i < rates_total - 1; i++)
   {
      bool new_fvg_bearish = (low[i - 2] - high[i] > 0);
      bool new_fvg_bullish = (low[i] - high[i - 2] > 0);

      if(new_fvg_bearish)
         lastBearFvgBar = i;

      if(new_fvg_bullish)
         lastBullFvgBar = i;

      // 1. EVALUAR BULLISH BPR
      if(new_fvg_bullish && lastBearFvgBar != -1)
      {
         int bull_num_since = i - lastBearFvgBar;
         if(bull_num_since <= InpBarsSince)
         {
            double bearFvgTop = low[lastBearFvgBar - 2];
            double bearFvgBtm = high[lastBearFvgBar];
            double bullFvgTop = low[i];
            double bullFvgBtm = high[i - 2];

            double combinedLow  = MathMax(bearFvgBtm, bullFvgBtm);
            double combinedHigh = MathMin(bearFvgTop, bullFvgTop);

            if(combinedHigh > combinedLow && (combinedHigh - combinedLow >= InpBprThreshold * _Point))
            {
               bool clean = true;
               if(InpOnlyCleanBpr)
               {
                  for(int h = lastBearFvgBar; h <= i; h++)
                  {
                     if(high[h] > combinedLow)
                     {
                        clean = false;
                        break;
                     }
                  }
               }

               if(clean)
               {
                  BprRecord rec;
                  rec.isBullish     = true;
                  rec.high          = combinedHigh;
                  rec.low           = combinedLow;
                  rec.ce50          = NormalizeDouble((combinedHigh + combinedLow) / 2.0, _Digits);
                  rec.startBarIdx   = lastBearFvgBar - 2;
                  rec.startTime     = time[rec.startBarIdx];
                  rec.endBarIdx     = rates_total - 1;
                  rec.endTime       = time[rates_total - 1];
                  rec.isMitigated   = false;
                  rec.mitigationTime= 0;
                  rec.confluenceCount = 0;
                  rec.confluenceInfo  = "";
                  rec.boxName       = StringFormat("%sBOX_%d", m_prefix, (int)rec.startTime);
                  rec.ceLineName    = StringFormat("%sCE_%d", m_prefix, (int)rec.startTime);

                  for(int m = i + 1; m < rates_total; m++)
                  {
                     if(low[m] < combinedLow)
                     {
                        rec.isMitigated    = true;
                        rec.mitigationTime = time[m];
                        rec.endBarIdx      = m;
                        rec.endTime        = time[m];
                        break;
                     }
                  }

                  int sz = ArraySize(m_bprs);
                  ArrayResize(m_bprs, sz + 1);
                  m_bprs[sz] = rec;
               }
            }
         }
      }

      // 2. EVALUAR BEARISH BPR
      if(new_fvg_bearish && lastBullFvgBar != -1)
      {
         int bear_num_since = i - lastBullFvgBar;
         if(bear_num_since <= InpBarsSince)
         {
            double bullFvgTop = low[lastBullFvgBar];
            double bullFvgBtm = high[lastBullFvgBar - 2];
            double bearFvgTop = low[i - 2];
            double bearFvgBtm = high[i];

            double combinedLow  = MathMax(bullFvgBtm, bearFvgBtm);
            double combinedHigh = MathMin(bullFvgTop, bearFvgTop);

            if(combinedHigh > combinedLow && (combinedHigh - combinedLow >= InpBprThreshold * _Point))
            {
               bool clean = true;
               if(InpOnlyCleanBpr)
               {
                  for(int h = lastBullFvgBar; h <= i; h++)
                  {
                     if(low[h] < combinedHigh)
                     {
                        clean = false;
                        break;
                     }
                  }
               }

               if(clean)
               {
                  BprRecord rec;
                  rec.isBullish     = false;
                  rec.high          = combinedHigh;
                  rec.low           = combinedLow;
                  rec.ce50          = NormalizeDouble((combinedHigh + combinedLow) / 2.0, _Digits);
                  rec.startBarIdx   = lastBullFvgBar - 2;
                  rec.startTime     = time[rec.startBarIdx];
                  rec.endBarIdx     = rates_total - 1;
                  rec.endTime       = time[rates_total - 1];
                  rec.isMitigated   = false;
                  rec.mitigationTime= 0;
                  rec.confluenceCount = 0;
                  rec.confluenceInfo  = "";
                  rec.boxName       = StringFormat("%sBOX_%d", m_prefix, (int)rec.startTime);
                  rec.ceLineName    = StringFormat("%sCE_%d", m_prefix, (int)rec.startTime);

                  for(int m = i + 1; m < rates_total; m++)
                  {
                     if(high[m] > combinedHigh)
                     {
                        rec.isMitigated    = true;
                        rec.mitigationTime = time[m];
                        rec.endBarIdx      = m;
                        rec.endTime        = time[m];
                        break;
                     }
                  }

                  int sz = ArraySize(m_bprs);
                  ArrayResize(m_bprs, sz + 1);
                  m_bprs[sz] = rec;
               }
            }
         }
      }
   }

   // 3. DETECTAR CONFLUENCIA MULTI-TIMEFRAME (M15, M30, H1)
   if(InpCheckConfluence && ArraySize(m_bprs) > 0)
   {
      BprRecord htf1[];
      BprRecord htf2[];
      ScanBprsForTimeframe(InpHigherTF_1, htf1);
      ScanBprsForTimeframe(InpHigherTF_2, htf2);

      for(int b = 0; b < ArraySize(m_bprs); b++)
      {
         bool matchTF1 = false;
         for(int k = 0; k < ArraySize(htf1); k++)
         {
            if(m_bprs[b].high >= htf1[k].low && m_bprs[b].low <= htf1[k].high)
            {
               matchTF1 = true;
               break;
            }
         }

         bool matchTF2 = false;
         for(int k = 0; k < ArraySize(htf2); k++)
         {
            if(m_bprs[b].high >= htf2[k].low && m_bprs[b].low <= htf2[k].high)
            {
               matchTF2 = true;
               break;
            }
         }

         if(matchTF1)
         {
            m_bprs[b].confluenceCount++;
            m_bprs[b].confluenceInfo += EnumToString(InpHigherTF_1) + " ";
         }
         if(matchTF2)
         {
            m_bprs[b].confluenceCount++;
            m_bprs[b].confluenceInfo += EnumToString(InpHigherTF_2) + " ";
         }
      }
   }

   // Dibujar todos los BPRs procesados
   DrawAllBprObjects(rates_total, time);
}

//+------------------------------------------------------------------+
//| Dibujar cajas y líneas CE 50% de los BPRs                        |
//+------------------------------------------------------------------+
void DrawAllBprObjects(const int rates_total, const datetime &time[])
{
   datetime chartProjectEnd = time[rates_total - 1] + PeriodSeconds() * 20;

   for(int i = 0; i < ArraySize(m_bprs); i++)
   {
      if(InpDisplayMode == DISPLAY_ONLY_ACTIVE_BPR && m_bprs[i].isMitigated)
         continue;

      // Color: Si tiene 1 o más confluencias con TF superiores -> Dorado/Ámbar, sino Color Neutro
      bool hasConfluence = (m_bprs[i].confluenceCount > 0);
      color boxColor = hasConfluence ? InpConfluenceColor : InpBprColor;
      datetime rightTime = m_bprs[i].isMitigated ? m_bprs[i].endTime : chartProjectEnd;

      // 1. Caja BPR (Rectángulo)
      if(ObjectFind(0, m_bprs[i].boxName) < 0)
      {
         ObjectCreate(0, m_bprs[i].boxName, OBJ_RECTANGLE, 0, m_bprs[i].startTime, m_bprs[i].high, rightTime, m_bprs[i].low);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_COLOR, boxColor);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_BGCOLOR, boxColor);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_FILL, true);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_BACK, true);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_STYLE, m_bprs[i].isMitigated ? STYLE_DOT : STYLE_SOLID);
         ObjectSetString(0, m_bprs[i].boxName, OBJPROP_TOOLTIP, hasConfluence ? StringFormat("⚡ BPR CONFLUENCIA MTF [%s]", m_bprs[i].confluenceInfo) : "BPR Neutro");
      }
      else
      {
         ObjectSetDouble(0, m_bprs[i].boxName, OBJPROP_PRICE, 0, m_bprs[i].high);
         ObjectSetDouble(0, m_bprs[i].boxName, OBJPROP_PRICE, 1, m_bprs[i].low);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_TIME, 0, m_bprs[i].startTime);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_TIME, 1, rightTime);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_COLOR, boxColor);
         ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_BGCOLOR, boxColor);
      }

      // 2. Línea Central CE 50% (Punto clave para órdenes Limit)
      if(InpShowCE50)
      {
         if(ObjectFind(0, m_bprs[i].ceLineName) < 0)
         {
            ObjectCreate(0, m_bprs[i].ceLineName, OBJ_TREND, 0, m_bprs[i].startTime, m_bprs[i].ce50, rightTime, m_bprs[i].ce50);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_COLOR, boxColor);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_STYLE, STYLE_DASH);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_WIDTH, hasConfluence ? 2 : 1);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_RAY_RIGHT, !m_bprs[i].isMitigated);
            ObjectSetString(0, m_bprs[i].ceLineName, OBJPROP_TOOLTIP, StringFormat("CE 50%% Limit: %.2f", m_bprs[i].ce50));
         }
         else
         {
            ObjectSetDouble(0, m_bprs[i].ceLineName, OBJPROP_PRICE, 0, m_bprs[i].ce50);
            ObjectSetDouble(0, m_bprs[i].ceLineName, OBJPROP_PRICE, 1, m_bprs[i].ce50);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_TIME, 0, m_bprs[i].startTime);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_TIME, 1, rightTime);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_COLOR, boxColor);
            ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_RAY_RIGHT, !m_bprs[i].isMitigated);
         }
      }
   }
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| Actualizar extensiones de los BPRs vivos en cada tick           |
//+------------------------------------------------------------------+
void UpdateLiveExtensions(const int rates_total, const datetime &time[], const double &high[], const double &low[])
{
   datetime chartProjectEnd = time[rates_total - 1] + PeriodSeconds() * 20;
   double currentHigh = high[rates_total - 1];
   double currentLow  = low[rates_total - 1];

   for(int i = 0; i < ArraySize(m_bprs); i++)
   {
      if(!m_bprs[i].isMitigated)
      {
         if(m_bprs[i].isBullish && currentLow < m_bprs[i].low)
         {
            m_bprs[i].isMitigated = true;
            m_bprs[i].endTime = time[rates_total - 1];
            ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_TIME, 1, m_bprs[i].endTime);
            if(InpShowCE50)
            {
               ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_TIME, 1, m_bprs[i].endTime);
               ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_RAY_RIGHT, false);
            }
         }
         else if(!m_bprs[i].isBullish && currentHigh > m_bprs[i].high)
         {
            m_bprs[i].isMitigated = true;
            m_bprs[i].endTime = time[rates_total - 1];
            ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_TIME, 1, m_bprs[i].endTime);
            if(InpShowCE50)
            {
               ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_TIME, 1, m_bprs[i].endTime);
               ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_RAY_RIGHT, false);
            }
         }
         else
         {
            ObjectSetInteger(0, m_bprs[i].boxName, OBJPROP_TIME, 1, chartProjectEnd);
            if(InpShowCE50)
               ObjectSetInteger(0, m_bprs[i].ceLineName, OBJPROP_TIME, 1, chartProjectEnd);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Panel HUD en Gráfico                                             |
//+------------------------------------------------------------------+
void CreateHUD()
{
   string prefix = m_prefix + "HUD_";
   ObjectsDeleteAll(0, prefix);

   int x = 20, y = 30;
   CreateLabel(prefix + "BG", " ", x, y, 280, 135, C'15,23,42', C'51,65,85');
   CreateLabel(prefix + "TITLE", "⚡ BPR RADAR [WarriorTraderClub]", x + 12, y + 10, 0, 0, clrWhite, clrNONE, 10, true);
   CreateLabel(prefix + "TF", StringFormat("TF: %s | Lookback: %d bar", EnumToString(Period()), InpBarsSince), x + 12, y + 32, 0, 0, C'56,189,248', clrNONE, 9);
   CreateLabel(prefix + "TOTAL", "BPRs Activos: 0 zonas", x + 12, y + 52, 0, 0, C'148,163,184', clrNONE, 9);
   CreateLabel(prefix + "CONF", "⭐ Confluencias MTF: 0 zonas", x + 12, y + 72, 0, 0, C'245,158,11', clrNONE, 9, true);
   CreateLabel(prefix + "STATUS", "Escaneando zonas institucionales...", x + 12, y + 97, 0, 0, clrGold, clrNONE, 9);
}

void UpdateHUD(const int rates_total, const double &high[], const double &low[], const double &close[])
{
   string prefix = m_prefix + "HUD_";

   int liveCount = 0;
   int liveConfluence = 0;
   double currentClose = close[rates_total - 1];

   for(int i = 0; i < ArraySize(m_bprs); i++)
   {
      if(!m_bprs[i].isMitigated)
      {
         liveCount++;
         if(m_bprs[i].confluenceCount > 0)
            liveConfluence++;
      }
   }

   ObjectSetString(0, prefix + "TF", OBJPROP_TEXT, StringFormat("TF: %s | Lookback: %d bar", EnumToString(Period()), InpBarsSince));
   ObjectSetString(0, prefix + "TOTAL", OBJPROP_TEXT, StringFormat("BPRs Activos: %d zonas neutras", liveCount));
   ObjectSetString(0, prefix + "CONF", OBJPROP_TEXT, StringFormat("⭐ Confluencia MTF: %d zonas de alta prob.", liveConfluence));

   string statusStr = "⚪ Fuera de zonas BPR";
   color statusCol = clrLightGray;

   for(int i = 0; i < ArraySize(m_bprs); i++)
   {
      if(!m_bprs[i].isMitigated)
      {
         if(currentClose >= m_bprs[i].low && currentClose <= m_bprs[i].high)
         {
            if(m_bprs[i].confluenceCount > 0)
            {
               statusStr = StringFormat("🔥 EN CONFLUENCIA MTF (CE: %.2f)", m_bprs[i].ce50);
               statusCol = C'245,158,11';
            }
            else
            {
               statusStr = StringFormat("🎯 DENTRO DE BPR (CE: %.2f)", m_bprs[i].ce50);
               statusCol = C'56,189,248';
            }
            break;
         }
      }
   }

   ObjectSetString(0, prefix + "STATUS", OBJPROP_TEXT, statusStr);
   ObjectSetInteger(0, prefix + "STATUS", OBJPROP_COLOR, statusCol);
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
