/* =========================================================
   EduFlow Mobile - Core Application State, GAS REST API & Shared UI
   Google Apps Script(GAS) REST API 연동 + 오프라인/데모 폴백 지원
   ========================================================= */

const GAS_PROXY_ENDPOINT = '/api/gas';

const gasApi = {
  demoMode: typeof window !== 'undefined' && window.location.protocol === 'file:',
  getUrl() {
    return GAS_PROXY_ENDPOINT;
  },
  isConfigured() {
    return !this.demoMode && typeof window !== 'undefined' && window.location.protocol !== 'file:';
  },
  _demoError(message) {
    const err = new Error(message || '데모 모드로 동작 중입니다.');
    err.isDemo = true;
    return err;
  },
  async sha256Hex(text) {
    const data = new TextEncoder().encode(String(text || ''));
    if (window.crypto && window.crypto.subtle) {
      const hashBuf = await window.crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }
    return String(text || '');
  },
  async get(action, params = {}) {
    if (!this.isConfigured()) throw this._demoError('로컬 실행 또는 데모 모드입니다.');
    const qs = new URLSearchParams({ action, ...params });
    const resp = await fetch(`${GAS_PROXY_ENDPOINT}?${qs.toString()}`, {
      method: 'GET',
      redirect: 'follow'
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json && json.demo === true) {
      this.demoMode = true;
      throw this._demoError(json.error || 'GAS_WEB_APP_URL not configured');
    }
    if (json && json.ok === false) throw new Error(json.error || 'Apps Script 오류');
    return json;
  },
  async post(action, payload = {}) {
    if (!this.isConfigured()) throw this._demoError('로컬 실행 또는 데모 모드입니다.');
    const body = { action, ...payload };
    const resp = await fetch(GAS_PROXY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json && json.demo === true) {
      this.demoMode = true;
      throw this._demoError(json.error || 'GAS_WEB_APP_URL not configured');
    }
    if (json && json.ok === false) throw new Error(json.error || 'Apps Script 오류');
    return json;
  }
};

let mockData = {
  currentUser: {
    role: "student",
    userId: "",
    studentId: "",
    studentName: "",
    maskedName: "",
    parentName: "",
    grade: "",
    classNo: "",
    gradeClass: "",
    schoolName: "",
    teacherName: "",
    subject: "",
    phone: "",
    consultationHours: "",
    neisOfficeCode: "",
    neisSchoolCode: ""
  },
  isCounselingOpen: false,
  rules: {
    sickDays: 5,
    fieldPreDays: 3,
    fieldPostDays: 5
  },
  students: [],
  urgentDocuments: [],
  attendanceHistory: [],
  teacherTodayAttendance: [],
  timetable: [],
  teacherSchedule: [],
  meals: {
    lunch: null,
    dinner: null
  },
  circulars: [],
  budget: {
    balance: 0,
    income: 0,
    expense: 0,
    transactions: []
  },
  chatRooms: [],
  remoteTasks: [],
  notifications: []
};

// Global Application State
const state = {
  activeRole: 'student',
  activeMealTab: 'lunch',
  selectedAttType: '질병결석',
  currentCircularId: null,
  currentUnsubmittedCircularId: null,
  teacherDocFilter: 'pending',
  activeTeacherChatRoomId: '',
  isSignBoxPinned: true,
  hasDrawnSignature: false
};

// Common Toast Notification
function showToast(msg, icon = '✅') {
  const toast = document.getElementById('globalToast');
  document.getElementById('globalToastIcon').innerText = icon;
  document.getElementById('globalToastMsg').innerText = msg;
  toast.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

// Common Modal Controls
function openModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('hidden');
}

function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('hidden');
}

function toggleNoticeModal() {
  const modal = document.getElementById('noticeModal');
  modal.classList.toggle('hidden');
  if (!modal.classList.contains('hidden')) {
    renderNotificationsModal();
    document.getElementById('unreadDot').classList.add('hidden');
  }
}

