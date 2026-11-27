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

const googleDriveCalls = [];
const googleDriveMockExports = {
  extractDriveFileId(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    const q = s.match(/[?&]id=([A-Za-z0-9_-]{10,128})/);
    if (q) return q[1];
    const f = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,128})/);
    if (f) return f[1];
    if (/^[A-Za-z0-9_-]{10,128}$/.test(s)) return s;
    return '';
  },
  async downloadDriveFileBytes(fileId) {
    googleDriveCalls.push(fileId);
    return {
      ok: true,
      fileId,
      file_id: fileId,
      fileName: 'notice.pdf',
      mimeType: 'application/pdf',
      mime_type: 'application/pdf',
      size: 9,
      base64: Buffer.from('%PDF-1.4\n').toString('base64'),
    };
  },
};

const googleDrivePath = path.resolve(__dirname, '../api/_googleDrive.js');
require.cache[googleDrivePath] = {
  id: googleDrivePath,
  filename: googleDrivePath,
  loaded: true,
  exports: googleDriveMockExports,
};

const { _testHelpers } = require('../api/firestore.js');
const { _handleDesktopApiAction } = _testHelpers;

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
      orderBy() {
        return makeQuery(colName, filters, maxLimit);
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
      const base = makeQuery(colName);
      return {
        ...base,
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
      };
    },
  };
}

const authT1 = {
  ok: true,
  teacherId: 't_001',
  schoolCode: 'S100',
  comciganSchoolCode: '100',
  schoolName: '한빛고등학교',
  gradeNum: 1,
  classNum: 2,
  teacherDoc: { teacher_id: 't_001', name: '김교사', school_code: 'S100', grade: 1, class_no: 2 },
};

test('fetch_published_notices returns own and unassigned class notices sorted newest-first and excludes other teachers/schools', async () => {
  const db = createMockDb({
    가정통신문_목록: {
      n_own_old: {
        remote_id: 'n_own_old',
        title: '이전 본인 공지',
        teacher_id: 't_001',
        school_code: 'S100',
        target_grade: 1,
        target_class: 2,
        is_published: true,
        created_at: '2026-11-20 09:00:00',
      },
      n_own_new: {
        remote_id: 'n_own_new',
        title: '최신 본인 공지',
        teacher_id: 't_001',
        school_code: 'S100',
        target_grade: 1,
        target_class: 2,
        is_published: true,
        created_at: '2026-11-27 10:00:00',
      },
      n_class_legacy: {
        remote_id: 'n_class_legacy',
        title: '학급 공용 공지(teacher_id 없음)',
        school_code: 'S100',
        target_grade: 1,
        target_class: 2,
        is_published: true,
        created_at: '2026-11-25 10:00:00',
      },
      n_other_teacher_same_class: {
        remote_id: 'n_other_teacher_same_class',
        title: '타 교사 소유 공지',
        teacher_id: 't_002',
        school_code: 'S100',
        target_grade: 1,
        target_class: 2,
        is_published: true,
        created_at: '2026-11-27 12:00:00',
      },
      n_other_school: {
        remote_id: 'n_other_school',
        title: '타 학교 공지',
        teacher_id: 't_999',
        school_code: 'S999',
        target_grade: 1,
        target_class: 2,
        is_published: true,
        created_at: '2026-11-27 12:00:00',
      },
      n_draft: {
        remote_id: 'n_draft',
        title: '미게시 초안',
        teacher_id: 't_001',
        school_code: 'S100',
        target_grade: 1,
        target_class: 2,
        is_published: false,
        created_at: '2026-11-27 13:00:00',
      },
    },
  });

  const res = await _handleDesktopApiAction(db, 'fetch_published_notices', { limit: 2 }, authT1);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(
    res.json.notices.map((n) => n.remote_id),
    ['n_own_new', 'n_class_legacy']
  );
});

