/**
 * Vercel Serverless Function: Cloud Firestore Direct API
 * 기존 Google Apps Script 웹 앱 호출을 완전히 제거하고
 * firebase-admin SDK로 Cloud Firestore를 직접 조회·수정합니다.
 */
const crypto = require('crypto');
const { getFirestore, buildFirestoreErrorPayload } = require('./_firebaseAdmin');
const { uploadBase64ToDrive } = require('./_googleDrive');

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

  const safeUser = { ...userDoc, role };
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
    budgetRows
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
      : db.collection('학급회비').limit(100).get().then(_snapToRows)
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
  const filteredNotices = noticesRaw.filter((d) => {
    if (!_matchesTenant(d, tenant)) return false;
    if (!isTeacherRole) {
      const isPub = d.is_published === undefined ? true : _toBool(d.is_published);
      if (!isPub) return false;
    }
    return true;
  });
  const noticeIdSet = new Set(filteredNotices.map((n) => String(n.remote_id || '')).filter(Boolean));

  const bundle = {
    ok: true,
    backend: 'firestore',
    server_time: _nowStr(),
    teachers: teachersSnap,
    students: filteredStudents,
    attendance: attendanceRows.filter((d) => _matchesTenant(d, tenant)),
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
    budget: budgetRows.filter((d) => _matchesTenant(d, tenant))
  };

  if (timetableBaseRows !== undefined) bundle.timetable_base = timetableBaseRows.filter(_matchesTimetableRow);
  if (mealsRaw !== undefined) bundle.meals = mealsRaw.filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }));
  if (docRulesRows !== undefined) bundle.doc_rules = docRulesRows;

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
      const requesterId = String(params.requester_id || params.teacher_id || params.user_id || '').trim();
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
      if (actorRole !== 'teacher') {
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
      await db.collection('일일_출결').doc(rid).set(
        {
          remote_id: rid,
          date: attDate,
          student_id: sid,
          student_name: String(params.student_name || ''),
          grade: _toIntOrNull(params.grade),
          class_no: _toIntOrNull(params.class_no),
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
      if (actorRole !== 'teacher') {
        const existingDoc = await db.collection('일일_출결').doc(rid).get();
        if (existingDoc.exists && _toBool((existingDoc.data() || {}).teacher_confirmed)) {
          return res.status(200).json({ ok: false, error: '이미 담임 선생님이 확인한 출결 내역이 있어 새로 등록하거나 수정할 수 없습니다.' });
        }
      }
      await db.collection('일일_출결').doc(rid).delete();
      return res.status(200).json({ ok: true, deleted_id: rid });
    }

    if (action === 'delete_attendance_batch') {
      const rawIds = Array.isArray(params.remote_ids) ? params.remote_ids : [];
      const ids = rawIds.map(id => String(id || '').trim()).filter(Boolean);
      if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: 'remote_ids 배열이 필요합니다.' });
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
      await db.collection('일일_출결').doc(rid).set({ remote_id: rid, teacher_confirmed: true, updated_at: _nowStr() }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    if (action === 'save_class_attendance') {
      const records = Array.isArray(params.records) ? params.records : [];
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
            grade: _toIntOrNull(rec.grade ?? params.grade),
            class_no: _toIntOrNull(rec.class_no ?? params.class_no),
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
        Object.assign(update, {
          student_id: String(params.student_id || ''),
          student_name: String(params.student_name || ''),
          grade: resolvedGrade,
          class_no: resolvedClassNo,
          rule_code: ruleCode,
          doc_type: String(params.doc_type || ''),
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
      const rid = String(params.remote_id || '').trim();
      if (!rid) return res.status(400).json({ ok: false, error: 'remote_id가 필요합니다.' });
      await db.collection('서류_추적').doc(rid).delete();
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
      const rid = String(params.remote_id || `noti_doc_${Date.now()}`);
      let attachmentUrl = String(params.attachment_url || '');
      if (!attachmentUrl && params.attachment_base64) {
        const driveRes = await uploadBase64ToDrive({
          base64Data: params.attachment_base64,
          fileName: String(params.attachment_name || `notice_${rid}.pdf`),
          mimeType: String(params.attachment_mime || 'application/pdf'),
          folderName: 'EduFlow_Notices'
        });
        if (driveRes.ok) attachmentUrl = driveRes.downloadUrl;
      }
      const isPublished = params.is_published === undefined ? true : _toBool(params.is_published);
      const signatureMode = String(params.signature_mode || '').trim().toLowerCase() === 'both' ? 'both' : 'single';
      const nowStr = _nowStr();
      const noticePayload = {
        remote_id: rid,
        title: String(params.title || ''),
        category: String(params.category || '가정통신문'),
        content: String(params.content || ''),
        target_grade: _toIntOrNull(params.target_grade ?? params.grade),
        target_class: _toIntOrNull(params.target_class ?? params.class_no),
        school_code: String(params.school_code || ''),
        school_name: String(params.school_name || ''),
        due_date: String(params.due_date || ''),
        author_name: String(params.author_name || '담임교사'),
        attachment_url: attachmentUrl,
        requires_reply: params.requires_reply === undefined ? true : _toBool(params.requires_reply),
        signature_mode: signatureMode,
        is_published: isPublished,
        updated_at: nowStr
      };
      if (params.reply_schema_json !== undefined) {
        noticePayload.reply_schema_json = typeof params.reply_schema_json === 'string'
          ? params.reply_schema_json
          : JSON.stringify(params.reply_schema_json || []);
      }
      if (isPublished) {
        noticePayload.published_at = nowStr;
      }
      await db.collection('가정통신문_목록').doc(rid).set(noticePayload, { merge: true });
      if (isPublished && params.create_notification !== false) {
        await _createNoticePublishedNotification(db, noticePayload);
      }
      return res.status(200).json({ ok: true, remote_id: rid, attachment_url: attachmentUrl, is_published: isPublished, signature_mode: signatureMode });
    }

    if (action === 'publish_notice') {
      const rid = String(params.remote_id || params.notice_id || '').trim();
      if (!rid) {
        return res.status(400).json({ ok: false, error: 'remote_id 또는 notice_id가 필요합니다.' });
      }
      const docRef = db.collection('가정통신문_목록').doc(rid);
      const existingSnap = await docRef.get();
      const existing = existingSnap.exists ? (existingSnap.data() || {}) : {};
      const nowStr = _nowStr();
      const rawSigMode = params.signature_mode !== undefined ? params.signature_mode : existing.signature_mode;
      const signatureMode = String(rawSigMode || '').trim().toLowerCase() === 'both' ? 'both' : 'single';
      const mergedPayload = {
        remote_id: rid,
        title: String(params.title !== undefined ? params.title : (existing.title || '')).trim(),
        category: String(params.category !== undefined ? params.category : (existing.category || '가정통신문')).trim(),
        content: String(params.content !== undefined ? params.content : (existing.content || '')).trim(),
        due_date: String(params.due_date !== undefined ? params.due_date : (existing.due_date || '')).trim(),
        target_grade: _toIntOrNull(params.target_grade ?? params.grade ?? existing.target_grade),
        target_class: _toIntOrNull(params.target_class ?? params.class_no ?? existing.target_class),
        school_code: String(params.school_code !== undefined ? params.school_code : (existing.school_code || '')).trim(),
        school_name: String(params.school_name !== undefined ? params.school_name : (existing.school_name || '')).trim(),
        author_name: String(params.author_name !== undefined ? params.author_name : (existing.author_name || '담임교사')).trim(),
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
      const rid = String(params.remote_id || `chat_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      await db.collection('1:1_상담채팅').doc(rid).set(
        {
          remote_id: rid,
          room_id: String(params.room_id || `ROOM-${params.student_id || 'DEFAULT'}`),
          student_id: String(params.student_id || ''),
          grade: _toIntOrNull(params.grade),
          class_no: _toIntOrNull(params.class_no),
          sender_role: String(params.sender_role || 'student'),
          sender_name: String(params.sender_name || ''),
          message: String(params.message || ''),
          is_read: false,
          created_at: _nowStr(),
          updated_at: _nowStr()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'mark_chat_read') {
      const roomId = String(params.room_id || '').trim();
      const readerRole = String(params.reader_role || 'teacher').trim();
      if (roomId) {
        const snap = await db.collection('1:1_상담채팅').where('room_id', '==', roomId).get();
        const batch = db.batch();
        let cnt = 0;
        snap.forEach((doc) => {
          const d = doc.data() || {};
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
      const tid = String(params.teacher_id || params.remote_id || '').trim();
      if (!tid) return res.status(400).json({ ok: false, error: 'teacher_id가 필요합니다.' });
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
      await db.collection('Tasks').doc(rid).set(
        {
          remote_id: rid,
          title: String(params.title || ''),
          task_type: String(params.task_type || 'general'),
          scheduled_time: String(params.scheduled_time || ''),
          target_info: String(params.target_info || ''),
          action_payload: typeof params.action_payload === 'string' ? params.action_payload : JSON.stringify(params.action_payload || {}),
          exec_status: 'pending',
          is_done: false,
          is_mobile_task: true,
          memo: String(params.memo || ''),
          updated_at: _nowStr()
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
      'fetch_notice_replies',
      'send_class_notification',
      'fetch_sent_notifications',
      'fetch_chat_history',
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
      author_name: String(params.author_name || auth.teacherDoc.name || '담임교사').trim(),
      is_published: true,
      updated_at: _nowStr(),
    };
    await db.collection('가정통신문_목록').doc(rid).set(payload, { merge: true });
    return { status: 200, json: { ok: true, remote_id: rid } };
  }

  if (action === 'fetch_notice_replies') {
    const nid = String(params.notice_id || '').trim();
    if (!nid) return { status: 200, json: { ok: true, replies: [] } };
    const snap = await db.collection('가정통신문_회신').where('notice_id', '==', nid).get();
    return { status: 200, json: { ok: true, replies: _snapToRows(snap) } };
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

  return { status: 400, json: { ok: false, error: `지원하지 않는 데스크톱 action입니다: ${action}` } };
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

module.exports._testHelpers = {
  _handleGetMobileBundle,
  _matchesTenant,
  _normalizeTeacherName,
  _verifyActiveTeacherAuth,
  _handleDesktopApiAction,
  _createNoticePublishedNotification,
};
