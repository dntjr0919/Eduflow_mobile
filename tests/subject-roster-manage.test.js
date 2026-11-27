const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256(str) {
  return crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex');
}

let activeMockDb = null;

const firebaseAdminPath = path.resolve(__dirname, '../api/_firebaseAdmin.js');
require.cache[firebaseAdminPath] = {
  id: firebaseAdminPath,
  filename: firebaseAdminPath,
  loaded: true,
  exports: {
    getFirestore: () => activeMockDb,
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

function createMockDb(initialCollections = {}) {
  const store = new Map();
  let writeCount = 0;

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
        const docs = [];
        for (const [docId, data] of colMap.entries()) {
          const matched = filters.every((f) => {
            if (f.op === '==') return data[f.field] === f.val;
            if (f.op === 'in' && Array.isArray(f.val)) return f.val.includes(data[f.field]);
            return true;
          });
          if (matched) docs.push(makeSnap(docId, data));
          if (docs.length >= maxLimit) break;
        }
        return { docs, forEach: (cb) => docs.forEach(cb) };
      },
    };
  }

  return {
    getWriteCount: () => writeCount,
    resetWriteCount: () => { writeCount = 0; },
    getCol: (colName) => getColMap(colName),
    collection(colName) {
      const base = makeQuery(colName);
      return {
        ...base,
        doc(docId) {
          return {
            async get() {
              const data = getColMap(colName).get(docId);
              return makeSnap(docId, data);
            },
            async set(payload, opts = {}) {
              writeCount += 1;
              const colMap = getColMap(colName);
              const prev = opts.merge ? (colMap.get(docId) || {}) : {};
              colMap.set(docId, { ...prev, ...payload });
            },
            async delete() {
              writeCount += 1;
              getColMap(colName).delete(docId);
            },
          };
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(docRef, payload, opts) {
          ops.push(() => docRef.set(payload, opts));
        },
        delete(docRef) {
          ops.push(() => docRef.delete());
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
  };
}

async function callApi(action, body = {}) {
  let statusCode = 200;
  let jsonPayload = null;
  const req = {
    method: 'POST',
    query: {},
    headers: {},
    body: { action, ...body },
  };
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(obj) {
      jsonPayload = obj;
      return this;
    },
    end() {
      return this;
    },
  };
  await handler(req, res);
  return { status: statusCode, json: jsonPayload };
}

function buildFixtureDb() {
  return createMockDb({
    '계정_교사': {
      teacher_001: {
        remote_id: 'teacher_001',
        teacher_id: 'teacher_001',
        login_id: 'teacher_001',
        school_code: 'SCH01',
        school_name: '테스트고',
        grade: 1,
        class_no: 3,
        password_hash: sha256('pw1234'),
        status: 'active',
      },
      teacher_002: {
        remote_id: 'teacher_002',
        teacher_id: 'teacher_002',
        login_id: 'teacher_002',
        school_code: 'SCH01',
        school_name: '테스트고',
        grade: 1,
        class_no: 4,
        password_hash: sha256('pw1234'),
        status: 'active',
      },
    },
    '교과_명렬표': {
      roster_t1_wrong: {
        remote_id: 'roster_t1_wrong',
        teacher_id: 'teacher_001',
        school_code: 'SCH01',
        school_name: '테스트고',
        subject: '학생개인번호',
        class_label: '1-3',
        roster_key: '학생개인번호__1-3',
        students: [{ student_id: '10301', student_name: '김철수' }],
      },
      roster_t2_other: {
        remote_id: 'roster_t2_other',
        teacher_id: 'teacher_002',
        school_code: 'SCH01',
        school_name: '테스트고',
        subject: '국어',
        class_label: '1-4',
        roster_key: '국어__1-4',
        students: [{ student_id: '10401', student_name: '이영희' }],
      },
    },
    '수업_진도': {
      prog_1: {
        remote_id: 'prog_1',
        teacher_id: 'teacher_001',
        school_code: 'SCH01',
        subject: '학생개인번호',
        class_label: '1-3',
        roster_key: '학생개인번호__1-3',
        unit: '1단원',
      },
      prog_other_teacher: {
        remote_id: 'prog_other_teacher',
        teacher_id: 'teacher_002',
        school_code: 'SCH01',
        subject: '학생개인번호',
        class_label: '1-3',
        roster_key: '학생개인번호__1-3',
        unit: '타교사단원',
      },
    },
    '교과_출결': {
      att_1: {
        remote_id: 'att_1',
        teacher_id: 'teacher_001',
        school_code: 'SCH01',
        subject: '학생개인번호',
        class_label: '1-3',
        roster_key: '학생개인번호__1-3',
        student_id: '10301',
        status: '출석',
      },
    },
  });
}

test('update_subject_roster enforces ownership and skips Firestore writes when unchanged', async () => {
  activeMockDb = buildFixtureDb();
  const loginRes = await callApi('login', { role: 'teacher', user_id: 'teacher_001', password: 'pw1234' });
  assert.equal(loginRes.status, 200);
  const token = loginRes.json.token;

  // Cross-teacher blocked (403)
  const crossRes = await callApi('update_subject_roster', {
    auth_token: token,
    remote_id: 'roster_t2_other',
    subject: '변조과목',
    class_label: '1-4',
  });
  assert.equal(crossRes.status, 403);

  // Unchanged -> early exit with skipped: true and ZERO writes
  activeMockDb.resetWriteCount();
  const skipRes = await callApi('update_subject_roster', {
    auth_token: token,
    remote_id: 'roster_t1_wrong',
    subject: '학생개인번호',
    class_label: '1-3',
    sync_related: false,
  });
  assert.equal(skipRes.status, 200);
  assert.equal(skipRes.json.ok, true);
  assert.equal(skipRes.json.skipped, true);
  assert.equal(activeMockDb.getWriteCount(), 0);
});

test('update_subject_roster updates roster only by default and syncs related docs only when sync_related=true', async () => {
  activeMockDb = buildFixtureDb();
  const loginRes = await callApi('login', { role: 'teacher', user_id: 'teacher_001', password: 'pw1234' });
  const token = loginRes.json.token;

  // 1) Update without sync_related -> only 교과_명렬표 updated
  activeMockDb.resetWriteCount();
  const res1 = await callApi('update_subject_roster', {
    auth_token: token,
    remote_id: 'roster_t1_wrong',
    subject: '과탐2',
    class_label: '1-3',
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.json.synced_progress, 0);
  assert.equal(res1.json.synced_attendance, 0);
  assert.equal(activeMockDb.getWriteCount(), 1);
  assert.equal(activeMockDb.getCol('교과_명렬표').get('roster_t1_wrong').subject, '과탐2');
  assert.equal(activeMockDb.getCol('수업_진도').get('prog_1').subject, '학생개인번호');

  // 2) Update with sync_related=true on fresh fixture -> updates roster + own 수업_진도 + own 교과_출결, leaves other teacher untouched
  activeMockDb = buildFixtureDb();
  const loginRes2 = await callApi('login', { role: 'teacher', user_id: 'teacher_001', password: 'pw1234' });
  const token2 = loginRes2.json.token;
  const res2 = await callApi('update_subject_roster', {
    auth_token: token2,
    remote_id: 'roster_t1_wrong',
    subject: '통합과학2',
    class_label: '1-3',
    sync_related: true,
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.json.synced_progress, 1);
  assert.equal(res2.json.synced_attendance, 1);
  assert.equal(activeMockDb.getCol('교과_명렬표').get('roster_t1_wrong').subject, '통합과학2');
  assert.equal(activeMockDb.getCol('수업_진도').get('prog_1').subject, '통합과학2');
  assert.equal(activeMockDb.getCol('교과_출결').get('att_1').subject, '통합과학2');
  assert.equal(activeMockDb.getCol('수업_진도').get('prog_other_teacher').subject, '학생개인번호');
});

test('delete_subject_roster enforces ownership and deletes only the roster document', async () => {
  activeMockDb = buildFixtureDb();
  const loginRes = await callApi('login', { role: 'teacher', user_id: 'teacher_001', password: 'pw1234' });
  const token = loginRes.json.token;

  const crossDel = await callApi('delete_subject_roster', {
    auth_token: token,
    remote_id: 'roster_t2_other',
  });
  assert.equal(crossDel.status, 403);

  const delRes = await callApi('delete_subject_roster', {
    auth_token: token,
    remote_id: 'roster_t1_wrong',
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.json.deleted, true);
  assert.equal(activeMockDb.getCol('교과_명렬표').has('roster_t1_wrong'), false);
  // Related progress and attendance remain intact
  assert.equal(activeMockDb.getCol('수업_진도').has('prog_1'), true);
  assert.equal(activeMockDb.getCol('교과_출결').has('att_1'), true);
});

test('admin/index.html wires subject roster management button and modal with unchecked sync checkbox', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../admin/index.html'), 'utf8');
  assert.match(html, /onclick="openSubjectRosterManageModal\(\)"/);
  assert.match(html, /id="subjectRosterManageModal"/);
  assert.match(html, /id="subject-roster-search-input"/);
  assert.match(html, /id="subject-roster-manage-list"/);

  const adminJs = fs.readFileSync(path.resolve(__dirname, '../admin/admin.js'), 'utf8');
  assert.match(adminJs, /id="sr-edit-sync-related"\s+type="checkbox"/);
  assert.doesNotMatch(adminJs, /id="sr-edit-sync-related"[^>]*checked/);
});

test('admin.js saveSubjectRosterEdit skips API call when subject and class_label are unchanged', async () => {
  const adminJs = fs.readFileSync(path.resolve(__dirname, '../admin/admin.js'), 'utf8');
  // Verify early-exit check exists before callApi('update_subject_roster', ...)
  const earlyExitIdx = adminJs.indexOf("if (newSubject === oldSubject && newClassLabel === oldClassLabel)");
  const apiCallIdx = adminJs.indexOf("callApi('update_subject_roster'");
  assert.ok(earlyExitIdx > 0 && apiCallIdx > earlyExitIdx, 'Early exit check must precede update_subject_roster API call');
});