function renderNotificationsModal() {
  const list = document.getElementById('noticeModalList');
  if (!list) return;
  const items = Array.isArray(mockData.notifications) ? mockData.notifications : [];
  if (items.length === 0) {
    list.innerHTML = `<div class="text-center py-8 text-slate-400">수신된 알림 내역이 없습니다.</div>`;
    return;
  }
  list.innerHTML = items.map(n => {
    const isUnread = String(n.is_read) !== '1';
    const ch = (n.channel || '').toLowerCase();
    let boxCls = 'bg-slate-50 border-slate-200/80';
    let badgeCls = 'text-indigo-600';
    if (ch.includes('doc') || ch.includes('urgent')) {
      boxCls = 'bg-red-50/70 border-red-100';
      badgeCls = 'text-red-600';
    } else if (ch.includes('timetable')) {
      boxCls = 'bg-amber-50/70 border-amber-100';
      badgeCls = 'text-amber-700';
    }
    return `
      <div onclick="markNotificationRead('${n.remote_id}')" class="p-3 ${boxCls} border rounded-xl cursor-pointer transition-all hover:opacity-90">
        <div class="flex items-center justify-between mb-0.5">
          <span class="text-[10px] font-bold ${badgeCls}">${n.sender || '학급 알림'}</span>
          ${isUnread ? '<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>' : ''}
        </div>
        <p class="font-semibold text-slate-800">${n.title || ''}</p>
        ${n.message ? `<p class="text-[11px] text-slate-600 mt-0.5 leading-relaxed">${n.message}</p>` : ''}
        <p class="text-[10px] text-slate-400 mt-1">${n.created_at || ''}</p>
      </div>
    `;
  }).join('');
}

async function markNotificationRead(remoteId) {
  const item = (mockData.notifications || []).find(n => n.remote_id === remoteId);
  if (item) {
    item.is_read = 1;
    renderNotificationsModal();
  }
  if (gasApi.isConfigured() && remoteId) {
    gasApi.post('mark_notification_read', { remote_id: remoteId }).catch(() => {});
  }
}

// Login & Role Switching
function selectRole(role) {
  state.activeRole = role;
  ['student', 'parent', 'teacher'].forEach(r => {
    const btn = document.getElementById(`roleBtn-${r}`);
    btn.className = r === role
      ? "flex-1 py-2 text-xs font-semibold rounded-lg transition-all duration-200 bg-white text-indigo-600 shadow-sm"
      : "flex-1 py-2 text-xs font-medium rounded-lg text-slate-600 hover:text-slate-900 transition-all duration-200";
  });
  const idLabel = document.getElementById('loginIdLabel');
  const idInput = document.getElementById('loginIdInput');
  if (role === 'student') {
    idLabel.innerText = "학번 (5자리)";
    idInput.placeholder = "학번 5자리(예: 10315)";
  } else if (role === 'parent') {
    idLabel.innerText = "학부모 아이디";
    idInput.placeholder = "학부모 ID(예: parent01)";
  } else {
    idLabel.innerText = "교사 교원번호/ID";
    idInput.placeholder = "교사 ID(예: teacher01)";
  }
}

async function handleLogin(e) {
  if (e) e.preventDefault();
  const userId = (document.getElementById('loginIdInput')?.value || '').trim();
  const password = (document.getElementById('loginPwInput')?.value || '');

  if (gasApi.isConfigured()) {
    try {
      showToast('Google Sheets 계정 인증 중...', '🔐');
      const pwHash = await gasApi.sha256Hex(password);
      const res = await gasApi.post('login', {
        role: state.activeRole,
        user_id: userId,
        password: password,
        password_hash: pwHash
      });
      if (res.user) {
        _applyAuthenticatedUser(res.user);
      }
      await refreshFromGas(false);
      if ('Notification' in window && Notification.permission === 'granted') {
        subscribeToWebPush(true).catch(() => {});
      }
    } catch (err) {
      if (err && err.isDemo) {
        mockData.currentUser.role = state.activeRole;
        mockData.currentUser.userId = userId;
        showToast('데모 모드로 로그인되었습니다 (연동된 시트 없음).', 'ℹ️');
      } else {
        showToast(`로그인 실패: ${err.message}`, '⚠️');
        return;
      }
    }
  } else {
    mockData.currentUser.role = state.activeRole;
    mockData.currentUser.userId = userId;
    showToast('로컬 데모 모드로 실행 중입니다.', 'ℹ️');
  }

  applyRoleUI();
  document.getElementById('loginScreen').classList.add('hidden');
  const dash = document.getElementById('dashboardScreen');
  dash.classList.remove('hidden');
  dash.classList.add('flex');
  renderAll();
}

