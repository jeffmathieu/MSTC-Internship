const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lap } = require('./mockLapHistory');
const { stintsForCar } = require('../src/shared/stintTracker');
const {
  safeFilePart,
  htmlEscape,
  buildStintReportPayload,
  buildCanonicalReportPayload,
  buildStintReportHtml,
  buildEventSummaryHtml,
  artifactPaths,
  writeClosedStintArtifacts,
  writeEventSummaryArtifacts
} = require('../src/main/stintReports');

const history = [
  lap({ carNumber: 33, teamName: 'MSTC & Team', driverName: 'Driver / One', lapNumber: 2, lapTimeMs: 180000, sector1Ms: 55000, sector2Ms: 79000, sector3Ms: 46000, lapCondition: 'dry', sector1Condition: 'dry', sector2Condition: 'dry', sector3Condition: 'dry' }),
  lap({ carNumber: 33, teamName: 'MSTC & Team', driverName: 'Driver / One', lapNumber: 3, lapTimeMs: 240000, sector1Ms: 70000, sector2Ms: 100000, sector3Ms: 70000, sessionFlag: 'FCY', lapCondition: 'transition', sector1Condition: 'dry', sector2Condition: 'transition', sector3Condition: 'wet' }),
  lap({ carNumber: 33, teamName: 'MSTC & Team', driverName: 'Driver Two', lapNumber: 4, lapTimeMs: 181000, sector1Ms: 55000, sector2Ms: 79500, sector3Ms: 46500, pitInfo: '1', lastPit: '1:18', pitTargetDurationMs: '70000', position: 7, classPosition: 3 })
];
const closedStint = stintsForCar(history, 33)[0];
const reportGapSamples = [
  { followedCarNumber: '33', rivalCarNumber: '2', relation: 'ahead', gapMs: 5000, lapGap: 0, confirmedAt: '2026-06-23T11:59:30.000Z' },
  { followedCarNumber: '33', rivalCarNumber: '9', relation: 'behind', gapMs: 7500, lapGap: 0, confirmedAt: '2026-06-23T11:59:40.000Z', suppressed: true },
  { followedCarNumber: '99', rivalCarNumber: '2', relation: 'ahead', gapMs: 1000, confirmedAt: '2026-06-23T11:59:30.000Z' }
];
const payload = buildStintReportPayload(closedStint, { sessionName: 'Spa <Race>' }, reportGapSamples);

assert.strictEqual(safeFilePart('Driver / One'), 'Driver_One');
assert.strictEqual(htmlEscape('<MSTC & "team">'), '&lt;MSTC &amp; &quot;team&quot;&gt;');
assert.strictEqual(payload.stint.laps[0].status, 'valid');
assert.strictEqual(payload.stint.laps[1].status, 'neutralized');
assert.strictEqual(payload.stint.stats.paceLapCount, 1);
assert.strictEqual(payload.stint.laps[0].lapCondition, 'dry');
assert.strictEqual(payload.stint.laps[1].sector3Condition, 'wet');
assert.strictEqual(payload.gapHistory.length, 1);
assert.strictEqual(payload.gapHistory[0].rivalCarNumber, '2');
const html = buildStintReportHtml(payload);
assert.ok(html.includes('Spa &lt;Race&gt;'));
assert.ok(html.includes('Driver / One'));
assert.ok(html.includes('class="neutralized"'));
assert.ok(html.includes('Confirmed class gap'));
assert.ok(html.includes('Lap times'));
assert.ok(buildEventSummaryHtml('Race summary', [payload]).includes('car stint 1'));

const canonical = buildCanonicalReportPayload({
  stints: [closedStint],
  session: { sessionName: 'Spa Race', circuit: 'Spa-Francorchamps' },
  gapSamples: reportGapSamples,
  history,
  carNumber: '33',
  pitRules: { pitStopDurationMs: 75000 }
});
assert.strictEqual(canonical.race.sessionName, 'Spa Race');
assert.strictEqual(canonical.race.circuit, 'Spa-Francorchamps');
assert.strictEqual(canonical.stints.length, 1);
assert.strictEqual(canonical.stints[0].driverName, 'Driver / One');
assert.strictEqual(canonical.stints[0].laps[1].status, 'neutralized');
assert.strictEqual(canonical.stints[0].teammates[0].driverName, 'Driver Two');
assert.strictEqual(canonical.stints[0].statsByCondition.dry.paceLapCount, 1);
assert.strictEqual(canonical.stints[0].statsByCondition.wet.averageSector3Ms, null, 'neutralized wet sectors stay out of report pace');
assert.strictEqual(canonical.stints[0].gapHistory.length, 1, 'suppressed long-pit samples stay out of the PDF');
assert.strictEqual(canonical.raceSummary.statsByCondition.combined.lapCount, 3);
assert.strictEqual(canonical.raceSummary.statsByCondition.transition.lapCount, 1, 'condition overview counts neutralized laps as laps');
assert.strictEqual(canonical.raceSummary.statsByCondition.transition.paceLapCount, 0, 'condition overview averages exclude neutralized laps');
assert.strictEqual(canonical.raceSummary.statsByCondition.wet.lapCount, 0, 'empty conditions remain available for fixed PDF rows');
assert.strictEqual(canonical.raceSummary.pitStops.length, 1);
assert.strictEqual(canonical.raceSummary.pitStops[0].durationMs, 78000);
assert.strictEqual(canonical.raceSummary.pitStops[0].targetDurationMs, 70000);
assert.strictEqual(canonical.raceSummary.pitStops[0].deltaVsTargetMs, 8000);
assert.strictEqual(canonical.raceSummary.pitStops[0].driverChanged, true);
assert.strictEqual(canonical.raceSummary.pitAnalysis.averageDeltaVsTargetMs, 8000);
assert.strictEqual(canonical.stints[0].endPitStop.stopNumber, 1);
assert.strictEqual(canonical.stints[0].endPitStop.classPositionAfter, 3);

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-stint-report-'));
const paths = artifactPaths(output, closedStint);
assert.ok(paths.folder.endsWith(path.join('stints', 'car-33', 'STINT_1_Driver_One')));
assert.ok(paths.pdfPath.endsWith('STINT_1_Driver_One.pdf'));

