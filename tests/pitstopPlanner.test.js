const assert = require('assert');
const {
  normalizeRules,
  parseTimeToMs,
  formatDuration,
  pitCountFromRow,
  raceClockFromSession,
  buildPitstopPlan,
  projectClassAfterPit
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

assert.strictEqual(parseTimeToMs('1:35:00'), 5700000);
assert.strictEqual(parseTimeToMs('55:54 / 1'), 3354000);
assert.strictEqual(parseTimeToMs('90'), 90000);
assert.strictEqual(parseTimeToMs('1:30'), 90000);
assert.strictEqual(parseTimeToMs('bad data'), null);
assert.strictEqual(formatDuration(3661000), '1:01:01');
assert.strictEqual(formatDuration(-61000), '-1:01');
assert.strictEqual(formatDuration(NaN), '—');
assert.strictEqual(pitCountFromRow({ pit: 'P2' }), 2);
assert.strictEqual(pitCountFromRow({ pitInfo: 'stops 3' }), 3);
assert.strictEqual(pitCountFromRow({ pit: '--' }), 0);

const clock = raceClockFromSession({ timeToGo: '1:30:00' }, rules);
assert.strictEqual(clock.elapsedMs, 30 * 60 * 1000);
assert.strictEqual(clock.remainingMs, 90 * 60 * 1000);

const unknownClock = raceClockFromSession({ timeToGo: '—' }, rules);
assert.strictEqual(unknownClock.elapsedMs, null);
assert.strictEqual(unknownClock.progress, 0);

const sanitizedRules = normalizeRules({ raceDurationMs: -1, requiredPitStops: -5, nearWindowLaps: 'bad' });
assert.strictEqual(sanitizedRules.raceDurationMs, 24 * 60 * 60 * 1000);
assert.strictEqual(sanitizedRules.requiredPitStops, 2);
assert.strictEqual(sanitizedRules.nearWindowLaps, 2);

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

const nearlyOpen = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:37:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  rules
});
assert.strictEqual(nearlyOpen.status, 'soon');
assert.strictEqual(nearlyOpen.isNearlyOpen, true);

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

const cooldown = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '1:10:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 1, lastPitElapsedMs: 40 * 60 * 1000 },
  rules
});
assert.strictEqual(cooldown.status, 'closed');
assert.strictEqual(cooldown.waitMs, 15 * 60 * 1000);

const finishClosed = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '0:20:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 2 },
  rules
});
assert.strictEqual(finishClosed.status, 'closed');
assert.strictEqual(finishClosed.canPitNow, false);

const urgent = buildPitstopPlan({
  rows: classRows,
  session: { timeToGo: '0:50:00' },
  followedCarNumber: '33',
  pitState: { completedPitStops: 0 },
  rules
});
assert.strictEqual(urgent.status, 'urgent');
assert.strictEqual(urgent.canPitNow, true);

const projection = projectClassAfterPit(classRows, '33', 75000);
assert.strictEqual(projection.available, true);
assert.strictEqual(projection.projectedClassPosition, 3);
assert.strictEqual(projection.carAhead.carNumber, '56');
assert.strictEqual(projection.carAhead.projectedGapToUsMs, -55000);
assert.strictEqual(projectClassAfterPit(classRows, '999', 75000).available, false);

const unreliableProjection = projectClassAfterPit([
  classRows[0],
  { ...classRows[1], interval: '1L' }
], '33', 75000);
assert.strictEqual(unreliableProjection.available, false);

console.log('Pitstop planner tests passed.');
