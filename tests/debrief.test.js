const assert = require('assert');
const { buildDebriefModel, buildDebriefHtml, notesForStop } = require('../src/main/reports/debriefHtml');
const { buildDrivingStintState } = require('../src/shared/stintTracker');
const { prepareHistory } = require('../src/shared/lapAnalytics');
const { stintComparisonHistory } = require('./mockLapHistory');

const history = prepareHistory(stintComparisonHistory());
const stints = buildDrivingStintState(history, ['33'], '2026-06-23T13:30:00.000Z', { closeFinalAt: '2026-06-23T13:30:00.000Z' }).cars['33'].stints;
const payload = {
  reportMode: 'race',
  race: { sessionName: 'Debrief <Test> & Co', carNumber: '33', teamName: 'Our Team', className: 'LMP3', circuit: 'Spa' },
  raceSummary: {
    finalClassPosition: 3, totalLaps: 50,
    pitStops: [
      { id: '33|a', stopNumber: 1, lapNumber: 20, durationMs: 62000, driverBefore: 'Driver 1', driverAfter: 'Driver 2', deltaVsTargetMs: 2000 },
      { stopNumber: 2, lapNumber: 40, durationMs: 58000, driverBefore: 'Driver 2', driverAfter: 'Driver 3' }
    ],
    pitAnalysis: { averageDurationMs: 60000, slowestStop: { stopNumber: 1, durationMs: 62000 } },
    raceControl: { fcy: 1, safetyCar: 0, redFlag: 0, durationsMs: { fcy: 240000 } },
    graphs: {}
  }
};
const pitNotes = { '33|a': { stopNumber: 1, fuelAdded: true, tyresChanged: true, tyreSet: 'Set 4', driverNotes: 'Car pushes in slow corners', pitNotes: 'Perfect stop' } };

assert.strictEqual(notesForStop(payload.raceSummary.pitStops[0], pitNotes).tyreSet, 'Set 4', 'notes match by pit event id');
assert.strictEqual(notesForStop({ stopNumber: 1 }, pitNotes).tyreSet, 'Set 4', 'and fall back to the stop number');
assert.strictEqual(notesForStop({ stopNumber: 9 }, pitNotes), null);

const model = buildDebriefModel({ payload, history, stints, pitNotes });
assert.strictEqual(model.overview.totals.driverCount, 3);
assert.strictEqual(model.pitStops.length, 2);
assert.ok(model.takeaways.some((line) => line.startsWith('Fastest lap')));
assert.ok(model.takeaways.some((line) => line.includes('Tyres changed at 1/2 stops') && line.includes('Set 4')));
assert.ok(model.takeaways.some((line) => line.startsWith('Race control: FCY 1')));

const html = buildDebriefHtml(model);
assert.strictEqual((html.match(/class="report-page"/g) || []).length, 1, 'the debrief is exactly one page');
for (const text of ['RACE DEBRIEF', 'STINT TIMELINE', 'Driver 1', 'Set 4', 'Perfect stop', 'KEY TAKEAWAYS']) {
  assert.ok(html.toUpperCase().includes(text.toUpperCase()), `debrief contains ${text}`);
}
assert.ok(html.includes('Debrief &lt;Test&gt; &amp; Co') && !html.includes('<Test>'), 'session text is escaped');

const empty = buildDebriefHtml(buildDebriefModel({ payload: { reportMode: 'practice', race: { carNumber: '33' }, raceSummary: {} }, history: [], stints: [] }));
assert.ok(empty.includes('PRACTICE DEBRIEF') && empty.includes('No completed stints yet'), 'an empty session still produces a valid page');

console.log('Debrief tests passed.');
