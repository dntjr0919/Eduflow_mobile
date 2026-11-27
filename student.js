/* =========================================================
   EduFlow Mobile - Student & Parent Views (4 Tabs)
   [홈], [출결·서류], [가정통신·회비], [1:1 상담채팅]
   ========================================================= */

function _escStudentHtml(val) {
  if (typeof escapeHtml === 'function') return escapeHtml(val);
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _safeStudentImageUrl(rawUrl) {
  if (typeof safeImageUrl === 'function') return safeImageUrl(rawUrl);
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
  return '';
}

function _extractDriveFileId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const queryMatch = s.match(/[?&]id=([A-Za-z0-9_-]{10,128})/);
  if (queryMatch) return queryMatch[1];
  const filePathMatch = s.match(/\/file\/d\/([A-Za-z0-9_-]{10,128})/);
  if (filePathMatch) return filePathMatch[1];
  const shortPathMatch = s.match(/\/d\/([A-Za-z0-9_-]{10,128})/);
  if (shortPathMatch) return shortPathMatch[1];
  if (/^[A-Za-z0-9_-]{10,128}$/.test(s)) return s;
  return '';
}

function _resolveDriveImageUrls(rawUrlOrId) {
  const s = String(rawUrlOrId || '').trim();
  if (!s) return { primary: '', fallback: '', fileId: '' };
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) {
    return { primary: s, fallback: '', fileId: '' };
  }
  const isRawId = /^[A-Za-z0-9_-]{10,128}$/.test(s);
  const isDriveUrl = /^https?:\/\/(?:drive\.google\.com|lh3\.googleusercontent\.com)\//i.test(s);
  if (isRawId || isDriveUrl) {
    const fileId = _extractDriveFileId(s);
    if (fileId) {
      return {
        primary: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`,
        fallback: `https://lh3.googleusercontent.com/d/${fileId}`,
        fileId
      };
    }
  }
  const safe = _safeStudentImageUrl(s);
  return { primary: safe, fallback: '', fileId: '' };
}

function _applyDriveImageWithFallback(imgEl, rawUrlOrId) {
  const resolved = _resolveDriveImageUrls(rawUrlOrId);
  if (!imgEl) return Boolean(resolved.primary);
  imgEl.onerror = null;
  if (imgEl.dataset) delete imgEl.dataset.fbApplied;
  if (!resolved.primary) {
    imgEl.removeAttribute('src');
    return false;
  }
  if (resolved.fallback) {
    imgEl.onerror = function () {
      if (this.dataset && this.dataset.fbApplied) {
        this.onerror = null;
        return;
      }
      if (this.dataset) this.dataset.fbApplied = '1';
      this.src = resolved.fallback;
    };
  }
  imgEl.src = resolved.primary;
  return true;
}

function switchBottomTab(tabName) {
  if (typeof state !== 'undefined' && state) state.activeStudentTab = tabName;
  const studentTabs = ['home', 'attendance', 'letters', 'counseling'];
  const teacherTabs = ['home', 'documents', 'circulars', 'remote', 'chat'];
  teacherTabs.forEach(t => {
    const tv = document.getElementById(`teacherTabView-${t}`);
    if (tv) tv.classList.add('hidden');
  });

  studentTabs.forEach(t => {
    const view = document.getElementById(`tabView-${t}`);
    const btn = document.getElementById(`tabNav-${t}`);
    const dot = btn ? btn.querySelector('span:last-child') : null;
    if (t === tabName) {
      if (view) {
        view.classList.remove('hidden');
        if (t === 'counseling') view.classList.add('flex');
      }
      if (btn) btn.className = "flex flex-col items-center gap-0.5 text-indigo-600 w-16 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-indigo-600";
    } else {
      if (view) {
        view.classList.add('hidden');
        view.classList.remove('flex');
      }
      if (btn) btn.className = "flex flex-col items-center gap-0.5 text-slate-400 hover:text-slate-600 w-16 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-transparent";
    }
  });
  if (tabName === 'counseling' && typeof renderStudentChat === 'function') {
    renderStudentChat();
  }
  if (typeof _setChatTabRealtimeActive === 'function') {
    _setChatTabRealtimeActive(tabName === 'counseling');
  }
}

// --- TAB 1: Home (Urgent Docs, Timetable, Meals) ---
function renderUrgentDocuments() {
  const container = document.getElementById('urgentDocContainer');
  const badge = document.getElementById('pendingCountBadge');
  const targetStuId = String(mockData.currentUser.studentId || mockData.currentUser.userId || '');
  const myDocs = targetStuId
    ? mockData.urgentDocuments.filter(d => {
        if (String(d.studentId) !== targetStuId) return false;
        const st = String(d.status || '').trim().toLowerCase();
        return st !== 'closed' && st !== '확인완료' && st !== '최종 종결' && st !== '최종종결';
      })
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
    container.innerHTML = `<div class="w-full max-w-full min-w-0 bg-white border border-slate-200/80 rounded-2xl p-4 text-center text-xs text-slate-400">현재 제출 대상 증빙서류가 없습니다.</div>`;
    return;
  }

  container.innerHTML = myDocs.map(doc => {
    const safeDocId = _escStudentHtml(doc.id);
    if (doc.status === 'submitted') {
      return `
        <div class="w-full max-w-full min-w-0 bg-emerald-50/90 border border-emerald-300/80 rounded-2xl p-3.5 transition-all duration-300 shadow-sm">
          <div class="flex items-center justify-between gap-2 min-w-0">
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <div class="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>
              </div>
              <div class="min-w-0">
                <h4 class="text-xs font-bold text-emerald-900 break-words">${_escStudentHtml(doc.title)} (${_escStudentHtml(doc.docName)})</h4>
                <p class="text-[10px] text-emerald-700 font-medium">제출 확인 완료 (교사 나이스 검수 대기 중)</p>
              </div>
            </div>
            <span class="text-[10px] font-semibold text-emerald-700 bg-white/80 border border-emerald-200 px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap">${_escStudentHtml(doc.submittedAt || '방금 전 접수')}</span>
          </div>
        </div>
      `;
    }
    const isUrgent = doc.dDayColor === 'urgent';
    const borderColor = isUrgent ? 'border-urgent-500' : 'border-alert-500';
    const bgBadge = isUrgent ? 'bg-urgent-500 text-white' : 'bg-alert-500 text-white';
    return `
      <div id="doc-card-${safeDocId}" class="w-full max-w-full min-w-0 bg-white border-2 ${borderColor} rounded-2xl p-4 shadow-sm transition-all relative overflow-hidden">
        <div class="flex items-center justify-between gap-2 mb-1.5 min-w-0">
          <span class="text-[11px] font-bold px-2 py-0.5 rounded-md ${bgBadge} shadow-xs shrink-0 whitespace-nowrap">${_escStudentHtml(doc.dDayText)}</span>
          <span class="text-[11px] font-medium text-slate-400 truncate">마감: ${_escStudentHtml(doc.deadline)}</span>
        </div>
        <h4 class="text-xs font-bold text-slate-900 mt-1 break-words">${_escStudentHtml(doc.title)} · ${_escStudentHtml(doc.docName)}</h4>
        <p class="text-[11px] text-slate-600 mt-0.5 leading-relaxed break-words">${_escStudentHtml(doc.description)}</p>
        <div class="mt-3 pt-3 border-t border-slate-100 w-full max-w-full min-w-0">
          <p class="text-[10px] text-slate-500 mb-1.5 leading-relaxed font-medium">
            나이스(NEIS) 제출 후 <span class="inline-block whitespace-nowrap text-indigo-600 font-bold bg-indigo-50 px-1 py-0.5 rounded">"제출했습니다"</span>를 입력하면 독촉 알림이 중지됩니다.
          </p>
          <div class="flex flex-col sm:flex-row gap-2 w-full min-w-0">
            <input type="text" id="input-${safeDocId}" data-doc-confirm-input="1" autocomplete="off" placeholder="&quot;제출했습니다&quot;를 입력하세요" class="w-full min-w-0 sm:flex-1 px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all">
            <button onclick="handleDocSubmit('${safeDocId}', this)" class="w-full sm:w-auto shrink-0 whitespace-nowrap px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-xs font-bold rounded-xl shadow-xs transition-all">제출 완료 확인</button>
          </div>
          <p id="error-${safeDocId}" class="hidden text-[10px] text-urgent-500 mt-1 font-medium">⚠️ 정확히 "제출했습니다" 문구를 입력해야 확인 처리됩니다.</p>
        </div>
      </div>
    `;
  }).join('');
  _bindNoPasteDocConfirmInputs(container);
}

