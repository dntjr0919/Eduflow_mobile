const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Stub _firebaseAdmin.js and _googleDrive.js so api/firestore.js loads cleanly in unit tests
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

const {
  parseLessonMeta,
  canonicalizeClassLabel,
  normalizeLessonRecord,
  buildLessonMatrixModel,
} = require('../admin/admin.js');

const { _testHelpers } = require('../api/firestore.js');
const { _handleDesktopApiAction, _parseLessonMeta } = _testHelpers;

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

const teacherAuth = {
  teacherId: 'teacher_1',
  schoolCode: '8140246',
  schoolName: '테스트고등학교',
  gradeNum: 1,
  classNum: 4,
  isAdmin: false,
  teacherDoc: { teacher_id: 'teacher_1', name: '김교사', grade: 1, class_no: 4, school_code: '8140246' },
};

test('parseLessonMeta splits 과학탐구실험2 1-4 + [목 7] and combined strings cleanly', () => {
  assert.deepEqual(
    parseLessonMeta('과학탐구실험2 1-4', '[목 7]'),
    { subject: '과학탐구실험2', class_label: '1-4', period: 7 }
  );

  assert.deepEqual(
    parseLessonMeta({ subject: '과학탐구실험2 1-4', class_label: '[목 7]', period: '' }),
    { subject: '과학탐구실험2', class_label: '1-4', period: 7 }
  );

  assert.deepEqual(
    parseLessonMeta('과학탐구실험2 1-4 · [목 7]'),
    { subject: '과학탐구실험2', class_label: '1-4', period: 7 }
  );
});

test('parseLessonMeta handles weekday-period, class-token variants, and subject edge cases', () => {
  assert.deepEqual(
    parseLessonMeta('통합과학2', '1-13 (화 3)'),
    { subject: '통합과학2', class_label: '1-13', period: 3 }
  );

  assert.deepEqual(
    parseLessonMeta('물질과 에너지 2-F206', '목 7'),
    { subject: '물질과 에너지', class_label: '2-F206', period: 7 }
  );

  assert.deepEqual(
    parseLessonMeta('과학탐구실험2', '1-4 [목7]'),
    { subject: '과학탐구실험2', class_label: '1-4', period: 7 }
  );

  assert.deepEqual(
    parseLessonMeta('과학탐구실험2', '1-4 목7'),
    { subject: '과학탐구실험2', class_label: '1-4', period: 7 }
  );

  assert.deepEqual(
    parseLessonMeta('과학탐구실험2', '1-4 [월 2, 목 7]'),
    { subject: '과학탐구실험2', class_label: '1-4', period: 2 }
  );

  assert.deepEqual(
    parseLessonMeta('통합과학2', '1학년 4반', '5'),
    { subject: '통합과학2', class_label: '1학년 4반', period: 5 }
  );

  assert.deepEqual(
    parseLessonMeta('과학탐구실험2 (1-4)', ''),
    { subject: '과학탐구실험2', class_label: '1-4', period: null }
  );

  // Explicit period override still strips [목 7] from class_label
  assert.deepEqual(
    parseLessonMeta('통합과학2 1-4', '[목 7]', '5'),
    { subject: '통합과학2', class_label: '1-4', period: 5 }
  );

  // Non-structured custom class_label must not be stripped or copied into subject
  assert.deepEqual(
    parseLessonMeta('통합과학2', '심화반 [목 7]'),
    { subject: '통합과학2', class_label: '심화반', period: 7 }
  );

  // Subject abbreviations & trailing digits must NOT be falsely stripped as weekday+period
  assert.deepEqual(
    parseLessonMeta('수1', '1-4'),
    { subject: '수1', class_label: '1-4', period: null }
  );
  assert.deepEqual(
    parseLessonMeta('화2', '1-2'),
    { subject: '화2', class_label: '1-2', period: null }
  );
  assert.deepEqual(
    parseLessonMeta('특수 1', '1-4'),
    { subject: '특수 1', class_label: '1-4', period: null }
  );
  assert.deepEqual(
    parseLessonMeta('물리학1 (김철수)', '2-3'),
    { subject: '물리학1 (김철수)', class_label: '2-3', period: null }
  );
});

