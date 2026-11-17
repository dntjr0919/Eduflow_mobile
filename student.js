/* =========================================================
   EduFlow Mobile - Student & Parent Views (4 Tabs)
   [홈], [출결·서류], [가정통신·회비], [1:1 상담채팅]
   ========================================================= */

function switchBottomTab(tabName) {
  const studentTabs = ['home', 'attendance', 'letters', 'counseling'];
  const teacherTabs = ['home', 'documents', 'circulars', 'remote', 'chat'];
  teacherTabs.forEach(t => document.getElementById(`teacherTabView-${t}`).classList.add('hidden'));

  studentTabs.forEach(t => {
    const view = document.getElementById(`tabView-${t}`);
    const btn = document.getElementById(`tabNav-${t}`);
    const dot = btn.querySelector('span:last-child');
    if (t === tabName) {
      view.classList.remove('hidden');
      if (t === 'counseling') view.classList.add('flex');
      btn.className = "flex flex-col items-center gap-0.5 text-indigo-600 w-16 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-indigo-600";
    } else {
      view.classList.add('hidden');
      view.classList.remove('flex');
      btn.className = "flex flex-col items-center gap-0.5 text-slate-400 hover:text-slate-600 w-16 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-transparent";
    }
  });
}

// --- TAB 1: Home (Urgent Docs, Timetable, Meals) ---
function renderUrgentDocuments() {
  const container = document.getElementById('urgentDocContainer');
  const badge = document.getElementById('pendingCountBadge');
  const targetStuId = String(mockData.currentUser.studentId || mockData.currentUser.userId || '');
  const myDocs = targetStuId
    ? mockData.urgentDocuments.filter(d => String(d.studentId) === targetStuId && d.status !== 'closed')
    : [];
  const pendingDocs = myDocs.filter(d => d.status === 'pending');

  const attDot = document.getElementById('attNavDot');
  if (pendingDocs.length === 0) {
    badge.className = "text-[11px] px-2 py-0.5 font-bold rounded-full bg-emerald-100 text-emerald-700";
    badge.innerText = "모두 제출 완료 🎉";
    if (attDot) attDot.classList.add('hidden');
  } else {
    badge.className = "text-[11px] px-2 py-0.5 font-bold rounded-full bg-red-100 text-red-600";
    badge.innerText = `미제출 ${pendingDocs.length}건`;
    if (attDot) attDot.classList.remove('hidden');
  }

  if (myDocs.length === 0) {
    container.innerHTML = `<div class="bg-white border border-slate-200/80 rounded-2xl p-4 text-center text-xs text-slate-400">현재 제출 대상 증빙서류가 없습니다.</div>`;
    return;
  }

  container.innerHTML = myDocs.map(doc => {
    if (doc.status === 'submitted') {
      return `
        <div class="bg-emerald-50/90 border border-emerald-300/80 rounded-2xl p-3.5 transition-all duration-300 shadow-sm">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <div class="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>
              </div>
              <div>
                <h4 class="text-xs font-bold text-emerald-900">${doc.title} (${doc.docName})</h4>
                <p class="text-[10px] text-emerald-700 font-medium">제출 확인 완료 (교사 나이스 검수 대기 중)</p>
              </div>
            </div>
            <span class="text-[10px] font-semibold text-emerald-700 bg-white/80 border border-emerald-200 px-2 py-0.5 rounded-full">${doc.submittedAt || '방금 전 접수'}</span>
          </div>
        </div>
      `;
    }
    const isUrgent = doc.dDayColor === 'urgent';
    const borderColor = isUrgent ? 'border-urgent-500' : 'border-alert-500';
    const bgBadge = isUrgent ? 'bg-urgent-500 text-white' : 'bg-alert-500 text-white';
    return `
      <div id="doc-card-${doc.id}" class="bg-white border-2 ${borderColor} rounded-2xl p-4 shadow-sm transition-all relative overflow-hidden">
        <div class="flex items-center justify-between mb-1.5">
          <span class="text-[11px] font-bold px-2 py-0.5 rounded-md ${bgBadge} shadow-xs">${doc.dDayText}</span>
          <span class="text-[11px] font-medium text-slate-400">마감: ${doc.deadline}</span>
        </div>
        <h4 class="text-xs font-bold text-slate-900 mt-1">${doc.title} · ${doc.docName}</h4>
        <p class="text-[11px] text-slate-600 mt-0.5 leading-relaxed">${doc.description}</p>
        <div class="mt-3 pt-3 border-t border-slate-100">
          <p class="text-[10px] text-slate-500 mb-1.5 flex items-center gap-1 font-medium">
            <span>나이스(NEIS) 제출 후</span>
            <span class="text-indigo-600 font-bold bg-indigo-50 px-1 py-0.5 rounded">"제출했습니다"</span>
            <span>를 입력하면 독촉 알림이 중지됩니다.</span>
          </p>
          <div class="flex gap-1.5">
            <input type="text" id="input-${doc.id}" placeholder="&quot;제출했습니다&quot;를 입력하세요" class="flex-1 px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all">
            <button onclick="handleDocSubmit('${doc.id}', this)" class="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-xs font-bold rounded-xl whitespace-nowrap shadow-xs transition-all">제출 완료 확인</button>
          </div>
          <p id="error-${doc.id}" class="hidden text-[10px] text-urgent-500 mt-1 font-medium">⚠️ 정확히 "제출했습니다" 문구를 입력해야 확인 처리됩니다.</p>
        </div>
      </div>
    `;
  }).join('');
}

