export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q, platform } = req.query;
  if (!q || q.length < 2) return res.status(200).json([]);

  const plat = platform || 'mt5';
  const url = `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/servers?name=${encodeURIComponent(q)}&limit=20`;

  const r = await fetch(url, {
    headers: {
      'auth-token': process.env.METAAPI_TOKEN,
      'Content-Type': 'application/json'
    }
  });

  const data = await r.json();
  const servers = Array.isArray(data) ? data : (data.servers || []);

  const filtered = servers
    .filter(s => !plat || (s.platform || '').toLowerCase() === plat.toLowerCase())
    .map(s => ({ name: s.name, broker: s.broker || '', platform: s.platform }));

  return res.status(200).json(filtered);
}
