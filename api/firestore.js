/**
 * Vercel Serverless Function: Cloud Firestore Direct API
 * 기존 Google Apps Script 웹 앱 호출을 완전히 제거하고
 * firebase-admin SDK로 Cloud Firestore를 직접 조회·수정합니다.
 */
const crypto = require('crypto');
const { getFirestore, buildFirestoreErrorPayload } = require('./_firebaseAdmin');
const googleDrive = require('./_googleDrive');
const { uploadBase64ToDrive } = googleDrive;

function _computeTeacherDriveStatus(teacherDoc) {
  const cfg = _extractTeacherDriveConfig(teacherDoc);
  if (!cfg) {
    const envFolder = String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
    const envGas = String(process.env.GOOGLE_APPS_SCRIPT_URL || '').trim();
    return {
      drive_priority: 'workspace',
      drive_configured: Boolean(envFolder || envGas)
    };
  }
  const priority = cfg.drive_priority === 'personal' ? 'personal' : 'workspace';
  const configured = priority === 'personal'
    ? Boolean(cfg.personal_gas_url)
    : Boolean(cfg.workspace_drive_folder_id);
  return {
    drive_priority: priority,
    drive_configured: configured
  };
}

function _extractTeacherDriveConfig(teacherDoc) {
  if (!teacherDoc || typeof teacherDoc !== 'object') return null;
  const hasAny =
    teacherDoc.drive_priority !== undefined ||
    teacherDoc.workspace_drive_folder_id !== undefined ||
    teacherDoc.personal_gas_url !== undefined ||
    teacherDoc.personal_drive_folder_id !== undefined;
  if (!hasAny) return null;
  const rawPriority = String(teacherDoc.drive_priority || 'workspace').trim().toLowerCase();
  return {
    drive_priority: rawPriority === 'personal' ? 'personal' : 'workspace',
    workspace_drive_folder_id: String(teacherDoc.workspace_drive_folder_id || '').trim(),
    personal_gas_url: String(teacherDoc.personal_gas_url || '').trim(),
    personal_drive_folder_id: String(teacherDoc.personal_drive_folder_id || '').trim()
  };
}

async function _resolveTeacherDriveConfig(db, {
  teacherDoc = null,
  teacherId = '',
  schoolCode = '',
  grade = null,
  classNo = null
} = {}) {
  const directCfg = _extractTeacherDriveConfig(teacherDoc);
  if (directCfg) return directCfg;

  const tid = String(teacherId || '').trim();
  if (tid) {
    try {
      const snap = await db.collection('계정_교사').doc(tid).get();
      if (snap && snap.exists) {
        return _extractTeacherDriveConfig(snap.data());
      }
    } catch (_) {}
  }

  const sc = String(schoolCode || '').trim();
  const gNum = _toIntOrNull(grade);
  const cNum = _toIntOrNull(classNo);

  try {
    let candidates = [];
    if (sc) {
      const snap = await db.collection('계정_교사').where('school_code', '==', sc).get();
      candidates = _snapToRows(snap);
    } else if (gNum !== null) {
      const snap = await db.collection('계정_교사').where('grade', '==', gNum).get();
      candidates = _snapToRows(snap);
    }
    const active = candidates.filter((t) => {
      const st = String(t.status || 'active').trim().toLowerCase();
      return st !== 'rejected' && st !== 'inactive' && st !== 'disabled';
    });
    const matched = active.find((t) => {
      if (gNum !== null && _toIntOrNull(t.grade) !== gNum) return false;
      if (cNum !== null && _toIntOrNull(t.class_no) !== cNum) return false;
      return true;
    }) || active[0] || null;
    if (matched) return _extractTeacherDriveConfig(matched);
  } catch (_) {}

  return null;
}

