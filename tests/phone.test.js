const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Stub _firebaseAdmin.js and _googleDrive.js so unit tests run without installed node_modules
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
const {
  _normalizePhoneNumber,
  _handleDesktopApiAction,
  _handleUpdateMyPhone,
  _handleLogin,
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
  gradeNum: 2,
  classNum: 3,
  isAdmin: false,
  teacherDoc: { teacher_id: 'teacher_1', name: '김교사', grade: 2, class_no: 3, school_code: '8140246' },
};

test('_normalizePhoneNumber formats Korean phone numbers and rejects invalid inputs', () => {
  assert.deepEqual(_normalizePhoneNumber('01012345678'), { ok: true, phone: '010-1234-5678' });
  assert.deepEqual(_normalizePhoneNumber('010-1234-5678'), { ok: true, phone: '010-1234-5678' });
  assert.deepEqual(_normalizePhoneNumber('+82 10 9876 5432'), { ok: true, phone: '010-9876-5432' });
  assert.deepEqual(_normalizePhoneNumber('  '), { ok: true, phone: '' });
  assert.equal(_normalizePhoneNumber('abc-1234').ok, false);
  assert.equal(_normalizePhoneNumber('010123').ok, false);
});

test('admin_update_account_phone updates student and parent phone in same class', async () => {
  const db = createMockDb({
    '계정_학생': {
      '20301': { student_id: '20301', name: '홍길동', grade: 2, class_no: 3, school_code: '8140246', status: 'active' },
    },
    '계정_학부모': {
      'p_20301': { parent_id: 'p_20301', student_id: '20301', name: '홍부모', grade: 2, class_no: 3, school_code: '8140246', status: 'active' },
    },
  });

  const stuRes = await _handleDesktopApiAction(db, 'admin_update_account_phone', {
    target_role: 'student',
    remote_id: '20301',
    phone: '01011112222',
  }, teacherAuth);

  assert.equal(stuRes.status, 200);
  assert.equal(stuRes.json.ok, true);
  assert.equal(stuRes.json.phone, '010-1111-2222');
  assert.equal(db._store.get('계정_학생').get('20301').phone, '010-1111-2222');

  const parRes = await _handleDesktopApiAction(db, 'admin_update_account_phone', {
    target_role: 'parent',
    remote_id: 'p_20301',
    phone: '010 3333 4444',
  }, teacherAuth);

  assert.equal(parRes.status, 200);
  assert.equal(parRes.json.ok, true);
  assert.equal(parRes.json.phone, '010-3333-4444');
  assert.equal(db._store.get('계정_학부모').get('p_20301').phone, '010-3333-4444');
});

test('admin_update_account_phone enforces class isolation (403 for other class or school)', async () => {
  const db = createMockDb({
    '계정_학생': {
      '20401': { student_id: '20401', name: '다른반', grade: 2, class_no: 4, school_code: '8140246', status: 'active' },
      'other_school': { student_id: '20302', name: '다른학교', grade: 2, class_no: 3, school_code: '9999999', status: 'active' },
    },
  });

  const otherClassRes = await _handleDesktopApiAction(db, 'admin_update_account_phone', {
    target_role: 'student',
    remote_id: '20401',
    phone: '010-5555-6666',
  }, teacherAuth);
  assert.equal(otherClassRes.status, 403);
  assert.equal(otherClassRes.json.ok, false);
  assert.equal(db._store.get('계정_학생').get('20401').phone, undefined);

  const otherSchoolRes = await _handleDesktopApiAction(db, 'admin_update_account_phone', {
    target_role: 'student',
    remote_id: 'other_school',
    phone: '010-5555-6666',
  }, teacherAuth);
  assert.equal(otherSchoolRes.status, 403);
  assert.equal(otherSchoolRes.json.ok, false);
});

test('update_my_phone allows student and parent to update their own phone', async () => {
  const db = createMockDb({
    '계정_학생': {
      '20301': { student_id: '20301', login_id: 'hong203', name: '홍길동', status: 'active' },
    },
    '계정_학부모': {
      'p_20301': { parent_id: 'p_20301', custom_id: 'hongparent', name: '홍부모', status: 'active' },
    },
  });

  const stuToken = _testHelpers._signSessionToken({ sub: 'hong203', role: 'student', sid: '20301', sc: '' }).token;
  const stuRes = await _handleUpdateMyPhone(db, {
    role: 'student',
    user_id: 'hong203',
    phone: '01077778888',
  }, { headers: { authorization: `Bearer ${stuToken}` } });
  assert.equal(stuRes.status, 200);
  assert.equal(stuRes.json.ok, true);
  assert.equal(stuRes.json.phone, '010-7777-8888');
  assert.equal(db._store.get('계정_학생').get('20301').phone, '010-7777-8888');

  const parToken = _testHelpers._signSessionToken({ sub: 'hongparent', role: 'parent', sid: 'p_20301', sc: '' }).token;
  const parRes = await _handleUpdateMyPhone(db, {
    role: 'parent',
    user_id: 'hongparent',
    phone: '010-9999-0000',
  }, { headers: { authorization: `Bearer ${parToken}` } });
  assert.equal(parRes.status, 200);
  assert.equal(parRes.json.ok, true);
  assert.equal(parRes.json.phone, '010-9999-0000');
  assert.equal(db._store.get('계정_학부모').get('p_20301').phone, '010-9999-0000');

  const invalidToken = _testHelpers._signSessionToken({ sub: '20301', role: 'student', sid: '20301', sc: '' }).token;
  const invalidRes = await _handleUpdateMyPhone(db, {
    role: 'student',
    user_id: '20301',
    phone: 'invalid',
  }, { headers: { authorization: `Bearer ${invalidToken}` } });
  assert.equal(invalidRes.status, 400);
  assert.equal(invalidRes.json.ok, false);
});

test('login and admin_get_class_overview include phone field', async () => {
  const db = createMockDb({
    '계정_학생': {
      '20301': { student_id: '20301', name: '홍길동', grade: 2, class_no: 3, school_code: '8140246', password_hash: '1234', status: 'active', phone: '010-1234-5678' },
      '20302': { student_id: '20302', name: '김철수', grade: 2, class_no: 3, school_code: '8140246', password_hash: '1234', status: 'active' },
    },
    '계정_학부모': {
      'p_20301': { parent_id: 'p_20301', student_id: '20301', name: '홍부모', grade: 2, class_no: 3, school_code: '8140246', status: 'active' },
    },
  });

  const loginRes = await _handleLogin(db, { role: 'student', user_id: '20302', password: '1234' });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.user.phone, '');

  const overviewRes = await _handleDesktopApiAction(db, 'admin_get_class_overview', {}, teacherAuth);
  assert.equal(overviewRes.status, 200);
  assert.equal(overviewRes.json.students[0].phone, '010-1234-5678');
  assert.equal(overviewRes.json.students[1].phone, '');
  assert.equal(overviewRes.json.parents[0].phone, '');
});
