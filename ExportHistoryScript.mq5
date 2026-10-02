//+------------------------------------------------------------------+
//|                                           ExportHistoryScript.mq5 |
//|                    Copyright 2026, Antigravity Trading System    |
//|                        https://github.com/telegram-mtproto      |
//+------------------------------------------------------------------+
#property copyright "Antigravity Trading System"
#property link      "http://127.0.0.1:3000"
#property version   "1.00"
#property script_show_inputs false

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

void OnStart()
{
   ResetLastError();
   if(!HistorySelect(0, TimeCurrent()))
   {
      Print("⚠️ [ExportHistory] Error seleccionando historial: ", GetLastError());
      return;
   }

   long login = AccountInfoInteger(ACCOUNT_LOGIN);
   string company = AccountInfoString(ACCOUNT_COMPANY);
   int totalDeals = HistoryDealsTotal();
   if(totalDeals <= 0)
   {
      Print("ℹ️ [ExportHistory] Cuenta #", login, ": No hay deals en el historial.");
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

   // 1. Exportar fichero de Deals detallados a FILE_COMMON
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

   // 2. Exportar fichero de Posiciones cerradas (Round-Trip) a FILE_COMMON
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

   Print("✅ [ExportHistory] Exportacion completada para Cuenta #", login, " (", count, " deals). Ficheros guardados en Common/Files.");
}