function _applyAuthenticatedUser(user) {
  const role = (user.role || state.activeRole).toLowerCase();
  const grade = user.grade !== undefined && user.grade !== '' ? String(user.grade) : '';
  const classNo = user.class_no !== undefined && user.class_no !== '' ? String(user.class_no) : '';
  const rawName = user.name || '';
  const masked = rawName.length >= 2 ? rawName[0] + 'OO' : rawName;
  const gradeClass = (grade && classNo) ? `${grade}학년 ${classNo}반` : '';

  mockData.currentUser = {
    ...mockData.currentUser,
    role,
    userId: user.teacher_id || user.student_id || user.parent_id || user.remote_id || '',
    studentId: user.student_id || '',
    studentName: role === 'parent' ? (user.student_name || '') : rawName,
    maskedName: masked,
    parentName: role === 'parent' ? rawName : (masked ? `${masked} 학부모님` : ''),
    grade,
    classNo,
    gradeClass,
    schoolName: user.school_name || '',
    teacherName: role === 'teacher' ? rawName : (mockData.currentUser.teacherName || ''),
    subject: user.subject || '',
    phone: user.phone || '',
    consultationHours: user.consultation_hours || '',
    neisOfficeCode: user.neis_office_code || '',
    neisSchoolCode: user.neis_school_code || ''
  };
}

async function refreshFromGas(showFeedback = true) {
  if (!gasApi.isConfigured()) {
    if (showFeedback) showToast('데모 모드로 동작 중입니다.', 'ℹ️');
    return;
  }
  try {
    const cu = mockData.currentUser;
    const bundle = await gasApi.get('get_mobile_bundle', {
      role: state.activeRole,
      student_id: cu.studentId || '',
      grade: cu.grade || '',
      class_no: cu.classNo || ''
    });
    hydrateMockDataFromBundle(bundle);
    renderAll();
    if (showFeedback) showToast('Google Sheets 최신 데이터를 불러왔습니다.', '🔄');
  } catch (err) {
    if (err && err.isDemo) {
      if (showFeedback) showToast('데모 모드로 동작 중입니다.', 'ℹ️');
      return;
    }
    if (showFeedback) showToast(`동기화 오류: ${err.message}`, '⚠️');
  }
}

function _getKoreanTodayDayChar() {
  return ['일', '월', '화', '수', '목', '금', '토'][new Date().getDay()];
}

