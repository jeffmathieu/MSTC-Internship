const assert = require('assert');
const { parseClockMs, updateSessionTiming } = require('../src/shared/sessionTiming');

assert.strictEqual(parseClockMs('01:05'), 65000);
assert.strictEqual(parseClockMs('1:02:03'), 3723000);
assert.strictEqual(parseClockMs('55:54 / 1'), 3354000);
assert.strictEqual(parseClockMs('not started'), null);
assert.strictEqual(parseClockMs('1:60'), null);

const waiting = updateSessionTiming(null, {
  flag: 'GREEN',
  elapsed: '00:00',
  timeToGo: '04:00:00'
}, [], '2026-08-01T10:00:00.000Z');
assert.strictEqual(waiting.started, false, 'green on the grid is not proof that the race has started');

const stillWaiting = updateSessionTiming(waiting, {
  flag: 'GREEN',
  elapsed: '00:00',
  timeToGo: '04:00:00'
}, [], '2026-08-01T10:00:05.000Z');
assert.strictEqual(stillWaiting.started, false, 'an unchanged official clock keeps the stint timer frozen');

const countdownStarted = updateSessionTiming(stillWaiting, {
  flag: 'GREEN',
  elapsed: '00:00',
  timeToGo: '03:59:55'
}, [], '2026-08-01T10:00:10.000Z');
assert.strictEqual(countdownStarted.started, true);
assert.strictEqual(countdownStarted.startedAt, '2026-08-01T10:00:05.000Z');
assert.strictEqual(countdownStarted.reason, 'official-remaining-clock');

const elapsedStarted = updateSessionTiming(null, {
  elapsed: '00:12',
  timeToGo: '03:59:48'
}, [], '2026-08-01T10:00:12.000Z');
assert.strictEqual(elapsedStarted.started, true);
assert.strictEqual(elapsedStarted.startedAt, '2026-08-01T10:00:00.000Z');

const lapStarted = updateSessionTiming(null, {}, [{
  lapNumber: 1,
  lapTimeMs: 90000,
  recordedAt: '2026-08-01T10:01:30.000Z'
}], '2026-08-01T10:01:31.000Z');
assert.strictEqual(lapStarted.started, true);
assert.strictEqual(lapStarted.startedAt, '2026-08-01T10:00:00.000Z');
assert.strictEqual(lapStarted.reason, 'completed-lap');

const disconnected = updateSessionTiming(elapsedStarted, {
  statusText: 'Not connected'
}, [], '2026-08-01T10:00:20.000Z');
assert.strictEqual(disconnected.started, true, 'temporary missing clocks cannot stop an active stint');
assert.strictEqual(disconnected.startedAt, elapsedStarted.startedAt);

console.log('Session timing tests passed.');
