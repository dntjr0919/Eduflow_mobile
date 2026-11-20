/**
 * Vercel Serverless Function: Cloud Firestore Direct API
 * 기존 Google Apps Script 웹 앱 호출을 완전히 제거하고
 * firebase-admin SDK로 Cloud Firestore를 직접 조회·수정합니다.
 */
const crypto = require('crypto');
const { getFirestore, buildFirestoreErrorPayload } = require('./_firebaseAdmin');
const googleDrive = require('./_googleDrive');
const { uploadBase64ToDrive } = googleDrive;

const SUPER_ADMIN_ID = '유우석';

async function _isSuperAdmin(db, requesterId) {
  const rid = String(requesterId || '').trim();
  if (!rid) return false;
  if (rid === SUPER_ADMIN_ID) return true;
  try {
    const doc = await db.collection('계정_교사').doc(rid).get();
    if (doc.exists && doc.data() && doc.data().is_admin === true) return true;
  } catch (_) {}
  return false;
}

function _nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function _toIntOrNull(val) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function _inferGradeClassFromStudentId(studentId) {
  const s = String(studentId || '').trim();
  if (/^\d{5}$/.test(s)) {
    return { grade: _toIntOrNull(s.slice(0, 1)), class_no: _toIntOrNull(s.slice(1, 3)) };
  }
  if (/^\d{4}$/.test(s)) {
    return { grade: _toIntOrNull(s.slice(0, 1)), class_no: _toIntOrNull(s.slice(1, 2)) };
  }
  return { grade: null, class_no: null };
}

function _withInferredClass(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const g = _toIntOrNull(doc.grade);
  const c = _toIntOrNull(doc.class_no);
  if (g !== null && c !== null) return doc;
  const inferred = _inferGradeClassFromStudentId(doc.student_id);
  return {
    ...doc,
    grade: g !== null ? g : inferred.grade,
    class_no: c !== null ? c : inferred.class_no
  };
}

function _toBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const s = String(val || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === '예';
}

function _normalizeNoticeDriveUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\/drive\.google\.com\/(?:uc|open)\b/i.test(s)) {
    const match = s.match(/[?&]id=([A-Za-z0-9_-]{10,128})/);
    if (match) return `https://drive.google.com/file/d/${match[1]}/view`;
  }
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function _resolveNoticeAttachmentUrl(row) {
  if (!row || typeof row !== 'object') return '';
  const candidates = [
    row.attachment_url,
    row.attachmentUrl,
    row.file_url,
    row.fileUrl,
    row.drive_url,
    row.driveUrl,
    row.pdf_url,
    row.pdfUrl,
    row.original_url,
    row.originalUrl,
    row.web_view_link,
    row.webViewLink,
    row.download_url,
    row.downloadUrl,
    row.attachment_link,
    row.link_url,
    row.url,
  ];
  for (const val of candidates) {
    const normalized = _normalizeNoticeDriveUrl(val);
    if (normalized) return normalized;
  }
  const rawFileId = String(row.drive_file_id || row.file_id || '').trim();
  if (/^[A-Za-z0-9_-]{10,128}$/.test(rawFileId)) {
    return `https://drive.google.com/file/d/${rawFileId}/view`;
  }
  return '';
}

function _withNormalizedNoticeAttachment(row) {
  if (!row || typeof row !== 'object') return row;
  const resolved = _resolveNoticeAttachmentUrl(row);
  if (row.attachment_url === resolved) return row;
  return { ...row, attachment_url: resolved };
}

function _addBusinessDays(baseDateStr, businessDays) {
  const parts = String(baseDateStr || '').trim().split('-');
  let d;
  if (parts.length === 3) {
    d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
  } else {
    const now = new Date();
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  }
  const days = parseInt(businessDays, 10);
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  if (isNaN(days) || days === 0) return fmt(d);
  const step = days > 0 ? 1 : -1;
  const target = Math.abs(days);
  let counted = 0;
  let guard = 0;
  while (counted < target && guard < 365) {
    d.setDate(d.getDate() + step);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      counted++;
    }
    guard++;
  }
  return fmt(d);
}

function _computeDocDueDate(ruleCode, baseDate, docRulesRows) {
  const code = String(ruleCode || 'ABSENCE_REPORT').trim();
  const base = String(baseDate || '').trim() || new Date().toISOString().slice(0, 10);
  const rules = Array.isArray(docRulesRows) ? docRulesRows : [];
  const matched = rules.find((r) => r && (r.rule_code === code || (code === 'ABSENCE_REPORT' && r.remote_id === 'rule_absence')));
  const defaultDays = code === 'FIELD_TRIP_PRE' ? 3 : 5;
  const days = (matched && parseInt(matched.due_business_days, 10)) || defaultDays;
  const signedDays = code === 'FIELD_TRIP_PRE' ? -Math.abs(days) : Math.abs(days);
  return _addBusinessDays(base, signedDays);
}

const STATIC_CACHE_TTL_MS = 10 * 60 * 1000;
if (!globalThis.__eduflowStaticCache) {
  globalThis.__eduflowStaticCache = new Map();
}
const _staticCache = globalThis.__eduflowStaticCache;

function _getStaticCache(key, force = false) {
  if (force) return undefined;
  const entry = _staticCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _staticCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _setStaticCache(key, value, ttlMs = STATIC_CACHE_TTL_MS) {
  _staticCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function _invalidateStaticCache(prefix) {
  if (!prefix) {
    _staticCache.clear();
    return;
  }
  for (const k of _staticCache.keys()) {
    if (k.startsWith(prefix)) _staticCache.delete(k);
  }
}

async function _getCachedOrFetch(key, force, fetcher) {
  const cached = _getStaticCache(key, force);
  if (cached !== undefined) return cached;
  const fresh = await fetcher();
  return _setStaticCache(key, fresh);
}

function _gradeCandidates(gradeNum) {
  if (gradeNum === null || gradeNum === undefined) return [];
  return [gradeNum, String(gradeNum)];
}

function _studentIdCandidates(studentId) {
  const s = String(studentId || '').trim();
  if (!s) return [];
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? [s, n] : [s];
}

function _snapToRows(snap) {
  const rows = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (!data.remote_id) data.remote_id = doc.id;
    rows.push(data);
  });
  return rows;
}

function _normalizeTeacherName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/(?:선생님|T)$/i, '').trim();
}

function _extractTeacherFromSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return '';
  const m = s.match(/^.+?\(([^)]+)\)$/);
  return m ? _normalizeTeacherName(m[1]) : '';
}

function _rowMatchesTeacher(row, targetNorm) {
  if (!row || typeof row !== 'object' || !targetNorm) return false;
  const candidates = [
    _normalizeTeacherName(row.teacher_name),
    _normalizeTeacherName(row.teacher),
    _extractTeacherFromSubject(row.teacher_name),
    _extractTeacherFromSubject(row.teacher),
    _extractTeacherFromSubject(row.subject),
    _normalizeTeacherName(row.changed_teacher),
    _normalizeTeacherName(row.original_teacher),
  ];
  return candidates.some((c) => c && c === targetNorm);
}

function _teacherNameCandidates(name) {
  const norm = _normalizeTeacherName(name);
  if (!norm) return [];
  return Array.from(new Set([norm, `${norm}T`]));
}

function _mergeRowsById(...rowLists) {
  const map = new Map();
  for (const list of rowLists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const rid = String(row.remote_id || `${row.entry_type || ''}_${row.grade || ''}_${row.class_no || ''}_${row.day_of_week || row.date || ''}_${row.period || ''}_${row.teacher_name || ''}`);
      if (!map.has(rid)) map.set(rid, row);
    }
  }
  return Array.from(map.values());
}

async function _queryClassScoped(db, collectionName, gradeNum, classNum) {
  let ref = db.collection(collectionName);
  if (gradeNum !== null && classNum !== null) {
    ref = ref.where('grade', '==', gradeNum).where('class_no', '==', classNum);
  } else if (gradeNum !== null) {
    ref = ref.where('grade', '==', gradeNum);
  } else {
    return [];
  }
  const snap = await ref.get();
  return _snapToRows(snap);
}

function _parsePayload(req) {
  let raw = {};
  if (req.method === 'GET') {
    raw = req.query || {};
  } else if (typeof req.body === 'string') {
    try {
      raw = req.body ? JSON.parse(req.body) : {};
    } catch (_) {
      raw = {};
    }
  } else if (req.body && typeof req.body === 'object') {
    raw = { ...req.body };
  }
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    return { ...raw, ...raw.data };
  }
  return raw;
}

function _matchesTenant(doc, { schoolCode, comciganSchoolCode, schoolName, gradeNum, classNum }) {
  if (!doc || typeof doc !== 'object') return false;
  const docSchoolCode = String(doc.school_code || doc.neis_school_code || '').trim();
  const docComciganCode = String(doc.comcigan_school_code || '').trim();
  const docSchoolName = String(doc.school_name || '').trim();

  const hasTenantSchool = Boolean(schoolCode || comciganSchoolCode || schoolName);
  const hasDocSchool = Boolean(docSchoolCode || docComciganCode || docSchoolName);
  if (hasTenantSchool && hasDocSchool) {
    let schoolMatched = false;
    if (schoolCode && docSchoolCode && docSchoolCode === schoolCode) {
      schoolMatched = true;
    } else if (comciganSchoolCode && docComciganCode && docComciganCode === comciganSchoolCode) {
      schoolMatched = true;
    } else if (comciganSchoolCode && docSchoolCode && docSchoolCode === comciganSchoolCode) {
      schoolMatched = true;
    } else if (schoolCode && docComciganCode && docComciganCode === schoolCode) {
      schoolMatched = true;
    } else if (schoolName && docSchoolName && docSchoolName === schoolName) {
      schoolMatched = true;
    }
    if (!schoolMatched) return false;
  }

  const rawG = doc.grade !== undefined && doc.grade !== '' ? doc.grade : doc.target_grade;
  const rawC = doc.class_no !== undefined && doc.class_no !== '' ? doc.class_no : doc.target_class;
  const docG = _toIntOrNull(rawG);
  const docC = _toIntOrNull(rawC);
  if (gradeNum !== null && docG !== null && docG !== gradeNum) return false;
  if (classNum !== null && docC !== null && docC !== classNum) return false;
  return true;
}

function _isSha256Hex(val) {
  return /^[a-f0-9]{64}$/i.test(String(val || '').trim());
}

function _sha256Hex(val) {
  return crypto.createHash('sha256').update(String(val || ''), 'utf8').digest('hex');
}

function _verifyPassword(storedHash, rawPassword, providedHash) {
  const stored = String(storedHash || '').trim();
  if (!stored) return true;
  if (rawPassword && stored === String(rawPassword)) return true;
  if (providedHash && stored.toLowerCase() === String(providedHash).toLowerCase()) return true;
  if (rawPassword) {
    const sha = _sha256Hex(rawPassword);
    if (stored.toLowerCase() === sha.toLowerCase()) return true;
  }
  return false;
}

async function _findAccountDoc(db, role, userId) {
  const colMap = {
    teacher: { col: '계정_교사', idField: 'teacher_id' },
    student: { col: '계정_학생', idField: 'student_id' },
    parent: { col: '계정_학부모', idField: 'parent_id' }
  };
  const target = colMap[role] || colMap.student;
  const colRef = db.collection(target.col);

  const directSnap = await colRef.doc(userId).get();
  if (directSnap.exists) {
    return { colRef, docId: directSnap.id, userDoc: { remote_id: directSnap.id, ...directSnap.data() } };
  }
  for (const field of [target.idField, 'login_id', 'custom_id']) {
    const qSnap = await colRef.where(field, '==', userId).limit(1).get();
    if (!qSnap.empty) {
      const d = qSnap.docs[0];
      return { colRef, docId: d.id, userDoc: { remote_id: d.id, ...d.data() } };
    }
  }
  return { colRef, docId: null, userDoc: null };
}

async function _isDuplicateIdAcrossAllCollections(db, candidateId) {
  const checks = [
    { col: '계정_교사', fields: ['teacher_id', 'login_id', 'custom_id'] },
    { col: '계정_학생', fields: ['student_id', 'login_id', 'custom_id'] },
    { col: '계정_학부모', fields: ['parent_id', 'login_id', 'custom_id'] }
  ];
  for (const item of checks) {
    const colRef = db.collection(item.col);
    const d = await colRef.doc(candidateId).get();
    if (d.exists) return true;
    for (const f of item.fields) {
      const q = await colRef.where(f, '==', candidateId).limit(1).get();
      if (!q.empty) return true;
    }
  }
  return false;
}

async function _handleLogin(db, body) {
  const role = String(body.role || 'student').trim().toLowerCase();
  const userId = String(body.user_id || '').trim();
  const password = String(body.password || '');
  const passwordHash = String(body.password_hash || '');

  if (!userId) {
    return { status: 400, json: { ok: false, error: '아이디를 입력해 주세요.' } };
  }

  const { colRef, docId, userDoc } = await _findAccountDoc(db, role, userId);

  if (!userDoc) {
    return { status: 401, json: { ok: false, error: '등록되지 않은 계정입니다.' } };
  }

  const accStatus = String(userDoc.status || 'active').trim().toLowerCase();
  if (accStatus === 'pending') {
    return { status: 403, json: { ok: false, error: '담임 교사(또는 관리자) 승인 대기 중인 계정입니다.' } };
  }
  if (accStatus === 'rejected') {
    return { status: 403, json: { ok: false, error: '가입 신청이 반려된 계정입니다.' } };
  }

  if (userDoc.custom_id_changed === true && userDoc.custom_id && userId !== String(userDoc.custom_id)) {
    return { status: 401, json: { ok: false, error: '커스텀 ID로 변경된 계정입니다. 변경한 ID로 로그인해 주세요.' } };
  }

  if (!_verifyPassword(userDoc.password_hash, password, passwordHash)) {
    return { status: 401, json: { ok: false, error: '비밀번호가 일치하지 않습니다.' } };
  }

  // 기존 평문 비밀번호로 로그인 성공 시 백그라운드에서 SHA-256 해시로 자동 업그레이드
  const storedPw = String(userDoc.password_hash || '').trim();
  if (storedPw && !_isSha256Hex(storedPw) && docId) {
    const upgradedHash = password
      ? _sha256Hex(password)
      : (_isSha256Hex(passwordHash) ? String(passwordHash).toLowerCase() : '');
    if (upgradedHash) {
      colRef.doc(docId).set(
        { password_hash: upgradedHash, updated_at: _nowStr() },
        { merge: true }
      ).catch(() => {});
    }
  }

  const safeUser = { ...userDoc, role, phone: String(userDoc.phone || '') };
  delete safeUser.password_hash;
  return { status: 200, json: { ok: true, user: safeUser } };
}

async function _handleChangePassword(db, body) {
  const role = String(body.role || 'student').trim().toLowerCase();
  const userId = String(body.user_id || '').trim();
  const currentPassword = String(body.current_password || '');
  const currentPasswordHash = String(body.current_password_hash || '');
  const newPassword = String(body.new_password || '');

  if (!userId) {
    return { status: 400, json: { ok: false, error: '아이디를 입력해 주세요.' } };
  }
  if (!newPassword) {
    return { status: 400, json: { ok: false, error: '새 비밀번호를 입력해 주세요.' } };
  }

  const { colRef, docId, userDoc } = await _findAccountDoc(db, role, userId);
  if (!userDoc || !docId) {
    return { status: 404, json: { ok: false, error: '계정을 찾을 수 없습니다.' } };
  }

  if (!_verifyPassword(userDoc.password_hash, currentPassword, currentPasswordHash)) {
    return { status: 401, json: { ok: false, error: '현재 비밀번호가 일치하지 않습니다.' } };
  }

  const newHash = _sha256Hex(newPassword);
  await colRef.doc(docId).set(
    { password_hash: newHash, updated_at: _nowStr() },
    { merge: true }
  );

  return { status: 200, json: { ok: true, message: '비밀번호가 안전하게 변경되었습니다.' } };
}

async function _handleChangeCustomId(db, body) {
  const role = String(body.role || 'student').trim().toLowerCase();
  const userId = String(body.user_id || '').trim();
  const newCustomId = String(body.new_custom_id || '').trim();

  if (role !== 'student' && role !== 'parent') {
    return { status: 400, json: { ok: false, error: '학생 또는 학부모 계정만 커스텀 ID를 변경할 수 있습니다.' } };
  }
  if (!userId || !newCustomId) {
    return { status: 400, json: { ok: false, error: '현재 ID와 새 커스텀 ID를 모두 입력해 주세요.' } };
  }
  if (/^\d{5}$/.test(newCustomId)) {
    return { status: 400, json: { ok: false, error: '5자리 숫자(학번 형식)는 커스텀 ID로 사용할 수 없습니다.' } };
  }
  if (!/^[a-z0-9_.-]{4,20}$/.test(newCustomId)) {
    return { status: 400, json: { ok: false, error: '커스텀 ID는 영문 소문자, 숫자, _, ., - 조합 4~20자여야 합니다.' } };
  }

  const { colRef, docId, userDoc } = await _findAccountDoc(db, role, userId);
  if (!userDoc || !docId) {
    return { status: 404, json: { ok: false, error: '계정을 찾을 수 없습니다.' } };
  }
  if (userDoc.custom_id_changed === true) {
    return { status: 400, json: { ok: false, error: '커스텀 ID 변경은 최초 1회만 가능합니다.' } };
  }

  const isDup = await _isDuplicateIdAcrossAllCollections(db, newCustomId);
  if (isDup) {
    return { status: 409, json: { ok: false, error: '이미 사용 중인 ID입니다. 다른 ID를 입력해 주세요.' } };
  }

  await colRef.doc(docId).set(
    {
      custom_id: newCustomId,
      login_id: newCustomId,
      custom_id_changed: true,
      updated_at: _nowStr()
    },
    { merge: true }
  );

  return { status: 200, json: { ok: true, custom_id: newCustomId, message: '커스텀 ID가 변경되었습니다. 다음부터 새 ID로 로그인해 주세요.' } };
}

function _normalizePhoneNumber(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { ok: true, phone: '' };
  if (/[^\d+\-\s()]/.test(trimmed)) {
    return { ok: false, error: '올바른 휴대폰 번호 형식이 아닙니다. (숫자와 하이픈만 입력해 주세요)' };
  }
  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('82') && (digits.length === 11 || digits.length === 12)) {
    digits = '0' + digits.slice(2);
  }
  if (digits.length < 9 || digits.length > 11 || !digits.startsWith('0')) {
    return { ok: false, error: '올바른 휴대폰 번호 형식이 아닙니다. (예: 010-1234-5678)' };
  }
  if (digits.startsWith('02')) {
    if (digits.length === 9) {
      return { ok: true, phone: digits.replace(/^(\d{2})(\d{3})(\d{4})$/, '$1-$2-$3') };
    }
    if (digits.length === 10) {
      return { ok: true, phone: digits.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3') };
    }
    return { ok: false, error: '올바른 전화번호 형식이 아닙니다.' };
  }
  if (digits.length === 10) {
    return { ok: true, phone: digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3') };
  }
  if (digits.length === 11) {
    return { ok: true, phone: digits.replace(/^(\d{3})(\d{4})(\d{4})$/, '$1-$2-$3') };
  }
  return { ok: false, error: '올바른 휴대폰 번호 형식이 아닙니다. (예: 010-1234-5678)' };
}

async function _handleUpdateMyPhone(db, body) {
  const role = String(body.role || 'student').trim().toLowerCase();
  if (role !== 'student' && role !== 'parent') {
    return { status: 400, json: { ok: false, error: '학생 또는 학부모 계정만 본인 연락처를 수정할 수 있습니다.' } };
  }
  const userId = String(body.user_id || body.student_id || body.parent_id || body.remote_id || '').trim();
  if (!userId) {
    return { status: 400, json: { ok: false, error: '계정 ID(user_id)가 필요합니다.' } };
  }
  const norm = _normalizePhoneNumber(body.phone ?? '');
  if (!norm.ok) {
    return { status: 400, json: { ok: false, error: norm.error } };
  }

  const { colRef, docId, userDoc } = await _findAccountDoc(db, role, userId);
  if (!userDoc || !docId) {
    return { status: 404, json: { ok: false, error: '계정을 찾을 수 없습니다.' } };
  }
  const accStatus = String(userDoc.status || 'active').trim().toLowerCase();
  if (accStatus === 'rejected') {
    return { status: 403, json: { ok: false, error: '반려된 계정은 연락처를 수정할 수 없습니다.' } };
  }

  const nowStr = _nowStr();
  await colRef.doc(docId).set(
    { phone: norm.phone, updated_at: nowStr },
    { merge: true }
  );

  return {
    status: 200,
    json: {
      ok: true,
      remote_id: docId,
      role,
      phone: norm.phone,
      updated_at: nowStr,
      message: norm.phone ? '연락처가 저장되었습니다.' : '연락처가 삭제되었습니다.'
    }
  };
}

async function _handleRegisterAccount(db, body) {
  const role = String(body.role || 'student').trim().toLowerCase();
  const desiredId = String(body.desired_id || '').trim();
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  const schoolName = String(body.school_name || '').trim();
  const neisOfficeCode = String(body.neis_office_code || '').trim();
  const neisSchoolCode = String(body.neis_school_code || '').trim();
  const gradeNum = _toIntOrNull(body.grade);
  const classNum = _toIntOrNull(body.class_no);
  const studentNoNum = _toIntOrNull(body.student_no);

  if (!desiredId || !password || !name) {
    return { status: 400, json: { ok: false, error: '이름, 희망 ID, 비밀번호를 모두 입력해 주세요.' } };
  }
  if (/^\d{5}$/.test(desiredId)) {
    return { status: 400, json: { ok: false, error: '5자리 숫자(학번 형식)는 ID로 사용할 수 없습니다.' } };
  }
  if (role !== 'teacher' && !/^[a-z0-9_.-]{4,20}$/.test(desiredId)) {
    return { status: 400, json: { ok: false, error: '희망 ID는 영문 소문자, 숫자, _, ., - 조합 4~20자여야 합니다.' } };
  }

  const isDup = await _isDuplicateIdAcrossAllCollections(db, desiredId);
  if (isDup) {
    return { status: 409, json: { ok: false, error: '이미 사용 중인 ID입니다. 다른 ID를 입력해 주세요.' } };
  }

  const pwHash = _sha256Hex(password);
  const now = _nowStr();
  const schoolPrefix = neisSchoolCode || schoolName;

  if (role === 'teacher') {
    await db.collection('계정_교사').doc(desiredId).set({
      remote_id: desiredId,
      teacher_id: desiredId,
      login_id: desiredId,
      name,
      school_name: schoolName,
      neis_office_code: neisOfficeCode,
      neis_school_code: neisSchoolCode,
      grade: gradeNum,
      class_no: classNum,
      subject: String(body.subject || '').trim(),
      password_hash: pwHash,
      status: 'pending',
      updated_at: now
    }, { merge: true });
    return { status: 200, json: { ok: true, status: 'pending', message: '교사 가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.' } };
  }

  if (role === 'parent') {
    const childSid = String(body.child_student_id || '').trim();
    const childName = String(body.child_name || '').trim();
    if (!childSid || !childName) {
      return { status: 400, json: { ok: false, error: '자녀 학번과 자녀 이름을 모두 입력해 주세요.' } };
    }
    let matchedStudent = null;
    const stuCol = db.collection('계정_학생');
    const directCandidates = neisSchoolCode ? [`${neisSchoolCode}_${childSid}`, childSid] : [childSid];
    for (const cand of directCandidates) {
      const sDoc = await stuCol.doc(cand).get();
      if (sDoc.exists) {
        const sd = sDoc.data() || {};
        if (_matchesTenant(sd, { schoolCode: neisSchoolCode, schoolName, gradeNum, classNum })) {
          matchedStudent = sd;
          break;
        }
      }
    }
    if (!matchedStudent) {
      const qSnap = await stuCol.where('student_id', '==', childSid).get();
      qSnap.forEach((d) => {
        if (matchedStudent) return;
        const sd = d.data() || {};
        if (_matchesTenant(sd, { schoolCode: neisSchoolCode, schoolName, gradeNum, classNum })) {
          matchedStudent = sd;
        }
      });
    }
    if (!matchedStudent || String(matchedStudent.name || '').trim() !== childName) {
      return { status: 400, json: { ok: false, error: '등록된 학생 정보(학번·이름)가 일치하지 않습니다.' } };
    }

    const docId = schoolPrefix ? `${schoolPrefix}_${desiredId}` : desiredId;
    await db.collection('계정_학부모').doc(docId).set({
      remote_id: docId,
      parent_id: desiredId,
      login_id: desiredId,
      custom_id: desiredId,
      custom_id_changed: true,
      name,
      school_name: schoolName || String(matchedStudent.school_name || ''),
      school_code: neisSchoolCode || String(matchedStudent.school_code || ''),
      grade: gradeNum ?? matchedStudent.grade ?? null,
      class_no: classNum ?? matchedStudent.class_no ?? null,
      student_id: childSid,
      student_name: childName,
      password_hash: pwHash,
      status: 'pending',
      updated_at: now
    }, { merge: true });
    return { status: 200, json: { ok: true, status: 'pending', message: '학부모 가입 신청이 접수되었습니다. 담임 교사 승인 후 로그인할 수 있습니다.' } };
  }

  const docId = schoolPrefix ? `${schoolPrefix}_${desiredId}` : desiredId;
  const computedSid = (gradeNum && classNum && studentNoNum)
    ? `${gradeNum}${String(classNum).padStart(2, '0')}${String(studentNoNum).padStart(2, '0')}`
    : desiredId;
  await db.collection('계정_학생').doc(docId).set({
    remote_id: docId,
    student_id: computedSid,
    login_id: desiredId,
    custom_id: desiredId,
    custom_id_changed: true,
    name,
    school_name: schoolName,
    school_code: neisSchoolCode,
    grade: gradeNum,
    class_no: classNum,
    student_no: studentNoNum,
    password_hash: pwHash,
    status: 'pending',
    updated_at: now
  }, { merge: true });
  return { status: 200, json: { ok: true, status: 'pending', message: '학생 가입 신청이 접수되었습니다. 담임 교사 승인 후 로그인할 수 있습니다.' } };
}

const PC_AGENT_ONLINE_TTL_MS = 3 * 60 * 1000;

function _parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw || '').trim();
  if (!s) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
}

