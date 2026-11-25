const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { getInAppBrowserType, resolvePwaPushGateDecision } = require('../app.js');

test('getInAppBrowserType detects KakaoTalk, Naver, Instagram, Facebook, Line, and standard browsers', () => {
  assert.equal(getInAppBrowserType('Mozilla/5.0 (Linux; Android 13) KAKAOTALK 10.4.0'), 'kakaotalk');
  assert.equal(getInAppBrowserType('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) NAVER(inapp; search; 1000)'), 'naver');
  assert.equal(getInAppBrowserType('Mozilla/5.0 Instagram 310.0.0.0 Android'), 'instagram');
  assert.equal(getInAppBrowserType('Mozilla/5.0 [FBAN/FBIOS;FBAV/440.0]'), 'facebook');
  assert.equal(getInAppBrowserType('Mozilla/5.0 Line/14.0.0'), 'line');
  assert.equal(getInAppBrowserType('Mozilla/5.0 (Linux; Android 14) Chrome/124.0.0.0 Mobile Safari/537.36'), '');
  assert.equal(typeof resolvePwaPushGateDecision, 'function');
});

test('index.html includes #inAppBrowserModal and student.js wires ensurePwaPushPermissionForAction on 3 actions', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(indexHtml, /id="inAppBrowserModal"/);
  assert.match(indexHtml, /id="inAppChromeIntentBtn"/);
  assert.match(indexHtml, /id="inAppIosGuide"/);
  assert.match(indexHtml, /현재 브라우저로 계속하기/);

  const studentSrc = fs.readFileSync(path.join(__dirname, '..', 'student.js'), 'utf8');
  assert.match(studentSrc, /ensurePwaPushPermissionForAction\('출결 보고'\)/);
  assert.match(studentSrc, /ensurePwaPushPermissionForAction\('가정통신문 회신'\)/);
  assert.match(studentSrc, /ensurePwaPushPermissionForAction\('1:1 상담 메시지 전송'\)/);
});

test('ensurePwaPushPermissionForAction allows unsupported environments, blocks ungranted/iOS tab, and passes granted', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

  function makeEnv({ hasPushApi = true, permission = 'default', ua = 'Chrome/124', standalone = false } = {}) {
    const toasts = [];
    const modalEl = { classList: { add() {}, remove() {}, contains: () => true } };
    const ctx = {
      console,
      Date,
      navigator: { userAgent: ua, platform: 'Linux', maxTouchPoints: 0, standalone },
      window: hasPushApi
        ? {
            location: { protocol: 'https:' },
            navigator: { standalone },
            Notification: { permission },
            PushManager: function () {},
            matchMedia: () => ({ matches: standalone }),
            addEventListener() {},
          }
        : {
            location: { protocol: 'https:' },
            matchMedia: () => ({ matches: standalone }),
            addEventListener() {},
          },
      document: {
        getElementById: (id) => (id === 'pwaPushGuideModal' ? modalEl : null),
        querySelectorAll: () => [],
      },
      showToast: (msg) => toasts.push(msg),
    };
    if (hasPushApi) {
      ctx.Notification = { permission };
    }
    vm.createContext(ctx);
    vm.runInContext(appSrc, ctx);
    ctx._state = vm.runInContext('state', ctx);
    let guideOpened = 0;
    let pushSynced = 0;
    ctx.openPwaPushGuide = () => { guideOpened++; };
    ctx.subscribeToWebPush = async () => { pushSynced++; return true; };
    ctx.showToast = (msg) => toasts.push(msg);
    return { ctx, toasts, getGuideOpened: () => guideOpened, getPushSynced: () => pushSynced };
  }

  // 1. Unsupported environment (e.g. in-app browser without PushManager) -> returns true without blocking
  const envUnsupported = makeEnv({ hasPushApi: false });
  assert.equal(envUnsupported.ctx.ensurePwaPushPermissionForAction('출결 보고'), true);
  assert.equal(envUnsupported.getGuideOpened(), 0);

  // 2. Permission default -> opens guide, shows toast, returns false
  const envDefault = makeEnv({ hasPushApi: true, permission: 'default' });
  envDefault.ctx._state.pwaPushGuideDismissed = true;
  assert.equal(envDefault.ctx.ensurePwaPushPermissionForAction('출결 보고'), false);
  assert.equal(envDefault.ctx._state.pwaPushGuideDismissed, false);
  assert.equal(envDefault.getGuideOpened(), 1);
  assert.match(envDefault.toasts[0], /출결 보고/);

  // 3. iOS browser tab (even if Notification exists) -> returns false
  const envIosTab = makeEnv({
    hasPushApi: true,
    permission: 'granted',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    standalone: false,
  });
  assert.equal(envIosTab.ctx.ensurePwaPushPermissionForAction('가정통신문 회신'), false);
  assert.equal(envIosTab.getGuideOpened(), 1);

  // 4. Granted on non-iOS (or iOS standalone) -> returns true & syncs subscription
  const envGranted = makeEnv({ hasPushApi: true, permission: 'granted' });
  assert.equal(envGranted.ctx.ensurePwaPushPermissionForAction('1:1 상담 메시지 전송'), true);
  assert.equal(envGranted.getPushSynced(), 1);
  assert.equal(envGranted.getGuideOpened(), 0);
});
