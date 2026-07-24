const assert = require('assert');
const { lap } = require('./mockLapHistory');
const {
  standardDeviation,
  paceSlope,
  compliance,
  buildCoachingSummary,
  buildStintInsights,
  classComparisonsForStint,
  classRankingForStint
} = require('../src/shared/stintInsights');

const at = (seconds) => `2026-07-04T10:00:${String(seconds).padStart(2, '0')}.000Z`;
const ourLaps = [
  lap({ carNumber: 33, className: 'C.CHA', driverName: 'Our Driver', lapNumber: 1, lapTimeMs: 180000, sector1Ms: 50000, sector2Ms: 80000, sector3Ms: 50000, collectedAt: at(10) }),
  lap({ carNumber: 33, className: 'C.CHA', driverName: 'Our Driver', lapNumber: 2, lapTimeMs: 179000, sector1Ms: 49000, sector2Ms: 80000, sector3Ms: 50000, collectedAt: at(20) }),
  lap({ carNumber: 33, className: 'C.CHA', driverName: 'Our Driver', lapNumber: 3, lapTimeMs: 178000, sector1Ms: 49000, sector2Ms: 79000, sector3Ms: 50000, collectedAt: at(30) }),
  lap({ carNumber: 33, className: 'C.CHA', driverName: 'Our Driver', lapNumber: 4, lapTimeMs: 300000, sector1Ms: 90000, sector2Ms: 120000, sector3Ms: 90000, sessionFlag: 'FCY', collectedAt: at(40) })
];
const insights = buildStintInsights(ourLaps, { lapMs: 180000, sector1Ms: 0, sector2Ms: 79000, sector3Ms: 0 });
assert.ok(Math.abs(standardDeviation([180000, 179000, 178000]) - 816.496580927726) < 0.001);
assert.strictEqual(paceSlope([180000, 179000, 178000]), -1000);
assert.strictEqual(insights.paceTrendMsPerLap, -1000, 'neutralized lap stays out of pace trend');
assert.strictEqual(insights.bestTheoreticalLapMs, 178000);
assert.strictEqual(insights.averageTheoreticalLapMs, 178500);
assert.strictEqual(insights.personalBestProgression.length, 2);
assert.strictEqual(insights.compliance.lap.violationCount, 2);
assert.strictEqual(insights.compliance.sector1.label, 'OK - reference not set');
assert.strictEqual(insights.compliance.sector2.violationCount, 0);
assert.ok(insights.coachingSummary.some((line) => line.includes('Main time loss was S2')), 'coaching finds the largest sector spread');
assert.ok(insights.coachingSummary.some((line) => line.includes('Pace improved')), 'coaching describes pace trend direction');
assert.ok(insights.coachingSummary.some((line) => line.includes('Best phase')), 'coaching points to the strongest stint phase');
assert.deepStrictEqual(buildCoachingSummary([], [], {}), ['No valid pace laps available for coaching yet.']);
assert.strictEqual(compliance([1, 2], 0).known, false);

const history = [
  ...ourLaps,
  lap({ carNumber: 2, className: 'C.CHA', teamName: 'BIC', driverName: 'Rival', lapNumber: 1, lapTimeMs: 177000, collectedAt: at(5) }),
  lap({ carNumber: 2, className: 'C.CHA', teamName: 'BIC', driverName: 'Rival', lapNumber: 2, lapTimeMs: 178000, collectedAt: at(15) }),
  lap({ carNumber: 2, className: 'C.CHA', teamName: 'BIC', driverName: 'Rival', lapNumber: 3, lapTimeMs: 179000, collectedAt: at(25) }),
  lap({ carNumber: 9, className: 'OTHER', teamName: 'Other', driverName: 'Other', lapNumber: 1, lapTimeMs: 160000, collectedAt: at(20) })
];
const comparisons = classComparisonsForStint(history, ourLaps.slice(0, 3), '33', 'C.CHA');
assert.strictEqual(comparisons.length, 1);
assert.strictEqual(comparisons[0].carNumber, '2');
assert.strictEqual(comparisons[0].lapCount, 2, 'only rival laps completed inside the analyzed stint window are compared');
assert.strictEqual(comparisons[0].averageLapMs, 178500);
assert.strictEqual(comparisons[0].averageDeltaMs, 0);
const ranking = classRankingForStint(ourLaps.slice(0, 3), comparisons);
assert.deepStrictEqual(ranking.average, { rank: 1, total: 2, leaderCarNumber: 'our car', deltaToLeaderMs: 0 });
assert.deepStrictEqual(ranking.best, { rank: 1, total: 2, leaderCarNumber: 'our car', deltaToLeaderMs: 0 });

console.log('Stint insight tests passed.');
