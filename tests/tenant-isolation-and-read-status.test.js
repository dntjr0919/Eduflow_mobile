const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let activeMockDb = null;
const firebaseAdminPath = path.resolve(__dirname, '../api/_firebaseAdmin.js');
require.cache[firebaseAdminPath] = {
  id: firebaseAdminPath,
  filename: firebaseAdminPath,
  loaded: true,
  exports: {
    getFirestore: () => {
      if (!activeMockDb) throw new Error('Mock db should be passed directly');
      return activeMockDb;
    },
    buildFirestoreErrorPayload: (err, ctx) => ({ ok: false, error: err.message, ctx }),
  },
};

const googleDrivePath = path.resolve(__dirname, '../api/_googleDrive.js');
require.cache[googleDrivePath] = {
  id: googleDrivePath,
  filename: googleDrivePath,
  loaded: true,
  exports: {},
};

const handler = require('../api/firestore.js');
const { _testHelpers } = handler;
const {
  _matchesTenant,
  _signSessionToken,
  _handleGetMobileBundle,
} = _testHelpers;

function createMockDb(initialCollections = {}) {
  const store = new Map();
  for (const [colName, docs] of Object.entries(initialCollections)) {
    const colMap = new Map();
    for (const [docId, data] of Object.entries(docs)) {
      colMap.set(docId, { ...data });
    }
    store.set(colName, colMap);
  }
  function getColMap(colName) {
    if (!store.has(colName)) store.set(colName, new Map());
    return store.get(colName);
  }
  function makeDocRef(colName, docId) {
    return {
      async get() {
        const colMap = getColMap(colName);
        return makeSnap(docId, colMap.get(docId), makeDocRef(colName, docId));
      },
      async set(data, opts = {}) {
        const colMap = getColMap(colName);
        const prev = colMap.get(docId);
        if (opts && opts.merge && prev) {
          colMap.set(docId, { ...prev, ...data });
        } else {
          colMap.set(docId, { ...data });
        }
      },
    };
  }
  function makeSnap(docId, data, ref) {
    return {
      id: docId,
      ref,
      exists: data !== undefined,
      data: () => (data ? { ...data } : undefined),
    };
  }
  function makeQuery(colName, filters = [], limitCount = null) {
    return {
      where(field, op, val) {
        return makeQuery(colName, [...filters, { field, op, val }], limitCount);
      },
      orderBy() {
        return makeQuery(colName, filters, limitCount);
      },
      limit(n) {
        return makeQuery(colName, filters, n);
      },
      async get() {
        const colMap = getColMap(colName);
        let entries = Array.from(colMap.entries()).filter(([, data]) => {
          return filters.every(({ field, op, val }) => {
            const actual = data ? data[field] : undefined;
            if (op === '==') return actual === val;
            if (op === 'in') return Array.isArray(val) && val.includes(actual);
            if (op === '>=') return String(actual || '') >= String(val || '');
            return true;
          });
        });
        if (typeof limitCount === 'number') {
          entries = entries.slice(0, limitCount);
        }
        const docs = entries.map(([id, data]) => makeSnap(id, data, makeDocRef(colName, id)));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach(cb) {
            docs.forEach(cb);
          },
        };
      },
    };
  }
  return {
    _store: store,
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push(() => ref.set(data, opts)); },
        async commit() { for (const op of ops) await op(); },
      };
    },
    collection(colName) {
      const q = makeQuery(colName);
      return {
        ...q,
        doc(docId) {
          return makeDocRef(colName, docId);
        },
      };
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
  return res;
}

