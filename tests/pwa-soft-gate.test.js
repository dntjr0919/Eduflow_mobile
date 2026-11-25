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

function makeAppVmEnv({ hasPushApi = true, permission = 'default', ua = 'Chrome/124', standalone = false } = {}) {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const storage = new Map();
  const scheduledTimers = [];
  const modalEl = { classList: { add() {}, remove() {}, contains: () => true } };
  const ctx = {
    console,
    Date,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    setTimeout: (fn, ms) => {
      scheduledTimers.push({ fn, ms });
      return scheduledTimers.length;
    },
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
          navigator: { standalone },
          matchMedia: () => ({ matches: standalone }),
          addEventListener() {},
        },
    document: {
      getElementById: (id) => (id === 'pwaPushGuideModal' ? modalEl : null),
      querySelectorAll: () => [],
    },
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
  ctx.showToast = () => {};
  return {
    ctx,
    storage,
    scheduledTimers,
    flushTimers: () => {
      while (scheduledTimers.length > 0) {
        const item = scheduledTimers.shift();
        item.fn();
      }
    },
    getGuideOpened: () => guideOpened,
    getPushSynced: () => pushSynced,
  };
}

test('ensurePwaPushPermissionForAction is non-blocking and nudges at most once per KST day', () => {
  // 1. Unsupported environment -> always true, no nudge
  const envUnsupported = makeAppVmEnv({ hasPushApi: false });
  assert.equal(envUnsupported.ctx.ensurePwaPushPermissionForAction('출결 보고'), true);
  envUnsupported.flushTimers();
  assert.equal(envUnsupported.getGuideOpened(), 0);

  // 2. Permission default -> returns true immediately, opens guide once after ~400ms, skips 2nd call same day
  const envDefault = makeAppVmEnv({ hasPushApi: true, permission: 'default' });
  assert.equal(envDefault.ctx.ensurePwaPushPermissionForAction('출결 보고'), true);
  assert.equal(envDefault.scheduledTimers.length, 1);
  assert.equal(envDefault.scheduledTimers[0].ms, 400);
  assert.equal(envDefault.getGuideOpened(), 0);
  envDefault.flushTimers();
  assert.equal(envDefault.getGuideOpened(), 1);

  // 2nd call same KST day -> returns true, no additional timer
  assert.equal(envDefault.ctx.ensurePwaPushPermissionForAction('가정통신문 회신'), true);
  assert.equal(envDefault.scheduledTimers.length, 0);

  // 3. Dismissed earlier today -> does not schedule nudge on same day
  const envDismissed = makeAppVmEnv({ hasPushApi: true, permission: 'default' });
  envDismissed.ctx.dismissPwaPushGuide();
  assert.equal(envDismissed.ctx.ensurePwaPushPermissionForAction('1:1 상담 메시지 전송'), true);
  assert.equal(envDismissed.scheduledTimers.length, 0);

  // 4. iOS browser tab -> returns true (non-blocking) and schedules 1-time nudge
  const envIosTab = makeAppVmEnv({
    hasPushApi: true,
    permission: 'granted',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    standalone: false,
  });
  assert.equal(envIosTab.ctx.ensurePwaPushPermissionForAction('가정통신문 회신'), true);
  assert.equal(envIosTab.scheduledTimers.length, 1);
  envIosTab.flushTimers();
  assert.equal(envIosTab.getGuideOpened(), 1);

  // 5. Granted on non-iOS -> returns true, syncs subscription, no guide
  const envGranted = makeAppVmEnv({ hasPushApi: true, permission: 'granted' });
  assert.equal(envGranted.ctx.ensurePwaPushPermissionForAction('1:1 상담 메시지 전송'), true);
  assert.equal(envGranted.getPushSynced(), 1);
  assert.equal(envGranted.scheduledTimers.length, 0);
});

test('_getDeviceDeniedStepsHtml renders exact single-path guidance per platform and standalone state', () => {
  const androidTab = makeAppVmEnv({
    ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/124.0.0.0 Mobile Safari/537.36',
    standalone: false,
  });
  const tabHtml = vm.runInContext('_getDeviceDeniedStepsHtml()', androidTab.ctx);
  assert.match(tabHtml, /오른쪽 위/);
  assert.match(tabHtml, /사이트 정보/);
  assert.match(tabHtml, /시크릿 모드/);
  assert.doesNotMatch(tabHtml, /길게 누르기/);

  const androidPwa = makeAppVmEnv({
    ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/124.0.0.0 Mobile Safari/537.36',
    standalone: true,
  });
  const pwaHtml = vm.runInContext('_getDeviceDeniedStepsHtml()', androidPwa.ctx);
  assert.match(pwaHtml, /길게 누르기/);
  assert.match(pwaHtml, /앱 정보/);
  assert.doesNotMatch(pwaHtml, /시크릿 모드/);

  const iosPwa = makeAppVmEnv({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    standalone: true,
  });
  const iosHtml = vm.runInContext('_getDeviceDeniedStepsHtml()', iosPwa.ctx);
  assert.match(iosHtml, /아이폰 설정/);
  assert.match(iosHtml, /EduFlow/);
});