function hydrateMockDataFromBundle(bundle) {
  if (!bundle || !bundle.ok) return;

  // 1. 학생 목록 (재적 인원 및 미제출자 비교용)
  if (Array.isArray(bundle.students)) {
    mockData.students = bundle.students;
    if (state.activeRole !== 'teacher' && bundle.students.length > 0 && !mockData.currentUser.grade) {
      const me = bundle.students[0];
      mockData.currentUser.grade = String(me.grade || '');
      mockData.currentUser.classNo = String(me.class_no || '');
      mockData.currentUser.gradeClass = (me.grade && me.class_no) ? `${me.grade}학년 ${me.class_no}반` : '';
    }
  }

  // 2. 교사 & 상담 ON/OFF 상태
  if (Array.isArray(bundle.teachers)) {
    const cu = mockData.currentUser;
    let t = null;
    if (state.activeRole === 'teacher' && cu.userId) {
      t = bundle.teachers.find(x =>
        String(x.teacher_id || '') === String(cu.userId) || String(x.remote_id || '') === String(cu.userId)
      );
    } else if (cu.grade && cu.classNo) {
      t = bundle.teachers.find(x =>
        String(x.grade || '') === String(cu.grade) && String(x.class_no || '') === String(cu.classNo)
      );
    }
    if (!t && bundle.teachers.length > 0) {
      t = bundle.teachers[0];
    }
    if (t) {
      mockData.currentUser.teacherName = t.name || mockData.currentUser.teacherName || '';
      mockData.currentUser.schoolName = t.school_name || mockData.currentUser.schoolName || '';
      if (state.activeRole === 'teacher') {
        mockData.currentUser.grade = t.grade !== undefined && t.grade !== '' ? String(t.grade) : mockData.currentUser.grade;
        mockData.currentUser.classNo = t.class_no !== undefined && t.class_no !== '' ? String(t.class_no) : mockData.currentUser.classNo;
        mockData.currentUser.gradeClass = (mockData.currentUser.grade && mockData.currentUser.classNo)
          ? `${mockData.currentUser.grade}학년 ${mockData.currentUser.classNo}반`
          : '';
        mockData.currentUser.subject = t.subject || '';
        mockData.currentUser.phone = t.phone || '';
        mockData.currentUser.consultationHours = t.consultation_hours || '';
        mockData.currentUser.neisOfficeCode = t.neis_office_code || '';
        mockData.currentUser.neisSchoolCode = t.neis_school_code || '';
      }
      mockData.isCounselingOpen = String(t.consultation_enabled) === '1' || t.consultation_enabled === true;
    } else {
      mockData.isCounselingOpen = false;
    }
  }

  // 3. 서류 규정
  if (Array.isArray(bundle.doc_rules)) {
    const abs = bundle.doc_rules.find(r => r.rule_code === 'ABSENCE_REPORT');
    const fld = bundle.doc_rules.find(r => r.rule_code === 'FIELD_TRIP');
    if (abs && abs.due_business_days) mockData.rules.sickDays = parseInt(abs.due_business_days, 10) || 5;
    if (fld && fld.due_business_days) mockData.rules.fieldPostDays = parseInt(fld.due_business_days, 10) || 5;
  }

  // 4. 서류 추적 (urgentDocuments)
  if (Array.isArray(bundle.doc_tracking)) {
    mockData.urgentDocuments = bundle.doc_tracking.map(d => {
      const rawStatus = (d.status || '').trim();
      let status = 'pending';
      if (rawStatus === '제출했습니다' || rawStatus === 'submitted') status = 'submitted';
      else if (rawStatus === '확인완료' || rawStatus === 'closed') status = 'closed';
      return {
        id: d.remote_id,
        studentId: String(d.student_id || ''),
        studentName: d.student_name || '',
        type: (d.rule_code === 'FIELD_TRIP') ? 'planning' : 'urgency',
        dDayText: status === 'submitted' ? '검수대기' : (status === 'closed' ? '종결' : '마감임박'),
        dDayColor: status === 'closed' ? 'success' : (d.rule_code === 'FIELD_TRIP' ? 'alert' : 'urgent'),
        title: `${d.doc_type || '서류'} (${d.base_date || ''})`,
        docName: d.doc_type || '증빙서류',
        description: d.memo || `마감일: ${d.due_date || ''}`,
        deadline: d.due_date || '',
        status,
        submittedAt: d.submitted_at || null
      };
    });
  }

  // 5. 일일 출결 (학생 이력 + 교사용 오늘 출결)
  if (Array.isArray(bundle.attendance)) {
    mockData.attendanceHistory = bundle.attendance.map(a => ({
      id: a.remote_id,
      period: a.date || '',
      type: a.attendance_type || '출결',
      reason: a.reason || '',
      docStatus: String(a.teacher_confirmed) === '1' ? '교사 최종완료' : '접수됨'
    }));
    const todayStr = new Date().toISOString().split('T')[0];
    const todayAtt = bundle.attendance.filter(a => !a.date || a.date === todayStr);
    mockData.teacherTodayAttendance = todayAtt.map(a => ({
      id: a.remote_id,
      studentId: String(a.student_id || ''),
      name: a.student_name || '',
      type: a.attendance_type || '출결',
      reason: a.reason || '',
      confirmed: String(a.teacher_confirmed) === '1'
    }));
  }

  // 6. 시간표 (오늘 요일 필터 + 변동 병합)
  if (Array.isArray(bundle.timetable_base)) {
    const todayStr = new Date().toISOString().split('T')[0];
    const dayChar = _getKoreanTodayDayChar();
    const changes = Array.isArray(bundle.timetable_changes) ? bundle.timetable_changes : [];
    const cu = mockData.currentUser;

    const stuTitleEl = document.getElementById('studentTimetableTitle');
    if (stuTitleEl) stuTitleEl.innerText = `오늘의 시간표 (${dayChar}요일)`;

    const todayBase = bundle.timetable_base
      .filter(tb => {
        const d = String(tb.day_of_week || '').trim();
        return !d || d.startsWith(dayChar);
      })
      .sort((a, b) => Number(a.period || 0) - Number(b.period || 0));

    const classBase = (cu.grade && cu.classNo)
      ? todayBase.filter(tb => String(tb.grade || '') === String(cu.grade) && String(tb.class_no || '') === String(cu.classNo))
      : todayBase;

    mockData.timetable = classBase.map(tb => {
      const chg = changes.find(c =>
        String(c.period) === String(tb.period) &&
        (!c.grade || String(c.grade) === String(tb.grade)) &&
        (!c.class_no || String(c.class_no) === String(tb.class_no)) &&
        (!c.date || c.date === todayStr)
      );
      if (chg) {
        return {
          period: Number(tb.period) || tb.period,
          subject: chg.changed_subject || tb.subject,
          teacher: chg.changed_teacher || tb.teacher_name || '',
          isChanged: true,
          original: chg.original_subject || tb.subject,
          time: `${8 + Number(tb.period || 1)}:50`
        };
      }
      return {
        period: Number(tb.period) || tb.period,
        subject: tb.subject || '',
        teacher: tb.teacher_name || '',
        isChanged: false,
        time: `${8 + Number(tb.period || 1)}:50`
      };
    });

    // 교사 본인 시간표 구성 (teacherName 일치 행)
    const tName = String(cu.teacherName || '').trim();
    const teacherBase = tName
      ? todayBase.filter(tb => String(tb.teacher_name || '').trim() === tName)
      : [];
    mockData.teacherSchedule = teacherBase.map(tb => {
      const chg = changes.find(c =>
        String(c.period) === String(tb.period) &&
        String(c.grade || '') === String(tb.grade || '') &&
        String(c.class_no || '') === String(tb.class_no || '') &&
        (!c.date || c.date === todayStr)
      );
      const targetStr = (tb.grade && tb.class_no) ? `${tb.grade}학년 ${tb.class_no}반` : '';
      return {
        period: `${tb.period}교시`,
        target: targetStr,
        subject: chg ? (chg.changed_subject || tb.subject) : (tb.subject || ''),
        changed: Boolean(chg)
      };
    });
  }

  // 7. 급식 식단표 (NEIS)
  if (Array.isArray(bundle.meals)) {
    const todayStr = new Date().toISOString().split('T')[0];
    const todayMeals = bundle.meals.filter(m => m.meal_date === todayStr);
    const pool = todayMeals.length > 0 ? todayMeals : bundle.meals;
    const lunch = pool.find(m => (m.meal_type || '').includes('중식'));
    const dinner = pool.find(m => (m.meal_type || '').includes('석식'));
    const mapMeal = (m) => ({
      calories: m.calories || '-',
      menu: (m.menu_text || '').split('\n').filter(Boolean).map(name => ({ name: name.trim(), allergy: '' })),
      allergyNotice: m.allergy_info || '나이스(NEIS) 식단 연동됨'
    });
    mockData.meals = {
      lunch: lunch ? mapMeal(lunch) : null,
      dinner: dinner ? mapMeal(dinner) : null
    };
  }

  // 8. 가정통신문 목록 & 회신
  if (Array.isArray(bundle.notices)) {
    const replies = Array.isArray(bundle.notice_replies) ? bundle.notice_replies : [];
    const cuId = String(mockData.currentUser.studentId || '');
    const classTotal = mockData.students.length;
    mockData.circulars = bundle.notices.map(n => {
      const nReplies = replies.filter(r => r.notice_id === n.remote_id);
      const myReply = cuId ? nReplies.find(r => String(r.student_id) === cuId) : null;
      return {
        id: n.remote_id,
        docNum: n.category || '가정통신문',
        title: n.title || '',
        deadline: n.due_date ? `${n.due_date} 마감` : '상시',
        status: myReply ? 'submitted' : 'pending',
        submittedCount: nReplies.length,
        totalCount: classTotal > 0 ? classTotal : nReplies.length,
        submittedStudentIds: nReplies.map(r => String(r.student_id || '')),
        content: n.content || '',
        meta: n.attachment_url ? [`첨부: ${n.attachment_url}`] : [`작성: ${n.author_name || '담임교사'}`]
      };
    });
  }

  // 9. 학급회비
  if (Array.isArray(bundle.budget)) {
    let income = 0;
    let expense = 0;
    const transactions = bundle.budget.map(b => {
      const amt = Number(b.amount || 0) || 0;
      const bType = String(b.type || 'expense').toLowerCase() === 'income' ? 'income' : 'expense';
      if (bType === 'income') income += amt;
      else expense += amt;
      return {
        id: b.remote_id,
        date: b.date || '',
        title: b.title || '',
        type: bType,
        amount: amt,
        store: b.store || '-',
        card: b.card || '-',
        receiptUrl: b.receipt_url || ''
      };
    });
    mockData.budget = {
      balance: income - expense,
      income,
      expense,
      transactions
    };
  }

  // 10. 1:1 상담 채팅
  if (Array.isArray(bundle.chat_messages)) {
    const roomMap = {};
    bundle.chat_messages.forEach(c => {
      const rId = c.room_id || 'ROOM-DEFAULT';
      if (!roomMap[rId]) {
        const stuIdFromRoom = rId.replace('ROOM-', '');
        const stuObj = mockData.students.find(s => String(s.student_id) === stuIdFromRoom);
        const stuName = stuObj ? stuObj.name : (c.sender_role !== 'teacher' ? (c.sender_name || stuIdFromRoom) : stuIdFromRoom);
        roomMap[rId] = {
          roomId: rId,
          studentId: stuIdFromRoom,
          studentName: stuName || '학생',
          partnerLabel: stuName ? `${stuName} (${stuIdFromRoom})` : rId,
          subtitle: stuObj ? `${stuObj.grade}학년 ${stuObj.class_no}반 ${stuObj.student_no || ''}번 ${stuObj.name}` : rId,
          unread: 0,
          messages: []
        };
      }
      if (String(c.is_read) !== '1' && c.sender_role !== 'teacher') {
        roomMap[rId].unread += 1;
      }
      roomMap[rId].messages.push({
        sender: c.sender_role === 'teacher' ? 'teacher' : 'user',
        text: c.message || '',
        time: (c.created_at || '').slice(11, 16) || '방금'
      });
    });
    mockData.chatRooms = Object.values(roomMap);
    if (mockData.chatRooms.length > 0 && !state.activeTeacherChatRoomId) {
      state.activeTeacherChatRoomId = mockData.chatRooms[0].roomId;
    }
  }

  // 11. PC 원격 예약 작업 (Tasks 시트)
  if (Array.isArray(bundle.remote_tasks)) {
    mockData.remoteTasks = bundle.remote_tasks.map(t => ({
      id: t.remote_id,
      type: t.title || t.task_type || '원격 작업',
      timing: t.scheduled_time || '즉시 실행',
      prompt: t.target_info || t.action_payload || '',
      status: t.exec_status === 'done' ? 'done' : (t.exec_status === 'running' ? 'running' : 'pending'),
      log: t.memo || (t.exec_status === 'done' ? 'PC 작업 완료' : 'PC EduFlow 워커 대기 중')
    }));
  }

  // 12. 알림 (Notifications 시트)
  if (Array.isArray(bundle.notifications)) {
    mockData.notifications = [...bundle.notifications].reverse();
    const hasUnread = mockData.notifications.some(n => String(n.is_read) !== '1');
    const dot = document.getElementById('unreadDot');
    if (dot) dot.classList.toggle('hidden', !hasUnread);
    renderNotificationsModal();
  }

  applyRoleUI();
}