let printCount = 0;
const fakeCanonicalRenderer = async (jsonPath, pdfPath, options) => {
  printCount += 1;
  const stored = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(Array.isArray(stored.stints), true);
  assert.strictEqual(typeof options.includeSummary, 'boolean');
  fs.writeFileSync(pdfPath, Buffer.from('%PDF-canonical-fake'));
  return { rendered: true, engine: 'reportlab-test' };
};
class FakeBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.webContents = {
      printToPDF: async () => {
        printCount += 1;
        return Buffer.from('%PDF-fake');
      }
    };
  }
  async loadURL(url) { this.url = url; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}

module.exports = (async () => {
  const first = await writeClosedStintArtifacts({
    BrowserWindow: FakeBrowserWindow,
    sessionFolder: output,
    stint: closedStint,
    session: { sessionName: 'Spa Race' },
    history,
    renderPdf: fakeCanonicalRenderer
  });
  assert.strictEqual(first.pdfCreated, true);
  assert.strictEqual(fs.existsSync(first.jsonPath), true);
  assert.strictEqual(fs.existsSync(first.pdfPath), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(first.jsonPath, 'utf8')).stint.stintNumber, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(first.jsonPath, 'utf8')).stint.driverStintNumber, 1);

  const second = await writeClosedStintArtifacts({
    BrowserWindow: FakeBrowserWindow,
    sessionFolder: output,
    stint: closedStint,
    session: { sessionName: 'Spa Race' },
    history,
    renderPdf: fakeCanonicalRenderer
  });
  assert.strictEqual(second.pdfCreated, false, 'existing PDF is not regenerated on every poll');
  assert.strictEqual(printCount, 1);

  const summaries = await writeEventSummaryArtifacts({
    BrowserWindow: FakeBrowserWindow,
    sessionFolder: output,
    carNumber: '33',
    stints: [closedStint],
    session: { sessionName: 'Spa Race' },
    history,
    renderPdf: fakeCanonicalRenderer
  });
  assert.strictEqual(summaries.length, 2, 'race and driver summaries are generated at session end');
  assert.strictEqual(summaries.every((summary) => fs.existsSync(summary.pdfPath)), true);
  assert.strictEqual(printCount, 3);

  const migrationOutput = path.join(output, 'old-layout');
  const oldPaths = artifactPaths(migrationOutput, closedStint);
  fs.mkdirSync(oldPaths.folder, { recursive: true });
  fs.writeFileSync(oldPaths.jsonPath, JSON.stringify({ schemaVersion: 1 }));
  fs.writeFileSync(oldPaths.pdfPath, Buffer.from('%PDF-old-portrait-layout'));
  const migrated = await writeClosedStintArtifacts({
    BrowserWindow: FakeBrowserWindow,
    sessionFolder: migrationOutput,
    stint: closedStint,
    session: { sessionName: 'Spa Race' },
    history,
    renderPdf: fakeCanonicalRenderer
  });
  assert.strictEqual(migrated.pdfCreated, true, 'old automatic reports are regenerated once');
  assert.strictEqual(printCount, 4);
  assert.strictEqual(fs.readFileSync(oldPaths.pdfPath, 'utf8'), '%PDF-canonical-fake');

  const openStint = stintsForCar(history, 33).at(-1);
  const openResult = await writeClosedStintArtifacts({
    BrowserWindow: FakeBrowserWindow,
    sessionFolder: output,
    stint: openStint,
    session: {}
  });
  assert.deepStrictEqual(openResult, { written: false, reason: 'stint-open' });
  console.log('Stint report automation tests passed.');
})();
