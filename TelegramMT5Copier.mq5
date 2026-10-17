//+------------------------------------------------------------------+
//|                                        TelegramMT5Copier.mq5     |
//|                    Copyright 2026, Antigravity Trading System    |
//|                        https://github.com/telegram-mtproto      |
//+------------------------------------------------------------------+
#property copyright "Antigravity Telegram-MT5 Copier"
#property link      "http://127.0.0.1:3000"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

input string   InpServerUrl = "http://127.0.0.1:3000/orders"; // URL del servidor Node.js local
input int      InpPollInterval = 250;                        // Intervalo de consulta (ms)
input double   InpDefaultSlippage = 10;                      // Deslizamiento máximo en puntos
input bool     InpAllowHedging = true;                       // Permitir Hedging (true: Capital Propio | false: Prop Firms)
input string   InpSymbolsToMonitor = "XAUUSD,EURUSD,GBPJPY,USDCAD,GBPUSD,AUDUSD,USDJPY,NAS100"; // Símbolos a alimentar a Node.js (separados por coma)

// 🛡️ PARÁMETROS BLINDADO DE SEGURIDAD (STOP LOSS Y TAKE PROFIT DE EMERGENCIA)
input group "=== 🛡️ 1. BLINDADO DE SEGURIDAD (SL / TP AUTOMÁTICO) ===";
input double   InpEmergencySL_Gold      = 3.0;   // SL de Emergencia Oro en $ (3.0$ = 30 pips)
input double   InpEmergencyTP_Gold      = 12.0;  // TP de Emergencia Oro por defecto en $ (12.0$ = 120 pips)
input bool     InpUseFarthestActiveTP   = true;  // Heredar TP más lejano si existen posiciones activas en la misma dirección

// 🛡️ PARÁMETROS AUTO BREAK-EVEN DINÁMICO (50% DEL RECORRIDO AL TP)
input group "=== 🛡️ 2. AUTO BREAK-EVEN DINÁMICO (50% DEL TP) ===";
input bool     InpEnableAutoBE          = true;  // Activar Auto Break-Even al 50% del recorrido al TP
input double   InpBETriggerPercent      = 50.0;  // Recorrido hacia el TP para activar BE (%: 50.0 = 50%)
input double   InpBEOffsetPips          = 0.0;   // Offset sobre precio de entrada (pips, 0 = BE exacto)

input group "=== 🛡️ 3. TRAILING STOP ===";
input bool     InpEnableTrailing        = false; // Trailing Stop (opcional)
input double   InpTrailingTriggerPips   = 0.0;   // Inactivo
input double   InpTrailingDistance      = 0.0;   // Inactivo
input double   InpTrailingStep          = 0.0;   // Inactivo

CTrade         trade;
datetime       lastCheckTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   EventSetMillisecondTimer(InpPollInterval);
   Print("✅ TelegramMT5Copier iniciado. Blindado: SL=", InpEmergencySL_Gold, "$ | TP_Defecto=", InpEmergencyTP_Gold, 
         "$ | HeredarTPLejano=", InpUseFarthestActiveTP, " | Auto-BE(50%)=", InpEnableAutoBE ? "ON" : "OFF", ". Conectando a ", InpServerUrl);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("🛑 TelegramMT5Copier detenido.");
}

//+------------------------------------------------------------------+
//| Helper: Distancia de Stop Loss de emergencia por activo          |
//+------------------------------------------------------------------+
double GetDefaultEmergencySLDistance(string sym)
{
   string s = sym;
   StringToUpper(s);
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   
   if(StringFind(s, "XAU") >= 0 || StringFind(s, "GOLD") >= 0) return InpEmergencySL_Gold;
   if(StringFind(s, "XAG") >= 0 || StringFind(s, "SILVER") >= 0) return 0.35;
   if(StringFind(s, "BTC") >= 0) return 250.0;
   if(StringFind(s, "ETH") >= 0) return 20.0;
   if(StringFind(s, "SOL") >= 0) return 2.5;
   if(StringFind(s, "NAS") >= 0 || StringFind(s, "100") >= 0 || StringFind(s, "US30") >= 0 || StringFind(s, "DJ") >= 0 || StringFind(s, "SPX") >= 0)
      return 25.0;
   if(digits == 3 || digits == 5) return 250 * point; // 25 pips
   if(digits == 2 || digits == 4) return 25 * point;  // 25 pips
   return 50 * (point > 0 ? point : 0.0001);
}

//+------------------------------------------------------------------+
//| Helper: Distancia de Take Profit de emergencia por defecto       |
//+------------------------------------------------------------------+
double GetDefaultEmergencyTPDistance(string sym)
{
   string s = sym;
   StringToUpper(s);
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   
   if(StringFind(s, "XAU") >= 0 || StringFind(s, "GOLD") >= 0) return InpEmergencyTP_Gold; // 12.0$ por defecto
   if(StringFind(s, "XAG") >= 0 || StringFind(s, "SILVER") >= 0) return 1.40;
   if(StringFind(s, "BTC") >= 0) return 1000.0;
   if(StringFind(s, "ETH") >= 0) return 80.0;
   if(StringFind(s, "SOL") >= 0) return 10.0;
   if(StringFind(s, "NAS") >= 0 || StringFind(s, "100") >= 0 || StringFind(s, "US30") >= 0 || StringFind(s, "DJ") >= 0 || StringFind(s, "SPX") >= 0)
      return 100.0;
   if(digits == 3 || digits == 5) return 1000 * point; // 100 pips
   if(digits == 2 || digits == 4) return 100 * point;  // 100 pips
   return 200 * (point > 0 ? point : 0.0001);
}

//+------------------------------------------------------------------+
//| Helper: Buscar el TP más lejano de posiciones activas en la misma |
//| dirección (BUY / SELL) y mismo símbolo                           |
//+------------------------------------------------------------------+
double FindFarthestActiveTP(string sym, ENUM_POSITION_TYPE dir, ulong excludeTicket = 0)
{
   double farthestTP = 0.0;
   int total = PositionsTotal();
   
   for(int i = 0; i < total; i++)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || t == excludeTicket) continue;
      
      string pSym = PositionGetString(POSITION_SYMBOL);
      if(pSym != sym) continue;
      
      ENUM_POSITION_TYPE pType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      if(pType != dir) continue;
      
      double pTP = PositionGetDouble(POSITION_TP);
      if(pTP <= 0) continue;
      
      if(dir == POSITION_TYPE_BUY)
      {
         // Para compras, el TP más lejano es el más alto
         if(farthestTP == 0.0 || pTP > farthestTP)
            farthestTP = pTP;
      }
      else if(dir == POSITION_TYPE_SELL)
      {
         // Para ventas, el TP más lejano es el más bajo
         if(farthestTP == 0.0 || pTP < farthestTP)
            farthestTP = pTP;
      }
   }
   
   return farthestTP;
}

