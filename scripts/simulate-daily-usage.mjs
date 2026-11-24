#!/usr/bin/env node
/**
 * Eduflow_mobile 하루치 Firestore 읽기/쓰기 부하 시뮬레이션 스크립트
 * - FIRESTORE_EMULATOR_HOST 설정 시 Firestore Emulator에 계측 Proxy를 연결해 실행
 * - 미설정 시 api/firestore.js의 실제 쿼리/핸들러 로직을 그대로 실행하는 계측용 인메모리 DB 사용
 * - 절대 운영 서비스 계정(eduflow-db-*.json)을 로드하지 않음
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const FREE_DAILY_READ_LIMIT = 50_000;
const FREE_DAILY_WRITE_LIMIT = 20_000;
const FREE_DAILY_DELETE_LIMIT = 20_000;

const SCHOOL_CODE = '8140246';
const SCHOOL_NAME = '에듀플로우고등학교';

// ---------------------------------------------------------------------------
// 1. 계측기 (기능별 버킷 + 컬렉션별 Read / Write / Delete 정확 카운팅)
// ---------------------------------------------------------------------------
function createMetricsTracker() {
  let activeBucket = 'setup';
  const buckets = new Map();
  const collections = new Map();

  function ensureBucket(name) {
    if (!buckets.has(name)) {
      buckets.set(name, { reads: 0, writes: 0, deletes: 0, apiCalls: 0, queries: 0, byCollection: new Map() });
    }
    return buckets.get(name);
  }

  function ensureCollection(name) {
    if (!collections.has(name)) {
      collections.set(name, { reads: 0, writes: 0, deletes: 0 });
    }
    return collections.get(name);
  }

  return {
    setBucket(name) {
      activeBucket = name;
      ensureBucket(name);
    },
    getBucket() {
      return activeBucket;
    },
    recordApiCall(bucketName = activeBucket) {
      ensureBucket(bucketName).apiCalls += 1;
    },
    recordRead(collectionName, count = 1, isQuery = false) {
      const b = ensureBucket(activeBucket);
      const c = ensureCollection(collectionName);
      b.reads += count;
      if (isQuery) b.queries += 1;
      b.byCollection.set(collectionName, (b.byCollection.get(collectionName) || 0) + count);
      c.reads += count;
    },
    recordWrite(collectionName, count = 1) {
      ensureBucket(activeBucket).writes += count;
      ensureCollection(collectionName).writes += count;
    },
    recordDelete(collectionName, count = 1) {
      ensureBucket(activeBucket).deletes += count;
      ensureCollection(collectionName).deletes += count;
    },
    reset() {
      buckets.clear();
      collections.clear();
    },
    snapshot() {
      return {
        buckets: new Map(buckets),
        collections: new Map(collections),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 2. 계측용 인메모리 Firestore 엔진 (Cloud Firestore 과금 규칙 준수)
// ---------------------------------------------------------------------------
function compareValues(a, b) {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function matchesFilter(data, filter) {
  const val = data[filter.field];
  switch (filter.op) {
    case '==':
      return val === filter.val;
    case '!=':
      return val !== filter.val;
    case 'in':
      return Array.isArray(filter.val) && filter.val.includes(val);
    case '>=':
      return val !== undefined && val !== null && compareValues(val, filter.val) >= 0;
    case '<=':
      return val !== undefined && val !== null && compareValues(val, filter.val) <= 0;
    case '>':
      return val !== undefined && val !== null && compareValues(val, filter.val) > 0;
    case '<':
      return val !== undefined && val !== null && compareValues(val, filter.val) < 0;
    default:
      throw new Error(`Unsupported Firestore filter op: ${filter.op}`);
  }
}

function createInstrumentedMemoryDb(metrics) {
  const store = new Map();

  function getColMap(colName) {
    if (!store.has(colName)) store.set(colName, new Map());
    return store.get(colName);
  }

  function makeDocRef(colName, docId) {
    const ref = {
      id: docId,
      path: `${colName}/${docId}`,
      async get() {
        metrics.recordRead(colName, 1, false);
        const data = getColMap(colName).get(docId);
        return {
          id: docId,
          ref,
          exists: data !== undefined,
          data: () => (data !== undefined ? structuredClone(data) : undefined),
        };
      },
      async set(data, opts = {}) {
        metrics.recordWrite(colName, 1);
        const colMap = getColMap(colName);
        if (opts && opts.merge && colMap.has(docId)) {
          colMap.set(docId, { ...colMap.get(docId), ...structuredClone(data) });
        } else {
          colMap.set(docId, structuredClone(data));
        }
      },
      async update(data) {
        const colMap = getColMap(colName);
        if (!colMap.has(docId)) {
          throw new Error(`NOT_FOUND: ${colName}/${docId}`);
        }
        metrics.recordWrite(colName, 1);
        colMap.set(docId, { ...colMap.get(docId), ...structuredClone(data) });
      },
      async delete() {
        metrics.recordDelete(colName, 1);
        getColMap(colName).delete(docId);
      },
    };
    return ref;
  }

  function makeSnap(colName, docId, data) {
    const ref = makeDocRef(colName, docId);
    return {
      id: docId,
      ref,
      exists: data !== undefined,
      data: () => (data !== undefined ? structuredClone(data) : undefined),
    };
  }

  function makeQuery(colName, filters = [], orders = [], maxLimit = Infinity) {
    return {
      where(field, op, val) {
        return makeQuery(colName, [...filters, { field, op, val }], orders, maxLimit);
      },
      orderBy(field, direction = 'asc') {
        return makeQuery(colName, filters, [...orders, { field, direction }], maxLimit);
      },
      limit(n) {
        return makeQuery(colName, filters, orders, Number(n));
      },
      async get() {
        const colMap = getColMap(colName);
        let matchedEntries = [];
        for (const [id, data] of colMap.entries()) {
          let ok = true;
          for (const f of filters) {
            if (!matchesFilter(data, f)) {
              ok = false;
              break;
            }
          }
          if (ok) matchedEntries.push([id, data]);
        }
        if (orders.length > 0) {
          matchedEntries.sort((a, b) => {
            for (const o of orders) {
              const cmp = compareValues(a[1][o.field], b[1][o.field]);
              if (cmp !== 0) return o.direction === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
        }
        if (Number.isFinite(maxLimit) && maxLimit >= 0) {
          matchedEntries = matchedEntries.slice(0, maxLimit);
        }
        const docs = matchedEntries.map(([id, data]) => makeSnap(colName, id, data));
        // Firestore 과금 규칙: 쿼리 결과가 0건이어도 최소 1 Read 과금
        const billedReads = Math.max(1, docs.length);
        metrics.recordRead(colName, billedReads, true);
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
    _mode: 'in-memory-instrumented',
    _store: store,
    batch() {
      const ops = [];
      return {
        set(docRef, data, opts) {
          ops.push(() => docRef.set(data, opts));
        },
        update(docRef, data) {
          ops.push(() => docRef.update(data));
        },
        delete(docRef) {
          ops.push(() => docRef.delete());
        },
        async commit() {
          for (const op of ops) {
            await op();
          }
        },
      };
    },
    collection(colName) {
      return {
        doc(docId) {
          const resolvedId = docId || crypto.randomUUID();
          return makeDocRef(colName, resolvedId);
        },
        where(field, op, val) {
          return makeQuery(colName, [{ field, op, val }]);
        },
        orderBy(field, direction = 'asc') {
          return makeQuery(colName, [], [{ field, direction }]);
        },
        limit(n) {
          return makeQuery(colName, [], [], Number(n));
        },
        async get() {
          return makeQuery(colName).get();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Firestore Emulator Proxy 래퍼 (FIRESTORE_EMULATOR_HOST 설정 시 사용)
// ---------------------------------------------------------------------------
function wrapEmulatorFirestore(realDb, metrics) {
  function wrapDocRef(colName, realDocRef) {
    return {
      get id() {
        return realDocRef.id;
      },
      get _real() {
        return realDocRef;
      },
      async get() {
        const snap = await realDocRef.get();
        metrics.recordRead(colName, 1, false);
        return {
          id: snap.id,
          ref: wrapDocRef(colName, snap.ref),
          exists: snap.exists,
          data: () => snap.data(),
        };
      },
      async set(data, opts) {
        metrics.recordWrite(colName, 1);
        return opts ? realDocRef.set(data, opts) : realDocRef.set(data);
      },
      async update(data) {
        metrics.recordWrite(colName, 1);
        return realDocRef.update(data);
      },
      async delete() {
        metrics.recordDelete(colName, 1);
        return realDocRef.delete();
      },
    };
  }

  function wrapQuery(colName, realQuery) {
    return {
      where(field, op, val) {
        return wrapQuery(colName, realQuery.where(field, op, val));
      },
      orderBy(field, dir) {
        return wrapQuery(colName, realQuery.orderBy(field, dir));
      },
      limit(n) {
        return wrapQuery(colName, realQuery.limit(n));
      },
      async get() {
        const snap = await realQuery.get();
        const billedReads = Math.max(1, snap.size);
        metrics.recordRead(colName, billedReads, true);
        const wrappedDocs = snap.docs.map((d) => ({
          id: d.id,
          ref: wrapDocRef(colName, d.ref),
          exists: d.exists,
          data: () => d.data(),
        }));
        return {
          empty: snap.empty,
          size: snap.size,
          docs: wrappedDocs,
          forEach(cb) {
            wrappedDocs.forEach(cb);
          },
        };
      },
    };
  }

  return {
    _mode: `firestore-emulator (${process.env.FIRESTORE_EMULATOR_HOST})`,
    batch() {
      const realBatch = realDb.batch();
      const pendingCounts = [];
      return {
        set(docRef, data, opts) {
          const colName = (docRef._real ? docRef._real.parent.id : docRef.parent.id);
          pendingCounts.push(['write', colName]);
          const target = docRef._real || docRef;
          if (opts) realBatch.set(target, data, opts);
          else realBatch.set(target, data);
        },
        update(docRef, data) {
          const colName = (docRef._real ? docRef._real.parent.id : docRef.parent.id);
          pendingCounts.push(['write', colName]);
          realBatch.update(docRef._real || docRef, data);
        },
        delete(docRef) {
          const colName = (docRef._real ? docRef._real.parent.id : docRef.parent.id);
          pendingCounts.push(['delete', colName]);
          realBatch.delete(docRef._real || docRef);
        },
        async commit() {
          const res = await realBatch.commit();
          for (const [kind, colName] of pendingCounts) {
            if (kind === 'write') metrics.recordWrite(colName, 1);
            else metrics.recordDelete(colName, 1);
          }
          return res;
        },
      };
    },
    collection(colName) {
      const realCol = realDb.collection(colName);
      return {
        doc(docId) {
          return wrapDocRef(colName, docId ? realCol.doc(docId) : realCol.doc());
        },
        where(field, op, val) {
          return wrapQuery(colName, realCol.where(field, op, val));
        },
        orderBy(field, dir) {
          return wrapQuery(colName, realCol.orderBy(field, dir));
        },
        limit(n) {
          return wrapQuery(colName, realCol.limit(n));
        },
        async get() {
          return wrapQuery(colName, realCol).get();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 4. api/firestore.js 로드 (운영 서비스 계정 로드 차단)
// ---------------------------------------------------------------------------
const metrics = createMetricsTracker();
let db;

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) {
    initializeApp({ projectId: 'demo-eduflow-sim' });
  }
  db = wrapEmulatorFirestore(getFirestore(), metrics);
} else {
  db = createInstrumentedMemoryDb(metrics);
}

const firebaseAdminPath = path.resolve(ROOT_DIR, 'api/_firebaseAdmin.js');
require.cache[firebaseAdminPath] = {
  id: firebaseAdminPath,
  filename: firebaseAdminPath,
  loaded: true,
  exports: {
    getFirestore: () => db,
    buildFirestoreErrorPayload: (err, context = 'Firestore') => {
      const rawMsg = err && err.message ? String(err.message) : 'Firestore query error';
      const isMissingIndex =
        (err && (err.code === 9 || String(err.code).toUpperCase() === 'FAILED_PRECONDITION')) ||
        /requires an index/i.test(rawMsg);
      return {
        ok: false,
        code: isMissingIndex ? 'FIRESTORE_INDEX_REQUIRED' : undefined,
        error: `[${context}] ${rawMsg}`,
      };
    },
  },
};

const googleDrivePath = path.resolve(ROOT_DIR, 'api/_googleDrive.js');
require.cache[googleDrivePath] = {
  id: googleDrivePath,
  filename: googleDrivePath,
  loaded: true,
  exports: {},
};

const apiHandler = require('../api/firestore.js');
const { _testHelpers } = apiHandler;
const { _kstDateStr, _nowStr } = _testHelpers;

// ---------------------------------------------------------------------------
// 5. HTTP Mock Req/Res 호출 헬퍼
// ---------------------------------------------------------------------------
const failedCalls = [];

async function invokeApi({ method = 'GET', query = {}, body = null, headers = {}, bucket = null }) {
  if (bucket) metrics.recordApiCall(bucket);
  const req = {
    method,
    query: { ...query },
    body: body || undefined,
    headers: { ...headers },
  };
  let statusCode = 200;
  let jsonPayload = null;
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return res;
    },
    json(payload) {
      jsonPayload = payload;
      return res;
    },
    end() {
      return res;
    },
  };

  await apiHandler(req, res);
  if (statusCode !== 200 || !jsonPayload || jsonPayload.ok === false) {
    failedCalls.push({
      bucket: bucket || metrics.getBucket(),
      action: query.action || (body && body.action),
      statusCode,
      error: jsonPayload && jsonPayload.error,
    });
  }
  return { status: statusCode, json: jsonPayload };
}

// ---------------------------------------------------------------------------
// 6. 가상 데이터 시드 (실사용 조건)
// ---------------------------------------------------------------------------
async function seedVirtualSchoolData() {
  metrics.setBucket('seed');
  const todayStr = _kstDateStr();
  const ymd = todayStr.replace(/-/g, '');
  const yesterdayStr = _kstDateStr(new Date(), -1);
  const twoDaysAgoStr = _kstDateStr(new Date(), -2);
  const nowStr = _nowStr();
  const pwHash = crypto.createHash('sha256').update('pass1234', 'utf8').digest('hex');

  const teachers = [
    { teacher_id: 'teacher_1', name: '김국어', subject: '국어', grade: 1, class_no: 1, is_admin: false },
    { teacher_id: 'teacher_2', name: '이수학', subject: '수학', grade: 1, class_no: 2, is_admin: false },
    { teacher_id: 'teacher_3', name: '박영어', subject: '영어', grade: 1, class_no: 3, is_admin: false },
    { teacher_id: 'teacher_4', name: '최과학', subject: '과학', grade: null, class_no: null, is_admin: false },
    { teacher_id: 'teacher_5', name: '정사회', subject: '사회', grade: null, class_no: null, is_admin: false },
    { teacher_id: 'admin_1', name: '한관리', subject: '정보', grade: 1, class_no: 1, is_admin: true },
  ];

  const students = [];
  for (let classNo = 1; classNo <= 3; classNo += 1) {
    for (let no = 1; no <= 35; no += 1) {
      const sid = `1${String(classNo).padStart(2, '0')}${String(no).padStart(2, '0')}`;
      students.push({
        remote_id: sid,
        student_id: sid,
        login_id: sid,
        name: `학생_${classNo}_${String(no).padStart(2, '0')}`,
        grade: 1,
        class_no: classNo,
        student_no: no,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        status: 'active',
        password_hash: pwHash,
      });
    }
  }

  // 배치 헬퍼
  async function writeBatchDocs(colName, items, idFn) {
    const CHUNK = 400;
    for (let i = 0; i < items.length; i += CHUNK) {
      const batch = db.batch();
      for (const item of items.slice(i, i + CHUNK)) {
        const id = idFn(item);
        batch.set(db.collection(colName).doc(id), { remote_id: id, ...item }, { merge: true });
      }
      await batch.commit();
    }
  }

  // 1) 교사 5명 + 관리자 1명
  await writeBatchDocs(
    '계정_교사',
    teachers.map((t) => ({
      ...t,
      login_id: t.teacher_id,
      school_code: SCHOOL_CODE,
      neis_school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      status: 'active',
      password_hash: pwHash,
    })),
    (t) => t.teacher_id
  );

  // 2) 학생 105명 + 학부모 60명 + 푸시 구독 60건
  await writeBatchDocs('계정_학생', students, (s) => s.student_id);
  await writeBatchDocs(
    '계정_학부모',
    students.slice(0, 60).map((s) => ({
      parent_id: `p_${s.student_id}`,
      login_id: `p_${s.student_id}`,
      student_id: s.student_id,
      student_no: s.student_no,
      name: `${s.name}_학부모`,
      grade: s.grade,
      class_no: s.class_no,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      status: 'active',
      password_hash: pwHash,
    })),
    (p) => p.parent_id
  );
  await writeBatchDocs(
    'Push_Subscriptions',
    students.slice(0, 60).map((s) => ({
      user_id: s.student_id,
      student_id: s.student_id,
      role: 'student',
      grade: s.grade,
      class_no: s.class_no,
      school_code: SCHOOL_CODE,
      endpoint: `https://push.example.local/${s.student_id}`,
    })),
    (p) => `ps_${p.user_id}`
  );

  // 3) 오늘자 시간표_스냅샷 (1건) + 시간표_기본 (90건: 스냅샷 최적화 검증용)
  const snapshotClasses = {};
  for (let c = 1; c <= 3; c += 1) {
    snapshotClasses[`1-${c}`] = {};
    for (let p = 1; p <= 6; p += 1) {
      const t = teachers[(c + p) % 5];
      snapshotClasses[`1-${c}`][String(p)] = {
        period: p,
        subject: t.subject,
        teacher_name: t.name,
      };
    }
  }
  const snapshotTeachers = {};
  for (const t of teachers.slice(0, 5)) {
    snapshotTeachers[t.name] = {
      '1': { period: 1, subject: t.subject, class_label: '1-1' },
      '2': { period: 2, subject: t.subject, class_label: '1-2' },
      '3': { period: 3, subject: t.subject, class_label: '1-3' },
    };
  }
  await writeBatchDocs(
    '시간표_스냅샷',
    [
      {
        remote_id: `snap_${SCHOOL_CODE}_${ymd}`,
        date: todayStr,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        classes: snapshotClasses,
        teachers: snapshotTeachers,
        updated_at: nowStr,
      },
    ],
    (x) => x.remote_id
  );

  const ttBase = [];
  for (let c = 1; c <= 3; c += 1) {
    for (let dow = 1; dow <= 5; dow += 1) {
      for (let p = 1; p <= 6; p += 1) {
        const t = teachers[(c + dow + p) % 5];
        ttBase.push({
          remote_id: `tt_1_${c}_${dow}_${p}`,
          grade: 1,
          class_no: c,
          day_of_week: dow,
          period: p,
          subject: t.subject,
          teacher_name: t.name,
          school_code: SCHOOL_CODE,
          school_name: SCHOOL_NAME,
        });
      }
    }
  }
  await writeBatchDocs('시간표_기본', ttBase, (x) => x.remote_id);

  // 4) 과거 누적 교과_출결 (200건: 교사 5명 × 40건)
  const subAttDocs = [];
  for (let ti = 0; ti < 5; ti += 1) {
    const t = teachers[ti];
    for (let k = 0; k < 40; k += 1) {
      const stu = students[(ti * 17 + k) % students.length];
      subAttDocs.push({
        remote_id: `seed_subatt_${t.teacher_id}_${k}`,
        teacher_id: t.teacher_id,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        date: k % 2 === 0 ? yesterdayStr : twoDaysAgoStr,
        period: (k % 6) + 1,
        subject: t.subject,
        class_label: `1-${stu.class_no}`,
        roster_key: `${t.subject}__1-${stu.class_no}`,
        student_id: stu.student_id,
        student_name: stu.name,
        status: k % 15 === 0 ? '지각' : '출석',
        memo: '',
        updated_at: nowStr,
      });
    }
  }
  await writeBatchDocs('교과_출결', subAttDocs, (x) => x.remote_id);

  // 5) 과거 누적 수업_진도 (150건: 교사 5명 × 30건)
  const progressDocs = [];
  for (let ti = 0; ti < 5; ti += 1) {
    const t = teachers[ti];
    for (let k = 0; k < 30; k += 1) {
      const classNo = (k % 3) + 1;
      progressDocs.push({
        remote_id: `seed_prog_${t.teacher_id}_${k}`,
        teacher_id: t.teacher_id,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        date: k % 2 === 0 ? yesterdayStr : twoDaysAgoStr,
        period: (k % 6) + 1,
        subject: t.subject,
        class_label: `1-${classNo}`,
        roster_key: `${t.subject}__1-${classNo}`,
        unit: `${(k % 4) + 1}단원`,
        lesson_no: `${k + 1}차시`,
        content: `${t.subject} 핵심 개념 학습 ${k + 1}`,
        status: '완료',
        created_at: nowStr,
        updated_at: nowStr,
      });
    }
  }
  await writeBatchDocs('수업_진도', progressDocs, (x) => x.remote_id);

  // 6) 완료된 Tasks (50건: 교사 5명 × 10건)
  const taskDocs = [];
  for (let ti = 0; ti < 5; ti += 1) {
    const t = teachers[ti];
    for (let k = 0; k < 10; k += 1) {
      taskDocs.push({
        remote_id: `seed_task_${t.teacher_id}_${k}`,
        teacher_id: t.teacher_id,
        task_type: 'comcigan_sync',
        title: `완료된 원격 작업 #${k + 1}`,
        is_mobile_task: true,
        exec_status: 'done',
        is_done: true,
        memo: '처리 완료',
        created_at: nowStr,
        updated_at: nowStr,
      });
    }
  }
  await writeBatchDocs('Tasks', taskDocs, (x) => x.remote_id);

  // 7) Notifications (30건)
  const notiDocs = [];
  for (let i = 0; i < 30; i += 1) {
    const classNo = (i % 3) + 1;
    notiDocs.push({
      remote_id: `seed_noti_${i + 1}`,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      grade: 1,
      class_no: classNo,
      title: `학급 알림 #${i + 1}`,
      message: `1학년 ${classNo}반 안내 사항입니다.`,
      is_read: i >= 15,
      created_at: nowStr,
      updated_at: nowStr,
    });
  }
  await writeBatchDocs('Notifications', notiDocs, (x) => x.remote_id);

  // 8) 실사용 보조 컬렉션 데이터 (일일출결, 서류, 가정통신문, 급식, 채팅, 공지, 회비, 명렬표, 일정, PC상태)
  await writeBatchDocs(
    '일일_출결',
    students.slice(0, 30).map((s, idx) => ({
      remote_id: `att_${ymd}_${s.student_id}`,
      date: todayStr,
      student_id: s.student_id,
      student_name: s.name,
      grade: s.grade,
      class_no: s.class_no,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      attendance_type: idx % 10 === 0 ? '결석' : '출석',
      updated_at: nowStr,
    })),
    (x) => x.remote_id
  );

  await writeBatchDocs(
    '서류_추적',
    students.slice(0, 15).map((s, idx) => ({
      remote_id: `doc_${idx + 1}`,
      student_id: s.student_id,
      grade: s.grade,
      class_no: s.class_no,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      rule_code: 'ABSENCE_REPORT',
      base_date: yesterdayStr,
      status: 'pending',
      updated_at: nowStr,
    })),
    (x) => x.remote_id
  );

  await writeBatchDocs(
    '가정통신문_목록',
    Array.from({ length: 10 }, (_, idx) => ({
      remote_id: `notice_${idx + 1}`,
      title: `가정통신문 #${idx + 1}`,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      target_grade: 1,
      target_class: (idx % 3) + 1,
      is_published: true,
      created_at: nowStr,
    })),
    (x) => x.remote_id
  );

  await writeBatchDocs(
    '가정통신문_회신',
    students.slice(0, 60).map((s, idx) => ({
      remote_id: `reply_${(idx % 10) + 1}_${s.student_id}`,
      notice_id: `notice_${(idx % 10) + 1}`,
      student_id: s.student_id,
      grade: s.grade,
      class_no: s.class_no,
      school_code: SCHOOL_CODE,
      submitted_at: nowStr,
    })),
    (x) => x.remote_id
  );

  await writeBatchDocs(
    '급식_식단표',
    Array.from({ length: 5 }, (_, idx) => {
      const mDate = _kstDateStr(new Date(), idx);
      return {
        remote_id: `meal_${SCHOOL_CODE}_${mDate}`,
        meal_date: mDate,
        date: mDate,
        meal_type: '중식',
        menu_text: '현미밥\n미역국\n불고기\n김치',
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
      };
    }),
    (x) => x.remote_id
  );

  await writeBatchDocs(
    '설정_서류규정',
    [
      { remote_id: 'rule_absence', rule_code: 'ABSENCE_REPORT', due_business_days: 5 },
      { remote_id: 'rule_field_pre', rule_code: 'FIELD_TRIP_PRE', due_business_days: 3 },
      { remote_id: 'rule_field_post', rule_code: 'FIELD_TRIP_POST', due_business_days: 5 },
      { remote_id: 'rule_late', rule_code: 'LATE_REPORT', due_business_days: 5 },
    ],
    (x) => x.remote_id
  );

  const chatSeed = [];
  for (let i = 0; i < 15; i += 1) {
    const s = students[i];
    chatSeed.push(
      {
        remote_id: `seed_chat_${s.student_id}_1`,
        room_id: `ROOM-${s.student_id}`,
        student_id: s.student_id,
        grade: s.grade,
        class_no: s.class_no,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        sender_role: 'student',
        sender_name: s.name,
        message: '선생님, 내일 상담 가능할까요?',
        is_read: true,
        created_at: nowStr,
      },
      {
        remote_id: `seed_chat_${s.student_id}_2`,
        room_id: `ROOM-${s.student_id}`,
        student_id: s.student_id,
        grade: s.grade,
        class_no: s.class_no,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        sender_role: 'teacher',
        sender_name: teachers[s.class_no - 1].name,
        teacher_id: teachers[s.class_no - 1].teacher_id,
        message: '네, 점심시간에 상담실로 오세요.',
        is_read: true,
        created_at: nowStr,
      }
    );
  }
  await writeBatchDocs('1:1_상담채팅', chatSeed, (x) => x.remote_id);

  await writeBatchDocs(
    '학급회비',
    Array.from({ length: 15 }, (_, idx) => ({
      remote_id: `budget_${idx + 1}`,
      grade: 1,
      class_no: (idx % 3) + 1,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      title: `학급 활동비 #${idx + 1}`,
      amount: 15000,
      date: yesterdayStr,
    })),
    (x) => x.remote_id
  );

  await writeBatchDocs(
    '학급_공지게시판',
    Array.from({ length: 12 }, (_, idx) => ({
      remote_id: `board_${idx + 1}`,
      grade: 1,
      class_no: (idx % 3) + 1,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      title: `학급 공지 #${idx + 1}`,
      is_published: true,
      is_pinned: idx < 3,
      published_at: nowStr,
    })),
    (x) => x.remote_id
  );

  const rosterDocs = [];
  for (let ti = 0; ti < 5; ti += 1) {
    const t = teachers[ti];
    for (let c = 1; c <= 3; c += 1) {
      const classStudents = students.filter((s) => s.class_no === c).map((s) => ({
        student_id: s.student_id,
        name: s.name,
        student_no: s.student_no,
      }));
      rosterDocs.push({
        remote_id: `roster_${t.teacher_id}_1_${c}`,
        teacher_id: t.teacher_id,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        subject: t.subject,
        class_label: `1-${c}`,
        roster_key: `${t.subject}__1-${c}`,
        students: classStudents,
      });
    }
  }
  await writeBatchDocs('교과_명렬표', rosterDocs, (x) => x.remote_id);

  await writeBatchDocs(
    'Schedules',
    Array.from({ length: 12 }, (_, idx) => ({
      remote_id: `sched_${idx + 1}`,
      title: `학사일정 #${idx + 1}`,
      start_date: _kstDateStr(new Date(), idx),
      end_date: _kstDateStr(new Date(), idx),
      date: _kstDateStr(new Date(), idx),
      is_private: false,
      visibility: 'public',
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
    })),
    (x) => x.remote_id
  );

  await writeBatchDocs(
    'PC_Agent_Status',
    teachers.slice(0, 5).map((t) => ({
      remote_id: t.teacher_id,
      teacher_id: t.teacher_id,
      school_code: SCHOOL_CODE,
      school_name: SCHOOL_NAME,
      pc_online: true,
      pc_last_seen_at: new Date().toISOString(),
      pc_hostname: `PC-${t.teacher_id}`,
      pc_app_version: '2.5.0',
      updated_at: nowStr,
    })),
    (x) => x.remote_id
  );

  return { teachers, students, todayStr };
}

// ---------------------------------------------------------------------------
// 7. 하루치 시나리오 실행
// ---------------------------------------------------------------------------
async function runDailySimulation() {
  const seed = await seedVirtualSchoolData();
  const { teachers, students, todayStr } = seed;

  // 로그인 세션 토큰 미리 발급 (시뮬레이션 전 준비 단계이므로 카운트 초기화 전 수행)
  metrics.setBucket('auth_setup');
  const teacherTokens = new Map();
  for (const t of teachers) {
    const loginRes = await invokeApi({
      method: 'POST',
      body: { action: 'login', role: 'teacher', user_id: t.teacher_id, password: 'pass1234' },
    });
    if (!loginRes.json || !loginRes.json.token) {
      throw new Error(`Failed to login ${t.teacher_id}: ${JSON.stringify(loginRes)}`);
    }
    teacherTokens.set(t.teacher_id, loginRes.json.token);
  }

  // 순수 하루치 운영 트래픽만 측정하도록 카운터 및 서버 정적 캐시 초기화
  metrics.reset();
  if (globalThis.__eduflowStaticCache) {
    globalThis.__eduflowStaticCache.clear();
  }

  // -------------------------------------------------------------------------
  // [시나리오 1] 학생 105명 × 하루 4회 접속/새로고침 (get_mobile_bundle)
  // -------------------------------------------------------------------------
  metrics.setBucket('학생 모바일 번들 (105명×4회)');
  for (let wave = 1; wave <= 4; wave += 1) {
    // 각 접속 시간대(등교/점심/방과후/저녁) 간격이 10분 이상이라 서버 메모리 캐시 만료 시뮬레이션
    if (globalThis.__eduflowStaticCache) {
      globalThis.__eduflowStaticCache.clear();
    }
    for (const s of students) {
      const query = {
        action: 'get_mobile_bundle',
        role: 'student',
        user_id: s.student_id,
        student_id: s.student_id,
        grade: String(s.grade),
        class_no: String(s.class_no),
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
      };
      // app.js 실제 동작: 하루 1회차 이후에는 localStorage 일일 정적 캐시로 skip_static=1 전송
      if (wave > 1) {
        query.skip_static = '1';
      }
      await invokeApi({ method: 'GET', query, bucket: '학생 모바일 번들 (105명×4회)' });
    }
  }

  // -------------------------------------------------------------------------
  // [시나리오 2] 학생 앱 실시간 리스너 초기 구독 (app.js _startRealtimeListeners)
  // -------------------------------------------------------------------------
  metrics.setBucket('학생 알림 실시간 리스너 (105명)');
  for (let i = 0; i < students.length; i += 1) {
    metrics.recordApiCall('학생 알림 실시간 리스너 (105명)');
    await db
      .collection('Notifications')
      .where('school_code', '==', SCHOOL_CODE)
      .limit(10)
      .get();
  }

  // -------------------------------------------------------------------------
  // [시나리오 3] 학생 일부(21명) 1:1 채팅 탭 진입 + 10명 메시지 전송/교사 읽음
  // -------------------------------------------------------------------------
  metrics.setBucket('1:1 채팅 진입 및 상담');
  const chatUsers = students.filter((_, idx) => idx % 5 === 0); // 21명
  for (const s of chatUsers) {
    // app.js _setChatTabRealtimeActive(true)의 초기 onSnapshot 쿼리 재현
    metrics.recordApiCall('1:1 채팅 진입 및 상담');
    await db
      .collection('1:1_상담채팅')
      .where('room_id', '==', `ROOM-${s.student_id}`)
      .limit(50)
      .get();
  }
  for (let i = 0; i < 10; i += 1) {
    const s = chatUsers[i];
    const roomId = `ROOM-${s.student_id}`;
    await invokeApi({
      method: 'POST',
      bucket: '1:1 채팅 진입 및 상담',
      body: {
        action: 'send_chat_message',
        sender_role: 'student',
        student_id: s.student_id,
        room_id: roomId,
        grade: s.grade,
        class_no: s.class_no,
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
        sender_name: s.name,
        message: '오늘 과제 제출 기한 문의드립니다.',
      },
    });
    const homeroomTeacher = teachers[s.class_no - 1];
    await invokeApi({
      method: 'POST',
      bucket: '1:1 채팅 진입 및 상담',
      body: {
        action: 'mark_chat_read',
        reader_role: 'teacher',
        room_id: roomId,
        student_id: s.student_id,
        grade: s.grade,
        class_no: s.class_no,
        auth_teacher_id: homeroomTeacher.teacher_id,
        auth_token: teacherTokens.get(homeroomTeacher.teacher_id),
      },
    });
  }

  // -------------------------------------------------------------------------
  // [시나리오 4] 교사 5명 × 하루 10회 홈 새로고침 (get_mobile_bundle)
  // -------------------------------------------------------------------------
  metrics.setBucket('교사 홈 새로고침 (5명×10회)');
  for (let refresh = 1; refresh <= 10; refresh += 1) {
    // 교시마다(1시간 간격 가정) 서버 캐시 만료 시뮬레이션
    if (globalThis.__eduflowStaticCache && refresh % 2 === 1) {
      globalThis.__eduflowStaticCache.clear();
    }
    for (const t of teachers.slice(0, 5)) {
      const query = {
        action: 'get_mobile_bundle',
        role: 'teacher',
        user_id: t.teacher_id,
        teacher_name: t.name,
        grade: t.grade !== null ? String(t.grade) : '',
        class_no: t.class_no !== null ? String(t.class_no) : '',
        school_code: SCHOOL_CODE,
        school_name: SCHOOL_NAME,
      };
      if (refresh > 1) {
        query.skip_static = '1';
      }
      await invokeApi({ method: 'GET', query, bucket: '교사 홈 새로고침 (5명×10회)' });
    }
  }
  // 교사 5명 앱 초기 Notifications 리스너 구독
  for (let i = 0; i < 5; i += 1) {
    metrics.recordApiCall('교사 홈 새로고침 (5명×10회)');
    await db
      .collection('Notifications')
      .where('school_code', '==', SCHOOL_CODE)
      .limit(10)
      .get();
  }

  // -------------------------------------------------------------------------
  // [시나리오 5] 교사 5명 × 하루 6교시 출결/진도 저장
  // -------------------------------------------------------------------------
  metrics.setBucket('교사 출결/진도 저장 (5명×6교시)');
  for (const t of teachers.slice(0, 5)) {
    const token = teacherTokens.get(t.teacher_id);
    for (let period = 1; period <= 6; period += 1) {
      const targetClassNo = ((period - 1) % 3) + 1;
      const classStudents = students.filter((s) => s.class_no === targetClassNo);
      await invokeApi({
        method: 'POST',
        bucket: '교사 출결/진도 저장 (5명×6교시)',
        body: {
          action: 'save_subject_attendance_batch',
          auth_teacher_id: t.teacher_id,
          auth_token: token,
          date: todayStr,
          period: String(period),
          subject: t.subject,
          class_label: `1-${targetClassNo}`,
          roster_key: `${t.subject}__1-${targetClassNo}`,
          records: classStudents.map((s, idx) => ({
            student_id: s.student_id,
            student_name: s.name,
            status: idx === 0 && period === 1 ? '지각' : '출석',
            memo: '',
          })),
        },
      });

      await invokeApi({
        method: 'POST',
        bucket: '교사 출결/진도 저장 (5명×6교시)',
        body: {
          action: 'upsert_lesson_progress',
          auth_teacher_id: t.teacher_id,
          auth_token: token,
          date: todayStr,
          period: String(period),
          subject: t.subject,
          class_label: `1-${targetClassNo}`,
          unit: '2단원',
          lesson_no: `${period}차시`,
          content: `${todayStr} ${period}교시 수업 진행`,
          status: '완료',
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // [시나리오 6] 관리자 개요 조회 3회 (admin_get_class_overview)
  // -------------------------------------------------------------------------
  metrics.setBucket('관리자 개요 조회 (3회)');
  const adminToken = teacherTokens.get('admin_1');
  for (let i = 0; i < 3; i += 1) {
    await invokeApi({
      method: 'POST',
      bucket: '관리자 개요 조회 (3회)',
      body: {
        action: 'admin_get_class_overview',
        auth_teacher_id: 'admin_1',
        auth_token: adminToken,
      },
    });
  }

  // -------------------------------------------------------------------------
  // [시나리오 7] PC 앱 워커 8시간분 폴링 (60초 간격 = 480회)
  // -------------------------------------------------------------------------
  metrics.setBucket('PC 워커 작업 폴링 (480회)');
  const workerToken = teacherTokens.get('teacher_1');
  for (let tick = 0; tick < 480; tick += 1) {
    await invokeApi({
      method: 'POST',
      bucket: 'PC 워커 작업 폴링 (480회)',
      body: {
        action: 'fetch_pending_remote_tasks',
        auth_teacher_id: 'teacher_1',
        auth_token: workerToken,
      },
    });
  }

  // -------------------------------------------------------------------------
  // [시나리오 8] PC 앱 워커 8시간분 하트비트 (60초 간격 = 480회)
  // -------------------------------------------------------------------------
  metrics.setBucket('PC 워커 하트비트 (480회)');
  for (let tick = 0; tick < 480; tick += 1) {
    await invokeApi({
      method: 'POST',
      bucket: 'PC 워커 하트비트 (480회)',
      body: {
        action: 'update_pc_agent_status',
        auth_teacher_id: 'teacher_1',
        auth_token: workerToken,
        pc_online: true,
        pc_last_seen_at: new Date().toISOString(),
        pc_hostname: 'PC-teacher_1',
        pc_app_version: '2.5.0',
      },
    });
  }

  return { todayStr, snap: metrics.snapshot() };
}

// ---------------------------------------------------------------------------
// 8. 리포트 출력
// ---------------------------------------------------------------------------
function formatNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function formatPct(n, limit) {
  return `${((Number(n || 0) / limit) * 100).toFixed(2)}%`;
}

function padRight(str, width) {
  let visualLen = 0;
  for (const ch of String(str)) {
    visualLen += /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(ch) ? 2 : 1;
  }
  const pad = Math.max(0, width - visualLen);
  return String(str) + ' '.repeat(pad);
}

function padLeft(str, width) {
  const s = String(str);
  return ' '.repeat(Math.max(0, width - s.length)) + s;
}

function printReport({ todayStr, snap }) {
  console.log('\n================================================================================');
  console.log(' Eduflow_mobile 하루치 Firestore DB 읽기/쓰기 부하 시뮬레이션 리포트');
  console.log('================================================================================');
  console.log(`- 실행 기준일(KST): ${todayStr}`);
  console.log(`- 실행 엔진: ${db._mode}`);
  console.log('- 시드 규모: 학급 3개(1-1~1-3, 각 35명=총 105명), 교사 5명, 관리자 1명');
  console.log('             시간표_스냅샷(오늘자 1건), 교과_출결(200건), 수업_진도(150건), Tasks(50건), Notifications(30건)');
  console.log(`- API 호출 실패 건수: ${failedCalls.length}`);
  if (failedCalls.length > 0) {
    console.log('  실패 상세:', failedCalls.slice(0, 5));
  }

  console.log('\n[1] 기능별 Read / Write / Delete 및 무료 일일 한도 대비 비율');
  console.log('    (무료 일일 한도 기준: Read 50,000건 / Write 20,000건 / Delete 20,000건)');
  console.log('--------------------------------------------------------------------------------');
  console.log(
    `${padRight('기능 (시나리오)', 34)} | ${padLeft('호출', 6)} | ${padLeft('Read', 8)} | ${padLeft('Read%', 7)} | ${padLeft('Write', 7)} | ${padLeft('Write%', 7)}`
  );
  console.log('--------------------------------------------------------------------------------');

  let totalCalls = 0;
  let totalReads = 0;
  let totalWrites = 0;
  let totalDeletes = 0;

  for (const [name, stat] of snap.buckets.entries()) {
    totalCalls += stat.apiCalls;
    totalReads += stat.reads;
    totalWrites += stat.writes;
    totalDeletes += stat.deletes;
    console.log(
      `${padRight(name, 34)} | ${padLeft(formatNum(stat.apiCalls), 6)} | ${padLeft(formatNum(stat.reads), 8)} | ${padLeft(formatPct(stat.reads, FREE_DAILY_READ_LIMIT), 7)} | ${padLeft(formatNum(stat.writes), 7)} | ${padLeft(formatPct(stat.writes, FREE_DAILY_WRITE_LIMIT), 7)}`
    );
  }

  console.log('--------------------------------------------------------------------------------');
  console.log(
    `${padRight('총합 (하루치 전체)', 34)} | ${padLeft(formatNum(totalCalls), 6)} | ${padLeft(formatNum(totalReads), 8)} | ${padLeft(formatPct(totalReads, FREE_DAILY_READ_LIMIT), 7)} | ${padLeft(formatNum(totalWrites), 7)} | ${padLeft(formatPct(totalWrites, FREE_DAILY_WRITE_LIMIT), 7)}`
  );
  if (totalDeletes > 0) {
    console.log(`  * Delete 총합: ${formatNum(totalDeletes)}건 (${formatPct(totalDeletes, FREE_DAILY_DELETE_LIMIT)})`);
  }

  console.log('\n[2] 컬렉션별 Read / Write Top 10');
  console.log('--------------------------------------------------------------------------------');
  console.log(
    `${padRight('컬렉션명', 28)} | ${padLeft('Read', 10)} | ${padLeft('Read 비중', 9)} | ${padLeft('Write', 9)} | ${padLeft('Write 비중', 10)}`
  );
  console.log('--------------------------------------------------------------------------------');

  const sortedCols = Array.from(snap.collections.entries())
    .sort((a, b) => (b[1].reads + b[1].writes) - (a[1].reads + a[1].writes))
    .slice(0, 10);

  for (const [colName, stat] of sortedCols) {
    const rShare = totalReads > 0 ? `${((stat.reads / totalReads) * 100).toFixed(1)}%` : '0.0%';
    const wShare = totalWrites > 0 ? `${((stat.writes / totalWrites) * 100).toFixed(1)}%` : '0.0%';
    console.log(
      `${padRight(colName, 28)} | ${padLeft(formatNum(stat.reads), 10)} | ${padLeft(rShare, 9)} | ${padLeft(formatNum(stat.writes), 9)} | ${padLeft(wShare, 10)}`
    );
  }
  console.log('--------------------------------------------------------------------------------');

  const teacherStat = snap.buckets.get('교사 홈 새로고침 (5명×10회)');
  if (teacherStat && teacherStat.byCollection) {
    const bundleReads = teacherStat.reads - 50; // 초기 Notifications 리스너 5명×10건 제외 참고 가능, 전체 평균도 표시
    const avgPerRefresh = (teacherStat.reads / 50).toFixed(1);
    const avgBundleOnly = (bundleReads / 50).toFixed(1);
    console.log('\n[2-1] 교사 홈 새로고침(5명×10회=50회 + 초기알림 5회) 컬렉션별 Read 내역');
    console.log(`- 50회 총 Read: ${formatNum(teacherStat.reads)}건 (전체 평균 ${avgPerRefresh} Read/회, 번들 단독 평균 ${avgBundleOnly} Read/회)`);
    console.log('--------------------------------------------------------------------------------');
    const teacherCols = Array.from(teacherStat.byCollection.entries()).sort((a, b) => b[1] - a[1]);
    for (const [colName, rCnt] of teacherCols) {
      console.log(
        `  ${padRight(colName, 26)} | ${padLeft(formatNum(rCnt), 8)} Read | 평균 ${(rCnt / 50).toFixed(1)} Read/회`
      );
    }
    console.log('--------------------------------------------------------------------------------');
  }

  const pollStat = snap.buckets.get('PC 워커 작업 폴링 (480회)') || { reads: 0, writes: 0 };
  const hbStat = snap.buckets.get('PC 워커 하트비트 (480회)') || { reads: 0, writes: 0 };
  const worker1Reads = pollStat.reads + hbStat.reads;
  const worker1Writes = pollStat.writes + hbStat.writes;
  const projected5WorkersReads = totalReads + worker1Reads * 4;
  const projected5WorkersWrites = totalWrites + worker1Writes * 4;

  console.log('\n[3] 운영 참고 (PC 워커 다중 교사 가동 시 추정치)');
  console.log(
    `- PC 워커 1대(8시간, 60초 간격) 단독 비용: Read ${formatNum(worker1Reads)}건 / Write ${formatNum(worker1Writes)}건`
  );
  console.log(
    `- 교사 5명 전원이 PC 워커를 동시 8시간 가동할 경우 하루 총합 추정: ` +
    `Read ${formatNum(projected5WorkersReads)}건 (${formatPct(projected5WorkersReads, FREE_DAILY_READ_LIMIT)}) / ` +
    `Write ${formatNum(projected5WorkersWrites)}건 (${formatPct(projected5WorkersWrites, FREE_DAILY_WRITE_LIMIT)})`
  );
  console.log('================================================================================\n');
}

const result = await runDailySimulation();
printReport(result);

if (failedCalls.length > 0) {
  process.exitCode = 1;
}
