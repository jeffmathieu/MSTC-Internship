const assert = require('assert');
const { adaptTimingFeed } = require('../src/shared/timingFeed');
const { servicePhase, updatePitEvents, serviceTimers } = require('../src/shared/pitEvents');
const { updateGapMemory } = require('../src/shared/gapMemory');
const battle = require('../src/shared/classBattle');
const planner = require('../src/shared/pitstopPlanner');
const { enrichPitStops, pitstopAnalysis, buildCanonicalReportPayload, buildCanonicalFallbackHtml } = require('../src/main/stintReports');
const { stintsForCar } = require('../src/shared/stintTracker');
const { normalizeForStorage, lapRecordFromNormalizedRow } = require('../src/shared/storageSchema');
const { parseTimingRow } = require('../src/shared/parser');
const { recoverStoredTiming } = require('../src/shared/storageSession');

const at = (seconds) => new Date(Date.UTC(2026, 8, 7) + seconds * 1000).toISOString();
let state;
const observe = (seconds, row) => {
  const result = updatePitEvents(state, { carNumber: '33', driver: 'Peter Bens', pit: '0', ...row }, at(seconds), { targetDurationMs: 75000, historySequence: 60 });
  state = result.state;
  return result;
};
assert.strictEqual(servicePhase({ state: 'F', eta: '00:30' }), 'fuel');
assert.strictEqual(servicePhase({ movement: 'F' }), 'fuel');
assert.strictEqual(servicePhase({ eta: 'Fuel' }), 'fuel');
assert.strictEqual(servicePhase({ state: 'P', eta: 'Fuel' }), 'pit', 'explicit state wins over a stale ETA cell');
assert.strictEqual(servicePhase({ state: 'RUN', eta: 'Fuel' }), 'track');
observe(0, { state: 'RUN' });
observe(10, { state: 'F' });
observe(15, { state: 'F', eta: 'Fuel' });
assert.strictEqual(serviceTimers(state, at(20)).fuelDurationMs, 10000);
observe(40, { state: 'P', eta: 'In pit' });
assert.strictEqual(serviceTimers(state, at(50)).fuelDurationMs, 30000);
assert.strictEqual(serviceTimers(state, at(50)).pitDurationMs, 10000);
// JSON checkpoint represents a restart in the middle of a pitstop.
state = JSON.parse(JSON.stringify(state));
observe(110, { state: 'RUN', eta: 'OUTLAP', driver: 'Ellen Leysen', pit: '1' });
let stop = state.events[0];
assert.strictEqual(state.events.length, 1);
assert.strictEqual(stop.fuelDurationMs, 30000);
assert.strictEqual(stop.pitDurationMs, 70000);
assert.strictEqual(stop.totalDurationMs, 100000);
assert.strictEqual(stop.durationMs, 70000);
assert.strictEqual(stop.driverChanged, true);
observe(115, { state: 'RUN', pit: '1', driver: 'Ellen Leysen', lastPit: '1:12' });
assert.strictEqual(state.events.length, 1, 'late provider measurement updates the same event');
assert.strictEqual(state.events[0].durationMs, 72000);
observe(300, { state: 'P', pit: '1', driver: 'Ellen Leysen', lastPit: '1:12' });
observe(375, { state: 'RUN', eta: 'OUTLAP', pit: '2', driver: 'Ellen Leysen', lastPit: '1:15' });
assert.strictEqual(state.events[1].fuelDurationMs, 0);
assert.strictEqual(state.events[1].driverChanged, false);
assert.strictEqual(state.events[1].totalDurationMs, 75000);
assert.strictEqual(serviceTimers(state, at(380)).fuelDurationMs, 0);