test('fetch_notice_detail and update_notice_pdf_field_map enforce ownership and update field map & reply schema', async () => {
  const db = createMockDb({
    가정통신문_목록: {
      n_1: {
        remote_id: 'n_1',
        title: '현장체험학습 안내',
        teacher_id: 't_001',
        school_code: 'S100',
        target_grade: 1,
        target_class: 2,
        drive_file_id: '1AbCdEfGhIjKlMnOpQrSt',
      },
      n_other: {
        remote_id: 'n_other',
        title: '타 교사 공지',
        teacher_id: 't_002',
        school_code: 'S100',
        target_grade: 1,
        target_class: 2,
      },
    },
  });

  const detailOk = await _handleDesktopApiAction(db, 'fetch_notice_detail', { notice_id: 'n_1' }, authT1);
  assert.equal(detailOk.status, 200);
  assert.equal(detailOk.json.ok, true);
  assert.equal(detailOk.json.notice.remote_id, 'n_1');

  const detailBlocked = await _handleDesktopApiAction(db, 'fetch_notice_detail', { notice_id: 'n_other' }, authT1);
  assert.equal(detailBlocked.status, 403);
  assert.equal(detailBlocked.json.ok, false);

  const detailMissing = await _handleDesktopApiAction(db, 'fetch_notice_detail', { notice_id: 'n_none' }, authT1);
  assert.equal(detailMissing.status, 404);

  const fieldMap = [{ name: 'agree', x: 120, y: 340, page: 1 }];
  const replySchema = [{ name: 'agree', label: '참가 여부', type: 'radio', options: ['참가', '불참'] }];
  const updOk = await _handleDesktopApiAction(db, 'update_notice_pdf_field_map', {
    notice_id: 'n_1',
    pdf_field_map: fieldMap,
    reply_schema: replySchema,
  }, authT1);
  assert.equal(updOk.status, 200);
  assert.equal(updOk.json.ok, true);

  const saved = db._store.get('가정통신문_목록').get('n_1');
  assert.deepEqual(saved.pdf_field_map, fieldMap);
  assert.equal(saved.pdf_field_map_json, JSON.stringify(fieldMap));
  assert.deepEqual(saved.reply_schema, replySchema);
  assert.equal(saved.reply_schema_json, JSON.stringify(replySchema));

  const updBlocked = await _handleDesktopApiAction(db, 'update_notice_pdf_field_map', {
    notice_id: 'n_other',
    pdf_field_map: fieldMap,
  }, authT1);
  assert.equal(updBlocked.status, 403);
});

test('download_drive_file verifies notice attachment scope and returns base64 + mime_type', async () => {
  googleDriveCalls.length = 0;
  const allowedFileId = '1AbCdEfGhIjKlMnOpQrSt';
  const otherFileId = '9ZyXwVuTsRqPoNmLkJiHg';
  const db = createMockDb({
    가정통신문_목록: {
      n_1: {
        remote_id: 'n_1',
        teacher_id: 't_001',
        school_code: 'S100',
        attachment_url: `https://drive.google.com/file/d/${allowedFileId}/view`,
      },
      n_other: {
        remote_id: 'n_other',
        teacher_id: 't_002',
        school_code: 'S100',
        attachment_url: `https://drive.google.com/file/d/${otherFileId}/view`,
      },
    },
  });

  const dlOk = await _handleDesktopApiAction(db, 'download_drive_file', { file_id: allowedFileId }, authT1);
  assert.equal(dlOk.status, 200);
  assert.equal(dlOk.json.ok, true);
  assert.equal(dlOk.json.mime_type, 'application/pdf');
  assert.equal(Buffer.from(dlOk.json.base64, 'base64').toString('utf8'), '%PDF-1.4\n');
  assert.deepEqual(googleDriveCalls, [allowedFileId]);

  const dlBlockedOther = await _handleDesktopApiAction(db, 'download_drive_file', { file_id: otherFileId }, authT1);
  assert.equal(dlBlockedOther.status, 403);
  assert.equal(dlBlockedOther.json.ok, false);

  const dlBlockedNoticeMismatch = await _handleDesktopApiAction(db, 'download_drive_file', {
    notice_id: 'n_1',
    file_id: otherFileId,
  }, authT1);
  assert.equal(dlBlockedNoticeMismatch.status, 403);
});

test('googleDrive.downloadDriveFileBytes passes supportsAllDrives: true and returns base64 + mime_type', async () => {
  const realDrivePath = path.resolve(__dirname, '../api/_googleDrive.js');
  delete require.cache[realDrivePath];
  const realDrive = require('../api/_googleDrive.js');

  const getCalls = [];
  const fakeDriveClient = {
    files: {
      async get(params, opts) {
        getCalls.push({ params, opts });
        if (params.alt === 'media') {
          return { data: Buffer.from('HELLO_PDF') };
        }
        return { data: { id: params.fileId, name: 'circular.pdf', mimeType: 'application/pdf', size: '9' } };
      },
    },
  };

  const res = await realDrive.downloadDriveFileBytes('1AbCdEfGhIjKlMnOpQrSt', { _driveClient: fakeDriveClient });
  assert.equal(res.ok, true);
  assert.equal(res.mime_type, 'application/pdf');
  assert.equal(Buffer.from(res.base64, 'base64').toString('utf8'), 'HELLO_PDF');
  assert.equal(getCalls.length, 2);
  assert.equal(getCalls[0].params.supportsAllDrives, true);
  assert.equal(getCalls[1].params.supportsAllDrives, true);
  assert.equal(getCalls[1].params.alt, 'media');

  require.cache[googleDrivePath] = {
    id: googleDrivePath,
    filename: googleDrivePath,
    loaded: true,
    exports: googleDriveMockExports,
  };
});

