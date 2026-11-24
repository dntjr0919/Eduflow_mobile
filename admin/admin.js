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
  auth: null, // { role: 'teacher', userId, token, expiresAt }
  overview: null,
  activeTab: 'tab-letters',
  selectedNoticeId: '',
  letterFilter: 'all',
  letterSearch: '',
  attSubtab: 'reports', // 'reports' | 'daily' | 'summary'
  attReportStatus: 'all', // 'all' | 'unconfirmed' | 'confirmed'
  attReportPeriod: 'all', // 'all' | 'week' | 'month'
  attReportSearch: '',
  attDailyDate: getLocalTodayStr(),
  attPeriod: 'month',
  rosterSearch: '',
  counselSearch: '',
  selectedCounselStudentId: '',
  pwResetTarget: null, // { role, remoteId, label }
  lessonCompareSubject: '',
  lessonMatrixSubject: '',
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
    if (parsed.password || parsed.passwordHash) {
      if (parsed.token) {
        saveTeacherAuth({
          role: parsed.role,
          userId: parsed.userId,
          token: parsed.token,
          expiresAt: parsed.expiresAt || 0,
        });
      } else {
        clearSavedAuth();
        return null;
      }
    }
    if (!parsed.token) return null;
    if (parsed.expiresAt && Number(parsed.expiresAt) <= Date.now()) {
      clearSavedAuth();
      return null;
    }
    return {
      role: parsed.role,
      userId: parsed.userId,
      token: String(parsed.token),
      expiresAt: Number(parsed.expiresAt || 0),
      savedAt: Number(parsed.savedAt || 0),
    };
  } catch (_) {
    return null;
  }
}

