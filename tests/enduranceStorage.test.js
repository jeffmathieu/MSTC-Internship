const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainHarness } = require('./helpers/mainHarness');
const { createReportQueue } = require('../src/main/reportQueue');
const { lapIdentity } = require('../src/shared/storageSchema');
const { loadSessionHistory } = require('../src/shared/storageSession');

module.exports = (async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-endurance-storage-'));
  const collector = mainHarness(folder);
  const settings = collector.normalizeSettings({ storageFolder: folder, followedCar: '33', followedCars: ['33'], sessionMode: 'race' });
  collector.setSettings(settings);
  collector.setState({ storageSessionFolder: folder });
  const lap = (number, time = '2:00.000') => ({ carNumber: '33', sourceProvider: 'test', timingUrl: 'https://timing.invalid',
    driverName: 'Peter Bens', className: 'A', collectedAt: new Date(Date.UTC(2026, 8, 7) + number * 120000).toISOString(),
    lapNumber: String(number), lastLap: time, sessionFlag: 'Green flag', pitInfo: '0' });
  try {
    collector.updateLapHistory(settings, [lap(1)]);
    collector.updateLapHistory(settings, [lap(2)]);
    assert.strictEqual(collector.getState().lapHistory.length, 2, 'identical consecutive laptimes with different counters are retained');
    collector.updateLapHistory(settings, [lap(2)]);
    assert.strictEqual(collector.getState().lapHistory.length, 2);
    const restored = collector.loadExistingHistory(settings);
    collector.setState({ lapHistory: restored });
    collector.updateLapHistory(settings, [lap(2)]);
    assert.strictEqual(collector.getState().lapHistory.length, 2, 'reopening the same feed is not a new passage');
    collector.updateLapHistory(settings, [lap(3, '1:59.000')]);
    const target = collector.getState().lapHistory[0];
    collector.updateStoredLapManualStatus({ lapId: target.lapId, carNumber: '33', status: 'track-limits' });
    assert.strictEqual(collector.getState().lapHistory[0].manualLapStatus, 'track-limits');
    assert.strictEqual(collector.getState().lapHistory[1].manualLapStatus, '');
    await collector.flush();
    const data = loadSessionHistory({ fs, jsonlPath: path.join(folder, 'lap_history.jsonl'), identityForLap: lapIdentity });
    assert.strictEqual(data.entries.length, 3);

    // Exercise the actual worker, archive reload and PDF engine, not a mocked
    // payload builder. Even while generating a PDF the parent event loop runs.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const queue = createReportQueue(async () => { throw new Error('This test requires the available ReportLab runtime'); });
    let report;
    try {
      report = await queue.enqueue('test-final', { sessionFolder: folder, carNumber: '33', final: true,
        session: { sessionName: '24h Regression' }, stintOptions: { closeFinalAt: '2026-09-08T00:00:00Z' }, pitEvents: [] });
    } finally { clearInterval(timer); }
    assert.ok(ticks > 0, 'PDF work does not block the collector event loop');
    assert.ok(report.summaries.length >= 2);
    const json = JSON.parse(fs.readFileSync(path.join(folder, 'stints/car-33/RACE_SUMMARY.json'), 'utf8'));
    assert.strictEqual(json.raceSummary.totalLaps, 3);
    assert.strictEqual(fs.readFileSync(report.summaries[0].pdfPath).subarray(0, 5).toString(), '%PDF-');
  } finally {
    await collector.flush();
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log('Endurance archive, manual correction, resume and report worker tests passed.');
})();
