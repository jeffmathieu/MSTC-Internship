const assert = require('assert');
const { buildDriverOverview } = require('../src/shared/driverOverview');
const { buildDrivingStintState } = require('../src/shared/stintTracker');
const { prepareHistory } = require('../src/shared/lapAnalytics');
const { stintComparisonHistory } = require('./mockLapHistory');

const history = prepareHistory(stintComparisonHistory());
const stintState = buildDrivingStintState(history, ['33'], '2026-06-23T13:30:00.000Z', {});
const overview = buildDriverOverview({ laps: history, stintCar: stintState.cars['33'], carNumber: '33', liveDriver: 'Driver 3' });

assert.deepStrictEqual(overview.drivers.map((d) => d.driverName), ['Driver 1', 'Driver 2', 'Driver 3']);
assert.strictEqual(overview.totals.driverCount, 3);
assert.strictEqual(overview.totals.stintCount, 3);
assert.strictEqual(overview.currentDriver, 'Driver 3');
assert.deepStrictEqual(overview.drivers.map((d) => d.isCurrent), [false, false, true]);
assert.deepStrictEqual(overview.drivers.map((d) => d.lapCount), [20, 20, 10]);
assert.ok(Math.abs(overview.drivers.reduce((sum, d) => sum + d.sharePct, 0) - 100) < 1e-6, 'driving shares add up to 100%');

const [one, two, three] = overview.drivers;
assert.strictEqual(one.isFastestAverage, true, 'the quickest average driver is flagged');
assert.strictEqual(one.deltaAverageMs, 0);
assert.ok(two.deltaAverageMs > 0 && three.deltaAverageMs > two.deltaAverageMs, 'slower drivers show a positive delta');
assert.strictEqual(overview.totals.fastestAverage.driverName, 'Driver 1');
assert.strictEqual(overview.totals.fastestLap.driverName, 'Driver 1');
assert.ok(one.consistencyMs > 0, 'consistency is the spread of representative laps');
assert.strictEqual(one.stintCount, 1);
assert.strictEqual(overview.stints.length, 3);
assert.strictEqual(overview.stints[0].lapCount, 20);

const empty = buildDriverOverview({ laps: [], stintCar: null, carNumber: '33' });
assert.deepStrictEqual(empty.drivers, []);
assert.strictEqual(empty.totals.drivingMs, 0);
assert.strictEqual(empty.totals.fastestLap, null);

console.log('Driver overview tests passed.');
