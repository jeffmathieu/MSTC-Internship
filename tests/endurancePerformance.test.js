const assert = require('assert');
const analytics = require('../src/shared/lapAnalytics');
const graphData = require('../src/shared/graphData');
const { createRendererChannel, mergeRendererState } = require('../src/main/rendererState');
const { buildTimingHighlights } = require('../src/shared/timingHighlights');

const raw = Array.from({ length: 31095 }, (_, index) => ({ carNumber: String(index % 45 + 1), className: `Class ${index % 3}`,
  driverName: 'Driver', lapNumber: Math.floor(index / 45) + 1, lapTimeMs: 125000 + index % 30,
  collectedAt: new Date(Date.UTC(2026, 8, 7) + Math.floor(index / 45) * 125000).toISOString(),
  lastLap: `2:05.${String(index % 30).padStart(3, '0')}`, sessionFlag: 'Green flag', pitInfo: '0' }));
const history = analytics.prepareHistory(raw);
const carOne = analytics.lapsForCar(history, '1');
const carTwo = analytics.lapsForCar(history, '2');
assert.strictEqual(carOne.length, 691);
assert.strictEqual(analytics.lapsForCar(history, '1'), carOne);
assert.strictEqual(analytics.statsForLaps(carOne), analytics.statsForLaps(carOne));
const extra = { ...raw.at(-45), lapNumber: 692, lapTimeMs: 126000, collectedAt: '2026-09-08T00:01:00.000Z' };
const next = analytics.prepareHistory([...raw, extra], history, [extra]);
assert.strictEqual(analytics.lapsForCar(next, '2'), carTwo, 'unaffected car statistics retain their cache');
assert.notStrictEqual(analytics.lapsForCar(next, '1'), carOne);
const wet = analytics.prepareConditionHistory(history, 'wet');
const wetNext = analytics.prepareConditionHistory(next, 'wet');
assert.strictEqual(analytics.lapsForCar(wet, '2'), analytics.lapsForCar(wetNext, '2'));
assert.notStrictEqual(analytics.lapsForCar(wet, '1'), analytics.lapsForCar(wetNext, '1'));
const mutable = [{ trackCondition: 'wet' }];
const conditions = require('../src/shared/trackConditions');
assert.strictEqual(conditions.conditionFilteredHistory(mutable, 'dry')[0].paceEligible, 'false');
mutable[0].trackCondition = 'dry';
assert.notStrictEqual(conditions.conditionFilteredHistory(mutable, 'dry')[0].paceEligible, 'false', 'legacy mutable callers cannot receive stale condition masks');
assert.strictEqual(analytics.completedLaps(next).length, 31096);

const channel = createRendererChannel();
const initialState = { storageSessionFolder: '/test/race', lapHistory: history,
  analyticsSummary: { followedCar: '1', timingHighlightsByCar: { '1': buildTimingHighlights(history, '1') } } };
const first = channel(initialState, '1');
let ui = mergeRendererState({}, first);
assert.strictEqual(ui.lapHistory.length, 691, 'dashboard receives only its own car history');
assert.strictEqual(ui.lapHistory[0].raw, undefined);
const timerUpdate = channel(initialState, '1');
assert.strictEqual(timerUpdate.historyPatch, null);
assert.strictEqual(timerUpdate.stripPatch, null);
assert.ok(Buffer.byteLength(JSON.stringify(timerUpdate)) < 100000);
assert.strictEqual(mergeRendererState(ui, timerUpdate).lapHistory, ui.lapHistory);
const newLapState = { ...initialState, lapHistory: next, analyticsSummary: { followedCar: '1',
  timingHighlightsByCar: { '1': buildTimingHighlights(next, '1') } } };
const update = channel(newLapState, '1');
assert.strictEqual(update.historyPatch.from, 691);
assert.strictEqual(update.historyPatch.items.length, 1);
ui = mergeRendererState(ui, update);
assert.strictEqual(ui.lapHistory.length, 692);
assert.strictEqual(mergeRendererState(ui, first), ui, 'delayed initial response cannot erase a newer update');
const edit = { ...raw[0], manualLapStatus: 'invalid' };
const editedHistory = analytics.prepareHistory([edit, ...raw.slice(1)]);
const correction = channel({ ...initialState, lapHistory: editedHistory }, '1');
assert.strictEqual(mergeRendererState(ui, correction).lapHistory[0].manualLapStatus, 'invalid');

const points = Array.from({ length: 10000 }, (_, i) => ({ x: i, y: i === 777 ? 900 : Math.sin(i / 10) }));
const decimated = graphData.visibleSeries(points, 0, 9999, 200);
assert.ok(decimated.length <= 402);
assert.ok(decimated.some((point) => point.y === 900), 'decimation preserves actual peaks');
const zoomed = graphData.visibleSeries(points, 770, 785, 200);
assert.ok(zoomed.includes(points[777]));
assert.ok(zoomed.length < 20, 'zoom reads only the selected lap window');
console.log('Endurance cache, IPC delta and chart budget regression tests passed.');