function applyRoleUI() {
  const nameElem = document.getElementById('userNameDisplay');
  const subElem = document.getElementById('userSubDisplay');
  const badgeElem = document.getElementById('userBadge');
  const avatarElem = document.getElementById('userAvatarText');
  const profileBtn = document.getElementById('teacherProfileHeaderBtn');

  const studentNav = document.getElementById('studentBottomNav');
  const teacherNav = document.getElementById('teacherBottomNav');

  const cu = mockData.currentUser;
  const gc = cu.gradeClass || '';
  const school = cu.schoolName || '소속 학교 미설정';
  const tName = cu.teacherName || '담임교사';

  if (state.activeRole === 'teacher') {
    nameElem.innerText = `${gc ? gc + ' ' : ''}${tName} 교사`;
    subElem.innerText = `${school}${gc ? ' ' + gc : ''} · 관리자 모드`;
    badgeElem.innerText = "교사";
    badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-purple-100 text-purple-700";
    avatarElem.innerText = (tName && tName[0]) || "교";
    if (profileBtn) profileBtn.classList.remove('hidden');

    studentNav.classList.add('hidden');
    teacherNav.classList.remove('hidden');
    teacherNav.classList.add('flex');
    if (typeof switchTeacherBottomTab === 'function') {
      switchTeacherBottomTab('home');
    }
  } else {
    if (profileBtn) profileBtn.classList.add('hidden');
    if (state.activeRole === 'student') {
      const stuDisplay = cu.maskedName || cu.studentName || cu.userId || '학생';
      nameElem.innerText = `${gc ? gc + ' ' : ''}${stuDisplay} 학생`;
      badgeElem.innerText = "학생";
      badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-indigo-100 text-indigo-700";
      avatarElem.innerText = (stuDisplay && stuDisplay[0]) || "학";
    } else {
      const pDisplay = cu.parentName || cu.userId || '학부모';
      nameElem.innerText = `${gc ? gc + ' ' : ''}${pDisplay}`;
      badgeElem.innerText = "학부모";
      badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-emerald-100 text-emerald-700";
      avatarElem.innerText = "학";
    }
    subElem.innerText = `${school}${gc ? ' ' + gc : ''} · 담임 ${tName} 선생님`;

    const cAvatar = document.getElementById('counselingTeacherAvatar');
    const cName = document.getElementById('counselingTeacherName');
    const cClass = document.getElementById('counselingTeacherClass');
    if (cAvatar) cAvatar.innerText = (tName && tName[0]) || '담';
    if (cName) cName.innerText = `${tName} 담임선생님`;
    if (cClass) cClass.innerText = gc ? `(${gc})` : '';

    const bLabel = document.getElementById('budgetClassLabel');
    if (bLabel) bLabel.innerText = `${gc ? gc + ' ' : ''}학급회비 잔액`;

    teacherNav.classList.add('hidden');
    teacherNav.classList.remove('flex');
    studentNav.classList.remove('hidden');
    if (typeof switchBottomTab === 'function') {
      switchBottomTab('home');
    }
  }
}