test('canonicalizeClassLabel and buildLessonMatrixModel group pure subjects and canonical classes', () => {
  assert.equal(canonicalizeClassLabel('1학년 4반'), '1-4');
  assert.equal(canonicalizeClassLabel('1 - 04'), '1-4');
  assert.equal(canonicalizeClassLabel('2-f206'), '2-F206');

  const progressList = [
    {
      remote_id: 'p1',
      subject: '과학탐구실험2 1-4',
      class_label: '[목 7]',
      period: '',
      unit: 'Ⅰ. 탐구 방법',
      lesson_no: '1차시',
      content: '가설 설정',
      date: '2026-11-19',
    },
    {
      remote_id: 'p2',
      subject: '과학탐구실험2',
      class_label: '1학년 4반',
      period: 7,
      unit: 'Ⅱ. 변인 통제',
      lesson_no: '2차시',
      content: '실험 설계',
      date: '2026-11-20',
    },
  ];
  const rosterList = [
    { subject: '과학탐구실험2 1-4', class_label: '[목 7]' },
    { subject: '과학탐구실험2 1-2', class_label: '(화 3)' },
  ];

  const model = buildLessonMatrixModel(progressList, rosterList, '', '목');
  assert.deepEqual(model.subjects, ['과학탐구실험2']);
  assert.equal(model.targetSubject, '과학탐구실험2');
  assert.deepEqual(model.classLabels, ['1-2', '1-4']);
  assert.equal(model.defaultPeriodByClass.get('1-4'), 7);
  assert.equal(model.defaultPeriodByClass.get('1-2'), 3);
  assert.equal(model.rows.length, 2);
  assert.equal(model.rows[0].byClass.get('1-4').remote_id, 'p1');
  assert.equal(model.rows[1].byClass.get('1-4').remote_id, 'p2');
});

test('api/firestore.js upsert_lesson_progress normalizes subject, class_label, and period', async () => {
  assert.deepEqual(
    _parseLessonMeta('과학탐구실험2 1-4', '[목 7]', ''),
    { subject: '과학탐구실험2', class_label: '1-4', period: 7 }
  );

  const db = createMockDb({});
  const res = await _handleDesktopApiAction(db, 'upsert_lesson_progress', {
    date: '2026-11-20',
    subject: '과학탐구실험2 1-4',
    class_label: '[목 7]',
    period: '',
    unit: 'Ⅰ. 과학 탐구',
    lesson_no: '1차시',
    content: '측정과 오차',
  }, teacherAuth);

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.item.subject, '과학탐구실험2');
  assert.equal(res.json.item.class_label, '1-4');
  assert.equal(res.json.item.period, 7);

  const stored = db._store.get('수업_진도').get(res.json.remote_id);
  assert.equal(stored.subject, '과학탐구실험2');
  assert.equal(stored.class_label, '1-4');
  assert.equal(stored.period, 7);
});

test('admin/index.html #lesson-progress-modal prevents mobile date truncation', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../admin/index.html'), 'utf8');
  const modalIdx = html.indexOf('id="lesson-progress-modal"');
  assert.ok(modalIdx !== -1, '#lesson-progress-modal must exist');
  const modalSnippet = html.slice(modalIdx, modalIdx + 1600);
  assert.ok(modalSnippet.includes('grid-cols-2 sm:grid-cols-3'), 'row should use grid-cols-2 sm:grid-cols-3');
  assert.ok(modalSnippet.includes('col-span-2 sm:col-span-1 min-w-0'), 'date wrapper should use col-span-2 sm:col-span-1 min-w-0');
  assert.ok(modalSnippet.includes('id="lp-date" type="date" required class="w-full min-w-0'), 'lp-date should have min-w-0');
});
