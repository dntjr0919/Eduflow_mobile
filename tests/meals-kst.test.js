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
const {
  _nowStr,
  _kstDateStr,
  _handleGetMobileBundle,
  _syncNeisMeals,
} = _testHelpers;
const {
  _getLocalTodayStr,
  hydrateMockDataFromBundle,
  mockData,
} = require('../app.js');

function createMealMockDb(initialCollections = {}) {
  const store = new Map();
  const recordedQueries = [];
  for (const [colName, docs] of Object.entries(initialCollections)) {
    const colMap = new Map();
    for (const [docId, data] of Object.entries(docs)) {
      colMap.set(docId, { ...data });
    }
    store.set(colName, colMap);
  }

  function getColMap(colName) {
    if (!store.has(colName)) store.set(colName, new Map());
    return store.get(colName);
  }

  function makeSnap(docId, data) {
    return {
      id: docId,
      exists: data !== undefined,
      data: () => (data ? { ...data } : undefined),
    };
  }

  function makeQuery(colName, filters = [], maxLimit = Infinity) {
    return {
      where(field, op, val) {
        return makeQuery(colName, [...filters, { field, op, val }], maxLimit);
      },
      limit(n) {
        return makeQuery(colName, filters, n);
      },
      async get() {
        recordedQueries.push({ colName, filters, maxLimit });
        const colMap = getColMap(colName);
        const matched = [];
        for (const [id, data] of colMap.entries()) {
          let ok = true;
          for (const f of filters) {
            const v = data[f.field];
            if (f.op === '==' && v !== f.val) ok = false;
            else if (f.op === '>=' && !(String(v || '') >= String(f.val))) ok = false;
            else if (f.op === 'in' && (!Array.isArray(f.val) || !f.val.includes(v))) ok = false;
            else if (f.op === '!=' && v === f.val) ok = false;
          }
          if (ok) matched.push(makeSnap(id, data));
          if (matched.length >= maxLimit) break;
        }
        return {
          empty: matched.length === 0,
          docs: matched,
          forEach(cb) { matched.forEach(cb); },
        };
      },
    };
  }

  return {
    _recordedQueries: recordedQueries,
    collection(colName) {
      return {
        doc(docId) {
          return {
            async get() {
              const colMap = getColMap(colName);
              return makeSnap(docId, colMap.get(docId));
            },
            async set(data, opts = {}) {
              const colMap = getColMap(colName);
              const prev = opts.merge ? (colMap.get(docId) || {}) : {};
              colMap.set(docId, { ...prev, ...data });
            },
          };
        },
        where(field, op, val) {
          return makeQuery(colName, [{ field, op, val }]);
        },
        limit(n) {
          return makeQuery(colName, [], n);
        },
        async get() {
          return makeQuery(colName).get();
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data, opts) {
          ops.push({ ref, data, opts });
        },
        async commit() {
          for (const op of ops) {
            await op.ref.set(op.data, op.opts);
          }
        },
      };
    },
  };
}

test('hydrateMockDataFromBundle uses local KST date at 00:00~08:59 KST and does not fall back to yesterday meals', (t) => {
  // 2026-11-23T23:30:00Z == 2026-11-24 08:30:00 KST (UTC is still 2026-11-23)
  const kstMorningUtcMs = new Date('2026-11-23T23:30:00.000Z').getTime();
  t.mock.timers.enable({ apis: ['Date'], now: kstMorningUtcMs });

  const localToday = _getLocalTodayStr();
  const utcToday = new Date().toISOString().split('T')[0];
  assert.equal(utcToday, '2026-11-23');
  assert.equal(localToday, '2026-11-24');

  // Case 1: Both yesterday and today meals exist -> must pick today (2026-11-24), not yesterday (2026-11-23)
  hydrateMockDataFromBundle({
    ok: true,
    meals: [
      { meal_date: '2026-11-23', meal_type: '중식', menu_text: '어제밥\n어제국', calories: '700 kcal' },
      { meal_date: '2026-11-24', meal_type: '중식', menu_text: '오늘밥\n오늘국', calories: '800 kcal' },
      { meal_date: '2026-11-24', meal_type: '석식', menu_text: '오늘저녁', calories: '650 kcal' },
    ],
  });
  assert.equal(mockData.meals.lunch.calories, '800 kcal');
  assert.deepEqual(mockData.meals.lunch.menu.map((m) => m.name), ['오늘밥', '오늘국']);
  assert.equal(mockData.meals.dinner.calories, '650 kcal');

  // Case 2: Only yesterday meal exists (today has no meal) -> must return null instead of falling back
  hydrateMockDataFromBundle({
    ok: true,
    meals: [
      { meal_date: '2026-11-23', meal_type: '중식', menu_text: '어제밥\n어제국', calories: '700 kcal' },
      { meal_date: '2026-11-23', meal_type: '석식', menu_text: '어제저녁', calories: '600 kcal' },
    ],
  });
  assert.equal(mockData.meals.lunch, null);
  assert.equal(mockData.meals.dinner, null);
});

