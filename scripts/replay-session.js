// Offline endurance test: read the source archive; write only to a new temp
// folder. No timing website, updater, original settings or original PDFs.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainHarness } = require('../tests/helpers/mainHarness');
const analytics = require('../src/shared/lapAnalytics');
const { recoverStoredTiming } = require('../src/shared/storageSession');
const { createRendererChannel } = require('../src/main/rendererState');
const { parseTimingRow } = require('../src/shared/parser');
const { adaptTimingFeed } = require('../src/shared/timingFeed');
const { drivingStintsForCar: stintsForCar } = require('../src/shared/stintTracker');
const { buildCanonicalReportPayload, renderReportLabPdf, buildCanonicalFallbackHtml, printHtmlToPdf } = require('../src/main/stintReports');

const source = path.resolve(process.argv[2] || 'race kopie');
const smoke = process.argv.includes('--smoke');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-offline-replay-'));
app.setPath('userData', path.join(folder, 'electron'));

app.whenReady().then(async () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(source, file), 'utf8'));
  const raw = fs.readFileSync(path.join(source, 'lap_history.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const metadata = read('session_metadata.json');
  const debug = read('parser_debug.json');
  const latest = read('latest_live_rows.json');
  const pitPlanFile = `pitstop_plan_car-${metadata.followedCar}.json`;
  const savedPitRules = fs.existsSync(path.join(source, pitPlanFile)) ? read(pitPlanFile).rules : undefined;
  const harness = mainHarness(folder);
  let settings = harness.normalizeSettings({ storageFolder: folder, followedCar: metadata.followedCar,
    followedCars: metadata.followedCars, sessionMode: metadata.sessionMode || 'race', trackCondition: latest[0]?.trackCondition || 'dry',
    setupComplete: true, analysisConditionFilter: 'combined', theme: 'light', pitRules: savedPitRules });
  harness.setSettings(settings);
  const car = settings.followedCar;
  const history = analytics.prepareHistory(recoverStoredTiming(raw));
  const headers = debug.detectedHeaders;
  const parse = (entries) => entries.map((row) => ({ ...row,
    ...parseTimingRow(headers, headers.map((header, i) => row.raw?.[header || `column_${i}`] || '')) }));
  // Seed rotation evidence from archived raw rows; the latest snapshot may
  // happen to contain only counters. Never treat a lap-only log as full polls.
  const seed = adaptTimingFeed({}, headers, parse(raw.slice(0, latest.length)));
  const adapted = adaptTimingFeed(seed.state, headers, parse(latest));
  let rows = adapted.rows;
  const collectedAt = latest[0]?.collectedAt || raw.at(-1).collectedAt;
  const session = { ...debug.session, sessionName: `${metadata.sessionName} — OFFLINE TEST` };
  harness.setState({ lapHistory: history, rows, session, storageSessionFolder: folder,
    status: 'collecting', message: 'OFFLINE TEST — original race data is read-only', lastSuccessAt: collectedAt });
  const rebuild = () => {
    const t = performance.now();
    harness.rebuildCollectorDerivedState(settings, { collectedAt, session }, rows);
    return performance.now() - t;
  };
  const initialMs = rebuild();
  const channels = new Map();
  const project = (sender, reset = false) => {
    if (!channels.has(sender.id)) channels.set(sender.id, createRendererChannel());
    return channels.get(sender.id)(harness.getState(), car, sender.getURL().includes('graphs.html'), reset);
  };
  const publish = () => BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('collector:update', project(win.webContents)));
  const windows = new Map();
  const errors = [];
  const open = async (file) => {
    if (windows.has(file)) { windows.get(file).show(); return; }
    const win = new BrowserWindow({ show: !smoke, width: 1600, height: 1000, title: 'MSTC — OFFLINE TEST',
      webPreferences: { preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    windows.set(file, win);
    const contentsId = win.webContents.id;
    win.on('closed', () => { windows.delete(file); channels.delete(contentsId); });
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    await win.loadFile(path.resolve(__dirname, '../src/renderer', file), { query: { car } });
    return win;
  };
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_event, patch) => {
    settings = harness.normalizeSettings({ ...settings, ...patch, storageFolder: folder, followedCar: car, followedCars: [car] });
    harness.setSettings(settings); rebuild(); publish();
    BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('theme:update', settings.theme));
    return settings;
  });
  ipcMain.handle('collector:getState', (event) => project(event.sender, true));
  ipcMain.handle('fuel:update', async (event, payload) => {
    settings = await harness.updateFuelSettingsAndState(payload);
    harness.setSettings(settings); rebuild(); publish();
    return { settings, state: project(event.sender) };
  });
  ipcMain.handle('graphs:open', () => open('graphs.html').then(() => true));
  ipcMain.handle('storage:chooseFolder', () => folder);
  ipcMain.handle('collector:openLiveWindow', () => false);
  ipcMain.handle('laps:updateStatus', () => ({ ok: false, message: 'Offline replay is read-only.' }));
  const exportPdf = async () => {
    const gaps = fs.existsSync(path.join(source, 'gap_history.jsonl'))
      ? fs.readFileSync(path.join(source, 'gap_history.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
    const payload = buildCanonicalReportPayload({ history, carNumber: car, session, gapSamples: gaps,
      stints: stintsForCar(history, car, { closeFinalAt: collectedAt }), pitRules: settings.pitRules });
    const jsonPath = path.join(folder, 'REPLAY_REPORT.json');
    const pdfPath = path.join(folder, 'REPLAY_REPORT.pdf');
    fs.writeFileSync(jsonPath, JSON.stringify(payload));
    const rendered = renderReportLabPdf(jsonPath, pdfPath, { includeSummary: true });
    if (!rendered.rendered) await printHtmlToPdf(BrowserWindow, buildCanonicalFallbackHtml(payload, true), pdfPath);
    return { jsonPath, pdfPath, historyPath: path.join(source, 'lap_history.jsonl') };
  };
  ipcMain.handle('export:current', exportPdf);
  let timer;
  const start = () => {
    if (!timer) timer = setInterval(() => { rebuild(); publish(); }, 5000);
    return true;
  };
  ipcMain.handle('collector:start', start);
  ipcMain.handle('collector:stop', (event) => { clearInterval(timer); timer = null; return { cancelled: false, state: project(event.sender) }; });
  const dashboard = await open('index.html');
  start();
  if (smoke) {
    const graphs = await open('graphs.html');
    for (const win of [dashboard, graphs]) await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let n=0; const t=setInterval(() => {
        if (document.querySelector('.lap-strip-row') || document.querySelector('.chart-panel h1')?.textContent === 'Lap times per driver') {clearInterval(t);resolve();}
        else if (++n>100) {clearInterval(t);reject(new Error('No rendered race data'));}
      },50);
    })`);
    const scroll = await dashboard.webContents.executeJavaScript(`(async () => {
      const list=document.getElementById('lap-strip-list'); const t=performance.now(); list.scrollTop=list.scrollHeight;
      list.dispatchEvent(new Event('scroll')); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return {ms:performance.now()-t, renderedRows:list.querySelectorAll('.lap-strip-row').length};
    })()`);
    fs.writeFileSync(path.join(folder, 'dashboard.png'), (await dashboard.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(folder, 'graphs.png'), (await graphs.webContents.capturePage()).toPNG());
    const pitSetup = await dashboard.webContents.executeJavaScript(`(async () => {
      document.getElementById('open-pit-setup').click();
      const estimationHidden = !document.getElementById('fuel-enabled') && !document.getElementById('fuel-estimate');
      document.getElementById('pit-setup-save').click();
      await new Promise((resolve,reject) => {
        let n=0; const timer=setInterval(() => {
          if (document.getElementById('pit-setup-modal').classList.contains('hidden')) {clearInterval(timer);resolve();}
          else if (++n>100) {clearInterval(timer);reject(new Error('Pit setup save timed out'));}
        },50);
      });
      return {estimationHidden, exportVisible: document.getElementById('export').getBoundingClientRect().width > 0};
    })()`);
    if (!pitSetup.estimationHidden || !pitSetup.exportVisible) throw new Error(JSON.stringify(pitSetup));
    const cachedMs = rebuild(); publish();
    const reports = await exportPdf();
    console.log(JSON.stringify({ source, folder, records: raw.length, initialMs, cachedMs, rotatingGapDetected: adapted.state.alternating,
      scroll, pitSetup, reports, errors }, null, 2));
    clearInterval(timer); await harness.flush(); app.quit();
  } else console.log(`Offline dashboard: ${source}\nScratch reports: ${folder}\nFull archive loaded; updates every 5s. Stop pauses updates, Start resumes. No new laps are invented.`);
  app.on('window-all-closed', () => { clearInterval(timer); app.quit(); });
}).catch((error) => { console.error(error); dialog.showErrorBox('Offline test failed', error.message); app.exit(1); });
