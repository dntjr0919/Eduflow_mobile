/* =========================================================
   EduFlow Mobile - Teacher Admin Views (5 Tabs)
   [홈·출결], [서류·규정], [가정통신·공지], [PC 원격예약], [1:1 채팅]
   ========================================================= */

function _escTeacherHtml(val) {
  if (typeof escapeHtml === 'function') return escapeHtml(val);
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function switchTeacherBottomTab(tabName) {
  if (typeof state !== 'undefined' && state) state.activeTeacherTab = tabName;
  const studentTabs = ['home', 'attendance', 'letters', 'counseling'];
  const teacherTabs = ['home', 'documents', 'circulars', 'remote', 'chat'];
  studentTabs.forEach(t => {
    const sv = document.getElementById(`tabView-${t}`);
    if (sv) sv.classList.add('hidden');
  });

  teacherTabs.forEach(t => {
    const view = document.getElementById(`teacherTabView-${t}`);
    const btn = document.getElementById(`tTabNav-${t}`);
    const dot = btn ? btn.querySelector('span:last-child') : null;
    if (t === tabName) {
      if (view) {
        view.classList.remove('hidden');
        if (t === 'chat') view.classList.add('flex');
      }
      if (btn) btn.className = "flex flex-col items-center gap-0.5 text-indigo-600 flex-1 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-indigo-600";
    } else {
      if (view) {
        view.classList.add('hidden');
        view.classList.remove('flex');
      }
      if (btn) btn.className = "flex flex-col items-center gap-0.5 text-slate-400 hover:text-slate-600 flex-1 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-transparent";
    }
  });
  if (tabName === 'chat') {
    if (typeof renderTeacherChatRooms === 'function') renderTeacherChatRooms();
    if (typeof renderTeacherChatMessages === 'function') renderTeacherChatMessages();
  }
  if (typeof _setChatTabRealtimeActive === 'function') {
    _setChatTabRealtimeActive(tabName === 'chat');
  }
}

// --- TEACHER TAB 1: Home & Live Attendance + Counseling Toggle ---
async function toggleCounselingAcceptance(isOpen) {
  mockData.isCounselingOpen = isOpen;
  const badge = document.getElementById('teacherCounselStatusBadge');
  if (isOpen) {
    badge.innerText = '접수 ON';
    badge.className = 'text-[10px] px-1.5 py-0.2 rounded font-bold bg-indigo-100 text-indigo-700';
    showToast('학생·학부모 앱에 상담 신청 창구가 열렸습니다.', '✨');
  } else {
    badge.innerText = '접수 OFF';
    badge.className = 'text-[10px] px-1.5 py-0.2 rounded font-bold bg-slate-100 text-slate-600';
    showToast('상담 접수가 비활성화되었습니다.', '🔒');
  }
  if (typeof renderStudentChat === 'function') renderStudentChat();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('set_consultation_status', {
        ..._getTeacherAuthParams(),
        teacher_id: mockData.currentUser.userId || 'teacher01',
        consultation_enabled: isOpen ? 1 : 0
      });
    } catch (err) {
      showToast(`상담 상태 동기화 실패: ${err.message}`, '⚠️');
    }
  }
}

// Helper: Dispatch Web Push in background (best-effort; sheet notification is primary)
async function _dispatchWebPush(payload) {
  try {
    const resp = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok || (json && json.ok === false && !json.skipped)) {
      console.warn('[EduFlow Push Dispatch] 발송 실패/부분 실패:', json || resp.status);
    }
    return json || { ok: resp.ok };
  } catch (err) {
    console.warn('[EduFlow Push Dispatch] 네트워크 오류:', err);
    return { ok: false, error: err && err.message ? err.message : 'Network error' };
  }
}

async function loadPendingRegistrationsBadge() {
  if (!gasApi.isConfigured()) return [];
  try {
    const cu = mockData.currentUser || {};
    const res = await gasApi.get('get_pending_registrations', {
      requester_id: cu.userId || '',
      teacher_id: cu.userId || '',
      grade: cu.grade || '',
      class_no: cu.classNo || '',
      school_code: cu.neisSchoolCode || '',
      school_name: cu.schoolName || ''
    });
    const items = Array.isArray(res.items) ? res.items : [];
    const badge = document.getElementById('teacherPendingRegBadge');
    if (badge) badge.innerText = String(items.length);
    return items;
  } catch (_) {
    return [];
  }
}

async function openPendingRegistrationsModal() {
  const listEl = document.getElementById('pendingRegistrationsList');
  if (listEl) listEl.innerHTML = '<p class="text-xs text-slate-400 text-center py-6">불러오는 중...</p>';
  openModal('pendingRegistrationsModal');
  const items = await loadPendingRegistrationsBadge();
  if (!listEl) return;
  if (items.length === 0) {
    listEl.innerHTML = '<p class="text-xs text-slate-400 text-center py-8">현재 승인 대기 중인 가입 신청이 없습니다.</p>';
    return;
  }
  listEl.innerHTML = items.map((it) => {
    const safeRid = _escTeacherHtml(it.remote_id);
    if (it.role === 'teacher') {
      const codeInfo = [it.neis_office_code, it.neis_school_code].filter(Boolean).join('/');
      return `
        <div class="p-3 rounded-2xl border border-purple-200 bg-purple-50/70 flex items-center justify-between gap-2">
          <div>
            <div class="flex items-center gap-1.5 mb-0.5">
              <span class="px-1.5 py-0.5 rounded bg-purple-600 text-white text-[9px] font-bold">교사 가입 신청</span>
              <p class="text-xs font-bold text-slate-800">${_escTeacherHtml(it.name || '')} <span class="text-slate-500 font-normal">(${_escTeacherHtml(it.teacher_id || it.login_id || it.remote_id)})</span></p>
            </div>
            <p class="text-[10px] text-slate-600">${_escTeacherHtml(it.school_name || '학교 미입력')}${codeInfo ? ` (${_escTeacherHtml(codeInfo)})` : ''} · ${_escTeacherHtml(it.grade || '-')}학년 ${_escTeacherHtml(it.class_no || '-')}반 · ${_escTeacherHtml(it.subject || '과목 미입력')}</p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" onclick="reviewRegistrationItem('teacher', '${safeRid}', 'approve', this)" class="px-2.5 py-1.5 bg-purple-600 text-white rounded-lg text-[10px] font-bold">승인</button>
            <button type="button" onclick="reviewRegistrationItem('teacher', '${safeRid}', 'reject', this)" class="px-2.5 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold">반려</button>
          </div>
        </div>
      `;
    }
    const roleLbl = it.role === 'parent' ? '학부모' : '학생';
    const safeRole = _escTeacherHtml(it.role);
    const subInfo = it.role === 'parent'
      ? `자녀: ${_escTeacherHtml(it.student_name || '')} (${_escTeacherHtml(it.student_id || '')})`
      : `${_escTeacherHtml(it.grade || '')}학년 ${_escTeacherHtml(it.class_no || '')}반 ${_escTeacherHtml(it.student_no || '')}번`;
    return `
      <div class="p-3 rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
        <div>
          <p class="text-xs font-bold text-slate-800">[${roleLbl}] ${_escTeacherHtml(it.name || '')} <span class="text-slate-400 font-normal">(${_escTeacherHtml(it.login_id || it.remote_id)})</span></p>
          <p class="text-[10px] text-slate-500">${_escTeacherHtml(it.school_name || '')} · ${subInfo}</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="reviewRegistrationItem('${safeRole}', '${safeRid}', 'approve', this)" class="px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg text-[10px] font-bold">승인</button>
          <button type="button" onclick="reviewRegistrationItem('${safeRole}', '${safeRid}', 'reject', this)" class="px-2.5 py-1.5 bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold">반려</button>
        </div>
      </div>
    `;
  }).join('');
}

async function reviewRegistrationItem(targetRole, remoteId, decision, btnEl) {
  await withButtonLoading(btnEl, '처리 중...', async () => {
    try {
      const cu = mockData.currentUser || {};
      await gasApi.post('review_registration', {
        requester_id: cu.userId || '',
        teacher_id: cu.userId || '',
        target_role: targetRole,
        remote_id: remoteId,
        decision
      });
      showToast(decision === 'approve' ? '가입 신청을 승인했습니다.' : '가입 신청을 반려했습니다.', decision === 'approve' ? '✅' : 'ℹ️');
      await openPendingRegistrationsModal();
    } catch (err) {
      showToast(`처리 실패: ${err && err.message ? err.message : '오류'}`, '⚠️');
    }
  });
}

function renderTeacherHome() {
  if (typeof loadPendingRegistrationsBadge === 'function') {
    void loadPendingRegistrationsBadge();
  }
  const toggleEl = document.getElementById('counselingToggleSwitch');
  const cBadge = document.getElementById('teacherCounselStatusBadge');
  if (toggleEl) toggleEl.checked = Boolean(mockData.isCounselingOpen);
  if (cBadge) {
    cBadge.innerText = mockData.isCounselingOpen ? '접수 ON' : '접수 OFF';
    cBadge.className = mockData.isCounselingOpen
      ? 'text-[10px] px-1.5 py-0.2 rounded font-bold bg-indigo-100 text-indigo-700'
      : 'text-[10px] px-1.5 py-0.2 rounded font-bold bg-slate-100 text-slate-600';
  }

  const gc = mockData.currentUser.gradeClass || '';
  const attTitle = document.getElementById('teacherAttClassTitle');
  if (attTitle) attTitle.innerText = gc ? `오늘 우리 반 출결 현황 (${gc})` : '오늘 우리 반 출결 현황';

  const totalStudents = mockData.students.length;
  const totalBadge = document.getElementById('teacherTotalStudentsBadge');
  if (totalBadge) totalBadge.innerText = `재적 ${totalStudents}명 기준`;

  const activeAttList = mockData.teacherTodayAttendance.filter(item => (item.type || '').trim() !== '출석');
  const STATUS_PRIORITY = { absent: 3, field: 2, late: 1, present: 0 };
  const studentStatusMap = new Map();
  activeAttList.forEach(item => {
    const sid = String(item.studentId || item.name || item.id || '').trim();
    if (!sid) return;
    const t = (item.type || '').trim();
    let cat = 'absent';
    if (t === '출석') cat = 'present';
    else if (t.includes('체험학습')) cat = 'field';
    else if (t.includes('지각') || t.includes('조퇴') || t.includes('외출')) cat = 'late';
    else cat = 'absent';

    const prev = studentStatusMap.get(sid);
    if (!prev || STATUS_PRIORITY[cat] > STATUS_PRIORITY[prev]) {
      studentStatusMap.set(sid, cat);
    }
  });

  let absentCnt = 0;
  let lateCnt = 0;
  let fieldCnt = 0;
  studentStatusMap.forEach(cat => {
    if (cat === 'absent') absentCnt++;
    else if (cat === 'field') fieldCnt++;
    else if (cat === 'late') lateCnt++;
  });
  const presentCnt = Math.max(0, totalStudents - absentCnt - lateCnt - fieldCnt);
  const elPres = document.getElementById('summaryPresentCount');
  const elAbs = document.getElementById('summaryAbsentCount');
  const elLate = document.getElementById('summaryLateCount');
  const elField = document.getElementById('summaryFieldCount');
  if (elPres) elPres.innerText = `${presentCnt}명`;
  if (elAbs) elAbs.innerText = `${absentCnt}명`;
  if (elLate) elLate.innerText = `${lateCnt}명`;
  if (elField) elField.innerText = `${fieldCnt}명`;

  const list = document.getElementById('teacherLiveAttList');
  const todayStrForUnconf = typeof _getLocalTodayStr === 'function' ? _getLocalTodayStr() : new Date().toISOString().slice(0, 10);
  const unconfirmedAll = Array.isArray(mockData.teacherUnconfirmedAttendance) ? mockData.teacherUnconfirmedAttendance : [];
  const otherDateUnconfirmed = unconfirmedAll.filter(u => !u.confirmed && u.date && u.date !== todayStrForUnconf);
  let unconfBanner = document.getElementById('teacherUnconfirmedAttBanner');
  if (!unconfBanner && list && list.parentNode) {
    unconfBanner = document.createElement('div');
    unconfBanner.id = 'teacherUnconfirmedAttBanner';
    list.parentNode.insertBefore(unconfBanner, list);
  }
  if (unconfBanner) {
    if (otherDateUnconfirmed.length > 0) {
      unconfBanner.className = 'mb-2.5 p-2.5 bg-amber-50 border border-amber-200 rounded-xl space-y-1.5';
      unconfBanner.innerHTML = `
        <div class="flex items-center justify-between text-[11px] font-bold text-amber-800">
          <span>🔔 미확인 학생·학부모 출결 보고 (${otherDateUnconfirmed.length}건)</span>
        </div>
        ${otherDateUnconfirmed.map(u => `
          <div class="flex items-center justify-between gap-2 bg-white px-2.5 py-2 rounded-lg border border-amber-100">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-[10px] font-mono text-slate-400">${u.date}</span>
                <span class="text-xs font-bold text-slate-800">${u.studentId} ${u.name}</span>
                <span class="text-[10px] px-1.5 py-0.2 rounded font-bold bg-amber-100 text-amber-800">${u.periodInfo ? `${u.type}(${u.periodInfo})` : u.type}</span>
              </div>
              <p class="text-[10px] text-slate-500 truncate">${u.reason || '사유 미입력'}</p>
            </div>
            <button type="button" onclick="confirmTeacherAtt('${u.id}', this)" class="text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white px-2 py-1 rounded-lg shrink-0">교사 확인</button>
          </div>
        `).join('')}
      `;
    } else {
      unconfBanner.className = 'hidden';
      unconfBanner.innerHTML = '';
    }
  }
  if (activeAttList.length === 0) {
    list.innerHTML = `<div class="p-4 bg-slate-50 rounded-xl border border-slate-200/70 text-center text-xs text-slate-400">오늘 접수된 출결 변동 내역이 없습니다.</div>`;
  } else {
    list.innerHTML = activeAttList.map(item => {
      const isOuting = (item.type || '').includes('외출');
      const typeLabel = isOuting
        ? item.type
        : (item.periodInfo ? `${item.type}(${item.periodInfo})` : item.type);
      const badgeCls = isOuting
        ? 'bg-teal-100 text-teal-700'
        : 'bg-red-100 text-red-700';
      const subText = item.reason || (isOuting && item.periodInfo ? `교사 출석체크 (${item.periodInfo})` : '사유 미입력');
      return `
      <div class="flex items-center justify-between gap-2 p-2.5 bg-slate-50 rounded-xl border border-slate-200/70">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-xs font-bold text-slate-800">${item.studentId} ${item.name}</span>
            <span class="text-[10px] px-1.5 py-0.2 rounded font-bold ${badgeCls}">${typeLabel}</span>
          </div>
          <p class="text-[10px] text-slate-500 mt-0.5 truncate">${subText}</p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          ${item.confirmed
            ? `<span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-200">확인완료</span>`
            : `<button onclick="confirmTeacherAtt('${item.id}', this)" class="text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white px-2 py-1 rounded-lg shadow-xs">교사 확인</button>`
          }
          <button type="button" onclick="editTeacherAtt('${item.id}')" title="출결 수정" class="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" aria-label="출결 수정">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
          </button>
          <button type="button" onclick="deleteTeacherAtt('${item.id}', this)" title="출결 삭제" class="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" aria-label="출결 삭제">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>
      </div>
    `;
    }).join('');
  }

  const dayChar = typeof _getKoreanTodayDayChar === 'function' ? _getKoreanTodayDayChar() : '';
  const targetDate = typeof _getLocalTodayStr === 'function' ? _getLocalTodayStr() : '';
  const cu = mockData.currentUser || {};
  const tName = cu.teacherName || '담임';

  if (
    typeof mergeTimetableForDay === 'function' &&
    ((Array.isArray(mockData.rawTimetableSnapshots) && mockData.rawTimetableSnapshots.length > 0) ||
      (Array.isArray(mockData.rawTimetableBase) && mockData.rawTimetableBase.length > 0) ||
      (Array.isArray(mockData.rawTimetableChanges) && mockData.rawTimetableChanges.length > 0))
  ) {
    mockData.teacherSchedule = mergeTimetableForDay(
      mockData.rawTimetableBase || [],
      mockData.rawTimetableChanges || [],
      {
        mode: 'teacher',
        teacherName: cu.teacherName || '',
        dayChar,
        targetDate,
        snapshots: mockData.rawTimetableSnapshots || []
      }
    );
    if (cu.grade && cu.classNo) {
      mockData.homeroomSchedule = mergeTimetableForDay(
        mockData.rawTimetableBase || [],
        mockData.rawTimetableChanges || [],
        {
          mode: 'class',
          grade: cu.grade,
          classNo: cu.classNo,
          dayChar,
          targetDate,
          snapshots: mockData.rawTimetableSnapshots || []
        }
      );
    }
  }

  const schedTitle = document.getElementById('teacherScheduleTitle');
  if (schedTitle) schedTitle.innerText = `${tName} 선생님 오늘 수업 (${dayChar}요일)`;

  const schedChgBadge = document.getElementById('teacherScheduleChangeBadge');
  const changedScheds = mockData.teacherSchedule.filter(s => s.changed);
  if (schedChgBadge) {
    if (changedScheds.length > 0) {
      schedChgBadge.classList.remove('hidden');
      schedChgBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>${changedScheds.map(s => s.period).join(', ')} 변동`;
    } else {
      schedChgBadge.classList.add('hidden');
    }
  }

  const sched = document.getElementById('teacherScheduleList');
  if (mockData.teacherSchedule.length === 0) {
    sched.innerHTML = `<div class="col-span-4 py-4 text-center text-xs text-slate-400">오늘 등록된 수업이 없습니다.</div>`;
  } else {
    sched.innerHTML = mockData.teacherSchedule.map((s, idx) => `
      <button type="button" onclick="openTeacherLessonModal(${idx})" class="p-2 rounded-xl border text-center transition-all hover:border-indigo-400 hover:shadow-xs active:scale-[0.98] cursor-pointer ${s.changed ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200/70'}">
        <div class="flex items-center justify-center gap-1">
          <span class="text-[10px] font-semibold ${s.changed ? 'text-amber-700' : 'text-slate-400'}">${_escTeacherHtml(s.period)}</span>
          ${s.changed ? `<span class="text-[9px] font-bold px-1 py-0.2 rounded bg-amber-500 text-white">변경</span>` : ''}
        </div>
        <p class="text-xs font-bold text-slate-800 mt-0.5">${_escTeacherHtml(s.target || (s.subject ? '-' : '공강'))}</p>
        <p class="text-[10px] ${s.changed ? 'text-amber-800 font-bold' : 'text-slate-500'}">${_escTeacherHtml(s.subject || '수업 없음')}</p>
      </button>
    `).join('');
  }

  // 담임 학급 당일 시간표 렌더링
  const hrTitle = document.getElementById('teacherHomeroomScheduleTitle');
  const hrChgBadge = document.getElementById('teacherHomeroomChangeBadge');
  const hrList = document.getElementById('teacherHomeroomScheduleList');

  if (hrTitle) {
    hrTitle.innerText = (cu.grade && cu.classNo)
      ? `${cu.grade}학년 ${cu.classNo}반 오늘 시간표 (${dayChar}요일)`
      : `담임 학급 오늘 시간표 (${dayChar}요일)`;
  }

  const homeroomRows = Array.isArray(mockData.homeroomSchedule) ? mockData.homeroomSchedule : [];
  const changedHomeroom = homeroomRows.filter(item => item.isChanged);
  if (hrChgBadge) {
    if (changedHomeroom.length > 0) {
      hrChgBadge.classList.remove('hidden');
      hrChgBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>${changedHomeroom.map(item => `${_escTeacherHtml(item.period)}교시`).join(', ')} 변동`;
    } else {
      hrChgBadge.classList.add('hidden');
    }
  }

  if (hrList) {
    if (!cu.grade || !cu.classNo) {
      hrList.innerHTML = `<div class="py-4 text-center text-xs text-slate-400">프로필에서 담임 학년·반을 설정하면 우리 반 시간표가 표시됩니다.</div>`;
    } else if (homeroomRows.length === 0) {
      hrList.innerHTML = `<div class="py-4 text-center text-xs text-slate-400">오늘 등록된 학급 시간표가 없습니다.</div>`;
    } else {
      hrList.innerHTML = homeroomRows.map(item => `
        <div class="flex items-center justify-between px-3 py-2 rounded-xl border ${item.isChanged ? 'bg-amber-50/90 border-amber-300' : 'bg-slate-50 border-slate-200/70'}">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="text-[11px] font-bold px-2 py-0.5 rounded-lg shrink-0 ${item.isChanged ? 'bg-amber-200/80 text-amber-900' : 'bg-white text-slate-600 border border-slate-200/80'}">${_escTeacherHtml(item.period)}교시</span>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-xs font-bold ${item.isChanged ? 'text-amber-950' : 'text-slate-800'}">${_escTeacherHtml(item.subject || '-')}</span>
                ${item.isChanged ? `<span class="text-[9px] font-bold px-1.5 py-0.2 rounded bg-amber-500 text-white">변경</span>` : ''}
              </div>
              ${item.isChanged && item.changedReason ? `<p class="text-[10px] text-amber-700 mt-0.5 truncate">${_escTeacherHtml(item.changedReason)}</p>` : ''}
            </div>
          </div>
          <span class="text-[11px] font-medium ${item.isChanged ? 'text-amber-800' : 'text-slate-500'} shrink-0 ml-2">${item.teacher ? `${_escTeacherHtml(item.teacher)}T` : '-'}</span>
        </div>
      `).join('');
    }
  }

  // 오늘의 급식 렌더링
  const mealList = document.getElementById('teacherMealList');
  if (mealList) {
    const mealEntries = [
      { key: 'lunch', label: '중식 식단', meal: mockData.meals && mockData.meals.lunch },
      { key: 'dinner', label: '석식 식단', meal: mockData.meals && mockData.meals.dinner }
    ].filter(entry => Boolean(entry.meal));

    if (mealEntries.length === 0) {
      mealList.innerHTML = `<div class="bg-slate-50/80 rounded-xl p-4 border border-slate-100 text-center text-xs text-slate-400">등록된 오늘의 급식 정보가 없습니다.</div>`;
    } else {
      mealList.innerHTML = mealEntries.map(({ label, meal }) => `
        <div class="bg-slate-50/80 rounded-xl p-3 border border-slate-100">
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] font-bold text-slate-700">🍽️ ${_escTeacherHtml(label)}</span>
            <span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">${_escTeacherHtml(meal.calories || '-')}</span>
          </div>
          <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 py-1">
            ${(meal.menu || []).map(item => `
              <div class="flex items-center justify-between text-xs py-0.5 border-b border-slate-100/80">
                <span class="font-medium text-slate-800">${_escTeacherHtml(item.name)}</span>
                ${item.allergy ? `<span class="text-[9px] text-slate-400 font-mono">(${_escTeacherHtml(item.allergy)})</span>` : ''}
              </div>
            `).join('')}
          </div>
          <div class="mt-2.5 pt-2 border-t border-slate-200/70 text-[9px] text-slate-400 leading-tight">
            ℹ️ <span class="font-semibold">알레르기 번호 안내:</span> ${_escTeacherHtml(meal.allergyNotice || '나이스(NEIS) 식단 연동됨')}
          </div>
        </div>
      `).join('');
    }
  }

  if (typeof renderAcademicSchedules === 'function') renderAcademicSchedules();
}

async function syncNeisMealsNow(btnEl) {
  if (!gasApi.isConfigured()) {
    showToast('데모 모드에서는 나이스 급식 동기화를 실행할 수 없습니다.', 'ℹ️');
    return;
  }
  await withButtonLoading(btnEl, '동기화 중...', async () => {
    showLoading('나이스(NEIS) 급식 식단표 동기화 중...');
    try {
      const res = await gasApi.post('sync_neis_meals', {
        teacher_id: mockData.currentUser.userId || '',
        office_code: mockData.currentUser.neisOfficeCode || '',
        school_code: mockData.currentUser.neisSchoolCode || ''
      });
      try { localStorage.removeItem('eduflow_daily_static_cache_v1'); } catch (_) {}
      await refreshFromGas(false);
      renderTeacherHome();
      showToast(`나이스 급식 동기화 완료 (${res.count || 0}건 반영)`, '✅');
    } catch (err) {
      showToast(`나이스 급식 동기화 실패: ${err.message}`, '⚠️');
    } finally {
      hideLoading();
    }
  });
}

function openTeacherProfileModal() {
  const cu = mockData.currentUser;
  document.getElementById('tpName').value = cu.teacherName || '';
  document.getElementById('tpSchoolName').value = cu.schoolName || '';
  document.getElementById('tpGrade').value = cu.grade || '';
  document.getElementById('tpClassNo').value = cu.classNo || '';
  document.getElementById('tpSubject').value = cu.subject || '';
  document.getElementById('tpPhone').value = cu.phone || '';
  document.getElementById('tpConsultationHours').value = cu.consultationHours || '';
  document.getElementById('tpNeisOfficeCode').value = cu.neisOfficeCode || '';
  document.getElementById('tpNeisSchoolCode').value = cu.neisSchoolCode || '';
  openModal('teacherProfileModal');
}

async function saveTeacherProfile(e) {
  e.preventDefault();
  const submitBtn = e.submitter || (e.target && e.target.querySelector('button[type="submit"]'));
  const payload = {
    teacher_id: mockData.currentUser.userId || 'teacher01',
    name: document.getElementById('tpName').value.trim(),
    school_name: document.getElementById('tpSchoolName').value.trim(),
    grade: document.getElementById('tpGrade').value.trim(),
    class_no: document.getElementById('tpClassNo').value.trim(),
    subject: document.getElementById('tpSubject').value.trim(),
    phone: document.getElementById('tpPhone').value.trim(),
    consultation_hours: document.getElementById('tpConsultationHours').value.trim(),
    neis_office_code: document.getElementById('tpNeisOfficeCode').value.trim(),
    neis_school_code: document.getElementById('tpNeisSchoolCode').value.trim()
  };

  await withButtonLoading(submitBtn, '저장 중...', async () => {
    if (gasApi.isConfigured()) {
      try {
        await gasApi.post('upsert_teacher_profile', { ..._getTeacherAuthParams(), ...payload });
      } catch (err) {
        showToast(`교사 프로필 저장 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    mockData.currentUser.teacherName = payload.name;
    mockData.currentUser.schoolName = payload.school_name;
    mockData.currentUser.grade = payload.grade;
    mockData.currentUser.classNo = payload.class_no;
    mockData.currentUser.gradeClass = (payload.grade && payload.class_no)
      ? `${payload.grade}학년 ${payload.class_no}반`
      : '';
    mockData.currentUser.subject = payload.subject;
    mockData.currentUser.phone = payload.phone;
    mockData.currentUser.consultationHours = payload.consultation_hours;
    mockData.currentUser.neisOfficeCode = payload.neis_office_code;
    mockData.currentUser.neisSchoolCode = payload.neis_school_code;
    if (typeof mergeTimetableForDay === 'function') {
      mockData.homeroomSchedule = mergeTimetableForDay(
        mockData.rawTimetableBase || [],
        mockData.rawTimetableChanges || [],
        { mode: 'class', grade: payload.grade, classNo: payload.class_no, snapshots: mockData.rawTimetableSnapshots || [] }
      );
      mockData.teacherSchedule = mergeTimetableForDay(
        mockData.rawTimetableBase || [],
        mockData.rawTimetableChanges || [],
        { mode: 'teacher', teacherName: payload.name, snapshots: mockData.rawTimetableSnapshots || [] }
      );
    } else if (typeof buildHomeroomSchedule === 'function') {
      mockData.homeroomSchedule = buildHomeroomSchedule(
        mockData.rawTimetableBase || [],
        mockData.rawTimetableChanges || [],
        payload.grade,
        payload.class_no,
        { snapshots: mockData.rawTimetableSnapshots || [] }
      );
    }

    try { localStorage.removeItem('eduflow_daily_static_cache_v1'); } catch (_) {}
    closeModal('teacherProfileModal');
    applyRoleUI();
    await refreshFromGas(false);
    renderTeacherHome();
    showToast('교사 프로필이 저장되었습니다.', '✅');
  });
}