function saveTeacherAuth(auth) {
  try {
    localStorage.setItem(AUTO_LOGIN_STORAGE_KEY, JSON.stringify({
      role: 'teacher',
      userId: auth.userId,
      token: String(auth.token || ''),
      expiresAt: Number(auth.expiresAt || 0),
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
  const headers = { 'Content-Type': 'application/json' };
  if (includeAuth && adminState.auth) {
    body.auth_teacher_id = adminState.auth.userId;
    if (adminState.auth.token) {
      body.auth_token = adminState.auth.token;
      headers.Authorization = `Bearer ${adminState.auth.token}`;
    }
  }
  const res = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers,
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
      reply_remote_id: reply ? String(reply.remote_id || `${noticeId}_${sid}`) : '',
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

  const editBtn = document.getElementById('letter-edit-btn');
  const delBtn = document.getElementById('letter-delete-btn');
  if (editBtn) editBtn.disabled = !notice;
  if (delBtn) delBtn.disabled = !notice;

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
      <th class="py-3 px-3 text-center">관리</th>
    </tr>
  `;

  if (filteredRows.length === 0) {
    const colSpan = 7 + (schema.length > 0 ? schema.length : 1);
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="py-10 text-center text-slate-400">표시할 학생 회신 데이터가 없습니다.</td></tr>`;
    return;
  }

  const activeNoticeId = notice ? String(notice.remote_id || notice.id || '') : '';

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
        <td class="py-3 px-3 text-center whitespace-nowrap">
          ${isOk
            ? `<button type="button" onclick="deleteNoticeReplyRow('${_escapeJsAttr(activeNoticeId)}', '${_escapeJsAttr(r.student_id)}', '${_escapeJsAttr(r.reply_remote_id)}', '${_escapeJsAttr(r.student_name)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">회신 삭제</button>`
            : '<span class="text-slate-300 text-[11px]">-</span>'}
        </td>
      </tr>
    `;
  }).join('');
}

function openNoticeModal(isEdit = false) {
  const notices = (adminState.overview && adminState.overview.notices) || [];
  const target = isEdit
    ? (notices.find((n) => String(n.remote_id || n.id || '') === adminState.selectedNoticeId) || notices[0] || null)
    : null;
  if (isEdit && !target) {
    alert('수정할 가정통신문을 먼저 선택해 주세요.');
    return;
  }
  document.getElementById('notice-modal-title').textContent = target ? '가정통신문 수정' : '가정통신문 작성';
  document.getElementById('nt-remote-id').value = target ? String(target.remote_id || target.id || '') : '';
  document.getElementById('nt-title').value = target ? String(target.title || '') : '';
  document.getElementById('nt-category').value = target ? String(target.category || '가정통신문') : '가정통신문';
  document.getElementById('nt-due-date').value = target ? String(target.due_date || '') : '';
  document.getElementById('nt-content').value = target ? String(target.content || '') : '';
  document.getElementById('nt-attachment-url').value = target ? String(target.attachment_url || '') : '';
  document.getElementById('nt-requires-reply').checked = target ? (target.requires_reply !== false && target.requires_reply !== 0 && target.requires_reply !== '0') : true;
  document.getElementById('nt-signature-mode').value = (target && String(target.signature_mode || '').toLowerCase() === 'both') ? 'both' : 'single';
  document.getElementById('notice-modal').classList.remove('hidden');
}

function closeNoticeModal() {
  document.getElementById('notice-modal').classList.add('hidden');
}

async function deleteSelectedNotice() {
  const notices = (adminState.overview && adminState.overview.notices) || [];
  const target = notices.find((n) => String(n.remote_id || n.id || '') === adminState.selectedNoticeId) || notices[0] || null;
  if (!target) {
    alert('삭제할 가정통신문을 선택해 주세요.');
    return;
  }
  const nid = String(target.remote_id || target.id || '');
  if (!confirm(`"${target.title || nid}" 가정통신문을 삭제하시겠습니까?`)) return;
  try {
    await callApi('delete_notice', { remote_id: nid }, true);
    adminState.selectedNoticeId = '';
    await refreshAdminData();
  } catch (err) {
    alert(`가정통신문 삭제 실패: ${err.message}`);
  }
}

async function deleteNoticeReplyRow(noticeId, studentId, replyRemoteId, studentName) {
  if (!confirm(`${studentName || studentId} 학생의 가정통신문 회신 내역을 삭제(초기화)하시겠습니까?`)) return;
  try {
    await callApi('delete_notice_reply', {
      remote_id: replyRemoteId,
      notice_id: noticeId,
      student_id: studentId,
    }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`회신 삭제 실패: ${err.message}`);
  }
}

function _safeAdminUrl(rawUrl, allowDataImage = false) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (allowDataImage && /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
  return '';
}

function openSignatureModal(signer, timestamp, url) {
  const safeImgUrl = _safeAdminUrl(url, true);
  const safeLinkUrl = _safeAdminUrl(url, false);
  document.getElementById('sig-signer').textContent = `${signer} 서명`;
  document.getElementById('sig-timestamp').textContent = timestamp || '-';
  if (safeImgUrl) {
    document.getElementById('sig-image').src = safeImgUrl;
  } else {
    document.getElementById('sig-image').removeAttribute('src');
  }
  const openLinkEl = document.getElementById('sig-open-link');
  if (safeLinkUrl) {
    openLinkEl.href = safeLinkUrl;
    openLinkEl.classList.remove('hidden');
  } else {
    openLinkEl.removeAttribute('href');
    openLinkEl.classList.add('hidden');
  }
  document.getElementById('signature-modal').classList.remove('hidden');
}

function closeSignatureModal() {
  document.getElementById('signature-modal').classList.add('hidden');
}

// =========================================================================
// TAB 2: 학생·학부모 출결 보고 + 일자별 출석체크 + 누적표 & 서류 추적
// =========================================================================
function switchAttendanceSubtab(subtab) {
  const target = (subtab === 'daily' || subtab === 'summary') ? subtab : 'reports';
  adminState.attSubtab = target;
  const map = [
    { key: 'reports', panelId: 'att-reports-panel', btnId: 'att-subtab-reports' },
    { key: 'daily', panelId: 'att-daily-panel', btnId: 'att-subtab-daily' },
    { key: 'summary', panelId: 'att-summary-panel', btnId: 'att-subtab-summary' },
  ];
  map.forEach(({ key, panelId, btnId }) => {
    const active = key === target;
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (panel) panel.classList.toggle('hidden', !active);
    if (btn) {
      btn.className = active
        ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-indigo-700 shadow-2xs transition'
        : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 transition';
    }
  });
}

function filterAttendanceReports(attendanceRows, { status = 'all', period = 'all', search = '' } = {}) {
  const nonPresent = (Array.isArray(attendanceRows) ? attendanceRows : []).filter((a) => {
    const t = String(a && a.attendance_type ? a.attendance_type : '').trim();
    return t !== '' && t !== '출석';
  });
  const byPeriod = filterAttendanceByPeriod(nonPresent, period);
  const term = String(search || '').trim().toLowerCase();
  return byPeriod
    .filter((a) => {
      const confirmed = Boolean(a.teacher_confirmed);
      if (status === 'unconfirmed' && confirmed) return false;
      if (status === 'confirmed' && !confirmed) return false;
      if (term) {
        const hay = `${a.student_name || ''} ${a.student_id || ''} ${a.attendance_type || ''} ${a.reason || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || '')));
}

function renderAttendanceReportsPanel() {
  const ov = adminState.overview || {};
  const allReports = filterAttendanceReports(ov.attendance || [], { status: 'all', period: adminState.attReportPeriod, search: '' });
  const unconfirmedCount = allReports.filter((a) => !a.teacher_confirmed).length;
  const confirmedCount = allReports.length - unconfirmedCount;

  const kTotal = document.getElementById('kpi-att-reports-total');
  const kUnconf = document.getElementById('kpi-att-reports-unconfirmed');
  const kConf = document.getElementById('kpi-att-reports-confirmed');
  if (kTotal) kTotal.innerHTML = `${allReports.length}<span class="text-xs font-normal text-slate-500 ml-1">건</span>`;
  if (kUnconf) kUnconf.innerHTML = `${unconfirmedCount}<span class="text-xs font-normal text-slate-500 ml-1">건</span>`;
  if (kConf) kConf.innerHTML = `${confirmedCount}<span class="text-xs font-normal text-slate-500 ml-1">건</span>`;

  const fAll = document.getElementById('att-report-filter-all');
  const fUnconf = document.getElementById('att-report-filter-unconfirmed');
  const fConf = document.getElementById('att-report-filter-confirmed');
  if (fAll) fAll.textContent = `전체 (${allReports.length})`;
  if (fUnconf) fUnconf.textContent = `미확인만 (${unconfirmedCount})`;
  if (fConf) fConf.textContent = `확인완료 (${confirmedCount})`;

  const filtered = filterAttendanceReports(ov.attendance || [], {
    status: adminState.attReportStatus,
    period: adminState.attReportPeriod,
    search: adminState.attReportSearch,
  });

  const visibleEl = document.getElementById('att-reports-visible-count');
  if (visibleEl) visibleEl.textContent = String(filtered.length);

  const tbody = document.getElementById('att-reports-tbody');
  if (!tbody) return;
  tbody.innerHTML = filtered.length === 0
    ? '<tr><td colspan="7" class="py-10 text-center text-slate-400">조회된 학생·학부모 출결 보고 내역이 없습니다.</td></tr>'
    : filtered.map((a) => {
        const rid = String(a.remote_id || '');
        const t = String(a.attendance_type || '출결');
        let badgeCls = 'bg-slate-100 text-slate-700';
        if (t.includes('결석')) badgeCls = 'bg-rose-100 text-rose-700';
        else if (t.includes('지각') || t.includes('조퇴')) badgeCls = 'bg-amber-100 text-amber-800';
        else if (t.includes('체험') || t.includes('인정')) badgeCls = 'bg-indigo-100 text-indigo-700';
        const periodText = a.period_info || formatAttendancePeriodInfo(a);
        const confirmed = Boolean(a.teacher_confirmed);
        const confirmCell = confirmed
          ? '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700">확인완료</span>'
          : `<button type="button" onclick="confirmAttendanceRow('${escapeHtml(rid)}')" class="px-2.5 py-1 bg-indigo-600 text-white hover:bg-indigo-700 rounded-lg text-[11px] font-semibold">담임 확인</button>`;
        return `
          <tr class="hover:bg-slate-50 ${confirmed ? '' : 'bg-amber-50/30'}">
            <td class="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">${escapeHtml(a.date || '-')}</td>
            <td class="py-2.5 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(a.student_id || '-')}</td>
            <td class="py-2.5 px-4 font-bold text-slate-900 whitespace-nowrap">${escapeHtml(a.student_name || a.student_id || '-')}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeCls}">${escapeHtml(t)}</span></td>
            <td class="py-2.5 px-3 text-center text-slate-600 whitespace-nowrap">${escapeHtml(periodText)}</td>
            <td class="py-2.5 px-4 text-slate-700">${escapeHtml(a.reason || '사유 미입력')}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">${confirmCell}</td>
          </tr>
        `;
      }).join('');
}

function exportAttendanceReportsCsv() {
  const ov = adminState.overview || {};
  const rows = filterAttendanceReports(ov.attendance || [], {
    status: adminState.attReportStatus,
    period: adminState.attReportPeriod,
    search: adminState.attReportSearch,
  });
  const headers = ['날짜', '학번', '이름', '출결구분', '교시', '상세사유', '확인상태'];
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach((a) => {
    lines.push([
      a.date || '',
      a.student_id || '',
      a.student_name || '',
      a.attendance_type || '',
      a.period_info || formatAttendancePeriodInfo(a),
      a.reason || '',
      a.teacher_confirmed ? '확인완료' : '미확인',
    ].map(csvEscape).join(','));
  });
  downloadFileWithBom('학생학부모_출결보고.csv', lines.join('\r\n'));
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

function renderUnconfirmedAttendanceBanner() {
  const ov = adminState.overview || {};
  const card = document.getElementById('att-unconfirmed-card');
  const countEl = document.getElementById('att-unconfirmed-count');
  const listEl = document.getElementById('att-unconfirmed-list');
  if (!card || !listEl) return;

  const unconfirmed = (ov.attendance || []).filter((a) => {
    const t = String(a.attendance_type || '').trim();
    return t !== '출석' && !a.teacher_confirmed;
  });

  if (unconfirmed.length === 0) {
    card.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }

  card.classList.remove('hidden');
  if (countEl) countEl.textContent = String(unconfirmed.length);
  listEl.innerHTML = unconfirmed.slice(0, 10).map((a) => {
    const rid = String(a.remote_id || '');
    return `
      <div class="bg-white rounded-xl border border-amber-200 px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div class="text-xs">
          <span class="font-mono text-[11px] text-slate-400 mr-2">${escapeHtml(a.date || '-')}</span>
          <strong class="text-slate-900">${escapeHtml(a.student_name || a.student_id)}</strong>
          <span class="ml-1.5 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold text-[11px]">${escapeHtml(a.attendance_type || '출결')}${a.period_info ? ` (${escapeHtml(a.period_info)})` : ''}</span>
          <span class="text-slate-500 ml-2">${escapeHtml(a.reason || '사유 미입력')}</span>
        </div>
        <button type="button" onclick="confirmAttendanceRow('${escapeHtml(rid)}')" class="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 self-start sm:self-auto shrink-0">담임 확인</button>
      </div>
    `;
  }).join('');
}

function renderDailyAttendancePanel() {
  renderUnconfirmedAttendanceBanner();
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
    ? '<tr><td colspan="7" class="py-8 text-center text-slate-400">학급 학생 명렬이 없습니다.</td></tr>'
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

        const manageCell = r.has_record
          ? `<button type="button" onclick="openAttendanceModal('${_escapeJsAttr(r.remote_id)}', '${_escapeJsAttr(r.student_id)}', '${_escapeJsAttr(selectedDate)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
             <button type="button" onclick="deleteAttendanceRow('${_escapeJsAttr(r.remote_id)}', '${_escapeJsAttr(r.student_name)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>`
          : `<button type="button" onclick="openAttendanceModal('', '${_escapeJsAttr(r.student_id)}', '${_escapeJsAttr(selectedDate)}')" class="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-[11px] font-semibold">등록</button>`;

        return `
          <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(r.student_id || r.student_no)}</td>
            <td class="py-2.5 px-4 font-bold text-slate-900">${escapeHtml(r.student_name)}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeCls}">${escapeHtml(st)}</span></td>
            <td class="py-2.5 px-3 text-center text-slate-600 whitespace-nowrap">${escapeHtml(r.period_info)}</td>
            <td class="py-2.5 px-4 text-slate-600">${escapeHtml(r.reason)}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">${confirmCell}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">${manageCell}</td>
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
  renderAttendanceReportsPanel();
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
    ? '<tr><td colspan="6" class="py-8 text-center text-slate-400">해당 기간 출결 기록이 없습니다.</td></tr>'
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
            <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">
              <button type="button" onclick="openAttendanceModal('${_escapeJsAttr(rid)}', '${_escapeJsAttr(a.student_id)}', '${_escapeJsAttr(a.date)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
              <button type="button" onclick="deleteAttendanceRow('${_escapeJsAttr(rid)}', '${_escapeJsAttr(a.student_name || a.student_id)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
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
            <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">
              ${actionBtn}
              <button type="button" onclick="openDocTrackingModal('${_escapeJsAttr(rid)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
              <button type="button" onclick="deleteDocTrackingRow('${_escapeJsAttr(rid)}', '${_escapeJsAttr(d.student_name || d.student_id)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
            </td>
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

  const pushEnabledCount = students.filter((s) => Boolean(s.push_enabled)).length;
  document.getElementById('kpi-roster-students').textContent = `${students.length}명`;
  document.getElementById('kpi-roster-parents').textContent = `${parents.length}명`;
  const pushKpiEl = document.getElementById('kpi-roster-push');
  if (pushKpiEl) pushKpiEl.textContent = `${pushEnabledCount}/${students.length}명`;
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
      String(s.phone || '').toLowerCase().includes(term) ||
      (p && (String(p.name || '').toLowerCase().includes(term) || String(p.phone || '').toLowerCase().includes(term)));
  });

  const statusPill = (st) => {
    const low = String(st || 'active').toLowerCase();
    if (low === 'pending') return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800">승인대기</span>';
    if (low === 'rejected') return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-800">반려</span>';
    return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-800">활성</span>';
  };

  const pushBadge = (enabled) => enabled
    ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700">알림 ON</span>'
    : '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">미설정</span>';

  const tbody = document.getElementById('roster-tbody');
  tbody.innerHTML = filtered.length === 0
    ? '<tr><td colspan="11" class="py-8 text-center text-slate-400">조회된 학생 계정이 없습니다.</td></tr>'
    : filtered.map((s) => {
        const sid = String(s.student_id || '').trim();
        const sRid = String(s.remote_id || sid);
        const sLogin = s.custom_id || s.student_id || sRid;
        const sPhone = String(s.phone || '').trim();
        const p = parentBySid.get(sid);
        const pRid = p ? String(p.remote_id || p.parent_id || '') : '';
        const pLogin = p ? (p.custom_id || p.parent_id || p.login_id || pRid) : '-';
        const pPhone = p ? String(p.phone || '').trim() : '';

        return `
          <tr class="hover:bg-slate-50">
            <td class="py-3 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(sid || s.student_no || '-')}</td>
            <td class="py-3 px-4 font-bold text-slate-900">${escapeHtml(s.name || s.student_name || '-')}</td>
            <td class="py-3 px-3 font-mono text-slate-600">${escapeHtml(sLogin)}</td>
            <td class="py-3 px-3 whitespace-nowrap">
              <div class="flex items-center gap-1.5">
                <span class="font-mono text-xs ${sPhone ? 'text-slate-800' : 'text-slate-300'}">${sPhone ? escapeHtml(sPhone) : '미등록'}</span>
                <button type="button" onclick="openPhoneEditModal('student', '${escapeHtml(sRid)}', '${escapeHtml(s.name || sLogin)} (학생)', '${escapeHtml(sPhone)}')" class="px-2 py-0.5 bg-slate-100 hover:bg-indigo-50 text-slate-600 hover:text-indigo-700 rounded text-[11px] font-semibold">연락처 수정</button>
              </div>
            </td>
            <td class="py-3 px-3 text-center">${statusPill(s.status)}</td>
            <td class="py-3 px-3 text-center whitespace-nowrap">
              <div class="flex flex-col items-center gap-1">
                ${pushBadge(Boolean(s.push_enabled))}
                ${p ? `<span class="text-[10px] ${p.push_enabled ? 'text-emerald-600 font-semibold' : 'text-slate-400'}">학부모 ${p.push_enabled ? 'ON' : '미설정'}</span>` : ''}
              </div>
            </td>
            <td class="py-3 px-3 text-slate-700">${p ? `${escapeHtml(p.name || '학부모')} <span class="text-[11px] text-slate-400 font-mono">(${escapeHtml(pLogin)})</span>` : '<span class="text-slate-300">미연동</span>'}</td>
            <td class="py-3 px-3 whitespace-nowrap">
              ${p ? `<div class="flex items-center gap-1.5">
                <span class="font-mono text-xs ${pPhone ? 'text-slate-800' : 'text-slate-300'}">${pPhone ? escapeHtml(pPhone) : '미등록'}</span>
                <button type="button" onclick="openPhoneEditModal('parent', '${escapeHtml(pRid)}', '${escapeHtml(p.name || pLogin)} (학부모)', '${escapeHtml(pPhone)}')" class="px-2 py-0.5 bg-slate-100 hover:bg-indigo-50 text-slate-600 hover:text-indigo-700 rounded text-[11px] font-semibold">연락처 수정</button>
              </div>` : '<span class="text-slate-300">-</span>'}
            </td>
            <td class="py-3 px-3 text-center">${p ? statusPill(p.status) : '<span class="text-slate-300">-</span>'}</td>
            <td class="py-3 px-4 text-center whitespace-nowrap space-x-1">
              <button type="button" onclick="openPwResetModal('student', '${escapeHtml(sRid)}', '${escapeHtml(s.name || sLogin)} (학생)')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">학생 비번초기화</button>
              ${p ? `<button type="button" onclick="openPwResetModal('parent', '${escapeHtml(pRid)}', '${escapeHtml(p.name || pLogin)} (학부모)')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">학부모 비번초기화</button>` : ''}
            </td>
            <td class="py-3 px-3 text-center whitespace-nowrap space-x-1">
              <button type="button" onclick="openRosterStudentModal('${_escapeJsAttr(sRid)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
              <button type="button" onclick="deleteRosterStudent('${_escapeJsAttr(sRid)}', '${_escapeJsAttr(s.name || sLogin)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
            </td>
          </tr>
        `;
      }).join('');
}

function openRosterStudentModal(remoteId = '') {
  const students = (adminState.overview && adminState.overview.students) || [];
  const target = remoteId ? students.find((s) => String(s.remote_id || s.student_id || '') === String(remoteId)) : null;
  document.getElementById('roster-student-modal-title').textContent = target ? '학생 정보 수정' : '학생 추가';
  document.getElementById('rs-remote-id').value = target ? String(target.remote_id || target.student_id || '') : '';
  document.getElementById('rs-student-id').value = target ? String(target.student_id || '') : '';
  document.getElementById('rs-student-no').value = target && target.student_no !== null && target.student_no !== undefined ? String(target.student_no) : '';
  document.getElementById('rs-name').value = target ? String(target.name || target.student_name || '') : '';
  document.getElementById('rs-phone').value = target ? String(target.phone || '') : '';
  document.getElementById('rs-init-pw').value = '';
  const createWrap = document.getElementById('rs-create-only-wrap');
  if (createWrap) createWrap.classList.toggle('hidden', Boolean(target));
  document.getElementById('roster-student-modal').classList.remove('hidden');
}

function closeRosterStudentModal() {
  document.getElementById('roster-student-modal').classList.add('hidden');
}

async function deleteRosterStudent(remoteId, name) {
  if (!confirm(`"${name || remoteId}" 학생 계정과 연동된 학부모 계정을 삭제(전출 처리)하시겠습니까?`)) return;
  try {
    await callApi('admin_delete_roster_student', { remote_id: remoteId }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`학생 삭제 실패: ${err.message}`);
  }
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

function openPhoneEditModal(role, remoteId, label, currentPhone = '') {
  adminState.phoneEditTarget = { role, remoteId, label };
  document.getElementById('phone-edit-target-label').textContent = `대상 계정: ${label}`;
  document.getElementById('phone-edit-input').value = currentPhone || '';
  document.getElementById('phone-edit-modal').classList.remove('hidden');
}

function closePhoneEditModal() {
  adminState.phoneEditTarget = null;
  document.getElementById('phone-edit-modal').classList.add('hidden');
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
        const safeReceiptUrl = _safeAdminUrl(row.receipt_url, false);
        const receiptHtml = safeReceiptUrl
          ? `<a href="${escapeHtml(safeReceiptUrl)}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:underline font-semibold">보기</a>`
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
    : boardNotices.map((b) => {
        const rid = String(b.remote_id || b.id || '');
        return `
      <div class="p-4 hover:bg-slate-50 space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-900">${b.is_pinned ? '📌 ' : ''}${escapeHtml(b.title || '공지')}</span>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[10px] px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold">${escapeHtml(b.source_type || '담임 공지')}</span>
            <button type="button" onclick="openBoardNoticeModal('${_escapeJsAttr(rid)}')" class="px-2 py-0.5 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded text-[11px] font-semibold">수정</button>
            <button type="button" onclick="deleteBoardNoticeRow('${_escapeJsAttr(rid)}', '${_escapeJsAttr(b.title || '공지')}')" class="px-2 py-0.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded text-[11px] font-semibold">삭제</button>
          </div>
        </div>
        <p class="text-xs text-slate-600 line-clamp-2">${escapeHtml(b.summary || b.content || '')}</p>
        <div class="text-[11px] text-slate-400">${escapeHtml(b.published_at || b.created_at || '')}</div>
      </div>
    `;
      }).join('');

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
    const mRid = String(m.remote_id || m.id || '');
    const mText = String(m.message || m.text || '');
    return `
      <div class="flex flex-col ${isTeacher ? 'items-end' : 'items-start'}">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-[10px] text-slate-400">${escapeHtml(senderLabel)} · ${escapeHtml(m.created_at || '')}</span>
          ${isTeacher && mRid ? `
            <button type="button" onclick="editCounselMessage('${_escapeJsAttr(mRid)}', '${_escapeJsAttr(mText)}')" class="text-[10px] text-indigo-600 hover:underline font-semibold">수정</button>
            <button type="button" onclick="deleteCounselMessage('${_escapeJsAttr(mRid)}')" class="text-[10px] text-rose-600 hover:underline font-semibold">삭제</button>
          ` : ''}
        </div>
        <div class="max-w-[85%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed ${isTeacher ? 'bg-indigo-600 text-white rounded-tr-xs' : 'bg-white border border-slate-200 text-slate-800 rounded-tl-xs'}">
          ${escapeHtml(mText)}
        </div>
      </div>
    `;
  }).join('');
}

async function editCounselMessage(remoteId, currentText) {
  const nextText = prompt('수정할 상담 메시지 내용을 입력하세요:', currentText || '');
  if (nextText === null) return;
  const trimmed = nextText.trim();
  if (!trimmed) return;
  try {
    await callApi('update_chat_message', { remote_id: remoteId, message: trimmed }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`메시지 수정 실패: ${err.message}`);
  }
}

async function deleteCounselMessage(remoteId) {
  if (!confirm('이 상담 메시지를 삭제하시겠습니까?')) return;
  try {
    await callApi('delete_chat_message', { remote_id: remoteId }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`메시지 삭제 실패: ${err.message}`);
  }
}

function selectCounselStudent(sid) {
  adminState.selectedCounselStudentId = sid;
  renderCounselTab();
}

// =========================================================================
// TAB 6: 교과 출결 · 수업 진도
// =========================================================================
const _SCHED_ITEM_SRC = '[월화수목금토일](?:요일)?\\s*[:\\-·/]?\\s*\\d{1,2}(?:\\s*[~,\\-]\\s*\\d{1,2})*(?:\\s*교시)?';
const _BRACKETED_WEEKDAY_PERIOD_RE = new RegExp(
  `(?:\\[\\s*${_SCHED_ITEM_SRC}(?:\\s*[,/·ㆍ\\s]\\s*${_SCHED_ITEM_SRC})*\\s*\\]|\\(\\s*${_SCHED_ITEM_SRC}(?:\\s*[,/·ㆍ\\s]\\s*${_SCHED_ITEM_SRC})*\\s*\\))`,
  'g'
);

function _cleanMetaSeparators(str) {
  let out = String(str || '');
  // Remove empty or punctuation-only brackets left behind after stripping tokens
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(/\(\s*[·ㆍ•\-/|,:;\s]*\)|\[\s*[·ㆍ•\-/|,:;\s]*\]/g, ' ');
    if (next === out) break;
    out = next;
  }
  // Collapse consecutive punctuation separators (e.g. " · · ") while preserving internal spaces/hyphens
  out = out.replace(/([·ㆍ•/|,:;])(?:\s*[·ㆍ•/|,:;])+/g, '$1');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[·ㆍ•\-/|,:;\s]+/, '').replace(/[·ㆍ•\-/|,:;\s]+$/, '').trim();
  return out;
}

function _stripWeekdayPeriod(raw, allowCompactBare = false) {
  let text = String(raw || '').trim();
  let firstPeriod = null;
  const schedules = [];

  if (!text) {
    return { text: '', period: null, schedules };
  }

  const recordSchedule = (weekday, periodNum) => {
    if (periodNum >= 1 && periodNum <= 15) {
      if (firstPeriod === null) firstPeriod = periodNum;
      if (weekday) schedules.push({ weekday, period: periodNum });
      return true;
    }
    return false;
  };

  // 1) Bracketed / parenthesized weekday+period (single or multi-schedule)
  text = text.replace(_BRACKETED_WEEKDAY_PERIOD_RE, (match) => {
    const innerRe = /([월화수목금토일])(?:요일)?\s*[:\-·/]?\s*(\d{1,2})(?:\s*[~,\-]\s*\d{1,2})*(?:\s*교시)?/g;
    const localExtracted = [];
    let m;
    while ((m = innerRe.exec(match)) !== null) {
      const pNum = Number(m[2]);
      if (pNum >= 1 && pNum <= 15) {
        localExtracted.push({ weekday: m[1], period: pNum });
      }
    }
    if (localExtracted.length === 0) return match;
    localExtracted.forEach((item) => recordSchedule(item.weekday, item.period));
    return ' ';
  });

  // 2) Bracketed / parenthesized standalone period: [3교시], (7교시)
  text = text.replace(/(?:\[\s*(\d{1,2})\s*교시\s*\]|\(\s*(\d{1,2})\s*교시\s*\))/g, (match, p1, p2) => {
    const pNum = Number(p1 || p2);
    return recordSchedule('', pNum) ? ' ' : match;
  });

  // 3) Bare weekday + period with separator, '요일', or '교시' (safe against '수1', '화2', '특수 1')
  text = text.replace(
    /(^|[\s·ㆍ•,/|(\[])([월화수목금토일])(?:요일\s*[:\-·/]?\s*|\s+[:\-·/]?\s*|\s*[:\-·/]\s*)(\d{1,2})(?:\s*교시)?(?=$|[\s·ㆍ•,/|)\]])/g,
    (match, prefix, wd, pStr) => {
      const pNum = Number(pStr);
      return recordSchedule(wd, pNum) ? `${prefix} ` : match;
    }
  );

  // 4) Bare weekday + compact digits with '교시' suffix: 목7교시
  text = text.replace(
    /(^|[\s·ㆍ•,/|(\[])([월화수목금토일])(?:요일)?\s*(\d{1,2})\s*교시(?=$|[\s·ㆍ•,/|)\]])/g,
    (match, prefix, wd, pStr) => {
      const pNum = Number(pStr);
      return recordSchedule(wd, pNum) ? `${prefix} ` : match;
    }
  );

  // 5) Compact bare weekday + digits (only for class_label / period fields, never subject)
  if (allowCompactBare) {
    text = text.replace(
      /(^|[\s·ㆍ•,/|(\[])([월화수목금토일])(\d{1,2})(?=$|[\s·ㆍ•,/|)\]])/g,
      (match, prefix, wd, pStr) => {
        const pNum = Number(pStr);
        return recordSchedule(wd, pNum) ? `${prefix} ` : match;
      }
    );
  }

  return { text, period: firstPeriod, schedules };
}

function _normalizeExplicitPeriod(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    const n = Math.trunc(raw);
    return n >= 1 && n <= 15 ? n : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const directMatch = s.match(/^(?:제\s*)?(\d{1,2})\s*(?:교시)?$/);
  if (directMatch) {
    const n = Number(directMatch[1]);
    return n >= 1 && n <= 15 ? n : null;
  }
  const stripped = _stripWeekdayPeriod(s, true);
  if (stripped.period !== null) return stripped.period;
  return s;
}

function _extractAndStripClassToken(raw) {
  const str = String(raw || '').trim();
  if (!str) return { text: '', classLabel: '' };

  const specs = [
    // 1) Korean grade-class: 1학년 4반
    {
      bracketed: true,
      re: /\(\s*(\d{1,2})\s*학년\s*(\d{1,2})\s*반\s*\)|\[\s*(\d{1,2})\s*학년\s*(\d{1,2})\s*반\s*\]/g,
      format: (m) => {
        const g = Number(m[1] || m[3]);
        const c = Number(m[2] || m[4]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}학년 ${c}반` : null;
      },
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])(\d{1,2})\s*학년\s*(\d{1,2})\s*반(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => {
        const g = Number(m[2]);
        const c = Number(m[3]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}학년 ${c}반` : null;
      },
    },
    // 2) Grade + dash + alphanumeric moving-class code: 2-F206, 2-A
    {
      bracketed: true,
      re: /\(\s*(\d{1,2})\s*-\s*([A-Za-z][A-Za-z0-9]*)(?:반)?\s*\)|\[\s*(\d{1,2})\s*-\s*([A-Za-z][A-Za-z0-9]*)(?:반)?\s*\]/g,
      format: (m) => {
        const g = Number(m[1] || m[3]);
        const code = String(m[2] || m[4] || '').toUpperCase();
        return g >= 1 && g <= 6 && code ? `${g}-${code}` : null;
      },
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])(\d{1,2})\s*-\s*([A-Za-z][A-Za-z0-9]*)(?:반)?(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => {
        const g = Number(m[2]);
        const code = String(m[3] || '').toUpperCase();
        return g >= 1 && g <= 6 && code ? `${g}-${code}` : null;
      },
    },
    // 3) Grade + dash + numeric class: 1-4, 1-13
    {
      bracketed: true,
      re: /\(\s*(\d{1,2})\s*-\s*(\d{1,2})(?:반)?\s*\)|\[\s*(\d{1,2})\s*-\s*(\d{1,2})(?:반)?\s*\]/g,
      format: (m) => {
        const g = Number(m[1] || m[3]);
        const c = Number(m[2] || m[4]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}-${c}` : null;
      },
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])(\d{1,2})\s*-\s*(\d{1,2})(?:반)?(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => {
        const g = Number(m[2]);
        const c = Number(m[3]);
        return g >= 1 && g <= 6 && c >= 1 && c <= 30 ? `${g}-${c}` : null;
      },
    },
    // 4) Standalone moving-class code: F206, A101
    {
      bracketed: true,
      re: /\(\s*([A-Za-z]\d{2,4})(?:반)?\s*\)|\[\s*([A-Za-z]\d{2,4})(?:반)?\s*\]/g,
      format: (m) => String(m[1] || m[2] || '').toUpperCase() || null,
    },
    {
      bracketed: false,
      re: /(^|[\s·ㆍ•,;/|(\[])([A-Za-z]\d{2,4})(?:반)?(?=$|[\s·ㆍ•,;/|)\[\]])/g,
      format: (m) => String(m[2] || '').toUpperCase() || null,
    },
  ];

  for (const spec of specs) {
    spec.re.lastIndex = 0;
    let m;
    while ((m = spec.re.exec(str)) !== null) {
      const classLabel = spec.format(m);
      if (classLabel) {
        const prefix = spec.bracketed ? '' : (m[1] || '');
        const text = `${str.slice(0, m.index)}${prefix} ${str.slice(m.index + m[0].length)}`;
        return { text, classLabel };
      }
    }
  }
  return { text: str, classLabel: '' };
}

