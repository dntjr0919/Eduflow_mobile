const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
  exports: {
    uploadBase64ToDrive: async ({ fileName }) => ({
      ok: true,
      fileId: `drive_${fileName}`,
      downloadUrl: `https://drive.google.com/uc?id=drive_${fileName}`,
      webViewLink: `https://drive.google.com/file/d/drive_${fileName}/view`,
    }),
  },
};

const handler = require('../api/firestore.js');
const { _testHelpers } = handler;
const { _handleLogin, _normalizeSignatureMode, _handleGetMobileBundle } = _testHelpers;
const { _normalizeNoticeSignatureMode } = require('../student.js');

function sha256(val) {
  return crypto.createHash('sha256').update(String(val), 'utf8').digest('hex');
}

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
  function makeQuery(colName, filters = [], orderSpec = null, maxLimit = Infinity) {
    return {
      where(field, op, val) {
        return makeQuery(colName, [...filters, { field, op, val }], orderSpec, maxLimit);
      },
      orderBy(field, direction = 'asc') {
        return makeQuery(colName, filters, { field, direction }, maxLimit);
      },
      limit(n) {
        return makeQuery(colName, filters, orderSpec, n);
      },
      async get() {
        const colMap = getColMap(colName);
        let matched = [];
        for (const [id, data] of colMap.entries()) {
          let ok = true;
          for (const f of filters) {
            if (f.op === '==' && data[f.field] !== f.val) ok = false;
            else if (f.op === 'in' && (!Array.isArray(f.val) || !f.val.includes(data[f.field]))) ok = false;
          }
          // Firestore orderBy() excludes documents missing the ordered field
          if (ok && orderSpec && data[orderSpec.field] === undefined) ok = false;
          if (ok) matched.push({ id, data });
        }
        if (orderSpec) {
          matched.sort((a, b) => {
            const va = String(a.data[orderSpec.field] ?? '');
            const vb = String(b.data[orderSpec.field] ?? '');
            return orderSpec.direction === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
          });
        }
        if (Number.isFinite(maxLimit)) matched = matched.slice(0, maxLimit);
        const snaps = matched.map((m) => makeSnap(m.id, m.data));
        return {
          empty: snaps.length === 0,
          size: snaps.length,
          docs: snaps,
          forEach(cb) {
            snaps.forEach(cb);
          },
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
              const data = getColMap(colName).get(docId);
              return makeSnap(docId, data);
            },
            async set(data) {
              const colMap = getColMap(colName);
              const existing = colMap.get(docId) || {};
              colMap.set(docId, { ...existing, ...data });
            },
          };
        },
        where(field, op, val) {
          return makeQuery(colName, [{ field, op, val }]);
        },
        orderBy(field, direction = 'asc') {
          return makeQuery(colName, [], { field, direction });
        },
        limit(n) {
          return makeQuery(colName, [], null, n);
        },
        async get() {
          return makeQuery(colName).get();
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) {
          ops.push(() => ref.set(data));
        },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
  };
}

function createMockRes() {
  return {
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
}

test('signature mode normalization supports 4 canonical modes and legacy values', () => {
  for (const fn of [_normalizeSignatureMode, _normalizeNoticeSignatureMode]) {
    assert.equal(fn('none', true), 'none');
    assert.equal(fn('0', true), 'none');
    assert.equal(fn('student', true), 'student');
    assert.equal(fn('parent', true), 'parent');
    assert.equal(fn('single', true), 'parent');
    assert.equal(fn('1', true), 'parent');
    assert.equal(fn('both', true), 'both');
    assert.equal(fn('2', true), 'both');
    assert.equal(fn('', false), 'none');
    assert.equal(fn('', true), 'parent');
  }
});

test('submit_notice_reply enforces none, student, parent, both, and legacy signature modes', async () => {
  const db = createMockDb({
    '계정_학생': {
      'doc_10536': {
        student_id: '10536',
        name: '이승수',
        grade: 1,
        class_no: 5,
        school_code: '7010057',
        status: 'active',
        password_hash: sha256('pass1234'),
      },
    },
    '가정통신문_목록': {
      'notice_none': { remote_id: 'notice_none', title: '열람용', requires_reply: false, signature_mode: 'none' },
      'notice_student': { remote_id: 'notice_student', title: '학생서명', requires_reply: true, signature_mode: 'student' },
      'notice_parent_legacy': { remote_id: 'notice_parent_legacy', title: '학부모레거시', requires_reply: true, signature_mode: '1' },
      'notice_both': { remote_id: 'notice_both', title: '2칸서명', requires_reply: true, signature_mode: 'both' },
    },
  });
  activeMockDb = db;

  const loginRes = await _handleLogin(db, {
    role: 'student',
    user_id: '10536',
    password: 'pass1234',
  });
  const token = loginRes.json.token;

  // 1. none: succeeds without any signature
  const resNone = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: { notice_id: 'notice_none', student_id: '10536', signature_mode: 'none', consent: '확인' },
    },
  }, resNone);
  assert.equal(resNone.statusCode, 200);
  assert.equal(resNone.body.signature_mode, 'none');

  // 2. student: rejects missing student signature, succeeds with student_signature_base64
  const resStuFail = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: { notice_id: 'notice_student', student_id: '10536', signature_mode: 'student' },
    },
  }, resStuFail);
  assert.equal(resStuFail.statusCode, 400);

  const resStuOk = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: {
        notice_id: 'notice_student',
        student_id: '10536',
        signature_mode: 'student',
        student_signature_base64: 'data:image/png;base64,AAAA',
      },
    },
  }, resStuOk);
  assert.equal(resStuOk.statusCode, 200);
  assert.equal(resStuOk.body.signature_mode, 'student');
  assert.ok(resStuOk.body.student_signature_drive_url);
  assert.equal(resStuOk.body.signature_drive_url, '');

  // 3. legacy '1' -> parent: rejects missing parent signature, succeeds with signature_base64
  const resParFail = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: { notice_id: 'notice_parent_legacy', student_id: '10536' },
    },
  }, resParFail);
  assert.equal(resParFail.statusCode, 400);

  const resParOk = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: {
        notice_id: 'notice_parent_legacy',
        student_id: '10536',
        signature_base64: 'data:image/png;base64,BBBB',
      },
    },
  }, resParOk);
  assert.equal(resParOk.statusCode, 200);
  assert.equal(resParOk.body.signature_mode, 'parent');
  assert.ok(resParOk.body.signature_drive_url);

  // 4. both: rejects if only one signature is provided, succeeds when both are provided
  const resBothFail = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: {
        notice_id: 'notice_both',
        student_id: '10536',
        signature_mode: 'both',
        student_signature_base64: 'data:image/png;base64,CCCC',
      },
    },
  }, resBothFail);
  assert.equal(resBothFail.statusCode, 400);

  const resBothOk = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: {
        notice_id: 'notice_both',
        student_id: '10536',
        signature_mode: 'both',
        student_signature_base64: 'data:image/png;base64,CCCC',
        parent_signature_base64: 'data:image/png;base64,DDDD',
      },
    },
  }, resBothOk);
  assert.equal(resBothOk.statusCode, 200);
  assert.equal(resBothOk.body.signature_mode, 'both');
  assert.ok(resBothOk.body.student_signature_drive_url);
  assert.ok(resBothOk.body.signature_drive_url);
});