async function confirmTeacherAtt(id, btnEl) {
  const item = mockData.teacherTodayAttendance.find(x => x.id === id);
  await withButtonLoading(btnEl, '확인 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('confirm_attendance', { remote_id: id });
      } catch (err) {
        showToast(`출결 확인 동기화 실패: ${err.message}`, '⚠️');
        return;
      }
    }
    if (item) item.confirmed = true;
    if (Array.isArray(mockData.teacherUnconfirmedAttendance)) {
      mockData.teacherUnconfirmedAttendance = mockData.teacherUnconfirmedAttendance.filter(x => x.id !== id);
    }
    renderTeacherHome();
    showToast('출결 보고가 확인 처리되었습니다.');
  });
}

async function deleteTeacherAtt(id, btnEl) {
  const item = mockData.teacherTodayAttendance.find(x => x.id === id);
  if (!item) return;
  if (!confirm(`${item.studentId} ${item.name} 학생의 "${item.type}" 출결 내역을 삭제하시겠습니까?`)) return;

  const doDelete = async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('delete_attendance', { ..._getTeacherAuthParams(), remote_id: id, role: 'teacher' });
      } catch (err) {
        showToast(`출결 삭제 실패: ${err.message}`, '⚠️');
        return;
      }
    }
    mockData.teacherTodayAttendance = mockData.teacherTodayAttendance.filter(x => x.id !== id);
    if (Array.isArray(mockData.attendanceHistory)) {
      mockData.attendanceHistory = mockData.attendanceHistory.filter(x => x.id !== id);
    }
    renderTeacherHome();
    showToast('출결 내역이 삭제되었습니다.');
  };

  if (btnEl) {
    await withButtonLoading(btnEl, '...', doDelete);
  } else {
    await doDelete();
  }
}

function onTeacherAttEditSubTypeChange() {
  const catEl = document.getElementById('teacherAttEditCategory');
  const subEl = document.getElementById('teacherAttEditSubType');
  const periodWrap = document.getElementById('teacherAttEditPeriodWrap');
  if (!catEl || !subEl || !periodWrap) return;

  const isPresentOrField = catEl.value === '출석' || catEl.value === '체험학습';
  subEl.disabled = isPresentOrField;
  const needsPeriod = !isPresentOrField && (subEl.value === '지각' || subEl.value === '조퇴' || subEl.value === '외출');
  periodWrap.classList.toggle('hidden', !needsPeriod);
}

function editTeacherAtt(id) {
  const item = mockData.teacherTodayAttendance.find(x => x.id === id);
  if (!item) return;

  const idEl = document.getElementById('teacherAttEditId');
  const labelEl = document.getElementById('teacherAttEditStudentLabel');
  const catEl = document.getElementById('teacherAttEditCategory');
  const subEl = document.getElementById('teacherAttEditSubType');
  const periodEl = document.getElementById('teacherAttEditPeriod');
  const reasonEl = document.getElementById('teacherAttEditReason');
  if (!idEl || !catEl || !subEl || !periodEl || !reasonEl) return;

  idEl.value = item.id;
  if (labelEl) labelEl.innerText = `${item.studentId} ${item.name} · 현재: ${item.type}`;

  const t = String(item.type || '');
  let cat = item.attCategory || '';
  if (!cat) {
    if (t === '출석') cat = '출석';
    else if (t.includes('체험학습')) cat = '체험학습';
    else if (t.includes('인정')) cat = '인정';
    else if (t.includes('기타')) cat = '기타';
    else cat = '질병';
  }
  let sub = item.attSubType || '';
  if (!sub) {
    if (t.includes('지각')) sub = '지각';
    else if (t.includes('조퇴')) sub = '조퇴';
    else if (t.includes('외출')) sub = '외출';
    else sub = '결석';
  }

  catEl.value = cat;
  subEl.value = sub;

  const options = typeof getPeriodOptionsList === 'function' ? getPeriodOptionsList() : ['조회', '1교시', '2교시', '3교시', '4교시', '5교시', '6교시', '7교시'];
  periodEl.innerHTML = `<option value="">교시 선택</option>` + options.map(o => `<option value="${o}">${o}</option>`).join('');
  if (item.periodInfo) {
    if (!options.includes(item.periodInfo)) {
      const opt = document.createElement('option');
      opt.value = item.periodInfo;
      opt.textContent = item.periodInfo;
      periodEl.appendChild(opt);
    }
    periodEl.value = item.periodInfo;
  } else {
    periodEl.value = '';
  }

  reasonEl.value = item.reason || '';
  onTeacherAttEditSubTypeChange();
  openModal('teacherAttEditModal');
}

