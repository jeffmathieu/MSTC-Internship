const assert = require('assert');
const {
  normalizeRules,
  parseTimeToMs,
  formatDuration,
  pitCountFromRow,
  nextPitStateFromRow,
  estimateAverageLapMs,
  raceClockFromSession,
  buildPitstopPlan,
  projectClassAfterPit,
  timeUntilNextAllowedPit,
  latestSafePitElapsedMsForRemainingStops
} = require('../src/shared/pitstopPlanner');

const rules = normalizeRules({
  raceDurationMs: 2 * 60 * 60 * 1000,
  pitClosedStartMs: 25 * 60 * 1000,
  pitClosedEndMs: 25 * 60 * 1000,
  pitCooldownMs: 25 * 60 * 1000,
  pitStopDurationMs: 75 * 1000,
  requiredPitStops: 2,
  nearWindowLaps: 2,
  averageLapMs: 125 * 1000
});

const classRows = [
  { position: 1, classPosition: 1, carNumber: 10, className: 'CC', team: 'Leader', lapNumber: 20, interval: '--' },
  { position: 2, classPosition: 2, carNumber: 33, className: 'CC', team: 'Us', lapNumber: 20, interval: '10.000' },
  { position: 3, classPosition: 3, carNumber: 56, className: 'CC', team: 'Chaser', lapNumber: 20, interval: '20.000' }
];

// Parsing and formatting helpers: these protect the input/output contract used
// by both the UI and the planner.
assert.strictEqual(parseTimeToMs('1:35:00'), 5700000);
assert.strictEqual(parseTimeToMs('55:54 / 1'), 3354000);
assert.strictEqual(parseTimeToMs('90'), 90000);
assert.strictEqual(parseTimeToMs('1:30'), 90000);
assert.strictEqual(parseTimeToMs('1:02:03:04'), null);
assert.strictEqual(parseTimeToMs('bad data'), null);
assert.strictEqual(formatDuration(3661000), '1:01:01');
assert.strictEqual(formatDuration(-61000), '-1:01');
assert.strictEqual(formatDuration(NaN), '—');
assert.strictEqual(pitCountFromRow({ pit: 'P2' }), 2);
assert.strictEqual(pitCountFromRow({ pitInfo: 'stops 3' }), 3);
assert.strictEqual(pitCountFromRow({ pit: '--' }), 0);
assert.strictEqual(estimateAverageLapMs([{ lastLap: '2:06.000' }, { lastLapMs: 124000 }, { lastLap: '2:05.000' }]), 125000);
assert.strictEqual(estimateAverageLapMs([{ lastLap: '--' }, { lastLapMs: 0 }]), null);

// Existing pit count on the first app sample is accepted as baseline because
// the app cannot know when that stop happened before it started.
const baselinePitState = nextPitStateFromRow({
  previous: {},
  row: { pit: 'P1' },
  session: { timeToGo: '1:20:00' },
  rules,
  collectedAt: '2026-06-26T08:00:00.000Z'
});
assert.strictEqual(baselinePitState.completedPitStops, 1);
assert.strictEqual(baselinePitState.validCompletedPitStops, 1);

// A later PIT-counter increase inside the green window counts toward required
// pitstops.
const validPitIncrease = nextPitStateFromRow({
  previous: baselinePitState,
  row: { pit: 'P2' },
  session: { timeToGo: '1:20:00' },
  rules,
  collectedAt: '2026-06-26T08:05:00.000Z'
});
assert.strictEqual(validPitIncrease.completedPitStops, 2);
assert.strictEqual(validPitIncrease.validCompletedPitStops, 2);
assert.strictEqual(validPitIncrease.lastPitCountedAsValid, true);

// A later PIT-counter increase during a red/closed window is stored as a real
// pitstop but does not count toward the mandatory valid-stop total.
const invalidPitIncrease = nextPitStateFromRow({
  previous: { completedPitStops: 0, validCompletedPitStops: 0, rawPitCount: 0 },
  row: { pit: 'P1' },
  session: { timeToGo: '1:40:00' },
  rules,
  collectedAt: '2026-06-26T08:10:00.000Z'
});
assert.strictEqual(invalidPitIncrease.completedPitStops, 1);
assert.strictEqual(invalidPitIncrease.validCompletedPitStops, 0);
assert.strictEqual(invalidPitIncrease.lastPitCountedAsValid, false);

