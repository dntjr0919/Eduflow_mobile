const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  _deriveAttCheckStatus,
  _formatOutingPeriodInfo,
  _getReturnPeriodOptions,
  _parseOutingPeriodInfo,
} = require('../teacher.js');

const PERIOD_OPTIONS = ['조회', '1교시', '2교시', '3교시', '4교시', '5교시', '6교시', '7교시'];

test('_formatOutingPeriodInfo formats single-period and multi-period outings consistently', () => {
  assert.equal(_formatOutingPeriodInfo('3교시', '3교시'), '3교시');
  assert.equal(_formatOutingPeriodInfo('3교시', ''), '3교시');
  assert.equal(_formatOutingPeriodInfo('3교시', '5교시'), '3교시~5교시');
  assert.equal(_formatOutingPeriodInfo('조회', '2교시'), '조회~2교시');
  assert.equal(_formatOutingPeriodInfo('', '3교시'), '');
});

test('_getReturnPeriodOptions dynamically includes startPeriod and all subsequent periods', () => {
  assert.deepEqual(
    _getReturnPeriodOptions(PERIOD_OPTIONS, '3교시'),
    ['3교시', '4교시', '5교시', '6교시', '7교시']
  );
  assert.deepEqual(
    _getReturnPeriodOptions(PERIOD_OPTIONS, '7교시'),
    ['7교시']
  );
  assert.deepEqual(_getReturnPeriodOptions(PERIOD_OPTIONS, ''), []);
});

test('_parseOutingPeriodInfo round-trips single and range periodInfo strings', () => {
  assert.deepEqual(_parseOutingPeriodInfo('3교시', PERIOD_OPTIONS), {
    period: '3교시',
    returnPeriod: '3교시',
  });
  assert.deepEqual(_parseOutingPeriodInfo('3교시~5교시', PERIOD_OPTIONS), {
    period: '3교시',
    returnPeriod: '5교시',
  });
  assert.deepEqual(_parseOutingPeriodInfo('3~4교시', PERIOD_OPTIONS), {
    period: '3교시',
    returnPeriod: '4교시',
  });
  assert.deepEqual(_parseOutingPeriodInfo('조회~2교시', PERIOD_OPTIONS), {
    period: '조회',
    returnPeriod: '2교시',
  });
});

test('_deriveAttCheckStatus derives 출석, 결석, 지각, 조퇴, and 외출 correctly', () => {
  assert.equal(_deriveAttCheckStatus({ checked: false, period: '', isOuting: false }).type, '출석');
  assert.equal(_deriveAttCheckStatus({ checked: true, period: '', isOuting: false }).type, '결석');

  const late = _deriveAttCheckStatus({ checked: true, period: '2교시', isOuting: false });
  assert.equal(late.type, '지각');
  assert.equal(late.label, '지각 (2교시까지 결과)');

  const early = _deriveAttCheckStatus({ checked: false, period: '3교시', isOuting: false });
  assert.equal(early.type, '조퇴');
  assert.equal(early.label, '조퇴 (3교시부터 결과)');

  const singleOuting = _deriveAttCheckStatus({
    checked: false,
    period: '3교시',
    isOuting: true,
    returnPeriod: '3교시',
  });
  assert.equal(singleOuting.type, '외출');
  assert.equal(singleOuting.periodInfo, '3교시');
  assert.equal(singleOuting.label, '외출 (3교시)');

  const rangeOuting = _deriveAttCheckStatus({
    checked: false,
    period: '3교시',
    isOuting: true,
    returnPeriod: '5교시',
  });
  assert.equal(rangeOuting.type, '외출');
  assert.equal(rangeOuting.periodInfo, '3교시~5교시');
  assert.equal(rangeOuting.label, '외출 (3교시~5교시)');
});

test('index.html and api/firestore.js include outing summary UI and period_info persistence', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(html.includes('id="attCheckCntOuting"'));
  assert.ok(html.includes('<option value="외출">외출</option>'));
  assert.ok(html.includes('지각·조퇴·외출'));

  const firestoreSrc = fs.readFileSync(path.join(__dirname, '../api/firestore.js'), 'utf8');
  const saveClassIdx = firestoreSrc.indexOf("if (action === 'save_class_attendance')");
  assert.ok(saveClassIdx >= 0);
  const saveClassBlock = firestoreSrc.slice(saveClassIdx, saveClassIdx + 3500);
  assert.ok(saveClassBlock.includes('period_info: String(rec.period_info || \'\')'));
  assert.ok(saveClassBlock.includes('att_sub_type: String(rec.att_sub_type || \'\')'));
});
