const assert = require('assert');
const graphData = require('../src/shared/graphData');
const { lap, stintComparisonHistory } = require('./mockLapHistory');

assert.strictEqual(graphData.GRAPH_OPTIONS.length, 4);
assert.strictEqual(graphData.average([]), null);
assert.strictEqual(graphData.average([null, NaN]), null);
assert.strictEqual(graphData.average([100, 200, null]), 150);
assert.strictEqual(graphData.chartLapNumber({ lapNumber: 12 }, 0), 12);
assert.strictEqual(graphData.chartLapNumber({ lapNumber: null }, 4), 5);

const history = stintComparisonHistory();
const driverLaps = graphData.driverLapTimes(history, 33);
assert.strictEqual(driverLaps.type, 'line');
assert.deepStrictEqual(driverLaps.series.map((series) => series.name), ['Driver 1', 'Driver 2', 'Driver 3']);
assert.strictEqual(driverLaps.series[0].points.length, 20);
assert.strictEqual(driverLaps.series[2].points.at(-1).x, 10);
assert.strictEqual(driverLaps.series[0].points[2].x, 3);
assert.strictEqual(driverLaps.series[1].points[2].x, 3, 'third valid lap of every driver shares the same x-position');
assert.strictEqual(driverLaps.series[1].points[2].raceLapNumber, 23, 'tooltip data retains the real race lap');
const driverLapsWithScGap = graphData.driverLapTimes([
  lap({ carNumber: 44, teamName: 'Gap Team', driverName: 'Gap Driver', lapNumber: 1, lapTimeMs: 100000, sector1Ms: 30000, sector2Ms: 40000, sector3Ms: 30000 }),
  lap({ carNumber: 44, teamName: 'Gap Team', driverName: 'Gap Driver', lapNumber: 2, lapTimeMs: 160000, sector1Ms: 50000, sector2Ms: 60000, sector3Ms: 50000, sessionFlag: 'Safety car' }),
  lap({ carNumber: 44, teamName: 'Gap Team', driverName: 'Gap Driver', lapNumber: 3, lapTimeMs: 101000, sector1Ms: 30000, sector2Ms: 40000, sector3Ms: 31000 })
], 44);
assert.deepStrictEqual(driverLapsWithScGap.series[0].points.map((point) => point.x), [1, 2], 'excluded laps leave no gap in valid-lap comparison numbering');

const driverPace = graphData.driverPaceComparison(history, 33, 10);
assert.strictEqual(driverPace.type, 'bar');
assert.deepStrictEqual(driverPace.categories, ['Driver 1', 'Driver 2', 'Driver 3']);
assert.strictEqual(driverPace.series[0].values[0], 100000);
assert.strictEqual(driverPace.series[2].values[0], 100145);
assert.strictEqual(driverPace.series[2].values[2], 102045);

const sectorGraph = graphData.driverSectorComparison(history, 33);
assert.strictEqual(sectorGraph.series.length, 6);
assert.strictEqual(sectorGraph.series[0].values[0], 30000);
assert.strictEqual(sectorGraph.series[3].values[1], 40200);

const rollingInput = [100000, 101000, 102000, 103000, 104000, 105000].map((lapTimeMs, index) => lap({
  carNumber: 8,
  teamName: 'Rolling Team',
  driverName: 'Rolling Driver',
  lapNumber: index + 1,
  lapTimeMs,
  sector1Ms: 30000,
  sector2Ms: 40000,
  sector3Ms: lapTimeMs - 70000,
  paceEligible: index === 2 ? 'false' : 'true'
}));
const rolling = graphData.rollingAveragePoints(rollingInput.map(require('../src/shared/lapAnalytics').normalizeLap), 3);
assert.strictEqual(rolling.length, 5, 'neutralized laps are excluded from rolling pace');
assert.deepStrictEqual(rolling.map((point) => point.sampleCount), [1, 2, 3, 3, 3]);
assert.strictEqual(rolling.at(-1).y, 104000, 'rolling average uses only the latest three valid laps');

