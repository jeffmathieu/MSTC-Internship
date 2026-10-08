const assert = require('assert');
const { nextProviderFreshness } = require('../src/shared/providerFreshness');
const at = (seconds) => new Date(Date.UTC(2026, 8, 8) + seconds * 1000).toISOString();
const rows = [{ carNumber: 33, lapNumber: 10, lastLap: '2:00.000', lastLapMs: 120000, sector1: '40.000' }];
const sample = (seconds, session = { elapsed: '00:20:00', flag: 'FCY' }, extra = {}) =>
  ({ observedAt: at(seconds), session, rows, ...extra });
let state = nextProviderFreshness({}, sample(0));
assert.strictEqual(state.usable, true);
const baseline = state.lastProgressAt;
state = nextProviderFreshness(state, sample(5));
assert.strictEqual(state.lastProgressAt, baseline, 'DOM reads are not source progress');
state = nextProviderFreshness(state, sample(30));
assert.strictEqual(state.status, 'stale', 'frozen source heartbeat is detected');
assert.strictEqual(state.usable, false);
state = nextProviderFreshness(state, sample(35, { elapsed: '00:20:05', flag: 'FCY' }));
assert.strictEqual(state.usable, true, 'clock progress restores source health');
for (const statusText of ['Not connected to the LiveTiming server', 'Trying to reconnect to the LiveTiming server',
  'Connecting to the LiveTiming server', 'Waiting for the LiveTiming data', 'No active heat']) {
  const unavailable = nextProviderFreshness(state, sample(40, { statusText }));
  assert.strictEqual(unavailable.usable, false, `cached rows do not override ${statusText}`);
}
const disconnected = nextProviderFreshness(state, sample(40, { statusText: 'Not connected to the LiveTiming server' }));
assert.strictEqual(nextProviderFreshness(disconnected, sample(45, { elapsed: '00:20:05', flag: 'FCY' })).usable, false,
  'removing the disconnect banner alone is not proof of refreshed data');
assert.strictEqual(nextProviderFreshness(state, sample(40, {}, { rows: [], status: 'parser_error' })).usable, false);
let noClock = nextProviderFreshness({}, sample(0, { flag: 'Green' }));
assert.strictEqual(nextProviderFreshness(noClock, sample(200, { flag: 'Green' })).usable, true, 'allow a slow lap without a heartbeat');
assert.strictEqual(nextProviderFreshness(noClock, sample(240, { flag: 'Green' })).usable, false);
let localClock = nextProviderFreshness({}, sample(0, { elapsed: '00:20:00', flag: 'Green' }));
localClock = nextProviderFreshness(localClock, sample(240, { elapsed: '00:24:00', flag: 'Green' }));
assert.strictEqual(localClock.usable, false, 'a locally advancing clock cannot hide a frozen timing table');
localClock = nextProviderFreshness(localClock, sample(245, { elapsed: '00:24:05', flag: 'Green' },
  { rows: [{ ...rows[0], sector2: '40.000' }] }));
assert.strictEqual(localClock.usable, true, 'fresh timing evidence clears a frozen-table warning');
const grid = [{ carNumber: 33, lapNumber: 0, lastLap: '' }];
const gridState = nextProviderFreshness({}, sample(0, {}, { rows: grid }));
assert.strictEqual(nextProviderFreshness(gridState, sample(3600, {}, { rows: grid })).usable, true,
  'a static grid with no heartbeat is not evidence of a disconnect');
const red = nextProviderFreshness({}, sample(0, { flag: 'Red flag' }));
assert.strictEqual(nextProviderFreshness(red, sample(3600, { flag: 'Red flag' })).usable, true);
console.log('Provider freshness tests passed.');
