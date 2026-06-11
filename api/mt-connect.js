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

  const { action, login, password, server, platform, accountId, userId } = req.body;

  // ── STEP 1: create or find account ──────────────────────────────
  if(action === 'create'){
    if(!login || !password || !server || !userId)
      return res.status(400).json({ error: 'Missing fields' });

    // Check if already exists
    const listRes = await fetch(PROVISION_URL, { headers: apiHeaders });
    const accounts = await listRes.json();
    const existing = Array.isArray(accounts) && accounts.find(a => String(a.login) === String(login) && a.server === server);

    if(existing){
      const id = existing._id || existing.id;
      // Redeploy if needed
      if(existing.state !== 'DEPLOYED'){
        await fetch(`${PROVISION_URL}/${id}/deploy`, { method: 'POST', headers: apiHeaders });
      }
      return res.status(200).json({ accountId: id, existing: true });
    }

    // Create new
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

    return res.status(200).json({ accountId: created.id || created._id });
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

    const tradesRes = await fetch(`${METASTATS_URL}/${accountId}/historical-trades/0/1000`, { headers: apiHeaders });
    const tradesData = await tradesRes.json();
    const mtTrades = tradesData.trades || [];

    // Undeploy to save costs
    await fetch(`${PROVISION_URL}/${accountId}/undeploy`, { method: 'POST', headers: apiHeaders });

    if(!mtTrades.length)
      return res.status(200).json({ imported: 0 });

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

    return res.status(200).json({ imported });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
