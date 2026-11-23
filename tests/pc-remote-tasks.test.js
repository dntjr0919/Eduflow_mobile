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
const { _handleDesktopApiAction, _handleGetMobileBundle, _evaluatePcAgentOnline } = _testHelpers;
const { isPcAgentOnline, REMOTE_TASK_LABELS } = require('../teacher.js');

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
    batch() {
      const ops = [];
      return {
        set(docRef, data, opts) {
          ops.push(() => docRef.set(data, opts));
        },
        delete(docRef) {
          ops.push(() => docRef.delete());
        },
        async commit() {
          for (const fn of ops) await fn();
        },
      };
    },
    collection(colName) {
      return {
        doc(docId) {
          return {
            id: docId,
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
            async delete() {
              const colMap = getColMap(colName);
              colMap.delete(docId);
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
  teacherId: 'teacher_a',
  schoolCode: '8140246',
  schoolName: '테스트고등학교',
  gradeNum: 1,
  classNum: 4,
  isAdmin: false,
  teacherDoc: { teacher_id: 'teacher_a', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
};

test('update_pc_agent_status and 3-minute online/offline evaluation', async () => {
  const nowMs = Date.UTC(2026, 10, 20, 5, 0, 0);
  const recentIso = new Date(nowMs - 60 * 1000).toISOString(); // 1 min ago -> online
  const staleIso = new Date(nowMs - 4 * 60 * 1000).toISOString(); // 4 min ago -> offline

  assert.equal(_evaluatePcAgentOnline({ pc_online: true, pc_last_seen_at: recentIso }, nowMs), true);
  assert.equal(_evaluatePcAgentOnline({ pc_online: true, pc_last_seen_at: staleIso }, nowMs), false);
  assert.equal(_evaluatePcAgentOnline({ pc_online: false, pc_last_seen_at: recentIso }, nowMs), false);
  assert.equal(_evaluatePcAgentOnline(null, nowMs), false);

  assert.equal(isPcAgentOnline({ pc_online: true, pc_last_seen_at: recentIso }, nowMs), true);
  assert.equal(isPcAgentOnline({ pc_online: true, pc_last_seen_at: staleIso }, nowMs), false);

  const db = createMockDb({
    '계정_교사': {
      teacher_a: { teacher_id: 'teacher_a', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
  });

  const res = await _handleDesktopApiAction(db, 'update_pc_agent_status', {
    pc_online: true,
    pc_last_seen_at: new Date().toISOString(),
    pc_hostname: 'DESKTOP-TEACHER',
    pc_app_version: '2.5.0',
  }, teacherAuth);

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.status.is_online, true);
  assert.equal(res.json.status.pc_hostname, 'DESKTOP-TEACHER');
  assert.equal(res.json.status.pc_app_version, '2.5.0');

  const savedStatus = db._store.get('PC_Agent_Status').get('teacher_a');
  assert.equal(savedStatus.pc_online, true);
  assert.equal(savedStatus.pc_hostname, 'DESKTOP-TEACHER');
});

test('fetch_pending_remote_tasks and update_remote_task_status enforce teacher isolation', async () => {
  const db = createMockDb({
    'Tasks': {
      mob_1: {
        remote_id: 'mob_1',
        teacher_id: 'teacher_a',
        task_type: 'comcigan_sync',
        title: '컴시간 시간표 즉시 동기화',
        is_mobile_task: true,
        exec_status: 'pending',
        is_done: false,
        created_at: '2026-11-20 14:00:00',
      },
      mob_2_done: {
        remote_id: 'mob_2_done',
        teacher_id: 'teacher_a',
        task_type: 'schoolbell_sync',
        is_mobile_task: true,
        exec_status: 'done',
        is_done: true,
        created_at: '2026-11-20 13:00:00',
      },
      mob_other_teacher: {
        remote_id: 'mob_other_teacher',
        teacher_id: 'teacher_b',
        task_type: 'file_sort',
        is_mobile_task: true,
        exec_status: 'pending',
        is_done: false,
        created_at: '2026-11-20 14:05:00',
      },
    },
  });

  // 1) fetch_pending_remote_tasks returns only teacher_a's pending mobile tasks
  const pendingRes = await _handleDesktopApiAction(db, 'fetch_pending_remote_tasks', {}, teacherAuth);
  assert.equal(pendingRes.status, 200);
  assert.equal(pendingRes.json.tasks.length, 1);
  assert.equal(pendingRes.json.tasks[0].remote_id, 'mob_1');

  // 2) update_remote_task_status blocks updating another teacher's task (403)
  const crossRes = await _handleDesktopApiAction(db, 'update_remote_task_status', {
    remote_id: 'mob_other_teacher',
    exec_status: 'done',
    memo: 'hacked',
  }, teacherAuth);
  assert.equal(crossRes.status, 403);

  // 3) update_remote_task_status rejects invalid exec_status (400)
  const badStatusRes = await _handleDesktopApiAction(db, 'update_remote_task_status', {
    remote_id: 'mob_1',
    exec_status: 'unknown',
  }, teacherAuth);
  assert.equal(badStatusRes.status, 400);

  // 4) update_remote_task_status updates running -> done/error with memo
  const runRes = await _handleDesktopApiAction(db, 'update_remote_task_status', {
    remote_id: 'mob_1',
    exec_status: 'running',
    memo: '컴시간 동기화 진행 중...',
  }, teacherAuth);
  assert.equal(runRes.status, 200);
  assert.equal(runRes.json.task.exec_status, 'running');
  assert.equal(runRes.json.task.is_done, false);

  const doneRes = await _handleDesktopApiAction(db, 'update_remote_task_status', {
    remote_id: 'mob_1',
    exec_status: 'done',
    memo: '시간표 18건 동기화 완료',
  }, teacherAuth);
  assert.equal(doneRes.status, 200);
  assert.equal(doneRes.json.task.exec_status, 'done');
  assert.equal(doneRes.json.task.is_done, true);
  assert.equal(doneRes.json.task.memo, '시간표 18건 동기화 완료');
});

test('get_mobile_bundle includes pc_agent_status and remote_tasks for teacher', async () => {
  const db = createMockDb({
    '계정_교사': {
      teacher_a: { teacher_id: 'teacher_a', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
    'PC_Agent_Status': {
      teacher_a: {
        remote_id: 'teacher_a',
        teacher_id: 'teacher_a',
        pc_online: true,
        pc_last_seen_at: new Date().toISOString(),
        pc_hostname: 'OFFICE-PC',
        pc_app_version: '2.5.0',
      },
    },
    'Tasks': {
      mob_1: {
        remote_id: 'mob_1',
        teacher_id: 'teacher_a',
        task_type: 'homeroom_report',
        title: '학급 출결·가정통신문 요약 보고서 생성',
        is_mobile_task: true,
        exec_status: 'done',
        memo: '보고서 생성 완료',
        created_at: '2026-11-20 14:10:00',
      },
      mob_other: {
        remote_id: 'mob_other',
        teacher_id: 'teacher_b',
        is_mobile_task: true,
        exec_status: 'pending',
        created_at: '2026-11-20 14:12:00',
      },
    },
  });

  const bundleRes = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 'teacher_a',
    grade: 1,
    class_no: 4,
    school_code: '8140246',
    force: '1',
  });

  assert.equal(bundleRes.status, 200);
  assert.equal(bundleRes.json.pc_agent_status.is_online, true);
  assert.equal(bundleRes.json.pc_agent_status.pc_hostname, 'OFFICE-PC');
  assert.equal(bundleRes.json.remote_tasks.length, 1);
  assert.equal(bundleRes.json.remote_tasks[0].remote_id, 'mob_1');
});

test('index.html remote tab has dynamic status banner, 4 practical tasks, and scheduled time picker', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const start = html.indexOf('id="teacherTabView-remote"');
  assert.ok(start !== -1);
  const end = html.indexOf('id="teacherTabView-chat"', start);
  const snippet = html.slice(start, end);

  assert.equal(snippet.includes('교탁/자택 PC 에이전트 온라인'), false);
  assert.ok(snippet.includes('id="pcAgentStatusBanner"'));
  assert.ok(snippet.includes('id="pcAgentStatusTitle"'));
  assert.ok(snippet.includes('id="remoteTaskType"'));
  for (const key of Object.keys(REMOTE_TASK_LABELS)) {
    assert.ok(snippet.includes(`value="${key}"`), `must include task option ${key}`);
  }
  assert.ok(snippet.includes('id="remoteTaskTime"'));
  assert.ok(snippet.includes('type="time"'));
});

test('naive KST heartbeat timestamps and legacy pc_agent_* aliases evaluate online properly', async () => {
  // 2026-11-23 15:00:00 KST == 2026-11-23T06:00:00Z
  const nowUtcMs = Date.UTC(2026, 10, 23, 6, 1, 0);
  assert.equal(_evaluatePcAgentOnline({ pc_online: true, pc_last_seen_at: '2026-11-23 15:00:00' }, nowUtcMs), true);
  assert.equal(isPcAgentOnline({ pc_online: true, pc_last_seen_at: '2026-11-23 15:00:00' }, nowUtcMs), true);

  const db = createMockDb({
    '계정_교사': {
      teacher_a: { teacher_id: 'teacher_a', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
    },
  });

  const res = await _handleDesktopApiAction(db, 'update_pc_agent_status', {
    online: false,
    pc_agent_online: false,
    last_seen: new Date().toISOString(),
    hostname: 'LEGACY-PC',
    app_version: '2.0',
  }, teacherAuth);
  assert.equal(res.status, 200);
  assert.equal(res.json.status.pc_online, false);
  assert.equal(res.json.status.pc_hostname, 'LEGACY-PC');
});

test('sync_timetables_batch reconcile_changes deletes cancelled comcigan changes and keeps manual ones', async () => {
  const db = createMockDb({
    '시간표_변동': {
      tc_20261123_1_4_3: {
        remote_id: 'tc_20261123_1_4_3',
        school_code: '8140246',
        date: '2026-11-23',
        grade: 1,
        class_no: 4,
        period: 3,
        source: 'comcigan',
      },
      tc_20261123_1_4_5: {
        remote_id: 'tc_20261123_1_4_5',
        school_code: '8140246',
        date: '2026-11-23',
        grade: 1,
        class_no: 4,
        period: 5,
        source: 'comcigan',
      },
      manual_1: {
        remote_id: 'manual_1',
        school_code: '8140246',
        date: '2026-11-23',
        grade: 1,
        class_no: 4,
        period: 6,
        source: 'manual',
      },
    },
  });

  const res = await _handleDesktopApiAction(db, 'sync_timetables_batch', {
    change_rows: [],
    reconcile_changes: true,
    reconcile_dates: ['2026-11-23'],
    keep_change_ids: ['tc_20261123_1_4_3'],
    school_code: '8140246',
  }, teacherAuth);

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.change_deleted, 1);

  const chgStore = db._store.get('시간표_변동');
  assert.equal(chgStore.has('tc_20261123_1_4_3'), true);
  assert.equal(chgStore.has('tc_20261123_1_4_5'), false);
  assert.equal(chgStore.has('manual_1'), true);
});
