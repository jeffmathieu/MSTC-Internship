const assert = require('assert');
const {
  cleanText,
  canonicalHeader,
  buildHeaderMap,
  parseInteger,
  parseLapTimeToMs,
  formatMs,
  parseTimingRow,
  looksLikeTimingHeaders
} = require('../src/shared/parser');

// Lap-time parsing protects the formats seen in live timing tables and manual
// reference/norm-time inputs. Add new assertions here before expanding parser.js
// to support another provider-specific time format.
assert.strictEqual(parseLapTimeToMs('1:42.112'), 102112);
assert.strictEqual(parseLapTimeToMs('01:42.112'), 102112);
assert.strictEqual(parseLapTimeToMs('4:02.899'), 242899);
assert.strictEqual(parseLapTimeToMs('24:58.345'), 1498345);
assert.strictEqual(parseLapTimeToMs('102.112'), 102112);
assert.strictEqual(parseLapTimeToMs('1:02:034'), 62034);
assert.strictEqual(parseLapTimeToMs('10:02:03.456'), 36123456);
assert.strictEqual(parseLapTimeToMs('1,234'), 1234);
assert.strictEqual(parseLapTimeToMs('In Pit'), null);
assert.strictEqual(parseLapTimeToMs('OUT LAP'), null);
assert.strictEqual(parseLapTimeToMs('abc'), null);
assert.strictEqual(formatMs(102112), '1:42.112');
assert.strictEqual(formatMs(36123456), '10:02:03.456');
assert.strictEqual(formatMs(-102112), '-1:42.112');
assert.strictEqual(formatMs(Number.NaN), '');

assert.strictEqual(cleanText(`  hello\u00a0   timing\nworld  `), 'hello timing world');
assert.strictEqual(canonicalHeader('#'), 'carNumber');
assert.strictEqual(canonicalHeader('Driver in car'), 'driver');
assert.strictEqual(canonicalHeader('Class / PIC'), 'className');
assert.strictEqual(canonicalHeader('Sector 2'), 'sector2');
assert.strictEqual(canonicalHeader('Unmapped Header'), 'unmappedheader');
assert.strictEqual(parseInteger('--'), null);
assert.strictEqual(parseInteger('P12'), 12);
assert.strictEqual(parseInteger('-3 places'), -3);

const duplicateHeaderMap = buildHeaderMap(['NAT', 'NAT', 'Driver']);
assert.strictEqual(duplicateHeaderMap.nationality, 0);
assert.strictEqual(duplicateHeaderMap.nationality_2, 1);
assert.strictEqual(duplicateHeaderMap.driver, 2);

// Representative GetRaceResults row. This verifies that header aliases, duplicate
// NAT columns, timing fields, and lap-number extraction still map correctly.
const headers = ['POS', 'M', 'NR', 'E.T.A.', 'TEAM', 'NAT', 'CAR', 'DRIVER IN CAR', 'NAT', 'CLS', 'PIC', 'GAP', 'DIFF', 'LAST', 'BEST', 'IN', 'SECT-1', 'SECT-2', 'SECT-3', 'PIT'];
const cells = ['6', '●', '33', '01:59', 'Inter Europol Endurance', '🇵🇱', 'Ligier JS P217', 'Nathan Kumar', '🇦🇺', 'LMP2', '6', '10.618', '10.618', '3:24.349', '1:58.735', '5', '42.881', '', '', '2'];
const row = parseTimingRow(headers, cells);
assert.strictEqual(row.position, 6);
assert.strictEqual(row.carNumber, 33);
assert.strictEqual(row.team, 'Inter Europol Endurance');
assert.strictEqual(row.car, 'Ligier JS P217');
assert.strictEqual(row.driver, 'Nathan Kumar');
assert.strictEqual(row.className, 'LMP2');
assert.strictEqual(row.classPosition, 6);
assert.strictEqual(row.lastLapMs, 204349);
assert.strictEqual(row.bestLapMs, 118735);
assert.strictEqual(row.inValue, '5');
assert.strictEqual(row.lapNumber, null);
assert.strictEqual(row.sector1, '42.881');
assert.strictEqual(row.raw.NAT, '🇵🇱');
assert.strictEqual(row.raw.NAT_8, '🇦🇺');
assert.strictEqual(row.headerMap.nationality_2, 8);

const risHeaders = ['POS', '#', 'Cla', 'Drivers on Track', 'INT', 'LAST', 'BEST', 'LAPS', 'S1', 'S2', 'S3'];
const risCells = ['1', '33', 'LMP3', 'Nigel Moore', '1.234', '1:42.123', '1:41.900', '5', '32.100', '39.500', '30.523'];
const risRow = parseTimingRow(risHeaders, risCells);
assert.strictEqual(risRow.carNumber, 33);
assert.strictEqual(risRow.driver, 'Nigel Moore');
assert.strictEqual(risRow.className, 'LMP3');
assert.strictEqual(risRow.interval, '1.234');
assert.strictEqual(risRow.sector1, '32.100');

const fallbackLapHeaders = ['NR', 'TEAM', 'DRIVER', 'IN', 'LAST'];
const fallbackLapRow = parseTimingRow(fallbackLapHeaders, ['12', 'Fallback Team', 'Fallback Driver', '9', '1:40.000']);
assert.strictEqual(fallbackLapRow.inValue, '9');
assert.strictEqual(fallbackLapRow.lapNumber, null);
assert.strictEqual(fallbackLapRow.bestLapMs, null);

const sparseRow = parseTimingRow(['POS', 'NR'], ['?', '--']);
assert.strictEqual(sparseRow.position, null);
assert.strictEqual(sparseRow.carNumber, null);
assert.strictEqual(sparseRow.team, '');

assert.strictEqual(looksLikeTimingHeaders(headers), true);
assert.strictEqual(looksLikeTimingHeaders(['TEAM', 'DRIVER', 'LAST']), false);
assert.strictEqual(looksLikeTimingHeaders(['NR', 'TEAM', 'DRIVER']), true);

console.log('Parser tests passed.');
