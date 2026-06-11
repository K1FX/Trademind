const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const PROVISION_URL = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts';
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const h = { 'Content-Type': 'application/json', 'auth-token': METAAPI_TOKEN };

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).end();

  const { action, login, password, server, platform, accountId, userId, fromDate, toDate } = req.body || {};

  // ── CREATE ──────────────────────────────────────────────────────────
  if(action === 'create'){
    if(accountId) return res.status(200).json({ accountId, existing: true, ready: false });
    if(!login || !password || !server || !userId)
      return res.status(400).json({ error: 'Missing fields' });
    try {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/mt_tokens?user_id=eq.${userId}&select=mt_account_id`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await sbRes.json();
      if(rows && rows[0] && rows[0].mt_account_id)
        return res.status(200).json({ accountId: rows[0].mt_account_id, existing: true, ready: false });
      const cr = await fetch(PROVISION_URL, {
        method: 'POST', headers: h,
        body: JSON.stringify({ login: String(login), password, name: 'TradeMind-'+login, server, platform: platform||'mt5', magic: 0, application: 'MetaApi', type: 'cloud-g2' })
      });
      const acc = await cr.json();
      if(!acc.id && !acc._id) return res.status(400).json({ error: acc.message || JSON.stringify(acc) });
      const newId = acc.id || acc._id;
      await fetch(`${SUPABASE_URL}/rest/v1/mt_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ user_id: userId, token: 'mt-'+userId, mt_account_id: newId })
      });
      return res.status(200).json({ accountId: newId, ready: false });
    } catch(e){ return res.status(200).json({ error: 'create failed: ' + e.message }); }
  }

  // ── STATUS ──────────────────────────────────────────────────────────
  if(action === 'status'){
    if(!accountId) return res.status(400).json({ error: 'Missing accountId' });
    try {
      const r = await fetch(`${PROVISION_URL}/${accountId}`, { headers: h });
      const acc = await r.json();
      const state = (acc.state||'').toUpperCase();
      const conn  = (acc.connectionStatus||'').toUpperCase();
      const ready = state === 'DEPLOYED' || conn.includes('CONNECTED');
      if(!ready && state !== 'DEPLOYING')
        await fetch(`${PROVISION_URL}/${accountId}/deploy`, { method: 'POST', headers: h });
      return res.status(200).json({ state: acc.state, connectionStatus: acc.connectionStatus, ready });
    } catch(e){ return res.status(200).json({ error: 'status failed: ' + e.message, ready: false }); }
  }

  // ── IMPORT ──────────────────────────────────────────────────────────
  if(action === 'import'){
    if(!accountId || !userId) return res.status(400).json({ error: 'Missing fields' });
    try {
      const startIso = fromDate ? new Date(fromDate).toISOString() : '2018-01-01T00:00:00.000Z';
      const endIso   = toDate   ? new Date(toDate + 'T23:59:59').toISOString() : new Date().toISOString();

      const accR   = await fetch(`${PROVISION_URL}/${accountId}`, { headers: h });
      const accInfo = await accR.json();
      const region  = (accInfo.region||'london').toLowerCase().replace(/\s/g,'-');

      const apis = [
        { base: `https://mt-client-api-v1.${region}.agiliumtrade.ai`,    path: (id,s,e) => `/users/current/accounts/${id}/history-deals/time/${encodeURIComponent(s)}/${encodeURIComponent(e)}`, key: null },
        { base: `https://metastats-api-v1.${region}.agiliumtrade.ai`,    path: (id,s,e) => `/users/current/accounts/${id}/historical-trades/${encodeURIComponent(s)}/${encodeURIComponent(e)}`, key: 'trades' },
      ];

      let raw = [];
      const errs = [];
      for(const api of apis){
        try {
          const url = api.base + api.path(accountId, startIso, endIso);
          const r   = await fetch(url, { headers: h });
          const txt = await r.text();
          if(r.status >= 400){ errs.push(r.status+':'+txt.slice(0,150)); continue; }
          const data = JSON.parse(txt);
          const arr  = api.key ? (data[api.key]||[]) : (Array.isArray(data) ? data : (data.deals||[]));
          if(arr.length){ raw = arr; break; }
          errs.push('empty:'+txt.slice(0,100));
        } catch(e){ errs.push('DNS:'+e.message.slice(0,80)); }
      }

      if(!raw.length) return res.status(200).json({ error: `region=${region} | `+errs.join(' || '), trades: [] });

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
          user_id: userId, date,
          pair: t.symbol.toUpperCase(),
          direction: typeUp.includes('SELL') ? 'Short' : 'Long',
          lots: parseFloat(t.volume)||0, pnl,
          entry: parseFloat(t.openPrice)||0,
          exit:  parseFloat(t.closePrice)||parseFloat(t.price)||0,
          sl:0, tp:0, rr:0,
          result: pnl>0?'Win':pnl<0?'Loss':'Breakeven',
          session:'', setup:'MT Auto-Import',
          notes:'Imported from MetaTrader', screenshot:null
        });
      }
      return res.status(200).json({ trades, found: trades.length, rawCount: raw.length });
    } catch(e){ return res.status(200).json({ error: 'import failed: ' + e.message, trades: [] }); }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
