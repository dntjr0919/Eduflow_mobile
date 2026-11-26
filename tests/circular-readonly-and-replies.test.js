const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function makeElement(id) {
  return {
    id,
    innerHTML: '',
    innerText: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    classList: {
      _set: new Set(),
      add(...cls) { cls.forEach(c => this._set.add(c)); },
      remove(...cls) { cls.forEach(c => this._set.delete(c)); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._set.has(c)) this._set.delete(c);
          else this._set.add(c);
        } else if (force) this._set.add(c);
        else this._set.delete(c);
      },
      contains(c) { return this._set.has(c); }
    }
  };
}

function setupMockDom(ids = []) {
  const elements = new Map();
  ids.forEach(id => elements.set(id, makeElement(id)));
  const toasts = [];
  const openedModals = [];

  global.document = {
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    }
  };
  global.showToast = (msg, icon) => { toasts.push({ msg, icon }); };
  global.openModal = (id) => { openedModals.push(id); };
  global.closeModal = () => {};
  global._escapeNoticeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  global._parseNoticeReplySchema = (json, arr) => {
    if (Array.isArray(arr)) return arr;
    if (!json) return [];
    try { const p = JSON.parse(json); return Array.isArray(p) ? p : []; } catch (_) { return []; }
  };
  global.normalizeCircularAttachmentUrl = (c) => (c && c.attachmentUrl) || '';

  return { elements, toasts, openedModals };
}

test('teacher.js removes fake print queue toast and handles 0 vs >0 submitted replies', () => {
  const teacherSource = fs.readFileSync(path.resolve(__dirname, '../teacher.js'), 'utf8');
  assert.equal(teacherSource.includes('인쇄 대기열로 전송되었습니다'), false);

  const { elements, toasts, openedModals } = setupMockDom([
    'teacherCircularsContainer',
    'teacherCircularCount',
    'submittedRepliesModalTitle',
    'submittedRepliesModalSubtitle',
    'submittedRepliesModalList',
  ]);

  global.state = {};
  global.mockData = {
    students: [
      { student_id: 's1', student_no: 1, name: '김철수', parent_name: '김부모' },
      { student_id: 's2', student_no: 2, name: '이영희', parent_name: '이부모' },
    ],
    circulars: [
      {
        id: 'n_empty',
        title: '현장체험학습 동의서',
        deadline: '2026-12-01 마감',
        isPublished: true,
        requiresReply: true,
        signatureMode: 'parent',
        submittedCount: 0,
        totalCount: 2,
        submittedStudentIds: [],
        replies: [],
      },
      {
        id: 'n_with_replies',
        title: '수련회 참가 신청서',
        deadline: '2026-12-05 마감',
        isPublished: true,
        requiresReply: true,
        signatureMode: 'both',
        submittedCount: 1,
        totalCount: 2,
        submittedStudentIds: ['s1'],
        replies: [
          {
            student_id: 's1',
            student_name: '김철수',
            parent_name: '김부모',
            consent: '동의',
            reply_file_drive_url: 'https://drive.google.com/file/d/reply1/view',
            signature_drive_url: 'https://drive.google.com/file/d/sig_parent1/view',
            student_signature_drive_url: 'https://drive.google.com/file/d/sig_stu1/view',
            signed_at: '2026-11-26 10:00:00',
          }
        ],
      },
      {
        id: 'n_readonly',
        title: '12월 보건소식지 안내',
        deadline: '상시',
        isPublished: true,
        requiresReply: false,
        signatureMode: 'none',
        submittedCount: 0,
        totalCount: 36,
        submittedStudentIds: [],
        replies: [],
      },
    ],
  };

  const teacher = require('../teacher.js');

  // 1) renderTeacherCirculars: read-only card hides 0/36명 제출, progress bar, unsubmitted & reply buttons
  teacher.renderTeacherCirculars();
  const containerHtml = elements.get('teacherCircularsContainer').innerHTML;
  assert.ok(containerHtml.includes('열람용 (회신 불필요)'));
  assert.equal(containerHtml.includes('0/36명 제출'), false);
  assert.equal(containerHtml.includes('미제출자 명단 (36명)'), false);
  assert.ok(containerHtml.includes("openSubmittedRepliesModal('n_with_replies')"));

  // 2) 0 replies -> shows toast and does not open modal
  teacher.openSubmittedRepliesModal('n_empty');
  assert.equal(openedModals.length, 0);
  assert.equal(toasts[0].msg, '아직 제출된 회신이 없습니다.');

  // 3) >0 replies -> opens submittedRepliesModal with drive URLs
  teacher.openSubmittedRepliesModal('n_with_replies');
  assert.deepEqual(openedModals, ['submittedRepliesModal']);
  const listHtml = elements.get('submittedRepliesModalList').innerHTML;
  assert.ok(listHtml.includes('https://drive.google.com/file/d/reply1/view'));
  assert.ok(listHtml.includes('https://drive.google.com/file/d/sig_parent1/view'));
  assert.ok(listHtml.includes('https://drive.google.com/file/d/sig_stu1/view'));
});

test('student.js renders read-only circular as 열람용 (회신 불필요) without 미제출', () => {
  const { elements } = setupMockDom(['circularsList']);
  global.mockData = {
    circulars: [
      {
        id: 'n_ro',
        title: '겨울방학 안전 안내문',
        deadline: '상시',
        isPublished: true,
        requiresReply: false,
        signatureMode: 'none',
        status: 'pending',
      }
    ]
  };
  const student = require('../student.js');
  student.renderCirculars();
  const html = elements.get('circularsList').innerHTML;
  assert.ok(html.includes('열람용 (회신 불필요)'));
  assert.equal(html.includes('미제출'), false);
});

test('admin/admin.js marks read-only notice as 열람용 (회신 불필요) instead of 0% / 미제출', () => {
  const { elements } = setupMockDom([
    'letter-doc-selector',
    'letter-edit-btn',
    'letter-delete-btn',
    'letter-doc-meta',
    'kpi-letters-total',
    'kpi-letters-completed',
    'kpi-letters-rate',
    'kpi-letters-pending',
    'kpi-letters-bar-ok',
    'kpi-letters-bar-pending',
    'badge-letters-rate',
    'filter-all',
    'filter-completed',
    'filter-pending',
    'letters-filtered-count',
    'letters-table-head',
    'letters-table-body',
  ]);
  global.escapeHtml = (s) => String(s ?? '');
  global._escapeJsAttr = (s) => String(s ?? '');
  const admin = require('../admin/admin.js');
  admin.adminState.selectedNoticeId = 'n_ro';
  admin.adminState.letterFilter = 'all';
  admin.adminState.letterSearch = '';
  admin.adminState.overview = {
    notices: [
      { remote_id: 'n_ro', title: '열람용 안내', requires_reply: false, signature_mode: 'none', due_date: '' }
    ],
    students: [
      { student_id: 's1', student_no: 1, name: '김철수', status: 'active' },
      { student_id: 's2', student_no: 2, name: '이영희', status: 'active' },
    ],
    replies: []
  };

  admin.renderLettersTab();
  assert.equal(elements.get('kpi-letters-rate').textContent, '열람용 (회신 불필요)');
  assert.equal(elements.get('kpi-letters-pending').textContent, '0');
  assert.equal(elements.get('badge-letters-rate').textContent, '열람용');
  const tbodyHtml = elements.get('letters-table-body').innerHTML;
  assert.ok(tbodyHtml.includes('열람용 (회신 불필요)'));
  assert.equal(tbodyHtml.includes('미제출'), false);
});
