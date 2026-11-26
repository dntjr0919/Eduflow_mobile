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

function _normalizeDriveConfig(driveConfig) {
  if (!driveConfig || typeof driveConfig !== 'object') {
    return {
      hasTeacherConfig: false,
      drivePriority: 'workspace',
      workspaceFolderId: (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
      personalGasUrl: (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim(),
      personalFolderId: ''
    };
  }
  const hasTeacherConfig =
    driveConfig.drive_priority !== undefined ||
    driveConfig.workspace_drive_folder_id !== undefined ||
    driveConfig.personal_gas_url !== undefined ||
    driveConfig.personal_drive_folder_id !== undefined;
  const rawPriority = String(driveConfig.drive_priority || 'workspace').trim().toLowerCase();
  const drivePriority = rawPriority === 'personal' ? 'personal' : 'workspace';
  const teacherWorkspaceFolderId = String(driveConfig.workspace_drive_folder_id || '').trim();
  const teacherGasUrl = String(driveConfig.personal_gas_url || '').trim();
  const teacherPersonalFolderId = String(driveConfig.personal_drive_folder_id || '').trim();

  return {
    hasTeacherConfig,
    drivePriority,
    workspaceFolderId: teacherWorkspaceFolderId || (hasTeacherConfig ? '' : (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim()),
    personalGasUrl: teacherGasUrl || (hasTeacherConfig ? '' : (process.env.GOOGLE_APPS_SCRIPT_URL || '').trim()),
    personalFolderId: teacherPersonalFolderId
  };
}

async function _verifyWorkspaceRootFolder(drive, rootFolderId) {
  if (!rootFolderId) {
    throw new Error('Workspace Google Drive 폴더 ID(workspace_drive_folder_id)가 설정되어 있지 않습니다.');
  }
  let metaRes;
  try {
    metaRes = await drive.files.get({
      fileId: rootFolderId,
      fields: 'id, name, mimeType, trashed',
      supportsAllDrives: true
    });
  } catch (err) {
    const msg = err && err.message ? err.message : '폴더 조회 실패';
    throw new Error(`Workspace Google Drive 폴더(${rootFolderId})에 접근할 수 없습니다: ${msg}`);
  }
  const meta = (metaRes && metaRes.data) || {};
  if (!meta.id || meta.trashed) {
    throw new Error(`Workspace Google Drive 폴더(${rootFolderId})가 존재하지 않거나 휴지통에 있습니다.`);
  }
  if (meta.mimeType && meta.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error(`지정한 Workspace Drive ID(${rootFolderId})가 폴더가 아닙니다.`);
  }
  return meta.id;
}

async function _resolveOrCreateFolder(drive, folderName, rootFolderId) {
  const verifiedRootId = await _verifyWorkspaceRootFolder(drive, rootFolderId);
  const rawPath = String(folderName || 'EduFlow_Uploads').trim();
  const segments = rawPath.split('/').map((s) => s.trim()).filter(Boolean);

  if (segments.length <= 1) {
    return verifiedRootId;
  }

  let parentId = verifiedRootId;
  for (const seg of segments) {
    const safeName = seg.replace(/'/g, "\\'");
    const parentClause = parentId ? ` and '${parentId}' in parents` : '';
    const listRes = await drive.files.list({
      q: `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`,
      fields: 'files(id, name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    const files = (listRes.data && listRes.data.files) || [];
    if (files.length > 0) {
      parentId = files[0].id;
    } else {
      const createRes = await drive.files.create({
        requestBody: {
          name: seg,
          mimeType: 'application/vnd.google-apps.folder',
          ...(parentId ? { parents: [parentId] } : {})
        },
        fields: 'id',
        supportsAllDrives: true
      });
      parentId = createRes.data.id;
    }
  }
  return parentId;
}

async function _uploadToPersonalGas({
  gasUrl,
  personalFolderId,
  b64Body,
  fileName,
  mimeType,
  folderName,
  fetchFn
}) {
  if (!gasUrl) {
    return {
      ok: false,
      error: '개인 Google Drive 업로드를 위한 Apps Script 웹 앱 URL(personal_gas_url)이 설정되어 있지 않습니다.'
    };
  }
  if (!/^https?:\/\//i.test(gasUrl)) {
    return {
      ok: false,
      error: '유효하지 않은 Apps Script 웹 앱 URL(personal_gas_url) 형식입니다.'
    };
  }
  const doFetch = fetchFn || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, error: 'GAS 웹 앱 호출을 위한 fetch 구현을 찾을 수 없습니다.' };
  }

  try {
    const body = {
      action: 'upload_file',
      file_base64: b64Body,
      file_name: fileName,
      mime_type: mimeType,
      folder_name: folderName
    };
    if (personalFolderId) {
      body.folder_id = personalFolderId;
    }
    const resp = await doFetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!resp.ok || !data || !data.ok) {
      return {
        ok: false,
        error: (data && data.error) || `개인 Google Drive(GAS) 업로드 실패 (HTTP ${resp.status})`
      };
    }
    const fileId = String(data.file_id || data.fileId || '').trim();
    const webViewLink = String(data.url || data.webViewLink || '').trim();
    const downloadUrl = String(data.download_url || data.downloadUrl || '').trim();
    if (!fileId && !downloadUrl && !webViewLink) {
      return {
        ok: false,
        error: '개인 Google Drive(GAS) 응답에 file_id 또는 URL이 포함되지 않았습니다.'
      };
    }
    const resolvedId = fileId || extractDriveFileId(downloadUrl || webViewLink);
    if (!resolvedId) {
      return {
        ok: false,
        error: '개인 Google Drive(GAS) 응답에서 유효한 file_id를 추출하지 못했습니다.'
      };
    }
    return {
      ok: true,
      fileId: resolvedId,
      file_id: resolvedId,
      downloadUrl: downloadUrl || `https://drive.google.com/uc?export=download&id=${resolvedId}`,
      webViewLink: webViewLink || `https://drive.google.com/file/d/${resolvedId}/view`
    };
  } catch (err) {
    return {
      ok: false,
      error: `개인 Google Drive(GAS) 호출 오류: ${err && err.message ? err.message : '알 수 없는 오류'}`
    };
  }
}

async function uploadBase64ToDrive({
  base64Data,
  fileName,
  mimeType = 'image/png',
  folderName = 'EduFlow_Uploads',
  driveConfig = null,
  _driveClient = null,
  _fetch = null
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

  const resolvedFileName = fileName || `eduflow_${Date.now()}.png`;
  const cfg = _normalizeDriveConfig(driveConfig);

  if (cfg.drivePriority === 'personal') {
    return _uploadToPersonalGas({
      gasUrl: cfg.personalGasUrl,
      personalFolderId: cfg.personalFolderId,
      b64Body,
      fileName: resolvedFileName,
      mimeType: detectedMime,
      folderName,
      fetchFn: _fetch
    });
  }

  try {
    const drive = _driveClient || _getDriveClient();
    const folderId = await _resolveOrCreateFolder(drive, folderName, cfg.workspaceFolderId);

    const createRes = await drive.files.create({
      requestBody: {
        name: resolvedFileName,
        parents: folderId ? [folderId] : undefined
      },
      media: {
        mimeType: detectedMime,
        body: Readable.from(buffer)
      },
      fields: 'id, webViewLink, webContentLink',
      supportsAllDrives: true
    });

    const fileId = String((createRes.data && createRes.data.id) || '').trim();
    if (!fileId) {
      return {
        ok: false,
        error: 'Google Drive 업로드 응답에 file_id가 없습니다.'
      };
    }
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    }).catch(() => {});

    return {
      ok: true,
      fileId,
      file_id: fileId,
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

const MAX_IMAGE_DOWNLOAD_BYTES = Math.floor(3.5 * 1024 * 1024);

function extractDriveFileId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const queryMatch = s.match(/[?&]id=([A-Za-z0-9_-]{10,128})/);
  if (queryMatch) return queryMatch[1];
  const filePathMatch = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,128})/);
  if (filePathMatch) return filePathMatch[1];
  const shortPathMatch = s.match(/\/d\/([A-Za-z0-9_-]{10,128})/);
  if (shortPathMatch) return shortPathMatch[1];
  if (/^[A-Za-z0-9_-]{10,128}$/.test(s)) return s;
  return '';
}

async function downloadDriveFileAsDataUrl(fileIdOrUrl) {
  const fid = extractDriveFileId(fileIdOrUrl);
  if (!fid) {
    return { ok: false, error: '유효한 Google Drive file_id가 필요합니다.' };
  }

  try {
    const drive = _getDriveClient();
    const metaRes = await drive.files.get({
      fileId: fid,
      fields: 'id, name, mimeType, size',
      supportsAllDrives: true
    });
    const meta = (metaRes && metaRes.data) || {};
    let mimeType = String(meta.mimeType || '').trim().toLowerCase();
    const fileName = String(meta.name || '').trim().toLowerCase();

    if (!mimeType.startsWith('image/')) {
      if ((mimeType === 'application/octet-stream' || !mimeType) && /\.(jpe?g|png|webp|gif|bmp)$/i.test(fileName)) {
        if (fileName.endsWith('.png')) mimeType = 'image/png';
        else if (fileName.endsWith('.webp')) mimeType = 'image/webp';
        else if (fileName.endsWith('.gif')) mimeType = 'image/gif';
        else mimeType = 'image/jpeg';
      } else {
        return { ok: false, error: '이미지 파일만 불러올 수 있습니다.' };
      }
    }

    const metaSize = Number(meta.size || 0);
    if (Number.isFinite(metaSize) && metaSize > MAX_IMAGE_DOWNLOAD_BYTES) {
      return { ok: false, error: '이미지 파일 크기가 제한(3.5MB)을 초과했습니다.' };
    }

    const mediaRes = await drive.files.get(
      { fileId: fid, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const rawData = mediaRes && mediaRes.data;
    let buf;
    if (Buffer.isBuffer(rawData)) {
      buf = rawData;
    } else if (rawData instanceof ArrayBuffer) {
      buf = Buffer.from(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      buf = Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    } else {
      buf = Buffer.from(rawData || '');
    }

    if (!buf.length) {
      return { ok: false, error: '다운로드한 이미지 데이터가 비어 있습니다.' };
    }
    if (buf.length > MAX_IMAGE_DOWNLOAD_BYTES) {
      return { ok: false, error: '이미지 파일 크기가 제한(3.5MB)을 초과했습니다.' };
    }

    return {
      ok: true,
      fileId: fid,
      mimeType,
      size: buf.length,
      dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : 'Google Drive 파일 읽기 오류'
    };
  }
}

module.exports = {
  uploadBase64ToDrive,
  downloadDriveFileAsDataUrl,
  extractDriveFileId
};
