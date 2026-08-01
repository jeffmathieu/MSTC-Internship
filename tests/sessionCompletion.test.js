const assert = require('assert');
const { rowIsFinished, followedClassCompletion } = require('../src/shared/sessionCompletion');

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

console.log('Session completion tests passed.');
