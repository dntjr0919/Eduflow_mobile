const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

function sha256(val) {
  return crypto.createHash('sha256').update(String(val || ''), 'utf8').digest('hex');
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
  exports: {
    uploadBase64ToDrive: async () => ({ ok: true, fileId: 'mock_file_1', viewUrl: 'https://drive.google.com/file/d/mock_file_1/view' }),
  },
};

const pushCalls = [];
const origResolveFilename = Module._resolveFilename;
const mockWebPushId = '__mock_web_push__';
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'web-push') {
    try {
      return origResolveFilename.call(this, request, parent, isMain, options);
    } catch (_) {
      return mockWebPushId;
    }
  }
  return origResolveFilename.call(this, request, parent, isMain, options);
};
let resolvedWebPushKey;
try {
  resolvedWebPushKey = require.resolve('web-push');
} catch (_) {
  resolvedWebPushKey = mockWebPushId;
}
require.cache[resolvedWebPushKey] = {
  id: resolvedWebPushKey,
  filename: resolvedWebPushKey,
  loaded: true,
  exports: {
    setVapidDetails() {},
    async sendNotification(sub, payload) {
      pushCalls.push({ sub, payload });
      return { statusCode: 201 };
    },
  },
};

const handler = require('../api/firestore.js');
const { _testHelpers } = handler;
const {
  _signSessionToken,
  _handleGetMobileBundle,
  _handleLogin,
  _verifyPassword,
  _verifyActiveTeacherAuth,
} = _testHelpers;

const pushHandler = require('../api/push.js');

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

  function makeQuery(colName, filters = [], orders = [], maxLimit = null) {
    return {
      where(field, op, val) {
        return makeQuery(colName, [...filters, { field, op, val }], orders, maxLimit);
      },
      orderBy(field, dir = 'asc') {
        return makeQuery(colName, filters, [...orders, { field, dir }], maxLimit);
      },
      limit(n) {
        return makeQuery(colName, filters, orders, n);
      },
      async get() {
        const colMap = getColMap(colName);
        let rows = [];
        for (const [docId, doc] of colMap.entries()) {
          let ok = true;
          for (const f of filters) {
            const v = doc[f.field];
            if (f.op === '==' && v !== f.val) { ok = false; break; }
            if (f.op === '!=' && v === f.val) { ok = false; break; }
            if (f.op === '>=' && !(v >= f.val)) { ok = false; break; }
            if (f.op === '<=' && !(v <= f.val)) { ok = false; break; }
            if (f.op === 'in' && (!Array.isArray(f.val) || !f.val.includes(v))) { ok = false; break; }
          }
          if (ok) rows.push([docId, doc]);
        }
        if (orders.length > 0) {
          rows.sort((a, b) => {
            for (const o of orders) {
              const av = a[1][o.field] ?? '';
              const bv = b[1][o.field] ?? '';
              if (av !== bv) {
                return (av < bv ? -1 : 1) * (o.dir === 'desc' ? -1 : 1);
              }
            }
            return 0;
          });
        }
        if (typeof maxLimit === 'number' && maxLimit >= 0) {
          rows = rows.slice(0, maxLimit);
        }
        const docs = rows.map(([docId, data]) => makeSnap(docId, data));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach(cb) {
            docs.forEach(cb);
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
          const resolvedId = docId || `auto_${crypto.randomBytes(4).toString('hex')}`;
          return {
            id: resolvedId,
            async get() {
              const colMap = getColMap(colName);
              return makeSnap(resolvedId, colMap.get(resolvedId));
            },
            async set(data, opts = {}) {
              const colMap = getColMap(colName);
              if (opts && opts.merge && colMap.has(resolvedId)) {
                colMap.set(resolvedId, { ...colMap.get(resolvedId), ...data });
              } else {
                colMap.set(resolvedId, { ...data });
              }
            },
            async update(data) {
              const colMap = getColMap(colName);
              colMap.set(resolvedId, { ...(colMap.get(resolvedId) || {}), ...data });
            },
            async delete() {
              getColMap(colName).delete(resolvedId);
            },
          };
        },
        where(field, op, val) {
          return makeQuery(colName, [{ field, op, val }]);
        },
        orderBy(field, dir = 'asc') {
          return makeQuery(colName, [], [{ field, dir }]);
        },
        limit(n) {
          return makeQuery(colName, [], [], n);
        },
        async get() {
          return makeQuery(colName).get();
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) { ops.push(() => ref.set(data, opts)); },
        update(ref, data) { ops.push(() => ref.update(data)); },
        delete(ref) { ops.push(() => ref.delete()); },
        async commit() {
          for (const op of ops) await op();
        },
      };
    },
  };
}

