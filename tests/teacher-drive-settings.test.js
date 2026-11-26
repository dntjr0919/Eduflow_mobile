const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const { uploadBase64ToDrive } = require('../api/_googleDrive.js');

const SAMPLE_B64 = 'data:image/png;base64,' + Buffer.from('hello-png').toString('base64');

function createMockDriveClient({ folderExists = true, folderTrashed = false, folderMime = 'application/vnd.google-apps.folder' } = {}) {
  const calls = {
    get: [],
    list: [],
    create: [],
    permissionsCreate: []
  };
  const client = {
    files: {
      async get(args) {
        calls.get.push(args);
        if (!folderExists) {
          throw new Error('File not found: ' + args.fileId);
        }
        return {
          data: {
            id: args.fileId,
            name: 'SharedFolder',
            mimeType: folderMime,
            trashed: folderTrashed
          }
        };
      },
      async list(args) {
        calls.list.push(args);
        return { data: { files: [] } };
      },
      async create(args) {
        calls.create.push(args);
        const isFolder = args.requestBody && args.requestBody.mimeType === 'application/vnd.google-apps.folder';
        const id = isFolder ? `sub_${calls.create.length}` : 'uploaded_file_123';
        return {
          data: {
            id,
            webViewLink: `https://drive.google.com/file/d/${id}/view`
          }
        };
      }
    },
    permissions: {
      async create(args) {
        calls.permissionsCreate.push(args);
        return { data: { id: 'perm_1' } };
      }
    }
  };
  return { client, calls };
}

test('workspace priority uses teacher folder ID and sets supportsAllDrives / includeItemsFromAllDrives', async () => {
  const { client, calls } = createMockDriveClient();
  const res = await uploadBase64ToDrive({
    base64Data: SAMPLE_B64,
    fileName: 'sig.png',
    mimeType: 'image/png',
    folderName: '가정통신문_회신/학교_1학년1반/제목',
    driveConfig: {
      drive_priority: 'workspace',
      workspace_drive_folder_id: 'shared_drive_folder_001',
      personal_gas_url: 'https://script.google.com/macros/s/should_not_be_called/exec'
    },
    _driveClient: client
  });

  assert.equal(res.ok, true);
  assert.equal(res.fileId, 'uploaded_file_123');
  assert.equal(calls.get[0].supportsAllDrives, true);
  assert.equal(calls.get[0].fileId, 'shared_drive_folder_001');
  assert.ok(calls.list.length >= 1);
  calls.list.forEach((c) => {
    assert.equal(c.supportsAllDrives, true);
    assert.equal(c.includeItemsFromAllDrives, true);
  });
  calls.create.forEach((c) => {
    assert.equal(c.supportsAllDrives, true);
  });
  assert.equal(calls.permissionsCreate[0].supportsAllDrives, true);
});