async function handleDocSubmit(docId, btnEl) {
  const input = document.getElementById(`input-${docId}`);
  const error = document.getElementById(`error-${docId}`);
  if ((input.value || '').trim() !== '제출했습니다') {
    error.classList.remove('hidden');
    input.classList.add('border-urgent-500', 'bg-red-50');
    input.focus();
    return;
  }
  error.classList.add('hidden');
  const doc = mockData.urgentDocuments.find(d => d.id === docId);
  if (!doc) return;

  await withButtonLoading(btnEl, '확인 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('mark_document_submitted', {
          remote_id: docId,
          submitted_by: mockData.currentUser.studentName || mockData.currentUser.studentId
        });
      } catch (err) {
        showToast(`서버 동기화 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    doc.status = 'submitted';
    const now = new Date();
    doc.submittedAt = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} 제출`;
    const hist = mockData.attendanceHistory.find(h => h.type.includes(doc.title.split(' ')[0]));
    if (hist) hist.docStatus = '학생확인완료';
    renderAll();
    showToast('서류 제출 확인이 등록되어 독촉 알림이 중지되었습니다.');
  });
}

function renderTimetable() {
  const container = document.getElementById('timetableList');
  const changeBadge = document.getElementById('studentTimetableChangeBadge');
  const changedItems = mockData.timetable.filter(t => t.isChanged);
  if (changeBadge) {
    if (changedItems.length > 0) {
      changeBadge.classList.remove('hidden');
      changeBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>${changedItems.map(c => c.period + '교시').join(', ')} 변동`;
    } else {
      changeBadge.classList.add('hidden');
    }
  }

  if (mockData.timetable.length === 0) {
    container.innerHTML = `<div class="w-full py-5 text-center text-xs text-slate-400">등록된 시간표가 없습니다.</div>`;
    return;
  }

  container.innerHTML = mockData.timetable.map(t => t.isChanged ? `
    <div class="shrink-0 w-24 bg-amber-50/90 border border-amber-300 rounded-xl p-2.5 flex flex-col justify-between text-center relative shadow-xs">
      <span class="absolute -top-1.5 -right-1.5 px-1.5 py-0.2 bg-amber-500 text-white text-[9px] font-bold rounded-full shadow-xs">변동</span>
      <div>
        <span class="text-[10px] font-semibold text-amber-700">${t.period}교시</span>
        <p class="text-xs font-extrabold text-amber-900 mt-0.5">${t.subject}</p>
        <p class="text-[10px] text-amber-700 font-medium truncate">${t.teacher}</p>
      </div>
      <div class="mt-2 pt-1 border-t border-amber-200/80"><span class="text-[9px] text-slate-400 line-through block">기존: ${t.original}</span></div>
    </div>
  ` : `
    <div class="shrink-0 w-24 bg-slate-50 border border-slate-100 rounded-xl p-2.5 flex flex-col justify-center text-center">
      <div>
        <span class="text-[10px] font-semibold text-slate-400">${t.period}교시</span>
        <p class="text-xs font-bold text-slate-800 mt-0.5">${t.subject}</p>
        <p class="text-[10px] text-slate-500 font-medium truncate">${t.teacher}</p>
      </div>
    </div>
  `).join('');
}

function switchMealTab(tab) {
  state.activeMealTab = tab;
  document.getElementById('mealTab-lunch').className = tab === 'lunch' ? "px-2.5 py-1 rounded-md bg-white text-indigo-600 shadow-xs transition-all" : "px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-800 transition-all";
  document.getElementById('mealTab-dinner').className = tab === 'dinner' ? "px-2.5 py-1 rounded-md bg-white text-indigo-600 shadow-xs transition-all" : "px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-800 transition-all";
  renderMeals();
}

function renderMeals() {
  const container = document.getElementById('mealContentBox');
  const meal = mockData.meals[state.activeMealTab];
  if (!meal) {
    container.innerHTML = `<div class="py-5 text-center text-xs text-slate-400">등록된 ${state.activeMealTab === 'lunch' ? '중식' : '석식'} 식단표가 없습니다.</div>`;
    return;
  }
  container.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <span class="text-[11px] font-bold text-slate-700">🍽️ ${state.activeMealTab === 'lunch' ? '중식 식단' : '석식 식단'}</span>
      <span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">${meal.calories}</span>
    </div>
    <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 py-1">
      ${meal.menu.map(item => `
        <div class="flex items-center justify-between text-xs py-0.5 border-b border-slate-100/80">
          <span class="font-medium text-slate-800">${item.name}</span>
          ${item.allergy ? `<span class="text-[9px] text-slate-400 font-mono">(${item.allergy})</span>` : ''}
        </div>
      `).join('')}
    </div>
    <div class="mt-2.5 pt-2 border-t border-slate-200/70 text-[9px] text-slate-400 leading-tight">
      ℹ️ <span class="font-semibold">알레르기 번호 안내:</span> ${meal.allergyNotice}
    </div>
  `;
}

// --- TAB 2: Attendance & Documents ---
function selectAttCategory(cat) {
  state.selectedAttCategory = cat;
  document.querySelectorAll('.att-cat-btn').forEach(btn => {
    btn.className = btn.dataset.cat === cat
      ? "att-cat-btn py-2 px-1 rounded-xl text-xs font-bold border transition-all text-center bg-indigo-600 text-white border-indigo-600 shadow-xs"
      : "att-cat-btn py-2 px-1 rounded-xl text-xs font-medium border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 transition-all text-center";
  });
}

function selectAttSubType(sub) {
  state.selectedAttSubType = sub;
  document.querySelectorAll('.att-sub-btn').forEach(btn => {
    btn.className = btn.dataset.sub === sub
      ? "att-sub-btn py-2 px-1 rounded-xl text-xs font-bold border transition-all text-center bg-indigo-600 text-white border-indigo-600 shadow-xs"
      : "att-sub-btn py-2 px-1 rounded-xl text-xs font-medium border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 transition-all text-center";
  });

  const periodGroup = document.getElementById('attPeriodGroup');
  const periodLabel = document.getElementById('attPeriodLabel');
  const periodSelect = document.getElementById('attPeriodSelect');
  const isTimeLimited = sub === '지각' || sub === '조퇴';

  if (periodGroup && periodSelect) {
    if (isTimeLimited) {
      periodGroup.classList.remove('hidden');
      if (periodLabel) {
        periodLabel.innerText = sub === '지각'
          ? '지각 교시 선택 (어디까지 결과인지)'
          : '조퇴 교시 선택 (어디서부터 결과인지)';
      }
      const prevVal = periodSelect.value;
      const options = getPeriodOptionsList();
      periodSelect.innerHTML = `<option value="">교시를 선택해 주세요</option>` +
        options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
      if (prevVal && options.includes(prevVal)) {
        periodSelect.value = prevVal;
      }
    } else {
      periodGroup.classList.add('hidden');
      periodSelect.value = '';
    }
  }
  syncAttEndDateIfNeeded();
}

function syncAttEndDateIfNeeded() {
  const startEl = document.getElementById('attStartDate');
  const endEl = document.getElementById('attEndDate');
  if (!startEl || !endEl) return;

  const isTimeLimited = state.selectedAttSubType === '지각' || state.selectedAttSubType === '조퇴';
  if (isTimeLimited) {
    if (!startEl.value) {
      startEl.value = getLocalTodayStr();
    }
    endEl.value = startEl.value;
    endEl.disabled = true;
  } else {
    endEl.disabled = false;
  }
}

function renderFieldTripGuide() {
  const box = document.getElementById('fieldTripGuideBox');
  if (!box) return;
  const preDays = Math.max(1, parseInt(mockData.rules.fieldPreDays || 3, 10) || 3);
  const postDays = Math.max(1, parseInt(mockData.rules.fieldPostDays || 5, 10) || 5);
  const todayStr = getLocalTodayStr();
  const earliestDate = addBusinessDays(todayStr, preDays);

  box.innerHTML = `
    <div class="flex items-center justify-between text-[11px]">
      <span class="text-slate-500 font-medium">오늘 날짜</span>
      <span class="font-bold text-slate-700">${todayStr} (${formatKoreanDateWithDay(todayStr)})</span>
    </div>
    <div class="flex items-center justify-between text-[11px]">
      <span class="text-slate-500 font-medium">신청서 제출 기한</span>
      <span class="font-bold text-indigo-700">체험학습 시작 ${preDays}영업일 전까지</span>
    </div>
    <div class="pt-1.5 mt-1 border-t border-slate-200/80 flex items-center justify-between text-[11px]">
      <span class="text-slate-600 font-semibold">오늘 신청 가능 시작일</span>
      <span class="font-extrabold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-lg">${earliestDate} (${formatKoreanDateWithDay(earliestDate)}) ~</span>
    </div>
    <p class="text-[10px] text-slate-400 pt-0.5">※ 결과보고서는 체험학습 종료 후 ${postDays}영업일 이내에 제출합니다. (주말·공휴일 제외)</p>
  `;
}

function _parseAttItemDates(item) {
  if (!item) return { startDate: '', endDate: '' };
  if (item.startDate) {
    return { startDate: item.startDate, endDate: item.endDate || item.startDate };
  }
  const matches = String(item.period || '').match(/\d{4}-\d{2}-\d{2}/g);
  if (!matches || matches.length === 0) return { startDate: '', endDate: '' };
  return {
    startDate: matches[0],
    endDate: matches[1] || matches[0]
  };
}

function _doesAttItemMatchDate(item, targetDate) {
  if (!targetDate) return false;
  const { startDate, endDate } = _parseAttItemDates(item);
  if (!startDate) return false;
  return targetDate >= startDate && targetDate <= (endDate || startDate);
}

function _parseAttCategoryAndSubType(item) {
  if (!item) return { category: '', subType: '' };
  let category = item.attCategory || '';
  let subType = item.attSubType || '';
  const typeStr = String(item.type || '');
  if (!category) {
    if (typeStr.includes('질병')) category = '질병';
    else if (typeStr.includes('인정')) category = '인정';
    else if (typeStr.includes('기타')) category = '기타';
  }
  if (!subType) {
    if (typeStr.includes('결석')) subType = '결석';
    else if (typeStr.includes('지각')) subType = '지각';
    else if (typeStr.includes('조퇴')) subType = '조퇴';
  }
  return { category, subType };
}

function _doPeriodRangesOverlap(subA, periodA, subB, periodB) {
  const options = typeof getPeriodOptionsList === 'function' ? getPeriodOptionsList() : [];
  const idxA = options.indexOf(periodA);
  const idxB = options.indexOf(periodB);
  if (idxA === -1 || idxB === -1) {
    return String(periodA || '') === String(periodB || '');
  }
  const rangeA = subA === '지각' ? [0, idxA] : [idxA, 999];
  const rangeB = subB === '지각' ? [0, idxB] : [idxB, 999];
  return Math.max(rangeA[0], rangeB[0]) <= Math.min(rangeA[1], rangeB[1]);
}

function cancelEditStudentAttendance() {
  state.editingAttendanceId = null;
  const btnText = document.getElementById('attSubmitBtnText');
  if (btnText) btnText.innerText = '담임선생님께 출결 보고하기';
  const cancelBtn = document.getElementById('attCancelEditBtn');
  if (cancelBtn) cancelBtn.classList.add('hidden');
  const reasonEl = document.getElementById('attReason');
  if (reasonEl) reasonEl.value = '';
  selectAttCategory('');
  selectAttSubType('');
}

function editStudentAttendance(attId) {
  const item = mockData.attendanceHistory.find(x => x.id === attId);
  if (!item) return;
  if (item.docStatus === '교사 최종완료' || item.confirmed) {
    showToast('교사 확인이 완료된 출결은 수정할 수 없습니다.', '🔒');
    return;
  }

  const { startDate, endDate } = _parseAttItemDates(item);
  const { category, subType } = _parseAttCategoryAndSubType(item);

  const startEl = document.getElementById('attStartDate');
  const endEl = document.getElementById('attEndDate');
  const reasonEl = document.getElementById('attReason');
  if (startEl && startDate) startEl.value = startDate;
  if (endEl && endDate) endEl.value = endDate;

  selectAttCategory(category);
  selectAttSubType(subType);

  const periodSelect = document.getElementById('attPeriodSelect');
  if (periodSelect && item.periodInfo && (subType === '지각' || subType === '조퇴')) {
    const hasOpt = Array.from(periodSelect.options).some(o => o.value === item.periodInfo);
    if (!hasOpt) {
      const opt = document.createElement('option');
      opt.value = item.periodInfo;
      opt.textContent = item.periodInfo;
      periodSelect.appendChild(opt);
    }
    periodSelect.value = item.periodInfo;
  }
  if (reasonEl) reasonEl.value = item.reason || '';

  state.editingAttendanceId = attId;
  const btnText = document.getElementById('attSubmitBtnText');
  if (btnText) btnText.innerText = '출결 수정 내용 저장하기';
  const cancelBtn = document.getElementById('attCancelEditBtn');
  if (cancelBtn) cancelBtn.classList.remove('hidden');

  if (startEl) {
    startEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  showToast('수정할 내용을 변경한 뒤 저장 버튼을 눌러주세요.', '✏️');
}

async function deleteStudentAttendance(attId) {
  const item = mockData.attendanceHistory.find(x => x.id === attId);
  if (!item) return;
  if (item.docStatus === '교사 최종완료' || item.confirmed) {
    showToast('교사 확인이 완료된 출결은 삭제할 수 없습니다.', '🔒');
    return;
  }
  if (!confirm('등록한 출결 내역을 삭제하시겠습니까?')) return;

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('delete_attendance', { remote_id: attId });
    } catch (err) {
      showToast(`출결 삭제 실패: ${err.message}`, '⚠️');
      return;
    }
  }

  mockData.attendanceHistory = mockData.attendanceHistory.filter(x => x.id !== attId);
  if (Array.isArray(mockData.teacherTodayAttendance)) {
    mockData.teacherTodayAttendance = mockData.teacherTodayAttendance.filter(x => x.id !== attId);
  }
  if (Array.isArray(mockData.urgentDocuments)) {
    const expectedTitle = `${item.type} (${item.period})`;
    mockData.urgentDocuments = mockData.urgentDocuments.filter(doc => {
      if (item.linkedDocId && doc.id === item.linkedDocId) return false;
      if (doc.type === 'urgency' && doc.title === expectedTitle) return false;
      return true;
    });
  }

  if (state.editingAttendanceId === attId) {
    cancelEditStudentAttendance();
  }
  renderAll();
  showToast('출결 내역이 삭제되었습니다.');
}

async function handleAttendanceSubmit(e) {
  e.preventDefault();
  if (!state.selectedAttCategory || !state.selectedAttSubType) {
    showToast('출결 종류(질병·인정·기타)와 출결 구분(지각·조퇴·결석)을 모두 선택해 주세요.', '⚠️');
    return;
  }

  const isTimeLimited = state.selectedAttSubType === '지각' || state.selectedAttSubType === '조퇴';
  const periodSelect = document.getElementById('attPeriodSelect');
  const periodInfo = isTimeLimited && periodSelect ? periodSelect.value : '';
  if (isTimeLimited && !periodInfo) {
    showToast(`${state.selectedAttSubType} 교시를 선택해 주세요.`, '⚠️');
    if (periodSelect) periodSelect.focus();
    return;
  }

  const submitBtn = e.submitter || (e.target && e.target.querySelector('button[type="submit"]'));
  const sDate = document.getElementById('attStartDate').value;
  const eDate = isTimeLimited ? sDate : document.getElementById('attEndDate').value;
  const reason = document.getElementById('attReason').value.trim();
  const combinedType = `${state.selectedAttCategory}${state.selectedAttSubType}`;
  const periodStr = isTimeLimited
    ? `${sDate} (${periodInfo})`
    : (sDate === eDate ? sDate : `${sDate} ~ ${eDate}`);

  const editingId = state.editingAttendanceId || null;
  let overwriteItem = editingId
    ? (mockData.attendanceHistory.find(x => x.id === editingId) || null)
    : null;

  if (!editingId) {
    const sameDateItems = mockData.attendanceHistory.filter(item => _doesAttItemMatchDate(item, sDate));
    if (sameDateItems.length > 0) {
      const existingAbsence = sameDateItems.find(item => _parseAttCategoryAndSubType(item).subType === '결석');
      if (existingAbsence || state.selectedAttSubType === '결석') {
        const target = existingAbsence || sameDateItems[0];
        if (!confirm(`오늘 이미 등록된 출결(${target.type})이 있습니다. 새로운 내용으로 변경(덮어쓰기)할까요?`)) {
          return;
        }
        overwriteItem = target;
      } else {
        const overlapping = sameDateItems.find(item => {
          const { subType: exSub } = _parseAttCategoryAndSubType(item);
          return (exSub === '지각' || exSub === '조퇴') &&
            _doPeriodRangesOverlap(exSub, item.periodInfo, state.selectedAttSubType, periodInfo);
        });
        if (overlapping) {
          showToast('이미 동일한 시간대에 출결이 등록되어 있습니다. 아래 이력에서 연필(수정) 버튼을 이용해 주세요.', '⚠️');
          return;
        }
      }
    }
  }

  const isOverwrite = Boolean(overwriteItem);
  const attId = isOverwrite ? overwriteItem.id : ('ATT-' + Date.now());
  const defaultRequiredTypes = ['질병결석', '인정지각', '인정조퇴', '인정결석', '기타지각', '기타조퇴', '기타결석'];
  const allowedDocTypes = Array.isArray(mockData.rules.requiredAttTypes)
    ? mockData.rules.requiredAttTypes
    : defaultRequiredTypes;
  const requiresDocument = allowedDocTypes.includes(combinedType);

  const oldTitle = isOverwrite ? `${overwriteItem.type} (${overwriteItem.period})` : '';
  const existingLinkedDoc = (isOverwrite && Array.isArray(mockData.urgentDocuments))
    ? mockData.urgentDocuments.find(d =>
        (overwriteItem.linkedDocId && d.id === overwriteItem.linkedDocId) ||
        (d.type === 'urgency' && d.title === oldTitle)
      )
    : null;
  const existingDocId = isOverwrite
    ? (overwriteItem.linkedDocId || (existingLinkedDoc ? existingLinkedDoc.id : null))
    : null;
  const docId = existingDocId || ('DOC-' + Date.now());
  const stuId = String(mockData.currentUser.studentId || mockData.currentUser.userId || '');
  const stuName = mockData.currentUser.studentName || '학생';
  const ruleCode = 'ABSENCE_REPORT';
  const docName = '출결신고서';

  const newDoc = {
    id: docId,
    studentId: stuId,
    studentName: stuName,
    type: 'urgency',
    dDayText: `기한 +${mockData.rules.sickDays}일`,
    dDayColor: 'urgent',
    title: `${combinedType} (${periodStr})`,
    docName,
    description: reason,
    deadline: eDate,
    status: 'pending',
    submittedAt: null
  };

  await withButtonLoading(submitBtn, isOverwrite ? '저장 중...' : '등록 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('submit_attendance', {
          data: {
            remote_id: attId,
            date: sDate,
            student_id: stuId,
            student_name: stuName,
            grade: mockData.currentUser.grade || '1',
            class_no: mockData.currentUser.classNo || '3',
            attendance_type: combinedType,
            att_category: state.selectedAttCategory,
            att_sub_type: state.selectedAttSubType,
            period_info: periodInfo,
            reason,
            submitted_by: stuName,
            role: state.activeRole,
            teacher_confirmed: 0,
            memo: periodStr
          }
        });
        if (requiresDocument && (!isOverwrite || !existingDocId)) {
          const docRes = await gasApi.post('upsert_document_tracking', {
            data: {
              remote_id: docId,
              doc_type: docName,
              rule_code: ruleCode,
              student_id: stuId,
              student_name: stuName,
              base_date: eDate || sDate,
              status: '미제출',
              memo: reason
            }
          });
          if (docRes && docRes.due_date) {
            newDoc.deadline = docRes.due_date;
          }
        } else if (!requiresDocument && isOverwrite && existingDocId) {
          await gasApi.post('delete_document_tracking', { remote_id: existingDocId });
        }
      } catch (err) {
        showToast(`출결 서버 전송 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    if (isOverwrite) {
      overwriteItem.period = periodStr;
      overwriteItem.startDate = sDate;
      overwriteItem.endDate = eDate;
      overwriteItem.type = combinedType;
      overwriteItem.attCategory = state.selectedAttCategory;
      overwriteItem.attSubType = state.selectedAttSubType;
      overwriteItem.periodInfo = periodInfo;
      overwriteItem.reason = reason;

      if (Array.isArray(mockData.teacherTodayAttendance)) {
        const tItem = mockData.teacherTodayAttendance.find(x => x.id === attId);
        if (tItem) {
          tItem.type = combinedType;
          tItem.attCategory = state.selectedAttCategory;
          tItem.attSubType = state.selectedAttSubType;
          tItem.periodInfo = periodInfo;
          tItem.reason = reason;
        }
      }

      if (requiresDocument) {
        if (existingLinkedDoc) {
          existingLinkedDoc.title = `${combinedType} (${periodStr})`;
          existingLinkedDoc.description = reason;
          existingLinkedDoc.deadline = eDate;
        } else if (!existingDocId) {
          mockData.urgentDocuments.unshift(newDoc);
        }
        overwriteItem.linkedDocId = docId;
        if (!overwriteItem.docStatus || overwriteItem.docStatus === '제출 불필요') {
          overwriteItem.docStatus = '서류 미제출';
        }
      } else {
        if (existingDocId && Array.isArray(mockData.urgentDocuments)) {
          mockData.urgentDocuments = mockData.urgentDocuments.filter(d => d.id !== existingDocId);
        }
        overwriteItem.linkedDocId = null;
        overwriteItem.docStatus = '제출 불필요';
      }
    } else {
      mockData.attendanceHistory.unshift({
        id: attId,
        period: periodStr,
        startDate: sDate,
        endDate: eDate,
        type: combinedType,
        attCategory: state.selectedAttCategory,
        attSubType: state.selectedAttSubType,
        periodInfo,
        reason: reason,
        docStatus: requiresDocument ? '서류 미제출' : '제출 불필요',
        linkedDocId: requiresDocument ? docId : null
      });
      if (requiresDocument) {
        mockData.urgentDocuments.unshift(newDoc);
      }
    }

    if (editingId) {
      cancelEditStudentAttendance();
    } else {
      document.getElementById('attReason').value = '';
      selectAttCategory('');
      selectAttSubType('');
    }
    renderAll();
    if (!requiresDocument) {
      showToast(`출결 사유가 보고되었습니다. (${combinedType}은 신고서 제출 대상이 아닙니다)`);
    } else {
      showToast(isOverwrite ? '출결 내역이 수정(덮어쓰기)되었습니다.' : '출결 사유가 등록되고 서류 알림이 생성되었습니다.');
    }
  });
}

function renderAttendanceHistory() {
  renderFieldTripGuide();
  const list = document.getElementById('attendanceHistoryList');
  document.getElementById('attHistoryCount').innerText = `총 ${mockData.attendanceHistory.length}건`;
  if (mockData.attendanceHistory.length === 0) {
    list.innerHTML = `<div class="bg-white p-5 rounded-2xl border border-slate-200/80 text-center text-xs text-slate-400">등록된 출결 이력이 없습니다.</div>`;
    return;
  }
  list.innerHTML = mockData.attendanceHistory.map(item => {
    let badgeStyle = 'bg-red-100 text-red-700';
    if (item.docStatus === '학생확인완료') badgeStyle = 'bg-blue-100 text-blue-700';
    if (item.docStatus === '교사 최종완료') badgeStyle = 'bg-emerald-100 text-emerald-700';
    if (item.docStatus === '제출 불필요') badgeStyle = 'bg-slate-100 text-slate-600';
    const isLocked = item.docStatus === '교사 최종완료' || item.confirmed;
    const periodLabel = (item.periodInfo && !String(item.period || '').includes(item.periodInfo))
      ? `${item.period} · ${item.periodInfo}`
      : item.period;
    const btnTone = isLocked
      ? 'text-slate-300 cursor-not-allowed'
      : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50';
    const delTone = isLocked
      ? 'text-slate-300 cursor-not-allowed'
      : 'text-slate-400 hover:text-red-600 hover:bg-red-50';
    return `
      <div class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-800">${item.type} <span class="text-[11px] font-normal text-slate-400">(${periodLabel})</span></span>
          <div class="flex items-center gap-1 shrink-0">
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeStyle}">${item.docStatus}</span>
            <button type="button" onclick="editStudentAttendance('${item.id}')" title="${isLocked ? '교사 확인 완료 건은 수정 불가' : '수정'}" class="p-1 rounded-lg transition-colors ${btnTone}" aria-label="출결 수정">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
            </button>
            <button type="button" onclick="deleteStudentAttendance('${item.id}')" title="${isLocked ? '교사 확인 완료 건은 삭제 불가' : '삭제'}" class="p-1 rounded-lg transition-colors ${delTone}" aria-label="출결 삭제">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          </div>
        </div>
        <p class="text-[11px] text-slate-600">${item.reason}</p>
      </div>
    `;
  }).join('');
}

// --- TAB 3: Circulars & Class Budget ---
function switchLettersSubTab(sub) {
  document.getElementById('subTabBtn-circulars').className = sub === 'circulars' ? "flex-1 py-2 text-xs font-semibold rounded-lg bg-white text-indigo-600 shadow-sm transition-all" : "flex-1 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg transition-all";
  document.getElementById('subTabBtn-budget').className = sub === 'budget' ? "flex-1 py-2 text-xs font-semibold rounded-lg bg-white text-indigo-600 shadow-sm transition-all" : "flex-1 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg transition-all";
  document.getElementById('lettersSection-circulars').classList.toggle('hidden', sub !== 'circulars');
  document.getElementById('lettersSection-budget').classList.toggle('hidden', sub !== 'budget');
}

function renderCirculars() {
  const list = document.getElementById('circularsList');
  if (mockData.circulars.length === 0) {
    list.innerHTML = `<div class="bg-white p-5 rounded-2xl border border-slate-200/80 text-center text-xs text-slate-400">등록된 가정통신문이 없습니다.</div>`;
    return;
  }
  list.innerHTML = mockData.circulars.map(c => `
    <div onclick="openCircularModal('${c.id}')" class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs hover:border-indigo-300 transition-all cursor-pointer flex items-center justify-between gap-3">
      <div class="space-y-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${c.status === 'pending' ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-700'}">
            ${c.status === 'pending' ? '미제출' : '서명완료'}
          </span>
          <span class="text-[10px] text-slate-400">${c.deadline}</span>
        </div>
        <h4 class="text-xs font-bold text-slate-800">${c.title}</h4>
      </div>
      <span class="text-xs text-indigo-600 font-bold shrink-0">${c.status === 'pending' ? '서명하기 →' : '열람'}</span>
    </div>
  `).join('');
}

function openCircularModal(id) {
  state.currentCircularId = id;
  const c = mockData.circulars.find(x => x.id === id);
  if (!c) return;
  document.getElementById('modalCircularNumber').innerText = c.docNum;
  document.getElementById('modalCircularTitle').innerText = c.title;
  document.getElementById('modalCircularContent').innerText = c.content;
  document.getElementById('modalCircularMeta').innerHTML = c.meta.map(m => `<p>• ${m}</p>`).join('');
  clearSignaturePad();
  openModal('circularModal');
}

function closeCircularModal() {
  closeModal('circularModal');
}

// HTML5 Canvas Touch Electronic Signature Engine
function initSignaturePad() {
  const canvas = document.getElementById('signaturePad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1E293B';
  let drawing = false;

  const getPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const start = (e) => {
    e.preventDefault();
    drawing = true;
    state.hasDrawnSignature = true;
    document.getElementById('signaturePlaceholder').classList.add('hidden');
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  };
  const end = () => { drawing = false; };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
}

function clearSignaturePad() {
  const canvas = document.getElementById('signaturePad');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.hasDrawnSignature = false;
  document.getElementById('signaturePlaceholder').classList.remove('hidden');
}

async function submitCircularSignature(btnEl) {
  if (!state.hasDrawnSignature) {
    showToast('서명란에 터치 전자서명을 작성해 주세요.', '✍️');
    return;
  }
  const canvas = document.getElementById('signaturePad');
  const signatureBase64 = canvas ? canvas.toDataURL('image/png') : '';
  const cId = state.currentCircularId;
  const c = mockData.circulars.find(x => x.id === cId);

  await withButtonLoading(btnEl, '제출 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        await gasApi.post('submit_notice_reply', {
          data: {
            notice_id: cId,
            student_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
            student_name: mockData.currentUser.studentName || '학생',
            parent_id: mockData.currentUser.userId || '',
            parent_name: mockData.currentUser.parentName || '학부모',
            consent: '동의',
            signature_base64: signatureBase64
          }
        });
      } catch (err) {
        showToast(`전자서명 저장 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    if (c && c.status === 'pending') {
      c.status = 'submitted';
      c.submittedCount = Math.min(c.totalCount, c.submittedCount + 1);
    }
    closeCircularModal();
    renderCirculars();
    if (typeof renderTeacherCirculars === 'function') renderTeacherCirculars();
    showToast('전자서명 및 회신이 제출되었습니다.');
  });
}

