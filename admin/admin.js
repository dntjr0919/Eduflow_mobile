const AUTO_LOGIN_STORAGE_KEY = 'eduflow_saved_auth';
const API_ENDPOINT = '/api/firestore';

function getLocalTodayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDateStr(dateStr, deltaDays) {
  const parts = String(dateStr || getLocalTodayStr()).split('-').map(Number);
  const d = parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date();
  d.setDate(d.getDate() + deltaDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const adminState = {
  auth: null, // { role: 'teacher', userId, password, passwordHash }
  overview: null,
  activeTab: 'tab-letters',
  selectedNoticeId: '',
  letterFilter: 'all',
  letterSearch: '',
  attSubtab: 'daily', // 'daily' | 'summary'
  attDailyDate: getLocalTodayStr(),
  attPeriod: 'month',
  rosterSearch: '',
  counselSearch: '',
  selectedCounselStudentId: '',
  pwResetTarget: null, // { role, remoteId, label }
  lessonCompareSubject: '',
  lessonProgSubject: '',
  lessonProgClass: '',
  lessonAttDate: '',
  lessonAttSubject: '',
  lessonAttClass: '',
};

function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadSavedAuth() {
  try {
    const raw = localStorage.getItem(AUTO_LOGIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.userId || !parsed.role) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function saveTeacherAuth(auth) {
  try {
    localStorage.setItem(AUTO_LOGIN_STORAGE_KEY, JSON.stringify({
      role: 'teacher',
      userId: auth.userId,
      password: auth.password || '',
      passwordHash: auth.passwordHash || '',
      savedAt: Date.now(),
    }));
  } catch (_) {}
}

function clearSavedAuth() {
  try {
    localStorage.removeItem(AUTO_LOGIN_STORAGE_KEY);
  } catch (_) {}
}

async function callApi(action, payload = {}, includeAuth = true) {
  const body = { action, ...payload };
  if (includeAuth && adminState.auth) {
    body.auth_teacher_id = adminState.auth.userId;
    if (adminState.auth.password) body.auth_password = adminState.auth.password;
    if (adminState.auth.passwordHash) body.auth_password_hash = adminState.auth.passwordHash;
  }
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: '응답 파싱 실패' }));
  if (!res.ok || !json.ok) {
    const err = new Error(json.error || `API 오류 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function showGate(gateName, noticeText = '', errorText = '') {
  const loadingGate = document.getElementById('admin-loading-gate');
  const authGate = document.getElementById('admin-auth-gate');
  const appShell = document.getElementById('admin-app-shell');

  loadingGate.classList.add('hidden');
  authGate.classList.add('hidden');
  appShell.classList.add('hidden');

  if (gateName === 'loading') loadingGate.classList.remove('hidden');
  if (gateName === 'auth') {
    authGate.classList.remove('hidden');
    const noticeBox = document.getElementById('admin-auth-notice');
    const noticeEl = document.getElementById('admin-auth-notice-text');
    if (noticeText) {
      noticeEl.textContent = noticeText;
      noticeBox.classList.remove('hidden');
    } else {
      noticeBox.classList.add('hidden');
    }
    const errBox = document.getElementById('admin-login-error');
    const errEl = document.getElementById('admin-login-error-text');
    if (errorText) {
      errEl.textContent = errorText;
      errBox.classList.remove('hidden');
    } else {
      errBox.classList.add('hidden');
    }
  }
  if (gateName === 'app') appShell.classList.remove('hidden');
}

function setRefreshSpinning(isSpinning) {
  document.querySelectorAll('.refresh-spin-icon').forEach((icon) => {
    if (isSpinning) icon.classList.add('fa-spin');
    else icon.classList.remove('fa-spin');
  });
}

async function refreshAdminData() {
  if (!adminState.auth) return;
  setRefreshSpinning(true);
  try {
    const data = await callApi('admin_get_class_overview', {}, true);
    adminState.overview = data;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeEl = document.getElementById('last-synced-time');
    if (timeEl) timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    renderAll();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      adminState.auth = null;
      showGate('auth', '', err.message);
    } else {
      alert(`데이터 조회 실패: ${err.message}`);
    }
  } finally {
    setRefreshSpinning(false);
  }
}

function renderSidebarProfile() {
  const ov = adminState.overview || {};
  const teacher = ov.teacher || {};
  const scope = ov.scope || {};
  const name = teacher.name || scope.teacher_id || '교사';
  const school = scope.school_name || teacher.school_name || '학교 미지정';
  const gradeClass = (scope.grade !== null && scope.grade !== undefined && scope.class_no !== null && scope.class_no !== undefined)
    ? `${scope.grade}학년 ${scope.class_no}반`
    : '학급 미지정';
  const stuCount = (ov.students || []).filter((s) => String(s.status || 'active').toLowerCase() !== 'rejected').length;

  const avatarChar = String(name).trim().slice(0, 2) || '교';
  const mobileAvatar = document.getElementById('mobile-teacher-avatar');
  const sideAvatar = document.getElementById('sidebar-teacher-avatar');
  const sideName = document.getElementById('sidebar-teacher-name');
  const sideClass = document.getElementById('sidebar-teacher-class');
  const mobileBadge = document.getElementById('mobile-class-badge');

  if (mobileAvatar) mobileAvatar.textContent = avatarChar.slice(0, 1);
  if (sideAvatar) sideAvatar.textContent = avatarChar;
  if (sideName) sideName.textContent = `${name} 선생님`;
  if (sideClass) sideClass.textContent = `${school} · ${gradeClass} (${stuCount}명)`;
  if (mobileBadge) mobileBadge.textContent = gradeClass;

  const docPending = (ov.documents || []).filter((d) => {
    const st = String(d.status || '').toLowerCase();
    return st !== 'closed' && st !== 'confirmed' && !d.teacher_confirmed;
  }).length;
  const rosterBadge = document.getElementById('badge-roster-count');
  const attBadge = document.getElementById('badge-attendance-docs');
  const counselBadge = document.getElementById('badge-counsel-count');
  if (rosterBadge) rosterBadge.textContent = `${stuCount}명`;
  if (attBadge) attBadge.textContent = `서류 ${docPending}건`;

  const chatStudents = new Set((ov.chats || []).map((c) => String(c.student_id || '').trim()).filter(Boolean));
  if (counselBadge) counselBadge.textContent = String(chatStudents.size);

  const lessonsBadge = document.getElementById('badge-lessons-count');
  if (lessonsBadge) lessonsBadge.textContent = String((ov.lesson_progress || []).length);
}

// =========================================================================
// TAB 1: 가정통신문 회신·서명 대장
// =========================================================================
function parseNoticeSchema(notice) {
  if (!notice) return [];
  let raw = notice.reply_fields || notice.reply_schema || notice.reply_schema_json || [];
  if (typeof raw === 'string') {
    try { raw = raw.trim() ? JSON.parse(raw) : []; } catch (_) { raw = []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((f, idx) => {
    if (!f || typeof f !== 'object') return null;
    const name = String(f.name || f.id || `field_${idx}`).trim();
    const label = String(f.label || f.title || name).trim();
    return { name, label, type: String(f.type || 'text') };
  }).filter(Boolean);
}

function buildLettersLedgerRows() {
  const ov = adminState.overview || {};
  const notices = ov.notices || [];
  const students = (ov.students || []).filter((s) => {
    const st = String(s.status || 'active').toLowerCase();
    return st !== 'rejected' && st !== 'inactive' && st !== 'disabled';
  });
  const replies = ov.replies || [];

  if (!adminState.selectedNoticeId && notices.length > 0) {
    adminState.selectedNoticeId = String(notices[0].remote_id || notices[0].id || '');
  }
  const notice = notices.find((n) => String(n.remote_id || n.id || '') === adminState.selectedNoticeId) || notices[0] || null;
  const noticeId = notice ? String(notice.remote_id || notice.id || '') : '';
  const schema = parseNoticeSchema(notice);

  const replyMap = new Map();
  replies.forEach((r) => {
    if (String(r.notice_id || '') === noticeId && r.student_id) {
      replyMap.set(String(r.student_id).trim(), r);
    }
  });

  const rows = students.map((s) => {
    const sid = String(s.student_id || s.remote_id || '').trim();
    const reply = replyMap.get(sid) || null;
    let parsedData = {};
    if (reply) {
      const rawData = reply.reply_data || reply.reply_data_json || reply.answers_json || {};
      if (typeof rawData === 'string') {
        try { parsedData = rawData.trim() ? JSON.parse(rawData) : {}; } catch (_) { parsedData = {}; }
      } else if (rawData && typeof rawData === 'object') {
        parsedData = rawData;
      }
    }
    const answers = {};
    schema.forEach((col) => {
      const v = parsedData[col.name] !== undefined ? parsedData[col.name] : parsedData[col.label];
      answers[col.name] = Array.isArray(v) ? v.join(', ') : (v !== undefined && v !== null ? String(v) : '');
    });

    return {
      student_id: sid,
      student_no: s.student_no ?? '',
      student_name: String(s.name || s.student_name || sid),
      parent_name: String((reply && reply.parent_name) || s.parent_name || ''),
      status: reply ? 'completed' : 'pending',
      answers,
      consent: reply ? String(reply.consent || reply.reply_choice || '제출') : '',
      memo: reply ? String(reply.memo || '') : '',
      signature_drive_url: reply ? String(reply.signature_drive_url || '') : '',
      student_signature_drive_url: reply ? String(reply.student_signature_drive_url || '') : '',
      reply_file_drive_url: reply ? String(reply.reply_file_drive_url || '') : '',
      signed_at: reply ? String(reply.signed_at || '') : '',
      submitted_at: reply ? String(reply.submitted_at || reply.updated_at || '') : '',
    };
  });

  return { notice, notices, schema, rows };
}

function renderLettersTab() {
  const { notice, notices, schema, rows } = buildLettersLedgerRows();
  const sel = document.getElementById('letter-doc-selector');
  if (sel) {
    if (notices.length === 0) {
      sel.innerHTML = '<option value="">등록된 가정통신문이 없습니다</option>';
    } else {
      sel.innerHTML = notices.map((n) => {
        const nid = String(n.remote_id || n.id || '');
        const selected = nid === String(notice && (notice.remote_id || notice.id)) ? 'selected' : '';
        const due = n.due_date ? ` (마감: ${n.due_date})` : '';
        return `<option value="${escapeHtml(nid)}" ${selected}>${escapeHtml(n.title || nid)}${escapeHtml(due)}</option>`;
      }).join('');
    }
  }

  const metaEl = document.getElementById('letter-doc-meta');
  if (metaEl) {
    const dueText = notice && notice.due_date ? notice.due_date : '상시';
    const sigMode = notice && notice.signature_mode === 'both' ? '학생+학부모 서명' : '단일 서명';
    metaEl.innerHTML = `<i class="fa-regular fa-clock text-slate-400"></i><span>마감: <strong class="text-slate-800">${escapeHtml(dueText)}</strong></span><span class="text-slate-300">|</span><span class="text-indigo-600 font-semibold">${escapeHtml(sigMode)}</span>`;
  }

  const total = rows.length;
  const completedCount = rows.filter((r) => r.status === 'completed').length;
  const pendingCount = total - completedCount;
  const ratePct = total > 0 ? ((completedCount / total) * 100).toFixed(1) : '0.0';

  document.getElementById('kpi-letters-total').textContent = String(total);
  document.getElementById('kpi-letters-completed').textContent = String(completedCount);
  document.getElementById('kpi-letters-rate').textContent = `${ratePct}% 회신`;
  document.getElementById('kpi-letters-pending').textContent = String(pendingCount);
  document.getElementById('kpi-letters-bar-ok').style.width = `${ratePct}%`;
  document.getElementById('kpi-letters-bar-pending').style.width = `${total > 0 ? ((pendingCount / total) * 100).toFixed(1) : 0}%`;

  const navBadge = document.getElementById('badge-letters-rate');
  if (navBadge) navBadge.textContent = `${Math.round(Number(ratePct))}%`;

  document.getElementById('filter-all').textContent = `전체 (${total})`;
  document.getElementById('filter-completed').textContent = `제출완료 (${completedCount})`;
  document.getElementById('filter-pending').textContent = `미제출 (${pendingCount})`;

  const term = adminState.letterSearch.trim().toLowerCase();
  const filteredRows = rows.filter((r) => {
    const matchFilter = adminState.letterFilter === 'all' || r.status === adminState.letterFilter;
    const matchSearch = !term || r.student_name.toLowerCase().includes(term) || r.student_id.toLowerCase().includes(term);
    return matchFilter && matchSearch;
  });

  document.getElementById('letters-filtered-count').textContent = String(filteredRows.length);

  const thead = document.getElementById('letters-table-head');
  const tbody = document.getElementById('letters-table-body');

  const schemaHeaders = schema.length > 0
    ? schema.map((col) => `<th class="py-3 px-3 text-center bg-indigo-50/40 text-indigo-900 border-x border-slate-200/80">${escapeHtml(col.label)}</th>`).join('')
    : '<th class="py-3 px-3 text-center bg-indigo-50/40 text-indigo-900 border-x border-slate-200/80">회신 선택/메모</th>';

  thead.innerHTML = `
    <tr class="bg-slate-100/80 text-slate-600 border-b border-slate-200 uppercase font-semibold text-[11px] tracking-wider whitespace-nowrap">
      <th class="py-3 px-3.5 table-cell-sticky bg-slate-100 w-20 text-center">학번</th>
      <th class="py-3 px-4 table-cell-sticky bg-slate-100 left-20 w-28">이름</th>
      <th class="py-3 px-3 text-center">제출상태</th>
      ${schemaHeaders}
      <th class="py-3 px-4 text-center">학생 서명</th>
      <th class="py-3 px-4 text-center">학부모 서명</th>
      <th class="py-3 px-4 text-center">제출 일시</th>
    </tr>
  `;

  if (filteredRows.length === 0) {
    const colSpan = 6 + (schema.length > 0 ? schema.length : 1);
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="py-10 text-center text-slate-400">표시할 학생 회신 데이터가 없습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredRows.map((r) => {
    const isOk = r.status === 'completed';
    const statusBadge = isOk
      ? '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800"><i class="fa-solid fa-check text-[9px] mr-1"></i>제출완료</span>'
      : '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-800"><i class="fa-solid fa-clock text-[9px] mr-1"></i>미제출</span>';

    const schemaCells = schema.length > 0
      ? schema.map((col) => {
          const val = isOk ? (r.answers[col.name] || r.consent || '-') : '-';
          const colorCls = !isOk ? 'text-slate-300' : (val.includes('비동의') || val.includes('미참') ? 'text-rose-600 font-semibold' : 'text-slate-800 font-medium');
          return `<td class="py-3 px-3 text-center border-x border-slate-100 ${colorCls}">${escapeHtml(val)}</td>`;
        }).join('')
      : `<td class="py-3 px-3 text-center border-x border-slate-100 text-slate-700">${isOk ? escapeHtml(r.consent || r.memo || '제출') : '-'}</td>`;

    const stuSigCell = r.student_signature_drive_url
      ? `<button type="button" onclick="openSignatureModal('${escapeHtml(r.student_name)} (학생)', '${escapeHtml(r.signed_at || r.submitted_at)}', '${escapeHtml(r.student_signature_drive_url)}')" class="inline-flex items-center gap-1 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg hover:border-indigo-400 text-[11px] font-semibold text-indigo-700"><i class="fa-solid fa-signature"></i><span>보기</span></button>`
      : '<span class="text-slate-300 text-[11px]">-</span>';

    const parSigCell = r.signature_drive_url
      ? `<button type="button" onclick="openSignatureModal('${escapeHtml(r.parent_name || r.student_name + ' 학부모')}', '${escapeHtml(r.signed_at || r.submitted_at)}', '${escapeHtml(r.signature_drive_url)}')" class="inline-flex items-center gap-1 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg hover:border-indigo-400 text-[11px] font-semibold text-indigo-700"><i class="fa-solid fa-signature"></i><span>보기</span></button>`
      : '<span class="text-slate-300 text-[11px]">-</span>';

    return `
      <tr class="hover:bg-indigo-50/30 transition-colors ${isOk ? '' : 'bg-rose-50/15'}">
        <td class="py-3 px-3.5 table-cell-sticky bg-white font-mono text-slate-500 text-center tabular-nums">${escapeHtml(r.student_id || r.student_no)}</td>
        <td class="py-3 px-4 table-cell-sticky bg-white left-20 font-bold text-slate-900 whitespace-nowrap">
          ${escapeHtml(r.student_name)}
          ${r.parent_name ? `<span class="block text-[10px] font-normal text-slate-400">${escapeHtml(r.parent_name)}</span>` : ''}
        </td>
        <td class="py-3 px-3 text-center whitespace-nowrap">${statusBadge}</td>
        ${schemaCells}
        <td class="py-3 px-4 text-center">${stuSigCell}</td>
        <td class="py-3 px-4 text-center">${parSigCell}</td>
        <td class="py-3 px-4 text-center text-slate-500 text-[11px] whitespace-nowrap tabular-nums">${escapeHtml(r.submitted_at || '-')}</td>
      </tr>
    `;
  }).join('');
}

function openSignatureModal(signer, timestamp, url) {
  document.getElementById('sig-signer').textContent = `${signer} 서명`;
  document.getElementById('sig-timestamp').textContent = timestamp || '-';
  document.getElementById('sig-image').src = url;
  document.getElementById('sig-open-link').href = url;
  document.getElementById('signature-modal').classList.remove('hidden');
}

function closeSignatureModal() {
  document.getElementById('signature-modal').classList.add('hidden');
}

// =========================================================================
// TAB 2: 전체 출결 누적표 & 서류 추적 + 일자별 출결 조회
// =========================================================================
function switchAttendanceSubtab(subtab) {
  adminState.attSubtab = subtab === 'summary' ? 'summary' : 'daily';
  const dailyPanel = document.getElementById('att-daily-panel');
  const summaryPanel = document.getElementById('att-summary-panel');
  const dailyBtn = document.getElementById('att-subtab-daily');
  const summaryBtn = document.getElementById('att-subtab-summary');

  const isDaily = adminState.attSubtab === 'daily';
  if (dailyPanel) dailyPanel.classList.toggle('hidden', !isDaily);
  if (summaryPanel) summaryPanel.classList.toggle('hidden', isDaily);
  if (dailyBtn) {
    dailyBtn.className = isDaily
      ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-indigo-700 shadow-2xs transition'
      : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 transition';
  }
  if (summaryBtn) {
    summaryBtn.className = !isDaily
      ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-indigo-700 shadow-2xs transition'
      : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 transition';
  }
}

function formatAttendancePeriodInfo(rec) {
  if (!rec) return '-';
  if (rec.periods) return String(rec.periods);
  if (rec.start_period && rec.end_period) return `${rec.start_period}~${rec.end_period}교시`;
  if (rec.period !== undefined && rec.period !== null && rec.period !== '') return `${rec.period}교시`;
  return '종일';
}

function buildDailyAttendanceRows(selectedDate) {
  const ov = adminState.overview || {};
  const students = (ov.students || []).filter((s) => {
    const st = String(s.status || 'active').toLowerCase();
    return st !== 'rejected' && st !== 'inactive' && st !== 'disabled';
  });
  const dayRecords = (ov.attendance || []).filter((a) => String(a.date || '').slice(0, 10) === selectedDate);
  const recBySid = new Map();
  dayRecords.forEach((rec) => {
    const sid = String(rec.student_id || '').trim();
    if (!sid) return;
    if (!recBySid.has(sid)) recBySid.set(sid, []);
    recBySid.get(sid).push(rec);
  });

  return students.map((s) => {
    const sid = String(s.student_id || s.remote_id || '').trim();
    const list = recBySid.get(sid) || [];
    if (list.length === 0) {
      return {
        student_id: sid,
        student_no: s.student_no ?? '',
        student_name: String(s.name || s.student_name || sid),
        status: '출석',
        period_info: '-',
        reason: '-',
        teacher_confirmed: true,
        remote_id: '',
        has_record: false,
      };
    }
    const primary = list[0];
    const types = list.map((r) => String(r.attendance_type || '출결')).join(', ');
    const periods = list.map(formatAttendancePeriodInfo).filter((p) => p !== '-').join(', ') || '-';
    const reasons = list.map((r) => String(r.reason || '').trim()).filter(Boolean).join(' / ') || '-';
    const allConfirmed = list.every((r) => Boolean(r.teacher_confirmed));
    return {
      student_id: sid,
      student_no: s.student_no ?? '',
      student_name: String(s.name || s.student_name || sid),
      status: types,
      period_info: periods,
      reason: reasons,
      teacher_confirmed: allConfirmed,
      remote_id: String(primary.remote_id || ''),
      has_record: true,
    };
  });
}

function renderDailyAttendancePanel() {
  const selectedDate = adminState.attDailyDate || getLocalTodayStr();
  const dateInput = document.getElementById('att-daily-date');
  const dateLabel = document.getElementById('att-daily-date-label');
  if (dateInput && dateInput.value !== selectedDate) dateInput.value = selectedDate;
  if (dateLabel) dateLabel.textContent = selectedDate;

  const rows = buildDailyAttendanceRows(selectedDate);
  let present = 0;
  let absent = 0;
  let late = 0;
  let field = 0;
  rows.forEach((r) => {
    const st = r.status;
    if (st.includes('결석')) absent += 1;
    else if (st.includes('지각') || st.includes('조퇴')) late += 1;
    else if (st.includes('체험') || st.includes('인정')) field += 1;
    else present += 1;
  });

  const elP = document.getElementById('kpi-daily-present');
  const elA = document.getElementById('kpi-daily-absent');
  const elL = document.getElementById('kpi-daily-late');
  const elF = document.getElementById('kpi-daily-field');
  if (elP) elP.innerHTML = `${present}<span class="text-xs font-normal text-slate-500 ml-1">명</span>`;
  if (elA) elA.innerHTML = `${absent}<span class="text-xs font-normal text-slate-500 ml-1">명</span>`;
  if (elL) elL.innerHTML = `${late}<span class="text-xs font-normal text-slate-500 ml-1">명</span>`;
  if (elF) elF.innerHTML = `${field}<span class="text-xs font-normal text-slate-500 ml-1">명</span>`;

  const tbody = document.getElementById('att-daily-tbody');
  if (!tbody) return;
  tbody.innerHTML = rows.length === 0
    ? '<tr><td colspan="6" class="py-8 text-center text-slate-400">학급 학생 명렬이 없습니다.</td></tr>'
    : rows.map((r) => {
        const st = r.status;
        let badgeCls = 'bg-emerald-100 text-emerald-700';
        if (st.includes('결석')) badgeCls = 'bg-rose-100 text-rose-700';
        else if (st.includes('지각') || st.includes('조퇴')) badgeCls = 'bg-amber-100 text-amber-800';
        else if (st.includes('체험') || st.includes('인정')) badgeCls = 'bg-indigo-100 text-indigo-700';

        const confirmCell = !r.has_record
          ? '<span class="text-slate-300 text-[11px]">-</span>'
          : (r.teacher_confirmed
            ? '<span class="text-emerald-600 font-semibold text-[11px]">확인완료</span>'
            : `<button type="button" onclick="confirmAttendanceRow('${escapeHtml(r.remote_id)}')" class="px-2 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-[11px] font-semibold">담임 확인</button>`);

        return `
          <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(r.student_id || r.student_no)}</td>
            <td class="py-2.5 px-4 font-bold text-slate-900">${escapeHtml(r.student_name)}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeCls}">${escapeHtml(st)}</span></td>
            <td class="py-2.5 px-3 text-center text-slate-600 whitespace-nowrap">${escapeHtml(r.period_info)}</td>
            <td class="py-2.5 px-4 text-slate-600">${escapeHtml(r.reason)}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">${confirmCell}</td>
          </tr>
        `;
      }).join('');
}

function exportDailyAttendanceCsv() {
  const selectedDate = adminState.attDailyDate || getLocalTodayStr();
  const rows = buildDailyAttendanceRows(selectedDate);
  const headers = ['일자', '학번', '이름', '출결상태', '교시정보', '사유', '교사확인'];
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((r) => {
    lines.push([
      selectedDate,
      r.student_id || r.student_no,
      r.student_name,
      r.status,
      r.period_info,
      r.reason,
      !r.has_record ? '-' : (r.teacher_confirmed ? '확인완료' : '미확인'),
    ].map(csvEscape).join(','));
  });
  downloadFileWithBom(`학급_일자별_출결_${selectedDate}.csv`, lines.join('\r\n'));
}

function filterAttendanceByPeriod(attendanceRows, period) {
  if (period === 'all') return attendanceRows;
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  if (period === 'month') {
    const ym = todayStr.slice(0, 7);
    return attendanceRows.filter((a) => String(a.date || '').startsWith(ym));
  }
  if (period === 'week') {
    const start = new Date(now);
    const day = start.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
    const startStr = start.toISOString().slice(0, 10);
    return attendanceRows.filter((a) => {
      const d = String(a.date || '').slice(0, 10);
      return d >= startStr && d <= todayStr;
    });
  }
  return attendanceRows;
}

function renderAttendanceTab() {
  renderDailyAttendancePanel();
  const ov = adminState.overview || {};
  const students = (ov.students || []).filter((s) => String(s.status || 'active').toLowerCase() !== 'rejected');
  const allAtt = ov.attendance || [];
  const filteredAtt = filterAttendanceByPeriod(allAtt, adminState.attPeriod);
  const docs = ov.documents || [];

  let absentCnt = 0;
  let lateEarlyCnt = 0;
  let fieldCnt = 0;
  const summaryMap = new Map();
  students.forEach((s) => {
    const sid = String(s.student_id || s.remote_id || '').trim();
    summaryMap.set(sid, {
      student_id: sid,
      student_no: s.student_no ?? '',
      name: String(s.name || s.student_name || sid),
      present: 0, absent: 0, late: 0, early: 0, field: 0, unconfirmed: 0,
    });
  });

  filteredAtt.forEach((a) => {
    const sid = String(a.student_id || '').trim();
    const type = String(a.attendance_type || '');
    if (!summaryMap.has(sid)) {
      summaryMap.set(sid, {
        student_id: sid, student_no: '', name: String(a.student_name || sid),
        present: 0, absent: 0, late: 0, early: 0, field: 0, unconfirmed: 0,
      });
    }
    const row = summaryMap.get(sid);
    if (type.includes('결석')) { row.absent += 1; absentCnt += 1; }
    else if (type.includes('지각')) { row.late += 1; lateEarlyCnt += 1; }
    else if (type.includes('조퇴')) { row.early += 1; lateEarlyCnt += 1; }
    else if (type.includes('체험') || type.includes('인정')) { row.field += 1; fieldCnt += 1; }
    else { row.present += 1; }
    if (!a.teacher_confirmed) row.unconfirmed += 1;
  });

  const pendingDocs = docs.filter((d) => {
    const st = String(d.status || '').toLowerCase();
    return st !== 'closed' && st !== 'confirmed' && !d.teacher_confirmed;
  }).length;

  document.getElementById('kpi-att-absent').innerHTML = `${absentCnt}<span class="text-xs font-normal text-slate-500 ml-1">건</span>`;
  document.getElementById('kpi-att-late').innerHTML = `${lateEarlyCnt}<span class="text-xs font-normal text-slate-500 ml-1">건</span>`;
  document.getElementById('kpi-att-field').innerHTML = `${fieldCnt}<span class="text-xs font-normal text-slate-500 ml-1">건</span>`;
  document.getElementById('kpi-att-doc-pending').innerHTML = `${pendingDocs}<span class="text-xs font-normal text-slate-500 ml-1">건</span>`;

  const sumTbody = document.getElementById('att-summary-tbody');
  const sumRows = Array.from(summaryMap.values());
  sumTbody.innerHTML = sumRows.length === 0
    ? '<tr><td colspan="8" class="py-8 text-center text-slate-400">학생 데이터가 없습니다.</td></tr>'
    : sumRows.map((r) => `
      <tr class="hover:bg-slate-50">
        <td class="py-2.5 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(r.student_id || r.student_no)}</td>
        <td class="py-2.5 px-4 font-bold text-slate-900">${escapeHtml(r.name)}</td>
        <td class="py-2.5 px-3 text-center tabular-nums text-emerald-700">${r.present}</td>
        <td class="py-2.5 px-3 text-center tabular-nums ${r.absent > 0 ? 'text-rose-600 font-bold' : 'text-slate-400'}">${r.absent}</td>
        <td class="py-2.5 px-3 text-center tabular-nums ${r.late > 0 ? 'text-amber-600 font-bold' : 'text-slate-400'}">${r.late}</td>
        <td class="py-2.5 px-3 text-center tabular-nums ${r.early > 0 ? 'text-amber-600 font-bold' : 'text-slate-400'}">${r.early}</td>
        <td class="py-2.5 px-3 text-center tabular-nums text-indigo-600">${r.field}</td>
        <td class="py-2.5 px-3 text-center tabular-nums">${r.unconfirmed > 0 ? `<span class="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 font-bold text-[11px]">${r.unconfirmed}</span>` : '<span class="text-slate-300">0</span>'}</td>
      </tr>
    `).join('');

  const detTbody = document.getElementById('att-detail-tbody');
  detTbody.innerHTML = filteredAtt.length === 0
    ? '<tr><td colspan="5" class="py-8 text-center text-slate-400">해당 기간 출결 기록이 없습니다.</td></tr>'
    : filteredAtt.map((a) => {
        const rid = String(a.remote_id || '');
        const confirmed = Boolean(a.teacher_confirmed);
        return `
          <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(a.date || '-')}</td>
            <td class="py-2.5 px-3 font-semibold text-slate-800 whitespace-nowrap">${escapeHtml(a.student_name || a.student_id)}</td>
            <td class="py-2.5 px-3 whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700">${escapeHtml(a.attendance_type || '-')}</span></td>
            <td class="py-2.5 px-3 text-slate-600 max-w-[180px] truncate" title="${escapeHtml(a.reason || '')}">${escapeHtml(a.reason || '-')}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">
              ${confirmed
                ? '<span class="text-emerald-600 font-semibold text-[11px]">확인됨</span>'
                : `<button type="button" onclick="confirmAttendanceRow('${escapeHtml(rid)}')" class="px-2 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-[11px] font-semibold">담임 확인</button>`}
            </td>
          </tr>
        `;
      }).join('');

  const docTbody = document.getElementById('doc-tracking-tbody');
  docTbody.innerHTML = docs.length === 0
    ? '<tr><td colspan="5" class="py-8 text-center text-slate-400">추적 중인 증빙 서류가 없습니다.</td></tr>'
    : docs.map((d) => {
        const rid = String(d.remote_id || '');
        const st = String(d.status || 'pending').toLowerCase();
        const isClosed = st === 'closed' || st === 'confirmed' || d.teacher_confirmed;
        const statusHtml = isClosed
          ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700">확인완료</span>'
          : (st === 'submitted'
            ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700">제출됨</span>'
            : '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-700">미제출</span>');
        const actionBtn = isClosed
          ? `<button type="button" onclick="confirmDocRow('${escapeHtml(rid)}', 'pending')" class="px-2 py-1 bg-slate-100 text-slate-600 hover:bg-slate-200 rounded-lg text-[11px] font-semibold">미제출 전환</button>`
          : `<button type="button" onclick="confirmDocRow('${escapeHtml(rid)}', 'closed')" class="px-2 py-1 bg-emerald-600 text-white hover:bg-emerald-700 rounded-lg text-[11px] font-semibold">제출 확인</button>`;
        return `
          <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-3 font-semibold text-slate-800 whitespace-nowrap">${escapeHtml(d.student_name || d.student_id)}</td>
            <td class="py-2.5 px-3 text-slate-700">${escapeHtml(d.doc_name || d.rule_name || d.rule_code || '증빙서류')}</td>
            <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(d.due_date || '-')}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">${statusHtml}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">${actionBtn}</td>
          </tr>
        `;
      }).join('');
}

async function confirmAttendanceRow(remoteId) {
  try {
    await callApi('confirm_attendance', { remote_id: remoteId }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`출결 확인 실패: ${err.message}`);
  }
}

async function confirmDocRow(remoteId, targetStatus) {
  try {
    await callApi('confirm_document', { remote_id: remoteId, status: targetStatus }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`서류 상태 변경 실패: ${err.message}`);
  }
}

// =========================================================================
// TAB 3: 우리 반 명렬표 & 계정 관리
// =========================================================================
function renderRosterTab() {
  const ov = adminState.overview || {};
  const students = ov.students || [];
  const parents = ov.parents || [];

  const pendingItems = [];
  students.forEach((s) => {
    if (String(s.status || '').toLowerCase() === 'pending') pendingItems.push({ role: 'student', doc: s });
  });
  parents.forEach((p) => {
    if (String(p.status || '').toLowerCase() === 'pending') pendingItems.push({ role: 'parent', doc: p });
  });

  document.getElementById('kpi-roster-students').textContent = `${students.length}명`;
  document.getElementById('kpi-roster-parents').textContent = `${parents.length}명`;
  document.getElementById('kpi-roster-pending').textContent = `${pendingItems.length}건`;

  const pendingCard = document.getElementById('roster-pending-card');
  const pendingList = document.getElementById('roster-pending-list');
  if (pendingItems.length > 0) {
    pendingCard.classList.remove('hidden');
    pendingList.innerHTML = pendingItems.map(({ role, doc }) => {
      const rid = String(doc.remote_id || '');
      const roleLabel = role === 'parent' ? '학부모' : '학생';
      const loginId = doc.custom_id || doc.student_id || doc.parent_id || doc.login_id || rid;
      return `
        <div class="bg-white rounded-xl border border-amber-200 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div class="text-xs">
            <span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px] mr-1.5">${roleLabel}</span>
            <strong class="text-slate-900">${escapeHtml(doc.name || doc.student_name || loginId)}</strong>
            <span class="text-slate-500 ml-2">ID: ${escapeHtml(loginId)} · 학번: ${escapeHtml(doc.student_id || '-')}</span>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" onclick="reviewPendingAccount('${role}', '${escapeHtml(rid)}', 'approve')" class="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-semibold hover:bg-emerald-700">승인</button>
            <button type="button" onclick="reviewPendingAccount('${role}', '${escapeHtml(rid)}', 'reject')" class="px-3 py-1.5 bg-rose-50 text-rose-700 border border-rose-200 rounded-lg text-xs font-semibold hover:bg-rose-100">반려</button>
          </div>
        </div>
      `;
    }).join('');
  } else {
    pendingCard.classList.add('hidden');
    pendingList.innerHTML = '';
  }

  const parentBySid = new Map();
  parents.forEach((p) => {
    const sid = String(p.student_id || '').trim();
    if (sid && !parentBySid.has(sid)) parentBySid.set(sid, p);
  });

  const term = adminState.rosterSearch.trim().toLowerCase();
  const filtered = students.filter((s) => {
    if (!term) return true;
    const p = parentBySid.get(String(s.student_id || '').trim());
    return String(s.name || '').toLowerCase().includes(term) ||
      String(s.student_id || '').toLowerCase().includes(term) ||
      String(s.custom_id || '').toLowerCase().includes(term) ||
      (p && String(p.name || '').toLowerCase().includes(term));
  });

  const statusPill = (st) => {
    const low = String(st || 'active').toLowerCase();
    if (low === 'pending') return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800">승인대기</span>';
    if (low === 'rejected') return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-800">반려</span>';
    return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800">활성</span>';
  };

  const tbody = document.getElementById('roster-tbody');
  tbody.innerHTML = filtered.length === 0
    ? '<tr><td colspan="7" class="py-8 text-center text-slate-400">조회된 학생 계정이 없습니다.</td></tr>'
    : filtered.map((s) => {
        const sid = String(s.student_id || '').trim();
        const sRid = String(s.remote_id || sid);
        const sLogin = s.custom_id || s.student_id || sRid;
        const p = parentBySid.get(sid);
        const pRid = p ? String(p.remote_id || p.parent_id || '') : '';
        const pLogin = p ? (p.custom_id || p.parent_id || p.login_id || pRid) : '-';

        return `
          <tr class="hover:bg-slate-50">
            <td class="py-3 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(sid || s.student_no || '-')}</td>
            <td class="py-3 px-4 font-bold text-slate-900">${escapeHtml(s.name || s.student_name || '-')}</td>
            <td class="py-3 px-3 font-mono text-slate-600">${escapeHtml(sLogin)}</td>
            <td class="py-3 px-3 text-center">${statusPill(s.status)}</td>
            <td class="py-3 px-3 text-slate-700">${p ? `${escapeHtml(p.name || '학부모')} <span class="text-[11px] text-slate-400 font-mono">(${escapeHtml(pLogin)})</span>` : '<span class="text-slate-300">미연동</span>'}</td>
            <td class="py-3 px-3 text-center">${p ? statusPill(p.status) : '<span class="text-slate-300">-</span>'}</td>
            <td class="py-3 px-4 text-center whitespace-nowrap space-x-1">
              <button type="button" onclick="openPwResetModal('student', '${escapeHtml(sRid)}', '${escapeHtml(s.name || sLogin)} (학생)')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">학생 비번초기화</button>
              ${p ? `<button type="button" onclick="openPwResetModal('parent', '${escapeHtml(pRid)}', '${escapeHtml(p.name || pLogin)} (학부모)')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">학부모 비번초기화</button>` : ''}
            </td>
          </tr>
        `;
      }).join('');
}

async function reviewPendingAccount(targetRole, remoteId, decision) {
  try {
    await callApi('review_registration', { target_role: targetRole, remote_id: remoteId, decision }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`처리 실패: ${err.message}`);
  }
}

function openPwResetModal(role, remoteId, label) {
  adminState.pwResetTarget = { role, remoteId, label };
  document.getElementById('pw-reset-target-label').textContent = `대상 계정: ${label}`;
  document.getElementById('pw-reset-input').value = '1234';
  document.getElementById('pw-reset-modal').classList.remove('hidden');
}

function closePwResetModal() {
  adminState.pwResetTarget = null;
  document.getElementById('pw-reset-modal').classList.add('hidden');
}

// =========================================================================
// TAB 4: 학급회비 장부 & 공지·알림
// =========================================================================
function renderLedgerTab() {
  const ov = adminState.overview || {};
  const ledger = ov.ledger || [];
  const boardNotices = ov.board_notices || [];
  const notifications = ov.notifications || [];

  let income = 0;
  let expense = 0;
  ledger.forEach((row) => {
    const amt = Math.abs(Number(row.amount || 0));
    const type = String(row.type || row.tx_type || row.category || '').toLowerCase();
    if (type.includes('수입') || type.includes('입금') || type === 'income' || type === 'in') income += amt;
    else expense += amt;
  });
  const balance = income - expense;

  document.getElementById('kpi-ledger-balance').textContent = `₩ ${balance.toLocaleString('ko-KR')}`;
  document.getElementById('kpi-ledger-income').textContent = `₩ ${income.toLocaleString('ko-KR')}`;
  document.getElementById('kpi-ledger-expense').textContent = `₩ ${expense.toLocaleString('ko-KR')}`;

  const tbody = document.getElementById('ledger-tbody');
  tbody.innerHTML = ledger.length === 0
    ? '<tr><td colspan="7" class="py-8 text-center text-slate-400">등록된 학급회비 입출금 내역이 없습니다.</td></tr>'
    : ledger.map((row) => {
        const rid = String(row.remote_id || '');
        const amt = Math.abs(Number(row.amount || 0));
        const type = String(row.type || row.tx_type || '').trim();
        const isInc = type.includes('수입') || type.includes('입금') || type.toLowerCase() === 'income' || type.toLowerCase() === 'in';
        const storeCard = [row.store, row.card || row.payment_method, row.memo].filter(Boolean).join(' · ') || '-';
        const receiptHtml = row.receipt_url
          ? `<a href="${escapeHtml(row.receipt_url)}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-semibold">보기</a>`
          : '<span class="text-slate-300">-</span>';
        return `
          <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(row.date || row.created_at || '-')}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">
              <span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${isInc ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">${isInc ? '수입' : '지출'}</span>
            </td>
            <td class="py-2.5 px-4 font-semibold text-slate-800">${escapeHtml(row.title || row.description || row.item || '-')}</td>
            <td class="py-2.5 px-4 text-slate-500">${escapeHtml(storeCard)}</td>
            <td class="py-2.5 px-4 text-right font-mono font-bold tabular-nums ${isInc ? 'text-emerald-600' : 'text-rose-600'}">${isInc ? '+' : '-'}${amt.toLocaleString('ko-KR')}원</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">${receiptHtml}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">
              <button type="button" onclick="openBudgetModal('${escapeHtml(rid)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
              <button type="button" onclick="deleteBudgetRow('${escapeHtml(rid)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
            </td>
          </tr>
        `;
      }).join('');

  const boardList = document.getElementById('board-notices-list');
  boardList.innerHTML = boardNotices.length === 0
    ? '<div class="p-6 text-center text-xs text-slate-400">등록된 공지사항이 없습니다.</div>'
    : boardNotices.map((b) => `
      <div class="p-4 hover:bg-slate-50 space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-900">${b.is_pinned ? '📌 ' : ''}${escapeHtml(b.title || '공지')}</span>
          <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold">${escapeHtml(b.source_type || '담임 공지')}</span>
        </div>
        <p class="text-xs text-slate-600 line-clamp-2">${escapeHtml(b.summary || b.content || '')}</p>
        <div class="text-[11px] text-slate-400">${escapeHtml(b.published_at || b.created_at || '')}</div>
      </div>
    `).join('');

  const notiList = document.getElementById('sent-notifications-list');
  notiList.innerHTML = notifications.length === 0
    ? '<div class="p-6 text-center text-xs text-slate-400">발송된 알림 이력이 없습니다.</div>'
    : notifications.map((n) => `
      <div class="p-4 hover:bg-slate-50 space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-900">${escapeHtml(n.title || '알림')}</span>
          <span class="text-[10px] text-slate-400 font-mono">${escapeHtml(n.created_at || '')}</span>
        </div>
        <p class="text-xs text-slate-600">${escapeHtml(n.message || '')}</p>
      </div>
    `).join('');
}

// =========================================================================
// TAB 5: 1:1 상담 기록
// =========================================================================
function getCounselGroups() {
  const ov = adminState.overview || {};
  const chats = ov.chats || [];
  const students = ov.students || [];
  const stuNameMap = new Map();
  students.forEach((s) => {
    const sid = String(s.student_id || '').trim();
    if (sid) stuNameMap.set(sid, String(s.name || s.student_name || sid));
  });

  const groups = new Map();
  chats.forEach((c) => {
    const sid = String(c.student_id || String(c.room_id || '').replace(/^ROOM-/, '')).trim();
    if (!sid) return;
    if (!groups.has(sid)) {
      groups.set(sid, {
        student_id: sid,
        student_name: String(c.student_name || stuNameMap.get(sid) || sid),
        messages: [],
      });
    }
    groups.get(sid).messages.push(c);
  });
  return Array.from(groups.values());
}

function renderCounselTab() {
  const groups = getCounselGroups();
  const term = adminState.counselSearch.trim().toLowerCase();
  const filtered = groups.filter((g) => !term || g.student_name.toLowerCase().includes(term) || g.student_id.toLowerCase().includes(term));

  if (!adminState.selectedCounselStudentId && filtered.length > 0) {
    adminState.selectedCounselStudentId = filtered[0].student_id;
  }

  const listEl = document.getElementById('counsel-student-list');
  listEl.innerHTML = filtered.length === 0
    ? '<div class="p-6 text-center text-xs text-slate-400">상담 채팅 기록이 없습니다.</div>'
    : filtered.map((g) => {
        const lastMsg = g.messages[g.messages.length - 1];
        const active = g.student_id === adminState.selectedCounselStudentId;
        return `
          <button type="button" onclick="selectCounselStudent('${escapeHtml(g.student_id)}')" class="w-full text-left p-3 rounded-xl transition ${active ? 'bg-white border border-indigo-200 shadow-xs' : 'hover:bg-white/70'}">
            <div class="flex justify-between items-center">
              <span class="font-bold text-slate-900 text-xs">${escapeHtml(g.student_name)} <span class="font-mono text-slate-400 font-normal">(${escapeHtml(g.student_id)})</span></span>
              <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-semibold">${g.messages.length}건</span>
            </div>
            <p class="text-[11px] text-slate-500 truncate mt-1">${escapeHtml((lastMsg && (lastMsg.message || lastMsg.text)) || '')}</p>
          </button>
        `;
      }).join('');

  const selected = groups.find((g) => g.student_id === adminState.selectedCounselStudentId) || null;
  const headerEl = document.getElementById('counsel-detail-header');
  const msgEl = document.getElementById('counsel-chat-messages');

  if (!selected) {
    headerEl.innerHTML = '<span class="text-sm font-bold text-slate-800">학생을 선택해 주세요</span>';
    msgEl.innerHTML = '<div class="text-center text-xs text-slate-400 py-12">좌측 목록에서 상담 내역을 확인할 학생을 선택하세요.</div>';
    return;
  }

  headerEl.innerHTML = `
    <div>
      <span class="font-bold text-sm text-slate-900">${escapeHtml(selected.student_name)} (${escapeHtml(selected.student_id)})</span>
      <span class="text-xs text-slate-400 ml-2">총 ${selected.messages.length}개의 메시지</span>
    </div>
  `;

  msgEl.innerHTML = selected.messages.map((m) => {
    const role = String(m.sender_role || m.role || '').toLowerCase();
    const isTeacher = role === 'teacher';
    const senderLabel = m.sender_name || (isTeacher ? '담임교사' : (role === 'parent' ? '학부모' : '학생'));
    return `
      <div class="flex flex-col ${isTeacher ? 'items-end' : 'items-start'}">
        <div class="text-[10px] text-slate-400 mb-1">${escapeHtml(senderLabel)} · ${escapeHtml(m.created_at || '')}</div>
        <div class="max-w-[85%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed ${isTeacher ? 'bg-indigo-600 text-white rounded-tr-xs' : 'bg-white border border-slate-200 text-slate-800 rounded-tl-xs'}">
          ${escapeHtml(m.message || m.text || '')}
        </div>
      </div>
    `;
  }).join('');
}

function selectCounselStudent(sid) {
  adminState.selectedCounselStudentId = sid;
  renderCounselTab();
}

// =========================================================================
// TAB 6: 교과 출결 · 수업 진도
// =========================================================================
function _populateSelectOptions(selectEl, values, currentVal, defaultLabel) {
  if (!selectEl) return;
  const unique = Array.from(new Set(values.filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), 'ko'));
  const opts = [`<option value="">${escapeHtml(defaultLabel)}</option>`];
  unique.forEach((v) => {
    opts.push(`<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${escapeHtml(v)}</option>`);
  });
  selectEl.innerHTML = opts.join('');
}

function renderLessonsTab() {
  const ov = adminState.overview || {};
  const progressList = ov.lesson_progress || [];
  const subAttList = ov.subject_attendance || [];

  const allSubjects = [
    ...progressList.map((p) => String(p.subject || '').trim()),
    ...subAttList.map((a) => String(a.subject || '').trim()),
  ];
  const allClasses = [
    ...progressList.map((p) => String(p.class_label || '').trim()),
    ...subAttList.map((a) => String(a.class_label || '').trim()),
  ];

  _populateSelectOptions(document.getElementById('lesson-compare-subject-filter'), allSubjects, adminState.lessonCompareSubject, '전체 교과');
  _populateSelectOptions(document.getElementById('lesson-prog-subject-filter'), allSubjects, adminState.lessonProgSubject, '전체 과목');
  _populateSelectOptions(document.getElementById('lesson-prog-class-filter'), allClasses, adminState.lessonProgClass, '전체 반');
  _populateSelectOptions(document.getElementById('lesson-att-subject-filter'), allSubjects, adminState.lessonAttSubject, '전체 과목');
  _populateSelectOptions(document.getElementById('lesson-att-class-filter'), allClasses, adminState.lessonAttClass, '전체 반');

  // 1) 반별/교과별 최신 진도 비교표
  const latestByGroup = new Map();
  progressList.forEach((p) => {
    const sub = String(p.subject || '').trim();
    const cls = String(p.class_label || '').trim();
    if (!sub) return;
    if (adminState.lessonCompareSubject && sub !== adminState.lessonCompareSubject) return;
    const key = `${sub}__${cls}`;
    if (!latestByGroup.has(key)) {
      latestByGroup.set(key, p);
    }
  });

  const compareGrid = document.getElementById('lesson-latest-compare-grid');
  if (compareGrid) {
    const groups = Array.from(latestByGroup.values()).sort((a, b) =>
      String(a.subject || '').localeCompare(String(b.subject || ''), 'ko') ||
      String(a.class_label || '').localeCompare(String(b.class_label || ''), 'ko')
    );
    compareGrid.innerHTML = groups.length === 0
      ? '<div class="col-span-full py-8 text-center text-xs text-slate-400">기록된 수업 진도가 없습니다.</div>'
      : groups.map((g) => `
        <div class="p-3.5 rounded-xl border border-slate-200 bg-slate-50/50 space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold text-indigo-700">${escapeHtml(g.subject)} · ${escapeHtml(g.class_label || '-')}</span>
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-600">${escapeHtml(g.lesson_no || '-')}</span>
          </div>
          <div class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(g.unit || '-')}</div>
          <p class="text-[11px] text-slate-600 line-clamp-2">${escapeHtml(g.content || '-')}</p>
          <div class="flex items-center justify-between pt-1 text-[10px] text-slate-400">
            <span>${escapeHtml(g.date || '-')} ${g.period ? `${escapeHtml(g.period)}교시` : ''}</span>
            <button type="button" onclick="openLessonProgressModal('${escapeHtml(g.remote_id || '')}')" class="text-indigo-600 font-semibold hover:underline">수정</button>
          </div>
        </div>
      `).join('');
  }

  // 2) 진도 누적 이력 표
  const filteredProg = progressList.filter((p) => {
    if (adminState.lessonProgSubject && String(p.subject || '').trim() !== adminState.lessonProgSubject) return false;
    if (adminState.lessonProgClass && String(p.class_label || '').trim() !== adminState.lessonProgClass) return false;
    return true;
  });

  const progTbody = document.getElementById('lesson-progress-tbody');
  if (progTbody) {
    progTbody.innerHTML = filteredProg.length === 0
      ? '<tr><td colspan="8" class="py-8 text-center text-slate-400">조회된 수업 진도 이력이 없습니다.</td></tr>'
      : filteredProg.map((p) => {
          const rid = String(p.remote_id || '');
          return `
            <tr class="hover:bg-slate-50">
              <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(p.date || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap">${p.period ? `${escapeHtml(p.period)}교시` : '-'}</td>
              <td class="py-2.5 px-3 font-bold text-slate-800 whitespace-nowrap">${escapeHtml(p.subject || '-')}</td>
              <td class="py-2.5 px-3 whitespace-nowrap">${escapeHtml(p.class_label || '-')}</td>
              <td class="py-2.5 px-3 text-indigo-700 font-semibold whitespace-nowrap">${escapeHtml(p.lesson_no || '-')}</td>
              <td class="py-2.5 px-4">
                <div class="font-semibold text-slate-800">${escapeHtml(p.unit || '-')}</div>
                <div class="text-[11px] text-slate-500">${escapeHtml(p.content || '')}</div>
              </td>
              <td class="py-2.5 px-4 text-slate-500">${escapeHtml(p.next_note || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">
                <button type="button" onclick="openLessonProgressModal('${escapeHtml(rid)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
                <button type="button" onclick="deleteLessonProgressRow('${escapeHtml(rid)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
              </td>
            </tr>
          `;
        }).join('');
  }

  // 3) 교과 출결 조회 표
  const filteredAtt = subAttList.filter((a) => {
    if (adminState.lessonAttDate && String(a.date || '').slice(0, 10) !== adminState.lessonAttDate) return false;
    if (adminState.lessonAttSubject && String(a.subject || '').trim() !== adminState.lessonAttSubject) return false;
    if (adminState.lessonAttClass && String(a.class_label || '').trim() !== adminState.lessonAttClass) return false;
    return true;
  });

  const attTbody = document.getElementById('lesson-att-tbody');
  if (attTbody) {
    attTbody.innerHTML = filteredAtt.length === 0
      ? '<tr><td colspan="8" class="py-8 text-center text-slate-400">조회된 교과 출결 기록이 없습니다.</td></tr>'
      : filteredAtt.map((a) => {
          const st = String(a.status || '출석');
          let badgeCls = 'bg-emerald-100 text-emerald-700';
          if (st.includes('결석')) badgeCls = 'bg-rose-100 text-rose-700';
          else if (st.includes('지각') || st.includes('조퇴')) badgeCls = 'bg-amber-100 text-amber-800';
          else if (st.includes('공결')) badgeCls = 'bg-indigo-100 text-indigo-700';
          return `
            <tr class="hover:bg-slate-50">
              <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(a.date || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap">${a.period ? `${escapeHtml(a.period)}교시` : '-'}</td>
              <td class="py-2.5 px-3 font-semibold text-slate-800 whitespace-nowrap">${escapeHtml(a.subject || '-')}</td>
              <td class="py-2.5 px-3 whitespace-nowrap">${escapeHtml(a.class_label || '-')}</td>
              <td class="py-2.5 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(a.student_id || '-')}</td>
              <td class="py-2.5 px-4 font-bold text-slate-900">${escapeHtml(a.student_name || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeCls}">${escapeHtml(st)}</span></td>
              <td class="py-2.5 px-4 text-slate-500">${escapeHtml(a.memo || '-')}</td>
            </tr>
          `;
        }).join('');
  }
}

function openLessonProgressModal(remoteId = '') {
  const ov = adminState.overview || {};
  const list = ov.lesson_progress || [];
  const item = remoteId ? list.find((p) => String(p.remote_id || '') === remoteId) : null;

  document.getElementById('lesson-prog-modal-title').textContent = item ? '수업 진도 수정' : '수업 진도 추가';
  document.getElementById('lp-remote-id').value = item ? String(item.remote_id || '') : '';
  document.getElementById('lp-date').value = item ? String(item.date || '').slice(0, 10) || getLocalTodayStr() : getLocalTodayStr();
  document.getElementById('lp-period').value = item ? String(item.period || '') : '';
  document.getElementById('lp-subject').value = item ? String(item.subject || '') : '';
  document.getElementById('lp-class-label').value = item ? String(item.class_label || '') : '';
  document.getElementById('lp-unit').value = item ? String(item.unit || '') : '';
  document.getElementById('lp-lesson-no').value = item ? String(item.lesson_no || '') : '';
  document.getElementById('lp-content').value = item ? String(item.content || '') : '';
  document.getElementById('lp-next-note').value = item ? String(item.next_note || '') : '';
  document.getElementById('lesson-progress-modal').classList.remove('hidden');
}

function closeLessonProgressModal() {
  document.getElementById('lesson-progress-modal').classList.add('hidden');
}

async function deleteLessonProgressRow(remoteId) {
  if (!remoteId) return;
  if (!confirm('이 수업 진도 기록을 삭제하시겠습니까?')) return;
  try {
    await callApi('delete_lesson_progress', { remote_id: remoteId }, true);
    if (adminState.overview && Array.isArray(adminState.overview.lesson_progress)) {
      adminState.overview.lesson_progress = adminState.overview.lesson_progress.filter((p) => String(p.remote_id || '') !== remoteId);
    }
    renderSidebarProfile();
    renderLessonsTab();
  } catch (err) {
    alert(`삭제 실패: ${err.message}`);
  }
}

function exportLessonProgressCsv() {
  const ov = adminState.overview || {};
  const list = ov.lesson_progress || [];
  const headers = ['일자', '교시', '과목', '반', '차시/페이지', '단원명', '수업내용', '다음안내'];
  const lines = [headers.map(csvEscape).join(',')];
  list.forEach((p) => {
    lines.push([
      p.date || '',
      p.period || '',
      p.subject || '',
      p.class_label || '',
      p.lesson_no || '',
      p.unit || '',
      p.content || '',
      p.next_note || '',
    ].map(csvEscape).join(','));
  });
  downloadFileWithBom('수업진도_누적이력.csv', lines.join('\r\n'));
}

function exportSubjectAttendanceCsv() {
  const ov = adminState.overview || {};
  const list = ov.subject_attendance || [];
  const headers = ['일자', '교시', '과목', '반', '학번', '이름', '출결상태', '비고'];
  const lines = [headers.map(csvEscape).join(',')];
  list.forEach((a) => {
    lines.push([
      a.date || '',
      a.period || '',
      a.subject || '',
      a.class_label || '',
      a.student_id || '',
      a.student_name || '',
      a.status || '',
      a.memo || '',
    ].map(csvEscape).join(','));
  });
  downloadFileWithBom('교과_출결_조회.csv', lines.join('\r\n'));
}

// =========================================================================
// CSV & TXT 내보내기 (UTF-8 BOM)
// =========================================================================
function downloadFileWithBom(filename, content, mimeType = 'text/csv;charset=utf-8;') {
  const bom = mimeType.includes('csv') ? '\uFEFF' : '';
  const blob = new Blob([bom + content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvEscape(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ');
  return `"${s.replace(/"/g, '""')}"`;
}

function exportLettersCsv() {
  const { notice, schema, rows } = buildLettersLedgerRows();
  const headers = ['학번', '이름', '학부모', '제출상태', ...schema.map((c) => c.label), '제출일시'];
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((r) => {
    const schemaVals = schema.map((c) => (r.status === 'completed' ? (r.answers[c.name] || r.consent || '') : ''));
    lines.push([
      r.student_id || r.student_no,
      r.student_name,
      r.parent_name,
      r.status === 'completed' ? '제출완료' : '미제출',
      ...schemaVals,
      r.submitted_at,
    ].map(csvEscape).join(','));
  });
  const title = (notice && notice.title ? notice.title : '가정통신문').replace(/[\\/:*?"<>|]/g, '_');
  downloadFileWithBom(`${title}_회신대장.csv`, lines.join('\r\n'));
}

function exportAttendanceCsv() {
  const ov = adminState.overview || {};
  const filteredAtt = filterAttendanceByPeriod(ov.attendance || [], adminState.attPeriod);
  const headers = ['일자', '학번', '이름', '출결유형', '사유', '담임확인'];
  const lines = [headers.map(csvEscape).join(',')];
  filteredAtt.forEach((a) => {
    lines.push([
      a.date || '',
      a.student_id || '',
      a.student_name || '',
      a.attendance_type || '',
      a.reason || '',
      a.teacher_confirmed ? '확인' : '미확인',
    ].map(csvEscape).join(','));
  });
  downloadFileWithBom(`학급_출결기록_${adminState.attPeriod}.csv`, lines.join('\r\n'));
}

function openBudgetModal(remoteId = '') {
  const ov = adminState.overview || {};
  const ledger = ov.ledger || [];
  const item = remoteId ? ledger.find((r) => String(r.remote_id || '') === remoteId) : null;

  document.getElementById('budget-modal-title').textContent = item ? '학급회비 내역 수정' : '학급회비 내역 추가';
  document.getElementById('budget-remote-id').value = item ? String(item.remote_id || '') : '';
  document.getElementById('budget-date').value = item ? String(item.date || '').slice(0, 10) || getLocalTodayStr() : getLocalTodayStr();
  const rawType = item ? String(item.type || item.tx_type || '').toLowerCase() : 'expense';
  document.getElementById('budget-type').value = (rawType === 'income' || rawType.includes('수입') || rawType.includes('입금')) ? 'income' : 'expense';
  document.getElementById('budget-title').value = item ? String(item.title || item.description || item.item || '') : '';
  document.getElementById('budget-amount').value = item ? String(Math.abs(Number(item.amount || 0))) : '';
  document.getElementById('budget-store').value = item ? String(item.store || '') : '';
  document.getElementById('budget-card').value = item ? String(item.card || item.payment_method || '') : '';
  document.getElementById('budget-receipt-url').value = item ? String(item.receipt_url || '') : '';
  document.getElementById('budget-modal').classList.remove('hidden');
}

function closeBudgetModal() {
  document.getElementById('budget-modal').classList.add('hidden');
}

async function deleteBudgetRow(remoteId) {
  if (!remoteId) return;
  if (!confirm('이 학급회비 내역을 삭제하시겠습니까?')) return;
  try {
    await callApi('delete_budget', { remote_id: remoteId }, true);
    if (adminState.overview && Array.isArray(adminState.overview.ledger)) {
      adminState.overview.ledger = adminState.overview.ledger.filter((r) => String(r.remote_id || '') !== remoteId);
    }
    renderLedgerTab();
  } catch (err) {
    alert(`삭제 실패: ${err.message}`);
  }
}

function exportLedgerCsv() {
  const ov = adminState.overview || {};
  const ledger = ov.ledger || [];
  const headers = ['일자', '구분', '항목명', '금액', '사용처', '결제수단', '영수증'];
  const lines = [headers.map(csvEscape).join(',')];
  ledger.forEach((row) => {
    const rawType = String(row.type || row.tx_type || '').toLowerCase();
    const isInc = rawType === 'income' || rawType.includes('수입') || rawType.includes('입금');
    lines.push([
      row.date || row.created_at || '',
      isInc ? '수입' : '지출',
      row.title || row.description || row.item || '',
      row.amount || 0,
      row.store || '',
      row.card || row.payment_method || '',
      row.receipt_url || '',
    ].map(csvEscape).join(','));
  });
  downloadFileWithBom('학급회비_장부.csv', lines.join('\r\n'));
}

function exportCounselTxt() {
  const groups = getCounselGroups();
  const target = groups.find((g) => g.student_id === adminState.selectedCounselStudentId);
  if (!target) {
    alert('내보낼 학생을 선택해 주세요.');
    return;
  }
  const lines = [`[EduFlow 1:1 상담 기록] ${target.student_name} (${target.student_id})`, ''];
  target.messages.forEach((m) => {
    const sender = m.sender_name || m.sender_role || '사용자';
    lines.push(`[${m.created_at || ''}] ${sender}: ${m.message || m.text || ''}`);
  });
  downloadFileWithBom(`상담기록_${target.student_name}_${target.student_id}.txt`, lines.join('\r\n'), 'text/plain;charset=utf-8;');
}

function exportCounselCsv() {
  const groups = getCounselGroups();
  const target = groups.find((g) => g.student_id === adminState.selectedCounselStudentId);
  if (!target) {
    alert('내보낼 학생을 선택해 주세요.');
    return;
  }
  const lines = [['일시', '학번', '학생명', '발신자', '역할', '메시지'].map(csvEscape).join(',')];
  target.messages.forEach((m) => {
    lines.push([
      m.created_at || '',
      target.student_id,
      target.student_name,
      m.sender_name || '',
      m.sender_role || m.role || '',
      m.message || m.text || '',
    ].map(csvEscape).join(','));
  });
  downloadFileWithBom(`상담기록_${target.student_name}_${target.student_id}.csv`, lines.join('\r\n'));
}

// =========================================================================
// Navigation & UI Event Wiring
// =========================================================================
const TAB_LIST = [
  { tabId: 'tab-letters', navId: 'nav-item-letters', mobId: 'mobile-tab-btn-letters' },
  { tabId: 'tab-attendance', navId: 'nav-item-attendance', mobId: 'mobile-tab-btn-attendance' },
  { tabId: 'tab-roster', navId: 'nav-item-roster', mobId: 'mobile-tab-btn-roster' },
  { tabId: 'tab-ledger', navId: 'nav-item-ledger', mobId: 'mobile-tab-btn-ledger' },
  { tabId: 'tab-counsel', navId: 'nav-item-counsel', mobId: 'mobile-tab-btn-counsel' },
  { tabId: 'tab-lessons', navId: 'nav-item-lessons', mobId: 'mobile-tab-btn-lessons' },
];

function toggleMobileSidebar(forceClose = false) {
  const sidebar = document.getElementById('main-sidebar');
  const backdrop = document.getElementById('mobile-backdrop');
  if (!sidebar || !backdrop) return;
  const isClosed = sidebar.classList.contains('-translate-x-full');
  if (forceClose || !isClosed) {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  } else {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
  }
}

function switchTab(activeTabId) {
  adminState.activeTab = activeTabId;
  TAB_LIST.forEach(({ tabId, navId, mobId }) => {
    const tabEl = document.getElementById(tabId);
    const navEl = document.getElementById(navId);
    const mobEl = document.getElementById(mobId);
    const isActive = tabId === activeTabId;
    if (tabEl) tabEl.classList.toggle('hidden', !isActive);
    if (navEl) {
      navEl.className = isActive
        ? 'group flex items-center justify-between px-3 py-2.5 text-xs font-semibold rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-200 transition-all'
        : 'group flex items-center justify-between px-3 py-2.5 text-xs font-medium rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-all';
    }
    if (mobEl) {
      mobEl.className = isActive
        ? 'px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white whitespace-nowrap flex items-center space-x-1.5'
        : 'px-3 py-1.5 text-xs font-medium rounded-lg text-slate-600 hover:bg-slate-100 whitespace-nowrap flex items-center space-x-1.5';
    }
  });
  toggleMobileSidebar(true);
}

function renderAll() {
  renderSidebarProfile();
  renderLettersTab();
  renderAttendanceTab();
  renderRosterTab();
  renderLedgerTab();
  renderCounselTab();
  renderLessonsTab();
}

function bindEvents() {
  // Mobile hamburger & drawer close
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => toggleMobileSidebar(false));
  document.getElementById('mobile-sidebar-close-btn')?.addEventListener('click', () => toggleMobileSidebar(true));
  document.getElementById('mobile-backdrop')?.addEventListener('click', () => toggleMobileSidebar(true));
  document.getElementById('mobile-refresh-btn')?.addEventListener('click', () => refreshAdminData());

  // Tab clicks
  document.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = el.getAttribute('data-tab');
      if (tabId) switchTab(tabId);
    });
  });

  // Password visibility toggle on login
  document.getElementById('toggle-pw-btn')?.addEventListener('click', () => {
    const input = document.getElementById('admin-login-pw');
    const icon = document.getElementById('pw-visibility-icon');
    if (!input || !icon) return;
    const isPw = input.type === 'password';
    input.type = isPw ? 'text' : 'password';
    icon.textContent = isPw ? 'visibility_off' : 'visibility';
  });

  // Login submit
  document.getElementById('admin-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userId = document.getElementById('admin-login-id').value.trim();
    const password = document.getElementById('admin-login-pw').value;
    const btn = document.getElementById('admin-login-submit');
    if (!userId) return;

    btn.disabled = true;
    try {
      await callApi('login', { role: 'teacher', user_id: userId, password }, false);
      adminState.auth = { role: 'teacher', userId, password, passwordHash: '' };
      saveTeacherAuth(adminState.auth);
      showGate('loading');
      await refreshAdminData();
      showGate('app');
    } catch (err) {
      showGate('auth', '', err.message || '교사 로그인에 실패했습니다.');
    } finally {
      btn.disabled = false;
    }
  });

  // Logout
  document.getElementById('admin-logout-btn')?.addEventListener('click', () => {
    clearSavedAuth();
    adminState.auth = null;
    adminState.overview = null;
    showGate('auth', '로그아웃되었습니다. 다시 로그인해 주세요.');
  });

  // Tab 1 controls
  document.getElementById('letter-doc-selector')?.addEventListener('change', (e) => {
    adminState.selectedNoticeId = e.target.value;
    renderLettersTab();
  });
  document.querySelectorAll('[data-letter-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      adminState.letterFilter = btn.getAttribute('data-letter-filter');
      ['all', 'completed', 'pending'].forEach((k) => {
        const el = document.getElementById(`filter-${k}`);
        if (!el) return;
        const active = k === adminState.letterFilter;
        if (k === 'all') el.className = active ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 text-white transition' : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition';
        if (k === 'completed') el.className = active ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white transition' : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition';
        if (k === 'pending') el.className = active ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 text-white transition' : 'px-3 py-1.5 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-50 transition';
      });
      renderLettersTab();
    });
  });
  document.getElementById('letter-search-input')?.addEventListener('input', (e) => {
    adminState.letterSearch = e.target.value;
    renderLettersTab();
  });

  // Tab 2 period filter & daily date controls
  document.getElementById('att-period-filter')?.addEventListener('change', (e) => {
    adminState.attPeriod = e.target.value;
    renderAttendanceTab();
  });
  document.getElementById('att-daily-date')?.addEventListener('change', (e) => {
    adminState.attDailyDate = e.target.value || getLocalTodayStr();
    renderDailyAttendancePanel();
  });
  document.getElementById('att-daily-prev')?.addEventListener('click', () => {
    adminState.attDailyDate = shiftDateStr(adminState.attDailyDate, -1);
    renderDailyAttendancePanel();
  });
  document.getElementById('att-daily-next')?.addEventListener('click', () => {
    adminState.attDailyDate = shiftDateStr(adminState.attDailyDate, 1);
    renderDailyAttendancePanel();
  });
  document.getElementById('att-daily-today')?.addEventListener('click', () => {
    adminState.attDailyDate = getLocalTodayStr();
    renderDailyAttendancePanel();
  });

  // Tab 4 budget modal form submit
  document.getElementById('budget-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('budget-submit-btn');
    const payload = {
      remote_id: document.getElementById('budget-remote-id').value.trim(),
      date: document.getElementById('budget-date').value,
      type: document.getElementById('budget-type').value,
      title: document.getElementById('budget-title').value.trim(),
      amount: Number(document.getElementById('budget-amount').value || 0),
      store: document.getElementById('budget-store').value.trim(),
      card: document.getElementById('budget-card').value.trim(),
      receipt_url: document.getElementById('budget-receipt-url').value.trim(),
    };
    if (!payload.title) return;
    btn.disabled = true;
    try {
      const res = await callApi('upsert_budget', payload, true);
      if (adminState.overview) {
        const list = Array.isArray(adminState.overview.ledger) ? adminState.overview.ledger : [];
        const idx = list.findIndex((r) => String(r.remote_id || '') === res.remote_id);
        if (idx >= 0) list[idx] = res.item;
        else list.unshift(res.item);
        list.sort((a, b) => String(b.date || b.created_at || '').localeCompare(String(a.date || a.created_at || '')));
        adminState.overview.ledger = list;
      }
      closeBudgetModal();
      renderLedgerTab();
    } catch (err) {
      alert(`저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Tab 3 search
  document.getElementById('roster-search-input')?.addEventListener('input', (e) => {
    adminState.rosterSearch = e.target.value;
    renderRosterTab();
  });

  // Tab 6 lessons & subject attendance filters + modal submit
  document.getElementById('lesson-compare-subject-filter')?.addEventListener('change', (e) => {
    adminState.lessonCompareSubject = e.target.value;
    renderLessonsTab();
  });
  document.getElementById('lesson-prog-subject-filter')?.addEventListener('change', (e) => {
    adminState.lessonProgSubject = e.target.value;
    renderLessonsTab();
  });
  document.getElementById('lesson-prog-class-filter')?.addEventListener('change', (e) => {
    adminState.lessonProgClass = e.target.value;
    renderLessonsTab();
  });
  document.getElementById('lesson-att-date-filter')?.addEventListener('change', (e) => {
    adminState.lessonAttDate = e.target.value;
    renderLessonsTab();
  });
  document.getElementById('lesson-att-clear-date')?.addEventListener('click', () => {
    adminState.lessonAttDate = '';
    const el = document.getElementById('lesson-att-date-filter');
    if (el) el.value = '';
    renderLessonsTab();
  });
  document.getElementById('lesson-att-subject-filter')?.addEventListener('change', (e) => {
    adminState.lessonAttSubject = e.target.value;
    renderLessonsTab();
  });
  document.getElementById('lesson-att-class-filter')?.addEventListener('change', (e) => {
    adminState.lessonAttClass = e.target.value;
    renderLessonsTab();
  });

  document.getElementById('lesson-progress-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('lp-submit-btn');
    const payload = {
      remote_id: document.getElementById('lp-remote-id').value.trim(),
      date: document.getElementById('lp-date').value,
      period: document.getElementById('lp-period').value.trim(),
      subject: document.getElementById('lp-subject').value.trim(),
      class_label: document.getElementById('lp-class-label').value.trim(),
      unit: document.getElementById('lp-unit').value.trim(),
      lesson_no: document.getElementById('lp-lesson-no').value.trim(),
      content: document.getElementById('lp-content').value.trim(),
      next_note: document.getElementById('lp-next-note').value.trim(),
    };
    if (!payload.subject) return;
    btn.disabled = true;
    try {
      const res = await callApi('upsert_lesson_progress', payload, true);
      if (adminState.overview) {
        const list = Array.isArray(adminState.overview.lesson_progress) ? adminState.overview.lesson_progress : [];
        const idx = list.findIndex((p) => String(p.remote_id || '') === res.remote_id);
        if (idx >= 0) list[idx] = res.item;
        else list.unshift(res.item);
        list.sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));
        adminState.overview.lesson_progress = list;
      }
      closeLessonProgressModal();
      renderSidebarProfile();
      renderLessonsTab();
    } catch (err) {
      alert(`저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Tab 5 search
  document.getElementById('counsel-search-input')?.addEventListener('input', (e) => {
    adminState.counselSearch = e.target.value;
    renderCounselTab();
  });

  // Password reset modal submit
  document.getElementById('pw-reset-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!adminState.pwResetTarget) return;
    const newPw = document.getElementById('pw-reset-input').value.trim();
    if (!newPw) return;
    const btn = document.getElementById('pw-reset-submit-btn');
    btn.disabled = true;
    try {
      await callApi('admin_reset_account_password', {
        target_role: adminState.pwResetTarget.role,
        remote_id: adminState.pwResetTarget.remoteId,
        new_password: newPw,
      }, true);
      closePwResetModal();
      alert('비밀번호가 초기화되었습니다.');
    } catch (err) {
      alert(`비밀번호 초기화 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

async function initAdminPage() {
  bindEvents();
  const saved = loadSavedAuth();
  if (!saved) {
    showGate('auth');
    return;
  }
  if (String(saved.role).toLowerCase() !== 'teacher') {
    showGate('auth', `현재 '${saved.role === 'parent' ? '학부모' : '학생'}' 계정으로 로그인되어 있습니다. 교사 전용 페이지이므로 교사 계정으로 인증해 주세요.`);
    return;
  }
  adminState.auth = saved;
  showGate('loading');
  try {
    await refreshAdminData();
    if (adminState.overview) showGate('app');
  } catch (err) {
    showGate('auth', '', err.message || '자동 인증에 실패했습니다.');
  }
}

document.addEventListener('DOMContentLoaded', initAdminPage);
