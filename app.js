/* =========================================================
   EduFlow Mobile - Core Application State, GAS REST API & Shared UI
   Google Apps Script(GAS) REST API 연동 + 오프라인/데모 폴백 지원
   ========================================================= */

const GAS_STORAGE_KEYS = {
  url: 'eduflow_gas_url',
  sheetId: 'eduflow_gas_sheet_id',
  session: 'eduflow_user_session'
};

const gasApi = {
  getUrl() {
    return (localStorage.getItem(GAS_STORAGE_KEYS.url) || '').trim();
  },
  getSheetId() {
    return (localStorage.getItem(GAS_STORAGE_KEYS.sheetId) || '').trim();
  },
  setConfig(url, sheetId = '') {
    const cleanUrl = (url || '').trim();
    const cleanSid = (sheetId || '').trim();
    if (cleanUrl) localStorage.setItem(GAS_STORAGE_KEYS.url, cleanUrl);
    else localStorage.removeItem(GAS_STORAGE_KEYS.url);
    if (cleanSid) localStorage.setItem(GAS_STORAGE_KEYS.sheetId, cleanSid);
    else localStorage.removeItem(GAS_STORAGE_KEYS.sheetId);
  },
  isConfigured() {
    return /^https:\/\/script\.google\.com\/macros\/s\//.test(this.getUrl());
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
    const baseUrl = this.getUrl();
    if (!baseUrl) throw new Error('Apps Script URL이 설정되지 않았습니다.');
    const qs = new URLSearchParams({ action, ...params });
    const sid = this.getSheetId();
    if (sid && !qs.has('sheetId')) qs.set('sheetId', sid);
    const sep = baseUrl.includes('?') ? '&' : '?';
    const resp = await fetch(`${baseUrl}${sep}${qs.toString()}`, {
      method: 'GET',
      redirect: 'follow'
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json && json.ok === false) throw new Error(json.error || 'Apps Script 오류');
    return json;
  },
  async post(action, payload = {}) {
    const baseUrl = this.getUrl();
    if (!baseUrl) throw new Error('Apps Script URL이 설정되지 않았습니다.');
    const body = { action, ...payload };
    const sid = this.getSheetId();
    if (sid && !body.sheetId) body.sheetId = sid;
    // text/plain 사용으로 브라우저 CORS Preflight(OPTIONS) 우회
    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json && json.ok === false) throw new Error(json.error || 'Apps Script 오류');
    return json;
  }
};