test('index.html exposes all 4 signature mode options in newCircularModal and candidateNoticeModal', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  for (const name of ['newCircularSignatureMode', 'candidateNoticeSignatureMode']) {
    for (const val of ['none', 'student', 'parent', 'both']) {
      assert.ok(
        html.includes(`name="${name}"`) && html.includes(`value="${val}"`),
        `Expected ${name} to include value="${val}"`
      );
    }
  }
});

test('submit_notice_reply persists created_at and is returned by _handleGetMobileBundle for both student and teacher', async () => {
  const db = createMockDb({
    '계정_교사': {
      't_105': {
        teacher_id: 't_105',
        name: '박담임',
        grade: 1,
        class_no: 5,
        school_code: '7010057',
        school_name: '테스트고',
        status: 'active',
        password_hash: sha256('teach1234'),
      },
    },
    '계정_학생': {
      'doc_10536': {
        student_id: '10536',
        name: '이승수',
        grade: 1,
        class_no: 5,
        school_code: '7010057',
        school_name: '테스트고',
        status: 'active',
        password_hash: sha256('pass1234'),
      },
    },
    '가정통신문_목록': {
      'notice_reg_1': {
        remote_id: 'notice_reg_1',
        title: '현장체험학습 안내',
        target_grade: 1,
        target_class: 5,
        school_code: '7010057',
        school_name: '테스트고',
        teacher_id: 't_105',
        requires_reply: true,
        signature_mode: 'parent',
        is_published: true,
        created_at: '2026-11-26 09:00:00',
        updated_at: '2026-11-26 09:00:00',
      },
    },
  });
  activeMockDb = db;

  const loginRes = await _handleLogin(db, {
    role: 'student',
    user_id: '10536',
    password: 'pass1234',
  });
  const token = loginRes.json.token;

  const submitRes = createMockRes();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      action: 'submit_notice_reply',
      data: {
        notice_id: 'notice_reg_1',
        student_id: '10536',
        student_name: '이승수',
        consent: '동의',
        signature_base64: 'data:image/png;base64,AAAA',
      },
    },
  }, submitRes);
  assert.equal(submitRes.statusCode, 200);
  const savedReply = db._store.get('가정통신문_회신').get('notice_reg_1_10536');
  assert.ok(savedReply, 'reply document must be stored');
  assert.ok(savedReply.created_at && String(savedReply.created_at).trim().length > 0, 'replyDoc must persist created_at');

  // Student bundle must include the submitted reply (not excluded by orderBy('created_at', 'desc'))
  const studentRes = await _handleGetMobileBundle(db, {
    role: 'student',
    student_id: '10536',
    user_id: 'doc_10536',
    grade: 1,
    class_no: 5,
    school_code: '7010057',
    force: '1',
  });
  const studentBundle = studentRes.json || studentRes;
  assert.equal(studentBundle.ok, true);
  assert.equal(
    studentBundle.notice_replies.some((r) => r.remote_id === 'notice_reg_1_10536' && r.notice_id === 'notice_reg_1'),
    true,
    'student _handleGetMobileBundle must return submitted notice reply'
  );

  // Teacher bundle must also include the submitted reply
  const teacherRes = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 't_105',
    grade: 1,
    class_no: 5,
    school_code: '7010057',
    force: '1',
  });
  const teacherBundle = teacherRes.json || teacherRes;
  assert.equal(teacherBundle.ok, true);
  assert.equal(
    teacherBundle.notice_replies.some((r) => r.remote_id === 'notice_reg_1_10536' && r.student_id === '10536'),
    true,
    'teacher _handleGetMobileBundle must return submitted notice reply'
  );
});