// Race clock parsing drives all open/closed window rules.
const clock = raceClockFromSession({ timeToGo: '1:30:00' }, rules);
assert.strictEqual(clock.elapsedMs, 30 * 60 * 1000);
assert.strictEqual(clock.remainingMs, 90 * 60 * 1000);

const unknownClock = raceClockFromSession({ timeToGo: '—' }, rules);
assert.strictEqual(unknownClock.elapsedMs, null);
assert.strictEqual(unknownClock.progress, 0);
assert.deepStrictEqual(
  timeUntilNextAllowedPit({ clock: unknownClock, rules }),
  { allowed: false, reason: 'Waiting for race clock', waitMs: null }
);
assert.strictEqual(latestSafePitElapsedMsForRemainingStops({ clock: unknownClock, rules, pitState: {} }), null);

const sanitizedRules = normalizeRules({ raceDurationMs: -1, requiredPitStops: -5, nearWindowLaps: 'bad' });
assert.strictEqual(sanitizedRules.raceDurationMs, 24 * 60 * 60 * 1000);
assert.strictEqual(sanitizedRules.requiredPitStops, 2);
assert.strictEqual(sanitizedRules.nearWindowLaps, 2);

// First 25 minutes are closed.
const startClosed = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:40:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  rules
});
assert.strictEqual(startClosed.status, 'closed');
assert.strictEqual(startClosed.canPitNow, false);
assert.strictEqual(startClosed.waitMs, 5 * 60 * 1000);

// The dashboard should warn when the window opens within the configured
// near-window lap count.
const nearlyOpen = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:37:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  rules
});
assert.strictEqual(nearlyOpen.status, 'soon');
assert.strictEqual(nearlyOpen.isNearlyOpen, true);

// Normal green/open window.
const open = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:20:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  rules
});
assert.strictEqual(open.status, 'open');
assert.strictEqual(open.canPitNow, true);
assert.strictEqual(open.remainingRequiredStops, 2);

// Required stops use valid stops, not raw total pit entries.
const onlyValidStopsCountForRequirement = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:20:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 2, validCompletedPitStops: 1 },
  rules
});
assert.strictEqual(onlyValidStopsCountForRequirement.totalPitStops, 2);
assert.strictEqual(onlyValidStopsCountForRequirement.completedPitStops, 1);
assert.strictEqual(onlyValidStopsCountForRequirement.remainingRequiredStops, 1);

// A valid previous pitstop closes the next 25 minutes.
const cooldown = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:10:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 1, lastPitElapsedMs: 40 * 60 * 1000 },
  rules
});
assert.strictEqual(cooldown.status, 'closed');
assert.strictEqual(cooldown.waitMs, 15 * 60 * 1000);

// Last 25 minutes are closed.
const finishClosed = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '0:20:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 2 },
  rules
});
assert.strictEqual(finishClosed.status, 'closed');
assert.strictEqual(finishClosed.canPitNow, false);

// Strategy can become urgent before the final red zone if there is no longer
// enough time to complete all required stops with cooldown spacing.
const urgent = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '0:50:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  rules
});
assert.strictEqual(urgent.status, 'urgent');
assert.strictEqual(urgent.canPitNow, true);

// Basic after-pit projection with all cars on the same lap.
const projection = projectClassAfterPit(classRows, '33', 75000);
assert.strictEqual(projection.available, true);
assert.strictEqual(projection.projectedClassPosition, 3);
assert.strictEqual(projection.carAhead.carNumber, '56');
assert.strictEqual(projection.carAhead.projectedGapToUsMs, -55000);
assert.strictEqual(projectClassAfterPit(classRows, '999', 75000).available, false);
assert.deepStrictEqual(projectClassAfterPit([{ carNumber: 33, className: '', lapNumber: 1 }], '33', 1000), {
  available: false,
  reason: 'No class data yet',
  items: []
});

