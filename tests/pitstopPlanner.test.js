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
  latestSafePitElapsedMsForRemainingStops,
  isFcySession,
  nextFcyGapState,
  pitLossForSession
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

// FCY pit loss subtracts the time a non-pitting car needs to cover the regular
// track between pit entry and pit exit. A missing distance produces no guess.
assert.strictEqual(isFcySession({ flag: 'Full Course Yellow' }), true);
assert.strictEqual(isFcySession({ flag: 'GREEN FLAG' }), false);
const missingFcyDistance = pitLossForSession({
  session: { flag: 'FCY' },
  rules: { pitStopDurationMs: 75000, circuitId: 'zolder', regularTrackDistanceMeters: null }
});
assert.strictEqual(missingFcyDistance.status, 'missing-distance');
assert.strictEqual(missingFcyDistance.pitLossMs, null);

const configuredFcyLoss = pitLossForSession({
  session: { flag: 'FCY' },
  fcyGapState: { ready: true },
  rules: { pitStopDurationMs: 75000, regularTrackDistanceMeters: 600, fcySpeedKph: 60 }
});
assert.strictEqual(configuredFcyLoss.regularTrackTravelMs, 36000);
assert.strictEqual(configuredFcyLoss.pitLossMs, 39000);
assert.strictEqual(configuredFcyLoss.reliable, true);
assert.strictEqual(pitLossForSession({ session: { flag: 'Green' }, rules: { pitStopDurationMs: 75000 } }).pitLossMs, 75000);

// Invalid FCY speeds fall back to 60 km/h instead of dividing by zero or
// producing Infinity. Numeric settings strings remain supported.
for (const invalidSpeed of [0, -20, 'not-a-speed', Infinity]) {
  const safeSpeedResult = pitLossForSession({
    session: { flag: 'Full Course Yellow' },
    fcyGapState: { ready: true },
    rules: { pitStopDurationMs: '75000', regularTrackDistanceMeters: '600', fcySpeedKph: invalidSpeed }
  });
  assert.strictEqual(safeSpeedResult.fcySpeedKph, 60);
  assert.strictEqual(safeSpeedResult.regularTrackTravelMs, 36000);
  assert.strictEqual(safeSpeedResult.pitLossMs, 39000);
}

// If both routes take exactly 75 seconds there is no relative loss. A longer
// regular route creates a negative loss (a relative FCY pit advantage), which
// must remain signed rather than being silently clamped to zero.
assert.strictEqual(pitLossForSession({
  session: { flag: 'FCY' },
  fcyGapState: { ready: true },
  rules: { pitStopDurationMs: 75000, regularTrackDistanceMeters: 1250, fcySpeedKph: 60 }
}).pitLossMs, 0);
assert.strictEqual(pitLossForSession({
  session: { flag: 'FCY' },
  fcyGapState: { ready: true },
  rules: { pitStopDurationMs: 75000, regularTrackDistanceMeters: 1500, fcySpeedKph: 60 }
}).pitLossMs, -15000);

for (const invalidDistance of [0, -1, 'bad', Infinity, undefined]) {
  const result = pitLossForSession({
    session: { flag: 'FCY' },
    rules: { pitStopDurationMs: 75000, circuitId: 'test-layout', regularTrackDistanceMeters: invalidDistance }
  });
  assert.strictEqual(result.status, 'missing-distance');
  assert.strictEqual(result.pitLossMs, null);
}

// Repeated polls do not become reliable until both a fresh timing passage and
// stable post-FCY gaps have been observed.
const stabilizationRules = { fcyStablePollsRequired: 2, fcyMinimumAgeMs: 10000 };
const preFcy = nextFcyGapState({
  rows: classRows,
  session: { flag: 'Green' },
  collectedAt: '2026-06-26T10:00:00.000Z',
  rules: stabilizationRules
});
const fcyStarted = nextFcyGapState({
  previous: preFcy,
  rows: classRows,
  session: { flag: 'FCY' },
  collectedAt: '2026-06-26T10:00:05.000Z',
  rules: stabilizationRules
});
assert.strictEqual(fcyStarted.ready, false);
assert.strictEqual(fcyStarted.freshTimingObserved, false);
const refreshedRows = classRows.map((row) => ({ ...row, lapNumber: row.lapNumber + 1, interval: row.carNumber === 56 ? '19.000' : row.interval }));
const fcyFresh = nextFcyGapState({ previous: fcyStarted, rows: refreshedRows, session: { flag: 'FCY' }, collectedAt: '2026-06-26T10:00:10.000Z', rules: stabilizationRules });
const fcyStableOnce = nextFcyGapState({ previous: fcyFresh, rows: refreshedRows, session: { flag: 'FCY' }, collectedAt: '2026-06-26T10:00:15.000Z', rules: stabilizationRules });
const fcyReady = nextFcyGapState({ previous: fcyStableOnce, rows: refreshedRows, session: { flag: 'FCY' }, collectedAt: '2026-06-26T10:00:20.000Z', rules: stabilizationRules });
assert.strictEqual(fcyFresh.freshTimingObserved, true);
assert.strictEqual(fcyStableOnce.ready, false);
assert.strictEqual(fcyReady.ready, true);

