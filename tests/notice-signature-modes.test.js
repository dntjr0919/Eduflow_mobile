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
const { _handleLogin, _normalizeSignatureMode } = _testHelpers;
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
            if (f.op === '==' && data[f.field] !== f.val) ok = false;
          }
          if (ok) matched.push(makeSnap(id, data));
          if (matched.length >= maxLimit) break;
        }
        return {
          empty: matched.length === 0,
          size: matched.length,
          docs: matched,
          forEach(cb) {
            matched.forEach(cb);
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