test('workspace priority fails loudly when workspace_drive_folder_id is empty (no silent bypass)', async () => {
  const origEnvFolder = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const origEnvGas = process.env.GOOGLE_APPS_SCRIPT_URL;
  process.env.GOOGLE_DRIVE_FOLDER_ID = 'global_env_folder';
  process.env.GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/global/exec';

  try {
    const { client } = createMockDriveClient();
    const res = await uploadBase64ToDrive({
      base64Data: SAMPLE_B64,
      fileName: 'sig.png',
      driveConfig: {
        drive_priority: 'workspace',
        workspace_drive_folder_id: '',
        personal_gas_url: 'https://script.google.com/macros/s/personal/exec'
      },
      _driveClient: client
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /workspace_drive_folder_id/);
  } finally {
    if (origEnvFolder === undefined) delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_FOLDER_ID = origEnvFolder;
    if (origEnvGas === undefined) delete process.env.GOOGLE_APPS_SCRIPT_URL;
    else process.env.GOOGLE_APPS_SCRIPT_URL = origEnvGas;
  }
});

test('workspace priority returns clear error when folder does not exist or lacks permission', async () => {
  const { client } = createMockDriveClient({ folderExists: false });
  const res = await uploadBase64ToDrive({
    base64Data: SAMPLE_B64,
    fileName: 'sig.png',
    driveConfig: {
      drive_priority: 'workspace',
      workspace_drive_folder_id: 'missing_folder_id'
    },
    _driveClient: client
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /missing_folder_id/);
});

test('personal priority calls personal_gas_url with folder_id and fails loudly if empty or error', async () => {
  const fetchCalls = [];
  const mockFetchOk = async (url, opts) => {
    fetchCalls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          file_id: 'gas_file_999',
          url: 'https://drive.google.com/file/d/gas_file_999/view',
          download_url: 'https://drive.google.com/uc?export=download&id=gas_file_999'
        });
      }
    };
  };

  const okRes = await uploadBase64ToDrive({
    base64Data: SAMPLE_B64,
    fileName: 'stu_sig.png',
    mimeType: 'image/png',
    folderName: '가정통신문_회신/테스트',
    driveConfig: {
      drive_priority: 'personal',
      workspace_drive_folder_id: 'ws_should_not_be_used',
      personal_gas_url: 'https://script.google.com/macros/s/teacher1/exec',
      personal_drive_folder_id: 'personal_folder_777'
    },
    _fetch: mockFetchOk
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.fileId, 'gas_file_999');
  assert.equal(fetchCalls[0].url, 'https://script.google.com/macros/s/teacher1/exec');
  assert.equal(fetchCalls[0].body.action, 'upload_file');
  assert.equal(fetchCalls[0].body.folder_id, 'personal_folder_777');

  const emptyUrlRes = await uploadBase64ToDrive({
    base64Data: SAMPLE_B64,
    fileName: 'stu_sig.png',
    driveConfig: {
      drive_priority: 'personal',
      workspace_drive_folder_id: 'ws_should_not_be_used',
      personal_gas_url: ''
    },
    _fetch: mockFetchOk
  });
  assert.equal(emptyUrlRes.ok, false);
  assert.match(emptyUrlRes.error, /personal_gas_url/);
});

test('null driveConfig falls back to GOOGLE_DRIVE_FOLDER_ID env var', async () => {
  const origEnvFolder = process.env.GOOGLE_DRIVE_FOLDER_ID;
  process.env.GOOGLE_DRIVE_FOLDER_ID = 'env_fallback_folder_001';
  try {
    const { client, calls } = createMockDriveClient();
    const res = await uploadBase64ToDrive({
      base64Data: SAMPLE_B64,
      fileName: 'env.png',
      driveConfig: null,
      _driveClient: client
    });
    assert.equal(res.ok, true);
    assert.equal(calls.get[0].fileId, 'env_fallback_folder_001');
  } finally {
    if (origEnvFolder === undefined) delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_FOLDER_ID = origEnvFolder;
  }
});

