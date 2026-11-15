/**
 * Vercel Serverless Function: Web Push Dispatcher & VAPID Public Key Provider
 * - GET /api/push  -> returns VAPID public key for client PushManager.subscribe
 * - POST /api/push -> fetches matching subscriptions from GAS and sends Web Push
 */
const webpush = require('web-push');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const vapidSubject = (process.env.VAPID_SUBJECT || 'mailto:admin@eduflow.local').trim();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      configured: Boolean(vapidPublicKey && vapidPrivateKey),
      publicKey: vapidPublicKey
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  if (!vapidPublicKey || !vapidPrivateKey) {
    return res.status(200).json({
      ok: false,
      skipped: true,
      error: 'VAPID_PUBLIC_KEY 또는 VAPID_PRIVATE_KEY 환경변수가 설정되지 않았습니다.'
    });
  }

  const gasUrl = (process.env.GAS_WEB_APP_URL || '').trim();
  const apiSecret = (process.env.GAS_API_SECRET || '').trim();
  if (!gasUrl) {
    return res.status(200).json({
      ok: false,
      skipped: true,
      error: 'GAS_WEB_APP_URL not configured'
    });
  }

  let body = {};
  if (typeof req.body === 'string') {
    try {
      body = req.body ? JSON.parse(req.body) : {};
    } catch (_) {
      body = {};
    }
  } else if (req.body && typeof req.body === 'object') {
    body = req.body;
  }

  const title = String(body.title || 'EduFlow 알림').trim();
  const message = String(body.message || '').trim();
  const targetRole = String(body.target_role || 'all').trim().toLowerCase();
  const targetStudentIds = Array.isArray(body.target_student_ids)
    ? body.target_student_ids.map((s) => String(s).trim()).filter(Boolean)
    : (body.target_student_id ? [String(body.target_student_id).trim()] : []);
  const url = String(body.url || '/').trim();

  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const gasTarget = new URL(gasUrl);
    gasTarget.searchParams.set('action', 'get_push_subscriptions');
    if (targetRole) gasTarget.searchParams.set('target_role', targetRole);
    if (targetStudentIds.length > 0) {
      gasTarget.searchParams.set('target_student_ids', targetStudentIds.join(','));
    }
    if (apiSecret) {
      gasTarget.searchParams.set('api_secret', apiSecret);
    }

    const gasResp = await fetch(gasTarget.toString(), {
      method: 'GET',
      redirect: 'follow'
    });
    const gasJson = await gasResp.json();
    if (!gasJson || gasJson.ok === false) {
      return res.status(502).json({
        ok: false,
        error: (gasJson && gasJson.error) || 'Push 구독 목록 조회 실패'
      });
    }

    const subs = Array.isArray(gasJson.subscriptions) ? gasJson.subscriptions : [];
    const payload = JSON.stringify({
      title,
      body: message,
      icon: '/icon.svg',
      badge: '/icon.svg',
      url
    });

    const results = await Promise.allSettled(
      subs
        .filter((s) => s.endpoint && s.p256dh && s.auth)
        .map((s) =>
          webpush.sendNotification(
            {
              endpoint: s.endpoint,
              keys: {
                p256dh: s.p256dh,
                auth: s.auth
              }
            },
            payload
          )
        )
    );

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    return res.status(200).json({
      ok: true,
      total: subs.length,
      sent,
      failed
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err && err.message ? err.message : 'Web Push 발송 오류'
    });
  }
};
