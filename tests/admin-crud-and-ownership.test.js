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
        set(ref, data, opts = {}) { ops.push({ type: 'set', ref, data, opts }); },
        delete(ref) { ops.push({ type: 'delete', ref }); },
        async commit() {
          for (const op of ops) {
            if (op.type === 'set') await op.ref.set(op.data, op.opts);
            else if (op.type === 'delete') await op.ref.delete();
          }
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
              const prev = colMap.get(docId) || {};
              colMap.set(docId, opts.merge ? { ...prev, ...data } : { ...data });
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
        async get() {
          return makeQuery(colName).get();
        },
      };
    },
  };
}

async function callHandler(action, body = {}) {
  let statusCode = 200;
  let jsonBody = null;
  const req = {
    method: 'POST',
    query: {},
    body: { action, ...body },
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

function buildSeedDb() {
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
    },
    '계정_학생': {
      SC01_10501: {
        remote_id: 'SC01_10501',
        student_id: '10501',
        login_id: '10501',
        name: '홍길동',
        grade: 1,
        class_no: 5,
        student_no: 1,
        school_code: 'SC01',
        school_name: '에듀고',
        status: 'active',
      },
      SC01_20301: {
        remote_id: 'SC01_20301',
        student_id: '20301',
        login_id: '20301',
        name: '타반학생',
        grade: 2,
        class_no: 3,
        student_no: 1,
        school_code: 'SC01',
        school_name: '에듀고',
        status: 'active',
      },
    },
    '계정_학부모': {
      SC01_p10501: {
        remote_id: 'SC01_p10501',
        parent_id: 'p10501',
        login_id: 'p10501',
        name: '홍길동 학부모',
        student_id: '10501',
        student_name: '홍길동',
        grade: 1,
        class_no: 5,
        student_no: 1,
        school_code: 'SC01',
        school_name: '에듀고',
        status: 'active',
      },
    },
    '학급_공지게시판': {
      board_2_3: {
        remote_id: 'board_2_3',
        title: '2학년 3반 공지',
        content: '타반 공지입니다',
        teacher_id: 't_2_3',
        author_name: '이교사',
        grade: 2,
        class_no: 3,
        school_code: 'SC01',
        school_name: '에듀고',
      },
    },
    '가정통신문_목록': {
      notice_2_3: {
        remote_id: 'notice_2_3',
        title: '2-3 가정통신문',
        content: '타반 통신문',
        teacher_id: 't_2_3',
        author_name: '이교사',
        target_grade: 2,
        target_class: 3,
        school_code: 'SC01',
        school_name: '에듀고',
      },
    },
    '가정통신문_회신': {
      notice_2_3_20301: {
        remote_id: 'notice_2_3_20301',
        notice_id: 'notice_2_3',
        student_id: '20301',
        grade: 2,
        class_no: 3,
        school_code: 'SC01',
      },
    },
    '일일_출결': {
      att_1_5_unconf: {
        remote_id: 'att_1_5_unconf',
        student_id: '10501',
        student_name: '홍길동',
        grade: 1,
        class_no: 5,
        school_code: 'SC01',
        attendance_type: '질병결석',
        teacher_confirmed: false,
      },
      att_1_5_conf: {
        remote_id: 'att_1_5_conf',
        student_id: '10501',
        student_name: '홍길동',
        grade: 1,
        class_no: 5,
        school_code: 'SC01',
        attendance_type: '지각',
        teacher_confirmed: true,
      },
      att_2_3: {
        remote_id: 'att_2_3',
        student_id: '20301',
        student_name: '타반학생',
        grade: 2,
        class_no: 3,
        school_code: 'SC01',
        attendance_type: '결석',
        teacher_confirmed: false,
      },
    },
    '교과_출결': {
      subatt_t_2_3: {
        remote_id: 'subatt_t_2_3',
        teacher_id: 't_2_3',
        school_code: 'SC01',
        subject: '수학',
        student_id: '20301',
        status: '결석',
      },
    },
  });
}

const t15Auth = { auth_teacher_id: 't_1_5', auth_password_hash: sha256('pass15') };
const stu10501Token = handler._testHelpers._signSessionToken({ sub: '10501', role: 'student', sid: '10501', sc: 'SC01' }).token;

