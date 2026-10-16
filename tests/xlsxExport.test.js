const assert = require('assert');
const zlib = require('zlib');
const { crc32 } = require('../src/main/export/zipWriter');
const { buildSessionWorkbook } = require('../src/main/export/sessionWorkbook');
const { Workbook, columnName, excel } = require('../src/main/export/xlsxWriter');
const { prepareHistory, lapPaceEligible } = require('../src/shared/lapAnalytics');
const { buildDrivingStintState } = require('../src/shared/stintTracker');
const { stintComparisonHistory } = require('./mockLapHistory');

// Reads a zip back through its central directory, inflating and CRC-checking every part.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'zip end record present');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const parts = {};
  for (let i = 0; i < count; i += 1) {
    assert.strictEqual(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const body = buffer.subarray(localOffset + 30 + localNameLength, localOffset + 30 + localNameLength + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.strictEqual(crc32(data), crc, `${name} checksum matches`);
    parts[name] = data.toString('utf8');
    offset += 46 + nameLength;
  }
  return parts;
}

assert.strictEqual(columnName(0), 'A');
assert.strictEqual(columnName(25), 'Z');
assert.strictEqual(columnName(26), 'AA');
assert.strictEqual(excel.duration(86400000), 1);
assert.strictEqual(excel.duration(null), null);

const history = prepareHistory(stintComparisonHistory());
const stintState = buildDrivingStintState(history, ['33'], '2026-06-23T13:30:00.000Z', { closeFinalAt: '2026-06-23T13:30:00.000Z' });
const events = [{ id: '33|a', carNumber: '33', stopNumber: 1, entryAt: '2026-06-23T12:20:00.000Z', exitAt: '2026-06-23T12:21:05.000Z', lapNumber: 20,
  driverBefore: 'Driver 1', driverAfter: 'Driver 2', durationMs: 65000, closed: true }];
const buffer = buildSessionWorkbook({
  sessionName: 'Test <Race> & "Co"', mode: 'race', followedCars: ['33'], history, stintStateCars: stintState.cars,
  pitEventsByCar: { 33: events },
  pitNotesByCar: { 33: { '33|a': { fuelAdded: true, tyresChanged: false, tyreSet: '=HYPERLINK("x")', driverNotes: 'Pushes <hard>', pitNotes: 'ok' } } },
  fieldCars: [{ carNumber: '2', className: 'LMP3', teamName: 'Best Class Car', lapCount: 20, paceLapCount: 18, bestLapMs: 99000 }]
});
const parts = readZip(buffer);

const workbookXml = parts['xl/workbook.xml'];
['Summary', 'Green laps', 'All laps', 'Drivers', 'Stints', 'Pit stops', 'Field', 'Chart data #33', 'Charts #33']
  .forEach((name) => assert.ok(workbookXml.includes(`name="${name}"`), `sheet ${name} exists`));
assert.ok(parts['[Content_Types].xml'].includes('/xl/charts/chart1.xml'));
assert.ok(Object.keys(parts).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name)).length >= 5, 'native charts are written');
assert.ok(parts['xl/charts/chart1.xml'].includes('<c:lineChart>') && parts['xl/charts/chart1.xml'].includes('numCache'), 'charts carry cached data');

const sheetFor = (name) => {
  const id = workbookXml.match(new RegExp(`<sheet name="${name}" sheetId="(\\d+)"`))[1];
  return parts[`xl/worksheets/sheet${id}.xml`];
};
const rowCount = (xml) => (xml.match(/<row /g) || []).length;
const carLapCount = history.filter((lap) => lap.carNumber === '33').length;
const greenCount = history.filter((lap) => lap.carNumber === '33' && lapPaceEligible(lap)).length;
assert.strictEqual(rowCount(sheetFor('All laps')), carLapCount + 1, 'every lap of the followed car is listed (plus the header)');
assert.strictEqual(rowCount(sheetFor('Green laps')), greenCount + 1, 'only pace-eligible laps are on the green-flag sheet');
assert.ok(greenCount < carLapCount || greenCount > 0);
assert.strictEqual(rowCount(sheetFor('Drivers')), 4, 'one row per driver plus the header');

assert.ok(workbookXml.includes('Charts #33'));
const summary = sheetFor('Summary');
assert.ok(summary.includes('Test &lt;Race&gt; &amp; &quot;Co&quot;') && !summary.includes('<Race>'), 'text is XML-escaped');
const pit = sheetFor('Pit stops');
assert.ok(pit.includes('t="inlineStr"') && pit.includes('=HYPERLINK'), 'text starting with = is stored as text');
assert.ok(!pit.includes('<f>'), 'no cell is ever a formula');
assert.ok(pit.includes('Pushes &lt;hard&gt;'));

// Safe names and an empty session still produce a valid package.
const wb = new Workbook();
assert.strictEqual(wb.addSheet('a/b:c').name, 'a b c');
assert.notStrictEqual(wb.addSheet('Sheet').name, wb.addSheet('Sheet').name, 'duplicate sheet names are made unique');
const empty = readZip(buildSessionWorkbook({ followedCars: ['4'], history: [] }));
assert.ok(empty['xl/workbook.xml'].includes('Summary') && empty['xl/workbook.xml'].includes('Charts #4'), 'an empty session still exports');

console.log('Excel export tests passed.');