function renderBudget() {
  document.getElementById('budgetBalance').innerText = (mockData.budget.balance || 0).toLocaleString() + '원';
  document.getElementById('budgetIncome').innerText = (mockData.budget.income || 0).toLocaleString() + '원';
  document.getElementById('budgetExpense').innerText = (mockData.budget.expense || 0).toLocaleString() + '원';
  const list = document.getElementById('budgetTransactionsList');
  if (!mockData.budget.transactions || mockData.budget.transactions.length === 0) {
    list.innerHTML = `<div class="bg-white p-5 rounded-xl border border-slate-200/80 text-center text-xs text-slate-400">등록된 학급회비 입출금 내역이 없습니다.</div>`;
    return;
  }
  list.innerHTML = mockData.budget.transactions.map(tx => `
    <div class="bg-white p-3 rounded-xl border border-slate-200/80 flex items-center justify-between">
      <div>
        <span class="text-[10px] text-slate-400">${tx.date} · ${tx.store}</span>
        <p class="text-xs font-bold text-slate-800">${tx.title}</p>
      </div>
      <div class="text-right">
        <p class="text-xs font-bold ${tx.type === 'income' ? 'text-indigo-600' : 'text-slate-800'}">
          ${tx.type === 'income' ? '+' : '-'}${(Number(tx.amount) || 0).toLocaleString()}원
        </p>
        <button onclick="openReceiptModal('${tx.id}')" class="text-[10px] text-indigo-600 hover:underline font-medium">영수증 보기</button>
      </div>
    </div>
  `).join('');
}