//+------------------------------------------------------------------+
//| Helper: Calcular el Take Profit inteligente para una nueva       |
//| posición o para el vigilante de seguridad                        |
//+------------------------------------------------------------------+
double GetSmartEmergencyTP(string sym, ENUM_POSITION_TYPE dir, double entryPrice, int digits, ulong excludeTicket = 0)
{
   if(InpUseFarthestActiveTP)
   {
      double farthestTP = FindFarthestActiveTP(sym, dir, excludeTicket);
      if(farthestTP > 0)
      {
         if(dir == POSITION_TYPE_BUY && farthestTP > entryPrice)
         {
            Print("🎯 [BLINDADO INTELIGENTE] Heredando TP más lejano de compras activas: ", farthestTP);
            return NormalizeDouble(farthestTP, digits);
         }
         else if(dir == POSITION_TYPE_SELL && farthestTP < entryPrice)
         {
            Print("🎯 [BLINDADO INTELIGENTE] Heredando TP más lejano de ventas activas: ", farthestTP);
            return NormalizeDouble(farthestTP, digits);
         }
      }
   }

   // Si no hay operaciones previas en esa dirección con TP, usar el valor por defecto (12$ en Oro)
   double defaultDist = GetDefaultEmergencyTPDistance(sym);
   double defaultTP = (dir == POSITION_TYPE_BUY) ? (entryPrice + defaultDist) : (entryPrice - defaultDist);
   Print("🛡️ [BLINDADO INTELIGENTE] Asignando TP por defecto (+/-", defaultDist, "): ", defaultTP);
   return NormalizeDouble(defaultTP, digits);
}