async function saveTeacherAttEdit(e) {
  e.preventDefault();
  const id = document.getElementById('teacherAttEditId').value;
  const item = mockData.teacherTodayAttendance.find(x => x.id === id);
  if (!item) return;

  const cat = document.getElementById('teacherAttEditCategory').value;
  const sub = document.getElementById('teacherAttEditSubType').value;
  const isPresentOrField = cat === '출석' || cat === '체험학습';
  const needsPeriod = !isPresentOrField && (sub === '지각' || sub === '조퇴' || sub === '외출');
  const periodInfo = needsPeriod ? document.getElementById('teacherAttEditPeriod').value : '';
  if (needsPeriod && !periodInfo) {
    showToast(`${sub} 교시를 선택해 주세요.`, '⚠️');
    return;
  }
  const reason = document.getElementById('teacherAttEditReason').value.trim();
  const combinedType = isPresentOrField ? cat : `${cat}${sub}`;
  const submitBtn = e.submitter || (e.target && e.target.querySelector('button[type="submit"]'));

  await withButtonLoading(submitBtn, '저장 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        const cu = mockData.currentUser || {};
        await gasApi.post('submit_attendance', {
          ..._getTeacherAuthParams(),
          role: 'teacher',
          data: {
            remote_id: item.id,
            date: typeof getLocalTodayStr === 'function' ? getLocalTodayStr() : new Date().toISOString().slice(0, 10),
            student_id: item.studentId,
            student_name: item.name,
            grade: cu.grade || '',
            class_no: cu.classNo || '',
            attendance_type: combinedType,
            att_category: isPresentOrField ? '' : cat,
            att_sub_type: isPresentOrField ? '' : sub,
            period_info: periodInfo,
            reason,
            teacher_confirmed: 1
          }
        });
      } catch (err) {
        showToast(`출결 정정 저장 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    item.type = combinedType;
    item.attCategory = isPresentOrField ? '' : cat;
    item.attSubType = isPresentOrField ? '' : sub;
    item.periodInfo = periodInfo;
    item.reason = reason;
    item.confirmed = true;

    if (Array.isArray(mockData.attendanceHistory)) {
      const hItem = mockData.attendanceHistory.find(x => x.id === item.id);
      if (hItem) {
        hItem.type = combinedType;
        hItem.attCategory = item.attCategory;
        hItem.attSubType = item.attSubType;
        hItem.periodInfo = periodInfo;
        hItem.reason = reason;
        hItem.docStatus = '교사 최종완료';
      }
    }

    closeModal('teacherAttEditModal');
    renderTeacherHome();
    showToast('출결 상태가 정정되었습니다.');
  });
}

// --- TEACHER ATTENDANCE CHECK (FULL-SCREEN) ---
let _attCheckRows = [];

function _formatOutingPeriodInfo(startPeriod, returnPeriod) {
  const start = String(startPeriod || '').trim();
  const end = String(returnPeriod || start).trim();
  if (!start) return '';
  if (!end || start === end) return start;
  return `${start}~${end}`;
}

function _getReturnPeriodOptions(periodOptions, startPeriod) {
  const list = Array.isArray(periodOptions) ? periodOptions : [];
  const start = String(startPeriod || '').trim();
  if (!start) return [];
  const idx = list.indexOf(start);
  return idx >= 0 ? list.slice(idx) : [];
}

function _parseOutingPeriodInfo(periodInfo, periodOptions) {
  const list = Array.isArray(periodOptions) ? periodOptions : [];
  const raw = String(periodInfo || '').trim();
  if (!raw) return { period: '', returnPeriod: '' };
  if (raw.includes('~')) {
    const parts = raw.split('~').map(s => s.trim());
    let rawStart = parts[0] || '';
    const rawEnd = parts[1] || '';
    if (/^\d+$/.test(rawStart) && rawEnd.endsWith('교시')) {
      rawStart = `${rawStart}교시`;
    }
    const startOpt = list.find(opt => opt === rawStart) || '';
    let endOpt = list.find(opt => opt === rawEnd) || '';
    if (startOpt) {
      const startIdx = list.indexOf(startOpt);
      const endIdx = list.indexOf(endOpt);
      if (!endOpt || endIdx < startIdx) endOpt = startOpt;
    }
    return { period: startOpt, returnPeriod: endOpt || startOpt };
  }
  const matched = list.find(opt => raw === opt || raw.includes(opt)) || '';
  return { period: matched, returnPeriod: matched };
}

function _deriveAttCheckStatus(row) {
  if (row.checked) {
    if (row.period) {
      return {
        type: '지각',
        subType: '지각',
        label: `지각 (${row.period}까지 결과)`,
        badgeClass: 'bg-amber-100 text-amber-800 border-amber-200'
      };
    }
    return {
      type: '결석',
      subType: '결석',
      label: '결석',
      badgeClass: 'bg-red-100 text-red-700 border-red-200'
    };
  }
  if (row.period) {
    if (row.isOuting) {
      const retP = row.returnPeriod || row.period;
      const outingInfo = _formatOutingPeriodInfo(row.period, retP);
      return {
        type: '외출',
        subType: '외출',
        periodInfo: outingInfo,
        label: `외출 (${outingInfo})`,
        badgeClass: 'bg-teal-100 text-teal-700 border-teal-200'
      };
    }
    return {
      type: '조퇴',
      subType: '조퇴',
      label: `조퇴 (${row.period}부터 결과)`,
      badgeClass: 'bg-purple-100 text-purple-700 border-purple-200'
    };
  }
  return {
    type: '출석',
    subType: '출석',
    label: '출석',
    badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200'
  };
}

function openTeacherAttendanceCheck() {
  const view = document.getElementById('teacherAttendanceCheckView');
  if (!view) return;
  stopAttFaceCameraPanel();

  const cu = mockData.currentUser;
  const todayStr = getLocalTodayStr();
  const classLabel = cu.gradeClass ? `${cu.gradeClass} 출석체크` : '오늘 우리 반 출석체크';
  const titleEl = document.getElementById('attCheckClassLabel');
  const dateEl = document.getElementById('attCheckDateLabel');
  if (titleEl) titleEl.innerText = classLabel;
  if (dateEl) dateEl.innerText = `${todayStr} (${formatKoreanDateWithDay(todayStr)})`;

  const cuGrade = String(cu.grade || '').trim();
  const cuClass = String(cu.classNo || '').trim();
  const classStudents = (mockData.students || [])
    .filter(s => {
      if (!cuGrade || !cuClass) return true;
      return String(s.grade || '').trim() === cuGrade && String(s.class_no || '').trim() === cuClass;
    })
    .slice()
    .sort((a, b) => {
      const noA = parseInt(a.student_no || '999', 10);
      const noB = parseInt(b.student_no || '999', 10);
      if (noA !== noB) return noA - noB;
      return String(a.student_id || '').localeCompare(String(b.student_id || ''));
    });

  const periodOptions = getPeriodOptionsList();
  _attCheckRows = classStudents.map(stu => {
    const sid = String(stu.student_id || '').trim();
    const existing = mockData.teacherTodayAttendance.find(a => String(a.studentId || '').trim() === sid);
    let checked = false;
    let period = '';
    let isOuting = false;
    let returnPeriod = '';

    if (existing) {
      const t = String(existing.type || '');
      const pInfo = String(existing.periodInfo || '').trim();
      const matchedOpt = periodOptions.find(opt => pInfo === opt || pInfo.includes(opt));
      if (t.includes('지각')) {
        checked = true;
        period = matchedOpt || '';
      } else if (t.includes('외출')) {
        checked = false;
        isOuting = true;
        const parsed = _parseOutingPeriodInfo(pInfo, periodOptions);
        period = parsed.period || matchedOpt || '';
        returnPeriod = parsed.returnPeriod || period;
      } else if (t.includes('조퇴')) {
        checked = false;
        period = matchedOpt || '';
      } else if (t !== '출석') {
        checked = true;
        period = '';
      }
    }

    return {
      studentId: sid,
      studentNo: stu.student_no || '',
      name: stu.name || '',
      grade: stu.grade || cuGrade,
      classNo: stu.class_no || cuClass,
      checked,
      period,
      isOuting,
      returnPeriod,
      cameraVerified: false,
      cameraMatchPct: 0,
      cameraVerifiedAt: 0,
      existingId: existing ? existing.id : '',
      existingReason: existing ? (existing.reason || '') : '',
      existingType: existing ? (existing.type || '') : ''
    };
  });

  _attFaceState.minMatchPct = _loadFaceMinMatchPct();
  _syncAttFaceMinMatchSelect();
  renderAttCheckStudentList();
  view.classList.remove('hidden');
}

function closeTeacherAttendanceCheck() {
  stopAttFaceCameraPanel();
  const view = document.getElementById('teacherAttendanceCheckView');
  if (view) view.classList.add('hidden');
}

function updateAttCheckSummary() {
  let present = 0;
  let absent = 0;
  let late = 0;
  let early = 0;
  let outing = 0;
  let cameraVerifiedCount = 0;
  _attCheckRows.forEach(row => {
    const st = _deriveAttCheckStatus(row);
    if (st.type === '결석') absent++;
    else if (st.type === '지각') late++;
    else if (st.type === '외출') outing++;
    else if (st.type === '조퇴') early++;
    else present++;
    if (!row.checked && !row.period && row.cameraVerified) cameraVerifiedCount++;
  });
  const elP = document.getElementById('attCheckCntPresent');
  const elA = document.getElementById('attCheckCntAbsent');
  const elL = document.getElementById('attCheckCntLate');
  const elE = document.getElementById('attCheckCntEarly');
  const elO = document.getElementById('attCheckCntOuting');
  const elCam = document.getElementById('attFaceRecognizedSummary');
  const elBadge = document.getElementById('attFaceVerifiedCountBadge');
  if (elP) elP.innerText = `${present}명`;
  if (elA) elA.innerText = `${absent}명`;
  if (elL) elL.innerText = `${late}명`;
  if (elE) elE.innerText = `${early}명`;
  if (elO) elO.innerText = `${outing}명`;
  if (elCam) elCam.innerText = `카메라 확인: ${cameraVerifiedCount}명`;
  if (elBadge) elBadge.innerText = `${cameraVerifiedCount}/${_attCheckRows.length}명 확인`;
  _renderAttFaceVerifiedChips();
}

function renderAttCheckStudentList() {
  const list = document.getElementById('attCheckStudentList');
  if (!list) return;
  updateAttCheckSummary();

  if (_attCheckRows.length === 0) {
    list.innerHTML = `<div class="bg-white rounded-2xl p-6 border border-slate-200/80 text-center text-xs text-slate-400">우리 반 학생 명단이 없습니다.<br/>프로필에서 담임 학년·반 설정을 확인해 주세요.</div>`;
    return;
  }

  const periodOptions = getPeriodOptionsList();
  list.innerHTML = _attCheckRows.map((row, idx) => {
    const st = _deriveAttCheckStatus(row);
    const isCamVerified = !row.checked && !row.period && Boolean(row.cameraVerified);
    const defaultOptLabel = row.checked ? '전체(결석)' : '해당 없음(출석)';
    const promptLabel = row.checked
      ? '어디까지 결과인지'
      : (row.isOuting ? '외출 시작 교시' : '어디서부터 결과인지');
    const cardBorder = row.checked
      ? 'border-red-200 bg-red-50/30'
      : (row.period && row.isOuting
        ? 'border-teal-200 bg-teal-50/30'
        : (row.period
          ? 'border-purple-200 bg-purple-50/30'
          : (isCamVerified ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200/80 bg-white')));

    const outingControlHtml = !row.checked
      ? `<label class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[10px] font-bold cursor-pointer select-none transition-colors ${row.isOuting ? 'bg-teal-600 text-white border-teal-600' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'}">
           <input type="checkbox" ${row.isOuting ? 'checked' : ''} onchange="onAttCheckOutingToggle(${idx}, this.checked)" class="w-3.5 h-3.5 rounded accent-teal-600 cursor-pointer" />
           <span>외출</span>
         </label>`
      : '';

    const badgesHtml = isCamVerified
      ? `<div class="flex items-center gap-1 shrink-0">
           <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 bg-emerald-100 text-emerald-700 border-emerald-200">카메라 확인됨</span>
           <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${st.badgeClass}">${st.label}</span>
           ${outingControlHtml}
         </div>`
      : `<div class="flex items-center gap-1.5 shrink-0">
           <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${st.badgeClass}">${st.label}</span>
           ${outingControlHtml}
         </div>`;

    const showReturnDropdown = !row.checked && Boolean(row.isOuting) && Boolean(row.period);
    const returnOptions = showReturnDropdown ? _getReturnPeriodOptions(periodOptions, row.period) : [];
    const effectiveReturnPeriod = returnOptions.includes(row.returnPeriod)
      ? row.returnPeriod
      : (returnOptions[0] || row.period || '');

    return `
      <div class="rounded-2xl p-3 border shadow-xs transition-colors ${cardBorder}" id="attCheckRow-${idx}">
        <div class="flex items-center justify-between gap-2">
          <label class="flex items-center gap-2.5 cursor-pointer flex-1 min-w-0 py-0.5">
            <input type="checkbox" ${row.checked ? 'checked' : ''} onchange="onAttCheckToggle(${idx}, this.checked)" class="w-5 h-5 rounded-md border-slate-300 text-red-600 focus:ring-red-500 shrink-0 cursor-pointer" />
            <div class="min-w-0">
              <span class="text-xs font-bold text-slate-900 truncate block">${row.studentNo ? _escTeacherHtml(row.studentNo) + '번 ' : ''}${_escTeacherHtml(row.name)}</span>
              <span class="text-[10px] text-slate-400">${_escTeacherHtml(row.studentId)}</span>
            </div>
          </label>
          ${badgesHtml}
        </div>
        <div class="mt-2 pt-2 border-t border-slate-200/60 flex items-center justify-between gap-2">
          <span class="text-[11px] font-semibold text-slate-600 shrink-0">${promptLabel}</span>
          <select onchange="onAttCheckPeriodChange(${idx}, this.value)" class="text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:outline-none text-slate-800 font-medium min-w-[130px]">
            <option value="" ${!row.period ? 'selected' : ''}>${defaultOptLabel}</option>
            ${periodOptions.map(opt => `<option value="${_escTeacherHtml(opt)}" ${row.period === opt ? 'selected' : ''}>${_escTeacherHtml(opt)}</option>`).join('')}
          </select>
        </div>
        ${showReturnDropdown ? `
        <div class="mt-2 pt-2 border-t border-teal-200/60 flex items-center justify-between gap-2">
          <span class="text-[11px] font-semibold text-teal-700 shrink-0">복귀 교시</span>
          <select onchange="onAttCheckReturnPeriodChange(${idx}, this.value)" class="text-xs px-2.5 py-1.5 bg-white border border-teal-200 rounded-xl focus:ring-2 focus:ring-teal-500 focus:outline-none text-slate-800 font-medium min-w-[130px]">
            ${returnOptions.map(opt => `<option value="${_escTeacherHtml(opt)}" ${effectiveReturnPeriod === opt ? 'selected' : ''}>${_escTeacherHtml(opt)}</option>`).join('')}
          </select>
        </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function onAttCheckToggle(idx, isChecked) {
  if (!_attCheckRows[idx]) return;
  _attCheckRows[idx].checked = Boolean(isChecked);
  _attCheckRows[idx].period = '';
  _attCheckRows[idx].isOuting = false;
  _attCheckRows[idx].returnPeriod = '';
  if (_attCheckRows[idx].checked) {
    _attCheckRows[idx].cameraVerified = false;
    _attCheckRows[idx].cameraVerifiedAt = 0;
  }
  renderAttCheckStudentList();
}

function onAttCheckPeriodChange(idx, periodVal) {
  const row = _attCheckRows[idx];
  if (!row) return;
  row.period = periodVal || '';
  if (!row.period) {
    row.isOuting = false;
    row.returnPeriod = '';
  } else if (row.isOuting) {
    const periodOptions = getPeriodOptionsList();
    const startIdx = periodOptions.indexOf(row.period);
    const retIdx = periodOptions.indexOf(row.returnPeriod);
    if (!row.returnPeriod || retIdx < startIdx) {
      row.returnPeriod = row.period;
    }
  }
  if (row.checked || row.period) {
    row.cameraVerified = false;
    row.cameraVerifiedAt = 0;
  }
  renderAttCheckStudentList();
}

function onAttCheckOutingToggle(idx, isOuting) {
  const row = _attCheckRows[idx];
  if (!row || row.checked) return;
  if (isOuting) {
    row.isOuting = true;
    const periodOptions = getPeriodOptionsList();
    if (!row.period) {
      row.period = periodOptions.find(p => p !== '조회') || periodOptions[0] || '';
    }
    const startIdx = periodOptions.indexOf(row.period);
    const retIdx = periodOptions.indexOf(row.returnPeriod);
    if (!row.returnPeriod || retIdx < startIdx) {
      row.returnPeriod = row.period;
    }
    row.cameraVerified = false;
    row.cameraVerifiedAt = 0;
  } else {
    row.isOuting = false;
    row.returnPeriod = '';
  }
  renderAttCheckStudentList();
}

function onAttCheckReturnPeriodChange(idx, returnPeriodVal) {
  const row = _attCheckRows[idx];
  if (!row) return;
  const periodOptions = getPeriodOptionsList();
  const startIdx = periodOptions.indexOf(row.period);
  const retIdx = periodOptions.indexOf(returnPeriodVal);
  row.returnPeriod = (returnPeriodVal && retIdx >= startIdx) ? returnPeriodVal : row.period;
  renderAttCheckStudentList();
}

// --- REAL-TIME CAMERA FACIAL RECOGNITION ATTENDANCE ---
const FACE_API_SCRIPT_URLS = [
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js',
  'https://unpkg.com/@vladmandic/face-api@1.7.15/dist/face-api.js'
];
const FACE_API_MODEL_URLS = [
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model',
  'https://unpkg.com/@vladmandic/face-api@1.7.15/model'
];
const FACE_MIN_MATCH_STORAGE_KEY = 'eduflow_face_min_match_pct_v1';
const DEFAULT_FACE_MIN_MATCH_PCT = 70;

const _attFaceState = {
  isOpen: false,
  isFullscreen: false,
  sessionId: 0,
  modelsLoaded: false,
  loadingPromise: null,
  stream: null,
  loopTimer: null,
  facingMode: 'environment',
  minMatchPct: DEFAULT_FACE_MIN_MATCH_PCT,
  matcher: null,
  labeledDescriptors: [],
  studentMap: new Map(),
  enrolledCount: 0,
  resizeHandler: null,
};

function _computeFaceMatchPercent(distance) {
  const d = Number(distance);
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - d) * 100)));
}

function _normalizeFaceMinMatchPct(val) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') {
    return DEFAULT_FACE_MIN_MATCH_PCT;
  }
  const num = Math.round(Number(val));
  if (!Number.isFinite(num) || num < 50 || num > 99) {
    return DEFAULT_FACE_MIN_MATCH_PCT;
  }
  return num;
}

function _computeFaceDistanceThreshold(minMatchPct) {
  const pct = _normalizeFaceMinMatchPct(minMatchPct);
  return Number(((100 - pct) / 100).toFixed(4));
}

function _computeFaceMatcherThreshold(minMatchPct) {
  const pct = _normalizeFaceMinMatchPct(minMatchPct);
  return Math.min(1, Number((((100 - pct) + 0.5) / 100).toFixed(4)));
}

function _loadFaceMinMatchPct() {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_FACE_MIN_MATCH_PCT;
    const saved = localStorage.getItem(FACE_MIN_MATCH_STORAGE_KEY);
    return _normalizeFaceMinMatchPct(saved);
  } catch (_) {
    return DEFAULT_FACE_MIN_MATCH_PCT;
  }
}

function _saveFaceMinMatchPct(pct) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FACE_MIN_MATCH_STORAGE_KEY, String(_normalizeFaceMinMatchPct(pct)));
  } catch (_) {}
}

function _syncAttFaceMinMatchSelect() {
  if (typeof document === 'undefined') return;
  const sel = document.getElementById('attFaceMinMatchSelect');
  if (sel) sel.value = String(_attFaceState.minMatchPct);
}

function evaluateFaceMatchDecision(bestMatch, minMatchPct = _attFaceState.minMatchPct) {
  const thresholdPct = _normalizeFaceMinMatchPct(minMatchPct);
  const matchPct = bestMatch ? _computeFaceMatchPercent(bestMatch.distance) : 0;
  const rawLabel = bestMatch && bestMatch.label ? String(bestMatch.label).trim() : '';
  const hasKnownLabel = Boolean(rawLabel && rawLabel.toLowerCase() !== 'unknown');
  const isMatched = hasKnownLabel && matchPct >= thresholdPct;
  return {
    isMatched,
    studentId: isMatched ? rawLabel : '',
    matchPct,
    minMatchPct: thresholdPct,
    unknownLabel: `미등록 (${matchPct}%)`,
  };
}

function onAttFaceMinMatchChange(val) {
  const pct = _normalizeFaceMinMatchPct(val);
  _attFaceState.minMatchPct = pct;
  _saveFaceMinMatchPct(pct);
  _syncAttFaceMinMatchSelect();
  if (
    Array.isArray(_attFaceState.labeledDescriptors) &&
    _attFaceState.labeledDescriptors.length > 0 &&
    typeof window !== 'undefined' &&
    window.faceapi
  ) {
    _attFaceState.matcher = new window.faceapi.FaceMatcher(
      _attFaceState.labeledDescriptors,
      _computeFaceMatcherThreshold(pct)
    );
  }
  if (typeof showToast === 'function') {
    showToast(`최소 일치율 기준이 ${pct}%로 설정되었습니다.`, '🎯');
  }
  return pct;
}

function _mapVideoBoxToOverlay(box, videoWidth, videoHeight, canvasWidth, canvasHeight) {
  if (!box || !videoWidth || !videoHeight || !canvasWidth || !canvasHeight) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.max(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (canvasWidth - renderedWidth) / 2;
  const offsetY = (canvasHeight - renderedHeight) / 2;
  return {
    x: Number(box.x || 0) * scale + offsetX,
    y: Number(box.y || 0) * scale + offsetY,
    width: Number(box.width || 0) * scale,
    height: Number(box.height || 0) * scale,
  };
}

function applyCameraFaceRecognitionToAttRows(rows, studentId, matchPct = 100, minMatchPct = _attFaceState.minMatchPct) {
  const list = Array.isArray(rows) ? rows : [];
  const sid = String(studentId || '').trim();
  const pct = Math.max(0, Math.min(100, Math.round(Number(matchPct) || 0)));
  const thresholdPct = _normalizeFaceMinMatchPct(minMatchPct);

  if (pct < thresholdPct) {
    return {
      matched: false,
      changed: false,
      rejectedBelowThreshold: true,
      matchPct: pct,
      minMatchPct: thresholdPct,
      row: null,
    };
  }
  if (!sid) {
    return {
      matched: false,
      changed: false,
      rejectedBelowThreshold: false,
      matchPct: pct,
      minMatchPct: thresholdPct,
      row: null,
    };
  }

  const row = list.find((r) => r && String(r.studentId || '').trim() === sid);
  if (!row) {
    return {
      matched: false,
      changed: false,
      rejectedBelowThreshold: false,
      matchPct: pct,
      minMatchPct: thresholdPct,
      row: null,
    };
  }

  const prevPct = Number(row.cameraMatchPct || 0);
  const changed = Boolean(row.checked) || Boolean(row.period) || Boolean(row.isOuting) || !row.cameraVerified;

  row.checked = false;
  row.period = '';
  row.isOuting = false;
  row.returnPeriod = '';
  row.cameraVerified = true;
  row.cameraMatchPct = Math.max(prevPct, pct);
  if (changed || !row.cameraVerifiedAt) {
    row.cameraVerifiedAt = Date.now();
  }

  return {
    matched: true,
    changed,
    rejectedBelowThreshold: false,
    matchPct: pct,
    minMatchPct: thresholdPct,
    row,
  };
}

function _buildRecentCameraVerifiedList(rows, maxItems = 12) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((r) => r && !r.checked && !r.period && Boolean(r.cameraVerified))
    .slice()
    .sort((a, b) => Number(b.cameraVerifiedAt || 0) - Number(a.cameraVerifiedAt || 0))
    .slice(0, maxItems);
}

function _escapeAttFaceHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _renderAttFaceVerifiedChips() {
  if (typeof document === 'undefined') return;
  const chipsEl = document.getElementById('attFaceRecentChips');
  if (!chipsEl) return;

  const recent = _buildRecentCameraVerifiedList(_attCheckRows, 12);
  if (recent.length > 0) {
    if (chipsEl.classList) chipsEl.classList.remove('hidden');
    chipsEl.innerHTML = recent.map((r) => {
      const noPrefix = r.studentNo ? `${_escapeAttFaceHtml(r.studentNo)}번 ` : '';
      const pctText = r.cameraMatchPct ? ` (${_escapeAttFaceHtml(r.cameraMatchPct)}%)` : '';
      return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-emerald-200 text-[11px] font-bold whitespace-nowrap shrink-0">✓ ${noPrefix}${_escapeAttFaceHtml(r.name || r.studentId)}${pctText}</span>`;
    }).join('');
    return;
  }

  if (_attFaceState.isFullscreen) {
    if (chipsEl.classList) chipsEl.classList.remove('hidden');
    chipsEl.innerHTML = `<span class="text-[11px] text-slate-300/80">카메라에 얼굴을 비추면 출석 확인된 학생 이름이 여기에 표시됩니다.</span>`;
  } else {
    if (chipsEl.classList) chipsEl.classList.add('hidden');
    chipsEl.innerHTML = '';
  }
}

function getAttFaceFullscreenClasses(isFullscreen) {
  if (isFullscreen) {
    return {
      panelClass: 'fixed inset-0 z-50 bg-slate-950 flex flex-col',
      topBarClass: 'bg-slate-950/80 backdrop-blur-md border-b border-white/10 px-3 py-2.5 space-y-2 shrink-0 z-10',
      stageClass: 'relative flex-1 min-h-0 w-full bg-black overflow-hidden',
      bottomBarClass: 'absolute inset-x-0 bottom-0 z-10 bg-slate-950/75 backdrop-blur-md border-t border-white/10 px-3 py-2.5 space-y-1.5',
      buttonLabel: '원래 크기로',
    };
  }
  return {
    panelClass: 'bg-slate-900 border-b border-slate-800 px-3 py-2.5 space-y-2 shrink-0',
    topBarClass: 'space-y-2',
    stageClass: 'relative w-full aspect-[4/3] max-h-[240px] bg-black rounded-xl overflow-hidden border border-slate-700/80',
    bottomBarClass: 'space-y-1.5',
    buttonLabel: '⛶ 전체화면',
  };
}

function _isMobileFaceViewport() {
  return typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= 640;
}

function _syncAttFaceOverlayCanvasSize(clearFrame = false) {
  if (typeof document === 'undefined') return;
  const canvas = document.getElementById('attFaceOverlay');
  if (!canvas || typeof canvas.getBoundingClientRect !== 'function') return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
  }
  if (clearFrame && typeof canvas.getContext === 'function') {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function setAttFaceCameraFullscreen(enabled) {
  _attFaceState.isFullscreen = Boolean(enabled);
  const classes = getAttFaceFullscreenClasses(_attFaceState.isFullscreen);

  if (typeof document !== 'undefined') {
    const panelEl = document.getElementById('attFaceCameraPanel');
    const topBarEl = document.getElementById('attFaceTopBar');
    const stageEl = document.getElementById('attFaceStage');
    const bottomBarEl = document.getElementById('attFaceBottomBar');
    const fsBtnEl = document.getElementById('attFaceFullscreenBtn');

    if (panelEl) {
      panelEl.className = _attFaceState.isOpen ? classes.panelClass : `${classes.panelClass} hidden`;
    }
    if (topBarEl) topBarEl.className = classes.topBarClass;
    if (stageEl) stageEl.className = classes.stageClass;
    if (bottomBarEl) bottomBarEl.className = classes.bottomBarClass;
    if (fsBtnEl) {
      fsBtnEl.innerText = classes.buttonLabel;
      fsBtnEl.textContent = classes.buttonLabel;
      if (typeof fsBtnEl.setAttribute === 'function') {
        fsBtnEl.setAttribute('aria-pressed', _attFaceState.isFullscreen ? 'true' : 'false');
      }
    }
    _renderAttFaceVerifiedChips();
    _syncAttFaceOverlayCanvasSize(true);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => _syncAttFaceOverlayCanvasSize(true));
    }
  }

  return _attFaceState.isFullscreen;
}

function toggleAttFaceCameraFullscreen() {
  return setAttFaceCameraFullscreen(!_attFaceState.isFullscreen);
}

function _getAttFaceState() {
  return {
    isOpen: _attFaceState.isOpen,
    isFullscreen: _attFaceState.isFullscreen,
    minMatchPct: _attFaceState.minMatchPct,
    enrolledCount: _attFaceState.enrolledCount,
    facingMode: _attFaceState.facingMode,
  };
}

