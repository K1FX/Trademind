const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const h = { 'Content-Type': 'application/json', 'auth-token': METAAPI_TOKEN };

const ALLOWED_ORIGINS = ['https://trademind-nine.vercel.app', 'https://trademind.dev'];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

const PROV_BASES = [
  'https://mt-provisioning-api-v1.new-york.agiliumtrade.ai/users/current/accounts',
  'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts',
];

async function provFetch(path, opts){
  let lastErr;
  for(const base of PROV_BASES){
    try {
      const r = await fetch(base + path, { ...opts, headers: h });
      return r;
    } catch(e){ lastErr = e; }
  }
  throw lastErr;
}

async function provJson(path){
  const r = await provFetch(path, {});
  return r.json();
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload.sub) return null;
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return { id: payload.sub };
  } catch { return null; }
}

export default async function handler(req, res){
  const origin = req.headers['origin'] || '';
  const cors = corsHeaders(origin);
  Object.entries(cors).forEach(([k,v]) => res.setHeader(k, v));

  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).end();

  // Verify auth token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  const authUser = await verifyToken(token);
  if (!authUser || !authUser.id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, login, password, server, platform, accountId, userId, fromDate, toDate, region: regionHint } = req.body || {};

  // Ensure the userId in the request matches the authenticated user
  if (userId && userId !== authUser.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Use the authenticated user's id as the canonical userId
  const canonicalUserId = authUser.id;

  // ── RESET ────────────────────────────────────────────────────────────
  if(action === 'reset'){
    try {
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/mt_tokens?user_id=eq.${canonicalUserId}&select=mt_account_id`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      const rows = await sbRes.json();
      if(rows && rows[0] && rows[0].mt_account_id){
        const id = rows[0].mt_account_id;
        provFetch('/'+id+'/undeploy', { method: 'POST' }).catch(()=>{});
        provFetch('/'+id, { method: 'DELETE' }).catch(()=>{});
        await fetch(`${SUPABASE_URL}/rest/v1/mt_tokens?user_id=eq.${canonicalUserId}`, { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      }
      await fetch(`${SUPABASE_URL}/rest/v1/trades?user_id=eq.${canonicalUserId}&setup=ilike.%25MT%20Auto-Import%25`, { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      return res.status(200).json({ ok: true });
    } catch(e){ return res.status(200).json({ ok: true }); }
  }

  // ── CREATE ──────────────────────────────────────────────────────────
  if(action === 'create'){
    if(accountId) return res.status(200).json({ accountId, existing: true, ready: false });
    if(!login || !password || !server)
      return res.status(400).json({ error: 'Missing fields' });
    try {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/mt_tokens?user_id=eq.${canonicalUserId}&select=mt_account_id`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await sbRes.json();
      if(rows && rows[0] && rows[0].mt_account_id)
        return res.status(200).json({ accountId: rows[0].mt_account_id, existing: true, ready: false });

      let acc, lastErr;
      for(let attempt=0; attempt<3; attempt++){
        try {
          if(attempt>0) await new Promise(r=>setTimeout(r,3000));
          const r = await provFetch('', {
            method: 'POST',
            body: JSON.stringify({ login: String(login), password, name: 'TradeMind-'+login, server, platform: platform||'mt5', magic: 0, application: 'MetaApi', type: 'cloud-g2', reliability: 'regular' })
          });
          acc = await r.json();
          if(acc.id || acc._id) break;
          lastErr = acc.message || JSON.stringify(acc);
        } catch(e){ lastErr = e.message; }
      }
      if(!acc || (!acc.id && !acc._id)) return res.status(400).json({ error: lastErr || 'MetaAPI unreachable' });
      const newId = acc.id || acc._id;
      await fetch(`${SUPABASE_URL}/rest/v1/mt_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: canonicalUserId, token: 'mt-'+canonicalUserId, mt_account_id: newId })
      });
      return res.status(200).json({ accountId: newId, ready: false });
    } catch(e){ return res.status(200).json({ error: 'create failed: ' + e.message }); }
  }

  // ── UNDEPLOY ─────────────────────────────────────────────────────────
  if(action === 'undeploy'){
    if(!accountId) return res.status(200).json({ ok: true });
    provFetch('/'+accountId+'/undeploy', { method: 'POST' }).catch(()=>{});
    return res.status(200).json({ ok: true });
  }

  // ── STATUS ──────────────────────────────────────────────────────────
  if(action === 'status'){
    if(!accountId) return res.status(400).json({ error: 'Missing accountId' });
    const region = regionHint || 'london';

    let state = '', conn = '', ready = false;
    try {
      const acc = await provJson('/'+accountId);
      state = (acc.state||'').toUpperCase();
      conn  = (acc.connectionStatus||'').toUpperCase();
      ready = conn === 'CONNECTED';
      if(state !== 'DEPLOYED' && state !== 'DEPLOYING')
        provFetch('/'+accountId+'/deploy', { method: 'POST' }).catch(()=>{});
      return res.status(200).json({ state: acc.state, connectionStatus: acc.connectionStatus, ready });
    } catch(e){}

    for(const base of PROV_BASES){
      try { await fetch(base+'/'+accountId+'/deploy', { method: 'POST', headers: h }); break; } catch(e){}
    }
    try {
      const regions = [region, 'london', 'new-york', 'frankfurt'];
      for(const r of regions){
        try {
          const url = `https://mt-client-api-v1.${r}.agiliumtrade.ai/users/current/accounts/${accountId}/accountInformation`;
          const resp = await fetch(url, { headers: h });
          if(resp.status === 200){
            return res.status(200).json({ state: 'DEPLOYED', connectionStatus: 'CONNECTED', ready: true });
          }
        } catch(e){}
      }
    } catch(e){}

    return res.status(200).json({ state: state||'DEPLOYING', connectionStatus: conn||'DISCONNECTED', ready: false });
  }

  // ── IMPORT ──────────────────────────────────────────────────────────
  if(action === 'import'){
    if(!accountId) return res.status(400).json({ error: 'Missing fields' });
    try {
      const startIso = fromDate ? new Date(fromDate).toISOString() : '2018-01-01T00:00:00.000Z';
      const endIso   = toDate   ? new Date(toDate + 'T23:59:59').toISOString() : new Date().toISOString();

      let region = regionHint || 'london';
      try {
        const accInfo = await provJson('/'+accountId);
        if(accInfo.region) region = accInfo.region.toLowerCase().replace(/\s/g,'-');
      } catch(e){}

      const regions = [region, 'london', 'new-york', 'frankfurt'].filter((v,i,a)=>a.indexOf(v)===i);
      const apis = [];
      for(const r of regions){
        apis.push({ base: `https://mt-client-api-v1.${r}.agiliumtrade.ai`,  path: (id,s,e) => `/users/current/accounts/${id}/history-deals/time/${encodeURIComponent(s)}/${encodeURIComponent(e)}`, key: null });
        apis.push({ base: `https://metastats-api-v1.${r}.agiliumtrade.ai`,  path: (id,s,e) => `/users/current/accounts/${id}/historical-trades/${encodeURIComponent(s)}/${encodeURIComponent(e)}`, key: 'trades' });
      }

      let raw = [];
      const errs = [];
      for(const api of apis){
        try {
          const url = api.base + api.path(accountId, startIso, endIso);
          const r   = await fetch(url, { headers: h });
          const txt = await r.text();
          if(r.status >= 400){ errs.push(r.status+':'+txt.slice(0,80)); continue; }
          const data = JSON.parse(txt);
          const arr  = api.key ? (data[api.key]||[]) : (Array.isArray(data) ? data : (data.deals||[]));
          if(arr.length){ raw = arr; break; }
          errs.push('empty');
        } catch(e){
          errs.push(e.message.slice(0,50));
        }
        if(raw.length) break;
      }

      if(!raw.length) return res.status(200).json({ error: errs.join(' | '), trades: [] });

      const fromD = fromDate ? new Date(fromDate) : null;
      const toD   = toDate   ? new Date(toDate + 'T23:59:59') : null;
      const trades = [];
      for(const t of raw){
        const typeUp  = (t.type||'').toUpperCase();
        const entryUp = (t.entryType||'').toUpperCase();
        if(!t.symbol) continue;
        if(typeUp.includes('BALANCE')||typeUp.includes('CREDIT')||typeUp.includes('COMMISSION')) continue;
        if(entryUp && !entryUp.includes('OUT') && !entryUp.includes('INOUT')) continue;
        const rawTime = t.time || t.brokerTime || t.closeTime || t.doneTime || t.openTime;
        const date = rawTime ? String(rawTime).split('T')[0] : new Date().toISOString().split('T')[0];
        if(fromD && new Date(date) < fromD) continue;
        if(toD   && new Date(date) > toD)   continue;
        const pnl = parseFloat(t.profit)||0;
        trades.push({
          user_id: canonicalUserId, date,
          pair: t.symbol.toUpperCase(),
          direction: typeUp.includes('SELL') ? 'Short' : 'Long',
          lots: parseFloat(t.volume)||0, pnl,
          entry: parseFloat(t.openPrice)||0,
          exit:  parseFloat(t.closePrice)||parseFloat(t.price)||0,
          sl:0, tp:0, rr:0,
          result: pnl>0?'Win':pnl<0?'Loss':'Breakeven',
          session:'', setup:'MT Auto-Import'+(login?'·'+login:''),
          notes:'Imported from MetaTrader', screenshot:null
        });
      }
      return res.status(200).json({ trades, found: trades.length, rawCount: raw.length });
    } catch(e){ return res.status(200).json({ error: 'import failed: ' + e.message, trades: [] }); }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
