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
  makeLap(13, 'LMP3', 'Our Team', 'Driver A', 2, 100000),
  makeLap(13, 'LMP3', 'Our Team', 'Driver A', 3, 110000),
  makeLap(13, 'LMP3', 'Our Team', 'Driver B', 4, 99000),
  makeLap(13, 'LMP3', 'Our Team', 'Driver B', 5, 130000),
  makeLap(2, 'LMP3', 'Best Quali Car', 'Rival A', 2, 98000),
  makeLap(2, 'LMP3', 'Best Quali Car', 'Rival A', 3, 101000),
  makeLap(9, 'LMP3', 'Selected Car', 'Rival B', 2, 102000),
  makeLap(9, 'LMP3', 'Selected Car', 'Rival B', 3, 104000),
  makeLap(77, 'GT', 'Other Class', 'GT Driver', 2, 90000)
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
assert.strictEqual(raceView.columns[0].deltaMs, 30000, 'slower current time is positive');
assert.strictEqual(raceView.columns[1].deltaMs, -1000, 'faster current best is negative');
assert.strictEqual(raceView.columns[2].deltaMs, 9500);
assert.strictEqual(raceView.columns[2].topLabel, 'Average D1');
assert.strictEqual(raceView.columns[3].topMs, 99500);
assert.strictEqual(raceView.matrix.ourCarNumber, '13');
assert.strictEqual(raceView.matrix.teammate.title, 'B vs. A', 'compact title prefers uppercase surname/name parts');
assert.strictEqual(raceView.matrix.teammate.metrics[0].deltaMs, -1000, 'team best delta is current minus D1');
assert.strictEqual(raceView.matrix.teammate.metrics[0].valueMs, 99000, 'comparison matrix carries the displayed current absolute time');
assert.strictEqual(raceView.matrix.bic.metrics[0].referenceMs, 98000, 'reference time remains available for future detail views');
assert.strictEqual(raceView.matrix.teammate.metrics[1].deltaMs, 20000, 'team last delta is current minus D1');
assert.deepStrictEqual(raceView.matrix.teammate.averages.map((entry) => entry.label), ['DA', 'DB']);
assert.strictEqual(raceView.matrix.teammate.averages[0].deltaMs, 0);
assert.strictEqual(raceView.matrix.teammate.averages[1].deltaMs, 9500, 'slower team driver average is positive versus D1');
assert.strictEqual(raceView.matrix.bic.targetCarNumber, '2');
assert.strictEqual(raceView.matrix.xic.targetCarNumber, '9');
assert.strictEqual(raceView.matrix.bic.metrics[0].deltaMs, 1000, 'our BIC delta is positive when our best is slower');
assert.strictEqual(raceView.matrix.bic.metrics[0].valueMs, 98000, 'BIC column displays the BIC car best time');
assert.strictEqual(raceView.matrix.bic.totalAverageDeltaMs, 10250, 'total BIC delta is our car average minus BIC average');
assert.strictEqual(raceView.matrix.bic.averages[0].deltaMs, 10250, 'external driver averages compare with our total car average');
assert.strictEqual(raceView.matrix.xic.metrics[0].deltaMs, -3000, 'our XIC delta is negative when our best is faster');
assert.strictEqual(raceView.matrix.xic.metrics[0].valueMs, 102000, 'XIC column displays the selected car best time');
assert.strictEqual(raceView.matrix.teammate.sectors.length, 3);
assert.strictEqual(raceView.matrix.teammate.sectors[0].averageMs, 30000, 'team sector average uses all valid sectors from our car');
assert.strictEqual(raceView.matrix.teammate.sectors[0].showDelta, false, 'team sector averages do not show deltas');
assert.strictEqual(raceView.matrix.bic.sectors[2].averageMs, 29500, 'BIC sector average comes from valid BIC sectors');
assert.strictEqual(raceView.matrix.bic.sectors[2].deltaMs, 10250, 'BIC sector delta compares our average sector with their average sector');
assert.strictEqual(raceView.matrix.bic.sectors[2].showDelta, true);
assert.deepStrictEqual(raceView.matrix.classCars.map((car) => car.carNumber), ['2', '13', '9'], 'class comparison tabs include every active car in class order');
assert.strictEqual(raceView.matrix.classCars[0].isBic, true, 'best-in-class car is marked for the UI');
assert.strictEqual(raceView.matrix.classCars[1].isOurCar, true, 'our car is marked so sector deltas can be hidden');

const longPitRows = [
  { position: 1, carNumber: '2', className: 'LMP3', classPosition: 1, driver: 'Rival A', lapNumber: 20 },
  { position: 2, carNumber: '13', className: 'LMP3', classPosition: 2, driver: 'Driver B', lapNumber: 20 },
  { position: 3, carNumber: '9', className: 'LMP3', classPosition: 3, driver: 'Rival B', lapNumber: 14, state: 'P' }
];
const longPitView = buildComparisonView({ history, rows: longPitRows, ourCarNumber: 13, selectedCarNumber: 9, mode: 'race' });
assert.deepStrictEqual(longPitView.matrix.classCars.map((car) => car.carNumber), ['2', '13'], 'cars that are 5+ laps down in pit are hidden from live class comparison tabs');

// BIC/XIC use the same current-minus-reference sign contract even when the
// target car's current driver differs from its full-car average.
const targetScopeHistory = [
  makeLap(13, 'LMP3', 'Our Team', 'Our Driver', 2, 120000),
  makeLap(2, 'LMP3', 'BIC', 'Old BIC Driver', 2, 90000),
  makeLap(2, 'LMP3', 'BIC', 'Current BIC Driver', 3, 110000),
  makeLap(9, 'LMP3', 'XIC', 'Old XIC Driver', 2, 120000),
  makeLap(9, 'LMP3', 'XIC', 'Current XIC Driver', 3, 100000)
];
const targetScopeRows = [
  { carNumber: '13', className: 'LMP3', driver: 'Our Driver' },
  { carNumber: '2', className: 'LMP3', driver: 'Current BIC Driver' },
  { carNumber: '9', className: 'LMP3', driver: 'Current XIC Driver' }
];
const targetScopeView = buildComparisonView({
  history: targetScopeHistory,
  rows: targetScopeRows,
  ourCarNumber: 13,
  selectedCarNumber: 9,
  mode: 'race'
});
assert.strictEqual(targetScopeView.columns[3].deltaMs, 10000, 'slower current BIC driver is positive');
assert.strictEqual(targetScopeView.columns[4].deltaMs, -10000, 'faster current XIC driver is negative');

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
assert.strictEqual(adjacent.ahead.bestLapDeltaMs, 1000);
assert.strictEqual(adjacent.ahead.trendState, 'bad');
assert.strictEqual(adjacent.behind.row.carNumber, '9');
assert.strictEqual(adjacent.behind.bestLapDeltaMs, -3000);
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
  makeLap(13, 'LMP3', 'Our Team', 'Our Driver', 2, 100000),
  makeLap(2, 'LMP3', 'Rival', 'Rival Driver', 2, 100000)
];
const equalRows = [
  { position: 1, carNumber: '2', className: 'LMP3', classPosition: 1, driverName: 'Rival Driver' },
  { position: 2, carNumber: '13', className: 'LMP3', classPosition: 2, driverName: 'Our Driver' }
];
assert.strictEqual(qualifyingAdjacentView(equalHistory, equalRows, 13).ahead.trendState, 'neutral');
assert.strictEqual(buildComparisonView({ history: equalHistory, rows: equalRows, ourCarNumber: 13, mode: 'race' }).columns[0].bottomMs, 100000);

console.log('Session mode tests passed.');