const neutralizedHistory = [
  lap({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver 1', lapNumber: 51, lapTimeMs: 180000, sector1Ms: 60000, sector2Ms: 60000, sector3Ms: 60000, lapFlag: 'FCY', paceEligible: 'false' }),
  lap({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver 1', lapNumber: 52, lapTimeMs: 105000, sector1Ms: 31000, sector2Ms: 41000, sector3Ms: 33000, lapFlag: 'FCY', paceEligible: 'false', sector1Eligible: 'true', sector2Eligible: 'true', sector3Eligible: 'false' })
];
const combined = [...history, ...neutralizedHistory];
const combinedLaps = graphData.driverLapTimes(combined, 33);
assert.strictEqual(combinedLaps.series[0].points.length, 20, 'FCY laps are omitted from the graph entirely');
assert.strictEqual(combinedLaps.series[0].points.at(-1).x, 20);
const combinedPace = graphData.driverPaceComparison(combined, 33);
assert.strictEqual(combinedPace.series[1].values[0], 100095, 'FCY laps do not affect driver lap averages');
const combinedSectors = graphData.driverSectorComparison(combined, 33);
assert.ok(combinedSectors.series[0].values[0] > 30000, 'eligible pre-FCY sectors still affect sector averages');
assert.strictEqual(combinedSectors.series[4].values[0], 30095, 'ineligible FCY S3 values are excluded');

const classGraph = graphData.classPaceComparison(history, 33, 5);
assert.strictEqual(classGraph.type, 'line');
assert.deepStrictEqual(classGraph.series.map((series) => series.carNumber), ['33', '2', '9']);
assert.strictEqual(classGraph.series.find((series) => series.carNumber === '33').highlight, true);
assert.strictEqual(classGraph.series.find((series) => series.carNumber === '2').highlight, false);
assert.strictEqual(classGraph.series.find((series) => series.carNumber === '2').points.length, 20);
assert.strictEqual(classGraph.series.find((series) => series.carNumber === '2').points[0].y, 99000);

const otherClass = lap({ carNumber: 77, className: 'GT', teamName: 'GT Team', driverName: 'GT Driver', lapNumber: 1, lapTimeMs: 110000, sector1Ms: 35000, sector2Ms: 40000, sector3Ms: 35000 });
assert.strictEqual(graphData.classPaceComparison([...history, otherClass], 33).series.some((series) => series.carNumber === '77'), false);
assert.deepStrictEqual(graphData.classPaceComparison([], 33).series, []);
assert.strictEqual(graphData.buildGraph('unknown', history, 33).title, 'Lap times per driver');
assert.strictEqual(graphData.buildGraph('driver-pace', history, 33).title, 'Driver pace comparison');
assert.strictEqual(graphData.buildGraph('driver-sectors', history, 33).title, 'Sector comparison');
assert.strictEqual(graphData.buildGraph('class-pace', history, 33).title, 'Class pace comparison');

assert.deepStrictEqual(graphData.normalizeViewport(), { start: 0, end: 1 });
assert.deepStrictEqual(graphData.normalizeViewport({ start: -2, end: 4 }), { start: 0, end: 1 });
const zoomed = graphData.zoomViewport({ start: 0, end: 1 }, 0.5);
assert.deepStrictEqual(zoomed, { start: 0.25, end: 0.75 });
assert.deepStrictEqual(graphData.panViewport(zoomed, -1), { start: 0.1, end: 0.6 });
assert.deepStrictEqual(graphData.panViewport(zoomed, 1), { start: 0.4, end: 0.9 });
assert.deepStrictEqual(graphData.panViewport({ start: 0, end: 0.5 }, -1), { start: 0, end: 0.5 });
const rightBounded = graphData.panViewport({ start: 0.5, end: 1 }, 1);
assert.ok(Math.abs(rightBounded.start - 0.5) < 1e-12);
assert.strictEqual(rightBounded.end, 1);
const minimumZoom = graphData.zoomViewport({ start: 0.49, end: 0.51 }, 0.01);
assert.ok(minimumZoom.end - minimumZoom.start >= 0.08 - Number.EPSILON);

console.log('Graph data tests passed.');