function parseLessonMeta(subjectOrObj, classLabel = '', period = '') {
  let rawSubject = subjectOrObj;
  let rawClass = classLabel;
  let rawPeriod = period;
  if (subjectOrObj && typeof subjectOrObj === 'object') {
    rawSubject = subjectOrObj.subject ?? '';
    rawClass = subjectOrObj.class_label ?? subjectOrObj.classLabel ?? '';
    rawPeriod = subjectOrObj.period ?? '';
  }

  const explicitPeriod = _normalizeExplicitPeriod(rawPeriod);
  const clsPeriodStrip = _stripWeekdayPeriod(rawClass, true);
  const subjPeriodStrip = _stripWeekdayPeriod(rawSubject, false);
  const resolvedPeriod = explicitPeriod !== null
    ? explicitPeriod
    : (clsPeriodStrip.period !== null ? clsPeriodStrip.period : subjPeriodStrip.period);

  const clsClassStrip = _extractAndStripClassToken(clsPeriodStrip.text);
  const subjClassStrip = _extractAndStripClassToken(subjPeriodStrip.text);

  const cleanedClsRemainder = _cleanMetaSeparators(clsClassStrip.text);
  const cleanedSubjRemainder = _cleanMetaSeparators(subjClassStrip.text);

  const resolvedClass = clsClassStrip.classLabel || cleanedClsRemainder || subjClassStrip.classLabel || '';
  const resolvedSubject = cleanedSubjRemainder || (clsClassStrip.classLabel ? cleanedClsRemainder : '');

  return {
    subject: resolvedSubject,
    class_label: resolvedClass,
    period: resolvedPeriod,
  };
}

