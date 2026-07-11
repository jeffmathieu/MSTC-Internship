const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const analytics = require('../src/shared/lapAnalytics');
const { findPdfPython, renderReportLabPdf } = require('../src/main/stintReports');
const {
  OUR_CAR,
  conditionForLap,
  buildConditionExampleStint,
  buildConditionExamplePayload
} = require('./fixtures/conditionStintExample');

assert.strictEqual(conditionForLap(1), 'wet');
assert.strictEqual(conditionForLap(7), 'wet');
assert.strictEqual(conditionForLap(8), 'dry');
assert.strictEqual(conditionForLap(13), 'wet');
assert.strictEqual(conditionForLap(20), 'dry');
assert.strictEqual(conditionForLap(25), 'transition');
assert.strictEqual(conditionForLap(30), 'dry');

const { history, stint } = buildConditionExampleStint();
assert.strictEqual(stint.carNumber, OUR_CAR);
assert.strictEqual(stint.driverName, 'Condition Tester');
assert.strictEqual(stint.laps.length, 30);
assert.strictEqual(stint.closed, true);

const combinedStats = analytics.statsForLaps(stint.laps);
assert.strictEqual(combinedStats.lapCount, 30);
assert.strictEqual(combinedStats.paceLapCount, 30);
assert.strictEqual(combinedStats.selection.lap.excludedCount, 0);

const byCondition = analytics.statsByCondition(stint.laps);
assert.strictEqual(byCondition.wet.lapCount, 16);
assert.strictEqual(byCondition.wet.paceLapCount, 16);
assert.strictEqual(byCondition.dry.lapCount, 10);
assert.strictEqual(byCondition.dry.paceLapCount, 10);
assert.strictEqual(byCondition.transition.lapCount, 4);
assert.strictEqual(byCondition.transition.paceLapCount, 4);
assert.ok(byCondition.wet.averageLapMs > byCondition.dry.averageLapMs, 'wet laps are intentionally slower than dry laps');
assert.ok(byCondition.transition.averageLapMs > byCondition.dry.averageLapMs, 'transition laps stay separate from dry pace');

assert.strictEqual(analytics.statsForLaps(stint.laps, { conditionFilter: 'dry' }).averageSector1Ms, byCondition.dry.averageSector1Ms);
assert.strictEqual(analytics.statsForLaps(stint.laps, { conditionFilter: 'wet' }).averageSector2Ms, byCondition.wet.averageSector2Ms);
assert.strictEqual(analytics.statsForLaps(stint.laps, { conditionFilter: 'transition' }).averageSector3Ms, byCondition.transition.averageSector3Ms);

const payload = buildConditionExamplePayload();
const reportStint = payload.stints[0];
assert.strictEqual(payload.race.carNumber, OUR_CAR);
assert.strictEqual(reportStint.laps.length, 30);
assert.strictEqual(reportStint.laps[0].lapCondition, 'wet');
assert.strictEqual(reportStint.laps[7].lapCondition, 'dry');
assert.strictEqual(reportStint.laps[24].lapCondition, 'transition');
assert.strictEqual(reportStint.statsByCondition.wet.paceLapCount, 16);
assert.strictEqual(reportStint.statsByCondition.dry.paceLapCount, 10);
assert.strictEqual(reportStint.statsByCondition.transition.paceLapCount, 4);
assert.strictEqual(reportStint.statsByCondition.combined.paceLapCount, 30);
assert.ok(reportStint.classComparisons.length >= 2, 'same-class rivals during the stint are included');
assert.ok(reportStint.teammates.length >= 1, 'other team-driver data is included for comparison');
assert.match(reportStint.insights.compliance.lap.label, /^\d+\/30 safe$/);
assert.match(reportStint.insights.compliance.sector1.label, /^\d+\/30 safe$/);
assert.ok(Number.isFinite(reportStint.insights.bestTheoreticalLapMs));
assert.ok(Number.isFinite(reportStint.insights.averageTheoreticalLapMs));

// Rendering is optional in CI because ReportLab may not be installed there, but
// when the renderer is available this exercises the same canonical PDF path as
// the app and validates that a non-empty PDF is created from condition data.
const python = findPdfPython();
if (python) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-condition-report-test-'));
  const jsonPath = path.join(folder, 'condition-example.json');
  const pdfPath = path.join(folder, 'condition-example.pdf');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const rendered = renderReportLabPdf(jsonPath, pdfPath, { python });
  assert.strictEqual(rendered.rendered, true);
  assert.ok(fs.statSync(pdfPath).size > 12000, 'rendered report should contain charts and report content');
}

console.log('Condition stint report tests passed.');