const unknown = enrichPitStops([{ durationMs: null, targetDurationMs: 75000, driverAfter: 'Ellen Leysen' }]);
assert.strictEqual(unknown[0].deltaVsTargetMs, null, 'unknown duration is never a zero-second pitstop');
assert.strictEqual(unknown[0].driverChanged, null);
assert.strictEqual(pitstopAnalysis(unknown).measuredCount, 0);
assert.strictEqual(pitstopAnalysis(unknown).averageDeltaVsTargetMs, null);
assert.strictEqual(enrichPitStops([{ durationMs: 80000, targetDurationMs: null }], 75000)[0].deltaVsTargetMs, 5000);

const headers = ['POS', 'NR', 'DRIVER', 'GAP', 'LAST', 'PIT'];
const rows = (gaps) => gaps.map((gap, index) => ({ carNumber: String(index + 1), position: index + 1, classPosition: index + 1,
  className: 'A', gap, lastLap: '2:00.001', lapNumber: null }));
let feed = adaptTimingFeed({}, headers, rows(['130', '129', '129']));
assert.ok(feed.rows.every((row) => row.gap === ''), 'absolute lap counts are suppressed immediately');
assert.ok(feed.rows.every((row) => row.lapNumber == null), 'wait for evidence of alternating phases');
let memory = updateGapMemory({}, { rows: feed.rows, followedCars: ['2'], collectedAt: at(0) });
assert.strictEqual(memory.viewsByCar['2'].ahead.gapMs, null);
feed = adaptTimingFeed(feed.state, headers, rows(['--', '2.500', '1.200']));
assert.strictEqual(feed.state.alternating, true);
assert.strictEqual(feed.rows[1].lapNumber, 129);
assert.strictEqual(feed.rows[1].interval, '2.500');
assert.strictEqual(battle.usesCumulativeGap(feed.rows), false);
assert.strictEqual(planner.usesCumulativeGap(feed.rows), false);
memory = updateGapMemory(memory, { rows: feed.rows, followedCars: ['2'], collectedAt: at(5) });
assert.strictEqual(memory.viewsByCar['2'].behind.gapMs, 1200, 'adjacent interval is not subtracted as a leader gap');
feed = adaptTimingFeed(feed.state, headers, rows(['131', '130', '130']));
memory = updateGapMemory(memory, { rows: feed.rows, followedCars: ['2'], collectedAt: at(10) });
assert.ok(Object.values(memory.confirmedCars).every((car) => !car || car.intervalToPreviousMs < 10000));
assert.ok(feed.rows.every((row) => row.gap === ''));
const stored = lapRecordFromNormalizedRow(normalizeForStorage(feed.rows[1], { collectedAt: at(10) }));
assert.strictEqual(stored.lapNumber, '', 'stale rotating counters cannot duplicate lap numbers in history');
assert.strictEqual(stored.observedProviderLapNumber, '130');

// Existing RIS leader gaps, lapped deficits and dedicated LAPS/INT feeds retain
// their established semantics. A blank INT poll is not a schema change.
const standard = rows(['--', '2.500', '10.000']).map((row, i) => ({ ...row, lapNumber: 100 - i }));
const normal = adaptTimingFeed(feed.state, [...headers, 'LAPS'], standard);
assert.strictEqual(normal.rows, standard);
assert.strictEqual(battle.usesCumulativeGap(normal.rows), true);
assert.strictEqual(planner.usesCumulativeGap(normal.rows), true);
assert.strictEqual(adaptTimingFeed({}, headers, rows(['--', '1L', '2L'])).state.alternating, false);
assert.strictEqual(adaptTimingFeed({}, headers, rows(['--', '1L', '2L'])).rows[1].gap, '1L');
const mixed = adaptTimingFeed({}, headers, rows(['-- 581 laps --', '16.427', '-- 579 laps --']));
assert.strictEqual(mixed.state.alternating, true, 'real Zolder cells rotate independently, while the leader always shows laps');
assert.strictEqual(mixed.rows[1].interval, '16.427');
assert.strictEqual(mixed.rows[2].gap, '');
const leaderMemory = updateGapMemory({}, { rows: mixed.rows, followedCars: ['1'], collectedAt: at(10) });
assert.strictEqual(leaderMemory.viewsByCar['1'].behind.gapMs, 16427,
  'a leader that permanently shows completed laps can still use its follower’s time interval');