// A changed interval resets stability, and empty timing tables can never become
// stable merely because the same empty page was polled repeatedly.
const changedGapAgain = nextFcyGapState({
  previous: fcyStableOnce,
  rows: refreshedRows.map((row) => ({ ...row, interval: row.carNumber === 56 ? '18.500' : row.interval })),
  session: { flag: 'FCY' },
  collectedAt: '2026-06-26T10:00:20.000Z',
  rules: stabilizationRules
});
assert.strictEqual(changedGapAgain.stablePolls, 0);
assert.strictEqual(changedGapAgain.ready, false);
const emptyFcyStart = nextFcyGapState({ rows: [], session: { flag: 'FCY' }, collectedAt: '2026-06-26T10:00:00.000Z', rules: { fcyStablePollsRequired: 1, fcyMinimumAgeMs: 0 } });
const emptyFcyAgain = nextFcyGapState({ previous: emptyFcyStart, rows: [], session: { flag: 'FCY' }, collectedAt: '2026-06-26T10:00:05.000Z', rules: { fcyStablePollsRequired: 1, fcyMinimumAgeMs: 0 } });
assert.strictEqual(emptyFcyAgain.ready, false);

const provisionalFcyPlan = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:20:00', flag: 'FCY' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  fcyGapState: fcyFresh,
  rules: { ...rules, regularTrackDistanceMeters: 600, fcySpeedKph: 60 }
});
assert.strictEqual(provisionalFcyPlan.pitLoss.pitLossMs, 39000);
assert.strictEqual(provisionalFcyPlan.pitLoss.status, 'stabilizing');
assert.strictEqual(provisionalFcyPlan.projection.provisional, true);

const missingDistancePlan = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:20:00', flag: 'FCY' },
  followedCarNumber: '33',
  rules: { ...rules, circuitId: 'assen', regularTrackDistanceMeters: null }
});
assert.strictEqual(missingDistancePlan.projection.available, false);
assert.ok(missingDistancePlan.projection.reason.includes('assen'));

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
assert.deepStrictEqual(validPitIncrease.validPitElapsedHistoryMs, [40 * 60 * 1000]);

const secondValidPitIncrease = nextPitStateFromRow({
  previous: validPitIncrease,
  row: { pit: 'P3' },
  session: { timeToGo: '0:50:00' },
  rules,
  collectedAt: '2026-06-26T08:35:00.000Z'
});
assert.deepStrictEqual(secondValidPitIncrease.validPitElapsedHistoryMs, [40 * 60 * 1000, 70 * 60 * 1000], 'older cooldown periods remain stored');

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
assert.deepStrictEqual(invalidPitIncrease.validPitElapsedHistoryMs, []);

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
  { position: 1, classPosition: 1, carNumber: 33, className: 'CC', interval: '--' },
  { position: 2, classPosition: 2, carNumber: 8, className: 'CC', interval: '1.000' },
  { position: 3, classPosition: 2, carNumber: 7, className: 'CC', interval: '1.000' }
], '33', 500);
assert.strictEqual(positionFallbackProjection.available, true);
assert.strictEqual(positionFallbackProjection.items[1].carNumber, '8');
assert.strictEqual(positionFallbackProjection.items[2].carNumber, '7');

// Mixed-class traffic must be included in the physical after-pit loss. #65 is
// not adjacent to #18 in class order because a GT car sits between them, but the
// overall DIFF chain still tells us how much time we lose before reaching #65.
const mixedClassInterloperProjection = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 33, className: 'CC', interval: '--', lapNumber: 20, lastLapMs: 125000 },
  { position: 2, classPosition: 2, carNumber: 18, className: 'CC', interval: '10.000', lapNumber: 20, lastLapMs: 125000 },
  { position: 3, classPosition: 1, carNumber: 90, className: 'GT', interval: '0.250', lapNumber: 20, lastLapMs: 126000 },
  { position: 4, classPosition: 3, carNumber: 65, className: 'CC', interval: '0.319', lapNumber: 20, lastLapMs: 125000 },
  { position: 5, classPosition: 4, carNumber: 91, className: 'CC', interval: '20', lapNumber: 20, lastLapMs: 126000 },
], '33', 15000, { averageLapMs: 125000 });
assert.strictEqual(mixedClassInterloperProjection.available, true);
assert.strictEqual(mixedClassInterloperProjection.projectedClassPosition, 3);
assert.strictEqual(mixedClassInterloperProjection.carAhead.carNumber, '65');
assert.strictEqual(mixedClassInterloperProjection.carBehind.carNumber, '91');

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

