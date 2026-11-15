/**
 * Vercel Serverless Function: Google Apps Script Proxy
 * Reads GAS_WEB_APP_URL from environment variables so the real Apps Script URL
 * is never exposed in client-side code or GitHub repositories.
 */
module.exports = async function handler(req, res) {
  const gasUrl = (process.env.GAS_WEB_APP_URL || '').trim();
  const apiSecret = (process.env.GAS_API_SECRET || '').trim();
  if (!gasUrl) {
    return res.status(200).json({
      ok: false,
      demo: true,
      error: 'GAS_WEB_APP_URL not configured'
    });
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    let upstream;

    if (req.method === 'GET') {
      const targetUrl = new URL(gasUrl);
      const query = req.query || {};
      for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
          value.forEach((v) => targetUrl.searchParams.append(key, String(v)));
        } else if (value !== undefined) {
          targetUrl.searchParams.set(key, String(value));
        }
      }
      if (apiSecret) {
        targetUrl.searchParams.set('api_secret', apiSecret);
      }

      upstream = await fetch(targetUrl.toString(), {
        method: 'GET',
        redirect: 'follow'
      });
    } else if (req.method === 'POST') {
      let payload = {};
      if (typeof req.body === 'string') {
        try {
          payload = req.body ? JSON.parse(req.body) : {};
        } catch (_) {
          payload = {};
        }
      } else if (req.body && typeof req.body === 'object') {
        payload = { ...req.body };
      }

      if (apiSecret) {
        payload.api_secret = apiSecret;
      }

      upstream = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
    } else {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const rawText = await upstream.text();
    try {
      const json = JSON.parse(rawText);
      return res.status(upstream.status).json(json);
    } catch (_) {
      return res.status(502).json({
        ok: false,
        error: 'Invalid JSON response from Apps Script',
        status: upstream.status
      });
    }
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err && err.message ? err.message : 'Upstream proxy error'
    });
  }
};
