const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const firebaseAdminPath = path.resolve(__dirname, '../api/_firebaseAdmin.js');
require.cache[firebaseAdminPath] = {
  id: firebaseAdminPath,
  filename: firebaseAdminPath,
  loaded: true,
  exports: {
    getFirestore: () => {
      throw new Error('Mock db should be passed directly');
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

const { _testHelpers } = require('../api/firestore.js');
const { _handleDesktopApiAction } = _testHelpers;
const { resolvePwaPushGateDecision } = require('../app.js');

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

  function makeSnap(docId, data) {
    return {
      id: docId,
      exists: data !== undefined,
      data: () => (data ? { ...data } : undefined),
    };
  }

  function makeQuery(colName, filters = [], maxLimit = Infinity) {
    return {
      where(field, op, val) {
        return makeQuery(colName, [...filters, { field, op, val }], maxLimit);
      },
      limit(n) {
        return makeQuery(colName, filters, n);
      },
      async get() {
        const colMap = getColMap(colName);
        const matched = [];
        for (const [id, data] of colMap.entries()) {
          let ok = true;
          for (const f of filters) {
            const v = data[f.field];
            if (f.op === '==' && v !== f.val) ok = false;
            else if (f.op === 'in' && (!Array.isArray(f.val) || !f.val.includes(v))) ok = false;
            else if (f.op === '!=' && v === f.val) ok = false;
          }
          if (ok) matched.push(makeSnap(id, data));
          if (matched.length >= maxLimit) break;
        }
        return {
          empty: matched.length === 0,
          docs: matched,
          forEach(cb) { matched.forEach(cb); },
        };
      },
    };
  }

  return {
    _store: store,
    collection(colName) {
      return {
        doc(docId) {
          return {
            async get() {
              const colMap = getColMap(colName);
              return makeSnap(docId, colMap.get(docId));
            },
            async set(data, opts = {}) {
              const colMap = getColMap(colName);
              if (opts.merge && colMap.has(docId)) {
                colMap.set(docId, { ...colMap.get(docId), ...data });
              } else {
                colMap.set(docId, { ...data });
              }
            },
          };
        },
        where(field, op, val) {
          return makeQuery(colName, [{ field, op, val }]);
        },
        limit(n) {
          return makeQuery(colName, [], n);
        },
      };
    },
  };
}

const teacherAuth = {
  teacherId: 'teacher_1',
  schoolCode: '8140246',
  schoolName: '테스트고등학교',
  gradeNum: 1,
  classNum: 4,
  isAdmin: false,
  teacherDoc: { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
};

test('resolvePwaPushGateDecision handles default prompt, iOS Safari non-standalone, granted, and denied', () => {
  // Not logged in -> hide_all
  assert.deepEqual(
    resolvePwaPushGateDecision({
      isLoggedIn: false,
      hasNotificationApi: true,
      permission: 'default',
      platform: 'android',
      isStandalone: true,
      role: 'student',
      guideDismissed: false,
    }),
    { action: 'hide_all', shouldOpenModal: false, showBanner: false, emphasize: false }
  );

  // iOS Safari browser tab (even without Notification API) -> show_ios_install & opens modal
  assert.deepEqual(
    resolvePwaPushGateDecision({
      isLoggedIn: true,
      hasNotificationApi: false,
      permission: 'unsupported',
      platform: 'ios',
      isStandalone: false,
      role: 'student',
      guideDismissed: false,
    }),
    { action: 'show_ios_install', shouldOpenModal: true, showBanner: true, emphasize: true }
  );

  // iOS Safari after user clicks "나중에 하기" -> modal stays closed, banner remains
  assert.deepEqual(
    resolvePwaPushGateDecision({
      isLoggedIn: true,
      hasNotificationApi: false,
      permission: 'unsupported',
      platform: 'ios',
      isStandalone: false,
      role: 'parent',
      guideDismissed: true,
    }),
    { action: 'show_ios_install', shouldOpenModal: false, showBanner: true, emphasize: true }
  );

  // Student with Notification.permission === 'default' right after login -> auto-opens emphasized modal
  assert.deepEqual(
    resolvePwaPushGateDecision({
      isLoggedIn: true,
      hasNotificationApi: true,
      permission: 'default',
      platform: 'android',
      isStandalone: true,
      role: 'student',
      guideDismissed: false,
    }),
    { action: 'default_prompt', shouldOpenModal: true, showBanner: true, emphasize: true }
  );

  // Teacher with permission === 'default' -> opens modal without student emphasis
  assert.deepEqual(
    resolvePwaPushGateDecision({
      isLoggedIn: true,
      hasNotificationApi: true,
      permission: 'default',
      platform: 'desktop',
      isStandalone: false,
      role: 'teacher',
      guideDismissed: false,
    }),
    { action: 'default_prompt', shouldOpenModal: true, showBanner: true, emphasize: false }
  );

  // Granted -> granted_sync
  assert.deepEqual(
    resolvePwaPushGateDecision({
      isLoggedIn: true,
      hasNotificationApi: true,
      permission: 'granted',
      platform: 'ios',
      isStandalone: true,
      role: 'student',
      guideDismissed: false,
    }),
    { action: 'granted_sync', shouldOpenModal: false, showBanner: false, emphasize: false }
  );

  // Denied -> denied_prompt
  assert.deepEqual(
    resolvePwaPushGateDecision({
      isLoggedIn: true,
      hasNotificationApi: true,
      permission: 'denied',
      platform: 'android',
      isStandalone: true,
      role: 'parent',
      guideDismissed: false,
      openGuideOnDenied: true,
    }),
    { action: 'denied_prompt', shouldOpenModal: true, showBanner: true, emphasize: true }
  );
});

test('admin_get_class_overview maps Push_Subscriptions to push_enabled and push_subscribed_user_ids', async () => {
  const db = createMockDb({
    '계정_학생': {
      '10401': { student_id: '10401', name: '김철수', student_no: 1, grade: 1, class_no: 4, school_code: '8140246', status: 'active' },
      '10402': { student_id: '10402', custom_id: 'younghee02', name: '이영희', student_no: 2, grade: 1, class_no: 4, school_code: '8140246', status: 'active' },
      '10403': { student_id: '10403', name: '박민수', student_no: 3, grade: 1, class_no: 4, school_code: '8140246', status: 'active' },
    },
    '계정_학부모': {
      'p_10401': { parent_id: 'p_10401', student_id: '10401', name: '김부모', grade: 1, class_no: 4, school_code: '8140246', status: 'active' },
      'p_10403': { parent_id: 'p_10403', student_id: '10403', name: '박부모', grade: 1, class_no: 4, school_code: '8140246', status: 'active' },
    },
    'Push_Subscriptions': {
      sub1: { role: 'student', user_id: '10401', student_id: '10401', grade: 1, class_no: 4 },
      sub2: { role: 'student', user_id: 'younghee02', student_id: '10402', grade: 1, class_no: 4 },
      sub3: { role: 'parent', user_id: 'p_10403', student_id: '10403', grade: 1, class_no: 4 },
      sub_other_class: { role: 'student', user_id: '10501', student_id: '10501', grade: 1, class_no: 5 },
      sub_teacher: { role: 'teacher', user_id: 'teacher_1', student_id: '', grade: 1, class_no: 4 },
    },
  });

  const res = await _handleDesktopApiAction(db, 'admin_get_class_overview', {}, teacherAuth);
  assert.equal(res.status, 200);
  assert.equal(res.json.students.length, 3);

  const s1 = res.json.students.find((s) => s.student_id === '10401');
  const s2 = res.json.students.find((s) => s.student_id === '10402');
  const s3 = res.json.students.find((s) => s.student_id === '10403');
  assert.equal(s1.push_enabled, true);
  assert.equal(s2.push_enabled, true);
  assert.equal(s3.push_enabled, false);

  const p1 = res.json.parents.find((p) => p.parent_id === 'p_10401');
  const p3 = res.json.parents.find((p) => p.parent_id === 'p_10403');
  assert.equal(p1.push_enabled, false);
  assert.equal(p3.push_enabled, true);

  assert.ok(res.json.push_subscribed_user_ids.includes('10401'));
  assert.ok(res.json.push_subscribed_user_ids.includes('younghee02'));
  assert.ok(res.json.push_subscribed_user_ids.includes('p_10403'));
  assert.equal(res.json.push_subscribed_user_ids.includes('10501'), false);
});

test('index.html and admin/index.html include push onboarding and roster push status UI', () => {
  const mobileHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(mobileHtml.includes('id="pwaPushIosGuide"'));
  assert.ok(mobileHtml.includes('홈 화면에 추가'));
  assert.ok(mobileHtml.includes('알림 허용하고 시작하기'));

  const adminHtml = fs.readFileSync(path.resolve(__dirname, '../admin/index.html'), 'utf8');
  assert.ok(adminHtml.includes('id="kpi-roster-push"'));
  assert.ok(adminHtml.includes('알림 수신'));
});