test('teacher ownership & auth checks block unauthenticated and cross-teacher mutations (401/403)', async () => {
  activeMockDb = buildSeedDb();

  // 1) Board notice: unauthenticated blocked (401), cross-class blocked (403)
  const unauthBoardUpsert = await callHandler('upsert_board_notice', { title: '무단 공지' });
  assert.equal(unauthBoardUpsert.status, 401);

  const unauthBoardDel = await callHandler('delete_board_notice', { remote_id: 'board_2_3' });
  assert.equal(unauthBoardDel.status, 401);

  const crossBoardUpsert = await callHandler('upsert_board_notice', {
    ...t15Auth,
    remote_id: 'board_2_3',
    title: '변조 시도',
  });
  assert.equal(crossBoardUpsert.status, 403);

  const crossBoardDel = await callHandler('delete_board_notice', {
    ...t15Auth,
    remote_id: 'board_2_3',
  });
  assert.equal(crossBoardDel.status, 403);

  // 2) Circular notices & replies: unauthenticated (401), cross-class (403)
  const unauthNotice = await callHandler('upsert_notice', { title: '무단 통신문' });
  assert.equal(unauthNotice.status, 401);

  const crossNoticeUpsert = await callHandler('upsert_notice', {
    ...t15Auth,
    remote_id: 'notice_2_3',
    title: '타반 수정',
  });
  assert.equal(crossNoticeUpsert.status, 403);

  const crossNoticePublish = await callHandler('publish_notice', {
    ...t15Auth,
    remote_id: 'notice_2_3',
    title: '타반 게시',
  });
  assert.equal(crossNoticePublish.status, 403);

  const crossNoticeMobile = await callHandler('publish_mobile_notice', {
    ...t15Auth,
    remote_id: 'notice_2_3',
    title: '타반 모바일',
  });
  assert.equal(crossNoticeMobile.status, 403);

  const crossNoticeDel = await callHandler('delete_notice', {
    ...t15Auth,
    remote_id: 'notice_2_3',
  });
  assert.equal(crossNoticeDel.status, 403);

  const crossRepliesFetch = await callHandler('fetch_notice_replies', {
    ...t15Auth,
    notice_id: 'notice_2_3',
  });
  assert.equal(crossRepliesFetch.status, 403);

  const crossReplyDel = await callHandler('delete_notice_reply', {
    ...t15Auth,
    remote_id: 'notice_2_3_20301',
  });
  assert.equal(crossReplyDel.status, 403);

  // 3) Subject attendance overwrite of another teacher's remote_id -> 403
  const crossSubAtt = await callHandler('save_subject_attendance_batch', {
    ...t15Auth,
    subject: '수학',
    class_label: '2학년 3반',
    records: [{ remote_id: 'subatt_t_2_3', student_id: '20301', status: '출석' }],
  });
  assert.equal(crossSubAtt.status, 403);

  // 4) Daily attendance delete: cross-class teacher -> 403, student confirmed -> blocked, student unconfirmed -> ok
  const crossAttDel = await callHandler('delete_attendance', {
    ...t15Auth,
    role: 'teacher',
    remote_id: 'att_2_3',
  });
  assert.equal(crossAttDel.status, 403);

  const stuConfDel = await callHandler('delete_attendance', {
    role: 'student',
    auth_token: stu10501Token,
    remote_id: 'att_1_5_conf',
  });
  assert.equal(stuConfDel.status, 200);
  assert.equal(stuConfDel.json.ok, false);

  const stuUnconfDel = await callHandler('delete_attendance', {
    role: 'student',
    auth_token: stu10501Token,
    remote_id: 'att_1_5_unconf',
  });
  assert.equal(stuUnconfDel.status, 200);
  assert.equal(stuUnconfDel.json.ok, true);
});