function _setAttFaceStatus(text, tone = 'emerald') {
  if (typeof document === 'undefined') return;
  const statusEl = document.getElementById('attFaceStatusText');
  const dotEl = document.getElementById('attFaceCamDot');
  if (statusEl) statusEl.innerText = text || '';
  if (dotEl) {
    let cls = 'w-2 h-2 rounded-full shrink-0 bg-emerald-400 animate-pulse';
    if (tone === 'amber') cls = 'w-2 h-2 rounded-full shrink-0 bg-amber-400';
    else if (tone === 'rose') cls = 'w-2 h-2 rounded-full shrink-0 bg-rose-500';
    dotEl.className = cls;
  }
}

function _setAttFaceLoading(visible, text = '') {
  if (typeof document === 'undefined') return;
  const overlay = document.getElementById('attFaceLoadingOverlay');
  const textEl = document.getElementById('attFaceLoadingText');
  if (textEl && text) textEl.innerText = text;
  if (overlay && overlay.classList) overlay.classList.toggle('hidden', !visible);
}

function _loadExternalScriptOnce(urls) {
  if (typeof window !== 'undefined' && window.faceapi) {
    return Promise.resolve(window.faceapi);
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('브라우저 환경에서만 실행할 수 있습니다.'));
  }
  const candidates = Array.isArray(urls) ? urls : [urls];
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (typeof window !== 'undefined' && window.faceapi) {
        resolve(window.faceapi);
        return;
      }
      if (idx >= candidates.length) {
        reject(new Error('face-api.js 스크립트를 불러오지 못했습니다.'));
        return;
      }
      const url = candidates[idx++];
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => {
        if (window.faceapi) resolve(window.faceapi);
        else {
          script.remove();
          tryNext();
        }
      };
      script.onerror = () => {
        script.remove();
        tryNext();
      };
      document.head.appendChild(script);
    };
    tryNext();
  });
}

async function _ensureFaceApiLoaded() {
  if (_attFaceState.modelsLoaded && typeof window !== 'undefined' && window.faceapi) {
    return window.faceapi;
  }
  if (_attFaceState.loadingPromise) {
    return _attFaceState.loadingPromise;
  }
  _attFaceState.loadingPromise = (async () => {
    try {
      const faceapi = await _loadExternalScriptOnce(FACE_API_SCRIPT_URLS);
      let loaded = false;
      let lastErr = null;
      for (const modelUrl of FACE_API_MODEL_URLS) {
        try {
          await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl),
            faceapi.nets.ssdMobilenetv1.loadFromUri(modelUrl),
            faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl),
            faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl),
          ]);
          loaded = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!loaded) {
        throw lastErr || new Error('안면 인식 모델 가중치를 불러오지 못했습니다.');
      }
      _attFaceState.modelsLoaded = true;
      return faceapi;
    } catch (err) {
      _attFaceState.loadingPromise = null;
      throw err;
    }
  })();
  return _attFaceState.loadingPromise;
}

function _loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 디코딩하지 못했습니다.'));
    img.src = dataUrl;
  });
}

async function _resolveFaceItemImageDataUrl(item, proxyFetcher) {
  if (!item || typeof item !== 'object') return '';
  const directDataUrl = String(item.photo_data_url || '').trim();
  if (/^data:image\//i.test(directDataUrl)) {
    return directDataUrl;
  }
  if ((item.photo_file_id || item.photo_url) && typeof proxyFetcher === 'function') {
    const photoRes = await proxyFetcher({
      file_id: item.photo_file_id || '',
      photo_url: item.photo_url || '',
      student_id: String(item.student_id || '').trim()
    });
    return (photoRes && photoRes.data_url) ? String(photoRes.data_url) : '';
  }
  return '';
}

async function _prepareClassFaceMatcher(sessionId) {
  if (typeof gasApi === 'undefined' || !gasApi.isConfigured()) {
    throw new Error('서버 연결이 필요합니다.');
  }
  const faceapi = window.faceapi;
  const res = await gasApi.post('get_student_face_data', { ..._getTeacherAuthParams() });
  if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return null;

  const items = Array.isArray(res && res.items) ? res.items : [];
  const studentMap = new Map();
  _attCheckRows.forEach((r) => {
    studentMap.set(String(r.studentId || '').trim(), {
      studentId: String(r.studentId || '').trim(),
      studentNo: r.studentNo || '',
      name: r.name || ''
    });
  });

  const descriptorGroups = new Map();
  const missingItems = [];

  items.forEach((item) => {
    const sid = String(item.student_id || '').trim();
    if (!sid) return;
    const prev = studentMap.get(sid) || {};
    studentMap.set(sid, {
      studentId: sid,
      studentNo: item.student_no !== null && item.student_no !== undefined ? item.student_no : (prev.studentNo || ''),
      name: item.student_name || prev.name || sid
    });

    if (
      Array.isArray(item.face_descriptor) &&
      item.face_descriptor.length === 128 &&
      item.face_descriptor.every((v) => Number.isFinite(Number(v)))
    ) {
      if (!descriptorGroups.has(sid)) descriptorGroups.set(sid, []);
      descriptorGroups.get(sid).push(new Float32Array(item.face_descriptor.map(Number)));
    } else if (item.photo_data_url || item.photo_file_id || item.photo_url) {
      missingItems.push(item);
    }
  });

  const newlyExtracted = [];
  for (let i = 0; i < missingItems.length; i += 1) {
    if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return null;
    const item = missingItems[i];
    const sid = String(item.student_id || '').trim();
    _setAttFaceLoading(true, `얼굴 특징 추출 중 (${i + 1}/${missingItems.length})...`);
    try {
      const dataUrl = await _resolveFaceItemImageDataUrl(item, (proxyParams) =>
        gasApi.post('proxy_drive_photo', {
          ..._getTeacherAuthParams(),
          ...proxyParams
        })
      );
      if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return null;
      if (!dataUrl) continue;

      const img = await _loadImageFromDataUrl(dataUrl);
      let det = await faceapi
        .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!det) {
        det = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.35 }))
          .withFaceLandmarks()
          .withFaceDescriptor();
      }
      if (det && det.descriptor && det.descriptor.length === 128) {
        const vec = Array.from(det.descriptor);
        if (!descriptorGroups.has(sid)) descriptorGroups.set(sid, []);
        descriptorGroups.get(sid).push(new Float32Array(vec));
        newlyExtracted.push({
          remote_id: item.remote_id || '',
          student_id: sid,
          student_name: item.student_name || '',
          student_no: item.student_no,
          photo_file_id: item.photo_file_id || '',
          photo_url: item.photo_url || '',
          face_descriptor: vec,
          descriptor_model: 'vladmandic-face-api-128d'
        });
      }
    } catch (err) {
      console.warn(`[FaceExtract] 학생 ${sid} 임베딩 추출 실패:`, err);
    }
  }

  if (newlyExtracted.length > 0 && sessionId === _attFaceState.sessionId && _attFaceState.isOpen) {
    try {
      await gasApi.post('save_student_face_descriptors_batch', {
        ..._getTeacherAuthParams(),
        rows: newlyExtracted
      });
    } catch (err) {
      console.warn('[FaceExtract] 임베딩 캐시 저장 실패:', err);
      showToast('추출된 얼굴 데이터 캐시 저장에 실패했습니다.', '⚠️');
    }
  }

  const labeledDescriptors = [];
  descriptorGroups.forEach((vecs, sid) => {
    if (vecs.length > 0) {
      labeledDescriptors.push(new faceapi.LabeledFaceDescriptors(sid, vecs));
    }
  });

  _attFaceState.studentMap = studentMap;
  _attFaceState.labeledDescriptors = labeledDescriptors;
  _attFaceState.enrolledCount = labeledDescriptors.length;
  const enrolledEl = document.getElementById('attFaceEnrolledSummary');
  if (enrolledEl) enrolledEl.innerText = `등록 얼굴: ${labeledDescriptors.length}명`;

  if (labeledDescriptors.length === 0) return null;
  return new faceapi.FaceMatcher(labeledDescriptors, _computeFaceMatcherThreshold(_attFaceState.minMatchPct));
}

function _stopCurrentVideoStream() {
  if (_attFaceState.stream) {
    try {
      _attFaceState.stream.getTracks().forEach((track) => track.stop());
    } catch (_) {}
    _attFaceState.stream = null;
  }
  const video = typeof document !== 'undefined' ? document.getElementById('attFaceVideo') : null;
  if (video) {
    try { video.srcObject = null; } catch (_) {}
  }
}

async function _startAttFaceVideoStream(facingMode, sessionId) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('이 브라우저는 카메라 기능을 지원하지 않습니다.');
  }
  _stopCurrentVideoStream();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 640 },
      height: { ideal: 480 }
    },
    audio: false
  });
  if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    return false;
  }
  const video = typeof document !== 'undefined' ? document.getElementById('attFaceVideo') : null;
  if (!video) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    return false;
  }
  _attFaceState.stream = stream;
  video.srcObject = stream;
  await video.play();
  return true;
}

function _drawFaceDetectionBox(ctx, overlayBox, labelText, isMatched) {
  const { x, y, width, height } = overlayBox;
  ctx.save();
  ctx.lineWidth = isMatched ? 2.5 : 2;
  ctx.strokeStyle = isMatched ? '#10b981' : '#f59e0b';
  ctx.strokeRect(x, y, width, height);

  ctx.font = 'bold 12px Pretendard, sans-serif';
  const paddingX = 6;
  const textWidth = ctx.measureText(labelText).width;
  const boxW = textWidth + paddingX * 2;
  const boxH = 20;
  const labelX = Math.max(2, x);
  const labelY = y >= boxH + 4 ? y - boxH - 2 : y + 2;

  ctx.fillStyle = isMatched ? '#10b981' : 'rgba(180, 83, 9, 0.9)';
  ctx.fillRect(labelX, labelY, boxW, boxH);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, labelX + paddingX, labelY + boxH / 2);
  ctx.restore();
}

function _scheduleAttFaceDetectionLoop(sessionId) {
  if (_attFaceState.loopTimer) {
    clearTimeout(_attFaceState.loopTimer);
    _attFaceState.loopTimer = null;
  }

  const runTick = async () => {
    if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return;
    const video = typeof document !== 'undefined' ? document.getElementById('attFaceVideo') : null;
    const canvas = document.getElementById('attFaceOverlay');
    const faceapi = typeof window !== 'undefined' ? window.faceapi : null;

    try {
      if (
        video &&
        canvas &&
        faceapi &&
        _attFaceState.matcher &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
          const targetW = Math.round(rect.width * dpr);
          const targetH = Math.round(rect.height * dpr);
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          const ctx = canvas.getContext('2d');
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, rect.width, rect.height);

          const detections = await faceapi
            .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
            .withFaceLandmarks()
            .withFaceDescriptors();

          if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return;

          let anyRowChanged = false;
          detections.forEach((det) => {
            const box = det.detection && det.detection.box;
            if (!box) return;
            const overlayBox = _mapVideoBoxToOverlay(box, video.videoWidth, video.videoHeight, rect.width, rect.height);
            const best = _attFaceState.matcher.findBestMatch(det.descriptor);
            const decision = evaluateFaceMatchDecision(best, _attFaceState.minMatchPct);

            if (decision.isMatched) {
              const sid = decision.studentId;
              const pct = decision.matchPct;
              const meta = _attFaceState.studentMap.get(sid) || {};
              const stuName = meta.name || sid;
              const labelText = `${sid} ${stuName} (${pct}%)`;
              _drawFaceDetectionBox(ctx, overlayBox, labelText, true);

              const updateRes = applyCameraFaceRecognitionToAttRows(_attCheckRows, sid, pct, _attFaceState.minMatchPct);
              if (updateRes.changed) {
                anyRowChanged = true;
                showToast(`${stuName} 출석 확인 (${pct}%)`, '📸');
              }
            } else {
              _drawFaceDetectionBox(ctx, overlayBox, decision.unknownLabel, false);
            }
          });

          if (anyRowChanged) {
            renderAttCheckStudentList();
          }
        }
      }
    } catch (err) {
      console.warn('[FaceLoop] 프레임 감지 오류:', err);
    } finally {
      if (sessionId === _attFaceState.sessionId && _attFaceState.isOpen) {
        _attFaceState.loopTimer = setTimeout(runTick, 280);
      }
    }
  };

  _attFaceState.loopTimer = setTimeout(runTick, 120);
}

function toggleAttFaceCameraPanel() {
  if (_attFaceState.isOpen) {
    stopAttFaceCameraPanel();
  } else {
    startAttFaceCameraPanel();
  }
}

async function startAttFaceCameraPanel() {
  const panel = document.getElementById('attFaceCameraPanel');
  const toggleBtn = document.getElementById('attFaceCamToggleBtn');
  if (!panel) return;

  _attFaceState.isOpen = true;
  _attFaceState.sessionId += 1;
  const sessionId = _attFaceState.sessionId;
  _attFaceState.minMatchPct = _loadFaceMinMatchPct();
  _syncAttFaceMinMatchSelect();
  setAttFaceCameraFullscreen(_isMobileFaceViewport());
  updateAttCheckSummary();

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    if (_attFaceState.resizeHandler && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', _attFaceState.resizeHandler);
      window.removeEventListener('orientationchange', _attFaceState.resizeHandler);
    }
    _attFaceState.resizeHandler = () => _syncAttFaceOverlayCanvasSize(true);
    window.addEventListener('resize', _attFaceState.resizeHandler);
    window.addEventListener('orientationchange', _attFaceState.resizeHandler);
  }

  if (toggleBtn) {
    toggleBtn.innerText = '📷 카메라 끄기';
    toggleBtn.className = 'text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 border border-emerald-600 px-2.5 py-1.5 rounded-xl flex items-center gap-1 transition-colors';
  }
  _setAttFaceStatus('안면 인식 모델 불러오는 중...', 'emerald');
  _setAttFaceLoading(true, '안면 인식 모델을 불러오는 중...');

  try {
    await _ensureFaceApiLoaded();
    if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return;

    _setAttFaceStatus('학생 안면 데이터 동기화 중...', 'emerald');
    _setAttFaceLoading(true, '우리 반 학생 안면 데이터를 불러오는 중...');
    const matcher = await _prepareClassFaceMatcher(sessionId);
    if (sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return;

    _attFaceState.matcher = matcher;
    if (!matcher) {
      _setAttFaceLoading(false);
      _setAttFaceStatus('등록된 학생 얼굴 데이터가 없습니다. 데스크톱에서 사진을 등록해 주세요.', 'amber');
      return;
    }

    _setAttFaceLoading(true, '카메라를 연결하는 중...');
    const started = await _startAttFaceVideoStream(_attFaceState.facingMode, sessionId);
    if (!started || sessionId !== _attFaceState.sessionId || !_attFaceState.isOpen) return;

    _setAttFaceLoading(false);
    _setAttFaceStatus('실시간 안면 인식 중 (카메라에 얼굴을 비춰주세요)', 'emerald');
    _syncAttFaceOverlayCanvasSize(true);
    _scheduleAttFaceDetectionLoop(sessionId);
  } catch (err) {
    if (sessionId !== _attFaceState.sessionId) return;
    _setAttFaceLoading(false);
    const msg = (err && err.message) || '카메라 안면 인식을 시작하지 못했습니다.';
    _setAttFaceStatus(msg, 'rose');
    if (typeof showToast === 'function') showToast(msg, '⚠️');
  }
}

function stopAttFaceCameraPanel() {
  _attFaceState.isOpen = false;
  _attFaceState.sessionId += 1;
  _attFaceState.matcher = null;
  _attFaceState.labeledDescriptors = [];
  if (_attFaceState.loopTimer) {
    clearTimeout(_attFaceState.loopTimer);
    _attFaceState.loopTimer = null;
  }
  if (
    _attFaceState.resizeHandler &&
    typeof window !== 'undefined' &&
    typeof window.removeEventListener === 'function'
  ) {
    window.removeEventListener('resize', _attFaceState.resizeHandler);
    window.removeEventListener('orientationchange', _attFaceState.resizeHandler);
    _attFaceState.resizeHandler = null;
  }
  _stopCurrentVideoStream();
  setAttFaceCameraFullscreen(false);

  if (typeof document !== 'undefined') {
    const canvas = document.getElementById('attFaceOverlay');
    if (canvas) {
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    const panel = document.getElementById('attFaceCameraPanel');
    if (panel && panel.classList) panel.classList.add('hidden');
    _setAttFaceLoading(false);

    const toggleBtn = document.getElementById('attFaceCamToggleBtn');
    if (toggleBtn) {
      toggleBtn.innerText = '📷 카메라 출석';
      toggleBtn.className = 'text-[11px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1.5 rounded-xl flex items-center gap-1 transition-colors';
    }
  }
}

async function switchAttFaceCameraFacing() {
  _attFaceState.facingMode = _attFaceState.facingMode === 'environment' ? 'user' : 'environment';
  if (!_attFaceState.isOpen) return;
  try {
    _setAttFaceLoading(true, '카메라 전환 중...');
    const started = await _startAttFaceVideoStream(_attFaceState.facingMode, _attFaceState.sessionId);
    if (started) {
      _setAttFaceLoading(false);
      _setAttFaceStatus(
        _attFaceState.facingMode === 'user' ? '전면 카메라로 실시간 안면 인식 중' : '후면 카메라로 실시간 안면 인식 중',
        'emerald'
      );
    }
  } catch (err) {
    _setAttFaceLoading(false);
    showToast(`카메라 전환 실패: ${(err && err.message) || '오류'}`, '⚠️');
  }
}

async function saveTeacherAttendanceCheck(btnEl) {
  if (_attCheckRows.length === 0) {
    closeTeacherAttendanceCheck();
    return;
  }

  const todayStr = getLocalTodayStr();
  const cu = mockData.currentUser;
  const teacherName = cu.teacherName || '담임교사';

  const records = _attCheckRows.map(row => {
    const st = _deriveAttCheckStatus(row);
    const periodInfo = st.type === '외출'
      ? (st.periodInfo || _formatOutingPeriodInfo(row.period, row.returnPeriod || row.period))
      : (row.period
        ? (row.checked ? `${row.period}까지 결과` : `${row.period}부터 결과`)
        : '');
    const finalType = (row.existingType && st.type === '결석' && row.existingType.includes('결석'))
      ? row.existingType
      : st.type;
    const defaultReason = periodInfo ? `교사 출석체크 (${periodInfo})` : `교사 출석체크 (${finalType})`;
    const preservedReason = (row.existingReason && !String(row.existingReason).startsWith('교사 출석체크'))
      ? row.existingReason
      : '';
    const reason = st.type === '출석'
      ? ''
      : (preservedReason || defaultReason);

    return {
      remote_id: row.existingId || `ATT_CHK_${todayStr}_${row.studentId}`,
      student_id: row.studentId,
      student_name: row.name,
      student_no: row.studentNo,
      grade: row.grade,
      class_no: row.classNo,
      attendance_type: finalType,
      att_category: '',
      att_sub_type: st.subType,
      period_info: periodInfo,
      reason,
      submitted_by: teacherName,
      memo: periodInfo || finalType
    };
  });

  await withButtonLoading(btnEl, '저장 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('save_class_attendance', {
          ..._getTeacherAuthParams(),
          data: {
            date: todayStr,
            grade: cu.grade || '',
            class_no: cu.classNo || '',
            submitted_by: teacherName,
            records
          }
        });
      } catch (err) {
        showToast(`출석체크 저장 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    const checkedIds = new Set(records.map(r => r.student_id));
    const remainingOthers = mockData.teacherTodayAttendance.filter(a => !checkedIds.has(String(a.studentId || '')));
    const newTodayItems = records
      .filter(r => r.attendance_type !== '출석')
      .map(r => ({
        id: r.remote_id,
        studentId: String(r.student_id),
        name: r.student_name,
        type: r.attendance_type,
        attCategory: r.att_category,
        attSubType: r.att_sub_type,
        periodInfo: r.period_info,
        reason: r.reason,
        confirmed: true
      }));

    mockData.teacherTodayAttendance = [...newTodayItems, ...remainingOthers];
    renderAll();
    closeTeacherAttendanceCheck();
    showToast(`출석체크 저장 완료 (${newTodayItems.length}명 변동 반영)`);
  });
}

// --- TEACHER TAB 2: NEIS Document Inspection & Rules ---
function switchTeacherDocFilter(filter) {
  state.teacherDocFilter = filter;
  ['pending', 'submitted', 'closed'].forEach(f => {
    const btn = document.getElementById(`tDocFilterBtn-${f}`);
    btn.className = f === filter
      ? "flex-1 py-1.5 text-xs font-semibold rounded-lg bg-white text-indigo-600 shadow-xs transition-all"
      : "flex-1 py-1.5 text-xs font-medium rounded-lg text-slate-600 hover:text-slate-900 transition-all";
  });
  renderTeacherDocs();
}

function renderTeacherDocs() {
  const pCount = mockData.urgentDocuments.filter(d => d.status === 'pending').length;
  const sCount = mockData.urgentDocuments.filter(d => d.status === 'submitted').length;
  const cCount = mockData.urgentDocuments.filter(d => d.status === 'closed').length;
  document.getElementById('filterPendingCount').innerText = pCount;
  document.getElementById('filterSubmittedCount').innerText = sCount;
  document.getElementById('filterClosedCount').innerText = cCount;

  const filtered = mockData.urgentDocuments.filter(d => d.status === state.teacherDocFilter);
  const container = document.getElementById('teacherDocsContainer');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-8 text-xs text-slate-400 bg-white rounded-2xl border border-slate-200/70">해당 상태의 서류 내역이 없습니다.</div>`;
    return;
  }

  container.innerHTML = filtered.map(doc => {
    const safeDocId = _escTeacherHtml(doc.id);
    return `
    <div class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold text-slate-800">${_escTeacherHtml(doc.studentId)} ${_escTeacherHtml(doc.studentName)} · ${_escTeacherHtml(doc.docName)}</span>
        <span class="text-[10px] font-semibold text-slate-400">마감 ${_escTeacherHtml(doc.deadline)}</span>
      </div>
      <p class="text-[11px] text-slate-600">${_escTeacherHtml(doc.title)} — ${_escTeacherHtml(doc.description)}</p>
      ${doc.status === 'submitted' ? `
        <div class="flex gap-2 pt-1">
          <button onclick="finalizeTeacherDoc('${safeDocId}', 'closed', this)" class="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-xl">나이스 확인 후 최종종결</button>
          <button onclick="finalizeTeacherDoc('${safeDocId}', 'pending', this)" class="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-[11px] font-bold rounded-xl">미제출 반려(재알림)</button>
        </div>
      ` : doc.status === 'pending' ? `
        <div class="flex items-center justify-between pt-1">
          <span class="text-[10px] text-urgent-600 font-semibold">매일 아침 자동 독촉 알림 발송 중</span>
          <button onclick="sendDocReminderNotification('${safeDocId}', this)" class="text-[10px] px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg">수동 재알림</button>
        </div>
      ` : `<span class="inline-block text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-semibold">${_escTeacherHtml(doc.submittedAt || '최종 종결됨')}</span>`}
    </div>
  `;
  }).join('');
}

