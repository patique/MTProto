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

// 🛡️ PARÁMETROS AUTO BREAK-EVEN & TRAILING STOP DINÁMICO (RESPETO DE R:R INSTITUCIONAL)
input bool     InpEnableAutoBE          = false; // Desactivado por defecto: permite a las operaciones respirar hacia TP (R:R 1.0)
input double   InpBETriggerPips         = 18.0;  // Pips de recorrido para activar BE institucional (Oro: 1.80 USD | EURUSD: 18 pips)
input double   InpBEOffsetPips          = 3.0;   // Colchón de beneficio neto por encima de entrada (cubre spread y comisiones)

input bool     InpEnableTrailing        = false; // Desactivado por defecto (Solo R:R 1.0 institucional)
input double   InpTrailingTriggerPips   = 25.0;  // Pips de beneficio para ACTIVAR Trailing Stop
input double   InpTrailingDistance      = 15.0;  // Distancia de persecución tras el precio
input double   InpTrailingStep          = 5.0;   // Paso mínimo de avance [Norma Anti-Spam The5%ers]

CTrade         trade;
datetime       lastCheckTime = 0;

//+------------------------------------------------------------------+
//| Estructura para registrar deals en memoria                       |
//+------------------------------------------------------------------+
struct DealRecord
{
   ulong    ticket;
   ulong    posId;
   ulong    order;
   datetime time;
   int      type;
   int      entry;
   string   sym;
   double   vol;
   double   price;
   double   profit;
   double   comm;
   double   swap;
   double   fee;
   string   comment;
};

