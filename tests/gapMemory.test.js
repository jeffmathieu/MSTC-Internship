const assert = require('assert');
const {
  DEFAULT_PACE_WINDOW,
  DEFAULT_PIT_SUPPRESSION_LAPS,
  carKey,
  lapNumber,
  isInPit,
  rowCrossed,
  confirmedGapBetween,
  updateGapMemory
} = require('../src/shared/gapMemory');

assert.strictEqual(DEFAULT_PACE_WINDOW, 5);
assert.strictEqual(DEFAULT_PIT_SUPPRESSION_LAPS, 5);
assert.strictEqual(carKey(null), '');
assert.strictEqual(carKey(33), '33');
assert.strictEqual(lapNumber({ laps: '12' }), 12);
assert.strictEqual(lapNumber({ lapNumber: 'bad', laps: 12 }), null, 'explicit invalid lap number is not replaced by a different field');
assert.strictEqual(lapNumber(null), null);
assert.strictEqual(isInPit({ state: 'IN PIT' }), true);
assert.strictEqual(isInPit({ state: ' pit ' }), true);
assert.strictEqual(isInPit({ state: 'RUN' }), false);
assert.strictEqual(rowCrossed(null, { lapNumber: 1 }), true);
assert.strictEqual(rowCrossed({ lapNumber: 1, lastLap: '1:40.000' }, { lapNumber: 1, lastLap: '1:39.000' }), false);
assert.strictEqual(rowCrossed({ lapNumber: null, lastLap: '1:40.000' }, { lastLap: '1:39.000' }), true);
assert.strictEqual(rowCrossed({ lapNumber: 1, lastLap: '' }, { lapNumber: 2 }), true);
assert.strictEqual(rowCrossed({ lapNumber: null, lastLap: '' }, {}), false);

const directRows = [
  { position: 1, carNumber: 1 },
  { position: 2, carNumber: 2 }
];
assert.strictEqual(confirmedGapBetween(directRows, {}, directRows[0], directRows[1], 100000), null);
assert.strictEqual(confirmedGapBetween(directRows, {}, directRows[0], directRows[0], 100000), null);
assert.strictEqual(confirmedGapBetween(directRows, {}, directRows[0], { carNumber: 9 }, 100000), null);
const lapGapCars = {
  1: { lapNumber: 10, confirmedAt: '2026-07-05T09:00:00.000Z' },
  2: { lapNumber: 8, confirmedAt: '2026-07-05T09:01:00.000Z' }
};
assert.deepStrictEqual(confirmedGapBetween(directRows, lapGapCars, directRows[0], directRows[1], 100000), {
  gapMs: 200000,
  lapGap: 2,
  estimated: true,
  source: 'confirmed-lap-gap',
  confirmedAt: '2026-07-05T09:01:00.000Z'
});
assert.strictEqual(confirmedGapBetween(directRows, lapGapCars, directRows[0], directRows[1], null).gapMs, null);
const brokenChainCars = {
  1: { lapNumber: 10, confirmedAt: 'a' },
  2: { lapNumber: 10, predecessorCarNumber: '9', intervalToPreviousMs: 1000, confirmedAt: 'b' }
};
assert.strictEqual(confirmedGapBetween(directRows, brokenChainCars, directRows[0], directRows[1], 100000), null);

const rows = (lap = 10, rivalState = 'RUN') => [
  { position: 1, carNumber: 13, className: 'LMP3', classPosition: 1, lapNumber: lap, lastLap: '2:05.000', diff: '' },
  { position: 2, carNumber: 77, className: 'GT', classPosition: 1, lapNumber: lap, lastLap: '2:07.000', diff: '4.000' },
  { position: 3, carNumber: 2, className: 'LMP3', classPosition: 2, lapNumber: lap, lastLap: '2:04.000', diff: '6.000', state: rivalState }
];

let state = updateGapMemory({}, {
  rows: rows(),
  followedCars: ['13'],
  collectedAt: '2026-07-05T10:00:00.000Z'
});
assert.strictEqual(state.viewsByCar['13'].behind.gapMs, 10000, 'other-class intervals are summed');
assert.strictEqual(state.viewsByCar['13'].behind.source, 'confirmed-interval-chain');
assert.strictEqual(state.samples.length, 1);

