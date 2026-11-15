/* =========================================================
   EduFlow Mobile - Core Application State, Data & Shared UI
   추후 Google Apps Script(GAS) REST API 연동 시 mockData 레이어 교체
   ========================================================= */

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
  handleLogin(new Event('submit'));
}

function handleLogin(e) {
  if (e) e.preventDefault();
  mockData.currentUser.role = state.activeRole;
  applyRoleUI();
  document.getElementById('loginScreen').classList.add('hidden');
  const dash = document.getElementById('dashboardScreen');
  dash.classList.remove('hidden');
  dash.classList.add('flex');
  renderAll();
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
    nameElem.innerText = `${mockData.currentUser.gradeClass} 박은혜 담임교사`;
    subElem.innerText = `서울고등학교 1-3반 · 관리자 모드`;
    badgeElem.innerText = "교사";
    badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-purple-100 text-purple-700";
    avatarElem.innerText = "박";
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
      avatarElem.innerText = "유";
    } else {
      nameElem.innerText = `${mockData.currentUser.gradeClass} ${mockData.currentUser.parentName}`;
      badgeElem.innerText = "학부모";
      badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-emerald-100 text-emerald-700";
      avatarElem.innerText = "학";
    }
    subElem.innerText = `서울고등학교 1-3반 · 담임 박은혜 선생님`;
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

// Initialize Dates & Canvas on Load
window.addEventListener('DOMContentLoaded', () => {
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