test('api/firestore.js update_teacher_drive_settings and upload actions pass teacher driveConfig', async () => {
  const capturedDriveConfigs = [];
  const store = new Map();
  function setDoc(col, id, data) {
    if (!store.has(col)) store.set(col, new Map());
    store.get(col).set(id, { ...data });
  }
  function getCol(col) {
    if (!store.has(col)) store.set(col, new Map());
    return store.get(col);
  }
  const sha = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
  setDoc('계정_교사', 'teacher_001', {
    remote_id: 'teacher_001',
    teacher_id: 'teacher_001',
    name: '김교사',
    grade: 1,
    class_no: 2,
    school_code: 'SC01',
    status: 'active',
    password_hash: sha('pw1234')
  });
  setDoc('가정통신문_목록', 'notice_001', {
    remote_id: 'notice_001',
    title: '체험학습',
    teacher_id: 'teacher_001',
    school_code: 'SC01',
    target_grade: 1,
    target_class: 2,
    requires_reply: true,
    signature_mode: 'parent'
  });

  const mockDb = {
    collection(col) {
      return {
        doc(id) {
          return {
            async get() {
              const d = getCol(col).get(id);
              return { id, exists: Boolean(d), data: () => (d ? { ...d } : undefined) };
            },
            async set(data, opts) {
              const prev = (opts && opts.merge && getCol(col).get(id)) || {};
              getCol(col).set(id, { ...prev, ...data });
            }
          };
        },
        where(field, op, val) {
          const filters = [{ field, op, val }];
          const q = {
            where(f2, o2, v2) { filters.push({ field: f2, op: o2, val: v2 }); return q; },
            limit() { return q; },
            async get() {
              const docs = [];
              for (const [id, data] of getCol(col).entries()) {
                if (filters.every(f => f.op === '==' && data[f.field] === f.val)) {
                  docs.push({ id, exists: true, data: () => ({ ...data }) });
                }
              }
              return { docs, empty: docs.length === 0, size: docs.length };
            }
          };
          return q;
        }
      };
    }
  };

  const firebaseAdminPath = path.resolve(__dirname, '../api/_firebaseAdmin.js');
  const prevFirebaseCache = require.cache[firebaseAdminPath];
  const googleDrivePath = path.resolve(__dirname, '../api/_googleDrive.js');
  const prevDriveCache = require.cache[googleDrivePath];
  const firestorePath = path.resolve(__dirname, '../api/firestore.js');
  const prevFirestoreCache = require.cache[firestorePath];

  require.cache[firebaseAdminPath] = {
    id: firebaseAdminPath,
    filename: firebaseAdminPath,
    loaded: true,
    exports: {
      getFirestore: () => mockDb,
      buildFirestoreErrorPayload: (err) => ({ ok: false, error: err.message })
    }
  };
  require.cache[googleDrivePath] = {
    id: googleDrivePath,
    filename: googleDrivePath,
    loaded: true,
    exports: {
      uploadBase64ToDrive: async (opts) => {
        capturedDriveConfigs.push(opts.driveConfig || null);
        return {
          ok: true,
          fileId: 'mock_f_1',
          downloadUrl: 'https://drive.google.com/uc?export=download&id=mock_f_1',
          webViewLink: 'https://drive.google.com/file/d/mock_f_1/view'
        };
      },
      downloadDriveFileAsDataUrl: async () => ({ ok: false, error: 'not used' }),
      extractDriveFileId: () => ''
    }
  };
  delete require.cache[firestorePath];

  try {
    const handler = require('../api/firestore.js');
    const makeRes = () => {
      const out = { statusCode: 200, body: null };
      return {
        out,
        status(code) { out.statusCode = code; return this; },
        json(obj) { out.body = obj; return this; },
        setHeader() {}
      };
    };

    // 1. Cross-teacher update blocked (403)
    const rForbidden = makeRes();
    await handler({
      method: 'POST',
      headers: {},
      body: {
        action: 'update_teacher_drive_settings',
        auth_teacher_id: 'teacher_001',
        auth_password: 'pw1234',
        teacher_id: 'teacher_999',
        drive_priority: 'personal',
        personal_gas_url: 'https://script.google.com/macros/s/abc/exec'
      }
    }, rForbidden);
    assert.equal(rForbidden.out.statusCode, 403);

    // 2. Own teacher update succeeds
    const rOk = makeRes();
    await handler({
      method: 'POST',
      headers: {},
      body: {
        action: 'update_teacher_drive_settings',
        auth_teacher_id: 'teacher_001',
        auth_password: 'pw1234',
        drive_priority: 'personal',
        personal_gas_url: 'https://script.google.com/macros/s/teacher1_gas/exec',
        personal_drive_folder_id: 'p_folder_1'
      }
    }, rOk);
    assert.equal(rOk.out.statusCode, 200);
    assert.equal(rOk.out.body.drive_priority, 'personal');

    // 3. upsert_notice with attachment_base64 passes teacher's driveConfig
    const rNotice = makeRes();
    await handler({
      method: 'POST',
      headers: {},
      body: {
        action: 'upsert_notice',
        auth_teacher_id: 'teacher_001',
        auth_password: 'pw1234',
        title: '공지',
        attachment_base64: SAMPLE_B64
      }
    }, rNotice);
    assert.equal(rNotice.out.statusCode, 200);
    assert.equal(capturedDriveConfigs[0].drive_priority, 'personal');
    assert.equal(capturedDriveConfigs[0].personal_gas_url, 'https://script.google.com/macros/s/teacher1_gas/exec');
    assert.equal(capturedDriveConfigs[0].personal_drive_folder_id, 'p_folder_1');

    // 4. Teacher login includes drive_configured & drive_priority; student login does NOT
    setDoc('계정_학생', 'stu_001', {
      remote_id: 'stu_001',
      student_id: 'stu_001',
      name: '김학생',
      grade: 1,
      class_no: 2,
      school_code: 'SC01',
      status: 'active',
      password_hash: sha('pw1234')
    });
    setDoc('계정_교사', 'teacher_unconfigured', {
      remote_id: 'teacher_unconfigured',
      teacher_id: 'teacher_unconfigured',
      name: '박교사',
      grade: 1,
      class_no: 3,
      school_code: 'SC01',
      status: 'active',
      password_hash: sha('pw1234')
    });

    const origEnvFolder = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const origEnvGas = process.env.GOOGLE_APPS_SCRIPT_URL;
    delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    delete process.env.GOOGLE_APPS_SCRIPT_URL;
    try {
      const rTeacherLogin = makeRes();
      await handler({
        method: 'POST',
        headers: {},
        body: { action: 'login', role: 'teacher', user_id: 'teacher_unconfigured', password: 'pw1234' }
      }, rTeacherLogin);
      assert.equal(rTeacherLogin.out.statusCode, 200);
      assert.equal(rTeacherLogin.out.body.user.drive_configured, false);
      assert.equal(rTeacherLogin.out.body.user.drive_priority, 'workspace');

      const rTeacherConfiguredLogin = makeRes();
      await handler({
        method: 'POST',
        headers: {},
        body: { action: 'login', role: 'teacher', user_id: 'teacher_001', password: 'pw1234' }
      }, rTeacherConfiguredLogin);
      assert.equal(rTeacherConfiguredLogin.out.statusCode, 200);
      assert.equal(rTeacherConfiguredLogin.out.body.user.drive_configured, true);
      assert.equal(rTeacherConfiguredLogin.out.body.user.drive_priority, 'personal');

      const rStudentLogin = makeRes();
      await handler({
        method: 'POST',
        headers: {},
        body: { action: 'login', role: 'student', user_id: 'stu_001', password: 'pw1234' }
      }, rStudentLogin);
      assert.equal(rStudentLogin.out.statusCode, 200);
      assert.equal('drive_configured' in rStudentLogin.out.body.user, false);
      assert.equal('drive_priority' in rStudentLogin.out.body.user, false);
    } finally {
      if (origEnvFolder !== undefined) process.env.GOOGLE_DRIVE_FOLDER_ID = origEnvFolder;
      if (origEnvGas !== undefined) process.env.GOOGLE_APPS_SCRIPT_URL = origEnvGas;
    }
  } finally {
    if (prevFirebaseCache) require.cache[firebaseAdminPath] = prevFirebaseCache;
    else delete require.cache[firebaseAdminPath];
    if (prevDriveCache) require.cache[googleDrivePath] = prevDriveCache;
    else delete require.cache[googleDrivePath];
    if (prevFirestoreCache) require.cache[firestorePath] = prevFirestoreCache;
    else delete require.cache[firestorePath];
  }
});

