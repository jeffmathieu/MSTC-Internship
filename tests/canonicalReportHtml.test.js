const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCanonicalFallbackHtml, printHtmlToPdf } = require('../src/main/stintReports');

const stats = { lapCount: 3, paceLapCount: 2, averageLapMs: 125000, bestLapMs: 124000,
  averageSector1Ms: 40000, averageSector2Ms: 45000, averageSector3Ms: 40000,
  bestSector1Ms: 39500, bestSector2Ms: 44500, bestSector3Ms: 39000, selection: { lap: { excludedCount: 1 } } };
const lineGraph = { title: 'Class lap times', type: 'line', series: [{ name: 'Car <33>', points: [{ x: 1, y: 124000 }, { x: 2, y: 125000 }] }] };
const payload = {
  reportMode: 'race', race: { sessionName: '<Race & summary>', carNumber: '33', className: 'CC' },
  raceSummary: { stats, totalLaps: 3, finalClassPosition: 6, statsByCondition: { combined: stats, dry: stats },
    drivers: [{ driverName: 'John Corbett', ...stats }],
    pitStops: Array.from({ length: 23 }, (_, i) => ({ stopNumber: i + 1, durationMs: 75000, targetDurationMs: 75000, deltaVsTargetMs: 0,
      driverBefore: 'John Corbett', driverAfter: 'Nathan Kumar', driverChanged: true, classPositionAfter: 6 })),
    graphs: { driverLaps: lineGraph, classPacePages: [lineGraph, lineGraph] } },
  stints: [{ driverName: 'John Corbett', stintNumber: 1, stats, laps: [
    { lapNumber: 1, lapTimeMs: 200000, status: 'neutralized' },
    { lapNumber: 2, lapTimeMs: 124000, status: 'valid', lapCondition: 'wet' },
    { lapNumber: 3, lapTimeMs: 126000, status: 'valid' }
  ] }], caveats: ['Timing notes from <stored data>.'], referenceTimes: { lapMs: 125000 }
};
const html = buildCanonicalFallbackHtml(payload, true);

// Stops during a stint carry the engineer's notes: one panel next to the lap chart
// (old reports without notes are unchanged), a continuation page when they do not fit.
const stintWith = (stops, extra = {}) => ({ ...payload, stints: [{ ...payload.stints[0], pitStopsDuring: stops, ...extra }] });
const noteStop = (n, lap, notes) => ({ id: `s${n}`, stopNumber: n, lapNumber: lap, durationMs: 65000, closed: true, notes });
const pageCount = (html) => (html.match(/class="report-page"/g) || []).length;

const singleStop = buildCanonicalFallbackHtml(stintWith([noteStop(2, 20, { fuelAdded: true, tyresChanged: false, tyreSet: 'Set <4>',
  driverNotes: 'Car pushes in slow corners', pitNotes: 'Clean stop' })]), false);
assert.ok(singleStop.toUpperCase().includes('PIT STOP NOTES') && singleStop.includes('Stop 2') && singleStop.includes('Set &lt;4&gt;'), 'notes panel is drawn and escaped');
assert.ok(singleStop.includes('Driver notes: Car pushes in slow corners'));
assert.strictEqual(pageCount(singleStop), 1, 'short notes fit the stint page');

const longText = 'The car understeers on corner entry and the front tyres drop off after twenty laps. '.repeat(6);
const threeStops = buildCanonicalFallbackHtml(stintWith([1, 2, 3].map((n) => noteStop(n, n * 15, { fuelAdded: true, tyresChanged: n === 2, tyreSet: `Set ${n}`,
  driverNotes: longText, pitNotes: `Remark ${n}: ${longText}` }))), false);
assert.ok(pageCount(threeStops) >= 2, 'long notes of several stops continue on an extra page');
['Stop 1', 'Stop 2', 'Stop 3', 'Set 3', 'Remark 3'].forEach((text) => assert.ok(threeStops.includes(text), `${text} is printed`));
assert.ok(threeStops.toUpperCase().includes('PIT STOP NOTES (CONTINUED)') || threeStops.toUpperCase().includes('FULL NOTES ON THE NEXT PAGE'), 'the panel points to the full notes');
const printedWords = (threeStops.match(/the front tyres drop off/g) || []).length;
assert.ok(printedWords >= 6, 'the full text of every note is printed on the continuation page');

