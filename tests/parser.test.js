const assert = require('assert');
const {
  cleanText,
  canonicalHeader,
  buildHeaderMap,
  parseInteger,
  parseLapTimeToMs,
  formatMs,
  splitTeamInfo,
  parseTimingRow,
  looksLikeTimingHeaders,
  parseSessionInfo
} = require('../src/shared/parser');

// Lap-time parsing protects the formats seen in live timing tables. Add new
// assertions here before expanding parser.js to support another provider-specific
// time format.
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
assert.strictEqual(canonicalHeader('43.575 | S1'), 'sector1');
assert.strictEqual(canonicalHeader('1:14.821 | S2'), 'sector2');
assert.strictEqual(canonicalHeader('39.376 | S3'), 'sector3');
assert.strictEqual(canonicalHeader('2:50.798 | BEST'), 'bestLap');
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

const risScreenshotHeaders = ['P', 'STATE', 'CLASS', 'PIC', '#', 'TEAM INFO', 'LAPS', 'GAP', 'INT', 'S1', 'S2', 'S3', 'LAST', 'BEST', 'ETA', 'PIT', 'L. PIT'];
const risScreenshotCells = ['12', 'IN', 'C1', '3', '216', 'Zeknova3 by a roule CITROEN C1', '272', '1.350', '1.350', '37.736', '1:19.654', '--', '2:01.000', '1:58.172', '--:--', '9', '0:55'];
const risScreenshotRow = parseTimingRow(risScreenshotHeaders, risScreenshotCells);
assert.strictEqual(risScreenshotRow.position, 12);
assert.strictEqual(risScreenshotRow.state, 'IN');
assert.strictEqual(risScreenshotRow.className, 'C1');
assert.strictEqual(risScreenshotRow.classPosition, 3);
assert.strictEqual(risScreenshotRow.carNumber, 216);
assert.strictEqual(risScreenshotRow.team, 'Zeknova3 by a roule CITROEN C1');
assert.strictEqual(risScreenshotRow.lapNumber, 272);
assert.strictEqual(risScreenshotRow.gap, '1.350');
assert.strictEqual(risScreenshotRow.interval, '1.350');
assert.strictEqual(risScreenshotRow.lastLapMs, 121000);
assert.strictEqual(risScreenshotRow.bestLapMs, 118172);
assert.strictEqual(risScreenshotRow.sector1Ms, 37736);
assert.strictEqual(risScreenshotRow.sector2Ms, 79654);
assert.strictEqual(risScreenshotRow.sector3Ms, null);
assert.strictEqual(risScreenshotRow.pit, '9');
assert.strictEqual(risScreenshotRow.lastPit, '0:55');

// Current Spa RIS layout: session-best values share the sector headers and the
// TEAM INFO cell has team on line one and "driver - car" on line two.
const spaRisHeaders = ['P', 'STATE', 'CLASS', 'PIC', '#', 'TEAM INFO', 'LAPS', 'GAP', '43.575 | S1', '1:14.821 | S2', '39.376 | S3', 'LAST', 'BEST', 'ETA', 'PIT'];
const spaRisCells = ['8', 'RUN', 'C.CHA', '1', '33', 'MSTC | JANSSENS Robbe - Mazda MX-5', '1', '--', '54.998', '--', '--', '35:05.611', '--', '02:17', '--'];
const spaRisRow = parseTimingRow(spaRisHeaders, spaRisCells);
assert.strictEqual(spaRisRow.team, 'MSTC');
assert.strictEqual(spaRisRow.driver, 'JANSSENS Robbe');
assert.strictEqual(spaRisRow.car, 'Mazda MX-5');
assert.strictEqual(spaRisRow.sector1, '54.998');
assert.strictEqual(spaRisRow.sector1Ms, 54998);
assert.strictEqual(spaRisRow.sector2Ms, null);
assert.strictEqual(spaRisRow.sector3Ms, null);
assert.deepStrictEqual(splitTeamInfo('MSTC | JANSSENS Robbe - Mazda MX-5'), {
  team: 'MSTC',
  driver: 'JANSSENS Robbe',
  car: 'Mazda MX-5'
});
assert.deepStrictEqual(splitTeamInfo('MSTC | Mazda MX-5', 'Known Driver', 'Known Car'), {
  team: 'MSTC',
  driver: 'Known Driver',
  car: 'Known Car'
});
assert.deepStrictEqual(splitTeamInfo('MSTC | JANSSENS Robbe - Mazda MX-5', 'Override Driver', 'Override Car'), {
  team: 'MSTC',
  driver: 'Override Driver',
  car: 'Override Car'
});
assert.deepStrictEqual(splitTeamInfo(null), { team: '', driver: '', car: '' });