async function callHandler(action, body = {}, method = 'POST', headers = {}) {
  let statusCode = 200;
  let jsonBody = null;
  const isGet = method.toUpperCase() === 'GET';
  const req = {
    method: method.toUpperCase(),
    headers,
    query: isGet ? { action, ...body } : {},
    body: isGet ? undefined : { action, ...body },
  };
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return {
        json(obj) { jsonBody = obj; return obj; },
        end() { return null; },
      };
    },
  };
  await handler(req, res);
  return { status: statusCode, json: jsonBody };
}

async function callPushHandler(body = {}, headers = {}) {
  let statusCode = 200;
  let jsonBody = null;
  const req = { method: 'POST', headers, body };
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return {
        json(obj) { jsonBody = obj; return obj; },
        end() { return null; },
      };
    },
  };
  await pushHandler(req, res);
  return { status: statusCode, json: jsonBody };
}

function buildSecuritySeedDb() {
  return createMockDb({
    '계정_교사': {
      t_1_5: {
        remote_id: 't_1_5',
        teacher_id: 't_1_5',
        login_id: 't_1_5',
        name: '김교사',
        school_code: 'SC01',
        school_name: '에듀고',
        grade: 1,
        class_no: 5,
        status: 'active',
        password_hash: sha256('pass15'),
      },
      t_2_3: {
        remote_id: 't_2_3',
        teacher_id: 't_2_3',
        login_id: 't_2_3',
        name: '이교사',
        school_code: 'SC01',
        school_name: '에듀고',
        grade: 2,
        class_no: 3,
        status: 'active',
        password_hash: sha256('pass23'),
      },
      t_empty_pw: {
        remote_id: 't_empty_pw',
        teacher_id: 't_empty_pw',
        login_id: 't_empty_pw',
        name: '빈비번교사',
        school_code: 'SC01',
        school_name: '에듀고',
        grade: 1,
        class_no: 6,
        status: 'active',
        password_hash: '',
      },
    },
    '계정_학생': {
      '10501': {
        remote_id: '10501',
        student_id: '10501',
        login_id: '10501',
        name: '홍길동',
        grade: 1,
        class_no: 5,
        school_code: 'SC01',
        school_name: '에듀고',
        status: 'active',
        password_hash: sha256('stupw1'),
      },
      '10502': {
        remote_id: '10502',
        student_id: '10502',
        login_id: '10502',
        name: '박철수',
        grade: 1,
        class_no: 5,
        school_code: 'SC01',
        school_name: '에듀고',
        status: 'active',
        password_hash: sha256('stupw2'),
      },
      'pending_stu': {
        remote_id: 'pending_stu',
        student_id: '10509',
        login_id: 'pending_stu',
        name: '신규생',
        grade: 1,
        class_no: 5,
        school_code: 'SC01',
        school_name: '에듀고',
        status: 'pending',
        password_hash: sha256('wait1'),
      },
    },
    '일일_출결': {
      att_1_5: {
        remote_id: 'att_1_5',
        student_id: '10501',
        student_name: '홍길동',
        grade: 1,
        class_no: 5,
        school_code: 'SC01',
        attendance_type: '질병결석',
        teacher_confirmed: false,
      },
    },
    '서류_추적': {
      doc_1_5: {
        remote_id: 'doc_1_5',
        student_id: '10501',
        student_name: '홍길동',
        grade: 1,
        class_no: 5,
        school_code: 'SC01',
        doc_type: '질병결석계',
        status: 'pending',
      },
    },
    'Push_Subscriptions': {
      sub_10501: {
        endpoint: 'https://push.example/1',
        role: 'student',
        user_id: '10501',
        student_id: '10501',
        school_code: 'SC01',
        p256dh: 'k1',
        auth: 'a1',
        keys: { p256dh: 'k1', auth: 'a1' },
      },
    },
  });
}

