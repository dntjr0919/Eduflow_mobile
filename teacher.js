/* =========================================================
   EduFlow Mobile - Teacher Admin Views (5 Tabs)
   [홈·출결], [서류·규정], [가정통신·공지], [PC 원격예약], [1:1 채팅]
   ========================================================= */

function switchTeacherBottomTab(tabName) {
  const studentTabs = ['home', 'attendance', 'letters', 'counseling'];
  const teacherTabs = ['home', 'documents', 'circulars', 'remote', 'chat'];
  studentTabs.forEach(t => document.getElementById(`tabView-${t}`).classList.add('hidden'));

  teacherTabs.forEach(t => {
    const view = document.getElementById(`teacherTabView-${t}`);
    const btn = document.getElementById(`tTabNav-${t}`);
    const dot = btn.querySelector('span:last-child');
    if (t === tabName) {
      view.classList.remove('hidden');
      if (t === 'chat') view.classList.add('flex');
      btn.className = "flex flex-col items-center gap-0.5 text-indigo-600 flex-1 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-indigo-600";
    } else {
      view.classList.add('hidden');
      view.classList.remove('flex');
      btn.className = "flex flex-col items-center gap-0.5 text-slate-400 hover:text-slate-600 flex-1 transition-colors";
      if (dot) dot.className = "w-1 h-1 rounded-full bg-transparent";
    }
  });
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
        teacher_id: mockData.currentUser.userId || 'teacher01',
        consultation_enabled: isOpen ? 1 : 0
      });
    } catch (err) {
      showToast(`상담 상태 동기화 실패: ${err.message}`, '⚠️');
    }
  }
}

