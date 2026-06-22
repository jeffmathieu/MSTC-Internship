const assert = require('assert');
const { parseLapTimeToMs, formatMs, parseTimingRow } = require('../src/shared/parser');

assert.strictEqual(parseLapTimeToMs('1:42.112'), 102112);
assert.strictEqual(parseLapTimeToMs('01:42.112'), 102112);
assert.strictEqual(parseLapTimeToMs('4:02.899'), 242899);
assert.strictEqual(parseLapTimeToMs('24:58.345'), 1498345);
assert.strictEqual(parseLapTimeToMs('102.112'), 102112);
assert.strictEqual(parseLapTimeToMs('In Pit'), null);
assert.strictEqual(formatMs(102112), '1:42.112');

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
assert.strictEqual(row.lapNumber, 5);
assert.strictEqual(row.sector1, '42.881');

console.log('Parser tests passed.');
