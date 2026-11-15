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
  const targetUserId = String(body.target_user_id || '').trim();
  const targetEndpoint = String(body.endpoint || '').trim();
  const url = String(body.url || '/').trim();

  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const gasTarget = new URL(gasUrl);
    gasTarget.searchParams.set('action', 'get_push_subscriptions');
    if (targetRole) gasTarget.searchParams.set('target_role', targetRole);
    if (targetStudentIds.length > 0) {
      gasTarget.searchParams.set('target_student_ids', targetStudentIds.join(','));
    }
    if (targetUserId) {
      gasTarget.searchParams.set('target_user_id', targetUserId);
    }
    if (targetEndpoint) {
      gasTarget.searchParams.set('endpoint', targetEndpoint);
    }
    if (apiSecret) {
      gasTarget.searchParams.set('api_secret', apiSecret);
    }

    const gasResp = await fetch(gasTarget.toString(), {
      method: 'GET',
      redirect: 'follow'
    });
    const rawGasText = await gasResp.text();
    let gasJson = null;
    try {
      gasJson = JSON.parse(rawGasText);
    } catch (_) {
      return res.status(502).json({
        ok: false,
        error: `Apps Script 응답 파싱 실패 (HTTP ${gasResp.status})`
      });
    }
    if (!gasJson || gasJson.ok === false) {
      return res.status(502).json({
        ok: false,
        error: (gasJson && gasJson.error) || 'Push 구독 목록 조회 실패'
      });
    }

    const subs = Array.isArray(gasJson.subscriptions) ? gasJson.subscriptions : [];
    const validSubs = subs.filter((s) => s.endpoint && s.p256dh && s.auth);
    if (validSubs.length === 0) {
      return res.status(200).json({
        ok: false,
        total: 0,
        sent: 0,
        failed: 0,
        error: '등록된 푸시 구독이 없습니다. 기기에서 알림 허용 후 다시 시도해 주세요.'
      });
    }

    const payload = JSON.stringify({
      title,
      body: message,
      icon: '/icon.svg',
      badge: '/icon.svg',
      url
    });

    const results = await Promise.allSettled(
      validSubs.map((s) =>
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
    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => {
        const err = r.reason || {};
        return {
          statusCode: err.statusCode || null,
          message: err.message || 'Unknown push error',
          body: err.body ? String(err.body).slice(0, 200) : ''
        };
      });
    const failed = errors.length;

    const firstErr = errors[0];
    let errorSummary = '';
    if (sent === 0 && firstErr) {
      if (firstErr.statusCode === 410 || firstErr.statusCode === 404) {
        errorSummary = `구독이 만료되었습니다 (${firstErr.statusCode} Gone). 구독을 다시 등록해 주세요.`;
      } else if (firstErr.statusCode === 401 || firstErr.statusCode === 403) {
        errorSummary = `VAPID 인증 오류 (${firstErr.statusCode}): 서버 VAPID 키와 구독 키가 일치하지 않습니다.`;
      } else {
        errorSummary = `푸시 발송 실패${firstErr.statusCode ? ' (' + firstErr.statusCode + ')' : ''}: ${firstErr.message}`;
      }
    }

    return res.status(200).json({
      ok: sent > 0,
      total: validSubs.length,
      sent,
      failed,
      errors,
      error: errorSummary || undefined
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err && err.message ? err.message : 'Web Push 발송 오류'
    });
  }
};