function openReceiptModal(txId) {
  const tx = mockData.budget.transactions.find(t => t.id === txId);
  if (!tx) return;
  document.getElementById('receiptModalBody').innerHTML = `
    <p class="font-bold text-slate-800 text-sm border-b border-slate-200 pb-2">${tx.store}</p>
    <p>거래일자: ${tx.date}</p>
    <p>적요항목: ${tx.title}</p>
    <p>결제수단: ${tx.card}</p>
    ${tx.receiptUrl ? `<p>증빙링크: <a href="${tx.receiptUrl}" target="_blank" rel="noopener" class="text-indigo-600 underline">영수증 원본 보기</a></p>` : ''}
    <p class="font-bold text-indigo-700 pt-2 border-t border-slate-200">합계금액: ${(Number(tx.amount) || 0).toLocaleString()}원</p>
  `;
  openModal('receiptModal');
}

function closeReceiptModal() {
  closeModal('receiptModal');
}

// --- TAB 4: 1:1 Counseling & Chat ---
function _getOrCreateStudentChatRoom() {
  const stuId = String(mockData.currentUser.studentId || mockData.currentUser.userId || 'ME');
  let room = mockData.chatRooms.find(r => String(r.studentId) === stuId) || mockData.chatRooms[0];
  if (!room) {
    room = {
      roomId: `ROOM-${stuId}`,
      studentId: stuId,
      studentName: mockData.currentUser.studentName || '학생',
      partnerLabel: mockData.currentUser.studentName || stuId,
      subtitle: mockData.currentUser.gradeClass || '',
      unread: 0,
      messages: []
    };
    mockData.chatRooms.push(room);
  }
  return room;
}

