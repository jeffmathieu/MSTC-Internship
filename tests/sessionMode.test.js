const assert = require('assert');
const {
  normalizeMode,
  subtract,
  bestDriverByBestLap,
  bestCarByBestLap,
  buildComparisonView,
  qualifyingAdjacentView
} = require('../src/shared/sessionMode');
const { lap } = require('./mockLapHistory');

function makeLap(carNumber, className, teamName, driverName, lapNumber, lapTimeMs) {
  return lap({
    carNumber,
    className,
    teamName,
    driverName,
    lapNumber,
    lapTimeMs,
    sector1Ms: 30000,
    sector2Ms: 40000,
    sector3Ms: lapTimeMs - 70000
  });
}

const history = [
  makeLap(13, 'LMP3', 'Our Team', 'Driver A', 1, 100000),
  makeLap(13, 'LMP3', 'Our Team', 'Driver A', 2, 110000),
  makeLap(13, 'LMP3', 'Our Team', 'Driver B', 3, 99000),
  makeLap(13, 'LMP3', 'Our Team', 'Driver B', 4, 130000),
  makeLap(2, 'LMP3', 'Best Quali Car', 'Rival A', 1, 98000),
  makeLap(2, 'LMP3', 'Best Quali Car', 'Rival A', 2, 101000),
  makeLap(9, 'LMP3', 'Selected Car', 'Rival B', 1, 102000),
  makeLap(9, 'LMP3', 'Selected Car', 'Rival B', 2, 104000),
  makeLap(77, 'GT', 'Other Class', 'GT Driver', 1, 90000)
];
const rows = [
  { position: 1, carNumber: '2', className: 'LMP3', classPosition: 1, driver: 'Rival A' },
  { position: 2, carNumber: '13', className: 'LMP3', classPosition: 2, driver: 'Driver B' },
  { position: 3, carNumber: '9', className: 'LMP3', classPosition: 3, driver: 'Rival B' }
];

assert.strictEqual(normalizeMode('race'), 'race');
assert.strictEqual(normalizeMode('PRACTICE'), 'practice');
assert.strictEqual(normalizeMode('quali'), 'qualifying');
assert.strictEqual(normalizeMode('qualification'), 'qualifying');
assert.strictEqual(normalizeMode('unknown'), 'race');
assert.strictEqual(subtract(5, 2), 3);
assert.strictEqual(subtract(null, 2), null);

assert.strictEqual(bestDriverByBestLap(history, 13).driverName, 'Driver B');
assert.strictEqual(bestCarByBestLap(history, 'LMP3').carNumber, '2');
assert.strictEqual(bestDriverByBestLap([], 13), null);
assert.strictEqual(bestCarByBestLap([], 'LMP3'), null);

const raceView = buildComparisonView({ history, rows, ourCarNumber: 13, selectedCarNumber: 9, mode: 'race' });
assert.strictEqual(raceView.mode, 'race');
assert.strictEqual(raceView.columns[0].topMs, 100000, 'race D1 is selected by average pace');
assert.strictEqual(raceView.columns[0].bottomMs, 130000);
assert.strictEqual(raceView.columns[2].topLabel, 'Average D1');
assert.strictEqual(raceView.columns[3].topMs, 99500);
const sameTargetView = buildComparisonView({ history, rows, ourCarNumber: 13, selectedCarNumber: 2, mode: 'race' });
assert.strictEqual(sameTargetView.columns[3].targetCarNumber, '2');
assert.strictEqual(sameTargetView.columns[4].targetCarNumber, '2');
assert.strictEqual(sameTargetView.columns[3].topMs, sameTargetView.columns[4].topMs);
assert.strictEqual(sameTargetView.columns[3].bottomMs, sameTargetView.columns[4].bottomMs);
assert.strictEqual(sameTargetView.columns[3].topScope, 'car');
assert.strictEqual(sameTargetView.columns[3].bottomScope, 'current-driver');

const practiceView = buildComparisonView({ history, rows, ourCarNumber: 13, selectedCarNumber: 9, mode: 'practice' });
assert.strictEqual(practiceView.mode, 'practice');
assert.strictEqual(practiceView.columns[2].topLabel, 'Average D1');

const qualifyingView = buildComparisonView({ history, rows, ourCarNumber: 13, selectedCarNumber: 9, mode: 'qualifying' });
assert.strictEqual(qualifyingView.mode, 'qualifying');
assert.strictEqual(qualifyingView.columns[0].topMs, 99000, 'qualifying reference driver is selected by best lap');
assert.strictEqual(qualifyingView.columns[0].bottomMs, 130000);
assert.strictEqual(qualifyingView.columns[2].topLabel, 'Last team driver');
assert.strictEqual(qualifyingView.columns[3].topLabel, 'Best BIC');
assert.strictEqual(qualifyingView.columns[3].topMs, 98000);
assert.strictEqual(qualifyingView.columns[3].bottomMs, 101000);
assert.strictEqual(qualifyingView.columns[3].deltaMs, 3000);
assert.strictEqual(qualifyingView.columns[4].deltaMs, 2000);
assert.strictEqual(buildComparisonView({ history, rows, ourCarNumber: 13, selectedCarNumber: 9, mode: 'quali' }).mode, 'qualifying');

const adjacent = qualifyingAdjacentView(history, rows, 13);
assert.strictEqual(adjacent.available, true);
assert.strictEqual(adjacent.ahead.row.carNumber, '2');
assert.strictEqual(adjacent.ahead.bestLapDeltaMs, -1000);
assert.strictEqual(adjacent.ahead.trendState, 'bad');
assert.strictEqual(adjacent.behind.row.carNumber, '9');
assert.strictEqual(adjacent.behind.bestLapDeltaMs, 3000);
assert.strictEqual(adjacent.behind.trendState, 'good');
assert.strictEqual(qualifyingAdjacentView(history, rows, 2).ahead, null);
assert.strictEqual(qualifyingAdjacentView(history, rows, 9).behind, null);
assert.strictEqual(qualifyingAdjacentView(history, rows, 999).available, false);

const missingView = buildComparisonView({ history: [], rows: [], ourCarNumber: 13, selectedCarNumber: '', mode: 'qualifying' });
assert.strictEqual(missingView.columns.every((column) => column.topMs == null && column.bottomMs == null && column.deltaMs === null), true);
const missingRaceView = buildComparisonView({ history: [], rows: [], ourCarNumber: 13, selectedCarNumber: '', mode: 'race' });
assert.strictEqual(missingRaceView.columns.every((column) => column.topMs == null && column.bottomMs == null && column.deltaMs === null), true);

const noTimesAdjacent = qualifyingAdjacentView([], rows, 13);
assert.strictEqual(noTimesAdjacent.ahead.bestLapDeltaMs, null);
assert.strictEqual(noTimesAdjacent.ahead.trendState, 'neutral');

const equalHistory = [
  makeLap(13, 'LMP3', 'Our Team', 'Our Driver', 1, 100000),
  makeLap(2, 'LMP3', 'Rival', 'Rival Driver', 1, 100000)
];
const equalRows = [
  { position: 1, carNumber: '2', className: 'LMP3', classPosition: 1, driverName: 'Rival Driver' },
  { position: 2, carNumber: '13', className: 'LMP3', classPosition: 2, driverName: 'Our Driver' }
];
assert.strictEqual(qualifyingAdjacentView(equalHistory, equalRows, 13).ahead.trendState, 'neutral');
assert.strictEqual(buildComparisonView({ history: equalHistory, rows: equalRows, ourCarNumber: 13, mode: 'race' }).columns[0].bottomMs, 100000);

console.log('Session mode tests passed.');