function logout() {
  document.getElementById('dashboardScreen').classList.add('hidden');
  document.getElementById('dashboardScreen').classList.remove('flex');
  document.getElementById('loginScreen').classList.remove('hidden');
}

function renderAll() {
  // Student Views
  if (typeof renderUrgentDocuments === 'function') renderUrgentDocuments();
  if (typeof renderTimetable === 'function') renderTimetable();
  if (typeof renderMeals === 'function') renderMeals();
  if (typeof renderAttendanceHistory === 'function') renderAttendanceHistory();
  if (typeof renderCirculars === 'function') renderCirculars();
  if (typeof renderBudget === 'function') renderBudget();
  if (typeof renderStudentChat === 'function') renderStudentChat();

  // Teacher Views
  if (typeof renderTeacherHome === 'function') renderTeacherHome();
  if (typeof renderTeacherDocs === 'function') renderTeacherDocs();
  if (typeof renderTeacherCirculars === 'function') renderTeacherCirculars();
  if (typeof renderRemoteTasks === 'function') renderRemoteTasks();
  if (typeof renderTeacherChatRooms === 'function') renderTeacherChatRooms();
}

// PWA Standalone Push Permission Gate
function isStandalonePwa() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function checkAndEnforcePwaPushGate() {
  const gateModal = document.getElementById('pwaPushGateModal');
  const deniedGuide = document.getElementById('pwaPushDeniedGuide');
  if (!gateModal) return;

  if (isStandalonePwa() && 'Notification' in window && Notification.permission !== 'granted') {
    gateModal.classList.remove('hidden');
    if (deniedGuide) {
      deniedGuide.classList.toggle('hidden', Notification.permission !== 'denied');
    }
  } else {
    gateModal.classList.add('hidden');
  }
}