test('api/firestore.js _nowStr and _kstDateStr always use KST (Asia/Seoul) regardless of UTC date', () => {
  // 2026-11-23 15:30:00 UTC == 2026-11-24 00:30:00 KST
  const kstMidnightPlus = new Date('2026-11-23T15:30:00.000Z');
  assert.equal(_nowStr(kstMidnightPlus), '2026-11-24 00:30:00');
  assert.equal(_kstDateStr(kstMidnightPlus, 0), '2026-11-24');
  assert.equal(_kstDateStr(kstMidnightPlus, 6), '2026-11-30');

  // 2026-11-23 23:59:59 UTC == 2026-11-24 08:59:59 KST
  const kstBeforeNine = new Date('2026-11-23T23:59:59.000Z');
  assert.equal(_nowStr(kstBeforeNine), '2026-11-24 08:59:59');
  assert.equal(_kstDateStr(kstBeforeNine, 0), '2026-11-24');
});

test('_handleGetMobileBundle queries 급식_식단표 with single-field school_code and filters -7~+7 days (KST)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-23T23:30:00.000Z').getTime() });
  if (globalThis.__eduflowStaticCache) globalThis.__eduflowStaticCache.clear();

  const meals = {};
  for (let i = 1; i <= 65; i++) {
    const day = String(((i - 1) % 20) + 1).padStart(2, '0');
    meals[`old_${i}`] = {
      remote_id: `old_${i}`,
      meal_date: `2026-10-${day}`,
      meal_type: '중식',
      menu_text: `옛날급식_${i}`,
      school_code: '7010001',
    };
  }
  meals['minus_7'] = {
    remote_id: 'minus_7',
    meal_date: '2026-11-17',
    meal_type: '중식',
    menu_text: '7일전급식',
    school_code: '7010001',
  };
  meals['today_s1'] = {
    remote_id: 'today_s1',
    meal_date: '2026-11-24',
    meal_type: '중식',
    menu_text: '오늘급식',
    school_code: '7010001',
  };
  meals['plus_7'] = {
    remote_id: 'plus_7',
    meal_date: '2026-12-01',
    meal_type: '석식',
    menu_text: '7일후급식',
    school_code: '7010001',
  };
  meals['plus_8'] = {
    remote_id: 'plus_8',
    meal_date: '2026-12-02',
    meal_type: '중식',
    menu_text: '8일후급식',
    school_code: '7010001',
  };
  meals['today_other_school'] = {
    remote_id: 'today_other_school',
    meal_date: '2026-11-24',
    meal_type: '중식',
    menu_text: '다른학교급식',
    school_code: '9999999',
  };

  const db = createMealMockDb({ '급식_식단표': meals });
  const res = await _handleGetMobileBundle(db, {
    role: 'student',
    student_id: '10101',
    grade: 1,
    class_no: 1,
    school_code: '7010001',
    force: '1',
  });

  assert.equal(res.status, 200);
  const ids = res.json.meals.map((m) => m.remote_id).sort();
  assert.deepEqual(ids, ['minus_7', 'plus_7', 'today_s1']);

  const mealQuery = db._recordedQueries.find((q) => q.colName === '급식_식단표');
  assert.ok(mealQuery);
  assert.deepEqual(mealQuery.filters, [{ field: 'school_code', op: '==', val: '7010001' }]);
  assert.equal(mealQuery.maxLimit, 500);

  // skip_meals=1 skips querying 급식_식단표 completely
  db._recordedQueries.length = 0;
  const skipRes = await _handleGetMobileBundle(db, {
    role: 'student',
    student_id: '10101',
    grade: 1,
    class_no: 1,
    school_code: '7010001',
    skip_meals: '1',
  });
  assert.equal(skipRes.status, 200);
  assert.equal(skipRes.json.meals, undefined);
  assert.equal(db._recordedQueries.some((q) => q.colName === '급식_식단표'), false);
});

test('_syncNeisMeals requests NEIS API with KST date range and invalidates meals static cache', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-23T23:30:00.000Z').getTime() });
  if (globalThis.__eduflowStaticCache) {
    globalThis.__eduflowStaticCache.clear();
    globalThis.__eduflowStaticCache.set('meals:7010001', { value: [], expiresAt: Date.now() + 60000 });
  }

  let requestedUrl = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      async json() {
        return {
          mealServiceDietInfo: [
            {},
            {
              row: [
                {
                  MLSV_YMD: '20261124',
                  MMEAL_SC_NM: '중식',
                  DDISH_NM: '쌀밥<br/>된장국 (5.6.)',
                  CAL_INFO: '750 Kcal',
                },
              ],
            },
          ],
        };
      },
    };
  };

  try {
    const db = createMealMockDb();
    const res = await _syncNeisMeals(db, {
      office_code: 'B10',
      school_code: '7010001',
    });
    assert.equal(res.ok, true);
    assert.equal(res.count, 1);

    const parsed = new URL(requestedUrl);
    assert.equal(parsed.searchParams.get('MLSV_FROM_YMD'), '20261124');
    assert.equal(parsed.searchParams.get('MLSV_TO_YMD'), '20261130');
    assert.equal(globalThis.__eduflowStaticCache.has('meals:7010001'), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
