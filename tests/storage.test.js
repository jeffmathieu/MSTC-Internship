const assert = require('assert');
const {
  NORMALIZED_ROW_COLUMNS,
  LAP_HISTORY_COLUMNS,
  normalizeForStorage,
  lapRecordFromNormalizedRow,
  lapIdentity,
  toCsvRows,
  detectSourceProvider
} = require('../src/shared/storageSchema');

const context = {
  collectedAt: '2026-06-23T10:00:00.000Z',
  timingUrl: 'https://livetiming.getraceresults.com/demo#screen-results',
  session: { sessionName: 'Demo Race', flag: 'Full Course Yellow' }
};

const getRaceResultsRow = normalizeForStorage({
  position: 1,
  carNumber: 33,
  team: 'Inter Europol Competition',
  car: 'Ligier JS P217',
  driver: 'Nigel Moore',
  className: 'LMP3',
  classPosition: 1,
  diff: '1.234',
  lastLap: '1:42.123',
  bestLap: '1:41.900',
  lapNumber: 5,
  sector1: '32.100',
  sector2: '39.500',
  sector3: '30.523',
  raw: { NR: '33', 'DRIVER IN CAR': 'Nigel Moore' }
}, context);

const risRow = normalizeForStorage({
  position: '1',
  carNumber: '33',
  teamName: 'Inter Europol Competition',
  driverName: 'Nigel Moore',
  className: 'LMP3',
  interval: '1.234',
  lastLap: '1:42.123',
  bestLap: '1:41.900',
  lapNumber: '5',
  sector1: '32.100',
  sector2: '39.500',
  sector3: '30.523',
  raw: { '#': '33', 'Drivers on Track': 'Nigel Moore', INT: '1.234' }
}, { ...context, timingUrl: 'https://example.com/ris-timing/live' });

assert.deepStrictEqual(toCsvRows([getRaceResultsRow]).split('\n')[0].split(','), NORMALIZED_ROW_COLUMNS);
assert.deepStrictEqual(toCsvRows([risRow]).split('\n')[0].split(','), NORMALIZED_ROW_COLUMNS);
assert.strictEqual(getRaceResultsRow.sourceProvider, 'getraceresults');
assert.strictEqual(risRow.sourceProvider, 'ris-timing');
assert.strictEqual(getRaceResultsRow.carNumber, '33');
assert.strictEqual(risRow.carNumber, '33');
assert.strictEqual(risRow.carModel, '');
assert.strictEqual(risRow.diff, '1.234');
assert.strictEqual(risRow.interval, '1.234');
assert.strictEqual(risRow.sessionName, 'Demo Race');
assert.strictEqual(risRow.sessionFlag, 'Full Course Yellow');

const fallbackContextRow = normalizeForStorage({
  movement: 'up',
  carNumberRaw: '007',
  team: 'Team, With "Quotes"',
  driver: 'Driver\nNewline',
  car: 'Prototype',
  pit: 'P1',
  interval: '2.500',
  lapFlag: 'Green flag',
  sector1Flag: 'Green flag',
  paceEligible: false,
  sector1Eligible: true,
  raw: 'not-an-object'
}, {
  collectedAt: '2026-06-23T11:00:00.000Z',
  timingUrl: 'https://example.com/live',
  session: { statusText: 'Waiting for race' },
  sessionFlag: 'Safety car'
});
assert.strictEqual(fallbackContextRow.sourceProvider, 'unknown');
assert.strictEqual(fallbackContextRow.sessionName, 'Waiting for race');
assert.strictEqual(fallbackContextRow.state, 'up');
assert.strictEqual(fallbackContextRow.carNumber, '007');
assert.strictEqual(fallbackContextRow.teamName, 'Team, With "Quotes"');
assert.strictEqual(fallbackContextRow.driverName, 'Driver\nNewline');
assert.strictEqual(fallbackContextRow.carModel, 'Prototype');
assert.strictEqual(fallbackContextRow.pitInfo, 'P1');
assert.strictEqual(fallbackContextRow.diff, '2.500');
assert.strictEqual(fallbackContextRow.interval, '2.500');
assert.strictEqual(fallbackContextRow.lapFlag, 'Green flag');
assert.strictEqual(fallbackContextRow.sector1Flag, 'Green flag');
assert.strictEqual(fallbackContextRow.paceEligible, 'false');
assert.strictEqual(fallbackContextRow.sector1Eligible, 'true');
assert.deepStrictEqual(fallbackContextRow.raw, {});

const getRaceResultsLap = lapRecordFromNormalizedRow(getRaceResultsRow);
const risLap = lapRecordFromNormalizedRow(risRow);
assert.deepStrictEqual(toCsvRows([getRaceResultsLap], LAP_HISTORY_COLUMNS).split('\n')[0].split(','), LAP_HISTORY_COLUMNS);
assert.deepStrictEqual(toCsvRows([risLap], LAP_HISTORY_COLUMNS).split('\n')[0].split(','), LAP_HISTORY_COLUMNS);
assert.strictEqual(getRaceResultsLap.lapTimeMs, '102123');
assert.strictEqual(risLap.sector1Ms, '32100');
assert.strictEqual(getRaceResultsLap.sessionFlag, 'Full Course Yellow');
assert.ok(LAP_HISTORY_COLUMNS.includes('sessionFlag'));
assert.ok(LAP_HISTORY_COLUMNS.includes('sector1Eligible'));
assert.strictEqual(lapIdentity(getRaceResultsLap), lapIdentity(lapRecordFromNormalizedRow(getRaceResultsRow)));

const invalidLap = lapRecordFromNormalizedRow({ lastLap: 'IN PIT', bestLap: '--', sector1: '?', sessionFlag: 'Safety car' });
assert.strictEqual(invalidLap.lapTimeMs, '');
assert.strictEqual(invalidLap.bestLapMs, '');
assert.strictEqual(invalidLap.sector1Ms, '');
assert.strictEqual(invalidLap.lapFlag, 'Safety car');

const csvWithEscapes = toCsvRows([fallbackContextRow]);
assert.ok(csvWithEscapes.includes('"Team, With ""Quotes"""'));
assert.ok(csvWithEscapes.includes('"Driver\nNewline"'));

const noLapNumberIdentity = lapIdentity({
  sourceProvider: 'unknown',
  timingUrl: 'https://example.com/live',
  sessionName: 'Demo',
  carNumber: '7',
  driverName: 'Fallback Driver',
  collectedAt: '2026-06-23T12:00:00.000Z',
  lastLap: '1:40.000',
  sector1: '30.000',
  sector2: '40.000',
  sector3: '30.000'
});
assert.strictEqual(noLapNumberIdentity, 'unknown|https://example.com/live|Demo|7|Fallback Driver|1:40.000');
assert.strictEqual(detectSourceProvider({ sourceProvider: 'manual-provider', timingUrl: 'https://livetiming.getraceresults.com' }), 'manual-provider');
assert.strictEqual(detectSourceProvider({ timingUrl: 'https://example.com/RISTiming/live' }), 'ris-timing');
assert.strictEqual(detectSourceProvider({}), 'unknown');

console.log('Storage schema tests passed.');
