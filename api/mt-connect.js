export const config = { maxDuration: 60 };

const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const PROVISION_URL = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts';
const METASTATS_URL = 'https://metastats-api-v1.london.agiliumtrade.ai/users/current/accounts';
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  'Content-Type': 'application/json',
  'auth-token': METAAPI_TOKEN
};

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function getAccountStatus(id){
  const r = await fetch(`${PROVISION_URL}/${id}`, { headers });
  return r.json();
}

async function waitDeployed(id, maxWait = 50000){
  const start = Date.now();
  while(Date.now() - start < maxWait){
    const acc = await getAccountStatus(id);
    if(acc.state === 'DEPLOYED' && acc.connectionStatus === 'CONNECTED') return true;
    if(acc.state === 'ERROR') return false;
    await sleep(3000);
  }
  return false;
}

async function undeploy(id){
  await fetch(`${PROVISION_URL}/${id}/undeploy`, { method: 'POST', headers });
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).end();

  const { login, password, server, platform, userId } = req.body;
  if(!login || !password || !server || !userId)
    return res.status(400).json({ error: 'Missing fields' });

  try {
    // Check if account already exists for this user
    let accountId = null;
    const listRes = await fetch(PROVISION_URL, { headers });
    const accounts = await listRes.json();
    const existing = Array.isArray(accounts) && accounts.find(a => a.login == login && a.server === server);

    if(existing){
      accountId = existing._id || existing.id;
      // Redeploy if needed
      if(existing.state !== 'DEPLOYED'){
        await fetch(`${PROVISION_URL}/${accountId}/deploy`, { method: 'POST', headers });
      }
    } else {
      // Create new account
      const createRes = await fetch(PROVISION_URL, {
        method: 'POST',
        headers,
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
        return res.status(400).json({ error: created.message || 'Failed to create account' });
      accountId = created.id || created._id;
    }

    // Wait for connection
    const connected = await waitDeployed(accountId);
    if(!connected){
      await undeploy(accountId);
      return res.status(408).json({ error: 'Connection timed out. Check your login, password and server name.' });
    }

    // Fetch trade history from MetaStats
    const tradesRes = await fetch(
      `${METASTATS_URL}/${accountId}/historical-trades/0/1000`,
      { headers }
    );
    const tradesData = await tradesRes.json();
    const mtTrades = tradesData.trades || [];

    // Undeploy to save costs
    await undeploy(accountId);

    if(!mtTrades.length)
      return res.status(200).json({ imported: 0, message: 'Connected but no trades found.' });

    // Import trades into Supabase
    let imported = 0;
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
        notes: `Imported from MetaTrader (${server})`,
        screenshot: null
      });
    }

    // Insert in batches of 50
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

    return res.status(200).json({ imported, total: toInsert.length });

  } catch(e){
    return res.status(500).json({ error: e.message });
  }
}
