const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const PROVISION_URL = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts';
const METASTATS_URL = 'https://metastats-api-v1.london.agiliumtrade.ai/users/current/accounts';
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
    if(!login || !password || !server || !userId)
      return res.status(400).json({ error: 'Missing fields' });

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

    // Create new account
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

  // ── STEP 3: fetch trades & import ───────────────────────────────
  if(action === 'import'){
    if(!accountId || !userId) return res.status(400).json({ error: 'Missing fields' });

    const startTime = fromDate ? new Date(fromDate).toISOString() : new Date(Date.now() - 365*24*60*60*1000).toISOString();
    const endTime   = toDate   ? new Date(toDate + 'T23:59:59').toISOString() : new Date().toISOString();
    const tradesRes = await fetch(`${METASTATS_URL}/${accountId}/historical-trades/${encodeURIComponent(startTime)}/${encodeURIComponent(endTime)}`, { headers: apiHeaders });
    const tradesData = await tradesRes.json();
    const mtTrades = tradesData.trades || [];

    // Undeploy to save costs
    await fetch(`${PROVISION_URL}/${accountId}/undeploy`, { method: 'POST', headers: apiHeaders });

    if(!mtTrades.length)
      return res.status(200).json({ imported: 0, found: 0 });

    const toInsert = [];
    for(const t of mtTrades){
      if(t.type !== 'DEAL_TYPE_BUY' && t.type !== 'DEAL_TYPE_SELL') continue;
      if(t.entryType !== 'DEAL_ENTRY_OUT' && t.entryType !== 'DEAL_ENTRY_INOUT') continue;
      if(!t.symbol) continue;
      const pnl = parseFloat(t.profit) || 0;
      toInsert.push({
        user_id: userId,
        date: t.time ? t.time.split('T')[0] : new Date().toISOString().split('T')[0],
        pair: t.symbol.toUpperCase(),
        direction: t.type === 'DEAL_TYPE_SELL' ? 'Long' : 'Short',
        lots: parseFloat(t.volume) || 0,
        pnl,
        entry: parseFloat(t.openPrice) || 0,
        exit: parseFloat(t.closePrice) || parseFloat(t.price) || 0,
        sl: 0, tp: 0, rr: 0,
        result: pnl > 0 ? 'Win' : pnl < 0 ? 'Loss' : 'Breakeven',
        session: '',
        setup: 'MT Auto-Import',
        notes: 'Imported from MetaTrader',
        screenshot: null
      });
    }

    let imported = 0;
    for(let i = 0; i < toInsert.length; i += 50){
      const batch = toInsert.slice(i, i + 50);
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/trades`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(batch)
      });
      if(insRes.ok) imported += batch.length;
    }

    return res.status(200).json({ imported, found: toInsert.length });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