const risLegacyHeaders = ['POS', 'NOW', 'NUM', 'CAT', '', 'TEAM', 'Drivers', 'S1', 'S2', 'S3', 'Lap', 'GAP', 'Last time', 'PS'];
const risLegacyCells = ['2', 'RUN', '18', 'GT+', '.', 'SPEEDLOVER', 'VERHOEVEN Jay', '30.049', '', '', '27', '17.129', '1:34.175', '.'];
const risLegacyRow = parseTimingRow(risLegacyHeaders, risLegacyCells);
assert.strictEqual(risLegacyRow.position, 2);
assert.strictEqual(risLegacyRow.state, 'RUN');
assert.strictEqual(risLegacyRow.carNumber, 18);
assert.strictEqual(risLegacyRow.className, 'GT+');
assert.strictEqual(risLegacyRow.team, 'SPEEDLOVER');
assert.strictEqual(risLegacyRow.driver, 'VERHOEVEN Jay');
assert.strictEqual(risLegacyRow.lapNumber, 27);
assert.strictEqual(risLegacyRow.gap, '17.129');
assert.strictEqual(risLegacyRow.lastLap, '1:34.175');
assert.strictEqual(risLegacyRow.lastLapMs, 94175);
assert.strictEqual(risLegacyRow.sector1Ms, 30049);
assert.strictEqual(risLegacyRow.bestLapMs, null);
assert.strictEqual(looksLikeTimingHeaders(risLegacyHeaders), true);

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

const risSession = parseSessionInfo({
  title: 'RIS Live Timing',
  location: 'https://results.ris-timing.be/example',
  bodyText: 'LIVE DATA COMPACT FULLSCREEN Ligier Js Cup • Paying Practice Status: GREEN Elapsed: 22:59 Remaining: 02:07:01 09:23:02'
});
assert.strictEqual(risSession.timeToGo, '02:07:01');
assert.strictEqual(risSession.elapsed, '22:59');
assert.strictEqual(risSession.statusText, 'GREEN');
assert.strictEqual(risSession.flag, 'Green flag');
assert.strictEqual(risSession.sessionName, 'Ligier Js Cup - Paying Practice');

const structuredRisSession = parseSessionInfo({
  title: 'RIS Live Timing',
  bodyText: '',
  sessionFields: {
    sessionName: 'Ligier Js Cup - Paying Practice',
    status: 'RED FLAG',
    elapsed: '38:28',
    remaining: '01:51:32'
  }
});
assert.strictEqual(structuredRisSession.sessionName, 'Ligier Js Cup - Paying Practice');
assert.strictEqual(structuredRisSession.timeToGo, '01:51:32');
assert.strictEqual(structuredRisSession.elapsed, '38:28');
assert.strictEqual(structuredRisSession.statusText, 'RED FLAG');
assert.strictEqual(structuredRisSession.flag, 'Red flag');

const risFcySession = parseSessionInfo({
  bodyText: 'Status: FULL COURSE YELLOW Elapsed: 01:12:30 Remaining: 22:47:30'
});
assert.strictEqual(risFcySession.timeToGo, '22:47:30');
assert.strictEqual(risFcySession.elapsed, '01:12:30');
assert.strictEqual(risFcySession.flag, 'Full course yellow');

const getRaceResultsSession = parseSessionInfo({
  bodyText: 'Green flag To go: 01:45:00 Spa Test - Practice Page updated 09:23:02 (UTC)'
});
assert.strictEqual(getRaceResultsSession.timeToGo, '01:45:00');
assert.strictEqual(getRaceResultsSession.sessionName, 'Spa Test - Practice');
assert.strictEqual(getRaceResultsSession.flag, 'Green flag');

const simpleToGoSession = parseSessionInfo({
  bodyText: 'To go: 00:42:15  Timing server connected'
});
assert.strictEqual(simpleToGoSession.timeToGo, '00:42:15');
const safetyCarSession = parseSessionInfo({ sessionFields: { status: 'SAFETY CAR' } });
assert.strictEqual(safetyCarSession.flag, 'Safety car');
const yellowSession = parseSessionInfo({ sessionFields: { status: 'LOCAL YELLOW' } });
assert.strictEqual(yellowSession.flag, 'Yellow flag');
const commonStatusSession = parseSessionInfo({ bodyText: 'Waiting for the LiveTiming data' });
assert.strictEqual(commonStatusSession.statusText, 'Waiting for the LiveTiming data');

console.log('Parser tests passed.');
