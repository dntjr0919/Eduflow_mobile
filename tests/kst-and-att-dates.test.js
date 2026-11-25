const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { _getLocalTodayStr, _getKoreanTodayDayChar } = require('../app.js');
const { _kstDateStr, _nowStr } = require('../api/firestore.js')._testHelpers;

test('app.js and api/firestore.js compute KST date and weekday at 00:00~08:59 KST', (t) => {
  // 2026-11-23T23:30:00Z == 2026-11-24 08:30:00 KST (Tuesday, '화')
  const utcMs = new Date('2026-11-23T23:30:00.000Z').getTime();
  t.mock.timers.enable({ apis: ['Date'], now: utcMs });

  assert.equal(_getLocalTodayStr(), '2026-11-24');
  assert.equal(_getKoreanTodayDayChar(), '화');
  assert.equal(_kstDateStr(), '2026-11-24');
  assert.equal(_nowStr(), '2026-11-24 08:30:00');
});

test('student.js syncAttEndDateIfNeeded and handleAttendanceSubmit enforce start <= end and preserve valid endDate', async () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(indexHtml, /id="attStartDate"[^>]*onchange="syncAttEndDateIfNeeded\(\)"/);
  assert.match(indexHtml, /id="attEndDate"[^>]*onchange="syncAttEndDateIfNeeded\(\)"/);

  const studentSrc = fs.readFileSync(path.join(__dirname, '..', 'student.js'), 'utf8');
  const startEl = { value: '2026-11-25', min: '' };
  const endEl = { value: '2026-11-27', min: '', disabled: false };
  const reasonEl = { value: '개인 사유' };
  const periodSelectEl = { value: '' };
  const toasts = [];

  const ctx = {
    console,
    Date,
    state: {
      selectedAttCategory: '인정',
      selectedAttSubType: '결석',
      editingAttendanceId: null,
    },
    mockData: {
      attendanceHistory: [],
    },
    getLocalTodayStr: () => '2026-11-25',
    showToast: (msg) => toasts.push(msg),
    document: {
      getElementById: (id) => {
        if (id === 'attStartDate') return startEl;
        if (id === 'attEndDate') return endEl;
        if (id === 'attReason') return reasonEl;
        if (id === 'attPeriodSelect') return periodSelectEl;
        return null;
      },
      querySelectorAll: () => [],
    },
  };
  vm.createContext(ctx);
  vm.runInContext(studentSrc, ctx);

  // 1. start <= end: keep user's endEl.value, set endEl.min = startEl.value
  ctx.syncAttEndDateIfNeeded();
  assert.equal(endEl.disabled, false);
  assert.equal(endEl.min, '2026-11-25');
  assert.equal(endEl.value, '2026-11-27');

  // 2. start > end: auto-sync endEl.value = startEl.value
  startEl.value = '2026-11-28';
  ctx.syncAttEndDateIfNeeded();
  assert.equal(endEl.min, '2026-11-28');
  assert.equal(endEl.value, '2026-11-28');

  // 3. empty endVal: auto-sync to startEl.value
  endEl.value = '';
  ctx.syncAttEndDateIfNeeded();
  assert.equal(endEl.value, '2026-11-28');

  // 4. 지각/조퇴: lock endEl to startEl and disable
  ctx.state.selectedAttSubType = '지각';
  endEl.value = '2026-11-30';
  ctx.syncAttEndDateIfNeeded();
  assert.equal(endEl.disabled, true);
  assert.equal(endEl.value, '2026-11-28');

  // 5. handleAttendanceSubmit blocks endDate < startDate and corrects endEl
  ctx.state.selectedAttSubType = '결석';
  endEl.disabled = false;
  startEl.value = '2026-11-28';
  endEl.value = '2026-11-26';
  await ctx.handleAttendanceSubmit({ preventDefault() {}, target: { querySelector: () => null } });
  assert.equal(endEl.value, '2026-11-28');
  assert.equal(toasts.length > 0, true);
});
