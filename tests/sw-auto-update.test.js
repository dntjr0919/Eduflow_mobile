const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { initServiceWorkerAndAutoSync } = require('../app.js');

test('sw.js uses network-first with no-cache, skipWaiting, clients.claim, and offline cache fallback', () => {
  const swSrc = fs.readFileSync(path.resolve(__dirname, '../sw.js'), 'utf8');
  assert.match(swSrc, /self\.skipWaiting\(\)/);
  assert.match(swSrc, /self\.clients\.claim\(\)/);
  assert.match(swSrc, /cache:\s*['"]no-store['"]/);
  assert.match(swSrc, /cache:\s*['"]no-cache['"]/);
  assert.match(swSrc, /\.catch\(\(\)\s*=>\s*caches\.match\(event\.request\)\)/);
});

test('initServiceWorkerAndAutoSync registers with updateViaCache:none, updates on visibilitychange, and guards controllerchange reload', async (t) => {
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevDocument = global.document;
  const prevWindow = global.window;
  const prevSessionStorage = global.sessionStorage;

  t.after(() => {
    if (prevNavDesc) Object.defineProperty(globalThis, 'navigator', prevNavDesc);
    global.document = prevDocument;
    global.window = prevWindow;
    global.sessionStorage = prevSessionStorage;
  });

  const swListeners = {};
  const docListeners = {};
  let registerOpts = null;
  let updateCalls = 0;
  let reloadCalls = 0;
  const ss = new Map();

  global.sessionStorage = {
    getItem: (k) => (ss.has(k) ? ss.get(k) : null),
    setItem: (k, v) => ss.set(k, String(v)),
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        controller: {}, // simulate already controlled page
        addEventListener: (ev, cb) => { swListeners[ev] = cb; },
        register: async (_path, opts) => {
          registerOpts = opts;
          return {
            update: async () => { updateCalls += 1; },
          };
        },
      },
    },
  });

  global.document = {
    visibilityState: 'visible',
    addEventListener: (ev, cb) => { docListeners[ev] = cb; },
    getElementById: (id) => (
      id === 'dashboardScreen'
        ? null
        : { innerText: '', classList: { add: () => {}, remove: () => {}, contains: () => true } }
    ),
  };

  global.window = {
    addEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    navigator: { standalone: false },
    location: {
      reload: () => { reloadCalls += 1; },
    },
  };

  initServiceWorkerAndAutoSync();
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(registerOpts, { updateViaCache: 'none' });
  assert.equal(typeof docListeners.visibilitychange, 'function');
  assert.equal(typeof swListeners.controllerchange, 'function');

  // visibilitychange triggers registration.update()
  docListeners.visibilitychange();
  assert.equal(updateCalls, 1);

  // controllerchange reloads once (reloading flag prevents duplicate reload)
  swListeners.controllerchange();
  swListeners.controllerchange();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(reloadCalls, 1);
});
