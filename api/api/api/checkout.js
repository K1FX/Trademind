export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { plan, email } = req.body;

    const prices = {
      pro_monthly: 'price_1TdWS3APIze1HTmytwcVuvJw',
      pro_annual: 'price_1TdWS3APIze1HTmytwcVuvJw',
      elite_monthly: 'price_1TdWVCAPIze1HTmydx15FbqZ',
      elite_annual: 'price_1TdWVCAPIze1HTmydx15FbqZ',
    };

    const priceId = prices[plan];
    if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

    const params = new URLSearchParams({
      'payment_method_types[]': 'card',
      'mode': 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'success_url': 'https://trademind-nine.vercel.app?success=true',
      'cancel_url': 'https://trademind-nine.vercel.app?canceled=true',
    });
    if (email) params.append('customer_email', email);

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`
      },
      body: params.toString()
    });

    const session = await response.json();
    if (session.error) return res.status(400).json({ error: session.error.message });
    return res.status(200).json({ url: session.url });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