// A volatile poll on the same completed lap must not overwrite confirmed data.
state = updateGapMemory(state, {
  rows: rows().map((row) => row.carNumber === 2 ? { ...row, diff: '30.000' } : row),
  followedCars: ['13'],
  collectedAt: '2026-07-05T10:00:05.000Z'
});
assert.strictEqual(state.viewsByCar['13'].behind.gapMs, 10000);
assert.strictEqual(state.samples.length, 1);

const resumed = JSON.parse(JSON.stringify({ ...state, samples: [], newSamples: [] }));
const afterRestart = updateGapMemory(resumed, {
  rows: rows(),
  followedCars: ['13'],
  collectedAt: '2026-07-05T10:00:10.000Z'
});
assert.strictEqual(afterRestart.confirmedCars['2'].confirmedAt, '2026-07-05T10:00:00.000Z');
assert.strictEqual(afterRestart.newSamples.length, 0, 'restart on the same lap does not duplicate confirmed samples');

// Crossing start/finish commits exactly one fresh value.
state = updateGapMemory(state, {
  rows: rows(11),
  followedCars: ['13'],
  collectedAt: '2026-07-05T10:02:05.000Z'
});
assert.strictEqual(state.viewsByCar['13'].behind.gapMs, 10000);
assert.strictEqual(state.samples.length, 2);

// A rival is hidden from catch output after five of our completed laps in pit,
// and becomes available immediately after returning to RUN.
state = updateGapMemory(state, { rows: rows(12, 'IN'), followedCars: ['13'], collectedAt: '2026-07-05T10:04:05.000Z' });
state = updateGapMemory(state, { rows: rows(16, 'IN'), followedCars: ['13'], collectedAt: '2026-07-05T10:12:05.000Z' });
assert.strictEqual(state.viewsByCar['13'].behind.suppressed, false);
state = updateGapMemory(state, { rows: rows(17, 'IN'), followedCars: ['13'], collectedAt: '2026-07-05T10:14:05.000Z' });
assert.strictEqual(state.viewsByCar['13'].behind.suppressed, true);
state = updateGapMemory(state, { rows: rows(17, 'RUN'), followedCars: ['13'], collectedAt: '2026-07-05T10:14:10.000Z' });
assert.strictEqual(state.viewsByCar['13'].behind.suppressed, false);

// RIS GAP-only mode stores each car's cumulative gap at its own crossing and
// subtracts those confirmed values instead of adding cumulative GAP cells.
const cumulativeRows = [
  { sourceProvider: 'ris-timing', position: 1, carNumber: 1, className: 'PRO', classPosition: 1, lapNumber: 50, gap: '--', lastLap: '2:00.000' },
  { sourceProvider: 'ris-timing', position: 2, carNumber: 33, className: 'CC', classPosition: 1, lapNumber: 50, gap: '20.000', lastLap: '2:05.000' },
  { sourceProvider: 'ris-timing', position: 3, carNumber: 65, className: 'CC', classPosition: 2, lapNumber: 50, gap: '30.000', lastLap: '2:04.000' }
];
const cumulativeState = updateGapMemory({}, {
  rows: cumulativeRows,
  followedCars: ['33'],
  collectedAt: '2026-07-05T11:00:00.000Z'
});
assert.strictEqual(cumulativeState.sourceMode, 'cumulative-gap');
assert.strictEqual(cumulativeState.viewsByCar['33'].behind.gapMs, 10000);
assert.strictEqual(cumulativeState.viewsByCar['33'].behind.source, 'confirmed-cumulative-gap');

// A lapped rival uses a lap-based estimate, even when no numeric interval can
// be summed safely.
const lappedState = updateGapMemory({}, {
  rows: [
    { position: 1, carNumber: 33, className: 'CC', classPosition: 1, lapNumber: 20, lastLap: '2:00.000' },
    { position: 2, carNumber: 65, className: 'CC', classPosition: 2, lapNumber: 18, lastLap: '2:04.000', interval: '2L' }
  ],
  followedCars: ['33'],
  collectedAt: '2026-07-05T11:10:00.000Z'
});
assert.strictEqual(lappedState.viewsByCar['33'].behind.lapGap, 2);
assert.strictEqual(lappedState.viewsByCar['33'].behind.gapMs, 248000);
assert.strictEqual(lappedState.viewsByCar['33'].behind.estimated, true);

