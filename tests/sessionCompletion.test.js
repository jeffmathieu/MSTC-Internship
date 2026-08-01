const assert = require('assert');
const {
  DEFAULT_FINISH_BUFFER_RATIO,
  DEFAULT_FINISH_LAP_MS,
  rowIsFinished,
  followedClassCompletion,
  finishSignalPresent,
  updateFinishCountdown
} = require('../src/shared/sessionCompletion');

assert.strictEqual(rowIsFinished({ eta: 'Finishd' }), true);
assert.strictEqual(rowIsFinished({ eta: 'Finish' }), true);
assert.strictEqual(rowIsFinished({ state: 'CLASSIFIED' }), true);
assert.strictEqual(rowIsFinished({ eta: '00:18' }), false);
assert.strictEqual(rowIsFinished({ eta: 'In Pit', pitStatus: 'P' }), false, 'being in pit is not the same as taking the finish');

const rows = [
  { carNumber: 33, className: 'C', eta: 'Finishd' },
  { carNumber: 38, className: 'C', eta: '00:12' },
  { carNumber: 7, className: 'B', eta: 'Finishd' }
];
assert.strictEqual(followedClassCompletion(rows, 33).complete, false, 'one running class car keeps the race active');
const completedClass = followedClassCompletion([
  ...rows.map((row) => row.carNumber === 38 ? { ...row, eta: 'Finished' } : row),
  { carNumber: 8, className: 'B', eta: '00:05' }
], 33);
assert.strictEqual(completedClass.complete, true, 'a running car from another class does not block our class finish');
assert.deepStrictEqual(completedClass.classRows.map((row) => row.carNumber), [33, 38]);
assert.strictEqual(followedClassCompletion(rows, 999).reason, 'followed-car-missing');

const noClassRows = [
  { carNumber: 1, eta: 'Finishd' },
  { carNumber: 2, eta: 'Finishd' }
];
assert.strictEqual(followedClassCompletion(noClassRows, 1).complete, true, 'missing class means one overall class');

assert.strictEqual(DEFAULT_FINISH_BUFFER_RATIO, 0.25);
assert.strictEqual(DEFAULT_FINISH_LAP_MS, 180000);
assert.strictEqual(finishSignalPresent({ status: 'GREEN' }, [{ eta: '00:05' }]), false);
assert.strictEqual(finishSignalPresent({ flag: 'Checkered flag' }, []), true);
assert.strictEqual(finishSignalPresent({}, [{ eta: 'Finishd' }]), true);

const beforeFinish = updateFinishCountdown(null, {
  nowMs: 1000,
  session: { status: 'GREEN' },
  rows: [],
  primaryAverageLapMs: 100000
});
assert.strictEqual(beforeFinish.active, false);
assert.strictEqual(beforeFinish.expired, false);

const startedCountdown = updateFinishCountdown(beforeFinish, {
  nowMs: 2000,
  session: { flag: 'CHECKERED' },
  rows: [],
  primaryAverageLapMs: 100000
});
assert.strictEqual(startedCountdown.active, true);
assert.strictEqual(startedCountdown.baseLapMs, 100000);
assert.strictEqual(startedCountdown.deadlineAtMs, 127000, '100 seconds plus a 25% finish buffer');

const latchedCountdown = updateFinishCountdown(startedCountdown, {
  nowMs: 126999,
  session: { flag: 'GREEN' },
  rows: [],
  primaryAverageLapMs: 50000
});
assert.strictEqual(latchedCountdown.expired, false, 'the first finish deadline stays latched when later page data changes');
assert.strictEqual(latchedCountdown.deadlineAtMs, 127000);
assert.strictEqual(latchedCountdown.baseLapMs, 100000);
assert.strictEqual(updateFinishCountdown(latchedCountdown, { nowMs: 127000 }).expired, true);

const lastLapFallback = updateFinishCountdown(null, {
  nowMs: '2026-08-01T10:00:00.000Z',
  rows: [{ eta: 'Finished' }],
  primaryAverageLapMs: null,
  primaryLastLapMs: 80000
});
assert.strictEqual(lastLapFallback.baseLapMs, 80000);
assert.strictEqual(lastLapFallback.remainingMs, 100000);

const safeDefault = updateFinishCountdown(null, {
  nowMs: 0,
  session: { sessionStatus: 'Finished' },
  primaryAverageLapMs: 0,
  primaryLastLapMs: null
});
assert.strictEqual(safeDefault.baseLapMs, DEFAULT_FINISH_LAP_MS);

console.log('Session completion tests passed.');
