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
    orderBy(field, dir) {
      return makeQueryObj(col, [...filters, { orderBy: field, dir }]);
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

  // Initial refreshFromGas -> starts Notifications only (personal + class scoped), NOT chat
  _startRealtimeListeners();
  assert.equal(subscriptions.length, 2);
  assert.equal(subscriptions[0].col, 'Notifications');
  assert.ok(subscriptions[0].filters.some((f) => f.field === 'school_code' && f.val === '8140246'));
  assert.equal(_getRealtimeListenerState().hasNoti, true);
  assert.equal(_getRealtimeListenerState().hasChat, false);

  // Calling _startRealtimeListeners again with same scope does NOT re-subscribe
  _startRealtimeListeners();
  assert.equal(subscriptions.length, 2);
  assert.equal(unsubCalls.length, 0);

  // Entering chat tab activates 1:1_상담채팅 listener
  _setChatTabRealtimeActive(true);
  assert.equal(subscriptions.length, 3);
  assert.equal(subscriptions[2].col, '1:1_상담채팅');
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

test('_handleGetMobileBundle force_refresh=1 bypasses _staticCache and admin writes invalidate it immediately', async () => {
  if (globalThis.__eduflowStaticCache) globalThis.__eduflowStaticCache.clear();
  const store = new Map();
  function getCol(name) {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  }
  getCol('계정_교사').set('teacher_1', { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246', status: 'active' });
  getCol('계정_학생').set('8140246_10401', { remote_id: '8140246_10401', student_id: '10401', name: '기존학생', grade: 1, class_no: 4, school_code: '8140246' });
  getCol('Schedules').set('s1', { remote_id: 's1', title: '기존일정', start_date: '2026-11-25', category: '학사일정', school_code: '8140246', teacher_id: 'teacher_1' });

  const makeSnap = (id, data) => ({ id, exists: data !== undefined, data: () => (data ? { ...data } : undefined) });
  const makeQuery = (colName, filters = [], maxLimit = Infinity) => ({
    where(field, op, val) { return makeQuery(colName, [...filters, { field, op, val }], maxLimit); },
    limit(n) { return makeQuery(colName, filters, n); },
    async get() {
      const matched = [];
      for (const [id, data] of getCol(colName).entries()) {
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
      return { empty: matched.length === 0, docs: matched, forEach(cb) { matched.forEach(cb); } };
    },
  });
  const db = {
    collection(colName) {
      return {
        doc(docId) {
          return {
            id: docId,
            async get() { return makeSnap(docId, getCol(colName).get(docId)); },
            async set(data, opts = {}) {
              if (opts.merge && getCol(colName).has(docId)) getCol(colName).set(docId, { ...getCol(colName).get(docId), ...data });
              else getCol(colName).set(docId, { ...data });
            },
          };
        },
        where(field, op, val) { return makeQuery(colName, [{ field, op, val }]); },
        limit(n) { return makeQuery(colName, [], n); },
      };
    },
  };

  // 1) Initial load populates _staticCache
  const initial = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
  });
  assert.equal(initial.json.students.length, 1);
  assert.equal(initial.json.schedules.length, 1);

  // 2) Direct DB mutation without invalidation -> skip_static=0 still hits server cache, but force_refresh=1 bypasses it
  getCol('계정_학생').set('8140246_10499', { remote_id: '8140246_10499', student_id: '10499', name: '전학생A', grade: 1, class_no: 4, school_code: '8140246' });
  const cachedRes = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    skip_static: '0',
  });
  assert.equal(cachedRes.json.students.length, 1);

  const forcedRes = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    skip_static: '0',
    force_refresh: '1',
  });
  assert.equal(forcedRes.json.students.length, 2);
  assert.ok(forcedRes.json.students.some((s) => s.student_id === '10499'));

  // 3) Admin write actions invalidate _staticCache immediately so normal skip_static=0 load sees new data
  const auth = { teacherId: 'teacher_1', schoolCode: '8140246', schoolName: '', gradeNum: 1, classNum: 4, isAdmin: true };
  await _handleDesktopApiAction(db, 'admin_upsert_roster_student', { student_id: '10498', name: '전학생B', student_no: 98 }, auth);
  await _handleDesktopApiAction(db, 'upsert_schedule', { title: '신규일정', start_date: '2026-11-28' }, auth);

  const afterWrite = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    skip_static: '0',
  });
  assert.equal(afterWrite.json.students.length, 3);
  assert.equal(afterWrite.json.schedules.length, 2);
});