function renderStudentChat() {
  const banner = document.getElementById('counselingCtaBanner');
  banner.classList.toggle('hidden', !mockData.isCounselingOpen);

  const teacherLabel = mockData.currentUser.teacherName
    ? `${mockData.currentUser.teacherName} 담임선생님`
    : '담임선생님';
  const room = _getOrCreateStudentChatRoom();
  const container = document.getElementById('chatMessagesContainer');

  if (!room.messages || room.messages.length === 0) {
    container.innerHTML = `<div class="text-center py-10 text-xs text-slate-400">${teacherLabel}과의 1:1 비공개 상담방입니다. 메시지를 입력해 대화를 시작해 보세요.</div>`;
    return;
  }

  container.innerHTML = room.messages.map(m => m.sender === 'user' ? `
    <div class="flex flex-col items-end">
      <div class="bg-indigo-600 text-white text-xs px-3.5 py-2.5 rounded-2xl rounded-tr-xs max-w-[80%] shadow-xs leading-relaxed">${m.text}</div>
      <span class="text-[9px] text-slate-400 mt-1">${m.time}</span>
    </div>
  ` : `
    <div class="flex flex-col items-start">
      <span class="text-[10px] font-semibold text-slate-500 mb-1">${teacherLabel}</span>
      <div class="bg-white text-slate-800 border border-slate-200/80 text-xs px-3.5 py-2.5 rounded-2xl rounded-tl-xs max-w-[80%] shadow-xs leading-relaxed">${m.text}</div>
      <span class="text-[9px] text-slate-400 mt-1">${m.time}</span>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  const now = new Date();
  const timeStr = `오늘 ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  const room = _getOrCreateStudentChatRoom();
  room.messages.push({ sender: 'user', text, time: timeStr });
  room.unread += 1;
  input.value = '';
  renderStudentChat();
  if (typeof renderTeacherChatRooms === 'function') renderTeacherChatRooms();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('send_chat_message', {
        data: {
          room_id: room.roomId,
          sender_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
          sender_name: mockData.currentUser.studentName || mockData.currentUser.parentName || '학생',
          sender_role: state.activeRole,
          receiver_id: 'teacher_001',
          message: text,
          is_read: 0
        }
      });
    } catch (err) {
      showToast(`메시지 전송 실패: ${err.message}`, '⚠️');
    }
  }
}

