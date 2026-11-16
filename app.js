/* =========================================================
   EduFlow Mobile - Core Application State, Cloud Firestore API & Shared UI
   Cloud Firestore 직접 연동 + 읽기 비용 최적화(반별 필터 + 일일 캐싱 + 제한적 onSnapshot)
   ========================================================= */

const GAS_PROXY_ENDPOINT = '/api/firestore';

const FIREBASE_WEB_CONFIG = {
  apiKey: "AIzaSyDsLrlZsqpNSRnk3BW3aM_p9u2v_9WtpGI",
  authDomain: "eduflow-db-b44f3.firebaseapp.com",
  projectId: "eduflow-db-b44f3",
  storageBucket: "eduflow-db-b44f3.firebasestorage.app",
  messagingSenderId: "491962677360",
  appId: "1:491962677360:web:0b39bb5214567cfb3ddcb5"
};

let _firestoreClient = null;
let _unsubChatListener = null;
let _unsubNotiListener = null;

function _getClientFirestore() {
  if (_firestoreClient) return _firestoreClient;
  if (typeof window !== 'undefined' && window.firebase && window.firebase.firestore) {
    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(FIREBASE_WEB_CONFIG);
    }
    _firestoreClient = window.firebase.firestore();
    return _firestoreClient;
  }
  return null;
}

function _stopRealtimeListeners() {
  if (typeof _unsubChatListener === 'function') {
    try { _unsubChatListener(); } catch (_) {}
    _unsubChatListener = null;
  }
  if (typeof _unsubNotiListener === 'function') {
    try { _unsubNotiListener(); } catch (_) {}
    _unsubNotiListener = null;
  }
}

function _startRealtimeListeners() {
  const fs = _getClientFirestore();
  if (!fs) return;
  _stopRealtimeListeners();

  const cu = mockData.currentUser || {};
  const role = String(cu.role || state.activeRole || 'student').toLowerCase();
  const gradeNum = cu.grade ? Number(cu.grade) : null;
  const classNum = cu.classNo ? Number(cu.classNo) : null;

  // 1) 1:1_상담채팅 실시간 리스너 (본인 방 또는 담당 학급으로 제한)
  try {
    let chatQuery = fs.collection('1:1_상담채팅');
    if (role !== 'teacher' && cu.studentId) {
      chatQuery = chatQuery.where('room_id', '==', `ROOM-${cu.studentId}`);
    } else if (gradeNum && classNum) {
      chatQuery = chatQuery.where('grade', '==', gradeNum).where('class_no', '==', classNum);
    } else {
      chatQuery = chatQuery.limit(50);
    }
    _unsubChatListener = chatQuery.onSnapshot((snap) => {
      const chatRows = [];
      snap.forEach((doc) => chatRows.push({ remote_id: doc.id, ...doc.data() }));
      chatRows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      hydrateMockDataFromBundle({ ok: true, chat_messages: chatRows });
      if (typeof renderTeacherChat === 'function' && role === 'teacher') renderTeacherChat();
      if (typeof renderStudentChat === 'function' && role !== 'teacher') renderStudentChat();
    }, (err) => {
      console.warn('[Firestore onSnapshot Chat]', err && err.message ? err.message : err);
    });
  } catch (_) {}

  // 2) 읽지 않은 Notifications 실시간 리스너 (is_read == false 조건 제한)
  try {
    const notiQuery = fs.collection('Notifications').where('is_read', '==', false).limit(50);
    _unsubNotiListener = notiQuery.onSnapshot((snap) => {
      const notiRows = [];
      snap.forEach((doc) => notiRows.push({ remote_id: doc.id, ...doc.data() }));
      hydrateMockDataFromBundle({ ok: true, notifications: notiRows });
      if (typeof renderNotifications === 'function') renderNotifications();
    }, (err) => {
      console.warn('[Firestore onSnapshot Notifications]', err && err.message ? err.message : err);
    });
  } catch (_) {}
}

function _isTruthyField(val) {
  return val === true || val === 1 || String(val || '').trim().toLowerCase() === 'true' || String(val || '').trim() === '1';
}

const DAILY_STATIC_CACHE_KEY = 'eduflow_daily_static_cache_v1';