async function sendDocReminderNotification(docId, btnEl) {
  const doc = mockData.urgentDocuments.find(d => d.id === docId);
  if (!doc) return;
  const title = `[서류 제출 독촉] ${doc.docName}`;
  const message = `${doc.studentName} 학생의 ${doc.title} 증빙서류를 나이스(NEIS)에 제출 후 앱에서 "제출했습니다" 확인을 눌러주세요. (마감: ${doc.deadline || '기한 내'})`;

  await withButtonLoading(btnEl, '발송 중...', async () => {
    if (gasApi.isConfigured()) {
      try {
        await gasApi.post('send_notification', {
          channel: 'doc_reminder',
          sender: mockData.currentUser.teacherName || '담임교사',
          title,
          message,
          target_role: 'all',
          target_student_id: doc.studentId,
          grade: mockData.currentUser.grade || '',
          class_no: mockData.currentUser.classNo || ''
        });
        await _dispatchWebPush({
          title,
          message,
          target_role: 'all',
          target_student_ids: [doc.studentId]
        });
      } catch (err) {
        showToast(`독촉 알림 전송 실패: ${err.message}`, '⚠️');
        return;
      }
    }
    showToast(`${doc.studentName} 학생에게 즉시 독촉 알림을 보냈습니다.`, '🔔');
  });
}

async function finalizeTeacherDoc(docId, nextStatus, btnEl) {
  const doc = mockData.urgentDocuments.find(d => d.id === docId);
  if (!doc) return;

  await withButtonLoading(btnEl, '처리 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('confirm_document', {
          remote_id: docId,
          student_id: doc.studentId || '',
          status: nextStatus === 'closed' ? '확인완료' : '미제출'
        });
      } catch (err) {
        showToast(`서류 상태 동기화 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    doc.status = nextStatus;
    if (nextStatus === 'closed') {
      doc.submittedAt = '방금 전 최종완료';
      showToast('나이스 서류 확인 후 최종 종결 처리되었습니다.');
    } else {
      doc.submittedAt = null;
      showToast('미제출 반려 처리되어 학생에게 다시 독촉 알림이 활성화됩니다.', '⚠️');
    }
    renderAll();
  });
}

function openRulesModal() {
  document.getElementById('ruleSick').value = mockData.rules.sickDays;
  document.getElementById('ruleFieldPre').value = mockData.rules.fieldPreDays;
  document.getElementById('ruleFieldPost').value = mockData.rules.fieldPostDays;
  const defaultRequiredTypes = ['질병결석', '인정지각', '인정조퇴', '인정결석', '기타지각', '기타조퇴', '기타결석'];
  const reqTypes = Array.isArray(mockData.rules.requiredAttTypes)
    ? mockData.rules.requiredAttTypes
    : defaultRequiredTypes;
  document.querySelectorAll('#rulesModal input[name="reqAttType"]').forEach(cb => {
    cb.checked = reqTypes.includes(cb.value);
  });
  openModal('rulesModal');
}

function closeRulesModal() {
  closeModal('rulesModal');
}

function adjustRuleDays(inputId, delta) {
  const el = document.getElementById(inputId);
  const next = Math.max(1, Math.min(30, parseInt(el.value || '5', 10) + delta));
  el.value = next;
}

async function saveRulesSettings(e) {
  e.preventDefault();
  const submitBtn = e.submitter || (e.target && e.target.querySelector('button[type="submit"]'));
  const nextSickDays = parseInt(document.getElementById('ruleSick').value, 10);
  const nextFieldPreDays = parseInt(document.getElementById('ruleFieldPre').value, 10);
  const nextFieldPostDays = parseInt(document.getElementById('ruleFieldPost').value, 10);
  const requiredTypes = Array.from(
    document.querySelectorAll('#rulesModal input[name="reqAttType"]:checked')
  ).map(cb => cb.value);

  await withButtonLoading(submitBtn, '저장 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('upsert_doc_rule', {
          data: {
            remote_id: 'rule_absence',
            rule_code: 'ABSENCE_REPORT',
            doc_name: '결석계 및 증빙서류',
            category: '출결서류',
            due_business_days: nextSickDays,
            required_types: requiredTypes,
            target_roles: 'student,parent',
            is_active: 1
          }
        });
        await gasApi.post('upsert_doc_rule', {
          data: {
            remote_id: 'rule_fieldtrip',
            rule_code: 'FIELD_TRIP',
            doc_name: '교외체험학습 결과보고서',
            category: '체험학습',
            due_business_days: nextFieldPostDays,
            target_roles: 'student,parent',
            is_active: 1
          }
        });
        await gasApi.post('upsert_doc_rule', {
          data: {
            remote_id: 'rule_fieldtrip_pre',
            rule_code: 'FIELD_TRIP_PRE',
            doc_name: '교외체험학습 사전 신청서',
            category: '체험학습',
            due_business_days: nextFieldPreDays,
            target_roles: 'student,parent',
            is_active: 1
          }
        });
      } catch (err) {
        showToast(`규정 저장 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    mockData.rules.sickDays = nextSickDays;
    mockData.rules.fieldPreDays = nextFieldPreDays;
    mockData.rules.fieldPostDays = nextFieldPostDays;
    mockData.rules.requiredAttTypes = requiredTypes;
    closeRulesModal();
    showToast(`규정 저장 완료 (결석 +${mockData.rules.sickDays}일, 체험학습 -${mockData.rules.fieldPreDays}일/+${mockData.rules.fieldPostDays}일)`, '⚙️');
  });
}

