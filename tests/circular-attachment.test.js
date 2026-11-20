const test = require('node:test');
const assert = require('node:assert/strict');
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
const { _handleGetMobileBundle, _resolveNoticeAttachmentUrl } = _testHelpers;
const { normalizeCircularAttachmentUrl } = require('../app.js');

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
    collection(colName) {
      const base = makeQuery(colName);
      return {
        ...base,
        doc(docId) {
          return {
            async get() {
              const colMap = getColMap(colName);
              return makeSnap(docId, colMap.get(docId));
            },
          };
        },
      };
    },
  };
}

test('_resolveNoticeAttachmentUrl reads attachment_url, file_url, drive_url and converts Drive uc/open URLs to preview', () => {
  assert.equal(
    _resolveNoticeAttachmentUrl({ attachment_url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view' }),
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view'
  );
  assert.equal(
    _resolveNoticeAttachmentUrl({ file_url: 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrSt' }),
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view'
  );
  assert.equal(
    _resolveNoticeAttachmentUrl({ drive_url: 'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrSt' }),
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view'
  );
  assert.equal(
    _resolveNoticeAttachmentUrl({ drive_file_id: '1AbCdEfGhIjKlMnOpQrSt' }),
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view'
  );
  assert.equal(_resolveNoticeAttachmentUrl({ attachment_url: 'javascript:alert(1)' }), '');
  assert.equal(_resolveNoticeAttachmentUrl({}), '');
});

test('_handleGetMobileBundle normalizes attachment_url across alternative field names in notices', async () => {
  const db = createMockDb({
    '계정_학생': {
      s1: { student_id: '10301', name: '김민준', grade: 1, class_no: 3, school_code: 'SC001' },
    },
    '가정통신문_목록': {
      n1: {
        remote_id: 'n1',
        title: '현장체험학습 안내',
        target_grade: 1,
        target_class: 3,
        school_code: 'SC001',
        is_published: true,
        file_url: 'https://drive.google.com/uc?export=download&id=1XyZ1234567890AbCdEf',
      },
      n2: {
        remote_id: 'n2',
        title: '일반 안내문',
        target_grade: 1,
        target_class: 3,
        school_code: 'SC001',
        is_published: true,
      },
    },
  });

  const res = await _handleGetMobileBundle(db, {
    role: 'student',
    student_id: '10301',
    grade: '1',
    class_no: '3',
    school_code: 'SC001',
  });

  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.json.notices.map((n) => [n.remote_id, n]));
  assert.equal(byId.n1.attachment_url, 'https://drive.google.com/file/d/1XyZ1234567890AbCdEf/view');
  assert.equal(byId.n2.attachment_url, '');
});

test('normalizeCircularAttachmentUrl validates URLs and rejects unsafe schemes', () => {
  assert.equal(
    normalizeCircularAttachmentUrl({ driveUrl: 'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrSt' }),
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view'
  );
  assert.equal(
    normalizeCircularAttachmentUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing'),
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing'
  );
  assert.equal(normalizeCircularAttachmentUrl('javascript:alert(1)'), '');
  assert.equal(normalizeCircularAttachmentUrl(''), '');
});

test('index.html, student.js, and teacher.js wire clickable circular attachment links properly', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  const studentJs = fs.readFileSync(path.resolve(__dirname, '../student.js'), 'utf8');
  const teacherJs = fs.readFileSync(path.resolve(__dirname, '../teacher.js'), 'utf8');

  assert.ok(html.includes('id="modalCircularAttachmentLink"'), 'index.html should contain #modalCircularAttachmentLink');
  assert.ok(html.includes('id="modalCircularAttachmentEmpty"'), 'index.html should contain #modalCircularAttachmentEmpty');
  assert.ok(html.includes('rel="noopener noreferrer" target="_blank"'), 'attachment link should open in a new tab safely');
  assert.ok(studentJs.includes('function openCircularAttachment(event, rawUrl)'), 'student.js should define openCircularAttachment');
  assert.ok(studentJs.includes('event.stopPropagation()'), 'openCircularAttachment should stop event propagation');
  assert.ok(studentJs.includes("window.open(safeUrl, '_blank', 'noopener,noreferrer')"), 'openCircularAttachment should use window.open');
  assert.ok(teacherJs.includes('openCircularAttachment(event, this.href)'), 'teacher.js circular cards should wire openCircularAttachment');
});