// A position change invalidates an old predecessor chain until the affected
// cars cross the line again; stale intervals must never be silently reused.
const lap17Rows = rows(17);
const reorderedRows = [lap17Rows[0], lap17Rows[2], lap17Rows[1]].map((row, index) => ({ ...row, position: index + 1 }));
const reorderedState = updateGapMemory(state, {
  rows: reorderedRows,
  followedCars: ['13'],
  collectedAt: '2026-07-05T11:20:00.000Z'
});
assert.strictEqual(reorderedState.viewsByCar['13'].behind.gapMs, null);
assert.strictEqual(reorderedState.viewsByCar['13'].behind.source, 'unavailable');

// Missing/partial tables remain harmless and preserve explicit configuration.
const emptyState = updateGapMemory(undefined, {
  rows: null,
  followedCars: ['', null, '999'],
  paceWindow: 3,
  pitSuppressionLaps: 2,
  collectedAt: '2026-07-05T11:30:00.000Z'
});
assert.strictEqual(emptyState.paceWindow, 3);
assert.strictEqual(emptyState.pitSuppressionLaps, 2);
assert.strictEqual(emptyState.viewsByCar['999'].available, false);
assert.strictEqual(emptyState.newSamples.length, 0);

const singleCarState = updateGapMemory({}, {
  rows: [{ position: 1, carNumber: 33, className: 'CC', classPosition: 1, laps: 1, lastLapMs: 125000 }],
  followedCars: ['33'],
  collectedAt: '2026-07-05T11:40:00.000Z'
});
assert.strictEqual(singleCarState.viewsByCar['33'].ahead, null);
assert.strictEqual(singleCarState.viewsByCar['33'].behind, null);
assert.deepStrictEqual(singleCarState.viewsByCar['33'].classCoordinates, [{ carNumber: '33', gapToUsMs: 0, estimated: false }]);

// If PIT is first observed before our lap counter exists, the start lap is
// filled in later instead of making suppression impossible forever.
let unknownLapPit = updateGapMemory({}, {
  rows: [
    { position: 1, carNumber: 13, className: 'CC', classPosition: 1, lapNumber: 'bad', lastLap: '--' },
    { position: 2, carNumber: 2, className: 'CC', classPosition: 2, lapNumber: 'bad', state: 'IN', interval: '2.000' }
  ],
  followedCars: ['13'],
  pitSuppressionLaps: 1,
  collectedAt: '2026-07-05T11:50:00.000Z'
});
assert.strictEqual(unknownLapPit.pitByPair['13|2'].sinceFollowedLap, null);
unknownLapPit = updateGapMemory(unknownLapPit, {
  rows: [
    { position: 1, carNumber: 13, className: 'CC', classPosition: 1, lapNumber: 5, lastLap: '2:05.000' },
    { position: 2, carNumber: 2, className: 'CC', classPosition: 2, lapNumber: 5, state: 'IN', interval: '2.000' }
  ],
  followedCars: ['13'],
  pitSuppressionLaps: 1,
  collectedAt: '2026-07-05T11:52:00.000Z'
});
assert.strictEqual(unknownLapPit.pitByPair['13|2'].sinceFollowedLap, 5);
unknownLapPit = updateGapMemory(unknownLapPit, {
  rows: [
    { position: 1, carNumber: 13, className: 'CC', classPosition: 1, lapNumber: 6, lastLap: '2:05.000' },
    { position: 2, carNumber: 2, className: 'CC', classPosition: 2, lapNumber: 6, state: 'IN', interval: '2.000' }
  ],
  followedCars: ['13'],
  pitSuppressionLaps: 1,
  collectedAt: '2026-07-05T11:54:00.000Z'
});
assert.strictEqual(unknownLapPit.viewsByCar['13'].behind.suppressed, true);
assert.strictEqual(unknownLapPit.newSamples.length, 0, 'long-pit rivals are excluded from report gap history');

// Persisted duplicate samples are compacted and the in-memory safety cap is
// enforced for very long races.
const duplicate = { key: '1|2', relation: 'behind', confirmedAt: 'same', gapMs: 1000, lapGap: 0 };
const compacted = updateGapMemory({ samples: [duplicate, { ...duplicate }] }, { rows: [], followedCars: [], collectedAt: 'now' });
assert.strictEqual(compacted.samples.length, 1);
const capped = updateGapMemory({
  samples: Array.from({ length: 5001 }, (_, index) => ({ key: `1|${index}`, relation: 'behind', confirmedAt: String(index), gapMs: index, lapGap: 0 }))
}, { rows: [], followedCars: [], collectedAt: 'later' });
assert.strictEqual(capped.samples.length, 5000);

console.log('Gap memory tests passed');
