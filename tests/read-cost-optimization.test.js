const test = require('node:test');
const assert = require('node:assert/strict');
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
const { _handleGetMobileBundle, _handleDesktopApiAction, _kstDateStr } = _testHelpers;
const {
  _startRealtimeListeners,
  _stopRealtimeListeners,
  _setChatTabRealtimeActive,
  _getRealtimeListenerState,
  mockData,
} = require('../app.js');

function createTrackedDb(initialCollections = {}, options = {}) {
  const store = new Map();
  const readCounts = {};
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
        if (options.throwIndexOn && options.throwIndexOn(colName, filters)) {
          const err = new Error('9 FAILED_PRECONDITION: The query requires an index.');
          err.code = 9;
          throw err;
        }
        readCounts[colName] = (readCounts[colName] || 0) + 1;
        const colMap = getColMap(colName);
        const matched = [];
        for (const [id, data] of colMap.entries()) {
          let ok = true;
          for (const f of filters) {
            const v = data[f.field];
            if (f.op === '==' && v !== f.val) ok = false;
            else if (f.op === 'in' && (!Array.isArray(f.val) || !f.val.includes(v))) ok = false;
            else if (f.op === '>=' && !(String(v || '') >= String(f.val))) ok = false;
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
    _readCounts: readCounts,
    collection(colName) {
      return {
        doc(docId) {
          return {
            async get() {
              readCounts[colName] = (readCounts[colName] || 0) + 1;
              return makeSnap(docId, getColMap(colName).get(docId));
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

test('_handleGetMobileBundle skips 시간표_기본 reads when today 시간표_스냅샷 exists for tenant', async () => {
  const todayStr = _kstDateStr();
  const db = createTrackedDb({
    '계정_교사': {
      teacher_1: { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
    '시간표_스냅샷': {
      [`snap_8140246_${todayStr.replace(/-/g, '')}`]: {
        remote_id: `snap_8140246_${todayStr.replace(/-/g, '')}`,
        date: todayStr,
        school_code: '8140246',
        classes: { '1-4': { '1': { period: 1, subject: '국어', teacher_name: '김교사' } } },
        teachers: { '김교사': { '1': { period: 1, subject: '국어', class_label: '1-4' } } },
      },
    },
    '시간표_기본': {
      tt1: { remote_id: 'tt1', grade: 1, class_no: 4, school_code: '8140246', subject: '수학', teacher_name: '김교사' },
    },
  });

  const res = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    teacher_name: '김교사',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    force: '1',
  });

  assert.equal(res.status, 200);
  assert.equal(db._readCounts['시간표_스냅샷'], 1);
  assert.equal(db._readCounts['시간표_기본'] || 0, 0);
  assert.equal(res.json.timetable_snapshots.length, 1);
});

test('app.js _startRealtimeListeners guards against duplicate re-subscription and activates chat listener only on chat tab', (t) => {
  const prevWindow = global.window;
  const prevUser = { ...mockData.currentUser };
  t.after(() => {
    _stopRealtimeListeners();
    global.window = prevWindow;
    mockData.currentUser = prevUser;
  });

  const subscriptions = [];
  const unsubCalls = [];
  const makeQueryObj = (col, filters = []) => ({
    where(field, op, val) {
      return makeQueryObj(col, [...filters, { field, op, val }]);
    },
    limit(n) {
      return makeQueryObj(col, [...filters, { limit: n }]);
    },
    onSnapshot(cb) {
      const idx = subscriptions.length;
      subscriptions.push({ col, filters, cb });
      return () => unsubCalls.push({ idx, col });
    },
  });

  global.window = {
    firebase: {
      apps: [{}],
      firestore: () => ({
        collection: (col) => makeQueryObj(col),
      }),
    },
  };

  mockData.currentUser = {
    role: 'student',
    userId: '10401',
    studentId: '10401',
    grade: '1',
    classNo: '4',
    neisSchoolCode: '8140246',
  };

  // Initial refreshFromGas -> starts Notifications only (scoped by school_code), NOT chat
  _startRealtimeListeners();
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].col, 'Notifications');
  assert.ok(subscriptions[0].filters.some((f) => f.field === 'school_code' && f.val === '8140246'));
  assert.equal(_getRealtimeListenerState().hasNoti, true);
  assert.equal(_getRealtimeListenerState().hasChat, false);

  // Calling _startRealtimeListeners again with same scope does NOT re-subscribe
  _startRealtimeListeners();
  assert.equal(subscriptions.length, 1);
  assert.equal(unsubCalls.length, 0);

  // Entering chat tab activates 1:1_상담채팅 listener
  _setChatTabRealtimeActive(true);
  assert.equal(subscriptions.length, 2);
  assert.equal(subscriptions[1].col, '1:1_상담채팅');
  assert.equal(_getRealtimeListenerState().hasChat, true);

  // Leaving chat tab unsubscribes 1:1_상담채팅 listener
  _setChatTabRealtimeActive(false);
  assert.equal(_getRealtimeListenerState().hasChat, false);
  assert.ok(unsubCalls.some((u) => u.col === '1:1_상담채팅'));
});

test('fetch_pending_remote_tasks queries active exec_status and falls back safely if composite index is missing', async () => {
  const tasksData = {
    t_pending: { remote_id: 't_pending', teacher_id: 'teacher_1', is_mobile_task: true, exec_status: 'pending' },
    t_done: { remote_id: 't_done', teacher_id: 'teacher_1', is_mobile_task: true, exec_status: 'done' },
  };

  // 1) With composite index available: filters by exec_status in ['pending', 'queued', 'running']
  const indexedDb = createTrackedDb({ Tasks: tasksData });
  const res1 = await _handleDesktopApiAction(indexedDb, 'fetch_pending_remote_tasks', {}, { teacherId: 'teacher_1' });
  assert.equal(res1.status, 200);
  assert.deepEqual(res1.json.tasks.map((x) => x.remote_id), ['t_pending']);

  // 2) Without composite index (simulated FAILED_PRECONDITION code 9): falls back cleanly without throwing
  const noIndexDb = createTrackedDb(
    { Tasks: tasksData },
    {
      throwIndexOn: (col, filters) =>
        col === 'Tasks' && filters.some((f) => f.field === 'exec_status'),
    }
  );
  const res2 = await _handleDesktopApiAction(noIndexDb, 'fetch_pending_remote_tasks', {}, { teacherId: 'teacher_1' });
  assert.equal(res2.status, 200);
  assert.deepEqual(res2.json.tasks.map((x) => x.remote_id), ['t_pending']);
});

test('_handleGetMobileBundle fetches 100% of today attendance and unconfirmed records even when 50+ past docs exist', async () => {
  const todayStr = _kstDateStr();
  const attendanceDocs = {};
  for (let i = 1; i <= 50; i += 1) {
    const sid = `104${String(i).padStart(2, '0')}`;
    attendanceDocs[`att_20261101_${sid}`] = {
      remote_id: `att_20261101_${sid}`,
      date: '2026-11-01',
      student_id: sid,
      grade: 1,
      class_no: 4,
      school_code: '8140246',
      attendance_type: '출석',
      teacher_confirmed: true,
    };
  }
  attendanceDocs.att_unconfirmed_old = {
    remote_id: 'att_unconfirmed_old',
    date: '2026-11-10',
    student_id: '10401',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    attendance_type: '결석',
    teacher_confirmed: false,
  };
  attendanceDocs.att_today_1 = {
    remote_id: 'att_today_1',
    date: todayStr,
    student_id: '10402',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    attendance_type: '지각',
    teacher_confirmed: true,
  };
  attendanceDocs.att_today_2 = {
    remote_id: 'att_today_2',
    date: todayStr,
    student_id: '10403',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    attendance_type: '출석',
    teacher_confirmed: true,
  };

  const db = createTrackedDb({
    '계정_교사': {
      teacher_1: { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
    '일일_출결': attendanceDocs,
  });

  const res = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    force: '1',
  });

  assert.equal(res.status, 200);
  const returnedIds = new Set(res.json.attendance.map((a) => a.remote_id));
  assert.equal(returnedIds.has('att_unconfirmed_old'), true);
  assert.equal(returnedIds.has('att_today_1'), true);
  assert.equal(returnedIds.has('att_today_2'), true);
  assert.equal(returnedIds.size, 3);
});
