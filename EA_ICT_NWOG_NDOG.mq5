//+------------------------------------------------------------------+
//|                                           EA_ICT_NWOG_NDOG.mq5  |
//|               Estrategia Institucional ICT NWOG / NDOG & EHPDA   |
//|                   Copyright 2026, Antigravity Quant Lab          |
//|                       https://github.com/telegram-mtproto        |
//+------------------------------------------------------------------+
#property copyright "Antigravity Quant Lab & ICT Concepts"
#property link      "https://github.com/telegram-mtproto"
#property version   "2.00"
#property strict
#property description "EA Institucional ICT: New Week Opening Gap (NWOG), New Day Opening Gap (NDOG) y EHPDA"
#property description "Soporta Múltiples Reacciones Institucionales, Inversión S/R (Inversion Gaps) y Cooldown Anti-Spam"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>

//--- ENUMERACIONES ---
enum ENUM_GAP_TYPE
{
   GAP_NWOG_ONLY, // Solo NWOG (Semanal)
   GAP_NDOG_ONLY, // Solo NDOG (Diario)
   GAP_BOTH       // Ambos (NWOG + NDOG)
};

enum ENUM_RISK_MODE
{
   RISK_PERCENT_BALANCE, // % del Balance
   RISK_PERCENT_EQUITY,  // % de la Equidad
   RISK_FIXED_USD,       // Riesgo Fijo en USD ($)
   RISK_FIXED_LOT        // Lotaje Fijo Manual
};

enum ENUM_TRIGGER_MODE
{
   TRIGGER_CE_50_REJECTION, // Confirmación en el CE 50% (Mecha de absorción)
   TRIGGER_ZONE_RETEST      // Retesteo de la caja del Gap
};

//--- PARÁMETROS DE ENTRADA (INPUTS) ---
input group "=== 📊 1. CONFIGURACIÓN DE GAPS ICT (NWOG / NDOG) ===";
input ENUM_GAP_TYPE      InpGapType              = GAP_NWOG_ONLY;        // Tipo de Gaps a Detectar (NWOG Semanal por defecto)
input int                InpMaxGapsToTrack       = 5;                    // Cantidad Máxima de Gaps Activos a Monitorear
input double             InpMinGapPoints         = 20.0;                 // Tamaño Mínimo de Gap en Puntos (20 pts = 0.20$ Oro)
input bool               InpUseEHPDA             = true;                 // Calcular y Dibujar EHPDA (Event Horizon)

input group "=== 🔄 2. INVERSIÓN DE ROL (S/R FLIP) Y COOLDOWN ===";
input bool               InpEnableInversion      = true;                 // Activar Inversión de Nivel (Inversion Gaps)
input int                InpGapCooldownBars      = 12;                   // Cooldown Anti-Spam en el Mismo Gap (Barras TF entrada)
input int                InpMaxTradesPerGap      = 4;                    // Máximo de Reacciones Permitidas por Gap

input group "=== 📈 3. FILTRO DE TENDENCIA INSTITUCIONAL (OPCIONAL) ===";
input bool               InpUseTrendFilter       = false;                // Activar Filtro de Tendencia (Opcional para tests)
input ENUM_TIMEFRAMES    InpTrendTF              = PERIOD_H1;            // Temporalidad de la Tendencia (H1)
input int                InpTrendEmaPeriod       = 200;                  // Período EMA de Tendencia (200)

input group "=== ⚖️ 4. GESTIÓN DE RIESGO DINÁMICO & R:R ===";
input ENUM_RISK_MODE     InpRiskMode             = RISK_PERCENT_BALANCE; // Modo de Cálculo de Riesgo
input double             InpRiskPercent          = 2.0;                  // Riesgo por Operación (%)
input double             InpFixedRiskUSD         = 50.0;                 // Riesgo Fijo por Operación ($ si modo USD)
input double             InpFixedLotSize         = 0.01;                 // Lotaje Fijo (si modo Fixed Lot)
input double             InpRiskRewardRatio      = 2.0;                  // Ratio Riesgo:Beneficio (R:R Dinámico)

input group "=== 🎯 5. GATILLO DE ENTRADA & CONFIRMACIÓN ===";
input ENUM_TIMEFRAMES    InpEntryTF              = PERIOD_M5;            // Temporalidad de Entrada y Rechazo (M5 o M2)
input ENUM_TRIGGER_MODE  InpTriggerMode          = TRIGGER_CE_50_REJECTION;// Modo de Gatillo Institucional
input double             InpMinRejectionWickPct  = 25.0;                 // Mecha de Rechazo Mínima (%) para Confirmar
input double             InpSLBufferPoints       = 15.0;                 // Holgura de SL tras el Extremo del Gap (puntos)
input int                InpMaxActiveTrades      = 1;                    // Máximo de Operaciones Simultáneas

input group "=== 🛡️ 6. AUTO BREAK-EVEN (50% DEL TP) ===";
input bool               InpEnableAutoBE         = false;                // Activar Auto Break-Even al 50% del TP
input double             InpBETriggerPercent     = 50.0;                 // Recorrido hacia el TP para Activar BE (%)
input double             InpBEOffsetPips         = 0.5;                  // Offset de Seguridad sobre Precio Entrada (pips)

