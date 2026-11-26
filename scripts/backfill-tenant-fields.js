#!/usr/bin/env node
/**
 * Legacy Firestore 문서 테넌트 필드(school_code, school_name, grade, class_no, target_role 등) 백필 스크립트
 *
 * 기본 실행은 --dry-run 모드로 동작하며 실제 DB를 변경하지 않습니다.
 * 실제 반영하려면 --apply 옵션을 전달하세요:
 *   node scripts/backfill-tenant-fields.js --dry-run
 *   node scripts/backfill-tenant-fields.js --apply
 */

const fs = require('fs');
const path = require('path');
const { getFirestore } = require('../api/_firebaseAdmin');

const TARGET_COLLECTIONS = [
  '1:1_상담채팅',
  '학급회비',
  '학급회비_장부',
  '학급_공지게시판',
  'Notifications',
  '일일_출결',
  '서류_추적',
  '가정통신문_목록',
  '가정통신문_회신',
  'Schedules',
];

function _loadLocalEnvIfNeeded() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || process.env.FIREBASE_PRIVATE_KEY) return;
  const candidates = ['.env.local', '.env'];
  for (const name of candidates) {
    const full = path.resolve(process.cwd(), name);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

function _toIntOrNull(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function _normName(val) {
  return String(val || '')
    .trim()
    .replace(/(선생님|교사|담임)$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function _inferGradeClassFromStudentId(sid) {
  const s = String(sid || '').trim();
  const m5 = s.match(/^(\d)(\d{2})\d{2}$/);
  if (m5) return { grade: Number(m5[1]), class_no: Number(m5[2]) };
  const m4 = s.match(/^(\d)(\d)\d{2}$/);
  if (m4) return { grade: Number(m4[1]), class_no: Number(m4[2]) };
  return { grade: null, class_no: null };
}

function _extractTenantFromRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    school_code: String(rec.school_code || rec.neis_school_code || '').trim(),
    school_name: String(rec.school_name || '').trim(),
    grade: _toIntOrNull(rec.grade ?? rec.target_grade),
    class_no: _toIntOrNull(rec.class_no ?? rec.target_class),
    teacher_id: String(rec.teacher_id || '').trim(),
  };
}

function buildAccountIndex(teachers = [], students = [], notices = []) {
  const teachersById = new Map();
  const teachersByName = new Map();
  const teachersByClass = new Map();
  const studentsById = new Map();
  const schoolByClass = new Map();
  const noticesById = new Map();

  const registerUnique = (map, key, val) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, val);
    else map.set(key, null); // ambiguous
  };

  for (const t of teachers) {
    const info = _extractTenantFromRecord(t);
    if (!info) continue;
    const tid = String(t.teacher_id || t.remote_id || t.id || '').trim();
    const tWithId = { ...info, teacher_id: tid || info.teacher_id };
    for (const k of [tid, t.remote_id, t.login_id, t.custom_id]) {
      const key = String(k || '').trim();
      if (key) teachersById.set(key, tWithId);
    }
    const nameKey = _normName(t.name);
    if (nameKey) registerUnique(teachersByName, nameKey, tWithId);
    if (info.grade !== null && info.class_no !== null) {
      registerUnique(teachersByClass, `${info.grade}_${info.class_no}`, tWithId);
      if (info.school_code || info.school_name) {
        registerUnique(schoolByClass, `${info.grade}_${info.class_no}`, info);
      }
    }
  }

  for (const s of students) {
    const info = _extractTenantFromRecord(s);
    if (!info) continue;
    for (const k of [s.student_id, s.remote_id, s.login_id, s.custom_id]) {
      const key = String(k || '').trim();
      if (key) studentsById.set(key, info);
    }
    if (info.grade !== null && info.class_no !== null && (info.school_code || info.school_name)) {
      registerUnique(schoolByClass, `${info.grade}_${info.class_no}`, info);
    }
  }

  for (const n of notices) {
    const nid = String(n.remote_id || n.id || '').trim();
    if (!nid) continue;
    const info = _extractTenantFromRecord(n);
    if (info) noticesById.set(nid, info);
  }

  return {
    teachersById,
    teachersByName,
    teachersByClass,
    studentsById,
    schoolByClass,
    noticesById,
  };
}