let mockData = {
  currentUser: {
    role: "student",
    studentId: "10315",
    studentName: "유재석",
    maskedName: "유OO",
    parentName: "유OO 학부모님",
    gradeClass: "1학년 3반",
    schoolName: "서울고등학교",
    teacherName: "박은혜"
  },
  isCounselingOpen: false,
  rules: {
    sickDays: 5,
    fieldPreDays: 3,
    fieldPostDays: 5
  },
  urgentDocuments: [
    {
      id: "DOC-2025-001",
      studentId: "10315",
      studentName: "유재석",
      type: "urgency",
      dDayText: "긴급 D-1",
      dDayColor: "urgent",
      title: "질병결석 (11/10~11/11)",
      docName: "결석신고서",
      description: "나이스 결석신고서 제출 대상 (종료일 기준 5영업일 이내)",
      deadline: "2025-11-18",
      status: "pending", // 'pending' | 'submitted' | 'closed'
      submittedAt: null
    },
    {
      id: "DOC-2025-002",
      studentId: "10315",
      studentName: "유재석",
      type: "planning",
      dDayText: "사전 D-3",
      dDayColor: "alert",
      title: "교외체험학습 (11/25~11/27)",
      docName: "체험학습 신청서",
      description: "교외체험학습 사전 신청서 제출 대상 (시작 3영업일 전 마감)",
      deadline: "2025-11-20",
      status: "pending",
      submittedAt: null
    },
    {
      id: "DOC-2025-003",
      studentId: "10309",
      studentName: "박명수",
      type: "urgency",
      dDayText: "검수대기",
      dDayColor: "urgent",
      title: "인정조퇴 (11/13)",
      docName: "지각·조퇴신고서",
      description: "공적 사유 인정조퇴 신고서 나이스 제출 완료 보고",
      deadline: "2025-11-20",
      status: "submitted",
      submittedAt: "오늘 08:45 제출"
    },
    {
      id: "DOC-2025-004",
      studentId: "10304",
      studentName: "김태호",
      type: "closed",
      dDayText: "종결",
      dDayColor: "success",
      title: "질병결석 (11/03)",
      docName: "결석신고서",
      description: "나이스 결재 확인 완료",
      deadline: "2025-11-10",
      status: "closed",
      submittedAt: "11/05 최종완료"
    },
    {
      id: "DOC-2025-005",
      studentId: "10318",
      studentName: "정준하",
      type: "closed",
      dDayText: "종결",
      dDayColor: "success",
      title: "생리지각 (11/04)",
      docName: "지각·조퇴신고서",
      description: "나이스 결재 확인 완료",
      deadline: "2025-11-11",
      status: "closed",
      submittedAt: "11/06 최종완료"
    }
  ],
  attendanceHistory: [
    { id: "ATT-01", period: "2025-11-10 ~ 11-11", type: "질병결석", reason: "급성 인후염 및 고열로 인한 병원 진료", docStatus: "서류 미제출" },
    { id: "ATT-02", period: "2025-11-25 ~ 11-27", type: "교외체험학습", reason: "가족 동반 역사 유적지 탐방", docStatus: "서류 미제출" },
    { id: "ATT-03", period: "2025-10-15", type: "인정 지각/조퇴", reason: "전국학생과학발명품경진대회 시상식 참석", docStatus: "교사 최종완료" }
  ],
  teacherTodayAttendance: [
    { id: "TA-1", studentId: "10315", name: "유재석", type: "질병결석", reason: "급성 인후염 진료", confirmed: false },
    { id: "TA-2", studentId: "10307", name: "노홍철", type: "질병결석", reason: "독감 격리 권고", confirmed: true },
    { id: "TA-3", studentId: "10309", name: "박명수", type: "인정조퇴", reason: "치과 교정 진료 (확인서 지참)", confirmed: false },
    { id: "TA-4", studentId: "10321", name: "이광수", type: "교외체험학습", reason: "가족 국내 체험학습 (2일차)", confirmed: true }
  ],
  timetable: [
    { period: 1, subject: "국어", teacher: "이지은", isChanged: false, time: "09:00" },
    { period: 2, subject: "수학Ⅰ", teacher: "최민수", isChanged: false, time: "09:50" },
    { period: 3, subject: "자습", teacher: "박OO (대체)", isChanged: true, original: "화학Ⅰ", time: "10:40" },
    { period: 4, subject: "영어", teacher: "한가인", isChanged: false, time: "11:30" },
    { period: 5, subject: "수학Ⅰ", teacher: "김OO (보강)", isChanged: true, original: "체육", time: "13:10" },
    { period: 6, subject: "한국사", teacher: "정약용", isChanged: false, time: "14:00" },
    { period: 7, subject: "동아리", teacher: "담당교사", isChanged: false, time: "14:50" }
  ],
  teacherSchedule: [
    { period: "1교시", target: "1학년 3반", subject: "통합과학", changed: false },
    { period: "3교시", target: "1학년 5반", subject: "보강(자습)", changed: true },
    { period: "4교시", target: "1학년 2반", subject: "통합과학", changed: false },
    { period: "6교시", target: "1학년 3반", subject: "창체(동아리)", changed: false }
  ],
  meals: {
    lunch: {
      calories: "785 kcal",
      menu: [
        { name: "친환경 흑미밥", allergy: "" },
        { name: "쇠고기 미역국", allergy: "16" },
        { name: "수제 떡갈비 구이", allergy: "1, 2, 5, 6, 10, 15, 16" },
        { name: "매콤 콩나물무침", allergy: "5" },
        { name: "배추김치", allergy: "9" },
        { name: "샤인머스캣", allergy: "" }
      ],
      allergyNotice: "1.난류 2.우유 5.대두 6.밀 9.새우 10.돼지고기 16.소고기"
    },
    dinner: {
      calories: "820 kcal",
      menu: [
        { name: "베이컨 김치볶음밥", allergy: "1, 5, 6, 10" },
        { name: "유부 맑은장국", allergy: "5, 6" },
        { name: "바삭 치킨텐더 & 렌치드레싱", allergy: "1, 2, 5, 6, 15" },
        { name: "수제 오이피클", allergy: "" },
        { name: "요구르트(런)", allergy: "2" }
      ],
      allergyNotice: "1.난류 2.우유 5.대두 6.밀 10.돼지고기"
    }
  },
  circulars: [
    {
      id: "CIR-104",
      docNum: "서울고등학교 제2025-104호",
      title: "2025학년도 2학기 현장체험학습 참가 동의 조사",
      deadline: "2025-11-21 마감",
      status: "pending",
      submittedCount: 24,
      totalCount: 28,
      content: "학부모님의 가정에 늘 평안과 행복이 깃들기를 기원합니다. 본교에서는 교육과정의 일환으로 학생들의 자율성과 협동심을 기르고자 현장체험학습을 실시하고자 하오니, 참가 여부를 회신해 주시기 바랍니다.",
      meta: ["일시: 2025년 11월 28일(금) 09:00~17:00", "장소: 국립중앙박물관 및 서울숲 일대", "비용: 학교운영지원비 전액 지원"]
    },
    {
      id: "CIR-102",
      docNum: "서울고등학교 제2025-102호",
      title: "2학기 기말고사 시험 시간표 및 부정행위 예방 안내",
      deadline: "2025-11-12 마감",
      status: "submitted",
      submittedCount: 28,
      totalCount: 28,
      content: "2025학년도 2학기 2차 지필평가(기말고사) 실시 계획 및 시험 유의사항을 안내하오니 가정에서도 지도 부탁드립니다.",
      meta: ["기간: 2025년 12월 08일(월) ~ 12월 11일(목)", "준비물: 컴퓨터용 사인펜, 학생증"]
    }
  ],
  budget: {
    balance: 184500,
    income: 300000,
    expense: 115500,
    transactions: [
      { id: "TX-1", date: "11/12", title: "체육대회 학급 단체 반티 추가 제작비", type: "expense", amount: 42000, store: "유니폼팩토리", card: "학급체크카드 (****-4821)" },
      { id: "TX-2", date: "10/28", title: "중간고사 응원 간식(초콜릿·음료) 구입", type: "expense", amount: 53500, store: "이마트24 서울고점", card: "학급체크카드 (****-4821)" },
      { id: "TX-3", date: "09/15", title: "학급 환경미화 게시판 문구류", type: "expense", amount: 20000, store: "다이소 역삼점", card: "학급체크카드 (****-4821)" },
      { id: "TX-4", date: "09/02", title: "2학기 학급운영비 배정 입금", type: "income", amount: 300000, store: "학교회계 전입금", card: "계좌이체" }
    ]
  },
  chatRooms: [
    {
      roomId: "ROOM-10315",
      studentId: "10315",
      studentName: "유재석",
      partnerLabel: "유재석 학생 학부모",
      subtitle: "1학년 3반 15번 유재석",
      unread: 1,
      messages: [
        { sender: "teacher", text: "안녕하세요, 1학년 3반 담임 박은혜입니다. 궁금한 사항이나 전달하실 말씀이 있으면 편하게 남겨주세요.", time: "어제 15:20" },
        { sender: "user", text: "선생님 안녕하세요! 11/10~11 질병결석 건 나이스 결석신고서 오늘 저녁 중으로 올리겠습니다.", time: "오늘 08:15" }
      ]
    },
    {
      roomId: "ROOM-10309",
      studentId: "10309",
      studentName: "박명수",
      partnerLabel: "10309 박명수 (학생)",
      subtitle: "1학년 3반 9번 박명수",
      unread: 0,
      messages: [
        { sender: "user", text: "선생님 오늘 6교시 끝나고 치과 진료 때문에 조퇴해야 할 것 같습니다.", time: "어제 16:40" },
        { sender: "teacher", text: "알겠습니다. 진료 확인서 챙겨서 나이스로 제출해 주세요.", time: "어제 16:52" }
      ]
    }
  ],
  remoteTasks: [
    { id: "JOB-01", type: "과세특/행특 AI 초안 생성", timing: "완료 (어제 18:12)", prompt: "1학년 통합과학 수행평가 보고서 기반 세특 초안 28명 생성", status: "done", log: "28명 초안 생성 및 HWPX 저장 완료" },
    { id: "JOB-02", type: "학급 주간 출결 보고서(HWPX) 자동 생성", timing: "예약됨 (오늘 17:30)", prompt: "11월 2주차 1-3반 출결 및 미제출 서류 현황표 생성", status: "pending", log: "PC EduFlow 워커 대기 중" }
  ]
};