test('_handleGetMobileBundle strips password_hash from teachers and students', async () => {
  const db = buildSecuritySeedDb();
  const studentBundle = await _handleGetMobileBundle(db, {
    role: 'student',
    user_id: '10501',
    student_id: '10501',
    grade: '1',
    class_no: '5',
    school_code: 'SC01',
    force_refresh: '1',
  });
  assert.equal(studentBundle.status, 200);
  assert.ok(Array.isArray(studentBundle.json.teachers));
  for (const t of studentBundle.json.teachers) {
    assert.equal('password_hash' in t, false);
  }
  for (const s of (studentBundle.json.students || [])) {
    assert.equal('password_hash' in s, false);
  }

  const teacherBundle = await _handleGetMobileBundle(db, {
    role: 'teacher',
    user_id: 't_1_5',
    grade: '1',
    class_no: '5',
    school_code: 'SC01',
    force_refresh: '1',
  });
  assert.equal(teacherBundle.status, 200);
  assert.ok(teacherBundle.json.students.length > 0);
  for (const t of teacherBundle.json.teachers) {
    assert.equal('password_hash' in t, false);
  }
  for (const s of teacherBundle.json.students) {
    assert.equal('password_hash' in s, false);
  }
});

test('_verifyPassword rejects empty storedHash and Pass-the-Hash on login while preserving PC app fallback', async () => {
  assert.equal(_verifyPassword('', 'anything'), false);
  assert.equal(_verifyPassword('', ''), false);

  const hash = sha256('secret123');
  assert.equal(_verifyPassword(hash, '', hash), false);
  assert.equal(_verifyPassword(hash, '', hash, { allowProvidedHash: true }), true);

  const db = buildSecuritySeedDb();
  const emptyPwLogin = await _handleLogin(db, { role: 'teacher', user_id: 't_empty_pw', password: '' });
  assert.equal(emptyPwLogin.status, 401);

  const pthLogin = await _handleLogin(db, { role: 'teacher', user_id: 't_1_5', password_hash: sha256('pass15') });
  assert.equal(pthLogin.status, 401);

  const pcFallback = await _verifyActiveTeacherAuth(db, {
    auth_teacher_id: 't_1_5',
    auth_password_hash: sha256('pass15'),
  });
  assert.equal(pcFallback.ok, true);
  assert.equal(pcFallback.teacherId, 't_1_5');
});