test('teacher.js _confirmDriveConfiguredForSignature warns when driveConfigured is false and signatureMode !== none', () => {
  const teacher = require('../teacher.js');
  const confirmCalls = [];
  let confirmResult = false;
  global.gasApi = { isConfigured: () => true };
  global.confirm = (msg) => { confirmCalls.push(msg); return confirmResult; };
  global.mockData = { currentUser: { driveConfigured: false } };

  assert.equal(teacher._confirmDriveConfiguredForSignature('none'), true);
  assert.equal(confirmCalls.length, 0);

  assert.equal(teacher._confirmDriveConfiguredForSignature('parent'), false);
  assert.equal(confirmCalls.length, 1);
  assert.match(confirmCalls[0], /Google Drive 서명 저장 폴더/);

  confirmResult = true;
  assert.equal(teacher._confirmDriveConfiguredForSignature('both'), true);

  global.mockData.currentUser.driveConfigured = true;
  assert.equal(teacher._confirmDriveConfiguredForSignature('parent'), true);
  assert.equal(confirmCalls.length, 2);
});

test('student.js and teacher.js resolve Drive URLs and file_ids to thumbnail + lh3 fallback', () => {
  const student = require('../student.js');
  const teacher = require('../teacher.js');
  const sampleId = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

  for (const mod of [student, teacher]) {
    const fromUc = mod._resolveDriveImageUrls(`https://drive.google.com/uc?export=download&id=${sampleId}`);
    assert.equal(fromUc.fileId, sampleId);
    assert.equal(fromUc.primary, `https://drive.google.com/thumbnail?id=${sampleId}&sz=w1000`);
    assert.equal(fromUc.fallback, `https://lh3.googleusercontent.com/d/${sampleId}`);

    const fromView = mod._resolveDriveImageUrls(`https://drive.google.com/file/d/${sampleId}/view`);
    assert.equal(fromView.primary, `https://drive.google.com/thumbnail?id=${sampleId}&sz=w1000`);
    assert.equal(fromView.fallback, `https://lh3.googleusercontent.com/d/${sampleId}`);

    const fromRawId = mod._resolveDriveImageUrls(sampleId);
    assert.equal(fromRawId.primary, `https://drive.google.com/thumbnail?id=${sampleId}&sz=w1000`);
    assert.equal(fromRawId.fallback, `https://lh3.googleusercontent.com/d/${sampleId}`);

    const fromDataUrl = mod._resolveDriveImageUrls(SAMPLE_B64);
    assert.equal(fromDataUrl.primary, SAMPLE_B64);
    assert.equal(fromDataUrl.fallback, '');

    const fromUnsafe = mod._resolveDriveImageUrls('javascript:alert(1)');
    assert.equal(fromUnsafe.primary, '');
  }

  const fakeImg = { src: '', dataset: {}, removeAttribute() { this.src = ''; } };
  const applied = student._applyDriveImageWithFallback(fakeImg, `https://drive.google.com/uc?export=download&id=${sampleId}`);
  assert.equal(applied, true);
  assert.equal(fakeImg.src, `https://drive.google.com/thumbnail?id=${sampleId}&sz=w1000`);
  assert.equal(typeof fakeImg.onerror, 'function');
  fakeImg.onerror();
  assert.equal(fakeImg.src, `https://lh3.googleusercontent.com/d/${sampleId}`);
  // Second onerror does not loop
  fakeImg.onerror();
  assert.equal(fakeImg.onerror, null);
});

