const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  numericGapMs,
  applyDriverOverrides,
  loadOverrides,
  findPdfPython,
  buildPayload
} = require('../scripts/generate-spa-stint-reports');
const { renderReportLabPdf } = require('../src/main/stintReports');

const history = fs.readFileSync(path.join(__dirname, 'SPA', 'RACE', 'lap_history.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const correctedHistory = applyDriverOverrides(
  history,
  loadOverrides(path.join(__dirname, 'SPA', 'RACE', 'report_driver_overrides.json'))
);
const payload = buildPayload(correctedHistory, '33', history);

assert.strictEqual(payload.race.carNumber, '33');
assert.strictEqual(payload.stints.length, 3);
assert.deepStrictEqual(payload.stints.map((stint) => stint.driverName), [
  'JANSSENS Robbe',
  'DE STRIJKER Kris',
  'DE JONG Alain'
]);
assert.strictEqual(payload.stints[0].startLap, 1);
assert.strictEqual(payload.stints[0].endLap, 23);
assert.deepStrictEqual(payload.stints.map((stint) => stint.stintNumber), [1, 2, 3]);
assert.deepStrictEqual(payload.stints.map((stint) => stint.driverStintNumber), [1, 1, 1], 'driver stint numbers count per driver, not per car stint');
assert.strictEqual(payload.stints[0].stats.paceLapCount, 18);
assert.strictEqual(Math.round(payload.stints[0].stats.averageLapMs), 181357);
assert.strictEqual(Math.round(payload.stints[1].stats.averageLapMs), 198655);
assert.strictEqual(Math.round(payload.stints[2].stats.averageLapMs), 197765);
assert.strictEqual(payload.raceSummary.totalLaps, 62);
assert.strictEqual(payload.raceSummary.pitStops.length, 3);
assert.deepStrictEqual(payload.raceSummary.pitStops.map((stop) => stop.durationMs), [284000, 154000, 286000]);
assert.strictEqual(payload.raceSummary.totalPitTimeMs, 724000);
assert.deepStrictEqual(payload.raceSummary.raceControl, { fcy: 9, safetyCar: 0, redFlag: 0 });
assert.strictEqual(payload.stints[0].laps.find((lap) => lap.lapNumber === 1).sector1Status, 'neutralized');
assert.strictEqual(payload.stints[1].laps.find((lap) => lap.lapNumber === 37).sector1Status, 'neutralized');
assert.strictEqual(payload.stints[1].laps.find((lap) => lap.lapNumber === 37).sector2Status, 'neutralized');
assert.strictEqual(payload.stints[1].laps.find((lap) => lap.lapNumber === 38).status, 'neutralized');
assert.strictEqual(numericGapMs('1:05.031'), 65031);
assert.strictEqual(numericGapMs('1L'), null);
assert.ok(findPdfPython(), 'a Python interpreter with ReportLab should be discoverable');

// CI installs the same pinned ReportLab dependency used by development. This
// smoke test proves that Python discovery, the src renderer and its payload
// contract work together instead of merely checking that an import succeeds.
const renderFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-reportlab-smoke-'));
try {
  const payloadPath = path.join(renderFolder, 'payload.json');
  const pdfPath = path.join(renderFolder, 'stint.pdf');
  const stintWithGaps = {
    ...payload.stints[0],
    gapHistory: [
      { rivalCarNumber: '2', relation: 'ahead', gapMs: 8200, estimated: false, confirmedAt: '2026-07-05T10:00:00.000Z' },
      { rivalCarNumber: '9', relation: 'behind', gapMs: 12600, estimated: false, confirmedAt: '2026-07-05T10:00:05.000Z' },
      { rivalCarNumber: '2', relation: 'ahead', gapMs: 6900, estimated: false, confirmedAt: '2026-07-05T10:03:00.000Z' },
      { rivalCarNumber: '9', relation: 'behind', gapMs: 10800, estimated: true, confirmedAt: '2026-07-05T10:03:05.000Z' }
    ]
  };
  fs.writeFileSync(payloadPath, JSON.stringify({ ...payload, stints: [stintWithGaps] }));
  const rendered = renderReportLabPdf(payloadPath, pdfPath);
  assert.strictEqual(rendered.rendered, true, rendered.error || rendered.reason);
  assert.strictEqual(fs.readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-');
} finally {
  fs.rmSync(renderFolder, { recursive: true, force: true });
}

console.log('Stint report data tests passed.');