const fallbackLapAwareProjection = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 10, className: 'CC', interval: '--', lapNumber: 20, lastLapMs: 125000 },
  { position: 2, classPosition: 2, carNumber: 33, className: 'CC', interval: '5.000', lapNumber: 20, lastLapMs: 125000 }
], '33', 500, { averageLapMs: 125000 });
assert.strictEqual(fallbackLapAwareProjection.available, true);
assert.strictEqual(fallbackLapAwareProjection.projectedClassPosition, 2);
assert.strictEqual(fallbackLapAwareProjection.carAhead.carNumber, '10');

const fallbackUnscoredOurCarProjection = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 10, className: 'CC', interval: '--', lapNumber: 20, lastLapMs: 125000 },
  { position: 2, classPosition: 2, carNumber: 33, className: 'CC', interval: '1L', lapNumber: 20, lastLapMs: 125000 }
], '33', 500, { averageLapMs: 125000 });
assert.strictEqual(fallbackUnscoredOurCarProjection.available, false);
assert.strictEqual(fallbackUnscoredOurCarProjection.reason, 'Our projected race distance is not reliable yet');

// Physical rejoin projection follows the numeric DIFF/INT chain. Even if a car
// is laps down in the race classification, a tiny numeric interval means it is
// physically close enough to pass us during a pitstop.
const lappedCarProjection = projectClassAfterPit([
  { position: 1, classPosition: 1, carNumber: 10, className: 'CC', team: 'Leader', lapNumber: 20, interval: '--', lastLapMs: 125000 },
  { position: 2, classPosition: 2, carNumber: 33, className: 'CC', team: 'Us', lapNumber: 20, interval: '10.000', lastLapMs: 125000 },
  { position: 5, classPosition: 5, carNumber: 65, className: 'CC', team: 'Lapped', lapNumber: 16, interval: '0.319', lastLapMs: 126000 }
], '33', 75000, { averageLapMs: 125000 });
assert.strictEqual(lappedCarProjection.available, true);
assert.strictEqual(lappedCarProjection.projectedClassPosition, 3);
assert.strictEqual(lappedCarProjection.carAhead.carNumber, '65');
assert.strictEqual(lappedCarProjection.carAhead.lapDeltaToUs, -4);
assert.strictEqual(lappedCarProjection.carAhead.projectedGapToUsMs, -74681);
assert.strictEqual(lappedCarProjection.carBehind, null);

// Regression for an Asian LMS-style table: a lapped other-class car can sit
// visually between us and the next same-class car. Its "-- 65 laps --" GAP must
// not be converted into seconds; the numeric DIFF/INT chain is used instead.
const lappedInterloperProjection = projectClassAfterPit([
  { position: 8, classPosition: 1, carNumber: 13, className: 'LMP3', team: 'Us', lapNumber: 100, gap: '1:05.031', diff: '1:05.031', interval: '1:05.031', lastLapMs: 125000 },
  { position: 9, classPosition: 2, carNumber: 59, className: 'LMP2 AM', team: 'Other class lapped', lapNumber: 35, gap: '-- 65 laps --', diff: '1:55.519', interval: '1:55.519', lastLapMs: 119621 },
  { position: 10, classPosition: 2, carNumber: 12, className: 'LMP3', team: 'Next LMP3', lapNumber: 100, gap: '0.171', diff: '0.171', interval: '0.171', lastLapMs: 126413 },
  { position: 11, classPosition: 3, carNumber: 2, className: 'LMP3', team: 'Third LMP3', lapNumber: 100, gap: '1.857', diff: '1.686', interval: '1.686', lastLapMs: 124245 },
  { position: 12, classPosition: 4, carNumber: 9, className: 'LMP3', team: 'Fourth LMP3', lapNumber: 100, gap: '30.512', diff: '28.655', interval: '28.655', lastLapMs: 128208 },
  { position: 16, classPosition: 5, carNumber: 65, className: 'LMP3', team: 'Fifth LMP3', lapNumber: 100, gap: '1:08.573', diff: '52.642', interval: '52.642', lastLapMs: 133001 },
  { position: 22, classPosition: 6, carNumber: 3, className: 'LMP3', team: 'Lapped LMP3', lapNumber: 38, gap: '-- 62 laps --', diff: '57.342', interval: '57.342', lastLapMs: 127053 }
], '13', 75000, { averageLapMs: 125000 });
assert.strictEqual(lappedInterloperProjection.available, true);
assert.strictEqual(lappedInterloperProjection.projectedClassPosition, 1);
assert.strictEqual(lappedInterloperProjection.carAhead, null);
assert.strictEqual(lappedInterloperProjection.carBehind.carNumber, '12');
assert.strictEqual(lappedInterloperProjection.carBehind.projectedGapToUsMs, 40690);

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