test('fetch_timetable_base, fetch_desktop_sync_bundle, upsert_todos_batch, upsert_timetable_changes_batch, sync_desktop_schedules_and_tasks enforce tenant & teacher isolation', async () => {
  const db = createMockDb({
    시간표_기본: {
      tb_1: { remote_id: 'tb_1', school_code: 'S100', grade: 1, class_no: 2, weekday: '월', period: 1, subject: '국어', teacher_name: '김교사' },
      tb_2: { remote_id: 'tb_2', school_code: 'S100', grade: 2, class_no: 1, weekday: '월', period: 2, subject: '수학', teacher_name: '이교사' },
      tb_other_school: { remote_id: 'tb_other_school', school_code: 'S999', grade: 1, class_no: 2, weekday: '월', period: 1, subject: '영어', teacher_name: '김교사' },
    },
    시간표_변동: {
      tc_other_school: { remote_id: 'tc_other_school', school_code: 'S999', date: '2026-11-27', period: 1, changed_subject: '자습' },
    },
    Schedules: {
      s_other_teacher: { remote_id: 's_other_teacher', teacher_id: 't_002', school_code: 'S100', title: '타교사 일정', start_date: '2026-11-27' },
    },
    Tasks: {
      todo_other_teacher: { remote_id: 'todo_other_teacher', teacher_id: 't_002', school_code: 'S100', title: '타교사 할일' },
    },
    Notifications: {
      noti_own_school: { remote_id: 'noti_own_school', school_code: 'S100', grade: 1, class_no: 2, title: '학급 알림', created_at: '2026-11-27 09:00:00' },
      noti_other_school: { remote_id: 'noti_other_school', school_code: 'S999', grade: 1, class_no: 2, title: '타학교 알림', created_at: '2026-11-27 09:00:00' },
    },
  });

  const ttRes = await _handleDesktopApiAction(db, 'fetch_timetable_base', { only_my_timetable: true }, authT1);
  assert.equal(ttRes.status, 200);
  assert.deepEqual(ttRes.json.rows.map((r) => r.remote_id), ['tb_1']);

  const ttBlocked = await _handleDesktopApiAction(db, 'fetch_timetable_base', { school_code: 'S999' }, authT1);
  assert.equal(ttBlocked.status, 403);

  const todoRes = await _handleDesktopApiAction(db, 'upsert_todos_batch', {
    todos: [
      { remote_id: 'todo_1', title: '가정통신문 취합' },
      { remote_id: 'todo_other_teacher', title: '탈취 시도' },
    ],
    delete_ids: ['todo_other_teacher'],
  }, authT1);
  assert.equal(todoRes.status, 200);
  assert.equal(todoRes.json.written, 1);
  assert.equal(todoRes.json.deleted, 0);
  assert.equal(todoRes.json.skipped, 2);
  assert.equal(db._store.get('Tasks').get('todo_other_teacher').title, '타교사 할일');

  const chgRes = await _handleDesktopApiAction(db, 'upsert_timetable_changes_batch', {
    change_rows: [
      { remote_id: 'tc_1', date: '2026-11-27', grade: 1, class_no: 2, period: 3, changed_subject: '미술' },
      { remote_id: 'tc_other_school', date: '2026-11-27', period: 1, changed_subject: '탈취' },
    ],
    delete_ids: ['tc_other_school'],
  }, authT1);
  assert.equal(chgRes.status, 200);
  assert.equal(chgRes.json.written, 1);
  assert.equal(chgRes.json.deleted, 0);
  assert.equal(chgRes.json.skipped, 2);

  const syncRes = await _handleDesktopApiAction(db, 'sync_desktop_schedules_and_tasks', {
    schedules: [
      { remote_id: 'sched_1', title: '학부모 상담', start_date: '2026-11-28' },
      { remote_id: 's_other_teacher', title: '탈취 일정', start_date: '2026-11-28' },
    ],
    delete_schedule_ids: ['s_other_teacher'],
  }, authT1);
  assert.equal(syncRes.status, 200);
  assert.equal(syncRes.json.schedules_written, 1);
  assert.equal(syncRes.json.schedules_deleted, 0);
  assert.deepEqual(syncRes.json.schedules.map((s) => s.remote_id), ['sched_1']);
  assert.deepEqual(syncRes.json.tasks.map((t) => t.remote_id), ['todo_1']);
  assert.deepEqual(syncRes.json.notifications.map((n) => n.remote_id), ['noti_own_school']);

  const bundleRes = await _handleDesktopApiAction(db, 'fetch_desktop_sync_bundle', {}, authT1);
  assert.equal(bundleRes.status, 200);
  assert.deepEqual(bundleRes.json.schedules.map((s) => s.remote_id), ['sched_1']);
  assert.deepEqual(bundleRes.json.tasks.map((t) => t.remote_id), ['todo_1']);
  assert.deepEqual(bundleRes.json.notifications.map((n) => n.remote_id), ['noti_own_school']);
  assert.deepEqual(bundleRes.json.timetable_changes.map((c) => c.remote_id), ['tc_1']);
});