// Global Application State
const state = {
  activeRole: 'student',
  activeMealTab: 'lunch',
  selectedAttType: '질병결석',
  currentCircularId: null,
  teacherDocFilter: 'pending',
  activeTeacherChatRoomId: 'ROOM-10315',
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
  document.getElementById('noticeModal').classList.toggle('hidden');
  document.getElementById('unreadDot').classList.add('hidden');
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
    idInput.value = "10315";
  } else if (role === 'parent') {
    idLabel.innerText = "학부모 아이디";
    idInput.placeholder = "휴대폰 번호 또는 학부모 ID";
    idInput.value = "P-010-8899-7711";
  } else {
    idLabel.innerText = "교사 교원번호/ID";
    idInput.placeholder = "나이스 교원 인증 ID";
    idInput.value = "T-2024091";
  }
}

function quickLogin(role) {
  selectRole(role);
  handleLogin(new Event('submit'), true);
}

async function handleLogin(e, isQuickDemo = false) {
  if (e) e.preventDefault();
  const userId = (document.getElementById('loginIdInput')?.value || '').trim();
  const password = (document.getElementById('loginPwInput')?.value || '');

  if (!isQuickDemo && gasApi.isConfigured()) {
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
    } catch (err) {
      showToast(`로그인 실패: ${err.message}`, '⚠️');
      return;
    }
  } else {
    mockData.currentUser.role = state.activeRole;
    if (gasApi.isConfigured()) {
      refreshFromGas(false).catch(() => {});
    }
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
  const grade = user.grade || '1';
  const classNo = user.class_no || '3';
  const rawName = user.name || mockData.currentUser.studentName;
  const masked = rawName.length >= 2 ? rawName[0] + 'OO' : rawName;

  mockData.currentUser = {
    ...mockData.currentUser,
    role,
    userId: user.teacher_id || user.student_id || user.parent_id || user.remote_id || '',
    studentId: user.student_id || mockData.currentUser.studentId,
    studentName: role === 'parent' ? (user.student_name || mockData.currentUser.studentName) : rawName,
    maskedName: masked,
    parentName: role === 'parent' ? rawName : `${masked} 학부모님`,
    grade: String(grade),
    classNo: String(classNo),
    gradeClass: `${grade}학년 ${classNo}반`,
    schoolName: user.school_name || mockData.currentUser.schoolName,
    teacherName: role === 'teacher' ? rawName : mockData.currentUser.teacherName
  };
}

