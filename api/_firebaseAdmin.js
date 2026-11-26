/**
 * Firebase Admin SDK 초기화 및 Firestore 복합 인덱스 안내 헬퍼
 * 1순위: 환경변수 지정 서비스 계정 JSON (FIREBASE_SERVICE_ACCOUNT_KEY / FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS)
 * 2순위: Vercel 환경변수 (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)
 */
const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');

function _resolveCredential() {
  const envJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim();
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson);
      if (parsed && parsed.project_id && parsed.client_email && parsed.private_key) {
        return cert(parsed);
      }
    } catch (err) {
      console.warn('[FirebaseAdmin] FIREBASE_SERVICE_ACCOUNT_KEY 파싱 실패:', err && err.message ? err.message : err);
    }
  }

  const candidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
    process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  ].map((p) => String(p).trim()).filter(Boolean);

  for (const credPath of candidates) {
    if (fs.existsSync(credPath)) {
      const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      return cert(raw);
    }
  }

  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  let privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase 인증 정보가 없습니다. 로컬 서비스 계정 JSON 또는 ' +
      'FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY 환경변수를 설정하세요.'
    );
  }

  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  return cert({
    projectId,
    clientEmail,
    privateKey
  });
}

function getFirestore() {
  if (!getApps().length) {
    const credential = _resolveCredential();
    const options = { credential };
    const bucket = (process.env.FIREBASE_STORAGE_BUCKET || '').trim();
    if (bucket) {
      options.storageBucket = bucket;
    }
    initializeApp(options);
  }
  return getAdminFirestore();
}

function buildFirestoreErrorPayload(err, context = 'Firestore') {
  const rawMsg = err && err.message ? String(err.message) : 'Firestore query error';
  const indexUrlMatch = rawMsg.match(/https:\/\/console\.firebase\.google\.com\/[^\s"']+/);
  const isMissingIndex =
    (err && (err.code === 9 || String(err.code).toUpperCase() === 'FAILED_PRECONDITION')) ||
    /requires an index/i.test(rawMsg);

  if (isMissingIndex) {
    const indexUrl = indexUrlMatch ? indexUrlMatch[0] : '';
    return {
      ok: false,
      code: 'FIRESTORE_INDEX_REQUIRED',
      error: indexUrl
        ? `[${context}] Firestore 복합 인덱스가 필요합니다. 아래 링크에서 클릭 한 번으로 생성해 주세요: ${indexUrl}`
        : `[${context}] Firestore 복합 인덱스가 필요합니다. firestore.indexes.json을 배포하거나 콘솔에서 인덱스를 생성해 주세요.`,
      index_url: indexUrl || undefined
    };
  }

  return {
    ok: false,
    error: `[${context}] ${rawMsg}`
  };
}

module.exports = {
  getFirestore,
  buildFirestoreErrorPayload
};
