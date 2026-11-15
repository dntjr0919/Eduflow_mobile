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
  const targetStuId = String(mockData.currentUser.studentId || '10315');
  const myDocs = mockData.urgentDocuments.filter(d => String(d.studentId) === targetStuId && d.status !== 'closed');
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
            <button onclick="handleDocSubmit('${doc.id}')" class="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-xs font-bold rounded-xl whitespace-nowrap shadow-xs transition-all">제출 완료 확인</button>
          </div>
          <p id="error-${doc.id}" class="hidden text-[10px] text-urgent-500 mt-1 font-medium">⚠️ 정확히 "제출했습니다" 문구를 입력해야 확인 처리됩니다.</p>
        </div>
      </div>
    `;
  }).join('');
}

async function handleDocSubmit(docId) {
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
  if (doc) {
    doc.status = 'submitted';
    const now = new Date();
    doc.submittedAt = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')} 제출`;
    const hist = mockData.attendanceHistory.find(h => h.type.includes(doc.title.split(' ')[0]));
    if (hist) hist.docStatus = '학생확인완료';
    renderAll();

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
    showToast('서류 제출 확인이 등록되어 독촉 알림이 중지되었습니다.');
  }
}

function renderTimetable() {
  const container = document.getElementById('timetableList');
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
    <div class="shrink-0 w-24 bg-slate-50 border border-slate-100 rounded-xl p-2.5 flex flex-col justify-between text-center">
      <div>
        <span class="text-[10px] font-semibold text-slate-400">${t.period}교시</span>
        <p class="text-xs font-bold text-slate-800 mt-0.5">${t.subject}</p>
        <p class="text-[10px] text-slate-500 font-medium truncate">${t.teacher}</p>
      </div>
      <div class="mt-2 pt-1 border-t border-slate-200/60"><span class="text-[9px] text-slate-400 font-mono">${t.time}</span></div>
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
function selectAttType(type) {
  state.selectedAttType = type;
  document.querySelectorAll('.att-type-btn').forEach(btn => {
    btn.className = btn.dataset.type === type
      ? "att-type-btn py-1.5 px-1 rounded-lg text-xs font-semibold border transition-all text-center bg-indigo-600 text-white border-indigo-600 shadow-xs"
      : "att-type-btn py-1.5 px-1 rounded-lg text-xs font-medium border border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 transition-all text-center";
  });
  const notice = document.getElementById('fieldStudyNotice');
  if (type === '교외체험학습') {
    document.getElementById('noticeRuleFieldPre').innerText = mockData.rules.fieldPreDays;
    document.getElementById('noticeRuleFieldPost').innerText = mockData.rules.fieldPostDays;
    notice.classList.remove('hidden');
  } else {
    notice.classList.add('hidden');
  }
}

async function handleAttendanceSubmit(e) {
  e.preventDefault();
  const sDate = document.getElementById('attStartDate').value;
  const eDate = document.getElementById('attEndDate').value;
  const reason = document.getElementById('attReason').value.trim();
  const periodStr = sDate === eDate ? sDate : `${sDate} ~ ${eDate}`;
  const attId = 'ATT-' + Date.now();
  const docId = 'DOC-' + Date.now();
  const stuId = String(mockData.currentUser.studentId || '10315');
  const stuName = mockData.currentUser.studentName || '학생';
  const ruleCode = state.selectedAttType === '교외체험학습' ? 'FIELD_TRIP' : 'ABSENCE_REPORT';
  const docName = state.selectedAttType === '교외체험학습' ? '체험학습 신청서' : '출결신고서';

  mockData.attendanceHistory.unshift({
    id: attId,
    period: periodStr,
    type: state.selectedAttType,
    reason: reason,
    docStatus: '서류 미제출'
  });

  const newDoc = {
    id: docId,
    studentId: stuId,
    studentName: stuName,
    type: state.selectedAttType === '교외체험학습' ? 'planning' : 'urgency',
    dDayText: state.selectedAttType === '교외체험학습' ? `사전 D-${mockData.rules.fieldPreDays}` : `기한 +${mockData.rules.sickDays}일`,
    dDayColor: state.selectedAttType === '교외체험학습' ? 'alert' : 'urgent',
    title: `${state.selectedAttType} (${periodStr})`,
    docName,
    description: reason,
    deadline: eDate,
    status: 'pending',
    submittedAt: null
  };
  mockData.urgentDocuments.unshift(newDoc);

  document.getElementById('attReason').value = '';
  renderAll();

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
          attendance_type: state.selectedAttType,
          reason,
          submitted_by: stuName,
          role: state.activeRole,
          teacher_confirmed: 0,
          memo: periodStr
        }
      });
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
        renderUrgentDocuments();
      }
    } catch (err) {
      showToast(`출결 서버 전송 실패: ${err.message}`, '⚠️');
      return;
    }
  }
  showToast('출결 사유가 등록되고 서류 알림이 생성되었습니다.');
}