function _extractRoomStudentId(doc) {
  const direct = String(doc.student_id || doc.target_student_id || '').trim();
  if (direct && direct.toUpperCase() !== 'ALL') return direct;
  const roomId = String(doc.room_id || '').trim();
  if (roomId.startsWith('ROOM-') && roomId !== 'ROOM-DEFAULT') {
    return roomId.slice(5).trim();
  }
  return '';
}

function computeBackfillPatch(collectionName, doc, index) {
  if (!doc || typeof doc !== 'object') return null;

  const isNoticeList = collectionName === '가정통신문_목록';
  const curSchoolCode = String(doc.school_code || doc.neis_school_code || '').trim();
  const curSchoolName = String(doc.school_name || '').trim();
  const curGrade = _toIntOrNull(isNoticeList ? (doc.target_grade ?? doc.grade) : (doc.grade ?? doc.target_grade));
  const curClassNo = _toIntOrNull(isNoticeList ? (doc.target_class ?? doc.class_no) : (doc.class_no ?? doc.target_class));
  const curTeacherId = String(doc.teacher_id || doc.author_id || '').trim();

  const sid = _extractRoomStudentId(doc);
  const stuInfo = sid ? index.studentsById.get(sid) : null;
  const noticeId = String(doc.notice_id || '').trim();
  const noticeInfo = noticeId ? index.noticesById.get(noticeId) : null;

  const teacherById = curTeacherId ? index.teachersById.get(curTeacherId) : null;
  const authorNameKey = _normName(doc.author_name || doc.sender || doc.sender_name || '');
  const teacherByName = authorNameKey ? index.teachersByName.get(authorNameKey) : null;

  const inferredFromSid = sid ? _inferGradeClassFromStudentId(sid) : { grade: null, class_no: null };
  let resolvedGrade = curGrade ?? (stuInfo && stuInfo.grade) ?? (noticeInfo && noticeInfo.grade) ?? (teacherById && teacherById.grade) ?? (teacherByName && teacherByName.grade) ?? inferredFromSid.grade;
  let resolvedClassNo = curClassNo ?? (stuInfo && stuInfo.class_no) ?? (noticeInfo && noticeInfo.class_no) ?? (teacherById && teacherById.class_no) ?? (teacherByName && teacherByName.class_no) ?? inferredFromSid.class_no;

  const classKey = (resolvedGrade !== null && resolvedClassNo !== null) ? `${resolvedGrade}_${resolvedClassNo}` : '';
  const teacherByClass = classKey ? index.teachersByClass.get(classKey) : null;
  const schoolByClass = classKey ? index.schoolByClass.get(classKey) : null;

  const resolvedSchoolCode = curSchoolCode
    || (stuInfo && stuInfo.school_code)
    || (noticeInfo && noticeInfo.school_code)
    || (teacherById && teacherById.school_code)
    || (teacherByName && teacherByName.school_code)
    || (teacherByClass && teacherByClass.school_code)
    || (schoolByClass && schoolByClass.school_code)
    || '';

  const resolvedSchoolName = curSchoolName
    || (stuInfo && stuInfo.school_name)
    || (noticeInfo && noticeInfo.school_name)
    || (teacherById && teacherById.school_name)
    || (teacherByName && teacherByName.school_name)
    || (teacherByClass && teacherByClass.school_name)
    || (schoolByClass && schoolByClass.school_name)
    || '';

  const resolvedTeacherId = curTeacherId
    || (noticeInfo && noticeInfo.teacher_id)
    || (teacherByName && teacherByName.teacher_id)
    || (teacherByClass && teacherByClass.teacher_id)
    || '';

  const patch = {};
  if (!curSchoolCode && resolvedSchoolCode) patch.school_code = resolvedSchoolCode;
  if (!curSchoolName && resolvedSchoolName) patch.school_name = resolvedSchoolName;

  if (isNoticeList) {
    if (_toIntOrNull(doc.target_grade) === null && resolvedGrade !== null) patch.target_grade = resolvedGrade;
    if (_toIntOrNull(doc.target_class) === null && resolvedClassNo !== null) patch.target_class = resolvedClassNo;
  } else {
    if (_toIntOrNull(doc.grade) === null && resolvedGrade !== null) patch.grade = resolvedGrade;
    if (_toIntOrNull(doc.class_no) === null && resolvedClassNo !== null) patch.class_no = resolvedClassNo;
  }

  if (!String(doc.teacher_id || '').trim() && resolvedTeacherId && collectionName !== '일일_출결' && collectionName !== '서류_추적') {
    patch.teacher_id = resolvedTeacherId;
  }

  if (collectionName === '1:1_상담채팅') {
    if (!String(doc.student_id || '').trim() && sid) patch.student_id = sid;
  }

  if (collectionName === 'Notifications') {
    const rawTargetRole = String(doc.target_role || '').trim().toLowerCase();
    if (!rawTargetRole) patch.target_role = 'all';
    const rawSid = String(doc.student_id || '').trim();
    const rawTargetSid = String(doc.target_student_id || '').trim();
    if (rawSid.toUpperCase() === 'ALL') patch.student_id = '';
    else if (doc.student_id === undefined) patch.student_id = rawTargetSid.toUpperCase() === 'ALL' ? '' : rawTargetSid;
    if (rawTargetSid.toUpperCase() === 'ALL') patch.target_student_id = '';
    if (!Array.isArray(doc.read_by)) patch.read_by = [];
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

async function runBackfill(db, { apply = false, collections = TARGET_COLLECTIONS, sampleLimit = 5 } = {}) {
  const [teacherSnap, studentSnap, noticeSnap] = await Promise.all([
    db.collection('계정_교사').get(),
    db.collection('계정_학생').get(),
    db.collection('가정통신문_목록').get(),
  ]);

  const toRows = (snap) => {
    const rows = [];
    snap.forEach((d) => rows.push({ id: d.id, remote_id: d.id, ...(d.data() || {}) }));
    return rows;
  };

  const index = buildAccountIndex(toRows(teacherSnap), toRows(studentSnap), toRows(noticeSnap));
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    collections: {},
    totalScanned: 0,
    totalUpdated: 0,
  };

  for (const colName of collections) {
    const snap = await db.collection(colName).get();
    const updates = [];
    snap.forEach((d) => {
      const data = d.data() || {};
      const patch = computeBackfillPatch(colName, { remote_id: d.id, ...data }, index);
      if (patch) {
        updates.push({ ref: d.ref, id: d.id, patch });
      }
    });

    if (apply && updates.length > 0) {
      const CHUNK_SIZE = 400;
      for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
        const batch = db.batch();
        const chunk = updates.slice(i, i + CHUNK_SIZE);
        for (const u of chunk) {
          batch.set(u.ref, u.patch, { merge: true });
        }
        await batch.commit();
      }
    }

    summary.totalScanned += snap.size;
    summary.totalUpdated += updates.length;
    summary.collections[colName] = {
      scanned: snap.size,
      toUpdate: updates.length,
      samples: updates.slice(0, sampleLimit).map((u) => ({ id: u.id, patch: u.patch })),
    };
  }

  return summary;
}

if (require.main === module) {
  (async () => {
    _loadLocalEnvIfNeeded();
    const args = new Set(process.argv.slice(2));
    const apply = args.has('--apply');
    const db = getFirestore();
    const summary = await runBackfill(db, { apply });
    console.log(JSON.stringify(summary, null, 2));
    if (!apply) {
      console.log('\n[DRY-RUN] 실제 반영하려면 --apply 옵션을 추가해 실행하세요:');
      console.log('  node scripts/backfill-tenant-fields.js --apply');
    } else {
      console.log(`\n[APPLY] 총 ${summary.totalUpdated}건 업데이트 완료.`);
    }
  })().catch((err) => {
    console.error('[backfill-tenant-fields] 실패:', err);
    process.exit(1);
  });
}

module.exports = {
  TARGET_COLLECTIONS,
  buildAccountIndex,
  computeBackfillPatch,
  runBackfill,
};
