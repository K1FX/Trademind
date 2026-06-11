const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const PROVISION_URL = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts';
const HISTORY_REGIONS = ['london','new-york','singapore','sydney','johannesburg'];
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const apiHeaders = {
  'Content-Type': 'application/json',
  'auth-token': METAAPI_TOKEN
};

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).end();

  const { action, login, password, server, platform, accountId, userId, fromDate, toDate } = req.body;

  // ── STEP 1: find or create account ──────────────────────────────
  if(action === 'create'){
    if(!userId)
      return res.status(400).json({ error: 'Missing userId' });

    // Check if accountId already saved in Supabase for this user
    const savedRes = await fetch(
      `${SUPABASE_URL}/rest/v1/mt_tokens?user_id=eq.${userId}&select=mt_account_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const savedRows = await savedRes.json();
    if(savedRows && savedRows[0] && savedRows[0].mt_account_id){
      const savedId = savedRows[0].mt_account_id;
      const accRes = await fetch(`${PROVISION_URL}/${savedId}`, { headers: apiHeaders });
      const acc = await accRes.json();
      const stateUp = (acc.state||'').toUpperCase();
      const connUp  = (acc.connectionStatus||'').toUpperCase();
      const ready   = stateUp === 'DEPLOYED' || connUp.includes('CONNECTED');
      if(!ready) await fetch(`${PROVISION_URL}/${savedId}/deploy`, { method: 'POST', headers: apiHeaders });
      return res.status(200).json({ accountId: savedId, existing: true, ready });
    }

    // Create new account — requires credentials
    if(!login || !password || !server)
      return res.status(400).json({ error: 'Missing fields' });

    const createRes = await fetch(PROVISION_URL, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        login: String(login),
        password,
        name: 'TradeMind-' + login,
        server,
        platform: platform || 'mt5',
        magic: 0,
        application: 'MetaApi',
        type: 'cloud-g2'
      })
    });
    const created = await createRes.json();
    if(!created.id && !created._id)
      return res.status(400).json({ error: created.message || JSON.stringify(created) });

    const newId = created.id || created._id;

    // Save accountId to Supabase for future use
    await fetch(`${SUPABASE_URL}/rest/v1/mt_tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ user_id: userId, token: 'mt-'+userId, mt_account_id: newId })
    });

    return res.status(200).json({ accountId: newId, ready: false });
  }

  // ── STEP 2: check connection status ─────────────────────────────
  if(action === 'status'){
    if(!accountId) return res.status(400).json({ error: 'Missing accountId' });
    const r = await fetch(`${PROVISION_URL}/${accountId}`, { headers: apiHeaders });
    const acc = await r.json();
    const stateUp = (acc.state||'').toUpperCase();
    const connUp  = (acc.connectionStatus||'').toUpperCase();
    const ready   = stateUp === 'DEPLOYED' || connUp.includes('CONNECTED');
    return res.status(200).json({
      state: acc.state,
      connectionStatus: acc.connectionStatus,
      ready
    });
  }

  // ── STEP 3: fetch trades from MetaStats, return to client ───────
  if(action === 'import'){
    if(!accountId || !userId) return res.status(400).json({ error: 'Missing fields' });

    // Get account region from provisioning API
    const accRes = await fetch(`${PROVISION_URL}/${accountId}`, { headers: apiHeaders });
    const accData = await accRes.json();
    const region = accData.region || accData.server?.region || 'london';

    // Use MetaAPI Trading History API (reads directly from MT5, no sync delay)
    const startTime = fromDate ? new Date(fromDate).toISOString() : new Date(Date.now() - 365*24*60*60*1000).toISOString();
    const endTime   = toDate   ? new Date(toDate + 'T23:59:59').toISOString() : new Date().toISOString();
    const historyUrl = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time/${encodeURIComponent(startTime)}/${encodeURIComponent(endTime)}`;
    const tradesRes = await fetch(historyUrl, { headers: apiHeaders });
    const tradesData = await tradesRes.json();
    const mtTrades = Array.isArray(tradesData) ? tradesData : (tradesData.deals || tradesData.items || []);

    // Undeploy to save costs
    await fetch(`${PROVISION_URL}/${accountId}/undeploy`, { method: 'POST', headers: apiHeaders });

    if(!mtTrades.length)
      return res.status(200).json({ trades: [], found: 0, rawCount: 0, debug: { region, url: historyUrl, sample: tradesData } });

    // Map to TradeMind format and return to client for direct Supabase insert
    const toInsert = [];
    for(const t of mtTrades){
      // Support both MetaStats format and Trading History API format
      const dealType   = t.type || t.dealType || '';
      const entryType  = t.entryType || t.entry || '';
      const symbol     = t.symbol || t.s || '';
      if(!symbol) continue;
      // Skip non-closing deals
      const typeUpper  = dealType.toUpperCase();
      const entryUpper = entryType.toUpperCase();
      if(typeUpper.includes('BALANCE') || typeUpper.includes('CREDIT') || typeUpper.includes('COMMISSION')) continue;
      if(entryUpper && !entryUpper.includes('OUT') && !entryUpper.includes('INOUT')) continue;
      const pnl = parseFloat(t.profit) || 0;
      const timeVal = t.time || t.brokerTime || t.doneTime || '';
      toInsert.push({
        user_id: userId,
        date: timeVal ? timeVal.split('T')[0] : new Date().toISOString().split('T')[0],
        pair: symbol.toUpperCase(),
        direction: typeUpper.includes('SELL') ? 'Long' : 'Short',
        lots: parseFloat(t.volume) || parseFloat(t.lots) || 0,
        pnl,
        entry: parseFloat(t.openPrice) || parseFloat(t.entryPrice) || 0,
        exit: parseFloat(t.closePrice) || parseFloat(t.price) || 0,
        sl: 0, tp: 0, rr: 0,
        result: pnl > 0 ? 'Win' : pnl < 0 ? 'Loss' : 'Breakeven',
        session: '',
        setup: 'MT Auto-Import',
        notes: 'Imported from MetaTrader',
        screenshot: null
      });
    }

    return res.status(200).json({ trades: toInsert, found: toInsert.length, rawCount: mtTrades.length });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
