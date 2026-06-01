export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { plan, email } = req.body;
    const prices = {
      pro_monthly: process.env.STRIPE_PRO_MONTHLY_PRICE,
      pro_annual: process.env.STRIPE_PRO_ANNUAL_PRICE,
      elite_monthly: process.env.STRIPE_ELITE_MONTHLY_PRICE,
      elite_annual: process.env.STRIPE_ELITE_ANNUAL_PRICE,
    };
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`
      },
      body: new URLSearchParams({
        'payment_method_types[]': 'card',
        'mode': 'subscription',
        'customer_email': email,
        'line_items[0][price]': prices[plan] || '',
        'line_items[0][quantity]': '1',
        'success_url': 'https://trademind-nine.vercel.app?success=true',
        'cancel_url': 'https://trademind-nine.vercel.app?canceled=true',
      })
    });
    const session = await response.json();
    return res.status(200).json({ url: session.url });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
