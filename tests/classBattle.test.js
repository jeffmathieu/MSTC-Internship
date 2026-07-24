const assert = require('assert');
const {
  numberOrNull,
  average,
  parseGapToMs,
  parseLapGap,
  parseTimeToMs,
  formatSeconds,
  formatSignedSeconds,
  rowSortNumber,
  classSortedRows,
  classGapToPrevious,
  relativeClassGap,
  overallRelativeGap,
  usesCumulativeGap,
  cumulativeGapToLeaderMs,
  lapGapBetween,
  lapsForCar,
  recentAverageForCar,
  buildClassBattleSummary,
  buildAdjacentClassBattles
} = require('../src/shared/classBattle');

assert.strictEqual(numberOrNull('12'), 12);
assert.strictEqual(numberOrNull(''), null);
assert.strictEqual(numberOrNull('bad'), null);
assert.strictEqual(average([]), null);
assert.strictEqual(average([null, 'bad', 1000, '2000']), 1500);
assert.strictEqual(formatSeconds(NaN), '—');
assert.strictEqual(formatSignedSeconds(1250), '+1.250s');
assert.strictEqual(formatSignedSeconds(-1250), '-1.250s');
assert.strictEqual(formatSignedSeconds(null), '—');
assert.strictEqual(rowSortNumber('2'), 2);
assert.strictEqual(rowSortNumber('unknown'), 999999);

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
assert.strictEqual(parseGapToMs('5L'), null);
assert.strictEqual(parseGapToMs(''), null);
assert.strictEqual(parseLapGap('5L'), 5);
assert.strictEqual(parseLapGap('5 L'), 5);
assert.strictEqual(parseLapGap('-- 106 laps --'), 106);
assert.strictEqual(parseLapGap('1 lap'), 1);
assert.strictEqual(parseLapGap('15.250'), null);
assert.strictEqual(parseTimeToMs('1:02:034'), 62034);
assert.strictEqual(parseTimeToMs('10:02:03.456'), 36123456);
assert.strictEqual(parseTimeToMs('12.5'), 12500);
assert.strictEqual(parseTimeToMs('1:02,500'), 62500);
assert.strictEqual(parseTimeToMs(''), null);
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
assert.ok(unsafeItem.battle.catchInfo.includes('they gain 1.000s/l'));
assert.ok(!unsafeItem.battle.catchInfo.includes('laps ·'));

const numericOtherClassChain = [
  { position: 1, carNumber: 13, className: 'LMP3', classPosition: 1, lapNumber: 20, lastLap: '2:05.000', diff: '' },
  { position: 2, carNumber: 77, className: 'GT', classPosition: 1, lapNumber: 20, lastLap: '2:07.000', diff: '4.000' },
  { position: 3, carNumber: 2, className: 'LMP3', classPosition: 2, lapNumber: 20, lastLap: '2:04.000', diff: '6.000' }
];
assert.strictEqual(overallRelativeGap(numericOtherClassChain, numericOtherClassChain[0], numericOtherClassChain[2]), 10000);
const numericChainBattle = buildAdjacentClassBattles(numericOtherClassChain, history, 13, { lapWindow: 10 });
assert.strictEqual(numericChainBattle.behind.relativeGap, 10000);
assert.strictEqual(numericChainBattle.behind.lastLapDeltaMs, -1000);
assert.strictEqual(numericChainBattle.behind.trendState, 'bad');
assert.strictEqual(numericChainBattle.lapWindow, 10);
assert.strictEqual(overallRelativeGap(numericOtherClassChain, numericOtherClassChain[0], { ...numericOtherClassChain[2], lapNumber: 19 }), null);

