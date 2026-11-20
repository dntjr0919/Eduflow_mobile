const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Test real extractDriveFileId from api/_googleDrive.js before installing mock download handler
const realGoogleDrive = require('../api/_googleDrive.js');

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

let driveDownloadCalls = [];
let mockDriveDownloadImpl = async (fileId) => ({
  ok: true,
  fileId,
  mimeType: 'image/jpeg',
  size: 12,
  dataUrl: 'data:image/jpeg;base64,ZmFrZS1pbWFnZS1ieXRlcw==',
});

const googleDrivePath = path.resolve(__dirname, '../api/_googleDrive.js');
require.cache[googleDrivePath] = {
  id: googleDrivePath,
  filename: googleDrivePath,
  loaded: true,
  exports: {
    ...realGoogleDrive,
    downloadDriveFileAsDataUrl: async (fileIdOrUrl) => {
      driveDownloadCalls.push(fileIdOrUrl);
      return mockDriveDownloadImpl(fileIdOrUrl);
    },
  },
};

const { _testHelpers } = require('../api/firestore.js');
const { _handleDesktopApiAction, _normalizeFaceDescriptor, _buildStudentFaceDocId } = _testHelpers;

const {
  _deriveAttCheckStatus,
  _computeFaceMatchPercent,
  _mapVideoBoxToOverlay,
  applyCameraFaceRecognitionToAttRows,
} = require('../teacher.js');

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
    batch() {
      const ops = [];
      return {
        set(docRef, data, opts) {
          ops.push({ docRef, data, opts });
        },
        async commit() {
          for (const op of ops) {
            await op.docRef.set(op.data, op.opts);
          }
        },
      };
    },
  };
}

function makeDescriptor(seed = 0.1) {
  return Array.from({ length: 128 }, (_, i) => Number((seed + i * 0.001).toFixed(4)));
}

const teacherAuth = {
  teacherId: 'teacher_104',
  schoolCode: '8140246',
  schoolName: '테스트고등학교',
  gradeNum: 1,
  classNum: 4,
  isAdmin: false,
  teacherDoc: { teacher_id: 'teacher_104', name: '이교사', grade: 1, class_no: 4, school_code: '8140246' },
};

test('extractDriveFileId parses raw IDs and Google Drive URL formats', () => {
  assert.equal(realGoogleDrive.extractDriveFileId('1AbCdEfGhIjKlMnOpQrStUvWxYz'), '1AbCdEfGhIjKlMnOpQrStUvWxYz');
  assert.equal(
    realGoogleDrive.extractDriveFileId('https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz'
  );
  assert.equal(
    realGoogleDrive.extractDriveFileId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz'
  );
  assert.equal(realGoogleDrive.extractDriveFileId('https://example.com/photo.jpg'), '');
  assert.equal(realGoogleDrive.extractDriveFileId(''), '');
});

test('upsert_student_face_photos_batch enforces class isolation and descriptor preservation/invalidation', async () => {
  const existingVec = makeDescriptor(0.2);
  const docId10401 = _buildStudentFaceDocId(teacherAuth, '10401');
  const db = createMockDb({
    '학생_안면데이터': {
      [docId10401]: {
        remote_id: docId10401,
        student_id: '10401',
        student_name: '김철수',
        grade: 1,
        class_no: 4,
        school_code: '8140246',
        photo_file_id: 'driveFile10401_old',
        photo_url: 'https://drive.google.com/uc?export=download&id=driveFile10401_old',
        face_descriptor: existingVec,
      },
    },
  });

  // 1) Same photo_file_id -> keeps cached face_descriptor
  const resSame = await _handleDesktopApiAction(db, 'upsert_student_face_photos_batch', {
    rows: [
      {
        student_id: '10401',
        student_name: '김철수',
        student_no: 1,
        photo_url: 'https://drive.google.com/uc?export=download&id=driveFile10401_old',
      },
      {
        student_id: '10402',
        student_name: '이영희',
        student_no: 2,
        photo_url: 'https://drive.google.com/file/d/driveFile10402_v1/view',
      },
    ],
  }, teacherAuth);

  assert.equal(resSame.status, 200);
  assert.equal(resSame.json.written, 2);
  const stored10401 = db._store.get('학생_안면데이터').get(docId10401);
  assert.deepEqual(stored10401.face_descriptor, existingVec);

  const docId10402 = _buildStudentFaceDocId(teacherAuth, '10402');
  const stored10402 = db._store.get('학생_안면데이터').get(docId10402);
  assert.equal(stored10402.photo_file_id, 'driveFile10402_v1');

  // 2) Changed photo_file_id -> invalidates old face_descriptor
  const resChanged = await _handleDesktopApiAction(db, 'upsert_student_face_photos_batch', {
    rows: [
      {
        student_id: '10401',
        student_name: '김철수',
        photo_file_id: 'driveFile10401_new',
      },
    ],
  }, teacherAuth);
  assert.equal(resChanged.status, 200);
  assert.equal(db._store.get('학생_안면데이터').get(docId10401).face_descriptor, null);

  // 3) Rejects cross-class or cross-school writes with 403
  const crossClassRes = await _handleDesktopApiAction(db, 'upsert_student_face_photos_batch', {
    rows: [{ student_id: '10501', student_name: '다른반', grade: 1, class_no: 5, photo_file_id: 'driveFile10501' }],
  }, teacherAuth);
  assert.equal(crossClassRes.status, 403);

  const crossSchoolRes = await _handleDesktopApiAction(db, 'upsert_student_face_photos_batch', {
    rows: [{ student_id: '10409', student_name: '다른학교', school_code: '9999999', photo_file_id: 'driveFileOtherSchool' }],
  }, teacherAuth);
  assert.equal(crossSchoolRes.status, 403);

  // 4) Rejects teacher with no assigned homeroom class
  const unassignedRes = await _handleDesktopApiAction(db, 'get_student_face_data', {}, {
    ...teacherAuth,
    gradeNum: null,
    classNum: null,
  });
  assert.equal(unassignedRes.status, 403);
});

test('get_student_face_data returns only homeroom class records', async () => {
  const vec = makeDescriptor(0.3);
  const db = createMockDb({
    '학생_안면데이터': {
      'face_10401': { student_id: '10401', student_name: '김일', student_no: 1, grade: 1, class_no: 4, school_code: '8140246', photo_file_id: 'file_10401_aaaa', face_descriptor: vec },
      'face_10501': { student_id: '10501', student_name: '다른반', student_no: 1, grade: 1, class_no: 5, school_code: '8140246', photo_file_id: 'file_10501_bbbb' },
      'face_other_school': { student_id: '10402', student_name: '다른학교', student_no: 2, grade: 1, class_no: 4, school_code: '9999999', photo_file_id: 'file_9999_cccc' },
    },
  });

  const res = await _handleDesktopApiAction(db, 'get_student_face_data', {}, teacherAuth);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.items.length, 1);
  assert.equal(res.json.items[0].student_id, '10401');
  assert.deepEqual(res.json.items[0].face_descriptor, vec);
});

