const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  exports: {},
};

const handler = require('../api/firestore.js');
const { _testHelpers } = handler;
const {
  _handleLogin,
  _verifyRequestSession,
  _matchesSessionStudent,
  _matchesSessionStudentWithLookup,
} = _testHelpers;

const studentModule = require('../student.js');
const {
  _parseConsultationHoursRange,
  _getKstWorkingHoursStatus,
} = studentModule;

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

test('student send_chat_message succeeds when receiver_id is teacher_001 and student_id is omitted', async () => {
  const db = createMockDb({
    '계정_학생': {
      'doc_10536': {
        student_id: '10536',
        login_id: 'lss_login',
        custom_id: 'leess',
        name: '이승수',
        grade: 1,
        class_no: 5,
        school_code: '7010057',
        status: 'active',
        password_hash: sha256('pass1234'),
      },
    },
  });
  activeMockDb = db;

  const loginRes = await _handleLogin(db, {
    role: 'student',
    user_id: 'leess',
    password: 'pass1234',
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.ok, true);

  const session = _verifyRequestSession({ auth_token: loginRes.json.token });
  assert.equal(session.ok, true);
  assert.equal(session.sub, '10536');
  assert.equal(session.studentId, '10536');

  const res = createMockRes();
  await handler(
    {
      method: 'POST',
      headers: { authorization: `Bearer ${loginRes.json.token}` },
      body: {
        action: 'send_chat_message',
        data: {
          room_id: 'ROOM-10536',
          sender_id: '10536',
          sender_name: '이승수',
          sender_role: 'student',
          receiver_id: 'teacher_001',
          message: '선생님 안녕하세요!',
          is_read: 0,
        },
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.item.room_id, 'ROOM-10536');
  assert.equal(res.body.item.student_id, '10536');
});

test('student send_chat_message allows own alternate ID (custom_id) and blocks other student rooms (403)', async () => {
  const db = createMockDb({
    '계정_학생': {
      'doc_10536': {
        student_id: '10536',
        login_id: 'lss_login',
        custom_id: 'leess',
        name: '이승수',
        status: 'active',
        password_hash: sha256('pass1234'),
      },
      'doc_10537': {
        student_id: '10537',
        name: '다른학생',
        status: 'active',
        password_hash: sha256('pass1234'),
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

  // Own custom_id in room_id is allowed via account lookup and canonicalized to ROOM-10536
  const ownAltRes = createMockRes();
  await handler(
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: {
        action: 'send_chat_message',
        data: {
          room_id: 'ROOM-leess',
          sender_id: 'leess',
          sender_role: 'student',
          receiver_id: 'teacher_001',
          message: '커스텀 ID 방 테스트',
        },
      },
    },
    ownAltRes
  );
  assert.equal(ownAltRes.statusCode, 200);
  assert.equal(ownAltRes.body.item.room_id, 'ROOM-10536');
  assert.equal(ownAltRes.body.item.student_id, '10536');

  // Another student's room is strictly blocked with 403
  const otherRes = createMockRes();
  await handler(
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: {
        action: 'send_chat_message',
        data: {
          room_id: 'ROOM-10537',
          student_id: '10537',
          sender_id: '10536',
          sender_role: 'student',
          receiver_id: 'teacher_001',
          message: '타인 방 침입 시도',
        },
      },
    },
    otherRes
  );
  assert.equal(otherRes.statusCode, 403);
  assert.equal(otherRes.body.ok, false);
});

test('student account without student_id falls back to docId/remote_id consistently', async () => {
  const db = createMockDb({
    '계정_학생': {
      'stu_doc_99': {
        login_id: 'nodoc_stu',
        name: '미기재학생',
        status: 'active',
        password_hash: sha256('pass1234'),
      },
    },
  });
  activeMockDb = db;

  const loginRes = await _handleLogin(db, {
    role: 'student',
    user_id: 'nodoc_stu',
    password: 'pass1234',
  });
  assert.equal(loginRes.status, 200);
  const session = _verifyRequestSession({ auth_token: loginRes.json.token });
  assert.equal(_matchesSessionStudent(session, 'stu_doc_99'), true);
  assert.equal(await _matchesSessionStudentWithLookup(db, session, 'nodoc_stu'), true);
  assert.equal(await _matchesSessionStudentWithLookup(db, session, '10537'), false);
});

test('KST working hours evaluation treats weekday 09:57 KST as working hours regardless of host timezone', () => {
  // 2026-11-26 is Thursday. 09:57 KST === 00:57 UTC.
  const kstWeekday0957 = Date.UTC(2026, 10, 26, 0, 57, 0);
  const statusDefault = _getKstWorkingHoursStatus('', kstWeekday0957);
  assert.equal(statusDefault.isWorkingHours, true);
  assert.equal(statusDefault.isWeekday, true);
  assert.equal(statusDefault.reason, 'working');
  assert.equal(statusDefault.kstHour, 9);
  assert.equal(statusDefault.kstMinute, 57);
  assert.equal(statusDefault.rangeLabel, '09:00~17:00');

  // 08:59 KST (23:59 UTC previous day) -> before_hours
  const kstWeekday0859 = Date.UTC(2026, 10, 25, 23, 59, 0);
  const statusBefore = _getKstWorkingHoursStatus('09:00~17:00', kstWeekday0859);
  assert.equal(statusBefore.isWorkingHours, false);
  assert.equal(statusBefore.reason, 'before_hours');

  // 17:00 KST (08:00 UTC) -> after_hours
  const kstWeekday1700 = Date.UTC(2026, 10, 26, 8, 0, 0);
  const statusAfter = _getKstWorkingHoursStatus('09:00~17:00', kstWeekday1700);
  assert.equal(statusAfter.isWorkingHours, false);
  assert.equal(statusAfter.reason, 'after_hours');

  // 2026-11-28 is Saturday. 10:00 KST (01:00 UTC) -> weekend
  const kstSaturday1000 = Date.UTC(2026, 10, 28, 1, 0, 0);
  const statusWeekend = _getKstWorkingHoursStatus('09:00~17:00', kstSaturday1000);
  assert.equal(statusWeekend.isWorkingHours, false);
  assert.equal(statusWeekend.isWeekday, false);
  assert.equal(statusWeekend.reason, 'weekend');

  // Custom teacher consultation hours parsing
  const parsed = _parseConsultationHoursRange('평일 08:30 ~ 16:30');
  assert.equal(parsed.rangeLabel, '08:30~16:30');
  const kstWeekday1640 = Date.UTC(2026, 10, 26, 7, 40, 0);
  const statusCustomAfter = _getKstWorkingHoursStatus('평일 08:30 ~ 16:30', kstWeekday1640);
  assert.equal(statusCustomAfter.isWorkingHours, false);
  assert.equal(statusCustomAfter.reason, 'after_hours');
});