async function subscribeToWebPush(silent = false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }
  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();

  if (!subscription) {
    let publicKey = '';
    try {
      const resp = await fetch('/api/push', { method: 'GET' });
      const json = await resp.json();
      publicKey = (json && json.publicKey) ? json.publicKey.trim() : '';
    } catch (_) {
      publicKey = '';
    }
    if (!publicKey) {
      if (!silent) showToast('서버 VAPID 공개키가 설정되지 않아 푸시 구독을 건너뜁니다.', 'ℹ️');
      return false;
    }
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey)
    });
  }

  const subJson = subscription.toJSON ? subscription.toJSON() : JSON.parse(JSON.stringify(subscription));
  const cu = mockData.currentUser;
  if (gasApi.isConfigured()) {
    await gasApi.post('save_push_subscription', {
      data: {
        user_id: cu.userId || cu.studentId || 'anonymous',
        role: state.activeRole,
        endpoint: subJson.endpoint || '',
        p256dh: (subJson.keys && subJson.keys.p256dh) || '',
        auth: (subJson.keys && subJson.keys.auth) || '',
        user_agent: navigator.userAgent || ''
      }
    });
  }
  return true;
}

async function requestPwaNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('이 브라우저는 알림 기능을 지원하지 않습니다.', '⚠️');
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      try {
        await subscribeToWebPush(true);
      } catch (err) {
        console.warn('Web Push 구독 저장 중 오류:', err);
      }
      const gateModal = document.getElementById('pwaPushGateModal');
      if (gateModal) gateModal.classList.add('hidden');
      showToast('알림 권한이 허용되었습니다.', '🔔');
    } else {
      const deniedGuide = document.getElementById('pwaPushDeniedGuide');
      if (deniedGuide) deniedGuide.classList.remove('hidden');
      showToast('알림 권한이 거부되었습니다. 기기 설정에서 허용해 주세요.', '⚠️');
    }
  } catch (err) {
    showToast(`알림 권한 요청 오류: ${err.message}`, '⚠️');
  }
}