test('roster student single CRUD creates, updates (with parent sync), enforces class isolation, and deletes', async () => {
  activeMockDb = buildSeedDb();

  // Create new student + auto-created parent
  const createRes = await callHandler('admin_upsert_roster_student', {
    ...t15Auth,
    student_id: '10502',
    student_no: 2,
    name: '김영희',
    phone: '01012345678',
    create_parent: true,
  });
  assert.equal(createRes.status, 200);
  assert.equal(createRes.json.ok, true);
  assert.equal(createRes.json.remote_id, 'SC01_10502');
  assert.equal(createRes.json.parent_remote_id, 'SC01_p10502');

  const stuDoc = activeMockDb._store.get('계정_학생').get('SC01_10502');
  const parDoc = activeMockDb._store.get('계정_학부모').get('SC01_p10502');
  assert.equal(stuDoc.name, '김영희');
  assert.equal(stuDoc.phone, '010-1234-5678');
  assert.equal(parDoc.student_name, '김영희');
  assert.equal(parDoc.grade, 1);
  assert.equal(parDoc.class_no, 5);

  // Update existing student -> syncs linked parent
  const updateRes = await callHandler('admin_upsert_roster_student', {
    ...t15Auth,
    remote_id: 'SC01_10502',
    student_id: '10502',
    student_no: 12,
    name: '김영희개명',
    phone: '01099998888',
  });
  assert.equal(updateRes.status, 200);
  assert.equal(activeMockDb._store.get('계정_학생').get('SC01_10502').name, '김영희개명');
  assert.equal(activeMockDb._store.get('계정_학생').get('SC01_10502').student_no, 12);
  assert.equal(activeMockDb._store.get('계정_학부모').get('SC01_p10502').student_name, '김영희개명');

  // Cross-class edit & delete blocked (403)
  const crossEdit = await callHandler('admin_upsert_roster_student', {
    ...t15Auth,
    remote_id: 'SC01_20301',
    student_id: '20301',
    name: '변조',
  });
  assert.equal(crossEdit.status, 403);

  const crossDel = await callHandler('admin_delete_roster_student', {
    ...t15Auth,
    remote_id: 'SC01_20301',
  });
  assert.equal(crossDel.status, 403);

  // Delete own class student -> cleans up student & linked parent
  const delRes = await callHandler('admin_delete_roster_student', {
    ...t15Auth,
    remote_id: 'SC01_10502',
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.json.deleted, true);
  assert.deepEqual(delRes.json.deleted_parents, ['SC01_p10502']);
  assert.equal(activeMockDb._store.get('계정_학생').has('SC01_10502'), false);
  assert.equal(activeMockDb._store.get('계정_학부모').has('SC01_p10502'), false);
});

test('own teacher notice, reply delete, and board notice CRUD succeed', async () => {
  activeMockDb = buildSeedDb();

  // Notice create -> update -> reply delete -> notice delete
  const nCreate = await callHandler('upsert_notice', {
    ...t15Auth,
    title: '1-5 체험학습 안내',
    content: '안내문 본문',
    due_date: '2026-11-30',
  });
  assert.equal(nCreate.status, 200);
  const nid = nCreate.json.remote_id;

  const nUpdate = await callHandler('upsert_notice', {
    ...t15Auth,
    remote_id: nid,
    title: '1-5 체험학습 안내(수정)',
    content: '수정된 본문',
  });
  assert.equal(nUpdate.status, 200);
  assert.equal(activeMockDb._store.get('가정통신문_목록').get(nid).title, '1-5 체험학습 안내(수정)');

  // Seed a reply for 1-5 student and delete it
  await activeMockDb.collection('가정통신문_회신').doc(`${nid}_10501`).set({
    remote_id: `${nid}_10501`,
    notice_id: nid,
    student_id: '10501',
    grade: 1,
    class_no: 5,
    school_code: 'SC01',
  });
  const rDel = await callHandler('delete_notice_reply', {
    ...t15Auth,
    notice_id: nid,
    student_id: '10501',
  });
  assert.equal(rDel.status, 200);
  assert.equal(activeMockDb._store.get('가정통신문_회신').has(`${nid}_10501`), false);

  const nDel = await callHandler('delete_notice', { ...t15Auth, remote_id: nid });
  assert.equal(nDel.status, 200);
  assert.equal(activeMockDb._store.get('가정통신문_목록').has(nid), false);

  // Board notice create -> update -> delete
  const bCreate = await callHandler('upsert_board_notice', {
    ...t15Auth,
    title: '내일 준비물',
    content: '체육복 지참',
    is_pinned: true,
  });
  assert.equal(bCreate.status, 200);
  const bid = bCreate.json.remote_id;

  const bUpdate = await callHandler('upsert_board_notice', {
    ...t15Auth,
    remote_id: bid,
    title: '내일 준비물(수정)',
  });
  assert.equal(bUpdate.status, 200);
  assert.equal(activeMockDb._store.get('학급_공지게시판').get(bid).title, '내일 준비물(수정)');

  const bDel = await callHandler('delete_board_notice', { ...t15Auth, remote_id: bid });
  assert.equal(bDel.status, 200);
  assert.equal(activeMockDb._store.get('학급_공지게시판').has(bid), false);
});

test('admin/index.html and admin/admin.js wire up roster, notice, and board notice CRUD UI', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../admin/index.html'), 'utf8');
  const js = fs.readFileSync(path.resolve(__dirname, '../admin/admin.js'), 'utf8');

  assert.match(html, /id="roster-student-modal"/);
  assert.match(html, /id="notice-modal"/);
  assert.match(html, /id="board-notice-modal"/);
  assert.match(html, /openRosterStudentModal\(\)/);
  assert.match(html, /openNoticeModal\(\)/);
  assert.match(html, /openBoardNoticeModal\(\)/);

  assert.match(js, /admin_upsert_roster_student/);
  assert.match(js, /admin_delete_roster_student/);
  assert.match(js, /upsert_notice/);
  assert.match(js, /delete_notice/);
  assert.match(js, /delete_notice_reply/);
  assert.match(js, /upsert_board_notice/);
  assert.match(js, /delete_board_notice/);
  assert.match(js, /delete_subject_attendance/);
  assert.match(js, /update_chat_message/);
  assert.match(js, /delete_chat_message/);
  assert.match(js, /upsert_schedule/);
  assert.match(js, /delete_schedule/);

  assert.match(html, /id="tab-schedules"/);
  assert.match(html, /id="attendance-modal"/);
  assert.match(html, /id="doc-tracking-modal"/);
  assert.match(html, /id="subject-att-modal"/);
  assert.match(html, /id="schedule-modal"/);
  assert.match(html, /id="counsel-reply-form"/);
});