test('_handleGetMobileBundle fetches pending/submitted doc_tracking even when 50+ closed docs exist', async () => {
  const docTracking = {};
  for (let i = 1; i <= 50; i += 1) {
    docTracking[`doc_closed_${String(i).padStart(2, '0')}`] = {
      remote_id: `doc_closed_${String(i).padStart(2, '0')}`,
      student_id: `104${String((i % 30) + 1).padStart(2, '0')}`,
      grade: 1,
      class_no: 4,
      school_code: '8140246',
      status: 'closed',
      teacher_confirmed: true,
    };
  }
  docTracking.doc_pending_new = {
    remote_id: 'doc_pending_new',
    student_id: '10401',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    status: 'pending',
    teacher_confirmed: false,
  };
  docTracking.doc_submitted_new = {
    remote_id: 'doc_submitted_new',
    student_id: '10402',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    status: 'submitted',
    teacher_confirmed: false,
  };

  const db = createTrackedDb({
    '계정_교사': {
      teacher_1: { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
    '서류_추적': docTracking,
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
  const ids = new Set(res.json.doc_tracking.map((d) => d.remote_id));
  assert.equal(ids.has('doc_pending_new'), true);
  assert.equal(ids.has('doc_submitted_new'), true);
});

test('chat tab switch stays on chat/counseling view when onSnapshot triggers hydrateMockDataFromBundle -> applyRoleUI', (t) => {
  const prevWindow = global.window;
  const prevDocument = global.document;
  const prevUser = { ...mockData.currentUser };
  const prevRole = require('../app.js').state.activeRole;

  function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
      add(...cls) { cls.forEach((c) => set.add(c)); },
      remove(...cls) { cls.forEach((c) => set.delete(c)); },
      contains(c) { return set.has(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (set.has(c)) set.delete(c); else set.add(c);
        } else if (force) set.add(c); else set.delete(c);
      },
    };
  }
  function makeMockNode(initialClasses = []) {
    return {
      className: '',
      innerText: '',
      innerHTML: '',
      textContent: '',
      classList: makeClassList(initialClasses),
      querySelector() { return { className: '' }; },
    };
  }

  const domMap = new Map();
  for (const tId of ['home', 'attendance', 'letters', 'counseling']) {
    domMap.set(`tabView-${tId}`, makeMockNode(tId === 'home' ? [] : ['hidden']));
    domMap.set(`tabNav-${tId}`, makeMockNode());
  }
  for (const tId of ['home', 'documents', 'circulars', 'remote', 'chat']) {
    domMap.set(`teacherTabView-${tId}`, makeMockNode(['hidden']));
    domMap.set(`tTabNav-${tId}`, makeMockNode());
  }
  domMap.set('studentBottomNav', makeMockNode());
  domMap.set('teacherBottomNav', makeMockNode(['hidden']));
  domMap.set('counselingCtaBanner', makeMockNode(['hidden']));
  domMap.set('chatMessagesContainer', makeMockNode());
  domMap.set('teacherChatSearch', { value: '' });
  domMap.set('teacherChatRoomsList', makeMockNode());
  domMap.set('teacherChatUnreadDot', makeMockNode(['hidden']));
  domMap.set('teacherLiveChatMessages', makeMockNode());
  domMap.set('activeChatRoomTitle', makeMockNode());
  domMap.set('activeChatRoomSubtitle', makeMockNode());

  const subscriptions = [];
  const makeQueryObj = (col) => ({
    where() { return makeQueryObj(col); },
    limit() { return makeQueryObj(col); },
    onSnapshot(cb) {
      subscriptions.push({ col, cb });
      return () => {};
    },
  });

  t.after(() => {
    _stopRealtimeListeners();
    global.window = prevWindow;
    global.document = prevDocument;
    mockData.currentUser = prevUser;
    require('../app.js').state.activeRole = prevRole;
    delete global.state;
    delete global.mockData;
    delete global._setChatTabRealtimeActive;
    delete global.switchBottomTab;
    delete global.switchTeacherBottomTab;
    delete global.renderStudentChat;
    delete global.renderTeacherChatRooms;
    delete global.renderTeacherChatMessages;
  });

  global.document = {
    getElementById(id) {
      return domMap.get(id) || null;
    },
  };
  global.window = {
    firebase: {
      apps: [{}],
      firestore: () => ({
        collection: (col) => makeQueryObj(col),
      }),
    },
  };

  const appMod = require('../app.js');
  const studentMod = require('../student.js');
  const teacherMod = require('../teacher.js');

  global.state = appMod.state;
  global.mockData = appMod.mockData;
  global._setChatTabRealtimeActive = appMod._setChatTabRealtimeActive;
  global.switchBottomTab = studentMod.switchBottomTab;
  global.switchTeacherBottomTab = teacherMod.switchTeacherBottomTab;
  global.renderStudentChat = studentMod.renderStudentChat;
  global.renderTeacherChatRooms = teacherMod.renderTeacherChatRooms;
  global.renderTeacherChatMessages = teacherMod.renderTeacherChatMessages;

  // 1) Student clicks counseling tab, then Firestore immediately fires initial onSnapshot callback
  appMod.state.activeRole = 'student';
  mockData.currentUser = {
    role: 'student',
    userId: '10401',
    studentId: '10401',
    studentName: '김민준',
    grade: '1',
    classNo: '4',
    neisSchoolCode: '8140246',
  };
  appMod.applyRoleUI({ resetTab: true });
  studentMod.switchBottomTab('counseling');

  assert.equal(domMap.get('tabView-counseling').classList.contains('hidden'), false);
  assert.equal(domMap.get('tabView-home').classList.contains('hidden'), true);
  assert.equal(appMod.state.activeStudentTab, 'counseling');
  assert.equal(_getRealtimeListenerState().hasChat, true);

  const studentChatSub = subscriptions.filter((s) => s.col === '1:1_상담채팅').pop();
  assert.ok(studentChatSub);
  studentChatSub.cb({
    forEach(fn) {
      fn({ id: 'c1', data: () => ({ room_id: 'ROOM-10401', sender_role: 'student', message: '안녕하세요', created_at: '2026-11-24 09:00:00' }) });
    },
  });

  // Must remain on counseling tab (not bounced back to home) and keep chat listener active
  assert.equal(domMap.get('tabView-counseling').classList.contains('hidden'), false);
  assert.equal(domMap.get('tabView-home').classList.contains('hidden'), true);
  assert.equal(appMod.state.activeStudentTab, 'counseling');
  assert.equal(_getRealtimeListenerState().hasChat, true);

  // 2) Teacher switches to chat tab, then onSnapshot fires
  appMod.state.activeRole = 'teacher';
  mockData.currentUser = {
    role: 'teacher',
    userId: 'teacher_1',
    teacherName: '김교사',
    grade: '1',
    classNo: '4',
    neisSchoolCode: '8140246',
  };
  appMod.applyRoleUI({ resetTab: true });
  teacherMod.switchTeacherBottomTab('chat');

  assert.equal(domMap.get('teacherTabView-chat').classList.contains('hidden'), false);
  assert.equal(domMap.get('teacherTabView-home').classList.contains('hidden'), true);
  assert.equal(appMod.state.activeTeacherTab, 'chat');
  assert.equal(_getRealtimeListenerState().hasChat, true);

  const teacherChatSub = subscriptions.filter((s) => s.col === '1:1_상담채팅').pop();
  assert.ok(teacherChatSub);
  teacherChatSub.cb({
    forEach(fn) {
      fn({ id: 'c2', data: () => ({ room_id: 'ROOM-10401', sender_role: 'student', message: '선생님 질문있습니다', created_at: '2026-11-24 09:05:00' }) });
    },
  });

  assert.equal(domMap.get('teacherTabView-chat').classList.contains('hidden'), false);
  assert.equal(domMap.get('teacherTabView-home').classList.contains('hidden'), true);
  assert.equal(appMod.state.activeTeacherTab, 'chat');
  assert.equal(_getRealtimeListenerState().hasChat, true);
});