const confirmedChainBattle = buildAdjacentClassBattles(numericOtherClassChain, history, 13, {
  lapWindow: 5,
  confirmedGapView: {
    behind: {
      rivalCarNumber: '2',
      gapMs: 8500,
      lapGap: 0,
      estimated: false,
      source: 'confirmed-interval-chain',
      confirmedAt: '2026-07-05T10:00:00.000Z'
    }
  }
});
assert.strictEqual(confirmedChainBattle.behind.relativeGap, 8500);
assert.strictEqual(confirmedChainBattle.behind.gapSource, 'confirmed-interval-chain');
assert.strictEqual(confirmedChainBattle.behind.gapConfirmedAt, '2026-07-05T10:00:00.000Z');
const suppressedChainBattle = buildAdjacentClassBattles(numericOtherClassChain, history, 13, {
  confirmedGapView: {
    behind: { rivalCarNumber: '2', gapMs: 8500, lapGap: 0, suppressed: true, rivalInPit: true, rivalPitLaps: 5 }
  }
});
assert.strictEqual(suppressedChainBattle.behind.suppressed, true);
assert.strictEqual(suppressedChainBattle.behind.lapsToCatch, null);
assert.strictEqual(suppressedChainBattle.behind.catchInfo, '#2 remains in pit');
const unavailableConfirmedBattle = buildAdjacentClassBattles(numericOtherClassChain, history, 13, {
  confirmedGapView: { behind: { rivalCarNumber: '2', gapMs: null, lapGap: null, source: 'unavailable' } }
});
assert.strictEqual(unavailableConfirmedBattle.behind.relativeGap, null, 'volatile live gap is not reused while confirmed memory is incomplete');
assert.strictEqual(unavailableConfirmedBattle.behind.gapLabel, 'gap unknown');

const classRows = classSortedRows(sameClassRows, 'LMP3');
assert.deepStrictEqual(classSortedRows(null, 'LMP3'), []);
assert.strictEqual(classGapToPrevious(sameClassRows, classRows, sameClassRows[0]).ms, 0);
const reliableGap = classGapToPrevious(sameClassRows, classRows, sameClassRows[1]);
assert.strictEqual(reliableGap.reliable, true);
assert.strictEqual(reliableGap.ms, 12000);
assert.strictEqual(relativeClassGap(sameClassRows, classRows, sameClassRows[0], sameClassRows[2]), 15000);
assert.strictEqual(relativeClassGap(sameClassRows, classRows, sameClassRows[0], sameClassRows[0]), null);
assert.strictEqual(relativeClassGap(sameClassRows, classRows, sameClassRows[0], { carNumber: 999 }), null);
assert.strictEqual(recentAverageForCar(history, 2), 125000);
assert.strictEqual(recentAverageForCar([
  { carNumber: 2, lapNumber: 10, lapTimeMs: 125000, pitInfo: '0' },
  { carNumber: 2, lapNumber: 11, lapTimeMs: 180000, pitInfo: 'P1' },
  { carNumber: 2, lapNumber: 12, lapTimeMs: 150000, pitInfo: 'P1' },
  { carNumber: 2, lapNumber: 13, lapTimeMs: 126000, pitInfo: 'P1' },
  { carNumber: 2, lapNumber: 14, lapTimeMs: 200000, sessionFlag: 'Safety car', pitInfo: 'P1' }
], 2, 10), 125500, 'recent battle pace excludes pit, outlap and Safety Car laps');
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
assert.ok(chaserItem.battle.catchInfo.includes('they gain 1.000s/l'));
assert.ok(chaserItem.battle.catchInfo.includes('12.0 laps'));
assert.strictEqual(chaserItem.battle.trendLabel, '#2 catches us · they gain 1.000s/l');
assert.strictEqual(chaserItem.battle.predictionLabel, 'Expected in 12.0 laps · 25.2 min');

const followedBehindSummary = buildClassBattleSummary(sameClassRows, history, 2);
const leaderItem = followedBehindSummary.items.find((item) => String(item.row.carNumber) === '13');
assert.strictEqual(leaderItem.battle.relation, 'ahead');
assert.strictEqual(leaderItem.battle.lapsToCatch, 12);
assert.ok(leaderItem.battle.catchInfo.includes('we catch #13'));
assert.ok(leaderItem.battle.catchInfo.includes('we gain 1.000s/l'));

const slowerBehindSummary = buildClassBattleSummary(sameClassRows, [
  { carNumber: 13, lapNumber: 2, lastLapMs: 125000 },
  { carNumber: 2, lapNumber: 2, lastLapMs: 126000 }
], 2);
const slowerLeaderItem = slowerBehindSummary.items.find((item) => String(item.row.carNumber) === '13');
assert.strictEqual(slowerLeaderItem.battle.estimate, 'we are not catching');
assert.ok(slowerLeaderItem.battle.catchInfo.includes('we lose 1.000s/l'));
assert.strictEqual(slowerLeaderItem.battle.predictionLabel, 'No catch predicted at current pace');

const slowerTrailingCar = buildAdjacentClassBattles(sameClassRows, [
  { carNumber: 13, lapNumber: 2, lastLapMs: 125000 },
  { carNumber: 2, lapNumber: 2, lastLapMs: 126000 }
], 13).behind;
assert.strictEqual(slowerTrailingCar.estimate, 'they are not catching');
assert.ok(slowerTrailingCar.catchInfo.includes('they lose 1.000s/l'));

