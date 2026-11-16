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

function _toBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const s = String(val || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === '예';
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

function _matchesTenant(doc, { schoolCode, schoolName, gradeNum, classNum }) {
  if (!doc || typeof doc !== 'object') return false;
  const docSchoolCode = String(doc.school_code || doc.neis_school_code || '').trim();
  const docSchoolName = String(doc.school_name || '').trim();
  if (schoolCode && docSchoolCode && docSchoolCode !== schoolCode) return false;
  if (schoolName && docSchoolName && docSchoolName !== schoolName) return false;

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
  const skipStatic = String(params.skip_static || '') === '1';

  const hasClassFilter = gradeNum !== null && classNum !== null;
  const tenant = { schoolCode, schoolName, gradeNum, classNum };

  // 읽기 비용 최적화 & 멀티 테넌트 격리:
  // 1) 시간표_기본/변동 등은 전체 컬렉션 get() 금지 -> 반드시 grade, class_no 조건절로 본인 반만 조회
  // 2) 학교(school_code / school_name) 및 학급(grade, class_no) 기준으로 타 학교/타 반 데이터 격리
  // 3) 시간표_기본, 급식_식단표, 설정_서류규정은 클라이언트 localStorage 일일 캐시 히트 시(skip_static=1) 조회 생략
  const [
    teachersRaw,
    studentsRows,
    attendanceRows,
    docTrackingRows,
    noticesRaw,
    noticeRepliesRaw,
    timetableBaseRows,
    timetableChangesRows,
    mealsRaw,
    docRulesRows,
    chatRows,
    notificationsRaw
  ] = await Promise.all([
    role === 'teacher' && userId
      ? db.collection('계정_교사').doc(userId).get().then((d) => (d.exists ? [{ remote_id: d.id, ...d.data() }] : []))
      : (hasClassFilter
          ? _queryClassScoped(db, '계정_교사', gradeNum, classNum)
          : db.collection('계정_교사').limit(20).get().then(_snapToRows)),
    hasClassFilter
      ? _queryClassScoped(db, '계정_학생', gradeNum, classNum)
      : (studentId
          ? db.collection('계정_학생').doc(studentId).get().then((d) => (d.exists ? [{ remote_id: d.id, ...d.data() }] : []))
          : Promise.resolve([])),
    hasClassFilter
      ? _queryClassScoped(db, '일일_출결', gradeNum, classNum)
      : (studentId
          ? db.collection('일일_출결').where('student_id', '==', studentId).get().then(_snapToRows)
          : Promise.resolve([])),
    studentId && role !== 'teacher'
      ? db.collection('서류_추적').where('student_id', '==', studentId).get().then(_snapToRows)
      : (hasClassFilter
          ? _queryClassScoped(db, '서류_추적', gradeNum, classNum)
          : db.collection('서류_추적').limit(100).get().then(_snapToRows)),
    db.collection('가정통신문_목록').limit(50).get().then(_snapToRows),
    studentId && role !== 'teacher'
      ? db.collection('가정통신문_회신').where('student_id', '==', studentId).get().then(_snapToRows)
      : db.collection('가정통신문_회신').limit(200).get().then(_snapToRows),
    !skipStatic && hasClassFilter
      ? _queryClassScoped(db, '시간표_기본', gradeNum, classNum)
      : Promise.resolve(undefined),
    hasClassFilter
      ? _queryClassScoped(db, '시간표_변동', gradeNum, classNum)
      : Promise.resolve([]),
    !skipStatic
      ? (schoolCode
          ? db.collection('급식_식단표').where('school_code', '==', schoolCode).limit(60).get().then(_snapToRows)
          : db.collection('급식_식단표').limit(60).get().then(_snapToRows))
      : Promise.resolve(undefined),
    !skipStatic
      ? db.collection('설정_서류규정').limit(50).get().then(_snapToRows)
      : Promise.resolve(undefined),
    studentId && role !== 'teacher'
      ? db.collection('1:1_상담채팅').where('room_id', '==', `ROOM-${studentId}`).get().then(_snapToRows)
      : (hasClassFilter
          ? _queryClassScoped(db, '1:1_상담채팅', gradeNum, classNum)
          : db.collection('1:1_상담채팅').limit(100).get().then(_snapToRows)),
    db.collection('Notifications').where('is_read', '==', false).limit(50).get().then(_snapToRows)
  ]);

  const teachersSnap = teachersRaw.filter((d) => _matchesTenant(d, { schoolCode, schoolName, gradeNum: null, classNum: null }));
  const filteredStudents = studentsRows.filter((d) => _matchesTenant(d, tenant));
  const studentIdSet = new Set(filteredStudents.map((s) => String(s.student_id || s.remote_id || '')).filter(Boolean));
  const filteredNotices = noticesRaw.filter((d) => _matchesTenant(d, tenant));
  const noticeIdSet = new Set(filteredNotices.map((n) => String(n.remote_id || '')).filter(Boolean));

  const bundle = {
    ok: true,
    backend: 'firestore',
    server_time: _nowStr(),
    teachers: teachersSnap,
    students: filteredStudents,
    attendance: attendanceRows.filter((d) => _matchesTenant(d, tenant)),
    doc_tracking: docTrackingRows.filter((d) => _matchesTenant(d, tenant)),
    notices: filteredNotices,
    notice_replies: noticeRepliesRaw.filter((r) => {
      if (noticeIdSet.size > 0 && r.notice_id && !noticeIdSet.has(String(r.notice_id))) return false;
      if (studentIdSet.size > 0 && r.student_id && !studentIdSet.has(String(r.student_id))) return false;
      return true;
    }),
    timetable_changes: timetableChangesRows.filter((d) => _matchesTenant(d, tenant)),
    chat_messages: chatRows.filter((d) => _matchesTenant(d, tenant)),
    notifications: notificationsRaw.filter((d) => _matchesTenant(d, tenant))
  };

  if (timetableBaseRows !== undefined) bundle.timetable_base = timetableBaseRows.filter((d) => _matchesTenant(d, tenant));
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
      const rid = String(params.remote_id || `att_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
      await db.collection('일일_출결').doc(rid).set(
        {
          remote_id: rid,
          date: String(params.date || new Date().toISOString().slice(0, 10)),
          student_id: String(params.student_id || ''),
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
      if (action === 'mark_document_submitted') {
        update.status = 'submitted';
        update.submitted_at = _nowStr();
        if (params.attachment_url) update.attachment_url = String(params.attachment_url);
      } else if (action === 'confirm_document') {
        update.status = 'closed';
        update.teacher_confirmed = true;
      } else {
        Object.assign(update, {
          student_id: String(params.student_id || ''),
          student_name: String(params.student_name || ''),
          grade: _toIntOrNull(params.grade),
          class_no: _toIntOrNull(params.class_no),
          rule_code: String(params.rule_code || ''),
          doc_type: String(params.doc_type || ''),
          base_date: String(params.base_date || ''),
          due_date: String(params.due_date || ''),
          memo: String(params.memo || ''),
          status: String(params.status || 'pending'),
          attachment_url: String(params.attachment_url || '')
        });
      }
      await db.collection('서류_추적').doc(rid).set(update, { merge: true });
      return res.status(200).json({ ok: true, remote_id: rid });
    }

    if (action === 'upsert_doc_rule') {
      const rid = String(params.remote_id || params.rule_code || `rule_${Date.now()}`);
      await db.collection('설정_서류규정').doc(rid).set(
        {
          remote_id: rid,
          rule_code: String(params.rule_code || rid),
          title: String(params.title || ''),
          due_business_days: _toIntOrNull(params.due_business_days),
          is_active: params.is_active === undefined ? true : _toBool(params.is_active),
          updated_at: _nowStr()
        },
        { merge: true }
      );
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
      await db.collection('가정통신문_목록').doc(rid).set(
        {
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
          is_published: params.is_published === undefined ? true : _toBool(params.is_published),
          updated_at: _nowStr()
        },
        { merge: true }
      );
      return res.status(200).json({ ok: true, remote_id: rid, attachment_url: attachmentUrl });
    }

    if (action === 'submit_notice_reply') {
      const noticeId = String(params.notice_id || '').trim();
      const studentId = String(params.student_id || '').trim();
      const rid = String(params.remote_id || `reply_${noticeId}_${studentId}`);
      let sigDriveUrl = String(params.signature_drive_url || params.signature_url || '');
      let driveError = '';
      if (params.signature_base64) {
        const driveRes = await uploadBase64ToDrive({
          base64Data: params.signature_base64,
          fileName: `sig_${noticeId}_${studentId}.png`,
          mimeType: 'image/png',
          folderName: 'EduFlow_Signatures'
        });
        if (driveRes.ok) {
          sigDriveUrl = driveRes.downloadUrl;
        } else {
          driveError = driveRes.error || '';
        }
      }
      await db.collection('가정통신문_회신').doc(rid).set(
        {
          remote_id: rid,
          notice_id: noticeId,
          student_id: studentId,
          student_name: String(params.student_name || ''),
          parent_id: String(params.parent_id || ''),
          parent_name: String(params.parent_name || ''),
          reply_choice: String(params.reply_choice || params.consent || '동의'),
          signature_drive_url: sigDriveUrl,
          signature_url: sigDriveUrl,
          memo: String(params.memo || ''),
          submitted_at: _nowStr(),
          updated_at: _nowStr()
        },
        { merge: true }
      );
      return res.status(200).json({
        ok: true,
        remote_id: rid,
        signature_drive_url: sigDriveUrl,
        drive_warning: driveError || undefined
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
      }
      await db.collection('계정_교사').doc(tid).set(data, { merge: true });
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

    return res.status(400).json({ ok: false, error: `지원하지 않는 action입니다: ${action}` });
  } catch (err) {
    const errPayload = buildFirestoreErrorPayload(err, `API:${action}`);
    return res.status(errPayload.code === 'FIRESTORE_INDEX_REQUIRED' ? 400 : 500).json(errPayload);
  }
};