const unnoted = buildCanonicalFallbackHtml(stintWith([noteStop(1, 10, null)]), false);
assert.ok(!unnoted.toUpperCase().includes('PIT STOP NOTES'), 'stops without any notes add no panel');
assert.ok(buildCanonicalFallbackHtml(stintWith([], { preliminary: true }), false).includes('PRELIMINARY: stint in progress'), 'running stints are marked preliminary');
assert.ok(!buildCanonicalFallbackHtml(payload, false).toUpperCase().includes('NOTES'), 'stints without stop data keep the original layout');
const pages = [...html.matchAll(/<section class="report-page">([\s\S]*?)<\/section>/g)].map((match) => match[1]);
assert.strictEqual(pages.length, 7, 'race summaries contain overview, two pit pages, one stint, team graphs and two class pages');
assert.ok(pages[0].includes('FULL RACE OVERVIEW') && pages[0].includes('FULL-SESSION PACE STATISTICS'));
assert.ok(pages[0].includes('IDEAL BEST') && pages[0].includes('2:03.000'), 'original overview restores theoretical sector totals');
assert.ok(pages[0].includes('fill="#152238"'), 'the packaged PDF preserves the original navy header');
assert.ok(pages[1].includes('#20') && !pages[1].includes('#21'));
assert.ok(pages[2].includes('#21') && pages[2].includes('#23'), 'every pitstop remains on a readable page');
assert.ok(pages[1].includes('PIC 6'), 'pitstop rejoin classification is preserved');
assert.ok(pages[3].includes('TEAM AND CLASS COMPARISON') && pages[3].includes('STINT ENGINEERING INSIGHTS'));
assert.ok(pages[3].includes('FAST 2:04.000') && !pages[3].includes('3:20.000'), 'the charts exclude neutralized pace samples');
assert.ok(html.includes('&lt;Race &amp; summary&gt;'), 'feed text is escaped in SVG and HTML');
assert.ok(!html.includes('DATA QUALITY AND TIMING NOTES') && !html.includes('&lt;stored data&gt;'), 'reports never include the timing-notes page');
assert.match(html, /@page \{ size: A4 landscape; margin: 0; \}/);
assert.strictEqual((buildCanonicalFallbackHtml(payload, false).match(/class="report-page"/g) || []).length, 1, 'single-stint exports are one analysis page without a timing-notes page');
assert.ok(!buildCanonicalFallbackHtml({ ...payload, reportMode: 'practice' }, true).includes('DATA QUALITY AND TIMING NOTES'), 'no report mode creates the timing-notes page');

module.exports = (async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-portable-report-test-'));
  let loadedPath, destroyed = false;
  class PdfWindow {
    constructor() {
      this.webContents = { printToPDF: async (options) => {
        assert.strictEqual(options.preferCSSPageSize, true);
        assert.deepStrictEqual(options.margins, { top: 0, bottom: 0, left: 0, right: 0 });
        assert.ok(fs.existsSync(loadedPath), 'the document survives until printing completes');
        return Buffer.from('%PDF-portable-test');
      } };
    }
    async loadFile(filename) {
      loadedPath = filename;
      assert.strictEqual(fs.readFileSync(filename, 'utf8'), html);
    }
    isDestroyed() { return destroyed; }
    destroy() { destroyed = true; }
  }
  try {
    const pdfPath = path.join(folder, 'report.pdf');
    await printHtmlToPdf(PdfWindow, html, pdfPath);
    assert.strictEqual(fs.readFileSync(pdfPath, 'utf8'), '%PDF-portable-test');
    assert.strictEqual(fs.existsSync(path.dirname(loadedPath)), false, 'temporary report data is removed after printing');
    assert.strictEqual(destroyed, true);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  console.log('Portable canonical PDF layout tests passed.');
})();