function canonicalizeClassLabel(cls) {
  const s = String(cls || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const kor = s.match(/^(\d{1,2})\s*학년\s*(\d{1,2})\s*반$/);
  if (kor) return `${Number(kor[1])}-${Number(kor[2])}`;
  const dashNum = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})(?:반)?$/);
  if (dashNum) return `${Number(dashNum[1])}-${Number(dashNum[2])}`;
  const dashCode = s.match(/^(\d{1,2})\s*-\s*([A-Za-z][A-Za-z0-9]*)(?:반)?$/);
  if (dashCode) return `${Number(dashCode[1])}-${dashCode[2].toUpperCase()}`;
  const codeOnly = s.match(/^([A-Za-z]\d{2,4})(?:반)?$/);
  if (codeOnly) return codeOnly[1].toUpperCase();
  return s;
}

function normalizeLessonRecord(rec) {
  const base = rec && typeof rec === 'object' ? rec : {};
  const parsed = parseLessonMeta(base.subject, base.class_label, base.period);
  return {
    ...base,
    subject: parsed.subject,
    class_label: parsed.class_label,
    period: parsed.period !== null ? parsed.period : '',
  };
}

function buildLessonMatrixModel(progressList, rosterList, selectedSubject = '', todayWeekday = '') {
  const rawProgs = Array.isArray(progressList) ? progressList : [];
  const rawRosters = Array.isArray(rosterList) ? rosterList : [];

  const normProgs = rawProgs.map((p) => {
    const norm = normalizeLessonRecord(p);
    return {
      norm,
      classKey: canonicalizeClassLabel(norm.class_label),
    };
  });

  const normRosters = rawRosters.map((r) => {
    const parsed = parseLessonMeta(r && r.subject, r && r.class_label, r && r.period);
    const clsStrip = _stripWeekdayPeriod((r && r.class_label) || '', true);
    const subjStrip = _stripWeekdayPeriod((r && r.subject) || '', false);
    const schedules = [...clsStrip.schedules, ...subjStrip.schedules];
    return {
      subject: parsed.subject,
      classKey: canonicalizeClassLabel(parsed.class_label),
      schedules,
      fallbackPeriod: typeof parsed.period === 'number' ? parsed.period : null,
    };
  });

  const subjects = Array.from(new Set([
    ...normProgs.map((x) => x.norm.subject),
    ...normRosters.map((x) => x.subject),
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko'));

  const parsedSelected = selectedSubject ? parseLessonMeta(selectedSubject).subject : '';
  const targetSubject = (selectedSubject && subjects.includes(selectedSubject))
    ? selectedSubject
    : ((parsedSelected && subjects.includes(parsedSelected)) ? parsedSelected : (subjects[0] || ''));

  const subProgs = normProgs.filter((x) => x.norm.subject === targetSubject);
  const subRosters = normRosters.filter((x) => x.subject === targetSubject);

  const classLabels = Array.from(new Set([
    ...subProgs.map((x) => x.classKey),
    ...subRosters.map((x) => x.classKey),
  ].filter(Boolean))).sort(_naturalClassSort);

  const rosterMetaByClass = new Map();
  subRosters.forEach((r) => {
    if (!r.classKey) return;
    if (!rosterMetaByClass.has(r.classKey)) {
      rosterMetaByClass.set(r.classKey, { schedules: [], fallbackPeriods: [] });
    }
    const entry = rosterMetaByClass.get(r.classKey);
    if (r.schedules.length > 0) {
      entry.schedules.push(...r.schedules);
    } else if (r.fallbackPeriod !== null) {
      entry.fallbackPeriods.push(r.fallbackPeriod);
    }
  });

  const defaultPeriodByClass = new Map();
  rosterMetaByClass.forEach((meta, clsKey) => {
    const schedPeriods = meta.schedules.map((s) => s.period);
    const allPeriods = Array.from(new Set(schedPeriods.length > 0 ? schedPeriods : meta.fallbackPeriods));
    if (allPeriods.length === 1) {
      defaultPeriodByClass.set(clsKey, allPeriods[0]);
    } else if (allPeriods.length > 1 && todayWeekday) {
      const matched = meta.schedules.find((s) => s.weekday === todayWeekday);
      if (matched) defaultPeriodByClass.set(clsKey, matched.period);
    }
  });

  const rowMap = new Map();
  subProgs.forEach(({ norm, classKey }) => {
    const unit = String(norm.unit || '').trim() || '진도 기록';
    const lessonNo = String(norm.lesson_no || '').trim();
    const rowKey = `${unit}__${lessonNo}`;
    if (!rowMap.has(rowKey)) rowMap.set(rowKey, { unit, lessonNo, byClass: new Map() });
    if (classKey && !rowMap.get(rowKey).byClass.has(classKey)) {
      rowMap.get(rowKey).byClass.set(classKey, norm);
    }
  });
  if (rowMap.size === 0 && classLabels.length > 0) {
    rowMap.set('진도 기록__', { unit: '진도 기록', lessonNo: '', byClass: new Map() });
  }

  return {
    subjects,
    targetSubject,
    classLabels,
    rows: Array.from(rowMap.values()),
    defaultPeriodByClass,
  };
}

function _escapeJsAttr(val) {
  const jsEscaped = String(val ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return escapeHtml(jsEscaped);
}

function _populateSelectOptions(selectEl, values, currentVal, defaultLabel, sortFn = null) {
  if (!selectEl) return;
  const comparator = typeof sortFn === 'function' ? sortFn : (a, b) => String(a).localeCompare(String(b), 'ko');
  const unique = Array.from(new Set(values.filter(Boolean))).sort(comparator);
  const opts = [`<option value="">${escapeHtml(defaultLabel)}</option>`];
  unique.forEach((v) => {
    opts.push(`<option value="${escapeHtml(v)}" ${v === currentVal ? 'selected' : ''}>${escapeHtml(v)}</option>`);
  });
  selectEl.innerHTML = opts.join('');
}

function _naturalClassSort(a, b) {
  const ma = String(a).match(/(\d+)\D+(\d+)/);
  const mb = String(b).match(/(\d+)\D+(\d+)/);
  if (ma && mb) {
    const gDiff = Number(ma[1]) - Number(mb[1]);
    if (gDiff !== 0) return gDiff;
    return Number(ma[2]) - Number(mb[2]);
  }
  return String(a).localeCompare(String(b), 'ko');
}

function renderLessonProgressMatrix(progressList, rosterList) {
  const subSelect = document.getElementById('lesson-matrix-subject-select');
  const thead = document.getElementById('lesson-matrix-thead');
  const tbody = document.getElementById('lesson-matrix-tbody');
  if (!subSelect || !thead || !tbody) return;

  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const todayWeekday = weekdays[new Date().getDay()];
  const model = buildLessonMatrixModel(progressList, rosterList, adminState.lessonMatrixSubject, todayWeekday);
  adminState.lessonMatrixSubject = model.targetSubject;

  if (model.subjects.length === 0) {
    subSelect.innerHTML = '<option value="">등록된 과목 없음</option>';
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="py-8 text-center text-slate-400">수업 진도 또는 교과 명렬표가 없습니다.</td></tr>';
    return;
  }

  subSelect.innerHTML = model.subjects.map((s) => `<option value="${escapeHtml(s)}" ${s === model.targetSubject ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');

  if (model.classLabels.length === 0) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td class="py-8 text-center text-slate-400">해당 과목의 담당 학반 데이터가 없습니다.</td></tr>';
    return;
  }

  thead.innerHTML = `
    <tr class="bg-slate-100/80 text-slate-600 border-b border-slate-200 font-semibold text-[11px] whitespace-nowrap">
      <th class="py-2.5 px-4 table-cell-sticky bg-slate-100 min-w-[160px]">단원 / 차시</th>
      ${model.classLabels.map((c) => `<th class="py-2.5 px-3 text-center min-w-[130px] border-l border-slate-200/80">${escapeHtml(c)}</th>`).join('')}
    </tr>
  `;

  tbody.innerHTML = model.rows.map((row) => {
    const cells = model.classLabels.map((cls) => {
      const p = row.byClass.get(cls) || null;
      const defaultPeriod = model.defaultPeriodByClass.get(cls);
      const defaultPeriodArg = defaultPeriod !== undefined && defaultPeriod !== null ? String(defaultPeriod) : '';
      if (!p) {
        return `
          <td class="p-2 border-l border-slate-100 text-center align-middle">
            <button type="button" onclick="openLessonMatrixCellModal('', '${_escapeJsAttr(model.targetSubject)}', '${_escapeJsAttr(cls)}', '${_escapeJsAttr(row.unit)}', '${_escapeJsAttr(row.lessonNo)}', '${_escapeJsAttr(defaultPeriodArg)}')" class="w-full py-2 px-2 rounded-lg border border-dashed border-slate-200 text-[11px] text-slate-400 hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50/40 transition">+ 입력</button>
          </td>
        `;
      }
      const st = String(p.status || '완료').trim();
      let stCls = 'bg-emerald-100 text-emerald-700';
      if (st === '진행중') stCls = 'bg-amber-100 text-amber-800';
      else if (st === '예정') stCls = 'bg-slate-100 text-slate-600';
      return `
        <td class="p-2 border-l border-slate-100 align-top">
          <button type="button" onclick="openLessonMatrixCellModal('${_escapeJsAttr(p.remote_id || '')}', '${_escapeJsAttr(model.targetSubject)}', '${_escapeJsAttr(cls)}', '${_escapeJsAttr(row.unit)}', '${_escapeJsAttr(row.lessonNo)}', '${_escapeJsAttr(defaultPeriodArg)}')" class="w-full text-left p-2 rounded-lg bg-slate-50/80 hover:bg-indigo-50/60 border border-slate-200/70 hover:border-indigo-300 transition space-y-1">
            <div class="flex items-center justify-between gap-1">
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${stCls}">${escapeHtml(st)}</span>
              <span class="text-[10px] font-mono text-slate-400">${escapeHtml((p.date || '').slice(5) || '-')}</span>
            </div>
            <div class="text-[11px] text-slate-700 line-clamp-2">${escapeHtml(p.content || p.unit || '-')}</div>
          </button>
        </td>
      `;
    }).join('');

    return `
      <tr class="hover:bg-slate-50/40">
        <td class="py-2.5 px-4 table-cell-sticky bg-white font-semibold text-slate-800 align-top">
          <div>${escapeHtml(row.unit)}</div>
          ${row.lessonNo ? `<div class="text-[11px] text-indigo-600 font-medium">${escapeHtml(row.lessonNo)}</div>` : ''}
        </td>
        ${cells}
      </tr>
    `;
  }).join('');
}

function openLessonMatrixCellModal(remoteId, subject, classLabel, unit, lessonNo, defaultPeriod = '') {
  openLessonProgressModal(remoteId);
  if (!remoteId) {
    const parsed = parseLessonMeta(subject, classLabel, defaultPeriod);
    document.getElementById('lp-subject').value = parsed.subject || '';
    document.getElementById('lp-class-label').value = parsed.class_label || '';
    document.getElementById('lp-period').value = parsed.period !== null && parsed.period !== '' ? String(parsed.period) : '';
    document.getElementById('lp-unit').value = unit === '진도 기록' ? '' : (unit || '');
    document.getElementById('lp-lesson-no').value = lessonNo || '';
    document.getElementById('lp-status').value = '완료';
  }
}

function renderLessonsTab() {
  const ov = adminState.overview || {};
  const rawProgressList = ov.lesson_progress || [];
  const rawSubAttList = ov.subject_attendance || [];
  const rosterList = ov.subject_rosters || [];

  renderLessonProgressMatrix(rawProgressList, rosterList);

  const progressList = rawProgressList.map(normalizeLessonRecord);
  const subAttList = rawSubAttList.map(normalizeLessonRecord);

  const allSubjects = [
    ...progressList.map((p) => p.subject),
    ...subAttList.map((a) => a.subject),
  ];
  const allClasses = [
    ...progressList.map((p) => canonicalizeClassLabel(p.class_label)),
    ...subAttList.map((a) => canonicalizeClassLabel(a.class_label)),
  ];

  _populateSelectOptions(document.getElementById('lesson-compare-subject-filter'), allSubjects, adminState.lessonCompareSubject, '전체 교과');
  _populateSelectOptions(document.getElementById('lesson-prog-subject-filter'), allSubjects, adminState.lessonProgSubject, '전체 과목');
  _populateSelectOptions(document.getElementById('lesson-prog-class-filter'), allClasses, adminState.lessonProgClass, '전체 반', _naturalClassSort);
  _populateSelectOptions(document.getElementById('lesson-att-subject-filter'), allSubjects, adminState.lessonAttSubject, '전체 과목');
  _populateSelectOptions(document.getElementById('lesson-att-class-filter'), allClasses, adminState.lessonAttClass, '전체 반', _naturalClassSort);

  // 1) 반별/교과별 최신 진도 비교표
  const latestByGroup = new Map();
  progressList.forEach((p) => {
    const sub = String(p.subject || '').trim();
    const clsKey = canonicalizeClassLabel(p.class_label);
    if (!sub) return;
    if (adminState.lessonCompareSubject && sub !== adminState.lessonCompareSubject) return;
    const key = `${sub}__${clsKey}`;
    if (!latestByGroup.has(key)) {
      latestByGroup.set(key, p);
    }
  });

  const compareGrid = document.getElementById('lesson-latest-compare-grid');
  if (compareGrid) {
    const groups = Array.from(latestByGroup.values()).sort((a, b) =>
      String(a.subject || '').localeCompare(String(b.subject || ''), 'ko') ||
      _naturalClassSort(canonicalizeClassLabel(a.class_label), canonicalizeClassLabel(b.class_label))
    );
    compareGrid.innerHTML = groups.length === 0
      ? '<div class="col-span-full py-8 text-center text-xs text-slate-400">기록된 수업 진도가 없습니다.</div>'
      : groups.map((g) => `
        <div class="p-3.5 rounded-xl border border-slate-200 bg-slate-50/50 space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold text-indigo-700">${escapeHtml(g.subject)} · ${escapeHtml(canonicalizeClassLabel(g.class_label) || g.class_label || '-')}</span>
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-600">${escapeHtml(g.lesson_no || '-')}</span>
          </div>
          <div class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(g.unit || '-')}</div>
          <p class="text-[11px] text-slate-600 line-clamp-2">${escapeHtml(g.content || '-')}</p>
          <div class="flex items-center justify-between pt-1 text-[10px] text-slate-400">
            <span>${escapeHtml(g.date || '-')} ${g.period ? `${escapeHtml(g.period)}교시` : ''}</span>
            <button type="button" onclick="openLessonProgressModal('${_escapeJsAttr(g.remote_id || '')}')" class="text-indigo-600 font-semibold hover:underline">수정</button>
          </div>
        </div>
      `).join('');
  }

  // 2) 진도 누적 이력 표
  const filteredProg = progressList.filter((p) => {
    if (adminState.lessonProgSubject && p.subject !== adminState.lessonProgSubject) return false;
    if (adminState.lessonProgClass && canonicalizeClassLabel(p.class_label) !== adminState.lessonProgClass) return false;
    return true;
  });

  const progTbody = document.getElementById('lesson-progress-tbody');
  if (progTbody) {
    progTbody.innerHTML = filteredProg.length === 0
      ? '<tr><td colspan="8" class="py-8 text-center text-slate-400">조회된 수업 진도 이력이 없습니다.</td></tr>'
      : filteredProg.map((p) => {
          const rid = String(p.remote_id || '');
          const displayCls = canonicalizeClassLabel(p.class_label) || p.class_label || '-';
          return `
            <tr class="hover:bg-slate-50">
              <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(p.date || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap">${p.period ? `${escapeHtml(p.period)}교시` : '-'}</td>
              <td class="py-2.5 px-3 font-bold text-slate-800 whitespace-nowrap">${escapeHtml(p.subject || '-')}</td>
              <td class="py-2.5 px-3 whitespace-nowrap">${escapeHtml(displayCls)}</td>
              <td class="py-2.5 px-3 text-indigo-700 font-semibold whitespace-nowrap">${escapeHtml(p.lesson_no || '-')}</td>
              <td class="py-2.5 px-4">
                <div class="font-semibold text-slate-800">${escapeHtml(p.unit || '-')}</div>
                <div class="text-[11px] text-slate-500">${escapeHtml(p.content || '')}</div>
              </td>
              <td class="py-2.5 px-4 text-slate-500">${escapeHtml(p.next_note || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">
                <button type="button" onclick="openLessonProgressModal('${_escapeJsAttr(rid)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
                <button type="button" onclick="deleteLessonProgressRow('${_escapeJsAttr(rid)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
              </td>
            </tr>
          `;
        }).join('');
  }

  // 3) 교과 출결 조회 표
  const filteredAtt = subAttList.filter((a) => {
    if (adminState.lessonAttDate && String(a.date || '').slice(0, 10) !== adminState.lessonAttDate) return false;
    if (adminState.lessonAttSubject && a.subject !== adminState.lessonAttSubject) return false;
    if (adminState.lessonAttClass && canonicalizeClassLabel(a.class_label) !== adminState.lessonAttClass) return false;
    return true;
  });

  const attTbody = document.getElementById('lesson-att-tbody');
  if (attTbody) {
    attTbody.innerHTML = filteredAtt.length === 0
      ? '<tr><td colspan="9" class="py-8 text-center text-slate-400">조회된 교과 출결 기록이 없습니다.</td></tr>'
      : filteredAtt.map((a) => {
          const rid = String(a.remote_id || '');
          const st = String(a.status || '출석');
          let badgeCls = 'bg-emerald-100 text-emerald-700';
          if (st.includes('결석') || st.includes('결과')) badgeCls = 'bg-rose-100 text-rose-700';
          else if (st.includes('지각') || st.includes('조퇴')) badgeCls = 'bg-amber-100 text-amber-800';
          else if (st.includes('공결')) badgeCls = 'bg-indigo-100 text-indigo-700';
          const displayCls = canonicalizeClassLabel(a.class_label) || a.class_label || '-';
          return `
            <tr class="hover:bg-slate-50">
              <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(a.date || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap">${a.period ? `${escapeHtml(a.period)}교시` : '-'}</td>
              <td class="py-2.5 px-3 font-semibold text-slate-800 whitespace-nowrap">${escapeHtml(a.subject || '-')}</td>
              <td class="py-2.5 px-3 whitespace-nowrap">${escapeHtml(displayCls)}</td>
              <td class="py-2.5 px-3 text-center font-mono text-slate-500 tabular-nums">${escapeHtml(a.student_id || '-')}</td>
              <td class="py-2.5 px-4 font-bold text-slate-900">${escapeHtml(a.student_name || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ${badgeCls}">${escapeHtml(st)}</span></td>
              <td class="py-2.5 px-4 text-slate-500">${escapeHtml(a.memo || '-')}</td>
              <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">
                <button type="button" onclick="openSubjectAttModal('${_escapeJsAttr(rid)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
                <button type="button" onclick="deleteSubjectAttRow('${_escapeJsAttr(rid)}', '${_escapeJsAttr(a.student_name || a.student_id)}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
              </td>
            </tr>
          `;
        }).join('');
  }
}

function normalizeLessonModalInputs() {
  const subjectEl = document.getElementById('lp-subject');
  const classEl = document.getElementById('lp-class-label');
  const periodEl = document.getElementById('lp-period');
  if (!subjectEl || !classEl || !periodEl) return { subject: '', class_label: '', period: null };
  const parsed = parseLessonMeta(subjectEl.value, classEl.value, periodEl.value);
  subjectEl.value = parsed.subject;
  classEl.value = parsed.class_label;
  periodEl.value = parsed.period !== null && parsed.period !== '' ? String(parsed.period) : '';
  return parsed;
}

function openLessonProgressModal(remoteId = '') {
  const ov = adminState.overview || {};
  const list = ov.lesson_progress || [];
  const item = remoteId ? list.find((p) => String(p.remote_id || '') === remoteId) : null;
  const parsed = item ? parseLessonMeta(item.subject, item.class_label, item.period) : null;

  document.getElementById('lesson-prog-modal-title').textContent = item ? '수업 진도 수정' : '수업 진도 추가';
  document.getElementById('lp-remote-id').value = item ? String(item.remote_id || '') : '';
  document.getElementById('lp-date').value = item ? String(item.date || '').slice(0, 10) || getLocalTodayStr() : getLocalTodayStr();
  document.getElementById('lp-period').value = parsed && parsed.period !== null && parsed.period !== '' ? String(parsed.period) : '';
  document.getElementById('lp-status').value = item ? String(item.status || '완료') : '완료';
  document.getElementById('lp-subject').value = parsed ? parsed.subject : '';
  document.getElementById('lp-class-label').value = parsed ? parsed.class_label : '';
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
  const list = (ov.lesson_progress || []).map(normalizeLessonRecord);
  const headers = ['일자', '교시', '과목', '반', '차시/페이지', '단원명', '수업내용', '다음안내'];
  const lines = [headers.map(csvEscape).join(',')];
  list.forEach((p) => {
    lines.push([
      p.date || '',
      p.period || '',
      p.subject || '',
      canonicalizeClassLabel(p.class_label) || p.class_label || '',
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
  const list = (ov.subject_attendance || []).map(normalizeLessonRecord);
  const headers = ['일자', '교시', '과목', '반', '학번', '이름', '출결상태', '비고'];
  const lines = [headers.map(csvEscape).join(',')];
  list.forEach((a) => {
    lines.push([
      a.date || '',
      a.period || '',
      a.subject || '',
      canonicalizeClassLabel(a.class_label) || a.class_label || '',
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
  { tabId: 'tab-schedules', navId: 'nav-item-schedules', mobId: 'mobile-tab-btn-schedules' },
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
  if (activeTabId === 'tab-schedules') {
    renderSchedulesTab();
  }
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
  renderSchedulesTab();
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
      const loginRes = await callApi('login', { role: 'teacher', user_id: userId, password }, false);
      adminState.auth = {
        role: 'teacher',
        userId,
        token: String((loginRes && loginRes.token) || ''),
        expiresAt: Number((loginRes && loginRes.expires_at) || 0),
      };
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

  // Tab 2 student/parent attendance report filters
  document.querySelectorAll('[data-att-report-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      adminState.attReportStatus = btn.getAttribute('data-att-report-status') || 'all';
      ['all', 'unconfirmed', 'confirmed'].forEach((k) => {
        const el = document.getElementById(`att-report-filter-${k}`);
        if (!el) return;
        const active = k === adminState.attReportStatus;
        if (k === 'all') el.className = active ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 text-white transition' : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-200/70 transition';
        if (k === 'unconfirmed') el.className = active ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 text-white transition' : 'px-3 py-1.5 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-50 transition';
        if (k === 'confirmed') el.className = active ? 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white transition' : 'px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-200/70 transition';
      });
      renderAttendanceReportsPanel();
    });
  });
  document.getElementById('att-report-period-filter')?.addEventListener('change', (e) => {
    adminState.attReportPeriod = e.target.value;
    renderAttendanceReportsPanel();
  });
  document.getElementById('att-report-search')?.addEventListener('input', (e) => {
    adminState.attReportSearch = e.target.value;
    renderAttendanceReportsPanel();
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
  document.getElementById('lesson-matrix-subject-select')?.addEventListener('change', (e) => {
    adminState.lessonMatrixSubject = e.target.value;
    renderLessonsTab();
  });
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

  document.getElementById('lp-subject')?.addEventListener('blur', normalizeLessonModalInputs);
  document.getElementById('lp-class-label')?.addEventListener('blur', normalizeLessonModalInputs);
  document.getElementById('lp-period')?.addEventListener('blur', normalizeLessonModalInputs);

  document.getElementById('lesson-progress-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('lp-submit-btn');
    const parsed = normalizeLessonModalInputs();
    const payload = {
      remote_id: document.getElementById('lp-remote-id').value.trim(),
      date: document.getElementById('lp-date').value,
      period: parsed.period !== null && parsed.period !== '' ? parsed.period : '',
      status: document.getElementById('lp-status').value,
      subject: parsed.subject,
      class_label: parsed.class_label,
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

  // Phone edit modal submit
  document.getElementById('phone-edit-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!adminState.phoneEditTarget) return;
    const { role, remoteId } = adminState.phoneEditTarget;
    const phoneInput = document.getElementById('phone-edit-input').value.trim();
    const btn = document.getElementById('phone-edit-submit-btn');
    btn.disabled = true;
    try {
      const res = await callApi('admin_update_account_phone', {
        target_role: role,
        remote_id: remoteId,
        phone: phoneInput,
      }, true);
      const savedPhone = res && res.phone !== undefined ? String(res.phone) : phoneInput;
      if (adminState.overview) {
        const listKey = role === 'parent' ? 'parents' : 'students';
        const list = Array.isArray(adminState.overview[listKey]) ? adminState.overview[listKey] : [];
        const target = list.find((item) =>
          String(item.remote_id || '') === String(remoteId) ||
          String(item.student_id || '') === String(remoteId) ||
          String(item.parent_id || '') === String(remoteId)
        );
        if (target) {
          target.phone = savedPhone;
        }
      }
      renderRosterTab();
      closePhoneEditModal();
    } catch (err) {
      alert(`연락처 수정 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Roster student add/edit modal submit
  document.getElementById('roster-student-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('rs-submit-btn');
    btn.disabled = true;
    try {
      const rid = document.getElementById('rs-remote-id').value.trim();
      const payload = {
        remote_id: rid || undefined,
        student_id: document.getElementById('rs-student-id').value.trim(),
        student_no: document.getElementById('rs-student-no').value.trim() || undefined,
        name: document.getElementById('rs-name').value.trim(),
        phone: document.getElementById('rs-phone').value.trim(),
      };
      if (!rid) {
        payload.initial_password = document.getElementById('rs-init-pw').value.trim();
        payload.create_parent = Boolean(document.getElementById('rs-create-parent').checked);
      }
      await callApi('admin_upsert_roster_student', payload, true);
      closeRosterStudentModal();
      await refreshAdminData();
    } catch (err) {
      alert(`저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Notice add/edit modal submit
  document.getElementById('notice-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('nt-submit-btn');
    btn.disabled = true;
    try {
      const rid = document.getElementById('nt-remote-id').value.trim();
      const payload = {
        remote_id: rid || undefined,
        title: document.getElementById('nt-title').value.trim(),
        category: document.getElementById('nt-category').value.trim() || '가정통신문',
        due_date: document.getElementById('nt-due-date').value.trim(),
        content: document.getElementById('nt-content').value.trim(),
        attachment_url: document.getElementById('nt-attachment-url').value.trim(),
        requires_reply: Boolean(document.getElementById('nt-requires-reply').checked),
        signature_mode: document.getElementById('nt-signature-mode').value || 'single',
        is_published: true,
      };
      const res = await callApi('upsert_notice', payload, true);
      if (res && res.remote_id) adminState.selectedNoticeId = String(res.remote_id);
      closeNoticeModal();
      await refreshAdminData();
    } catch (err) {
      alert(`가정통신문 저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Board notice add/edit modal submit
  document.getElementById('board-notice-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('bn-submit-btn');
    btn.disabled = true;
    try {
      const rid = document.getElementById('bn-remote-id').value.trim();
      const payload = {
        remote_id: rid || undefined,
        title: document.getElementById('bn-title').value.trim(),
        source_type: document.getElementById('bn-source-type').value || '담임 공지',
        is_pinned: Boolean(document.getElementById('bn-is-pinned').checked),
        summary: document.getElementById('bn-summary').value.trim(),
        content: document.getElementById('bn-content').value.trim(),
        is_published: true,
      };
      await callApi('upsert_board_notice', payload, true);
      closeBoardNoticeModal();
      await refreshAdminData();
    } catch (err) {
      alert(`학급 공지 저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Daily attendance add/edit modal submit
  document.getElementById('attendance-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('att-modal-submit-btn');
    btn.disabled = true;
    try {
      const rid = document.getElementById('att-modal-remote-id').value.trim();
      const sid = document.getElementById('att-modal-student').value.trim();
      const students = (adminState.overview && adminState.overview.students) || [];
      const stu = students.find((s) => String(s.student_id || s.remote_id || '') === sid);
      await callApi('submit_attendance', {
        remote_id: rid || undefined,
        role: 'teacher',
        date: document.getElementById('att-modal-date').value.trim(),
        student_id: sid,
        student_name: stu ? String(stu.name || stu.student_name || sid) : sid,
        attendance_type: document.getElementById('att-modal-type').value,
        period_info: document.getElementById('att-modal-period').value.trim(),
        reason: document.getElementById('att-modal-reason').value.trim(),
        teacher_confirmed: true,
      }, true);
      closeAttendanceModal();
      await refreshAdminData();
    } catch (err) {
      alert(`출결 저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Document tracking add/edit modal submit
  document.getElementById('doc-tracking-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('dt-submit-btn');
    btn.disabled = true;
    try {
      const rid = document.getElementById('dt-remote-id').value.trim();
      const sid = document.getElementById('dt-student').value.trim();
      const students = (adminState.overview && adminState.overview.students) || [];
      const stu = students.find((s) => String(s.student_id || s.remote_id || '') === sid);
      await callApi('upsert_document_tracking', {
        remote_id: rid || undefined,
        role: 'teacher',
        student_id: sid,
        student_name: stu ? String(stu.name || stu.student_name || sid) : sid,
        doc_name: document.getElementById('dt-doc-name').value.trim(),
        doc_type: document.getElementById('dt-doc-name').value.trim(),
        due_date: document.getElementById('dt-due-date').value.trim(),
        status: document.getElementById('dt-status').value,
        memo: document.getElementById('dt-memo').value.trim(),
      }, true);
      closeDocTrackingModal();
      await refreshAdminData();
    } catch (err) {
      alert(`서류 추적 저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Subject attendance edit modal submit
  document.getElementById('subject-att-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rid = document.getElementById('sa-remote-id').value.trim();
    const list = (adminState.overview && adminState.overview.subject_attendance) || [];
    const target = list.find((a) => String(a.remote_id || '') === rid);
    if (!target) return;
    const btn = document.getElementById('sa-submit-btn');
    btn.disabled = true;
    try {
      await callApi('save_subject_attendance_batch', {
        date: String(target.date || '').slice(0, 10),
        period: target.period || '',
        subject: target.subject || '',
        class_label: target.class_label || '',
        roster_key: target.roster_key || '',
        records: [{
          remote_id: rid,
          student_id: target.student_id,
          student_name: target.student_name || '',
          status: document.getElementById('sa-status').value,
          memo: document.getElementById('sa-memo').value.trim(),
        }],
      }, true);
      closeSubjectAttModal();
      await refreshAdminData();
    } catch (err) {
      alert(`교과 출결 수정 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // 1:1 Counsel reply submit
  document.getElementById('counsel-reply-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sid = adminState.selectedCounselStudentId;
    if (!sid) {
      alert('답장을 보낼 학생을 먼저 선택해 주세요.');
      return;
    }
    const input = document.getElementById('counsel-reply-input');
    const msg = input.value.trim();
    if (!msg) return;
    const btn = document.getElementById('counsel-reply-submit-btn');
    btn.disabled = true;
    try {
      await callApi('send_chat_message', {
        room_id: `ROOM-${sid}`,
        student_id: sid,
        sender_role: 'teacher',
        message: msg,
      }, true);
      input.value = '';
      await refreshAdminData();
    } catch (err) {
      alert(`답장 전송 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Schedule add/edit modal submit
  document.getElementById('schedule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('sc-submit-btn');
    btn.disabled = true;
    try {
      const rid = document.getElementById('sc-remote-id').value.trim();
      await callApi('upsert_schedule', {
        remote_id: rid || undefined,
        title: document.getElementById('sc-title').value.trim(),
        start_date: document.getElementById('sc-start-date').value.trim(),
        end_date: document.getElementById('sc-end-date').value.trim(),
        category: document.getElementById('sc-category').value.trim() || '학사일정',
        is_private: Boolean(document.getElementById('sc-is-private').checked),
        memo: document.getElementById('sc-memo').value.trim(),
      }, true);
      closeScheduleModal();
      await refreshAdminData();
    } catch (err) {
      alert(`학사일정 저장 실패: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

function openBoardNoticeModal(remoteId = '') {
  const list = (adminState.overview && adminState.overview.board_notices) || [];
  const target = remoteId ? list.find((b) => String(b.remote_id || b.id || '') === String(remoteId)) : null;
  document.getElementById('board-notice-modal-title').textContent = target ? '학급 공지 수정' : '학급 공지 작성';
  document.getElementById('bn-remote-id').value = target ? String(target.remote_id || target.id || '') : '';
  document.getElementById('bn-title').value = target ? String(target.title || '') : '';
  document.getElementById('bn-source-type').value = target ? String(target.source_type || '담임 공지') : '담임 공지';
  document.getElementById('bn-is-pinned').checked = Boolean(target && target.is_pinned);
  document.getElementById('bn-summary').value = target ? String(target.summary || '') : '';
  document.getElementById('bn-content').value = target ? String(target.content || '') : '';
  document.getElementById('board-notice-modal').classList.remove('hidden');
}

function closeBoardNoticeModal() {
  document.getElementById('board-notice-modal').classList.add('hidden');
}

function deleteBoardNoticeRow(remoteId, title) {
  if (!confirm(`"${title || remoteId}" 공지를 삭제하시겠습니까?`)) return;
  callApi('delete_board_notice', { remote_id: remoteId }, true)
    .then(() => refreshAdminData())
    .catch((err) => alert(`공지 삭제 실패: ${err.message}`));
}

function _populateStudentSelectOptions(selectEl, selectedSid = '') {
  if (!selectEl) return;
  const students = (adminState.overview && adminState.overview.students) || [];
  selectEl.innerHTML = students.map((s) => {
    const sid = String(s.student_id || s.remote_id || '').trim();
    const label = `${s.student_no ? `${s.student_no}번 ` : ''}${s.name || sid} (${sid})`;
    return `<option value="${escapeHtml(sid)}" ${sid === String(selectedSid) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function openAttendanceModal(remoteId = '', studentId = '', dateStr = '') {
  const list = (adminState.overview && adminState.overview.attendance) || [];
  const target = remoteId ? list.find((a) => String(a.remote_id || '') === String(remoteId)) : null;
  document.getElementById('attendance-modal-title').textContent = target ? '일일 출결 수정' : '일일 출결 등록';
  document.getElementById('att-modal-remote-id').value = target ? String(target.remote_id || '') : '';
  document.getElementById('att-modal-date').value = (target && target.date) || dateStr || adminState.attDailyDate || getLocalTodayStr();
  _populateStudentSelectOptions(document.getElementById('att-modal-student'), (target && target.student_id) || studentId);
  document.getElementById('att-modal-type').value = (target && target.attendance_type) || '출석';
  document.getElementById('att-modal-period').value = (target && target.period_info) || '';
  document.getElementById('att-modal-reason').value = (target && target.reason) || '';
  document.getElementById('attendance-modal').classList.remove('hidden');
}

function closeAttendanceModal() {
  document.getElementById('attendance-modal').classList.add('hidden');
}

async function deleteAttendanceRow(remoteId, studentName) {
  if (!confirm(`${studentName || ''} 학생의 이 출결 기록을 삭제하시겠습니까?`)) return;
  try {
    await callApi('delete_attendance', { remote_id: remoteId, role: 'teacher' }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`출결 삭제 실패: ${err.message}`);
  }
}

function openDocTrackingModal(remoteId = '') {
  const docs = (adminState.overview && adminState.overview.documents) || [];
  const target = remoteId ? docs.find((d) => String(d.remote_id || '') === String(remoteId)) : null;
  document.getElementById('doc-tracking-modal-title').textContent = target ? '증빙 서류 수정' : '증빙 서류 추가';
  document.getElementById('dt-remote-id').value = target ? String(target.remote_id || '') : '';
  _populateStudentSelectOptions(document.getElementById('dt-student'), target && target.student_id);
  document.getElementById('dt-doc-name').value = target ? String(target.doc_name || target.rule_name || target.doc_type || '') : '';
  document.getElementById('dt-due-date').value = target ? String(target.due_date || '') : '';
  document.getElementById('dt-status').value = target ? String(target.status || 'pending') : 'pending';
  document.getElementById('dt-memo').value = target ? String(target.memo || '') : '';
  document.getElementById('doc-tracking-modal').classList.remove('hidden');
}

function closeDocTrackingModal() {
  document.getElementById('doc-tracking-modal').classList.add('hidden');
}

async function deleteDocTrackingRow(remoteId, studentName) {
  if (!confirm(`${studentName || ''} 학생의 증빙 서류 추적 항목을 삭제하시겠습니까?`)) return;
  try {
    await callApi('delete_document_tracking', { remote_id: remoteId }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`서류 추적 삭제 실패: ${err.message}`);
  }
}

function openSubjectAttModal(remoteId) {
  const list = (adminState.overview && adminState.overview.subject_attendance) || [];
  const target = list.find((a) => String(a.remote_id || '') === String(remoteId));
  if (!target) return;
  document.getElementById('sa-remote-id').value = String(target.remote_id || '');
  document.getElementById('sa-target-label').textContent = `${target.date || ''} · ${target.subject || ''} (${target.class_label || ''}) · ${target.student_name || target.student_id}`;
  document.getElementById('sa-status').value = String(target.status || '출석');
  document.getElementById('sa-memo').value = String(target.memo || '');
  document.getElementById('subject-att-modal').classList.remove('hidden');
}

function closeSubjectAttModal() {
  document.getElementById('subject-att-modal').classList.add('hidden');
}

async function deleteSubjectAttRow(remoteId, studentName) {
  if (!confirm(`${studentName || ''} 학생의 교과 출결 기록을 삭제하시겠습니까?`)) return;
  try {
    await callApi('delete_subject_attendance', { remote_id: remoteId }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`교과 출결 삭제 실패: ${err.message}`);
  }
}

function renderSchedulesTab() {
  if (typeof document === 'undefined') return;
  const rawSchedules = (adminState && adminState.overview && Array.isArray(adminState.overview.schedules))
    ? adminState.overview.schedules
    : [];
  const schedules = rawSchedules.filter((s) => s && typeof s === 'object');
  const badgeEl = document.getElementById('badge-schedules-count');
  if (badgeEl) badgeEl.textContent = String(schedules.length);
  const tbody = document.getElementById('schedules-tbody');
  if (!tbody) return;
  tbody.innerHTML = schedules.length === 0
    ? '<tr><td colspan="6" class="py-8 text-center text-slate-400">등록된 학사일정이 없습니다.</td></tr>'
    : schedules.map((s) => {
        const rid = String(s.remote_id || s.id || '');
        const start = String(s.start_date || s.date || '-');
        const end = String(s.end_date || start);
        const periodText = start === end ? start : `${start} ~ ${end}`;
        const isPriv = s.is_private === true ||
          String(s.is_private || '').trim().toLowerCase() === 'true' ||
          String(s.visibility || '').trim().toLowerCase() === 'private';
        return `
          <tr class="hover:bg-slate-50">
            <td class="py-2.5 px-4 font-mono text-[11px] text-slate-600 whitespace-nowrap">${escapeHtml(periodText)}</td>
            <td class="py-2.5 px-4 font-bold text-slate-900">${escapeHtml(s.title || '-')}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700">${escapeHtml(s.category || '학사일정')}</span></td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap">${isPriv ? '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800">교사 개인</span>' : '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700">공개</span>'}</td>
            <td class="py-2.5 px-4 text-slate-500">${escapeHtml(s.memo || s.description || '-')}</td>
            <td class="py-2.5 px-3 text-center whitespace-nowrap space-x-1">
              <button type="button" onclick="openScheduleModal('${_escapeJsAttr(rid)}')" class="px-2 py-1 bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 rounded-lg text-[11px] font-semibold">수정</button>
              <button type="button" onclick="deleteScheduleRow('${_escapeJsAttr(rid)}', '${_escapeJsAttr(s.title || '')}')" class="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg text-[11px] font-semibold">삭제</button>
            </td>
          </tr>
        `;
      }).join('');
}

function openScheduleModal(remoteId = '') {
  if (typeof document === 'undefined') return;
  const modal = document.getElementById('schedule-modal');
  if (!modal) return;
  const rawList = (adminState && adminState.overview && Array.isArray(adminState.overview.schedules))
    ? adminState.overview.schedules
    : [];
  const list = rawList.filter((s) => s && typeof s === 'object');
  const target = remoteId ? list.find((s) => String(s.remote_id || s.id || '') === String(remoteId)) : null;
  const titleEl = document.getElementById('schedule-modal-title');
  const ridEl = document.getElementById('sc-remote-id');
  const scTitleEl = document.getElementById('sc-title');
  const startEl = document.getElementById('sc-start-date');
  const endEl = document.getElementById('sc-end-date');
  const catEl = document.getElementById('sc-category');
  const privEl = document.getElementById('sc-is-private');
  const memoEl = document.getElementById('sc-memo');
  if (titleEl) titleEl.textContent = target ? '학사일정 수정' : '학사일정 추가';
  if (ridEl) ridEl.value = target ? String(target.remote_id || target.id || '') : '';
  if (scTitleEl) scTitleEl.value = target ? String(target.title || '') : '';
  if (startEl) startEl.value = target ? String(target.start_date || target.date || '') : getLocalTodayStr();
  if (endEl) endEl.value = target ? String(target.end_date || target.start_date || target.date || '') : getLocalTodayStr();
  if (catEl) catEl.value = target ? String(target.category || '학사일정') : '학사일정';
  if (privEl) {
    privEl.checked = Boolean(target && (
      target.is_private === true ||
      String(target.is_private || '').trim().toLowerCase() === 'true' ||
      String(target.visibility || '').trim().toLowerCase() === 'private'
    ));
  }
  if (memoEl) memoEl.value = target ? String(target.memo || target.description || '') : '';
  modal.classList.remove('hidden');
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').classList.add('hidden');
}

async function deleteScheduleRow(remoteId, title) {
  if (!confirm(`"${title || remoteId}" 학사일정을 삭제하시겠습니까?`)) return;
  try {
    await callApi('delete_schedule', { remote_id: remoteId }, true);
    await refreshAdminData();
  } catch (err) {
    alert(`학사일정 삭제 실패: ${err.message}`);
  }
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

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initAdminPage);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseLessonMeta,
    canonicalizeClassLabel,
    normalizeLessonRecord,
    buildLessonMatrixModel,
    _naturalClassSort,
    TAB_LIST,
    switchTab,
    renderSchedulesTab,
    adminState,
  };
}
