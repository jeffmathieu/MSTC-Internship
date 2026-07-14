const assert = require('assert');
const {
  normalizeRules,
  strategySafetyBuffer,
  latestPossiblePitElapsedMsForRemainingStops,
  latestSafePitElapsedMsForRemainingStops,
  buildRequiredStopSchedule,
  buildPitstopPlan
} = require('../src/shared/pitstopPlanner');

const minute = 60 * 1000;
const raceDurationMs = 4 * 60 * minute;
const rules = normalizeRules({
  raceDurationMs,
  pitClosedStartMs: 25 * minute,
  pitClosedEndMs: 25 * minute,
  pitCooldownMs: 25 * minute,
  pitStopDurationMs: 75 * 1000,
  requiredPitStops: 3,
  averageLapMs: 125 * 1000,
  safetyBufferLaps: 2,
  fixedSafetyBufferMs: 30 * 1000,
  nearWindowLaps: 2
});

const clockAt = (elapsedMs) => ({
  raceDurationMs,
  elapsedMs,
  remainingMs: raceDurationMs - elapsedMs,
  progress: elapsedMs / raceDurationMs
});

// Two lap margins plus fixed operational delays create the real safety buffer.
const buffer = strategySafetyBuffer({ rules, averageLapMs: 125 * 1000 });
assert.deepStrictEqual(buffer, {
  lapBufferMs: 250000,
  fixedSafetyBufferMs: 30000,
  totalMs: 280000,
  averageLapMs: 125000,
  laps: 2
});

// With two stops remaining, the next stop must happen by 3:10 theoretically:
// 4:00 race - 0:25 final closure - 0:25 spacing for the final stop.
const oneStopCompleted = { completedPitStops: 1, validCompletedPitStops: 1, lastPitElapsedMs: 40 * minute };
assert.strictEqual(latestPossiblePitElapsedMsForRemainingStops({ clock: clockAt(60 * minute), rules, pitState: oneStopCompleted }), 190 * minute);
assert.strictEqual(latestSafePitElapsedMsForRemainingStops({ clock: clockAt(60 * minute), rules, pitState: oneStopCompleted, averageLapMs: 125000 }), (190 * minute) - 280000);

const schedule = buildRequiredStopSchedule({ clock: clockAt(60 * minute), rules, pitState: oneStopCompleted, averageLapMs: 125000 });
assert.strictEqual(schedule.feasible, true);
assert.strictEqual(schedule.safeFeasible, true);
assert.strictEqual(schedule.next.earliestEntryElapsedMs, 65 * minute);
assert.strictEqual(schedule.stops[0].latestPossibleEntryElapsedMs, 190 * minute);
assert.strictEqual(schedule.stops[1].latestPossibleEntryElapsedMs, 215 * minute);
assert.strictEqual(schedule.stops[0].latestSafeEntryElapsedMs, (190 * minute) - 280000);

const rows = [
  { position: 1, classPosition: 1, carNumber: 33, className: 'CC', lapNumber: 50, interval: '--', lastLapMs: 125000 },
  { position: 2, classPosition: 2, carNumber: 56, className: 'CC', lapNumber: 50, interval: '40.000', lastLapMs: 126000 }
];
const sessionAt = (elapsedMinutes, flag = 'GREEN') => ({
  timeToGo: `${Math.floor((240 - elapsedMinutes) / 60)}:${String((240 - elapsedMinutes) % 60).padStart(2, '0')}:00`,
  flag
});

const normalPlan = buildPitstopPlan({
  rows,
  session: sessionAt(70),
  followedCarNumber: '33',
  pitState: oneStopCompleted,
  rules
});
assert.strictEqual(normalPlan.recommendation.action, 'PLAN PIT');
assert.strictEqual(normalPlan.latestPossiblePitElapsedMs, 190 * minute);
assert.strictEqual(normalPlan.latestSafePitElapsedMs, (190 * minute) - 280000);
assert.strictEqual(normalPlan.canPitNow, true);

// FCY pit loss is still calculated, but the dashboard no longer makes a
// threshold-based strategy recommendation.
const fcyPlan = buildPitstopPlan({
  rows,
  session: sessionAt(70, 'FCY'),
  followedCarNumber: '33',
  pitState: oneStopCompleted,
  fcyGapState: { ready: true },
  rules: { ...rules, regularTrackDistanceMeters: 600, fcySpeedKph: 60 }
});
assert.strictEqual(fcyPlan.pitLoss.pitLossMs, 39000);
assert.strictEqual(fcyPlan.recommendation.fcySavingsMs, 36000);
assert.strictEqual(fcyPlan.recommendation.action, 'PLAN PIT');
assert.strictEqual(fcyPlan.recommendation.level, 'normal');

