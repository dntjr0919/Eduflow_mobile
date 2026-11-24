const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const firebaseAdminPath = path.resolve(__dirname, '../api/_firebaseAdmin.js');
require.cache[firebaseAdminPath] = {
  id: firebaseAdminPath,
  filename: firebaseAdminPath,
  loaded: true,
  exports: {
    getFirestore: () => {
      throw new Error('Mock db should be passed directly');
    },
    buildFirestoreErrorPayload: (err, ctx) => ({ ok: false, error: err.message, ctx }),
  },
};

const googleDrivePath = path.resolve(__dirname, '../api/_googleDrive.js');
require.cache[googleDrivePath] = {
  id: googleDrivePath,
  filename: googleDrivePath,
  loaded: true,
  exports: {},
};

const { _testHelpers } = require('../api/firestore.js');
const { _parsePayload, _validateStringInput } = _testHelpers;
const appMod = require('../app.js');
const studentMod = require('../student.js');
const teacherMod = require('../teacher.js');

function createMockElement(id = '') {
  return {
    id,
    innerHTML: '',
    innerText: '',
    textContent: '',
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    className: '',
    href: '',
    src: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    querySelectorAll() { return []; },
    removeAttribute(attr) { this[attr] = ''; },
  };
}

function setupMockDom(ids = []) {
  const elements = {};
  for (const id of ids) {
    elements[id] = createMockElement(id);
  }
  const prevDocument = global.document;
  const prevMockData = global.mockData;
  const prevState = global.state;
  const prevEscapeHtml = global.escapeHtml;
  const prevSafeHttpUrl = global.safeHttpUrl;
  const prevSafeImageUrl = global.safeImageUrl;
  const prevOpenModal = global.openModal;
  const prevGasApi = global.gasApi;

  global.document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = createMockElement(id);
      return elements[id];
    },
    querySelectorAll() { return []; },
  };
  global.escapeHtml = appMod.escapeHtml;
  global.safeHttpUrl = appMod.safeHttpUrl;
  global.safeImageUrl = appMod.safeImageUrl;
  global._safeHttpUrl = appMod.safeHttpUrl;
  global.openModal = () => {};
  global.gasApi = { isConfigured: () => false };
  global.mockData = appMod.mockData;
  global.state = {
    activeMealTab: 'lunch',
    teacherDocFilter: 'pending',
    activeTeacherChatRoomId: 'ROOM-1',
    activeRole: 'student',
  };

  return {
    elements,
    restore() {
      global.document = prevDocument;
      global.mockData = prevMockData;
      global.state = prevState;
      global.escapeHtml = prevEscapeHtml;
      global.safeHttpUrl = prevSafeHttpUrl;
      global.safeImageUrl = prevSafeImageUrl;
      global.openModal = prevOpenModal;
      global.gasApi = prevGasApi;
    },
  };
}

