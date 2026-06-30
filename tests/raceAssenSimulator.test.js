const assert = require('assert');
const path = require('path');
const {
  DEFAULT_LAP_SECONDS,
  parseArgs,
  parseRaceTimeToMs,
  formatMs,
  loadRaceData,
  buildRowsAtRaceTime,
  createSimulator,
  renderPage
} = require('./race-assen-simulator/core');
const { looksLikeTimingHeaders } = require('../src/shared/parser');

const dataPath = path.join(__dirname, 'race-assen-simulator', 'assen-club-challenge-data.json');
const data = loadRaceData(dataPath);

assert.deepStrictEqual(parseArgs(['--port', '5199', '--lap-seconds', '10', '--paused']), {
  port: 5199,
  lapSeconds: 10,
  paused: true
});
assert.deepStrictEqual(parseArgs(['--port', '-1', '--lap-seconds', 'abc']), {
  port: 5177,
  lapSeconds: DEFAULT_LAP_SECONDS,
  paused: false
});
assert.strictEqual(parseRaceTimeToMs('2:04.059'), 124059);
assert.strictEqual(parseRaceTimeToMs('1:02:03.456'), 3723456);
assert.strictEqual(parseRaceTimeToMs('12.345'), 12345);
assert.strictEqual(parseRaceTimeToMs('bad'), null);
assert.strictEqual(formatMs(124059), '2:04.059');
assert.strictEqual(formatMs(3723456), '1:02:03.456');
assert.strictEqual(formatMs(Number.NaN), '');
assert.strictEqual(data.cars.length, 5);
assert.deepStrictEqual(data.cars.map((car) => car.carNumber).sort(), ['33', '36', '38', '4', '56']);
data.cars.forEach((car) => {
  assert.strictEqual(car.lapTimeMs.length, car.declaredLaps);
  assert.strictEqual(car.cumulativeMs.length, car.declaredLaps);
  assert.ok(car.cumulativeMs.at(-1) > 0);
});

const startRows = buildRowsAtRaceTime(data, 0);
assert.strictEqual(startRows[0].car.carNumber, '33');
assert.strictEqual(startRows[0].completedLaps, 0);
assert.strictEqual(startRows[0].gap, '');

const rowsAfterFirstMstcLap = buildRowsAtRaceTime(data, parseRaceTimeToMs('2:55.000'));
const mstc = rowsAfterFirstMstcLap.find((row) => row.car.carNumber === '33');
assert.strictEqual(mstc.completedLaps, 1);
assert.strictEqual(formatMs(mstc.lastLapMs), '2:04.059');
assert.strictEqual(formatMs(mstc.bestLapMs), '2:04.059');
assert.notStrictEqual(mstc.sector1, '');

const finalRows = buildRowsAtRaceTime(data, Number.POSITIVE_INFINITY);
assert.strictEqual(finalRows[0].car.carNumber, '38');
assert.strictEqual(finalRows[0].completedLaps, 84);
const ourFinalRow = finalRows.find((row) => row.car.carNumber === '33');
assert.strictEqual(ourFinalRow.completedLaps, 83);
assert.strictEqual(ourFinalRow.gap, '-- 1 lap --');

const simulator = createSimulator(data, { lapSeconds: 5, paused: true });
assert.strictEqual(simulator.snapshot().paused, true);
simulator.setLapSeconds('10');
assert.strictEqual(simulator.snapshot().lapSeconds, 10);
simulator.setLapSeconds('-1');
assert.strictEqual(simulator.snapshot().lapSeconds, 10);
simulator.reset();
assert.strictEqual(simulator.snapshot().raceMs, 0);
simulator.setPaused(false);
assert.strictEqual(simulator.snapshot().paused, false);
simulator.setPaused(true);
assert.strictEqual(simulator.snapshot().paused, true);
const html = renderPage(data, simulator);
assert.ok(html.includes('Belcar Endurance Championship - Race'));
assert.ok(html.includes('DRIVER IN CAR'));
assert.strictEqual(looksLikeTimingHeaders(['POS', 'NR', 'TEAM', 'DRIVER IN CAR', 'CLS', 'LAST', 'BEST']), true);

console.log('Assen race simulator tests passed.');