//+------------------------------------------------------------------+
//| Gestor de Auto Break-Even al 50% del Recorrido hacia el TP       |
//+------------------------------------------------------------------+
void AutoBreakEvenManager()
{
   if(!InpEnableAutoBE) return;

   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      string posSym = PositionGetString(POSITION_SYMBOL);
      ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      
      // Solo se puede calcular el 50% si la posición tiene TP definido
      if(tp <= 0) continue;

      int digits = (int)SymbolInfoInteger(posSym, SYMBOL_DIGITS);
      if(digits <= 0) digits = 2;
      double point = SymbolInfoDouble(posSym, SYMBOL_POINT);
      if(point <= 0) point = 0.01;

      double pipUnit = (digits == 3 || digits == 5) ? (point * 10) : point;
      double offsetPrice = InpBEOffsetPips * pipUnit;

      if(posType == POSITION_TYPE_BUY)
      {
         double tpDistance = tp - openPrice;
         if(tpDistance <= 0) continue;

         double triggerPrice = openPrice + (tpDistance * (InpBETriggerPercent / 100.0));
         double bid = SymbolInfoDouble(posSym, SYMBOL_BID);
         if(bid <= 0) continue;

         // Si el precio ya recorrió el 50% del camino al TP
         if(bid >= triggerPrice)
         {
            double newSL = NormalizeDouble(openPrice + offsetPrice, digits);
            // Solo mover si el SL actual está por debajo de newSL
            if(sl < newSL - 0.00001)
            {
               Print("🛡️ [AUTO BREAK-EVEN 50%] Posición BUY #", ticket, " (", posSym, ") alcanzó el ", InpBETriggerPercent, 
                     "% del TP (Bid: ", bid, " >= Trigger 50%: ", triggerPrice, "). Moviendo SL a Entrada (", newSL, ")");
               bool ok = trade.PositionModify(ticket, newSL, tp);
               if(!ok)
               {
                  ModifySinglePositionByTicket(ticket, newSL, tp);
               }
            }
         }
      }
      else if(posType == POSITION_TYPE_SELL)
      {
         double tpDistance = openPrice - tp;
         if(tpDistance <= 0) continue;

         double triggerPrice = openPrice - (tpDistance * (InpBETriggerPercent / 100.0));
         double ask = SymbolInfoDouble(posSym, SYMBOL_ASK);
         if(ask <= 0) continue;

         // Si el precio ya recorrió el 50% del camino al TP a la baja
         if(ask <= triggerPrice)
         {
            double newSL = NormalizeDouble(openPrice - offsetPrice, digits);
            // Solo mover si el SL actual está por encima de newSL o no tiene SL
            if(sl > newSL + 0.00001 || sl <= 0)
            {
               Print("🛡️ [AUTO BREAK-EVEN 50%] Posición SELL #", ticket, " (", posSym, ") alcanzó el ", InpBETriggerPercent, 
                     "% del TP (Ask: ", ask, " <= Trigger 50%: ", triggerPrice, "). Moviendo SL a Entrada (", newSL, ")");
               bool ok = trade.PositionModify(ticket, newSL, tp);
               if(!ok)
               {
                  ModifySinglePositionByTicket(ticket, newSL, tp);
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Vigilante de Emergencia: Garantizar que NINGUNA posicion quede  |
//| sin Stop Loss (SL) ni Take Profit (TP).                          |
//+------------------------------------------------------------------+
void EnforceSafetyStopLoss()
{
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         double sl = PositionGetDouble(POSITION_SL);
         double tp = PositionGetDouble(POSITION_TP);
         if(sl <= 0 || tp <= 0)
         {
            string posSym = PositionGetString(POSITION_SYMBOL);
            double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
            datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
            datetime now = TimeCurrent();

            // Si la posición lleva más de 2 segundos con algún stop sin asignar
            if(now - openTime >= 2)
            {
               Print("🚨 [VIGILANTE DE SEGURIDAD] Posicion #", ticket, " (", posSym, ") requiere proteccion. SL actual: ", sl, " | TP actual: ", tp);

               int digits = (int)SymbolInfoInteger(posSym, SYMBOL_DIGITS);
               if(digits <= 0) digits = 2;

               double emSLDist = GetDefaultEmergencySLDistance(posSym);
               double normSL = (sl > 0) ? sl : ((posType == POSITION_TYPE_BUY) ? NormalizeDouble(openPrice - emSLDist, digits) : NormalizeDouble(openPrice + emSLDist, digits));
               double normTP = (tp > 0) ? tp : GetSmartEmergencyTP(posSym, posType, openPrice, digits, ticket);

               bool ok = trade.PositionModify(ticket, normSL, normTP);

               // Si ni siquiera se puede asignar la protección de emergencia, CERRAR A MERCADO DE INMEDIATO
               if(!ok)
               {
                  Print("⛔ [ALERTA CRITICA - IMPOSIBLE ASIGNAR PROTECCION] Cerrando posicion #", ticket, " a mercado por seguridad de la cuenta!");
                  trade.PositionClose(ticket);
               }
               else
               {
                  Print("🛡️ [PROTECCION DE EMERGENCIA APLICADA] Posicion #", ticket, " -> SL: ", normSL, " | TP: ", normTP);
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Helper para empaquetar ticks de todos los símbolos monitoreados  |
//+------------------------------------------------------------------+
string BuildMultiSymbolTicksQuery()
{
   string monitorList = InpSymbolsToMonitor;
   if(monitorList == "") monitorList = "XAUUSD,EURUSD,GBPJPY,USDCAD,GBPUSD,AUDUSD,USDJPY,NAS100,XAGUSD,EURJPY,BTCUSD,ETHUSD";
   if(StringFind(monitorList, "NAS100") < 0) monitorList += ",NAS100";
   if(StringFind(monitorList, "USDCAD") < 0) monitorList += ",USDCAD";
   if(StringFind(monitorList, "GBPUSD") < 0) monitorList += ",GBPUSD";
   if(StringFind(monitorList, "AUDUSD") < 0) monitorList += ",AUDUSD";
   if(StringFind(monitorList, "USDJPY") < 0) monitorList += ",USDJPY";
   if(StringFind(monitorList, "GBPJPY") < 0) monitorList += ",GBPJPY";
   if(StringFind(monitorList, "EURUSD") < 0) monitorList += ",EURUSD";
   if(StringFind(monitorList, "XAUUSD") < 0) monitorList += ",XAUUSD";
   if(StringFind(monitorList, "XAGUSD") < 0) monitorList += ",XAGUSD";
   if(StringFind(monitorList, "EURJPY") < 0) monitorList += ",EURJPY";
   if(StringFind(monitorList, "BTCUSD") < 0) monitorList += ",BTCUSD";
   if(StringFind(monitorList, "ETHUSD") < 0) monitorList += ",ETHUSD";

   string symbols[];
   int count = StringSplit(monitorList, ',', symbols);
   if(count <= 0) return "";

   string result = "";
   for(int i = 0; i < count; i++)
   {
      string rawSym = symbols[i];
      StringTrimLeft(rawSym);
      StringTrimRight(rawSym);
      if(rawSym == "") continue;

      string resolved = ResolveSymbol(rawSym);
      SymbolSelect(resolved, true);

      MqlTick tick;
      double b = 0.0, a = 0.0;
      if(SymbolInfoTick(resolved, tick) && tick.bid > 0 && tick.ask > 0)
      {
         b = tick.bid;
         a = tick.ask;
      }
      else
      {
         b = SymbolInfoDouble(resolved, SYMBOL_BID);
         a = SymbolInfoDouble(resolved, SYMBOL_ASK);
      }

      int dig = (int)SymbolInfoInteger(resolved, SYMBOL_DIGITS);
      if(dig <= 0) dig = 2;

      MqlRates d1Rates[];
      ArraySetAsSeries(d1Rates, true);
      double symPDH = 0.0, symPDL = 0.0;
      if(CopyRates(resolved, PERIOD_D1, 1, 1, d1Rates) >= 1)
      {
         symPDH = d1Rates[0].high;
         symPDL = d1Rates[0].low;
      }

      if(b > 0 && a > 0)
      {
         if(result != "") result += "|";
         result += rawSym + ":" + DoubleToString(b, dig) + ":" + DoubleToString(a, dig) + ":" + DoubleToString(symPDH, dig) + ":" + DoubleToString(symPDL, dig);
      }
   }
   return result;
}

//+------------------------------------------------------------------+
//| Timer function (Consultar servidor local Node.js en ms)          |
//+------------------------------------------------------------------+
void OnTimer()
{
   // 1. Ejecutar vigilante de seguridad de Stop Loss en cada pulso (250 ms)
   EnforceSafetyStopLoss();

   // 2. Ejecutar Auto Break-Even inteligente al 50% del recorrido al TP
   AutoBreakEvenManager();

   string cookie=NULL;
   char post[], result[];
   string result_headers;
   int timeout = 500;

   // Realizar petición GET al servidor Node.js enviando identidad de cuenta, balance y precios
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string company = AccountInfoString(ACCOUNT_COMPANY);
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double credit = AccountInfoDouble(ACCOUNT_CREDIT);
   string curr = AccountInfoString(ACCOUNT_CURRENCY);
   double liveBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double liveAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   int openPosCount = PositionsTotal();

   double realFloatingProfit = 0.0;
   // Conteo de posiciones con RIESGO ACTIVO y cálculo exacto del beneficio flotante real de las órdenes
   int riskPosCount = 0;
   for(int p = 0; p < openPosCount; p++)
   {
      ulong t = PositionGetTicket(p);
      if(t > 0)
      {
         realFloatingProfit += PositionGetDouble(POSITION_PROFIT);
         double opPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         double posSL   = PositionGetDouble(POSITION_SL);
         ENUM_POSITION_TYPE pType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         bool isAtBE = false;
         if(posSL > 0)
         {
            if(pType == POSITION_TYPE_BUY && posSL >= opPrice - 0.0001) isAtBE = true;
            if(pType == POSITION_TYPE_SELL && posSL <= opPrice + 0.0001) isAtBE = true;
         }
         if(!isAtBE) riskPosCount++;
      }
   }

   MqlRates chartD1[];
   ArraySetAsSeries(chartD1, true);
   double chartPDH = 0.0, chartPDL = 0.0;
   if(CopyRates(_Symbol, PERIOD_D1, 1, 1, chartD1) >= 1)
   {
      chartPDH = chartD1[0].high;
      chartPDL = chartD1[0].low;
   }

   string multiTicks = BuildMultiSymbolTicksQuery();
   static datetime lastTicksPrint = 0;
   if(TimeCurrent() - lastTicksPrint >= 30)
   {
      lastTicksPrint = TimeCurrent();
      Print("📊 [Multi-Tick Monitor] ", multiTicks);
   }

   int chartDig = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   if(chartDig <= 0) chartDig = 2;

   string url = InpServerUrl + "?account=" + IntegerToString(login) + 
                "&symbol=" + _Symbol +
                "&balance=" + DoubleToString(balance, 2) + 
                "&equity=" + DoubleToString(equity, 2) + 
                "&credit=" + DoubleToString(credit, 2) + 
                "&floatingProfit=" + DoubleToString(realFloatingProfit, 2) + 
                "&currency=" + curr +
                "&broker=" + company + 
                "&bid=" + DoubleToString(liveBid, chartDig) + 
                "&ask=" + DoubleToString(liveAsk, chartDig) + 
                "&pdh=" + DoubleToString(chartPDH, chartDig) + 
                "&pdl=" + DoubleToString(chartPDL, chartDig) + 
                "&openPositions=" + IntegerToString(openPosCount) +
                "&riskPositions=" + IntegerToString(riskPosCount);

   if(multiTicks != "") url += "&ticks=" + multiTicks;

   int res = WebRequest("GET", url, cookie, NULL, timeout, post, 0, result, result_headers);

   if(res == 200)
   {
      string jsonResponse = CharArrayToString(result);
      if(StringLen(jsonResponse) > 10 && jsonResponse != "[]")
      {
         Print("📩 [MT5 EA] Nueva orden recibida desde Node.js: ", jsonResponse);
         ExecuteJsonOrders(jsonResponse);
      }
   }
}

//+------------------------------------------------------------------+
//| Tick function (Auto Break-Even instantáneo por cada tick)        |
//+------------------------------------------------------------------+
void OnTick()
{
   AutoBreakEvenManager();
}

//+------------------------------------------------------------------+
//| Helper para verificar si un símbolo es operable en el broker     |
//+------------------------------------------------------------------+
bool IsTradableSymbol(string sym)
{
   if(!SymbolSelect(sym, true)) return false;
   long mode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   return (mode != SYMBOL_TRADE_MODE_DISABLED);
}

//+------------------------------------------------------------------+
//| Helper para resolver sufijos del broker (ej. XAUUSD-VIP, XAUUSD.m)|
//+------------------------------------------------------------------+
string ResolveSymbol(string reqSymbol)
{
   // 1. Si el símbolo exacto existe y es operable, usarlo directamente
   if(IsTradableSymbol(reqSymbol))
      return reqSymbol;

   // 1.1 Aliases especiales para Índices (ej. NAS100 -> US100.cash en FTMO)
   if(reqSymbol == "NAS100" || reqSymbol == "US100" || reqSymbol == "USTEC")
   {
      string nasVariants[] = {"US100.cash", "US100", "NAS100", "NAS100.cash", "USTEC", "NDX", "US100-VIP"};
      for(int v = 0; v < ArraySize(nasVariants); v++)
      {
         if(IsTradableSymbol(nasVariants[v])) return nasVariants[v];
      }
   }

   // 2. Probar variantes comunes con sufijo (ej. -VIP para VT Markets, .m, .pro)
   string vipSuffix = reqSymbol + "-VIP";
   if(IsTradableSymbol(vipSuffix))
      return vipSuffix;

   string mSuffix = reqSymbol + ".m";
   if(IsTradableSymbol(mSuffix))
      return mSuffix;

   string proSuffix = reqSymbol + ".pro";
   if(IsTradableSymbol(proSuffix))
      return proSuffix;

   // 3. Probar primero con el símbolo del gráfico actual donde está el EA si es operable
   if(IsTradableSymbol(_Symbol) && (StringFind(_Symbol, reqSymbol) >= 0 || (reqSymbol == "GOLD" && StringFind(_Symbol, "XAU") >= 0)))
      return _Symbol;

   // 4. Buscar en Market Watch (selected = true) un símbolo que contenga el nombre y sea operable
   int totalSelected = SymbolsTotal(true);
   for(int i = 0; i < totalSelected; i++)
   {
      string name = SymbolName(i, true);
      if(StringFind(name, reqSymbol) >= 0 && IsTradableSymbol(name))
      {
         return name;
      }
   }

   // 5. Buscar en el catálogo completo del broker (selected = false)
   int totalAll = SymbolsTotal(false);
   for(int i = 0; i < totalAll; i++)
   {
      string name = SymbolName(i, false);
      if(StringFind(name, reqSymbol) >= 0 && IsTradableSymbol(name))
      {
         return name;
      }
   }

   return reqSymbol;
}

//+------------------------------------------------------------------+
//| Ejecutar órdenes de trading recibidas en formato JSON            |
//+------------------------------------------------------------------+
void ExecuteJsonOrders(string json)
{
   int startPos = 0;
   while(true)
   {
      int objStart = StringFind(json, "{", startPos);
      if(objStart < 0) break;
      int objEnd = StringFind(json, "}", objStart);
      if(objEnd < 0) break;

      string itemJson = StringSubstr(json, objStart, objEnd - objStart + 1);
      startPos = objEnd + 1;

      ExecuteSingleOrder(itemJson);
   }
}

//+------------------------------------------------------------------+
//| Helper para establecer el tipo de llenado compatible con el broker|
//+------------------------------------------------------------------+
void SetBestFillingType(string sym)
{
   uint filling = (uint)SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0)
      trade.SetTypeFilling(ORDER_FILLING_FOK);
   else if((filling & SYMBOL_FILLING_IOC) != 0)
      trade.SetTypeFilling(ORDER_FILLING_IOC);
   else
      trade.SetTypeFilling(ORDER_FILLING_RETURN);
}

//+------------------------------------------------------------------+
//| Verificar si ya existe una posicion activa en direccion opuesta |
//+------------------------------------------------------------------+
bool HasOppositePosition(string sym, ENUM_POSITION_TYPE requestedType)
{
   if(InpAllowHedging) return false; // En cuenta personal con capital propio el hedging está 100% permitido

   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         string posSym = PositionGetString(POSITION_SYMBOL);
         ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         if(posSym == sym && posType != requestedType)
         {
            return true;
         }
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Obtener el ticket de la posicion recien abierta por CTrade       |
//+------------------------------------------------------------------+
ulong GetPositionTicketFromResult(CTrade &tr, string sym)
{
   ulong dealTicket = tr.ResultDeal();
   if(dealTicket > 0 && HistoryDealSelect(dealTicket))
   {
      ulong posId = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
      if(posId > 0 && PositionSelectByTicket(posId)) return posId;
   }
   
   ulong orderTicket = tr.ResultOrder();
   if(orderTicket > 0 && PositionSelectByTicket(orderTicket))
      return orderTicket;

   // Fallback: seleccionar la posición más reciente del símbolo abierta en los últimos 3 segundos
   datetime now = TimeCurrent();
   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetString(POSITION_SYMBOL) == sym)
      {
         datetime posTime = (datetime)PositionGetInteger(POSITION_TIME);
         if(now - posTime <= 4) return t;
      }
   }
   return 0;
}

//+------------------------------------------------------------------+
//| Modificar SL y TP EXCLUSIVAMENTE para un ticket especifico        |
//+------------------------------------------------------------------+
bool ModifySinglePositionByTicket(ulong ticket, double sl, double tp)
{
   if(ticket <= 0)
   {
      Print("⚠️ [MT5 EA] Ticket invalido para modificacion individual: ", ticket);
      return false;
   }

   if(!PositionSelectByTicket(ticket))
   {
      Print("⚠️ [MT5 EA] No se encontro la posicion activa con ticket #", ticket);
      return false;
   }

   string posSym = PositionGetString(POSITION_SYMBOL);
   int digits = (int)SymbolInfoInteger(posSym, SYMBOL_DIGITS);
   if(digits <= 0) digits = 2;

   double existingSL = PositionGetDouble(POSITION_SL);
   double existingTP = PositionGetDouble(POSITION_TP);

   double normSL = (sl > 0) ? NormalizeDouble(sl, digits) : existingSL;
   double normTP = (tp > 0) ? NormalizeDouble(tp, digits) : existingTP;

   ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   double bid = SymbolInfoDouble(posSym, SYMBOL_BID);
   double ask = SymbolInfoDouble(posSym, SYMBOL_ASK);
   double point = SymbolInfoDouble(posSym, SYMBOL_POINT);
   long stopsLevel = SymbolInfoInteger(posSym, SYMBOL_TRADE_STOPS_LEVEL);
   double minDistance = stopsLevel * point;

   // Validar que SL y TP no violen las reglas del broker (Invalid Stops)
   if(posType == POSITION_TYPE_BUY)
   {
      if(normSL > 0 && normSL >= bid - minDistance)
      {
         Print("⚠️ [MT5 EA] SL invalidado por estar muy cerca o por encima de Bid en BUY. Bid: ", bid, " SL: ", normSL);
         normSL = existingSL;
      }
      if(normTP > 0 && normTP <= bid + minDistance)
      {
         Print("⚠️ [MT5 EA] TP (", normTP, ") invalidado por estar por debajo o muy cerca de Bid. No se modificara TP.");
         normTP = existingTP;
      }
   }
   else if(posType == POSITION_TYPE_SELL)
   {
      if(normSL > 0 && normSL <= ask + minDistance)
      {
         Print("⚠️ [MT5 EA] SL invalidado por estar muy cerca o por debajo de Ask en SELL. Ask: ", ask, " SL: ", normSL);
         normSL = existingSL;
      }
      if(normTP > 0 && normTP >= ask - minDistance)
      {
         Print("⚠️ [MT5 EA] TP (", normTP, ") invalidado por estar por encima o muy cerca de Ask. No se modificara TP.");
         normTP = existingTP;
      }
   }

   Print("🔍 [MT5 EA] Modificando INDIVIDUALMENTE posicion #", ticket, " (", posSym, ") | SL: ", normSL, " | TP: ", normTP);

   // 1. Intentar con CTrade
   bool ok = trade.PositionModify(ticket, normSL, normTP);

   // 2. Si CTrade falla, enviar MqlTradeRequest nativo directo al servidor MT5
   if(!ok)
   {
      Print("⚠️ [MT5 EA] CTrade fallo (Retcode: ", trade.ResultRetcode(), "). Ejecutando OrderSend nativo de MQL5...");
      
      MqlTradeRequest req;
      MqlTradeResult res;
      ZeroMemory(req);
      ZeroMemory(res);

      req.action   = TRADE_ACTION_SLTP;
      req.position = ticket;
      req.symbol   = posSym;
      req.sl       = normSL;
      req.tp       = normTP;

      if(OrderSend(req, res))
      {
         if(res.retcode == TRADE_RETCODE_DONE || res.retcode == 10009 || res.retcode == 10008)
         {
            Print("✅ [MT5 EA NATIVO EXITOSO] SL (", normSL, ") y TP (", normTP, ") asignados a posicion #", ticket);
            ok = true;
         }
         else
         {
            Print("❌ [MT5 EA NATIVO ERROR] OrderSend fallo. Retcode: ", res.retcode, " (", res.comment, ")");
         }
      }
   }
   else
   {
      Print("✅ [MT5 EA INDIVIDUAL EXITOSO] SL (", normSL, ") y TP (", normTP, ") asignados a posicion #", ticket);
   }

   return ok;
}

//+------------------------------------------------------------------+
//| Modificar posicion por coincidencia de precio de entrada (Seguro)|
//+------------------------------------------------------------------+
void ModifyPositionByProximity(string symbol, double targetEntry, double sl, double tp, string comment = "")
{
   int total = PositionsTotal();
   ulong bestTicket = 0;
   double minDiff = 999999.0;
   
   for(int i = 0; i < total; i++)
   {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetString(POSITION_SYMBOL) == symbol)
      {
         string posComment = PositionGetString(POSITION_COMMENT);
         if(comment != "" && (StringFind(posComment, comment) >= 0 || StringFind(comment, posComment) >= 0))
         {
            bestTicket = t;
            minDiff = 0.0;
            break;
         }
         double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         if(targetEntry > 0)
         {
            double diff = MathAbs(openPrice - targetEntry);
            if(diff < minDiff)
            {
               minDiff = diff;
               bestTicket = t;
            }
         }
         else
         {
            bestTicket = t; // Tomar la única abierta si no se especificó precio
         }
      }
   }
   
   // Modificar si coincide por comentario o por proximidad razonable (hasta 15.0 / 150 pips)
   if(bestTicket > 0 && (targetEntry <= 0 || minDiff <= 15.0))
   {
      Print("🎯 [MT5 EA] Modificando posicion por canal/proximidad: Ticket #", bestTicket, " (Diferencia: ", DoubleToString(minDiff, 2), ")");
      ModifySinglePositionByTicket(bestTicket, sl, tp);
   }
   else
   {
      Print("⚠️ [MT5 EA] No se encontro posicion coincidente con entrada ", targetEntry, " / comentario ", comment, ". Modificacion omitida.");
   }
}

void ExecuteSingleOrder(string json)
{
   string rawSymbol = ExtractJsonString(json, "symbol");
   if(rawSymbol == "" || rawSymbol == "undefined") rawSymbol = "XAUUSD";
   string symbol = ResolveSymbol(rawSymbol);

   SymbolSelect(symbol, true);
   SetBestFillingType(symbol);

   double volume = ExtractJsonDouble(json, "volume");
   double sl = ExtractJsonDouble(json, "sl");
   double tp = ExtractJsonDouble(json, "tp");
   ulong ticket = ExtractJsonUlong(json, "ticket");
   string actionStr = ExtractJsonString(json, "action");
   string comment = ExtractJsonString(json, "comment");
   if(comment == "") comment = ExtractJsonString(json, "channelId");
   if(comment == "") comment = ExtractJsonString(json, "channel");

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits <= 0) digits = 2;

   if(actionStr == "EXPORT_BARS" || actionStr == "EXPORT_M5" || actionStr == "EXPORT_M2")
   {
      string exportSymbols[] = {"XAUUSD", "EURUSD", "GBPJPY", "USDCAD", "GBPUSD", "AUDUSD", "USDJPY"};
      Print("📊 [MT5 EA] Iniciando exportacion de barras M5 y M2 para backtest...");
      for(int s = 0; s < ArraySize(exportSymbols); s++)
      {
         string rawSym = exportSymbols[s];
         string expSym = ResolveSymbol(rawSym);
         
         // 1. Export M5
         MqlRates rates[];
         ArraySetAsSeries(rates, false);
         int copied = CopyRates(expSym, PERIOD_M5, 0, 3000, rates);
         if(copied > 0)
         {
            string fileName = "M5_" + rawSym + "_THIS_WEEK.csv";
            int handle = FileOpen(fileName, FILE_WRITE|FILE_CSV|FILE_COMMON, '\t');
            if(handle != INVALID_HANDLE)
            {
               FileWriteString(handle, "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n");
               for(int r = 0; r < copied; r++)
               {
                  MqlDateTime dt;
                  TimeToStruct(rates[r].time, dt);
                  string dStr = StringFormat("%04d.%02d.%02d", dt.year, dt.mon, dt.day);
                  string tStr = StringFormat("%02d:%02d:00", dt.hour, dt.min);
                  string line = StringFormat("%s\t%s\t%.5f\t%.5f\t%.5f\t%.5f\t%d\t%d\t%d\n",
                     dStr, tStr, rates[r].open, rates[r].high, rates[r].low, rates[r].close,
                     (int)rates[r].tick_volume, (int)rates[r].real_volume, (int)rates[r].spread);
                  FileWriteString(handle, line);
               }
               FileClose(handle);
               Print("✅ [MT5 EA] Exportadas ", copied, " barras M5 para ", rawSym, " (simbolo broker: ", expSym, ") en Common/Files/", fileName);
            }
         }
         else
         {
            Print("⚠️ [MT5 EA] Error al copiar M5 para ", expSym, " (Error: ", GetLastError(), ")");
         }
         
         // 2. Export M2
         MqlRates ratesM2[];
         ArraySetAsSeries(ratesM2, false);
         int copiedM2 = CopyRates(expSym, PERIOD_M2, 0, 5000, ratesM2);
         if(copiedM2 > 0)
         {
            string fileNameM2 = "M2_" + rawSym + "_THIS_WEEK.csv";
            int handleM2 = FileOpen(fileNameM2, FILE_WRITE|FILE_CSV|FILE_COMMON, '\t');
            if(handleM2 != INVALID_HANDLE)
            {
               FileWriteString(handleM2, "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n");
               for(int r = 0; r < copiedM2; r++)
               {
                  MqlDateTime dt;
                  TimeToStruct(ratesM2[r].time, dt);
                  string dStr = StringFormat("%04d.%02d.%02d", dt.year, dt.mon, dt.day);
                  string tStr = StringFormat("%02d:%02d:00", dt.hour, dt.min);
                  string line = StringFormat("%s\t%s\t%.5f\t%.5f\t%.5f\t%.5f\t%d\t%d\t%d\n",
                     dStr, tStr, ratesM2[r].open, ratesM2[r].high, ratesM2[r].low, ratesM2[r].close,
                     (int)ratesM2[r].tick_volume, (int)ratesM2[r].real_volume, (int)ratesM2[r].spread);
                  FileWriteString(handleM2, line);
               }
               FileClose(handleM2);
               Print("✅ [MT5 EA] Exportadas ", copiedM2, " barras M2 para ", rawSym, " (simbolo broker: ", expSym, ") en Common/Files/", fileNameM2);
            }
         }
         else
         {
            Print("⚠️ [MT5 EA] Error al copiar M2 para ", expSym, " (Error: ", GetLastError(), ")");
         }

         // 3. Export M3
         MqlRates ratesM3[];
         ArraySetAsSeries(ratesM3, false);
         int copiedM3 = CopyRates(expSym, PERIOD_M3, 0, 5000, ratesM3);
         if(copiedM3 > 0)
         {
            string fileNameM3 = "M3_" + rawSym + "_THIS_WEEK.csv";
            int handleM3 = FileOpen(fileNameM3, FILE_WRITE|FILE_CSV|FILE_COMMON, '\t');
            if(handleM3 != INVALID_HANDLE)
            {
               FileWriteString(handleM3, "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n");
               for(int r = 0; r < copiedM3; r++)
               {
                  MqlDateTime dt;
                  TimeToStruct(ratesM3[r].time, dt);
                  string dStr = StringFormat("%04d.%02d.%02d", dt.year, dt.mon, dt.day);
                  string tStr = StringFormat("%02d:%02d:00", dt.hour, dt.min);
                  string line = StringFormat("%s\t%s\t%.5f\t%.5f\t%.5f\t%.5f\t%d\t%d\t%d\n",
                     dStr, tStr, ratesM3[r].open, ratesM3[r].high, ratesM3[r].low, ratesM3[r].close,
                     (int)ratesM3[r].tick_volume, (int)ratesM3[r].real_volume, (int)ratesM3[r].spread);
                  FileWriteString(handleM3, line);
               }
               FileClose(handleM3);
               Print("✅ [MT5 EA] Exportadas ", copiedM3, " barras M3 para ", rawSym, " (simbolo broker: ", expSym, ") en Common/Files/", fileNameM3);
            }
         }
         else
         {
            Print("⚠️ [MT5 EA] Error al copiar M3 para ", expSym, " (Error: ", GetLastError(), ")");
         }
      }
      return;
   }

   if(actionStr == "CLOSE_ALL" || actionStr == "CLOSE_ALL_MARKET" || actionStr == "CLOSE_ALL_POSITIONS")
   {
      Print("🚨 [MT5 EA] Comando de EMERGENCIA CLOSE_ALL recibido para ", symbol == "" ? "TODOS LOS PARES" : symbol, "...");
      int totalPos = PositionsTotal();
      for(int p = totalPos - 1; p >= 0; p--)
      {
         ulong pTicket = PositionGetTicket(p);
         if(pTicket > 0)
         {
            string posSym = PositionGetString(POSITION_SYMBOL);
            if(symbol == "" || symbol == "ALL" || posSym == symbol)
            {
               trade.PositionClose(pTicket);
               Print("🛑 [MT5 EA] Posicion #", pTicket, " (", posSym, ") cerrada de emergencia.");
            }
         }
      }
      return;
   }

   if(actionStr == "CANCEL_ALL_PENDING" || actionStr == "CANCEL" || actionStr == "DELETE" || StringFind(json, "\"action\":\"CANCEL") >= 0)
   {
      string targetType = ExtractJsonString(json, "targetType"); // "BUY_LIMIT" | "SELL_LIMIT" | ""
      Print("🗑️ [MT5 EA] Comando de eliminacion de ordenes pendientes recibido para ", symbol, " (Filtro: ", targetType == "" ? "TODAS" : targetType, ")...");
      
      int totalOrders = OrdersTotal();
      for(int i = totalOrders - 1; i >= 0; i--)
      {
         ulong orderTicket = OrderGetTicket(i);
         if(orderTicket > 0 && (symbol == "" || symbol == "ALL" || OrderGetString(ORDER_SYMBOL) == symbol))
         {
            ENUM_ORDER_TYPE oType = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
            
            bool shouldDelete = false;
            if(targetType == "BUY_LIMIT" && (oType == ORDER_TYPE_BUY_LIMIT || oType == ORDER_TYPE_BUY_STOP)) shouldDelete = true;
            else if(targetType == "SELL_LIMIT" && (oType == ORDER_TYPE_SELL_LIMIT || oType == ORDER_TYPE_SELL_STOP)) shouldDelete = true;
            else if(targetType == "" || targetType == "ALL") shouldDelete = true;

            if(shouldDelete)
            {
               bool delOk = trade.OrderDelete(orderTicket);
               if(delOk) Print("🗑️ [MT5 EA] Orden pendiente #", orderTicket, " (", EnumToString(oType), ") eliminada.");
               else Print("⚠️ [MT5 EA] No se pudo eliminar la orden pendiente #", orderTicket, ". Retcode: ", trade.ResultRetcode());
            }
         }
      }
      return;
   }
   else if(actionStr == "MODIFY" || actionStr == "UPDATE" || StringFind(json, "\"action\":\"MODIFY") >= 0)
   {
      string modType = ExtractJsonString(json, "modifyType");
      Print("🔄 [MT5 EA] Comando MODIFY recibido para ", symbol, " (Tipo: ", modType == "" ? "ESTANDAR" : modType, "). Ticket: ", ticket, " | SL: ", sl, " | TP: ", tp);
      if(modType == "BREAK_EVEN" || modType == "BE")
      {
         Print("🛡️ [MT5 EA] Comando BREAK_EVEN ignorado por configuracion del usuario (SL se mantiene en su nivel original).");
         return;
      }
      else if(ticket > 0)
      {
         ModifySinglePositionByTicket(ticket, sl, tp);
      }
      else
      {
         double targetEntry = ExtractJsonDouble(json, "entryPrice");
         if(targetEntry <= 0) targetEntry = ExtractJsonDouble(json, "entry");
         ModifyPositionByProximity(symbol, targetEntry, sl, tp, comment);
      }
   }
   else if(actionStr == "BUY_LIMIT")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      double emDistSL = GetDefaultEmergencySLDistance(symbol);
      if(sl <= 0) sl = NormalizeDouble(entryPrice - emDistSL, digits);
      if(tp <= 0) tp = GetSmartEmergencyTP(symbol, POSITION_TYPE_BUY, entryPrice, digits);
      Print("⏳ [MT5 EA] Colocando orden pendiente BUY LIMIT en ", symbol, " a ", entryPrice, " | SL: ", sl, " | TP: ", tp);
      bool res = trade.BuyLimit(volume > 0 ? volume : 0.01, entryPrice, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      if(res) Print("✅ [MT5 EA] Orden pendiente BUY LIMIT colocada con exito en ", symbol);
      else Print("❌ [MT5 EA] Error al colocar BUY LIMIT. Retcode: ", trade.ResultRetcode());
   }
   else if(actionStr == "SELL_LIMIT")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      double emDistSL = GetDefaultEmergencySLDistance(symbol);
      if(sl <= 0) sl = NormalizeDouble(entryPrice + emDistSL, digits);
      if(tp <= 0) tp = GetSmartEmergencyTP(symbol, POSITION_TYPE_SELL, entryPrice, digits);
      Print("⏳ [MT5 EA] Colocando orden pendiente SELL LIMIT en ", symbol, " a ", entryPrice, " | SL: ", sl, " | TP: ", tp);
      bool res = trade.SellLimit(volume > 0 ? volume : 0.01, entryPrice, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      if(res) Print("✅ [MT5 EA] Orden pendiente SELL LIMIT colocada con exito en ", symbol);
      else Print("❌ [MT5 EA] Error al colocar SELL LIMIT. Retcode: ", trade.ResultRetcode());
   }
   else if(actionStr == "BUY_STOP")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      double emDistSL = GetDefaultEmergencySLDistance(symbol);
      if(sl <= 0) sl = NormalizeDouble(entryPrice - emDistSL, digits);
      if(tp <= 0) tp = GetSmartEmergencyTP(symbol, POSITION_TYPE_BUY, entryPrice, digits);
      Print("⏳ [MT5 EA] Colocando orden pendiente BUY STOP en ", symbol, " a ", entryPrice, " | SL: ", sl, " | TP: ", tp);
      bool res = trade.BuyStop(volume > 0 ? volume : 0.01, entryPrice, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      if(res) Print("✅ [MT5 EA] Orden pendiente BUY STOP colocada con exito en ", symbol);
      else Print("❌ [MT5 EA] Error al colocar BUY STOP. Retcode: ", trade.ResultRetcode());
   }
   else if(actionStr == "SELL_STOP")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      double emDistSL = GetDefaultEmergencySLDistance(symbol);
      if(sl <= 0) sl = NormalizeDouble(entryPrice + emDistSL, digits);
      if(tp <= 0) tp = GetSmartEmergencyTP(symbol, POSITION_TYPE_SELL, entryPrice, digits);
      Print("⏳ [MT5 EA] Colocando orden pendiente SELL STOP en ", symbol, " a ", entryPrice, " | SL: ", sl, " | TP: ", tp);
      bool res = trade.SellStop(volume > 0 ? volume : 0.01, entryPrice, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      if(res) Print("✅ [MT5 EA] Orden pendiente SELL STOP colocada con exito en ", symbol);
      else Print("❌ [MT5 EA] Error al colocar SELL STOP. Retcode: ", trade.ResultRetcode());
   }
   else if(actionStr == "BUY" || actionStr == "BUY NOW" || StringFind(actionStr, "BUY") >= 0)
   {
      if(HasOppositePosition(symbol, POSITION_TYPE_BUY))
      {
         Print("⚠️ [REGLA ESTRATEGIA - ANTI-HEDGING] Omite BUY en ", symbol, " porque ya existe una posicion activa de SELL opuesta.");
         return;
      }

      double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
      if(ask <= 0) ask = SymbolInfoDouble(symbol, SYMBOL_LAST);

      // Garantía anti-quema: Si la orden entrase sin SL o TP, aplicar parámetros de seguridad inteligentes
      double emDistSL = GetDefaultEmergencySLDistance(symbol);
      if(sl <= 0) sl = NormalizeDouble(ask - emDistSL, digits);
      if(tp <= 0) tp = GetSmartEmergencyTP(symbol, POSITION_TYPE_BUY, ask, digits);
      
      // 1. Intentar abrir con SL/TP directo en un solo paso
      bool res = trade.Buy(volume > 0 ? volume : 0.01, symbol, ask, sl, tp, comment);
      
      // 2. Si el broker ECN rechaza la orden directa con SL/TP, abrir primero y luego modificar SOLO este ticket
      if(!res)
      {
         Print("⚠️ [MT5 EA] Broker ECN rechazo SL/TP directo (Retcode: ", trade.ResultRetcode(), "). Abriendo a mercado y asignando SL/TP a la nueva posicion...");
         res = trade.Buy(volume > 0 ? volume : 0.01, symbol, ask, 0, 0, comment);
         if(res)
         {
            ulong posTicket = 0;
            for(int attempt = 0; attempt < 5; attempt++)
            {
               Sleep(150);
               posTicket = GetPositionTicketFromResult(trade, symbol);
               if(posTicket > 0) break;
            }
            bool modOk = false;
            if(posTicket > 0 && (sl > 0 || tp > 0))
            {
               modOk = ModifySinglePositionByTicket(posTicket, sl, tp);
            }
            if(!modOk)
            {
               Print("⛔ [ALERTA DE SEGURIDAD CRITICA] Imposible aplicar SL/TP tras abrir a mercado (Retcode: ", trade.ResultRetcode(), "). CERRANDO POSICION #", posTicket, " DE INMEDIATO!");
               if(posTicket > 0) trade.PositionClose(posTicket);
               else trade.PositionClose(symbol);
               res = false;
            }
         }
      }
      else
      {
         ulong posTicket = GetPositionTicketFromResult(trade, symbol);
         Print("✅ [MT5 EA] Posicion BUY abierta exitosamente con SL y TP en ticket #", posTicket);
      }

      if(!res)
      {
         Print("❌ [MT5 EA] Error al abrir BUY en ", symbol, ". Codigo error: ", GetLastError(), " | Retcode: ", trade.ResultRetcode());
      }
   }
   else if(actionStr == "SELL" || actionStr == "SELL NOW" || StringFind(actionStr, "SELL") >= 0)
   {
      if(HasOppositePosition(symbol, POSITION_TYPE_SELL))
      {
         Print("⚠️ [REGLA ESTRATEGIA - ANTI-HEDGING] Omite SELL en ", symbol, " porque ya existe una posicion activa de BUY opuesta.");
         return;
      }

      double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
      if(bid <= 0) bid = SymbolInfoDouble(symbol, SYMBOL_LAST);

      // Garantía anti-quema: Si la orden entrase sin SL o TP, aplicar parámetros de seguridad inteligentes
      double emDistSL = GetDefaultEmergencySLDistance(symbol);
      if(sl <= 0) sl = NormalizeDouble(bid + emDistSL, digits);
      if(tp <= 0) tp = GetSmartEmergencyTP(symbol, POSITION_TYPE_SELL, bid, digits);

      // 1. Intentar abrir con SL/TP directo en un solo paso
      bool res = trade.Sell(volume > 0 ? volume : 0.01, symbol, bid, sl, tp, comment);

      // 2. Si el broker ECN rechaza la orden directa con SL/TP, abrir primero y luego modificar SOLO este ticket
      if(!res)
      {
         Print("⚠️ [MT5 EA] Broker ECN rechazo SL/TP directo (Retcode: ", trade.ResultRetcode(), "). Abriendo a mercado y asignando SL/TP a la nueva posicion...");
         res = trade.Sell(volume > 0 ? volume : 0.01, symbol, bid, 0, 0, comment);
         if(res)
         {
            ulong posTicket = 0;
            for(int attempt = 0; attempt < 5; attempt++)
            {
               Sleep(150);
               posTicket = GetPositionTicketFromResult(trade, symbol);
               if(posTicket > 0) break;
            }
            bool modOk = false;
            if(posTicket > 0 && (sl > 0 || tp > 0))
            {
               modOk = ModifySinglePositionByTicket(posTicket, sl, tp);
            }
            if(!modOk)
            {
               Print("⛔ [ALERTA DE SEGURIDAD CRITICA] Imposible aplicar SL/TP tras abrir a mercado (Retcode: ", trade.ResultRetcode(), "). CERRANDO POSICION #", posTicket, " DE INMEDIATO!");
               if(posTicket > 0) trade.PositionClose(posTicket);
               else trade.PositionClose(symbol);
               res = false;
            }
         }
      }
      else
      {
         ulong posTicket = GetPositionTicketFromResult(trade, symbol);
         Print("✅ [MT5 EA] Posicion SELL abierta exitosamente con SL y TP en ticket #", posTicket);
      }

      if(!res)
      {
         Print("❌ [MT5 EA] Error al abrir SELL en ", symbol, ". Codigo error: ", GetLastError(), " | Retcode: ", trade.ResultRetcode());
      }
   }
}

//+------------------------------------------------------------------+
//| Helpers de parseo JSON estático                                  |
//+------------------------------------------------------------------+
double ExtractJsonDouble(string json, string key)
{
   int pos = StringFind(json, "\"" + key + "\":");
   if(pos < 0) return 0.0;
   pos += StringLen(key) + 3;
   string sub = StringSubstr(json, pos, 20);
   int endPos = StringFind(sub, ",");
   if(endPos < 0) endPos = StringFind(sub, "}");
   if(endPos > 0) sub = StringSubstr(sub, 0, endPos);
   return StringToDouble(sub);
}

ulong ExtractJsonUlong(string json, string key)
{
   int pos = StringFind(json, "\"" + key + "\":");
   if(pos < 0) return 0;
   pos += StringLen(key) + 3;
   string sub = StringSubstr(json, pos, 25);
   int endPos = StringFind(sub, ",");
   if(endPos < 0) endPos = StringFind(sub, "}");
   if(endPos > 0) sub = StringSubstr(sub, 0, endPos);
   StringTrimLeft(sub);
   StringTrimRight(sub);
   StringReplace(sub, "\"", "");
   return (ulong)StringToInteger(sub);
}

string ExtractJsonString(string json, string key)
{
   int pos = StringFind(json, "\"" + key + "\":\"");
   if(pos < 0) return "";
   pos += StringLen(key) + 4;
   string sub = StringSubstr(json, pos, 30);
   int endPos = StringFind(sub, "\"");
   if(endPos > 0) sub = StringSubstr(sub, 0, endPos);
   return sub;
}

//+------------------------------------------------------------------+
//| Notificar cierre de posicion al servidor Node.js (Feedback Loop)|
//+------------------------------------------------------------------+
void NotifyTradeClosed(ulong dealTicket, ulong posTicket, string sym, double profit, double price, string comment)
{
   string cookie=NULL, headers = "Content-Type: application/json\r\n";
   char post[], result[];
   string result_headers;
   int timeout = 500;
   
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string company = AccountInfoString(ACCOUNT_COMPANY);
   double liveBal = AccountInfoDouble(ACCOUNT_BALANCE);
   double liveEq = AccountInfoDouble(ACCOUNT_EQUITY);
   string curr = AccountInfoString(ACCOUNT_CURRENCY);
   
   string payload = StringFormat("{\"account\":\"%I64u\",\"broker\":\"%s\",\"ticket\":%I64u,\"position\":%I64u,\"symbol\":\"%s\",\"profit\":%.2f,\"price\":%.2f,\"outcome\":\"%s\",\"comment\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"currency\":\"%s\"}",
                                 login, company, dealTicket, posTicket, sym, profit, price, (profit >= 0 ? "WIN" : "LOSS"), comment, liveBal, liveEq, curr);
   
   StringToCharArray(payload, post, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(post, ArraySize(post) - 1);
   
   string url = "http://127.0.0.1:3000/trade-closed";
   int res = WebRequest("POST", url, cookie, headers, timeout, post, ArraySize(post), result, result_headers);
   if(res == 200)
   {
      Print("📊 [FEEDBACK LOOP MT5] Notificado cierre de trade #", posTicket, " al AnalyticsEngine (Profit: $", DoubleToString(profit, 2), ")");
   }
}

//+------------------------------------------------------------------+
//| Gestor de Transacciones de Trading (Detección de cierres TP/SL)  |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest& request,
                        const MqlTradeResult& result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      ulong dealTicket = trans.deal;
      if(dealTicket > 0 && HistoryDealSelect(dealTicket))
      {
         ENUM_DEAL_ENTRY entryType = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
         if(entryType == DEAL_ENTRY_OUT || entryType == DEAL_ENTRY_INOUT)
         {
            double profit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
            double closePrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
            string dealSym = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
            string dealComment = HistoryDealGetString(dealTicket, DEAL_COMMENT);
            ulong posTicket = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
            
            // Si el dealComment es [tp] o [sl], recuperar el canal del deal de entrada original
            if(posTicket > 0 && (dealComment == "" || StringFind(dealComment, "[") >= 0))
            {
               if(HistorySelectByPosition(posTicket))
               {
                  int totalDeals = HistoryDealsTotal();
                  for(int d = 0; d < totalDeals; d++)
                  {
                     ulong dTicket = HistoryDealGetTicket(d);
                     if(dTicket > 0 && (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dTicket, DEAL_ENTRY) == DEAL_ENTRY_IN)
                     {
                        string origComment = HistoryDealGetString(dTicket, DEAL_COMMENT);
                        if(origComment != "") dealComment = origComment;
                        break;
                     }
                  }
               }
            }
            
            NotifyTradeClosed(dealTicket, posTicket, dealSym, profit, closePrice, dealComment);
         }
      }
   }
}
