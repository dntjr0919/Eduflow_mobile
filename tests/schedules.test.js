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
const { _handleGetMobileBundle, _isPublicAcademicSchedule } = _testHelpers;
const { computeScheduleDday, getUpcomingSchedules } = require('../app.js');

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

test('_handleGetMobileBundle excludes personal/private schedules for student/parent but keeps them for teacher', async () => {
  assert.equal(_isPublicAcademicSchedule({ category: '학사' }), true);
  assert.equal(_isPublicAcademicSchedule({ category: '개인' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: 'personal' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: '비공개' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: '교사' }), false);

  const db = createMockDb({
    '계정_학생': {
      '10401': { student_id: '10401', name: '김철수', grade: 1, class_no: 4, school_code: '8140246', status: 'active' },
    },
    '계정_교사': {
      teacher_1: { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
    'Schedules': {
      s1: { remote_id: 's1', title: '2학기 기말고사', start_date: '2026-12-01', end_date: '2026-12-04', category: '시험', school_code: '8140246' },
      s2: { remote_id: 's2', title: '교내 과학축제', start_date: '2026-11-23', end_date: '2026-11-23', category: '행사', school_code: '8140246' },
      s3_priv: { remote_id: 's3_priv', title: '교사 연수(개인)', start_date: '2026-11-22', category: '개인', school_code: '8140246' },
      s4_personal: { remote_id: 's4_personal', title: '개인 일정', start_date: '2026-11-24', category: 'personal', school_code: '8140246' },
      s5_secret: { remote_id: 's5_secret', title: '학생상담 준비', start_date: '2026-11-25', category: '비공개', school_code: '8140246' },
      s6_teacher: { remote_id: 's6_teacher', title: '교직원 회의', start_date: '2026-11-26', category: '교사', school_code: '8140246' },
    },
  });

  const stuBundle = await _handleGetMobileBundle(db, {
    role: 'student',
    user_id: '10401',
    student_id: '10401',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    force: '1',
  });
  assert.equal(stuBundle.status, 200);
  assert.deepEqual(
    stuBundle.json.schedules.map((s) => s.remote_id),
    ['s2', 's1'] // sorted by start_date ascending, private/personal/비공개/교사 excluded
  );

  const parBundle = await _handleGetMobileBundle(db, {
    role: 'parent',
    user_id: 'p_10401',
    student_id: '10401',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    force: '1',
  });
  assert.equal(parBundle.status, 200);
  assert.deepEqual(parBundle.json.schedules.map((s) => s.remote_id), ['s2', 's1']);

  const teacherBundle = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    force: '1',
  });
  assert.equal(teacherBundle.status, 200);
  assert.equal(teacherBundle.json.schedules.length, 6);
});

test('computeScheduleDday and getUpcomingSchedules compute D-day, ongoing, and 14-day max-5 filtering', () => {
  const today = '2026-11-20';

  assert.deepEqual(computeScheduleDday('2026-11-20', '2026-11-20', today), { label: '오늘', diffDays: 0, isOngoing: true, isPast: false });
  assert.deepEqual(computeScheduleDday('2026-11-23', '2026-11-23', today), { label: 'D-3', diffDays: 3, isOngoing: false, isPast: false });
  assert.deepEqual(computeScheduleDday('2026-11-18', '2026-11-21', today), { label: '진행중', diffDays: 0, isOngoing: true, isPast: false });
  assert.deepEqual(computeScheduleDday('2026-11-10', '2026-11-12', today), { label: '종료', diffDays: -10, isOngoing: false, isPast: true });

  const list = [
    { remote_id: 'past', title: '지난 일정', start_date: '2026-11-15', end_date: '2026-11-15' },
    { remote_id: 'far', title: '먼 일정', start_date: '2026-12-20', end_date: '2026-12-20' },
    { remote_id: 'u6', title: '일정6', start_date: '2026-12-03', end_date: '2026-12-03' },
    { remote_id: 'u2', title: '일정2', start_date: '2026-11-22', end_date: '2026-11-22' },
    { remote_id: 'u1', title: '일정1', start_date: '2026-11-20', end_date: '2026-11-20' },
    { remote_id: 'u4', title: '일정4', start_date: '2026-11-28', end_date: '2026-11-28' },
    { remote_id: 'u3', title: '일정3', start_date: '2026-11-25', end_date: '2026-11-25' },
    { remote_id: 'u5', title: '일정5', start_date: '2026-12-01', end_date: '2026-12-01' },
  ];

  const upcoming = getUpcomingSchedules(list, today, 14, 5);
  assert.equal(upcoming.length, 5);
  assert.deepEqual(upcoming.map((i) => i.remote_id), ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.equal(upcoming[0].dday.label, '오늘');
  assert.equal(upcoming[1].dday.label, 'D-2');
});

test('index.html places academic schedule cards below meal cards in student/teacher homes and includes modal', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const mealStudentIdx = html.indexOf('id="mealContentBox"');
  const schedStudentIdx = html.indexOf('id="homeScheduleCard"');
  const boardStudentIdx = html.indexOf('id="homeBoardNoticeSection"');
  assert.ok(mealStudentIdx !== -1 && schedStudentIdx > mealStudentIdx && schedStudentIdx < boardStudentIdx);

  const mealTeacherIdx = html.indexOf('id="teacherMealCard"');
  const schedTeacherIdx = html.indexOf('id="teacherScheduleCard"');
  assert.ok(mealTeacherIdx !== -1 && schedTeacherIdx > mealTeacherIdx);

  assert.ok(html.includes('id="allSchedulesModal"'));
  assert.ok(html.includes('onclick="openAllSchedulesModal()"'));
});
