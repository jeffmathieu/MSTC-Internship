const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainHarness } = require('./helpers/mainHarness');
const { loadSessionHistory } = require('../src/shared/storageSession');
const { lapIdentity } = require('../src/shared/storageSchema');

module.exports = (async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-p1-regression-'));
  const collectors = [];
  const at = (seconds) => new Date(Date.UTC(2026, 8, 8) + seconds * 1000).toISOString();
  function setup(name) {
    const storageFolder = path.join(folder, name);
    fs.mkdirSync(storageFolder);
    const collector = mainHarness(storageFolder);
    const settings = collector.normalizeSettings({ storageFolder, followedCar: '33', followedCars: ['33'], sessionMode: 'race' });
    collector.setSettings(settings);
    collector.setState({ storageSessionFolder: storageFolder });
    collectors.push(collector);
    return { collector, settings, storageFolder };
  }
  const lap = (number, seconds, time = '2:00.000', extra = {}) => ({ carNumber: '33', sourceProvider: 'test',
    timingUrl: 'https://timing.invalid', driverName: 'A', className: 'A', collectedAt: at(seconds),
    lapNumber: String(number), lastLap: time, sessionFlag: 'Green flag', pitInfo: '0', ...extra });
  const archive = (storageFolder) => loadSessionHistory({ fs, jsonlPath: path.join(storageFolder, 'lap_history.jsonl'), identityForLap: lapIdentity }).entries;
  const snapshot = (number, statusText = '') => ({ location: 'https://timing.invalid', title: 'Race',
    bodyText: statusText, sessionFields: { elapsed: `00:${String(number).padStart(2, '0')}:00`, currentFlag: 'Green flag' },
    tables: [{ tableIndex: 0, headers: ['POS', '#', 'CLASS', 'DRIVER', 'LAPS', 'LAST', 'BEST'], rowCount: 1,
      rows: [['1', '33', 'A', 'A', String(number), '2:00.000', '1:59.000']] }] });
  try {
    const counterFirst = setup('counter-first');
    const { collector: c, settings: s, storageFolder: f } = counterFirst;
    c.updateLapHistory(s, [lap(10, 120)]);
    c.updateLapHistory(s, [lap(11, 240)]);
    const id = c.getState().lapHistory[1].lapId;
    c.updateStoredLapManualStatus({ lapId: id, carNumber: '33', status: 'track-limits' });
    await c.flush();
    c.setState({ lapHistory: c.loadExistingHistory(s) });
    c.updateLapHistory(s, [lap(11, 245, '1:59.000', { sector1: '39.000', sector2: '40.000', sector3: '40.000' })]);
    assert.strictEqual(c.getState().lapHistory.length, 2, 'delayed LAST updates the existing passage');
    const corrected = c.getState().lapHistory[1];
    assert.strictEqual(corrected.lastLap, '1:59.000');
    assert.strictEqual(corrected.lapTimeMs, '119000');
    assert.strictEqual(corrected.sector1Ms, '39000');
    assert.strictEqual(corrected.lapId, id);
    assert.strictEqual(corrected.historySequence, 2);
    assert.strictEqual(corrected.manualLapStatus, 'track-limits', 'timing corrections preserve manual review');
    assert.strictEqual(archive(f)[1].lapTimeMs, '119000', 'corrected timing survives restart');
    c.updateLapHistory(s, [lap(11, 250, '1:59.000')]);
    assert.strictEqual(c.getState().lapHistory.length, 2);
    c.updateLapHistory(s, [lap(12, 360, '1:59.000')]);
    assert.strictEqual(c.getState().lapHistory.length, 3, 'equal consecutive lap times remain distinct');
    c.updateLapHistory(s, [lap(11, 365, '1:59.000')]);
    c.updateLapHistory(s, [lap(12, 370, '1:59.000')]);
    assert.strictEqual(c.getState().lapHistory.length, 3, 'a transient counter regression cannot duplicate a lap');
    assert.strictEqual(fs.readFileSync(path.join(f, 'lap_history.csv'), 'utf8').trim().split('\n').length, 4,
      'CSV appends remain on separate rows after a correction rewrite');

    const lastFirst = setup('last-first');
    lastFirst.collector.updateLapHistory(lastFirst.settings, [lap(10, 120)]);
    lastFirst.collector.updateLapHistory(lastFirst.settings, [lap(10, 235, '1:58.000', { driverName: 'B' })]);
    assert.strictEqual(lastFirst.collector.getState().lapHistory[0].lastLap, '2:00.000', 'LAST-first does not rewrite the preceding lap');
    lastFirst.collector.updateLapHistory(lastFirst.settings, [lap(11, 240, '1:58.000', { driverName: 'B' })]);
    assert.strictEqual(lastFirst.collector.getState().lapHistory.length, 2);
    assert.strictEqual(lastFirst.collector.getState().lapHistory[1].lastLap, '1:58.000');
    assert.strictEqual(lastFirst.collector.getState().lapHistory[1].driverName, 'A', 'preserve driver evidence from before the passage');

    const missing = setup('no-counter');
    missing.collector.updateLapHistory(missing.settings, [lap('', 120)]);
    missing.collector.updateLapHistory(missing.settings, [lap('', 240, '1:59.000')]);
    assert.strictEqual(missing.collector.getState().lapHistory.length, 2, 'feeds without counters still use LAST changes');

    const damaged = setup('damaged');
    damaged.collector.updateLapHistory(damaged.settings, [lap(1, 120)]);
    fs.appendFileSync(path.join(damaged.storageFolder, 'lap_history.jsonl'), '{"carNumber":');
    damaged.collector.setState({ lapHistory: damaged.collector.loadExistingHistory(damaged.settings) });
    assert.strictEqual(damaged.collector.getState().lapHistory.length, 1);
    assert.ok(fs.existsSync(path.join(damaged.storageFolder, 'lap_history.jsonl.corrupt.json')));
    damaged.collector.updateLapHistory(damaged.settings, [lap(2, 240, '1:59.000')]);
    assert.strictEqual(archive(damaged.storageFolder).length, 2);

    for (const blockedFile of ['latest_live_rows.csv', 'parser_debug.json', 'session_metadata.json']) {
      const brokenExport = setup(`blocked-${blockedFile}`);
      fs.mkdirSync(path.join(brokenExport.storageFolder, blockedFile));
      brokenExport.collector.setSnapshot(snapshot(1));
      await brokenExport.collector.pollLivePage();
      brokenExport.collector.setSnapshot(snapshot(2));
      await brokenExport.collector.pollLivePage();
      assert.strictEqual(archive(brokenExport.storageFolder).length, 2, `${blockedFile} failure cannot stop lap recording`);
      assert.ok(brokenExport.collector.getState().errors.length, 'optional export failures remain visible');
      assert.strictEqual(brokenExport.collector.getState().status, 'collecting');
    }

    const failedJournal = setup('failed-journal');
    fs.mkdirSync(path.join(failedJournal.storageFolder, 'lap_history.jsonl'));
    failedJournal.collector.setSnapshot(snapshot(1));
    await failedJournal.collector.pollLivePage();
    assert.strictEqual(failedJournal.collector.getState().status, 'error', 'canonical persistence failures cannot report healthy collection');
    assert.strictEqual(failedJournal.collector.getState().lastSuccessAt, null);
    fs.rmdirSync(path.join(failedJournal.storageFolder, 'lap_history.jsonl'));
    await failedJournal.collector.pollLivePage();
    assert.strictEqual(archive(failedJournal.storageFolder).length, 1, 'retry after a journal failure records the passage once');

    const offline = setup('offline');
    offline.collector.setSnapshot(snapshot(1));
    await offline.collector.pollLivePage();
    const lastSuccess = offline.collector.getState().lastSuccessAt;
    offline.collector.setSnapshot(snapshot(2, 'Not connected to the LiveTiming server'));
    await offline.collector.pollLivePage();
    assert.strictEqual(offline.collector.getState().status, 'disconnected');
    assert.strictEqual(offline.collector.getState().lastSuccessAt, lastSuccess);
    assert.strictEqual(archive(offline.storageFolder).length, 1, 'cached disconnected tables do not produce new laps');
    assert.strictEqual(offline.collector.getState().rows[0].lapNumber, 1, 'retain the last confirmed display');
    assert.strictEqual(offline.collector.getState().pitstopPlan, null, 'cached strategy cannot remain ready during a provider outage');

    // Inject failure after the replacement file was flushed, before rename.
    await c.flush();
    const original = fs.readFileSync(path.join(f, 'lap_history.jsonl'), 'utf8');
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => { if (to === path.join(f, 'lap_history.jsonl')) throw new Error('Injected archive failure'); return rename(from, to); };
      assert.throws(() => c.updateStoredLapManualStatus({ lapId: id, carNumber: '33', status: 'invalid' }), /Injected archive failure/);
    } finally { fs.renameSync = rename; }
    assert.strictEqual(fs.readFileSync(path.join(f, 'lap_history.jsonl'), 'utf8'), original);
    assert.strictEqual(c.getState().lapHistory[1].manualLapStatus, 'track-limits', 'failed manual edits do not publish uncommitted state');

    const correctionFailure = setup('failed-correction');
    correctionFailure.collector.updateLapHistory(correctionFailure.settings, [lap(10, 120)]);
    correctionFailure.collector.updateLapHistory(correctionFailure.settings, [lap(11, 240)]);
    try {
      fs.renameSync = (from, to) => { if (to === path.join(correctionFailure.storageFolder, 'lap_history.jsonl')) throw new Error('Injected correction failure'); return rename(from, to); };
      assert.throws(() => correctionFailure.collector.updateLapHistory(correctionFailure.settings, [lap(11, 245, '1:59.000')]), /Injected correction failure/);
    } finally { fs.renameSync = rename; }
    assert.strictEqual(correctionFailure.collector.getState().lapHistory[1].lastLap, '2:00.000');
    correctionFailure.collector.updateLapHistory(correctionFailure.settings, [lap(11, 250, '1:59.000')]);
    assert.strictEqual(archive(correctionFailure.storageFolder)[1].lastLap, '1:59.000', 'a failed correction can be safely retried');

    const manualCsvFailure = setup('manual-csv-failure');
    manualCsvFailure.collector.updateLapHistory(manualCsvFailure.settings, [lap(1, 120)]);
    fs.unlinkSync(path.join(manualCsvFailure.storageFolder, 'lap_history.csv'));
    fs.mkdirSync(path.join(manualCsvFailure.storageFolder, 'lap_history.csv'));
    const manualId = manualCsvFailure.collector.getState().lapHistory[0].lapId;
    assert.strictEqual(manualCsvFailure.collector.updateStoredLapManualStatus({ lapId: manualId, carNumber: '33', status: 'invalid' }).ok, true);
    assert.strictEqual(archive(manualCsvFailure.storageFolder)[0].manualLapStatus, 'invalid', 'CSV failure does not roll back a committed correction');

    const historical = setup('historical');
    historical.collector.updateLapHistory(historical.settings, [lap(1, 120)]);
    historical.collector.updateLapHistory(historical.settings, [lap(2, 240)]);
    fs.writeFileSync(path.join(historical.storageFolder, 'session_metadata.json'), JSON.stringify({ sessionName: 'Race',
      followedCar: '33', followedCars: ['33'], sessionMode: 'race', lastUpdatedAt: at(245), startedAt: at(0),
      timingUrl: 'https://timing.invalid/historical' }));
    await historical.collector.finalizeCurrentSession();
    assert.strictEqual(historical.collector.getState().stintState.cars['33'].currentStint.stintTimeMs, 245000,
      'finalizing a reopened archive does not include the weeks until report generation');
    const metadataPath = path.join(historical.storageFolder, 'session_metadata.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(metadataPath)).finishedAt, at(245));
    assert.strictEqual(JSON.parse(fs.readFileSync(metadataPath)).startedAt, at(0), 'regeneration preserves session start metadata');
    assert.strictEqual(JSON.parse(fs.readFileSync(metadataPath)).timingUrl, 'https://timing.invalid/historical');
    const report = historical.collector.getState().stintState.generatedStintReports[0];
    const payload = JSON.parse(fs.readFileSync(report.jsonPath));
    assert.strictEqual(payload.stints[0].stintTimeMs, 245000, 'the report worker uses the same session endpoint as the dashboard');
    await historical.collector.finalizeCurrentSession();
    assert.strictEqual(historical.collector.getState().stintState.cars['33'].currentStint.stintTimeMs, 245000,
      'repeated finalization keeps the endpoint stable');
    const today = new Date().toISOString();
    historical.collector.writeSessionMetadata(historical.settings, { collectedAt: today, sourceObservedAt: today,
      session: { flag: 'Finished flag' }, sourceProgressObserved: false });
    assert.strictEqual(JSON.parse(fs.readFileSync(metadataPath)).finishedAt, at(245),
      'reading a finished page again cannot reopen its archived endpoint');
    assert.strictEqual(JSON.parse(fs.readFileSync(metadataPath)).lastUpdatedAt, at(245));
    historical.collector.writeSessionMetadata(historical.settings, { collectedAt: today, sourceObservedAt: today,
      session: { flag: 'Green flag' }, sourceProgressObserved: true });
    assert.strictEqual(JSON.parse(fs.readFileSync(metadataPath)).finishedAt, null, 'actual new source progress reopens collection');
  } finally {
    for (const collector of collectors) await collector.flush();
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log('Collector P1 reliability regression tests passed.');
})();