input group "=== ⏱️ 7. SESIONES & KILLZONES ICT (HORA ESPAÑA/CET) ===";
input bool               InpUseSessionFilter     = true;                 // Operar Solo en Killzones
input int                InpLondonStartHour      = 8;                    // Apertura Londres (08:00 CET)
input int                InpLondonEndHour        = 12;                   // Cierre Londres (12:00 CET)
input int                InpNYStartHour          = 13;                   // Apertura New York (13:30 CET)
input int                InpNYEndHour            = 17;                   // Cierre New York (17:00 CET)
input bool               InpCloseFriday          = true;                 // Cierre Preventivo Viernes
input int                InpFridayCloseHour      = 21;                   // Hora Cierre Viernes
input int                InpFridayCloseMin       = 30;                   // Minuto Cierre Viernes

input group "=== 🎨 8. IDENTIFICACIÓN Y GRÁFICO ===";
input ulong              InpMagicNumber          = 889901;               // Magic Number
input string             InpTradeComment         = "ICT_NWOG_NDOG";      // Comentario de Trade
input bool               InpDrawVisuals          = true;                 // Dibujar Cajas de Gaps y Niveles CE
input bool               InpShowHUD              = true;                 // Mostrar Panel HUD en Gráfico
input color              InpBullColor            = C'91,156,246';        // Color Gap Alcista (Demanda / Azul)
input color              InpBearColor            = C'186,104,200';       // Color Gap Bajista (Oferta / Lila)
input color              InpEhpdaColor           = C'148,163,184';       // Color EHPDA

//--- ESTRUCTURAS DE DATOS ---
struct GapData
{
   datetime time;
   double   top;
   double   bottom;
   double   ce50;          // Consequent Encroachment (top + bottom) / 2
   bool     isBullish;     // true si open > close[1] (Gap Alcista)
   bool     isFlipped;     // true si fue quebrado y ahora actúa como Inversion Gap (S/R Flip)
   datetime lastTradeTime; // Timestamp de la última operación ejecutada en este gap
   int      tradeCount;    // Número de veces que este gap ha sido operado
   string   typeStr;       // "NWOG" o "NDOG"
   string   boxName;
   string   topLineName;
   string   ceLineName;
   string   btmLineName;
};

//--- VARIABLES GLOBALES ---
CTrade         m_trade;
CPositionInfo  m_pos;
CAccountInfo   m_acc;

GapData        m_gaps[];
double         m_ehpdaLevels[];
datetime       m_lastBarTime  = 0;
datetime       m_lastW1Time   = 0;
datetime       m_lastD1Time   = 0;
int            m_emaTrendHandle = INVALID_HANDLE;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   m_trade.SetExpertMagicNumber(InpMagicNumber);
   m_trade.SetMarginMode();
   m_trade.SetTypeFillingBySymbol(_Symbol);

   ArrayResize(m_gaps, 0);
   ArrayResize(m_ehpdaLevels, 0);

   // Inicializar filtro de tendencia si está habilitado
   if(InpUseTrendFilter)
   {
      m_emaTrendHandle = iMA(_Symbol, InpTrendTF, InpTrendEmaPeriod, 0, MODE_EMA, PRICE_CLOSE);
      if(m_emaTrendHandle == INVALID_HANDLE)
         Print("⚠️ [ADVERTENCIA] No se pudo crear el handle de la EMA de tendencia.");
      else
         PrintFormat("📈 [FILTRO TENDENCIA] EMA %d en %s activada.", InpTrendEmaPeriod, EnumToString(InpTrendTF));
   }

   PrintFormat("🚀 [EA_ICT_NWOG_NDOG v2.0] Inicializado en %s | R:R 1:%.2f | Riesgo: %.2f%% | Inversión S/R: %s | Anti-Spam: %d barras",
               _Symbol, InpRiskRewardRatio, InpRiskPercent, InpEnableInversion ? "ON" : "OFF", InpGapCooldownBars);

   // Escaneo inicial de Gaps históricos
   ScanGapsHistorical();

   if(InpShowHUD)
      CreateHUD();

   EventSetMillisecondTimer(250);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();

   if(m_emaTrendHandle != INVALID_HANDLE)
   {
      IndicatorRelease(m_emaTrendHandle);
      m_emaTrendHandle = INVALID_HANDLE;
   }

   if(InpDrawVisuals)
   {
      ObjectsDeleteAll(0, "ICT_GAP_");
      ObjectsDeleteAll(0, "ICT_EHPDA_");
   }

   if(InpShowHUD)
      DestroyHUD();
}

//+------------------------------------------------------------------+
//| Timer function (250 ms)                                          |
//+------------------------------------------------------------------+
void OnTimer()
{
   // 1. Auto Break-Even dinámico al 50% del TP
   if(InpEnableAutoBE)
      ManageAutoBreakEven();

   // 2. Cierre preventivo de viernes
   if(InpCloseFriday)
      CheckFridayCloseGuard();

   // 3. Actualizar HUD cada segundo
   static datetime lastHudUpdate = 0;
   if(TimeCurrent() - lastHudUpdate >= 1)
   {
      lastHudUpdate = TimeCurrent();
      if(InpShowHUD)
         UpdateHUD();
   }
}