//+------------------------------------------------------------------+
//| Exportar Historial Completo a Archivos CSV en Carpeta Comun     |
//+------------------------------------------------------------------+
void ExportFullHistory()
{
   ResetLastError();
   if(!HistorySelect(0, TimeCurrent()))
   {
      Print("⚠️ [MT5 History] Error seleccionando historial: ", GetLastError());
      return;
   }

   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   int totalDeals = HistoryDealsTotal();
   if(totalDeals <= 0)
   {
      Print("ℹ️ [MT5 History] Cuenta #", login, ": No hay deals en el historial.");
      return;
   }

   DealRecord deals[];
   ArrayResize(deals, totalDeals);
   int count = 0;

   for(int i = 0; i < totalDeals; i++)
   {
      ulong t = HistoryDealGetTicket(i);
      if(t > 0)
      {
         deals[count].ticket  = t;
         deals[count].posId   = HistoryDealGetInteger(t, DEAL_POSITION_ID);
         deals[count].order   = HistoryDealGetInteger(t, DEAL_ORDER);
         deals[count].time    = (datetime)HistoryDealGetInteger(t, DEAL_TIME);
         deals[count].type    = (int)HistoryDealGetInteger(t, DEAL_TYPE);
         deals[count].entry   = (int)HistoryDealGetInteger(t, DEAL_ENTRY);
         deals[count].sym     = HistoryDealGetString(t, DEAL_SYMBOL);
         deals[count].vol     = HistoryDealGetDouble(t, DEAL_VOLUME);
         deals[count].price   = HistoryDealGetDouble(t, DEAL_PRICE);
         deals[count].profit  = HistoryDealGetDouble(t, DEAL_PROFIT);
         deals[count].comm    = HistoryDealGetDouble(t, DEAL_COMMISSION);
         deals[count].swap    = HistoryDealGetDouble(t, DEAL_SWAP);
         deals[count].fee     = HistoryDealGetDouble(t, DEAL_FEE);
         deals[count].comment = HistoryDealGetString(t, DEAL_COMMENT);
         count++;
      }
   }
   ArrayResize(deals, count);

   // 1. Exportar fichero de Deals detallados
   string fnameDeals = "history_deals_" + IntegerToString(login) + ".csv";
   int fDeals = FileOpen(fnameDeals, FILE_WRITE|FILE_CSV|FILE_ANSI|FILE_COMMON, ",");
   if(fDeals != INVALID_HANDLE)
   {
      FileWrite(fDeals, "Ticket", "PositionID", "Order", "Time", "Type", "Entry", "Symbol", "Volume", "Price", "Profit", "Commission", "Swap", "Fee", "Comment");
      for(int i = 0; i < count; i++)
      {
         string sType = (deals[i].type == DEAL_TYPE_BUY ? "BUY" : (deals[i].type == DEAL_TYPE_SELL ? "SELL" : (deals[i].type == DEAL_TYPE_BALANCE ? "BALANCE" : "OTHER")));
         string sEntry = (deals[i].entry == DEAL_ENTRY_IN ? "IN" : (deals[i].entry == DEAL_ENTRY_OUT ? "OUT" : (deals[i].entry == DEAL_ENTRY_INOUT ? "INOUT" : "STATE")));

         FileWrite(fDeals, IntegerToString(deals[i].ticket), IntegerToString(deals[i].posId), IntegerToString(deals[i].order),
                   TimeToString(deals[i].time, TIME_DATE|TIME_SECONDS), sType, sEntry, deals[i].sym,
                   DoubleToString(deals[i].vol, 2), DoubleToString(deals[i].price, 5), DoubleToString(deals[i].profit, 2),
                   DoubleToString(deals[i].comm, 2), DoubleToString(deals[i].swap, 2), DoubleToString(deals[i].fee, 2),
                   deals[i].comment);
      }
      FileClose(fDeals);
   }

   // 2. Exportar fichero de Posiciones cerradas (Round-Trip)
   string fnamePos = "history_positions_" + IntegerToString(login) + ".csv";
   int fPos = FileOpen(fnamePos, FILE_WRITE|FILE_CSV|FILE_ANSI|FILE_COMMON, ",");
   if(fPos != INVALID_HANDLE)
   {
      FileWrite(fPos, "PositionID", "Symbol", "Type", "Volume", "OpenTime", "OpenPrice", "CloseTime", "ClosePrice", "GrossProfit", "Commission", "Swap", "NetProfit", "Pips", "CloseComment");

      for(int i = 0; i < count; i++)
      {
         if(deals[i].entry == DEAL_ENTRY_OUT || deals[i].entry == DEAL_ENTRY_INOUT)
         {
            ulong pId = deals[i].posId;
            if(pId <= 0) continue;

            datetime openTime = 0;
            double openPrice = 0.0;
            string inTypeStr = "BUY";
            double totalComm = deals[i].comm;

            for(int j = 0; j < count; j++)
            {
               if(deals[j].posId == pId && deals[j].entry == DEAL_ENTRY_IN)
               {
                  openTime = deals[j].time;
                  openPrice = deals[j].price;
                  inTypeStr = (deals[j].type == DEAL_TYPE_BUY ? "BUY" : "SELL");
                  totalComm += deals[j].comm;
                  break;
               }
            }

            double netProfit = deals[i].profit + totalComm + deals[i].swap;
            double pips = 0.0;
            string sym = deals[i].sym;
            int digs = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
            if(digs <= 0) digs = 2;
            double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
            if(pt > 0 && openPrice > 0)
            {
               double diff = (inTypeStr == "BUY") ? (deals[i].price - openPrice) : (openPrice - deals[i].price);
               double mult = (digs == 3 || digs == 5) ? 10.0 : 1.0;
               pips = (diff / pt) / mult;
            }

            FileWrite(fPos, IntegerToString(pId), sym, inTypeStr, DoubleToString(deals[i].vol, 2),
                      TimeToString(openTime, TIME_DATE|TIME_SECONDS), DoubleToString(openPrice, digs),
                      TimeToString(deals[i].time, TIME_DATE|TIME_SECONDS), DoubleToString(deals[i].price, digs),
                      DoubleToString(deals[i].profit, 2), DoubleToString(totalComm, 2), DoubleToString(deals[i].swap, 2),
                      DoubleToString(netProfit, 2), DoubleToString(pips, 1), deals[i].comment);
         }
      }
      FileClose(fPos);
   }

   Print("📁 [MT5 History] Exportacion completada para Cuenta #", login, " (", count, " deals). Ficheros guardados en Carpeta Comun.");
}