function _getEnvSuperAdminIds() {
  return String(process.env.SUPER_ADMIN_IDS || process.env.SUPER_ADMIN_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function _isSuperAdmin(db, requesterId) {
  const rid = String(requesterId || '').trim();
  if (!rid) return false;
  if (_getEnvSuperAdminIds().includes(rid)) return true;
  try {
    const doc = await db.collection('계정_교사').doc(rid).get();
    if (doc.exists && doc.data() && doc.data().is_admin === true) return true;
    const found = await _findAccountDoc(db, 'teacher', rid);
    if (found && found.userDoc && found.userDoc.is_admin === true) return true;
  } catch (_) {}
  return false;
}

function _kstDateStr(dateObj, offsetDays = 0) {
  const d = dateObj || new Date();
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
}

function _nowStr(dateObj) {
  const d = dateObj || new Date();
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`;
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

async function _resolveStudentTenantScope(db, studentId, opts = {}) {
  const sid = String(studentId || '').trim();
  const teacherAuth = opts.teacherAuth || null;
  let schoolCode = String(opts.schoolCode || (teacherAuth ? teacherAuth.schoolCode : '') || '').trim();
  let schoolName = String(opts.schoolName || (teacherAuth ? teacherAuth.schoolName : '') || '').trim();
  let grade = _toIntOrNull(opts.grade ?? (teacherAuth ? teacherAuth.gradeNum : null));
  let classNo = _toIntOrNull(opts.classNo ?? (teacherAuth ? teacherAuth.classNum : null));
  let studentName = String(opts.studentName || '').trim();

  if (db && sid && (grade === null || classNo === null || !schoolCode || !schoolName || !studentName)) {
    try {
      let stuData = null;
      const candidateIds = schoolCode ? [`${schoolCode}_${sid}`, sid] : [sid];
      for (const docId of candidateIds) {
        const snap = await db.collection('계정_학생').doc(docId).get();
        if (snap.exists) {
          stuData = snap.data() || {};
          break;
        }
      }
      if (!stuData) {
        const qSnap = await db.collection('계정_학생').where('student_id', '==', sid).limit(5).get();
        qSnap.forEach((d) => {
          const candidate = d.data() || {};
          if (!stuData) stuData = candidate;
          if (teacherAuth && _isStrictClassMember({ remote_id: d.id, ...candidate }, teacherAuth)) {
            stuData = candidate;
          } else if (!teacherAuth && schoolCode && String(candidate.school_code || candidate.neis_school_code || '').trim() === schoolCode) {
            stuData = candidate;
          }
        });
      }
      if (stuData) {
        if (grade === null) grade = _toIntOrNull(stuData.grade);
        if (classNo === null) classNo = _toIntOrNull(stuData.class_no);
        if (!schoolCode) schoolCode = String(stuData.school_code || stuData.neis_school_code || '').trim();
        if (!schoolName) schoolName = String(stuData.school_name || '').trim();
        if (!studentName) studentName = String(stuData.name || stuData.student_name || '').trim();
      }
    } catch (_) {}
  }

  if (sid && (grade === null || classNo === null)) {
    const inf = _inferGradeClassFromStudentId(sid);
    if (grade === null) grade = inf.grade;
    if (classNo === null) classNo = inf.class_no;
  }

  return { schoolCode, schoolName, grade, classNo, studentName };
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
  if (parts.length === 3 && !isNaN(parseInt(parts[0], 10)) && !isNaN(parseInt(parts[1], 10)) && !isNaN(parseInt(parts[2], 10))) {
    d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0));
  } else {
    const kstParts = _kstDateStr().split('-').map(Number);
    d = new Date(Date.UTC(kstParts[0], kstParts[1] - 1, kstParts[2], 12, 0, 0));
  }
  const days = parseInt(businessDays, 10);
  const fmt = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  if (isNaN(days) || days === 0) return fmt(d);
  const step = days > 0 ? 1 : -1;
  const target = Math.abs(days);
  let counted = 0;
  let guard = 0;
  while (counted < target && guard < 365) {
    d.setUTCDate(d.getUTCDate() + step);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      counted++;
    }
    guard++;
  }
  return fmt(d);
}

function _computeDocDueDate(ruleCode, baseDate, docRulesRows) {
  const code = String(ruleCode || 'ABSENCE_REPORT').trim();
  const base = String(baseDate || '').trim() || _kstDateStr();
  const rules = Array.isArray(docRulesRows) ? docRulesRows : [];
  const matched = rules.find((r) => r && (r.rule_code === code || (code === 'ABSENCE_REPORT' && r.remote_id === 'rule_absence')));
  const defaultDays = code === 'FIELD_TRIP_PRE' ? 3 : 5;
  const days = (matched && parseInt(matched.due_business_days, 10)) || defaultDays;
  const signedDays = code === 'FIELD_TRIP_PRE' ? -Math.abs(days) : Math.abs(days);
  return _addBusinessDays(base, signedDays);
}

const STATIC_CACHE_TTL_MS = 10 * 60 * 1000;
const LOW_FREQ_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_STATIC_CACHE_ENTRIES = 500;
if (!globalThis.__eduflowStaticCache) {
  globalThis.__eduflowStaticCache = new Map();
}
const _staticCache = globalThis.__eduflowStaticCache;

function _pruneStaticCache() {
  const now = Date.now();
  for (const [k, entry] of _staticCache.entries()) {
    if (!entry || now > entry.expiresAt) {
      _staticCache.delete(k);
    }
  }
  while (_staticCache.size >= MAX_STATIC_CACHE_ENTRIES) {
    const oldestKey = _staticCache.keys().next().value;
    if (oldestKey === undefined) break;
    _staticCache.delete(oldestKey);
  }
}

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
  _pruneStaticCache();
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

async function _getCachedOrFetch(key, force, fetcher, ttlMs = STATIC_CACHE_TTL_MS) {
  const cached = _getStaticCache(key, force);
  if (cached !== undefined) return cached;
  const fresh = await fetcher();
  return _setStaticCache(key, fresh, ttlMs);
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

function _validateStringInput(val, { maxLen = 2000, required = false, label = '입력값' } = {}) {
  if (val !== undefined && val !== null && typeof val === 'object') {
    return { ok: false, error: `${label}의 형식이 올바르지 않습니다.` };
  }
  const s = String(val ?? '').trim();
  if (required && !s) {
    return { ok: false, error: `${label}이(가) 필요합니다.` };
  }
  if (s.length > maxLen) {
    return { ok: false, error: `${label}은(는) ${maxLen}자 이내로 입력해 주세요.` };
  }
  return { ok: true, value: s };
}

function _normalizeSignatureMode(rawMode, requiresReply = true) {
  const raw = String(rawMode ?? '').trim().toLowerCase();
  if (raw === 'none' || raw === '0' || raw === 'no' || raw === 'false') return 'none';
  if (raw === 'student' || raw === 'student_only') return 'student';
  if (raw === 'both' || raw === '2') return 'both';
  if (raw === 'parent' || raw === 'parent_only' || raw === 'single' || raw === '1') return 'parent';
  return requiresReply ? 'parent' : 'none';
}

function _parsePayload(req) {
  let raw = {};
  if (req.method === 'GET') {
    raw = (req.query && typeof req.query === 'object') ? req.query : {};
  } else if (typeof req.body === 'string') {
    if (req.body.length > 10 * 1024 * 1024) {
      return {};
    }
    try {
      const parsed = req.body ? JSON.parse(req.body) : {};
      raw = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) {
      raw = {};
    }
  } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    raw = { ...req.body };
  }
  if (raw && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    return { ...raw, ...raw.data };
  }
  return raw || {};
}

function _matchesTenant(doc, {
  schoolCode,
  comciganSchoolCode,
  schoolName,
  gradeNum,
  classNum,
  requireSchool = true,
  requireClass = false,
}) {
  if (!doc || typeof doc !== 'object') return false;
  const docSchoolCode = String(doc.school_code || doc.neis_school_code || '').trim();
  const docComciganCode = String(doc.comcigan_school_code || '').trim();
  const docSchoolName = String(doc.school_name || '').trim();

  const hasTenantSchool = Boolean(schoolCode || comciganSchoolCode || schoolName);
  const hasDocSchool = Boolean(docSchoolCode || docComciganCode || docSchoolName);
  if (hasTenantSchool && !hasDocSchool) {
    if (requireSchool) return false;
  } else if (hasTenantSchool && hasDocSchool) {
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
  if (requireClass) {
    if (gradeNum !== null && docG === null) return false;
    if (classNum !== null && docC === null) return false;
  } else if (gradeNum !== null && docG === null && docC !== null) {
    return false;
  }
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

const DEFAULT_SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function _getSessionTokenSecret() {
  const envSecret = String(
    process.env.AUTH_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    ''
  ).trim();
  if (envSecret) return envSecret;
  const keyMaterial = String(
    process.env.FIREBASE_PRIVATE_KEY ||
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    ''
  ).trim();
  if (keyMaterial) {
    return crypto.createHash('sha256').update(`eduflow_session:${keyMaterial}`, 'utf8').digest('hex');
  }
  const isProdOrHosted = (
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL === '1' ||
    process.env.VERCEL_ENV === 'production' ||
    process.env.VERCEL_ENV === 'preview'
  );
  if (isProdOrHosted) {
    throw new Error('AUTH_TOKEN_SECRET 환경변수가 설정되지 않았습니다.');
  }
  if (!globalThis.__eduflowEphemeralSessionSecret) {
    globalThis.__eduflowEphemeralSessionSecret = crypto.randomBytes(32).toString('hex');
  }
  return globalThis.__eduflowEphemeralSessionSecret;
}

function _base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function _base64UrlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

function _signSessionToken(claims = {}, ttlSeconds = DEFAULT_SESSION_TOKEN_TTL_SECONDS) {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0
    ? Math.floor(Number(ttlSeconds))
    : DEFAULT_SESSION_TOKEN_TTL_SECONDS;
  const headerB64 = _base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = {
    ...claims,
    iat: nowSec,
    exp: nowSec + ttl,
  };
  const payloadB64 = _base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac('sha256', _getSessionTokenSecret()).update(signingInput, 'utf8').digest();
  return {
    token: `${signingInput}.${_base64UrlEncode(sig)}`,
    expiresAt: payload.exp * 1000,
  };
}

function _verifySessionToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, error: '인증 토큰이 필요합니다.' };
  const parts = raw.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: '유효하지 않은 인증 토큰 형식입니다.' };
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto.createHmac('sha256', _getSessionTokenSecret()).update(signingInput, 'utf8').digest();
  let providedSig;
  try {
    providedSig = _base64UrlDecode(sigB64);
  } catch (_) {
    return { ok: false, error: '인증 토큰 서명을 디코딩할 수 없습니다.' };
  }
  if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, error: '인증 토큰 서명이 유효하지 않습니다.' };
  }
  let claims;
  try {
    claims = JSON.parse(_base64UrlDecode(payloadB64).toString('utf8'));
  } catch (_) {
    return { ok: false, error: '인증 토큰 페이로드가 손상되었습니다.' };
  }
  if (!claims || typeof claims !== 'object' || !claims.sub || !claims.role) {
    return { ok: false, error: '인증 토큰 클레임이 올바르지 않습니다.' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= nowSec) {
    return { ok: false, error: '세션이 만료되었습니다. 다시 로그인해 주세요.' };
  }
  return { ok: true, claims };
}

function _extractSessionToken(params, req = null) {
  const fromParams = String((params && (params.auth_token || params.token || params._bearer_token)) || '').trim();
  if (fromParams) return fromParams;
  if (req && req.headers) {
    const authHeader = String(req.headers.authorization || req.headers.Authorization || '').trim();
    if (/^Bearer\s+/i.test(authHeader)) {
      return authHeader.replace(/^Bearer\s+/i, '').trim();
    }
  }
  return '';
}

function _hasTeacherAuthCredentials(params) {
  if (!params || typeof params !== 'object') return false;
  return Boolean(
    _extractSessionToken(params) ||
    params.auth_teacher_id ||
    params.auth_password ||
    params.auth_password_hash
  );
}

function _timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function _verifyPassword(storedHash, rawPassword, providedHash, options = {}) {
  const stored = String(storedHash || '').trim();
  if (!stored) return false;
  const allowProvidedHash = Boolean(options && options.allowProvidedHash);
  if (rawPassword) {
    if (_timingSafeEqualStr(stored, String(rawPassword))) return true;
    const sha = _sha256Hex(rawPassword);
    if (_timingSafeEqualStr(stored.toLowerCase(), sha.toLowerCase())) return true;
  }
  if (allowProvidedHash && providedHash) {
    if (_timingSafeEqualStr(stored.toLowerCase(), String(providedHash).toLowerCase())) return true;
  }
  return false;
}

function _verifyRequestSession(params, req = null) {
  const token = _extractSessionToken(params, req);
  const verified = _verifySessionToken(token);
  if (!verified.ok) {
    return { ok: false, status: 401, error: verified.error || '인증 토큰이 필요합니다.' };
  }
  const { claims } = verified;
  const role = String(claims.role || '').trim().toLowerCase();
  const sub = String(claims.sub || '').trim();
  const studentId = String(claims.sid || (role === 'student' ? sub : '')).trim();
  return {
    ok: true,
    token,
    claims,
    role,
    sub,
    studentId,
    schoolCode: String(claims.sc || '').trim(),
  };
}

function _matchesSessionStudent(session, candidateSid) {
  const target = String(candidateSid || '').trim();
  if (!target) return false;
  if (session.studentId && target === session.studentId) return true;
  if (session.sub && target === session.sub) return true;
  return false;
}

async function _matchesSessionStudentWithLookup(db, session, candidateSid) {
  if (_matchesSessionStudent(session, candidateSid)) return true;
  const target = String(candidateSid || '').trim();
  if (!target || !db || !session || !session.ok || !session.sub) return false;
  if (session.role !== 'student' && session.role !== 'parent') return false;
  try {
    const { docId, userDoc } = await _findAccountDoc(db, session.role, session.sub);
    if (!userDoc) return false;
    const allowedIds = session.role === 'student'
      ? [docId, userDoc.remote_id, userDoc.student_id, userDoc.login_id, userDoc.custom_id]
      : [userDoc.student_id];
    return allowedIds
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .includes(target);
  } catch (_) {
    return false;
  }
}

function _matchesSessionAccountDoc(session, userDoc, fallbackId = '') {
  if (!session || !session.ok || !userDoc) return false;
  const keys = [
    userDoc.remote_id,
    userDoc.teacher_id,
    userDoc.student_id,
    userDoc.parent_id,
    userDoc.login_id,
    userDoc.custom_id,
    fallbackId,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return keys.includes(session.sub) || (session.studentId ? keys.includes(session.studentId) : false);
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
function _getFirebaseServiceAccountCreds() {
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (clientEmail && privateKey) {
    return { clientEmail, privateKey };
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
      if (parsed.client_email && parsed.private_key) {
        return {
          clientEmail: String(parsed.client_email).trim(),
          privateKey: String(parsed.private_key).replace(/\\n/g, '\n').trim(),
        };
      }
    } catch (_) {}
  }
  try {
    const fs = require('fs');
    const path = require('path');
    const defaultPath = path.join(process.cwd(), 'eduflow-db-b44f3-5692e5dea8c3.json');
    const targetFile = fs.existsSync(defaultPath)
      ? defaultPath
      : fs.readdirSync(process.cwd())
          .filter((f) => f.endsWith('.json') && f.includes('firebase-adminsdk'))
          .map((f) => path.join(process.cwd(), f))[0];
    if (targetFile) {
      const sa = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      if (sa.client_email && sa.private_key) {
        return { clientEmail: sa.client_email, privateKey: sa.private_key };
      }
    }
  } catch (_) {}
  return null;
}

async function _issueFirebaseCustomToken(user, role) {
  try {
    const creds = _getFirebaseServiceAccountCreds();
    if (!creds) return '';
    const normalizedRole = String(role || user.role || 'student').trim().toLowerCase();
    const uid = String(
      user.teacher_id || user.parent_id || user.student_id || user.remote_id || ''
    ).trim();
    if (!uid) return '';

    const nowSec = Math.floor(Date.now() / 1000);
    const headerB64 = _base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = {
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: nowSec,
      exp: nowSec + 3600,
      iss: creds.clientEmail,
      sub: creds.clientEmail,
      uid,
      claims: {
        role: normalizedRole,
        student_id: String(user.student_id || '').trim(),
        school_code: String(user.neis_school_code || user.school_code || '').trim(),
        grade: _toIntOrNull(user.grade),
        class_no: _toIntOrNull(user.class_no),
      },
    };
    const payloadB64 = _base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;
    const sig = crypto.createSign('RSA-SHA256').update(signingInput, 'utf8').sign(creds.privateKey);
    return `${signingInput}.${_base64UrlEncode(sig)}`;
  } catch (err) {
    console.warn('[createCustomToken error]', err && err.message ? err.message : err);
    return '';
  }
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
  if (role === 'teacher') {
    const driveStatus = _computeTeacherDriveStatus(userDoc);
    safeUser.drive_configured = driveStatus.drive_configured;
    safeUser.drive_priority = driveStatus.drive_priority;
  }
  const canonicalSub = String(
    userDoc.teacher_id || userDoc.student_id || userDoc.parent_id || userDoc.remote_id || userId
  ).trim();
  const canonicalSid = String(
    userDoc.student_id || (role === 'student' ? (userDoc.remote_id || userDoc.login_id || userDoc.custom_id || userId) : '')
  ).trim();
  const { token, expiresAt } = _signSessionToken({
    sub: canonicalSub,
    role,
    sid: canonicalSid,
    sc: String(userDoc.school_code || userDoc.neis_school_code || '').trim(),
  });
  const firebaseToken = await _issueFirebaseCustomToken(userDoc, role);
  return { status: 200, json: { ok: true, user: safeUser, token, expires_at: expiresAt, firebase_token: firebaseToken } };
}

async function _handleVerifySession(db, params, req = null) {
  const token = _extractSessionToken(params, req);
  const verified = _verifySessionToken(token);
  if (!verified.ok) {
    return { status: 401, json: { ok: false, error: verified.error } };
  }
  const { claims } = verified;
  const role = String(claims.role || '').trim().toLowerCase();
  const userId = String(claims.sub || '').trim();
  const { userDoc } = await _findAccountDoc(db, role, userId);
  if (!userDoc) {
    return { status: 401, json: { ok: false, error: '등록되지 않은 계정입니다.' } };
  }
  const accStatus = String(userDoc.status || 'active').trim().toLowerCase();
  if (accStatus === 'pending' || accStatus === 'rejected' || (accStatus !== '' && accStatus !== 'active')) {
    return { status: 403, json: { ok: false, error: '활성화(active)된 계정만 사용할 수 있습니다.' } };
  }
  const safeUser = { ...userDoc, role, phone: String(userDoc.phone || '') };
  delete safeUser.password_hash;
  if (role === 'teacher') {
    const driveStatus = _computeTeacherDriveStatus(userDoc);
    safeUser.drive_configured = driveStatus.drive_configured;
    safeUser.drive_priority = driveStatus.drive_priority;
  }
  const firebaseToken = await _issueFirebaseCustomToken(userDoc, role);
  return {
    status: 200,
    json: {
      ok: true,
      user: safeUser,
      token,
      expires_at: Number(claims.exp) * 1000,
      firebase_token: firebaseToken,
    },
  };
}

async function _handleChangePassword(db, body, req = null) {
  const session = _verifyRequestSession(body, req);
  if (!session.ok) {
    return { status: session.status, json: { ok: false, error: session.error } };
  }
  const role = String(body.role || session.role || 'student').trim().toLowerCase();
  const userId = String(body.user_id || session.sub || '').trim();
  const currentPassword = String(body.current_password || '');
  const currentPasswordHash = String(body.current_password_hash || '');
  const newPassword = String(body.new_password || '');

  if (session.role !== role) {
    return { status: 403, json: { ok: false, error: '본인 역할의 계정만 비밀번호를 변경할 수 있습니다.' } };
  }
  if (!userId || !newPassword) {
    return { status: 400, json: { ok: false, error: '아이디와 새 비밀번호를 입력해 주세요.' } };
  }
  if (newPassword.length < 4) {
    return { status: 400, json: { ok: false, error: '새 비밀번호는 4자 이상이어야 합니다.' } };
  }

  const { colRef, docId, userDoc } = await _findAccountDoc(db, role, userId);
  if (!userDoc || !docId) {
    return { status: 404, json: { ok: false, error: '계정을 찾을 수 없습니다.' } };
  }
  if (!_matchesSessionAccountDoc(session, userDoc, docId)) {
    return { status: 403, json: { ok: false, error: '본인 계정의 비밀번호만 변경할 수 있습니다.' } };
  }

  if (!_verifyPassword(userDoc.password_hash, currentPassword, currentPasswordHash)) {
    return { status: 401, json: { ok: false, error: '현재 비밀번호가 일치하지 않습니다.' } };
  }

  const newHash = _sha256Hex(newPassword);
  await colRef.doc(docId).set(
    { password_hash: newHash, updated_at: _nowStr() },
    { merge: true }
  );

  const canonicalSub = String(
    userDoc.teacher_id || userDoc.student_id || userDoc.parent_id || userDoc.remote_id || userId
  ).trim();
  const canonicalSid = String(
    userDoc.student_id || (role === 'student' ? (userDoc.remote_id || userDoc.login_id || userDoc.custom_id || userId) : '')
  ).trim();
  const { token, expiresAt } = _signSessionToken({
    sub: canonicalSub,
    role,
    sid: canonicalSid,
    sc: String(userDoc.school_code || userDoc.neis_school_code || '').trim(),
  });
  return { status: 200, json: { ok: true, message: '비밀번호가 안전하게 변경되었습니다.', token, expires_at: expiresAt } };
}

async function _handleChangeCustomId(db, body, req = null) {
  const session = _verifyRequestSession(body, req);
  if (!session.ok) {
    return { status: session.status, json: { ok: false, error: session.error } };
  }
  const role = String(body.role || session.role || 'student').trim().toLowerCase();
  const userId = String(body.user_id || session.sub || '').trim();
  const newCustomId = String(body.new_custom_id || '').trim();

  if (role !== 'student' && role !== 'parent') {
    return { status: 400, json: { ok: false, error: '학생 또는 학부모 계정만 커스텀 ID를 변경할 수 있습니다.' } };
  }
  if (session.role !== role) {
    return { status: 403, json: { ok: false, error: '본인 역할의 계정만 커스텀 ID를 변경할 수 있습니다.' } };
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
  if (!_matchesSessionAccountDoc(session, userDoc, docId)) {
    return { status: 403, json: { ok: false, error: '본인 계정의 커스텀 ID만 변경할 수 있습니다.' } };
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

async function _handleUpdateMyPhone(db, body, req = null) {
  const session = _verifyRequestSession(body, req);
  if (!session.ok) {
    return { status: session.status, json: { ok: false, error: session.error } };
  }
  const role = String(body.role || session.role || 'student').trim().toLowerCase();
  if (role !== 'student' && role !== 'parent') {
    return { status: 400, json: { ok: false, error: '학생 또는 학부모 계정만 본인 연락처를 수정할 수 있습니다.' } };
  }
  if (session.role !== role) {
    return { status: 403, json: { ok: false, error: '본인 역할의 계정만 연락처를 수정할 수 있습니다.' } };
  }
  const userId = String(body.user_id || body.student_id || body.parent_id || body.remote_id || session.sub || '').trim();
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
  if (!_matchesSessionAccountDoc(session, userDoc, docId)) {
    return { status: 403, json: { ok: false, error: '본인 계정의 연락처만 수정할 수 있습니다.' } };
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
  _invalidateStaticCache('students_');

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
    _invalidateStaticCache('teacher');
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
    await _notifyClassTeachers(db, {
      title: `[가입 신청] ${name}`,
      message: `학부모(${name}) 가입 신청이 접수되었습니다. (자녀: ${childName})`,
      channel: 'registration_pending',
      sender: name,
      schoolCode: neisSchoolCode || String(matchedStudent.school_code || ''),
      schoolName: schoolName || String(matchedStudent.school_name || ''),
      grade: gradeNum ?? matchedStudent.grade ?? null,
      classNo: classNum ?? matchedStudent.class_no ?? null,
      studentId: childSid
    });
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
  await _notifyClassTeachers(db, {
    title: `[가입 신청] ${name}`,
    message: `학생(${name}) 가입 신청이 접수되었습니다.`,
    channel: 'registration_pending',
    sender: name,
    schoolCode: neisSchoolCode,
    schoolName,
    grade: gradeNum,
    classNo: classNum,
    studentId: computedSid
  });
  _invalidateStaticCache('students_');
  return { status: 200, json: { ok: true, status: 'pending', message: '학생 가입 신청이 접수되었습니다. 담임 교사 승인 후 로그인할 수 있습니다.' } };
}

const PC_AGENT_ONLINE_TTL_MS = 3 * 60 * 1000;

function _parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw || '').trim();
  if (!s) return NaN;
  let normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
  // 타임존 표기가 없는 YYYY-MM-DDTHH:mm(:ss) 문자열은 한국 표준시(+09:00)로 해석
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
    normalized += '+09:00';
  }
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
}

const PUBLIC_STUDENT_SCHEDULE_CATEGORIES = new Set(['학사일정', '수행평가']);

function _isPublicAcademicSchedule(row) {
  if (!row || typeof row !== 'object') return false;
  if (_toBool(row.is_private) || String(row.visibility || '').trim().toLowerCase() === 'private') {
    return false;
  }
  const cat = String(row.category || row.type || '').trim();
  return PUBLIC_STUDENT_SCHEDULE_CATEGORIES.has(cat);
}

function _evaluatePcAgentOnline(statusDoc, nowMs = Date.now()) {
  if (!statusDoc || typeof statusDoc !== 'object') return false;
  if (!_toBool(statusDoc.pc_online)) return false;
  const seenMs = _parseTimestampMs(statusDoc.pc_last_seen_at);
  if (!Number.isFinite(seenMs)) return false;
  const diff = nowMs - seenMs;
  return diff >= -60 * 1000 && diff <= PC_AGENT_ONLINE_TTL_MS;
}

async function _queryTeacherClassScoped(db, colName, gradeNum, classNum, gradeIn, maxLimit) {
  if (gradeNum !== null && classNum !== null) {
    try {
      const snap = await db
        .collection(colName)
        .where('grade', '==', gradeNum)
        .where('class_no', '==', classNum)
        .limit(maxLimit)
        .get();
      return _snapToRows(snap);
    } catch (err) {
      const isIndexErr = err && (err.code === 9 || /index|FAILED_PRECONDITION/i.test(String(err.message || '')));
      if (!isIndexErr) throw err;
    }
  }
  if (gradeIn.length > 0) {
    return db.collection(colName).where('grade', 'in', gradeIn).limit(maxLimit).get().then(_snapToRows);
  }
  return [];
}

async function _queryWithOrderByFallback(baseQuery, orderField = 'created_at', direction = 'desc', limitNum = 30) {
  if (baseQuery && typeof baseQuery.orderBy === 'function') {
    try {
      const snap = await baseQuery.orderBy(orderField, direction).limit(limitNum).get();
      return _snapToRows(snap);
    } catch (err) {
      const isIndexErr = err && (err.code === 9 || /index|FAILED_PRECONDITION/i.test(String(err.message || '')));
      if (!isIndexErr) throw err;
    }
  }
  const snap = await baseQuery.limit(limitNum).get();
  const rows = _snapToRows(snap);
  rows.sort((a, b) => {
    const va = String((a && (a[orderField] || a.updated_at)) || '');
    const vb = String((b && (b[orderField] || b.updated_at)) || '');
    return direction === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  return rows;
}

async function _handleGetMobileBundle(db, params) {
  const role = String(params.role || 'student').trim().toLowerCase();
  const studentId = String(params.student_id || '').trim();
  const userId = String(params.user_id || '').trim();
  const gradeNum = _toIntOrNull(params.grade);
  const classNum = _toIntOrNull(params.class_no);
  const schoolCode = String(params.school_code || params.neis_school_code || '').trim();
  const schoolName = String(params.school_name || '').trim();
  const forceRefresh = String(params.force || '') === '1' || String(params.force_refresh || '') === '1';
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
  const mealsCacheKey = `meals:all:${todayStr}`;
  const budgetCacheKey = gradeNum !== null ? `budget_grade:${gradeNum}` : 'budget_all';
  const schedulesCacheKey = `schedules:${schoolCode || 'all'}`;
  const studentsCacheKey = (gradeNum !== null && classNum !== null)
    ? `students_class:${gradeNum}_${classNum}`
    : (gradeNum !== null ? `students_grade:${gradeNum}` : null);
  const subjectRostersCacheKey = userId ? `subject_rosters:${userId}` : null;
  const includeNotifications = String(params.include_notifications || '') === '1';
  const includeChat = String(params.include_chat || '') === '1';
  const effectiveStudentId = studentId || (role !== 'teacher' ? userId : '');

  // 읽기 비용 최적화 (단일 필드 where만 사용해 복합 인덱스 오류 방지 + 정적/저빈도 데이터 서버 메모리 캐시):
  const timetableSnapshotsRaw = await db
    .collection('시간표_스냅샷')
    .where('date', '==', todayStr)
    .get()
    .then(_snapToRows)
    .catch(() => []);

  const hasTodaySnapshot = (timetableSnapshotsRaw || []).some((s) =>
    _matchesTenant(s, { schoolCode, comciganSchoolCode: params.comcigan_school_code || '', schoolName, gradeNum: null, classNum: null })
  );

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
    role !== 'teacher'
      ? (effectiveStudentId
          ? db.collection('계정_학생').doc(effectiveStudentId).get().then(async (d) => {
              if (d.exists) return [{ remote_id: d.id, ...d.data() }];
              if (sidIn.length > 0) {
                return db.collection('계정_학생').where('student_id', 'in', sidIn).limit(1).get().then(_snapToRows);
              }
              return [];
            })
          : Promise.resolve([]))
      : (!skipStatic && studentsCacheKey
          ? _getCachedOrFetch(
              studentsCacheKey,
              forceRefresh,
              () => _queryTeacherClassScoped(db, '계정_학생', gradeNum, classNum, gradeIn, 60),
              STATIC_CACHE_TTL_MS
            )
          : Promise.resolve(studentsCacheKey ? undefined : [])),
    isStudentScoped && sidIn.length > 0
      ? db.collection('일일_출결').where('student_id', 'in', sidIn).limit(200).get().then(_snapToRows)
      : (gradeIn.length > 0
          ? Promise.all([
              db.collection('일일_출결').where('date', '==', todayStr).limit(300).get().then(_snapToRows).catch(() => []),
              db.collection('일일_출결').where('teacher_confirmed', '==', false).limit(100).get().then(_snapToRows).catch(() => []),
            ]).then(([todayRows, unconfirmedRows]) => _mergeRowsById(todayRows, unconfirmedRows))
          : Promise.resolve([])),
    isStudentScoped && sidIn.length > 0
      ? db.collection('서류_추적').where('student_id', 'in', sidIn).limit(50).get().then(_snapToRows)
      : (gradeIn.length > 0
          ? Promise.all([
              db.collection('서류_추적')
                .where('status', 'in', ['pending', 'submitted', '미제출', '제출했습니다', '학생확인완료'])
                .limit(100)
                .get()
                .then(_snapToRows)
                .catch(() => []),
              _queryTeacherClassScoped(db, '서류_추적', gradeNum, classNum, gradeIn, 30),
            ]).then(([activeDocs, classDocs]) => _mergeRowsById(activeDocs, classDocs))
          : Promise.resolve([])),
    _queryWithOrderByFallback(db.collection('가정통신문_목록'), 'created_at', 'desc', 20),
    isStudentScoped && sidIn.length > 0
      ? _queryWithOrderByFallback(db.collection('가정통신문_회신').where('student_id', 'in', sidIn), 'created_at', 'desc', 20)
      : (gradeNum !== null
          ? _getCachedOrFetch(
              `notice_replies_grade:${gradeNum}`,
              forceRefresh,
              () => _queryWithOrderByFallback(db.collection('가정통신문_회신').where('grade', '==', gradeNum), 'created_at', 'desc', 30).catch(() => []),
              LOW_FREQ_CACHE_TTL_MS
            )
          : Promise.resolve([])),
    !skipStatic && !hasTodaySnapshot && ttBaseCacheKey
      ? _getCachedOrFetch(ttBaseCacheKey, forceRefresh, () =>
          db.collection('시간표_기본').where('grade', 'in', gradeIn).limit(300).get().then(_snapToRows)
        )
      : Promise.resolve(hasTodaySnapshot ? [] : undefined),
    hasTodaySnapshot
      ? db.collection('시간표_변동').where('date', '==', todayStr).limit(100).get().then(_snapToRows)
      : (gradeIn.length > 0
          ? db.collection('시간표_변동').where('grade', 'in', gradeIn).limit(100).get().then(_snapToRows)
          : db.collection('시간표_변동').where('date', '>=', todayStr).limit(100).get().then(_snapToRows)),
    !skipStatic
      ? _getCachedOrFetch(mealsCacheKey, forceRefresh, () =>
          db.collection('급식_식단표').where('meal_date', '>=', todayStr).limit(300).get().then(_snapToRows)
        )
      : Promise.resolve(undefined),
    !skipStatic
      ? _getCachedOrFetch(schoolCode ? `doc_rules:${schoolCode}` : 'doc_rules', forceRefresh, () =>
          (schoolCode
            ? db.collection('설정_서류규정').where('school_code', '==', schoolCode).limit(50).get().then(_snapToRows)
            : db.collection('설정_서류규정').limit(50).get().then(_snapToRows))
        )
      : Promise.resolve(undefined),
    includeChat
      ? (isStudentScoped
          ? _queryWithOrderByFallback(db.collection('1:1_상담채팅').where('room_id', '==', `ROOM-${studentId}`), 'created_at', 'desc', 100)
          : (gradeIn.length > 0
              ? _queryWithOrderByFallback(db.collection('1:1_상담채팅').where('grade', 'in', gradeIn), 'created_at', 'desc', 150)
              : _queryWithOrderByFallback(db.collection('1:1_상담채팅'), 'created_at', 'desc', 100)))
      : (role === 'teacher'
          ? _queryWithOrderByFallback(db.collection('1:1_상담채팅').where('is_read', '==', false), 'created_at', 'desc', 20).catch(() => [])
          : Promise.resolve(undefined)),
    includeNotifications
      ? (schoolCode
          ? _queryWithOrderByFallback(db.collection('Notifications').where('school_code', '==', schoolCode), 'created_at', 'desc', 30)
          : (gradeIn.length > 0
              ? _queryWithOrderByFallback(db.collection('Notifications').where('grade', 'in', gradeIn), 'created_at', 'desc', 30)
              : _queryWithOrderByFallback(db.collection('Notifications').where('is_read', '==', false), 'created_at', 'desc', 30)))
      : Promise.resolve(undefined),
    !skipStatic
      ? _getCachedOrFetch(budgetCacheKey, forceRefresh, () => (
          gradeIn.length > 0
            ? db.collection('학급회비').where('grade', 'in', gradeIn).limit(100).get().then(_snapToRows)
            : db.collection('학급회비').limit(100).get().then(_snapToRows)
        ), LOW_FREQ_CACHE_TTL_MS)
      : Promise.resolve(undefined),
    gradeIn.length > 0
      ? _queryWithOrderByFallback(db.collection('학급_공지게시판').where('grade', 'in', gradeIn), 'created_at', 'desc', 20)
      : _queryWithOrderByFallback(db.collection('학급_공지게시판'), 'created_at', 'desc', 20),
    role === 'teacher' && subjectRostersCacheKey
      ? (!skipStatic
          ? _getCachedOrFetch(
              subjectRostersCacheKey,
              forceRefresh,
              () => db.collection('교과_명렬표').where('teacher_id', '==', userId).limit(50).get().then(_snapToRows).catch(() => []),
              STATIC_CACHE_TTL_MS
            )
          : Promise.resolve(undefined))
      : Promise.resolve([]),
    role === 'teacher' && userId
      ? db.collection('교과_출결').where('date', '==', todayStr).limit(40).get().then(_snapToRows).catch(() => [])
      : Promise.resolve([]),
    role === 'teacher' && userId
      ? (!skipStatic
          ? _getCachedOrFetch(
              `lesson_progress:${userId}`,
              forceRefresh,
              () => db.collection('수업_진도').where('teacher_id', '==', userId).limit(30).get().then(_snapToRows).catch(() => []),
              LOW_FREQ_CACHE_TTL_MS
            )
          : Promise.resolve(undefined))
      : Promise.resolve([]),
    role === 'teacher' && userId
      ? db.collection('PC_Agent_Status').doc(userId).get().then((d) => (d.exists ? { remote_id: d.id, ...d.data() } : null)).catch(() => null)
      : Promise.resolve(null),
    role === 'teacher' && userId
      ? (!skipStatic
          ? _getCachedOrFetch(
              `remote_tasks:${userId}`,
              forceRefresh,
              () => db.collection('Tasks').where('teacher_id', '==', userId).limit(15).get().then(_snapToRows).catch(() => []),
              LOW_FREQ_CACHE_TTL_MS
            )
          : Promise.resolve(undefined))
      : Promise.resolve([]),
    !skipStatic
      ? _getCachedOrFetch(schedulesCacheKey, forceRefresh, () =>
          _queryWithOrderByFallback(db.collection('Schedules'), 'start_date', 'desc', 80).catch(() => []),
          LOW_FREQ_CACHE_TTL_MS
        )
      : Promise.resolve(undefined),
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

  if (role === 'teacher' && teacherCandidates.length > 0 && !hasTodaySnapshot) {
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

  const _stripSensitiveFields = (d) => {
    if (!d || typeof d !== 'object') return d;
    const { password_hash: _pw, ...safe } = d;
    return safe;
  };
  const _stripTeacherDriveFields = (d) => {
    if (!d || typeof d !== 'object') return d;
    const {
      drive_priority: _dp,
      workspace_drive_folder_id: _wdf,
      personal_gas_url: _pgu,
      personal_drive_folder_id: _pdf,
      drive_configured: _dc,
      ...safe
    } = d;
    return safe;
  };
  const classTenant = { ...tenant, requireClass: true };
  const isTeacherRole = role === 'teacher';
  const teachersSnap = teachersRaw
    .filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }))
    .map(_stripSensitiveFields)
    .map((d) => {
      const isSelfTeacher = isTeacherRole && (
        String(d.teacher_id || '') === userId || String(d.remote_id || '') === userId
      );
      return isSelfTeacher ? d : _stripTeacherDriveFields(d);
    });
  const filteredStudents = Array.isArray(studentsRows)
    ? studentsRows.filter((d) => _matchesTenant(d, classTenant)).map(_stripSensitiveFields)
    : undefined;
  const studentIdSet = new Set((filteredStudents || []).map((s) => String(s.student_id || s.remote_id || '')).filter(Boolean));
  const filteredNotices = noticesRaw
    .filter((d) => {
      if (!_matchesTenant(d, tenant)) return false;
      if (!isTeacherRole) {
        const isPub = d.is_published === undefined ? true : _toBool(d.is_published);
        if (!isPub) return false;
      }
      return true;
    })
    .map(_withNormalizedNoticeAttachment)
    .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));
  const noticeIdSet = new Set(filteredNotices.map((n) => String(n.remote_id || '')).filter(Boolean));

  const matchedSnapshots = (timetableSnapshotsRaw || []).filter((d) => _matchesTenant(d, ttTeacherTenant));
  const snapshotDateSet = new Set(
    matchedSnapshots.map((s) => String((s && s.date) || '').trim().slice(0, 10)).filter(Boolean)
  );
  const _isComciganChangeDoc = (c) => {
    if (!c || typeof c !== 'object') return false;
    const src = String(c.source || '').trim().toLowerCase();
    const rid = String(c.remote_id || '').trim();
    return src === 'comcigan' || src === 'comcigan_playwright' || rid.startsWith('tc_');
  };

  const bundle = {
    ok: true,
    backend: 'firestore',
    server_time: _nowStr(),
    teachers: teachersSnap,
    attendance: attendanceRows.map(_withInferredClass).filter((d) => _matchesTenant(d, classTenant)),
    doc_tracking: docTrackingRows
      .map(_withInferredClass)
      .filter((d) => _matchesTenant(d, classTenant))
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
    timetable_snapshots: matchedSnapshots,
    timetable_changes: timetableChangesRows
      .filter(_matchesTimetableRow)
      .filter((c) => {
        const cDate = String((c && (c.date || c.target_date)) || '').trim().slice(0, 10);
        if (snapshotDateSet.has(cDate) && _isComciganChangeDoc(c)) return false;
        return true;
      }),
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

  if (isTeacherRole) {
    const myTeacherDoc = teachersSnap.find((t) =>
      String(t.teacher_id || '') === userId || String(t.remote_id || '') === userId
    ) || teachersSnap[0] || null;
    const driveStatus = _computeTeacherDriveStatus(myTeacherDoc);
    bundle.drive_configured = driveStatus.drive_configured;
    bundle.drive_priority = driveStatus.drive_priority;
    if (myTeacherDoc) {
      bundle.workspace_drive_folder_id = String(myTeacherDoc.workspace_drive_folder_id || '').trim();
      bundle.personal_gas_url = String(myTeacherDoc.personal_gas_url || '').trim();
      bundle.personal_drive_folder_id = String(myTeacherDoc.personal_drive_folder_id || '').trim();
    }
  }
  if (filteredStudents !== undefined) {
    bundle.students = filteredStudents;
  }
  if (includeChat && Array.isArray(chatRows)) {
    bundle.chat_messages = chatRows.filter((d) => _matchesTenant(d, classTenant));
  } else if (role === 'teacher' && Array.isArray(chatRows)) {
    bundle.chat_unread_count = chatRows.filter((d) =>
      _matchesTenant(d, classTenant) && String(d.sender_role || '').trim().toLowerCase() !== 'teacher'
    ).length;
  }
  if (notificationsRaw !== undefined) {
    const readerCandidates = [userId, effectiveStudentId]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    const sidCandidates = _studentIdCandidates(effectiveStudentId).map((x) => String(x).trim());
    bundle.notifications = notificationsRaw
      .filter((d) => {
        if (!_matchesTenant(d, tenant)) return false;
        const nRole = String(d.target_role || 'all').trim().toLowerCase();
        if (role !== 'teacher') {
          if (nRole === 'teacher') return false;
          if (nRole && nRole !== 'all' && nRole !== role) return false;
          const targetSid = String(d.target_student_id || d.student_id || '').trim();
          if (targetSid) {
            const matchedSid = sidCandidates.includes(targetSid) || (userId && targetSid === userId);
            if (!matchedSid) return false;
          }
        }
        return true;
      })
      .map((d) => {
        const targetSid = String(d.target_student_id || d.student_id || '').trim();
        if (!targetSid) {
          const readBy = Array.isArray(d.read_by) ? d.read_by.map((x) => String(x).trim()) : [];
          if (readerCandidates.some((id) => readBy.includes(id))) {
            return { ...d, is_read: true };
          }
        }
        return d;
      })
      .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));
  }
  if (budgetRows !== undefined) {
    bundle.budget = budgetRows.filter((d) => _matchesTenant(d, classTenant));
  }
  if (timetableBaseRows !== undefined) bundle.timetable_base = timetableBaseRows.filter(_matchesTimetableRow);
  if (mealsRaw !== undefined) bundle.meals = mealsRaw.filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }));
  if (docRulesRows !== undefined) {
    bundle.doc_rules = docRulesRows.filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }));
  }
  const teacherScope = { teacherId: userId, schoolCode, schoolName };
  if (schedulesRaw !== undefined) {
    const hasStudentClass = gradeNum !== null && classNum !== null;
    const homeroomTeacherIds = !isTeacherRole && hasStudentClass
      ? new Set(
          (teachersRaw || [])
            .filter((t) => _matchesTenant(t, classTenant))
            .map((t) => String(t.teacher_id || t.remote_id || '').trim())
            .filter(Boolean)
        )
      : null;
    bundle.schedules = (schedulesRaw || [])
      .filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }))
      .filter((d) => {
        if (isTeacherRole) return _belongsToTeacher(d, teacherScope);
        const docTid = String((d && d.teacher_id) || '').trim();
        return Boolean(docTid && homeroomTeacherIds && homeroomTeacherIds.has(docTid)) && _isPublicAcademicSchedule(d);
      })
      .sort((a, b) => String(a.start_date || a.date || '').localeCompare(String(b.start_date || b.date || '')));
  }
  if (isTeacherRole) {
    if (subjectRostersRaw !== undefined) {
      bundle.subject_rosters = (subjectRostersRaw || []).filter((d) => _belongsToTeacher(d, teacherScope));
    }
    bundle.subject_attendance = (subjectAttRaw || [])
      .filter((d) => _belongsToTeacher(d, teacherScope))
      .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));
    if (lessonProgressRaw !== undefined) {
      bundle.lesson_progress = (lessonProgressRaw || [])
        .filter((d) => _belongsToTeacher(d, teacherScope))
        .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));
    }
    const rawPcStatus = pcAgentStatusDoc || (teachersRaw[0] ? {
      pc_online: teachersRaw[0].pc_online !== undefined ? teachersRaw[0].pc_online : teachersRaw[0].pc_agent_online,
      pc_last_seen_at: teachersRaw[0].pc_last_seen_at || teachersRaw[0].pc_agent_last_seen,
      pc_hostname: teachersRaw[0].pc_hostname || teachersRaw[0].pc_agent_hostname,
      pc_app_version: teachersRaw[0].pc_app_version || teachersRaw[0].pc_agent_version,
    } : null);
    bundle.pc_agent_status = {
      pc_online: Boolean(rawPcStatus && _toBool(rawPcStatus.pc_online)),
      pc_last_seen_at: String((rawPcStatus && rawPcStatus.pc_last_seen_at) || ''),
      pc_hostname: String((rawPcStatus && rawPcStatus.pc_hostname) || ''),
      pc_app_version: String((rawPcStatus && rawPcStatus.pc_app_version) || ''),
      is_online: _evaluatePcAgentOnline(rawPcStatus),
    };
    if (remoteTasksRaw !== undefined) {
      bundle.remote_tasks = (remoteTasksRaw || [])
        .filter((t) => _toBool(t.is_mobile_task) && String(t.teacher_id || '').trim() === userId)
        .sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));
    }
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
  const fromYmd = _kstDateStr(now, 0).replace(/-/g, '');
  const toYmd = _kstDateStr(now, 6).replace(/-/g, '');

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
  const bearerToken = _extractSessionToken(params, req);
  if (bearerToken && !params._bearer_token) {
    params._bearer_token = bearerToken;
  }
  if (params.action !== undefined && typeof params.action !== 'string') {
    return res.status(400).json({ ok: false, error: 'action 파라미터 형식이 올바르지 않습니다.' });
  }
  const action = String(params.action || '').trim();
  if (!action || action.length > 100) {
    return res.status(400).json({ ok: false, error: '유효한 action 파라미터가 필요합니다.' });
  }

  try {
    const db = getFirestore();

    if (action === 'login') {
      const result = await _handleLogin(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'verify_session') {
      const result = await _handleVerifySession(db, params, req);
      return res.status(result.status).json(result.json);
    }

    if (action === 'change_password') {
      const result = await _handleChangePassword(db, params, req);
      return res.status(result.status).json(result.json);
    }

    if (action === 'change_custom_id') {
      const result = await _handleChangeCustomId(db, params, req);
      return res.status(result.status).json(result.json);
    }

    if (action === 'update_my_phone') {
      const result = await _handleUpdateMyPhone(db, params, req);
      return res.status(result.status).json(result.json);
    }

    if (action === 'register_account') {
      const result = await _handleRegisterAccount(db, params);
      return res.status(result.status).json(result.json);
    }

    if (action === 'get_pending_registrations') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const requesterId = adminAuth.teacherId;
      const isAdmin = await _isSuperAdmin(db, requesterId);
      const gradeNum = isAdmin ? _toIntOrNull(params.grade) : adminAuth.gradeNum;
      const classNum = isAdmin ? _toIntOrNull(params.class_no) : adminAuth.classNum;
      const schoolCode = isAdmin ? String(params.school_code || adminAuth.schoolCode || '').trim() : adminAuth.schoolCode;
      const schoolName = isAdmin ? String(params.school_name || adminAuth.schoolName || '').trim() : adminAuth.schoolName;

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

      const filtered = items.filter((d) => (
        isAdmin
          ? _matchesTenant(d, { schoolCode, schoolName, gradeNum, classNum })
          : _isStrictClassMember(d, adminAuth)
      ));
      if (isAdmin && snaps[2]) {
        snaps[2].forEach((d) => {
          const td = { remote_id: d.id, role: 'teacher', ...d.data() };
          if (_matchesTenant(td, { schoolCode, schoolName, gradeNum: null, classNum: null })) {
            filtered.push(td);
          }
        });
      }
      filtered.forEach((d) => { delete d.password_hash; });
      return res.status(200).json({ ok: true, is_super_admin: isAdmin, items: filtered });
    }

    if (action === 'review_registration') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const requesterId = adminAuth.teacherId;
      const targetRole = String(params.target_role || 'student').trim().toLowerCase();
      const rid = String(params.remote_id || '').trim();
      const decision = String(params.decision || 'approve').trim().toLowerCase();

      if (targetRole === 'teacher') {
        const isAdmin = await _isSuperAdmin(db, requesterId);
        if (!isAdmin) {
          return res.status(403).json({
            ok: false,
            error: '신규 교사 가입 승인·반려는 최고 관리자만 처리할 수 있습니다.'
          });
        }
      }

      const colName = targetRole === 'parent' ? '계정_학부모' : (targetRole === 'teacher' ? '계정_교사' : '계정_학생');
      if (!rid) return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      const targetSnap = await db.collection(colName).doc(rid).get();
      if (!targetSnap.exists) {
        return res.status(404).json({ ok: false, error: '대상 계정을 찾을 수 없습니다.' });
      }
      const targetData = { remote_id: targetSnap.id, ...(targetSnap.data() || {}) };
      if (targetRole === 'teacher') {
        const scopedSchoolCode = String(params.school_code || adminAuth.schoolCode || '').trim();
        const scopedSchoolName = String(params.school_name || adminAuth.schoolName || '').trim();
        if (scopedSchoolCode || scopedSchoolName) {
          if (!_matchesTenant(targetData, { schoolCode: scopedSchoolCode, schoolName: scopedSchoolName, gradeNum: null, classNum: null })) {
            return res.status(403).json({ ok: false, error: '해당 학교의 교사 가입 요청만 처리할 수 있습니다.' });
          }
        }
      } else if (!_isStrictClassMember(targetData, adminAuth)) {
        return res.status(403).json({ ok: false, error: '담당 학급의 학생·학부모 가입 요청만 처리할 수 있습니다.' });
      }
      const isApproved = decision === 'approve';
      await db.collection(colName).doc(rid).set(
        { status: isApproved ? 'active' : 'rejected', updated_at: _nowStr() },
        { merge: true }
      );
      if (targetRole === 'teacher') _invalidateStaticCache('teacher');
      else if (targetRole === 'student') _invalidateStaticCache('students_');

      const regSid = String(targetData.student_id || '').trim();
      const regName = String(targetData.name || targetData.student_name || rid).trim();
      const regStatusMsg = isApproved
        ? `${regName}님의 가입 신청이 승인되었습니다. 로그인하여 이용해 주세요.`
        : `${regName}님의 가입 신청이 반려되었습니다. 담임 교사 또는 관리자에게 문의해 주세요.`;
      if (targetRole === 'teacher') {
        await _notifyClassTeachers(db, {
          title: isApproved ? '[가입 승인]' : '[가입 반려]',
          message: regStatusMsg,
          channel: 'registration_review',
          sender: '관리자',
          teacherId: String(targetData.teacher_id || rid).trim(),
          schoolCode: String(targetData.school_code || adminAuth.schoolCode || '').trim(),
          schoolName: String(targetData.school_name || adminAuth.schoolName || '').trim(),
          grade: targetData.grade,
          classNo: targetData.class_no,
        });
      } else if (regSid) {
        await _notifyStudentAndParent(db, {
          title: isApproved ? '[가입 승인]' : '[가입 반려]',
          message: regStatusMsg,
          channel: 'registration_review',
          sender: String((adminAuth.teacherDoc && adminAuth.teacherDoc.name) || '담임교사'),
          targetRole,
          schoolCode: String(targetData.school_code || adminAuth.schoolCode || '').trim(),
          schoolName: String(targetData.school_name || adminAuth.schoolName || '').trim(),
          grade: targetData.grade ?? adminAuth.gradeNum,
          classNo: targetData.class_no ?? adminAuth.classNum,
          studentId: regSid,
          targetUserId: String(targetData.parent_id || targetData.student_id || '').trim(),
        });
      }
      return res.status(200).json({ ok: true, status: isApproved ? 'active' : 'rejected', notification_sent: true });
    }

    if (action === 'get_mobile_bundle') {
      const session = _verifyRequestSession(params, req);
      if (!session.ok) {
        return res.status(session.status).json({ ok: false, error: session.error });
      }
      const requestedRole = String(params.role || session.role || 'student').trim().toLowerCase();
      if (requestedRole !== session.role) {
        return res.status(403).json({ ok: false, error: '세션 역할과 일치하지 않는 번들 요청입니다.' });
      }
      const scopedParams = { ...params, role: session.role };
      if (session.role === 'teacher') {
        const reqUid = String(params.user_id || '').trim();
        if (reqUid && reqUid !== session.sub) {
          return res.status(403).json({ ok: false, error: '본인 교사 계정의 데이터만 조회할 수 있습니다.' });
        }
        scopedParams.user_id = session.sub;
      } else {
        const reqSid = String(params.student_id || '').trim();
        const reqUid = String(params.user_id || '').trim();
        if (reqSid && !_matchesSessionStudent(session, reqSid)) {
          return res.status(403).json({ ok: false, error: '타인의 학생 데이터는 조회할 수 없습니다.' });
        }
        if (reqUid && reqUid !== session.sub && (!session.studentId || reqUid !== session.studentId)) {
          return res.status(403).json({ ok: false, error: '본인 계정의 데이터만 조회할 수 있습니다.' });
        }
        scopedParams.user_id = session.sub;
        scopedParams.student_id = session.studentId || session.sub;
      }
      const result = await _handleGetMobileBundle(db, scopedParams);
      return res.status(result.status).json(result.json);
    }

    if (action === 'mark_notification_read') {
      const session = _verifyRequestSession(params, req);
      if (!session.ok) {
        return res.status(session.status).json({ ok: false, error: session.error });
      }
      const rid = String(params.remote_id || '').trim();
      if (!rid) {
        return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      }

      const docRef = db.collection('Notifications').doc(rid);
      const snap = await docRef.get();
      if (!snap.exists) {
        return res.status(404).json({ ok: false, error: '해당 알림을 찾을 수 없습니다.' });
      }

      const notiData = snap.data() || {};
      const notiSchoolCode = String(notiData.school_code || '').trim();
      if (session.schoolCode && notiSchoolCode && notiSchoolCode !== session.schoolCode) {
        return res.status(403).json({ ok: false, error: '타 학교의 알림은 읽음 처리할 수 없습니다.' } );
      }

      const targetSid = String(notiData.target_student_id || notiData.student_id || '').trim();
      if (targetSid && session.role !== 'teacher' && !_matchesSessionStudent(session, targetSid)) {
        return res.status(403).json({ ok: false, error: '본인(또는 자녀) 대상 알림만 읽음 처리할 수 있습니다.' });
      }

      if (targetSid) {
        await docRef.set({ remote_id: rid, is_read: true, updated_at: _nowStr() }, { merge: true });
      } else {
        const existingReadBy = Array.isArray(notiData.read_by)
          ? notiData.read_by.map((x) => String(x).trim()).filter(Boolean)
          : [];
        const readerIds = [session.sub, session.studentId]
          .map((x) => String(x || '').trim())
          .filter(Boolean);
        const nextReadBy = Array.from(new Set([...existingReadBy, ...readerIds]));
        await docRef.set({ remote_id: rid, read_by: nextReadBy, updated_at: _nowStr() }, { merge: true });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'save_push_subscription') {
      const session = _verifyRequestSession(params, req);
      if (!session.ok) {
        return res.status(session.status).json({ ok: false, error: session.error });
      }
      const endpoint = String(params.endpoint || '').trim();
      if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint가 필요합니다.' });
      const docId = crypto.createHash('sha1').update(endpoint).digest('hex').slice(0, 24);
      const schoolCode = String(params.school_code || params.neis_school_code || session.schoolCode || '').trim();
      await db.collection('Push_Subscriptions').doc(docId).set(
        {
          remote_id: docId,
          endpoint,
          p256dh: String(params.p256dh || ''),
          auth: String(params.auth || ''),
          role: session.role,
          user_id: session.sub,
          student_id: session.role === 'teacher' ? '' : (session.studentId || session.sub),
          school_code: schoolCode,
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
      const attDate = String(params.date || _kstDateStr());
      let sid = String(params.student_id || '').trim();
      const actorRole = String(params.role || '').trim().toLowerCase();
      const session = _verifyRequestSession(params, req);
      const hasTeacherCreds = Boolean(params.auth_teacher_id && (params.auth_password || params.auth_password_hash));
      const useTeacherPath = (session.ok && session.role === 'teacher') || (!session.ok && hasTeacherCreds) || actorRole === 'teacher';
      let teacherAuth = null;
      if (useTeacherPath) {
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
        if (!session.ok) {
          return res.status(session.status).json({ ok: false, error: session.error });
        }
        if (sid && !_matchesSessionStudent(session, sid)) {
          return res.status(403).json({ ok: false, error: '본인(또는 자녀)의 출결만 등록·수정할 수 있습니다.' });
        }
        if (!sid) {
          sid = session.studentId || session.sub;
        }
        const confirmedMsg = '이미 담임 선생님이 확인한 출결 내역이 있어 새로 등록하거나 수정할 수 없습니다.';
        if (params.remote_id) {
          const existingDoc = await db.collection('일일_출결').doc(rid).get();
          if (existingDoc.exists) {
            const exData = existingDoc.data() || {};
            if (exData.student_id && !_matchesSessionStudent(session, exData.student_id)) {
              return res.status(403).json({ ok: false, error: '타인의 출결 내역은 수정할 수 없습니다.' });
            }
            if (_toBool(exData.teacher_confirmed)) {
              return res.status(200).json({ ok: false, error: confirmedMsg });
            }
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
      const resolvedScope = await _resolveStudentTenantScope(db, sid, {
        schoolCode: params.school_code || params.neis_school_code || (teacherAuth ? teacherAuth.schoolCode : (session.ok ? session.schoolCode : '')),
        schoolName: params.school_name || (teacherAuth ? teacherAuth.schoolName : ''),
        grade: params.grade ?? (teacherAuth ? teacherAuth.gradeNum : null),
        classNo: params.class_no ?? (teacherAuth ? teacherAuth.classNum : null),
        studentName: params.student_name || '',
        teacherAuth,
      });
      const resolvedGrade = resolvedScope.grade;
      const resolvedClassNo = resolvedScope.classNo;
      const resolvedSchoolCode = resolvedScope.schoolCode;
      const resolvedSchoolName = resolvedScope.schoolName;
      const resolvedStudentName = resolvedScope.studentName;
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
          ...(teacherAuth ? { teacher_id: teacherAuth.teacherId } : {}),
          attendance_type: String(params.attendance_type || ''),
          att_category: String(params.att_category || ''),
          att_sub_type: String(params.att_sub_type || ''),
          period_info: String(params.period_info || ''),
          reason: String(params.reason || ''),
          teacher_confirmed: teacherAuth ? _toBool(params.teacher_confirmed) : false,
          updated_at: _nowStr()
        },
        { merge: true }
      );
      if (!teacherAuth) {
        const stuLabel = resolvedStudentName || sid || '학생';
        const attType = String(params.attendance_type || params.att_category || '출결').trim();
        const reasonStr = String(params.reason || '').trim();
        await _notifyClassTeachers(db, {
          title: `[출결 보고] ${stuLabel}`,
          message: `${attDate} ${attType}${reasonStr ? ` (${reasonStr})` : ''}`,
          channel: 'student_attendance',
          sender: stuLabel,
          schoolCode: resolvedSchoolCode,
          schoolName: resolvedSchoolName,
          grade: resolvedGrade,
          classNo: resolvedClassNo,
          studentId: sid
        });
      }
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'delete_attendance') {
      const rid = String(params.remote_id || '').trim();
      if (!rid) return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      const actorRole = String(params.role || '').trim().toLowerCase();
      const session = _verifyRequestSession(params, req);
      const hasTeacherCreds = Boolean(params.auth_teacher_id && (params.auth_password || params.auth_password_hash));
      const useTeacherPath = (session.ok && session.role === 'teacher') || (!session.ok && hasTeacherCreds) || actorRole === 'teacher';
      const existingDoc = await db.collection('일일_출결').doc(rid).get();
      if (useTeacherPath) {
        const adminAuth = await _verifyActiveTeacherAuth(db, params);
        if (!adminAuth.ok) {
          return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
        }
        if (existingDoc.exists && !_isStrictClassMember({ remote_id: existingDoc.id, ...(existingDoc.data() || {}) }, adminAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 출결 내역만 삭제할 수 있습니다.' });
        }
      } else {
        if (!session.ok) {
          return res.status(session.status).json({ ok: false, error: session.error });
        }
        if (existingDoc.exists) {
          const exData = existingDoc.data() || {};
          if (exData.student_id && !_matchesSessionStudent(session, exData.student_id)) {
            return res.status(403).json({ ok: false, error: '타인의 출결 내역은 삭제할 수 없습니다.' });
          }
          if (_toBool(exData.teacher_confirmed)) {
            return res.status(200).json({ ok: false, error: '이미 담임 선생님이 확인한 출결 내역이 있어 새로 등록하거나 수정할 수 없습니다.' });
          }
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
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const attSnap = await db.collection('일일_출결').doc(rid).get();
      const attData = attSnap.exists ? (attSnap.data() || {}) : {};
      if (attSnap.exists && !_isStrictClassMember({ remote_id: attSnap.id, ...attData }, adminAuth)) {
        return res.status(403).json({ ok: false, error: '담당 학급의 출결 내역만 확인할 수 있습니다.' });
      }
      const isRejected = params.teacher_confirmed === false || String(params.status || '').trim().toLowerCase() === 'rejected';
      await db.collection('일일_출결').doc(rid).set(
        { remote_id: rid, teacher_confirmed: !isRejected, ...(isRejected ? { status: 'rejected' } : {}), updated_at: _nowStr() },
        { merge: true }
      );
      const stuId = String(attData.student_id || params.student_id || '').trim();
      if (stuId) {
        const stuName = String(attData.student_name || params.student_name || stuId).trim();
        const attType = String(attData.attendance_type || params.attendance_type || '출결').trim();
        const teacherLabel = String((adminAuth.teacherDoc && adminAuth.teacherDoc.name) || '담임교사').trim();
        await _notifyStudentAndParent(db, {
          title: isRejected ? `[출결 반려] ${stuName}` : `[출결 확인] ${stuName}`,
          message: isRejected
            ? `${attType} 신청이 반려되었습니다. 내용을 확인해 주세요.`
            : `${attType} 신청이 담임 선생님에 의해 확인되었습니다.`,
          channel: 'attendance_confirm',
          sender: teacherLabel,
          schoolCode: String(attData.school_code || adminAuth.schoolCode || '').trim(),
          schoolName: String(attData.school_name || adminAuth.schoolName || '').trim(),
          grade: attData.grade ?? adminAuth.gradeNum,
          classNo: attData.class_no ?? adminAuth.classNum,
          studentId: stuId,
        });
      }
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
      const dateStr = String(params.date || _kstDateStr());
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
            student_no: rec.student_no !== undefined ? rec.student_no : '',
            school_code: adminAuth.schoolCode,
            school_name: adminAuth.schoolName,
            grade: adminAuth.gradeNum,
            class_no: adminAuth.classNum,
            teacher_id: adminAuth.teacherId,
            attendance_type: String(rec.attendance_type || '출석'),
            att_category: String(rec.att_category || ''),
            att_sub_type: String(rec.att_sub_type || ''),
            period_info: String(rec.period_info || ''),
            reason: String(rec.reason || ''),
            submitted_by: String(rec.submitted_by || ''),
            memo: String(rec.memo || ''),
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
      const session = _verifyRequestSession(params, req);
      const hasTeacherCreds = Boolean(params.auth_teacher_id && (params.auth_password || params.auth_password_hash));
      const useTeacherPath =
        action === 'confirm_document' ||
        (session.ok && session.role === 'teacher') ||
        (!session.ok && hasTeacherCreds) ||
        (action === 'upsert_document_tracking' && actorRole === 'teacher');

      let teacherAuth = null;
      const checkRid = String(params.remote_id || '').trim();
      const existingDocSnap = checkRid ? await db.collection('서류_추적').doc(checkRid).get() : null;
      const existingDocData = existingDocSnap && existingDocSnap.exists ? { remote_id: existingDocSnap.id, ...(existingDocSnap.data() || {}) } : null;

      if (useTeacherPath) {
        teacherAuth = await _verifyActiveTeacherAuth(db, params);
        if (!teacherAuth.ok) {
          return res.status(teacherAuth.status || 401).json({ ok: false, error: teacherAuth.error });
        }
        if (existingDocData && !_isStrictClassMember(existingDocData, teacherAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 서류 추적 내역만 처리할 수 있습니다.' });
        }
      } else {
        if (!session.ok) {
          return res.status(session.status).json({ ok: false, error: session.error });
        }
        const reqSid = String(params.student_id || '').trim();
        if (reqSid && !_matchesSessionStudent(session, reqSid)) {
          return res.status(403).json({ ok: false, error: '본인(또는 자녀)의 서류만 등록·제출할 수 있습니다.' });
        }
        if (existingDocData && existingDocData.student_id && !_matchesSessionStudent(session, existingDocData.student_id)) {
          return res.status(403).json({ ok: false, error: '타인의 서류 추적 내역은 수정할 수 없습니다.' });
        }
        if (action === 'upsert_document_tracking') {
          const reqSt = String(params.status || '').trim().toLowerCase();
          if (reqSt === 'closed' || reqSt === 'confirmed' || reqSt === '확인완료' || reqSt === '최종 종결' || reqSt === '최종종결') {
            return res.status(403).json({ ok: false, error: '서류 최종 확인은 교사만 처리할 수 있습니다.' });
          }
        }
      }
      const rid = String(params.remote_id || `doc_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      const update = { remote_id: rid, updated_at: _nowStr() };
      const docSid = String(
        params.student_id ||
        (existingDocData && existingDocData.student_id) ||
        (!useTeacherPath && session.ok ? (session.studentId || session.sub) : '') ||
        ''
      ).trim();
      const docTenant = await _resolveStudentTenantScope(db, docSid, {
        schoolCode: params.school_code || (existingDocData && existingDocData.school_code) || (teacherAuth ? teacherAuth.schoolCode : (session.ok ? session.schoolCode : '')),
        schoolName: params.school_name || (existingDocData && existingDocData.school_name) || (teacherAuth ? teacherAuth.schoolName : ''),
        grade: params.grade ?? (existingDocData && existingDocData.grade) ?? (teacherAuth ? teacherAuth.gradeNum : null),
        classNo: params.class_no ?? (existingDocData && existingDocData.class_no) ?? (teacherAuth ? teacherAuth.classNum : null),
        studentName: params.student_name || (existingDocData && existingDocData.student_name) || '',
        teacherAuth,
      });
      let responseDueDate = '';
      if (action === 'mark_document_submitted') {
        update.status = 'submitted';
        update.submitted_at = _nowStr();
        if (params.attachment_url) update.attachment_url = String(params.attachment_url);
        if (docTenant.grade !== null) update.grade = docTenant.grade;
        if (docTenant.classNo !== null) update.class_no = docTenant.classNo;
        if (docTenant.schoolCode) update.school_code = docTenant.schoolCode;
        if (docTenant.schoolName) update.school_name = docTenant.schoolName;
      } else if (action === 'confirm_document') {
        if (teacherAuth && teacherAuth.teacherId) update.teacher_id = teacherAuth.teacherId;
        if (docTenant.grade !== null && (!existingDocData || existingDocData.grade === undefined || existingDocData.grade === null)) update.grade = docTenant.grade;
        if (docTenant.classNo !== null && (!existingDocData || existingDocData.class_no === undefined || existingDocData.class_no === null)) update.class_no = docTenant.classNo;
        if (docTenant.schoolCode && (!existingDocData || !existingDocData.school_code)) update.school_code = docTenant.schoolCode;
        if (docTenant.schoolName && (!existingDocData || !existingDocData.school_name)) update.school_name = docTenant.schoolName;
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
        const targetGrade = docTenant.grade;
        const targetClassNo = docTenant.classNo;
        const targetSchoolCode = docTenant.schoolCode;
        const targetSchoolName = docTenant.schoolName;
        if (teacherAuth && !_isStrictClassMember({
          student_id: docSid,
          grade: targetGrade,
          class_no: targetClassNo,
          school_code: targetSchoolCode,
          school_name: targetSchoolName,
        }, teacherAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급의 서류 추적 내역만 등록·수정할 수 있습니다.' });
        }
        Object.assign(update, {
          student_id: docSid,
          student_name: docTenant.studentName,
          grade: targetGrade,
          class_no: targetClassNo,
          school_code: targetSchoolCode,
          school_name: targetSchoolName,
          ...(teacherAuth ? { teacher_id: teacherAuth.teacherId } : {}),
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
      if (!teacherAuth) {
        const effectiveStatus = String(update.status || '').trim().toLowerCase();
        const isSubmittedStatus =
          action === 'mark_document_submitted' ||
          ['submitted', '제출했습니다', '학생확인완료', '제출완료'].includes(effectiveStatus);
        if (isSubmittedStatus) {
          const docStudentId = String(
            update.student_id ||
            params.student_id ||
            (existingDocData && existingDocData.student_id) ||
            (session.ok ? (session.studentId || session.sub) : '') ||
            ''
          ).trim();
          const docStudentName = String(
            update.student_name ||
            params.student_name ||
            (existingDocData && existingDocData.student_name) ||
            ''
          ).trim();
          const docSchoolCode = String(
            update.school_code ||
            params.school_code ||
            (existingDocData && existingDocData.school_code) ||
            (session.ok ? session.schoolCode : '') ||
            ''
          ).trim();
          const docSchoolName = String(
            update.school_name ||
            params.school_name ||
            (existingDocData && existingDocData.school_name) ||
            ''
          ).trim();
          const infDoc = _inferGradeClassFromStudentId(docStudentId);
          const docGrade = _toIntOrNull(update.grade ?? params.grade ?? (existingDocData && existingDocData.grade) ?? infDoc.grade);
          const docClassNo = _toIntOrNull(update.class_no ?? params.class_no ?? (existingDocData && existingDocData.class_no) ?? infDoc.class_no);
          const docLabel = String(
            update.doc_name ||
            update.doc_type ||
            (existingDocData && (existingDocData.doc_name || existingDocData.doc_type)) ||
            '서류'
          ).trim();
          const stuLabel = docStudentName || docStudentId || '학생';
          await _notifyClassTeachers(db, {
            title: `[서류 제출] ${stuLabel}`,
            message: `${docLabel}이(가) 제출되었습니다.`,
            channel: 'doc_submitted',
            sender: stuLabel,
            schoolCode: docSchoolCode,
            schoolName: docSchoolName,
            grade: docGrade,
            classNo: docClassNo,
            studentId: docStudentId
          });
        }
      } else if (action === 'confirm_document' && teacherAuth) {
        const docStudentId = String(params.student_id || (existingDocData && existingDocData.student_id) || '').trim();
        if (docStudentId) {
          const isRejected = update.status === 'pending';
          const docLabel = String(
            params.doc_name ||
            params.doc_type ||
            (existingDocData && (existingDocData.doc_name || existingDocData.doc_type)) ||
            '서류'
          ).trim();
          const teacherLabel = String((teacherAuth.teacherDoc && teacherAuth.teacherDoc.name) || '담임교사').trim();
          const infDoc = _inferGradeClassFromStudentId(docStudentId);
          await _notifyStudentAndParent(db, {
            title: isRejected ? `[서류 반려] ${docLabel}` : `[서류 확인] ${docLabel}`,
            message: isRejected
              ? `${docLabel}이(가) 반려(재제출 요청)되었습니다. 확인 후 다시 제출해 주세요.`
              : `${docLabel}이(가) 확인 완료되었습니다.`,
            channel: 'doc_confirm',
            sender: teacherLabel,
            schoolCode: String((existingDocData && existingDocData.school_code) || teacherAuth.schoolCode || '').trim(),
            schoolName: String((existingDocData && existingDocData.school_name) || teacherAuth.schoolName || '').trim(),
            grade: _toIntOrNull((existingDocData && existingDocData.grade) ?? teacherAuth.gradeNum ?? infDoc.grade),
            classNo: _toIntOrNull((existingDocData && existingDocData.class_no) ?? teacherAuth.classNum ?? infDoc.classNo),
            studentId: docStudentId,
          });
        }
      }
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
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const schoolCode = String(adminAuth.schoolCode || '').trim();
      const schoolName = String(adminAuth.schoolName || '').trim();
      const rawRid = String(params.remote_id || params.rule_code || `rule_${Date.now()}`).trim();
      let rid = rawRid;
      if (params.remote_id) {
        const existingSnap = await db.collection('설정_서류규정').doc(rawRid).get();
        if (existingSnap.exists) {
          const existingData = existingSnap.data() || {};
          if ((schoolCode || schoolName) && !_matchesTenant(existingData, { schoolCode, schoolName, gradeNum: null, classNum: null })) {
            return res.status(403).json({ ok: false, error: '타 학교의 서류 규정은 수정할 수 없습니다.' });
          }
        } else if (schoolCode && !rawRid.startsWith(`${schoolCode}_`)) {
          rid = `${schoolCode}_${rawRid}`;
        }
      } else if (schoolCode && !rawRid.startsWith(`${schoolCode}_`)) {
        rid = `${schoolCode}_${rawRid}`;
      }
      const ruleDoc = {
        remote_id: rid,
        rule_code: String(params.rule_code || rawRid),
        title: String(params.title || ''),
        due_business_days: _toIntOrNull(params.due_business_days),
        is_active: params.is_active === undefined ? true : _toBool(params.is_active),
        school_code: schoolCode,
        school_name: schoolName,
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
      const session = _verifyRequestSession(params, req);
      if (!session.ok) {
        return res.status(session.status).json({ ok: false, error: session.error });
      }
      if (
        session.role !== 'teacher' &&
        params.student_id &&
        !_matchesSessionStudent(session, params.student_id)
      ) {
        return res.status(403).json({ ok: false, error: '본인 학생 계정의 파일만 업로드할 수 있습니다.' });
      }
      const driveConfig = await _resolveTeacherDriveConfig(db, {
        teacherId: params.teacher_id || (session.role === 'teacher' ? (session.teacherId || session.sub) : ''),
        schoolCode: params.school_code || session.schoolCode || '',
        grade: params.grade ?? session.grade,
        classNo: params.class_no ?? session.classNo
      });
      const driveRes = await uploadBase64ToDrive({
        base64Data: params.file_base64 || params.attachment_base64 || params.base64,
        fileName: String(params.file_name || `eduflow_${Date.now()}.bin`),
        mimeType: String(params.mime_type || 'application/octet-stream'),
        folderName: String(params.folder_name || 'EduFlow_Uploads'),
        driveConfig
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
        const driveConfig = await _resolveTeacherDriveConfig(db, {
          teacherDoc: adminAuth.teacherDoc,
          teacherId: (existing && existing.teacher_id) || adminAuth.teacherId || '',
          schoolCode: params.school_code || (existing && existing.school_code) || adminAuth.schoolCode || '',
          grade: params.target_grade ?? params.grade ?? (existing && existing.target_grade) ?? adminAuth.gradeNum,
          classNo: params.target_class ?? params.class_no ?? (existing && existing.target_class) ?? adminAuth.classNum
        });
        const driveRes = await uploadBase64ToDrive({
          base64Data: params.attachment_base64,
          fileName: String(params.attachment_name || `notice_${rid}.pdf`),
          mimeType: String(params.attachment_mime || 'application/pdf'),
          folderName: 'EduFlow_Notices',
          driveConfig
        });
        if (!driveRes.ok) {
          return res.status(502).json({
            ok: false,
            error: `Google Drive 첨부파일 업로드 실패: ${driveRes.error || '알 수 없는 오류'}`
          });
        }
        attachmentUrl = _normalizeNoticeDriveUrl(driveRes.webViewLink || driveRes.downloadUrl);
      }
      const isPublished = params.is_published === undefined ? true : _toBool(params.is_published);
      const requiresReply = params.requires_reply === undefined ? true : _toBool(params.requires_reply);
      const signatureMode = _normalizeSignatureMode(params.signature_mode, requiresReply);
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
        requires_reply: requiresReply,
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
      const requiresReply = params.requires_reply !== undefined
        ? _toBool(params.requires_reply)
        : (existing.requires_reply === undefined ? true : _toBool(existing.requires_reply));
      const rawSigMode = params.signature_mode !== undefined ? params.signature_mode : existing.signature_mode;
      const signatureMode = _normalizeSignatureMode(rawSigMode, requiresReply);
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
        requires_reply: requiresReply,
        signature_mode: signatureMode,
        is_published: true,
        published_at: existing.published_at || nowStr,
        created_at: String(existing.created_at || nowStr),
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
      const session = _verifyRequestSession(params, req);
      if (!session.ok) {
        return res.status(session.status).json({ ok: false, error: session.error });
      }
      const noticeId = String(params.notice_id || '').trim();
      let studentId = String(params.student_id || '').trim();
      if (session.role === 'teacher') {
        const teacherAuth = await _verifyActiveTeacherAuth(db, params);
        if (!teacherAuth.ok) {
          return res.status(teacherAuth.status || 401).json({ ok: false, error: teacherAuth.error });
        }
        if (!noticeId || !studentId) {
          return res.status(400).json({ ok: false, error: 'notice_id와 student_id가 필요합니다.' });
        }
        if (!_isStrictClassMember({
          student_id: studentId,
          grade: _toIntOrNull(params.grade ?? teacherAuth.gradeNum),
          class_no: _toIntOrNull(params.class_no ?? teacherAuth.classNum),
          school_code: String(params.school_code || teacherAuth.schoolCode || ''),
          school_name: String(params.school_name || teacherAuth.schoolName || ''),
        }, teacherAuth)) {
          return res.status(403).json({ ok: false, error: '담당 학급 학생의 회신만 처리할 수 있습니다.' });
        }
      } else {
        if (!studentId) studentId = session.studentId || session.sub;
        if (!_matchesSessionStudent(session, studentId)) {
          return res.status(403).json({ ok: false, error: '본인(또는 자녀)의 가정통신문 회신만 제출할 수 있습니다.' });
        }
      }
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
      const noticeRequiresReply = noticeData.requires_reply === undefined ? true : _toBool(noticeData.requires_reply);
      const rawReplySigMode = noticeData.signature_mode !== undefined ? noticeData.signature_mode : params.signature_mode;
      const signatureMode = _normalizeSignatureMode(rawReplySigMode, noticeRequiresReply);
      const effectiveParentBase64 = signatureMode === 'none' || signatureMode === 'student'
        ? ''
        : String(params.parent_signature_base64 || params.signature_base64 || '').trim();
      const effectiveStudentBase64 = signatureMode === 'none' || signatureMode === 'parent'
        ? ''
        : String(params.student_signature_base64 || (signatureMode === 'student' ? (params.signature_base64 || '') : '')).trim();
      const hasParentSigInput = Boolean(
        effectiveParentBase64 ||
        (signatureMode !== 'none' && signatureMode !== 'student' && params.signature_drive_url && !String(params.signature_drive_url).startsWith('data:'))
      );
      const hasStudentSigInput = Boolean(
        effectiveStudentBase64 ||
        (signatureMode !== 'none' && signatureMode !== 'parent' && params.student_signature_drive_url && !String(params.student_signature_drive_url).startsWith('data:'))
      );
      if (session.role !== 'teacher') {
        if (signatureMode === 'student' && !hasStudentSigInput) {
          return res.status(400).json({ ok: false, error: '학생 전자서명이 필요합니다.' });
        }
        if (signatureMode === 'parent' && !hasParentSigInput) {
          return res.status(400).json({ ok: false, error: '학부모(보호자) 전자서명이 필요합니다.' });
        }
        if (signatureMode === 'both' && (!hasStudentSigInput || !hasParentSigInput)) {
          return res.status(400).json({ ok: false, error: '학생과 학부모(보호자) 전자서명이 모두 필요합니다.' });
        }
      }
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
      const driveConfig = (effectiveParentBase64 || effectiveStudentBase64 || params.reply_file_base64)
        ? await _resolveTeacherDriveConfig(db, {
            teacherId: noticeData.teacher_id || params.teacher_id || (session.role === 'teacher' ? (session.teacherId || session.sub) : ''),
            schoolCode: noticeData.school_code || params.school_code || session.schoolCode || '',
            grade: targetGrade ?? session.grade,
            classNo: targetClass ?? session.classNo
          })
        : null;

      let sigDriveUrl = String(params.signature_drive_url || '').trim();
      let sigFileId = String(params.signature_file_id || '').trim();
      if (sigDriveUrl.startsWith('data:')) {
        sigDriveUrl = '';
      }
      const parentSigBase64 = effectiveParentBase64;
      if (parentSigBase64) {
        const driveRes = await uploadBase64ToDrive({
          base64Data: parentSigBase64,
          fileName: `${baseFileName}.png`,
          mimeType: 'image/png',
          folderName: driveFolderPath,
          driveConfig
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
      if (effectiveStudentBase64) {
        const stuDriveRes = await uploadBase64ToDrive({
          base64Data: effectiveStudentBase64,
          fileName: `${baseFileName}_student.png`,
          mimeType: 'image/png',
          folderName: driveFolderPath,
          driveConfig
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
          folderName: driveFolderPath,
          driveConfig
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
      const replyTenant = await _resolveStudentTenantScope(db, studentId, {
        schoolCode: noticeData.school_code || params.school_code || session.schoolCode || '',
        schoolName: noticeData.school_name || params.school_name || '',
        grade: noticeData.target_grade ?? noticeData.grade ?? params.grade,
        classNo: noticeData.target_class ?? noticeData.class_no ?? params.class_no,
        studentName,
      });
      const replyDoc = {
        remote_id: rid,
        notice_id: noticeId,
        student_id: studentId,
        student_name: replyTenant.studentName || studentName,
        school_code: replyTenant.schoolCode,
        school_name: replyTenant.schoolName,
        grade: replyTenant.grade,
        class_no: replyTenant.classNo,
        ...(noticeData.teacher_id ? { teacher_id: String(noticeData.teacher_id).trim() } : {}),
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
        created_at: nowStr,
        updated_at: nowStr
      };
      if (replyFileDriveUrl || replyFileId) {
        replyDoc.reply_file_drive_url = replyFileDriveUrl;
        replyDoc.reply_file_id = replyFileId;
      }
      await replyRef.set(replyDoc, { merge: true });
      _invalidateStaticCache('notice_replies_');
      try {
        const notiSnap = await db.collection('Notifications').where('notice_id', '==', noticeId).limit(20).get();
        if (!notiSnap.empty) {
          const readerIds = [studentId, session.sub].map((x) => String(x || '').trim()).filter(Boolean);
          const batch = db.batch();
          let hasUpdates = false;
          notiSnap.forEach((nDoc) => {
            const nd = nDoc.data() || {};
            const existingReadBy = Array.isArray(nd.read_by) ? nd.read_by.map((x) => String(x).trim()).filter(Boolean) : [];
            const nextReadBy = Array.from(new Set([...existingReadBy, ...readerIds]));
            if (nextReadBy.length !== existingReadBy.length) {
              batch.set(nDoc.ref, { read_by: nextReadBy, updated_at: nowStr }, { merge: true });
              hasUpdates = true;
            }
          });
          if (hasUpdates) await batch.commit();
        }
      } catch (_) {}
      if (session.role !== 'teacher') {
        const infStu = _inferGradeClassFromStudentId(studentId);
        const stuLabel = studentName || studentId || '학생';
        await _notifyClassTeachers(db, {
          title: `[가정통신문 회신] ${stuLabel}`,
          message: noticeData.title ? `${noticeData.title} 회신이 제출되었습니다.` : '가정통신문 회신이 제출되었습니다.',
          channel: 'notice_reply',
          sender: stuLabel,
          teacherId: String(noticeData.teacher_id || '').trim(),
          schoolCode: String(noticeData.school_code || params.school_code || session.schoolCode || '').trim(),
          schoolName: String(noticeData.school_name || params.school_name || '').trim(),
          grade: targetGrade ?? infStu.grade,
          classNo: targetClass ?? infStu.class_no,
          studentId
        });
      }
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
      const session = _verifyRequestSession(params, req);
      const hasTeacherCreds = Boolean(params.auth_teacher_id && (params.auth_password || params.auth_password_hash));
      const useTeacherPath = senderRole === 'teacher' || (session.ok && session.role === 'teacher') || (!session.ok && hasTeacherCreds);
      let roomId = String(params.room_id || `ROOM-${params.student_id || 'DEFAULT'}`).trim();
      const roomSid = (roomId.startsWith('ROOM-') && roomId !== 'ROOM-DEFAULT') ? roomId.slice(5).trim() : '';
      let inferredSid = useTeacherPath
        ? String(params.student_id || params.receiver_id || roomSid).trim()
        : String(params.student_id || roomSid || params.sender_id || '').trim();
      let teacherAuth = null;
      if (useTeacherPath) {
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
      } else {
        if (!session.ok) {
          return res.status(session.status).json({ ok: false, error: session.error });
        }
        const ownSid = session.studentId || session.sub;
        if (inferredSid && !(await _matchesSessionStudentWithLookup(db, session, inferredSid))) {
          return res.status(403).json({ ok: false, error: '본인(또는 자녀)의 1:1 상담방에만 메시지를 보낼 수 있습니다.' });
        }
        if (roomId && roomId !== 'ROOM-DEFAULT' && roomId !== `ROOM-${ownSid}`) {
          const roomMatches = roomSid && (await _matchesSessionStudentWithLookup(db, session, roomSid));
          if (!roomMatches) {
            return res.status(403).json({ ok: false, error: '타인의 1:1 상담방에는 메시지를 보낼 수 없습니다.' });
          }
        }
        inferredSid = ownSid;
        roomId = `ROOM-${ownSid}`;
      }
      const msgCheck = _validateStringInput(params.message, { maxLen: 4000, required: true, label: '상담 메시지(message)' });
      if (!msgCheck.ok) {
        return res.status(400).json({ ok: false, error: msgCheck.error });
      }
      const senderNameCheck = _validateStringInput(
        params.sender_name || (teacherAuth && teacherAuth.teacherDoc && teacherAuth.teacherDoc.name) || '',
        { maxLen: 100, required: false, label: '발신자 이름' }
      );
      if (!senderNameCheck.ok) {
        return res.status(400).json({ ok: false, error: senderNameCheck.error });
      }
      const rid = String(params.remote_id || `chat_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      const nowStr = _nowStr();
      const chatTenant = await _resolveStudentTenantScope(db, inferredSid, {
        schoolCode: params.school_code || (teacherAuth ? teacherAuth.schoolCode : (session.ok ? session.schoolCode : '')),
        schoolName: params.school_name || (teacherAuth ? teacherAuth.schoolName : ''),
        grade: params.grade ?? (teacherAuth ? teacherAuth.gradeNum : null),
        classNo: params.class_no ?? (teacherAuth ? teacherAuth.classNum : null),
        teacherAuth,
      });
      const chatDoc = {
        remote_id: rid,
        room_id: roomId,
        student_id: inferredSid,
        grade: chatTenant.grade,
        class_no: chatTenant.classNo,
        school_code: chatTenant.schoolCode,
        school_name: chatTenant.schoolName,
        sender_role: senderRole || 'student',
        sender_name: senderNameCheck.value,
        message: msgCheck.value,
        is_read: false,
        created_at: nowStr,
        updated_at: nowStr
      };
      if (teacherAuth) chatDoc.teacher_id = teacherAuth.teacherId;
      await db.collection('1:1_상담채팅').doc(rid).set(chatDoc, { merge: true });
      if (!teacherAuth && senderRole !== 'teacher') {
        const infStu = _inferGradeClassFromStudentId(inferredSid);
        const senderLabel = senderNameCheck.value || inferredSid || '학생/학부모';
        await _notifyClassTeachers(db, {
          title: `[1:1 상담] ${senderLabel}`,
          message: msgCheck.value.slice(0, 120),
          channel: 'chat_message',
          sender: senderLabel,
          schoolCode: chatDoc.school_code || (session.ok ? session.schoolCode : ''),
          schoolName: chatDoc.school_name || '',
          grade: chatDoc.grade ?? infStu.grade,
          classNo: chatDoc.class_no ?? infStu.class_no,
          studentId: inferredSid
        });
      } else if ((teacherAuth || senderRole === 'teacher') && inferredSid) {
        const infStu = _inferGradeClassFromStudentId(inferredSid);
        const senderLabel = senderNameCheck.value || (teacherAuth && teacherAuth.teacherDoc && teacherAuth.teacherDoc.name) || '담임교사';
        await _notifyStudentAndParent(db, {
          title: `[1:1 상담] ${senderLabel}`,
          message: msgCheck.value.slice(0, 120),
          channel: 'chat_message',
          sender: senderLabel,
          schoolCode: chatDoc.school_code || (teacherAuth ? teacherAuth.schoolCode : ''),
          schoolName: chatDoc.school_name || (teacherAuth ? teacherAuth.schoolName : ''),
          grade: chatDoc.grade ?? infStu.grade,
          classNo: chatDoc.class_no ?? infStu.class_no,
          studentId: inferredSid
        });
      }
      return res.status(200).json({ ok: true, remote_id: rid, item: chatDoc });
    }

    if (action === 'mark_chat_read') {
      let roomId = String(params.room_id || '').trim();
      const readerRole = String(params.reader_role || 'teacher').trim().toLowerCase();
      const session = _verifyRequestSession(params, req);
      const hasTeacherCreds = Boolean(params.auth_teacher_id && (params.auth_password || params.auth_password_hash));
      const useTeacherPath = readerRole === 'teacher' || (session.ok && session.role === 'teacher') || (!session.ok && hasTeacherCreds);
      let teacherAuth = null;
      if (useTeacherPath) {
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
      } else {
        if (!session.ok) {
          return res.status(session.status).json({ ok: false, error: session.error });
        }
        const ownSid = session.studentId || session.sub;
        const targetSid = roomId.startsWith('ROOM-') ? roomId.slice(5).trim() : String(params.student_id || '').trim();
        if (targetSid && !(await _matchesSessionStudentWithLookup(db, session, targetSid))) {
          return res.status(403).json({ ok: false, error: '본인(또는 자녀)의 상담 채팅만 읽음 처리할 수 있습니다.' });
        }
        if (roomId && roomId !== `ROOM-${ownSid}`) {
          const roomMatches = targetSid && (await _matchesSessionStudentWithLookup(db, session, targetSid));
          if (!roomMatches) {
            return res.status(403).json({ ok: false, error: '타인의 상담 채팅방은 읽음 처리할 수 없습니다.' });
          }
        }
        if (!roomId && ownSid) roomId = `ROOM-${ownSid}`;
      }
      if (roomId) {
        const actualReaderRole = useTeacherPath
          ? 'teacher'
          : String((session && session.role) || readerRole || 'student').trim().toLowerCase();
        const readerId = useTeacherPath
          ? teacherAuth.teacherId
          : String((session && (session.sub || session.studentId)) || actualReaderRole).trim();
        const snap = await db.collection('1:1_상담채팅').where('room_id', '==', roomId).get();
        const batch = db.batch();
        let cnt = 0;
        snap.forEach((doc) => {
          const d = doc.data() || {};
          if (teacherAuth && !_isStrictClassMember({ remote_id: doc.id, ...d }, teacherAuth)) {
            return;
          }
          const sender = String(d.sender_role || '').trim().toLowerCase();
          if (actualReaderRole === 'teacher') {
            if (sender !== 'teacher' && !_toBool(d.is_read)) {
              const existingReadBy = Array.isArray(d.read_by) ? d.read_by.map((x) => String(x).trim()).filter(Boolean) : [];
              const nextReadBy = Array.from(new Set([...existingReadBy, 'teacher', readerId].filter(Boolean)));
              batch.set(doc.ref, { is_read: true, read_by_teacher: true, read_by: nextReadBy, updated_at: _nowStr() }, { merge: true });
              cnt += 1;
            }
          } else if (sender === 'teacher') {
            const roleField = actualReaderRole === 'parent' ? 'read_by_parent' : 'read_by_student';
            const existingReadBy = Array.isArray(d.read_by) ? d.read_by.map((x) => String(x).trim()).filter(Boolean) : [];
            const alreadyReadByRole = _toBool(d[roleField]) || existingReadBy.includes(actualReaderRole);
            if (!alreadyReadByRole) {
              const nextReadBy = Array.from(new Set([...existingReadBy, actualReaderRole, readerId].filter(Boolean)));
              const studentDone = actualReaderRole === 'student' ? true : (_toBool(d.read_by_student) || nextReadBy.includes('student'));
              const parentDone = actualReaderRole === 'parent' ? true : (_toBool(d.read_by_parent) || nextReadBy.includes('parent'));
              batch.set(doc.ref, {
                [roleField]: true,
                read_by: nextReadBy,
                is_read: studentDone && parentDone,
                updated_at: _nowStr()
              }, { merge: true });
              cnt += 1;
            }
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
        if (params.drive_priority !== undefined) {
          const rawPriority = String(params.drive_priority || 'workspace').trim().toLowerCase();
          if (rawPriority !== 'workspace' && rawPriority !== 'personal') {
            return res.status(400).json({ ok: false, error: 'drive_priority는 workspace 또는 personal이어야 합니다.' });
          }
          data.drive_priority = rawPriority;
        }
        if (params.workspace_drive_folder_id !== undefined) {
          data.workspace_drive_folder_id = String(params.workspace_drive_folder_id || '').trim();
        }
        if (params.personal_gas_url !== undefined) {
          const personalGasUrl = String(params.personal_gas_url || '').trim();
          if (personalGasUrl && !/^https?:\/\//i.test(personalGasUrl)) {
            return res.status(400).json({ ok: false, error: 'personal_gas_url은 http(s) URL 형식이어야 합니다.' });
          }
          data.personal_gas_url = personalGasUrl;
        }
        if (params.personal_drive_folder_id !== undefined) {
          data.personal_drive_folder_id = String(params.personal_drive_folder_id || '').trim();
        }
      }
      const teacherRef = db.collection('계정_교사').doc(tid);
      await teacherRef.set(data, { merge: true });
      const updatedSnap = await teacherRef.get();
      const updatedDoc = updatedSnap.exists ? (updatedSnap.data() || {}) : data;
      const driveStatus = _computeTeacherDriveStatus(updatedDoc);
      _invalidateStaticCache('teacher');
      return res.status(200).json({
        ok: true,
        remote_id: tid,
        drive_priority: driveStatus.drive_priority,
        drive_configured: driveStatus.drive_configured
      });
    }

    if (action === 'update_teacher_drive_settings') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const tid = String(params.teacher_id || params.remote_id || adminAuth.teacherId || '').trim();
      if (!tid) return res.status(400).json({ ok: false, error: 'teacher_id가 필요합니다.' });
      if (tid !== adminAuth.teacherId) {
        return res.status(403).json({ ok: false, error: '본인 교사 계정의 Google Drive 설정만 수정할 수 있습니다.' });
      }
      const rawPriority = String(params.drive_priority ?? 'workspace').trim().toLowerCase();
      if (rawPriority !== 'workspace' && rawPriority !== 'personal') {
        return res.status(400).json({ ok: false, error: 'drive_priority는 workspace 또는 personal이어야 합니다.' });
      }
      const workspaceFolderId = String(params.workspace_drive_folder_id || '').trim();
      const personalGasUrl = String(params.personal_gas_url || '').trim();
      const personalFolderId = String(params.personal_drive_folder_id || '').trim();
      if (personalGasUrl && !/^https?:\/\//i.test(personalGasUrl)) {
        return res.status(400).json({ ok: false, error: 'personal_gas_url은 http(s) URL 형식이어야 합니다.' });
      }
      const driveData = {
        remote_id: tid,
        teacher_id: tid,
        drive_priority: rawPriority,
        workspace_drive_folder_id: workspaceFolderId,
        personal_gas_url: personalGasUrl,
        personal_drive_folder_id: personalFolderId,
        updated_at: _nowStr()
      };
      await db.collection('계정_교사').doc(tid).set(driveData, { merge: true });
      _invalidateStaticCache('teacher');
      return res.status(200).json({ ok: true, ...driveData });
    }

    if (action === 'send_notification') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const titleCheck = _validateStringInput(params.title || 'EduFlow 알림', { maxLen: 200, required: true, label: '알림 제목(title)' });
      if (!titleCheck.ok) return res.status(400).json({ ok: false, error: titleCheck.error });
      const msgCheck = _validateStringInput(params.message || '', { maxLen: 2000, required: false, label: '알림 내용(message)' });
      if (!msgCheck.ok) return res.status(400).json({ ok: false, error: msgCheck.error });
      const senderCheck = _validateStringInput(
        params.sender || (adminAuth.teacherDoc && adminAuth.teacherDoc.name) || adminAuth.teacherId || '',
        { maxLen: 100, required: false, label: '발신자(sender)' }
      );
      if (!senderCheck.ok) return res.status(400).json({ ok: false, error: senderCheck.error });
      const rawTargetRole = String(params.target_role || 'all').trim().toLowerCase();
      const targetRole = ['all', 'student', 'parent', 'teacher'].includes(rawTargetRole) ? rawTargetRole : 'all';
      const rawSingleSid = String(params.target_student_id ?? params.student_id ?? '').trim();
      const normalizedSingleSid = rawSingleSid.toUpperCase() === 'ALL' ? '' : rawSingleSid;
      const targetStudentIds = Array.isArray(params.target_student_ids)
        ? params.target_student_ids.map((s) => String(s || '').trim()).filter((s) => s && s.toUpperCase() !== 'ALL')
        : [];
      const resolvedGrade = _toIntOrNull(params.grade) ?? adminAuth.gradeNum;
      const resolvedClassNo = _toIntOrNull(params.class_no) ?? adminAuth.classNum;
      const resolvedSchoolCode = String(adminAuth.schoolCode || params.school_code || '').trim();
      const resolvedSchoolName = String(adminAuth.schoolName || params.school_name || '').trim();
      const nowStr = _nowStr();
      const baseNoti = {
        title: titleCheck.value,
        message: msgCheck.value,
        channel: String(params.channel || 'mobile_pwa'),
        target_role: targetRole,
        sender: senderCheck.value,
        teacher_id: adminAuth.teacherId,
        school_code: resolvedSchoolCode,
        school_name: resolvedSchoolName,
        grade: resolvedGrade,
        class_no: resolvedClassNo,
        is_read: false,
        read_by: [],
        created_at: nowStr,
        updated_at: nowStr
      };
      const baseRid = String(params.remote_id || `noti_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      if (targetStudentIds.length > 0) {
        const batch = db.batch();
        const createdIds = [];
        targetStudentIds.forEach((sid, idx) => {
          const itemRid = `${baseRid}_${idx}`;
          createdIds.push(itemRid);
          batch.set(
            db.collection('Notifications').doc(itemRid),
            { ...baseNoti, remote_id: itemRid, student_id: sid, target_student_id: sid },
            { merge: true }
          );
        });
        await batch.commit();
        await _dispatchClassNotificationPush(db, {
          title: titleCheck.value,
          message: msgCheck.value,
          schoolCode: resolvedSchoolCode,
          grade: resolvedGrade,
          classNo: resolvedClassNo,
          targetRole,
          studentIds: targetStudentIds,
        });
        return res.status(200).json({ ok: true, remote_id: createdIds[0], remote_ids: createdIds, count: createdIds.length });
      }
      await db.collection('Notifications').doc(baseRid).set(
        { ...baseNoti, remote_id: baseRid, student_id: normalizedSingleSid, target_student_id: normalizedSingleSid },
        { merge: true }
      );
      await _dispatchClassNotificationPush(db, {
        title: titleCheck.value,
        message: msgCheck.value,
        schoolCode: resolvedSchoolCode,
        grade: resolvedGrade,
        classNo: resolvedClassNo,
        targetRole,
        studentIds: normalizedSingleSid ? [normalizedSingleSid] : [],
      });
      return res.status(200).json({ ok: true, remote_id: baseRid });
    }

    if (action === 'enqueue_remote_task') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const rid = String(params.remote_id || `mob_${Date.now()}`);
      const nowStr = _nowStr();
      const teacherId = adminAuth.teacherId;
      const schoolCode = adminAuth.schoolCode || String(params.school_code || params.neis_school_code || '').trim();
      const grade = _toIntOrNull(params.grade) ?? adminAuth.gradeNum;
      const classNo = _toIntOrNull(params.class_no) ?? adminAuth.classNum;
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
      _invalidateStaticCache('remote_tasks:');
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'sync_neis_meals') {
      const adminAuth = await _verifyActiveTeacherAuth(db, params);
      if (!adminAuth.ok) {
        return res.status(adminAuth.status || 401).json({ ok: false, error: adminAuth.error });
      }
      const resSync = await _syncNeisMeals(db, {
        ...params,
        teacher_id: adminAuth.teacherId,
        school_code: params.school_code || adminAuth.schoolCode,
      });
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
      'fetch_lesson_progress',
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
  const sessionToken = _extractSessionToken(params);
  let teacherId = String(params.auth_teacher_id || params.teacher_id || params.requester_id || '').trim();
  const rawPw = String(params.auth_password || params.password || '');
  const pwHash = String(params.auth_password_hash || params.password_hash || '');

  let verifiedClaims = null;
  if (sessionToken) {
    const verified = _verifySessionToken(sessionToken);
    if (!verified.ok) {
      return { ok: false, status: 401, error: verified.error };
    }
    verifiedClaims = verified.claims;
    if (String(verifiedClaims.role || '').trim().toLowerCase() !== 'teacher') {
      return { ok: false, status: 403, error: '교사 세션 토큰이 아닙니다.' };
    }
    teacherId = String(verifiedClaims.sub || teacherId || '').trim();
  }

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

  if (verifiedClaims) {
    const requestedTid = String(params.auth_teacher_id || '').trim();
    const canonicalTid = String(userDoc.teacher_id || userDoc.remote_id || teacherId).trim();
    if (
      requestedTid &&
      requestedTid !== canonicalTid &&
      requestedTid !== String(userDoc.login_id || '').trim() &&
      requestedTid !== String(userDoc.custom_id || '').trim() &&
      requestedTid !== String(verifiedClaims.sub || '').trim()
    ) {
      return { ok: false, status: 403, error: '토큰과 요청된 교사 ID가 일치하지 않습니다.' };
    }
  } else if (!_verifyPassword(userDoc.password_hash, rawPw, pwHash, { allowProvidedHash: true })) {
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
    isAdmin: userDoc.is_admin === true || _getEnvSuperAdminIds().includes(String(userDoc.teacher_id || userDoc.remote_id || '').trim()),
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
    const isSelf = tid === auth.teacherId || String(userDoc.teacher_id || '').trim() === auth.teacherId;
    if (!isSelf && !_matchesTenant(userDoc, {
      schoolCode: auth.schoolCode,
      comciganSchoolCode: auth.comciganSchoolCode,
      schoolName: auth.schoolName,
      gradeNum: null,
      classNum: null,
    })) {
      return { status: 403, json: { ok: false, error: '동일 학교 교사의 프로필만 조회할 수 있습니다.' } };
    }
    const safe = { ...userDoc };
    delete safe.password_hash;
    return { status: 200, json: { ok: true, profile: safe } };
  }

  if (action === 'check_timetable_exists') {
    const reqSc = String(params.school_code || '').trim();
    const reqCc = String(params.comcigan_school_code || '').trim();
    const reqSn = String(params.school_name || '').trim();
    if (
      (reqSc && auth.schoolCode && reqSc !== auth.schoolCode) ||
      (reqCc && auth.comciganSchoolCode && reqCc !== auth.comciganSchoolCode) ||
      (reqSn && auth.schoolName && reqSn !== auth.schoolName)
    ) {
      return { status: 403, json: { ok: false, error: '소속 학교의 시간표 존재 여부만 확인할 수 있습니다.' } };
    }
    const sc = String(auth.schoolCode || reqSc).trim();
    const cc = String(auth.comciganSchoolCode || reqCc).trim();
    const sn = String(auth.schoolName || reqSn).trim();
    if (!sc && !cc && !sn) {
      return { status: 200, json: { ok: true, exists: false } };
    }
    const requestedCol = String(params.collection || '').trim();
    const colsToCheck = requestedCol === '시간표_스냅샷'
      ? ['시간표_스냅샷']
      : (requestedCol === '시간표_기본' ? ['시간표_기본'] : ['시간표_스냅샷', '시간표_기본']);
    for (const colName of colsToCheck) {
      const colRef = db.collection(colName);
      for (const [field, val] of [['school_code', sc], ['comcigan_school_code', cc], ['school_name', sn]]) {
        if (val) {
          const snap = await colRef.where(field, '==', val).limit(1).get();
          if (!snap.empty) return { status: 200, json: { ok: true, exists: true, collection: colName } };
        }
      }
    }
    return { status: 200, json: { ok: true, exists: false } };
  }

  if (action === 'sync_timetable_snapshots') {
    const snapshots = Array.isArray(params.snapshots) ? params.snapshots : [];
    const cleanupComciganChanges = params.cleanup_comcigan_changes === undefined ? true : _toBool(params.cleanup_comcigan_changes);
    const cleanupDates = new Set(
      (Array.isArray(params.cleanup_dates) ? params.cleanup_dates : snapshots.map((s) => s && s.date))
        .map((d) => String(d || '').trim().slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    );
    let snapshotsWritten = 0;
    const now = _nowStr();
    for (let i = 0; i < snapshots.length; i += 200) {
      const slice = snapshots.slice(i, i + 200);
      const batch = db.batch();
      slice.forEach((rawSnap) => {
        if (!rawSnap || typeof rawSnap !== 'object') return;
        const rid = String(rawSnap.remote_id || '').trim().replace(/\//g, '_');
        if (!rid) return;
        const docData = {
          ...rawSnap,
          remote_id: rid,
          updated_at: rawSnap.updated_at || now,
        };
        if (scopeDefaults.schoolCode && !docData.school_code) docData.school_code = scopeDefaults.schoolCode;
        if (scopeDefaults.comciganSchoolCode && !docData.comcigan_school_code) docData.comcigan_school_code = scopeDefaults.comciganSchoolCode;
        if (scopeDefaults.schoolName && !docData.school_name) docData.school_name = scopeDefaults.schoolName;
        // 날짜별 최종 스냅샷 통째 교체: merge 없이 Set/Overwrite
        batch.set(db.collection('시간표_스냅샷').doc(rid), docData);
        snapshotsWritten += 1;
      });
      await batch.commit();
    }

    let changeDeleted = 0;
    if (cleanupComciganChanges && cleanupDates.size > 0) {
      const sc = String(params.school_code || auth.schoolCode || '').trim();
      const cc = String(params.comcigan_school_code || '').trim();
      const sn = String(params.school_name || auth.schoolName || '').trim();
      let existingSnap = null;
      if (sc) {
        existingSnap = await db.collection('시간표_변동').where('school_code', '==', sc).get().catch(() => null);
      } else if (cc) {
        existingSnap = await db.collection('시간표_변동').where('comcigan_school_code', '==', cc).get().catch(() => null);
      } else if (sn) {
        existingSnap = await db.collection('시간표_변동').where('school_name', '==', sn).get().catch(() => null);
      }
      if (existingSnap && !existingSnap.empty) {
        const staleIds = [];
        existingSnap.forEach((docSnap) => {
          const rid = String(docSnap.id || '').trim();
          if (!rid) return;
          const data = typeof docSnap.data === 'function' ? (docSnap.data() || {}) : {};
          const src = String(data.source || '').trim().toLowerCase();
          if (src !== 'comcigan' && src !== 'comcigan_playwright' && !rid.startsWith('tc_')) return;
          const docDate = String(data.date || data.target_date || '').trim().slice(0, 10);
          if (!docDate || cleanupDates.has(docDate)) staleIds.push(rid);
        });
        for (let i = 0; i < staleIds.length; i += 400) {
          const batch = db.batch();
          staleIds.slice(i, i + 400).forEach((rid) => {
            batch.delete(db.collection('시간표_변동').doc(rid));
            changeDeleted += 1;
          });
          await batch.commit();
        }
      }
    }
    return {
      status: 200,
      json: { ok: true, snapshots_written: snapshotsWritten, change_deleted: changeDeleted },
    };
  }

  if (action === 'sync_timetables_batch') {
    const baseRows = Array.isArray(params.base_rows) ? params.base_rows : [];
    const changeRows = Array.isArray(params.change_rows) ? params.change_rows : [];
    const deleteBaseIds = Array.isArray(params.delete_base_ids) ? params.delete_base_ids : [];
    const deleteChangeIds = Array.isArray(params.delete_change_ids) ? params.delete_change_ids : [];
    const reconcileChanges = _toBool(params.reconcile_changes);
    const reconcileDates = Array.isArray(params.reconcile_dates)
      ? params.reconcile_dates.map((d) => String(d || '').trim().slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [];
    const baseWritten = await _batchUpsertDocs(db, '시간표_기본', baseRows, scopeDefaults);
    if (baseWritten > 0 || deleteBaseIds.length > 0) _invalidateStaticCache('tt_base');
    const changeWritten = await _batchUpsertDocs(db, '시간표_변동', changeRows, scopeDefaults);
    let baseDeleted = 0;
    let changeDeleted = 0;

    // 컴시간 변동 동기화 시, 최신 파싱 결과에서 사라진(취소/원복된) 기존 컴시간 변동 문서를 정리
    const extraDeleteChangeIds = [];
    if (reconcileChanges) {
      const keepIds = new Set([
        ...changeRows.map((r) => String((r && r.remote_id) || '').trim()),
        ...(Array.isArray(params.keep_change_ids) ? params.keep_change_ids.map((x) => String(x || '').trim()) : []),
      ].filter(Boolean));
      const sc = String(params.school_code || auth.schoolCode || '').trim();
      const cc = String(params.comcigan_school_code || '').trim();
      const sn = String(params.school_name || auth.schoolName || '').trim();
      let existingSnap = null;
      if (sc) {
        existingSnap = await db.collection('시간표_변동').where('school_code', '==', sc).get().catch(() => null);
      } else if (cc) {
        existingSnap = await db.collection('시간표_변동').where('comcigan_school_code', '==', cc).get().catch(() => null);
      } else if (sn) {
        existingSnap = await db.collection('시간표_변동').where('school_name', '==', sn).get().catch(() => null);
      }
      if (existingSnap && !existingSnap.empty) {
        const minDate = reconcileDates.length > 0 ? reconcileDates.slice().sort()[0] : '';
        existingSnap.forEach((docSnap) => {
          const rid = String(docSnap.id || '').trim();
          if (!rid || keepIds.has(rid)) return;
          const data = typeof docSnap.data === 'function' ? (docSnap.data() || {}) : {};
          const src = String(data.source || '').trim().toLowerCase();
          const isComciganDoc = src === 'comcigan' || src === 'comcigan_playwright' || rid.startsWith('tc_');
          if (!isComciganDoc) return;
          const docDate = String(data.date || data.target_date || '').trim().slice(0, 10);
          if (reconcileDates.length > 0 && docDate && !reconcileDates.includes(docDate) && (!minDate || docDate < minDate)) {
            return;
          }
          extraDeleteChangeIds.push(rid);
        });
      }
    }

    const mergedDeleteChangeIds = Array.from(new Set([...deleteChangeIds, ...extraDeleteChangeIds]));
    for (const [colName, idList, isBase] of [['시간표_기본', deleteBaseIds, true], ['시간표_변동', mergedDeleteChangeIds, false]]) {
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
    _invalidateStaticCache('meals:');
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
    _invalidateStaticCache('students_');

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
    await _createNoticePublishedNotification(db, payload);
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
    _invalidateStaticCache('notice_replies_');
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
    const rawTargetRole = String(params.target_role || 'all').trim().toLowerCase();
    const targetRole = ['all', 'student', 'parent', 'teacher'].includes(rawTargetRole) ? rawTargetRole : 'all';
    const rawSid = String(params.target_student_id ?? params.student_id ?? '').trim();
    const normalizedSid = rawSid.toUpperCase() === 'ALL' ? '' : rawSid;
    const resolvedGrade = auth.gradeNum !== null ? auth.gradeNum : _toIntOrNull(params.grade);
    const resolvedClassNo = auth.classNum !== null ? auth.classNum : _toIntOrNull(params.class_no);
    const resolvedSchoolCode = auth.schoolCode || String(params.school_code || '').trim();
    const resolvedSchoolName = auth.schoolName || String(params.school_name || '').trim();
    const payload = {
      remote_id: rid,
      title: String(params.title || '').trim(),
      message: String(params.message || '').trim(),
      channel: String(params.channel || 'desktop_broadcast').trim(),
      target_role: targetRole,
      sender: String(params.sender || auth.teacherDoc.name || '담임교사').trim(),
      teacher_id: auth.teacherId,
      grade: resolvedGrade,
      class_no: resolvedClassNo,
      school_code: resolvedSchoolCode,
      school_name: resolvedSchoolName,
      student_id: normalizedSid,
      target_student_id: normalizedSid,
      is_read: false,
      read_by: [],
      created_at: String(params.created_at || '').trim() || _nowStr(),
      updated_at: _nowStr(),
    };
    await db.collection('Notifications').doc(rid).set(payload, { merge: true });
    await _dispatchClassNotificationPush(db, {
      title: payload.title || 'EduFlow 알림',
      message: payload.message,
      schoolCode: resolvedSchoolCode,
      grade: resolvedGrade,
      classNo: resolvedClassNo,
      targetRole,
      studentIds: normalizedSid ? [normalizedSid] : [],
    });
    return { status: 200, json: { ok: true, remote_id: rid } };
  }

  if (action === 'fetch_sent_notifications') {
    const lim = Math.min(200, Math.max(1, Number(params.limit || 50)));
    const rows = await _queryWithOrderByFallback(db.collection('Notifications'), 'created_at', 'desc', lim);
    const filtered = rows
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
        ? _queryWithOrderByFallback(db.collection('1:1_상담채팅').where('grade', 'in', gradeIn), 'created_at', 'desc', 400).catch(() => [])
        : Promise.resolve([]),
      _queryWithOrderByFallback(db.collection('가정통신문_목록'), 'created_at', 'desc', 150).catch(() => []),
      _queryWithOrderByFallback(db.collection('가정통신문_회신'), 'created_at', 'desc', 500).catch(() => []),
      _queryWithOrderByFallback(db.collection('학급_공지게시판'), 'created_at', 'desc', 150).catch(() => []),
      _queryWithOrderByFallback(db.collection('Notifications'), 'created_at', 'desc', 200).catch(() => []),
      db.collection('교과_명렬표').where('teacher_id', '==', auth.teacherId).limit(200).get().then(_snapToRows).catch(() => []),
      db.collection('교과_출결').where('teacher_id', '==', auth.teacherId).limit(500).get().then(_snapToRows).catch(() => []),
      db.collection('수업_진도').where('teacher_id', '==', auth.teacherId).limit(300).get().then(_snapToRows).catch(() => []),
      hasAssignedClass
        ? db.collection('Push_Subscriptions').where('grade', 'in', gradeIn).limit(500).get().then(_snapToRows).catch(() => [])
        : Promise.resolve([]),
      _queryWithOrderByFallback(db.collection('Schedules'), 'start_date', 'desc', 200).catch(() => []),
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
          .filter((d) => _matchesTenant(d, { ...tenant, gradeNum: null, classNum: null }) && _belongsToTeacher(d, auth))
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
    _invalidateStaticCache('students_');
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
    _invalidateStaticCache('students_');

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
    _invalidateStaticCache('students_');

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
    _invalidateStaticCache('budget');
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
    _invalidateStaticCache('budget');
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
    _invalidateStaticCache('subject_rosters:');
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
    const titleCheck = _validateStringInput(params.title, { maxLen: 200, required: true, label: '일정명(title)' });
    if (!titleCheck.ok) {
      return { status: 400, json: { ok: false, error: titleCheck.error } };
    }
    const title = titleCheck.value;
    const startDate = String(params.start_date || params.date || '').trim();
    if (!startDate) {
      return { status: 400, json: { ok: false, error: '일정명(title)과 시작일(start_date)이 필요합니다.' } };
    }
    const memoCheck = _validateStringInput(params.memo || params.description || '', { maxLen: 2000, required: false, label: '일정 메모(memo)' });
    if (!memoCheck.ok) {
      return { status: 400, json: { ok: false, error: memoCheck.error } };
    }
    const catCheck = _validateStringInput(params.category || '', { maxLen: 50, required: false, label: '일정 구분(category)' });
    if (!catCheck.ok) {
      return { status: 400, json: { ok: false, error: catCheck.error } };
    }
    const rid = String(params.remote_id || `sched_${auth.teacherId}_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const docRef = db.collection('Schedules').doc(rid);
    const existingSnap = params.remote_id ? await docRef.get() : null;
    const existing = existingSnap && existingSnap.exists ? { remote_id: existingSnap.id, ...(existingSnap.data() || {}) } : null;
    if (existing && !_belongsToTeacher(existing, auth)) {
      return { status: 403, json: { ok: false, error: '본인이 등록한 일정만 수정할 수 있습니다.' } };
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
      teacher_id: auth.teacherId,
      school_code: auth.schoolCode,
      school_name: auth.schoolName,
      grade: params.grade !== undefined ? _toIntOrNull(params.grade) : auth.gradeNum,
      class_no: params.class_no !== undefined ? _toIntOrNull(params.class_no) : auth.classNum,
      created_at: String((existing && existing.created_at) || nowStr),
      updated_at: nowStr,
    };
    await docRef.set(payload, { merge: true });
    _invalidateStaticCache('schedules:');
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
    if (!_belongsToTeacher(targetDoc, auth)) {
      return { status: 403, json: { ok: false, error: '본인이 등록한 일정만 삭제할 수 있습니다.' } };
    }
    await docRef.delete();
    _invalidateStaticCache('schedules:');
    return { status: 200, json: { ok: true, remote_id: rid, deleted: true } };
  }

  if (action === 'fetch_lesson_progress') {
    const rawLimit = _toIntOrNull(params.limit);
    const limitVal = rawLimit !== null && rawLimit > 0 ? Math.min(rawLimit, 500) : 300;
    const targetDate = String(params.date || '').trim().slice(0, 10);
    const snap = await db.collection('수업_진도').where('teacher_id', '==', auth.teacherId).limit(limitVal).get();
    const rows = _snapToRows(snap)
      .filter((d) => _belongsToTeacher(d, auth))
      .filter((d) => (!targetDate || String(d.date || '').trim().slice(0, 10) === targetDate))
      .sort((a, b) => {
        const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
        if (dateCmp !== 0) return dateCmp;
        const pA = Number(a.period);
        const pB = Number(b.period);
        if (Number.isFinite(pA) && Number.isFinite(pB) && pA !== pB) return pA - pB;
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
      });
    return { status: 200, json: { ok: true, items: rows, total: rows.length } };
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
    _invalidateStaticCache('lesson_progress:');
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
    _invalidateStaticCache('lesson_progress:');
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
    _invalidateStaticCache('lesson_progress:');
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
    const rawOnline = params.pc_online !== undefined
      ? params.pc_online
      : (params.pc_agent_online !== undefined ? params.pc_agent_online : params.online);
    const pcOnline = rawOnline === undefined ? true : _toBool(rawOnline);
    const nowIso = new Date().toISOString();
    const lastSeenAt = String(params.pc_last_seen_at || params.pc_agent_last_seen || params.last_seen || nowIso).trim();
    const hostname = String(params.pc_hostname || params.pc_agent_hostname || params.hostname || '').trim();
    const appVersion = String(params.pc_app_version || params.pc_agent_version || params.app_version || '').trim();
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
    let snap;
    try {
      snap = await db
        .collection('Tasks')
        .where('teacher_id', '==', auth.teacherId)
        .where('exec_status', 'in', ['pending', 'queued', 'running'])
        .limit(50)
        .get();
    } catch (err) {
      const isIndexErr = err && (err.code === 9 || /index|FAILED_PRECONDITION/i.test(String(err.message || '')));
      if (!isIndexErr) throw err;
      snap = await db.collection('Tasks').where('teacher_id', '==', auth.teacherId).limit(50).get();
    }
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
    _invalidateStaticCache('remote_tasks:');
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
  if (resolvedTitle.length > 200) {
    return { status: 400, json: { ok: false, error: '공지 제목(title)은 200자 이내로 입력해 주세요.' } };
  }
  if (resolvedSummary.length > 500) {
    return { status: 400, json: { ok: false, error: '공지 요약(summary)은 500자 이내로 입력해 주세요.' } };
  }
  if (resolvedContent.length > 20000) {
    return { status: 400, json: { ok: false, error: '공지 본문(content)은 20000자 이내로 입력해 주세요.' } };
  }
  const rawSourceUrl = params.source_url !== undefined ? String(params.source_url || '').trim() : String(existing.source_url || '').trim();
  if (rawSourceUrl && !/^https?:\/\//i.test(rawSourceUrl)) {
    return { status: 400, json: { ok: false, error: '원문 링크(source_url)는 http:// 또는 https:// 주소만 허용됩니다.' } };
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
    created_at: String(params.created_at || existing.created_at || '').trim() || nowStr,
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
  const grade = _toIntOrNull(notice.target_grade ?? notice.grade);
  const classNo = _toIntOrNull(notice.target_class ?? notice.class_no);
  const schoolCode = String(notice.school_code || '').trim();
  const schoolName = String(notice.school_name || '').trim();
  const msg = dueDate
    ? `${title} (마감: ${dueDate})가 게시되었습니다. 확인 후 회신해 주세요.`
    : `${title}가 게시되었습니다. 확인해 주세요.`;
  await db.collection('Notifications').doc(rid).set(
    {
      remote_id: rid,
      title: `[가정통신문] ${title}`,
      message: msg,
      channel: 'notice_publish',
      target_role: 'all',
      sender: String(notice.author_name || '담임교사'),
      teacher_id: String(notice.teacher_id || '').trim(),
      grade,
      class_no: classNo,
      school_code: schoolCode,
      school_name: schoolName,
      student_id: '',
      target_student_id: '',
      notice_id: noticeId,
      is_read: false,
      read_by: [],
      created_at: nowStr,
      updated_at: nowStr
    },
    { merge: true }
  );
  await _dispatchClassNotificationPush(db, {
    title: `[가정통신문] ${title}`,
    message: msg,
    schoolCode,
    grade,
    classNo,
    targetRole: 'all',
    studentIds: [],
  });
  return rid;
}

async function _dispatchClassNotificationPush(db, opts = {}) {
  try {
    const title = String(opts.title || 'EduFlow 알림').trim();
    const message = String(opts.message || '').trim();
    const schoolCode = String(opts.schoolCode || '').trim();
    const grade = _toIntOrNull(opts.grade);
    const classNo = _toIntOrNull(opts.classNo);
    const targetRole = String(opts.targetRole || 'all').trim().toLowerCase() || 'all';
    const studentIds = Array.isArray(opts.studentIds)
      ? opts.studentIds.map((s) => String(s || '').trim()).filter((s) => s && s.toUpperCase() !== 'ALL')
      : [];
    const url = String(opts.url || '/').trim();

    let queryRef = db.collection('Push_Subscriptions');
    if (studentIds.length === 1) {
      queryRef = queryRef.where('student_id', '==', studentIds[0]);
    } else if (targetRole && targetRole !== 'all') {
      queryRef = queryRef.where('role', '==', targetRole);
    } else if (schoolCode) {
      queryRef = queryRef.where('school_code', '==', schoolCode);
    } else if (grade !== null) {
      queryRef = queryRef.where('grade', '==', grade);
    }

    const snap = await queryRef.get();
    const idSet = studentIds.length > 0 ? new Set(studentIds) : null;
    const subs = [];
    snap.forEach((doc) => {
      const s = doc.data() || {};
      if (!s.endpoint || !s.p256dh || !s.auth) return;
      const sRole = String(s.role || '').trim().toLowerCase();
      if (targetRole === 'teacher') {
        if (sRole !== 'teacher') return;
      } else if (targetRole === 'student' || targetRole === 'parent') {
        if (sRole !== targetRole) return;
      } else if (sRole === 'teacher' && !idSet) {
        return;
      }
      const sSchoolCode = String(s.school_code || '').trim();
      if (schoolCode && sSchoolCode !== schoolCode) return;
      if (idSet) {
        if (!idSet.has(String(s.student_id || '').trim())) return;
      } else {
        if (grade !== null && _toIntOrNull(s.grade) !== grade) return;
        if (classNo !== null && _toIntOrNull(s.class_no) !== classNo) return;
      }
      subs.push({ _docId: doc.id, ...s });
    });

    await _dispatchWebPushToSubs(db, subs, { title, body: message, url });
  } catch (err) {
    console.warn('[_dispatchClassNotificationPush]', err && err.message ? err.message : err);
  }
}

async function _dispatchWebPushToSubs(db, subs, { title, body, url = '/' }) {
  const list = Array.isArray(subs) ? subs : [];
  if (list.length === 0) return;
  const vapidPublicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const vapidPrivateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  const prodHost = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '').trim().replace(/^https?:\/\//, '');
  const vapidSubject = String(process.env.VAPID_SUBJECT || (prodHost ? `mailto:admin@${prodHost}` : 'mailto:noreply@eduflow.kr')).trim();
  if (!vapidPublicKey || !vapidPrivateKey) return;

  const webpush = require('web-push');
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const payload = JSON.stringify({
    title,
    body,
    icon: '/icon.svg',
    badge: '/badge-96.png',
    url
  });

  const results = await Promise.allSettled(
    list.map((s) =>
      webpush.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth }
        },
        payload
      )
    )
  );

  const expiredDocIds = [];
  results.forEach((r, idx) => {
    if (r.status === 'rejected') {
      const err = r.reason || {};
      if (err.statusCode === 410 || err.statusCode === 404) {
        const docId = list[idx] && list[idx]._docId;
        if (docId) expiredDocIds.push(docId);
      }
    }
  });
  if (expiredDocIds.length > 0) {
    await Promise.allSettled(
      expiredDocIds.map((docId) => db.collection('Push_Subscriptions').doc(docId).delete())
    );
  }
}

async function _notifyClassTeachers(db, opts = {}) {
  try {
    const nowStr = _nowStr();
    const channel = String(opts.channel || 'teacher_alert').trim();
    const teacherId = String(opts.teacherId || opts.teacher_id || '').trim();
    const schoolCode = String(opts.schoolCode || opts.school_code || '').trim();
    const schoolName = String(opts.schoolName || opts.school_name || '').trim();
    const gradeNum = _toIntOrNull(opts.grade);
    const classNum = _toIntOrNull(opts.classNo ?? opts.class_no);
    const studentId = String(opts.studentId || opts.student_id || '').trim();
    const title = String(opts.title || '학급 알림').trim();
    const message = String(opts.message || '').trim();
    const sender = String(opts.sender || '').trim();
    const url = String(opts.url || '/').trim();

    const rid = `noti_t_${channel.replace(/[^a-zA-Z0-9_]/g, '') || 'alert'}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await db.collection('Notifications').doc(rid).set(
      {
        remote_id: rid,
        title,
        message,
        channel,
        target_role: 'teacher',
        teacher_id: teacherId,
        sender,
        school_code: schoolCode,
        school_name: schoolName,
        grade: gradeNum,
        class_no: classNum,
        student_id: studentId,
        is_read: false,
        read_by: [],
        created_at: nowStr,
        updated_at: nowStr
      },
      { merge: true }
    );

    const subSnap = await db.collection('Push_Subscriptions').where('role', '==', 'teacher').get();
    const subs = [];
    subSnap.forEach((doc) => {
      const s = doc.data() || {};
      if (!s.endpoint || !s.p256dh || !s.auth) return;
      const sSchoolCode = String(s.school_code || '').trim();
      if (schoolCode && sSchoolCode && sSchoolCode !== schoolCode) return;

      const sUserId = String(s.user_id || '').trim();
      const matchedTeacherId = Boolean(teacherId && sUserId && sUserId === teacherId);

      const sGrade = _toIntOrNull(s.grade);
      const sClassNo = _toIntOrNull(s.class_no);
      const matchedClass =
        gradeNum !== null &&
        classNum !== null &&
        sGrade === gradeNum &&
        sClassNo === classNum &&
        (!schoolCode || sSchoolCode === schoolCode);

      if (matchedTeacherId || matchedClass) {
        subs.push({ _docId: doc.id, ...s });
      }
    });

    await _dispatchWebPushToSubs(db, subs, { title, body: message, url });
    return rid;
  } catch (err) {
    console.warn('[_notifyClassTeachers]', err && err.message ? err.message : err);
    return null;
  }
}

async function _notifyStudentAndParent(db, opts = {}) {
  try {
    const nowStr = _nowStr();
    const channel = String(opts.channel || 'student_alert').trim();
    const schoolCode = String(opts.schoolCode || opts.school_code || '').trim();
    const schoolName = String(opts.schoolName || opts.school_name || '').trim();
    const gradeNum = _toIntOrNull(opts.grade);
    const classNum = _toIntOrNull(opts.classNo ?? opts.class_no);
    const studentId = String(opts.studentId || opts.student_id || '').trim();
    const targetUserId = String(opts.targetUserId || opts.target_user_id || '').trim();
    const targetRole = String(opts.targetRole || opts.target_role || 'all').trim().toLowerCase() || 'all';
    const title = String(opts.title || '학급 알림').trim();
    const message = String(opts.message || '').trim();
    const sender = String(opts.sender || '담임교사').trim();
    const url = String(opts.url || '/').trim();

    const rid = `noti_s_${channel.replace(/[^a-zA-Z0-9_]/g, '') || 'alert'}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    await db.collection('Notifications').doc(rid).set(
      {
        remote_id: rid,
        title,
        message,
        channel,
        target_role: targetRole,
        sender,
        school_code: schoolCode,
        school_name: schoolName,
        grade: gradeNum,
        class_no: classNum,
        student_id: studentId,
        target_student_id: studentId,
        is_read: false,
        read_by: [],
        created_at: nowStr,
        updated_at: nowStr
      },
      { merge: true }
    );

    if (!studentId && !targetUserId) return rid;
    const snap = studentId
      ? await db.collection('Push_Subscriptions').where('student_id', '==', studentId).get()
      : await db.collection('Push_Subscriptions').where('user_id', '==', targetUserId).get();
    const subs = [];
    snap.forEach((doc) => {
      const s = doc.data() || {};
      if (!s.endpoint || !s.p256dh || !s.auth) return;
      const sRole = String(s.role || '').trim().toLowerCase();
      if (sRole === 'teacher') return;
      if (targetRole !== 'all' && sRole && sRole !== targetRole) return;
      const sSchoolCode = String(s.school_code || '').trim();
      if (schoolCode && sSchoolCode && sSchoolCode !== schoolCode) return;
      subs.push({ _docId: doc.id, ...s });
    });

    await _dispatchWebPushToSubs(db, subs, { title, body: message, url });
    return rid;
  } catch (err) {
    console.warn('[_notifyStudentAndParent]', err && err.message ? err.message : err);
    return null;
  }
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
        signature_file_id: reply ? String(reply.signature_file_id || '') : '',
        student_signature_drive_url: reply ? String(reply.student_signature_drive_url || '') : '',
        student_signature_file_id: reply ? String(reply.student_signature_file_id || '') : '',
        reply_file_drive_url: reply ? String(reply.reply_file_drive_url || '') : '',
        signed_at: reply ? String(reply.signed_at || '') : '',
        submitted_at: reply ? String(reply.submitted_at || reply.updated_at || '') : '',
      };
    });

  return { schema, rows };
}

module.exports._testHelpers = {
  _parsePayload,
  _normalizeSignatureMode,
  _validateStringInput,
  _handleGetMobileBundle,
  _handleLogin,
  _handleVerifySession,
  _signSessionToken,
  _verifySessionToken,
  _verifyRequestSession,
  _matchesSessionStudent,
  _matchesSessionStudentWithLookup,
  _verifyPassword,
  _extractSessionToken,
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
  _nowStr,
  _kstDateStr,
  _syncNeisMeals,
};