//+------------------------------------------------------------------+
//| Tick function                                                    |
//+------------------------------------------------------------------+
void OnTick()
{
   // 1. Verificar si hay nueva vela en la temporalidad de entrada
   datetime currentBarTime = iTime(_Symbol, InpEntryTF, 0);
   bool isNewBar = (currentBarTime != m_lastBarTime);

   // 2. Detectar nuevos Gaps al cambiar de semana o de día
   CheckForNewGaps();

   // 3. Auto Break-Even reactivo por cada tick
   if(InpEnableAutoBE)
      ManageAutoBreakEven();

   // 4. Buscar gatillo de entrada al cierre de vela (o nuevo bar)
   if(isNewBar)
   {
      m_lastBarTime = currentBarTime;
      EvaluateInstitutionalEntry();
   }
}

//+------------------------------------------------------------------+
//| Detectar apertura de nueva vela W1 y D1 para registrar Gaps       |
//+------------------------------------------------------------------+
void CheckForNewGaps()
{
   // 1. Gaps Semanales (NWOG)
   if(InpGapType == GAP_NWOG_ONLY || InpGapType == GAP_BOTH)
   {
      datetime currentW1Time = iTime(_Symbol, PERIOD_W1, 0);
      if(currentW1Time != m_lastW1Time && currentW1Time > 0)
      {
         m_lastW1Time = currentW1Time;
         RegisterGap(PERIOD_W1, "NWOG");
      }
   }

   // 2. Gaps Diarios (NDOG)
   if(InpGapType == GAP_NDOG_ONLY || InpGapType == GAP_BOTH)
   {
      datetime currentD1Time = iTime(_Symbol, PERIOD_D1, 0);
      if(currentD1Time != m_lastD1Time && currentD1Time > 0)
      {
         m_lastD1Time = currentD1Time;
         RegisterGap(PERIOD_D1, "NDOG");
      }
   }
}

//+------------------------------------------------------------------+
//| Escanear Gaps recientes al inicializar el EA                     |
//+------------------------------------------------------------------+
void ScanGapsHistorical()
{
   ArrayResize(m_gaps, 0);

   if(InpGapType == GAP_NWOG_ONLY || InpGapType == GAP_BOTH)
   {
      for(int shift = InpMaxGapsToTrack - 1; shift >= 0; shift--)
      {
         MqlRates rates[];
         ArraySetAsSeries(rates, true);
         if(CopyRates(_Symbol, PERIOD_W1, shift, 2, rates) == 2)
         {
            double prevClose = rates[1].close;
            double currOpen  = rates[0].open;
            double gapSize   = MathAbs(currOpen - prevClose);

            if(gapSize >= InpMinGapPoints * _Point)
            {
               AddGapData(rates[0].time, currOpen, prevClose, "NWOG");
            }
         }
      }
   }

   if(InpGapType == GAP_NDOG_ONLY || InpGapType == GAP_BOTH)
   {
      for(int shift = InpMaxGapsToTrack - 1; shift >= 0; shift--)
      {
         MqlRates rates[];
         ArraySetAsSeries(rates, true);
         if(CopyRates(_Symbol, PERIOD_D1, shift, 2, rates) == 2)
         {
            double prevClose = rates[1].close;
            double currOpen  = rates[0].open;
            double gapSize   = MathAbs(currOpen - prevClose);

            if(gapSize >= InpMinGapPoints * _Point)
            {
               AddGapData(rates[0].time, currOpen, prevClose, "NDOG");
            }
         }
      }
   }

   CalculateEHPDA();
   RedrawAllGaps();
}

//+------------------------------------------------------------------+
//| Registrar un Gap recién formado en tiempo real                   |
//+------------------------------------------------------------------+
void RegisterGap(ENUM_TIMEFRAMES tf, string typeStr)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, tf, 0, 2, rates) == 2)
   {
      double prevClose = rates[1].close;
      double currOpen  = rates[0].open;
      double gapSize   = MathAbs(currOpen - prevClose);

      if(gapSize >= InpMinGapPoints * _Point)
      {
         AddGapData(rates[0].time, currOpen, prevClose, typeStr);
         CalculateEHPDA();
         RedrawAllGaps();
         PrintFormat("💎 [ICT %s DETECTADO] Apertura: %.5f | Cierre Anterior: %.5f | Tamaño: %.1f pips | Tipo: %s",
                     typeStr, currOpen, prevClose, gapSize / (_Point * 10),
                     (currOpen > prevClose) ? "Alcista (Demanda/Azul)" : "Bajista (Oferta/Lila)");
      }
   }
}