const missingSummary = buildClassBattleSummary(sameClassRows, history, 999);
assert.strictEqual(missingSummary.followed, null);
assert.deepStrictEqual(missingSummary.items, []);
assert.strictEqual(buildAdjacentClassBattles(sameClassRows, history, 999).available, false);

const intervalFallbackRows = [
  { position: 1, carNumber: 1, className: 'GT', classPosition: 1, lapNumber: 4, lastLap: '1:40.000' },
  { position: 2, carNumber: 2, className: 'GT', classPosition: 2, lapNumber: 4, lastLap: '1:40.000', diff: '', interval: '2.000' },
  { position: 3, carNumber: 3, className: 'GT', classPosition: 3, lapNumber: 4, lastLap: '1:40.000', diff: '', interval: '', gap: '3.000' }
];
assert.strictEqual(overallRelativeGap(intervalFallbackRows, intervalFallbackRows[0], intervalFallbackRows[2]), 5000);
assert.strictEqual(overallRelativeGap(intervalFallbackRows, intervalFallbackRows[0], intervalFallbackRows[0]), null);
assert.strictEqual(overallRelativeGap(intervalFallbackRows, intervalFallbackRows[0], { carNumber: 99 }), null);
assert.strictEqual(overallRelativeGap([
  intervalFallbackRows[0],
  { ...intervalFallbackRows[1], diff: '?', interval: '?', gap: '?' }
], intervalFallbackRows[0], intervalFallbackRows[1]), null);

const singleCarBattle = buildAdjacentClassBattles([intervalFallbackRows[0]], [], 1);
assert.strictEqual(singleCarBattle.available, true);
assert.strictEqual(singleCarBattle.ahead, null);
assert.strictEqual(singleCarBattle.behind, null);

const noPaceSummary = buildClassBattleSummary([
  { position: 1, carNumber: 1, className: 'GT', classPosition: 1, diff: '', lastLap: '--' },
  { position: 2, carNumber: 2, className: 'GT', classPosition: 2, diff: '2.000', lastLap: '--' }
], [], 1);
const noPaceItem = noPaceSummary.items.find((item) => item.battle)?.battle;
assert.strictEqual(noPaceItem.deltaPerLap, null);
assert.strictEqual(noPaceItem.trendState, 'neutral');

// Provider-independent lap-gap handling. RIS-style "5L" and a numeric interval
// that happens to be present at the same time must both defer to lap counters.
const lappedBattleRows = [
  { sourceProvider: 'ris-timing', position: 1, classPosition: 1, carNumber: 10, className: 'CC', lapNumber: 105, lastLap: '2:10.000', interval: '--' },
  { sourceProvider: 'ris-timing', position: 2, classPosition: 2, carNumber: 33, className: 'CC', lapNumber: 100, lastLap: '2:05.000', interval: '5L', diff: '0.500' },
  { sourceProvider: 'ris-timing', position: 3, classPosition: 3, carNumber: 65, className: 'CC', lapNumber: 95, lastLap: '2:00.000', interval: '5L' }
];
const lappedHistory = [
  { carNumber: 10, lapNumber: 104, lapTimeMs: 130000 },
  { carNumber: 33, lapNumber: 99, lapTimeMs: 125000 },
  { carNumber: 65, lapNumber: 94, lapTimeMs: 120000 }
];
const lappedBattles = buildAdjacentClassBattles(lappedBattleRows, lappedHistory, 33);
const lappedClassRows = classSortedRows(lappedBattleRows, 'CC');
assert.strictEqual(classGapToPrevious(lappedBattleRows, lappedClassRows, lappedBattleRows[1]).label, '5L');
assert.strictEqual(lappedBattles.ahead.relativeGap, null);
assert.strictEqual(lappedBattles.ahead.lapGap, 5);
assert.strictEqual(lappedBattles.ahead.gapLabel, '5L');
assert.strictEqual(lappedBattles.ahead.estimatedGapMs, 650000);
assert.strictEqual(lappedBattles.ahead.lapsToCatch, 130);
assert.ok(lappedBattles.ahead.catchInfo.includes('est. 130.0 laps'));
assert.strictEqual(lappedBattles.behind.gapLabel, '5L');
assert.strictEqual(lappedBattles.behind.estimatedGapMs, 625000);
assert.strictEqual(lappedBattles.behind.lapsToCatch, 125);
assert.ok(lappedBattles.behind.catchInfo.includes('est. 125.0 laps'));
assert.strictEqual(lapGapBetween(lappedBattleRows, lappedBattleRows[0], lappedBattleRows[1]), 5);