test('escapeHtml and URL helpers neutralize XSS payloads and unsafe schemes', () => {
  const scriptPayload = '<script>alert(1)</script>';
  const imgPayload = '<img src=x onerror=alert(1)>';
  assert.equal(
    appMod.escapeHtml(scriptPayload),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
  assert.equal(
    appMod.escapeHtml(imgPayload),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
  assert.equal(appMod.escapeHtml(`"&'`), '&quot;&amp;&#39;');

  assert.equal(appMod.safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(appMod.safeHttpUrl('JaVaScRiPt:alert(1)'), '');
  assert.equal(appMod.safeHttpUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(appMod.safeHttpUrl('https://example.com/notice.pdf'), 'https://example.com/notice.pdf');

  assert.equal(appMod.safeImageUrl('javascript:alert(1)'), '');
  assert.equal(appMod.safeImageUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(
    appMod.safeImageUrl('data:image/png;base64,iVBORw0KGgo='),
    'data:image/png;base64,iVBORw0KGgo='
  );
});

test('app.js escapes schedule titles/categories and notification fields against XSS', () => {
  const dom = setupMockDom(['noticeModalList']);
  try {
    const schedHtml = appMod._buildScheduleItemsHtml([
      {
        start_date: '2026-11-25',
        end_date: '2026-11-25',
        title: '<script>alert(1)</script>중간고사',
        category: '<img src=x onerror=alert(1)>',
        dday: { label: 'D-1', diffDays: 1, isPast: false },
      },
    ], '없음');
    assert.ok(!schedHtml.includes('<script>'));
    assert.ok(!schedHtml.includes('<img '));
    assert.ok(schedHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(schedHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));

    appMod.mockData.notifications = [
      {
        remote_id: "id'<script>alert(1)</script>",
        sender: '<img src=x onerror=alert(1)>',
        title: '<script>alert(1)</script>공지',
        message: '<img src=x onerror=alert(1)>본문',
        created_at: '2026-11-24 <script>alert(1)</script>',
        is_read: 0,
      },
    ];
    appMod.renderNotificationsModal();
    const notiHtml = dom.elements.noticeModalList.innerHTML;
    assert.ok(!notiHtml.includes('<script>'));
    assert.ok(!notiHtml.includes('<img '));
    assert.ok(notiHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(notiHtml.includes('&lt;img src=x onerror=alert(1)&gt;'));
  } finally {
    dom.restore();
  }
});

test('student.js escapes meals, timetable, urgent docs, attendance, budget/receipt, and chat XSS payloads', () => {
  const dom = setupMockDom([
    'mealContentBox',
    'timetableList',
    'studentTimetableChangeBadge',
    'urgentDocsContainer',
    'urgentDocsBadge',
    'attTabBadge',
    'attendanceHistoryList',
    'attHistoryCount',
    'fieldTripGuideBox',
    'budgetBalance',
    'budgetIncome',
    'budgetExpense',
    'budgetTransactionsList',
    'receiptModalBody',
    'counselingCtaBanner',
    'chatMessagesContainer',
  ]);
  try {
    // 1. Meals
    appMod.mockData.meals = {
      lunch: {
        calories: '<script>alert(1)</script>700kcal',
        menu: [{ name: '<img src=x onerror=alert(1)>김치찌개', allergy: '<script>1</script>' }],
        allergyNotice: '<script>alert(1)</script>안내',
      },
    };
    studentMod.renderMeals();
    const mealHtml = dom.elements.mealContentBox.innerHTML;
    assert.ok(!mealHtml.includes('<script>'));
    assert.ok(!mealHtml.includes('<img '));
    assert.ok(mealHtml.includes('&lt;img src=x onerror=alert(1)&gt;김치찌개'));

    // 2. Timetable
    appMod.mockData.timetable = [
      {
        period: '1<script>alert(1)</script>',
        subject: '<img src=x onerror=alert(1)>수학',
        teacher: '<script>alert(1)</script>김교사',
        original: '<img src=x onerror=alert(1)>영어',
        isChanged: true,
      },
    ];
    studentMod.renderTimetable();
    const ttHtml = dom.elements.timetableList.innerHTML;
    assert.ok(!ttHtml.includes('<script>'));
    assert.ok(!ttHtml.includes('<img '));
    assert.ok(ttHtml.includes('&lt;img src=x onerror=alert(1)&gt;수학'));

    // 3. Urgent docs
    appMod.mockData.urgentDocuments = [
      {
        id: "doc'<script>alert(1)</script>",
        title: '<script>alert(1)</script>결석계',
        docName: '<img src=x onerror=alert(1)>진단서',
        description: '<script>alert(1)</script>제출요망',
        deadline: '<img src=x onerror=alert(1)>',
        dDayText: '<script>D-1</script>',
        status: 'pending',
      },
    ];
    studentMod.renderUrgentDocuments();
    const docHtml = dom.elements.urgentDocsContainer.innerHTML;
    assert.ok(!docHtml.includes('<script>'));
    assert.ok(!docHtml.includes('<img '));

    // 4. Budget & Receipt (including javascript: URL)
    appMod.mockData.budget = {
      balance: 10000,
      income: 20000,
      expense: 10000,
      transactions: [
        {
          id: 'tx1',
          date: '2026-11-24',
          store: '<script>alert(1)</script>문구점',
          title: '<img src=x onerror=alert(1)>준비물',
          card: '<script>카드</script>',
          amount: 5000,
          type: 'expense',
          receiptUrl: 'javascript:alert(1)',
        },
      ],
    };
    studentMod.renderBudget();
    assert.ok(!dom.elements.budgetTransactionsList.innerHTML.includes('<script>'));
    assert.ok(!dom.elements.budgetTransactionsList.innerHTML.includes('<img '));
    studentMod.openReceiptModal('tx1');
    const receiptHtml = dom.elements.receiptModalBody.innerHTML;
    assert.ok(!receiptHtml.includes('<script>'));
    assert.ok(!receiptHtml.includes('<img '));
    assert.ok(!receiptHtml.includes('javascript:'));

    // 5. Chat
    appMod.mockData.currentUser = {
      studentId: '10101',
      studentName: '홍길동',
      teacherName: '<script>alert(1)</script>담임',
    };
    appMod.mockData.chatRooms = [
      {
        roomId: 'ROOM-10101',
        studentId: '10101',
        messages: [
          { sender: 'user', text: '<img src=x onerror=alert(1)>안녕하세요', time: '<script>10:00</script>' },
        ],
      },
    ];
    studentMod.renderStudentChat();
    const chatHtml = dom.elements.chatMessagesContainer.innerHTML;
    assert.ok(!chatHtml.includes('<script>'));
    assert.ok(!chatHtml.includes('<img '));
  } finally {
    dom.restore();
  }
});

test('teacher.js escapes dashboard schedules/meals, docs, and chat XSS payloads', () => {
  const dom = setupMockDom([
    'teacherScheduleList',
    'teacherTimetableChangeBadge',
    'teacherHomeroomScheduleTitle',
    'teacherHomeroomChangeBadge',
    'teacherHomeroomScheduleList',
    'teacherMealList',
    'teacherDocsContainer',
    'teacherChatRoomsList',
    'teacherChatUnreadDot',
    'teacherLiveChatMessages',
  ]);
  try {
    appMod.mockData.currentUser = { grade: 1, classNo: 1, teacherName: '김선생' };
    appMod.mockData.teacherSchedule = [
      { period: '1교시', target: '<script>alert(1)</script>1-1', subject: '<img src=x onerror=alert(1)>국어', changed: true },
    ];
    appMod.mockData.homeroomSchedule = [
      { period: '2', subject: '<script>alert(1)</script>영어', teacher: '<img src=x onerror=alert(1)>이', isChanged: true, changedReason: '<script>보강</script>' },
    ];
    appMod.mockData.meals = {
      lunch: {
        calories: '<script>alert(1)</script>650kcal',
        menu: [{ name: '<img src=x onerror=alert(1)>비빔밥', allergy: '<script>5</script>' }],
        allergyNotice: '<script>alert(1)</script>',
      },
    };
    teacherMod.renderTeacherHome();
    for (const id of ['teacherScheduleList', 'teacherHomeroomScheduleList', 'teacherMealList']) {
      assert.ok(!dom.elements[id].innerHTML.includes('<script>'), `${id} should not contain raw <script>`);
      assert.ok(!dom.elements[id].innerHTML.includes('<img '), `${id} should not contain raw <img>`);
    }

    appMod.mockData.urgentDocuments = [
      {
        id: 'd1',
        studentId: '10101',
        studentName: '<script>alert(1)</script>학생',
        docName: '<img src=x onerror=alert(1)>서류',
        title: '<script>alert(1)</script>제목',
        description: '<img src=x onerror=alert(1)>설명',
        deadline: '2026-11-30',
        status: 'pending',
      },
    ];
    teacherMod.renderTeacherDocs();
    assert.ok(!dom.elements.teacherDocsContainer.innerHTML.includes('<script>'));
    assert.ok(!dom.elements.teacherDocsContainer.innerHTML.includes('<img '));

    appMod.mockData.chatRooms = [
      {
        roomId: 'ROOM-1',
        studentName: '<script>홍</script>',
        partnerLabel: '<img src=x onerror=alert(1)>홍길동',
        unread: 1,
        messages: [
          { sender: 'student', text: '<script>alert(1)</script>질문', time: '<img src=x onerror=alert(1)>' },
        ],
      },
    ];
    teacherMod.renderTeacherChatRooms();
    assert.ok(!dom.elements.teacherChatRoomsList.innerHTML.includes('<script>'));
    assert.ok(!dom.elements.teacherChatRoomsList.innerHTML.includes('<img '));

    teacherMod.renderTeacherChatMessages();
    assert.ok(!dom.elements.teacherLiveChatMessages.innerHTML.includes('<script>'));
    assert.ok(!dom.elements.teacherLiveChatMessages.innerHTML.includes('<img '));
  } finally {
    dom.restore();
  }
});

test('api/firestore.js validates payload types and string lengths safely', () => {
  assert.deepEqual(_parsePayload({ method: 'POST', body: 'null' }), {});
  assert.deepEqual(_parsePayload({ method: 'POST', body: '[1,2,3]' }), {});
  assert.deepEqual(_parsePayload({ method: 'POST', body: '{invalid' }), {});
  assert.deepEqual(_parsePayload({ method: 'POST', body: '{"action":"ping","data":{"x":1}}' }), {
    action: 'ping',
    data: { x: 1 },
    x: 1,
  });

  assert.equal(_validateStringInput({ bad: true }, { label: '제목' }).ok, false);
  assert.equal(_validateStringInput('   ', { required: true, label: '제목' }).ok, false);
  assert.equal(_validateStringInput('a'.repeat(201), { maxLen: 200, label: '제목' }).ok, false);
  assert.deepEqual(_validateStringInput('  정상 제목  ', { maxLen: 200, required: true, label: '제목' }), {
    ok: true,
    value: '정상 제목',
  });
});
