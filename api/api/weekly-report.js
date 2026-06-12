const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

export default async function handler(req, res) {
  // Allow POST from cron or with secret
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();
  const auth = req.headers['authorization'] || '';
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });

  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - 7);
  const fromDate = monday.toISOString().split('T')[0];
  const toDate   = now.toISOString().split('T')[0];

  try {
    // Get all elite subscribers
    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?plan=eq.elite&status=eq.active&select=user_id,email`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const subs = await subRes.json();
    if (!subs || !subs.length) return res.status(200).json({ sent: 0 });

    let sent = 0;
    for (const sub of subs) {
      try {
        // Get trades for past week
        const tRes = await fetch(
          `${SUPABASE_URL}/rest/v1/trades?user_id=eq.${sub.user_id}&date=gte.${fromDate}&date=lte.${toDate}&select=*`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const trades = await tRes.json();

        const total = trades.length;
        const wins  = trades.filter(t => t.result === 'Win').length;
        const losses = trades.filter(t => t.result === 'Loss').length;
        const pnl   = trades.reduce((s, t) => s + (t.pnl || 0), 0);
        const wr    = total ? Math.round(wins / total * 100) : 0;
        const bestTrade = trades.reduce((b, t) => (t.pnl > (b?.pnl || -Infinity) ? t : b), null);
        const worstTrade = trades.reduce((b, t) => (t.pnl < (b?.pnl || Infinity) ? t : b), null);

        const pnlColor = pnl >= 0 ? '#22c55e' : '#ef4444';
        const pnlSign  = pnl >= 0 ? '+' : '';

        const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Segoe UI',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:28px">
    <span style="font-size:22px">📈</span>
    <span style="font-size:18px;font-weight:700;color:#fff">TradeMind</span>
    <span style="font-size:11px;color:#6b7280;margin-left:4px">Weekly Report</span>
  </div>
  <h2 style="color:#fff;font-size:20px;margin:0 0 4px">Your Week in Review</h2>
  <p style="color:#6b7280;font-size:12px;margin:0 0 24px">${fromDate} → ${toDate}</p>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
    <div style="background:#1a1d27;border-radius:10px;padding:16px">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:6px">Total P&L</div>
      <div style="font-size:24px;font-weight:700;color:${pnlColor}">${pnlSign}$${Math.abs(pnl).toFixed(2)}</div>
    </div>
    <div style="background:#1a1d27;border-radius:10px;padding:16px">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:6px">Win Rate</div>
      <div style="font-size:24px;font-weight:700;color:#fff">${wr}%</div>
    </div>
    <div style="background:#1a1d27;border-radius:10px;padding:16px">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:6px">Trades</div>
      <div style="font-size:24px;font-weight:700;color:#fff">${total}</div>
      <div style="font-size:10px;color:#6b7280;margin-top:4px">${wins}W / ${losses}L</div>
    </div>
    <div style="background:#1a1d27;border-radius:10px;padding:16px">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:6px">Avg per trade</div>
      <div style="font-size:24px;font-weight:700;color:${total ? pnlColor : '#fff'}">${total ? (pnlSign + '$' + Math.abs(pnl / total).toFixed(2)) : '-'}</div>
    </div>
  </div>

  ${bestTrade ? `
  <div style="background:#1a1d27;border-radius:10px;padding:16px;margin-bottom:12px">
    <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:8px">Best Trade</div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><span style="color:#fff;font-weight:600">${bestTrade.pair}</span> <span style="color:#6b7280;font-size:11px">${bestTrade.direction} · ${bestTrade.date}</span></div>
      <div style="color:#22c55e;font-weight:700">+$${bestTrade.pnl.toFixed(2)}</div>
    </div>
  </div>` : ''}

  ${worstTrade && worstTrade.pnl < 0 ? `
  <div style="background:#1a1d27;border-radius:10px;padding:16px;margin-bottom:24px">
    <div style="font-size:10px;color:#6b7280;text-transform:uppercase;margin-bottom:8px">Worst Trade</div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><span style="color:#fff;font-weight:600">${worstTrade.pair}</span> <span style="color:#6b7280;font-size:11px">${worstTrade.direction} · ${worstTrade.date}</span></div>
      <div style="color:#ef4444;font-weight:700">-$${Math.abs(worstTrade.pnl).toFixed(2)}</div>
    </div>
  </div>` : '<div style="margin-bottom:24px"></div>'}

  <a href="https://trademind-nine.vercel.app" style="display:block;text-align:center;background:#22c55e;color:#000;font-weight:700;padding:14px;border-radius:10px;text-decoration:none;font-size:14px">Open TradeMind →</a>

  <p style="color:#374151;font-size:10px;text-align:center;margin-top:24px">TradeMind Elite · <a href="https://trademind-nine.vercel.app" style="color:#374151">Unsubscribe</a></p>
</div>
</body></html>`;

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({
            from: 'TradeMind <support@trademind.ai>',
            to: [sub.email],
            subject: `📈 Your Week: ${pnlSign}$${Math.abs(pnl).toFixed(2)} P&L · ${wr}% Win Rate`,
            html
          })
        });
        sent++;
      } catch(e) { /* skip this user */ }
    }
    return res.status(200).json({ sent });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