test('phase 2 teacher ownership checks block unauthenticated/cross-class attendance, docs, chat, profile, and schedules (401/403)', async () => {
  activeMockDb = buildSeedDb();
  await activeMockDb.collection('서류_추적').doc('doc_2_3').set({
    remote_id: 'doc_2_3',
    student_id: '20301',
    grade: 2,
    class_no: 3,
    school_code: 'SC01',
    doc_name: '진단서',
    status: 'pending',
  });
  await activeMockDb.collection('1:1_상담채팅').doc('chat_2_3_t').set({
    remote_id: 'chat_2_3_t',
    room_id: 'ROOM-20301',
    student_id: '20301',
    grade: 2,
    class_no: 3,
    school_code: 'SC01',
    teacher_id: 't_2_3',
    sender_role: 'teacher',
    message: '타반 교사 메시지',
  });
  await activeMockDb.collection('1:1_상담채팅').doc('chat_1_5_stu').set({
    remote_id: 'chat_1_5_stu',
    room_id: 'ROOM-10501',
    student_id: '10501',
    grade: 1,
    class_no: 5,
    school_code: 'SC01',
    sender_role: 'student',
    message: '학생 메시지',
  });
  await activeMockDb.collection('Schedules').doc('sched_2_3').set({
    remote_id: 'sched_2_3',
    title: '타반 개인일정',
    start_date: '2026-11-25',
    teacher_id: 't_2_3',
    school_code: 'SC01',
    is_private: true,
  });

  // Attendance & class attendance
  const crossSubmitAtt = await callHandler('submit_attendance', {
    ...t15Auth,
    role: 'teacher',
    student_id: '20301',
    grade: 2,
    class_no: 3,
    school_code: 'SC01',
    attendance_type: '결석',
  });
  assert.equal(crossSubmitAtt.status, 403);

  const studentSubmitAtt = await callHandler('submit_attendance', {
    role: 'student',
    auth_token: stu10501Token,
    student_id: '10501',
    student_name: '홍길동',
    attendance_type: '질병결석',
  });
  assert.equal(studentSubmitAtt.status, 200);
  assert.equal(studentSubmitAtt.json.ok, true);

  const unauthClassAtt = await callHandler('save_class_attendance', {
    date: '2026-11-20',
    records: [{ student_id: '10501', attendance_type: '출석' }],
  });
  assert.equal(unauthClassAtt.status, 401);

  const crossClassAtt = await callHandler('save_class_attendance', {
    ...t15Auth,
    date: '2026-11-20',
    records: [{ student_id: '20301', grade: 2, class_no: 3, school_code: 'SC01', attendance_type: '출석' }],
  });
  assert.equal(crossClassAtt.status, 403);

  // Document tracking
  const crossDocUpsert = await callHandler('upsert_document_tracking', {
    ...t15Auth,
    role: 'teacher',
    remote_id: 'doc_2_3',
    status: 'closed',
  });
  assert.equal(crossDocUpsert.status, 403);

  const crossDocDel = await callHandler('delete_document_tracking', {
    ...t15Auth,
    remote_id: 'doc_2_3',
  });
  assert.equal(crossDocDel.status, 403);

  // Subject attendance delete
  const crossSubDel = await callHandler('delete_subject_attendance', {
    ...t15Auth,
    remote_id: 'subatt_t_2_3',
  });
  assert.equal(crossSubDel.status, 403);

  // Chat & teacher profile
  const crossChatSend = await callHandler('send_chat_message', {
    ...t15Auth,
    sender_role: 'teacher',
    student_id: '20301',
    grade: 2,
    class_no: 3,
    school_code: 'SC01',
    message: '타반 전송',
  });
  assert.equal(crossChatSend.status, 403);

  const studentChatSend = await callHandler('send_chat_message', {
    sender_role: 'student',
    auth_token: stu10501Token,
    student_id: '10501',
    message: '학생 질문입니다',
  });
  assert.equal(studentChatSend.status, 200);

  const crossChatUpd = await callHandler('update_chat_message', {
    ...t15Auth,
    remote_id: 'chat_2_3_t',
    message: '변조',
  });
  assert.equal(crossChatUpd.status, 403);

  const stuMsgDelAttempt = await callHandler('delete_chat_message', {
    ...t15Auth,
    remote_id: 'chat_1_5_stu',
  });
  assert.equal(stuMsgDelAttempt.status, 403);

  const crossConsultStatus = await callHandler('set_consultation_status', {
    ...t15Auth,
    teacher_id: 't_2_3',
    consultation_enabled: false,
  });
  assert.equal(crossConsultStatus.status, 403);

  const crossProfileUpsert = await callHandler('upsert_teacher_profile', {
    ...t15Auth,
    teacher_id: 't_2_3',
    name: '변조교사',
  });
  assert.equal(crossProfileUpsert.status, 403);

  // Schedules
  const crossSchedUpsert = await callHandler('upsert_schedule', {
    ...t15Auth,
    remote_id: 'sched_2_3',
    title: '변조 일정',
    start_date: '2026-11-25',
  });
  assert.equal(crossSchedUpsert.status, 403);

  const crossSchedDel = await callHandler('delete_schedule', {
    ...t15Auth,
    remote_id: 'sched_2_3',
  });
  assert.equal(crossSchedDel.status, 403);
});