function _getTodayDateKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _loadDailyStaticCache(grade, classNo) {
  try {
    const raw = localStorage.getItem(DAILY_STATIC_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.date !== _getTodayDateKey()) return null;
    if (String(parsed.grade || '') !== String(grade || '') || String(parsed.classNo || '') !== String(classNo || '')) {
      return null;
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function _saveDailyStaticCache(grade, classNo, bundle) {
  try {
    if (!bundle) return;
    localStorage.setItem(DAILY_STATIC_CACHE_KEY, JSON.stringify({
      date: _getTodayDateKey(),
      grade: String(grade || ''),
      classNo: String(classNo || ''),
      timetable_base: Array.isArray(bundle.timetable_base) ? bundle.timetable_base : [],
      meals: Array.isArray(bundle.meals) ? bundle.meals : [],
      doc_rules: Array.isArray(bundle.doc_rules) ? bundle.doc_rules : []
    }));
  } catch (_) {}
}

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
    if (json && json.ok === false) {
      const err = new Error(json.error || 'Apps Script 오류');
      err.isServerRejection = true;
      throw err;
    }
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
    if (json && json.ok === false) {
      const err = new Error(json.error || 'Apps Script 오류');
      err.isServerRejection = true;
      throw err;
    }
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
  homeroomSchedule: [],
  rawTimetableBase: [],
  rawTimetableChanges: [],
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
  selectedAttType: '',
  selectedAttCategory: '',
  selectedAttSubType: '',
  currentCircularId: null,
  currentUnsubmittedCircularId: null,
  teacherDocFilter: 'pending',
  activeTeacherChatRoomId: '',
  isSignBoxPinned: true,
  hasDrawnSignature: false
};

const KR_HOLIDAYS = [
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30',
  '2025-03-01', '2025-03-03', '2025-05-05', '2025-05-06',
  '2025-06-06', '2025-08-15', '2025-10-03', '2025-10-05',
  '2025-10-06', '2025-10-07', '2025-10-08', '2025-10-09',
  '2025-12-25',
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-03-01', '2026-03-02', '2026-05-05', '2026-05-24',
  '2026-05-25', '2026-06-06', '2026-08-15', '2026-08-17',
  '2026-09-24', '2026-09-25', '2026-09-26', '2026-10-03',
  '2026-10-05', '2026-10-09', '2026-12-25',
  '2027-01-01', '2027-02-06', '2027-02-07', '2027-02-08',
  '2027-02-09', '2027-03-01', '2027-05-05', '2027-05-13',
  '2027-06-06', '2027-08-15', '2027-08-16', '2027-09-14',
  '2027-09-15', '2027-09-16', '2027-10-03', '2027-10-04',
  '2027-10-09', '2027-10-11', '2027-12-25'
];

function getLocalTodayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isNonBusinessDay(dateObj) {
  const day = dateObj.getDay();
  if (day === 0 || day === 6) return true;
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return KR_HOLIDAYS.includes(`${y}-${m}-${d}`);
}

/**
 * 기준일(yyyy-MM-dd)로부터 N 영업일(주말·공휴일 제외) 이후 날짜 계산
 * apps_script_template.gs _addBusinessDays 와 동일 로직
 */
function addBusinessDays(baseDateStr, businessDays) {
  const parts = String(baseDateStr || '').trim().split('-');
  let d;
  if (parts.length === 3) {
    d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
  } else {
    const now = new Date();
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  }
  const daysToAdd = parseInt(businessDays, 10);
  if (isNaN(daysToAdd) || daysToAdd <= 0) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  let added = 0;
  let guard = 0;
  while (added < daysToAdd && guard < 365) {
    d.setDate(d.getDate() + 1);
    if (!isNonBusinessDay(d)) {
      added++;
    }
    guard++;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatKoreanDateWithDay(ymd) {
  const parts = String(ymd || '').split('-');
  if (parts.length !== 3) return ymd || '';
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${parseInt(parts[1], 10)}월 ${parseInt(parts[2], 10)}일(${days[d.getDay()]})`;
}

/**
 * 오늘 시간표 또는 기본 최대 교시 수 반환 (최소 1, 시간표 없으면 기본 7교시)
 */
function getClassMaxPeriod() {
  const source = (state.activeRole === 'teacher' && Array.isArray(mockData.homeroomSchedule) && mockData.homeroomSchedule.length > 0)
    ? mockData.homeroomSchedule
    : (Array.isArray(mockData.timetable) && mockData.timetable.length > 0 ? mockData.timetable : []);
  const nums = source.map(item => parseInt(item.period, 10)).filter(n => !isNaN(n) && n > 0);
  if (nums.length > 0) {
    return Math.max(...nums);
  }
  return 7;
}

function getPeriodOptionsList(maxPeriod) {
  const maxP = Math.max(1, parseInt(maxPeriod || getClassMaxPeriod(), 10) || 7);
  const list = ['조회'];
  for (let i = 1; i <= maxP; i++) {
    list.push(`${i}교시`);
  }
  return list;
}

// Common Toast Notification
function showToast(msg, icon = '✅') {
  const toast = document.getElementById('globalToast');
  document.getElementById('globalToastIcon').innerText = icon;
  document.getElementById('globalToastMsg').innerText = msg;
  toast.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

// Global Loading Overlay & Button Loading Wrapper
let _loadingCount = 0;

function showLoading(message = '처리 중...') {
  _loadingCount += 1;
  const overlay = document.getElementById('globalLoadingOverlay');
  const msgEl = document.getElementById('globalLoadingMsg');
  if (msgEl) msgEl.innerText = message || '처리 중...';
  if (overlay) overlay.classList.remove('hidden');
}

function hideLoading() {
  _loadingCount = Math.max(0, _loadingCount - 1);
  if (_loadingCount === 0) {
    const overlay = document.getElementById('globalLoadingOverlay');
    if (overlay) overlay.classList.add('hidden');
  }
}

async function withButtonLoading(btnElement, loadingText, asyncFn) {
  if (!btnElement) {
    return await asyncFn();
  }
  if (btnElement.dataset.loading === '1') {
    return;
  }

  const origHtml = btnElement.innerHTML;
  const origDisabled = btnElement.disabled;
  btnElement.dataset.loading = '1';
  btnElement.disabled = true;
  btnElement.classList.add('opacity-75', 'cursor-not-allowed');

  if (loadingText) {
    btnElement.innerHTML = `<span class="inline-flex items-center justify-center gap-1.5"><span class="spinner" aria-hidden="true"></span><span>${loadingText}</span></span>`;
  } else {
    btnElement.innerHTML = `<span class="spinner" aria-hidden="true"></span>`;
  }

  try {
    return await asyncFn();
  } finally {
    btnElement.innerHTML = origHtml;
    btnElement.disabled = origDisabled;
    delete btnElement.dataset.loading;
    btnElement.classList.remove('opacity-75', 'cursor-not-allowed');
  }
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
    void refreshPushStatusUI();
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

const AUTO_LOGIN_STORAGE_KEY = 'eduflow_saved_auth';
const BUNDLE_CACHE_STORAGE_KEY = 'eduflow_cached_bundle';

function _saveAutoLoginAuth(auth) {
  try {
    localStorage.setItem(AUTO_LOGIN_STORAGE_KEY, JSON.stringify({
      role: auth.role,
      userId: auth.userId,
      password: auth.password || '',
      passwordHash: auth.passwordHash || '',
      savedAt: Date.now()
    }));
  } catch (err) {
    console.warn('[EduFlow Auth] 자동 로그인 저장 실패:', err);
  }
}

function _loadAutoLoginAuth() {
  try {
    const raw = localStorage.getItem(AUTO_LOGIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.role || !parsed.userId) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function _clearAutoLoginAuth() {
  try {
    localStorage.removeItem(AUTO_LOGIN_STORAGE_KEY);
  } catch (_) {}
}

function _saveBundleCache(bundle) {
  try {
    if (!bundle || typeof bundle !== 'object') return;
    localStorage.setItem(BUNDLE_CACHE_STORAGE_KEY, JSON.stringify({
      role: state.activeRole,
      userId: mockData.currentUser.userId || '',
      currentUser: mockData.currentUser,
      bundle,
      cachedAt: Date.now()
    }));
  } catch (err) {
    console.warn('[EduFlow Cache] 번들 캐시 저장 실패:', err);
  }
}

function _loadBundleCache(expectedRole = '', expectedUserId = '') {
  try {
    const raw = localStorage.getItem(BUNDLE_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.bundle || typeof parsed.bundle !== 'object') return null;
    if (expectedRole && parsed.role !== expectedRole) return null;
    if (expectedUserId && parsed.userId !== expectedUserId) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function _clearBundleCache() {
  try {
    localStorage.removeItem(BUNDLE_CACHE_STORAGE_KEY);
  } catch (_) {}
}

function _enterDashboardAfterLogin() {
  applyRoleUI();
  document.getElementById('loginScreen').classList.add('hidden');
  const dash = document.getElementById('dashboardScreen');
  dash.classList.remove('hidden');
  dash.classList.add('flex');
  renderAll();
  checkAndEnforcePwaPushGate({ openGuideOnDenied: true });
}

async function _performLoginAuth(role, userId, password, precomputedHash = '', options = {}) {
  state.activeRole = role;
  let pwHash = precomputedHash || '';

  if (gasApi.isConfigured()) {
    try {
      if (!pwHash && password) {
        pwHash = await gasApi.sha256Hex(password);
      }
      const res = await gasApi.post('login', {
        role,
        user_id: userId,
        password: password,
        password_hash: pwHash
      });
      if (res.user) {
        _applyAuthenticatedUser(res.user);
      }
      await refreshFromGas(false);
      if ('Notification' in window && Notification.permission === 'granted') {
        void subscribeToWebPush(true);
      }
      return { ok: true, pwHash, isDemo: false };
    } catch (err) {
      if (err && err.isDemo) {
        mockData.currentUser.role = role;
        mockData.currentUser.userId = userId;
        if (!options.isAutoLogin) {
          showToast('데모 모드로 로그인되었습니다 (연동된 시트 없음).', 'ℹ️');
        }
        return { ok: true, pwHash, isDemo: true };
      }
      return { ok: false, error: err && err.message ? err.message : '인증 실패', isAuthRejected: Boolean(err && err.isServerRejection) };
    }
  }

  mockData.currentUser.role = role;
  mockData.currentUser.userId = userId;
  if (!options.isAutoLogin) {
    showToast('로컬 데모 모드로 실행 중입니다.', 'ℹ️');
  }
  return { ok: true, pwHash, isDemo: true };
}

async function handleLogin(e) {
  if (e) e.preventDefault();
  const userId = (document.getElementById('loginIdInput')?.value || '').trim();
  const password = (document.getElementById('loginPwInput')?.value || '');
  const autoLoginChecked = Boolean(document.getElementById('autoLoginCheck')?.checked);
  const submitBtn = (e && e.submitter) || document.querySelector('#loginScreen form button[type="submit"]');

  let authResult = { ok: false };
  await withButtonLoading(submitBtn, '로그인 중...', async () => {
    if (gasApi.isConfigured()) showLoading('EduFlow 서버 인증 중...');
    try {
      authResult = await _performLoginAuth(state.activeRole, userId, password);
      if (!authResult.ok) {
        showToast(`로그인 실패: ${authResult.error}`, '⚠️');
      }
    } finally {
      if (gasApi.isConfigured()) hideLoading();
    }
  });

  if (!authResult.ok) return;

  if (autoLoginChecked) {
    _saveAutoLoginAuth({
      role: state.activeRole,
      userId,
      password,
      passwordHash: authResult.pwHash
    });
  } else {
    _clearAutoLoginAuth();
  }

  _enterDashboardAfterLogin();
}

async function tryAutoLogin() {
  const saved = _loadAutoLoginAuth();
  if (!saved) return;

  const validRoles = ['student', 'parent', 'teacher'];
  const role = validRoles.includes(saved.role) ? saved.role : 'student';
  selectRole(role);

  const idInput = document.getElementById('loginIdInput');
  const autoCheck = document.getElementById('autoLoginCheck');
  if (idInput) idInput.value = saved.userId;
  if (autoCheck) autoCheck.checked = true;

  const cached = _loadBundleCache(role, saved.userId);
  if (cached && cached.bundle) {
    // 캐시된 사용자 정보 및 번들로 0ms 즉시 진입 (로딩 오버레이 없음)
    if (cached.currentUser && typeof cached.currentUser === 'object') {
      mockData.currentUser = { ...mockData.currentUser, ...cached.currentUser };
    }
    hydrateMockDataFromBundle(cached.bundle);
    _enterDashboardAfterLogin();

    // 백그라운드에서 조용히 인증 및 최신 데이터 동기화
    const refreshIcon = document.querySelector('#headerRefreshBtn svg');
    if (refreshIcon) refreshIcon.classList.add('animate-spin');
    try {
      const authResult = await _performLoginAuth(
        role,
        saved.userId,
        saved.password || '',
        saved.passwordHash || '',
        { isAutoLogin: true }
      );
      if (authResult.ok) {
        applyRoleUI();
        renderAll();
      } else if (authResult.isAuthRejected) {
        logout();
        showToast('자동 로그인 인증에 실패했습니다. 다시 로그인해 주세요.', '⚠️');
      } else {
        showToast('네트워크 연결이 원활하지 않아 저장된 데이터를 표시합니다.', 'ℹ️');
      }
    } finally {
      if (refreshIcon) refreshIcon.classList.remove('animate-spin');
    }
    return;
  }

  showLoading('자동 로그인 중...');
  try {
    const authResult = await _performLoginAuth(
      role,
      saved.userId,
      saved.password || '',
      saved.passwordHash || '',
      { isAutoLogin: true }
    );
    if (authResult.ok) {
      _enterDashboardAfterLogin();
    } else {
      _clearAutoLoginAuth();
      _clearBundleCache();
      const pwInput = document.getElementById('loginPwInput');
      if (pwInput) pwInput.value = '';
      showToast('자동 로그인 인증에 실패했습니다. 다시 로그인해 주세요.', '⚠️');
    }
  } finally {
    hideLoading();
  }
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
    neisSchoolCode: user.neis_school_code || '',
    customId: user.custom_id || '',
    customIdChanged: Boolean(user.custom_id_changed)
  };
}

async function refreshFromGas(showFeedback = true, triggerBtn = null) {
  if (!gasApi.isConfigured()) {
    if (showFeedback) showToast('데모 모드로 동작 중입니다.', 'ℹ️');
    return;
  }
  const btn = triggerBtn || (showFeedback ? document.getElementById('headerRefreshBtn') : null);
  await withButtonLoading(btn, '', async () => {
    if (showFeedback) showLoading('최신 데이터를 동기화 중...');
    try {
      const cu = mockData.currentUser;
      const dailyCache = _loadDailyStaticCache(cu.grade, cu.classNo);
      const bundleParams = {
        role: state.activeRole,
        user_id: cu.userId || '',
        student_id: cu.studentId || '',
        teacher_name: cu.teacherName || '',
        grade: cu.grade || '',
        class_no: cu.classNo || '',
        school_code: cu.neisSchoolCode || '',
        school_name: cu.schoolName || ''
      };
      if (dailyCache) {
        bundleParams.skip_static = '1';
      }
      const bundle = await gasApi.get('get_mobile_bundle', bundleParams);
      if (dailyCache) {
        bundle.timetable_base = dailyCache.timetable_base;
        bundle.meals = dailyCache.meals;
        bundle.doc_rules = dailyCache.doc_rules;
      } else {
        _saveDailyStaticCache(cu.grade, cu.classNo, bundle);
      }
      hydrateMockDataFromBundle(bundle);
      _saveBundleCache(bundle);
      _startRealtimeListeners();
      renderAll();
      if (showFeedback) showToast('최신 데이터를 동기화했습니다.', '🔄');
    } catch (err) {
      if (err && err.isDemo) {
        if (showFeedback) showToast('데모 모드로 동작 중입니다.', 'ℹ️');
        return;
      }
      if (showFeedback) showToast(`동기화 오류: ${err.message}`, '⚠️');
    } finally {
      if (showFeedback) hideLoading();
    }
  });
}

function _getLocalTodayStr(dateObj) {
  const d = dateObj || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _getKoreanTodayDayChar(dateObj) {
  const d = dateObj || new Date();
  return ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
}

function _normalizeTeacherName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/(?:선생님|T)$/i, '').trim();
}

function mergeTimetableForDay(timetableBase, timetableChanges, options = {}) {
  const mode = options.mode === 'teacher' ? 'teacher' : 'class';
  const g = String(options.grade || '').trim();
  const cNo = String(options.classNo || '').trim();
  const tName = _normalizeTeacherName(options.teacherName || '');
  const targetDate = String(options.targetDate || _getLocalTodayStr()).trim();
  const dayChar = String(options.dayChar || _getKoreanTodayDayChar()).trim();

  const baseArr = Array.isArray(timetableBase) ? timetableBase : [];
  const changesArr = Array.isArray(timetableChanges) ? timetableChanges : [];

  const todayBase = baseArr.filter(tb => {
    if (!tb || typeof tb !== 'object') return false;
    const d = String(tb.day_of_week || '').trim();
    return !d || d.startsWith(dayChar);
  });

  const todayChanges = changesArr.filter(c => {
    if (!c || typeof c !== 'object') return false;
    const cDate = String(c.date || c.target_date || '').trim();
    return !cDate || cDate === targetDate;
  });

  if (mode === 'class') {
    const classBase = (g && cNo)
      ? todayBase.filter(tb => {
          const eType = String(tb.entry_type || '').trim();
          const typeOk = !eType || eType === 'class';
          return typeOk && String(tb.grade || '').trim() === g && String(tb.class_no || '').trim() === cNo;
        })
      : todayBase.filter(tb => !tb.entry_type || String(tb.entry_type).trim() === 'class');

    const classChanges = (g && cNo)
      ? todayChanges.filter(c => String(c.grade || '').trim() === g && String(c.class_no || '').trim() === cNo)
      : todayChanges;

    const periodMap = new Map();
    classBase.forEach(tb => {
      const pNum = Number(tb.period || 0);
      const pKey = pNum > 0 ? pNum : String(tb.period || '').trim();
      if (!pKey) return;
      periodMap.set(pKey, {
        period: pNum || tb.period,
        subject: tb.subject || '',
        teacher: _normalizeTeacherName(tb.teacher_name || tb.teacher || ''),
        isChanged: false,
        original: '',
        originalSubject: '',
        changedReason: '',
        time: `${8 + (pNum || 1)}:50`
      });
    });

    classChanges.forEach(c => {
      const pNum = Number(c.period || 0);
      const pKey = pNum > 0 ? pNum : String(c.period || '').trim();
      if (!pKey) return;
      const prev = periodMap.get(pKey);
      periodMap.set(pKey, {
        period: pNum || c.period,
        subject: c.changed_subject || (prev ? prev.subject : ''),
        teacher: _normalizeTeacherName(c.changed_teacher || (prev ? prev.teacher : '') || c.original_teacher || ''),
        isChanged: true,
        original: c.original_subject || (prev ? prev.subject : ''),
        originalSubject: c.original_subject || (prev ? prev.subject : ''),
        changedReason: c.reason || c.changed_reason || c.memo || '',
        time: `${8 + (pNum || 1)}:50`
      });
    });

    return Array.from(periodMap.values()).sort((a, b) => Number(a.period || 0) - Number(b.period || 0));
  }

  // mode === 'teacher'
  if (!tName) return [];
  const explicitTeacherRows = todayBase.filter(
    tb => String(tb.entry_type || '').trim() === 'teacher' && _normalizeTeacherName(tb.teacher_name || tb.teacher) === tName
  );
  const teacherBase = explicitTeacherRows.length > 0
    ? explicitTeacherRows
    : todayBase.filter(tb => _normalizeTeacherName(tb.teacher_name || tb.teacher) === tName);

  const periodMap = new Map();
  teacherBase.forEach(tb => {
    const pNum = Number(tb.period || 0);
    const pKey = pNum > 0 ? pNum : String(tb.period || '').trim();
    if (!pKey) return;
    const tbGrade = String(tb.grade || '').trim();
    const tbClass = String(tb.class_no || '').trim();
    const targetStr = (tbGrade && tbClass) ? `${tbGrade}학년 ${tbClass}반` : '';
    periodMap.set(pKey, {
      _periodNum: pNum || 0,
      _grade: tbGrade,
      _classNo: tbClass,
      period: `${pNum || tb.period}교시`,
      target: targetStr,
      subject: tb.subject || '',
      changed: false
    });
  });

  todayChanges.forEach(c => {
    const pNum = Number(c.period || 0);
    const pKey = pNum > 0 ? pNum : String(c.period || '').trim();
    if (!pKey) return;
    const cChgTeacher = _normalizeTeacherName(c.changed_teacher || '');
    const cOrigTeacher = _normalizeTeacherName(c.original_teacher || '');
    const cGrade = String(c.grade || '').trim();
    const cClass = String(c.class_no || '').trim();
    const prev = periodMap.get(pKey);
    const matchesTeacher = cChgTeacher === tName || cOrigTeacher === tName;
    const matchesPrevClass = prev && cGrade && cClass && prev._grade === cGrade && prev._classNo === cClass;
    if (!matchesTeacher && !matchesPrevClass) return;

    const targetStr = (cGrade && cClass)
      ? `${cGrade}학년 ${cClass}반`
      : (prev ? prev.target : '');
    periodMap.set(pKey, {
      _periodNum: pNum || (prev ? prev._periodNum : 0),
      _grade: cGrade || (prev ? prev._grade : ''),
      _classNo: cClass || (prev ? prev._classNo : ''),
      period: `${pNum || c.period}교시`,
      target: targetStr,
      subject: c.changed_subject || (prev ? prev.subject : ''),
      changed: true
    });
  });

  return Array.from(periodMap.values())
    .sort((a, b) => Number(a._periodNum || 0) - Number(b._periodNum || 0))
    .map(({ _periodNum, _grade, _classNo, ...item }) => item);
}

function buildHomeroomSchedule(timetableBase, timetableChanges, grade, classNo) {
  const g = String(grade || '').trim();
  const cNo = String(classNo || '').trim();
  if (!g || !cNo || (!Array.isArray(timetableBase) && !Array.isArray(timetableChanges))) return [];
  return mergeTimetableForDay(timetableBase, timetableChanges, {
    mode: 'class',
    grade: g,
    classNo: cNo
  });
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
      mockData.isCounselingOpen = _isTruthyField(t.consultation_enabled);
    } else {
      mockData.isCounselingOpen = false;
    }
  }

  // 3. 서류 규정
  if (Array.isArray(bundle.doc_rules)) {
    const abs = bundle.doc_rules.find(r => r.rule_code === 'ABSENCE_REPORT');
    const fld = bundle.doc_rules.find(r => r.rule_code === 'FIELD_TRIP');
    const fldPre = bundle.doc_rules.find(r => r.rule_code === 'FIELD_TRIP_PRE');
    if (abs && abs.due_business_days) mockData.rules.sickDays = parseInt(abs.due_business_days, 10) || 5;
    if (fld && fld.due_business_days) mockData.rules.fieldPostDays = parseInt(fld.due_business_days, 10) || 5;
    if (fldPre && fldPre.due_business_days) mockData.rules.fieldPreDays = parseInt(fldPre.due_business_days, 10) || 3;
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
    mockData.attendanceHistory = bundle.attendance
      .filter(a => (a.attendance_type || '').trim() !== '출석')
      .map(a => ({
        id: a.remote_id,
        period: a.date || '',
        type: a.attendance_type || '출결',
        attCategory: a.att_category || '',
        attSubType: a.att_sub_type || '',
        periodInfo: a.period_info || '',
        reason: a.reason || '',
        docStatus: _isTruthyField(a.teacher_confirmed) ? '교사 최종완료' : '접수됨'
      }));
    const todayStr = getLocalTodayStr();
    const todayAtt = bundle.attendance.filter(a => !a.date || a.date === todayStr);
    mockData.teacherTodayAttendance = todayAtt
      .filter(a => (a.attendance_type || '').trim() !== '출석')
      .map(a => ({
        id: a.remote_id,
        studentId: String(a.student_id || ''),
        name: a.student_name || '',
        type: a.attendance_type || '출결',
        attCategory: a.att_category || '',
        attSubType: a.att_sub_type || '',
        periodInfo: a.period_info || '',
        reason: a.reason || '',
        confirmed: _isTruthyField(a.teacher_confirmed)
      }));
  }

  // 6. 시간표 (오늘 요일 필터 + period 기준 Union 병합)
  if (Array.isArray(bundle.timetable_base) || Array.isArray(bundle.timetable_changes)) {
    const todayStr = _getLocalTodayStr();
    const dayChar = _getKoreanTodayDayChar();
    const rawBase = Array.isArray(bundle.timetable_base) ? bundle.timetable_base : [];
    const changes = Array.isArray(bundle.timetable_changes) ? bundle.timetable_changes : [];
    const cu = mockData.currentUser;
    mockData.rawTimetableBase = rawBase;
    mockData.rawTimetableChanges = changes;

    const stuTitleEl = document.getElementById('studentTimetableTitle');
    if (stuTitleEl) stuTitleEl.innerText = `오늘의 시간표 (${dayChar}요일)`;

    const cuGrade = String(cu.grade || '').trim();
    const cuClass = String(cu.classNo || '').trim();
    mockData.timetable = mergeTimetableForDay(rawBase, changes, {
      mode: 'class',
      grade: cuGrade,
      classNo: cuClass,
      dayChar,
      targetDate: todayStr
    });

    // 교사 본인 시간표 구성 (entry_type === 'teacher' 우선, '유우석' vs '유우석T' 정규화, 변동 Union 병합)
    mockData.teacherSchedule = mergeTimetableForDay(rawBase, changes, {
      mode: 'teacher',
      teacherName: cu.teacherName || '',
      dayChar,
      targetDate: todayStr
    });

    // 담임 학급 당일 시간표 구성 (교사 로그인 시 grade + class_no 기준)
    if (cu.role === 'teacher' || state.activeRole === 'teacher') {
      mockData.homeroomSchedule = buildHomeroomSchedule(rawBase, changes, cu.grade, cu.classNo);
    } else {
      mockData.homeroomSchedule = [];
    }
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
      if (!_isTruthyField(c.is_read) && c.sender_role !== 'teacher') {
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
  const customIdBtn = document.getElementById('customIdHeaderBtn');

  const studentNav = document.getElementById('studentBottomNav');
  const teacherNav = document.getElementById('teacherBottomNav');

  const cu = mockData.currentUser;
  const gc = cu.gradeClass || '';
  const school = cu.schoolName || '소속 학교 미설정';
  const tName = cu.teacherName || '담임교사';

  if (state.activeRole === 'teacher') {
    nameElem.innerText = tName;
    subElem.innerText = `${school}${gc ? ' ' + gc : ''} · 관리자 모드`;
    badgeElem.innerText = "교사";
    badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-purple-100 text-purple-700";
    avatarElem.innerText = (tName && tName[0]) || "교";
    if (profileBtn) profileBtn.classList.remove('hidden');
    if (customIdBtn) customIdBtn.classList.add('hidden');

    studentNav.classList.add('hidden');
    teacherNav.classList.remove('hidden');
    teacherNav.classList.add('flex');
    if (typeof switchTeacherBottomTab === 'function') {
      switchTeacherBottomTab('home');
    }
  } else {
    if (profileBtn) profileBtn.classList.add('hidden');
    if (customIdBtn) customIdBtn.classList.remove('hidden');
    if (state.activeRole === 'student') {
      const stuDisplay = cu.studentName || cu.userId || '학생';
      nameElem.innerText = stuDisplay;
      badgeElem.innerText = "학생";
      badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-indigo-100 text-indigo-700";
      avatarElem.innerText = (stuDisplay && stuDisplay[0]) || "학";
    } else {
      const pDisplay = cu.parentName || cu.userId || '학부모';
      nameElem.innerText = pDisplay;
      badgeElem.innerText = "학부모";
      badgeElem.className = "text-[10px] px-1.5 py-0.5 rounded font-bold bg-emerald-100 text-emerald-700";
      avatarElem.innerText = (pDisplay && pDisplay[0]) || "학";
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

function togglePasswordVisibility(inputId, btnEl) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  if (btnEl) {
    btnEl.dataset.showing = show ? '1' : '0';
    btnEl.style.opacity = show ? '1' : '0.6';
  }
}

function remaskPasswordInput(inputEl) {
  if (!inputEl) return;
  if (inputEl.type !== 'password') {
    inputEl.type = 'password';
  }
}

function showNeisCodeHelp(kind) {
  if (kind === 'office') {
    showToast('시도교육청 코드 예: N10(충남), B10(서울), J10(경기)', 'ℹ️');
  } else {
    showToast('나이스 학교표준코드 7자리 숫자 예: 8140246', 'ℹ️');
  }
}

function openAccountMenuModal() {
  const cu = mockData.currentUser || {};
  const role = String(cu.role || state.activeRole || 'student').toLowerCase();
  const titleEl = document.getElementById('accountMenuTitle');
  const actionsEl = document.getElementById('accountMenuActions');
  if (titleEl) {
    const nm = role === 'teacher' ? (cu.teacherName || cu.userId) : (role === 'parent' ? (cu.parentName || cu.userId) : (cu.studentName || cu.userId));
    titleEl.innerText = `${nm || '계정'} · 계정 관리`;
  }
  if (actionsEl) {
    if (role === 'teacher') {
      actionsEl.innerHTML = `
        <button type="button" onclick="closeModal('accountMenuModal'); openTeacherProfileModal()" class="w-full py-3 px-4 bg-purple-50 hover:bg-purple-100 text-purple-800 font-bold rounded-xl text-xs text-left flex items-center justify-between">
          <span>✏️ 프로필 수정 (학교·학급·NEIS)</span><span>→</span>
        </button>
        <button type="button" onclick="closeModal('accountMenuModal'); openChangePasswordModal()" class="w-full py-3 px-4 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-xl text-xs text-left flex items-center justify-between">
          <span>🔐 비밀번호 변경</span><span>→</span>
        </button>
      `;
    } else {
      const idBtnHtml = cu.customIdChanged
        ? `<button type="button" disabled class="w-full py-3 px-4 bg-slate-100 text-slate-400 font-bold rounded-xl text-xs text-left cursor-not-allowed">
            🪪 로그인 ID 변경 완료 (${cu.customId || cu.userId}) · 재변경 불가
           </button>`
        : `<button type="button" onclick="closeModal('accountMenuModal'); openCustomIdModal()" class="w-full py-3 px-4 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 font-bold rounded-xl text-xs text-left flex items-center justify-between">
            <span>🪪 로그인 ID 변경 (최초 1회)</span><span>→</span>
           </button>`;
      actionsEl.innerHTML = `
        ${idBtnHtml}
        <button type="button" onclick="closeModal('accountMenuModal'); openChangePasswordModal()" class="w-full py-3 px-4 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-xl text-xs text-left flex items-center justify-between">
          <span>🔐 비밀번호 변경</span><span>→</span>
        </button>
      `;
    }
  }
  openModal('accountMenuModal');
}

function handlePushBannerAllowClick() {
  if ('Notification' in window && Notification.permission === 'denied') {
    openPwaPushGuide();
  } else if (typeof requestPwaNotificationPermission === 'function') {
    requestPwaNotificationPermission();
  }
}

function openCustomIdModal() {
  const cu = mockData.currentUser || {};
  const input = document.getElementById('customIdInput');
  const btn = document.getElementById('customIdSubmitBtn');
  const msg = document.getElementById('customIdStatusMsg');
  if (cu.customIdChanged) {
    if (input) {
      input.value = cu.customId || cu.userId || '';
      input.disabled = true;
    }
    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    if (msg) {
      msg.innerText = `이미 최초 1회 커스텀 ID 변경을 완료했습니다. (현재 ID: ${cu.customId || cu.userId})`;
    }
  } else {
    if (input) {
      input.value = '';
      input.disabled = false;
    }
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
    if (msg) {
      msg.innerText = '초기 ID 대신 기억하기 쉬운 나만의 로그인 ID를 최초 1회에 한해 설정할 수 있습니다. (5자리 숫자 불가, 영문 소문자·숫자 4~20자)';
    }
  }
  openModal('customIdModal');
}

async function submitCustomIdChange(e) {
  if (e) e.preventDefault();
  const cu = mockData.currentUser || {};
  if (cu.customIdChanged) {
    showToast('ID 변경은 최초 1회만 가능합니다.', '⚠️');
    return;
  }
  const newCustomId = (document.getElementById('customIdInput')?.value || '').trim();
  if (/^\d{5}$/.test(newCustomId)) {
    showToast('5자리 숫자(학번 형식)는 커스텀 ID로 사용할 수 없습니다.', '⚠️');
    return;
  }
  if (!/^[a-z0-9_.-]{4,20}$/.test(newCustomId)) {
    showToast('영문 소문자, 숫자, _, ., - 조합 4~20자로 입력해 주세요.', '⚠️');
    return;
  }
  const submitBtn = (e && e.submitter) || document.getElementById('customIdSubmitBtn');
  await withButtonLoading(submitBtn, '변경 중...', async () => {
    try {
      await gasApi.post('change_custom_id', {
        role: cu.role || state.activeRole || 'student',
        user_id: cu.userId || cu.studentId || '',
        new_custom_id: newCustomId
      });
      cu.customId = newCustomId;
      cu.customIdChanged = true;
      cu.userId = newCustomId;
      const saved = _loadAutoLoginAuth();
      if (saved) {
        _saveAutoLoginAuth({ ...saved, userId: newCustomId });
      }
      closeModal('customIdModal');
      showToast(`커스텀 ID(${newCustomId})가 확정되었습니다.`, '🪪');
    } catch (err) {
      showToast(`ID 변경 실패: ${err && err.message ? err.message : '오류'}`, '⚠️');
    }
  });
}

function openSignupModal() {
  onSignupRoleChange();
  openModal('signupModal');
}

function onSignupRoleChange() {
  const role = (document.getElementById('signupRole')?.value || 'student').toLowerCase();
  const pExtra = document.getElementById('signupParentExtra');
  const tExtra = document.getElementById('signupTeacherExtra');
  const stuNoWrap = document.getElementById('signupStudentNoWrap');
  if (pExtra) pExtra.classList.toggle('hidden', role !== 'parent');
  if (tExtra) tExtra.classList.toggle('hidden', role !== 'teacher');
  if (stuNoWrap) stuNoWrap.classList.toggle('hidden', role !== 'student');
}

async function submitSignupForm(e) {
  if (e) e.preventDefault();
  const role = (document.getElementById('signupRole')?.value || 'student').toLowerCase();
  const desiredId = (document.getElementById('signupDesiredId')?.value || '').trim();
  if (/^\d{5}$/.test(desiredId)) {
    showToast('5자리 숫자(학번 형식)는 ID로 사용할 수 없습니다.', '⚠️');
    return;
  }
  if (role !== 'teacher' && !/^[a-z0-9_.-]{4,20}$/.test(desiredId)) {
    showToast('희망 ID는 영문 소문자, 숫자, _, ., - 조합 4~20자로 입력해 주세요.', '⚠️');
    return;
  }
  const signupPw = document.getElementById('signupPassword')?.value || '';
  const signupPwConfirm = document.getElementById('signupPasswordConfirm')?.value || '';
  if (signupPw !== signupPwConfirm) {
    showToast('비밀번호와 비밀번호 확인이 일치하지 않습니다.', '⚠️');
    return;
  }
  const submitBtn = (e && e.submitter) || (e && e.target && e.target.querySelector('button[type="submit"]'));
  await withButtonLoading(submitBtn, '신청 중...', async () => {
    try {
      const res = await gasApi.post('register_account', {
        role,
        school_name: (document.getElementById('signupSchoolName')?.value || '').trim(),
        name: (document.getElementById('signupName')?.value || '').trim(),
        grade: (document.getElementById('signupGrade')?.value || '').trim(),
        class_no: (document.getElementById('signupClassNo')?.value || '').trim(),
        student_no: (document.getElementById('signupStudentNo')?.value || '').trim(),
        child_student_id: (document.getElementById('signupChildStudentId')?.value || '').trim(),
        child_name: (document.getElementById('signupChildName')?.value || '').trim(),
        neis_office_code: (document.getElementById('signupNeisOffice')?.value || '').trim(),
        neis_school_code: (document.getElementById('signupNeisSchool')?.value || '').trim(),
        subject: (document.getElementById('signupSubject')?.value || '').trim(),
        desired_id: desiredId,
        password: document.getElementById('signupPassword')?.value || ''
      });
      closeModal('signupModal');
      showToast(res.message || '가입 신청이 완료되었습니다. 승인 후 로그인해 주세요.', '✨');
    } catch (err) {
      showToast(`가입 신청 실패: ${err && err.message ? err.message : '오류'}`, '⚠️');
    }
  });
}

function openChangePasswordModal() {
  const c1 = document.getElementById('currentPasswordInput');
  const c2 = document.getElementById('newPasswordInput');
  const c3 = document.getElementById('confirmNewPasswordInput');
  if (c1) c1.value = '';
  if (c2) c2.value = '';
  if (c3) c3.value = '';
  openModal('changePasswordModal');
}

async function submitChangePassword(e) {
  if (e) e.preventDefault();
  const currentPassword = (document.getElementById('currentPasswordInput')?.value || '');
  const newPassword = (document.getElementById('newPasswordInput')?.value || '');
  const confirmPassword = (document.getElementById('confirmNewPasswordInput')?.value || '');

  if (!currentPassword || !newPassword) {
    showToast('현재 비밀번호와 새 비밀번호를 모두 입력해 주세요.', '⚠️');
    return;
  }
  if (newPassword.length < 4) {
    showToast('새 비밀번호는 4자 이상이어야 합니다.', '⚠️');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('새 비밀번호와 확인 비밀번호가 일치하지 않습니다.', '⚠️');
    return;
  }

  const submitBtn = (e && e.submitter) || (e && e.target && e.target.querySelector('button[type="submit"]'));
  await withButtonLoading(submitBtn, '변경 중...', async () => {
    try {
      const cu = mockData.currentUser || {};
      const curHash = await gasApi.sha256Hex(currentPassword);
      await gasApi.post('change_password', {
        role: cu.role || state.activeRole || 'student',
        user_id: cu.userId || cu.studentId || '',
        current_password: currentPassword,
        current_password_hash: curHash,
        new_password: newPassword
      });

      // 자동 로그인 정보가 저장된 경우 새 비밀번호 해시로 동기화
      const saved = _loadAutoLoginAuth();
      if (saved && saved.userId === (cu.userId || cu.studentId || '')) {
        const newHash = await gasApi.sha256Hex(newPassword);
        _saveAutoLoginAuth({
          ...saved,
          password: newPassword,
          passwordHash: newHash
        });
      }

      closeModal('changePasswordModal');
      showToast('비밀번호가 안전하게 변경되었습니다.', '🔐');
    } catch (err) {
      showToast(`비밀번호 변경 실패: ${err && err.message ? err.message : '오류'}`, '⚠️');
    }
  });
}

function logout() {
  _stopRealtimeListeners();
  _clearAutoLoginAuth();
  _clearBundleCache();
  _hideAllPwaPushUI();
  state.pwaPushBannerDismissed = false;
  state.pwaPushGuideDismissed = false;
  const pwInput = document.getElementById('loginPwInput');
  if (pwInput) pwInput.value = '';
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

let _pwaPushSyncedThisSession = false;

function getPwaDevicePlatform() {
  const ua = (navigator.userAgent || '').toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIos) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'desktop';
}

function _getDeviceDeniedStepsHtml() {
  const platform = getPwaDevicePlatform();
  if (platform === 'ios') {
    return `
      <p><strong>iPhone (iOS PWA)</strong>:</p>
      <p>1. <strong>아이폰 설정</strong> 앱 열기</p>
      <p>2. <strong>알림</strong> → <strong>EduFlow</strong>(또는 Safari) 선택</p>
      <p>3. <strong>알림 허용</strong>을 켠 뒤 앱으로 돌아와 <strong>[권한 다시 확인]</strong>을 눌러주세요.</p>
    `;
  }
  if (platform === 'android') {
    return `
      <p><strong>Android (Chrome)</strong>:</p>
      <p>1. 상단 주소창 왼쪽 <strong>설정(🔒/⚙️)</strong> 아이콘 터치</p>
      <p>2. <strong>권한</strong> → <strong>알림</strong>을 <strong>허용</strong>으로 변경</p>
      <p class="text-[10px] text-amber-700/90 mt-1">* 홈 화면 앱인 경우 기기 <strong>설정 → 애플리케이션 → EduFlow → 알림 허용</strong> 후 <strong>[권한 다시 확인]</strong>을 눌러주세요.</p>
    `;
  }
  return `
    <p><strong>브라우저 알림 설정</strong>:</p>
    <p>1. 주소창 왼쪽 <strong>사이트 정보(🔒/⚙️)</strong> 클릭</p>
    <p>2. <strong>알림</strong> 권한을 <strong>허용</strong>으로 변경 후 <strong>[권한 다시 확인]</strong>을 눌러주세요.</p>
  `;
}

function _hideAllPwaPushUI() {
  const banner = document.getElementById('pwaPushBanner');
  const bannerDefault = document.getElementById('pwaPushBannerDefault');
  const bannerDenied = document.getElementById('pwaPushBannerDenied');
  const guideModal = document.getElementById('pwaPushGuideModal');
  if (banner) banner.classList.add('hidden');
  if (bannerDefault) bannerDefault.classList.add('hidden');
  if (bannerDenied) bannerDenied.classList.add('hidden');
  if (guideModal) guideModal.classList.add('hidden');
}

function dismissPwaPushBanner() {
  state.pwaPushBannerDismissed = true;
  const banner = document.getElementById('pwaPushBanner');
  const bannerDefault = document.getElementById('pwaPushBannerDefault');
  if (bannerDefault) bannerDefault.classList.add('hidden');
  if (banner && (!document.getElementById('pwaPushBannerDenied') || document.getElementById('pwaPushBannerDenied').classList.contains('hidden'))) {
    banner.classList.add('hidden');
  }
}

function openPwaPushGuide() {
  const guideModal = document.getElementById('pwaPushGuideModal');
  if (!guideModal || !('Notification' in window)) return;

  const isDenied = Notification.permission === 'denied';
  const titleEl = document.getElementById('pwaPushGuideTitle');
  const descEl = document.getElementById('pwaPushDesc');
  const deniedGuide = document.getElementById('pwaPushDeniedGuide');
  const stepsEl = document.getElementById('pwaPushDeviceSteps');
  const enableBtn = document.getElementById('pwaPushEnableBtn');
  const recheckBtn = document.getElementById('pwaPushRecheckBtn');

  if (titleEl) {
    titleEl.innerText = isDenied ? '알림 권한이 차단되어 있어요' : '실시간 학사 알림 켜기';
  }
  if (descEl) {
    descEl.innerHTML = isDenied
      ? '웹앱 보안 정책상 설정 화면으로 자동 이동할 수 없습니다. 아래 기기별 안내에 따라 허용해 주세요.'
      : '출결·서류 마감 독촉, 가정통신문, 긴급 공지를 실시간으로 받으려면 알림을 허용해 주세요.';
  }
  if (deniedGuide) {
    deniedGuide.classList.toggle('hidden', !isDenied);
  }
  if (isDenied && stepsEl) {
    stepsEl.innerHTML = _getDeviceDeniedStepsHtml();
  }
  if (enableBtn) {
    enableBtn.classList.toggle('hidden', isDenied);
  }
  if (recheckBtn) {
    recheckBtn.classList.toggle('hidden', !isDenied);
  }

  guideModal.classList.remove('hidden');
}

function dismissPwaPushGuide() {
  state.pwaPushGuideDismissed = true;
  const guideModal = document.getElementById('pwaPushGuideModal');
  if (guideModal) guideModal.classList.add('hidden');
  checkAndEnforcePwaPushGate();
}

function checkAndEnforcePwaPushGate(options = {}) {
  const dash = document.getElementById('dashboardScreen');
  const isLoggedIn = dash && !dash.classList.contains('hidden');
  if (!isLoggedIn || !('Notification' in window)) {
    _hideAllPwaPushUI();
    return;
  }

  const perm = Notification.permission;
  const banner = document.getElementById('pwaPushBanner');
  const bannerDefault = document.getElementById('pwaPushBannerDefault');
  const bannerDenied = document.getElementById('pwaPushBannerDenied');

  if (perm === 'granted') {
    _hideAllPwaPushUI();
    if (!_pwaPushSyncedThisSession) {
      _pwaPushSyncedThisSession = true;
      void subscribeToWebPush(true);
    }
    return;
  }

  if (perm === 'default') {
    if (bannerDenied) bannerDenied.classList.add('hidden');
    if (banner) banner.classList.remove('hidden');
    if (bannerDefault) bannerDefault.classList.remove('hidden');
    return;
  }

  // perm === 'denied'
  if (bannerDefault) bannerDefault.classList.add('hidden');
  if (banner) banner.classList.remove('hidden');
  if (bannerDenied) bannerDenied.classList.remove('hidden');

  const guideModal = document.getElementById('pwaPushGuideModal');
  const isGuideOpen = guideModal && !guideModal.classList.contains('hidden');
  if (isGuideOpen || (options && options.openGuideOnDenied && !state.pwaPushGuideDismissed)) {
    openPwaPushGuide();
  }
}

async function _getServiceWorkerRegistrationReady(timeoutMs = 8000) {
  if (!('serviceWorker' in navigator)) {
    throw new Error('이 브라우저는 Service Worker를 지원하지 않습니다.');
  }
  let reg = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!reg) {
    reg = await navigator.serviceWorker.register('/sw.js');
  }
  return await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('ServiceWorker ready timeout')), timeoutMs))
  ]);
}

async function getPushSubscriptionStatus() {
  if (!('Notification' in window)) {
    return { supported: false, permission: 'unsupported', hasSubscription: false, endpoint: '' };
  }
  const permission = Notification.permission;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { supported: false, permission, hasSubscription: false, endpoint: '' };
  }
  try {
    const reg = await _getServiceWorkerRegistrationReady(5000);
    const sub = await reg.pushManager.getSubscription();
    return {
      supported: true,
      permission,
      hasSubscription: Boolean(sub),
      endpoint: sub ? sub.endpoint : '',
      subscription: sub || null
    };
  } catch (err) {
    return {
      supported: true,
      permission,
      hasSubscription: false,
      endpoint: '',
      error: err && err.message ? err.message : '구독 상태 조회 실패'
    };
  }
}

async function refreshPushStatusUI() {
  const el = document.getElementById('pushStatusText');
  if (!el) return;
  el.innerText = '확인 중...';
  el.className = 'text-[11px] font-semibold text-slate-500 truncate';

  const status = await getPushSubscriptionStatus();
  if (!status.supported) {
    el.innerText = '이 브라우저는 웹 푸시를 지원하지 않습니다.';
    el.className = 'text-[11px] font-semibold text-slate-500 truncate';
    return;
  }

  const permLabel = status.permission === 'granted'
    ? '권한 허용'
    : (status.permission === 'denied' ? '권한 차단됨' : '권한 미결정');
  const subLabel = status.hasSubscription ? '구독 등록됨' : '구독 없음';

  if (status.error) {
    el.innerText = `${permLabel} · 오류(${status.error})`;
    el.className = 'text-[11px] font-semibold text-red-600 truncate';
  } else if (status.permission === 'granted' && status.hasSubscription) {
    el.innerText = `${permLabel} · ${subLabel}`;
    el.className = 'text-[11px] font-semibold text-emerald-700 truncate';
  } else if (status.permission === 'denied') {
    el.innerText = `${permLabel} · 기기 설정 필요`;
    el.className = 'text-[11px] font-semibold text-red-600 truncate';
  } else {
    el.innerText = `${permLabel} · ${subLabel}`;
    el.className = 'text-[11px] font-semibold text-amber-700 truncate';
  }
}

async function subscribeToWebPush(silent = false) {
  state.lastPushError = '';
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      state.lastPushError = '이 브라우저는 Web Push(PushManager)를 지원하지 않습니다.';
      console.warn('[EduFlow Push]', state.lastPushError);
      return false;
    }

    const reg = await _getServiceWorkerRegistrationReady(8000);
    let subscription = await reg.pushManager.getSubscription();

    if (!subscription) {
      let publicKey = '';
      let vapidErrMsg = '';
      try {
        const resp = await fetch('/api/push', { method: 'GET' });
        const json = await resp.json();
        publicKey = (json && json.publicKey) ? json.publicKey.trim() : '';
        if (!publicKey && json && json.error) vapidErrMsg = json.error;
      } catch (fetchErr) {
        vapidErrMsg = fetchErr && fetchErr.message ? fetchErr.message : 'VAPID 공개키 조회 실패';
      }
      if (!publicKey) {
        state.lastPushError = vapidErrMsg || '서버 VAPID 공개키가 설정되지 않았습니다.';
        console.warn('[EduFlow Push] VAPID public key missing:', state.lastPushError);
        if (!silent) showToast(state.lastPushError, '⚠️');
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
      const saveRes = await gasApi.post('save_push_subscription', {
        data: {
          user_id: cu.userId || cu.studentId || 'anonymous',
          role: state.activeRole,
          endpoint: subJson.endpoint || '',
          p256dh: (subJson.keys && subJson.keys.p256dh) || '',
          auth: (subJson.keys && subJson.keys.auth) || '',
          user_agent: navigator.userAgent || ''
        }
      });
      if (saveRes && saveRes.ok === false) {
        throw new Error(saveRes.error || 'save_push_subscription 실패');
      }
    }
    void refreshPushStatusUI();
    return true;
  } catch (err) {
    state.lastPushError = err && err.message ? err.message : 'Web Push 구독 처리 오류';
    console.warn('[EduFlow Push] 구독 처리 중 오류:', err);
    if (!silent) {
      showToast(`푸시 구독 오류: ${state.lastPushError}`, '⚠️');
    }
    void refreshPushStatusUI();
    return false;
  }
}

async function sendTestPushToMyDevice(btnEl) {
  if (!('Notification' in window)) {
    showToast('이 브라우저는 알림 기능을 지원하지 않습니다.', '⚠️');
    return;
  }
  if (Notification.permission === 'denied') {
    showToast('알림 권한이 차단되어 있습니다. 기기 설정에서 허용해 주세요.', '⚠️');
    openPwaPushGuide();
    return;
  }

  await withButtonLoading(btnEl, '발송 중...', async () => {
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      checkAndEnforcePwaPushGate();
      if (perm !== 'granted') {
        showToast('알림 권한을 허용해야 테스트 푸시를 받을 수 있습니다.', '⚠️');
        return;
      }
    }

    const subscribed = await subscribeToWebPush(false);
    if (!subscribed) {
      showToast(state.lastPushError || '푸시 구독 등록에 실패했습니다.', '⚠️');
      return;
    }

    const status = await getPushSubscriptionStatus();
    if (!status.hasSubscription || !status.endpoint) {
      showToast('브라우저 푸시 구독 정보를 찾을 수 없습니다. (구독 없음)', '⚠️');
      return;
    }

    const cu = mockData.currentUser;
    try {
      const resp = await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        body: JSON.stringify({
          title: '🔔 EduFlow 내 기기 푸시 테스트',
          message: `${cu.studentName || cu.teacherName || cu.userId || '사용자'}님 기기의 웹 푸시 알림이 정상 동작 중입니다.`,
          target_role: state.activeRole,
          target_user_id: cu.userId || cu.studentId || '',
          endpoint: status.endpoint,
          url: '/'
        })
      });
      const json = await resp.json();
      if (json && json.ok && json.sent > 0) {
        showToast('테스트 푸시 발송 완료! 잠시 후 OS 알림을 확인하세요.', '🔔');
      } else {
        const errMsg = (json && json.error) || '푸시 발송에 실패했습니다.';
        console.warn('[EduFlow Push Test] Failed:', json);
        showToast(`푸시 테스트 실패: ${errMsg}`, '⚠️');
      }
    } catch (err) {
      showToast(`푸시 테스트 요청 오류: ${err.message}`, '⚠️');
    } finally {
      void refreshPushStatusUI();
    }
  });
}

async function requestPwaNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('이 브라우저는 알림 기능을 지원하지 않습니다.', '⚠️');
    return;
  }

  if (Notification.permission === 'granted') {
    _hideAllPwaPushUI();
    showToast('알림 권한이 확인되었습니다.', '🔔');
    _pwaPushSyncedThisSession = true;
    void subscribeToWebPush(true);
    return;
  }

  if (Notification.permission === 'denied') {
    openPwaPushGuide();
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      // 즉시(0ms) UI를 닫은 뒤 백그라운드에서 Web Push 구독 및 GAS 저장 실행
      _hideAllPwaPushUI();
      showToast('알림 권한이 허용되었습니다.', '🔔');
      _pwaPushSyncedThisSession = true;
      void subscribeToWebPush(true);
    } else {
      checkAndEnforcePwaPushGate();
      if (permission === 'denied') {
        openPwaPushGuide();
        showToast('알림 권한이 차단되었습니다. 기기 설정에서 허용해 주세요.', '⚠️');
      } else {
        showToast('나중에 상단 배너에서 언제든 알림을 켤 수 있습니다.', 'ℹ️');
      }
    }
  } catch (err) {
    checkAndEnforcePwaPushGate();
    showToast(`알림 권한 요청 오류: ${err.message}`, '⚠️');
  }
}

function recheckPwaNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('이 브라우저는 알림 기능을 지원하지 않습니다.', '⚠️');
    return;
  }
  if (Notification.permission === 'granted') {
    _hideAllPwaPushUI();
    showToast('알림 권한이 허용되었습니다!', '🔔');
    _pwaPushSyncedThisSession = true;
    void subscribeToWebPush(true);
  } else if (Notification.permission === 'default') {
    const guideModal = document.getElementById('pwaPushGuideModal');
    if (guideModal) guideModal.classList.add('hidden');
    checkAndEnforcePwaPushGate();
    showToast('알림 권한이 아직 결정되지 않았습니다. [알림 허용하기]를 눌러주세요.', 'ℹ️');
  } else {
    openPwaPushGuide();
    showToast('아직 알림이 차단되어 있습니다. 설정에서 허용 후 다시 확인해 주세요.', '⚠️');
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

    checkAndEnforcePwaPushGate();

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

  window.addEventListener('pageshow', checkAndEnforcePwaPushGate);
  window.addEventListener('focus', checkAndEnforcePwaPushGate);
}

// Initialize Dates, Canvas & Service Worker on Load
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initServiceWorkerAndAutoSync();

    const today = _getLocalTodayStr();
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
    void tryAutoLogin();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeTimetableForDay,
    _normalizeTeacherName,
    buildHomeroomSchedule,
    _getLocalTodayStr,
    _getKoreanTodayDayChar,
  };
}