function openCounselingModal() {
  openModal('counselingModal');
}

function closeCounselingModal() {
  closeModal('counselingModal');
}

async function handleCounselingBooking(e) {
  e.preventDefault();
  const date = document.getElementById('counselDate').value;
  const slot = document.getElementById('counselTimeSlot').value;
  const topic = document.querySelector('input[name="counselTopic"]:checked').value;
  const notes = document.getElementById('counselNotes').value.trim();
  const msg = `📅 [상담 신청] ${date} / ${slot} / 주제: ${topic}${notes ? ' (' + notes + ')' : ''}`;
  const room = _getOrCreateStudentChatRoom();
  room.messages.push({ sender: 'user', text: msg, time: '방금 전' });
  room.unread += 1;
  closeCounselingModal();
  renderStudentChat();
  if (typeof renderTeacherChatRooms === 'function') renderTeacherChatRooms();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('send_chat_message', {
        data: {
          room_id: room.roomId,
          sender_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
          sender_name: mockData.currentUser.studentName || mockData.currentUser.parentName || '학생',
          sender_role: state.activeRole,
          receiver_id: 'teacher_001',
          message: msg,
          is_read: 0
        }
      });
    } catch (err) {
      showToast(`상담 신청 전송 실패: ${err.message}`, '⚠️');
      return;
    }
  }
  showToast('상담 면담 신청이 담임선생님께 전송되었습니다.');
}