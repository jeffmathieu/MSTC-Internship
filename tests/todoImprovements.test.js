const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
const { mainHarness } = require('./helpers/mainHarness');
const { localPageAllowed, remoteNavigationAllowed, secureContents, trustedSender } = require('../src/main/windowSecurity');
const { setupAppLifecycle } = require('../src/main/appLifecycle');
const { nextRaceControlEvent, summarizeRaceControl } = require('../src/shared/raceControl');
const { followedClassesCompletion, automaticCompletionReason, updateFinishCountdown } = require('../src/shared/sessionCompletion');
const { updateSessionTiming } = require('../src/shared/sessionTiming');
const { toCsvRows } = require('../src/shared/storageSchema');
const { prepareHistory } = require('../src/shared/lapAnalytics');
const { buildDrivingStintState, drivingStintsForCar } = require('../src/shared/stintTracker');
const graphData = require('../src/shared/graphData');
const reports = require('../src/main/stintReports');

module.exports = (async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-todo-tests-'));
  const at = (seconds) => new Date(Date.UTC(2026, 8, 8) + seconds * 1000).toISOString();
  const rendererFolder = path.resolve(__dirname, '../src/renderer');
  try {
    const local = pathToFileURL(path.join(rendererFolder, 'index.html')).href;
    assert.strictEqual(localPageAllowed(`${local}?car=33`, rendererFolder), true);
    for (const bad of ['https://timing.invalid/index.html', pathToFileURL(path.join(folder, 'index.html')).href, 'javascript:alert(1)']) {
      assert.strictEqual(localPageAllowed(bad, rendererFolder), false);
    }
    assert.strictEqual(remoteNavigationAllowed('https://timing.invalid/results', 'https://timing.invalid/'), true);
    assert.strictEqual(remoteNavigationAllowed('https://timing.invalid/results', 'http://timing.invalid/'), true);
    assert.strictEqual(remoteNavigationAllowed('https://other.invalid/', 'https://timing.invalid/'), false);
    assert.strictEqual(remoteNavigationAllowed('file:///etc/passwd', 'https://timing.invalid/'), false);
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = (callback) => { contents.openWindow = callback; };
    contents.session = { setPermissionRequestHandler: (handler) => { contents.permission = handler; },
      setPermissionCheckHandler: (handler) => { contents.check = handler; } };
    secureContents(contents, (url) => localPageAllowed(url, rendererFolder));
    assert.deepStrictEqual(contents.openWindow({ url: local }), { action: 'deny' });
    let denied = false;
    contents.emit('will-navigate', { preventDefault: () => { denied = true; } }, 'https://evil.invalid');
    assert.strictEqual(denied, true);
    contents.permission(null, 'media', (allowed) => assert.strictEqual(allowed, false));
    assert.strictEqual(contents.check(), false);
    const frame = { url: local };
    contents.mainFrame = frame;
    const win = { webContents: contents, isDestroyed: () => false };
    assert.strictEqual(trustedSender({ sender: contents, senderFrame: frame }, [win], rendererFolder), true);
    assert.strictEqual(trustedSender({ sender: contents, senderFrame: { url: local } }, [win], rendererFolder), false, 'subframes cannot use privileged IPC');
    assert.strictEqual(trustedSender({ sender: contents, senderFrame: frame }, [], rendererFolder), false);

    let bridge;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8'), {
      require: (name) => { assert.strictEqual(name, 'electron', 'sandboxed preload uses no local CommonJS require');
        return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
          ipcRenderer: { invoke: async () => ({ transportSequence: 1, historyPatch: { from: 0, items: [{ carNumber: '33' }] } }), on() {}, removeListener() {} } }; }
    });
    assert.strictEqual((await bridge.getCollectorState()).lapHistory[0].carNumber, '33');

    const csv = toCsvRows([{ teamName: ' =HYPERLINK("https://evil")', driverName: '\t+SUM(1,2)',
      lapTimeMs: '-120000', gap: '@evil', carNumber: '33' }], ['teamName', 'driverName', 'lapTimeMs', 'gap', 'carNumber']);
    assert.ok(csv.includes("'=HYPERLINK"));
    assert.ok(csv.includes("'+SUM"));
    assert.ok(csv.includes(",-120000,'@evil,33"), 'real numeric fields retain their numeric value');
    assert.strictEqual(reports.formatMs(null), '—');
    assert.strictEqual(reports.formatMs(''), '—');
    assert.strictEqual(reports.formatMs(0), '0:00.000');
    const gaps = reports.gapSamplesForStint([{ followedCarNumber: '33', confirmedAt: at(2), gapMs: null, lapGap: '' }],
      { carNumber: '33', startedAt: at(0), closedAt: at(10) });
    assert.strictEqual(gaps[0].gapMs, null);
    assert.strictEqual(gaps[0].lapGap, null);
    assert.strictEqual(updateSessionTiming(null, {}, [{ historySequence: 1, lapTimeMs: 120000, collectedAt: at(120) }], at(120)).started, true);

    const rows = [{ carNumber: '33', className: 'A', eta: 'Finished', lastLapMs: 100000 },
      { carNumber: '7', className: 'B', eta: 'RUN', lastLapMs: 240000 }];
    const completion = followedClassesCompletion(rows, ['33', '7']);
    assert.strictEqual(completion.complete, false);
    assert.strictEqual(automaticCompletionReason(completion, { expired: true }), '', 'countdown cannot stop a running followed class');
    assert.strictEqual(automaticCompletionReason(followedClassesCompletion(rows, ['33', '999']), { expired: true }), '');
    assert.strictEqual(followedClassesCompletion(rows.map((row) => ({ ...row, eta: 'Finished' })), ['33', '7']).complete, true);
    assert.strictEqual(updateFinishCountdown(null, { nowMs: 1000, rows, slowestFollowedLapMs: 240000,
      primaryAverageLapMs: 100000 }).baseLapMs, 240000);

    const events = [];
    for (const [seconds, flag] of [[0, 'Green'], [5, 'FCY'], [8, 'Green'], [10, 'Safety car'], [15, 'Green']]) {
      const event = nextRaceControlEvent(events.at(-1), { flag }, at(seconds));
      if (event) events.push(event);
    }
    const control = summarizeRaceControl(events, at(20));
    assert.strictEqual(control.fcy, 1);
    assert.strictEqual(control.safetyCar, 1);
    assert.deepStrictEqual(control.durationsMs, { fcy: 3000, safetyCar: 5000, redFlag: 0 }, 'short periods survive even without a completed lap');

    const lap = (sequence, seconds, extra = {}) => ({ carNumber: '33', className: 'A', driverName: 'A', lapNumber: '',
      historySequence: sequence, lapNumberSource: 'observed-sequence', collectedAt: at(seconds), lastLap: '2:00.000',
      lapTimeMs: 120000, sector1Ms: 40000, sector2Ms: 40000, sector3Ms: 40000, sessionFlag: 'Green', ...extra });
    const history = prepareHistory([lap(10, 120), lap(11, 240, { sessionFlag: 'FCY' }), lap(12, 360)]);
    const graph = graphData.classPaceComparison(history, '33');
    assert.deepStrictEqual(graph.series[0].points.map((point) => point.x), [10, 12]);
    assert.ok(graph.series[0].points[1].label.includes('Observed passage 12'));
    assert.strictEqual(graph.series[0].points[1].deltaToOurCarMs, null, 'observed passages from different cars are not official lap alignment');
    assert.deepStrictEqual(graphData.rollingAveragePoints(history).map((point) => point.x), [10, 12]);

    const counterStop = { carNumber: '33', closed: true, partial: true, exitAt: at(240), entryAt: null,
      stopNumber: 1, durationMs: 60000, totalDurationMs: null };
    const driving = drivingStintsForCar(history, '33', { generatedAt: at(360), pitEvents: [counterStop] });
    assert.strictEqual(driving[0].stintTimeMs, 300000, 'known counter-only pit duration is excluded from driving');
    assert.strictEqual(driving[0].drivingTimeEstimated, true);
    let paused = buildDrivingStintState(history, ['33'], at(400), { liveRows: [{ carNumber: '33', driver: 'A', state: 'F' }] });
    const firstTime = paused.cars['33'].currentStint.stintTimeMs;
    paused = buildDrivingStintState(history, ['33'], at(500), { previousState: paused, liveRows: [{ carNumber: '33', driver: 'A', state: 'P' }] });
    assert.strictEqual(paused.cars['33'].currentStint.stintTimeMs, firstTime, 'an untracked observed fuel/pit pause cannot advance driving time');

    const collector = mainHarness(folder);
    const headers = ['#', 'DRIVER', 'LAST', 'BEST', 'LAPS'];
    const snapshot = { location: 'https://timing.invalid', bodyText: '', tables: [
      { tableIndex: 0, headers, rows: [], visible: true },
      { tableIndex: 1, headers, rows: [['33', 'Stale', '2:00.000', '2:00.000', '10']], visible: false },
      { tableIndex: 2, headers, rows: [['33', 'Current', '1:59.000', '1:58.000', '11']], visible: true }
    ] };
    assert.strictEqual(collector.normalizeSnapshot(snapshot).diagnostics.selectedTableIndex, 2);
    assert.strictEqual(collector.normalizeSnapshot(snapshot).rows[0].driver, 'Current');

    const stints = drivingStintsForCar(history, '33', { closeFinalAt: at(360), generatedAt: at(360), pitEvents: [counterStop] });
    let rendered = 0;
    const options = { sessionFolder: folder, stint: stints[0], history, session: { sessionName: '<Practice>' },
      sessionMode: 'practice', raceControlEvents: events, renderPdf: async (_json, pdf) => { rendered++; fs.writeFileSync(pdf, '%PDF-test'); return { rendered: true }; } };
    const first = await reports.writeClosedStintArtifacts(options);
    await reports.writeClosedStintArtifacts(options);
    assert.strictEqual(rendered, 1, 'unchanged data keeps its cached PDF');
    const revisedHistory = prepareHistory(history.map((row, index) => index === 0 ? { ...row, manualLapStatus: 'track-limits', paceEligible: false } : row));
    await reports.writeClosedStintArtifacts({ ...options, history: revisedHistory,
      stint: drivingStintsForCar(revisedHistory, '33', { closeFinalAt: at(360) })[0] });
    assert.strictEqual(rendered, 2, 'a manual classification refreshes the PDF without force');
    const payload = JSON.parse(fs.readFileSync(first.jsonPath));
    const html = reports.buildCanonicalFallbackHtml(payload, true);
    for (const section of ['PRACTICE OVERVIEW', 'Team comparison', 'Class comparison', 'Stint engineering insights', 'Data quality and timing notes', 'Class lap times', 'Reference times']) {
      assert.ok(html.includes(section), `portable PDF retains ${section}`);
    }
    assert.ok(html.includes('&lt;Practice&gt;'));
    assert.strictEqual(payload.raceSummary.raceControl.fcy, 1);

    const app = new EventEmitter();
    let quitCalls = 0, release;
    app.quit = () => { quitCalls++; };
    setupAppLifecycle({ app, onBeforeQuit: () => new Promise((resolve) => { release = resolve; }) });
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    assert.strictEqual(prevented, true);
    assert.strictEqual(quitCalls, 0, 'shutdown waits for queued writes/reports');
    release();
    await new Promise(setImmediate);
    assert.strictEqual(quitCalls, 1);
    await collector.flush();
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  console.log('TODO security, timing, graph, report and shutdown regression tests passed.');
})();