function _isPublicAcademicSchedule(row) {
  if (!row || typeof row !== 'object') return false;
  const cat = String(row.category || row.type || '').trim().toLowerCase();
  if (!cat) return true;
  if (cat === '개인' || cat === 'personal' || cat === '비공개' || cat === '교사') {
    return false;
  }
  return true;
}

function _evaluatePcAgentOnline(statusDoc, nowMs = Date.now()) {
  if (!statusDoc || typeof statusDoc !== 'object') return false;
  if (!_toBool(statusDoc.pc_online)) return false;
  const seenMs = _parseTimestampMs(statusDoc.pc_last_seen_at);
  if (!Number.isFinite(seenMs)) return false;
  const diff = nowMs - seenMs;
  return diff >= -60 * 1000 && diff <= PC_AGENT_ONLINE_TTL_MS;
}

async function _handleGetMobileBundle(db, params) {
  const role = String(params.role || 'student').trim().toLowerCase();
  const studentId = String(params.student_id || '').trim();
  const userId = String(params.user_id || '').trim();
  const gradeNum = _toIntOrNull(params.grade);
  const classNum = _toIntOrNull(params.class_no);
  const schoolCode = String(params.school_code || params.neis_school_code || '').trim();
  const schoolName = String(params.school_name || '').trim();
  const forceRefresh = String(params.force || '') === '1';
  const skipStatic = !forceRefresh && String(params.skip_static || '') === '1';

  const tenant = { schoolCode, schoolName, gradeNum, classNum };
  const rawTeacherParam = String(params.teacher_name || '').trim();
  const normTeacherParam = _normalizeTeacherName(rawTeacherParam);
  const gradeIn = _gradeCandidates(gradeNum);
  const sidIn = _studentIdCandidates(studentId);
  const isStudentScoped = Boolean(studentId && role !== 'teacher');
  const todayStr = _nowStr().slice(0, 10);

  const teacherCacheKey = role === 'teacher' && userId
    ? `teacher_doc:${userId}`
    : (gradeNum !== null ? `teachers_grade:${gradeNum}` : 'teachers_default');
  const ttBaseCacheKey = gradeNum !== null ? `tt_base_grade:${gradeNum}` : null;
  const mealsCacheKey = `meals:${schoolCode || 'all'}`;

  // 읽기 비용 최적화 (단일 필드 where만 사용해 복합 인덱스 오류 방지 + 정적 데이터 서버 메모리 캐시):
  const [
    teachersRaw,
    studentsRows,
    attendanceRows,
    docTrackingRows,
    noticesRaw,
    noticeRepliesRaw,
    timetableBaseClassRows,
    timetableChangesClassRows,
    mealsRaw,
    docRulesRows,
    chatRows,
    notificationsRaw,
    budgetRows,
    boardNoticesRows,
    subjectRostersRaw,
    subjectAttRaw,
    lessonProgressRaw,
    pcAgentStatusDoc,
    remoteTasksRaw,
    schedulesRaw
  ] = await Promise.all([
    _getCachedOrFetch(teacherCacheKey, forceRefresh, () => (
      role === 'teacher' && userId
        ? db.collection('계정_교사').doc(userId).get().then((d) => (d.exists ? [{ remote_id: d.id, ...d.data() }] : []))
        : (gradeIn.length > 0
            ? db.collection('계정_교사').where('grade', 'in', gradeIn).limit(30).get().then(_snapToRows)
            : db.collection('계정_교사').limit(20).get().then(_snapToRows))
    )),
    isStudentScoped && sidIn.length > 0
      ? db.collection('계정_학생').where('student_id', 'in', sidIn).limit(5).get().then(_snapToRows)
      : (gradeIn.length > 0
          ? db.collection('계정_학생').where('grade', 'in', gradeIn).limit(200).get().then(_snapToRows)
          : Promise.resolve([])),
    isStudentScoped && sidIn.length > 0
      ? db.collection('일일_출결').where('student_id', 'in', sidIn).limit(100).get().then(_snapToRows)
      : (gradeIn.length > 0
          ? db.collection('일일_출결').where('grade', 'in', gradeIn).limit(200).get().then(_snapToRows)
          : Promise.resolve([])),
    isStudentScoped && sidIn.length > 0
      ? db.collection('서류_추적').where('student_id', 'in', sidIn).limit(50).get().then(_snapToRows)
      : db.collection('서류_추적').limit(150).get().then(_snapToRows),
    db.collection('가정통신문_목록').limit(50).get().then(_snapToRows),
    isStudentScoped && sidIn.length > 0
      ? db.collection('가정통신문_회신').where('student_id', 'in', sidIn).limit(50).get().then(_snapToRows)
      : db.collection('가정통신문_회신').limit(150).get().then(_snapToRows),
    !skipStatic && ttBaseCacheKey
      ? _getCachedOrFetch(ttBaseCacheKey, forceRefresh, () =>
          db.collection('시간표_기본').where('grade', 'in', gradeIn).limit(300).get().then(_snapToRows)
        )
      : Promise.resolve(undefined),
    gradeIn.length > 0
      ? db.collection('시간표_변동').where('grade', 'in', gradeIn).limit(100).get().then(_snapToRows)
      : db.collection('시간표_변동').where('date', '>=', todayStr).limit(100).get().then(_snapToRows),
    !skipStatic
      ? _getCachedOrFetch(mealsCacheKey, forceRefresh, () => (
          schoolCode
            ? db.collection('급식_식단표').where('school_code', '==', schoolCode).limit(60).get().then(_snapToRows)
            : db.collection('급식_식단표').limit(60).get().then(_snapToRows)
        ))
      : Promise.resolve(undefined),
    !skipStatic
      ? _getCachedOrFetch('doc_rules', forceRefresh, () =>
          db.collection('설정_서류규정').limit(50).get().then(_snapToRows)
        )
      : Promise.resolve(undefined),
    isStudentScoped
      ? db.collection('1:1_상담채팅').where('room_id', '==', `ROOM-${studentId}`).limit(100).get().then(_snapToRows)
      : (gradeIn.length > 0
          ? db.collection('1:1_상담채팅').where('grade', 'in', gradeIn).limit(150).get().then(_snapToRows)
          : db.collection('1:1_상담채팅').limit(100).get().then(_snapToRows)),
    db.collection('Notifications').where('is_read', '==', false).limit(50).get().then(_snapToRows),
    gradeIn.length > 0
      ? db.collection('학급회비').where('grade', 'in', gradeIn).limit(100).get().then(_snapToRows)
      : db.collection('학급회비').limit(100).get().then(_snapToRows),
    gradeIn.length > 0
      ? db.collection('학급_공지게시판').where('grade', 'in', gradeIn).limit(100).get().then(_snapToRows)
      : db.collection('학급_공지게시판').limit(100).get().then(_snapToRows),
    role === 'teacher' && userId
      ? db.collection('교과_명렬표').where('teacher_id', '==', userId).limit(200).get().then(_snapToRows).catch(() => [])
      : Promise.resolve([]),
    role === 'teacher' && userId
      ? db.collection('교과_출결').where('teacher_id', '==', userId).limit(500).get().then(_snapToRows).catch(() => [])
      : Promise.resolve([]),
    role === 'teacher' && userId
      ? db.collection('수업_진도').where('teacher_id', '==', userId).limit(300).get().then(_snapToRows).catch(() => [])
      : Promise.resolve([]),
    role === 'teacher' && userId
      ? db.collection('PC_Agent_Status').doc(userId).get().then((d) => (d.exists ? { remote_id: d.id, ...d.data() } : null)).catch(() => null)
      : Promise.resolve(null),
    role === 'teacher' && userId
      ? db.collection('Tasks').where('teacher_id', '==', userId).limit(100).get().then(_snapToRows).catch(() => [])
      : Promise.resolve([]),
    db.collection('Schedules').limit(150).get().then(_snapToRows).catch(() => []),
  ]);

  const effectiveTeacherName = normTeacherParam || (role === 'teacher' && teachersRaw[0] ? _normalizeTeacherName(teachersRaw[0].name || teachersRaw[0].teacher_id || '') : '');
  const comciganSchoolCode = String(
    params.comcigan_school_code ||
    (teachersRaw[0] && teachersRaw[0].comcigan_school_code) ||
    ''
  ).trim();
  const ttTenant = { schoolCode, comciganSchoolCode, schoolName, gradeNum, classNum };
  const ttTeacherTenant = { schoolCode, comciganSchoolCode, schoolName, gradeNum: null, classNum: null };
  const teacherCandidates = _teacherNameCandidates(effectiveTeacherName);
  let timetableBaseRows = timetableBaseClassRows;
  let timetableChangesRows = timetableChangesClassRows;

  if (role === 'teacher' && teacherCandidates.length > 0) {
    const [tBaseByName, tBaseByTeacher, tChgChanged, tChgOrig] = await Promise.all([
      !skipStatic
        ? db.collection('시간표_기본').where('teacher_name', 'in', teacherCandidates).get().then(_snapToRows).catch(() => [])
        : Promise.resolve(undefined),
      !skipStatic
        ? db.collection('시간표_기본').where('teacher', 'in', teacherCandidates).get().then(_snapToRows).catch(() => [])
        : Promise.resolve(undefined),
      db.collection('시간표_변동').where('changed_teacher', 'in', teacherCandidates).get().then(_snapToRows).catch(() => []),
      db.collection('시간표_변동').where('original_teacher', 'in', teacherCandidates).get().then(_snapToRows).catch(() => []),
    ]);
    if (tBaseByName !== undefined || tBaseByTeacher !== undefined) {
      let tBaseExtra = _mergeRowsById(tBaseByName || [], tBaseByTeacher || []);
      if (tBaseExtra.length === 0) {
        const tenantQueries = [
          ['school_code', schoolCode],
          ['comcigan_school_code', comciganSchoolCode],
          ['school_name', schoolName],
        ].filter(([, val]) => Boolean(val));
        for (const [field, val] of tenantQueries) {
          const scopedRows = await db.collection('시간표_기본').where(field, '==', val).limit(500).get().then(_snapToRows).catch(() => []);
          const matched = scopedRows.filter((r) => _rowMatchesTeacher(r, effectiveTeacherName));
          if (matched.length > 0) {
            tBaseExtra = _mergeRowsById(tBaseExtra, matched);
            break;
          }
        }
      }
      timetableBaseRows = _mergeRowsById(timetableBaseClassRows || [], tBaseExtra);
    }
    timetableChangesRows = _mergeRowsById(timetableChangesClassRows || [], tChgChanged, tChgOrig);
  }

  const _matchesTimetableRow = (d) => {
    if (!d || typeof d !== 'object') return false;
    if (role === 'teacher' && effectiveTeacherName) {
      const isTeacherOwned =
        String(d.entry_type || '').trim() === 'teacher' ||
        _rowMatchesTeacher(d, effectiveTeacherName);
      if (isTeacherOwned) {
        return _matchesTenant(d, ttTeacherTenant);
      }
    }
    return _matchesTenant(d, ttTenant);
  };

  const teachersSnap = teachersRaw.filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }));
  const filteredStudents = studentsRows.filter((d) => _matchesTenant(d, tenant));
  const studentIdSet = new Set(filteredStudents.map((s) => String(s.student_id || s.remote_id || '')).filter(Boolean));
  const isTeacherRole = role === 'teacher';
  const filteredNotices = noticesRaw
    .filter((d) => {
      if (!_matchesTenant(d, tenant)) return false;
      if (!isTeacherRole) {
        const isPub = d.is_published === undefined ? true : _toBool(d.is_published);
        if (!isPub) return false;
      }
      return true;
    })
    .map(_withNormalizedNoticeAttachment);
  const noticeIdSet = new Set(filteredNotices.map((n) => String(n.remote_id || '')).filter(Boolean));

  const bundle = {
    ok: true,
    backend: 'firestore',
    server_time: _nowStr(),
    teachers: teachersSnap,
    students: filteredStudents,
    attendance: attendanceRows.map(_withInferredClass).filter((d) => _matchesTenant(d, tenant)),
    doc_tracking: docTrackingRows
      .map(_withInferredClass)
      .filter((d) => _matchesTenant(d, tenant))
      .map((d) => {
        if (!String(d.due_date || '').trim() && d.base_date) {
          return { ...d, due_date: _computeDocDueDate(d.rule_code, d.base_date, docRulesRows) };
        }
        return d;
      }),
    notices: filteredNotices,
    notice_replies: noticeRepliesRaw.filter((r) => {
      if (noticeIdSet.size > 0 && r.notice_id && !noticeIdSet.has(String(r.notice_id))) return false;
      if (studentIdSet.size > 0 && r.student_id && !studentIdSet.has(String(r.student_id))) return false;
      return true;
    }),
    timetable_changes: timetableChangesRows.filter(_matchesTimetableRow),
    chat_messages: chatRows.filter((d) => _matchesTenant(d, tenant)),
    notifications: notificationsRaw.filter((d) => _matchesTenant(d, tenant)),
    budget: budgetRows.filter((d) => _matchesTenant(d, tenant)),
    board_notices: (boardNoticesRows || [])
      .filter((d) => {
        if (!_matchesTenant(d, tenant)) return false;
        if (!isTeacherRole) {
          const isPub = d.is_published === undefined ? true : _toBool(d.is_published);
          if (!isPub) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const pinA = _toBool(a.is_pinned) ? 1 : 0;
        const pinB = _toBool(b.is_pinned) ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        return String(b.published_at || b.created_at || b.updated_at || '').localeCompare(
          String(a.published_at || a.created_at || a.updated_at || '')
        );
      })
  };

  if (timetableBaseRows !== undefined) bundle.timetable_base = timetableBaseRows.filter(_matchesTimetableRow);
  if (mealsRaw !== undefined) bundle.meals = mealsRaw.filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }));
  if (docRulesRows !== undefined) bundle.doc_rules = docRulesRows;
  bundle.schedules = (schedulesRaw || [])
    .filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }))
    .filter((d) => (isTeacherRole ? true : _isPublicAcademicSchedule(d)))
    .sort((a, b) => String(a.start_date || a.date || '').localeCompare(String(b.start_date || b.date || '')));
  if (isTeacherRole) {
    const teacherScope = { teacherId: userId, schoolCode, schoolName };
    bundle.subject_rosters = (subjectRostersRaw || []).filter((d) => _belongsToTeacher(d, teacherScope));
    bundle.subject_attendance = (subjectAttRaw || [])
      .filter((d) => _belongsToTeacher(d, teacherScope))
      .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));
    bundle.lesson_progress = (lessonProgressRaw || [])
      .filter((d) => _belongsToTeacher(d, teacherScope))
      .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));
    const rawPcStatus = pcAgentStatusDoc || (teachersRaw[0] ? {
      pc_online: teachersRaw[0].pc_online,
      pc_last_seen_at: teachersRaw[0].pc_last_seen_at,
      pc_hostname: teachersRaw[0].pc_hostname,
      pc_app_version: teachersRaw[0].pc_app_version,
    } : null);
    bundle.pc_agent_status = {
      pc_online: Boolean(rawPcStatus && _toBool(rawPcStatus.pc_online)),
      pc_last_seen_at: String((rawPcStatus && rawPcStatus.pc_last_seen_at) || ''),
      pc_hostname: String((rawPcStatus && rawPcStatus.pc_hostname) || ''),
      pc_app_version: String((rawPcStatus && rawPcStatus.pc_app_version) || ''),
      is_online: _evaluatePcAgentOnline(rawPcStatus),
    };
    bundle.remote_tasks = (remoteTasksRaw || [])
      .filter((t) => _toBool(t.is_mobile_task) && String(t.teacher_id || '').trim() === userId)
      .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));
  }

  return { status: 200, json: bundle };
}