// --- TEACHER TAB 3: Circulars & Notices ---
function renderTeacherCirculars() {
  const pendingSection = document.getElementById('teacherPendingCircularsSection');
  const pendingContainer = document.getElementById('teacherPendingCircularsContainer');
  const pendingCountEl = document.getElementById('teacherPendingCircularCount');
  const container = document.getElementById('teacherCircularsContainer');
  const countEl = document.getElementById('teacherCircularCount');

  const allCirculars = Array.isArray(mockData.circulars) ? mockData.circulars : [];
  const pending = allCirculars.filter(c => c.isPublished === false);
  const published = allCirculars.filter(c => c.isPublished !== false);

  if (pendingSection && pendingContainer) {
    if (pending.length === 0) {
      pendingSection.classList.add('hidden');
      pendingContainer.innerHTML = '';
    } else {
      pendingSection.classList.remove('hidden');
      if (pendingCountEl) pendingCountEl.innerText = `${pending.length}건`;
      pendingContainer.innerHTML = pending.map(c => {
        const fields = typeof _parseNoticeReplySchema === 'function'
          ? _parseNoticeReplySchema(c.replySchemaJson, c.replyFields)
          : [];
        const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (s => String(s ?? ''));
        const attachmentUrl = typeof normalizeCircularAttachmentUrl === 'function'
          ? normalizeCircularAttachmentUrl(c)
          : '';
        return `
          <div onclick="openCandidateNoticeModal('${esc(c.id)}')" class="bg-white p-3.5 rounded-2xl border border-amber-200 hover:border-amber-400 shadow-xs cursor-pointer transition-all space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">게시 대기</span>
                ${attachmentUrl ? `<a href="${esc(attachmentUrl)}" onclick="return (typeof openCircularAttachment === 'function' ? openCircularAttachment(event, this.href) : (event.stopPropagation(), true))" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-indigo-600 hover:underline bg-indigo-50 px-2 py-0.5 rounded-lg">📄 원본 PDF ↗</a>` : ''}
              </div>
              <span class="text-[10px] text-slate-400">${esc(c.deadline || '상시')}</span>
            </div>
            <h4 class="text-xs font-bold text-slate-800">${esc(c.title || '제목 없음')}</h4>
            <div class="flex items-center justify-between text-[10px] text-slate-500">
              <span>입력칸 ${fields.length}개 · ${c.requiresReply ? '자필서명 포함' : '열람용'}</span>
              <span class="font-bold text-indigo-600">미리보기·게시 →</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  if (countEl) countEl.innerText = `총 ${published.length}건 진행중`;
  if (!container) return;
  if (published.length === 0) {
    container.innerHTML = `<div class="bg-white p-5 rounded-2xl border border-slate-200/80 text-center text-xs text-slate-400">등록된 가정통신문이 없습니다.</div>`;
    return;
  }
  container.innerHTML = published.map(c => {
    const pct = c.totalCount > 0 ? Math.round((c.submittedCount / c.totalCount) * 100) : 0;
    const unsubmittedCount = Math.max(0, c.totalCount - c.submittedCount);
    const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (s => String(s ?? ''));
    const attachmentUrl = typeof normalizeCircularAttachmentUrl === 'function'
      ? normalizeCircularAttachmentUrl(c)
      : '';
    return `
      <div class="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs space-y-2.5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">${esc(c.deadline)}</span>
            ${attachmentUrl ? `<a href="${esc(attachmentUrl)}" onclick="return (typeof openCircularAttachment === 'function' ? openCircularAttachment(event, this.href) : (event.stopPropagation(), true))" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-indigo-600 hover:underline bg-indigo-50 px-2 py-0.5 rounded-lg">📄 원본 PDF ↗</a>` : ''}
          </div>
          <span class="text-xs font-bold text-slate-800">${c.submittedCount}/${c.totalCount}명 제출 (${pct}%)</span>
        </div>
        <h4 class="text-xs font-bold text-slate-800">${esc(c.title)}</h4>
        <div class="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
          <div class="bg-indigo-600 h-full rounded-full transition-all" style="width: ${pct}%"></div>
        </div>
        <div class="flex gap-2 pt-1">
          <button onclick="openUnsubmittedModal('${esc(c.id)}')" class="flex-1 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold rounded-xl">미제출자 명단 (${unsubmittedCount}명)</button>
          <button onclick="showToast('제출된 서명 이미지가 원본 PDF 좌표에 합성되어 인쇄 대기열로 전송되었습니다.', '🖨️')" class="flex-1 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold rounded-xl">서명본 PDF 일괄 출력</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderTeacherBoardNotices() {
  const container = document.getElementById('teacherBoardNoticesContainer');
  const countEl = document.getElementById('teacherBoardNoticeCount');
  const list = Array.isArray(mockData.boardNotices) ? mockData.boardNotices : [];
  if (countEl) countEl.innerText = `총 ${list.length}건`;
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = `<div class="bg-white p-5 rounded-2xl border border-slate-200/80 text-center text-xs text-slate-400">게시된 학급 공지가 없습니다.</div>`;
    return;
  }
  const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (s => String(s ?? ''));
  const badgeClsFn = typeof _getBoardSourceBadgeClass === 'function'
    ? _getBoardSourceBadgeClass
    : (() => 'bg-indigo-50 text-indigo-700 border border-indigo-200/80');
  const fmtDateFn = typeof _formatBoardDate === 'function'
    ? _formatBoardDate
    : (d => String(d || '').slice(0, 10));
  const safeUrlFn = typeof _safeHttpUrl === 'function'
    ? _safeHttpUrl
    : (u => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : ''));

  container.innerHTML = list.map((n) => {
    const badgeCls = badgeClsFn(n.sourceType);
    const dateLabel = fmtDateFn(n.publishedAt);
    const safeUrl = safeUrlFn(n.sourceUrl);
    const pinBtnCls = n.isPinned
      ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-300/80'
      : 'bg-slate-100 hover:bg-slate-200 text-slate-700';
    return `
      <div class="bg-white p-3.5 rounded-2xl border ${n.isPinned ? 'border-amber-300/90' : 'border-slate-200/80'} shadow-xs space-y-2">
        <div onclick="typeof openBoardNoticeModal === 'function' && openBoardNoticeModal('${esc(n.id)}')" class="cursor-pointer space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeCls}">${esc(n.sourceType || '담임 공지')}</span>
              ${n.isPinned ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-600">📌 상단 고정</span>' : ''}
            </div>
            <span class="text-[10px] text-slate-400 shrink-0">${esc(dateLabel)}</span>
          </div>
          <h4 class="text-xs font-bold text-slate-800 leading-snug">${esc(n.title || '제목 없음')}</h4>
          ${n.summary ? `<p class="text-[11px] text-slate-600 leading-relaxed">${esc(n.summary)}</p>` : ''}
          ${safeUrl ? `<a href="${esc(safeUrl)}" onclick="event.stopPropagation()" target="_blank" rel="noopener noreferrer" class="inline-block text-[10px] font-bold text-indigo-600 hover:underline">원문 링크 ↗</a>` : ''}
        </div>
        <div class="flex gap-2 pt-1 border-t border-slate-100">
          <button type="button" onclick="toggleBoardNoticePin('${esc(n.id)}', this)" class="flex-1 py-1.5 text-[11px] font-bold rounded-xl transition-all ${pinBtnCls}">${n.isPinned ? '📌 고정 해제' : '📌 상단 고정'}</button>
          <button type="button" onclick="deleteBoardNotice('${esc(n.id)}', this)" class="px-3.5 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 text-[11px] font-bold rounded-xl transition-all">삭제</button>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleBoardNoticePin(noticeId, btnEl) {
  const list = Array.isArray(mockData.boardNotices) ? mockData.boardNotices : [];
  const target = list.find((n) => n.id === noticeId);
  if (!target) return;
  const nextPinned = !target.isPinned;

  await withButtonLoading(btnEl, '처리 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('upsert_board_notice', {
          ..._getTeacherAuthParams(),
          remote_id: noticeId,
          is_pinned: nextPinned
        });
      } catch (err) {
        if (!err.isDemo) {
          showToast(`고정 상태 변경 실패: ${err.message}`, '⚠️');
          return;
        }
      }
    }
    target.isPinned = nextPinned;
    mockData.boardNotices = list.slice().sort((a, b) => {
      const pinDiff = (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
      if (pinDiff !== 0) return pinDiff;
      return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
    });
    renderTeacherBoardNotices();
    if (typeof renderBoardNotices === 'function') renderBoardNotices();
    showToast(nextPinned ? '공지를 상단에 고정했습니다.' : '상단 고정을 해제했습니다.');
  });
}

async function deleteBoardNotice(noticeId, btnEl) {
  const list = Array.isArray(mockData.boardNotices) ? mockData.boardNotices : [];
  const target = list.find((n) => n.id === noticeId);
  if (!target) return;
  if (typeof confirm === 'function' && !confirm(`"${target.title || '이 공지'}"를 삭제하시겠습니까?`)) {
    return;
  }

  await withButtonLoading(btnEl, '삭제 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('delete_board_notice', { ..._getTeacherAuthParams(), remote_id: noticeId });
      } catch (err) {
        if (!err.isDemo) {
          showToast(`공지 삭제 실패: ${err.message}`, '⚠️');
          return;
        }
      }
    }
    mockData.boardNotices = list.filter((n) => n.id !== noticeId);
    renderTeacherBoardNotices();
    if (typeof renderBoardNotices === 'function') renderBoardNotices();
    showToast('학급 공지가 삭제되었습니다.');
  });
}

function openCandidateNoticeModal(circularId) {
  const c = (mockData.circulars || []).find(x => x.id === circularId);
  if (!c) return;
  state.currentCandidateNoticeId = circularId;
  const titleEl = document.getElementById('candidateNoticeTitle');
  const dueDateEl = document.getElementById('candidateNoticeDueDate');
  const contentEl = document.getElementById('candidateNoticeContent');
  const badgeEl = document.getElementById('candidateNoticeReplyBadge');

  if (titleEl) titleEl.value = c.title || '';
  if (dueDateEl) dueDateEl.value = c.dueDate || '';
  if (contentEl) contentEl.value = c.content || '';
  if (badgeEl) badgeEl.innerText = c.requiresReply ? '자필서명 필수' : '회신 불필요';

  const sigMode = c.signatureMode === 'both' ? 'both' : 'single';
  const sigRadio = document.querySelector(`input[name="candidateNoticeSignatureMode"][value="${sigMode}"]`);
  if (sigRadio) sigRadio.checked = true;

  const parsedFields = typeof _parseNoticeReplySchema === 'function'
    ? _parseNoticeReplySchema(c.replySchemaJson, c.replyFields)
    : [];
  state.candidateNoticeFields = parsedFields.map((f, idx) => ({
    name: f.name || `field_${idx}`,
    label: f.label || `항목 ${idx + 1}`,
    type: ['radio', 'checkbox', 'text', 'textarea'].includes(f.type) ? f.type : 'text',
    optionsText: Array.isArray(f.options) ? f.options.map(o => o.label || o.value).filter(Boolean).join(', ') : '',
    required: Boolean(f.required),
    placeholder: f.placeholder || ''
  }));

  renderCandidateNoticeSchemaEditor();
  openModal('candidateNoticeModal');
}

function renderCandidateNoticeSchemaEditor() {
  const previewEl = document.getElementById('candidateNoticeSchemaPreview');
  if (!previewEl) return;
  const fields = Array.isArray(state.candidateNoticeFields) ? state.candidateNoticeFields : [];
  const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (s => String(s ?? ''));

  if (fields.length === 0) {
    previewEl.innerHTML = `<p class="text-[11px] text-slate-400 py-1">등록된 입력칸이 없습니다. [+ 항목 추가]로 추가하거나 항목 없이 기본 동의/서명란으로 게시할 수 있습니다.</p>`;
    return;
  }

  previewEl.innerHTML = fields.map((f, idx) => {
    const showOpts = f.type === 'radio' || f.type === 'checkbox';
    return `
      <div class="bg-white border border-slate-200/90 rounded-xl p-2.5 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] font-bold text-indigo-600">항목 ${idx + 1}</span>
          <div class="flex items-center gap-2">
            <label class="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-600 cursor-pointer">
              <input type="checkbox" class="rounded text-indigo-600 focus:ring-indigo-500" ${f.required ? 'checked' : ''} onchange="updateCandidateNoticeField(${idx}, 'required', this.checked)"/>
              <span>필수</span>
            </label>
            <button type="button" onclick="removeCandidateNoticeSchemaField(${idx})" class="text-[10px] font-semibold text-rose-500 hover:text-rose-700 px-1.5 py-0.5 rounded bg-rose-50">삭제</button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          <input type="text" value="${esc(f.label)}" oninput="updateCandidateNoticeField(${idx}, 'label', this.value)" placeholder="항목명" class="col-span-2 text-[11px] px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"/>
          <select onchange="updateCandidateNoticeField(${idx}, 'type', this.value)" class="text-[11px] px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none">
            <option value="radio" ${f.type === 'radio' ? 'selected' : ''}>단일선택</option>
            <option value="checkbox" ${f.type === 'checkbox' ? 'selected' : ''}>복수선택</option>
            <option value="text" ${f.type === 'text' ? 'selected' : ''}>단답형</option>
            <option value="textarea" ${f.type === 'textarea' ? 'selected' : ''}>서술형</option>
          </select>
        </div>
        ${showOpts ? `
          <div>
            <input type="text" value="${esc(f.optionsText)}" oninput="updateCandidateNoticeField(${idx}, 'optionsText', this.value)" placeholder="선택지 (쉼표로 구분, 예: 동의, 미동의)" class="w-full text-[11px] px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"/>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function updateCandidateNoticeField(idx, key, val) {
  if (!Array.isArray(state.candidateNoticeFields) || !state.candidateNoticeFields[idx]) return;
  state.candidateNoticeFields[idx][key] = val;
  if (key === 'type') {
    renderCandidateNoticeSchemaEditor();
  }
}

function addCandidateNoticeSchemaField() {
  if (!Array.isArray(state.candidateNoticeFields)) state.candidateNoticeFields = [];
  const nextNum = state.candidateNoticeFields.length + 1;
  state.candidateNoticeFields.push({
    name: `field_${Date.now()}_${nextNum}`,
    label: `새 항목 ${nextNum}`,
    type: 'text',
    optionsText: '',
    required: false,
    placeholder: ''
  });
  renderCandidateNoticeSchemaEditor();
}

function removeCandidateNoticeSchemaField(idx) {
  if (!Array.isArray(state.candidateNoticeFields)) return;
  state.candidateNoticeFields.splice(idx, 1);
  renderCandidateNoticeSchemaEditor();
}

function _buildCandidateNoticeSchemaPayload() {
  const fields = Array.isArray(state.candidateNoticeFields) ? state.candidateNoticeFields : [];
  return fields.map((f, idx) => {
    const type = ['radio', 'checkbox', 'text', 'textarea'].includes(f.type) ? f.type : 'text';
    const label = String(f.label || '').trim() || `항목 ${idx + 1}`;
    const name = String(f.name || '').trim() || `field_${idx}`;
    const opts = (type === 'radio' || type === 'checkbox')
      ? String(f.optionsText || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => ({ label: s, value: s }))
      : [];
    return {
      name,
      label,
      type,
      options: opts,
      required: Boolean(f.required),
      placeholder: String(f.placeholder || '')
    };
  });
}

function closeCandidateNoticeModal() {
  closeModal('candidateNoticeModal');
}

async function publishCandidateNotice(btnEl) {
  const cId = state.currentCandidateNoticeId;
  const c = (mockData.circulars || []).find(x => x.id === cId);
  if (!c) return;
  const title = (document.getElementById('candidateNoticeTitle')?.value || '').trim();
  const dueDate = (document.getElementById('candidateNoticeDueDate')?.value || '').trim();
  const content = (document.getElementById('candidateNoticeContent')?.value || '').trim();
  if (!title) {
    showToast('가정통신문 제목을 입력해 주세요.', '⚠️');
    return;
  }

  const sigModeEl = document.querySelector('input[name="candidateNoticeSignatureMode"]:checked');
  const signatureMode = sigModeEl && sigModeEl.value === 'both' ? 'both' : 'single';
  const editedFields = _buildCandidateNoticeSchemaPayload();
  const replySchemaJson = JSON.stringify(editedFields);

  await withButtonLoading(btnEl, '게시 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('publish_notice', {
          ..._getTeacherAuthParams(),
          data: {
            remote_id: c.id,
            title,
            due_date: dueDate,
            content,
            category: c.docNum || '가정통신문',
            attachment_url: c.attachmentUrl || '',
            reply_schema_json: replySchemaJson,
            signature_mode: signatureMode,
            requires_reply: c.requiresReply ? 1 : 0,
            target_grade: c.targetGrade || mockData.currentUser.grade || '',
            target_class: c.targetClass || mockData.currentUser.classNo || '',
            school_code: c.schoolCode || mockData.currentUser.neisSchoolCode || '',
            school_name: c.schoolName || mockData.currentUser.schoolName || '',
            author_name: c.authorName || mockData.currentUser.teacherName || '담임교사'
          }
        });
      } catch (err) {
        showToast(`가정통신문 게시 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    c.title = title;
    c.dueDate = dueDate;
    c.deadline = dueDate ? `${dueDate} 마감` : '상시';
    c.content = content;
    c.replySchemaJson = replySchemaJson;
    c.replyFields = editedFields;
    c.signatureMode = signatureMode;
    c.isPublished = true;

    closeCandidateNoticeModal();
    renderTeacherCirculars();
    if (typeof renderCirculars === 'function') renderCirculars();
    showToast('가정통신문이 게시되고 학급 알림이 발송되었습니다.');
  });
}

function openNewCircularModal() {
  const titleEl = document.getElementById('newCircularTitle');
  const contentEl = document.getElementById('newCircularContent');
  const dueDateEl = document.getElementById('newCircularDueDate');
  const reqReplyEl = document.getElementById('newCircularRequiresReply');
  const singleRadio = document.querySelector('input[name="newCircularSignatureMode"][value="single"]');

  if (titleEl) titleEl.value = '';
  if (contentEl) contentEl.value = '';
  if (dueDateEl) dueDateEl.value = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  if (reqReplyEl) reqReplyEl.checked = true;
  if (singleRadio) singleRadio.checked = true;
  toggleNewCircularReplyMode();
  openModal('newCircularModal');
}

function closeNewCircularModal() {
  closeModal('newCircularModal');
}

function toggleNewCircularReplyMode() {
  const reqReplyEl = document.getElementById('newCircularRequiresReply');
  const sigWrap = document.getElementById('newCircularSignatureModeWrap');
  if (reqReplyEl && sigWrap) {
    sigWrap.classList.toggle('hidden', !reqReplyEl.checked);
  }
}

async function publishNewCircular(btnEl) {
  const title = (document.getElementById('newCircularTitle')?.value || '').trim();
  const content = (document.getElementById('newCircularContent')?.value || '').trim();
  const dueDateInput = (document.getElementById('newCircularDueDate')?.value || '').trim();
  const requiresReply = Boolean(document.getElementById('newCircularRequiresReply')?.checked);
  const sigModeEl = document.querySelector('input[name="newCircularSignatureMode"]:checked');
  const signatureMode = (requiresReply && sigModeEl && sigModeEl.value === 'both') ? 'both' : 'single';

  if (!title) {
    showToast('가정통신문 제목을 입력해 주세요.', '⚠️');
    return;
  }
  if (!content) {
    showToast('가정통신문 본문 내용을 입력해 주세요.', '⚠️');
    return;
  }

  const noticeId = 'CIR-' + Date.now();
  const dueDate = dueDateInput || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const runPublish = async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('upsert_notice', {
          ..._getTeacherAuthParams(),
          data: {
            remote_id: noticeId,
            title,
            category: '가정통신문',
            content,
            target_grade: mockData.currentUser.grade || '1',
            target_class: mockData.currentUser.classNo || '3',
            school_code: mockData.currentUser.neisSchoolCode || '',
            school_name: mockData.currentUser.schoolName || '',
            due_date: dueDate,
            requires_reply: requiresReply ? 1 : 0,
            signature_mode: signatureMode,
            author_name: mockData.currentUser.teacherName || '담임교사',
            is_published: 1
          }
        });
      } catch (err) {
        showToast(`가정통신문 배포 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    mockData.circulars.unshift({
      id: noticeId,
      docNum: '가정통신문',
      title,
      dueDate,
      deadline: dueDate ? `${dueDate} 마감` : '상시',
      isPublished: true,
      requiresReply,
      signatureMode,
      replySchemaJson: '',
      status: 'pending',
      submittedCount: 0,
      totalCount: mockData.students.length,
      submittedStudentIds: [],
      content,
      meta: [
        `대상: ${mockData.currentUser.gradeClass || '우리 반'} 전체`,
        requiresReply
          ? (signatureMode === 'both' ? '회신 필요 (학생·학부모 2칸 서명)' : '회신 필요 (전자서명 1칸)')
          : '열람용 안내문'
      ]
    });
    closeNewCircularModal();
    if (typeof renderCirculars === 'function') renderCirculars();
    renderTeacherCirculars();
    showToast('새 가정통신문이 배포되었습니다.');
  };

  if (btnEl) {
    await withButtonLoading(btnEl, '배포 중...', runPublish);
  } else {
    await runPublish();
  }
}

function _getUnsubmittedStudents(circularId) {
  const c = mockData.circulars.find(x => x.id === circularId);
  const submittedSet = new Set((c && Array.isArray(c.submittedStudentIds)) ? c.submittedStudentIds.map(String) : []);
  return (mockData.students || []).filter(s => !submittedSet.has(String(s.student_id || '')));
}

function openUnsubmittedModal(circularId) {
  state.currentUnsubmittedCircularId = circularId;
  const unsubmitted = _getUnsubmittedStudents(circularId);
  const titleEl = document.getElementById('unsubmittedModalTitle');
  const listEl = document.getElementById('unsubmittedModalList');
  const btnEl = document.getElementById('unsubmittedBulkBtn');

  if (titleEl) titleEl.innerHTML = `<span>📋 미제출자 명단 (${unsubmitted.length}명)</span>`;
  if (listEl) {
    if (unsubmitted.length === 0) {
      listEl.innerHTML = `<div class="text-center py-6 text-slate-400">미제출 학생이 없습니다.</div>`;
    } else {
      listEl.innerHTML = unsubmitted.map(s => `
        <div class="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200/80 rounded-xl">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center font-bold text-[10px] text-slate-700">${_escTeacherHtml(s.student_no || '-')}</span>
            <div>
              <p class="font-bold text-slate-800 text-xs">${_escTeacherHtml(s.student_id || '')} ${_escTeacherHtml(s.name || '')}</p>
              <p class="text-[10px] text-slate-400">${_escTeacherHtml(s.phone || '연락처 미등록')}</p>
            </div>
          </div>
          <span class="text-[10px] text-urgent-600 font-semibold">미회신</span>
        </div>
      `).join('');
    }
  }
  if (btnEl) {
    btnEl.disabled = unsubmitted.length === 0;
    btnEl.innerHTML = `<span>📲 미제출 ${unsubmitted.length}명 학부모에게 독촉 알림 일괄 발송</span>`;
  }
  openModal('unsubmittedModal');
}

function closeUnsubmittedModal() {
  closeModal('unsubmittedModal');
}

async function sendBulkPromptToUnsubmitted(btnEl) {
  const cId = state.currentUnsubmittedCircularId;
  const c = mockData.circulars.find(x => x.id === cId);
  const unsubmitted = _getUnsubmittedStudents(cId);
  if (unsubmitted.length === 0) {
    closeUnsubmittedModal();
    return;
  }
  const targetIds = unsubmitted.map(s => String(s.student_id)).filter(Boolean);
  const title = `[가정통신문 회신 요청] ${(c && c.title) || '미제출 안내'}`;
  const message = `아직 전자서명 회신이 완료되지 않았습니다. 앱의 [가정통신·회비] 탭에서 확인 및 서명해 주세요.`;

  await withButtonLoading(btnEl || document.getElementById('unsubmittedBulkBtn'), '일괄 발송 중...', async () => {
    if (gasApi.isConfigured()) {
      try {
        await gasApi.post('send_notification', {
          channel: 'circular_reminder',
          sender: mockData.currentUser.teacherName || '담임교사',
          title,
          message,
          target_role: 'all',
          target_student_ids: targetIds,
          grade: mockData.currentUser.grade || '',
          class_no: mockData.currentUser.classNo || ''
        });
        await _dispatchWebPush({
          title,
          message,
          target_role: 'all',
          target_student_ids: targetIds
        });
      } catch (err) {
        showToast(`독촉 알림 발송 실패: ${err.message}`, '⚠️');
        return;
      }
    }
    closeUnsubmittedModal();
    showToast(`미제출 ${unsubmitted.length}명에게 회신 독촉 알림을 일괄 발송했습니다.`, '📲');
  });
}

function openSendNoticeModal() {
  const select = document.getElementById('sendNoticeTargetStudent');
  if (select) {
    const opts = ['<option value="ALL">우리 반 전체</option>'];
    (mockData.students || []).forEach(s => {
      opts.push(`<option value="${s.student_id}">${s.student_no ? s.student_no + '번 ' : ''}${s.name} (${s.student_id})</option>`);
    });
    select.innerHTML = opts.join('');
  }
  document.getElementById('sendNoticeTitle').value = '';
  document.getElementById('sendNoticeMessage').value = '';
  openModal('sendNoticeModal');
}

async function handleSendNotification(e) {
  e.preventDefault();
  const submitBtn = e.submitter || (e.target && e.target.querySelector('button[type="submit"]'));
  const targetStudentId = document.getElementById('sendNoticeTargetStudent').value || 'ALL';
  const targetRole = document.getElementById('sendNoticeTargetRole').value || 'all';
  const title = document.getElementById('sendNoticeTitle').value.trim();
  const message = document.getElementById('sendNoticeMessage').value.trim();
  if (!title || !message) return;

  await withButtonLoading(submitBtn, '발송 중...', async () => {
    if (gasApi.isConfigured()) {
      try {
        await gasApi.post('send_notification', {
          channel: 'teacher_notice',
          sender: mockData.currentUser.teacherName || '담임교사',
          title,
          message,
          target_role: targetRole,
          target_student_id: targetStudentId,
          grade: mockData.currentUser.grade || '',
          class_no: mockData.currentUser.classNo || ''
        });
        await _dispatchWebPush({
          title,
          message,
          target_role: targetRole,
          target_student_id: targetStudentId
        });
      } catch (err) {
        showToast(`알림 발송 실패: ${err.message}`, '⚠️');
        return;
      }
    }
    closeModal('sendNoticeModal');
    showToast('학급 알림이 발송되었습니다.', '📢');
  });
}

// --- TEACHER TAB 4: PC Remote Task Queue ---
const REMOTE_TASK_LABELS = {
  comcigan_sync: '컴시간 시간표 즉시 동기화',
  schoolbell_sync: '학교종이 최근 공지 수집',
  file_sort: '스마트 파일 자동 분류 실행',
  homeroom_report: '학급 출결·가정통신문 요약 보고서 생성',
};

function isPcAgentOnline(statusObj, nowMs = Date.now()) {
  if (!statusObj || typeof statusObj !== 'object') return false;
  if (statusObj.pc_online !== true && statusObj.pc_online !== 'true' && statusObj.pc_online !== 1) return false;
  const raw = statusObj.pc_last_seen_at;
  if (!raw) return false;
  let seenMs = NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    seenMs = raw;
  } else {
    const s = String(raw).trim();
    let normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)) {
      normalized += '+09:00';
    }
    seenMs = Date.parse(normalized);
  }
  if (!Number.isFinite(seenMs)) return false;
  const diff = nowMs - seenMs;
  return diff >= -60 * 1000 && diff <= 3 * 60 * 1000;
}

function formatPcLastSeenRelative(tsStr, nowMs = Date.now()) {
  if (!tsStr) return '기록 없음';
  const s = String(tsStr).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
  const seenMs = Date.parse(normalized);
  if (!Number.isFinite(seenMs)) return s;
  const diffSec = Math.max(0, Math.floor((nowMs - seenMs) / 1000));
  if (diffSec < 60) return '방금 전';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  return s.slice(0, 16).replace('T', ' ');
}

function renderPcAgentStatusBanner() {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById('pcAgentStatusBanner');
  const dot = document.getElementById('pcAgentStatusDot');
  const titleEl = document.getElementById('pcAgentStatusTitle');
  const subEl = document.getElementById('pcAgentStatusSub');
  const verEl = document.getElementById('pcAgentStatusVersion');
  if (!banner || !titleEl || !subEl) return;

  const statusObj = typeof mockData !== 'undefined' ? mockData.pcAgentStatus : null;
  const online = isPcAgentOnline(statusObj);

  if (online) {
    const host = _escapeAttFaceHtml((statusObj && statusObj.pc_hostname) || '교사 PC');
    const rel = _escapeAttFaceHtml(formatPcLastSeenRelative(statusObj && statusObj.pc_last_seen_at));
    const ver = (statusObj && statusObj.pc_app_version) ? String(statusObj.pc_app_version) : '연결됨';
    banner.className = 'bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-2xl p-4 shadow-lg transition-colors';
    if (dot) dot.className = 'absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full ring-2 ring-slate-900 animate-ping';
    titleEl.innerHTML = `온라인 · 연결됨 <span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-normal">${host} · ${rel}</span>`;
    subEl.innerText = `EduFlow 데스크톱 워커 · 마지막 하트비트: ${formatPcLastSeenRelative(statusObj && statusObj.pc_last_seen_at)}`;
    if (verEl) {
      verEl.innerText = ver;
      verEl.className = 'text-[10px] text-indigo-200 font-mono shrink-0';
    }
  } else {
    banner.className = 'bg-gradient-to-r from-slate-800 to-slate-900 text-white rounded-2xl p-4 shadow-lg transition-colors';
    if (dot) dot.className = 'absolute -top-1 -right-1 w-2.5 h-2.5 bg-slate-400 rounded-full ring-2 ring-slate-900';
    titleEl.innerHTML = `오프라인 <span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-normal">미연결</span>`;
    subEl.innerText = 'PC 앱 미실행 또는 미로그인 — 예약 시 PC 실행 후 자동 처리';
    if (verEl) {
      verEl.innerText = '-';
      verEl.className = 'text-[10px] text-slate-400 font-mono shrink-0';
    }
  }
}

function onRemoteTaskTimingChange() {
  if (typeof document === 'undefined') return;
  const checked = document.querySelector('input[name="taskTiming"]:checked');
  const wrap = document.getElementById('remoteTaskTimeWrap');
  if (wrap) {
    wrap.classList.toggle('hidden', !checked || checked.value !== 'scheduled');
  }
}

function _inferRemoteTaskType(val) {
  if (REMOTE_TASK_LABELS[val]) return val;
  const s = (val || '').toLowerCase();
  if (s.includes('컴시간') || s.includes('시간표')) return 'comcigan_sync';
  if (s.includes('학교종이') || s.includes('공지')) return 'schoolbell_sync';
  if (s.includes('분류') || s.includes('정리')) return 'file_sort';
  if (s.includes('보고서') || s.includes('출결') || s.includes('요약')) return 'homeroom_report';
  return 'comcigan_sync';
}

async function handleCreateRemoteTask(e) {
  e.preventDefault();
  const submitBtn = e.submitter || (e.target && e.target.querySelector('button[type="submit"]'));
  const rawTypeVal = document.getElementById('remoteTaskType').value;
  const taskType = _inferRemoteTaskType(rawTypeVal);
  const typeLabel = REMOTE_TASK_LABELS[taskType] || rawTypeVal;
  const timingVal = document.querySelector('input[name="taskTiming"]:checked')?.value || 'now';
  const timeInputVal = (document.getElementById('remoteTaskTime')?.value || '17:30').trim() || '17:30';
  const prompt = document.getElementById('remoteTaskPrompt').value.trim() || '기본 설정값으로 자동 실행';
  const jobId = 'mob_' + Date.now();
  const todayDate = typeof getLocalTodayStr === 'function' ? getLocalTodayStr() : new Date().toISOString().split('T')[0];
  const nowTime = new Date().toTimeString().slice(0, 5);
  const scheduledStr = timingVal === 'now'
    ? `${todayDate} ${nowTime}`
    : `${todayDate} ${timeInputVal}`;

  const cu = mockData.currentUser || {};
  const authParams = typeof _getTeacherAuthParams === 'function' ? _getTeacherAuthParams() : {};

  await withButtonLoading(submitBtn, '예약 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('enqueue_remote_task', {
          ...authParams,
          teacher_id: authParams.auth_teacher_id || cu.userId || '',
          school_code: cu.schoolCode || '',
          grade: cu.grade || '',
          class_no: cu.classNo || '',
          data: {
            remote_id: jobId,
            teacher_id: authParams.auth_teacher_id || cu.userId || '',
            school_code: cu.schoolCode || '',
            grade: cu.grade || '',
            class_no: cu.classNo || '',
            task_type: taskType,
            title: typeLabel,
            due_date: todayDate,
            priority: timingVal === 'now' ? 'high' : 'normal',
            is_mobile_task: true,
            scheduled_time: scheduledStr,
            target_info: prompt,
            action_payload: JSON.stringify({ prompt, mode: timingVal, scheduled_time: scheduledStr }),
            exec_status: 'pending',
            is_done: false,
            memo: 'EduFlow Mobile에서 예약됨'
          }
        });
      } catch (err) {
        showToast(`원격 작업 큐 등록 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    mockData.remoteTasks.unshift({
      id: jobId,
      taskType,
      type: typeLabel,
      timing: timingVal === 'now' ? '즉시 실행 요청됨' : `예약됨 (오늘 ${timeInputVal})`,
      prompt,
      status: 'pending',
      log: timingVal === 'now' ? 'PC EduFlow 워커 수신 대기 중...' : `예약됨 (${timeInputVal}) · PC 실행 시 자동 처리`
    });
    document.getElementById('remoteTaskPrompt').value = '';
    renderRemoteTasks();
    showToast('PC EduFlow 원격 작업 큐에 등록되었습니다.', '⚡');
  });
}

function renderRemoteTasks() {
  renderPcAgentStatusBanner();
  const container = document.getElementById('remoteTasksContainer');
  const countBadge = document.getElementById('remoteTaskCountBadge');
  if (!container || !countBadge) return;

  countBadge.innerText = `${mockData.remoteTasks.length}건 대기/완료`;
  if (mockData.remoteTasks.length === 0) {
    container.innerHTML = `<div class="bg-white p-5 rounded-2xl border border-slate-200/80 text-center text-xs text-slate-400">등록된 PC 원격 작업이 없습니다.</div>`;
    return;
  }
  container.innerHTML = mockData.remoteTasks.map(job => {
    let badge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-700 shrink-0">대기중</span>`;
    let logClass = 'text-indigo-600 font-medium';
    if (job.status === 'running') {
      badge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-indigo-100 text-indigo-700 animate-pulse shrink-0">PC 실행중</span>`;
    } else if (job.status === 'done') {
      badge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700 shrink-0">완료</span>`;
      logClass = 'text-emerald-700 font-medium';
    } else if (job.status === 'error') {
      badge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-rose-100 text-rose-700 shrink-0">실패</span>`;
      logClass = 'text-rose-600 font-medium';
    }
    return `
      <div class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-800 truncate">${_escapeAttFaceHtml(job.type)}</span>
          ${badge}
        </div>
        <p class="text-[11px] text-slate-600">${_escapeAttFaceHtml(job.prompt)}</p>
        <div class="flex items-center justify-between gap-2 text-[10px] text-slate-400 pt-1 border-t border-slate-100">
          <span class="shrink-0">${_escapeAttFaceHtml(job.timing)}</span>
          <span class="${logClass} text-right truncate">${_escapeAttFaceHtml(job.log)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// --- TEACHER TAB 5: 1:1 Teacher Messenger ---
function renderTeacherChatRooms() {
  const query = (document.getElementById('teacherChatSearch')?.value || '').trim();
  const list = document.getElementById('teacherChatRoomsList');
  const rooms = mockData.chatRooms.filter(r => !query || r.partnerLabel.includes(query));
  const totalUnread = mockData.chatRooms.reduce((acc, r) => acc + r.unread, 0);
  document.getElementById('teacherChatUnreadDot').classList.toggle('hidden', totalUnread === 0);

  list.innerHTML = rooms.length === 0
    ? `<div class="p-8 text-center text-xs text-slate-400">진행 중인 1:1 상담 대화방이 없습니다.</div>`
    : rooms.map(r => {
    const lastMsg = r.messages[r.messages.length - 1];
    return `
      <div onclick="openTeacherChatDetail('${_escTeacherHtml(r.roomId)}')" class="p-3.5 bg-white hover:bg-slate-50 cursor-pointer flex items-center justify-between gap-3 transition-colors">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center text-xs shrink-0">${_escTeacherHtml((r.studentName || '?')[0])}</div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <p class="text-xs font-bold text-slate-800 truncate">${_escTeacherHtml(r.partnerLabel)}</p>
              <span class="text-[10px] text-slate-400">${lastMsg ? _escTeacherHtml(lastMsg.time) : ''}</span>
            </div>
            <p class="text-[11px] text-slate-500 truncate mt-0.5">${lastMsg ? _escTeacherHtml(lastMsg.text) : ''}</p>
          </div>
        </div>
        ${r.unread > 0 ? `<span class="w-5 h-5 rounded-full bg-urgent-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">${_escTeacherHtml(r.unread)}</span>` : ''}
      </div>
    `;
  }).join('');
}

function openTeacherChatDetail(roomId) {
  state.activeTeacherChatRoomId = roomId;
  const room = mockData.chatRooms.find(r => r.roomId === roomId);
  if (!room) return;
  room.unread = 0;
  document.getElementById('activeChatRoomTitle').innerText = room.partnerLabel;
  document.getElementById('activeChatRoomSubtitle').innerText = room.subtitle;
  document.getElementById('teacherChatListView').classList.add('hidden');
  const detail = document.getElementById('teacherChatDetailView');
  detail.classList.remove('hidden');
  detail.classList.add('flex');
  renderTeacherChatMessages();
  renderTeacherChatRooms();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    gasApi.post('mark_chat_read', { ..._getTeacherAuthParams(), room_id: roomId, reader_role: 'teacher' }).catch(() => {});
  }
}

function closeTeacherChatDetail() {
  const detail = document.getElementById('teacherChatDetailView');
  detail.classList.add('hidden');
  detail.classList.remove('flex');
  document.getElementById('teacherChatListView').classList.remove('hidden');
}

function renderTeacherChatMessages() {
  const room = mockData.chatRooms.find(r => r.roomId === state.activeTeacherChatRoomId);
  if (!room) return;
  const container = document.getElementById('teacherLiveChatMessages');
  container.innerHTML = room.messages.map(m => m.sender === 'teacher' ? `
    <div class="flex flex-col items-end">
      <div class="bg-indigo-600 text-white text-xs px-3.5 py-2.5 rounded-2xl rounded-tr-xs max-w-[80%] shadow-xs leading-relaxed">${_escTeacherHtml(m.text)}</div>
      <span class="text-[9px] text-slate-400 mt-1">${_escTeacherHtml(m.time)}</span>
    </div>
  ` : `
    <div class="flex flex-col items-start">
      <span class="text-[10px] font-semibold text-slate-500 mb-1">${_escTeacherHtml(room.partnerLabel)}</span>
      <div class="bg-white text-slate-800 border border-slate-200/80 text-xs px-3.5 py-2.5 rounded-2xl rounded-tl-xs max-w-[80%] shadow-xs leading-relaxed">${_escTeacherHtml(m.text)}</div>
      <span class="text-[9px] text-slate-400 mt-1">${_escTeacherHtml(m.time)}</span>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

function insertTeacherQuickReply(text) {
  const input = document.getElementById('teacherMsgInput');
  input.value = text;
  input.focus();
}

async function sendTeacherMessage() {
  const input = document.getElementById('teacherMsgInput');
  const text = input.value.trim();
  if (!text) return;
  const room = mockData.chatRooms.find(r => r.roomId === state.activeTeacherChatRoomId);
  if (!room) return;
  const now = new Date();
  const timeStr = `오늘 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  room.messages.push({ sender: 'teacher', text, time: timeStr });
  input.value = '';
  renderTeacherChatMessages();
  if (typeof renderStudentChat === 'function') renderStudentChat();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('send_chat_message', {
        ..._getTeacherAuthParams(),
        data: {
          room_id: room.roomId,
          sender_id: mockData.currentUser.userId || 'teacher01',
          sender_name: mockData.currentUser.teacherName || '담임교사',
          sender_role: 'teacher',
          receiver_id: room.studentId || '',
          message: text,
          is_read: 0
        }
      });
    } catch (err) {
      showToast(`메시지 전송 실패: ${err.message}`, '⚠️');
    }
  }
}

async function quickRegisterAttFromChat() {
  const room = mockData.chatRooms.find(r => r.roomId === state.activeTeacherChatRoomId);
  if (!room) return;
  const lastUserMsg = [...room.messages].reverse().find(m => m.sender === 'user');
  const attId = 'TA-' + Date.now();
  const reason = lastUserMsg ? lastUserMsg.text : '1:1 상담방 접수 건';
  mockData.teacherTodayAttendance.unshift({
    id: attId,
    studentId: room.studentId,
    name: room.studentName,
    type: '출결보고(채팅)',
    reason,
    confirmed: true
  });
  renderTeacherHome();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('submit_attendance', {
        ..._getTeacherAuthParams(),
        data: {
          remote_id: attId,
          date: new Date().toISOString().split('T')[0],
          student_id: room.studentId,
          student_name: room.studentName,
          attendance_type: '출결보고(채팅)',
          reason,
          submitted_by: mockData.currentUser.teacherName || '담임교사',
          role: 'teacher',
          teacher_confirmed: 1
        }
      });
    } catch (err) {
      showToast(`출결 등록 실패: ${err.message}`, '⚠️');
      return;
    }
  }
  showToast(`${room.studentName} 학생의 채팅 내용이 출결 시트에 즉시 등록되었습니다.`, '⚡');
}

// =========================================================================
// 교사 시간표 터치 기반 교과 출석부 · 수업 진도 관리 모달
// =========================================================================
const LESSON_ROSTER_MAP_KEY = 'eduflow_lesson_roster_map_v1';
const _lessonModalState = {
  scheduleItem: null,
  dateStr: '',
  periodNum: '',
  subject: '',
  classLabel: '',
  rosterKey: '',
  students: [], // [{ student_id, student_name, status, memo }]
  progressRemoteId: '',
};

function _getTeacherAuthParams() {
  const saved = typeof _loadAutoLoginAuth === 'function' ? _loadAutoLoginAuth() : null;
  const cu = mockData.currentUser || {};
  const token = (typeof state !== 'undefined' && state && state.sessionToken)
    ? String(state.sessionToken).trim()
    : String((saved && saved.token) || '').trim();
  return {
    auth_teacher_id: (saved && saved.userId) || cu.userId || '',
    ...(token ? { auth_token: token } : {}),
  };
}

function _loadLessonRosterMap() {
  try {
    const raw = localStorage.getItem(LESSON_ROSTER_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function _saveLessonRosterMapping(mapKey, rosterKey) {
  try {
    const map = _loadLessonRosterMap();
    map[mapKey] = rosterKey;
    localStorage.setItem(LESSON_ROSTER_MAP_KEY, JSON.stringify(map));
  } catch (_) {}
}

function _normLessonToken(val) {
  return String(val || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[·ㆍ.,()\[\]]/g, '');
}

const SUBJECT_ABBREV_MAP = {
  '통과': ['통합과학'],
  '과탐': ['과학탐구실험'],
  '물리': ['물리학'],
  '화학': ['화학'],
  '생명': ['생명과학'],
  '지구': ['지구과학'],
  '사문': ['사회문화'],
  '생윤': ['생활과윤리'],
  '한지': ['한국지리'],
  '세지': ['세계지리'],
  '동아': ['동아시아사'],
  '확통': ['확률과통계'],
  '미적': ['미적분'],
  '기하': ['기하'],
  '영독': ['영어독해와작문'],
  '화작': ['화법과작문'],
  '언매': ['언어와매체'],
};

function _extractClassTokens(raw) {
  const str = String(raw || '').trim();
  const gradeClassSet = new Set();
  const movingSet = new Set();

  // "1학년 13반", "1학년13반"
  const korMatches = str.matchAll(/(\d+)\s*학년\s*(\d+)\s*반/g);
  for (const m of korMatches) {
    gradeClassSet.add(`${Number(m[1])}-${Number(m[2])}`);
  }
  // "1-13", "1-2"
  const dashMatches = str.matchAll(/(?:^|[^\d])(\d{1,2})\s*-\s*(\d{1,2})(?:[^\d]|$)/g);
  for (const m of dashMatches) {
    gradeClassSet.add(`${Number(m[1])}-${Number(m[2])}`);
  }
  // 이동수업반 토큰 (예: F206, A101 등)
  const movMatches = str.toUpperCase().matchAll(/\b([A-Z]\d{2,4})\b/g);
  for (const m of movMatches) {
    movingSet.add(m[1]);
  }
  return { gradeClassSet, movingSet };
}

function _expandSubjectTokens(raw) {
  const base = _normLessonToken(raw);
  const tokens = new Set();
  if (!base) return tokens;
  tokens.add(base);
  Object.entries(SUBJECT_ABBREV_MAP).forEach(([abbr, fullList]) => {
    if (base.includes(abbr)) {
      fullList.forEach((full) => {
        tokens.add(base.replace(abbr, full));
        tokens.add(full);
      });
    }
    fullList.forEach((full) => {
      if (base.includes(full)) {
        tokens.add(base.replace(full, abbr));
        tokens.add(abbr);
      }
    });
  });
  return tokens;
}

function _findBestSubjectRoster(rosters, subject, classLabel) {
  const list = Array.isArray(rosters) ? rosters : [];
  if (list.length === 0) return null;

  const targetCls = _extractClassTokens(classLabel);
  const targetSubTokens = _expandSubjectTokens(subject);
  const targetDigits = String(subject || '').match(/\d+/)?.[0] || '';

  let bestRoster = null;
  let bestScore = 0;

  for (const r of list) {
    const rText = `${r.subject || ''} ${r.class_label || ''}`.trim();
    const rCls = _extractClassTokens(rText);

    let classScore = 0;
    if (targetCls.gradeClassSet.size > 0 && rCls.gradeClassSet.size > 0) {
      const matched = Array.from(targetCls.gradeClassSet).some((t) => rCls.gradeClassSet.has(t));
      if (!matched) continue; // 학년-반이 명시되어 있는데 다르면 제외
      classScore = 100;
    } else if (targetCls.movingSet.size > 0 && rCls.movingSet.size > 0) {
      const matched = Array.from(targetCls.movingSet).some((t) => rCls.movingSet.has(t));
      if (!matched) continue;
      classScore = 90;
    } else {
      const normTargetCls = _normLessonToken(classLabel);
      const normRCls = _normLessonToken(r.class_label || rText);
      if (normTargetCls && normRCls && (normRCls === normTargetCls || normRCls.includes(normTargetCls))) {
        classScore = 80;
      }
    }

    if (classScore === 0) continue;

    const rSubTokens = _expandSubjectTokens(r.subject || rText);
    const rDigits = String(r.subject || rText).match(/\d+/)?.[0] || '';
    let subScore = 0;
    for (const ts of targetSubTokens) {
      for (const rs of rSubTokens) {
        if (ts === rs) subScore = Math.max(subScore, 60);
        else if (ts.length >= 2 && rs.length >= 2 && (rs.includes(ts) || ts.includes(rs))) {
          subScore = Math.max(subScore, 40);
        }
      }
    }
    if (subScore === 0) continue;
    if (targetDigits && rDigits && targetDigits === rDigits) subScore += 10;

    const total = classScore + subScore;
    if (total > bestScore) {
      bestScore = total;
      bestRoster = r;
    }
  }
  return bestRoster;
}

if (typeof globalThis !== 'undefined') {
  globalThis._eduflowTeacherHelpers = {
    _deriveAttCheckStatus,
    _computeFaceMatchPercent,
    _normalizeFaceMinMatchPct,
    _computeFaceDistanceThreshold,
    _computeFaceMatcherThreshold,
    evaluateFaceMatchDecision,
    _mapVideoBoxToOverlay,
    applyCameraFaceRecognitionToAttRows,
    _buildRecentCameraVerifiedList,
    getAttFaceFullscreenClasses,
    setAttFaceCameraFullscreen,
    toggleAttFaceCameraFullscreen,
    onAttFaceMinMatchChange,
    _getAttFaceState,
    stopAttFaceCameraPanel,
    _resolveFaceItemImageDataUrl,
    isPcAgentOnline,
    formatPcLastSeenRelative,
    REMOTE_TASK_LABELS,
    _extractClassTokens,
    _expandSubjectTokens,
    _findBestSubjectRoster,
    _normalizeLessonAttendanceStatus,
    _getRecentLessonProgressDates,
    _getDefaultLessonImportDate,
    _getLessonProgressByDate,
    saveTeacherLessonAttendance,
    saveTeacherLessonProgress,
    _lessonModalState,
    renderTeacherHome,
    renderTeacherDocs,
    renderTeacherChatRooms,
    renderTeacherChatMessages,
  };
}

function switchTeacherLessonTab(tabKey) {
  const isAtt = tabKey !== 'prog';
  document.getElementById('lessonPanel-att')?.classList.toggle('hidden', !isAtt);
  document.getElementById('lessonPanel-prog')?.classList.toggle('hidden', isAtt);
  const btnAtt = document.getElementById('lessonTabBtn-att');
  const btnProg = document.getElementById('lessonTabBtn-prog');
  if (btnAtt) {
    btnAtt.className = isAtt
      ? 'flex-1 py-2 text-xs font-bold rounded-lg bg-white text-indigo-700 shadow-xs transition'
      : 'flex-1 py-2 text-xs font-semibold rounded-lg text-slate-500 hover:text-slate-800 transition';
  }
  if (btnProg) {
    btnProg.className = !isAtt
      ? 'flex-1 py-2 text-xs font-bold rounded-lg bg-white text-indigo-700 shadow-xs transition'
      : 'flex-1 py-2 text-xs font-semibold rounded-lg text-slate-500 hover:text-slate-800 transition';
  }
}

function _resolveLessonRosterStudents(rosterKey) {
  const rosters = Array.isArray(mockData.subjectRosters) ? mockData.subjectRosters : [];
  if (rosterKey && rosterKey !== '__homeroom__') {
    const found = rosters.find((r) => String(r.roster_key || r.remote_id || '') === rosterKey);
    if (found && Array.isArray(found.students) && found.students.length > 0) {
      return found.students.map((s) => ({
        student_id: String(s.student_id || s.id || '').trim(),
        student_name: String(s.student_name || s.name || s.student_id || '').trim(),
      })).filter((s) => s.student_id);
    }
  }
  // 폴백: 담임 학급 명렬표 (mockData.students)
  return (mockData.students || []).map((s) => ({
    student_id: String(s.student_id || s.remote_id || '').trim(),
    student_name: String(s.name || s.student_name || s.student_id || '').trim(),
  })).filter((s) => s.student_id);
}

function _normalizeLessonAttendanceStatus(rawStatus) {
  const trimmed = String(rawStatus ?? '').trim();
  if (!trimmed || trimmed === '출석') return '출석';
  return '결과';
}

function _renderLessonAttStudentList() {
  const listEl = document.getElementById('lessonAttStudentList');
  if (!listEl) return;
  const students = _lessonModalState.students || [];
  if (students.length === 0) {
    listEl.innerHTML = `<div class="py-8 text-center text-xs text-slate-400">표시할 학생 명렬표가 없습니다. 상단 드롭다운에서 교과 명렬표를 선택해 주세요.</div>`;
    return;
  }
  const statuses = ['출석', '결과'];
  listEl.innerHTML = students.map((st, idx) => {
    const currentStatus = _normalizeLessonAttendanceStatus(st.status);
    const btns = statuses.map((label) => {
      const active = currentStatus === label;
      const activeCls = label === '결과'
        ? 'bg-rose-600 text-white border-rose-600'
        : 'bg-emerald-600 text-white border-emerald-600';
      return `<button type="button" onclick="setLessonStudentStatus(${idx}, '${label}')" class="px-2.5 py-1 rounded-lg text-[10px] font-bold border transition ${active ? activeCls : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}">${label}</button>`;
    }).join('');
    return `
      <div class="p-2.5 bg-slate-50 rounded-xl border border-slate-200/70 space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-bold text-slate-800 truncate">${_escTeacherHtml(st.student_name)} <span class="text-[10px] font-mono text-slate-400 font-normal">${_escTeacherHtml(st.student_id)}</span></div>
          <div class="flex items-center gap-1 shrink-0">${btns}</div>
        </div>
        <input type="text" value="${_escTeacherHtml(st.memo || '')}" oninput="setLessonStudentMemo(${idx}, this.value)" placeholder="비고/메모 (선택)" class="w-full px-2 py-1 text-[11px] bg-white border border-slate-200 rounded-lg text-slate-700">
      </div>
    `;
  }).join('');
}

function setLessonStudentStatus(idx, status) {
  if (_lessonModalState.students[idx]) {
    _lessonModalState.students[idx].status = _normalizeLessonAttendanceStatus(status);
    _renderLessonAttStudentList();
  }
}

function setLessonStudentMemo(idx, memo) {
  if (_lessonModalState.students[idx]) {
    _lessonModalState.students[idx].memo = memo;
  }
}

function _hydrateLessonAttendanceStudents(rosterKey) {
  const baseStudents = _resolveLessonRosterStudents(rosterKey);
  const existing = (mockData.subjectAttendance || []).filter((a) =>
    String(a.date || '').slice(0, 10) === _lessonModalState.dateStr &&
    String(a.period || '') === String(_lessonModalState.periodNum) &&
    String(a.subject || '') === _lessonModalState.subject &&
    String(a.class_label || '') === _lessonModalState.classLabel
  );
  const existingMap = new Map();
  existing.forEach((a) => existingMap.set(String(a.student_id || '').trim(), a));

  _lessonModalState.students = baseStudents.map((s) => {
    const prev = existingMap.get(s.student_id);
    return {
      student_id: s.student_id,
      student_name: s.student_name,
      status: prev ? _normalizeLessonAttendanceStatus(prev.status) : '출석',
      memo: prev ? String(prev.memo || '') : '',
    };
  });
  _renderLessonAttStudentList();
}

function onLessonRosterSelectChange(rosterKey) {
  _lessonModalState.rosterKey = rosterKey;
  const mapKey = `${_lessonModalState.subject}__${_lessonModalState.classLabel}`;
  _saveLessonRosterMapping(mapKey, rosterKey);
  const badge = document.getElementById('lessonRosterMatchBadge');
  if (badge) {
    badge.textContent = rosterKey === '__homeroom__' ? '학급 명렬 폴백' : '수동 연결 저장됨';
  }
  _hydrateLessonAttendanceStudents(rosterKey);
}

function openTeacherLessonModal(scheduleIndex) {
  const item = (mockData.teacherSchedule || [])[scheduleIndex];
  if (!item) return;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const periodNum = String(item.period || '').replace(/[^0-9]/g, '') || String(item.period || '');
  const subject = String(item.subject || '').trim();
  const classLabel = String(item.target || '').trim();

  _lessonModalState.scheduleItem = item;
  _lessonModalState.dateStr = todayStr;
  _lessonModalState.periodNum = periodNum;
  _lessonModalState.subject = subject;
  _lessonModalState.classLabel = classLabel;

  document.getElementById('teacherLessonTitle').innerText = `${item.period} · ${classLabel || '공강'} · ${subject || '수업 없음'}`;
  document.getElementById('teacherLessonSub').innerText = `${todayStr} 수업 출결 및 진도 관리`;

  // 1) 명렬표 자동 매칭 또는 localStorage 기억 매핑
  const rosters = Array.isArray(mockData.subjectRosters) ? mockData.subjectRosters : [];
  const mapKey = `${subject}__${classLabel}`;
  const savedMap = _loadLessonRosterMap();
  let matchedKey = savedMap[mapKey] || '';
  let matchModeLabel = '저장된 연결';

  if (!matchedKey || (matchedKey !== '__homeroom__' && !rosters.some((r) => String(r.roster_key || r.remote_id || '') === matchedKey))) {
    const autoFound = _findBestSubjectRoster(rosters, subject, classLabel);
    if (autoFound) {
      matchedKey = String(autoFound.roster_key || autoFound.remote_id || '');
      matchModeLabel = '자동 매칭';
    } else {
      matchedKey = '__homeroom__';
      matchModeLabel = '일치하는 교과 명렬표 없음 — 수동 선택 또는 폴백';
    }
  }

  _lessonModalState.rosterKey = matchedKey;
  const badge = document.getElementById('lessonRosterMatchBadge');
  if (badge) badge.textContent = matchModeLabel;

  const sel = document.getElementById('lessonRosterSelect');
  if (sel) {
    const opts = rosters.map((r) => {
      const k = String(r.roster_key || r.remote_id || '');
      const label = `${r.subject || '교과'} · ${r.class_label || '-'} (${Array.isArray(r.students) ? r.students.length : 0}명)`;
      return `<option value="${k}" ${k === matchedKey ? 'selected' : ''}>${label}</option>`;
    });
    opts.push(`<option value="__homeroom__" ${matchedKey === '__homeroom__' ? 'selected' : ''}>우리 반 학급 명렬표 (폴백 · ${(mockData.students || []).length}명)</option>`);
    sel.innerHTML = opts.join('');
  }

  _hydrateLessonAttendanceStudents(matchedKey);

  // 2) 수업 진도 탭 채우기 (직전 진도 + 당일 기존 진도)
  const allProg = (mockData.lessonProgress || []).filter((p) =>
    _normLessonToken(p.subject) === _normLessonToken(subject) &&
    _normLessonToken(p.class_label) === _normLessonToken(classLabel)
  );
  const todayProg = allProg.find((p) => String(p.date || '').slice(0, 10) === todayStr && String(p.period || '') === periodNum) || null;
  const prevProg = allProg.find((p) => !todayProg || p.remote_id !== todayProg.remote_id) || null;

  _lessonModalState.progressRemoteId = todayProg ? String(todayProg.remote_id || '') : '';
  const prevBox = document.getElementById('lessonPrevProgressBox');
  if (prevBox) {
    const esc = typeof _escapeNoticeHtml === 'function'
      ? _escapeNoticeHtml
      : (s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
    const importBtnHtml = `<button type="button" id="lessonImportProgBtn" onclick="openLessonProgressImportModal()" class="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full bg-white hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-[10px] font-bold shadow-2xs transition">진도 불러오기</button>`;
    if (prevProg) {
      prevBox.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <span class="font-bold text-indigo-900">직전 수업 진도 (${esc(prevProg.date || '-')} · ${prevProg.period ? esc(prevProg.period) + '교시' : '-'})</span>
            ${prevProg.lesson_no ? `<span class="inline-block ml-1.5 text-[10px] font-semibold text-indigo-700 bg-white px-2 py-0.5 rounded-full border border-indigo-100 align-middle">${esc(prevProg.lesson_no)}</span>` : ''}
          </div>
          ${importBtnHtml}
        </div>
        <div class="text-slate-700 font-semibold mt-1">${esc(prevProg.unit || '-')}</div>
        <div class="text-slate-600 text-[11px]">${esc(prevProg.content || '-')}</div>
        ${prevProg.next_note ? `<div class="text-[11px] text-indigo-700 mt-1">💡 다음 안내: ${esc(prevProg.next_note)}</div>` : ''}
      `;
    } else {
      prevBox.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="font-bold text-indigo-900">직전 수업 진도</div>
          ${importBtnHtml}
        </div>
        <p class="text-slate-500">기록된 직전 진도가 없습니다.</p>
      `;
    }
  }

  document.getElementById('lessonProgUnit').value = todayProg ? (todayProg.unit || '') : '';
  document.getElementById('lessonProgNo').value = todayProg ? (todayProg.lesson_no || '') : '';
  document.getElementById('lessonProgContent').value = todayProg ? (todayProg.content || '') : '';
  document.getElementById('lessonProgNext').value = todayProg ? (todayProg.next_note || '') : '';

  switchTeacherLessonTab('att');
  openModal('teacherLessonModal');
}

function _restoreLessonSaveButton(btnEl, origHtml, origDisabled) {
  if (!btnEl) return;
  if (btnEl.dataset && btnEl.dataset.loading === '1') {
    btnEl.innerHTML = origHtml;
    btnEl.disabled = origDisabled;
    delete btnEl.dataset.loading;
    if (btnEl.classList) btnEl.classList.remove('opacity-75', 'cursor-not-allowed');
  }
}

async function saveTeacherLessonAttendance(btnEl) {
  if (!_lessonModalState.students || _lessonModalState.students.length === 0) {
    showToast('저장할 학생 명렬이 없습니다.', '⚠️');
    return;
  }
  const origHtml = btnEl ? btnEl.innerHTML : '';
  const origDisabled = btnEl ? btnEl.disabled : false;
  try {
    await withButtonLoading(btnEl, '저장 중...', async () => {
      const payload = {
        ..._getTeacherAuthParams(),
        date: _lessonModalState.dateStr,
        period: _lessonModalState.periodNum,
        subject: _lessonModalState.subject,
        class_label: _lessonModalState.classLabel,
        roster_key: _lessonModalState.rosterKey,
        records: _lessonModalState.students,
      };
      if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
        const res = await gasApi.post('save_subject_attendance_batch', payload);
        if (res && res.ok === false) {
          throw new Error(res.error || '교과 출결 저장에 실패했습니다.');
        }
        if (res && Array.isArray(res.items)) {
          const rest = (mockData.subjectAttendance || []).filter((a) => !(
            String(a.date || '').slice(0, 10) === _lessonModalState.dateStr &&
            String(a.period || '') === String(_lessonModalState.periodNum) &&
            String(a.subject || '') === _lessonModalState.subject &&
            String(a.class_label || '') === _lessonModalState.classLabel
          ));
          mockData.subjectAttendance = [...res.items, ...rest];
        }
      }
      showToast(`${_lessonModalState.classLabel} ${_lessonModalState.subject} 출결이 저장되었습니다.`, '✅');
    });
  } catch (err) {
    const msg = (err && err.message) ? err.message : '알 수 없는 오류';
    showToast(`교과 출결 저장 실패: ${msg}`, '⚠️');
  } finally {
    _restoreLessonSaveButton(btnEl, origHtml, origDisabled);
  }
}

function _getRecentLessonProgressDates(progressList, limit = 5) {
  const seen = new Set();
  const dates = [];
  (Array.isArray(progressList) ? progressList : []).forEach((p) => {
    const d = String((p && p.date) || '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !seen.has(d)) {
      seen.add(d);
      dates.push(d);
    }
  });
  dates.sort((a, b) => b.localeCompare(a));
  return dates.slice(0, limit);
}

function _getDefaultLessonImportDate(progressList, fallbackDate) {
  const fallback = String(fallbackDate || '').trim().slice(0, 10);
  const recent = _getRecentLessonProgressDates(progressList, 50);
  if (fallback && recent.includes(fallback)) return fallback;
  if (recent.length > 0) return recent[0];
  return fallback;
}

function _getLessonProgressByDate(progressList, dateStr) {
  const target = String(dateStr || '').trim().slice(0, 10);
  if (!target) return [];
  return (Array.isArray(progressList) ? progressList : [])
    .filter((p) => p && String(p.date || '').trim().slice(0, 10) === target)
    .slice()
    .sort((a, b) => {
      const pa = parseInt(String(a.period || '').replace(/[^0-9]/g, ''), 10);
      const pb = parseInt(String(b.period || '').replace(/[^0-9]/g, ''), 10);
      const na = Number.isFinite(pa) ? pa : 999;
      const nb = Number.isFinite(pb) ? pb : 999;
      if (na !== nb) return na - nb;
      const clsCmp = String(a.class_label || '').localeCompare(String(b.class_label || ''), 'ko');
      if (clsCmp !== 0) return clsCmp;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
}

function _renderLessonImportRecentDateChips(activeDate) {
  const container = document.getElementById('lessonProgImportRecentDates');
  if (!container) return;
  const esc = typeof _escapeNoticeHtml === 'function'
    ? _escapeNoticeHtml
    : (s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  const recentDates = _getRecentLessonProgressDates(mockData.lessonProgress || [], 5);
  if (recentDates.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = recentDates.map((d) => {
    const isActive = d === activeDate;
    return `<button type="button" onclick="selectLessonImportDate('${esc(d)}')" class="shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full text-[10px] font-semibold border transition ${isActive ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-indigo-50'}">${esc(d)}</button>`;
  }).join('');
}

function selectLessonImportDate(dateStr) {
  const inputEl = document.getElementById('lessonProgImportDate');
  if (inputEl) inputEl.value = dateStr;
  renderLessonProgressImportList(dateStr);
}

let _lessonProgressFullLoaded = false;
let _lessonProgressLoadingPromise = null;

async function _ensureFullLessonProgressLoaded(targetDate = '') {
  if (_lessonProgressFullLoaded) return false;
  if (typeof gasApi === 'undefined' || !gasApi.isConfigured()) return false;
  if (_lessonProgressLoadingPromise) {
    return _lessonProgressLoadingPromise;
  }
  _lessonProgressLoadingPromise = (async () => {
    try {
      const res = await gasApi.post('fetch_lesson_progress', {
        ..._getTeacherAuthParams(),
        limit: 300,
      });
      if (res && res.ok !== false && Array.isArray(res.items)) {
        const merged = new Map();
        (Array.isArray(mockData.lessonProgress) ? mockData.lessonProgress : []).forEach((item) => {
          if (item && item.remote_id) merged.set(String(item.remote_id), item);
        });
        res.items.forEach((item) => {
          if (item && item.remote_id) merged.set(String(item.remote_id), item);
        });
        mockData.lessonProgress = Array.from(merged.values()).sort((a, b) =>
          String(b.date || b.updated_at || '').localeCompare(String(a.date || a.updated_at || ''))
        );
        _lessonProgressFullLoaded = true;
        const modalEl = typeof document !== 'undefined' ? document.getElementById('lessonProgressImportModal') : null;
        if (modalEl && !modalEl.classList.contains('hidden')) {
          const inputEl = document.getElementById('lessonProgImportDate');
          const activeDate = (inputEl && inputEl.value) || targetDate || '';
          renderLessonProgressImportList(activeDate);
        }
        return true;
      }
    } catch (_) {
    } finally {
      _lessonProgressLoadingPromise = null;
    }
    return false;
  })();
  return _lessonProgressLoadingPromise;
}

function renderLessonProgressImportList(dateStr) {
  const targetDate = String(dateStr || '').trim().slice(0, 10);
  _renderLessonImportRecentDateChips(targetDate);
  const listEl = document.getElementById('lessonProgImportList');
  if (!listEl) return;

  const esc = typeof _escapeNoticeHtml === 'function'
    ? _escapeNoticeHtml
    : (s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  const items = _getLessonProgressByDate(mockData.lessonProgress || [], targetDate);
  _lessonModalState.importCandidates = items;

  if (items.length === 0) {
    if (!_lessonProgressFullLoaded && typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      listEl.innerHTML = '<div class="py-10 text-center text-xs text-slate-400">과거 수업 진도 기록을 불러오는 중...</div>';
      _ensureFullLessonProgressLoaded(targetDate);
      return;
    }
    listEl.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">선택한 날짜(${esc(targetDate || '-')})에 등록된 수업 진도가 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = items.map((item, idx) => {
    const metaParts = [];
    if (item.period !== undefined && item.period !== null && String(item.period).trim() !== '') {
      const pText = String(item.period).trim();
      metaParts.push(pText.endsWith('교시') ? pText : `${pText}교시`);
    }
    if (String(item.class_label || '').trim()) metaParts.push(String(item.class_label).trim());
    if (String(item.subject || '').trim()) metaParts.push(String(item.subject).trim());
    const metaLabel = metaParts.join(' · ') || '수업 기록';
    const lessonNo = String(item.lesson_no || '').trim();
    const unit = String(item.unit || '').trim() || '(단원명 없음)';
    const content = String(item.content || '').trim() || '(수업 내용 없음)';
    const nextNote = String(item.next_note || '').trim();

    return `
      <button type="button" onclick="applyImportedLessonProgress(${idx})" class="w-full text-left p-3 rounded-2xl border border-slate-200 bg-slate-50/70 hover:border-indigo-400 hover:bg-indigo-50/40 active:scale-[0.99] transition space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] font-bold text-indigo-700 truncate">${esc(metaLabel)}</span>
          ${lessonNo ? `<span class="shrink-0 text-[10px] font-semibold text-slate-600 bg-white px-2 py-0.5 rounded-full border border-slate-200">${esc(lessonNo)}</span>` : ''}
        </div>
        <div class="text-xs font-bold text-slate-800 truncate">${esc(unit)}</div>
        <p class="text-[11px] text-slate-600 line-clamp-2">${esc(content)}</p>
        ${nextNote ? `<div class="text-[10px] text-indigo-600 truncate">💡 ${esc(nextNote)}</div>` : ''}
      </button>
    `;
  }).join('');
}

function openLessonProgressImportModal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const localToday = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultDate = _getDefaultLessonImportDate(mockData.lessonProgress || [], _lessonModalState.dateStr || localToday);
  const inputEl = document.getElementById('lessonProgImportDate');
  if (inputEl) inputEl.value = defaultDate;
  openModal('lessonProgressImportModal');
  renderLessonProgressImportList(defaultDate);
  if (!_lessonProgressFullLoaded) {
    _ensureFullLessonProgressLoaded(defaultDate);
  }
}

function applyImportedLessonProgress(idx) {
  const item = (_lessonModalState.importCandidates || [])[idx];
  if (!item) return;
  const unitEl = document.getElementById('lessonProgUnit');
  const noEl = document.getElementById('lessonProgNo');
  const contentEl = document.getElementById('lessonProgContent');
  const nextEl = document.getElementById('lessonProgNext');
  if (unitEl) unitEl.value = String(item.unit || '');
  if (noEl) noEl.value = String(item.lesson_no || '');
  if (contentEl) contentEl.value = String(item.content || '');
  if (nextEl) nextEl.value = String(item.next_note || '');
  closeModal('lessonProgressImportModal');
  showToast('진도 내용을 불러왔습니다. 확인 후 저장해 주세요.', '📋');
}

async function saveTeacherLessonProgress(btnEl) {
  const unit = (document.getElementById('lessonProgUnit')?.value || '').trim();
  const lessonNo = (document.getElementById('lessonProgNo')?.value || '').trim();
  const content = (document.getElementById('lessonProgContent')?.value || '').trim();
  const nextNote = (document.getElementById('lessonProgNext')?.value || '').trim();
  if (!unit && !content) {
    showToast('단원명 또는 수업 내용을 입력해 주세요.', '⚠️');
    return;
  }
  const origHtml = btnEl ? btnEl.innerHTML : '';
  const origDisabled = btnEl ? btnEl.disabled : false;
  try {
    await withButtonLoading(btnEl, '저장 중...', async () => {
      const payload = {
        ..._getTeacherAuthParams(),
        remote_id: _lessonModalState.progressRemoteId,
        date: _lessonModalState.dateStr,
        period: _lessonModalState.periodNum,
        subject: _lessonModalState.subject,
        class_label: _lessonModalState.classLabel,
        roster_key: _lessonModalState.rosterKey,
        unit,
        lesson_no: lessonNo,
        content,
        next_note: nextNote,
      };
      if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
        const res = await gasApi.post('upsert_lesson_progress', payload);
        if (res && res.ok === false) {
          throw new Error(res.error || '수업 진도 저장에 실패했습니다.');
        }
        if (res && res.item) {
          _lessonModalState.progressRemoteId = res.remote_id;
          const list = Array.isArray(mockData.lessonProgress) ? mockData.lessonProgress : [];
          const idx = list.findIndex((p) => String(p.remote_id || '') === res.remote_id);
          if (idx >= 0) list[idx] = res.item;
          else list.unshift(res.item);
          mockData.lessonProgress = list;
        }
      }
      showToast(`${_lessonModalState.classLabel} ${_lessonModalState.subject} 수업 진도가 저장되었습니다.`, '📖');
    });
  } catch (err) {
    const msg = (err && err.message) ? err.message : '알 수 없는 오류';
    showToast(`수업 진도 저장 실패: ${msg}`, '⚠️');
  } finally {
    _restoreLessonSaveButton(btnEl, origHtml, origDisabled);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    switchTeacherBottomTab,
    _deriveAttCheckStatus,
    _formatOutingPeriodInfo,
    _getReturnPeriodOptions,
    _parseOutingPeriodInfo,
    _computeFaceMatchPercent,
    _normalizeFaceMinMatchPct,
    _computeFaceDistanceThreshold,
    _computeFaceMatcherThreshold,
    evaluateFaceMatchDecision,
    _mapVideoBoxToOverlay,
    applyCameraFaceRecognitionToAttRows,
    _buildRecentCameraVerifiedList,
    getAttFaceFullscreenClasses,
    setAttFaceCameraFullscreen,
    toggleAttFaceCameraFullscreen,
    onAttFaceMinMatchChange,
    _getAttFaceState,
    stopAttFaceCameraPanel,
    _resolveFaceItemImageDataUrl,
    isPcAgentOnline,
    formatPcLastSeenRelative,
    REMOTE_TASK_LABELS,
    _extractClassTokens,
    _expandSubjectTokens,
    _findBestSubjectRoster,
    _normalizeLessonAttendanceStatus,
    _getRecentLessonProgressDates,
    _getDefaultLessonImportDate,
    _getLessonProgressByDate,
    saveTeacherLessonAttendance,
    saveTeacherLessonProgress,
    _lessonModalState,
    renderTeacherHome,
    renderTeacherDocs,
    renderTeacherChatRooms,
    renderTeacherChatMessages,
  };
}