test('phase 2 own teacher CRUD for doc tracking, subject attendance, chat, and schedules succeed', async () => {
  activeMockDb = buildSeedDb();

  // Own doc tracking create -> delete
  const docRes = await callHandler('upsert_document_tracking', {
    ...t15Auth,
    role: 'teacher',
    student_id: '10501',
    student_name: '홍길동',
    doc_name: '체험학습 신청서',
    due_date: '2026-11-28',
  });
  assert.equal(docRes.status, 200);
  const docDel = await callHandler('delete_document_tracking', { ...t15Auth, remote_id: docRes.json.remote_id });
  assert.equal(docDel.status, 200);

  // Own subject attendance create -> delete
  const subRes = await callHandler('save_subject_attendance_batch', {
    ...t15Auth,
    date: '2026-11-20',
    period: '3',
    subject: '통과2',
    class_label: '1학년 5반',
    records: [{ student_id: '10501', student_name: '홍길동', status: '출석' }],
  });
  assert.equal(subRes.status, 200);
  const subRid = subRes.json.items[0].remote_id;
  const subDel = await callHandler('delete_subject_attendance', { ...t15Auth, remote_id: subRid });
  assert.equal(subDel.status, 200);

  // Own chat send -> update -> delete
  const chatRes = await callHandler('send_chat_message', {
    ...t15Auth,
    sender_role: 'teacher',
    student_id: '10501',
    message: '상담 답변입니다.',
  });
  assert.equal(chatRes.status, 200);
  const chatRid = chatRes.json.remote_id;

  const chatUpd = await callHandler('update_chat_message', {
    ...t15Auth,
    remote_id: chatRid,
    message: '수정된 답변입니다.',
  });
  assert.equal(chatUpd.status, 200);
  assert.equal(activeMockDb._store.get('1:1_상담채팅').get(chatRid).message, '수정된 답변입니다.');

  const chatDel = await callHandler('delete_chat_message', { ...t15Auth, remote_id: chatRid });
  assert.equal(chatDel.status, 200);
  assert.equal(activeMockDb._store.get('1:1_상담채팅').has(chatRid), false);

  // Own schedule create -> update -> delete
  const schedRes = await callHandler('upsert_schedule', {
    ...t15Auth,
    title: '1-5 학급회의',
    start_date: '2026-11-26',
    is_private: false,
  });
  assert.equal(schedRes.status, 200);
  const schedRid = schedRes.json.remote_id;

  const schedUpd = await callHandler('upsert_schedule', {
    ...t15Auth,
    remote_id: schedRid,
    title: '1-5 학급회의(변경)',
    start_date: '2026-11-27',
  });
  assert.equal(schedUpd.status, 200);
  assert.equal(activeMockDb._store.get('Schedules').get(schedRid).title, '1-5 학급회의(변경)');

  const schedDel = await callHandler('delete_schedule', { ...t15Auth, remote_id: schedRid });
  assert.equal(schedDel.status, 200);
  assert.equal(activeMockDb._store.get('Schedules').has(schedRid), false);
});
