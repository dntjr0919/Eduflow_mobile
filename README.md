# EduFlow Mobile (PWA)

교사·학생·학부모를 위한 **Google Sheets + Apps Script(GAS) 기반 실시간 학급 관리 & 출결·서류·가정통신문·상담 PWA**입니다.
데스크톱 EduFlow 레포의 `docs/apps_script_template.gs`와 100% 동일한 Google Sheets DB를 공유하며, Vercel Serverless Proxy를 통해 시트 URL과 비밀키를 안전하게 보호합니다.

---

## 1. 프로젝트 아키텍처 (Vercel + GAS 프록시)

```text
[PWA 클라이언트 (브라우저 / 홈 화면 앱)]
  ├─ index.html, styles.css, app.js, student.js, teacher.js, sw.js
  │
  ├─ GET / POST /api/gas  ──▶  [Vercel Serverless: api/gas.js]
  │                               └─ GAS_WEB_APP_URL + GAS_API_SECRET 주입
  │                               └─▶ [Google Apps Script Web App] ◀──▶ [Google Sheets DB]
  │
  └─ GET / POST /api/push ──▶  [Vercel Serverless: api/push.js]
                                  ├─ VAPID 키로 Web Push 서명·발송 (`web-push`)
                                  └─ GAS `get_push_subscriptions` 조회 후 구독 기기 전송
```

- **보안 원칙**: 클라이언트 코드(`app.js`, `student.js`, `teacher.js`)에는 Google Apps Script 웹 앱 URL과 `API_SECRET`, `VAPID_PRIVATE_KEY`가 절대 포함되지 않습니다.
- **PWA 알림 권한 강제**: 홈 화면에 추가(`standalone` 모드)로 실행 시 알림 권한이 `granted`가 아니면 차단 오버레이가 표시되어 푸시 알림 수신을 보장합니다.

---

## 2. 필수 Vercel 환경변수

Vercel 대시보드 → **Project Settings → Environment Variables**에 아래 값을 등록하세요.

| 변수명 | 필수 여부 | 설명 |
| --- | --- | --- |
| `GAS_WEB_APP_URL` | **필수** | Google Apps Script 웹 앱 배포 URL (`https://script.google.com/macros/s/.../exec`) |
| `GAS_API_SECRET` | **권장(필수)** | GAS 스크립트 속성 `API_SECRET`과 동일한 비밀키 |
| `VAPID_PUBLIC_KEY` | Web Push 시 필수 | Web Push VAPID 공개키 |
| `VAPID_PRIVATE_KEY` | Web Push 시 필수 | Web Push VAPID 비밀키 |
| `VAPID_SUBJECT` | Web Push 시 권장 | 연락처 URI (예: `mailto:teacher@school.kr`) |

### VAPID 키 생성 방법

```bash
npx web-push generate-vapid-keys
```

생성된 `Public Key`와 `Private Key`를 각각 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`에 등록합니다.

---

## 3. Google Sheets 연동 및 `apps_script_template.gs` 배포 절차

1. **Google 스프레드시트 생성**
   - 개인 Google 계정(`@gmail.com`)으로 새 스프레드시트를 생성합니다. *(교육청/기관 Workspace 계정은 외부 익명 요청 시 403 정책으로 차단될 수 있음)*
2. **Apps Script 붙여넣기**
   - 상단 메뉴 **확장 프로그램 → Apps Script**를 열고 기존 코드를 지운 뒤 데스크톱 레포의 `docs/apps_script_template.gs` 전체 내용을 붙여넣고 저장합니다.
3. **시트 스키마 자동 초기화**
   - 함수 드롭다운에서 `initSheets` (테스트 계정이 필요하면 `seedSampleData`)를 선택 후 **실행**합니다.
   - 기존 데스크톱 시트(`Schedules`, `Tasks`, `Notifications`)와 모바일 시트(`계정_교사`, `계정_학생`, `계정_학부모`, `일일_출결`, `설정_서류규정`, `서류_추적`, `가정통신문_목록`, `가정통신문_회신`, `시간표_기본`, `시간표_변동`, `급식_식단표`, `1:1_상담채팅`, `학급회비`, `Push_Subscriptions`)가 자동 생성됩니다.
4. **스크립트 속성 등록** (**프로젝트 설정 → 스크립트 속성**)
   - `API_SECRET`: Vercel `GAS_API_SECRET`과 동일한 임의 문자열
   - *(선택)* 나이스(NEIS) 급식 자동 수집용:
     - `NEIS_API_KEY`: 나이스 교육정보 개방 포털 API 인증키
     - `NEIS_OFFICE_CODE`: 시도교육청 코드 (예: `B10`)
     - `NEIS_SCHOOL_CODE`: 표준학교코드 (예: `7010057`)
5. **나이스 급식 자동 수집 트리거 등록 (선택)**
   - 함수 드롭다운에서 `installNeisMealTrigger`를 1회 실행하면 매일 새벽 4시 `급식_식단표` 시트가 자동 갱신됩니다. (앱 내 교사 홈의 **급식 동기화** 버튼으로도 수동 실행 가능)
6. **웹 앱 배포**
   - 우측 상단 **배포 → 새 배포** (코드 수정 후에는 **배포 관리 → 새 버전**)
   - 유형: **웹 앱**
   - 다음 사용자 권한으로 실행: **나(Me)**
   - 액세스 권한이 있는 사용자: **모든 사용자(Anyone)**
   - 발급된 `/exec` URL을 Vercel `GAS_WEB_APP_URL`에 등록합니다.

---

## 4. 로컬 테스트 방법

### 방법 A: Vercel CLI (`vercel dev`) — 권장 (프록시 및 Push API 포함)

```bash
npm install
npx vercel env pull .env.local   # 또는 .env.local 직접 작성
npx vercel dev
```

`.env.local` 예시:
```env
GAS_WEB_APP_URL=https://script.google.com/macros/s/YOUR_DEPLOY_ID/exec
GAS_API_SECRET=your-secret-key
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

### 방법 B: 정적 서버로 UI 확인 (데모 모드)

```bash
npx serve .
```

- `GAS_WEB_APP_URL`이 설정되지 않은 정적 서버나 `file://` 환경에서는 **데모 모드**로 동작하며 빈 상태 UI를 확인할 수 있습니다.

---

## 5. 주요 기능

- **학생/학부모 모드**: 오늘 시간표(컴시간 변동 반영), 오늘 급식(NEIS), 출결·증빙서류 마감 D-day 및 `"제출했습니다"` 확인, 가정통신문 전자서명(Google Drive 저장), 학급회비 투명 공개, 1:1 담임 상담 채팅
- **교사 모드**: 교사 본인 프로필 작성/수정, 학생·학부모 상담 접수 ON/OFF, 학급 출결 실시간 확인, 서류 기한 규정 설정 및 수동 재알림, 가정통신문 배포 및 미제출자 일괄 독촉, 학급/개별 알림 발송(시트 + Web Push), 나이스 급식 즉시 동기화, PC 원격 배치 작업 예약