async function refreshFromGas(showFeedback = true) {
  if (!gasApi.isConfigured()) {
    if (showFeedback) showToast('데모 모드입니다. 로그인 화면 [API 연동]에서 URL을 설정하세요.', 'ℹ️');
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
    if (showFeedback) showToast(`동기화 오류: ${err.message}`, '⚠️');
  }
}

function hydrateMockDataFromBundle(bundle) {
  if (!bundle || !bundle.ok) return;

  // 1. 교사 & 상담 ON/OFF 상태
  if (Array.isArray(bundle.teachers) && bundle.teachers.length > 0) {
    const t = bundle.teachers[0];
    mockData.currentUser.teacherName = t.name || mockData.currentUser.teacherName;
    mockData.currentUser.schoolName = t.school_name || mockData.currentUser.schoolName;
    mockData.isCounselingOpen = String(t.consultation_enabled) === '1' || t.consultation_enabled === true;
  }

  // 2. 서류 규정
  if (Array.isArray(bundle.doc_rules) && bundle.doc_rules.length > 0) {
    const abs = bundle.doc_rules.find(r => r.rule_code === 'ABSENCE_REPORT');
    const fld = bundle.doc_rules.find(r => r.rule_code === 'FIELD_TRIP');
    if (abs && abs.due_business_days) mockData.rules.sickDays = parseInt(abs.due_business_days, 10) || 5;
    if (fld && fld.due_business_days) mockData.rules.fieldPostDays = parseInt(fld.due_business_days, 10) || 5;
  }

  // 3. 서류 추적 (urgentDocuments)
  if (Array.isArray(bundle.doc_tracking) && bundle.doc_tracking.length > 0) {
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

  // 4. 일일 출결 (학생 이력 + 교사용 오늘 출결)
  if (Array.isArray(bundle.attendance) && bundle.attendance.length > 0) {
    mockData.attendanceHistory = bundle.attendance.map(a => ({
      id: a.remote_id,
      period: a.date || '',
      type: a.attendance_type || '출결',
      reason: a.reason || '',
      docStatus: String(a.teacher_confirmed) === '1' ? '교사 최종완료' : '접수됨'
    }));
    mockData.teacherTodayAttendance = bundle.attendance.map(a => ({
      id: a.remote_id,
      studentId: String(a.student_id || ''),
      name: a.student_name || '',
      type: a.attendance_type || '출결',
      reason: a.reason || '',
      confirmed: String(a.teacher_confirmed) === '1'
    }));
  }

  // 5. 시간표 (기본 + 변동 병합)
  if (Array.isArray(bundle.timetable_base) && bundle.timetable_base.length > 0) {
    const todayStr = new Date().toISOString().split('T')[0];
    const changes = Array.isArray(bundle.timetable_changes) ? bundle.timetable_changes : [];
    mockData.timetable = bundle.timetable_base.map(tb => {
      const chg = changes.find(c =>
        String(c.period) === String(tb.period) && (!c.date || c.date === todayStr)
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
  }

  // 6. 급식 식단표 (NEIS)
  if (Array.isArray(bundle.meals) && bundle.meals.length > 0) {
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
    if (lunch) mockData.meals.lunch = mapMeal(lunch);
    if (dinner) mockData.meals.dinner = mapMeal(dinner);
  }

  // 7. 가정통신문 목록 & 회신
  if (Array.isArray(bundle.notices) && bundle.notices.length > 0) {
    const replies = Array.isArray(bundle.notice_replies) ? bundle.notice_replies : [];
    const cuId = String(mockData.currentUser.studentId || '');
    mockData.circulars = bundle.notices.map(n => {
      const nReplies = replies.filter(r => r.notice_id === n.remote_id);
      const myReply = nReplies.find(r => String(r.student_id) === cuId);
      return {
        id: n.remote_id,
        docNum: n.category || '가정통신문',
        title: n.title || '',
        deadline: n.due_date ? `${n.due_date} 마감` : '상시',
        status: myReply ? 'submitted' : 'pending',
        submittedCount: nReplies.length,
        totalCount: Math.max(nReplies.length, 28),
        content: n.content || '',
        meta: n.attachment_url ? [`첨부: ${n.attachment_url}`] : [`작성: ${n.author_name || '담임교사'}`]
      };
    });
  }

  // 8. 1:1 상담 채팅
  if (Array.isArray(bundle.chat_messages) && bundle.chat_messages.length > 0) {
    const roomMap = {};
    bundle.chat_messages.forEach(c => {
      const rId = c.room_id || 'ROOM-DEFAULT';
      if (!roomMap[rId]) {
        roomMap[rId] = {
          roomId: rId,
          studentId: rId.replace('ROOM-', ''),
          studentName: c.sender_role !== 'teacher' ? (c.sender_name || '학생') : '학생',
          partnerLabel: c.sender_role !== 'teacher' ? (c.sender_name || rId) : rId,
          subtitle: rId,
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
    if (mockData.chatRooms.length > 0) {
      state.activeTeacherChatRoomId = mockData.chatRooms[0].roomId;
    }
  }

  // 9. PC 원격 예약 작업 (Tasks 시트)
  if (Array.isArray(bundle.remote_tasks) && bundle.remote_tasks.length > 0) {
    mockData.remoteTasks = bundle.remote_tasks.map(t => ({
      id: t.remote_id,
      type: t.title || t.task_type || '원격 작업',
      timing: t.scheduled_time || '즉시 실행',
      prompt: t.target_info || t.action_payload || '',
      status: t.exec_status === 'done' ? 'done' : (t.exec_status === 'running' ? 'running' : 'pending'),
      log: t.memo || (t.exec_status === 'done' ? 'PC 작업 완료' : 'PC EduFlow 워커 대기 중')
    }));
  }
}

function openApiConfigModal() {
  const urlEl = document.getElementById('gasUrlInput');
  const sidEl = document.getElementById('gasSheetIdInput');
  if (urlEl) urlEl.value = gasApi.getUrl();
  if (sidEl) sidEl.value = gasApi.getSheetId();
  openModal('apiConfigModal');
}

function saveApiConfig(e) {
  e.preventDefault();
  const url = document.getElementById('gasUrlInput').value;
  const sid = document.getElementById('gasSheetIdInput').value;
  gasApi.setConfig(url, sid);
  closeModal('apiConfigModal');
  showToast(gasApi.isConfigured() ? 'Apps Script 연동 URL이 저장되었습니다.' : '데모(오프라인) 모드로 전환되었습니다.', '🔗');
}

async function testGasConnection() {
  const url = document.getElementById('gasUrlInput').value.trim();
  const sid = document.getElementById('gasSheetIdInput').value.trim();
  if (!url) {
    showToast('Apps Script 웹 앱 URL을 먼저 입력하세요.', '⚠️');
    return;
  }
  gasApi.setConfig(url, sid);
  try {
    const res = await gasApi.get('ping');
    showToast(`연결 성공: ${res.spreadsheet_name || '시트'} (${(res.all_sheets || []).length}개 시트)`, '✅');
  } catch (err) {
    showToast(`연결 실패: ${err.message}`, '❌');
  }
}

function toggleTeacherStudentMode() {
  state.activeRole = (state.activeRole === 'teacher') ? 'student' : 'teacher';
  mockData.currentUser.role = state.activeRole;
  applyRoleUI();
  renderAll();
  showToast(state.activeRole === 'teacher' ? '교사 관리자 모드로 전환되었습니다.' : '학생 모드로 전환되었습니다.', '🔄');
}

function applyRoleUI() {
  const nameElem = document.getElementById('userNameDisplay');
  const subElem = document.getElementById('userSubDisplay');
  const badgeElem = document.getElementById('userBadge');
  const avatarElem = document.getElementById('userAvatarText');
  const toggleText = document.getElementById('headerRoleToggleText');

  const studentNav = document.getElementById('studentBottomNav');
  const teacherNav = document.getElementById('teacherBottomNav');

  if (state.activeRole === 'teacher') {
    const tName = mockData.currentUser.teacherName || '담임';
    nameElem.innerText = `${mockData.currentUser.gradeClass} ${tName} 담임교사`;
    subElem.innerText = `${mockData.currentUser.schoolName} ${mockData.currentUser.gradeClass} · 관리자 모드`;
    badgeElem.innerText = "교사";
    badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-purple-100 text-purple-700";
    avatarElem.innerText = tName[0] || "교";
    toggleText.innerText = "학생모드 전환";

    studentNav.classList.add('hidden');
    teacherNav.classList.remove('hidden');
    teacherNav.classList.add('flex');
    if (typeof switchTeacherBottomTab === 'function') {
      switchTeacherBottomTab('home');
    }
  } else {
    if (state.activeRole === 'student') {
      nameElem.innerText = `${mockData.currentUser.gradeClass} ${mockData.currentUser.maskedName} 학생`;
      badgeElem.innerText = "학생";
      badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-indigo-100 text-indigo-700";
      avatarElem.innerText = (mockData.currentUser.maskedName || "학")[0];
    } else {
      nameElem.innerText = `${mockData.currentUser.gradeClass} ${mockData.currentUser.parentName}`;
      badgeElem.innerText = "학부모";
      badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-emerald-100 text-emerald-700";
      avatarElem.innerText = "학";
    }
    subElem.innerText = `${mockData.currentUser.schoolName} ${mockData.currentUser.gradeClass} · 담임 ${mockData.currentUser.teacherName} 선생님`;
    toggleText.innerText = "교사모드 전환";

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

// Initialize Dates, Canvas, URL API Param & Service Worker on Load
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const apiParam = urlParams.get('api');
  const sidParam = urlParams.get('sheetId') || '';
  if (apiParam) {
    gasApi.setConfig(apiParam, sidParam);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

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
});