// When class positions tie, overall position is used as stable fallback order.
const positionFallbackProjection = projectClassAfterPit([
  { position: 3, classPosition: 1, carNumber: 33, className: 'CC', interval: '--' },
  { position: 2, classPosition: 2, carNumber: 7, className: 'CC', interval: '1.000' },
  { position: 1, classPosition: 2, carNumber: 8, className: 'CC', interval: '1.000' }
], '33', 500);
assert.strictEqual(positionFallbackProjection.available, true);
assert.strictEqual(positionFallbackProjection.items[1].carNumber, '8');
assert.strictEqual(positionFallbackProjection.items[2].carNumber, '7');

// Invalid pit loss should not produce a projection.
const impossibleProjection = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 33, className: 'CC', interval: '--' },
  { position: 2, classPosition: 2, carNumber: 7, className: 'CC', interval: '1.000' }
], '33', NaN);
assert.strictEqual(impossibleProjection.available, false);
assert.strictEqual(impossibleProjection.reason, 'Our projected race distance is not reliable yet');

// Other cars with unusable score data are filtered out rather than shown with a
// fake gap.
const filteredUnscoredCarProjection = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 33, className: 'CC', interval: '--' },
  { position: 2, classPosition: 2, carNumber: 7, className: 'CC', interval: '1L' }
], '33', 500);
assert.strictEqual(filteredUnscoredCarProjection.available, true);
assert.strictEqual(filteredUnscoredCarProjection.items.length, 1);
assert.strictEqual(filteredUnscoredCarProjection.items[0].carNumber, '33');

// Regression test for the important lapped-car bug: 75 seconds of pit loss must
// not place us behind a car that is four completed laps down.
const lappedCarProjection = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 10, className: 'CC', team: 'Leader', lapNumber: 20, interval: '--', lastLapMs: 125000 },
  { position: 2, classPosition: 2, carNumber: 33, className: 'CC', team: 'Us', lapNumber: 20, interval: '10.000', lastLapMs: 125000 },
  { position: 5, classPosition: 5, carNumber: 65, className: 'CC', team: 'Lapped', lapNumber: 16, interval: '0.319', lastLapMs: 126000 }
], '33', 75000, { averageLapMs: 125000 });
assert.strictEqual(lappedCarProjection.available, true);
assert.strictEqual(lappedCarProjection.projectedClassPosition, 2);
assert.strictEqual(lappedCarProjection.carBehind.carNumber, '65');
assert.strictEqual(lappedCarProjection.carBehind.lapDeltaToUs, -4);
assert.ok(lappedCarProjection.carBehind.projectedGapToUsMs > 3 * 120000);

// Tight same-lap scenario: after losing 5.050s we should stay only 50ms ahead
// of car #18. This protects millisecond-level after-pit gap math.
const CarProjectionExtra = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 33, className: 'CC', team: 'Leader', lapNumber: 20, interval: '--', lastLapMs: 125000 },
  { position: 2, classPosition: 2, carNumber: 10, className: 'CC', team: 'Us', lapNumber: 20, interval: '4.500', lastLapMs: 125000 },
  { position: 3, classPosition: 3, carNumber: 65, className: 'CC', team: '', lapNumber: 20, interval: '0.500', lastLapMs: 126000 },
  { position: 4, classPosition: 4, carNumber: 18, className: 'CC', team: '', lapNumber: 20, interval: '0.100', lastLapMs: 125000 },
  { position: 5, classPosition: 5, carNumber: 27, className: 'CC', team: '', lapNumber: 20, interval: '6.250', lastLapMs: 125000 },
], '33', 5050, { averageLapMs: 125000 });

const myPlan = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:20:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  rules
});
assert.strictEqual(myPlan.status, 'open');
assert.strictEqual(myPlan.canPitNow, true);
assert.strictEqual(CarProjectionExtra.available, true);
assert.strictEqual(CarProjectionExtra.projectedClassPosition, 3);
assert.strictEqual(CarProjectionExtra.carBehind.carNumber, '18');
assert.strictEqual(CarProjectionExtra.carBehind.projectedGapToUsMs, 50);

const unreliableProjection = projectClassAfterPit([
  classRows[0],
  { ...classRows[1], interval: '1L' }
], '33', 75000);
assert.strictEqual(unreliableProjection.available, false);

console.log('Pitstop planner tests passed.');
