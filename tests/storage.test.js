const assert = require('assert');
const {
  NORMALIZED_ROW_COLUMNS,
  LAP_HISTORY_COLUMNS,
  normalizeForStorage,
  lapRecordFromNormalizedRow,
  lapIdentity,
  toCsvRows
} = require('../src/shared/storageSchema');

const context = {
  collectedAt: '2026-06-23T10:00:00.000Z',
  timingUrl: 'https://livetiming.getraceresults.com/demo#screen-results',
  session: { sessionName: 'Demo Race' }
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

const getRaceResultsLap = lapRecordFromNormalizedRow(getRaceResultsRow);
const risLap = lapRecordFromNormalizedRow(risRow);
assert.deepStrictEqual(toCsvRows([getRaceResultsLap], LAP_HISTORY_COLUMNS).split('\n')[0].split(','), LAP_HISTORY_COLUMNS);
assert.deepStrictEqual(toCsvRows([risLap], LAP_HISTORY_COLUMNS).split('\n')[0].split(','), LAP_HISTORY_COLUMNS);
assert.strictEqual(getRaceResultsLap.lapTimeMs, '102123');
assert.strictEqual(risLap.sector1Ms, '32100');
assert.strictEqual(lapIdentity(getRaceResultsLap), lapIdentity(lapRecordFromNormalizedRow(getRaceResultsRow)));

console.log('Storage schema tests passed.');
