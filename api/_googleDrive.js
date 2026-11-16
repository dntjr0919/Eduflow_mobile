/**
 * Google Drive API 업로드 헬퍼 (서비스 계정 JWT 인증)
 * 가정통신문 첨부파일 및 학부모 전자서명 PNG를 Google Drive에 업로드하고
 * 공유 다운로드 URL(signature_drive_url / attachment_url)을 반환합니다.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');

const DEFAULT_CRED_FILENAME = 'eduflow-db-b44f3-5692e5dea8c3.json';
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive'
];

function _loadServiceAccountFields() {
  const candidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
    path.join(process.cwd(), DEFAULT_CRED_FILENAME),
    path.join(__dirname, '..', DEFAULT_CRED_FILENAME)
  ].filter(Boolean);

  for (const credPath of candidates) {
    if (fs.existsSync(credPath)) {
      const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      return {
        clientEmail: raw.client_email,
        privateKey: raw.private_key
      };
    }
  }

  const clientEmail = (process.env.GOOGLE_DRIVE_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  let privateKey = (process.env.GOOGLE_DRIVE_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY || '').trim();
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }
  return { clientEmail, privateKey };
}

function _getDriveClient() {
  const { clientEmail, privateKey } = _loadServiceAccountFields();
  if (!clientEmail || !privateKey) {
    throw new Error('Google Drive 업로드를 위한 서비스 계정 인증 정보가 없습니다.');
  }
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: DRIVE_SCOPES
  });
  return google.drive({ version: 'v3', auth });
}

async function _resolveOrCreateFolder(drive, folderName) {
  const envFolderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (envFolderId) return envFolderId;

  const safeName = String(folderName || 'EduFlow_Uploads').replace(/'/g, "\\'");
  const listRes = await drive.files.list({
    q: `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  const files = (listRes.data && listRes.data.files) || [];
  if (files.length > 0) return files[0].id;

  const createRes = await drive.files.create({
    requestBody: {
      name: folderName || 'EduFlow_Uploads',
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id',
    supportsAllDrives: true
  });
  return createRes.data.id;
}

async function uploadBase64ToDrive({
  base64Data,
  fileName,
  mimeType = 'image/png',
  folderName = 'EduFlow_Uploads'
}) {
  const raw = String(base64Data || '').trim();
  if (!raw) {
    return { ok: false, error: '업로드할 파일 데이터가 비어 있습니다.' };
  }

  let detectedMime = mimeType;
  let b64Body = raw;
  const dataUrlMatch = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUrlMatch) {
    detectedMime = dataUrlMatch[1] || mimeType;
    b64Body = dataUrlMatch[2];
  }

  const buffer = Buffer.from(b64Body, 'base64');
  if (!buffer.length) {
    return { ok: false, error: 'Base64 디코딩 결과가 비어 있습니다.' };
  }

  try {
    const drive = _getDriveClient();
    const folderId = await _resolveOrCreateFolder(drive, folderName);

    const createRes = await drive.files.create({
      requestBody: {
        name: fileName || `eduflow_${Date.now()}.png`,
        parents: folderId ? [folderId] : undefined
      },
      media: {
        mimeType: detectedMime,
        body: Readable.from(buffer)
      },
      fields: 'id, webViewLink, webContentLink',
      supportsAllDrives: true
    });

    const fileId = createRes.data.id;
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    }).catch(() => {});

    return {
      ok: true,
      fileId,
      downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
      webViewLink: createRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : 'Google Drive 업로드 오류'
    };
  }
}

module.exports = {
  uploadBase64ToDrive
};