test('save_student_face_descriptors_batch validates 128-dim arrays and enforces class isolation', async () => {
  const docId = _buildStudentFaceDocId(teacherAuth, '10403');
  const db = createMockDb({
    '학생_안면데이터': {
      [docId]: {
        remote_id: docId,
        student_id: '10403',
        student_name: '박민수',
        grade: 1,
        class_no: 4,
        school_code: '8140246',
        photo_file_id: 'file_10403_xxxx',
      },
    },
  });

  // Invalid dimensions -> 400
  const badRes = await _handleDesktopApiAction(db, 'save_student_face_descriptors_batch', {
    rows: [{ student_id: '10403', face_descriptor: [0.1, 0.2, 0.3] }],
  }, teacherAuth);
  assert.equal(badRes.status, 400);

  // NaN entry -> 400
  const nanVec = makeDescriptor(0.1);
  nanVec[5] = 'not-a-number';
  assert.equal(_normalizeFaceDescriptor(nanVec), null);

  // Cross-class write -> 403
  const crossRes = await _handleDesktopApiAction(db, 'save_student_face_descriptors_batch', {
    rows: [{ student_id: '20101', face_descriptor: makeDescriptor(0.4) }],
  }, teacherAuth);
  assert.equal(crossRes.status, 403);

  // Valid 128-dim descriptor -> 200 & persisted
  const goodVec = makeDescriptor(0.5);
  const okRes = await _handleDesktopApiAction(db, 'save_student_face_descriptors_batch', {
    rows: [{ student_id: '10403', face_descriptor: goodVec }],
  }, teacherAuth);
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.saved_count, 1);
  assert.deepEqual(db._store.get('학생_안면데이터').get(docId).face_descriptor, goodVec);
});

test('proxy_drive_photo allows homeroom student photo and blocks unauthorized file_ids', async () => {
  driveDownloadCalls = [];
  const db = createMockDb({
    '학생_안면데이터': {
      'face_10401': {
        remote_id: 'face_10401',
        student_id: '10401',
        grade: 1,
        class_no: 4,
        school_code: '8140246',
        photo_file_id: 'allowedDriveFile12345',
      },
      'face_10501': {
        remote_id: 'face_10501',
        student_id: '10501',
        grade: 1,
        class_no: 5,
        school_code: '8140246',
        photo_file_id: 'otherClassDriveFile67890',
      },
    },
  });

  // Blocked for another class
  const deniedClass = await _handleDesktopApiAction(db, 'proxy_drive_photo', {
    file_id: 'otherClassDriveFile67890',
  }, teacherAuth);
  assert.equal(deniedClass.status, 403);
  assert.equal(driveDownloadCalls.length, 0);

  // Blocked for unregistered file_id
  const deniedUnknown = await _handleDesktopApiAction(db, 'proxy_drive_photo', {
    file_id: 'unregisteredDriveFile999',
  }, teacherAuth);
  assert.equal(deniedUnknown.status, 403);
  assert.equal(driveDownloadCalls.length, 0);

  // Allowed for homeroom student
  const allowedRes = await _handleDesktopApiAction(db, 'proxy_drive_photo', {
    file_id: 'allowedDriveFile12345',
    student_id: '10401',
  }, teacherAuth);
  assert.equal(allowedRes.status, 200);
  assert.equal(allowedRes.json.ok, true);
  assert.equal(allowedRes.json.file_id, 'allowedDriveFile12345');
  assert.ok(allowedRes.json.data_url.startsWith('data:image/jpeg;base64,'));
  assert.deepEqual(driveDownloadCalls, ['allowedDriveFile12345']);
});

