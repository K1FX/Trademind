export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, trade } = req.body;
  if (!token || !trade) return res.status(400).json({ error: 'Missing token or trade data' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Look up user by token
  const tokenRes = await fetch(
    `${supabaseUrl}/rest/v1/mt_tokens?token=eq.${encodeURIComponent(token)}&select=user_id`,
    { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
  );
  const tokenRows = await tokenRes.json();
  if (!tokenRows || !tokenRows.length) return res.status(401).json({ error: 'Invalid token' });

  const userId = tokenRows[0].user_id;
  const pnl = parseFloat(trade.pnl) || 0;

  const t = {
    user_id: userId,
    date: trade.date || new Date().toISOString().split('T')[0],
    pair: (trade.pair || '').toUpperCase(),
    direction: trade.direction || 'Long',
    lots: parseFloat(trade.lots) || 0,
    pnl: pnl,
    entry: parseFloat(trade.entry) || 0,
    exit: parseFloat(trade.exit) || 0,
    sl: parseFloat(trade.sl) || 0,
    tp: parseFloat(trade.tp) || 0,
    rr: parseFloat(trade.rr) || 0,
    result: pnl > 0 ? 'Win' : pnl < 0 ? 'Loss' : 'Breakeven',
    session: trade.session || '',
    setup: 'MT Auto-Import',
    notes: trade.notes || 'Imported from MetaTrader',
    screenshot: null
  };

  if (!t.pair) return res.status(400).json({ error: 'Missing symbol/pair' });

  const insertRes = await fetch(`${supabaseUrl}/rest/v1/trades`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(t)
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    return res.status(500).json({ error: err });
  }

  return res.status(200).json({ success: true, pair: t.pair, pnl: t.pnl });
}