function _bindNoPasteDocConfirmInputs(container) {
  if (!container) return;
  const warnPasteBlocked = () => {
    if (typeof showToast === 'function') {
      showToast('복사·붙여넣기는 사용할 수 없습니다. 직접 입력해 주세요.', '⚠️');
    }
  };
  container.querySelectorAll('input[data-doc-confirm-input]').forEach(input => {
    let isComposing = false;
    let lastValidValue = input.value || '';

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      warnPasteBlocked();
    });
    input.addEventListener('drop', (e) => {
      e.preventDefault();
      warnPasteBlocked();
    });
    input.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
        e.preventDefault();
        warnPasteBlocked();
      }
    });
    input.addEventListener('compositionstart', () => {
      isComposing = true;
    });
    input.addEventListener('compositionend', () => {
      isComposing = false;
      lastValidValue = input.value || '';
    });
    input.addEventListener('input', (e) => {
      if (e.isComposing || isComposing) return;
      const current = input.value || '';
      if (current.length - lastValidValue.length >= 2) {
        input.value = lastValidValue;
        warnPasteBlocked();
        return;
      }
      lastValidValue = current;
    });
  });
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
        const targetSid = mockData.currentUser.studentId || doc.studentId || '';
        const sidMatch5 = String(targetSid).trim().match(/^(\d)(\d{2})\d{2}$/);
        const sidMatch4 = String(targetSid).trim().match(/^(\d)(\d)\d{2}$/);
        const resolvedGrade = Number(mockData.currentUser.grade) || (sidMatch5 ? Number(sidMatch5[1]) : (sidMatch4 ? Number(sidMatch4[1]) : null));
        const resolvedClassNo = Number(mockData.currentUser.classNo) || (sidMatch5 ? Number(sidMatch5[2]) : (sidMatch4 ? Number(sidMatch4[2]) : null));
        await gasApi.post('mark_document_submitted', {
          remote_id: docId,
          student_id: targetSid,
          grade: resolvedGrade,
          class_no: resolvedClassNo,
          submitted_by: mockData.currentUser.studentName || mockData.currentUser.studentId
        });
      } catch (err) {
        showToast(`서버 동기화 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    doc.status = 'submitted';
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    doc.submittedAt = `${kst.getUTCHours()}:${String(kst.getUTCMinutes()).padStart(2, '0')} 제출`;
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
      changeBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>${changedItems.map(c => _escStudentHtml(c.period) + '교시').join(', ')} 변동`;
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
        <span class="text-[10px] font-semibold text-amber-700">${_escStudentHtml(t.period)}교시</span>
        <p class="text-xs font-extrabold text-amber-900 mt-0.5">${_escStudentHtml(t.subject)}</p>
        <p class="text-[10px] text-amber-700 font-medium truncate">${_escStudentHtml(t.teacher)}</p>
      </div>
      <div class="mt-2 pt-1 border-t border-amber-200/80"><span class="text-[9px] text-slate-400 line-through block">기존: ${_escStudentHtml(t.original)}</span></div>
    </div>
  ` : `
    <div class="shrink-0 w-24 bg-slate-50 border border-slate-100 rounded-xl p-2.5 flex flex-col justify-center text-center">
      <div>
        <span class="text-[10px] font-semibold text-slate-400">${_escStudentHtml(t.period)}교시</span>
        <p class="text-xs font-bold text-slate-800 mt-0.5">${_escStudentHtml(t.subject)}</p>
        <p class="text-[10px] text-slate-500 font-medium truncate">${_escStudentHtml(t.teacher)}</p>
      </div>
    </div>
  `).join('');
}

function switchMealTab(tab) {
  state.activeMealTab = tab;
  const activeCls = "px-2.5 py-1 rounded-md bg-white text-indigo-600 shadow-xs transition-all whitespace-nowrap shrink-0";
  const inactiveCls = "px-2.5 py-1 rounded-md text-slate-500 hover:text-slate-800 transition-all whitespace-nowrap shrink-0";
  ['mealTab', 'teacherMealTab'].forEach((prefix) => {
    const lunchBtn = document.getElementById(`${prefix}-lunch`);
    const dinnerBtn = document.getElementById(`${prefix}-dinner`);
    if (lunchBtn) lunchBtn.className = tab === 'lunch' ? activeCls : inactiveCls;
    if (dinnerBtn) dinnerBtn.className = tab === 'dinner' ? activeCls : inactiveCls;
  });
  renderMeals();
}

function renderMeals() {
  const meal = mockData.meals && mockData.meals[state.activeMealTab];
  const html = !meal
    ? `<div class="py-5 text-center text-xs text-slate-400">등록된 ${state.activeMealTab === 'lunch' ? '중식' : '석식'} 식단표가 없습니다.</div>`
    : `
      <div class="flex items-center justify-between mb-2">
        <span class="text-[11px] font-bold text-slate-700">🍽️ ${state.activeMealTab === 'lunch' ? '중식 식단' : '석식 식단'}</span>
        <span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">${_escStudentHtml(meal.calories || '-')}</span>
      </div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 py-1">
        ${(meal.menu || []).map(item => `
          <div class="flex items-center justify-between text-xs py-0.5 border-b border-slate-100/80">
            <span class="font-medium text-slate-800">${_escStudentHtml(item.name)}</span>
            ${item.allergy ? `<span class="text-[9px] text-slate-400 font-mono">(${_escStudentHtml(item.allergy)})</span>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="mt-2.5 pt-2 border-t border-slate-200/70 text-[9px] text-slate-400 leading-tight">
        ℹ️ <span class="font-semibold">알레르기 번호 안내:</span> ${_escStudentHtml(meal.allergyNotice || '나이스(NEIS) 식단 연동됨')}
      </div>
    `;
  ['mealContentBox', 'teacherMealContentBox'].forEach((id) => {
    const container = document.getElementById(id);
    if (container) container.innerHTML = html;
  });
  if (typeof renderAcademicSchedules === 'function') renderAcademicSchedules();
}

let _allMealsModalFilter = 'all';
let _allMealsModalDate = '';

function _shiftYmdDate(dateStr, deltaDays) {
  const m = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(deltaDays)));
  return dt.toISOString().slice(0, 10);
}

function _formatMealDateWithDay(dateStr) {
  const s = String(dateStr || '').trim().slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '-';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${s} (${days[dt.getDay()]})`;
}

function _renderAllMealsModalList(filter = _allMealsModalFilter, selectedDate = _allMealsModalDate) {
  const listEl = document.getElementById('allMealsModalList');
  const subEl = document.getElementById('allMealsModalSubtitle');
  if (!listEl) return;

  const rawMeals = Array.isArray(mockData.allMeals) ? mockData.allMeals : [];
  const filtered = rawMeals.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    const typeStr = String(m.meal_type || '');
    if (filter === 'lunch' && !typeStr.includes('중식')) return false;
    if (filter === 'dinner' && !typeStr.includes('석식')) return false;
    if (selectedDate) {
      const dateKey = String(m.meal_date || m.date || '').trim().slice(0, 10);
      if (dateKey !== selectedDate) return false;
    }
    return true;
  });

  const dateMap = new Map();
  filtered.forEach((m) => {
    const dateKey = String(m.meal_date || m.date || '').trim().slice(0, 10);
    if (!dateKey) return;
    if (!dateMap.has(dateKey)) dateMap.set(dateKey, []);
    dateMap.get(dateKey).push(m);
  });

  const sortedDates = Array.from(dateMap.keys()).sort((a, b) => a.localeCompare(b));
  if (subEl) {
    if (selectedDate) {
      subEl.innerText = `${_formatMealDateWithDay(selectedDate)} · 전후 7일 내 식단 조회`;
    } else {
      subEl.innerText = `오늘 기준 전후 7일 (총 ${sortedDates.length}일치 식단)`;
    }
  }

  if (sortedDates.length === 0) {
    if (selectedDate) {
      listEl.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">선택한 날짜(${_escStudentHtml(selectedDate)})에 등록된 급식 식단표가 없습니다.</div>`;
    } else {
      const filterLabel = filter === 'lunch' ? '중식 ' : (filter === 'dinner' ? '석식 ' : '');
      listEl.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">등록된 ${filterLabel}식단 데이터가 없습니다.</div>`;
    }
    return;
  }

  const todayStr = typeof _getLocalTodayStr === 'function' ? _getLocalTodayStr() : '';

  listEl.innerHTML = sortedDates.map((dateKey) => {
    const isToday = dateKey === todayStr;
    const items = dateMap.get(dateKey);
    const lunch = items.find((m) => String(m.meal_type || '').includes('중식'));
    const dinner = items.find((m) => String(m.meal_type || '').includes('석식'));
    const sections = [];
    if (lunch && (filter === 'all' || filter === 'lunch')) {
      sections.push({ label: '중식', meal: lunch });
    }
    if (dinner && (filter === 'all' || filter === 'dinner')) {
      sections.push({ label: '석식', meal: dinner });
    }
    if (sections.length === 0 && items.length > 0) {
      items.forEach((m) => sections.push({ label: String(m.meal_type || '급식'), meal: m }));
    }

    const cardCls = isToday
      ? 'p-3.5 rounded-2xl border border-indigo-300 bg-indigo-50/30 space-y-2.5'
      : 'p-3.5 rounded-2xl border border-slate-200/80 bg-white space-y-2.5';

    return `
      <div class="${cardCls}" ${isToday ? 'data-meal-today="true"' : ''}>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-900">${_escStudentHtml(_formatMealDateWithDay(dateKey))}</span>
          ${isToday ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-600 text-white shrink-0">오늘</span>' : ''}
        </div>
        <div class="space-y-2">
          ${sections.map(({ label, meal }) => {
            const menuLines = String(meal.menu_text || '').split('\n').map(s => s.trim()).filter(Boolean);
            return `
              <div class="bg-white/80 rounded-xl p-2.5 border border-slate-100">
                <div class="flex items-center justify-between mb-1.5">
                  <span class="text-[11px] font-bold text-slate-700">🍽️ ${_escStudentHtml(label)}</span>
                  <span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100">${_escStudentHtml(meal.calories || '-')}</span>
                </div>
                ${menuLines.length > 0
                  ? `<div class="grid grid-cols-2 gap-x-2.5 gap-y-1 text-[11px] text-slate-700">${menuLines.map(line => `<div class="truncate py-0.5 border-b border-slate-100/80">${_escStudentHtml(line)}</div>`).join('')}</div>`
                  : `<div class="text-[11px] text-slate-400">메뉴 정보가 없습니다.</div>`}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function _syncAllMealsDateControls() {
  if (typeof document === 'undefined') return;
  const todayStr = typeof _getLocalTodayStr === 'function' ? _getLocalTodayStr() : '';
  const dateInput = document.getElementById('allMealsDateInput');
  if (dateInput) {
    if (todayStr) {
      dateInput.min = _shiftYmdDate(todayStr, -7);
      dateInput.max = _shiftYmdDate(todayStr, 7);
    }
    dateInput.value = _allMealsModalDate || '';
  }
  const allRangeBtn = document.getElementById('allMealsAllRangeBtn');
  if (allRangeBtn) {
    allRangeBtn.className = !_allMealsModalDate
      ? 'px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white text-[11px] font-bold shrink-0 whitespace-nowrap transition-colors'
      : 'px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-[11px] font-bold shrink-0 whitespace-nowrap transition-colors';
  }
}

function _scrollToTodayMealCard() {
  if (typeof document === 'undefined') return;
  const listEl = document.getElementById('allMealsModalList');
  if (!listEl) return;
  const todayCard = listEl.querySelector('[data-meal-today="true"]');
  if (todayCard && typeof todayCard.scrollIntoView === 'function') {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        todayCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    } else {
      todayCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function selectAllMealsDate(dateStr) {
  _allMealsModalDate = String(dateStr || '').trim().slice(0, 10);
  _syncAllMealsDateControls();
  _renderAllMealsModalList(_allMealsModalFilter, _allMealsModalDate);
}

function stepAllMealsDate(deltaDays) {
  const baseDate = _allMealsModalDate || (typeof _getLocalTodayStr === 'function' ? _getLocalTodayStr() : '');
  const nextDate = _shiftYmdDate(baseDate, deltaDays);
  if (nextDate) selectAllMealsDate(nextDate);
}

function resetAllMealsDateFilter() {
  selectAllMealsDate('');
  _scrollToTodayMealCard();
}

function filterAllMealsModal(filter) {
  _allMealsModalFilter = filter || 'all';
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.all-meals-filter-btn').forEach((btn) => {
      const isActive = btn.dataset.filter === _allMealsModalFilter;
      btn.className = isActive
        ? 'all-meals-filter-btn px-3 py-1.5 rounded-full text-xs font-bold bg-indigo-600 text-white transition-colors'
        : 'all-meals-filter-btn px-3 py-1.5 rounded-full text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors';
    });
  }
  _renderAllMealsModalList(_allMealsModalFilter, _allMealsModalDate);
}

function openAllMealsModal() {
  if (typeof document === 'undefined') return;
  const modal = document.getElementById('allMealsModal');
  const listEl = document.getElementById('allMealsModalList');
  if (!modal || !listEl) return;

  const todayStr = typeof _getLocalTodayStr === 'function' ? _getLocalTodayStr() : '';
  _allMealsModalDate = todayStr;
  _syncAllMealsDateControls();
  filterAllMealsModal('all');
  modal.classList.remove('hidden');
  _scrollToTodayMealCard();
}

function closeAllMealsModal() {
  if (typeof document === 'undefined') return;
  const modal = document.getElementById('allMealsModal');
  if (modal) modal.classList.add('hidden');
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
        options.map(opt => `<option value="${_escStudentHtml(opt)}">${_escStudentHtml(opt)}</option>`).join('');
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
    endEl.min = startEl.value;
    endEl.disabled = true;
  } else {
    endEl.disabled = false;
    const startVal = startEl.value || '';
    const endVal = endEl.value || '';
    endEl.min = startVal;
    if (startVal && (!endVal || startVal > endVal)) {
      endEl.value = startVal;
    }
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
      await gasApi.post('delete_attendance', { remote_id: attId, role: state.activeRole });
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
  if (typeof ensurePwaPushPermissionForAction === 'function') ensurePwaPushPermissionForAction('출결 보고');
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
  const endEl = document.getElementById('attEndDate');
  const eDate = isTimeLimited ? sDate : (endEl ? endEl.value : '');
  if (!isTimeLimited && sDate && (!eDate || eDate < sDate)) {
    if (endEl) {
      endEl.value = sDate;
      endEl.min = sDate;
    }
    showToast('종료일은 시작일보다 이전일 수 없어 시작일과 같게 맞췄습니다.', '⚠️');
    return;
  }
  const reason = document.getElementById('attReason').value.trim();
  const combinedType = `${state.selectedAttCategory}${state.selectedAttSubType}`;
  const periodStr = isTimeLimited
    ? `${sDate} (${periodInfo})`
    : (sDate === eDate ? sDate : `${sDate} ~ ${eDate}`);

  const editingId = state.editingAttendanceId || null;
  let overwriteItem = editingId
    ? (mockData.attendanceHistory.find(x => x.id === editingId) || null)
    : null;

  if (overwriteItem && (overwriteItem.docStatus === '교사 최종완료' || overwriteItem.confirmed)) {
    showToast('이미 담임 선생님이 확인한 출결 내역이 있어 새로 등록하거나 수정할 수 없습니다.', '⚠️');
    return;
  }

  if (!editingId) {
    const sameDateItems = mockData.attendanceHistory.filter(item => _doesAttItemMatchDate(item, sDate));
    if (sameDateItems.some(item => item.docStatus === '교사 최종완료' || item.confirmed)) {
      showToast('이미 담임 선생님이 확인한 출결 내역이 있어 새로 등록하거나 수정할 수 없습니다.', '⚠️');
      return;
    }
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

  const sickDays = Math.max(1, parseInt(mockData.rules.sickDays || 5, 10) || 5);
  const baseDate = eDate || sDate;
  const computedDueDate = addBusinessDays(baseDate, sickDays);

  const newDoc = {
    id: docId,
    studentId: stuId,
    studentName: stuName,
    type: 'urgency',
    dDayText: `기한 +${sickDays}영업일`,
    dDayColor: 'urgent',
    title: `${combinedType} (${periodStr})`,
    docName,
    description: reason,
    deadline: computedDueDate,
    status: 'pending',
    submittedAt: null
  };

  await withButtonLoading(submitBtn, isOverwrite ? '저장 중...' : '등록 중...', async () => {
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        const sidMatch5 = String(stuId || '').trim().match(/^(\d)(\d{2})\d{2}$/);
        const sidMatch4 = String(stuId || '').trim().match(/^(\d)(\d)\d{2}$/);
        const resolvedGrade = Number(mockData.currentUser.grade) || (sidMatch5 ? Number(sidMatch5[1]) : (sidMatch4 ? Number(sidMatch4[1]) : 1));
        const resolvedClassNo = Number(mockData.currentUser.classNo) || (sidMatch5 ? Number(sidMatch5[2]) : (sidMatch4 ? Number(sidMatch4[2]) : 1));
        await gasApi.post('submit_attendance', {
          data: {
            remote_id: attId,
            date: sDate,
            student_id: stuId,
            student_name: stuName,
            grade: resolvedGrade,
            class_no: resolvedClassNo,
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
              grade: resolvedGrade,
              class_no: resolvedClassNo,
              base_date: baseDate,
              due_date: computedDueDate,
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
    const safeId = _escStudentHtml(item.id);
    return `
      <div class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-slate-800">${_escStudentHtml(item.type)} <span class="text-[11px] font-normal text-slate-400">(${_escStudentHtml(periodLabel)})</span></span>
          <div class="flex items-center gap-1 shrink-0">
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeStyle}">${_escStudentHtml(item.docStatus)}</span>
            <button type="button" onclick="editStudentAttendance('${safeId}')" title="${isLocked ? '교사 확인 완료 건은 수정 불가' : '수정'}" class="p-1 rounded-lg transition-colors ${btnTone}" aria-label="출결 수정">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
            </button>
            <button type="button" onclick="deleteStudentAttendance('${safeId}')" title="${isLocked ? '교사 확인 완료 건은 삭제 불가' : '삭제'}" class="p-1 rounded-lg transition-colors ${delTone}" aria-label="출결 삭제">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          </div>
        </div>
        <p class="text-[11px] text-slate-600">${_escStudentHtml(item.reason)}</p>
      </div>
    `;
  }).join('');
}

// --- TAB 3: Circulars, Class Board & Class Budget ---
function switchLettersSubTab(sub) {
  const tabs = ['circulars', 'board', 'budget'];
  tabs.forEach((t) => {
    const btn = document.getElementById(`subTabBtn-${t}`);
    const sec = document.getElementById(`lettersSection-${t}`);
    if (btn) {
      btn.className = sub === t
        ? "flex-1 py-2 text-xs font-semibold rounded-lg bg-white text-indigo-600 shadow-sm transition-all"
        : "flex-1 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg transition-all";
    }
    if (sec) {
      sec.classList.toggle('hidden', sub !== t);
    }
  });
}

function openBoardNoticesTab() {
  switchBottomTab('letters');
  switchLettersSubTab('board');
}

function _getBoardSourceBadgeClass(sourceType) {
  const s = String(sourceType || '').trim();
  if (s === '학교종이') return 'bg-amber-100 text-amber-800 border border-amber-200/80';
  if (s === '학급 카톡') return 'bg-yellow-100 text-yellow-800 border border-yellow-300/80';
  return 'bg-indigo-50 text-indigo-700 border border-indigo-200/80';
}

function _safeHttpUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

function _formatBoardDate(rawDate) {
  const s = String(rawDate || '').trim();
  if (!s) return '';
  return s.slice(0, 10);
}

function renderBoardNotices() {
  const listEl = document.getElementById('boardNoticesList');
  const countEl = document.getElementById('boardNoticesCountLabel');
  const homeListEl = document.getElementById('homeBoardNoticeList');
  const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (v => String(v ?? ''));

  const published = (mockData.boardNotices || []).filter((n) => n && n.isPublished !== false);

  if (countEl) countEl.innerText = `총 ${published.length}건`;

  if (homeListEl) {
    if (published.length === 0) {
      homeListEl.innerHTML = `<div class="bg-slate-50 rounded-xl p-3 text-center text-[11px] text-slate-400">등록된 학급 공지가 없습니다.</div>`;
    } else {
      const topItems = published.slice(0, 2);
      homeListEl.innerHTML = topItems.map((n) => {
        const badgeCls = _getBoardSourceBadgeClass(n.sourceType);
        const dateLabel = _formatBoardDate(n.publishedAt);
        return `
          <div onclick="openBoardNoticeModal('${esc(n.id)}')" class="p-2.5 rounded-xl bg-slate-50/90 hover:bg-indigo-50/50 border border-slate-200/70 transition-all cursor-pointer space-y-1">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1 min-w-0">
                <span class="text-[9px] font-bold px-1.5 py-0.5 rounded ${badgeCls} shrink-0">${esc(n.sourceType || '담임 공지')}</span>
                ${n.isPinned ? '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 shrink-0">📌 고정</span>' : ''}
              </div>
              <span class="text-[10px] text-slate-400 shrink-0">${esc(dateLabel)}</span>
            </div>
            <p class="text-xs font-bold text-slate-800 truncate">${esc(n.title || '제목 없음')}</p>
            ${n.summary ? `<p class="text-[11px] text-slate-600 line-clamp-1">${esc(n.summary)}</p>` : ''}
          </div>
        `;
      }).join('');
    }
  }

  if (!listEl) return;
  if (published.length === 0) {
    listEl.innerHTML = `<div class="bg-white p-5 rounded-2xl border border-slate-200/80 text-center text-xs text-slate-400">등록된 학급 공지가 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = published.map((n) => {
    const badgeCls = _getBoardSourceBadgeClass(n.sourceType);
    const dateLabel = _formatBoardDate(n.publishedAt);
    const safeUrl = _safeHttpUrl(n.sourceUrl);
    return `
      <div onclick="openBoardNoticeModal('${esc(n.id)}')" class="bg-white p-3.5 rounded-2xl border ${n.isPinned ? 'border-amber-300/90 ring-1 ring-amber-100' : 'border-slate-200/80'} shadow-xs hover:border-indigo-300 transition-all cursor-pointer space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeCls}">${esc(n.sourceType || '담임 공지')}</span>
            ${n.isPinned ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-600">📌 고정</span>' : ''}
          </div>
          <span class="text-[10px] text-slate-400 shrink-0">${esc(dateLabel)}</span>
        </div>
        <h4 class="text-xs font-bold text-slate-900 leading-snug">${esc(n.title || '제목 없음')}</h4>
        ${n.summary ? `<p class="text-[11px] text-slate-600 leading-relaxed">${esc(n.summary)}</p>` : ''}
        <div class="flex items-center justify-between pt-1">
          <span class="text-[10px] text-slate-400">${esc(n.authorName || '담임교사')}</span>
          <div class="flex items-center gap-2">
            ${safeUrl ? `<a href="${esc(safeUrl)}" onclick="event.stopPropagation()" target="_blank" rel="noopener noreferrer" class="text-[10px] font-bold text-indigo-600 hover:underline bg-indigo-50 px-2 py-0.5 rounded-lg">원문 링크 ↗</a>` : ''}
            <span class="text-[10px] font-bold text-slate-500">상세 보기 →</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function _linkifyBoardContent(rawText) {
  const esc = typeof _escapeNoticeHtml === 'function'
    ? _escapeNoticeHtml
    : (v => String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'));
  const escaped = esc(String(rawText || ''));
  return escaped.replace(/https?:\/\/[^\s<>"')\]\}]+/gi, (match) => {
    const safe = _safeHttpUrl(match);
    if (!safe) return match;
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 underline break-all hover:text-indigo-800">${safe}</a>`;
  });
}

function _extractBoardImageUrls(notice) {
  const candidates = [];
  if (notice && notice.sourceUrl) candidates.push(String(notice.sourceUrl));
  const contentStr = String((notice && notice.content) || '');
  const matches = contentStr.match(/https?:\/\/[^\s<>"')\]\}]+/gi) || [];
  candidates.push(...matches);

  const seen = new Set();
  const images = [];
  for (const raw of candidates) {
    const safe = _safeHttpUrl(raw);
    if (!safe || seen.has(safe)) continue;
    const pathOnly = safe.split(/[?#]/)[0];
    if (/\.(jpe?g|png|webp)$/i.test(pathOnly)) {
      seen.add(safe);
      images.push(safe);
    }
  }
  return images;
}

function openBoardNoticeModal(noticeId) {
  const n = (mockData.boardNotices || []).find((x) => x.id === noticeId);
  if (!n) return;
  const modal = document.getElementById('boardNoticeModal');
  if (!modal) return;

  const badgeEl = document.getElementById('boardModalSourceBadge');
  const pinEl = document.getElementById('boardModalPinnedBadge');
  const titleEl = document.getElementById('boardModalTitle');
  const metaEl = document.getElementById('boardModalMeta');
  const summaryBoxEl = document.getElementById('boardModalSummaryBox');
  const summaryEl = document.getElementById('boardModalSummary');
  const contentEl = document.getElementById('boardModalContent');
  const imagesBoxEl = document.getElementById('boardModalImagesBox');
  const imagesEl = document.getElementById('boardModalImages');
  const linkEl = document.getElementById('boardModalSourceLink');

  if (badgeEl) {
    badgeEl.className = `text-[10px] font-bold px-2 py-0.5 rounded-md ${_getBoardSourceBadgeClass(n.sourceType)}`;
    badgeEl.innerText = n.sourceType || '담임 공지';
  }
  if (pinEl) {
    pinEl.classList.toggle('hidden', !n.isPinned);
  }
  if (titleEl) titleEl.innerText = n.title || '제목 없음';
  if (metaEl) {
    const parts = [n.authorName || '담임교사', _formatBoardDate(n.publishedAt)].filter(Boolean);
    metaEl.innerText = parts.join(' · ');
  }
  if (summaryBoxEl && summaryEl) {
    const hasSummary = Boolean(String(n.summary || '').trim());
    summaryBoxEl.classList.toggle('hidden', !hasSummary);
    summaryEl.innerText = n.summary || '';
  }
  if (contentEl) {
    contentEl.innerHTML = _linkifyBoardContent(n.content || n.summary || '상세 본문 내용이 없습니다.');
  }
  if (imagesBoxEl && imagesEl) {
    const imgUrls = _extractBoardImageUrls(n);
    if (imgUrls.length > 0) {
      imagesEl.innerHTML = imgUrls
        .map((url) => {
          const safeUrl = _escStudentHtml(url);
          return (
            `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="block rounded-xl overflow-hidden border border-slate-200 bg-white hover:border-indigo-300 transition-all">` +
            `<img src="${safeUrl}" alt="공지 미리보기 이미지" loading="lazy" class="w-full max-h-64 object-contain bg-white" />` +
            `</a>`
          );
        })
        .join('');
      imagesBoxEl.classList.remove('hidden');
    } else {
      imagesEl.innerHTML = '';
      imagesBoxEl.classList.add('hidden');
    }
  }
  if (linkEl) {
    const safeUrl = _safeHttpUrl(n.sourceUrl);
    if (safeUrl) {
      linkEl.href = safeUrl;
      linkEl.classList.remove('hidden');
    } else {
      linkEl.removeAttribute('href');
      linkEl.classList.add('hidden');
    }
  }
  modal.classList.remove('hidden');
}

function closeBoardNoticeModal() {
  const modal = document.getElementById('boardNoticeModal');
  if (modal) modal.classList.add('hidden');
}

function openCircularAttachment(event, rawUrl) {
  if (event) event.stopPropagation();
  const safeUrl = typeof normalizeCircularAttachmentUrl === 'function'
    ? normalizeCircularAttachmentUrl(rawUrl)
    : _safeHttpUrl(rawUrl);
  if (!safeUrl) {
    if (event) event.preventDefault();
    return false;
  }
  try {
    const opened = window.open(safeUrl, '_blank', 'noopener,noreferrer');
    if (opened) {
      if (event) event.preventDefault();
      return false;
    }
  } catch (_) {
    // Fallback to native <a target="_blank"> navigation
  }
  return true;
}

function _isStudentReadOnlyCircular(c) {
  if (!c) return false;
  const reqReply = c.requiresReply !== false && c.requires_reply !== false && String(c.requires_reply ?? '') !== '0';
  if (reqReply) return false;
  const sigMode = _normalizeNoticeSignatureMode(c.signatureMode ?? c.signature_mode, false);
  if (sigMode !== 'none') return false;
  const fields = typeof _parseNoticeReplySchema === 'function'
    ? _parseNoticeReplySchema(c.replySchemaJson || c.reply_schema_json, c.replyFields || c.reply_fields)
    : [];
  return fields.length === 0;
}

function renderCirculars() {
  const list = document.getElementById('circularsList');
  if (!list) return;
  const publishedList = (mockData.circulars || []).filter(c => c.isPublished !== false);
  if (publishedList.length === 0) {
    list.innerHTML = `<div class="bg-white p-5 rounded-2xl border border-slate-200/80 text-center text-xs text-slate-400">등록된 가정통신문이 없습니다.</div>`;
    return;
  }
  const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (s => String(s ?? ''));
  list.innerHTML = publishedList.map(c => {
    const isReadOnly = _isStudentReadOnlyCircular(c);
    const isSubmitted = !isReadOnly && (c.status === 'submitted' || Boolean(c.myReply));
    const badgeClass = isSubmitted
      ? 'bg-emerald-100 text-emerald-700'
      : ((isReadOnly || c.requiresReply === false) ? 'bg-slate-100 text-slate-600' : 'bg-red-100 text-red-600');
    const badgeText = isSubmitted ? '제출 완료' : (isReadOnly ? '열람용 (회신 불필요)' : (c.requiresReply === false ? '안내' : '미제출'));
    const actionText = (isSubmitted || isReadOnly) ? '열람 →' : (c.requiresReply === false ? '확인 →' : '회신·서명 →');
    const attachmentUrl = typeof normalizeCircularAttachmentUrl === 'function'
      ? normalizeCircularAttachmentUrl(c)
      : _safeHttpUrl(c.attachmentUrl);
    return `
      <div onclick="openCircularModal('${esc(c.id)}')" class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs hover:border-indigo-300 transition-all cursor-pointer flex items-center justify-between gap-3">
        <div class="space-y-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeClass}">${badgeText}</span>
            <span class="text-[10px] text-slate-400">${esc(c.deadline)}</span>
            ${attachmentUrl ? `<a href="${esc(attachmentUrl)}" onclick="return openCircularAttachment(event, this.href)" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-0.5 text-[10px] font-bold text-indigo-600 hover:underline bg-indigo-50 px-2 py-0.5 rounded-lg">📄 원본 PDF ↗</a>` : ''}
          </div>
          <h4 class="text-xs font-bold text-slate-800">${esc(c.title)}</h4>
        </div>
        <span class="text-xs text-indigo-600 font-bold shrink-0">${actionText}</span>
      </div>
    `;
  }).join('');
}

function _renderDynamicCircularField(field, idx) {
  const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (s => String(s ?? ''));
  const reqMark = field.required ? `<span class="text-urgent-600 font-bold ml-0.5">*</span>` : '';
  const fieldNameAttr = `circular_dyn_${idx}`;

  if (field.type === 'radio') {
    const opts = field.options.length > 0 ? field.options : [{ label: '예', value: '예' }, { label: '아니오', value: '아니오' }];
    return `
      <div class="space-y-1.5">
        <label class="block text-[11px] font-bold text-slate-700">${esc(field.label)}${reqMark}</label>
        <div class="grid ${opts.length <= 2 ? 'grid-cols-2' : 'grid-cols-1'} gap-2">
          ${opts.map((opt) => `
            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 cursor-pointer has-[:checked]:bg-indigo-50 has-[:checked]:border-indigo-600 has-[:checked]:text-indigo-700 text-xs font-semibold">
              <input class="text-indigo-600 focus:ring-indigo-500" name="${esc(fieldNameAttr)}" type="radio" value="${esc(opt.value)}"/>
              <span>${esc(opt.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  if (field.type === 'checkbox') {
    const opts = field.options.length > 0 ? field.options : [{ label: '확인함', value: '확인함' }];
    return `
      <div class="space-y-1.5">
        <label class="block text-[11px] font-bold text-slate-700">${esc(field.label)}${reqMark}</label>
        <div class="space-y-1.5">
          ${opts.map((opt) => `
            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 cursor-pointer has-[:checked]:bg-indigo-50 has-[:checked]:border-indigo-600 has-[:checked]:text-indigo-700 text-xs font-medium">
              <input class="rounded text-indigo-600 focus:ring-indigo-500" name="${esc(fieldNameAttr)}" type="checkbox" value="${esc(opt.value)}"/>
              <span>${esc(opt.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  if (field.type === 'textarea') {
    return `
      <div class="space-y-1">
        <label class="block text-[11px] font-bold text-slate-700">${esc(field.label)}${reqMark}</label>
        <textarea class="w-full text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none" id="${esc(fieldNameAttr)}" placeholder="${esc(field.placeholder || '내용을 입력해 주세요')}" rows="3"></textarea>
      </div>
    `;
  }

  return `
    <div class="space-y-1">
      <label class="block text-[11px] font-bold text-slate-700">${esc(field.label)}${reqMark}</label>
      <input class="w-full text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none" id="${esc(fieldNameAttr)}" placeholder="${esc(field.placeholder || '입력해 주세요')}" type="text"/>
    </div>
  `;
}

function _getCircularDefaultTextValue(field) {
  if (!field || field.type !== 'text') return '';
  const cu = mockData.currentUser || {};
  const studentName = String(cu.studentName || '').trim();
  const grade = String(cu.grade || '').trim();
  const classNo = String(cu.classNo || '').trim();
  let studentNo = String(cu.studentNo || '').trim();
  if (!studentNo && cu.studentId && Array.isArray(mockData.students)) {
    const found = mockData.students.find(s => String(s.student_id || '') === String(cu.studentId));
    if (found && found.number !== undefined && found.number !== null && String(found.number).trim()) {
      studentNo = String(found.number).trim();
    }
  }

  const labelCompact = String(field.label || '').toLowerCase().replace(/[\s/·_-]+/g, '');
  const nameCompact = String(field.name || '').toLowerCase().replace(/[\s/·_-]+/g, '');
  const combined = `${labelCompact} ${nameCompact}`;
  const isGuardian = combined.includes('학부모') || combined.includes('보호자') || combined.includes('교사');

  if (!isGuardian && (combined.includes('학생성명') || combined.includes('학생이름') || combined.includes('studentname') || labelCompact === '성명' || labelCompact === '이름')) {
    return studentName;
  }
  if (combined.includes('학급번호') || combined.includes('학년반번호') || combined.includes('학반번호') || combined.includes('반번호') || combined.includes('학번')) {
    return [grade ? `${grade}학년` : '', classNo ? `${classNo}반` : '', studentNo ? `${studentNo}번` : ''].filter(Boolean).join(' ');
  }
  if (combined.includes('학년반') || labelCompact === '학급' || labelCompact === '반') {
    return [grade ? `${grade}학년` : '', classNo ? `${classNo}반` : ''].filter(Boolean).join(' ');
  }
  if (labelCompact === '번호' || labelCompact === '출석번호' || nameCompact === 'studentno') {
    return studentNo ? `${studentNo}번` : '';
  }
  if (labelCompact === '학년') {
    return grade ? `${grade}학년` : '';
  }
  return '';
}

function _normalizeNoticeSignatureMode(rawMode, requiresReply = true) {
  const raw = String(rawMode ?? '').trim().toLowerCase();
  if (raw === 'none' || raw === '0' || raw === 'no' || raw === 'false') return 'none';
  if (raw === 'student' || raw === 'student_only') return 'student';
  if (raw === 'both' || raw === '2') return 'both';
  if (raw === 'parent' || raw === 'parent_only' || raw === 'single' || raw === '1') return 'parent';
  return requiresReply ? 'parent' : 'none';
}

function openCircularModal(id) {
  state.currentCircularId = id;
  const c = mockData.circulars.find(x => x.id === id);
  if (!c) return;
  document.getElementById('modalCircularNumber').innerText = c.docNum;
  document.getElementById('modalCircularTitle').innerText = c.title;
  document.getElementById('modalCircularContent').innerText = c.content;
  document.getElementById('modalCircularMeta').innerHTML = (c.meta || []).map(m => `<p>• ${_escapeNoticeHtml ? _escapeNoticeHtml(m) : m}</p>`).join('');

  const attachmentUrl = typeof normalizeCircularAttachmentUrl === 'function'
    ? normalizeCircularAttachmentUrl(c)
    : _safeHttpUrl(c.attachmentUrl);
  const attachLinkEl = document.getElementById('modalCircularAttachmentLink');
  const attachEmptyEl = document.getElementById('modalCircularAttachmentEmpty');
  if (attachLinkEl) {
    if (attachmentUrl) {
      attachLinkEl.href = attachmentUrl;
      attachLinkEl.classList.remove('hidden');
    } else {
      attachLinkEl.removeAttribute('href');
      attachLinkEl.classList.add('hidden');
    }
  }
  if (attachEmptyEl) {
    attachEmptyEl.classList.toggle('hidden', Boolean(attachmentUrl));
  }

  const submittedView = document.getElementById('modalCircularSubmittedView');
  const formView = document.getElementById('modalCircularFormView');
  const dynFieldsEl = document.getElementById('modalCircularDynamicFields');
  const sigSection = document.getElementById('modalCircularSignatureSection');
  const singleSigWrap = document.getElementById('modalCircularSingleSigWrap');
  const bothSigWrap = document.getElementById('modalCircularBothSigWrap');
  const readOnlyNote = document.getElementById('modalCircularReadOnlyNote');
  const submitBtn = document.getElementById('modalCircularSubmitBtn');

  const isSubmitted = c.status === 'submitted' || Boolean(c.myReply);
  const parsedFields = typeof _parseNoticeReplySchema === 'function'
    ? _parseNoticeReplySchema(c.replySchemaJson, c.replyFields)
    : [];

  if (isSubmitted) {
    if (submittedView) submittedView.classList.remove('hidden');
    if (formView) formView.classList.add('hidden');

    const reply = c.myReply || {};
    const signedAtEl = document.getElementById('modalCircularSubmittedAt');
    if (signedAtEl) signedAtEl.innerText = reply.signedAt ? `제출일시: ${reply.signedAt}` : '';

    const answersEl = document.getElementById('modalCircularSubmittedAnswers');
    if (answersEl) {
      const esc = typeof _escapeNoticeHtml === 'function' ? _escapeNoticeHtml : (s => String(s ?? ''));
      let parsedData = {};
      if (reply.replyDataJson) {
        try {
          parsedData = typeof reply.replyDataJson === 'string'
            ? JSON.parse(reply.replyDataJson)
            : (reply.replyDataJson || {});
        } catch (_) {
          parsedData = {};
        }
      }
      const rowsHtml = [];
      if (parsedData && typeof parsedData === 'object' && Object.keys(parsedData).length > 0) {
        const labelByName = {};
        parsedFields.forEach(f => { labelByName[f.name] = f.label; });
        Object.entries(parsedData).forEach(([k, v]) => {
          const valText = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          if (!valText) return;
          const label = labelByName[k] || (k === 'consent' ? '참가 동의 여부' : k);
          rowsHtml.push(`<div><span class="font-bold text-slate-600">${esc(label)}:</span> <span class="text-slate-800">${esc(valText)}</span></div>`);
        });
      }
      if (rowsHtml.length === 0 && reply.consent) {
        rowsHtml.push(`<div><span class="font-bold text-slate-600">회신 선택:</span> <span class="text-slate-800">${esc(reply.consent)}</span></div>`);
      }
      if (rowsHtml.length === 0) {
        rowsHtml.push(`<div class="text-slate-500">제출이 완료되었습니다.</div>`);
      }
      answersEl.innerHTML = rowsHtml.join('');
    }

    const sigWrap = document.getElementById('modalCircularSubmittedSigWrap');
    const studentSigBox = document.getElementById('modalCircularSubmittedStudentSigBox');
    const studentSigImg = document.getElementById('modalCircularSubmittedStudentSigImg');
    const parentSigBox = document.getElementById('modalCircularSubmittedParentSigBox');
    const sigLabel = document.getElementById('modalCircularSubmittedSigLabel');
    const sigImg = document.getElementById('modalCircularSubmittedSigImg');
    const studentSigResolved = _resolveDriveImageUrls(reply.studentSignatureUrl);
    const parentSigResolved = _resolveDriveImageUrls(reply.signatureUrl);
    const hasStudentSig = Boolean(studentSigResolved.primary);
    const hasParentSig = Boolean(parentSigResolved.primary);

    if (studentSigBox && studentSigImg) {
      if (hasStudentSig) {
        _applyDriveImageWithFallback(studentSigImg, reply.studentSignatureUrl);
        studentSigBox.classList.remove('hidden');
      } else {
        studentSigImg.removeAttribute('src');
        studentSigBox.classList.add('hidden');
      }
    }
    if (parentSigBox && sigImg) {
      if (hasParentSig) {
        _applyDriveImageWithFallback(sigImg, reply.signatureUrl);
        parentSigBox.classList.remove('hidden');
      } else {
        sigImg.removeAttribute('src');
        parentSigBox.classList.add('hidden');
      }
    }
    if (sigLabel) {
      const submittedSigMode = _normalizeNoticeSignatureMode(c.signatureMode, c.requiresReply !== false);
      if (hasStudentSig && !hasParentSig) {
        sigLabel.innerText = '학생 전자서명';
      } else if (hasStudentSig || submittedSigMode === 'both') {
        sigLabel.innerText = '학부모(보호자) 전자서명';
      } else if (submittedSigMode === 'student') {
        sigLabel.innerText = '학생 전자서명';
      } else {
        sigLabel.innerText = '학부모(보호자) 전자서명';
      }
    }
    if (sigWrap) {
      sigWrap.classList.toggle('hidden', !hasStudentSig && !hasParentSig);
    }
  } else {
    if (submittedView) submittedView.classList.add('hidden');
    if (formView) formView.classList.remove('hidden');

    let activeFields = parsedFields;
    if (activeFields.length === 0 && c.requiresReply !== false) {
      activeFields = [{
        name: 'consent',
        label: '참가 동의 여부',
        type: 'radio',
        required: true,
        options: [
          { label: '동의 (참가함)', value: '동의' },
          { label: '미동의 (불참)', value: '미동의' }
        ]
      }];
    }
    state.currentCircularFields = activeFields;

    if (dynFieldsEl) {
      dynFieldsEl.innerHTML = activeFields.map((f, idx) => _renderDynamicCircularField(f, idx)).join('');
      dynFieldsEl.classList.toggle('hidden', activeFields.length === 0);
      activeFields.forEach((f, idx) => {
        if (f.type !== 'text') return;
        const inputEl = document.getElementById(`circular_dyn_${idx}`);
        if (inputEl && !inputEl.value.trim()) {
          const defaultVal = _getCircularDefaultTextValue(f);
          if (defaultVal) inputEl.value = defaultVal;
        }
      });
    }

    const sigMode = _normalizeNoticeSignatureMode(c.signatureMode, c.requiresReply !== false);
    const needsSig = sigMode !== 'none';
    const isBothSig = sigMode === 'both';
    const singleSigTitle = document.getElementById('modalCircularSingleSigTitle');
    const singleSigPh = document.getElementById('signaturePlaceholder');
    const singleSigHint = document.getElementById('modalCircularSingleSigHint');
    if (sigMode === 'student') {
      if (singleSigTitle) singleSigTitle.innerText = '학생 전자서명';
      if (singleSigPh) singleSigPh.innerText = '학생 본인 정자(서명)를 작성해 주세요';
      if (singleSigHint) singleSigHint.innerText = '학생 본인이 손가락 또는 마우스로 정자 서명하세요.';
    } else if (sigMode === 'parent') {
      if (singleSigTitle) singleSigTitle.innerText = '학부모(보호자) 전자서명';
      if (singleSigPh) singleSigPh.innerText = '학부모(보호자) 정자(서명)를 작성해 주세요';
      if (singleSigHint) singleSigHint.innerText = '학부모(보호자)가 손가락 또는 마우스로 정자 서명하세요.';
    }
    if (sigSection) sigSection.classList.toggle('hidden', !needsSig);
    if (singleSigWrap) singleSigWrap.classList.toggle('hidden', !needsSig || isBothSig);
    if (bothSigWrap) bothSigWrap.classList.toggle('hidden', !needsSig || !isBothSig);
    if (readOnlyNote) readOnlyNote.classList.toggle('hidden', needsSig || activeFields.length > 0);
    if (submitBtn) {
      submitBtn.classList.toggle('hidden', !needsSig && activeFields.length === 0);
      submitBtn.innerText = needsSig ? '서명 및 회신 제출하기' : '회신 제출하기';
    }
    clearSignaturePad();
  }

  openModal('circularModal');
}

function closeCircularModal() {
  closeModal('circularModal');
}

function _bindSignatureCanvas(canvasId, placeholderId, stateKey) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || canvas.dataset.sigBound === '1') return;
  canvas.dataset.sigBound = '1';
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
    state[stateKey] = true;
    const ph = document.getElementById(placeholderId);
    if (ph) ph.classList.add('hidden');
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

// HTML5 Canvas Touch Electronic Signature Engine
function initSignaturePad() {
  _bindSignatureCanvas('signaturePad', 'signaturePlaceholder', 'hasDrawnSignature');
  _bindSignatureCanvas('studentSignaturePad', 'studentSignaturePlaceholder', 'hasDrawnStudentSignature');
  _bindSignatureCanvas('parentSignaturePad', 'parentSignaturePlaceholder', 'hasDrawnParentSignature');
}

function _clearSingleCanvas(canvasId, placeholderId, stateKey) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state[stateKey] = false;
  const ph = document.getElementById(placeholderId);
  if (ph) ph.classList.remove('hidden');
}

function clearSignaturePad(target) {
  if (!target || target === 'single') {
    _clearSingleCanvas('signaturePad', 'signaturePlaceholder', 'hasDrawnSignature');
  }
  if (!target || target === 'student') {
    _clearSingleCanvas('studentSignaturePad', 'studentSignaturePlaceholder', 'hasDrawnStudentSignature');
  }
  if (!target || target === 'parent') {
    _clearSingleCanvas('parentSignaturePad', 'parentSignaturePlaceholder', 'hasDrawnParentSignature');
  }
}

async function submitCircularSignature(btnEl) {
  if (typeof ensurePwaPushPermissionForAction === 'function') ensurePwaPushPermissionForAction('가정통신문 회신');
  const cId = state.currentCircularId;
  const c = mockData.circulars.find(x => x.id === cId);
  if (!c) return;
  if (c.status === 'submitted' || c.myReply) {
    showToast('이미 제출 완료된 가정통신문입니다.', '✅');
    return;
  }

  const fields = Array.isArray(state.currentCircularFields) ? state.currentCircularFields : [];
  const replyData = {};
  for (let idx = 0; idx < fields.length; idx++) {
    const f = fields[idx];
    const nameAttr = `circular_dyn_${idx}`;
    let val = '';
    if (f.type === 'radio') {
      const checked = document.querySelector(`input[name="${nameAttr}"]:checked`);
      val = checked ? checked.value : '';
    } else if (f.type === 'checkbox') {
      const checkedEls = Array.from(document.querySelectorAll(`input[name="${nameAttr}"]:checked`));
      val = checkedEls.map(el => el.value);
    } else {
      const inputEl = document.getElementById(nameAttr);
      val = inputEl ? inputEl.value.trim() : '';
    }
    const isEmpty = Array.isArray(val) ? val.length === 0 : !String(val || '').trim();
    if (f.required && isEmpty) {
      showToast(`필수 항목(${f.label})을 입력해 주세요.`, '⚠️');
      return;
    }
    replyData[f.name] = val;
  }

  const sigMode = _normalizeNoticeSignatureMode(c.signatureMode, c.requiresReply !== false);
  const needsSig = sigMode !== 'none';
  const isBothSig = sigMode === 'both';
  let signatureBase64 = '';
  let studentSignatureBase64 = '';
  let parentSignatureBase64 = '';

  if (needsSig && isBothSig) {
    if (!state.hasDrawnStudentSignature) {
      showToast('학생 전자서명란에 서명을 작성해 주세요.', '✍️');
      return;
    }
    if (!state.hasDrawnParentSignature) {
      showToast('학부모(보호자) 전자서명란에 서명을 작성해 주세요.', '✍️');
      return;
    }
    const stuCanvas = document.getElementById('studentSignaturePad');
    const parCanvas = document.getElementById('parentSignaturePad');
    studentSignatureBase64 = stuCanvas ? stuCanvas.toDataURL('image/png') : '';
    parentSignatureBase64 = parCanvas ? parCanvas.toDataURL('image/png') : '';
    signatureBase64 = parentSignatureBase64;
  } else if (sigMode === 'student') {
    if (!state.hasDrawnSignature) {
      showToast('학생 전자서명란에 서명을 작성해 주세요.', '✍️');
      return;
    }
    const canvas = document.getElementById('signaturePad');
    studentSignatureBase64 = canvas ? canvas.toDataURL('image/png') : '';
  } else if (sigMode === 'parent') {
    if (!state.hasDrawnSignature) {
      showToast('학부모(보호자) 서명란에 터치 전자서명을 작성해 주세요.', '✍️');
      return;
    }
    const canvas = document.getElementById('signaturePad');
    signatureBase64 = canvas ? canvas.toDataURL('image/png') : '';
    parentSignatureBase64 = signatureBase64;
  }

  const firstRadio = fields.find(f => f.type === 'radio');
  const consentVal = String(replyData.consent || (firstRadio ? replyData[firstRadio.name] : '') || '제출');
  const replyDataJson = JSON.stringify(replyData);
  const signedAt = typeof _getKstNowStr === 'function'
    ? _getKstNowStr()
    : new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  await withButtonLoading(btnEl, '제출 중...', async () => {
    let savedSigUrl = (sigMode === 'both' || sigMode === 'parent') ? (parentSignatureBase64 || signatureBase64) : '';
    let savedStudentSigUrl = (sigMode === 'both' || sigMode === 'student') ? studentSignatureBase64 : '';
    if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
      try {
        const payloadData = {
          notice_id: cId,
          student_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
          student_name: mockData.currentUser.studentName || '학생',
          parent_id: mockData.currentUser.userId || '',
          parent_name: mockData.currentUser.parentName || '학부모',
          signature_mode: sigMode,
          consent: consentVal,
          reply_data_json: replyDataJson,
          signature_base64: signatureBase64,
          signed_at: signedAt
        };
        if (sigMode === 'both') {
          payloadData.student_signature_base64 = studentSignatureBase64;
          payloadData.parent_signature_base64 = parentSignatureBase64;
        } else if (sigMode === 'student') {
          payloadData.student_signature_base64 = studentSignatureBase64;
        } else if (sigMode === 'parent') {
          payloadData.parent_signature_base64 = parentSignatureBase64;
        }
        const res = await gasApi.post('submit_notice_reply', { data: payloadData });
        if (res && (res.signature_drive_url || res.signature_file_id)) {
          savedSigUrl = res.signature_drive_url || res.signature_file_id;
        }
        if (res && (res.student_signature_drive_url || res.student_signature_file_id)) {
          savedStudentSigUrl = res.student_signature_drive_url || res.student_signature_file_id;
        }
      } catch (err) {
        showToast(`전자서명 저장 실패: ${err.message}`, '⚠️');
        return;
      }
    }

    c.status = 'submitted';
    c.myReply = {
      consent: consentVal,
      replyDataJson,
      signatureUrl: savedSigUrl,
      studentSignatureUrl: savedStudentSigUrl,
      signedAt
    };
    c.submittedCount = Math.min(c.totalCount || 999, (c.submittedCount || 0) + 1);
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
        <span class="text-[10px] text-slate-400">${_escStudentHtml(tx.date)} · ${_escStudentHtml(tx.store)}</span>
        <p class="text-xs font-bold text-slate-800">${_escStudentHtml(tx.title)}</p>
      </div>
      <div class="text-right">
        <p class="text-xs font-bold ${tx.type === 'income' ? 'text-indigo-600' : 'text-slate-800'}">
          ${tx.type === 'income' ? '+' : '-'}${(Number(tx.amount) || 0).toLocaleString()}원
        </p>
        <button onclick="openReceiptModal('${_escStudentHtml(tx.id)}')" class="text-[10px] text-indigo-600 hover:underline font-medium">영수증 보기</button>
      </div>
    </div>
  `).join('');
}

function openReceiptModal(txId) {
  const tx = mockData.budget.transactions.find(t => t.id === txId);
  if (!tx) return;
  const safeReceiptUrl = _safeHttpUrl(tx.receiptUrl);
  document.getElementById('receiptModalBody').innerHTML = `
    <p class="font-bold text-slate-800 text-sm border-b border-slate-200 pb-2">${_escStudentHtml(tx.store)}</p>
    <p>거래일자: ${_escStudentHtml(tx.date)}</p>
    <p>적요항목: ${_escStudentHtml(tx.title)}</p>
    <p>결제수단: ${_escStudentHtml(tx.card)}</p>
    ${safeReceiptUrl ? `<p>증빙링크: <a href="${_escStudentHtml(safeReceiptUrl)}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 underline">영수증 원본 보기</a></p>` : ''}
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

function _parseConsultationHoursRange(rawHours) {
  const fallback = {
    startMinutes: 9 * 60,
    endMinutes: 17 * 60,
    startLabel: '09:00',
    endLabel: '17:00',
    rangeLabel: '09:00~17:00'
  };
  const text = String(rawHours || '').trim();
  if (!text) return fallback;
  const match = text.match(/(\d{1,2})\s*:\s*(\d{2})\s*[~\-–—]\s*(\d{1,2})\s*:\s*(\d{2})/);
  if (!match) return fallback;
  const startH = parseInt(match[1], 10);
  const startM = parseInt(match[2], 10);
  const endH = parseInt(match[3], 10);
  const endM = parseInt(match[4], 10);
  if (
    Number.isNaN(startH) || Number.isNaN(startM) ||
    Number.isNaN(endH) || Number.isNaN(endM) ||
    startH < 0 || startH > 23 || endH < 0 || endH > 23 ||
    startM < 0 || startM > 59 || endM < 0 || endM > 59
  ) {
    return fallback;
  }
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  if (startMinutes >= endMinutes) return fallback;
  const pad2 = (n) => String(n).padStart(2, '0');
  const startLabel = `${pad2(startH)}:${pad2(startM)}`;
  const endLabel = `${pad2(endH)}:${pad2(endM)}`;
  return {
    startMinutes,
    endMinutes,
    startLabel,
    endLabel,
    rangeLabel: `${startLabel}~${endLabel}`
  };
}

function _getKstWorkingHoursStatus(consultationHours, nowMs = Date.now()) {
  const kst = new Date(Number(nowMs) + 9 * 60 * 60 * 1000);
  const kstDay = kst.getUTCDay();
  const kstHour = kst.getUTCHours();
  const kstMinute = kst.getUTCMinutes();
  const isWeekday = kstDay >= 1 && kstDay <= 5;
  const currentMinutes = kstHour * 60 + kstMinute;
  const range = _parseConsultationHoursRange(consultationHours);
  const isWorkingHours = isWeekday && currentMinutes >= range.startMinutes && currentMinutes < range.endMinutes;
  let reason = 'working';
  if (!isWeekday) {
    reason = 'weekend';
  } else if (currentMinutes < range.startMinutes) {
    reason = 'before_hours';
  } else if (currentMinutes >= range.endMinutes) {
    reason = 'after_hours';
  }
  return {
    isWorkingHours,
    isWeekday,
    reason,
    kstDay,
    kstHour,
    kstMinute,
    ...range
  };
}

function _updateCounselingWorkHoursBanner() {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById('counselingWorkHoursBanner');
  const iconEl = document.getElementById('counselingWorkHoursIcon');
  const textEl = document.getElementById('counselingWorkHoursText');
  if (!banner || !textEl) return;
  const cu = (typeof mockData !== 'undefined' && mockData.currentUser) ? mockData.currentUser : {};
  const status = _getKstWorkingHoursStatus(cu.consultationHours || '');
  if (status.isWorkingHours) {
    banner.className = 'bg-emerald-50 border border-emerald-200/70 rounded-xl px-3 py-2 text-[10px] text-emerald-800 flex items-center gap-1.5';
    if (iconEl) iconEl.textContent = '💬';
    textEl.innerHTML = `현재 <strong>근무 시간(${_escStudentHtml(status.rangeLabel)})</strong>입니다. 메시지를 남겨주시면 확인 후 순차적으로 답변해 드립니다.`;
  } else if (status.reason === 'weekend') {
    banner.className = 'bg-slate-100 rounded-xl px-3 py-2 text-[10px] text-slate-600 flex items-center gap-1.5';
    if (iconEl) iconEl.textContent = '⏰';
    textEl.innerHTML = `현재 <strong>주말(근무 외 시간)</strong>입니다. 메시지를 남겨주시면 평일 근무 시간(${_escStudentHtml(status.rangeLabel)})에 확인합니다.`;
  } else if (status.reason === 'before_hours') {
    banner.className = 'bg-slate-100 rounded-xl px-3 py-2 text-[10px] text-slate-600 flex items-center gap-1.5';
    if (iconEl) iconEl.textContent = '⏰';
    textEl.innerHTML = `현재 <strong>근무 외 시간(${_escStudentHtml(status.startLabel)} 이전)</strong>입니다. 메시지를 남겨주시면 근무 시간(${_escStudentHtml(status.rangeLabel)})에 확인합니다.`;
  } else {
    banner.className = 'bg-slate-100 rounded-xl px-3 py-2 text-[10px] text-slate-600 flex items-center gap-1.5';
    if (iconEl) iconEl.textContent = '⏰';
    textEl.innerHTML = `현재 <strong>근무 외 시간(${_escStudentHtml(status.endLabel)} 이후)</strong>입니다. 메시지를 남겨주시면 익일 근무 시간에 확인합니다.`;
  }
}

function renderStudentChat() {
  _updateCounselingWorkHoursBanner();
  const banner = document.getElementById('counselingCtaBanner');
  banner.classList.toggle('hidden', !mockData.isCounselingOpen);

  const teacherLabel = mockData.currentUser.teacherName
    ? `${mockData.currentUser.teacherName} 담임선생님`
    : '담임선생님';
  const room = _getOrCreateStudentChatRoom();
  const container = document.getElementById('chatMessagesContainer');

  if (!room.messages || room.messages.length === 0) {
    container.innerHTML = `<div class="text-center py-10 text-xs text-slate-400">${_escStudentHtml(teacherLabel)}과의 1:1 비공개 상담방입니다. 메시지를 입력해 대화를 시작해 보세요.</div>`;
    return;
  }

  container.innerHTML = room.messages.map(m => m.sender === 'user' ? `
    <div class="flex flex-col items-end">
      <div class="bg-indigo-600 text-white text-xs px-3.5 py-2.5 rounded-2xl rounded-tr-xs max-w-[80%] shadow-xs leading-relaxed">${_escStudentHtml(m.text)}</div>
      <span class="text-[9px] text-slate-400 mt-1">${_escStudentHtml(m.time)}</span>
    </div>
  ` : `
    <div class="flex flex-col items-start">
      <span class="text-[10px] font-semibold text-slate-500 mb-1">${_escStudentHtml(teacherLabel)}</span>
      <div class="bg-white text-slate-800 border border-slate-200/80 text-xs px-3.5 py-2.5 rounded-2xl rounded-tl-xs max-w-[80%] shadow-xs leading-relaxed">${_escStudentHtml(m.text)}</div>
      <span class="text-[9px] text-slate-400 mt-1">${_escStudentHtml(m.time)}</span>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  if (typeof ensurePwaPushPermissionForAction === 'function') ensurePwaPushPermissionForAction('1:1 상담 메시지 전송');
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const timeStr = `오늘 ${kst.getUTCHours()}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
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
          student_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
          sender_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
          sender_name: mockData.currentUser.studentName || mockData.currentUser.parentName || '학생',
          sender_role: state.activeRole,
          receiver_id: 'teacher_001',
          grade: mockData.currentUser.grade || '',
          class_no: mockData.currentUser.classNo || '',
          school_code: mockData.currentUser.neisSchoolCode || mockData.currentUser.schoolCode || '',
          school_name: mockData.currentUser.schoolName || '',
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
          student_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
          sender_id: mockData.currentUser.studentId || mockData.currentUser.userId || '',
          sender_name: mockData.currentUser.studentName || mockData.currentUser.parentName || '학생',
          sender_role: state.activeRole,
          receiver_id: 'teacher_001',
          grade: mockData.currentUser.grade || '',
          class_no: mockData.currentUser.classNo || '',
          school_code: mockData.currentUser.neisSchoolCode || mockData.currentUser.schoolCode || '',
          school_name: mockData.currentUser.schoolName || '',
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    switchBottomTab,
    renderUrgentDocuments,
    renderTimetable,
    switchMealTab,
    renderMeals,
    openAllMealsModal,
    closeAllMealsModal,
    filterAllMealsModal,
    selectAllMealsDate,
    stepAllMealsDate,
    resetAllMealsDateFilter,
    renderAttendanceHistory,
    renderBudget,
    openReceiptModal,
    renderStudentChat,
    _parseConsultationHoursRange,
    _getKstWorkingHoursStatus,
    _updateCounselingWorkHoursBanner,
    _normalizeNoticeSignatureMode,
    _isStudentReadOnlyCircular,
    renderCirculars,
    _extractDriveFileId,
    _resolveDriveImageUrls,
    _applyDriveImageWithFallback,
  };
}