test('teacher.js openSubmittedRepliesModal renders Drive signature img with thumbnail and lh3 fallback', () => {
  const teacher = require('../teacher.js');
  const sampleId = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa987654';
  const elements = new Map();
  const makeEl = () => ({ innerHTML: '', textContent: '' });
  elements.set('submittedRepliesModalTitle', makeEl());
  elements.set('submittedRepliesModalSubtitle', makeEl());
  elements.set('submittedRepliesModalList', makeEl());

  global.document = {
    getElementById: (id) => elements.get(id) || null
  };
  global.openModal = () => {};
  global.state = { currentSubmittedCircularId: null };
  global.mockData = {
    students: [{ student_id: 'stu_1', student_no: 1, name: '홍길동', parent_name: '홍부모' }],
    circulars: [{
      id: 'c_1',
      title: '현장체험학습 동의서',
      replies: [{
        student_id: 'stu_1',
        student_name: '홍길동',
        consent: '동의',
        signature_drive_url: `https://drive.google.com/uc?export=download&id=${sampleId}`,
        student_signature_file_id: sampleId
      }]
    }]
  };

  teacher.openSubmittedRepliesModal('c_1');
  const html = elements.get('submittedRepliesModalList').innerHTML;
  assert.match(html, new RegExp(`https://drive\\.google\\.com/thumbnail\\?id=${sampleId}&amp;sz=w1000`));
  assert.match(html, new RegExp(`https://lh3\\.googleusercontent\\.com/d/${sampleId}`));
  assert.match(html, /onerror=/);
});