//+------------------------------------------------------------------+
//| Factor de Escala de Pips exacto por Símbolo                      |
//+------------------------------------------------------------------+
double GetPipScale(string sym)
{
   if(StringFind(sym, "XAU") >= 0 || StringFind(sym, "GOLD") >= 0) return 0.10; // 1 pip en Oro = 0.10 USD (10 puntos)
   if(StringFind(sym, "JPY") >= 0) return 0.01;                                // 1 pip en JPY = 0.01 JPY
   if(StringFind(sym, "NAS") >= 0 || StringFind(sym, "US100") >= 0 || StringFind(sym, "USTEC") >= 0 || StringFind(sym, "NDX") >= 0) return 1.0; // 1 pt en NAS
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   if(digits >= 4) return 0.0001; // Forex regular (EURUSD: 1 pip = 0.00010)
   return SymbolInfoDouble(sym, SYMBOL_POINT) * 10.0;
}

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   EventSetMillisecondTimer(InpPollInterval);
   string eSym = ResolveSymbol("EURUSD");
   if(eSym != "") SymbolSelect(eSym, true);
   Print("✅ TelegramMT5Copier iniciado. Conectando a ", InpServerUrl);
   ExportFullHistory();
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
//| Gestor de Auto Break-Even y Trailing Stop Dinámico (The5%ers Safe)|
//+------------------------------------------------------------------+
void AutoBreakEvenManager()
{
   if(!InpEnableAutoBE && !InpEnableTrailing) return;

   int total = PositionsTotal();
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         string posSym = PositionGetString(POSITION_SYMBOL);
         double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         double currentSL = PositionGetDouble(POSITION_SL);
         double currentTP = PositionGetDouble(POSITION_TP);
         ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

         int digits = (int)SymbolInfoInteger(posSym, SYMBOL_DIGITS);
         if(digits <= 0) digits = 2;

         double bid = SymbolInfoDouble(posSym, SYMBOL_BID);
         double ask = SymbolInfoDouble(posSym, SYMBOL_ASK);

         double pipScale = GetPipScale(posSym);
         double beTriggerVal = InpBETriggerPips * pipScale;
         double beOffsetVal = InpBEOffsetPips * pipScale;
         double trailTriggerVal = InpTrailingTriggerPips * pipScale;
         double trailDistVal = InpTrailingDistance * pipScale;
         double trailStepVal = InpTrailingStep * pipScale;

         if(posType == POSITION_TYPE_BUY)
         {
            double bePrice = NormalizeDouble(openPrice + beOffsetVal, digits);

            // 1. Auto Break-Even inicial
            if(InpEnableAutoBE && bid >= openPrice + beTriggerVal && (currentSL < bePrice || currentSL <= 0))
            {
               Print("🛡️ [AUTO BREAK-EVEN] BUY #", ticket, " (", posSym, ") en beneficio. Moviendo SL a BE: ", bePrice);
               trade.PositionModify(ticket, bePrice, currentTP);
               currentSL = bePrice;
            }

            // 2. Trailing Stop Dinámico continuo (solo tras superar InpTrailingTriggerPips)
            if(InpEnableTrailing && bid >= openPrice + trailTriggerVal)
            {
               double desiredSL = NormalizeDouble(bid - trailDistVal, digits);
               // Filtro Anti-Spam: Solo enviar modificación si avanza al menos trailStepVal y está por encima del SL actual
               if(desiredSL >= currentSL + trailStepVal && desiredSL >= bePrice)
               {
                  Print("🚀 [TRAILING STOP BUY] Posición #", ticket, " (", posSym, ") -> Avanzando SL de ", currentSL, " a ", desiredSL, " (Bid: ", bid, ")");
                  trade.PositionModify(ticket, desiredSL, currentTP);
               }
            }
         }
         else if(posType == POSITION_TYPE_SELL)
         {
            double bePrice = NormalizeDouble(openPrice - beOffsetVal, digits);

            // 1. Auto Break-Even inicial
            if(InpEnableAutoBE && ask <= openPrice - beTriggerVal && (currentSL > bePrice || currentSL <= 0))
            {
               Print("🛡️ [AUTO BREAK-EVEN] SELL #", ticket, " (", posSym, ") en beneficio. Moviendo SL a BE: ", bePrice);
               trade.PositionModify(ticket, bePrice, currentTP);
               currentSL = bePrice;
            }

            // 2. Trailing Stop Dinámico continuo (solo tras superar InpTrailingTriggerPips)
            if(InpEnableTrailing && ask <= openPrice - trailTriggerVal)
            {
               double desiredSL = NormalizeDouble(ask + trailDistVal, digits);
               // Filtro Anti-Spam: Solo enviar modificación si avanza al menos trailStepVal y está por debajo del SL actual
               if((currentSL <= 0 || desiredSL <= currentSL - trailStepVal) && desiredSL <= bePrice)
               {
                  Print("🚀 [TRAILING STOP SELL] Posición #", ticket, " (", posSym, ") -> Avanzando SL de ", currentSL, " a ", desiredSL, " (Ask: ", ask, ")");
                  trade.PositionModify(ticket, desiredSL, currentTP);
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
               double point = SymbolInfoDouble(posSym, SYMBOL_POINT);
               double defaultStopDistance = 3.0;
               if(digits >= 4) defaultStopDistance = 300 * point; // 30 pips de emergencia en Forex

               double normSL = (sl > 0) ? sl : ((posType == POSITION_TYPE_BUY) ? NormalizeDouble(openPrice - defaultStopDistance, digits) : NormalizeDouble(openPrice + defaultStopDistance, digits));
               double normTP = (tp > 0) ? tp : ((posType == POSITION_TYPE_BUY) ? NormalizeDouble(openPrice + defaultStopDistance, digits) : NormalizeDouble(openPrice - defaultStopDistance, digits));

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
//| Timer function (Consultar servidor local Node.js en ms)          |
//+------------------------------------------------------------------+
void OnTimer()
{
   // 1. Ejecutar gestor de Auto Break-Even para proteger ganancias al avanzar hacia TP1
   AutoBreakEvenManager();

   // 2. Ejecutar vigilante de seguridad de Stop Loss en cada pulso (250 ms)
   EnforceSafetyStopLoss();

   string cookie=NULL, headers;
   char post[], result[];
   string result_headers;
   int timeout = 500;

   // Realizar petición GET al servidor Node.js enviando identidad de cuenta, balance y precios
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string company = AccountInfoString(ACCOUNT_COMPANY);
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double liveBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double liveAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   int openPosCount = PositionsTotal();
   int openBuy = 0, openSell = 0;
   for(int p = 0; p < openPosCount; p++)
   {
      ulong t = PositionGetTicket(p);
      if(t > 0)
      {
         ENUM_POSITION_TYPE pt = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         if(pt == POSITION_TYPE_BUY) openBuy++;
         else if(pt == POSITION_TYPE_SELL) openSell++;
      }
   }
   int symDigits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   if(symDigits <= 0) symDigits = 2;

   string url = InpServerUrl + "?account=" + IntegerToString(login) + 
                "&balance=" + DoubleToString(balance, 2) + 
                "&equity=" + DoubleToString(equity, 2) + 
                "&broker=" + company + 
                "&symbol=" + _Symbol + 
                "&bid=" + DoubleToString(liveBid, symDigits) + 
                "&ask=" + DoubleToString(liveAsk, symDigits) + 
                "&openPositions=" + IntegerToString(openPosCount) + 
                "&openBuy=" + IntegerToString(openBuy) + 
                "&openSell=" + IntegerToString(openSell);

   // Enviar precios en tiempo real de EURUSD si existe en Market Watch
   static string cachedEUR = "";
   if(cachedEUR == "") cachedEUR = ResolveSymbol("EURUSD");
   double eBid = 0, eAsk = 0;
   if(cachedEUR != "" && GetSymbolPrices(cachedEUR, eBid, eAsk))
   {
      url += "&eurusdBid=" + DoubleToString(eBid, 5) + "&eurusdAsk=" + DoubleToString(eAsk, 5);
   }

   // Enviar precios en tiempo real de GBPJPY si existe en Market Watch
   static string cachedGBP = "";
   if(cachedGBP == "") cachedGBP = ResolveSymbol("GBPJPY");
   double gBid = 0, gAsk = 0;
   if(cachedGBP != "" && GetSymbolPrices(cachedGBP, gBid, gAsk))
   {
      url += "&gbpjpyBid=" + DoubleToString(gBid, 3) + "&gbpjpyAsk=" + DoubleToString(gAsk, 3);
   }

   // Enviar precios en tiempo real de NAS100 si existe en Market Watch
   static string cachedNAS = "";
   if(cachedNAS == "")
   {
      cachedNAS = ResolveSymbol("NAS100");
      if(cachedNAS == "") cachedNAS = ResolveSymbol("US100");
      if(cachedNAS == "") cachedNAS = ResolveSymbol("USTEC");
      if(cachedNAS == "") cachedNAS = ResolveSymbol("NDX");
      if(cachedNAS == "") cachedNAS = ResolveSymbol("NAS");
   }
   double nBid = 0, nAsk = 0;
   if(cachedNAS != "" && GetSymbolPrices(cachedNAS, nBid, nAsk))
   {
      int nDigits = (int)SymbolInfoInteger(cachedNAS, SYMBOL_DIGITS);
      if(nDigits <= 0) nDigits = 2;
      url += "&nas100Bid=" + DoubleToString(nBid, nDigits) + "&nas100Ask=" + DoubleToString(nAsk, nDigits);
   }

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
//| Obtener precios actuales (Bid/Ask) con fallbacks robustos        |
//+------------------------------------------------------------------+
bool GetSymbolPrices(string sym, double &bid, double &ask)
{
   bid = 0; ask = 0;
   if(sym == "") return false;
   
   MqlTick tick;
   if(SymbolInfoTick(sym, tick) && tick.bid > 0 && tick.ask > 0)
   {
      bid = tick.bid;
      ask = tick.ask;
      return true;
   }
   
   bid = SymbolInfoDouble(sym, SYMBOL_BID);
   ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(bid > 0 && ask > 0) return true;
   
   double last = SymbolInfoDouble(sym, SYMBOL_LAST);
   if(last > 0)
   {
      bid = last;
      ask = last;
      return true;
   }
   
   return false;
}

//+------------------------------------------------------------------+
//| Helper para verificar si un símbolo permite trading real en este broker |
//+------------------------------------------------------------------+
bool IsSymbolTradable(string sym)
{
   if(sym == "") return false;
   long mode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   return (mode != SYMBOL_TRADE_MODE_DISABLED);
}

//+------------------------------------------------------------------+
//| Helper para resolver sufijos del broker (ej. XAUUSD-VIP, US100)  |
//+------------------------------------------------------------------+
string ResolveSymbol(string reqSymbol)
{
   if(reqSymbol == "") return "";

   // 0. Si coincide con el gráfico donde corre el EA y es operable
   if((StringFind(_Symbol, reqSymbol) >= 0 || (reqSymbol == "GOLD" && StringFind(_Symbol, "XAU") >= 0)) && IsSymbolTradable(_Symbol))
      return _Symbol;

   // 1. Si el símbolo exacto ya existe, está seleccionado en Market Watch Y ES OPERABLE
   if(SymbolInfoInteger(reqSymbol, SYMBOL_SELECT) && IsSymbolTradable(reqSymbol))
      return reqSymbol;

   // 2. Buscar primero entre los símbolos ya visibles en Market Watch que sean operables
   int totalSelected = SymbolsTotal(true);
   for(int i = 0; i < totalSelected; i++)
   {
      string name = SymbolName(i, true);
      if(StringFind(name, reqSymbol) >= 0 && IsSymbolTradable(name))
         return name;
   }

   // 3. Buscar en el catálogo completo del broker y agregarlo a Market Watch (solo si es operable)
   int totalAll = SymbolsTotal(false);
   for(int i = 0; i < totalAll; i++)
   {
      string name = SymbolName(i, false);
      if(StringFind(name, reqSymbol) >= 0 && IsSymbolTradable(name))
      {
         SymbolSelect(name, true);
         return name;
      }
   }

   return "";
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
   // Detección automática estricta de cuentas de Fondeo (Prop Firms)
   string company = AccountInfoString(ACCOUNT_COMPANY);
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   bool isPropFirm = (StringFind(company, "FTMO") >= 0 || 
                      StringFind(company, "Five Percent") >= 0 || 
                      StringFind(company, "The5") >= 0 || 
                      bal >= 4000.0);

   // Si es cuenta personal (Capital Propio) y el usuario permite Hedging, no se bloquea
   // En cuentas de Fondeo (Prop Firms), el Anti-Hedging es OBLIGATORIO E INQUEBRANTABLE (Regla 1)
   if(InpAllowHedging && !isPropFirm) return false;

   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         string posSym = PositionGetString(POSITION_SYMBOL);
         ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         
         // Normalizar símbolos para emparejar con o sin sufijos (ej. XAUUSD vs XAUUSD-VIP)
         bool sameSymbol = (posSym == sym || 
                           (StringFind(sym, "XAU") >= 0 && StringFind(posSym, "XAU") >= 0) ||
                           (StringFind(sym, "EURUSD") >= 0 && StringFind(posSym, "EURUSD") >= 0) ||
                           (StringFind(sym, "GBPJPY") >= 0 && StringFind(posSym, "GBPJPY") >= 0) ||
                           (StringFind(sym, "NAS") >= 0 && StringFind(posSym, "NAS") >= 0) ||
                           (StringFind(sym, "US100") >= 0 && StringFind(posSym, "US100") >= 0));

         if(sameSymbol && posType != requestedType)
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

// Helper para normalizar identificadores (quitar espacios, guiones y mayúsculas)
string NormalizeTag(string s)
{
   string res = "";
   StringToUpper(s);
   int len = StringLen(s);
   for(int i = 0; i < len; i++)
   {
      ushort ch = StringGetCharacter(s, i);
      if(ch != ' ' && ch != '_' && ch != '-')
      {
         res += ShortToString(ch);
      }
   }
   return res;
}

// Detectar si dos tags pertenecen a temporalidades o estrategias en conflicto (ej: M1 vs M2)
bool IsTimeframeConflict(string tag1, string tag2)
{
   string tfs[] = {"M1", "M2", "M3", "M5", "M15", "M30", "H1", "H4"};
   string norm1 = NormalizeTag(tag1);
   string norm2 = NormalizeTag(tag2);
   
   for(int i = 0; i < ArraySize(tfs); i++)
   {
      if(StringFind(norm1, tfs[i]) >= 0)
      {
         for(int j = 0; j < ArraySize(tfs); j++)
         {
            if(i != j && StringFind(norm2, tfs[j]) >= 0)
            {
               // Conflicto directo entre temporalidades distintas (ej: M1 vs M2)
               return true;
            }
         }
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Modificar posicion por canal estricto o proximidad segura        |
//+------------------------------------------------------------------+
void ModifyPositionByProximity(string symbol, double targetEntry, double sl, double tp, string comment = "", string channelId = "")
{
   int total = PositionsTotal();
   ulong bestTicket = 0;
   double minDiff = 999999.0;
   string searchTag = comment != "" ? comment : channelId;
   string normSearch = NormalizeTag(searchTag);
   
   // 1. Paso 1: Búsqueda estricta por coincidencia de Canal / Estrategia
   if(normSearch != "")
   {
      for(int i = 0; i < total; i++)
      {
         ulong t = PositionGetTicket(i);
         if(t > 0 && PositionGetString(POSITION_SYMBOL) == symbol)
         {
            string posComment = PositionGetString(POSITION_COMMENT);
            string normPos = NormalizeTag(posComment);
            
            // Si el tag actual de la posición está en conflicto directo de TF con el buscador, descartar
            if(IsTimeframeConflict(normSearch, normPos))
               continue;

            // Coincidencia exacta o parcial normalizada
            if(StringFind(normPos, normSearch) >= 0 || StringFind(normSearch, normPos) >= 0)
            {
               bestTicket = t;
               minDiff = 0.0;
               break;
            }
         }
      }
      
      // Si se especificó un canal concreto y NO se encontró esa posición,
      // NUNCA debemos alterar otra posición que pertenezca a otro canal/temporalidad.
      if(bestTicket == 0)
      {
         Print("⚠️ [MT5 EA] No se encontro posicion activa para '", searchTag, "'. Modificacion OMITIDA para proteger otras ordenes.");
         return;
      }
   }
   
   // 2. Paso 2: Si no había tag específico de canal, buscar por proximidad de precio pero bloqueando conflictos de TF
   if(bestTicket == 0 && targetEntry > 0)
   {
      for(int i = 0; i < total; i++)
      {
         ulong t = PositionGetTicket(i);
         if(t > 0 && PositionGetString(POSITION_SYMBOL) == symbol)
         {
            string posComment = PositionGetString(POSITION_COMMENT);
            if(searchTag != "" && IsTimeframeConflict(searchTag, posComment))
            {
               continue; // Bloqueo de seguridad: Evitar tocar posiciones de otro timeframe
            }
            
            double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            double diff = MathAbs(openPrice - targetEntry);
            if(diff < minDiff)
            {
               minDiff = diff;
               bestTicket = t;
            }
         }
      }
   }
   
   // Modificar si coincide por comentario o por proximidad razonable (máx 5.0)
   if(bestTicket > 0 && (normSearch != "" || minDiff <= 5.0))
   {
      Print("🎯 [MT5 EA] Modificando posicion: Ticket #", bestTicket, " (Filtro: ", searchTag, " | Dif: ", DoubleToString(minDiff, 2), ")");
      ModifySinglePositionByTicket(bestTicket, sl, tp);
   }
   else
   {
      Print("⚠️ [MT5 EA] No se encontro posicion coincidente con entrada ", targetEntry, " / comentario ", searchTag, ". Modificacion omitida.");
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

   if(actionStr == "EXPORT_HISTORY")
   {
      ExportFullHistory();
      return;
   }

   if(actionStr == "CLOSE_ALL" || actionStr == "CLOSE_ALL_MARKET" || actionStr == "CLOSE_ALL_POSITIONS" || actionStr == "CLOSE_CHANNEL" || actionStr == "CLOSE_SPECIFIC")
   {
      string targetChannel = ExtractJsonString(json, "channelId");
      if(targetChannel == "") targetChannel = ExtractJsonString(json, "comment");

      Print("🚨 [MT5 EA] Comando de CIERRE (", actionStr, ") recibido para ", targetChannel != "" ? targetChannel : (symbol == "" ? "TODOS LOS PARES" : symbol), "...");
      int totalPos = PositionsTotal();
      for(int p = totalPos - 1; p >= 0; p--)
      {
         ulong pTicket = PositionGetTicket(p);
         if(pTicket > 0)
         {
            string posSym = PositionGetString(POSITION_SYMBOL);
            string posComment = PositionGetString(POSITION_COMMENT);
            bool match = false;
            if(actionStr == "CLOSE_CHANNEL" || actionStr == "CLOSE_SPECIFIC")
            {
               if(targetChannel != "" && (StringFind(posComment, targetChannel) >= 0 || StringFind(targetChannel, posComment) >= 0))
                  match = true;
               else if(symbol != "" && posSym == symbol && targetChannel == "")
                  match = true;
            }
            else
            {
               if(symbol == "" || symbol == "ALL" || posSym == symbol)
                  match = true;
            }

            if(match)
            {
               trade.PositionClose(pTicket);
               Print("🛑 [MT5 EA] Posicion #", pTicket, " (", posSym, " - ", posComment, ") cerrada por comando ", actionStr);
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
         int totalPos = PositionsTotal();
         for(int p = totalPos - 1; p >= 0; p--)
         {
            ulong pTicket = PositionGetTicket(p);
            if(pTicket > 0 && PositionGetString(POSITION_SYMBOL) == symbol)
            {
               double op = PositionGetDouble(POSITION_PRICE_OPEN);
               double curTP = PositionGetDouble(POSITION_TP);
               ENUM_POSITION_TYPE pType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
               double bePrice = (pType == POSITION_TYPE_BUY) ? NormalizeDouble(op + InpBEOffsetPips, digits) : NormalizeDouble(op - InpBEOffsetPips, digits);
               trade.PositionModify(pTicket, bePrice, curTP);
               Print("🛡️ [MT5 EA] Posicion #", pTicket, " movida a Break-Even (", bePrice, ") por senal externa.");
            }
         }
      }
      else if(ticket > 0)
      {
         ModifySinglePositionByTicket(ticket, sl, tp);
      }
      else
      {
         double targetEntry = ExtractJsonDouble(json, "entryPrice");
         if(targetEntry <= 0) targetEntry = ExtractJsonDouble(json, "entry");
         string channelId = ExtractJsonString(json, "channelId");
         ModifyPositionByProximity(symbol, targetEntry, sl, tp, comment, channelId);
      }
   }
   else if(actionStr == "BUY_LIMIT")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      Print("⏳ [MT5 EA] Colocando orden pendiente BUY LIMIT en ", symbol, " a ", entryPrice);
      bool res = trade.BuyLimit(volume > 0 ? volume : 0.01, entryPrice, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      if(res) Print("✅ [MT5 EA] Orden pendiente BUY LIMIT colocada con exito en ", symbol);
      else Print("❌ [MT5 EA] Error al colocar BUY LIMIT. Retcode: ", trade.ResultRetcode());
   }
   else if(actionStr == "SELL_LIMIT")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      Print("⏳ [MT5 EA] Colocando orden pendiente SELL LIMIT en ", symbol, " a ", entryPrice);
      bool res = trade.SellLimit(volume > 0 ? volume : 0.01, entryPrice, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      if(res) Print("✅ [MT5 EA] Orden pendiente SELL LIMIT colocada con exito en ", symbol);
      else Print("❌ [MT5 EA] Error al colocar SELL LIMIT. Retcode: ", trade.ResultRetcode());
   }
   else if(actionStr == "BUY_STOP")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      Print("⏳ [MT5 EA] Colocando orden pendiente BUY STOP en ", symbol, " a ", entryPrice);
      bool res = trade.BuyStop(volume > 0 ? volume : 0.01, entryPrice, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      if(res) Print("✅ [MT5 EA] Orden pendiente BUY STOP colocada con exito en ", symbol);
      else Print("❌ [MT5 EA] Error al colocar BUY STOP. Retcode: ", trade.ResultRetcode());
   }
   else if(actionStr == "SELL_STOP")
   {
      double entryPrice = ExtractJsonDouble(json, "entryPrice");
      if(entryPrice <= 0) entryPrice = ExtractJsonDouble(json, "entry");
      Print("⏳ [MT5 EA] Colocando orden pendiente SELL STOP en ", symbol, " a ", entryPrice);
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

      // Garantía anti-quema: Si la orden entrase sin SL o TP, aplicar parámetros de seguridad inmediatos
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0) point = (digits == 5 || digits == 3) ? 0.00001 : 0.01;
      double defaultStopDist = (StringFind(symbol, "XAU") >= 0 || StringFind(symbol, "GOLD") >= 0) ? 3.5 : (300.0 * point);
      double defaultTpDist = (StringFind(symbol, "XAU") >= 0 || StringFind(symbol, "GOLD") >= 0) ? 3.0 : (300.0 * point);
      if(sl <= 0) sl = NormalizeDouble(ask - defaultStopDist, digits);
      if(tp <= 0) tp = NormalizeDouble(ask + defaultTpDist, digits);
      
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

      // Garantía anti-quema: Si la orden entrase sin SL o TP, aplicar parámetros de seguridad inmediatos
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0) point = (digits == 5 || digits == 3) ? 0.00001 : 0.01;
      double defaultStopDist = (StringFind(symbol, "XAU") >= 0 || StringFind(symbol, "GOLD") >= 0) ? 3.5 : (300.0 * point);
      double defaultTpDist = (StringFind(symbol, "XAU") >= 0 || StringFind(symbol, "GOLD") >= 0) ? 3.0 : (300.0 * point);
      if(sl <= 0) sl = NormalizeDouble(bid + defaultStopDist, digits);
      if(tp <= 0) tp = NormalizeDouble(bid - defaultTpDist, digits);

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
void NotifyTradeClosed(ulong dealTicket, ulong posTicket, string sym, double profit, double price, string comment, double pips = 0.0, double volume = 0.01)
{
   string cookie=NULL, headers = "Content-Type: application/json\r\n";
   char post[], result[];
   string result_headers;
   int timeout = 500;
   
   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string company = AccountInfoString(ACCOUNT_COMPANY);
   double liveBal = AccountInfoDouble(ACCOUNT_BALANCE);
   double liveEq = AccountInfoDouble(ACCOUNT_EQUITY);
   
   string payload = StringFormat("{\"account\":\"%I64u\",\"broker\":\"%s\",\"ticket\":%I64u,\"position\":%I64u,\"symbol\":\"%s\",\"profit\":%.2f,\"price\":%.2f,\"outcome\":\"%s\",\"comment\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"pips\":%.1f,\"volume\":%.2f}",
                                 login, company, dealTicket, posTicket, sym, profit, price, (profit >= 0 ? "WIN" : "LOSS"), comment, liveBal, liveEq, pips, volume);
   
   StringToCharArray(payload, post, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(post, ArraySize(post) - 1);
   
   string url = "http://127.0.0.1:3000/trade-closed";
   int res = WebRequest("POST", url, cookie, headers, timeout, post, ArraySize(post), result, result_headers);
   if(res == 200)
   {
      Print("📊 [FEEDBACK LOOP MT5] Notificado cierre de trade #", posTicket, " al AnalyticsEngine (Profit: $", DoubleToString(profit, 2), " | Pips: ", DoubleToString(pips, 1), ")");
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
            double dealVol = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
            double openPrice = 0.0;
            ENUM_DEAL_TYPE inDealType = DEAL_TYPE_BUY;
            
            // Si el dealComment es [tp] o [sl], recuperar el canal del deal de entrada original
            if(posTicket > 0)
            {
               if(HistorySelectByPosition(posTicket))
               {
                  int totalDeals = HistoryDealsTotal();
                  for(int d = 0; d < totalDeals; d++)
                  {
                     ulong dTicket = HistoryDealGetTicket(d);
                     if(dTicket > 0 && (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dTicket, DEAL_ENTRY) == DEAL_ENTRY_IN)
                     {
                        openPrice = HistoryDealGetDouble(dTicket, DEAL_PRICE);
                        inDealType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dTicket, DEAL_TYPE);
                        string origComment = HistoryDealGetString(dTicket, DEAL_COMMENT);
                        if(origComment != "" && (dealComment == "" || StringFind(dealComment, "[") >= 0)) dealComment = origComment;
                        break;
                     }
                  }
               }
            }

            double realPips = 0.0;
            if(openPrice > 0.0)
            {
               if(inDealType == DEAL_TYPE_BUY) realPips = (closePrice - openPrice) * 10.0;
               else realPips = (openPrice - closePrice) * 10.0;
            }
            else if(dealVol > 0.0)
            {
               realPips = profit / (dealVol * 10.0);
            }
            
            NotifyTradeClosed(dealTicket, posTicket, dealSym, profit, closePrice, dealComment, realPips, dealVol);
            ExportFullHistory();
         }
      }
   }
}

