const assert = require('assert');
const {
  parseGapToMs,
  parseTimeToMs,
  classSortedRows,
  classGapToPrevious,
  relativeClassGap,
  lapsForCar,
  recentAverageForCar,
  buildClassBattleSummary
} = require('../src/shared/classBattle');

const rowsWithOtherClassBetween = [
  { position: 6, carNumber: 13, className: 'LMP3', classPosition: 1, team: 'Inter Europol Competition', driver: 'Nigel Moore', lastLap: '2:06.516', lastLapMs: 126516, bestLap: '2:03.628', diff: '5:24.534', gap: '5:24.534' },
  { position: 7, carNumber: 59, className: 'LMP2 AM', classPosition: 1, team: 'RLR MSport', driver: 'Andrew Higgins', lastLap: '2:08.261', lastLapMs: 128261, bestLap: '1:58.141', diff: '-- 106 laps --', gap: '-- 106 laps --' },
  { position: 8, carNumber: 2, className: 'LMP3', classPosition: 2, team: 'Nielsen Racing', driver: 'Colin Noble', lastLap: '2:05.791', lastLapMs: 125791, bestLap: '2:03.625', diff: '10.246', gap: '10.246' }
];

const sameClassRows = [
  { position: 1, carNumber: 13, className: 'LMP3', classPosition: 1, team: 'Leader', driver: 'Leader Driver', lastLap: '2:06.000', lastLapMs: 126000, diff: '' },
  { position: 2, carNumber: 2, className: 'LMP3', classPosition: 2, team: 'Chaser', driver: 'Chaser Driver', lastLap: '2:05.000', lastLapMs: 125000, diff: '12.000', gap: '12.000' },
  { position: 3, carNumber: 9, className: 'LMP3', classPosition: 3, team: 'Third', driver: 'Third Driver', lastLap: '2:07.000', lastLapMs: 127000, diff: '3.000', gap: '15.000' }
];

const history = [
  { carNumber: 13, lapNumber: 1, lastLapMs: 126000, driverName: 'Leader Driver', collectedAt: '2026-06-23T12:00:01.000Z' },
  { carNumber: 13, lapNumber: 2, lastLapMs: 126000, driverName: 'Leader Driver', collectedAt: '2026-06-23T12:02:07.000Z' },
  { carNumber: 2, lapNumber: 1, lastLapMs: 125000, driverName: 'Chaser Driver', collectedAt: '2026-06-23T12:00:02.000Z' },
  { carNumber: 2, lapNumber: 2, lastLapMs: 125000, driverName: 'Chaser Driver', collectedAt: '2026-06-23T12:02:06.000Z' },
  { carNumber: 9, lapNumber: 1, lastLapMs: 127000, driverName: 'Third Driver', collectedAt: '2026-06-23T12:00:03.000Z' }
];

assert.strictEqual(parseGapToMs('12.000'), 12000);
assert.strictEqual(parseGapToMs('+1:02.500'), 62500);
assert.strictEqual(parseGapToMs('-- 106 laps --'), null);
assert.strictEqual(parseTimeToMs('1:02:034'), 62034);
assert.strictEqual(parseTimeToMs('10:02:03.456'), 36123456);
assert.strictEqual(parseTimeToMs('bad time'), null);

assert.deepStrictEqual(classSortedRows(rowsWithOtherClassBetween, 'LMP3').map((row) => row.carNumber), [13, 2]);

const classRowsWithGapProblem = classSortedRows(rowsWithOtherClassBetween, 'LMP3');
const unsafeGap = classGapToPrevious(rowsWithOtherClassBetween, classRowsWithGapProblem, rowsWithOtherClassBetween[2]);
assert.strictEqual(unsafeGap.reliable, false);
assert.strictEqual(unsafeGap.label, 'class gap unknown');
assert.strictEqual(relativeClassGap(rowsWithOtherClassBetween, classRowsWithGapProblem, rowsWithOtherClassBetween[0], rowsWithOtherClassBetween[2]), null);

const unsafeSummary = buildClassBattleSummary(rowsWithOtherClassBetween, history, 13);
const unsafeItem = unsafeSummary.items.find((item) => String(item.row.carNumber) === '2');
assert.strictEqual(unsafeItem.classGap.label, 'class gap unknown');
assert.strictEqual(unsafeItem.battle.relativeGap, null);
assert.ok(unsafeItem.battle.catchInfo.includes('#2 gaining'));
assert.ok(unsafeItem.battle.catchInfo.includes('1.000s/lap'));
assert.ok(!unsafeItem.battle.catchInfo.includes('laps ·'));

const classRows = classSortedRows(sameClassRows, 'LMP3');
const reliableGap = classGapToPrevious(sameClassRows, classRows, sameClassRows[1]);
assert.strictEqual(reliableGap.reliable, true);
assert.strictEqual(reliableGap.ms, 12000);
assert.strictEqual(relativeClassGap(sameClassRows, classRows, sameClassRows[0], sameClassRows[2]), 15000);
assert.strictEqual(recentAverageForCar(history, 2), 125000);
assert.deepStrictEqual(lapsForCar([
  { carNumber: 5, lapNumber: '', lapTimeMs: 102000, collectedAt: '2026-06-23T12:02:00.000Z' },
  { carNumber: 5, lapNumber: '', lapTimeMs: 101000, collectedAt: '2026-06-23T12:01:00.000Z' },
  { carNumber: 6, lapTimeMs: 99000, collectedAt: '2026-06-23T12:00:00.000Z' }
], 5).map((lap) => lap.lastLapMs), [101000, 102000]);

const sameLapSummary = buildClassBattleSummary(sameClassRows, history, 13);
const chaserItem = sameLapSummary.items.find((item) => String(item.row.carNumber) === '2');
assert.strictEqual(chaserItem.classGap.label, '12.000s');
assert.strictEqual(chaserItem.battle.relativeGap, 12000);
assert.strictEqual(chaserItem.battle.lapsToCatch, 12);
assert.ok(chaserItem.battle.catchInfo.includes('#2 catches us'));
assert.ok(chaserItem.battle.catchInfo.includes('12.0 laps'));

const followedBehindSummary = buildClassBattleSummary(sameClassRows, history, 2);
const leaderItem = followedBehindSummary.items.find((item) => String(item.row.carNumber) === '13');
assert.strictEqual(leaderItem.battle.relation, 'ahead');
assert.strictEqual(leaderItem.battle.lapsToCatch, 12);
assert.ok(leaderItem.battle.catchInfo.includes('we catch #13'));

const slowerBehindSummary = buildClassBattleSummary(sameClassRows, [
  { carNumber: 13, lapNumber: 1, lastLapMs: 125000 },
  { carNumber: 2, lapNumber: 1, lastLapMs: 126000 }
], 2);
const slowerLeaderItem = slowerBehindSummary.items.find((item) => String(item.row.carNumber) === '13');
assert.strictEqual(slowerLeaderItem.battle.estimate, 'we are not catching');

const missingSummary = buildClassBattleSummary(sameClassRows, history, 999);
assert.strictEqual(missingSummary.followed, null);
assert.deepStrictEqual(missingSummary.items, []);

console.log('Class battle tests passed.');