// Text fallback also supports GetRaceResults-style labels when lap counters are
// missing, but only for adjacent overall cars so an unrelated interval cannot
// contaminate the estimate.
const textLapGapRows = [
  { sourceProvider: 'getraceresults', position: 1, carNumber: 1, className: 'GT', classPosition: 1, lastLap: '--' },
  { sourceProvider: 'getraceresults', position: 2, carNumber: 2, className: 'GT', classPosition: 2, interval: '-- 3 laps --', lastLap: '--' },
  { sourceProvider: 'getraceresults', position: 3, carNumber: 3, className: 'OTHER', classPosition: 1, interval: '1L', lastLap: '--' }
];
const textLapSummary = buildAdjacentClassBattles(textLapGapRows, [], 1);
assert.strictEqual(textLapSummary.behind.gapLabel, '3L');
assert.strictEqual(textLapSummary.behind.estimatedGapMs, null);
assert.strictEqual(textLapSummary.behind.lapsToCatch, null);
assert.strictEqual(lapGapBetween(textLapGapRows, textLapGapRows[0], textLapGapRows[2]), null);

// RIS GAP-only timing: GAP is cumulative to the overall leader, including cars
// from other classes. The class gap is therefore the difference between the two
// cumulative values, not their sum and not the visual row interval.
const risCumulativeRows = [
  { sourceProvider: 'ris-timing', position: 1, carNumber: 1, className: 'PRO', classPosition: 1, lapNumber: 50, gap: '--', lastLap: '2:00.000' },
  { sourceProvider: 'ris-timing', position: 2, carNumber: 90, className: 'OTHER', classPosition: 1, lapNumber: 50, gap: '12.000', lastLap: '2:01.000' },
  { sourceProvider: 'ris-timing', position: 3, carNumber: 33, className: 'CC', classPosition: 1, lapNumber: 50, gap: '20.000', lastLap: '2:05.000' },
  { sourceProvider: 'ris-timing', position: 4, carNumber: 77, className: 'OTHER', classPosition: 2, lapNumber: 50, gap: '24.000', lastLap: '2:03.000' },
  { sourceProvider: 'ris-timing', position: 5, carNumber: 65, className: 'CC', classPosition: 2, lapNumber: 50, gap: '30.000', lastLap: '2:04.000' }
];
assert.strictEqual(usesCumulativeGap(risCumulativeRows), true);
assert.strictEqual(cumulativeGapToLeaderMs(risCumulativeRows, risCumulativeRows[4], 125000), 30000);
assert.strictEqual(overallRelativeGap(risCumulativeRows, risCumulativeRows[2], risCumulativeRows[4], 125000), 10000);
const risCumulativeBattle = buildAdjacentClassBattles(risCumulativeRows, [
  { carNumber: 33, lapNumber: 49, lapTimeMs: 125000 },
  { carNumber: 65, lapNumber: 49, lapTimeMs: 124000 }
], 33);
assert.strictEqual(risCumulativeBattle.behind.relativeGap, 10000);
assert.strictEqual(risCumulativeBattle.behind.lapsToCatch, 10);

// A lap-valued cumulative GAP remains usable as an explicit estimate. The
// leader row's lap counter is authoritative, so its display text is never
// mistaken for a 50-lap deficit.
const risLapGapRows = [
  { sourceProvider: 'ris-timing', position: 1, carNumber: 1, className: 'PRO', classPosition: 1, lapNumber: 50, gap: '50 laps', lastLap: '2:00.000' },
  { sourceProvider: 'ris-timing', position: 2, carNumber: 33, className: 'CC', classPosition: 1, lapNumber: 49, gap: '1L', lastLap: '2:05.000' },
  { sourceProvider: 'ris-timing', position: 3, carNumber: 65, className: 'CC', classPosition: 2, lapNumber: 47, gap: '3 laps', lastLap: '2:04.000' }
];
assert.strictEqual(cumulativeGapToLeaderMs(risLapGapRows, risLapGapRows[0], 125000), 0);
assert.strictEqual(overallRelativeGap(risLapGapRows, risLapGapRows[1], risLapGapRows[2], 125000), 250000);

console.log('Class battle tests passed.');