function renderTeacherHome() {
  const list = document.getElementById('teacherLiveAttList');
  list.innerHTML = mockData.teacherTodayAttendance.map(item => `
    <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-200/70">
      <div>
        <div class="flex items-center gap-1.5">
          <span class="text-xs font-bold text-slate-800">${item.studentId} ${item.name}</span>
          <span class="text-[10px] px-1.5 py-0.2 rounded font-bold bg-red-100 text-red-700">${item.type}</span>
        </div>
        <p class="text-[10px] text-slate-500 mt-0.5">${item.reason}</p>
      </div>
      ${item.confirmed
        ? `<span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">확인완료</span>`
        : `<button onclick="confirmTeacherAtt('${item.id}')" class="text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1 rounded-lg shadow-xs">교사 확인</button>`
      }
    </div>
  `).join('');

  const sched = document.getElementById('teacherScheduleList');
  sched.innerHTML = mockData.teacherSchedule.map(s => `
    <div class="p-2 rounded-xl border text-center ${s.changed ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200/70'}">
      <span class="text-[10px] font-semibold ${s.changed ? 'text-amber-700' : 'text-slate-400'}">${s.period}</span>
      <p class="text-xs font-bold text-slate-800 mt-0.5">${s.target}</p>
      <p class="text-[10px] ${s.changed ? 'text-amber-800 font-bold' : 'text-slate-500'}">${s.subject}</p>
    </div>
  `).join('');
}

async function confirmTeacherAtt(id) {
  const item = mockData.teacherTodayAttendance.find(x => x.id === id);
  if (item) item.confirmed = true;
  renderTeacherHome();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('confirm_attendance', { remote_id: id });
    } catch (err) {
      showToast(`출결 확인 동기화 실패: ${err.message}`, '⚠️');
      return;
    }
  }
  showToast('출결 보고가 확인 처리되었습니다.');
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

  container.innerHTML = filtered.map(doc => `
    <div class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold text-slate-800">${doc.studentId} ${doc.studentName} · ${doc.docName}</span>
        <span class="text-[10px] font-semibold text-slate-400">마감 ${doc.deadline}</span>
      </div>
      <p class="text-[11px] text-slate-600">${doc.title} — ${doc.description}</p>
      ${doc.status === 'submitted' ? `
        <div class="flex gap-2 pt-1">
          <button onclick="finalizeTeacherDoc('${doc.id}', 'closed')" class="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-xl">나이스 확인 후 최종종결</button>
          <button onclick="finalizeTeacherDoc('${doc.id}', 'pending')" class="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-[11px] font-bold rounded-xl">미제출 반려(재알림)</button>
        </div>
      ` : doc.status === 'pending' ? `
        <div class="flex items-center justify-between pt-1">
          <span class="text-[10px] text-urgent-600 font-semibold">매일 아침 자동 독촉 알림 발송 중</span>
          <button onclick="showToast('${doc.studentName} 학생에게 즉시 독촉 알림을 보냈습니다.', '🔔')" class="text-[10px] px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg">수동 재알림</button>
        </div>
      ` : `<span class="inline-block text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-semibold">${doc.submittedAt || '최종 종결됨'}</span>`}
    </div>
  `).join('');
}

async function finalizeTeacherDoc(docId, nextStatus) {
  const doc = mockData.urgentDocuments.find(d => d.id === docId);
  if (!doc) return;
  doc.status = nextStatus;
  if (nextStatus === 'closed') {
    doc.submittedAt = '방금 전 최종완료';
    showToast('나이스 서류 확인 후 최종 종결 처리되었습니다.');
  } else {
    doc.submittedAt = null;
    showToast('미제출 반려 처리되어 학생에게 다시 독촉 알림이 활성화됩니다.', '⚠️');
  }
  renderAll();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('confirm_document', {
        remote_id: docId,
        status: nextStatus === 'closed' ? '확인완료' : '미제출'
      });
    } catch (err) {
      showToast(`서류 상태 동기화 실패: ${err.message}`, '⚠️');
    }
  }
}

function openRulesModal() {
  document.getElementById('ruleSick').value = mockData.rules.sickDays;
  document.getElementById('ruleFieldPre').value = mockData.rules.fieldPreDays;
  document.getElementById('ruleFieldPost').value = mockData.rules.fieldPostDays;
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
  mockData.rules.sickDays = parseInt(document.getElementById('ruleSick').value, 10);
  mockData.rules.fieldPreDays = parseInt(document.getElementById('ruleFieldPre').value, 10);
  mockData.rules.fieldPostDays = parseInt(document.getElementById('ruleFieldPost').value, 10);
  closeRulesModal();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('upsert_doc_rule', {
        data: {
          remote_id: 'rule_absence',
          rule_code: 'ABSENCE_REPORT',
          doc_name: '결석계 및 증빙서류',
          category: '출결서류',
          due_business_days: mockData.rules.sickDays,
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
          due_business_days: mockData.rules.fieldPostDays,
          target_roles: 'student,parent',
          is_active: 1
        }
      });
    } catch (err) {
      showToast(`규정 저장 실패: ${err.message}`, '⚠️');
      return;
    }
  }
  showToast(`규정 저장 완료 (결석 +${mockData.rules.sickDays}일, 체험학습 -${mockData.rules.fieldPreDays}일/+${mockData.rules.fieldPostDays}일)`, '⚙️');
}

// --- TEACHER TAB 3: Circulars & Notices ---
function renderTeacherCirculars() {
  const container = document.getElementById('teacherCircularsContainer');
  document.getElementById('teacherCircularCount').innerText = `총 ${mockData.circulars.length}건 진행중`;
  container.innerHTML = mockData.circulars.map(c => {
    const pct = Math.round((c.submittedCount / c.totalCount) * 100);
    return `
      <div class="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs space-y-2.5">
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">${c.deadline}</span>
          <span class="text-xs font-bold text-slate-800">${c.submittedCount}/${c.totalCount}명 제출 (${pct}%)</span>
        </div>
        <h4 class="text-xs font-bold text-slate-800">${c.title}</h4>
        <div class="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
          <div class="bg-indigo-600 h-full rounded-full transition-all" style="width: ${pct}%"></div>
        </div>
        <div class="flex gap-2 pt-1">
          <button onclick="openUnsubmittedModal()" class="flex-1 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold rounded-xl">미제출자 명단 (${c.totalCount - c.submittedCount}명)</button>
          <button onclick="showToast('제출된 서명 이미지가 원본 PDF 좌표에 합성되어 인쇄 대기열로 전송되었습니다.', '🖨️')" class="flex-1 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold rounded-xl">서명본 PDF 일괄 출력</button>
        </div>
      </div>
    `;
  }).join('');
}

function openNewCircularModal() {
  openModal('newCircularModal');
}

function closeNewCircularModal() {
  closeModal('newCircularModal');
}

function toggleSignBoxPin() {
  state.isSignBoxPinned = !state.isSignBoxPinned;
  const box = document.getElementById('pinpointSignBox');
  const badge = document.getElementById('signPinBadge');
  if (state.isSignBoxPinned) {
    box.className = "border-2 border-dashed border-indigo-600 bg-indigo-50/80 rounded-lg p-2 text-center cursor-pointer transition-all hover:bg-indigo-100";
    badge.innerText = "터치 지정됨";
  } else {
    box.className = "border-2 border-dashed border-slate-300 bg-slate-100 rounded-lg p-2 text-center cursor-pointer transition-all";
    badge.innerText = "해제됨";
  }
}

async function publishNewCircular() {
  const title = document.getElementById('newCircularTitle').value.trim();
  if (!title) return;
  const noticeId = 'CIR-' + Date.now();
  const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  mockData.circulars.unshift({
    id: noticeId,
    docNum: '가정통신문',
    title,
    deadline: `${dueDate} 마감`,
    status: 'pending',
    submittedCount: 0,
    totalCount: 28,
    content: '학부모님의 가정에 늘 행운이 가득하시길 기원합니다. 참가 희망 여부를 전자 서명 후 회신 바랍니다.',
    meta: [`대상: ${mockData.currentUser.gradeClass || '1학년 3반'} 전체`, '전자서명 좌표 매핑 완료']
  });
  closeNewCircularModal();
  if (typeof renderCirculars === 'function') renderCirculars();
  renderTeacherCirculars();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('upsert_notice', {
        data: {
          remote_id: noticeId,
          title,
          category: '가정통신문',
          content: '참가 희망 여부를 전자 서명 후 회신 바랍니다.',
          target_grade: mockData.currentUser.grade || '1',
          target_class: mockData.currentUser.classNo || '3',
          due_date: dueDate,
          requires_reply: 1,
          author_name: mockData.currentUser.teacherName || '담임교사',
          is_published: 1
        }
      });
    } catch (err) {
      showToast(`가정통신문 배포 실패: ${err.message}`, '⚠️');
      return;
    }
  }
  showToast('새 가정통신문이 배포되었습니다.');
}

function openUnsubmittedModal() {
  openModal('unsubmittedModal');
}

function closeUnsubmittedModal() {
  closeModal('unsubmittedModal');
}

function sendBulkPromptToUnsubmitted() {
  closeUnsubmittedModal();
  showToast('미제출 4명 학부모에게 회신 독촉 알림을 일괄 발송했습니다.', '📲');
}

// --- TEACHER TAB 4: PC Remote Task Queue ---
function _inferRemoteTaskType(label) {
  const s = (label || '').toLowerCase();
  if (s.includes('분류') || s.includes('정리')) return 'file_sort';
  if (s.includes('엑셀') || s.includes('병합')) return 'excel_merge';
  if (s.includes('서명') || s.includes('pdf')) return 'signature_pdf';
  if (s.includes('가정통신문') || s.includes('추출')) return 'notice_extract';
  return 'web_llm';
}

async function handleCreateRemoteTask(e) {
  e.preventDefault();
  const typeLabel = document.getElementById('remoteTaskType').value;
  const timingVal = document.querySelector('input[name="taskTiming"]:checked').value;
  const prompt = document.getElementById('remoteTaskPrompt').value.trim() || '기본 설정값으로 자동 실행';
  const jobId = 'mob_' + Date.now();
  const scheduledStr = timingVal === 'now'
    ? new Date().toISOString().slice(0, 16).replace('T', ' ')
    : `${new Date().toISOString().split('T')[0]} 17:30`;

  mockData.remoteTasks.unshift({
    id: jobId,
    type: typeLabel,
    timing: timingVal === 'now' ? '즉시 실행 요청됨' : '예약됨 (오늘 17:30)',
    prompt,
    status: timingVal === 'now' ? 'running' : 'pending',
    log: timingVal === 'now' ? '집 PC EduFlow 백그라운드 워커가 작업을 수신했습니다...' : 'PC EduFlow 워커 대기 중'
  });
  document.getElementById('remoteTaskPrompt').value = '';
  renderRemoteTasks();

  if (typeof gasApi !== 'undefined' && gasApi.isConfigured()) {
    try {
      await gasApi.post('enqueue_remote_task', {
        data: {
          remote_id: jobId,
          task_type: _inferRemoteTaskType(typeLabel),
          title: typeLabel,
          due_date: new Date().toISOString().split('T')[0],
          priority: timingVal === 'now' ? 'high' : 'normal',
          is_mobile_task: 1,
          scheduled_time: scheduledStr,
          target_info: prompt,
          action_payload: JSON.stringify({ prompt, mode: timingVal }),
          exec_status: 'pending',
          is_done: 0,
          memo: 'EduFlow Mobile에서 예약됨'
        }
      });
    } catch (err) {
      showToast(`원격 작업 큐 등록 실패: ${err.message}`, '⚠️');
      return;
    }
  }
  showToast('PC EduFlow 원격 작업 큐에 등록되었습니다.', '⚡');
}

function renderRemoteTasks() {
  const container = document.getElementById('remoteTasksContainer');
  document.getElementById('remoteTaskCountBadge').innerText = `${mockData.remoteTasks.length}건 대기/완료`;
  container.innerHTML = mockData.remoteTasks.map(job => {
    let badge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-700">대기중</span>`;
    if (job.status === 'running') badge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-indigo-100 text-indigo-700 animate-pulse">PC 실행중</span>`;
    if (job.status === 'done') badge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700">완료</span>`;
    return `
      <div class="bg-white p-3.5 rounded-2xl border border-slate-200/80 shadow-xs space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-slate-800">${job.type}</span>
          ${badge}
        </div>
        <p class="text-[11px] text-slate-600">${job.prompt}</p>
        <div class="flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t border-slate-100">
          <span>${job.timing}</span>
          <span class="text-indigo-600 font-medium">${job.log}</span>
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

  list.innerHTML = rooms.map(r => {
    const lastMsg = r.messages[r.messages.length - 1];
    return `
      <div onclick="openTeacherChatDetail('${r.roomId}')" class="p-3.5 bg-white hover:bg-slate-50 cursor-pointer flex items-center justify-between gap-3 transition-colors">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center text-xs shrink-0">${r.studentName[0]}</div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <p class="text-xs font-bold text-slate-800 truncate">${r.partnerLabel}</p>
              <span class="text-[10px] text-slate-400">${lastMsg ? lastMsg.time : ''}</span>
            </div>
            <p class="text-[11px] text-slate-500 truncate mt-0.5">${lastMsg ? lastMsg.text : ''}</p>
          </div>
        </div>
        ${r.unread > 0 ? `<span class="w-5 h-5 rounded-full bg-urgent-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">${r.unread}</span>` : ''}
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
    gasApi.post('mark_chat_read', { room_id: roomId, reader_role: 'teacher' }).catch(() => {});
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
      <div class="bg-indigo-600 text-white text-xs px-3.5 py-2.5 rounded-2xl rounded-tr-xs max-w-[80%] shadow-xs leading-relaxed">${m.text}</div>
      <span class="text-[9px] text-slate-400 mt-1">${m.time}</span>
    </div>
  ` : `
    <div class="flex flex-col items-start">
      <span class="text-[10px] font-semibold text-slate-500 mb-1">${room.partnerLabel}</span>
      <div class="bg-white text-slate-800 border border-slate-200/80 text-xs px-3.5 py-2.5 rounded-2xl rounded-tl-xs max-w-[80%] shadow-xs leading-relaxed">${m.text}</div>
      <span class="text-[9px] text-slate-400 mt-1">${m.time}</span>
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