test('api/firestore.js removes hardcoded fallback secret and fails closed in production', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../api/firestore.js'), 'utf8');
  assert.equal(src.includes('eduflow_mobile_dev_fallback_secret'), false);
  assert.equal(src.includes("SUPER_ADMIN_ID = '유우석'"), false);

  const prevSecret = process.env.AUTH_TOKEN_SECRET;
  const prevJwt = process.env.JWT_SECRET;
  const prevSess = process.env.SESSION_SECRET;
  const prevPk = process.env.FIREBASE_PRIVATE_KEY;
  const prevSa = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.AUTH_TOKEN_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.SESSION_SECRET;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    process.env.NODE_ENV = 'production';
    assert.throws(() => _signSessionToken({ sub: 't1', role: 'teacher' }), /AUTH_TOKEN_SECRET/);
  } finally {
    if (prevSecret !== undefined) process.env.AUTH_TOKEN_SECRET = prevSecret;
    if (prevJwt !== undefined) process.env.JWT_SECRET = prevJwt;
    if (prevSess !== undefined) process.env.SESSION_SECRET = prevSess;
    if (prevPk !== undefined) process.env.FIREBASE_PRIVATE_KEY = prevPk;
    if (prevSa !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = prevSa;
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test('_matchesTenant rejects missing school_code and missing class when requireClass is true', () => {
  const tenant = { schoolCode: 'SC01', schoolName: '가나고', gradeNum: 1, classNum: 4 };
  assert.equal(_matchesTenant({ grade: 1, class_no: 4 }, tenant), false);
  assert.equal(_matchesTenant({ school_code: 'SC01', grade: 1, class_no: 4 }, { ...tenant, requireClass: true }), true);
  assert.equal(_matchesTenant({ school_code: 'SC01' }, { ...tenant, requireClass: true }), false);
  assert.equal(_matchesTenant({ school_code: 'SC01', class_no: 4 }, tenant), false);
  assert.equal(_matchesTenant({ school_code: 'SC01' }, tenant), true);
});

test('upsert_doc_rule, get_pending_registrations, review_registration, get_teacher_profile, and check_timetable_exists enforce school_code scope', async () => {
  const mockDb = createMockDb({
    계정_교사: {
      SC01_admin1: { teacher_id: 'admin1', name: '관리자', grade: 1, class_no: 1, school_code: 'SC01', is_admin: true, status: 'active' },
      SC01_t2: { teacher_id: 't2', name: '동일교교사', grade: 1, class_no: 2, school_code: 'SC01', status: 'active' },
      SC02_t9: { teacher_id: 't9', name: '타학교교사', grade: 1, class_no: 1, school_code: 'SC02', status: 'active' },
      SC01_pending_t: { teacher_id: 'pending_t1', name: '대기1', school_code: 'SC01', status: 'pending' },
      SC02_pending_t: { teacher_id: 'pending_t2', name: '대기2', school_code: 'SC02', status: 'pending' },
    },
    설정_서류규정: {
      SC02_rule_absence: { remote_id: 'SC02_rule_absence', rule_code: 'ABSENCE_REPORT', school_code: 'SC02', title: '타학교규정' },
    },
    시간표_기본: {
      tt_sc02: { school_code: 'SC02', grade: 1, class_no: 1 },
    },
  });

  activeMockDb = mockDb;
  const adminToken = _signSessionToken({ sub: 'admin1', role: 'teacher', school_code: 'SC01', grade: 1, class_no: 1 }).token;

  async function callApi(action, params = {}) {
    const req = { method: 'POST', headers: {}, body: { action, auth_token: adminToken, ...params } };
    const res = makeRes();
    await handler(req, res);
    return res;
  }

  const upsertCross = await callApi('upsert_doc_rule', { remote_id: 'SC02_rule_absence', title: '덮어쓰기시도' });
  assert.equal(upsertCross.statusCode, 403);

  const upsertOwn = await callApi('upsert_doc_rule', { rule_code: 'ABSENCE_REPORT', title: '결석계', due_business_days: 5 });
  assert.equal(upsertOwn.statusCode, 200);
  assert.equal(upsertOwn.body.remote_id, 'SC01_ABSENCE_REPORT');

  const bundleRes = await _handleGetMobileBundle(mockDb, { role: 'teacher', user_id: 'admin1', school_code: 'SC01', grade: 1, class_no: 1, force_refresh: 1 });
  assert.equal(bundleRes.json.doc_rules.length, 1);
  assert.equal(bundleRes.json.doc_rules[0].school_code, 'SC01');

  const pendingRes = await callApi('get_pending_registrations');
  assert.equal(pendingRes.statusCode, 200);
  assert.equal(pendingRes.body.items.length, 1);
  assert.equal(pendingRes.body.items[0].school_code, 'SC01');

  const reviewCross = await callApi('review_registration', { target_role: 'teacher', remote_id: 'SC02_pending_t', decision: 'approve' });
  assert.equal(reviewCross.statusCode, 403);

  const profileCross = await callApi('get_teacher_profile', { teacher_id: 't9' });
  assert.equal(profileCross.statusCode, 403);

  const profileSame = await callApi('get_teacher_profile', { teacher_id: 't2' });
  assert.equal(profileSame.statusCode, 200);
  assert.equal(profileSame.body.profile.teacher_id, 't2');

  const ttCross = await callApi('check_timetable_exists', { school_code: 'SC02' });
  assert.equal(ttCross.statusCode, 403);

  const ttOwn = await callApi('check_timetable_exists', { school_code: 'SC01' });
  assert.equal(ttOwn.statusCode, 200);
  assert.equal(ttOwn.body.exists, false);
});

test('app.js chat listener, notification read_by/ordering, and push metadata fixes', () => {
  const appSrc = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
  const rulesSrc = fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8');

  assert.equal(rulesSrc.includes('isSameSchool()'), true);
  assert.equal(rulesSrc.includes('matchesNotificationTarget()'), true);

  let recordedPushPayload = null;
  let recordedQueries = [];
  const ctx = {
    console,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Set,
    Map,
    Promise,
    navigator: { userAgent: 'TestAgent' },
    Notification: { permission: 'granted' },
    document: {
      getElementById: () => ({ classList: { toggle() {}, add() {}, remove() {}, contains: () => true }, style: {}, innerHTML: '', innerText: '', className: '' }),
      querySelectorAll: () => [],
    },
    window: {
      location: { protocol: 'https:', search: '', hostname: 'example.com' },
      addEventListener() {},
      firebase: {
        apps: [{}],
        firestore: () => ({
          collection(name) {
            const filters = [];
            const q = {
              where(f, op, v) { filters.push([f, op, v]); return q; },
              limit(n) { recordedQueries.push({ name, filters, limit: n }); return q; },
              onSnapshot() { return () => {}; },
              orderBy() { return q; },
            };
            return q;
          },
        }),
      },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    gasApi: {
      isConfigured: () => true,
      async post(action, payload) {
        if (action === 'save_push_subscription') recordedPushPayload = payload;
        return { ok: true };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(appSrc, ctx);
  const mockData = vm.runInContext('mockData', ctx);
  const state = vm.runInContext('state', ctx);

  mockData.currentUser = {
    role: 'teacher',
    userId: 't1',
    neisSchoolCode: 'SC01',
    grade: 1,
    classNo: 4,
  };
  state.activeRole = 'teacher';

  ctx._setChatTabRealtimeActive(true);
  assert.equal(recordedQueries.length, 1);
  assert.equal(recordedQueries[0].name, '1:1_상담채팅');
  assert.deepEqual(recordedQueries[0].filters, [
    ['school_code', '==', 'SC01'],
    ['grade', '==', 1],
    ['class_no', '==', 4],
  ]);

  recordedQueries = [];
  ctx._stopChatListener();
  mockData.currentUser = { role: 'student', userId: 's1', studentId: '', neisSchoolCode: 'SC01' };
  state.activeRole = 'student';
  ctx._setChatTabRealtimeActive(true);
  assert.equal(recordedQueries.length, 0);

  mockData.currentUser = { role: 'student', userId: 's1', studentId: '10401', neisSchoolCode: 'SC01' };
  ctx.hydrateMockDataFromBundle({
    ok: true,
    notifications: [
      { remote_id: 'n_newest', title: '최신', is_read: false, read_by: ['10401'], created_at: '2026-11-26 09:00:00' },
      { remote_id: 'n_older', title: '이전', is_read: false, read_by: [], created_at: '2026-11-25 09:00:00' },
    ],
  });
  assert.equal(mockData.notifications[0].remote_id, 'n_newest');
  assert.equal(ctx._isNotificationRead(mockData.notifications[0]), true);
  assert.equal(ctx._isNotificationRead(mockData.notifications[1]), false);
  assert.equal(ctx._isNotificationRead({ is_read: true }), true);
  assert.equal(ctx._isNotificationRead({ is_read: '1' }), true);

  assert.equal(appSrc.includes("grade: cu.grade ? Number(cu.grade) : null"), true);
  assert.equal(appSrc.includes("class_no: cu.classNo ? Number(cu.classNo) : null"), true);
});

test('teacher->student/parent notifications, mark_chat_read role separation, and push/admin config defaults', async () => {
  const mockDb = createMockDb({
    계정_교사: {
      SC01_t1: { teacher_id: 't1', name: '담임T', grade: 1, class_no: 4, school_code: 'SC01', status: 'active' },
    },
    일일_출결: {
      att_1: { remote_id: 'att_1', student_id: '10401', student_name: '김철수', grade: 1, class_no: 4, school_code: 'SC01', attendance_type: '결석' },
    },
    서류_추적: {
      doc_1: { remote_id: 'doc_1', student_id: '10401', doc_type: '결석계', grade: 1, class_no: 4, school_code: 'SC01', status: 'submitted' },
    },
    '1:1_상담채팅': {
      chat_t1: { remote_id: 'chat_t1', room_id: 'ROOM-10401', student_id: '10401', grade: 1, class_no: 4, school_code: 'SC01', sender_role: 'teacher', is_read: false, read_by: [] },
    },
  });
  activeMockDb = mockDb;

  const teacherToken = _signSessionToken({ sub: 't1', role: 'teacher', school_code: 'SC01', grade: 1, class_no: 4 }).token;
  const studentToken = _signSessionToken({ sub: '10401', sid: '10401', role: 'student', school_code: 'SC01', grade: 1, class_no: 4 }).token;
  const parentToken = _signSessionToken({ sub: 'p_10401', sid: '10401', role: 'parent', school_code: 'SC01', grade: 1, class_no: 4 }).token;

  async function callWithToken(action, token, params = {}) {
    const req = { method: 'POST', headers: {}, body: { action, auth_token: token, ...params } };
    const res = makeRes();
    await handler(req, res);
    return res;
  }

  const r1 = await callWithToken('confirm_attendance', teacherToken, { remote_id: 'att_1' });
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
  const r2 = await callWithToken('confirm_document', teacherToken, { remote_id: 'doc_1', status: 'pending' });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  const r3 = await callWithToken('send_chat_message', teacherToken, { student_id: '10401', sender_role: 'teacher', message: '안녕' });
  assert.equal(r3.statusCode, 200, JSON.stringify(r3.body));
  const r4 = await callWithToken('publish_mobile_notice', teacherToken, { title: '가정통신문', content: '내용' });
  assert.equal(r4.statusCode, 200, JSON.stringify(r4.body));

  const notis = Array.from(mockDb._store.get('Notifications').values());
  assert.equal(notis.some((n) => n.channel === 'attendance_confirm' && n.student_id === '10401'), true);
  assert.equal(notis.some((n) => n.channel === 'doc_confirm' && n.student_id === '10401'), true);
  assert.equal(notis.some((n) => n.channel === 'chat_message' && n.student_id === '10401'), true);
  assert.equal(notis.some((n) => n.channel === 'notice_publish'), true);

  // Student reads teacher chat -> read_by_student=true, is_read still false until parent reads
  assert.equal((await callWithToken('mark_chat_read', studentToken, { room_id: 'ROOM-10401', reader_role: 'student' })).statusCode, 200);
  const afterStu = mockDb._store.get('1:1_상담채팅').get('chat_t1');
  assert.equal(afterStu.read_by_student, true);
  assert.equal(afterStu.is_read, false);

  assert.equal((await callWithToken('mark_chat_read', parentToken, { room_id: 'ROOM-10401', reader_role: 'parent' })).statusCode, 200);
  const afterPar = mockDb._store.get('1:1_상담채팅').get('chat_t1');
  assert.equal(afterPar.read_by_parent, true);
  assert.equal(afterPar.is_read, true);

  const pushSrc = fs.readFileSync(path.resolve(__dirname, '../api/push.js'), 'utf8');
  const adminSrc = fs.readFileSync(path.resolve(__dirname, '../api/_firebaseAdmin.js'), 'utf8');
  assert.equal(pushSrc.includes('.local'), false);
  assert.equal(adminSrc.includes('eduflow-db-b44f3-5692e5dea8c3.json'), false);
});
