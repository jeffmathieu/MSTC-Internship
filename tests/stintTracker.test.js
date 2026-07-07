const assert = require('assert');
const { lap } = require('./mockLapHistory');
const {
  normalizeDriverName,
  sumLapTimes,
  parseStintDurationMs,
  providerTimerProgress,
  resolveMissingDriverNames,
  stintsForCar,
  buildStintState
} = require('../src/shared/stintTracker');

function stintLap(driverName, lapNumber, extra = {}) {
  return lap({
    carNumber: 33,
    teamName: 'MSTC',
    driverName,
    lapNumber,
    lapTimeMs: 180000 + lapNumber * 100,
    sector1Ms: 55000,
    sector2Ms: 79000,
    sector3Ms: 46100 + lapNumber * 100,
    ...extra
  });
}

const history = [
  stintLap('Driver A', 1),
  stintLap('', 2, { state: 'IN', pitInfo: '1' }),
  stintLap('', 3, { pitInfo: '1' }),
  stintLap('Driver B', 4),
  stintLap('driver b', 5),
  stintLap('Driver A', 6)
];

assert.strictEqual(normalizeDriverName('  Driver   A  '), 'Driver A');
assert.strictEqual(sumLapTimes([{ lapTimeMs: 1000 }, { lapTimeMs: '2000' }, { lapTimeMs: '' }]), 3000);
assert.deepStrictEqual(
  resolveMissingDriverNames(history).slice(0, 4).map((entry) => entry.driverName),
  ['Driver A', 'Driver A', 'Driver A', 'Driver B'],
  'blank provider names must not create fake stints'
);

const stints = stintsForCar(history, 33);
assert.strictEqual(stints.length, 3, 'driver returning later creates a new contiguous stint');
assert.deepStrictEqual(stints.map((stint) => stint.stintNumber), [1, 2, 3]);
assert.deepStrictEqual(stints.map((stint) => stint.driverStintNumber), [1, 1, 2]);
assert.deepStrictEqual(stints.map((stint) => [stint.startLap, stint.endLap]), [[1, 3], [4, 5], [6, 6]]);
assert.deepStrictEqual(stints.map((stint) => stint.closed), [true, true, false]);
assert.strictEqual(stints[0].lapCount, 3, 'pitstop with the same driver stays in one stint');
assert.strictEqual(stints[1].driverName, 'Driver B', 'driver-name casing changes do not split a stint');
assert.strictEqual(stints[0].stintTimeMs, 540600);
assert.strictEqual(stints[0].totalDriverTimeMs, 721200, 'driver total includes a later stint by the same driver');
assert.ok(stints[0].closedAt);
assert.strictEqual(stints[2].closedAt, null);
const finalizedStints = stintsForCar(history, 33, { closeFinalAt: '2026-07-05T23:00:00.000Z' });
assert.strictEqual(finalizedStints.at(-1).closed, true);
assert.strictEqual(finalizedStints.at(-1).closedAt, '2026-07-05T23:00:00.000Z');

const state = buildStintState(history, ['33', '33', '2'], '2026-06-23T12:06:05.000Z');
assert.strictEqual(state.generatedAt, '2026-06-23T12:06:05.000Z');
assert.strictEqual(state.cars['33'].stintCount, 3);
assert.strictEqual(state.cars['33'].closedStintCount, 2);
assert.strictEqual(state.cars['33'].currentStint.stintNumber, 3);
assert.strictEqual(state.cars['33'].currentStint.driverStintNumber, 2);
assert.strictEqual(state.cars['33'].currentStint.laps, undefined, 'persisted state remains compact');
assert.strictEqual(state.cars['33'].totalTimeByDriver['Driver A'], 726200);
assert.strictEqual(state.cars['2'].stintCount, 0);

// Reconstructing after an application restart must produce the same boundaries
// and numbers without reading any transient counters.
assert.deepStrictEqual(
  stintsForCar(JSON.parse(JSON.stringify(history)), 33).map((stint) => [stint.stintNumber, stint.driverName, stint.startLap, stint.endLap]),
  stints.map((stint) => [stint.stintNumber, stint.driverName, stint.startLap, stint.endLap])
);