async function _syncNeisMeals(db, body) {
  let officeCode = String(body.office_code || body.neis_office_code || '').trim();
  let schoolCode = String(body.school_code || body.neis_school_code || '').trim();
  const teacherId = String(body.teacher_id || body.user_id || '').trim();

  if ((!officeCode || !schoolCode) && teacherId) {
    const tDoc = await db.collection('계정_교사').doc(teacherId).get();
    if (tDoc.exists) {
      const t = tDoc.data() || {};
      officeCode = officeCode || String(t.neis_office_code || '').trim();
      schoolCode = schoolCode || String(t.neis_school_code || '').trim();
    }
  }
  if (!officeCode || !schoolCode) {
    const tSnap = await db.collection('계정_교사').limit(1).get();
    if (!tSnap.empty) {
      const t = tSnap.docs[0].data() || {};
      officeCode = officeCode || String(t.neis_office_code || '').trim();
      schoolCode = schoolCode || String(t.neis_school_code || '').trim();
    }
  }
  if (!officeCode || !schoolCode) {
    return { ok: false, error: 'NEIS 교육청 코드 또는 학교 코드가 설정되지 않았습니다. 교사 프로필에서 먼저 입력해 주세요.' };
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fromYmd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const end = new Date(now.getTime() + 6 * 86400000);
  const toYmd = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}`;

  const url = new URL('https://open.neis.go.kr/hub/mealServiceDietInfo');
  url.searchParams.set('Type', 'json');
  url.searchParams.set('pIndex', '1');
  url.searchParams.set('pSize', '50');
  url.searchParams.set('ATPT_OFCDC_SC_CODE', officeCode);
  url.searchParams.set('SD_SCHUL_CODE', schoolCode);
  url.searchParams.set('MLSV_FROM_YMD', fromYmd);
  url.searchParams.set('MLSV_TO_YMD', toYmd);
  if (process.env.NEIS_API_KEY) {
    url.searchParams.set('KEY', process.env.NEIS_API_KEY.trim());
  }

  const resp = await fetch(url.toString());
  const data = await resp.json();
  const blocks = Array.isArray(data.mealServiceDietInfo) ? data.mealServiceDietInfo : [];
  let rawRows = [];
  for (const b of blocks) {
    if (b && Array.isArray(b.row)) {
      rawRows = b.row;
      break;
    }
  }

  const batch = db.batch();
  let count = 0;
  for (const item of rawRows) {
    const ymd = String(item.MLSV_YMD || '').trim();
    const mealDate = ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd;
    const mealType = String(item.MMEAL_SC_NM || '중식').trim();
    const menuText = String(item.DDISH_NM || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\s*\([0-9.]+\)/g, '')
      .trim();
    const rid = `meal_${schoolCode}_${ymd}_${mealType}`;
    batch.set(
      db.collection('급식_식단표').doc(rid),
      {
        remote_id: rid,
        meal_date: mealDate,
        date: mealDate,
        meal_type: mealType,
        menu_text: menuText,
        calories: String(item.CAL_INFO || '').trim(),
        allergy_info: '나이스(NEIS) 식단 연동됨',
        office_code: officeCode,
        school_code: schoolCode,
        updated_at: _nowStr()
      },
      { merge: true }
    );
    count += 1;
  }
  if (count > 0) await batch.commit();
  _invalidateStaticCache('meals:');
  return { ok: true, count, office_code: officeCode, school_code: schoolCode };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const params = _parsePayload(req);
  const action = String(params.action || '').trim();
  if (!action) {
    return res.status(400).json({ ok: false, error: 'action 파라미터가 필요합니다.' });
  }

  try {
    const db = getFirestore();

    if (action === 'login') {
      const result = await _handleLogin(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'change_password') {
      const result = await _handleChangePassword(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'change_custom_id') {
      const result = await _handleChangeCustomId(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'update_my_phone') {
      const result = await _handleUpdateMyPhone(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'register_account') {
      const result = await _handleRegisterAccount(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'get_pending_registrations') {
      const requesterId = String(params.requester_id || params.teacher_id || params.user_id || '').trim();
      const isAdmin = await _isSuperAdmin(db, requesterId);
      const gradeNum = _toIntOrNull(params.grade);
      const classNum = _toIntOrNull(params.class_no);
      const schoolCode = String(params.school_code || '').trim();
      const schoolName = String(params.school_name || '').trim();

      const queries = [
        db.collection('계정_학생').where('status', '==', 'pending').get(),
        db.collection('계정_학부모').where('status', '==', 'pending').get()
      ];
      if (isAdmin) {
        queries.push(db.collection('계정_교사').where('status', '==', 'pending').get());
      }

      const snaps = await Promise.all(queries);
      const items = [];
      snaps[0].forEach((d) => items.push({ remote_id: d.id, role: 'student', ...d.data() }));
      snaps[1].forEach((d) => items.push({ remote_id: d.id, role: 'parent', ...d.data() }));

      const filtered = items.filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum, classNum }));
      if (isAdmin && snaps[2]) {
        snaps[2].forEach((d) => filtered.push({ remote_id: d.id, role: 'teacher', ...d.data() }));
      }
      filtered.forEach((d) => { delete d.password_hash; });
      return res.status(200).json({ ok: true, is_super_admin: isAdmin, items: filtered });
    }

    if (action === 'review_registration') {
      const hasAdminAuth = Boolean(params.auth_teacher_id && (params.auth_password || params.auth_password_hash));
      let adminAuth = null;
      if (hasAdminAuth) {
        adminAuth = await _verifyActiveTeacherAuth(db, params);
        if (!adminAuth.ok) {
          return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
        }
      }
      const requesterId = String((adminAuth && adminAuth.teacherId) || params.requester_id || params.teacher_id || params.user_id || '').trim();
      const targetRole = String(params.target_role || 'student').trim().toLowerCase();
      const rid = String(params.remote_id || '').trim();
      const decision = String(params.decision || 'approve').trim().toLowerCase();

      if (targetRole === 'teacher') {
        const isAdmin = await _isSuperAdmin(db, requesterId);
        if (!isAdmin) {
          return res.status(403).json({
            ok: false,
            error: '신규 교사 가입 승인·반려는 최고 관리자(유우석)만 처리할 수 있습니다.'
          });
        }
      }

      const colName = targetRole === 'parent' ? '계정_학부모' : (targetRole === 'teacher' ? '계정_교사' : '계정_학생');
      if (!rid) return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      if (adminAuth && targetRole !== 'teacher') {
        const targetSnap = await db.collection(colName).doc(rid).get();
        if (!targetSnap.exists) {
          return res.status(404).json({ ok: false, error: '대상 계정을 찾을 수 없습니다.' });
        }
        if (!_isStrictClassMember({ remote_id: targetSnap.id, ...(targetSnap.data() || {}) }, adminAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 학생·학부모 가입 요청만 처리할 수 있습니다.' });
        }
      }
      await db.collection(colName).doc(rid).set(
        { status: decision === 'approve' ? 'active' : 'rejected', updated_at: _nowStr() },
        { merge: true }
      );
      return res.status(200).json({ ok: true, status: decision === 'approve' ? 'active' : 'rejected' });
    }

    if (action === 'get_mobile_bundle') {
      const result = await _handleGetMobileBundle(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'mark_notification_read') {
      const rid = String(params.remote_id || '').trim();
      if (rid) {
        await db.collection('Notifications').doc(rid).set({ remote_id: rid, is_read: true, updated_at: _nowStr() }, { merge: true });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'save_push_subscription') {
      const endpoint = String(params.endpoint || '').trim();
      if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint가 필요합니다.' });
      const docId = crypto.createHash('sha1').update(endpoint).digest('hex').slice(0, 24);
      await db.collection('Push_Subscriptions').doc(docId).set(
        {
          remote_id: docId,
          endpoint,
          p256dh: String(params.p256dh || ''),
          auth: String(params.auth || ''),
          role: String(params.role || 'student').toLowerCase(),
          user_id: String(params.user_id || ''),
          student_id: String(params.student_id || ''),
          grade: _toIntOrNull(params.grade),
          class_no: _toIntOrNull(params.class_no),
          updated_at: _nowStr()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, remote_id: docId });
    }

    if (action === 'submit_attendance') {
      const rid = String(params.remote_id || '').trim() || `att_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const attDate = String(params.date || new Date().toISOString().slice(0, 10));
      const sid = String(params.student_id || '').trim();
      const actorRole = String(params.role || '').trim().toLowerCase();
      const hasTeacherAuth = Boolean(params.auth_teacher_id || params.auth_password || params.auth_password_hash);
      let teacherAuth = null;
      if (actorRole === 'teacher' || hasTeacherAuth) {
        teacherAuth = await _verifyActiveTeacherAuth(db, params);
        if (!teacherAuth.ok) {
          return res.status(teacherAuth.status || 401).json({ ok: false, error: teacherAuth.error });
        }
        if (params.remote_id) {
          const existingDoc = await db.collection('일일_출결').doc(rid).get();
          if (existingDoc.exists && !_isStrictClassMember({ remote_id: existingDoc.id, ...(existingDoc.data() || {}) }, teacherAuth)) {
            return res.status(403).json({ ok: false, error: '담당 학급의 출결 내역만 수정할 수 있습니다.' });
          }
        }
      } else {
        const confirmedMsg = '이미 담임 선생님이 확인한 출결 내역이 있어 새로 등록하거나 수정할 수 없습니다.';
        if (params.remote_id) {
          const existingDoc = await db.collection('일일_출결').doc(rid).get();
          if (existingDoc.exists && _toBool((existingDoc.data() || {}).teacher_confirmed)) {
            return res.status(200).json({ ok: false, error: confirmedMsg });
          }
        }
        if (sid) {
          const sameDaySnap = await db.collection('일일_출결')
            .where('date', '==', attDate)
            .where('student_id', '==', sid)
            .get();
          let hasConfirmed = false;
          sameDaySnap.forEach((d) => {
            if (_toBool((d.data() || {}).teacher_confirmed)) hasConfirmed = true;
          });
          if (hasConfirmed) {
            return res.status(200).json({ ok: false, error: confirmedMsg });
          }
        }
      }
      let resolvedGrade = _toIntOrNull(params.grade ?? (teacherAuth ? teacherAuth.gradeNum : null));
      let resolvedClassNo = _toIntOrNull(params.class_no ?? (teacherAuth ? teacherAuth.classNum : null));
      let resolvedSchoolCode = String(params.school_code || params.neis_school_code || (teacherAuth ? teacherAuth.schoolCode : '') || '').trim();
      let resolvedSchoolName = String(params.school_name || (teacherAuth ? teacherAuth.schoolName : '') || '').trim();
      let resolvedStudentName = String(params.student_name || '').trim();
      if (sid && (resolvedGrade === null || resolvedClassNo === null || !resolvedSchoolCode || !resolvedStudentName)) {
        const stuDocId = resolvedSchoolCode ? `${resolvedSchoolCode}_${sid}` : sid;
        const stuSnap = await db.collection('계정_학생').doc(stuDocId).get();
        let stuData = stuSnap.exists ? (stuSnap.data() || {}) : null;
        if (!stuData) {
          const qSnap = await db.collection('계정_학생').where('student_id', '==', sid).limit(5).get();
          qSnap.forEach((d) => {
            const candidate = d.data() || {};
            if (!stuData) stuData = candidate;
            if (teacherAuth && _isStrictClassMember({ remote_id: d.id, ...candidate }, teacherAuth)) {
              stuData = candidate;
            }
          });
        }
        if (stuData) {
          if (resolvedGrade === null) resolvedGrade = _toIntOrNull(stuData.grade);
          if (resolvedClassNo === null) resolvedClassNo = _toIntOrNull(stuData.class_no);
          if (!resolvedSchoolCode) resolvedSchoolCode = String(stuData.school_code || stuData.neis_school_code || '').trim();
          if (!resolvedSchoolName) resolvedSchoolName = String(stuData.school_name || '').trim();
          if (!resolvedStudentName) resolvedStudentName = String(stuData.name || stuData.student_name || '').trim();
        }
        if (resolvedGrade === null || resolvedClassNo === null) {
          const inf = _inferGradeClassFromStudentId(sid);
          if (resolvedGrade === null) resolvedGrade = inf.grade;
          if (resolvedClassNo === null) resolvedClassNo = inf.class_no;
        }
      }
      if (teacherAuth && !_isStrictClassMember({
        student_id: sid,
        grade: resolvedGrade,
        class_no: resolvedClassNo,
        school_code: resolvedSchoolCode,
        school_name: resolvedSchoolName,
      }, teacherAuth)) {
        return res.status(403).json({ ok: false, error: '담당 학급의 학생 출결만 등록·수정할 수 있습니다.' });
      }
      await db.collection('일일_출결').doc(rid).set(
        {
          remote_id: rid,
          date: attDate,
          student_id: sid,
          student_name: resolvedStudentName,
          school_code: resolvedSchoolCode,
          school_name: resolvedSchoolName,
          grade: resolvedGrade,
          class_no: resolvedClassNo,
          attendance_type: String(params.attendance_type || ''),
          att_category: String(params.att_category || ''),
          att_sub_type: String(params.att_sub_type || ''),
          period_info: String(params.period_info || ''),
          reason: String(params.reason || ''),
          teacher_confirmed: _toBool(params.teacher_confirmed),
          updated_at: _nowStr()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'delete_attendance') {
      const rid = String(params.remote_id || '').trim();
      if (!rid) return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      const actorRole = String(params.role || '').trim().toLowerCase();
      const hasTeacherAuth = Boolean(params.auth_teacher_id || params.auth_password || params.auth_password_hash);
      const existingDoc = await db.collection('일일_출결').doc(rid).get();
      if (actorRole === 'teacher' || hasTeacherAuth) {
        const adminAuth = await _verifyActiveTeacherAuth(db, params);
        if (!adminAuth.ok) {
          return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
        }
        if (existingDoc.exists && !_isStrictClassMember({ remote_id: existingDoc.id, ...(existingDoc.data() || {}) }, adminAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 출결 내역만 삭제할 수 있습니다.' });
        }
      } else {
        if (existingDoc.exists && _toBool((existingDoc.data() || {}).teacher_confirmed)) {
          return res.status(200).json({ ok: false, error: '이미 담임 선생님이 확인한 출결 내역이 있어 새로 등록하거나 수정할 수 없습니다.' });
        }
      }
      await db.collection('일일_출결').doc(rid).delete();
      return res.status(200).json({ ok: true, deleted_id: rid });
    }

    if (action === 'delete_attendance_batch') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const rawIds = Array.isArray(params.remote_ids) ? params.remote_ids : [];
      const ids = rawIds.map(id => String(id || '').trim()).filter(Boolean);
      if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: 'remote_ids 배열이 필요합니다.' });
      }
      const snaps = await Promise.all(ids.map((rid) => db.collection('일일_출결').doc(rid).get()));
      for (const s of snaps) {
        if (s.exists && !_isStrictClassMember({ remote_id: s.id, ...(s.data() || {}) }, adminAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 출결 내역만 일괄 삭제할 수 있습니다.' });
        }
      }
      const batch = db.batch();
      ids.forEach(rid => {
        batch.delete(db.collection('일일_출결').doc(rid));
      });
      await batch.commit();
      return res.status(200).json({ ok: true, deleted_count: ids.length, deleted_ids: ids });
    }

    if (action === 'confirm_attendance') {
      const rid = String(params.remote_id || '').trim();
      if (!rid) return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      if (params.auth_teacher_id && (params.auth_password || params.auth_password_hash)) {
        const adminAuth = await _verifyActiveTeacherAuth(db, params);
        if (!adminAuth.ok) {
          return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
        }
        const attSnap = await db.collection('일일_출결').doc(rid).get();
        if (attSnap.exists && !_isStrictClassMember({ remote_id: attSnap.id, ...(attSnap.data() || {}) }, adminAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 출결 내역만 확인할 수 있습니다.' });
        }
      }
      await db.collection('일일_출결').doc(rid).set({ remote_id: rid, teacher_confirmed: true, updated_at: _nowStr() }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (action === 'save_class_attendance') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      if (adminAuth.gradeNum === null || adminAuth.classNum === null) {
        return res.status(403).json({ ok: false, error: '담당 학년·반이 지정된 교사만 학급 출결을 저장할 수 있습니다.' });
      }
      const records = Array.isArray(params.records) ? params.records : [];
      for (const rec of records) {
        const sid = String((rec && rec.student_id) || '').trim();
        if (!sid) continue;
        const recScope = {
          student_id: sid,
          grade: _toIntOrNull(rec.grade ?? params.grade ?? adminAuth.gradeNum),
          class_no: _toIntOrNull(rec.class_no ?? params.class_no ?? adminAuth.classNum),
          school_code: String(rec.school_code || params.school_code || adminAuth.schoolCode || ''),
          school_name: String(rec.school_name || params.school_name || adminAuth.schoolName || ''),
        };
        if (!_isStrictClassMember(recScope, adminAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 학생 출결만 일괄 저장할 수 있습니다.' });
        }
      }
      const dateStr = String(params.date || new Date().toISOString().slice(0, 10));
      const batch = db.batch();
      for (const rec of records) {
        const sid = String(rec.student_id || '').trim();
        if (!sid) continue;
        const rid = String(rec.remote_id || `att_${dateStr.replace(/-/g, '')}_${sid}`);
        batch.set(
          db.collection('일일_출결').doc(rid),
          {
            remote_id: rid,
            date: dateStr,
            student_id: sid,
            student_name: String(rec.student_name || ''),
            school_code: adminAuth.schoolCode,
            school_name: adminAuth.schoolName,
            grade: adminAuth.gradeNum,
            class_no: adminAuth.classNum,
            attendance_type: String(rec.attendance_type || '출석'),
            reason: String(rec.reason || ''),
            teacher_confirmed: true,
            updated_at: _nowStr()
          },
          { merge: true }
        );
      }
      if (records.length > 0) await batch.commit();
      return res.status(200).json({ ok: true, count: records.length });
    }

    if (action === 'upsert_document_tracking' || action === 'mark_document_submitted' || action === 'confirm_document') {
      const actorRole = String(params.role || '').trim().toLowerCase();
      const hasTeacherAuth = Boolean(params.auth_teacher_id || params.auth_password || params.auth_password_hash);
      let teacherAuth = null;
      if ((action === 'confirm_document' && hasTeacherAuth) || (action === 'upsert_document_tracking' && (actorRole === 'teacher' || hasTeacherAuth))) {
        teacherAuth = await _verifyActiveTeacherAuth(db, params);
        if (!teacherAuth.ok) {
          return res.status(teacherAuth.status || 401).json({ ok: false, error: teacherAuth.error });
        }
        const checkRid = String(params.remote_id || '').trim();
        if (checkRid) {
          const docCheck = await db.collection('서류_추적').doc(checkRid).get();
          if (docCheck.exists && !_isStrictClassMember({ remote_id: docCheck.id, ...(docCheck.data() || {}) }, teacherAuth)) {
            return res.status(403).json({ ok: false, error: '담당 학급의 서류 추적 내역만 처리할 수 있습니다.' });
          }
        }
      }
      const rid = String(params.remote_id || `doc_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      const update = { remote_id: rid, updated_at: _nowStr() };
      const inferred = _inferGradeClassFromStudentId(params.student_id);
      const resolvedGrade = _toIntOrNull(params.grade) ?? inferred.grade;
      const resolvedClassNo = _toIntOrNull(params.class_no) ?? inferred.class_no;
      let responseDueDate = '';
      if (action === 'mark_document_submitted') {
        update.status = 'submitted';
        update.submitted_at = _nowStr();
        if (params.attachment_url) update.attachment_url = String(params.attachment_url);
        if (resolvedGrade !== null) update.grade = resolvedGrade;
        if (resolvedClassNo !== null) update.class_no = resolvedClassNo;
      } else if (action === 'confirm_document') {
        const reqStatus = String(params.status || '').trim().toLowerCase();
        if (reqStatus === '미제출' || reqStatus === 'pending') {
          update.status = 'pending';
          update.teacher_confirmed = false;
        } else {
          update.status = 'closed';
          update.teacher_confirmed = true;
          let targetSid = String(params.student_id || '').trim();
          if (!targetSid) {
            const docSnap = await db.collection('서류_추적').doc(rid).get();
            if (docSnap.exists) targetSid = String((docSnap.data() || {}).student_id || '').trim();
          }
          if (targetSid) {
            const notifSnap = await db.collection('Notifications')
              .where('channel', '==', 'doc_reminder')
              .where('is_read', '==', false)
              .limit(50)
              .get();
            const batch = db.batch();
            let hasNotifUpdates = false;
            notifSnap.forEach((nDoc) => {
              const nd = nDoc.data() || {};
              if (String(nd.target_student_id || '').trim() === targetSid) {
                batch.set(nDoc.ref, { is_read: true, updated_at: _nowStr() }, { merge: true });
                hasNotifUpdates = true;
              }
            });
            if (hasNotifUpdates) await batch.commit();
          }
        }
      } else {
        const ruleCode = String(params.rule_code || 'ABSENCE_REPORT');
        const baseDate = String(params.base_date || '');
        let dueDate = String(params.due_date || '').trim();
        if (!dueDate && baseDate) {
          const rulesSnap = await db.collection('설정_서류규정').limit(50).get();
          dueDate = _computeDocDueDate(ruleCode, baseDate, _snapToRows(rulesSnap));
        }
        responseDueDate = dueDate;
        const targetGrade = resolvedGrade ?? (teacherAuth ? teacherAuth.gradeNum : null);
        const targetClassNo = resolvedClassNo ?? (teacherAuth ? teacherAuth.classNum : null);
        const targetSchoolCode = String(params.school_code || (teacherAuth ? teacherAuth.schoolCode : '') || '').trim();
        const targetSchoolName = String(params.school_name || (teacherAuth ? teacherAuth.schoolName : '') || '').trim();
        if (teacherAuth && !_isStrictClassMember({
          student_id: String(params.student_id || ''),
          grade: targetGrade,
          class_no: targetClassNo,
          school_code: targetSchoolCode,
          school_name: targetSchoolName,
        }, teacherAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 서류 추적 내역만 등록·수정할 수 있습니다.' });
        }
        Object.assign(update, {
          student_id: String(params.student_id || ''),
          student_name: String(params.student_name || ''),
          grade: targetGrade,
          class_no: targetClassNo,
          school_code: targetSchoolCode,
          school_name: targetSchoolName,
          rule_code: ruleCode,
          doc_type: String(params.doc_type || ''),
          doc_name: String(params.doc_name || params.doc_type || ''),
          base_date: baseDate,
          due_date: dueDate,
          memo: String(params.memo || ''),
          status: String(params.status || 'pending'),
          attachment_url: String(params.attachment_url || '')
        });
      }
      await db.collection('서류_추적').doc(rid).set(update, { merge: true });
      return res.status(200).json({ ok: true, remote_id: rid, ...(responseDueDate ? { due_date: responseDueDate } : {}) });
    }

    if (action === 'delete_document_tracking') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const rid = String(params.remote_id || '').trim();
      if (!rid) return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      const docRef = db.collection('서류_추적').doc(rid);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ ok: false, error: '해당 서류 추적 내역을 찾을 수 없습니다.' });
      }
      if (!_isStrictClassMember({ remote_id: snap.id, ...(snap.data() || {}) }, adminAuth)) {
        return res.status(403).json({ ok: false, error: '담당 학급의 서류 추적 내역만 삭제할 수 있습니다.' });
      }
      await docRef.delete();
      return res.status(200).json({ ok: true, deleted_id: rid });
    }

    if (action === 'upsert_doc_rule') {
      const rid = String(params.remote_id || params.rule_code || `rule_${Date.now()}`);
      const ruleDoc = {
        remote_id: rid,
        rule_code: String(params.rule_code || rid),
        title: String(params.title || ''),
        due_business_days: _toIntOrNull(params.due_business_days),
        is_active: params.is_active === undefined ? true : _toBool(params.is_active),
        updated_at: _nowStr()
      };
      if (Array.isArray(params.required_types)) {
        ruleDoc.required_types = params.required_types.map(v => String(v));
      }
      await db.collection('설정_서류규정').doc(rid).set(ruleDoc, { merge: true });
      _invalidateStaticCache('doc_rules');
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'upload_file') {
      const driveRes = await uploadBase64ToDrive({
        base64Data: params.file_base64 || params.attachment_base64 || params.base64,
        fileName: String(params.file_name || `eduflow_${Date.now()}.bin`),
        mimeType: String(params.mime_type || 'application/octet-stream'),
        folderName: String(params.folder_name || 'EduFlow_Uploads')
      });
      return res.status(driveRes.ok ? 200 : 502).json(driveRes);
    }

    if (action === 'upsert_notice') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const rid = String(params.remote_id || `noti_doc_${Date.now()}`);
      const docRef = db.collection('가정통신문_목록').doc(rid);
      const existingSnap = params.remote_id ? await docRef.get() : null;
      const existing = existingSnap && existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;
      if (existing && !_matchesTeacherClassOrAuthor(existing, adminAuth)) {
        return res.status(403).json({ ok: false, error: '본인 학급 또는 본인이 작성한 가정통신문만 수정할 수 있습니다.' });
      }
      let attachmentUrl = _resolveNoticeAttachmentUrl(params);
      if (!attachmentUrl && params.attachment_base64) {
        const driveRes = await uploadBase64ToDrive({
          base64Data: params.attachment_base64,
          fileName: String(params.attachment_name || `notice_${rid}.pdf`),
          mimeType: String(params.attachment_mime || 'application/pdf'),
          folderName: 'EduFlow_Notices'
        });
        if (driveRes.ok) {
          attachmentUrl = _normalizeNoticeDriveUrl(driveRes.webViewLink || driveRes.downloadUrl);
        }
      }
      const isPublished = params.is_published === undefined ? true : _toBool(params.is_published);
      const signatureMode = String(params.signature_mode || '').trim().toLowerCase() === 'both' ? 'both' : 'single';
      const nowStr = _nowStr();
      const noticePayload = {
        remote_id: rid,
        title: String(params.title || ''),
        category: String(params.category || '가정통신문'),
        content: String(params.content || ''),
        target_grade: _toIntOrNull(params.target_grade ?? params.grade ?? (existing && existing.target_grade) ?? adminAuth.gradeNum),
        target_class: _toIntOrNull(params.target_class ?? params.class_no ?? (existing && existing.target_class) ?? adminAuth.classNum),
        school_code: String(params.school_code || (existing && existing.school_code) || adminAuth.schoolCode || ''),
        school_name: String(params.school_name || (existing && existing.school_name) || adminAuth.schoolName || ''),
        due_date: String(params.due_date || ''),
        teacher_id: String((existing && existing.teacher_id) || adminAuth.teacherId || ''),
        author_name: String(params.author_name || (existing && existing.author_name) || (adminAuth.teacherDoc && adminAuth.teacherDoc.name) || '담임교사'),
        attachment_url: attachmentUrl,
        requires_reply: params.requires_reply === undefined ? true : _toBool(params.requires_reply),
        signature_mode: signatureMode,
        is_published: isPublished,
        created_at: String((existing && existing.created_at) || nowStr),
        updated_at: nowStr
      };
      if (params.reply_schema_json !== undefined) {
        noticePayload.reply_schema_json = typeof params.reply_schema_json === 'string'
          ? params.reply_schema_json
          : JSON.stringify(params.reply_schema_json || []);
      }
      if (isPublished) {
        noticePayload.published_at = String((existing && existing.published_at) || nowStr);
      }
      await docRef.set(noticePayload, { merge: true });
      if (isPublished && params.create_notification !== false && !existing) {
        await _createNoticePublishedNotification(db, noticePayload);
      }
      return res.status(200).json({ ok: true, remote_id: rid, attachment_url: attachmentUrl, is_published: isPublished, signature_mode: signatureMode });
    }

    if (action === 'publish_notice') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const rid = String(params.remote_id || params.notice_id || '').trim();
      if (!rid) {
        return res.status(400).json({ ok: false, error: 'remote_id 또는 notice_id가 필요합니다.' });
      }
      const docRef = db.collection('가정통신문_목록').doc(rid);
      const existingSnap = await docRef.get();
      const existing = existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : {};
      if (existingSnap.exists && !_matchesTeacherClassOrAuthor(existing, adminAuth)) {
        return res.status(403).json({ ok: false, error: '본인 학급 또는 본인이 작성한 가정통신문만 게시·수정할 수 있습니다.' });
      }
      const nowStr = _nowStr();
      const rawSigMode = params.signature_mode !== undefined ? params.signature_mode : existing.signature_mode;
      const signatureMode = String(rawSigMode || '').trim().toLowerCase() === 'both' ? 'both' : 'single';
      const mergedPayload = {
        remote_id: rid,
        title: String(params.title !== undefined ? params.title : (existing.title || '')).trim(),
        category: String(params.category !== undefined ? params.category : (existing.category || '가정통신문')).trim(),
        content: String(params.content !== undefined ? params.content : (existing.content || '')).trim(),
        due_date: String(params.due_date !== undefined ? params.due_date : (existing.due_date || '')).trim(),
        target_grade: _toIntOrNull(params.target_grade ?? params.grade ?? existing.target_grade ?? adminAuth.gradeNum),
        target_class: _toIntOrNull(params.target_class ?? params.class_no ?? existing.target_class ?? adminAuth.classNum),
        school_code: String(params.school_code !== undefined ? params.school_code : (existing.school_code || adminAuth.schoolCode || '')).trim(),
        school_name: String(params.school_name !== undefined ? params.school_name : (existing.school_name || adminAuth.schoolName || '')).trim(),
        teacher_id: String(existing.teacher_id || adminAuth.teacherId || '').trim(),
        author_name: String(params.author_name !== undefined ? params.author_name : (existing.author_name || (adminAuth.teacherDoc && adminAuth.teacherDoc.name) || '담임교사')).trim(),
        attachment_url: _resolveNoticeAttachmentUrl(params) || _resolveNoticeAttachmentUrl(existing) || '',
        requires_reply: params.requires_reply !== undefined
          ? _toBool(params.requires_reply)
          : (existing.requires_reply === undefined ? true : _toBool(existing.requires_reply)),
        signature_mode: signatureMode,
        is_published: true,
        published_at: existing.published_at || nowStr,
        updated_at: nowStr
      };
      if (params.reply_schema_json !== undefined) {
        mergedPayload.reply_schema_json = typeof params.reply_schema_json === 'string'
          ? params.reply_schema_json
          : JSON.stringify(params.reply_schema_json || []);
      }
      await docRef.set(mergedPayload, { merge: true });
      const notificationId = await _createNoticePublishedNotification(db, mergedPayload);
      return res.status(200).json({
        ok: true,
        remote_id: rid,
        is_published: true,
        signature_mode: signatureMode,
        notification_id: notificationId,
        updated_at: nowStr
      });
    }

    if (action === 'submit_notice_reply') {
      const noticeId = String(params.notice_id || '').trim();
      const studentId = String(params.student_id || '').trim();
      if (!noticeId || !studentId) {
        return res.status(400).json({ ok: false, error: 'notice_id와 student_id가 필요합니다.' });
      }
      const rid = `${noticeId}_${studentId}`;
      const replyRef = db.collection('가정통신문_회신').doc(rid);
      const existingReply = await replyRef.get();
      if (existingReply.exists) {
        return res.status(409).json({
          ok: false,
          already_submitted: true,
          remote_id: rid,
          error: '이미 제출 완료된 가정통신문입니다.'
        });
      }
      const studentName = String(params.student_name || '').trim();
      const sanitizeSeg = (val, fallback = '') => String(val ?? '').trim().replace(/[\\/:*?"<>|]/g, '_') || fallback;
      const noticeSnap = await db.collection('가정통신문_목록').doc(noticeId).get();
      const noticeData = noticeSnap.exists ? (noticeSnap.data() || {}) : {};
      const schoolName = sanitizeSeg(noticeData.school_name || params.school_name, '학교미지정');
      const targetGrade = _toIntOrNull(noticeData.target_grade ?? noticeData.grade ?? params.grade);
      const targetClass = _toIntOrNull(noticeData.target_class ?? noticeData.class_no ?? params.class_no);
      const gradeClassLabel = `${targetGrade !== null ? targetGrade : '0'}학년${targetClass !== null ? targetClass : '0'}반`;
      const teacherName = sanitizeSeg(noticeData.author_name || params.author_name, '담임교사');
      const noticeTitle = sanitizeSeg(noticeData.title || params.notice_title, '가정통신문');
      const safeNoticeId = sanitizeSeg(noticeId, 'notice');
      const safeStudentName = sanitizeSeg(studentName, '학생');
      const safeStudentId = sanitizeSeg(studentId, 'student');
      const driveFolderPath = `가정통신문_회신/${schoolName}_${gradeClassLabel}_${teacherName}/${noticeTitle}_${safeNoticeId}`;
      const baseFileName = `${safeStudentId}_${safeStudentName}`;

      let sigDriveUrl = String(params.signature_drive_url || '').trim();
      let sigFileId = String(params.signature_file_id || '').trim();
      if (sigDriveUrl.startsWith('data:')) {
        sigDriveUrl = '';
      }
      const parentSigBase64 = params.parent_signature_base64 || params.signature_base64 || '';
      if (parentSigBase64) {
        const driveRes = await uploadBase64ToDrive({
          base64Data: parentSigBase64,
          fileName: `${baseFileName}.png`,
          mimeType: 'image/png',
          folderName: driveFolderPath
        });
        if (!driveRes.ok || !driveRes.downloadUrl || !driveRes.fileId) {
          return res.status(502).json({
            ok: false,
            error: `Google Drive 서명 이미지 업로드 실패: ${driveRes.error || 'Drive URL 또는 fileId를 받지 못했습니다.'}`
          });
        }
        sigDriveUrl = driveRes.downloadUrl;
        sigFileId = driveRes.fileId;
      }

      let studentSigDriveUrl = String(params.student_signature_drive_url || '').trim();
      let studentSigFileId = String(params.student_signature_file_id || '').trim();
      if (studentSigDriveUrl.startsWith('data:')) {
        studentSigDriveUrl = '';
      }
      if (params.student_signature_base64) {
        const stuDriveRes = await uploadBase64ToDrive({
          base64Data: params.student_signature_base64,
          fileName: `${baseFileName}_student.png`,
          mimeType: 'image/png',
          folderName: driveFolderPath
        });
        if (!stuDriveRes.ok || !stuDriveRes.downloadUrl || !stuDriveRes.fileId) {
          return res.status(502).json({
            ok: false,
            error: `Google Drive 학생 서명 이미지 업로드 실패: ${stuDriveRes.error || 'Drive URL 또는 fileId를 받지 못했습니다.'}`
          });
        }
        studentSigDriveUrl = stuDriveRes.downloadUrl;
        studentSigFileId = stuDriveRes.fileId;
      }

      let replyFileDriveUrl = String(params.reply_file_drive_url || '').trim();
      let replyFileId = String(params.reply_file_id || '').trim();
      if (params.reply_file_base64) {
        const replyFileName = String(params.reply_file_name || `${baseFileName}_reply.pdf`).replace(/[\\/:*?"<>|]/g, '_');
        const fileRes = await uploadBase64ToDrive({
          base64Data: params.reply_file_base64,
          fileName: `${baseFileName}_${replyFileName}`,
          mimeType: String(params.reply_file_mime || 'application/pdf'),
          folderName: driveFolderPath
        });
        if (!fileRes.ok || !fileRes.downloadUrl || !fileRes.fileId) {
          return res.status(502).json({
            ok: false,
            error: `Google Drive 응답 파일 업로드 실패: ${fileRes.error || 'Drive URL 또는 fileId를 받지 못했습니다.'}`
          });
        }
        replyFileDriveUrl = fileRes.downloadUrl;
        replyFileId = fileRes.fileId;
      }

      const nowStr = _nowStr();
      const consentVal = String(params.consent || params.reply_choice || '').trim();
      const replyDataJson = typeof params.reply_data_json === 'string'
        ? params.reply_data_json
        : JSON.stringify(params.reply_data_json || params.reply_data || {});
      const signedAt = String(params.signed_at || nowStr);
      const signatureMode = String(params.signature_mode || noticeData.signature_mode || '').trim().toLowerCase() === 'both' ? 'both' : 'single';
      const replyDoc = {
        remote_id: rid,
        notice_id: noticeId,
        student_id: studentId,
        student_name: studentName,
        parent_id: String(params.parent_id || ''),
        parent_name: String(params.parent_name || ''),
        signature_mode: signatureMode,
        consent: consentVal,
        reply_choice: consentVal || '제출',
        reply_data_json: replyDataJson,
        signature_drive_url: sigDriveUrl,
        signature_file_id: sigFileId,
        student_signature_drive_url: studentSigDriveUrl,
        student_signature_file_id: studentSigFileId,
        memo: String(params.memo || ''),
        signed_at: signedAt,
        submitted_at: nowStr,
        updated_at: nowStr
      };
      if (replyFileDriveUrl || replyFileId) {
        replyDoc.reply_file_drive_url = replyFileDriveUrl;
        replyDoc.reply_file_id = replyFileId;
      }
      await replyRef.set(replyDoc, { merge: true });
      return res.status(200).json({
        ok: true,
        remote_id: rid,
        signature_mode: signatureMode,
        signature_drive_url: sigDriveUrl,
        signature_file_id: sigFileId,
        student_signature_drive_url: studentSigDriveUrl,
        student_signature_file_id: studentSigFileId,
        reply_file_drive_url: replyFileDriveUrl || undefined,
        reply_file_id: replyFileId || undefined,
        signed_at: signedAt
      });
    }

    if (action === 'send_chat_message') {
      const senderRole = String(params.sender_role || 'student').trim().toLowerCase();
      const hasTeacherAuth = Boolean(params.auth_teacher_id || params.auth_password || params.auth_password_hash);
      const roomId = String(params.room_id || `ROOM-${params.student_id || 'DEFAULT'}`).trim();
      const inferredSid = String(params.student_id || params.receiver_id || (roomId.startsWith('ROOM-') ? roomId.slice(5) : '')).trim();
      let teacherAuth = null;
      if (senderRole === 'teacher' || hasTeacherAuth) {
        teacherAuth = await _verifyActiveTeacherAuth(db, params);
        if (!teacherAuth.ok) {
          return res.status(teacherAuth.status || 401).json({ ok: false, error: teacherAuth.error });
        }
        const targetScope = {
          student_id: inferredSid,
          grade: _toIntOrNull(params.grade ?? teacherAuth.gradeNum),
          class_no: _toIntOrNull(params.class_no ?? teacherAuth.classNum),
          school_code: String(params.school_code || teacherAuth.schoolCode || ''),
          school_name: String(params.school_name || teacherAuth.schoolName || ''),
        };
        if (!_isStrictClassMember(targetScope, teacherAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급 학생에게만 1:1 상담 메시지를 보낼 수 있습니다.' });
        }
      }
      const rid = String(params.remote_id || `chat_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      const nowStr = _nowStr();
      const chatDoc = {
        remote_id: rid,
        room_id: roomId,
        student_id: inferredSid,
        grade: _toIntOrNull(params.grade ?? (teacherAuth ? teacherAuth.gradeNum : null)),
        class_no: _toIntOrNull(params.class_no ?? (teacherAuth ? teacherAuth.classNum : null)),
        school_code: String(params.school_code || (teacherAuth ? teacherAuth.schoolCode : '') || ''),
        school_name: String(params.school_name || (teacherAuth ? teacherAuth.schoolName : '') || ''),
        sender_role: senderRole || 'student',
        sender_name: String(params.sender_name || (teacherAuth && teacherAuth.teacherDoc && teacherAuth.teacherDoc.name) || ''),
        message: String(params.message || ''),
        is_read: false,
        created_at: nowStr,
        updated_at: nowStr
      };
      if (teacherAuth) chatDoc.teacher_id = teacherAuth.teacherId;
      await db.collection('1:1_상담채팅').doc(rid).set(chatDoc, { merge: true });
      return res.status(200).json({ ok: true, remote_id: rid, item: chatDoc });
    }

    if (action === 'mark_chat_read') {
      const roomId = String(params.room_id || '').trim();
      const readerRole = String(params.reader_role || 'teacher').trim().toLowerCase();
      const hasTeacherAuth = Boolean(params.auth_teacher_id || params.auth_password || params.auth_password_hash);
      let teacherAuth = null;
      if (readerRole === 'teacher' || hasTeacherAuth) {
        teacherAuth = await _verifyActiveTeacherAuth(db, params);
        if (!teacherAuth.ok) {
          return res.status(teacherAuth.status || 401).json({ ok: false, error: teacherAuth.error });
        }
        const inferredSid = roomId.startsWith('ROOM-') ? roomId.slice(5).trim() : String(params.student_id || '').trim();
        if (inferredSid && !_isStrictClassMember({
          student_id: inferredSid,
          grade: _toIntOrNull(params.grade ?? teacherAuth.gradeNum),
          class_no: _toIntOrNull(params.class_no ?? teacherAuth.classNum),
          school_code: teacherAuth.schoolCode,
          school_name: teacherAuth.schoolName,
        }, teacherAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 상담 채팅만 읽음 처리할 수 있습니다.' });
        }
      }
      if (roomId) {
        const snap = await db.collection('1:1_상담채팅').where('room_id', '==', roomId).get();
        const batch = db.batch();
        let cnt = 0;
        snap.forEach((doc) => {
          const d = doc.data() || {};
          if (teacherAuth && !_isStrictClassMember({ remote_id: doc.id, ...d }, teacherAuth)) {
            return;
          }
          if (d.sender_role !== readerRole && !_toBool(d.is_read)) {
            batch.set(doc.ref, { is_read: true, updated_at: _nowStr() }, { merge: true });
            cnt += 1;
          }
        });
        if (cnt > 0) await batch.commit();
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'set_consultation_status' || action === 'upsert_teacher_profile') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const tid = String(params.teacher_id || params.remote_id || adminAuth.teacherId || '').trim();
      if (!tid) return res.status(400).json({ ok: false, error: 'teacher_id가 필요합니다.' });
      if (tid !== adminAuth.teacherId) {
        return res.status(403).json({ ok: false, error: '본인 교사 계정의 설정만 수정할 수 있습니다.' });
      }
      const data = { remote_id: tid, teacher_id: tid, updated_at: _nowStr() };
      if (action === 'set_consultation_status') {
        data.consultation_enabled = _toBool(params.consultation_enabled ?? params.enabled);
      } else {
        if (params.name !== undefined) data.name = String(params.name);
        if (params.school_name !== undefined) data.school_name = String(params.school_name);
        if (params.grade !== undefined) data.grade = _toIntOrNull(params.grade);
        if (params.class_no !== undefined) data.class_no = _toIntOrNull(params.class_no);
        if (params.subject !== undefined) data.subject = String(params.subject);
        if (params.phone !== undefined) data.phone = String(params.phone);
        if (params.consultation_hours !== undefined) data.consultation_hours = String(params.consultation_hours);
        if (params.neis_office_code !== undefined) data.neis_office_code = String(params.neis_office_code);
        if (params.neis_school_code !== undefined) data.neis_school_code = String(params.neis_school_code);
        if (params.school_code !== undefined) data.school_code = String(params.school_code);
        if (params.comcigan_school_code !== undefined) data.comcigan_school_code = String(params.comcigan_school_code);
      }
      await db.collection('계정_교사').doc(tid).set(data, { merge: true });
      _invalidateStaticCache('teacher');
      return res.status(200).json({ ok: true, remote_id: tid });
    }

    if (action === 'send_notification') {
      const rid = String(params.remote_id || `noti_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      await db.collection('Notifications').doc(rid).set(
        {
          remote_id: rid,
          title: String(params.title || 'EduFlow 알림'),
          message: String(params.message || ''),
          channel: String(params.channel || 'mobile_pwa'),
          sender: String(params.sender || ''),
          grade: _toIntOrNull(params.grade),
          class_no: _toIntOrNull(params.class_no),
          student_id: String(params.student_id || ''),
          is_read: false,
          created_at: _nowStr(),
          updated_at: _nowStr()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'enqueue_remote_task') {
      const rid = String(params.remote_id || `mob_${Date.now()}`);
      const nowStr = _nowStr();
      const teacherId = String(params.teacher_id || params.auth_teacher_id || params.user_id || '').trim();
      const schoolCode = String(params.school_code || params.neis_school_code || '').trim();
      const grade = _toIntOrNull(params.grade);
      const classNo = _toIntOrNull(params.class_no);
      await db.collection('Tasks').doc(rid).set(
        {
          remote_id: rid,
          teacher_id: teacherId,
          school_code: schoolCode,
          grade,
          class_no: classNo,
          title: String(params.title || ''),
          task_type: String(params.task_type || 'general'),
          scheduled_time: String(params.scheduled_time || ''),
          target_info: String(params.target_info || ''),
          action_payload: typeof params.action_payload === 'string' ? params.action_payload : JSON.stringify(params.action_payload || {}),
          exec_status: 'pending',
          is_done: false,
          is_mobile_task: true,
          memo: String(params.memo || ''),
          created_at: String(params.created_at || nowStr),
          updated_at: nowStr
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'sync_neis_meals') {
      const resSync = await _syncNeisMeals(db, params);
      return res.status(200).json(resSync);
    }

    // =========================================================================
    // 데스크톱 앱 하이브리드 백엔드(Vercel API 모드) 전용 인증 기반 액션
    // =========================================================================
    if (action === 'health_check') {
      return res.status(200).json({ ok: true, backend: 'vercel_api', server_time: _nowStr() });
    }

    const desktopActions = new Set([
      'get_teacher_profile',
      'check_timetable_exists',
      'sync_timetables_batch',
      'sync_meals_batch',
      'provision_homeroom_accounts',
      'fetch_homeroom_students',
      'fetch_homeroom_attendance',
      'publish_mobile_notice',
      'delete_notice',
      'delete_notice_reply',
      'fetch_notice_replies',
      'send_class_notification',
      'fetch_sent_notifications',
      'fetch_chat_history',
      'upsert_board_notice',
      'delete_board_notice',
      'admin_get_class_overview',
      'admin_reset_account_password',
      'admin_update_account_phone',
      'admin_upsert_roster_student',
      'admin_delete_roster_student',
      'upsert_budget',
      'delete_budget',
      'sync_subject_rosters_batch',
      'save_subject_attendance_batch',
      'delete_subject_attendance',
      'update_chat_message',
      'delete_chat_message',
      'upsert_schedule',
      'delete_schedule',
      'upsert_lesson_progress',
      'delete_lesson_progress',
      'sync_lesson_progress_batch',
      'upsert_student_face_photos_batch',
      'get_student_face_data',
      'save_student_face_descriptors_batch',
      'proxy_drive_photo',
      'update_pc_agent_status',
      'fetch_pending_remote_tasks',
      'update_remote_task_status',
    ]);

    if (desktopActions.has(action)) {
      const auth = await _verifyActiveTeacherAuth(db, params);
      if (!auth.ok) {
        return res.status(auth.status || 401).json({ ok: false, error: auth.error });
      }
      const resDesktop = await _handleDesktopApiAction(db, action, params, auth);
      return res.status(resDesktop.status || 200).json(resDesktop.json);
    }

    return res.status(400).json({ ok: false, error: `지원하지 않는 action입니다: ${action}` });
  } catch (err) {
    const errPayload = buildFirestoreErrorPayload(err, `API:${action}`);
    return res.status(errPayload.code === 'FIRESTORE_INDEX_REQUIRED' ? 400 : 500).json(errPayload);
  }
};

async function _verifyActiveTeacherAuth(db, params) {
  const teacherId = String(params.auth_teacher_id || params.teacher_id || params.requester_id || '').trim();
  const rawPw = String(params.auth_password || params.password || '');
  const pwHash = String(params.auth_password_hash || params.password_hash || '');
  if (!teacherId) {
    return { ok: false, status: 401, error: '교사 인증 ID(auth_teacher_id)가 필요합니다.' };
  }
  const { userDoc } = await _findAccountDoc(db, 'teacher', teacherId);
  if (!userDoc) {
    return { ok: false, status: 401, error: '등록되지 않은 교사 계정입니다.' };
  }
  const accStatus = String(userDoc.status || 'active').trim().toLowerCase();
  if (accStatus !== '' && accStatus !== 'active') {
    return { ok: false, status: 403, error: '활성화(active)된 교사 계정만 사용할 수 있습니다.' };
  }
  if (!_verifyPassword(userDoc.password_hash, rawPw, pwHash)) {
    return { ok: false, status: 401, error: '교사 인증 비밀번호가 일치하지 않습니다.' };
  }
  const safeTeacher = { ...userDoc };
  delete safeTeacher.password_hash;
  return {
    ok: true,
    teacherDoc: safeTeacher,
    teacherId: String(userDoc.teacher_id || userDoc.remote_id || teacherId).trim(),
    schoolCode: String(userDoc.school_code || userDoc.neis_school_code || '').trim(),
    comciganSchoolCode: String(userDoc.comcigan_school_code || '').trim(),
    schoolName: String(userDoc.school_name || '').trim(),
    gradeNum: _toIntOrNull(userDoc.grade),
    classNum: _toIntOrNull(userDoc.class_no),
    isAdmin: userDoc.is_admin === true || String(userDoc.teacher_id || '') === SUPER_ADMIN_ID,
  };
}

function _resolveDesktopDocId(colName, row, idx) {
  const rawId = String((row && row.remote_id) || '').trim();
  if (rawId) return rawId.replace(/\//g, '_');
  const payload = JSON.stringify(row || {});
  const digest = crypto.createHash('sha1').update(`${colName}:${idx}:${payload}`).digest('hex').slice(0, 16);
  return `auto_${digest}`;
}

async function _batchUpsertDocs(db, collectionName, rows, defaults = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return 0;
  const CHUNK = 400;
  let written = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const batch = db.batch();
    slice.forEach((rawRow, offset) => {
      if (!rawRow || typeof rawRow !== 'object') return;
      const docId = _resolveDesktopDocId(collectionName, rawRow, i + offset);
      const docData = { ...rawRow, remote_id: docId, updated_at: rawRow.updated_at || _nowStr() };
      if (defaults.schoolCode && !docData.school_code) docData.school_code = defaults.schoolCode;
      if (defaults.comciganSchoolCode && !docData.comcigan_school_code) docData.comcigan_school_code = defaults.comciganSchoolCode;
      if (defaults.schoolName && !docData.school_name) docData.school_name = defaults.schoolName;
      if (docData.grade !== undefined && docData.grade !== '') docData.grade = _toIntOrNull(docData.grade);
      if (docData.class_no !== undefined && docData.class_no !== '') docData.class_no = _toIntOrNull(docData.class_no);
      if (docData.period !== undefined && docData.period !== '') docData.period = _toIntOrNull(docData.period);
      batch.set(db.collection(collectionName).doc(docId), docData, { merge: true });
      written += 1;
    });
    await batch.commit();
  }
  return written;
}

function _extractBirth6Digits(student) {
  if (!student || typeof student !== 'object') return '';
  let extra = student.extra_data;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch (_) { extra = {}; }
  }
  const entries = [];
  if (extra && typeof extra === 'object') {
    entries.push(...Object.entries(extra));
  }
  for (const k of ['birth_date', 'rrn', '주민번호', '주민등록번호', '생년월일', '생일']) {
    if (student[k] !== undefined) entries.push([k, student[k]]);
  }
  for (const [key, val] of entries) {
    const kn = String(key || '').replace(/\s+/g, '').toLowerCase();
    if (kn.includes('주민') || kn.includes('생년월일') || kn.includes('생일') || kn.includes('birth') || kn.includes('rrn')) {
      const digits = String(val || '').replace(/\D/g, '');
      if (digits.length >= 13) return digits.slice(0, 6);
      if (digits.length === 8 && (digits.startsWith('19') || digits.startsWith('20'))) return digits.slice(2, 8);
      if (digits.length >= 6) return digits.slice(0, 6);
    }
  }
  return '';
}

const _LESSON_SCHED_ITEM_SRC = '[월화수목금토일](?:요일)?\\s*[:\\-·/]?\\s*\\d{1,2}(?:\\s*[~,\\-]\\s*\\d{1,2})*(?:\\s*교시)?';
const _LESSON_BRACKETED_WEEKDAY_PERIOD_RE = new RegExp(
  `(?:\\[\\s*${_LESSON_SCHED_ITEM_SRC}(?:\\s*[,/·ㆍ\\s]\\s*${_LESSON_SCHED_ITEM_SRC})*\\s*\\]|\\(\\s*${_LESSON_SCHED_ITEM_SRC}(?:\\s*[,/·ㆍ\\s]\\s*${_LESSON_SCHED_ITEM_SRC})*\\s*\\))`,
  'g'
);

function _cleanLessonMetaSeparators(str) {
  let out = String(str || '');
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(/\(\s*[·ㆍ•\-/|,:;\s]*\)|\[\s*[·ㆍ•\-/|,:;\s]*\]/g, ' ');
    if (next === out) break;
    out = next;
  }
  out = out.replace(/([·ㆍ•/|,:;])(?:\s*[·ㆍ•/|,:;])+/g, '$1');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[·ㆍ•\-/|,:;\s]+/, '').replace(/[·ㆍ•\-/|,:;\s]+$/, '').trim();
  return out;
}

function _stripLessonWeekdayPeriod(raw, allowCompactBare = false) {
  let text = String(raw || '').trim();
  let firstPeriod = null;
  if (!text) return { text: '', period: null };

  const recordPeriod = (periodNum) => {
    if (periodNum >= 1 && periodNum <= 15) {
      if (firstPeriod === null) firstPeriod = periodNum;
      return true;
    }
    return false;
  };

  text = text.replace(_LESSON_BRACKETED_WEEKDAY_PERIOD_RE, (match) => {
    const innerRe = /([월화수목금토일])(?:요일)?\s*[:\-·/]?\s*(\d{1,2})(?:\s*[~,\-]\s*\d{1,2})*(?:\s*교시)?/g;
    const extracted = [];
    let m;
    while ((m = innerRe.exec(match)) !== null) {
      const pNum = Number(m[2]);
      if (pNum >= 1 && pNum <= 15) extracted.push(pNum);
    }
    if (extracted.length === 0) return match;
    extracted.forEach(recordPeriod);
    return ' ';
  });

  text = text.replace(/(?:\[\s*(\d{1,2})\s*교시\s*\]|\(\s*(\d{1,2})\s*교시\s*\))/g, (match, p1, p2) => {
    return recordPeriod(Number(p1 || p2)) ? ' ' : match;
  });

  text = text.replace(
    /(^|[\s·ㆍ•,/|(\[])([월화수목금토일])(?:요일\s*[:\-·/]?\s*|\s+[:\-·/]?\s*|\s*[:\-·/]\s*)(\d{1,2})(?:\s*교시)?(?=$|[\s·ㆍ•,/|)\]])/g,
    (match, prefix, wd, pStr) => (recordPeriod(Number(pStr)) ? `${prefix} ` : match)
  );

  text = text.replace(
    /(^|[\s·ㆍ•,/|(\[])([월화수목금토일])(?:요일)?\s*(\d{1,2})\s*교시(?=$|[\s·ㆍ•,/|)\]])/g,
    (match, prefix, wd, pStr) => (recordPeriod(Number(pStr)) ? `${prefix} ` : match)
  );

  if (allowCompactBare) {
    text = text.replace(
      /(^|[\s·ㆍ•,/|(\[])([월화수목금토일])(\d{1,2})(?=$|[\s·ㆍ•,/|)\]])/g,
      (match, prefix, wd, pStr) => (recordPeriod(Number(pStr)) ? `${prefix} ` : match)
    );
  }

  return { text, period: firstPeriod };
}

function _normalizeExplicitLessonPeriod(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    const n = Math.trunc(raw);
    return n >= 1 && n <= 15 ? n : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const directMatch = s.match(/^(?:제\s*)?(\d{1,2})\s*(?:교시)?$/);
  if (directMatch) {
    const n = Number(directMatch[1]);
    return n >= 1 && n <= 15 ? n : null;
  }
  const stripped = _stripLessonWeekdayPeriod(s, true);
  if (stripped.period !== null) return stripped.period;
  return s;
}

function _extractAndStripLessonClassToken(raw) {
  const str = String(raw || '').trim();
  if (!str) return { text: '', classLabel: '' };

  const specs = [
    {
      bracketed: true,
      re: /\(\s*(\d{1,2})\s*학년\s*(\d{1,2})\s*반\s*\)|\[\s*(\d{1,2})\s*학년\s*(\d{1,2})\s*반\s*\]/g,
      format: (m) => {
        const g = Number(m[1] || m[3]);
        const c = Number(m[2] || m[4]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}학년 ${c}반` : null;
      },
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])(\d{1,2})\s*학년\s*(\d{1,2})\s*반(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => {
        const g = Number(m[2]);
        const c = Number(m[3]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}학년 ${c}반` : null;
      },
    },
    {
      bracketed: true,
      re: /\(\s*(\d{1,2})\s*-\s*([A-Za-z][A-Za-z0-9]*)(?:반)?\s*\)|\[\s*(\d{1,2})\s*-\s*([A-Za-z][A-Za-z0-9]*)(?:반)?\s*\]/g,
      format: (m) => {
        const g = Number(m[1] || m[3]);
        const code = String(m[2] || m[4] || '').toUpperCase();
        return g >= 1 && g <= 6 && code ? `${g}-${code}` : null;
      },
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])(\d{1,2})\s*-\s*([A-Za-z][A-Za-z0-9]*)(?:반)?(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => {
        const g = Number(m[2]);
        const code = String(m[3] || '').toUpperCase();
        return g >= 1 && g <= 6 && code ? `${g}-${code}` : null;
      },
    },
    {
      bracketed: true,
      re: /\(\s*(\d{1,2})\s*-\s*(\d{1,2})(?:반)?\s*\)|\[\s*(\d{1,2})\s*-\s*(\d{1,2})(?:반)?\s*\]/g,
      format: (m) => {
        const g = Number(m[1] || m[3]);
        const c = Number(m[2] || m[4]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}-${c}` : null;
      },
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])(\d{1,2})\s*-\s*(\d{1,2})(?:반)?(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => {
        const g = Number(m[2]);
        const c = Number(m[3]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}-${c}` : null;
      },
    },
    {
      bracketed: true,
      re: /\(\s*([A-Za-z]\d{2,4})(?:반)?\s*\)|\[\s*([A-Za-z]\d{2,4})(?:반)?\s*\]/g,
      format: (m) => String(m[1] || m[2] || '').toUpperCase() || null,
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])([A-Za-z]\d{2,4})(?:반)?(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => String(m[2] || '').toUpperCase() || null,
    },
  ];

  for (const spec of specs) {
    spec.re.lastIndex = 0;
    let m;
    while ((m = spec.re.exec(str)) !== null) {
      const classLabel = spec.format(m);
      if (classLabel) {
        const prefix = spec.bracketed ? '' : (m[1] || '');
        const text = `${str.slice(0, m.index)}${prefix} ${str.slice(m.index + m[0].length)}`;
        return { text, classLabel };
      }
    }
  }
  return { text: str, classLabel: '' };
}

function _parseLessonMeta(subjectOrObj, classLabel = '', period = '') {
  let rawSubject = subjectOrObj;
  let rawClass = classLabel;
  let rawPeriod = period;
  if (subjectOrObj && typeof subjectOrObj === 'object') {
    rawSubject = subjectOrObj.subject ?? '';
    rawClass = subjectOrObj.class_label ?? subjectOrObj.classLabel ?? '';
    rawPeriod = subjectOrObj.period ?? '';
  }

  const explicitPeriod = _normalizeExplicitLessonPeriod(rawPeriod);
  const clsPeriodStrip = _stripLessonWeekdayPeriod(rawClass, true);
  const subjPeriodStrip = _stripLessonWeekdayPeriod(rawSubject, false);
  const resolvedPeriod = explicitPeriod !== null
    ? explicitPeriod
    : (clsPeriodStrip.period !== null ? clsPeriodStrip.period : subjPeriodStrip.period);

  const clsClassStrip = _extractAndStripLessonClassToken(clsPeriodStrip.text);
  const subjClassStrip = _extractAndStripLessonClassToken(subjPeriodStrip.text);

  const cleanedClsRemainder = _cleanLessonMetaSeparators(clsClassStrip.text);
  const cleanedSubjRemainder = _cleanLessonMetaSeparators(subjClassStrip.text);

  const resolvedClass = clsClassStrip.classLabel || cleanedClsRemainder || subjClassStrip.classLabel || '';
  const resolvedSubject = cleanedSubjRemainder || (clsClassStrip.classLabel ? cleanedClsRemainder : '');

  return {
    subject: resolvedSubject,
    class_label: resolvedClass,
    period: resolvedPeriod,
  };
}

function _extractDriveFileId(input) {
  if (typeof googleDrive.extractDriveFileId === 'function') {
    return googleDrive.extractDriveFileId(input);
  }
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

function _buildStudentFaceDocId(auth, studentId) {
  const scopeKey = String((auth && (auth.schoolCode || auth.schoolName || auth.teacherId)) || 'default').trim();
  return `face_${scopeKey}_${String(studentId || '').trim()}`.replace(/[\\/:*?"<>|\s]/g, '_');
}

function _normalizeFaceDescriptor(raw) {
  if (!raw) return null;
  let arr = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
    arr = Array.from(raw);
  } else {
    return null;
  }
  if (arr.length !== 128) return null;
  const out = new Array(128);
  for (let i = 0; i < 128; i += 1) {
    const val = arr[i];
    if (typeof val === 'boolean' || val === null || val === undefined || val === '') {
      return null;
    }
    const num = Number(val);
    if (!Number.isFinite(num)) return null;
    out[i] = num;
  }
  return out;
}

function _normalizePhotoDataUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 750000) return '';
  const m = s.match(/^(data:image\/[a-z0-9.+-]+;base64,)([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return '';
  const body = m[2].replace(/\s+/g, '');
  if (!body || (m[1].length + body.length) > 750000) return '';
  return `${m[1].toLowerCase()}${body}`;
}

function _isFaceRowAllowedForTeacherClass(row, auth) {
  if (!row || typeof row !== 'object' || !auth) return false;
  if (auth.gradeNum === null || auth.gradeNum === undefined || auth.classNum === null || auth.classNum === undefined) {
    return false;
  }
  const docSc = String(row.school_code || row.neis_school_code || '').trim();
  const docSn = String(row.school_name || '').trim();
  if (auth.schoolCode && docSc && docSc !== auth.schoolCode) return false;
  if (!auth.schoolCode && auth.schoolName && docSn && docSn !== auth.schoolName) return false;
  if (auth.schoolCode && !docSc && auth.schoolName && docSn && docSn !== auth.schoolName) return false;

  const rawG = row.grade !== undefined && row.grade !== '' ? row.grade : row.target_grade;
  const rawC = row.class_no !== undefined && row.class_no !== '' ? row.class_no : row.target_class;
  const explicitG = _toIntOrNull(rawG);
  const explicitC = _toIntOrNull(rawC);
  if (explicitG !== null && explicitG !== auth.gradeNum) return false;
  if (explicitC !== null && explicitC !== auth.classNum) return false;

  if (explicitG === null || explicitC === null) {
    const inferred = _inferGradeClassFromStudentId(row.student_id);
    if (explicitG === null && inferred.grade !== null && inferred.grade !== auth.gradeNum) return false;
    if (explicitC === null && inferred.class_no !== null && inferred.class_no !== auth.classNum) return false;
  }
  return true;
}

async function _handleDesktopApiAction(db, action, params, auth) {
  const scopeDefaults = {
    schoolCode: auth.schoolCode,
    comciganSchoolCode: auth.comciganSchoolCode,
    schoolName: auth.schoolName,
  };
  const tenant = {
    schoolCode: auth.schoolCode,
    comciganSchoolCode: auth.comciganSchoolCode,
    schoolName: auth.schoolName,
    gradeNum: auth.gradeNum,
    classNum: auth.classNum,
  };

  if (action === 'get_teacher_profile') {
    const tid = String(params.teacher_id || auth.teacherId).trim();
    const { userDoc } = await _findAccountDoc(db, 'teacher', tid);
    if (!userDoc) return { status: 200, json: { ok: true, profile: null } };
    const safe = { ...userDoc };
    delete safe.password_hash;
    return { status: 200, json: { ok: true, profile: safe } };
  }

  if (action === 'check_timetable_exists') {
    const sc = String(params.school_code || auth.schoolCode || '').trim();
    const cc = String(params.comcigan_school_code || auth.comciganSchoolCode || '').trim();
    const sn = String(params.school_name || auth.schoolName || '').trim();
    const colRef = db.collection('시간표_기본');
    for (const [field, val] of [['school_code', sc], ['comcigan_school_code', cc], ['school_name', sn]]) {
      if (val) {
        const snap = await colRef.where(field, '==', val).limit(1).get();
        if (!snap.empty) return { status: 200, json: { ok: true, exists: true } };
      }
    }
    if (!sc && !cc && !sn) {
      const snap = await colRef.limit(1).get();
      return { status: 200, json: { ok: true, exists: !snap.empty } };
    }
    return { status: 200, json: { ok: true, exists: false } };
  }

  if (action === 'sync_timetables_batch') {
    const baseRows = Array.isArray(params.base_rows) ? params.base_rows : [];
    const changeRows = Array.isArray(params.change_rows) ? params.change_rows : [];
    const deleteBaseIds = Array.isArray(params.delete_base_ids) ? params.delete_base_ids : [];
    const deleteChangeIds = Array.isArray(params.delete_change_ids) ? params.delete_change_ids : [];
    const baseWritten = await _batchUpsertDocs(db, '시간표_기본', baseRows, scopeDefaults);
    if (baseWritten > 0 || deleteBaseIds.length > 0) _invalidateStaticCache('tt_base');
    const changeWritten = await _batchUpsertDocs(db, '시간표_변동', changeRows, scopeDefaults);
    let baseDeleted = 0;
    let changeDeleted = 0;
    for (const [colName, idList, isBase] of [['시간표_기본', deleteBaseIds, true], ['시간표_변동', deleteChangeIds, false]]) {
      const cleanIds = idList.map((x) => String(x || '').trim()).filter(Boolean);
      for (let i = 0; i < cleanIds.length; i += 400) {
        const batch = db.batch();
        cleanIds.slice(i, i + 400).forEach((rid) => {
          batch.delete(db.collection(colName).doc(rid));
          if (isBase) baseDeleted += 1;
          else changeDeleted += 1;
        });
        await batch.commit();
      }
    }
    return {
      status: 200,
      json: { ok: true, base_written: baseWritten, change_written: changeWritten, base_deleted: baseDeleted, change_deleted: changeDeleted },
    };
  }

  if (action === 'sync_meals_batch') {
    const mealRows = Array.isArray(params.meal_rows) ? params.meal_rows : [];
    const mealWritten = await _batchUpsertDocs(db, '급식_식단표', mealRows, scopeDefaults);
    return { status: 200, json: { ok: true, meal_written: mealWritten } };
  }

  if (action === 'provision_homeroom_accounts') {
    const students = Array.isArray(params.students) ? params.students : [];
    const sc = auth.schoolCode || String(params.school_code || '').trim();
    const sn = auth.schoolName || String(params.school_name || '').trim();
    const now = _nowStr();

    const [stuSnap, parSnap] = await Promise.all([
      db.collection('계정_학생').get(),
      db.collection('계정_학부모').get(),
    ]);
    const existingStu = new Set();
    stuSnap.forEach((d) => {
      existingStu.add(d.id);
      const data = d.data() || {};
      if (data.student_id) existingStu.add(String(data.student_id));
    });
    const existingPar = new Set();
    parSnap.forEach((d) => {
      existingPar.add(d.id);
      const data = d.data() || {};
      if (data.parent_id) existingPar.add(String(data.parent_id));
    });

    const pending = [];
    let studentsCreated = 0;
    let studentsSkipped = 0;
    let parentsCreated = 0;
    let parentsSkipped = 0;

    for (const s of students) {
      const sid = String((s && s.student_id) || '').trim();
      if (!sid) continue;
      const gVal = auth.gradeNum !== null ? auth.gradeNum : _toIntOrNull(s.grade);
      const cVal = auth.classNum !== null ? auth.classNum : _toIntOrNull(s.class_no);
      const numVal = _toIntOrNull(s.number !== undefined ? s.number : s.student_no);
      const name = String(s.name || '').trim();
      const initPw = _extractBirth6Digits(s) || sid;
      const pwHash = _sha256Hex(initPw);

      const stuDocId = sc ? `${sc}_${sid}` : sid;
      const parLoginId = `p${sid}`;
      const parDocId = sc ? `${sc}_${parLoginId}` : parLoginId;

      if (existingStu.has(stuDocId) || (!sc && existingStu.has(sid))) {
        studentsSkipped += 1;
      } else {
        pending.push([
          db.collection('계정_학생').doc(stuDocId),
          {
            remote_id: stuDocId,
            student_id: sid,
            login_id: sid,
            name,
            grade: gVal,
            class_no: cVal,
            student_no: numVal,
            school_code: sc,
            school_name: sn,
            password_hash: pwHash,
            custom_id: '',
            custom_id_changed: false,
            status: 'active',
            updated_at: now,
          },
        ]);
        existingStu.add(stuDocId);
        studentsCreated += 1;
      }

      if (existingPar.has(parDocId) || (!sc && existingPar.has(parLoginId))) {
        parentsSkipped += 1;
      } else {
        pending.push([
          db.collection('계정_학부모').doc(parDocId),
          {
            remote_id: parDocId,
            parent_id: parLoginId,
            login_id: parLoginId,
            name: name ? `${name} 학부모` : '학부모',
            student_id: sid,
            student_name: name,
            grade: gVal,
            class_no: cVal,
            student_no: numVal,
            school_code: sc,
            school_name: sn,
            password_hash: pwHash,
            custom_id: '',
            custom_id_changed: false,
            status: 'active',
            updated_at: now,
          },
        ]);
        existingPar.add(parDocId);
        parentsCreated += 1;
      }
    }

    for (let i = 0; i < pending.length; i += 400) {
      const batch = db.batch();
      pending.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, data, { merge: true }));
      await batch.commit();
    }

    return {
      status: 200,
      json: {
        ok: true,
        students_created: studentsCreated,
        students_skipped: studentsSkipped,
        parents_created: parentsCreated,
        parents_skipped: parentsSkipped,
      },
    };
  }

  if (action === 'fetch_homeroom_students') {
    const g = auth.gradeNum !== null ? auth.gradeNum : _toIntOrNull(params.grade);
    const c = auth.classNum !== null ? auth.classNum : _toIntOrNull(params.class_no);
    const rows = (g !== null && c !== null)
      ? await _queryClassScoped(db, '계정_학생', g, c)
      : _snapToRows(await db.collection('계정_학생').limit(200).get());
    const filtered = rows
      .filter((d) => {
        const st = String(d.status || 'active').trim().toLowerCase();
        if (st === 'pending' || st === 'rejected' || st === 'inactive' || st === 'disabled') return false;
        return _matchesTenant(d, { ...tenant, gradeNum: g, classNum: c });
      })
      .map((d) => {
        const safe = { ...d };
        delete safe.password_hash;
        return safe;
      })
      .sort((a, b) => Number(a.student_no || 9999) - Number(b.student_no || 9999));
    return { status: 200, json: { ok: true, students: filtered } };
  }

  if (action === 'fetch_homeroom_attendance') {
    const g = auth.gradeNum !== null ? auth.gradeNum : _toIntOrNull(params.grade);
    const c = auth.classNum !== null ? auth.classNum : _toIntOrNull(params.class_no);
    const rows = (g !== null && c !== null)
      ? await _queryClassScoped(db, '일일_출결', g, c)
      : _snapToRows(await db.collection('일일_출결').limit(200).get());
    const filtered = rows
      .filter((d) => _matchesTenant(d, { ...tenant, gradeNum: g, classNum: c }))
      .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));
    return { status: 200, json: { ok: true, attendance: filtered } };
  }

  if (action === 'publish_mobile_notice') {
    const rid = String(params.remote_id || `noti_doc_${Date.now()}`).trim();
    const docRef = db.collection('가정통신문_목록').doc(rid);
    const existingSnap = params.remote_id ? await docRef.get() : null;
    const existing = existingSnap && existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;
    if (existing && !_matchesTeacherClassOrAuthor(existing, auth)) {
      return { status: 403, json: { ok: false, error: '본인 학급 또는 본인이 작성한 가정통신문만 수정할 수 있습니다.' } };
    }
    const nowStr = _nowStr();
    const payload = {
      remote_id: rid,
      title: String(params.title || '').trim(),
      category: String(params.category || '가정통신문').trim(),
      content: String(params.content || '').trim(),
      reply_fields: Array.isArray(params.reply_fields) ? params.reply_fields : [],
      target_grade: auth.gradeNum !== null ? auth.gradeNum : _toIntOrNull(params.target_grade),
      target_class: auth.classNum !== null ? auth.classNum : _toIntOrNull(params.target_class),
      school_code: auth.schoolCode || String(params.school_code || '').trim(),
      school_name: auth.schoolName || String(params.school_name || '').trim(),
      due_date: String(params.due_date || '').trim(),
      teacher_id: String((existing && existing.teacher_id) || auth.teacherId || '').trim(),
      author_name: String(params.author_name || (auth.teacherDoc && auth.teacherDoc.name) || '담임교사').trim(),
      is_published: true,
      created_at: String((existing && existing.created_at) || nowStr),
      updated_at: nowStr,
    };
    await docRef.set(payload, { merge: true });
    return { status: 200, json: { ok: true, remote_id: rid } };
  }

  if (action === 'delete_notice') {
    const rid = String(params.remote_id || params.notice_id || params.id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 가정통신문의 remote_id가 필요합니다.' } };
    }
    const docRef = db.collection('가정통신문_목록').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '해당 가정통신문을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    if (!_matchesTeacherClassOrAuthor(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '본인 학급 또는 본인이 작성한 가정통신문만 삭제할 수 있습니다.' } };
    }
    await docRef.delete();
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'delete_notice_reply') {
    const noticeId = String(params.notice_id || '').trim();
    const studentId = String(params.student_id || '').trim();
    const rid = String(params.remote_id || (noticeId && studentId ? `${noticeId}_${studentId}` : '')).trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 회신 내역의 remote_id 또는 notice_id/student_id가 필요합니다.' } };
    }
    const replyRef = db.collection('가정통신문_회신').doc(rid);
    const replySnap = await replyRef.get();
    if (!replySnap.exists) {
      return { status: 404, json: { ok: false, error: '해당 회신 내역을 찾을 수 없습니다.' } };
    }
    const replyDoc = { remote_id: replySnap.id, ...(replySnap.data() || {}) };
    const parentNoticeId = String(replyDoc.notice_id || noticeId || '').trim();
    let noticeAllowed = false;
    if (parentNoticeId) {
      const noticeSnap = await db.collection('가정통신문_목록').doc(parentNoticeId).get();
      if (noticeSnap.exists) {
        noticeAllowed = _matchesTeacherClassOrAuthor({ remote_id: noticeSnap.id, ...(noticeSnap.data() || {}) }, auth);
      }
    }
    const replyInClass = _isStrictClassMember(replyDoc, auth);
    if (!noticeAllowed && !replyInClass) {
      return { status: 403, json: { ok: false, error: '담당 학급 또는 본인 가정통신문의 회신 내역만 삭제할 수 있습니다.' } };
    }
    await replyRef.delete();
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'fetch_notice_replies') {
    const nid = String(params.notice_id || '').trim();
    if (!nid) return { status: 200, json: { ok: true, replies: [] } };
    const noticeSnap = await db.collection('가정통신문_목록').doc(nid).get();
    if (noticeSnap.exists && !_matchesTeacherClassOrAuthor({ remote_id: noticeSnap.id, ...(noticeSnap.data() || {}) }, auth)) {
      return { status: 403, json: { ok: false, error: '담당 학급 또는 본인이 작성한 가정통신문의 회신만 조회할 수 있습니다.' } };
    }
    const snap = await db.collection('가정통신문_회신').where('notice_id', '==', nid).get();
    const rows = _snapToRows(snap).filter((r) => noticeSnap.exists || _isStrictClassMember(r, auth));
    return { status: 200, json: { ok: true, replies: rows } };
  }

  if (action === 'send_class_notification') {
    const rid = String(params.remote_id || `noti_${Date.now()}`).trim();
    const payload = {
      remote_id: rid,
      title: String(params.title || '').trim(),
      message: String(params.message || '').trim(),
      channel: String(params.channel || 'desktop_broadcast').trim(),
      target_role: String(params.target_role || 'all').trim().toLowerCase(),
      sender: String(params.sender || auth.teacherDoc.name || '담임교사').trim(),
      grade: auth.gradeNum !== null ? auth.gradeNum : _toIntOrNull(params.grade),
      class_no: auth.classNum !== null ? auth.classNum : _toIntOrNull(params.class_no),
      school_code: auth.schoolCode || String(params.school_code || '').trim(),
      school_name: auth.schoolName || String(params.school_name || '').trim(),
      student_id: String(params.student_id || '').trim(),
      is_read: false,
      created_at: params.created_at || _nowStr(),
      updated_at: _nowStr(),
    };
    await db.collection('Notifications').doc(rid).set(payload, { merge: true });
    return { status: 200, json: { ok: true, remote_id: rid } };
  }

  if (action === 'fetch_sent_notifications') {
    const lim = Math.min(200, Math.max(1, Number(params.limit || 50)));
    const snap = await db.collection('Notifications').limit(lim).get();
    const filtered = _snapToRows(snap)
      .filter((d) => _matchesTenant(d, tenant))
      .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));
    return { status: 200, json: { ok: true, notifications: filtered } };
  }

  if (action === 'fetch_chat_history') {
    const sid = String(params.student_id || '').trim();
    let rows = [];
    if (sid) {
      const snap = await db.collection('1:1_상담채팅').where('room_id', '==', `ROOM-${sid}`).get();
      rows = _snapToRows(snap);
    } else if (auth.gradeNum !== null && auth.classNum !== null) {
      rows = await _queryClassScoped(db, '1:1_상담채팅', auth.gradeNum, auth.classNum);
    } else {
      rows = _snapToRows(await db.collection('1:1_상담채팅').limit(100).get());
    }
    const filtered = rows
      .filter((d) => _matchesTenant(d, tenant))
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    return { status: 200, json: { ok: true, messages: filtered } };
  }

  if (action === 'upsert_board_notice') {
    return await _upsertBoardNotice(db, params, auth);
  }

  if (action === 'delete_board_notice') {
    return await _deleteBoardNotice(db, params, auth);
  }

  if (action === 'admin_get_class_overview') {
    const g = auth.gradeNum;
    const c = auth.classNum;
    const hasAssignedClass = g !== null && c !== null;
    const gradeIn = hasAssignedClass ? _gradeCandidates(g) : [];

    const [
      stuRowsRaw,
      parRowsRaw,
      attRowsRaw,
      docRowsRaw,
      ledgerRowsRaw,
      chatRowsRaw,
      noticeRowsRaw,
      replyRowsRaw,
      boardRowsRaw,
      notiRowsRaw,
      subjectRostersRaw,
      subjectAttRaw,
      lessonProgressRaw,
      pushSubRowsRaw,
      schedulesRaw,
    ] = await Promise.all([
      hasAssignedClass
        ? db.collection('계정_학생').where('grade', 'in', gradeIn).limit(250).get().then(_snapToRows).catch(() => [])
        : Promise.resolve([]),
      hasAssignedClass
        ? db.collection('계정_학부모').where('grade', 'in', gradeIn).limit(250).get().then(_snapToRows).catch(() => [])
        : Promise.resolve([]),
      hasAssignedClass
        ? Promise.all([
            db.collection('일일_출결').where('grade', 'in', gradeIn).limit(1500).get().then(_snapToRows).catch(() => []),
            db.collection('일일_출결').where('attendance_type', '!=', '출석').limit(500).get().then(_snapToRows).catch(() => []),
          ]).then(([byGrade, nonPresent]) => _mergeRowsById(nonPresent, byGrade))
        : Promise.resolve([]),
      hasAssignedClass
        ? db.collection('서류_추적').where('grade', 'in', gradeIn).limit(300).get().then(_snapToRows).catch(() => [])
        : Promise.resolve([]),
      hasAssignedClass
        ? db.collection('학급회비').where('grade', 'in', gradeIn).limit(200).get().then(_snapToRows).catch(() => [])
        : Promise.resolve([]),
      hasAssignedClass
        ? db.collection('1:1_상담채팅').where('grade', 'in', gradeIn).limit(400).get().then(_snapToRows).catch(() => [])
        : Promise.resolve([]),
      db.collection('가정통신문_목록').limit(150).get().then(_snapToRows).catch(() => []),
      db.collection('가정통신문_회신').limit(500).get().then(_snapToRows).catch(() => []),
      db.collection('학급_공지게시판').limit(150).get().then(_snapToRows).catch(() => []),
      db.collection('Notifications').limit(200).get().then(_snapToRows).catch(() => []),
      db.collection('교과_명렬표').where('teacher_id', '==', auth.teacherId).limit(200).get().then(_snapToRows).catch(() => []),
      db.collection('교과_출결').where('teacher_id', '==', auth.teacherId).limit(500).get().then(_snapToRows).catch(() => []),
      db.collection('수업_진도').where('teacher_id', '==', auth.teacherId).limit(300).get().then(_snapToRows).catch(() => []),
      hasAssignedClass
        ? db.collection('Push_Subscriptions').where('grade', 'in', gradeIn).limit(500).get().then(_snapToRows).catch(() => [])
        : Promise.resolve([]),
      db.collection('Schedules').limit(200).get().then(_snapToRows).catch(() => []),
    ]);

    const pushSubscribedUserIds = new Set();
    const pushSubscribedStudentKeys = new Set();
    const pushSubscribedParentKeys = new Set();
    const pushSubscribedParentSids = new Set();

    (pushSubRowsRaw || []).forEach((ps) => {
      if (!ps || typeof ps !== 'object') return;
      const psG = _toIntOrNull(ps.grade);
      const psC = _toIntOrNull(ps.class_no);
      if (g !== null && psG !== null && psG !== g) return;
      if (c !== null && psC !== null && psC !== c) return;
      const psRole = String(ps.role || '').trim().toLowerCase();
      if (psRole === 'teacher') return;
      const uid = String(ps.user_id || '').trim();
      const sid = String(ps.student_id || '').trim();
      if (uid) pushSubscribedUserIds.add(uid);
      if (sid && psRole !== 'parent') pushSubscribedUserIds.add(sid);
      if (psRole === 'parent') {
        if (uid) pushSubscribedParentKeys.add(uid);
        if (sid) pushSubscribedParentSids.add(sid);
      } else {
        if (uid) pushSubscribedStudentKeys.add(uid);
        if (sid) pushSubscribedStudentKeys.add(sid);
      }
    });

    const students = stuRowsRaw
      .filter((d) => _isStrictClassMember(d, auth))
      .map((d) => {
        const safe = { ..._withInferredClass(d), phone: String(d.phone || '') };
        delete safe.password_hash;
        const keys = [safe.student_id, safe.login_id, safe.custom_id, safe.remote_id]
          .map((v) => String(v || '').trim())
          .filter(Boolean);
        safe.push_enabled = keys.some((k) => pushSubscribedStudentKeys.has(k));
        return safe;
      })
      .sort((a, b) => Number(a.student_no || 9999) - Number(b.student_no || 9999) || String(a.student_id || '').localeCompare(String(b.student_id || '')));

    const classStudentIds = new Set(students.map((s) => String(s.student_id || '').trim()).filter(Boolean));

    const parents = parRowsRaw
      .filter((d) => _isStrictClassMember(d, auth) || (d.student_id && classStudentIds.has(String(d.student_id).trim())))
      .map((d) => {
        const safe = { ..._withInferredClass(d), phone: String(d.phone || '') };
        delete safe.password_hash;
        const keys = [safe.parent_id, safe.login_id, safe.custom_id, safe.remote_id]
          .map((v) => String(v || '').trim())
          .filter(Boolean);
        const pSid = String(safe.student_id || '').trim();
        safe.push_enabled = keys.some((k) => pushSubscribedParentKeys.has(k)) || Boolean(pSid && pushSubscribedParentSids.has(pSid));
        return safe;
      })
      .sort((a, b) => Number(a.student_no || 9999) - Number(b.student_no || 9999));

    const notices = noticeRowsRaw
      .filter((d) => _matchesTeacherClassOrAuthor(d, auth))
      .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));

    const noticeIds = new Set(notices.map((n) => String(n.remote_id || n.id || '').trim()).filter(Boolean));

    const replies = replyRowsRaw
      .filter((r) => {
        const sid = String(r.student_id || '').trim();
        const nid = String(r.notice_id || '').trim();
        if (classStudentIds.size > 0 && sid) return classStudentIds.has(sid);
        return Boolean(nid && noticeIds.has(nid));
      })
      .sort((a, b) => String(b.submitted_at || b.updated_at || '').localeCompare(String(a.submitted_at || a.updated_at || '')));

    const attendance = attRowsRaw
      .filter((d) => _isStrictClassMember(d, auth) || (d.student_id && classStudentIds.has(String(d.student_id).trim())))
      .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));

    const documents = docRowsRaw
      .filter((d) => _isStrictClassMember(d, auth) || (d.student_id && classStudentIds.has(String(d.student_id).trim())))
      .sort((a, b) => String(b.updated_at || b.due_date || '').localeCompare(String(a.updated_at || a.due_date || '')));

    const ledger = ledgerRowsRaw
      .filter((d) => _isStrictClassMember(d, auth))
      .sort((a, b) => String(b.date || b.created_at || '').localeCompare(String(a.date || a.created_at || '')));

    const boardNotices = boardRowsRaw
      .filter((d) => _matchesTeacherClassOrAuthor(d, auth))
      .sort((a, b) => {
        const pinDiff = (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0);
        if (pinDiff !== 0) return pinDiff;
        return String(b.published_at || b.created_at || b.updated_at || '').localeCompare(String(a.published_at || a.created_at || a.updated_at || ''));
      });

    const notifications = notiRowsRaw
      .filter((d) => {
        const sid = String(d.student_id || d.target_student_id || '').trim();
        if (sid && classStudentIds.has(sid)) return true;
        return _matchesTeacherClassOrAuthor(d, auth);
      })
      .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));

    const chats = chatRowsRaw
      .filter((d) => {
        const sid = String(d.student_id || '').trim();
        if (sid && classStudentIds.has(sid)) return true;
        return _isStrictClassMember(d, auth);
      })
      .sort((a, b) => String(a.created_at || a.updated_at || '').localeCompare(String(b.created_at || b.updated_at || '')));

    return {
      status: 200,
      json: {
        ok: true,
        teacher: auth.teacherDoc,
        scope: {
          teacher_id: auth.teacherId,
          school_code: auth.schoolCode,
          school_name: auth.schoolName,
          grade: auth.gradeNum,
          class_no: auth.classNum,
        },
        students,
        parents,
        push_subscribed_user_ids: Array.from(pushSubscribedUserIds),
        notices,
        replies,
        attendance,
        documents,
        ledger,
        board_notices: boardNotices,
        notifications,
        chats,
        subject_rosters: (subjectRostersRaw || []).filter((d) => _belongsToTeacher(d, auth)),
        subject_attendance: (subjectAttRaw || [])
          .filter((d) => _belongsToTeacher(d, auth))
          .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || ''))),
        lesson_progress: (lessonProgressRaw || [])
          .filter((d) => _belongsToTeacher(d, auth))
          .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || ''))),
        schedules: (schedulesRaw || [])
          .filter((d) => {
            if (!d || typeof d !== 'object') return false;
            if (!_matchesTenant(d, { ...tenant, gradeNum: null, classNum: null })) return false;
            if (!_isPublicAcademicSchedule(d)) return _belongsToTeacher(d, auth);
            return true;
          })
          .sort((a, b) => String(a.start_date || a.date || '').localeCompare(String(b.start_date || b.date || ''))),
      },
    };
  }

  if (action === 'admin_reset_account_password') {
    const targetRole = String(params.target_role || 'student').trim().toLowerCase();
    if (targetRole !== 'student' && targetRole !== 'parent') {
      return { status: 400, json: { ok: false, error: '학생(student) 또는 학부모(parent) 계정만 초기화할 수 있습니다.' } };
    }
    const rid = String(params.remote_id || params.user_id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '대상 계정 remote_id가 필요합니다.' } };
    }
    const newPassword = String(params.new_password || '1234').trim() || '1234';
    const colName = targetRole === 'parent' ? '계정_학부모' : '계정_학생';
    const docRef = db.collection(colName).doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '대상 계정을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    if (!_isStrictClassMember(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '담당 학급의 학생·학부모 계정만 비밀번호를 초기화할 수 있습니다.' } };
    }
    const nowStr = _nowStr();
    await docRef.set({ password_hash: _sha256Hex(newPassword), updated_at: nowStr }, { merge: true });
    return {
      status: 200,
      json: { ok: true, remote_id: rid, target_role: targetRole, reset_at: nowStr },
    };
  }

  if (action === 'admin_update_account_phone') {
    const targetRole = String(params.target_role || 'student').trim().toLowerCase();
    if (targetRole !== 'student' && targetRole !== 'parent') {
      return { status: 400, json: { ok: false, error: '학생(student) 또는 학부모(parent) 계정의 연락처만 수정할 수 있습니다.' } };
    }
    const rid = String(params.remote_id || params.user_id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '대상 계정 remote_id가 필요합니다.' } };
    }
    const norm = _normalizePhoneNumber(params.phone ?? '');
    if (!norm.ok) {
      return { status: 400, json: { ok: false, error: norm.error } };
    }

    const colName = targetRole === 'parent' ? '계정_학부모' : '계정_학생';
    const docRef = db.collection(colName).doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '대상 계정을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    if (!_isStrictClassMember(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '담당 학급의 학생·학부모 연락처만 수정할 수 있습니다.' } };
    }
    const nowStr = _nowStr();
    await docRef.set({ phone: norm.phone, updated_at: nowStr }, { merge: true });
    return {
      status: 200,
      json: { ok: true, remote_id: rid, target_role: targetRole, phone: norm.phone, updated_at: nowStr },
    };
  }

  if (action === 'admin_upsert_roster_student') {
    if (auth.gradeNum === null || auth.classNum === null) {
      return { status: 403, json: { ok: false, error: '담당 학년·반이 지정된 교사만 명렬표를 관리할 수 있습니다.' } };
    }
    const sid = String(params.student_id || '').trim();
    const stuName = String(params.name || params.student_name || '').trim();
    if (!sid || !stuName) {
      return { status: 400, json: { ok: false, error: '학번(student_id)과 학생 이름(name)을 모두 입력해 주세요.' } };
    }
    const rawPhone = String(params.phone ?? '').trim();
    let normalizedPhone = '';
    if (rawPhone) {
      const norm = _normalizePhoneNumber(rawPhone);
      if (!norm.ok) {
        return { status: 400, json: { ok: false, error: norm.error } };
      }
      normalizedPhone = norm.phone;
    }
    const studentNo = _toIntOrNull(params.student_no ?? params.number);
    const sc = auth.schoolCode || '';
    const sn = auth.schoolName || '';
    const nowStr = _nowStr();
    const reqRid = String(params.remote_id || '').trim();
    const stuDocId = reqRid || (sc ? `${sc}_${sid}` : sid);
    const stuRef = db.collection('계정_학생').doc(stuDocId);
    const existingSnap = await stuRef.get();
    const existing = existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;

    if (reqRid) {
      if (!existing) {
        return { status: 404, json: { ok: false, error: '수정할 학생 계정을 찾을 수 없습니다.' } };
      }
      if (!_isStrictClassMember(existing, auth)) {
        return { status: 403, json: { ok: false, error: '담당 학급의 학생 계정만 수정할 수 있습니다.' } };
      }
    } else if (existing) {
      if (!_isStrictClassMember(existing, auth)) {
        return { status: 403, json: { ok: false, error: '타 학급 또는 타 학교에 이미 등록된 학번입니다.' } };
      }
      return { status: 409, json: { ok: false, error: `이미 등록된 학번입니다 (${sid}).` } };
    }

    const oldSid = existing ? String(existing.student_id || '').trim() : sid;
    const stuPayload = {
      remote_id: stuDocId,
      student_id: sid,
      login_id: existing && existing.custom_id_changed ? String(existing.login_id || sid) : sid,
      name: stuName,
      grade: auth.gradeNum,
      class_no: auth.classNum,
      student_no: studentNo,
      school_code: sc,
      school_name: sn,
      status: String((existing && existing.status) || 'active'),
      updated_at: nowStr,
    };
    if (params.phone !== undefined) {
      stuPayload.phone = normalizedPhone;
    }
    if (!existing) {
      const initPw = String(params.initial_password || params.password || sid).trim() || sid;
      stuPayload.password_hash = _sha256Hex(initPw);
      stuPayload.custom_id = '';
      stuPayload.custom_id_changed = false;
      stuPayload.created_at = nowStr;
    }
    await stuRef.set(stuPayload, { merge: true });

    let parentResult = null;
    const shouldSyncParent = existing ? true : (params.create_parent !== false);
    if (shouldSyncParent) {
      const parLoginId = `p${sid}`;
      const defaultParDocId = sc ? `${sc}_${parLoginId}` : parLoginId;
      let targetParRef = null;
      let existingPar = null;
      if (existing && oldSid) {
        const parSnapBySid = await db.collection('계정_학부모').where('student_id', '==', oldSid).get();
        parSnapBySid.forEach((d) => {
          const pd = { remote_id: d.id, ...(d.data() || {}) };
          if (!existingPar && _isStrictClassMember(pd, auth)) {
            existingPar = pd;
            targetParRef = db.collection('계정_학부모').doc(d.id);
          }
        });
      }
      if (!targetParRef) {
        const defaultRef = db.collection('계정_학부모').doc(defaultParDocId);
        const defaultSnap = await defaultRef.get();
        if (defaultSnap.exists) {
          const pd = { remote_id: defaultSnap.id, ...(defaultSnap.data() || {}) };
          if (_isStrictClassMember(pd, auth)) {
            existingPar = pd;
            targetParRef = defaultRef;
          }
        } else if (!existing) {
          targetParRef = defaultRef;
        }
      }
      if (targetParRef) {
        const parPayload = {
          remote_id: targetParRef.id,
          parent_id: existingPar ? String(existingPar.parent_id || parLoginId) : parLoginId,
          login_id: existingPar && existingPar.custom_id_changed ? String(existingPar.login_id || parLoginId) : parLoginId,
          name: existingPar ? String(existingPar.name || `${stuName} 학부모`) : `${stuName} 학부모`,
          student_id: sid,
          student_name: stuName,
          grade: auth.gradeNum,
          class_no: auth.classNum,
          student_no: studentNo,
          school_code: sc,
          school_name: sn,
          status: String((existingPar && existingPar.status) || 'active'),
          updated_at: nowStr,
        };
        if (!existingPar) {
          const initPw = String(params.initial_password || params.password || sid).trim() || sid;
          parPayload.password_hash = _sha256Hex(initPw);
          parPayload.custom_id = '';
          parPayload.custom_id_changed = false;
          parPayload.created_at = nowStr;
        }
        await targetParRef.set(parPayload, { merge: true });
        parentResult = targetParRef.id;
      }
    }

    return {
      status: 200,
      json: {
        ok: true,
        remote_id: stuDocId,
        student: stuPayload,
        parent_remote_id: parentResult,
      },
    };
  }

  if (action === 'admin_delete_roster_student') {
    const rid = String(params.remote_id || params.user_id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 학생 계정의 remote_id가 필요합니다.' } };
    }
    const stuRef = db.collection('계정_학생').doc(rid);
    const snap = await stuRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '삭제할 학생 계정을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    if (!_isStrictClassMember(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '담당 학급의 학생 계정만 삭제할 수 있습니다.' } };
    }
    const sid = String(targetDoc.student_id || '').trim();
    await stuRef.delete();

    const deletedParents = [];
    if (sid) {
      const parSnap = await db.collection('계정_학부모').where('student_id', '==', sid).get();
      const batch = db.batch();
      parSnap.forEach((d) => {
        const pd = { remote_id: d.id, ...(d.data() || {}) };
        if (_isStrictClassMember(pd, auth)) {
          batch.delete(db.collection('계정_학부모').doc(d.id));
          deletedParents.push(d.id);
        }
      });
      if (deletedParents.length > 0) await batch.commit();
    }

    return {
      status: 200,
      json: { ok: true, remote_id: rid, deleted: true, deleted_parents: deletedParents },
    };
  }

  if (action === 'upsert_budget') {
    if (auth.gradeNum === null || auth.classNum === null) {
      return { status: 403, json: { ok: false, error: '담당 학년·반이 지정된 교사만 학급회비를 등록/수정할 수 있습니다.' } };
    }
    const rawTitle = String(params.title || params.description || params.item || '').trim();
    if (!rawTitle) {
      return { status: 400, json: { ok: false, error: '항목명(title)을 입력해 주세요.' } };
    }
    const rawAmount = Number(params.amount);
    if (!Number.isFinite(rawAmount) || rawAmount < 0) {
      return { status: 400, json: { ok: false, error: '유효한 금액(amount)을 입력해 주세요.' } };
    }

    const rid = String(params.remote_id || `budget_${Date.now()}_${Math.floor(Math.random() * 1000)}`).trim();
    const docRef = db.collection('학급회비').doc(rid);
    const existingSnap = params.remote_id ? await docRef.get() : null;
    const existing = existingSnap && existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;

    if (existing && !_isStrictClassMember(existing, auth)) {
      return { status: 403, json: { ok: false, error: '담당 학급의 학급회비 내역만 수정할 수 있습니다.' } };
    }

    const rawType = String(params.type || params.tx_type || '').trim().toLowerCase();
    const normalizedType = (rawType === 'income' || rawType === 'in' || rawType.includes('수입') || rawType.includes('입금'))
      ? 'income'
      : 'expense';

    const nowStr = _nowStr();
    const payload = {
      remote_id: rid,
      type: normalizedType,
      amount: Math.round(Math.abs(rawAmount)),
      date: String(params.date || (existing && existing.date) || nowStr.slice(0, 10)).trim(),
      title: rawTitle,
      store: String(params.store || '').trim(),
      card: String(params.card || params.payment_method || '').trim(),
      receipt_url: String(params.receipt_url || '').trim(),
      memo: String(params.memo || '').trim(),
      school_code: auth.schoolCode,
      school_name: auth.schoolName,
      grade: auth.gradeNum,
      class_no: auth.classNum,
      teacher_id: auth.teacherId,
      created_at: String((existing && existing.created_at) || nowStr),
      updated_at: nowStr,
    };

    await docRef.set(payload, { merge: true });
    return { status: 200, json: { ok: true, remote_id: rid, item: payload } };
  }

  if (action === 'delete_budget') {
    const rid = String(params.remote_id || params.id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 학급회비 내역의 remote_id가 필요합니다.' } };
    }
    const docRef = db.collection('학급회비').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '해당 학급회비 내역을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    if (!_isStrictClassMember(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '담당 학급의 학급회비 내역만 삭제할 수 있습니다.' } };
    }
    await docRef.delete();
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'sync_subject_rosters_batch') {
    const rawRows = Array.isArray(params.rows) ? params.rows : [];
    const nowStr = _nowStr();
    const normalized = rawRows
      .filter((r) => r && typeof r === 'object')
      .map((r, idx) => {
        const subject = String(r.subject || '').trim();
        const classLabel = String(r.class_label || '').trim();
        const rosterKey = String(r.roster_key || `${subject}__${classLabel}` || `roster_${idx}`).trim();
        const rid = String(r.remote_id || `roster_${auth.teacherId}_${rosterKey}`.replace(/[\\/:*?"<>|\s]/g, '_'));
        return {
          ...r,
          remote_id: rid,
          teacher_id: auth.teacherId,
          school_code: auth.schoolCode,
          school_name: auth.schoolName,
          subject,
          class_label: classLabel,
          roster_key: rosterKey,
          students: Array.isArray(r.students) ? r.students : [],
          updated_at: nowStr,
        };
      });
    const written = await _batchUpsertDocs(db, '교과_명렬표', normalized, scopeDefaults);
    return { status: 200, json: { ok: true, written } };
  }

  if (action === 'save_subject_attendance_batch') {
    const dateStr = String(params.date || _nowStr().slice(0, 10)).trim();
    const periodVal = String(params.period || '').trim();
    const subject = String(params.subject || '').trim();
    const classLabel = String(params.class_label || '').trim();
    const rosterKey = String(params.roster_key || `${subject}__${classLabel}`).trim();
    const records = Array.isArray(params.records) ? params.records : [];
    if (!subject || records.length === 0) {
      return { status: 400, json: { ok: false, error: '과목명(subject)과 학생 출결 records가 필요합니다.' } };
    }
    const nowStr = _nowStr();
    const safeKey = rosterKey.replace(/[\\/:*?"<>|\s]/g, '_');
    const safePeriod = periodVal.replace(/[\\/:*?"<>|\s]/g, '_');
    const normalized = records
      .filter((rec) => rec && String(rec.student_id || '').trim())
      .map((rec) => {
        const sid = String(rec.student_id).trim();
        const rid = String(rec.remote_id || `subatt_${auth.teacherId}_${dateStr}_${safePeriod}_${safeKey}_${sid}`).replace(/[\\/:*?"<>|]/g, '_');
        return {
          remote_id: rid,
          teacher_id: auth.teacherId,
          school_code: auth.schoolCode,
          school_name: auth.schoolName,
          date: dateStr,
          period: _toIntOrNull(periodVal) ?? periodVal,
          subject,
          class_label: classLabel,
          roster_key: rosterKey,
          student_id: sid,
          student_name: String(rec.student_name || '').trim(),
          status: String(rec.status || '출석').trim(),
          memo: String(rec.memo || '').trim(),
          updated_at: nowStr,
        };
      });
    const existingSnaps = await Promise.all(
      normalized.map((item) => db.collection('교과_출결').doc(item.remote_id).get())
    );
    for (const snap of existingSnaps) {
      if (snap.exists && !_belongsToTeacher({ remote_id: snap.id, ...(snap.data() || {}) }, auth)) {
        return { status: 403, json: { ok: false, error: '본인이 등록한 교과 출결만 수정할 수 있습니다.' } };
      }
    }
    const savedCount = await _batchUpsertDocs(db, '교과_출결', normalized, scopeDefaults);
    return { status: 200, json: { ok: true, saved_count: savedCount, items: normalized } };
  }

  if (action === 'delete_subject_attendance') {
    const rid = String(params.remote_id || params.id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 교과 출결의 remote_id가 필요합니다.' } };
    }
    const docRef = db.collection('교과_출결').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '해당 교과 출결 내역을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    if (!_belongsToTeacher(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '본인이 등록한 교과 출결만 삭제할 수 있습니다.' } };
    }
    await docRef.delete();
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'update_chat_message') {
    const rid = String(params.remote_id || params.id || '').trim();
    const message = String(params.message || '').trim();
    if (!rid || !message) {
      return { status: 400, json: { ok: false, error: 'remote_id와 수정할 메시지(message)가 필요합니다.' } };
    }
    const docRef = db.collection('1:1_상담채팅').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '수정할 상담 메시지를 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    const isTeacherSender = String(targetDoc.sender_role || '').trim().toLowerCase() === 'teacher';
    const isOwner = (targetDoc.teacher_id && String(targetDoc.teacher_id) === auth.teacherId) || _isStrictClassMember(targetDoc, auth);
    if (!isTeacherSender || !isOwner) {
      return { status: 403, json: { ok: false, error: '교사 본인이 발송한 상담 메시지만 수정할 수 있습니다.' } };
    }
    const nowStr = _nowStr();
    await docRef.set({ message, updated_at: nowStr }, { merge: true });
    return { status: 200, json: { ok: true, remote_id: rid, message, updated_at: nowStr } };
  }

  if (action === 'delete_chat_message') {
    const rid = String(params.remote_id || params.id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 상담 메시지의 remote_id가 필요합니다.' } };
    }
    const docRef = db.collection('1:1_상담채팅').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '삭제할 상담 메시지를 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    const isTeacherSender = String(targetDoc.sender_role || '').trim().toLowerCase() === 'teacher';
    const isOwner = (targetDoc.teacher_id && String(targetDoc.teacher_id) === auth.teacherId) || _isStrictClassMember(targetDoc, auth);
    if (!isTeacherSender || !isOwner) {
      return { status: 403, json: { ok: false, error: '교사 본인이 발송한 상담 메시지만 삭제할 수 있습니다.' } };
    }
    await docRef.delete();
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'upsert_schedule') {
    const title = String(params.title || '').trim();
    const startDate = String(params.start_date || params.date || '').trim();
    if (!title || !startDate) {
      return { status: 400, json: { ok: false, error: '일정명(title)과 시작일(start_date)이 필요합니다.' } };
    }
    const rid = String(params.remote_id || `sched_${auth.teacherId}_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const docRef = db.collection('Schedules').doc(rid);
    const existingSnap = params.remote_id ? await docRef.get() : null;
    const existing = existingSnap && existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;
    if (existing) {
      const hasTid = Boolean(String(existing.teacher_id || '').trim());
      const allowed = hasTid ? _belongsToTeacher(existing, auth) : _matchesTenant(existing, { ...tenant, gradeNum: null, classNum: null });
      if (!allowed) {
        return { status: 403, json: { ok: false, error: '본인 학교·학급 또는 본인이 등록한 일정만 수정할 수 있습니다.' } };
      }
    }
    const nowStr = _nowStr();
    const endDate = String(params.end_date || startDate).trim() || startDate;
    const isPrivate = _toBool(params.is_private);
    const payload = {
      remote_id: rid,
      title,
      start_date: startDate,
      end_date: endDate,
      date: startDate,
      category: String(params.category || (isPrivate ? '개인 일정' : '학사일정')).trim(),
      description: String(params.description || params.memo || '').trim(),
      memo: String(params.memo || params.description || '').trim(),
      is_private: isPrivate,
      visibility: isPrivate ? 'private' : 'public',
      teacher_id: String((existing && existing.teacher_id) || auth.teacherId || '').trim(),
      school_code: auth.schoolCode,
      school_name: auth.schoolName,
      grade: params.grade !== undefined ? _toIntOrNull(params.grade) : auth.gradeNum,
      class_no: params.class_no !== undefined ? _toIntOrNull(params.class_no) : auth.classNum,
      created_at: String((existing && existing.created_at) || nowStr),
      updated_at: nowStr,
    };
    await docRef.set(payload, { merge: true });
    return { status: 200, json: { ok: true, remote_id: rid, item: payload } };
  }

  if (action === 'delete_schedule') {
    const rid = String(params.remote_id || params.id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 일정의 remote_id가 필요합니다.' } };
    }
    const docRef = db.collection('Schedules').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '해당 학사일정을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    const hasTid = Boolean(String(targetDoc.teacher_id || '').trim());
    const allowed = hasTid ? _belongsToTeacher(targetDoc, auth) : _matchesTenant(targetDoc, { ...tenant, gradeNum: null, classNum: null });
    if (!allowed) {
      return { status: 403, json: { ok: false, error: '본인 학교·학급 또는 본인이 등록한 일정만 삭제할 수 있습니다.' } };
    }
    await docRef.delete();
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'upsert_lesson_progress') {
    const parsedMeta = _parseLessonMeta(params.subject, params.class_label, params.period);
    const subject = parsedMeta.subject;
    const classLabel = parsedMeta.class_label;
    if (!subject) {
      return { status: 400, json: { ok: false, error: '과목명(subject)이 필요합니다.' } };
    }
    const rid = String(params.remote_id || `prog_${auth.teacherId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`).replace(/[\\/:*?"<>|]/g, '_');
    const docRef = db.collection('수업_진도').doc(rid);
    const existingSnap = params.remote_id ? await docRef.get() : null;
    const existing = existingSnap && existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;
    if (existing && !_belongsToTeacher(existing, auth)) {
      return { status: 403, json: { ok: false, error: '본인이 등록한 수업 진도만 수정할 수 있습니다.' } };
    }
    const nowStr = _nowStr();
    const hasExplicitPeriodParam = params.period !== undefined;
    let resolvedPeriod = parsedMeta.period;
    if (resolvedPeriod === null) {
      if (hasExplicitPeriodParam) {
        resolvedPeriod = '';
      } else {
        const existingPeriod = existing ? _parseLessonMeta('', '', existing.period).period : null;
        resolvedPeriod = existingPeriod !== null ? existingPeriod : '';
      }
    }
    const payload = {
      remote_id: rid,
      teacher_id: auth.teacherId,
      school_code: auth.schoolCode,
      school_name: auth.schoolName,
      date: String(params.date || (existing && existing.date) || nowStr.slice(0, 10)).trim(),
      period: resolvedPeriod,
      subject,
      class_label: classLabel,
      roster_key: String(params.roster_key || `${subject}__${classLabel}`).trim(),
      unit: String(params.unit || '').trim(),
      lesson_no: String(params.lesson_no || '').trim(),
      content: String(params.content || '').trim(),
      next_note: String(params.next_note || '').trim(),
      status: String(params.status || (existing && existing.status) || '완료').trim(),
      created_at: String((existing && existing.created_at) || nowStr),
      updated_at: nowStr,
    };
    await docRef.set(payload, { merge: true });
    return { status: 200, json: { ok: true, remote_id: rid, item: payload } };
  }

  if (action === 'delete_lesson_progress') {
    const rid = String(params.remote_id || params.id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '삭제할 수업 진도의 remote_id가 필요합니다.' } };
    }
    const docRef = db.collection('수업_진도').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '해당 수업 진도 내역을 찾을 수 없습니다.' } };
    }
    const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
    if (!_belongsToTeacher(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '본인이 등록한 수업 진도만 삭제할 수 있습니다.' } };
    }
    await docRef.delete();
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'sync_lesson_progress_batch') {
    const rawRows = Array.isArray(params.rows) ? params.rows : [];
    const nowStr = _nowStr();
    const normalized = rawRows
      .filter((r) => r && typeof r === 'object')
      .map((r, idx) => {
        const rid = String(r.remote_id || `prog_${auth.teacherId}_${Date.now()}_${idx}`).replace(/[\\/:*?"<>|]/g, '_');
        const parsedMeta = _parseLessonMeta(r.subject, r.class_label, r.period);
        const subject = parsedMeta.subject;
        const classLabel = parsedMeta.class_label;
        const nextRow = {
          ...r,
          remote_id: rid,
          teacher_id: auth.teacherId,
          school_code: auth.schoolCode,
          school_name: auth.schoolName,
          subject,
          class_label: classLabel,
          roster_key: String(r.roster_key || `${subject}__${classLabel}`).trim(),
          updated_at: nowStr,
        };
        if (parsedMeta.period !== null) {
          nextRow.period = parsedMeta.period;
        }
        return nextRow;
      });
    const written = await _batchUpsertDocs(db, '수업_진도', normalized, scopeDefaults);
    return { status: 200, json: { ok: true, written } };
  }

  if (
    action === 'upsert_student_face_photos_batch' ||
    action === 'get_student_face_data' ||
    action === 'save_student_face_descriptors_batch' ||
    action === 'proxy_drive_photo'
  ) {
    if (auth.gradeNum === null || auth.gradeNum === undefined || auth.classNum === null || auth.classNum === undefined) {
      return { status: 403, json: { ok: false, error: '담당 학년·반이 지정된 교사만 학생 안면 데이터를 조회·관리할 수 있습니다.' } };
    }
  }

  if (action === 'upsert_student_face_photos_batch') {
    const rawRows = Array.isArray(params.rows)
      ? params.rows
      : (Array.isArray(params.items) ? params.items : (Array.isArray(params.photos) ? params.photos : []));
    const nowStr = _nowStr();
    const validRows = [];
    let rejectedCount = 0;

    for (const row of rawRows) {
      if (!row || typeof row !== 'object') continue;
      const sid = String(row.student_id || '').trim();
      if (!sid) continue;
      if (!_isFaceRowAllowedForTeacherClass(row, auth)) {
        rejectedCount += 1;
        continue;
      }

      const docId = String(row.remote_id || _buildStudentFaceDocId(auth, sid)).replace(/[\\/:*?"<>|\s]/g, '_');
      const existingSnap = await db.collection('학생_안면데이터').doc(docId).get();
      const existing = existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;
      if (existing && !_isStrictClassMember(existing, auth)) {
        rejectedCount += 1;
        continue;
      }

      const photoFileId = _extractDriveFileId(
        row.photo_file_id || row.drive_file_id || row.file_id || row.photo_url || row.drive_url || row.download_url || ''
      );
      const rawPhotoUrl = String(row.photo_url || row.drive_url || row.download_url || '').trim();
      const photoUrl = rawPhotoUrl || (photoFileId ? `https://drive.google.com/uc?export=download&id=${photoFileId}` : '');
      const photoDataUrl = row.photo_data_url !== undefined ? _normalizePhotoDataUrl(row.photo_data_url) : undefined;
      const photoHash = row.photo_hash !== undefined
        ? String(row.photo_hash || '').trim()
        : (photoDataUrl ? _sha256Hex(photoDataUrl) : '');
      const sNo = _toIntOrNull(row.student_no);

      const itemPayload = {
        remote_id: docId,
        student_id: sid,
        student_name: String(row.student_name || row.name || (existing && (existing.student_name || existing.name)) || '').trim(),
        student_no: sNo !== null ? sNo : (existing && existing.student_no !== undefined ? existing.student_no : null),
        grade: auth.gradeNum,
        class_no: auth.classNum,
        school_code: auth.schoolCode,
        school_name: auth.schoolName,
        teacher_id: auth.teacherId,
        photo_file_id: photoFileId,
        photo_url: photoUrl,
        updated_at: nowStr,
      };
      if (photoDataUrl !== undefined) {
        itemPayload.photo_data_url = photoDataUrl;
      }
      if (photoHash || row.photo_hash !== undefined) {
        itemPayload.photo_hash = photoHash;
      }

      if (row.face_descriptor !== undefined) {
        const vec = _normalizeFaceDescriptor(row.face_descriptor);
        if (vec) {
          itemPayload.face_descriptor = vec;
          itemPayload.descriptor_model = String(row.descriptor_model || 'vladmandic-face-api-128d').trim();
          itemPayload.descriptor_updated_at = nowStr;
        } else if (row.face_descriptor === null) {
          itemPayload.face_descriptor = null;
          itemPayload.descriptor_model = '';
        }
      } else if (existing) {
        const prevFileId = String(existing.photo_file_id || _extractDriveFileId(existing.photo_url || '')).trim();
        const prevHash = String(existing.photo_hash || '').trim();
        const fileIdChanged = Boolean(photoFileId && prevFileId && prevFileId !== photoFileId) || Boolean(photoFileId && !prevFileId && !prevHash);
        const hashChanged = Boolean(photoHash && prevHash !== photoHash);
        if (fileIdChanged || hashChanged) {
          itemPayload.face_descriptor = null;
          itemPayload.descriptor_model = '';
        }
      }

      validRows.push(itemPayload);
    }

    if (rejectedCount > 0 && validRows.length === 0) {
      return { status: 403, json: { ok: false, error: '담당 학급 학생의 안면 데이터만 저장할 수 있습니다.' } };
    }

    const written = await _batchUpsertDocs(db, '학생_안면데이터', validRows, scopeDefaults);
    return { status: 200, json: { ok: true, written, skipped: rejectedCount, items: validRows } };
  }

  if (action === 'get_student_face_data') {
    const gradeIn = _gradeCandidates(auth.gradeNum);
    const snap = await db.collection('학생_안면데이터').where('grade', 'in', gradeIn).limit(200).get();
    const rows = _snapToRows(snap);
    const items = rows
      .filter((d) => _isStrictClassMember(d, auth))
      .map((d) => {
        const descriptor = _normalizeFaceDescriptor(d.face_descriptor);
        const item = {
          remote_id: String(d.remote_id || ''),
          student_id: String(d.student_id || '').trim(),
          student_name: String(d.student_name || d.name || '').trim(),
          student_no: d.student_no ?? null,
          grade: _toIntOrNull(d.grade),
          class_no: _toIntOrNull(d.class_no),
          photo_file_id: String(d.photo_file_id || _extractDriveFileId(d.photo_url || '')).trim(),
          photo_url: String(d.photo_url || '').trim(),
          photo_hash: String(d.photo_hash || '').trim(),
          face_descriptor: descriptor,
          descriptor_model: String(d.descriptor_model || '').trim(),
          updated_at: String(d.updated_at || ''),
        };
        if (!descriptor) {
          const dataUrl = _normalizePhotoDataUrl(d.photo_data_url);
          if (dataUrl) item.photo_data_url = dataUrl;
        }
        return item;
      })
      .sort((a, b) => Number(a.student_no || 9999) - Number(b.student_no || 9999) || String(a.student_id).localeCompare(String(b.student_id)));
    return { status: 200, json: { ok: true, items, total: items.length } };
  }

  if (action === 'save_student_face_descriptors_batch') {
    const rawRows = Array.isArray(params.rows)
      ? params.rows
      : (Array.isArray(params.items) ? params.items : (Array.isArray(params.descriptors) ? params.descriptors : []));
    const nowStr = _nowStr();
    const validRows = [];
    let rejectedCount = 0;
    let invalidCount = 0;

    for (const row of rawRows) {
      if (!row || typeof row !== 'object') continue;
      const sid = String(row.student_id || '').trim();
      if (!sid) continue;

      const vec = _normalizeFaceDescriptor(row.face_descriptor);
      if (!vec) {
        invalidCount += 1;
        continue;
      }
      if (!_isFaceRowAllowedForTeacherClass(row, auth)) {
        rejectedCount += 1;
        continue;
      }

      const docId = String(row.remote_id || _buildStudentFaceDocId(auth, sid)).replace(/[\\/:*?"<>|\s]/g, '_');
      const existingSnap = await db.collection('학생_안면데이터').doc(docId).get();
      const existing = existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;
      if (existing && !_isStrictClassMember(existing, auth)) {
        rejectedCount += 1;
        continue;
      }

      const nextDoc = {
        remote_id: docId,
        student_id: sid,
        grade: auth.gradeNum,
        class_no: auth.classNum,
        school_code: auth.schoolCode,
        school_name: auth.schoolName,
        teacher_id: auth.teacherId,
        face_descriptor: vec,
        descriptor_model: String(row.descriptor_model || 'vladmandic-face-api-128d').trim(),
        descriptor_updated_at: nowStr,
        updated_at: nowStr,
      };
      const sName = String(row.student_name || row.name || (existing && (existing.student_name || existing.name)) || '').trim();
      if (sName) nextDoc.student_name = sName;
      const sNo = _toIntOrNull(row.student_no);
      if (sNo !== null) nextDoc.student_no = sNo;
      else if (existing && existing.student_no !== undefined && existing.student_no !== null) nextDoc.student_no = existing.student_no;
      const pFileId = _extractDriveFileId(row.photo_file_id || row.photo_url || (existing && (existing.photo_file_id || existing.photo_url)) || '');
      if (pFileId) nextDoc.photo_file_id = pFileId;
      const pUrl = String(row.photo_url || (existing && existing.photo_url) || '').trim();
      if (pUrl) nextDoc.photo_url = pUrl;

      validRows.push(nextDoc);
    }

    if (rejectedCount > 0 && validRows.length === 0) {
      return { status: 403, json: { ok: false, error: '담당 학급 학생의 안면 데이터만 저장할 수 있습니다.' } };
    }
    if (invalidCount > 0 && validRows.length === 0) {
      return { status: 400, json: { ok: false, error: 'face_descriptor는 128차원 숫자 배열이어야 합니다.' } };
    }

    const written = await _batchUpsertDocs(db, '학생_안면데이터', validRows, scopeDefaults);
    return { status: 200, json: { ok: true, saved_count: written, skipped: rejectedCount + invalidCount } };
  }

  if (action === 'proxy_drive_photo') {
    const fileId = _extractDriveFileId(params.file_id || params.photo_file_id || params.photo_url || '');
    if (!fileId) {
      return { status: 400, json: { ok: false, error: '유효한 Google Drive file_id가 필요합니다.' } };
    }

    const targetSid = String(params.student_id || '').trim();
    const gradeIn = _gradeCandidates(auth.gradeNum);
    const snap = await db.collection('학생_안면데이터').where('grade', 'in', gradeIn).limit(200).get();
    const rows = _snapToRows(snap);
    const matchedDoc = rows.find((d) => {
      if (!_isStrictClassMember(d, auth)) return false;
      const docFileId = String(d.photo_file_id || _extractDriveFileId(d.photo_url || '')).trim();
      if (docFileId !== fileId) return false;
      if (targetSid && String(d.student_id || '').trim() !== targetSid) return false;
      return true;
    });

    if (!matchedDoc) {
      return { status: 403, json: { ok: false, error: '담당 학급 학생의 안면 사진만 불러올 수 있습니다.' } };
    }
    if (typeof googleDrive.downloadDriveFileAsDataUrl !== 'function') {
      return { status: 500, json: { ok: false, error: 'Google Drive 읽기 헬퍼를 사용할 수 없습니다.' } };
    }

    const dl = await googleDrive.downloadDriveFileAsDataUrl(fileId);
    if (!dl || !dl.ok) {
      return { status: 502, json: { ok: false, error: (dl && dl.error) || '사진을 불러오지 못했습니다.' } };
    }
    return { status: 200, json: { ok: true, file_id: fileId, mime_type: dl.mimeType, data_url: dl.dataUrl } };
  }

  if (action === 'update_pc_agent_status') {
    const pcOnline = params.pc_online === undefined ? true : _toBool(params.pc_online);
    const nowIso = new Date().toISOString();
    const lastSeenAt = String(params.pc_last_seen_at || nowIso).trim();
    const hostname = String(params.pc_hostname || params.hostname || '').trim();
    const appVersion = String(params.pc_app_version || params.app_version || '').trim();
    const nowStr = _nowStr();

    const statusPayload = {
      remote_id: auth.teacherId,
      teacher_id: auth.teacherId,
      school_code: auth.schoolCode,
      school_name: auth.schoolName,
      pc_online: pcOnline,
      pc_last_seen_at: lastSeenAt,
      pc_hostname: hostname,
      pc_app_version: appVersion,
      updated_at: nowStr,
    };

    await Promise.all([
      db.collection('PC_Agent_Status').doc(auth.teacherId).set(statusPayload, { merge: true }),
      db.collection('계정_교사').doc(auth.teacherId).set({
        pc_online: pcOnline,
        pc_last_seen_at: lastSeenAt,
        pc_hostname: hostname,
        pc_app_version: appVersion,
        updated_at: nowStr,
      }, { merge: true }).catch(() => {}),
    ]);

    return {
      status: 200,
      json: {
        ok: true,
        status: {
          ...statusPayload,
          is_online: _evaluatePcAgentOnline(statusPayload),
        },
      },
    };
  }

  if (action === 'fetch_pending_remote_tasks') {
    const snap = await db.collection('Tasks').where('teacher_id', '==', auth.teacherId).limit(100).get();
    const rows = _snapToRows(snap);
    const tasks = rows
      .filter((t) => (
        _toBool(t.is_mobile_task) &&
        String(t.exec_status || '').trim().toLowerCase() === 'pending' &&
        String(t.teacher_id || '').trim() === auth.teacherId
      ))
      .sort((a, b) => String(a.created_at || a.updated_at || '').localeCompare(String(b.created_at || b.updated_at || '')));
    return { status: 200, json: { ok: true, tasks } };
  }

  if (action === 'update_remote_task_status') {
    const rid = String(params.remote_id || params.id || '').trim();
    if (!rid) {
      return { status: 400, json: { ok: false, error: '원격 작업의 remote_id가 필요합니다.' } };
    }
    const execStatus = String(params.exec_status || '').trim().toLowerCase();
    if (!['running', 'done', 'error'].includes(execStatus)) {
      return { status: 400, json: { ok: false, error: '유효한 exec_status(running, done, error)가 필요합니다.' } };
    }
    const docRef = db.collection('Tasks').doc(rid);
    const snap = await docRef.get();
    if (!snap.exists) {
      return { status: 404, json: { ok: false, error: '해당 원격 작업을 찾을 수 없습니다.' } };
    }
    const existing = snap.data() || {};
    if (String(existing.teacher_id || '').trim() !== auth.teacherId) {
      return { status: 403, json: { ok: false, error: '본인의 원격 작업 상태만 수정할 수 있습니다.' } };
    }
    const isDone = params.is_done !== undefined ? _toBool(params.is_done) : (execStatus === 'done');
    const updateData = {
      exec_status: execStatus,
      is_done: isDone,
      updated_at: _nowStr(),
    };
    if (params.memo !== undefined) {
      updateData.memo = String(params.memo || '').trim();
    }
    await docRef.set(updateData, { merge: true });
    return {
      status: 200,
      json: {
        ok: true,
        remote_id: rid,
        task: { ...existing, ...updateData, remote_id: rid },
      },
    };
  }

  return { status: 400, json: { ok: false, error: `지원하지 않는 데스크톱 action입니다: ${action}` } };
}

function _normalizeBoardSourceType(raw) {
  const s = String(raw || '').trim();
  const low = s.toLowerCase();
  if (!s) return '담임 공지';
  if (low === 'school_bell' || low === 'schoolbell' || s.includes('학교종이')) return '학교종이';
  if (low === 'kakao' || low === 'kakaotalk' || s.includes('카톡') || s.includes('카카오')) return '학급 카톡';
  if (low === 'homeroom' || low === 'teacher' || s.includes('담임')) return '담임 공지';
  return s;
}

async function _upsertBoardNotice(db, params, auth = null) {
  if (!auth) {
    return { status: 401, json: { ok: false, error: '교사 인증이 필요합니다.' } };
  }
  const rid = String(params.remote_id || params.notice_id || params.id || `board_${Date.now()}`).trim();
  const docRef = db.collection('학급_공지게시판').doc(rid);
  const existingSnap = await docRef.get();
  const existing = existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : {};
  if (existingSnap.exists && !_matchesTeacherClassOrAuthor(existing, auth)) {
    return { status: 403, json: { ok: false, error: '본인 학급 또는 본인이 작성한 공지사항만 수정할 수 있습니다.' } };
  }
  const nowStr = _nowStr();

  const resolvedTitle = params.title !== undefined
    ? String(params.title || '').trim()
    : String(existing.title || '').trim();
  const resolvedSummary = (params.summary !== undefined || params.key_summary !== undefined)
    ? String(params.summary !== undefined ? params.summary : (params.key_summary || '')).trim()
    : String(existing.summary || existing.key_summary || '').trim();
  const resolvedContent = (params.content !== undefined || params.body !== undefined)
    ? String(params.content !== undefined ? params.content : (params.body || '')).trim()
    : String(existing.content || existing.body || '').trim();

  if (!existingSnap.exists && !resolvedTitle) {
    return { status: 400, json: { ok: false, error: '공지 제목(title)이 필요합니다.' } };
  }

  const rawSource = (params.source_type !== undefined || params.source !== undefined)
    ? (params.source_type !== undefined ? params.source_type : params.source)
    : (existing.source_type || existing.source || '담임 공지');

  const isPinned = params.is_pinned !== undefined
    ? _toBool(params.is_pinned)
    : (existing.is_pinned !== undefined ? _toBool(existing.is_pinned) : false);
  const isPublished = params.is_published !== undefined
    ? _toBool(params.is_published)
    : (existing.is_published !== undefined ? _toBool(existing.is_published) : true);

  const payload = {
    remote_id: rid,
    title: resolvedTitle,
    summary: resolvedSummary,
    content: resolvedContent,
    source_type: _normalizeBoardSourceType(rawSource),
    source_url: params.source_url !== undefined ? String(params.source_url || '').trim() : String(existing.source_url || '').trim(),
    is_pinned: isPinned,
    is_published: isPublished,
    published_at: String(params.published_at || existing.published_at || nowStr).trim(),
    created_at: String(params.created_at || existing.created_at || nowStr).trim(),
    updated_at: nowStr,
    teacher_id: String(existing.teacher_id || (auth && auth.teacherId) || '').trim(),
    author_name: String(
      params.author_name ||
      (auth && auth.teacherDoc && auth.teacherDoc.name) ||
      existing.author_name ||
      '담임교사'
    ).trim(),
    grade: _toIntOrNull(params.grade ?? params.target_grade ?? (auth ? auth.gradeNum : null) ?? existing.grade),
    class_no: _toIntOrNull(params.class_no ?? params.target_class ?? (auth ? auth.classNum : null) ?? existing.class_no),
    school_code: String(params.school_code || (auth && auth.schoolCode) || existing.school_code || '').trim(),
    school_name: String(params.school_name || (auth && auth.schoolName) || existing.school_name || '').trim()
  };

  await docRef.set(payload, { merge: true });
  return { status: 200, json: { ok: true, remote_id: rid, notice: payload } };
}

async function _deleteBoardNotice(db, params, auth = null) {
  if (!auth) {
    return { status: 401, json: { ok: false, error: '교사 인증이 필요합니다.' } };
  }
  const rid = String(params.remote_id || params.notice_id || params.id || '').trim();
  if (!rid) {
    return { status: 400, json: { ok: false, error: 'remote_id가 필요합니다.' } };
  }
  const docRef = db.collection('학급_공지게시판').doc(rid);
  const snap = await docRef.get();
  if (!snap.exists) {
    return { status: 404, json: { ok: false, error: '해당 공지사항을 찾을 수 없습니다.' } };
  }
  const targetDoc = { remote_id: snap.id, ...(snap.data() || {}) };
  if (!_matchesTeacherClassOrAuthor(targetDoc, auth)) {
    return { status: 403, json: { ok: false, error: '본인 학급 또는 본인이 작성한 공지사항만 삭제할 수 있습니다.' } };
  }
  await docRef.delete();
  return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
}

async function _createNoticePublishedNotification(db, notice) {
  const nowStr = _nowStr();
  const noticeId = String(notice.remote_id || '').trim();
  const title = String(notice.title || '새 가정통신문').trim();
  const dueDate = String(notice.due_date || '').trim();
  const rid = `noti_notice_${noticeId}_${Date.now()}`;
  await db.collection('Notifications').doc(rid).set(
    {
      remote_id: rid,
      title: `[가정통신문] ${title}`,
      message: dueDate
        ? `${title} (마감: ${dueDate})가 게시되었습니다. 확인 후 회신해 주세요.`
        : `${title}가 게시되었습니다. 확인해 주세요.`,
      channel: 'notice_publish',
      target_role: 'all',
      sender: String(notice.author_name || '담임교사'),
      grade: _toIntOrNull(notice.target_grade),
      class_no: _toIntOrNull(notice.target_class),
      school_code: String(notice.school_code || ''),
      school_name: String(notice.school_name || ''),
      student_id: '',
      notice_id: noticeId,
      is_read: false,
      created_at: nowStr,
      updated_at: nowStr
    },
    { merge: true }
  );
  return rid;
}

function _belongsToTeacher(doc, authOrScope) {
  if (!doc || typeof doc !== 'object' || !authOrScope) return false;
  const authTid = String(authOrScope.teacherId || '').trim();
  const docTid = String(doc.teacher_id || '').trim();
  if (!authTid || !docTid || docTid !== authTid) return false;

  const authSc = String(authOrScope.schoolCode || '').trim();
  const docSc = String(doc.school_code || '').trim();
  if (authSc && docSc && authSc !== docSc) return false;

  const authSn = String(authOrScope.schoolName || '').trim();
  const docSn = String(doc.school_name || '').trim();
  if (!authSc && authSn && docSn && authSn !== docSn) return false;

  return true;
}

function _isStrictClassMember(doc, auth) {
  if (!doc || typeof doc !== 'object' || !auth) return false;
  if (auth.gradeNum === null || auth.gradeNum === undefined || auth.classNum === null || auth.classNum === undefined) {
    return false;
  }
  const enriched = _withInferredClass(doc);
  if (!_matchesTenant(enriched, {
    schoolCode: auth.schoolCode,
    comciganSchoolCode: auth.comciganSchoolCode,
    schoolName: auth.schoolName,
    gradeNum: auth.gradeNum,
    classNum: auth.classNum,
  })) {
    return false;
  }
  const rawG = enriched.grade !== undefined && enriched.grade !== '' ? enriched.grade : enriched.target_grade;
  const rawC = enriched.class_no !== undefined && enriched.class_no !== '' ? enriched.class_no : enriched.target_class;
  const docG = _toIntOrNull(rawG);
  const docC = _toIntOrNull(rawC);
  return docG === auth.gradeNum && docC === auth.classNum;
}

function _matchesTeacherClassOrAuthor(doc, auth) {
  if (!doc || typeof doc !== 'object' || !auth) return false;
  if (!_matchesTenant(doc, {
    schoolCode: auth.schoolCode,
    comciganSchoolCode: auth.comciganSchoolCode,
    schoolName: auth.schoolName,
    gradeNum: null,
    classNum: null,
  })) {
    return false;
  }
  const authTid = String(auth.teacherId || '').trim();
  const authNameNorm = _normalizeTeacherName(auth.teacherDoc && auth.teacherDoc.name);
  const docAuthorId = String(doc.teacher_id || doc.author_id || '').trim();
  const docAuthorNorm = _normalizeTeacherName(doc.author_name || doc.sender || '');
  const authorMatches = Boolean(
    (docAuthorId && authTid && docAuthorId === authTid) ||
    (docAuthorNorm && authNameNorm && docAuthorNorm === authNameNorm)
  );
  const rawG = doc.target_grade !== undefined && doc.target_grade !== '' ? doc.target_grade : doc.grade;
  const rawC = doc.target_class !== undefined && doc.target_class !== '' ? doc.target_class : doc.class_no;
  const docG = _toIntOrNull(rawG);
  const docC = _toIntOrNull(rawC);
  const classMatches = (
    auth.gradeNum !== null &&
    auth.classNum !== null &&
    docG === auth.gradeNum &&
    docC === auth.classNum
  );
  if (docG !== null && docC !== null) {
    return classMatches || authorMatches;
  }
  return authorMatches;
}

function _parseReplySchema(notice) {
  if (!notice || typeof notice !== 'object') return [];
  let raw = notice.reply_fields || notice.reply_schema || notice.reply_schema_json || [];
  if (typeof raw === 'string') {
    try { raw = raw.trim() ? JSON.parse(raw) : []; } catch (_) { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((f, idx) => {
    if (!f || typeof f !== 'object') return null;
    const name = String(f.name || f.id || `field_${idx}`).trim();
    const label = String(f.label || f.title || name).trim();
    const type = String(f.type || 'text').trim();
    const options = Array.isArray(f.options) ? f.options : [];
    return { name, label, type, options };
  }).filter(Boolean);
}

function _buildNoticeReplyLedger(students, notice, replies) {
  const stuList = Array.isArray(students) ? students : [];
  const repList = Array.isArray(replies) ? replies : [];
  const noticeId = String((notice && (notice.remote_id || notice.id)) || '').trim();
  const schema = _parseReplySchema(notice);

  const replyBySid = new Map();
  for (const r of repList) {
    if (!r || typeof r !== 'object') continue;
    if (noticeId && String(r.notice_id || '').trim() !== noticeId) continue;
    const sid = String(r.student_id || '').trim();
    if (sid) replyBySid.set(sid, r);
  }

  const rows = stuList
    .filter((s) => {
      const st = String(s.status || 'active').trim().toLowerCase();
      return st !== 'rejected' && st !== 'inactive' && st !== 'disabled';
    })
    .sort((a, b) => Number(a.student_no || 9999) - Number(b.student_no || 9999) || String(a.student_id || '').localeCompare(String(b.student_id || '')))
    .map((s) => {
      const sid = String(s.student_id || s.remote_id || '').trim();
      const reply = replyBySid.get(sid) || null;
      let parsedData = {};
      if (reply) {
        const rawData = reply.reply_data || reply.reply_data_json || reply.answers_json || {};
        if (typeof rawData === 'string') {
          try { parsedData = rawData.trim() ? JSON.parse(rawData) : {}; } catch (_) { parsedData = {}; }
        } else if (rawData && typeof rawData === 'object') {
          parsedData = rawData;
        }
      }
      const answers = {};
      for (const col of schema) {
        const val = parsedData[col.name] !== undefined ? parsedData[col.name] : parsedData[col.label];
        answers[col.name] = Array.isArray(val) ? val.join(', ') : (val !== undefined && val !== null ? String(val) : '');
      }
      return {
        student_id: sid,
        student_no: s.student_no ?? '',
        student_name: String(s.name || s.student_name || sid),
        parent_name: String((reply && reply.parent_name) || s.parent_name || ''),
        status: reply ? 'completed' : 'pending',
        answers,
        consent: reply ? String(reply.consent || reply.reply_choice || '제출') : '',
        memo: reply ? String(reply.memo || '') : '',
        signature_drive_url: reply ? String(reply.signature_drive_url || '') : '',
        student_signature_drive_url: reply ? String(reply.student_signature_drive_url || '') : '',
        reply_file_drive_url: reply ? String(reply.reply_file_drive_url || '') : '',
        signed_at: reply ? String(reply.signed_at || '') : '',
        submitted_at: reply ? String(reply.submitted_at || reply.updated_at || '') : '',
      };
    });

  return { schema, rows };
}

module.exports._testHelpers = {
  _handleGetMobileBundle,
  _handleLogin,
  _handleUpdateMyPhone,
  _normalizePhoneNumber,
  _matchesTenant,
  _normalizeTeacherName,
  _verifyActiveTeacherAuth,
  _handleDesktopApiAction,
  _createNoticePublishedNotification,
  _normalizeBoardSourceType,
  _upsertBoardNotice,
  _deleteBoardNotice,
  _isStrictClassMember,
  _belongsToTeacher,
  _matchesTeacherClassOrAuthor,
  _parseReplySchema,
  _buildNoticeReplyLedger,
  _parseLessonMeta,
  _normalizeFaceDescriptor,
  _buildStudentFaceDocId,
  _extractDriveFileId,
  _evaluatePcAgentOnline,
  _isPublicAcademicSchedule,
  _resolveNoticeAttachmentUrl,
};