test('HTTP handler enforces session token, role, and ownership across student/teacher/push endpoints', async () => {
  activeMockDb = buildSecuritySeedDb();
  const stu10501Token = _signSessionToken({ sub: '10501', role: 'student', sid: '10501', sc: 'SC01' }).token;
  const stu10502Token = _signSessionToken({ sub: '10502', role: 'student', sid: '10502', sc: 'SC01' }).token;
  const t23Token = _signSessionToken({ sub: 't_2_3', role: 'teacher', sc: 'SC01' }).token;

  // get_mobile_bundle
  assert.equal((await callHandler('get_mobile_bundle', { role: 'teacher', user_id: 't_1_5', school_code: 'SC01' }, 'GET')).status, 401);
  assert.equal((await callHandler('get_mobile_bundle', { role: 'teacher', user_id: 't_1_5', school_code: 'SC01', auth_token: stu10501Token }, 'GET')).status, 403);
  assert.equal((await callHandler('get_mobile_bundle', { role: 'student', user_id: '10501', student_id: '10501', school_code: 'SC01', auth_token: stu10502Token }, 'GET')).status, 403);

  // Teacher/admin-only actions reject unauthenticated (401) & student tokens (403)
  assert.equal((await callHandler('get_pending_registrations', {})).status, 401);
  assert.equal((await callHandler('get_pending_registrations', { auth_token: stu10501Token })).status, 403);

  assert.equal((await callHandler('review_registration', { target_role: 'student', remote_id: 'pending_stu', decision: 'approve' })).status, 401);
  assert.equal((await callHandler('review_registration', { target_role: 'student', remote_id: 'pending_stu', decision: 'approve', auth_token: stu10501Token })).status, 403);
  assert.equal((await callHandler('review_registration', { target_role: 'student', remote_id: 'pending_stu', decision: 'approve', auth_token: t23Token })).status, 403);

  assert.equal((await callHandler('confirm_attendance', { remote_id: 'att_1_5' })).status, 401);
  assert.equal((await callHandler('confirm_attendance', { remote_id: 'att_1_5', auth_token: stu10501Token })).status, 403);

  assert.equal((await callHandler('confirm_document', { remote_id: 'doc_1_5' })).status, 401);
  assert.equal((await callHandler('confirm_document', { remote_id: 'doc_1_5', auth_token: stu10501Token })).status, 403);

  assert.equal((await callHandler('upsert_document_tracking', { role: 'student', student_id: '10501', remote_id: 'doc_1_5', status: 'closed' })).status, 401);
  assert.equal((await callHandler('upsert_document_tracking', { role: 'student', student_id: '10501', remote_id: 'doc_1_5', status: 'closed', auth_token: stu10501Token })).status, 403);
  assert.equal((await callHandler('upsert_document_tracking', { role: 'student', student_id: '10501', remote_id: 'doc_1_5', status: 'submitted', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('upsert_doc_rule', { title: '새서류' })).status, 401);
  assert.equal((await callHandler('upsert_doc_rule', { title: '새서류', auth_token: stu10501Token })).status, 403);

  assert.equal((await callHandler('enqueue_remote_task', { teacher_id: 't_1_5', task_type: 'comcigan_sync', title: 'sync' })).status, 401);
  assert.equal((await callHandler('enqueue_remote_task', { teacher_id: 't_1_5', task_type: 'comcigan_sync', title: 'sync', auth_token: stu10501Token })).status, 403);

  assert.equal((await callHandler('send_notification', { title: '공지', message: '테스트' })).status, 401);
  assert.equal((await callHandler('send_notification', { title: '공지', message: '테스트', auth_token: stu10501Token })).status, 403);

  assert.equal((await callHandler('upload_file', { student_id: '10501', file_name: 'a.txt', data_url: 'data:text/plain;base64,QQ==' })).status, 401);
  assert.equal((await callHandler('upload_file', { student_id: '10501', file_name: 'a.txt', data_url: 'data:text/plain;base64,QQ==', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('sync_neis_meals', { school_code: 'SC01', school_name: '에듀고' })).status, 401);
  assert.equal((await callHandler('sync_neis_meals', { school_code: 'SC01', school_name: '에듀고', auth_token: stu10501Token })).status, 403);

  // Student-owned endpoints reject unauthenticated (401) & cross-student (403)
  assert.equal((await callHandler('change_custom_id', { role: 'student', user_id: '10501', new_custom_id: 'hong105' })).status, 401);
  assert.equal((await callHandler('change_custom_id', { role: 'student', user_id: '10501', new_custom_id: 'hong105', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('update_my_phone', { role: 'student', user_id: '10501', phone: '01012345678' })).status, 401);
  assert.equal((await callHandler('update_my_phone', { role: 'student', user_id: '10501', phone: '01012345678', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('submit_attendance', { role: 'student', student_id: '10501', attendance_type: '결석' })).status, 401);
  assert.equal((await callHandler('submit_attendance', { role: 'student', student_id: '10501', attendance_type: '결석', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('delete_attendance', { role: 'student', remote_id: 'att_1_5' })).status, 401);
  assert.equal((await callHandler('delete_attendance', { role: 'student', remote_id: 'att_1_5', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('submit_notice_reply', { notice_id: 'n1', student_id: '10501', answer_status: '동의' })).status, 401);
  assert.equal((await callHandler('submit_notice_reply', { notice_id: 'n1', student_id: '10501', answer_status: '동의', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('send_chat_message', { sender_role: 'student', student_id: '10501', message: '안녕' })).status, 401);
  assert.equal((await callHandler('send_chat_message', { sender_role: 'student', student_id: '10501', message: '안녕', auth_token: stu10502Token })).status, 403);

  assert.equal((await callHandler('mark_chat_read', { reader_role: 'student', student_id: '10501', room_id: 'ROOM-10501' })).status, 401);
  assert.equal((await callHandler('mark_chat_read', { reader_role: 'student', student_id: '10501', room_id: 'ROOM-10501', auth_token: stu10502Token })).status, 403);

  // POST /api/push
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = 'test-pub-key';
  process.env.VAPID_PRIVATE_KEY = 'test-priv-key';
  try {
    pushCalls.length = 0;
    assert.equal((await callPushHandler({ title: '무단 푸시', target_role: 'all' })).status, 401);
    assert.equal((await callPushHandler({ title: '전체 발송 시도', target_role: 'all', auth_token: stu10501Token })).status, 403);
    const selfPush = await callPushHandler({
      title: '내 기기 테스트',
      target_role: 'student',
      target_user_id: '10501',
      target_student_id: '10501',
      endpoint: 'https://push.example/1',
      auth_token: stu10501Token,
    });
    assert.equal(selfPush.status, 200);
    assert.equal(selfPush.json.ok, true);
    assert.equal(pushCalls.length, 1);
  } finally {
    if (prevPub === undefined) delete process.env.VAPID_PUBLIC_KEY; else process.env.VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.VAPID_PRIVATE_KEY; else process.env.VAPID_PRIVATE_KEY = prevPriv;
  }
});

test('teacher.js renderTeacherHome escapes Stored XSS in attendance names, reasons, periodInfo, and onclick attributes', () => {
  const teacherSrc = fs.readFileSync(path.resolve(__dirname, '../teacher.js'), 'utf8');
  const elements = new Map();
  const makeEl = (id) => ({
    id,
    innerHTML: '',
    innerText: '',
    className: '',
    checked: false,
    classList: { toggle() {}, add() {}, remove() {} },
    querySelectorAll: () => [],
  });
  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {},
  };

  const escapeHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const xssName = "<img src=x onerror=alert('n')>";
  const xssReason = "<script>alert(1)</script>";
  const xssId = "att');alert(9);//";

  const ctx = {
    console,
    Date,
    Math,
    Map,
    Set,
    Array,
    String,
    Number,
    Boolean,
    Object,
    JSON,
    encodeURIComponent,
    document: documentStub,
    window: {},
    localStorage: { getItem: () => null, setItem() {} },
    gasApi: {
      isConfigured: () => false,
      get: async () => ({ ok: true, items: [] }),
      post: async () => ({ ok: true }),
    },
    escapeHtml,
    sanitizeUrl: (u) => u,
    formatLocalDate: () => '2026-11-24',
    _getLocalTodayStr: () => '2026-11-24',
    renderTodayMealCard() {},
    renderTeacherSubjectClasses() {},
    renderTeacherTimetable() {},
    renderTeacherDocs() {},
    renderTeacherCirculars() {},
    renderTeacherBoardNotices() {},
    renderTeacherUpcomingSchedules() {},
    loadPendingRegistrationsBadge: null,
    mockData: {
      isCounselingOpen: true,
      currentUser: { userId: 't_1_5', gradeClass: '1학년 5반' },
      students: [{ studentId: '10501', name: xssName }],
      teacherSchedule: [],
      homeroomSchedule: [],
      meals: {},
      teacherUnconfirmedAttendance: [
        {
          id: xssId,
          studentId: '10501',
          name: xssName,
          type: '질병외출<svg onload=alert(2)>',
          periodInfo: '2~3교시<b>x</b>',
          reason: xssReason,
          confirmed: false,
          date: '2026-11-23',
        },
      ],
      teacherTodayAttendance: [
        {
          id: xssId,
          studentId: '10501',
          name: xssName,
          type: '질병외출<svg onload=alert(2)>',
          periodInfo: '2~3교시<b>x</b>',
          reason: xssReason,
          confirmed: false,
          date: '2026-11-24',
        },
        {
          id: xssId,
          studentId: '10502',
          name: xssName,
          type: '질병결석<svg onload=alert(3)>',
          periodInfo: '',
          reason: xssReason,
          confirmed: true,
          date: '2026-11-24',
        },
      ],
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(teacherSrc, ctx);
  ctx.renderTeacherHome();

  const bannerHtml = documentStub.getElementById('teacherUnconfirmedAttBanner').innerHTML;
  const liveHtml = documentStub.getElementById('teacherLiveAttList').innerHTML;
  for (const html of [bannerHtml, liveHtml]) {
    assert.doesNotMatch(html, /<img src=x|<script>alert|<svg onload|<b>x<\/b>/i);
    assert.match(html, /&lt;img src=x onerror=alert\(&#39;n&#39;\)&gt;/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(html.includes("confirmTeacherAtt('att\\&#39;);alert(9);//', this)"));
  }
});

test('admin/admin.js escapes JS string attributes with _escapeJsAttr across all onclick handlers', () => {
  const adminSrc = fs.readFileSync(path.resolve(__dirname, '../admin/admin.js'), 'utf8');
  const onclickCallsUsingBareEscapeHtml = adminSrc.match(/onclick="[^"]*escapeHtml\(/g) || [];
  assert.equal(onclickCallsUsingBareEscapeHtml.length, 0);

  const fnMatch = adminSrc.match(/function _escapeJsAttr\(val\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, '_escapeJsAttr must exist in admin/admin.js');
  const sandbox = {
    String,
    escapeHtml: (str) => String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  };
  vm.runInNewContext(fnMatch[0], sandbox);
  const escaped = sandbox._escapeJsAttr("a'b\\c\n<img src=x>");
  assert.equal(escaped.includes("'"), false);
  assert.equal(escaped.includes('<'), false);
  assert.ok(escaped.includes('\\\\'));
  assert.ok(escaped.includes('\\&#39;'));
});
