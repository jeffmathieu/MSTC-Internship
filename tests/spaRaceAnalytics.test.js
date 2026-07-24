const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  lapsForCar,
  lapPaceEligible,
  statsForLaps
} = require('../src/shared/lapAnalytics');

const historyPath = path.join(__dirname, 'SPA', 'RACE', 'lap_history.jsonl');
const history = fs.readFileSync(historyPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const laps = lapsForCar(history, '33');
const byLap = (lapNumber) => laps.find((lap) => lap.lapNumber === lapNumber);

assert.strictEqual(laps.length, 62);
assert.strictEqual(lapPaceEligible(byLap(2)), false, 'Spa lap 2 is excluded even though its stale lapFlag says green');
assert.strictEqual(byLap(2).sector1Flag, 'Full course yellow');

assert.strictEqual(byLap(23).lapPhase, 'inlap');
assert.strictEqual(byLap(24).lapPhase, 'outlap');
assert.strictEqual(byLap(25).lapPhase, '');
assert.strictEqual(byLap(38).lapPhase, 'inlap');
assert.strictEqual(byLap(39).lapPhase, 'outlap');
assert.strictEqual(byLap(46).lapPhase, 'inlap');
assert.strictEqual(byLap(47).lapPhase, 'outlap');

const stats = statsForLaps(laps);
assert.strictEqual(stats.paceLapCount, 46);
assert.strictEqual(stats.selection.lap.excludedCount, 16);
assert.deepStrictEqual(stats.selection.lap.excludedByReason, {
  'first-lap': 1,
  neutralized: 12,
  'pit-in': 3,
  'pit-out': 3
});
assert.strictEqual(stats.averageLapMs, 198301.45652173914);
assert.strictEqual(stats.bestLapMs, 178665);

console.log('Spa race analytics regression tests passed.');