const leadingUnknown = resolveMissingDriverNames([stintLap('', 1), stintLap('Known Driver', 2)]);
assert.deepStrictEqual(leadingUnknown.map((entry) => entry.driverName), ['Known Driver', 'Known Driver']);
assert.strictEqual(stintsForCar([], 33).length, 0);

assert.strictEqual(parseStintDurationMs('42:07'), 2527000);
assert.strictEqual(parseStintDurationMs('1:02:03'), 3723000);
assert.strictEqual(parseStintDurationMs('42:99'), null);
assert.strictEqual(parseStintDurationMs('4'), null);

const providerTimed = [
  stintLap('Driver A', 1, { stint: '10:00' }),
  stintLap('Driver A', 2, { stint: '20:00' }),
  stintLap('Driver B', 3, { stint: '05:00' })
];
const providerStints = stintsForCar(providerTimed, 33);
assert.deepStrictEqual(providerStints.map((stint) => stint.stintNumber), [1, 2]);
assert.strictEqual(providerStints[0].stintTimeMs, 1200000);
assert.strictEqual(providerStints[1].stintTimeMs, 300000);
assert.strictEqual(providerStints[1].timerSource, 'stored-provider-stint-timer');
assert.strictEqual(providerTimerProgress([
  stintLap('Driver A', 1, { stint: '20:00' }),
  stintLap('Driver A', 2, { stint: '01:00' })
]).totalMs, 1260000, 'same-driver provider timer reset preserves the completed segment');

const liveProviderState = buildStintState(providerTimed, ['33'], '2026-06-23T12:03:05.000Z', {
  liveRows: [{ carNumber: '33', driver: 'Driver B', stint: '42:07' }]
});
assert.strictEqual(liveProviderState.cars['33'].currentStint.stintTimeMs, 2527000);
const repeatedProviderState = buildStintState(providerTimed, ['33'], '2026-06-23T12:03:10.000Z', {
  liveRows: [{ carNumber: '33', driver: 'Driver B', stint: '42:07' }],
  previousState: liveProviderState
});
assert.strictEqual(repeatedProviderState.cars['33'].currentStint.stintTimeMs, 2532000, 'unchanged provider timer advances by poll time');

const returningProviderDriver = [
  stintLap('Driver A', 1, { lapTimeMs: 180000, stint: '1:30:00' }),
  stintLap('Driver A', 2, { lapTimeMs: 181000, stint: '1:45:00' }),
  stintLap('Driver B', 3, { lapTimeMs: 182000, stint: '05:00' }),
  stintLap('Driver A', 4, { lapTimeMs: 183000, stint: '08:00' })
];
const returningProviderState = buildStintState(returningProviderDriver, ['33'], '2026-06-23T12:08:00.000Z', {
  liveRows: [{ carNumber: '33', driver: 'Driver A', stint: '10:00' }]
});
assert.strictEqual(
  returningProviderState.cars['33'].currentStint.totalDriverTimeMs,
  961000,
  'driver total uses stored lap durations for old stints plus the active live stint timer'
);

const noColumnStart = buildStintState([], ['33'], '2026-06-23T12:00:00.000Z', {
  liveRows: [{ carNumber: '33', driver: 'New Driver', stint: '' }]
});
assert.strictEqual(noColumnStart.cars['33'].currentStint.stintTimeMs, 0);
const noColumnNextPoll = buildStintState([], ['33'], '2026-06-23T12:00:05.000Z', {
  liveRows: [{ carNumber: '33', driver: 'New Driver', stint: '' }],
  previousState: noColumnStart
});
assert.strictEqual(noColumnNextPoll.cars['33'].currentStint.stintTimeMs, 5000, 'timestamp fallback advances every poll without STINT column');

console.log('Stint tracker tests passed.');
