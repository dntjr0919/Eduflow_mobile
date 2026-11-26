/**
 * EduFlow Mobile - 개인 Gmail용 Google Drive 업로드 Apps Script 템플릿
 *
 * 배포 방법:
 * 1. https://script.google.com 에서 새 프로젝트 생성 후 본 코드를 붙여넣습니다.
 * 2. 우측 상단 [배포] > [새 배포] > 유형: [웹 앱] 선택
 * 3. 실행 주체: [나(본인)], 액세스 권한: [모든 사용자] 로 설정 후 배포
 * 4. 발급된 웹 앱 URL(.../exec)을 교사 설정의 `personal_gas_url`에 저장합니다.
 */

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var payload = JSON.parse(raw);
    var action = String(payload.action || '').trim();

    if (action !== 'upload_file') {
      return _jsonResponse({ ok: false, error: '지원하지 않는 action입니다: ' + action });
    }

    var b64 = String(payload.file_base64 || '').trim();
    if (!b64) {
      return _jsonResponse({ ok: false, error: 'file_base64가 비어 있습니다.' });
    }

    var dataUrlMatch = b64.match(/^data:([^;]+);base64,(.+)$/);
    var mimeType = String(payload.mime_type || 'application/octet-stream').trim();
    if (dataUrlMatch) {
      if (!payload.mime_type && dataUrlMatch[1]) mimeType = dataUrlMatch[1];
      b64 = dataUrlMatch[2];
    }

    var fileName = String(payload.file_name || ('eduflow_' + Date.now() + '.bin')).trim();
    var folderId = String(payload.folder_id || '').trim();
    var folderName = String(payload.folder_name || 'EduFlow_Uploads').trim();

    var targetFolder = _resolveTargetFolder(folderId, folderName);
    var bytes = Utilities.base64Decode(b64);
    var blob = Utilities.newBlob(bytes, mimeType, fileName);
    var file = targetFolder.createFile(blob);

    // 링크가 있는 모든 사용자에게 보기 권한 부여
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    var savedId = file.getId();
    if (!savedId) {
      return _jsonResponse({ ok: false, error: 'Google Drive file_id를 생성하지 못했습니다.' });
    }
    return _jsonResponse({
      ok: true,
      file_id: savedId,
      url: file.getUrl(),
      download_url: 'https://drive.google.com/uc?export=download&id=' + savedId
    });
  } catch (err) {
    return _jsonResponse({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function _resolveTargetFolder(folderId, folderName) {
  if (folderId) {
    return DriveApp.getFolderById(folderId);
  }
  var segments = String(folderName || 'EduFlow_Uploads')
    .split('/')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });

  if (segments.length === 0) {
    segments = ['EduFlow_Uploads'];
  }

  var current = DriveApp.getRootFolder();
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    var iter = current.getFoldersByName(seg);
    current = iter.hasNext() ? iter.next() : current.createFolder(seg);
  }
  return current;
}

function _jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
