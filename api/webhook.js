export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  try {
    // Get raw body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    
    // Verify signature manually (no stripe library needed)
    const crypto = require('crypto');
    const elements = sig.split(',');
    let timestamp, v1sig;
    for (const el of elements) {
      const [k, v] = el.split('=');
      if (k === 't') timestamp = v;
      if (k === 'v1') v1sig = v;
    }
    const payload = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
    if (expected !== v1sig) return res.status(400).json({ error: 'Invalid signature' });

    event = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  async function upsertSubscription(data) {
    const response = await fetch(`${supabaseUrl}/rest/v1/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(data)
    });
    return response.json();
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_email || session.customer_details?.email;
        
        // Get user from Supabase by email
        const userRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        const users = await userRes.json();
        const user = users.users?.find(u => u.email === email);
        
        // Determine plan from amount
        const amount = session.amount_total;
        let plan = 'pro';
        if (amount >= 4900) plan = 'elite';

        await upsertSubscription({
          user_id: user?.id || null,
          email: email,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          plan: plan,
          status: 'active',
          updated_at: new Date().toISOString()
        });

        // Send confirmation email via Resend
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
          },
          body: JSON.stringify({
            from: 'TradeMind <support@trademind.ai>',
            to: [email],
            subject: `Welcome to TradeMind ${plan.charAt(0).toUpperCase() + plan.slice(1)}!`,
            html: `<div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px">
              <h2 style="color:#55D396">You are now on the ${plan.toUpperCase()} plan!</h2>
              <p>Thank you for upgrading TradeMind. Your account has been upgraded and all Pro features are now unlocked.</p>
              <a href="https://trademind-nine.vercel.app" style="background:#55D396;color:#040605;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;margin-top:16px">Open TradeMind</a>
              <p style="color:#666;font-size:12px;margin-top:24px">Questions? Email support@trademind.ai</p>
            </div>`
          })
        });
        break;
      }
      
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const status = sub.status === 'active' ? 'active' : 'inactive';
        await fetch(`${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${sub.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({ status, updated_at: new Date().toISOString() })
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await fetch(`${supabaseUrl}/rest/v1/subscriptions?stripe_subscription_id=eq.${sub.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({ plan: 'free', status: 'canceled', updated_at: new Date().toISOString() })
        });
        break;
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