// Service Worker Auto-Update & Foreground Data Sync
let _swRegistration = null;
let _lastForegroundSyncAt = 0;

function initServiceWorkerAndAutoSync() {
  if ('serviceWorker' in navigator) {
    let swReadyForReload = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!swReadyForReload) {
        swReadyForReload = true;
        return;
      }
      if (refreshing) return;
      refreshing = true;
      showToast('새 버전이 적용되어 앱을 새로고침합니다.', '🔄');
      setTimeout(() => {
        window.location.reload();
      }, 350);
    });

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        _swRegistration = registration;
      })
      .catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    if (_swRegistration && typeof _swRegistration.update === 'function') {
      _swRegistration.update().catch(() => {});
    }

    const dash = document.getElementById('dashboardScreen');
    const isLoggedIn = dash && !dash.classList.contains('hidden');
    if (isLoggedIn && gasApi.isConfigured()) {
      const now = Date.now();
      if (now - _lastForegroundSyncAt >= 10000) {
        _lastForegroundSyncAt = now;
        refreshFromGas(false);
      }
    }
  });
}

// Initialize Dates, Canvas & Service Worker on Load
window.addEventListener('DOMContentLoaded', () => {
  initServiceWorkerAndAutoSync();

  const today = new Date().toISOString().split('T')[0];
  const attStart = document.getElementById('attStartDate');
  const attEnd = document.getElementById('attEndDate');
  const counselDate = document.getElementById('counselDate');
  if (attStart) attStart.value = today;
  if (attEnd) attEnd.value = today;
  if (counselDate) counselDate.value = today;
  if (typeof initSignaturePad === 'function') {
    initSignaturePad();
  }

  checkAndEnforcePwaPushGate();
});