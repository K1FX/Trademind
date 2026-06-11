//+------------------------------------------------------------------+
//|                                               TradeMindEA.mq5    |
//|                              Auto-import trades to TradeMind.ai  |
//+------------------------------------------------------------------+
#property copyright "TradeMind.ai"
#property version   "1.00"
#property description "Automatically sends closed trades to your TradeMind journal."

// ——— Configure these two fields in EA settings ———
input string WebhookURL = "https://trademind-nine.vercel.app/api/mt-import";
input string Token      = "PASTE_YOUR_TOKEN_HERE";

//+------------------------------------------------------------------+
void OnInit() {
   Print("TradeMind EA v1.0 started. Trades will be sent to TradeMind.ai");
}

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest     &request,
                        const MqlTradeResult      &result) {

   // Only process when a new deal is added
   if (trans.type != TRADE_TRANSACTION_DEAL_ADD) return;

   ulong ticket = trans.deal;
   if (!HistoryDealSelect(ticket)) return;

   // Only closing deals
   long dealEntry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
   if (dealEntry != DEAL_ENTRY_OUT && dealEntry != DEAL_ENTRY_INOUT) return;

   long   dealType = HistoryDealGetInteger(ticket, DEAL_TYPE);
   string symbol   = HistoryDealGetString(ticket,  DEAL_SYMBOL);
   double lots     = HistoryDealGetDouble(ticket,  DEAL_VOLUME);
   double pnl      = HistoryDealGetDouble(ticket,  DEAL_PROFIT);
   double price    = HistoryDealGetDouble(ticket,  DEAL_PRICE);
   datetime time   = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);

   // DEAL_TYPE_SELL closing = was Long; DEAL_TYPE_BUY closing = was Short
   string dir = (dealType == DEAL_TYPE_SELL) ? "Long" : "Short";
   string res = (pnl > 0) ? "Win" : (pnl < 0 ? "Loss" : "Breakeven");

   // Format date as YYYY-MM-DD
   MqlDateTime dt;
   TimeToStruct(time, dt);
   string dateStr = StringFormat("%04d-%02d-%02d", dt.year, dt.mon, dt.day);

   // Build JSON payload
   string json = StringFormat(
      "{\"token\":\"%s\",\"trade\":{\"pair\":\"%s\",\"direction\":\"%s\","
      "\"lots\":%.2f,\"pnl\":%.2f,\"exit\":%.5f,\"date\":\"%s\","
      "\"result\":\"%s\",\"notes\":\"Auto-imported from MetaTrader\"}}",
      Token, symbol, dir, lots, pnl, price, dateStr, res
   );

   // Send HTTP POST
   char  post[];
   char  response[];
   string respHeaders;
   StringToCharArray(json, post, 0, StringLen(json));

   string headers = "Content-Type: application/json\r\n";
   int httpCode = WebRequest("POST", WebhookURL, headers, 5000, post, response, respHeaders);

   if (httpCode == 200) {
      Print("TradeMind ✓  Imported: ", symbol, "  P&L: ", pnl);
   } else {
      Print("TradeMind ✗  Import failed. HTTP: ", httpCode, "  Error: ", GetLastError());
      Print("             Make sure '", WebhookURL, "' is in Tools > Options > Expert Advisors > Allow WebRequest");
   }
}