//+------------------------------------------------------------------+
//| Añadir datos del Gap al array y limitar por InpMaxGapsToTrack    |
//+------------------------------------------------------------------+
void AddGapData(datetime t, double currOpen, double prevClose, string typeStr)
{
   GapData newGap;
   newGap.time          = t;
   newGap.top           = MathMax(currOpen, prevClose);
   newGap.bottom        = MathMin(currOpen, prevClose);
   newGap.ce50          = NormalizeDouble((newGap.top + newGap.bottom) / 2.0, _Digits);
   newGap.isBullish     = (currOpen > prevClose);
   newGap.isFlipped     = false;
   newGap.lastTradeTime = 0;
   newGap.tradeCount    = 0;
   newGap.typeStr       = typeStr;
   newGap.boxName       = StringFormat("ICT_GAP_%s_%d", typeStr, (int)t);
   newGap.topLineName   = StringFormat("ICT_GAP_TOP_%s_%d", typeStr, (int)t);
   newGap.ceLineName    = StringFormat("ICT_GAP_CE_%s_%d", typeStr, (int)t);
   newGap.btmLineName   = StringFormat("ICT_GAP_BTM_%s_%d", typeStr, (int)t);

   int size = ArraySize(m_gaps);
   ArrayResize(m_gaps, size + 1);
   m_gaps[size] = newGap;

   // Mantener únicamente los últimos N gaps
   if(ArraySize(m_gaps) > InpMaxGapsToTrack)
   {
      if(InpDrawVisuals)
      {
         ObjectDelete(0, m_gaps[0].boxName);
         ObjectDelete(0, m_gaps[0].topLineName);
         ObjectDelete(0, m_gaps[0].ceLineName);
         ObjectDelete(0, m_gaps[0].btmLineName);
      }
      for(int i = 0; i < ArraySize(m_gaps) - 1; i++)
         m_gaps[i] = m_gaps[i+1];
      ArrayResize(m_gaps, ArraySize(m_gaps) - 1);
   }
}

//+------------------------------------------------------------------+
//| Calcular niveles EHPDA (Event Horizon Premium/Discount Array)    |
//+------------------------------------------------------------------+
void CalculateEHPDA()
{
   int count = ArraySize(m_gaps);
   if(!InpUseEHPDA || count < 2) return;

   double sortedCE[];
   ArrayResize(sortedCE, count);
   for(int i = 0; i < count; i++)
      sortedCE[i] = m_gaps[i].ce50;
   ArraySort(sortedCE);

   ArrayResize(m_ehpdaLevels, count - 1);
   for(int i = 0; i < count - 1; i++)
   {
      m_ehpdaLevels[i] = NormalizeDouble((sortedCE[i] + sortedCE[i+1]) / 2.0, _Digits);
   }
}