const stabilizingFcy = buildPitstopPlan({
  rows,
  session: sessionAt(70, 'FCY'),
  followedCarNumber: '33',
  pitState: oneStopCompleted,
  fcyGapState: { ready: false },
  rules: { ...rules, regularTrackDistanceMeters: 600, fcySpeedKph: 60 }
});
assert.strictEqual(stabilizingFcy.recommendation.action, 'PLAN PIT');
assert.strictEqual(stabilizingFcy.recommendation.level, 'normal');

const moderateFcy = buildPitstopPlan({
  rows,
  session: sessionAt(70, 'FCY'),
  followedCarNumber: '33',
  pitState: oneStopCompleted,
  fcyGapState: { ready: true },
  rules: { ...rules, regularTrackDistanceMeters: 167, fcySpeedKph: 60 }
});
assert.strictEqual(moderateFcy.recommendation.action, 'PLAN PIT');
assert.strictEqual(moderateFcy.recommendation.level, 'normal');

const weakFcy = buildPitstopPlan({
  rows,
  session: sessionAt(70, 'FCY'),
  followedCarNumber: '33',
  pitState: oneStopCompleted,
  fcyGapState: { ready: true },
  rules: { ...rules, regularTrackDistanceMeters: 50, fcySpeedKph: 60 }
});
assert.strictEqual(weakFcy.recommendation.action, 'PLAN PIT');

// Closed windows are never overridden by strategy urgency or an FCY.
const closedFcy = buildPitstopPlan({
  rows,
  session: sessionAt(10, 'FCY'),
  followedCarNumber: '33',
  pitState: { completedPitStops: 0, validCompletedPitStops: 0 },
  fcyGapState: { ready: true },
  rules: { ...rules, regularTrackDistanceMeters: 600, fcySpeedKph: 60 }
});
assert.strictEqual(closedFcy.canPitNow, false);
assert.strictEqual(closedFcy.recommendation.action, 'STAY OUT');

const openingSoon = buildPitstopPlan({
  rows,
  session: sessionAt(23),
  followedCarNumber: '33',
  pitState: { completedPitStops: 0, validCompletedPitStops: 0 },
  rules
});
assert.strictEqual(openingSoon.canPitNow, false);
assert.strictEqual(openingSoon.recommendation.action, 'PREPARE PIT');
assert.strictEqual(openingSoon.recommendation.targetElapsedMs, 25 * minute);

// As the safe deadline approaches the recommendation escalates, and once the
// theoretical deadline has passed the plan explicitly reports no legal plan.
const soonPlan = buildPitstopPlan({
  rows,
  session: sessionAt(183),
  followedCarNumber: '33',
  pitState: oneStopCompleted,
  rules
});
assert.strictEqual(soonPlan.recommendation.action, 'MUST PIT SOON');
assert.strictEqual(soonPlan.status, 'urgent');

const cooldownNearDeadline = buildPitstopPlan({
  rows,
  session: sessionAt(183),
  followedCarNumber: '33',
  pitState: { ...oneStopCompleted, lastPitElapsedMs: 160 * minute },
  rules
});
assert.strictEqual(cooldownNearDeadline.canPitNow, false);
assert.strictEqual(cooldownNearDeadline.recommendation.action, 'PIT WHEN OPEN');
assert.strictEqual(cooldownNearDeadline.recommendation.level, 'warning');

const impossiblePlan = buildPitstopPlan({
  rows,
  session: sessionAt(192),
  followedCarNumber: '33',
  pitState: oneStopCompleted,
  rules
});
assert.strictEqual(impossiblePlan.schedule.feasible, false);
assert.strictEqual(impossiblePlan.recommendation.action, 'PIT NOW');
assert.strictEqual(impossiblePlan.recommendation.level, 'critical');

const completePlan = buildPitstopPlan({
  rows,
  session: sessionAt(100),
  followedCarNumber: '33',
  pitState: { completedPitStops: 3, validCompletedPitStops: 3 },
  rules
});
assert.strictEqual(completePlan.recommendation.action, 'STAY OUT');
assert.strictEqual(completePlan.recommendation.level, 'complete');

console.log('Pitstop strategy tests passed.');
