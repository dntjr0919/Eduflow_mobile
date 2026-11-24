const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const {
  _signSessionToken,
  _verifySessionToken,
  _extractSessionToken,
  _handleLogin,
  _handleVerifySession,
  _verifyActiveTeacherAuth,
} = _testHelpers;

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
          docs: matched,
          forEach(cb) { matched.forEach(cb); },
        };
      },
    };
  }
  return {
    collection(colName) {
      return {
        doc(docId) {
          return {
            async get() {
              return makeSnap(docId, getColMap(colName).get(docId));
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

test('_handleLogin issues signed HMAC-SHA256 session token and _verifySessionToken validates/rejects tampered or expired tokens', async () => {
  const db = createMockDb({
    '계정_교사': {
      teacher_1: {
        teacher_id: 'teacher_1',
        name: '김교사',
        grade: 1,
        class_no: 4,
        school_code: '8140246',
        status: 'active',
        password_hash: sha256('secret1234'),
      },
    },
    '계정_학생': {
      '10401': {
        student_id: '10401',
        name: '박학생',
        grade: 1,
        class_no: 4,
        school_code: '8140246',
        status: 'active',
        password_hash: sha256('stu1234'),
      },
    },
  });

  const badLogin = await _handleLogin(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    password: 'wrong',
  });
  assert.equal(badLogin.status, 401);

  const loginRes = await _handleLogin(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    password: 'secret1234',
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.ok, true);
  assert.ok(loginRes.json.token);
  assert.equal(loginRes.json.token.split('.').length, 3);
  assert.equal(loginRes.json.user.password_hash, undefined);
  assert.ok(loginRes.json.expires_at > Date.now());

  const verified = _verifySessionToken(loginRes.json.token);
  assert.equal(verified.ok, true);
  assert.equal(verified.claims.sub, 'teacher_1');
  assert.equal(verified.claims.role, 'teacher');

  // Tampered token rejected
  const parts = loginRes.json.token.split('.');
  const tampered = `${parts[0]}.${parts[1]}.tampered_sig`;
  assert.equal(_verifySessionToken(tampered).ok, false);

  // Expired token rejected (sign a token with past exp using the same secret logic)
  const expHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const expPayload = Buffer.from(JSON.stringify({
    sub: 'teacher_1',
    role: 'teacher',
    iat: Math.floor(Date.now() / 1000) - 120,
    exp: Math.floor(Date.now() / 1000) - 60,
  })).toString('base64url');
  const fallbackSecret = crypto.createHash('sha256').update(
    `eduflow_session:${process.env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_SERVICE_ACCOUNT_KEY || 'eduflow_mobile_dev_fallback_secret'}`,
    'utf8'
  ).digest('hex');
  const secret = String(process.env.AUTH_TOKEN_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || '').trim() || fallbackSecret;
  const expSig = crypto.createHmac('sha256', secret).update(`${expHeader}.${expPayload}`, 'utf8').digest('base64url');
  assert.equal(_verifySessionToken(`${expHeader}.${expPayload}.${expSig}`).ok, false);

  // _handleVerifySession via Bearer header
  const extracted = _extractSessionToken({}, { headers: { authorization: `Bearer ${loginRes.json.token}` } });
  assert.equal(extracted, loginRes.json.token);

  const sessionRes = await _handleVerifySession(
    db,
    {},
    { headers: { authorization: `Bearer ${loginRes.json.token}` } }
  );
  assert.equal(sessionRes.status, 200);
  assert.equal(sessionRes.json.user.teacher_id, 'teacher_1');
  assert.equal(sessionRes.json.user.password_hash, undefined);
});

test('_verifyActiveTeacherAuth accepts token without password and preserves PC app password fallback', async () => {
  const db = createMockDb({
    '계정_교사': {
      teacher_1: {
        teacher_id: 'teacher_1',
        name: '김교사',
        grade: 1,
        class_no: 4,
        school_code: '8140246',
        status: 'active',
        password_hash: sha256('pcAppPass!'),
      },
    },
    '계정_학생': {
      '10401': {
        student_id: '10401',
        name: '박학생',
        grade: 1,
        class_no: 4,
        school_code: '8140246',
        status: 'active',
        password_hash: sha256('stu1234'),
      },
    },
  });

  const teacherLogin = await _handleLogin(db, {
    role: 'teacher',
    user_id: 'teacher_1',
    password: 'pcAppPass!',
  });
  const studentLogin = await _handleLogin(db, {
    role: 'student',
    user_id: '10401',
    password: 'stu1234',
  });

  // 1) Web client: token-only (no auth_password, no auth_password_hash)
  const tokenAuth = await _verifyActiveTeacherAuth(db, {
    auth_teacher_id: 'teacher_1',
    auth_token: teacherLogin.json.token,
  });
  assert.equal(tokenAuth.ok, true);
  assert.equal(tokenAuth.teacherId, 'teacher_1');

  // Student token cannot be used for teacher auth
  const stuAttempt = await _verifyActiveTeacherAuth(db, {
    auth_token: studentLogin.json.token,
  });
  assert.equal(stuAttempt.ok, false);
  assert.equal(stuAttempt.status, 403);

  // Mismatched auth_teacher_id rejected
  const mismatchAttempt = await _verifyActiveTeacherAuth(db, {
    auth_teacher_id: 'other_teacher',
    auth_token: teacherLogin.json.token,
  });
  assert.equal(mismatchAttempt.ok, false);
  assert.equal(mismatchAttempt.status, 403);

  // 2) PC app (eduflow) backward compatibility: password/hash without token still works
  const pcAppAuth = await _verifyActiveTeacherAuth(db, {
    auth_teacher_id: 'teacher_1',
    auth_password: 'pcAppPass!',
  });
  assert.equal(pcAppAuth.ok, true);
  assert.equal(pcAppAuth.teacherId, 'teacher_1');
});

test('frontend files never store plaintext/hashed passwords in localStorage or send auth_password in API payloads', () => {
  const appJs = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
  const teacherJs = fs.readFileSync(path.resolve(__dirname, '../teacher.js'), 'utf8');
  const adminJs = fs.readFileSync(path.resolve(__dirname, '../admin/admin.js'), 'utf8');

  assert.doesNotMatch(teacherJs, /auth_password\s*:/);
  assert.doesNotMatch(teacherJs, /auth_password_hash\s*:/);
  assert.doesNotMatch(adminJs, /body\.auth_password\b/);
  assert.doesNotMatch(adminJs, /body\.auth_password_hash\b/);
  assert.doesNotMatch(appJs, /passwordHash:\s*auth\.passwordHash/);
  assert.doesNotMatch(adminJs, /passwordHash:\s*auth\.passwordHash/);
});
