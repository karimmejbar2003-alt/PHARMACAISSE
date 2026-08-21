const webPush = require('web-push');

webPush.setVapidDetails(
  'mailto:admin@pharmacaisse.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { subscription, payload } = req.body;
  if (!subscription || !payload) return res.status(400).json({ error: 'Missing data' });

  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload));
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Push error:', err.statusCode, err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};