function renderAttendanceHistory() {
  const list = document.getElementById('attendanceHistoryList');
  document.getElementById('attHistoryCount').innerText = `총 ${mockData.attendanceHistory.length}건`;
  list.innerHTML = mockData.attendanceHistory.map(item => {
    let badgeStyle = 'bg-red-100 text-red-700';
    if (item.docStatus === '학생확인완료') badgeStyle = 'bg-blue-100 text-blue-700';
    if (item.docStatus === '교사 최종완료') badgeStyle = 'bg-emerald-100 text-emerald-700';
    return `
      <div class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-slate-800">${item.type} <span class="text-[11px] font-normal text-slate-400">(${item.period})</span></span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeStyle}">${item.docStatus}</span>
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

async function submitCircularSignature() {
  if (!state.hasDrawnSignature) {
    showToast('서명란에 터치 전자서명을 작성해 주세요.', '✍️');
    return;
  }
  const canvas = document.getElementById('signaturePad');
  const signatureBase64 = canvas ? canvas.toDataURL('image/png') : '';
  const cId = state.currentCircularId;
  const c = mockData.circulars.find(x => x.id === cId);
  if (c && c.status === 'pending') {
    c.status = 'submitted';
    c.submittedCount = Math.min(c.totalCount, c.submittedCount + 1);
  }
  closeCircularModal();
  renderCirculars();
  if (typeof renderTeacherCirculars === 'function') renderTeacherCirculars();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      showToast('전자서명을 Google Drive에 저장 중...', '☁️');
      await gasApi.post('submit_notice_reply', {
        data: {
          notice_id: cId,
          student_id: mockData.currentUser.studentId || '10315',
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
  showToast('전자서명 및 회신이 제출되었습니다.');
}

function renderBudget() {
  document.getElementById('budgetBalance').innerText = mockData.budget.balance.toLocaleString() + '원';
  document.getElementById('budgetIncome').innerText = mockData.budget.income.toLocaleString() + '원';
  document.getElementById('budgetExpense').innerText = mockData.budget.expense.toLocaleString() + '원';
  const list = document.getElementById('budgetTransactionsList');
  list.innerHTML = mockData.budget.transactions.map(tx => `
    <div class="bg-white p-3 rounded-xl border border-slate-200/80 flex items-center justify-between">
      <div>
        <span class="text-[10px] text-slate-400">${tx.date} · ${tx.store}</span>
        <p class="text-xs font-bold text-slate-800">${tx.title}</p>
      </div>
      <div class="text-right">
        <p class="text-xs font-bold ${tx.type === 'income' ? 'text-indigo-600' : 'text-slate-800'}">
          ${tx.type === 'income' ? '+' : '-'}${tx.amount.toLocaleString()}원
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
    <p>거래일시: 2025-${tx.date.replace('/', '-')} 14:22:10</p>
    <p>적요항목: ${tx.title}</p>
    <p>결제수단: ${tx.card}</p>
    <p class="font-bold text-indigo-700 pt-2 border-t border-slate-200">합계금액: ${tx.amount.toLocaleString()}원</p>
  `;
  openModal('receiptModal');
}

function closeReceiptModal() {
  closeModal('receiptModal');
}

// --- TAB 4: 1:1 Counseling & Chat ---
function renderStudentChat() {
  const banner = document.getElementById('counselingCtaBanner');
  banner.classList.toggle('hidden', !mockData.isCounselingOpen);

  const room = mockData.chatRooms[0];
  const container = document.getElementById('chatMessagesContainer');
  container.innerHTML = room.messages.map(m => m.sender === 'user' ? `
    <div class="flex flex-col items-end">
      <div class="bg-indigo-600 text-white text-xs px-3.5 py-2.5 rounded-2xl rounded-tr-xs max-w-[80%] shadow-xs leading-relaxed">${m.text}</div>
      <span class="text-[9px] text-slate-400 mt-1">${m.time}</span>
    </div>
  ` : `
    <div class="flex flex-col items-start">
      <span class="text-[10px] font-semibold text-slate-500 mb-1">박은혜 담임선생님</span>
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
  const room = mockData.chatRooms[0];
  room.messages.push({ sender: 'user', text, time: timeStr });
  room.unread += 1;
  input.value = '';
  renderStudentChat();
  if (typeof renderTeacherChatRooms === 'function') renderTeacherChatRooms();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('send_chat_message', {
        data: {
          room_id: room.roomId || `ROOM-${mockData.currentUser.studentId}`,
          sender_id: mockData.currentUser.studentId || '10315',
          sender_name: mockData.currentUser.studentName || '학생',
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
  const room = mockData.chatRooms[0];
  room.messages.push({ sender: 'user', text: msg, time: '방금 전' });
  room.unread += 1;
  closeCounselingModal();
  renderStudentChat();
  if (typeof renderTeacherChatRooms === 'function') renderTeacherChatRooms();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('send_chat_message', {
        data: {
          room_id: room.roomId || `ROOM-${mockData.currentUser.studentId}`,
          sender_id: mockData.currentUser.studentId || '10315',
          sender_name: mockData.currentUser.studentName || '학생',
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