test('teacher.js GAS template matches docs/gas-drive-upload.gs and index.html wires Drive UI', () => {
  const fs = require('node:fs');
  const teacher = require('../teacher.js');
  const gasFile = fs.readFileSync(path.resolve(__dirname, '../docs/gas-drive-upload.gs'), 'utf8').replace(/\r\n/g, '\n').trim();
  const templateCode = String(teacher.TEACHER_GAS_DRIVE_UPLOAD_TEMPLATE || '').replace(/\r\n/g, '\n').trim();
  assert.equal(templateCode, gasFile);

  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  for (const id of [
    'tpDrivePriority',
    'tpWorkspaceDriveFolderId',
    'tpPersonalGasUrl',
    'tpPersonalDriveFolderId',
    'tpDriveInfoBtn',
    'tpDriveInfoBox',
    'tpCopyGasCodeBtn',
    'teacherGasGuideModal'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
});

test('api/firestore.js upsert_teacher_profile saves Drive settings and bundle hides them from students', async () => {
  const store = new Map();
  function setDoc(col, id, data) {
    if (!store.has(col)) store.set(col, new Map());
    store.get(col).set(id, { ...data });
  }
  function getCol(col) {
    if (!store.has(col)) store.set(col, new Map());
    return store.get(col);
  }
  const sha = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
  setDoc('계정_교사', 'teacher_001', {
    remote_id: 'teacher_001',
    teacher_id: 'teacher_001',
    name: '김교사',
    grade: 1,
    class_no: 2,
    school_code: 'SC01',
    status: 'active',
    password_hash: sha('pw1234')
  });
  setDoc('계정_학생', 'stu_001', {
    remote_id: 'stu_001',
    student_id: 'stu_001',
    name: '김학생',
    grade: 1,
    class_no: 2,
    school_code: 'SC01',
    status: 'active',
    password_hash: sha('pw1234')
  });

  const makeSnap = (docs) => ({
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach(cb) { docs.forEach(cb); }
  });
  const mockDb = {
    collection(col) {
      const makeQuery = (filters = []) => ({
        where(f2, o2, v2) { return makeQuery([...filters, { field: f2, op: o2, val: v2 }]); },
        orderBy() { return makeQuery(filters); },
        limit() { return makeQuery(filters); },
        async get() {
          const docs = [];
          for (const [id, data] of getCol(col).entries()) {
            const match = filters.every((f) => {
              if (f.op === '==') return data[f.field] === f.val;
              if (f.op === 'in' && Array.isArray(f.val)) return f.val.includes(data[f.field]);
              if (f.op === '>=') return String(data[f.field] || '') >= String(f.val || '');
              return true;
            });
            if (match) docs.push({ id, exists: true, data: () => ({ ...data }) });
          }
          return makeSnap(docs);
        }
      });
      return {
        doc(id) {
          return {
            async get() {
              const d = getCol(col).get(id);
              return { id, exists: Boolean(d), data: () => (d ? { ...d } : undefined) };
            },
            async set(data, opts) {
              const prev = (opts && opts.merge && getCol(col).get(id)) || {};
              getCol(col).set(id, { ...prev, ...data });
            }
          };
        },
        where(field, op, val) { return makeQuery([{ field, op, val }]); },
        orderBy() { return makeQuery([]); },
        limit() { return makeQuery([]); },
        async get() { return makeQuery([]).get(); }
      };
    }
  };

  const firebaseAdminPath = path.resolve(__dirname, '../api/_firebaseAdmin.js');
  const prevFirebaseCache = require.cache[firebaseAdminPath];
  const firestorePath = path.resolve(__dirname, '../api/firestore.js');
  const prevFirestoreCache = require.cache[firestorePath];
  require.cache[firebaseAdminPath] = {
    id: firebaseAdminPath,
    filename: firebaseAdminPath,
    loaded: true,
    exports: {
      getFirestore: () => mockDb,
      buildFirestoreErrorPayload: (err) => ({ ok: false, error: err.message })
    }
  };
  delete require.cache[firestorePath];

  try {
    const handler = require('../api/firestore.js');
    const makeRes = () => {
      const out = { statusCode: 200, body: null };
      return {
        out,
        status(code) { out.statusCode = code; return this; },
        json(obj) { out.body = obj; return this; },
        setHeader() {}
      };
    };

    const rBadUrl = makeRes();
    await handler({
      method: 'POST',
      headers: {},
      body: {
        action: 'upsert_teacher_profile',
        auth_teacher_id: 'teacher_001',
        auth_password: 'pw1234',
        drive_priority: 'personal',
        personal_gas_url: 'ftp://invalid-url'
      }
    }, rBadUrl);
    assert.equal(rBadUrl.out.statusCode, 400);

    const rSave = makeRes();
    await handler({
      method: 'POST',
      headers: {},
      body: {
        action: 'upsert_teacher_profile',
        auth_teacher_id: 'teacher_001',
        auth_password: 'pw1234',
        name: '김교사수정',
        drive_priority: 'personal',
        workspace_drive_folder_id: 'ws_folder_001',
        personal_gas_url: 'https://script.google.com/macros/s/abc123/exec',
        personal_drive_folder_id: 'p_folder_002'
      }
    }, rSave);
    assert.equal(rSave.out.statusCode, 200);
    assert.equal(rSave.out.body.drive_priority, 'personal');
    assert.equal(rSave.out.body.drive_configured, true);

    const savedTeacher = getCol('계정_교사').get('teacher_001');
    assert.equal(savedTeacher.drive_priority, 'personal');
    assert.equal(savedTeacher.workspace_drive_folder_id, 'ws_folder_001');
    assert.equal(savedTeacher.personal_gas_url, 'https://script.google.com/macros/s/abc123/exec');
    assert.equal(savedTeacher.personal_drive_folder_id, 'p_folder_002');

    // Bundle for teacher includes own Drive fields
    const teacherBundleRes = await handler._testHelpers._handleGetMobileBundle(mockDb, {
      role: 'teacher',
      user_id: 'teacher_001',
      school_code: 'SC01',
      grade: 1,
      class_no: 2,
      force_refresh: 1
    });
    const teacherBundle = teacherBundleRes.json || teacherBundleRes;
    assert.equal(teacherBundle.drive_configured, true);
    assert.equal(teacherBundle.drive_priority, 'personal');
    assert.equal(teacherBundle.workspace_drive_folder_id, 'ws_folder_001');
    assert.equal(teacherBundle.personal_gas_url, 'https://script.google.com/macros/s/abc123/exec');
    assert.equal(teacherBundle.personal_drive_folder_id, 'p_folder_002');

    // Bundle for student MUST NOT expose any teacher Drive fields
    const studentBundleRes = await handler._testHelpers._handleGetMobileBundle(mockDb, {
      role: 'student',
      user_id: 'stu_001',
      student_id: 'stu_001',
      school_code: 'SC01',
      grade: 1,
      class_no: 2,
      force_refresh: 1
    });
    const studentBundle = studentBundleRes.json || studentBundleRes;
    assert.equal('drive_configured' in studentBundle, false);
    assert.equal('drive_priority' in studentBundle, false);
    assert.equal('personal_gas_url' in studentBundle, false);
    assert.equal('workspace_drive_folder_id' in studentBundle, false);
    assert.equal('personal_drive_folder_id' in studentBundle, false);
    const leakedTeacher = (studentBundle.teachers || [])[0] || {};
    assert.equal('personal_gas_url' in leakedTeacher, false);
    assert.equal('workspace_drive_folder_id' in leakedTeacher, false);
    assert.equal('personal_drive_folder_id' in leakedTeacher, false);
    assert.equal('drive_priority' in leakedTeacher, false);
  } finally {
    if (prevFirebaseCache) require.cache[firebaseAdminPath] = prevFirebaseCache;
    else delete require.cache[firebaseAdminPath];
    if (prevFirestoreCache) require.cache[firestorePath] = prevFirestoreCache;
    else delete require.cache[firestorePath];
  }
});
