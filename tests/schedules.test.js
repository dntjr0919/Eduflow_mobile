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
const { computeScheduleDday, filterSchedulesForRole, getUpcomingSchedules, hydrateMockDataFromBundle, mergeTimetableForDay, mockData } = require('../app.js');

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

test('_handleGetMobileBundle allows only 학사일정/수행평가 for student/parent and keeps 업무/개인 for teacher', async () => {
  assert.equal(_isPublicAcademicSchedule({ category: '학사일정' }), true);
  assert.equal(_isPublicAcademicSchedule({ category: '수행평가' }), true);
  assert.equal(_isPublicAcademicSchedule({ category: '업무' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: '개인' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: 'personal' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: '비공개' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: '교사' }), false);
  assert.equal(_isPublicAcademicSchedule({ category: '학사일정', is_private: true }), false);

  const db = createMockDb({
    '계정_학생': {
      '10401': { student_id: '10401', name: '김철수', grade: 1, class_no: 4, school_code: '8140246', status: 'active' },
    },
    '계정_교사': {
      teacher_1: { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
    'Schedules': {
      s1: { remote_id: 's1', title: '2학기 기말고사', start_date: '2026-12-01', end_date: '2026-12-04', category: '학사일정', school_code: '8140246' },
      s2: { remote_id: 's2', title: '국어 수행평가', start_date: '2026-11-23', end_date: '2026-11-23', category: '수행평가', school_code: '8140246' },
      s3_work: { remote_id: 's3_work', title: '나이스 마감 처리', start_date: '2026-11-21', category: '업무', school_code: '8140246' },
      s4_priv: { remote_id: 's4_priv', title: '교사 연수(개인)', start_date: '2026-11-22', category: '개인', school_code: '8140246' },
      s5_personal: { remote_id: 's5_personal', title: '개인 일정', start_date: '2026-11-24', category: 'personal', school_code: '8140246' },
      s6_secret: { remote_id: 's6_secret', title: '학생상담 준비', start_date: '2026-11-25', category: '비공개', school_code: '8140246' },
      s7_teacher: { remote_id: 's7_teacher', title: '교직원 회의', start_date: '2026-11-26', category: '교사', school_code: '8140246' },
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
    ['s2', 's1'] // sorted by start_date ascending, only 학사일정 & 수행평가
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
  assert.equal(teacherBundle.json.schedules.length, 7);
});

test('filterSchedulesForRole & hydrateMockDataFromBundle keep only 학사일정 and 수행평가 for student/parent when mixed with 업무 and 개인', () => {
  const mixed = [
    { remote_id: 'sc_academic', title: '개교기념일', start_date: '2026-11-21', category: '학사일정' },
    { remote_id: 'sc_perf', title: '영어 말하기 수행평가', start_date: '2026-11-22', category: '수행평가' },
    { remote_id: 'sc_work', title: '공문 제출 마감', start_date: '2026-11-23', category: '업무' },
    { remote_id: 'sc_personal', title: '치과 예약', start_date: '2026-11-24', category: '개인' },
  ];

  const studentFiltered = filterSchedulesForRole(mixed, 'student');
  assert.deepEqual(studentFiltered.map((s) => s.category), ['학사일정', '수행평가']);
  assert.deepEqual(studentFiltered.map((s) => s.remote_id), ['sc_academic', 'sc_perf']);

  const parentFiltered = filterSchedulesForRole(mixed, 'parent');
  assert.deepEqual(parentFiltered.map((s) => s.category), ['학사일정', '수행평가']);

  const teacherFiltered = filterSchedulesForRole(mixed, 'teacher');
  assert.equal(teacherFiltered.length, 4);

  hydrateMockDataFromBundle({
    ok: true,
    user: { role: 'student', student_id: '10401', name: '김철수', grade: 1, class_no: 4 },
    schedules: mixed,
  });
  assert.deepEqual(mockData.schedules.map((s) => s.category), ['학사일정', '수행평가']);

  hydrateMockDataFromBundle({
    ok: true,
    user: { role: 'teacher', teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4 },
    schedules: mixed,
  });
  assert.equal(mockData.schedules.length, 4);
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

test('mergeTimetableForDay preserves empty string changed_subject ("") as deleted/free period in class and teacher modes', () => {
  const baseRows = [
    {
      remote_id: 'tb_c_1_5_월_3',
      entry_type: 'class',
      grade: '1',
      class_no: '5',
      day_of_week: '월',
      period: '3',
      subject: '자율',
      teacher_name: '김교사',
    },
    {
      remote_id: 'tb_c_1_5_월_4',
      entry_type: 'class',
      grade: '1',
      class_no: '5',
      day_of_week: '월',
      period: '4',
      subject: '수학',
      teacher_name: '이교사',
    },
    {
      remote_id: 'tb_t_김교사_월_3',
      entry_type: 'teacher',
      grade: '1',
      class_no: '5',
      day_of_week: '월',
      period: '3',
      subject: '자율',
      teacher_name: '김교사',
    },
  ];
  const changeRows = [
    {
      remote_id: 'tc_20261116_1_5_3',
      date: '2026-11-16',
      grade: '1',
      class_no: '5',
      period: '3',
      original_subject: '자율',
      changed_subject: '',
      original_teacher: '김교사',
      changed_teacher: '',
    },
  ];

  const classMerged = mergeTimetableForDay(baseRows, changeRows, {
    mode: 'class',
    grade: '1',
    classNo: '5',
    dayChar: '월',
    targetDate: '2026-11-16',
  });
  assert.equal(classMerged.length, 2);
  const p3Class = classMerged.find((r) => Number(r.period) === 3);
  assert.equal(p3Class.isChanged, true);
  assert.equal(p3Class.subject, '');
  assert.equal(p3Class.teacher, '');
  assert.equal(p3Class.original, '자율');
  const p4Class = classMerged.find((r) => Number(r.period) === 4);
  assert.equal(p4Class.isChanged, false);
  assert.equal(p4Class.subject, '수학');

  const teacherMerged = mergeTimetableForDay(baseRows, changeRows, {
    mode: 'teacher',
    teacherName: '김교사',
    dayChar: '월',
    targetDate: '2026-11-16',
  });
  assert.equal(teacherMerged.length, 1);
  assert.equal(teacherMerged[0].changed, true);
  assert.equal(teacherMerged[0].subject, '');
  assert.equal(teacherMerged[0].target, '');
});

test('mergeTimetableForDay uses date snapshot as Single Source of Truth, ignores legacy comcigan changes, and overlays manual changes', () => {
  const baseRows = [
    { remote_id: 'tb_c_1_5_월_1', entry_type: 'class', grade: '1', class_no: '5', day_of_week: '월', period: '1', subject: '국어', teacher_name: '김교사' },
    { remote_id: 'tb_c_1_5_월_7', entry_type: 'class', grade: '1', class_no: '5', day_of_week: '월', period: '7', subject: '옛보강', teacher_name: '유우석' },
    { remote_id: 'tb_t_유우석_월_1', entry_type: 'teacher', grade: '1', class_no: '5', day_of_week: '월', period: '1', subject: '정보', teacher_name: '유우석' },
    { remote_id: 'tb_t_유우석_월_7', entry_type: 'teacher', grade: '1', class_no: '5', day_of_week: '월', period: '7', subject: '옛보강', teacher_name: '유우석' },
  ];
  const changeRows = [
    // 과거 컴시간 찌꺼기 문서 -> 스냅샷이 존재하는 날짜에서는 무시되어야 함
    { remote_id: 'tc_20261123_1_5_7', date: '2026-11-23', grade: '1', class_no: '5', period: '7', changed_subject: '찌꺼기보강', changed_teacher: '유우석', source: 'comcigan' },
    // 교사 수동 변동 -> 스냅샷 위에 마지막으로 오버레이되어야 함
    { remote_id: 'manual_20261123_1_5_2', date: '2026-11-23', grade: '1', class_no: '5', period: '2', original_subject: '수학', changed_subject: '수동자습', changed_teacher: '박교사', reason: '교사 수동 입력', source: 'manual' },
  ];
  const snapshots = [
    {
      remote_id: 'snap_8140246_20261123',
      date: '2026-11-23',
      classes: {
        '1-5': {
          '1': { period: 1, subject: '', teacher_name: '', is_changed: true }, // 1교시 수업 삭제/공강
          '2': { period: 2, subject: '수학', teacher_name: '이교사', is_changed: false },
          '7': { period: 7, subject: '', teacher_name: '', is_changed: false }, // 7교시 보강 취소(빈 슬롯)
        },
      },
      teachers: {
        '유우석': {
          '1': { period: 1, grade: '', class_no: '', subject: '', teacher_name: '유우석', is_changed: true },
          '2': { period: 2, grade: '1', class_no: '3', subject: '정보', teacher_name: '유우석', is_changed: false },
          '7': { period: 7, grade: '', class_no: '', subject: '', teacher_name: '유우석', is_changed: false },
        },
      },
    },
  ];

  // 1) 학급 시간표: 1교시 공강([변경]), 2교시 수동자습([변경]), 7교시 취소된 보강은 제거됨
  const classRes = mergeTimetableForDay(baseRows, changeRows, {
    mode: 'class',
    grade: '1',
    classNo: '5',
    dayChar: '월',
    targetDate: '2026-11-23',
    snapshots,
  });
  assert.equal(classRes.length, 2);
  const p1 = classRes.find((r) => Number(r.period) === 1);
  assert.equal(p1.subject, '');
  assert.equal(p1.isChanged, true);
  const p2 = classRes.find((r) => Number(r.period) === 2);
  assert.equal(p2.subject, '수동자습');
  assert.equal(p2.teacher, '박교사');
  assert.equal(p2.isChanged, true);
  assert.equal(classRes.some((r) => Number(r.period) === 7), false);

  // 2) 교사 시간표: 1교시 공강([변경]), 2교시 정보, 7교시 취소된 보강은 제거됨
  const teacherRes = mergeTimetableForDay(baseRows, changeRows, {
    mode: 'teacher',
    teacherName: '유우석',
    dayChar: '월',
    targetDate: '2026-11-23',
    snapshots,
  });
  assert.equal(teacherRes.length, 2);
  assert.equal(teacherRes[0].period, '1교시');
  assert.equal(teacherRes[0].subject, '');
  assert.equal(teacherRes[0].changed, true);
  assert.equal(teacherRes[1].period, '2교시');
  assert.equal(teacherRes[1].subject, '정보');
  assert.equal(teacherRes[1].changed, false);

  // 3) 스냅샷이 없는 날짜는 기존 시간표_기본 폴백 동작
  const fallbackRes = mergeTimetableForDay(baseRows, [], {
    mode: 'class',
    grade: '1',
    classNo: '5',
    dayChar: '월',
    targetDate: '2026-11-24',
    snapshots,
  });
  assert.equal(fallbackRes.length, 2);
  assert.equal(fallbackRes[0].subject, '국어');
});

test('sync_timetable_snapshots overwrites snapshot docs and cleans up legacy comcigan changes while preserving manual changes', async () => {
  const { _testHelpers } = require('../api/firestore');
  const { _handleDesktopApiAction } = _testHelpers;
  const store = new Map();
  const makeCol = (colName) => {
    if (!store.has(colName)) store.set(colName, new Map());
    return store.get(colName);
  };
  makeCol('시간표_변동').set('tc_20261123_1_5_7', {
    remote_id: 'tc_20261123_1_5_7',
    date: '2026-11-23',
    school_code: '8140246',
    source: 'comcigan',
    changed_subject: '찌꺼기',
  });
  makeCol('시간표_변동').set('manual_20261123_1_5_2', {
    remote_id: 'manual_20261123_1_5_2',
    date: '2026-11-23',
    school_code: '8140246',
    source: 'manual',
    changed_subject: '수동자습',
  });
  makeCol('시간표_스냅샷').set('snap_8140246_20261123', {
    remote_id: 'snap_8140246_20261123',
    date: '2026-11-23',
    school_code: '8140246',
    stale_field: 'should_be_overwritten',
  });

  const db = {
    collection(name) {
      const col = makeCol(name);
      return {
        doc: (id) => ({ _col: name, _id: id }),
        where(field, op, val) {
          return {
            async get() {
              const docs = [];
              for (const [id, data] of col.entries()) {
                if (op === '==' && data[field] === val) {
                  docs.push({ id, data: () => ({ ...data }) });
                }
              }
              return { empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
            },
          };
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) { ops.push({ type: 'set', ref, data }); },
        delete(ref) { ops.push({ type: 'delete', ref }); },
        async commit() {
          for (const op of ops) {
            const col = makeCol(op.ref._col);
            if (op.type === 'set') col.set(op.ref._id, { ...op.data });
            else if (op.type === 'delete') col.delete(op.ref._id);
          }
        },
      };
    },
  };

  const res = await _handleDesktopApiAction(
    db,
    'sync_timetable_snapshots',
    {
      school_code: '8140246',
      snapshots: [
        {
          remote_id: 'snap_8140246_20261123',
          date: '2026-11-23',
          school_code: '8140246',
          classes: { '1-5': { '1': { period: 1, subject: '', teacher_name: '', is_changed: true } } },
          teachers: {},
        },
      ],
    },
    { schoolCode: '8140246', schoolName: '천안오성고' }
  );

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.snapshots_written, 1);
  assert.equal(res.json.change_deleted, 1);

  const savedSnap = makeCol('시간표_스냅샷').get('snap_8140246_20261123');
  assert.equal(savedSnap.stale_field, undefined);
  assert.equal(savedSnap.classes['1-5']['1'].is_changed, true);
  assert.equal(makeCol('시간표_변동').has('tc_20261123_1_5_7'), false);
  assert.equal(makeCol('시간표_변동').has('manual_20261123_1_5_2'), true);
});