const parsedFuel = parseTimingRow(['POS', '', 'NR', 'E.T.A.', 'GAP', 'PIT TIME', '#PIT'], ['2', 'F', '509', 'Fuel', '-- 102 laps --', '00:36', '4']);
assert.strictEqual(parsedFuel.state, 'F');
assert.strictEqual(parsedFuel.lastPit, '00:36');
assert.strictEqual(parsedFuel.pit, '4');
const runningPit = planner.nextPitStateFromRow({ row: { ...parsedFuel, state: 'P', eta: 'In pit' } });
assert.ok(runningPit.lastPitDurationMs == null, 'the running PIT TIME clock is not the last completed stop');
const archived = recoverStoredTiming([{ ...normalizeForStorage(parsedFuel), lastPit: '' }]);
assert.strictEqual(archived[0].lastPit, '00:36');
assert.strictEqual(archived[0].gap, '');
const gapStop = updatePitEvents({ active: { ...stop, closed: false, phase: 'pit', phaseStartedAt: at(40) }, events: [], observedAt: at(40) },
  { carNumber: '33', eta: 'Outlap', pitInfo: '1' }, at(200), { maximumObservationGapMs: 15000 });
assert.strictEqual(gapStop.state.events[0].fuelDurationMs, null, 'an offline gap cannot be counted as measured fuel/pit time');
let delayed = updatePitEvents({}, { carNumber: '1', state: 'RUN', pit: '4', lastPit: '1:30' }, at(0)).state;
delayed = updatePitEvents(delayed, { carNumber: '1', state: 'P', pit: '4', lastPit: '1:30' }, at(10)).state;
delayed = updatePitEvents(delayed, { carNumber: '1', state: 'RUN', pit: '4', lastPit: '1:30' }, at(80)).state;
assert.strictEqual(delayed.events[0].durationMs, 70000, 'the prior stop duration is not reused on exit');
delayed = updatePitEvents(delayed, { carNumber: '1', state: 'RUN', pit: '4', lastPit: '1:10' }, at(85)).state;
assert.strictEqual(delayed.events[0].stopNumber, null, 'a late count is not assigned the previous stop number');
delayed = updatePitEvents(delayed, { carNumber: '1', state: 'RUN', pit: '5', lastPit: '1:10' }, at(90)).state;
assert.strictEqual(delayed.events.length, 1);
assert.strictEqual(delayed.events[0].stopNumber, 5);

const history = Array.from({ length: 8 }, (_, i) => ({ carNumber: '33', className: 'A', driverName: i < 4 ? 'Peter Bens' : 'Ellen Leysen',
  lapNumber: '', lapTimeMs: 120000 + i, lastLap: `2:00.00${i}`, pitInfo: i < 4 ? '0' : '1',
  sessionFlag: 'Green flag', collectedAt: at(i * 125) }));
const payload = buildCanonicalReportPayload({ history, carNumber: '33', stints: stintsForCar(history, '33', { closeFinalAt: at(1000) }), pitRules: { pitStopDurationMs: 75000 } });
assert.deepStrictEqual(payload.stints.map((stint) => [stint.startLap, stint.endLap]), [[1, 4], [5, 8]]);
assert.strictEqual(payload.raceSummary.pitStops[0].lapNumber, 5);
assert.strictEqual(payload.raceSummary.pitStops[0].driverChanged, true);
assert.strictEqual(payload.raceSummary.pitStops[0].deltaVsTargetMs, null);
assert.ok(payload.caveats.some((text) => text.includes('Observed')));
assert.ok(!buildCanonicalFallbackHtml(payload, true).includes('None'));
console.log('Endurance fuel, gap rotation and missing-data regression tests passed.');