test('teacher.js camera face recognition helpers update _attCheckRows and map overlay boxes accurately', () => {
  assert.equal(_computeFaceMatchPercent(0.25), 75);
  assert.equal(_computeFaceMatchPercent(0), 100);
  assert.equal(_computeFaceMatchPercent(1.5), 0);

  // Landscape 640x480 video inside narrower 320x240 (exact 0.5x) and taller 240x360 container (object-cover crop)
  assert.deepEqual(
    _mapVideoBoxToOverlay({ x: 100, y: 80, width: 200, height: 160 }, 640, 480, 320, 240),
    { x: 50, y: 40, width: 100, height: 80 }
  );
  const portraitBox = _mapVideoBoxToOverlay({ x: 320, y: 240, width: 100, height: 100 }, 640, 480, 240, 360);
  assert.equal(portraitBox.x, 120); // center x of 640 maps to center x of 240
  assert.equal(portraitBox.y, 180); // center y of 480 maps to center y of 360
  assert.equal(portraitBox.width, 75); // scale = 360 / 480 = 0.75

  const rows = [
    { studentId: '10401', name: '김철수', checked: true, period: '', cameraVerified: false, cameraMatchPct: 0 },
    { studentId: '10402', name: '이영희', checked: true, period: '2교시', cameraVerified: false, cameraMatchPct: 0 },
    { studentId: '10403', name: '박민수', checked: false, period: '5교시', cameraVerified: false, cameraMatchPct: 0 },
  ];

  // Absent -> Present + cameraVerified
  const r1 = applyCameraFaceRecognitionToAttRows(rows, '10401', 86);
  assert.equal(r1.matched, true);
  assert.equal(r1.changed, true);
  assert.equal(rows[0].checked, false);
  assert.equal(rows[0].period, '');
  assert.equal(rows[0].cameraVerified, true);
  assert.equal(rows[0].cameraMatchPct, 86);
  assert.equal(_deriveAttCheckStatus(rows[0]).type, '출석');

  // Repeated recognition -> changed: false, keeps max matchPct
  const r1Repeat = applyCameraFaceRecognitionToAttRows(rows, '10401', 91);
  assert.equal(r1Repeat.matched, true);
  assert.equal(r1Repeat.changed, false);
  assert.equal(rows[0].cameraMatchPct, 91);

  // Late (checked + period) -> Present
  const r2 = applyCameraFaceRecognitionToAttRows(rows, '10402', 80);
  assert.equal(r2.changed, true);
  assert.equal(rows[1].checked, false);
  assert.equal(rows[1].period, '');
  assert.equal(_deriveAttCheckStatus(rows[1]).type, '출석');

  // Early leave (period) -> Present
  const r3 = applyCameraFaceRecognitionToAttRows(rows, '10403', 82);
  assert.equal(r3.changed, true);
  assert.equal(rows[2].checked, false);
  assert.equal(rows[2].period, '');
  assert.equal(_deriveAttCheckStatus(rows[2]).type, '출석');

  // Unknown student -> matched: false
  const unknownRes = applyCameraFaceRecognitionToAttRows(rows, '99999', 90);
  assert.equal(unknownRes.matched, false);
  assert.equal(unknownRes.changed, false);
});

test('index.html #teacherAttendanceCheckView contains camera button and video/canvas panel', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const viewStart = html.indexOf('id="teacherAttendanceCheckView"');
  assert.ok(viewStart !== -1);
  const viewEnd = html.indexOf('id="globalLoadingOverlay"', viewStart);
  const snippet = html.slice(viewStart, viewEnd);

  const camBtnIdx = snippet.indexOf('id="attFaceCamToggleBtn"');
  const closeBtnIdx = snippet.indexOf('onclick="closeTeacherAttendanceCheck()" type="button">닫기</button>');
  const summaryBarIdx = snippet.indexOf('id="attCheckSummaryBar"');
  const camPanelIdx = snippet.indexOf('id="attFaceCameraPanel"');

  assert.ok(camBtnIdx !== -1, 'camera button must exist');
  assert.ok(closeBtnIdx !== -1 && camBtnIdx < closeBtnIdx, 'camera button must appear to the left of 닫기');
  assert.ok(summaryBarIdx !== -1 && camPanelIdx > summaryBarIdx, 'camera panel must appear below summary bar');
  assert.ok(snippet.includes('id="attFaceVideo"'));
  assert.ok(snippet.includes('playsinline=""'));
  assert.ok(snippet.includes('muted=""'));
  assert.ok(snippet.includes('id="attFaceOverlay"'));
  assert.ok(snippet.includes('id="attFaceSwitchCamBtn"'));
  assert.ok(snippet.includes('id="attFaceCloseCamBtn"'));
});