//+------------------------------------------------------------------+
//| Dibujar todos los Gaps y niveles EHPDA en el gráfico             |
//+------------------------------------------------------------------+
void RedrawAllGaps()
{
   if(!InpDrawVisuals) return;

   datetime chartEnd = TimeCurrent() + PeriodSeconds(PERIOD_D1) * 30;

   for(int i = 0; i < ArraySize(m_gaps); i++)
   {
      color gapColor = m_gaps[i].isBullish ? InpBullColor : InpBearColor;
      if(m_gaps[i].isFlipped)
         gapColor = m_gaps[i].isBullish ? InpBearColor : InpBullColor; // Invertir color si es S/R Flip

      // 1. Caja del Gap
      if(ObjectFind(0, m_gaps[i].boxName) < 0)
      {
         ObjectCreate(0, m_gaps[i].boxName, OBJ_RECTANGLE, 0, m_gaps[i].time, m_gaps[i].top, chartEnd, m_gaps[i].bottom);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_COLOR, gapColor);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_BGCOLOR, gapColor);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_FILL, true);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_BACK, true);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_STYLE, STYLE_SOLID);
      }
      else
      {
         ObjectSetDouble(0, m_gaps[i].boxName, OBJPROP_PRICE, 0, m_gaps[i].top);
         ObjectSetDouble(0, m_gaps[i].boxName, OBJPROP_PRICE, 1, m_gaps[i].bottom);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_TIME, 1, chartEnd);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_COLOR, gapColor);
         ObjectSetInteger(0, m_gaps[i].boxName, OBJPROP_BGCOLOR, gapColor);
      }

      // 2. Línea Superior (Top) proyectada a la derecha
      if(ObjectFind(0, m_gaps[i].topLineName) < 0)
      {
         ObjectCreate(0, m_gaps[i].topLineName, OBJ_TREND, 0, m_gaps[i].time, m_gaps[i].top, chartEnd, m_gaps[i].top);
         ObjectSetInteger(0, m_gaps[i].topLineName, OBJPROP_COLOR, gapColor);
         ObjectSetInteger(0, m_gaps[i].topLineName, OBJPROP_STYLE, STYLE_SOLID);
         ObjectSetInteger(0, m_gaps[i].topLineName, OBJPROP_WIDTH, 1);
         ObjectSetInteger(0, m_gaps[i].topLineName, OBJPROP_RAY_RIGHT, true);
      }
      else
      {
         ObjectSetDouble(0, m_gaps[i].topLineName, OBJPROP_PRICE, 0, m_gaps[i].top);
         ObjectSetDouble(0, m_gaps[i].topLineName, OBJPROP_PRICE, 1, m_gaps[i].top);
         ObjectSetInteger(0, m_gaps[i].topLineName, OBJPROP_TIME, 1, chartEnd);
         ObjectSetInteger(0, m_gaps[i].topLineName, OBJPROP_COLOR, gapColor);
      }

      // 3. Línea Central CE 50% proyectada a la derecha (Discontinua)
      if(ObjectFind(0, m_gaps[i].ceLineName) < 0)
      {
         ObjectCreate(0, m_gaps[i].ceLineName, OBJ_TREND, 0, m_gaps[i].time, m_gaps[i].ce50, chartEnd, m_gaps[i].ce50);
         ObjectSetInteger(0, m_gaps[i].ceLineName, OBJPROP_COLOR, gapColor);
         ObjectSetInteger(0, m_gaps[i].ceLineName, OBJPROP_STYLE, STYLE_DOT);
         ObjectSetInteger(0, m_gaps[i].ceLineName, OBJPROP_WIDTH, 1);
         ObjectSetInteger(0, m_gaps[i].ceLineName, OBJPROP_RAY_RIGHT, true);
      }
      else
      {
         ObjectSetDouble(0, m_gaps[i].ceLineName, OBJPROP_PRICE, 0, m_gaps[i].ce50);
         ObjectSetDouble(0, m_gaps[i].ceLineName, OBJPROP_PRICE, 1, m_gaps[i].ce50);
         ObjectSetInteger(0, m_gaps[i].ceLineName, OBJPROP_TIME, 1, chartEnd);
         ObjectSetInteger(0, m_gaps[i].ceLineName, OBJPROP_COLOR, gapColor);
      }

      // 4. Línea Inferior (Bottom) proyectada a la derecha
      if(ObjectFind(0, m_gaps[i].btmLineName) < 0)
      {
         ObjectCreate(0, m_gaps[i].btmLineName, OBJ_TREND, 0, m_gaps[i].time, m_gaps[i].bottom, chartEnd, m_gaps[i].bottom);
         ObjectSetInteger(0, m_gaps[i].btmLineName, OBJPROP_COLOR, gapColor);
         ObjectSetInteger(0, m_gaps[i].btmLineName, OBJPROP_STYLE, STYLE_SOLID);
         ObjectSetInteger(0, m_gaps[i].btmLineName, OBJPROP_WIDTH, 1);
         ObjectSetInteger(0, m_gaps[i].btmLineName, OBJPROP_RAY_RIGHT, true);
      }
      else
      {
         ObjectSetDouble(0, m_gaps[i].btmLineName, OBJPROP_PRICE, 0, m_gaps[i].bottom);
         ObjectSetDouble(0, m_gaps[i].btmLineName, OBJPROP_PRICE, 1, m_gaps[i].bottom);
         ObjectSetInteger(0, m_gaps[i].btmLineName, OBJPROP_TIME, 1, chartEnd);
         ObjectSetInteger(0, m_gaps[i].btmLineName, OBJPROP_COLOR, gapColor);
      }
   }

   // 5. Dibujar niveles EHPDA
   if(InpUseEHPDA)
   {
      for(int e = 0; e < ArraySize(m_ehpdaLevels); e++)
      {
         string ehName = StringFormat("ICT_EHPDA_LVL_%d", e);
         if(ObjectFind(0, ehName) < 0)
         {
            ObjectCreate(0, ehName, OBJ_HLINE, 0, 0, m_ehpdaLevels[e]);
            ObjectSetInteger(0, ehName, OBJPROP_COLOR, InpEhpdaColor);
            ObjectSetInteger(0, ehName, OBJPROP_STYLE, STYLE_DASHDOT);
            ObjectSetInteger(0, ehName, OBJPROP_WIDTH, 1);
            ObjectSetString(0, ehName, OBJPROP_TEXT, "EHPDA Event Horizon");
         }
         else
         {
            ObjectSetDouble(0, ehName, OBJPROP_PRICE, 0, m_ehpdaLevels[e]);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Comprobar si la dirección está autorizada por la EMA Tendencia   |
//+------------------------------------------------------------------+
bool IsTrendAllowed(bool isBuy)
{
   if(!InpUseTrendFilter || m_emaTrendHandle == INVALID_HANDLE)
      return true;

   double emaVal[1];
   if(CopyBuffer(m_emaTrendHandle, 0, 0, 1, emaVal) <= 0)
      return true;

   double currentBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(isBuy)
      return (currentBid >= emaVal[0]);
   else
      return (currentBid <= emaVal[0]);
}

//+------------------------------------------------------------------+
//| Evaluación Institucional y Disparo a Mercado                     |
//+------------------------------------------------------------------+
void EvaluateInstitutionalEntry()
{
   // 1. Validar límite de posiciones activas del EA
   if(GetActivePositionsCount() >= InpMaxActiveTrades)
      return;

   // 2. Filtro de Killzones / Sesiones de Liquidez
   if(!IsInKillzone())
      return;

   int gapsCount = ArraySize(m_gaps);
   if(gapsCount == 0) return;

   // Obtener la vela previa cerrada en TF de entrada
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, InpEntryTF, 1, 1, rates) < 1) return;

   double cOpen  = rates[0].open;
   double cClose = rates[0].close;
   double cHigh  = rates[0].high;
   double cLow   = rates[0].low;
   double cRange = cHigh - cLow;
   if(cRange <= 0) return;

   datetime currentBarTime = rates[0].time;

   double lowerWick = MathMin(cOpen, cClose) - cLow;
   double upperWick = cHigh - MathMax(cOpen, cClose);
   double lowerWickPct = (lowerWick / cRange) * 100.0;
   double upperWickPct = (upperWick / cRange) * 100.0;

   // Iterar por los gaps activos (del más reciente al más antiguo)
   for(int i = gapsCount - 1; i >= 0; i--)
   {
      double top    = m_gaps[i].top;
      double bottom = m_gaps[i].bottom;
      double ce50   = m_gaps[i].ce50;

      // -------------------------------------------------------------
      // 0. ACTUALIZACIÓN DINÁMICA DE INVERSIÓN (S/R FLIP CON CUERPO)
      // -------------------------------------------------------------
      if(InpEnableInversion)
      {
         // Si era Bajista (Resistencia) y una vela cierra con cuerpo claramente por encima del Top
         if(!m_gaps[i].isBullish && !m_gaps[i].isFlipped && cClose > top && cOpen > top)
         {
            m_gaps[i].isFlipped = true;
            PrintFormat("🔄 [INVERSIÓN S/R FLIP] Gap Bajista %s en %.5f roto al alza con cuerpo. Ahora actúa como SOPORTE.",
                        m_gaps[i].typeStr, ce50);
            RedrawAllGaps();
         }
         // Si era Alcista (Soporte) y una vela cierra con cuerpo claramente por debajo del Bottom
         else if(m_gaps[i].isBullish && !m_gaps[i].isFlipped && cClose < bottom && cOpen < bottom)
         {
            m_gaps[i].isFlipped = true;
            PrintFormat("🔄 [INVERSIÓN S/R FLIP] Gap Alcista %s en %.5f roto a la baja con cuerpo. Ahora actúa como RESISTENCIA.",
                        m_gaps[i].typeStr, ce50);
            RedrawAllGaps();
         }
      }

      // -------------------------------------------------------------
      // 1. REGLA ANTI-SPAM (COOLDOWN Y TOQUES MÁXIMOS POR GAP)
      // -------------------------------------------------------------
      if(m_gaps[i].tradeCount >= InpMaxTradesPerGap)
         continue;

      if(m_gaps[i].lastTradeTime > 0)
      {
         int barsSinceTrade = (int)((currentBarTime - m_gaps[i].lastTradeTime) / PeriodSeconds(InpEntryTF));
         if(barsSinceTrade < InpGapCooldownBars)
            continue; // Gap en periodo de enfriamiento
      }

      // Determinar si en este momento este gap funciona como Soporte o Resistencia
      // - Gap Alcista Normal (no flipped) o Gap Bajista Flipped -> SOPORTE (Buscar Compras)
      // - Gap Bajista Normal (no flipped) o Gap Alcista Flipped -> RESISTENCIA (Buscar Ventas)
      bool actsAsSupport    = (m_gaps[i].isBullish && !m_gaps[i].isFlipped) || (!m_gaps[i].isBullish && m_gaps[i].isFlipped);
      bool actsAsResistance = (!m_gaps[i].isBullish && !m_gaps[i].isFlipped) || (m_gaps[i].isBullish && m_gaps[i].isFlipped);

      // -------------------------------------------------------------
      // A) SETUP DE COMPRA (Soporte en Gap Original o Inversión)
      // El precio baja a testear la zona / CE 50, respeta el nivel con
      // el cuerpo cerrando por encima y deja mecha de rechazo inferior
      // -------------------------------------------------------------
      if(actsAsSupport && IsTrendAllowed(true))
      {
         bool testedSupport = false;
         if(InpTriggerMode == TRIGGER_CE_50_REJECTION)
            testedSupport = (cLow <= ce50 && cClose > ce50);
         else
            testedSupport = (cLow <= top && cClose >= bottom);

         // Validación: Cuerpo no destruido, cierre alcista/respetando y mecha de absorción
         if(testedSupport && cClose >= bottom && lowerWickPct >= InpMinRejectionWickPct)
         {
            double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
            double sl  = NormalizeDouble(bottom - (InpSLBufferPoints * _Point), _Digits);
            double slDist = ask - sl;

            if(slDist > (InpSLBufferPoints * _Point))
            {
               double tp = NormalizeDouble(ask + (slDist * InpRiskRewardRatio), _Digits);
               double lot = CalculateLotSize(ask, sl);

               string modeStr = m_gaps[i].isFlipped ? "INVERSIÓN SOPORTE" : "SOPORTE ORIGINAL";
               PrintFormat("🎯 [SEÑAL COMPRA ICT] %s (%s) CE 50: %.5f | Rechazo Mecha: %.1f%% | SL: %.5f | TP (R:R 1:%.2f): %.5f | Lot: %.2f",
                           modeStr, m_gaps[i].typeStr, ce50, lowerWickPct, sl, InpRiskRewardRatio, tp, lot);

               string orderComment = StringFormat("%s_%s_%s_BUY", InpTradeComment, m_gaps[i].typeStr, m_gaps[i].isFlipped ? "INV" : "DIR");
               if(m_trade.Buy(lot, _Symbol, ask, sl, tp, orderComment))
               {
                  m_gaps[i].lastTradeTime = currentBarTime;
                  m_gaps[i].tradeCount++;
                  PrintFormat("✅ [ORDEN COMPRA EJECUTADA] Toque #%d para este Gap.", m_gaps[i].tradeCount);
                  return;
               }
            }
         }
      }

      // -------------------------------------------------------------
      // B) SETUP DE VENTA (Resistencia en Gap Original o Inversión)
      // El precio sube a testear la zona / CE 50, respeta el nivel con
      // el cuerpo cerrando por debajo y deja mecha de rechazo superior
      // -------------------------------------------------------------
      if(actsAsResistance && IsTrendAllowed(false))
      {
         bool testedResistance = false;
         if(InpTriggerMode == TRIGGER_CE_50_REJECTION)
            testedResistance = (cHigh >= ce50 && cClose < ce50);
         else
            testedResistance = (cHigh >= bottom && cClose <= top);

         // Validación: Cuerpo no destruido, cierre bajista/respetando y mecha de absorción
         if(testedResistance && cClose <= top && upperWickPct >= InpMinRejectionWickPct)
         {
            double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
            double sl  = NormalizeDouble(top + (InpSLBufferPoints * _Point), _Digits);
            double slDist = sl - bid;

            if(slDist > (InpSLBufferPoints * _Point))
            {
               double tp = NormalizeDouble(bid - (slDist * InpRiskRewardRatio), _Digits);
               double lot = CalculateLotSize(bid, sl);

               string modeStr = m_gaps[i].isFlipped ? "INVERSIÓN RESISTENCIA" : "RESISTENCIA ORIGINAL";
               PrintFormat("🎯 [SEÑAL VENTA ICT] %s (%s) CE 50: %.5f | Rechazo Mecha: %.1f%% | SL: %.5f | TP (R:R 1:%.2f): %.5f | Lot: %.2f",
                           modeStr, m_gaps[i].typeStr, ce50, upperWickPct, sl, InpRiskRewardRatio, tp, lot);

               string orderComment = StringFormat("%s_%s_%s_SELL", InpTradeComment, m_gaps[i].typeStr, m_gaps[i].isFlipped ? "INV" : "DIR");
               if(m_trade.Sell(lot, _Symbol, bid, sl, tp, orderComment))
               {
                  m_gaps[i].lastTradeTime = currentBarTime;
                  m_gaps[i].tradeCount++;
                  PrintFormat("✅ [ORDEN VENTA EJECUTADA] Toque #%d para este Gap.", m_gaps[i].tradeCount);
                  return;
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Cálculo Dinámico de Lotaje por Distancia al Stop Loss            |
//+------------------------------------------------------------------+
double CalculateLotSize(double entryPrice, double slPrice)
{
   if(InpRiskMode == RISK_FIXED_LOT)
      return InpFixedLotSize;

   double riskUSD = 0.0;
   if(InpRiskMode == RISK_PERCENT_BALANCE)
   {
      double balance = AccountInfoDouble(ACCOUNT_BALANCE);
      riskUSD = balance * (InpRiskPercent / 100.0);
   }
   else if(InpRiskMode == RISK_PERCENT_EQUITY)
   {
      double equity = AccountInfoDouble(ACCOUNT_EQUITY);
      riskUSD = equity * (InpRiskPercent / 100.0);
   }
   else if(InpRiskMode == RISK_FIXED_USD)
   {
      riskUSD = InpFixedRiskUSD;
   }

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
//| Gestor de Auto Break-Even al 50% del Recorrido al TP             |
//+------------------------------------------------------------------+
void ManageAutoBreakEven()
{
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      if(PositionGetInteger(POSITION_MAGIC) != InpMagicNumber || PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;

      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      if(tp <= 0) continue;

      double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
      double pipUnit = (_Digits == 3 || _Digits == 5) ? (point * 10) : point;
      double offsetPrice = InpBEOffsetPips * pipUnit;

      if(posType == POSITION_TYPE_BUY)
      {
         double tpDistance = tp - openPrice;
         if(tpDistance <= 0) continue;

         double triggerPrice = openPrice + (tpDistance * (InpBETriggerPercent / 100.0));
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

         if(bid >= triggerPrice)
         {
            double newSL = NormalizeDouble(openPrice + offsetPrice, _Digits);
            if(sl < newSL - 0.00001)
            {
               PrintFormat("🛡️ [AUTO BREAK-EVEN 50%%] Posición BUY #%d alcanzó el %.1f%% del TP. SL movido a Entrada: %.5f",
                           ticket, InpBETriggerPercent, newSL);
               m_trade.PositionModify(ticket, newSL, tp);
            }
         }
      }
      else if(posType == POSITION_TYPE_SELL)
      {
         double tpDistance = openPrice - tp;
         if(tpDistance <= 0) continue;

         double triggerPrice = openPrice - (tpDistance * (InpBETriggerPercent / 100.0));
         double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

         if(ask <= triggerPrice)
         {
            double newSL = NormalizeDouble(openPrice - offsetPrice, _Digits);
            if(sl > newSL + 0.00001 || sl <= 0)
            {
               PrintFormat("🛡️ [AUTO BREAK-EVEN 50%%] Posición SELL #%d alcanzó el %.1f%% del TP. SL movido a Entrada: %.5f",
                           ticket, InpBETriggerPercent, newSL);
               m_trade.PositionModify(ticket, newSL, tp);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Filtro de Horarios / Killzones Institucionales                   |
//+------------------------------------------------------------------+
bool IsInKillzone()
{
   if(!InpUseSessionFilter) return true;

   MqlDateTime dt;
   TimeCurrent(dt);

   bool isLondon = (dt.hour >= InpLondonStartHour && dt.hour < InpLondonEndHour);
   bool isNY     = (dt.hour >= InpNYStartHour && dt.hour < InpNYEndHour);

   return (isLondon || isNY);
}

//+------------------------------------------------------------------+
//| Cierre Preventivo Viernes 21:30 CET                              |
//+------------------------------------------------------------------+
void CheckFridayCloseGuard()
{
   MqlDateTime dt;
   TimeCurrent(dt);

   if(dt.day_of_week == 5) // Viernes
   {
      if(dt.hour > InpFridayCloseHour || (dt.hour == InpFridayCloseHour && dt.min >= InpFridayCloseMin))
      {
         int total = PositionsTotal();
         for(int i = total - 1; i >= 0; i--)
         {
            ulong ticket = PositionGetTicket(i);
            if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && PositionGetString(POSITION_SYMBOL) == _Symbol)
            {
               Print("🔒 [FRIDAY CLOSE GUARD] Cierre preventivo de fin de semana para posición #", ticket);
               m_trade.PositionClose(ticket);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Contar Posiciones Activas del EA                                 |
//+------------------------------------------------------------------+
int GetActivePositionsCount()
{
   int count = 0;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && PositionGetString(POSITION_SYMBOL) == _Symbol)
         count++;
   }
   return count;
}

//+------------------------------------------------------------------+
//| Panel Visual HUD en Gráfico                                      |
//+------------------------------------------------------------------+
void CreateHUD()
{
   string prefix = "ICT_HUD_";
   ObjectsDeleteAll(0, prefix);

   int x = 20, y = 30;
   CreateLabel(prefix + "BG", " ", x, y, 280, 175, C'15,23,42', C'51,65,85');
   CreateLabel(prefix + "TITLE", "⚡ ICT NWOG/NDOG RADAR v2.0", x + 12, y + 10, 0, 0, clrWhite, clrNONE, 10, true);
   CreateLabel(prefix + "RR", StringFormat("R:R Dinámico: 1:%.2f", InpRiskRewardRatio), x + 12, y + 32, 0, 0, C'56,189,248', clrNONE, 9);
   CreateLabel(prefix + "RISK", StringFormat("Riesgo: %.2f%% (%s)", InpRiskPercent, EnumToString(InpRiskMode)), x + 12, y + 52, 0, 0, C'245,158,11', clrNONE, 9);
   CreateLabel(prefix + "TREND", InpUseTrendFilter ? StringFormat("Tendencia: EMA %d (%s)", InpTrendEmaPeriod, EnumToString(InpTrendTF)) : "Tendencia: Filtro Desactivado", x + 12, y + 72, 0, 0, InpUseTrendFilter ? C'52,211,153' : C'148,163,184', clrNONE, 9);
   CreateLabel(prefix + "INVERSION", StringFormat("Inversión S/R: %s | Anti-Spam: %d bar", InpEnableInversion ? "ON" : "OFF", InpGapCooldownBars), x + 12, y + 92, 0, 0, C'192,132,252', clrNONE, 9);
   CreateLabel(prefix + "GAPS", StringFormat("Gaps Monitoreados: %d activos", ArraySize(m_gaps)), x + 12, y + 112, 0, 0, clrLightGray, clrNONE, 9);
   CreateLabel(prefix + "SESSION", "Sesión: Evaluando...", x + 12, y + 132, 0, 0, C'52,211,153', clrNONE, 9);
   CreateLabel(prefix + "STATUS", "Estado: Escaneando CE 50%...", x + 12, y + 152, 0, 0, clrGold, clrNONE, 9);
}

void UpdateHUD()
{
   string prefix = "ICT_HUD_";
   bool inKillzone = IsInKillzone();
   string sessStr = inKillzone ? "🟢 KILLZONE ACTIVA" : "⚪ FUERA DE KILLZONE";
   color sessColor = inKillzone ? C'52,211,153' : C'148,163,184';

   ObjectSetString(0, prefix + "SESSION", OBJPROP_TEXT, "Sesión: " + sessStr);
   ObjectSetInteger(0, prefix + "SESSION", OBJPROP_COLOR, sessColor);

   int flippedCount = 0;
   for(int i = 0; i < ArraySize(m_gaps); i++)
      if(m_gaps[i].isFlipped) flippedCount++;

   ObjectSetString(0, prefix + "GAPS", OBJPROP_TEXT, StringFormat("Gaps: %d activos (%d Inversión)", ArraySize(m_gaps), flippedCount));

   int activePos = GetActivePositionsCount();
   string statusStr = activePos > 0 ? StringFormat("⚡ %d OPERACIÓN ACTIVA", activePos) : "🎯 ESCANEANDO RECHAZO CE 50%";
   color statusColor = activePos > 0 ? C'56,189,248' : clrGold;

   ObjectSetString(0, prefix + "STATUS", OBJPROP_TEXT, "Estado: " + statusStr);
   ObjectSetInteger(0, prefix + "STATUS", OBJPROP_COLOR, statusColor);
}

void DestroyHUD()
{
   ObjectsDeleteAll(0, "ICT_HUD_");
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
