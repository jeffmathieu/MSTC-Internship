// Screenshots for the README, made from a recorded race with every driver and
// team name replaced by a placeholder. Reads the archive, writes only to a temp
// folder and to docs/screenshots/.
//
// Usage: npx electron scripts/readme-screenshots.js [session folder]
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainHarness } = require('../tests/helpers/mainHarness');
const analytics = require('../src/shared/lapAnalytics');
const { recoverStoredTiming } = require('../src/shared/storageSession');
const { createRendererChannel } = require('../src/main/rendererState');
const { parseTimingRow } = require('../src/shared/parser');
const { adaptTimingFeed } = require('../src/shared/timingFeed');
const { drivingStintsForCar } = require('../src/shared/stintTracker');
const { buildCanonicalReportPayload, buildCanonicalFallbackHtml } = require('../src/main/stintReports');
const { updateGapMemory } = require('../src/shared/gapMemory');
const { loadPolls } = require('./ris-gap-replay');

const archive = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('-')) || path.join(__dirname, '..', 'tests', 'SPA', 'RACE'));
const source = fs.existsSync(path.join(archive, 'data', 'lap_history.jsonl')) ? path.join(archive, 'data') : archive;
const output = path.join(__dirname, '..', 'docs', 'screenshots');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-readme-'));
app.setPath('userData', path.join(folder, 'electron'));
const SESSION_NAME = 'Demo Cup - Race';

// Copy every JSON file with driver and team names replaced. Our own car's
// drivers become "Driver A/B/C", everyone else "Driver 01", "Team 01", ...
function anonymise(followedCars) {
  const lines = fs.readFileSync(path.join(source, 'lap_history.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const latest = JSON.parse(fs.readFileSync(path.join(source, 'latest_live_rows.json'), 'utf8'));
  const drivers = new Map(), teams = new Map();
  const ours = new Set(followedCars.map(String));
  const ourDrivers = [];
  for (const row of [...lines, ...latest]) {
    if (row.driverName && !drivers.has(row.driverName)) {
      if (ours.has(String(row.carNumber))) {
        ourDrivers.push(row.driverName);
        drivers.set(row.driverName, `Driver ${String.fromCharCode(64 + ourDrivers.length)}`);
      } else drivers.set(row.driverName, `Driver ${String(drivers.size - ourDrivers.length + 1).padStart(2, '0')}`);
    }
    if (row.teamName && !teams.has(row.teamName)) teams.set(row.teamName, ours.has(String(row.carNumber)) ? 'Our Team' : `Team ${String(teams.size + 1).padStart(2, '0')}`);
  }
  const names = [...drivers, ...teams].sort((a, b) => b[0].length - a[0].length);
  const replace = (text) => names.reduce((result, [real, fake]) => result.split(real).join(fake), text);
  const target = path.join(folder, 'archive');
  fs.mkdirSync(target);
  for (const file of fs.readdirSync(source).filter((name) => /\.(json|jsonl)$/.test(name))) {
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'session_metadata.json'), 'utf8'));
    const text = replace(fs.readFileSync(path.join(source, file), 'utf8')).split(metadata.sessionName).join(SESSION_NAME);
    fs.writeFileSync(path.join(target, file), text);
  }
  return target;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const sourceMetadata = JSON.parse(fs.readFileSync(path.join(source, 'session_metadata.json'), 'utf8'));
  const data = anonymise([sourceMetadata.followedCar]);
  const read = (file) => JSON.parse(fs.readFileSync(path.join(data, file), 'utf8'));
  const raw = fs.readFileSync(path.join(data, 'lap_history.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const metadata = read('session_metadata.json');
  const debug = read('parser_debug.json');
  const latest = read('latest_live_rows.json');
  const pitPlanFile = `pitstop_plan_car-${metadata.followedCar}.json`;
  const pitRules = fs.existsSync(path.join(data, pitPlanFile)) ? read(pitPlanFile).rules : undefined;
  const harness = mainHarness(folder);
  let settings = harness.normalizeSettings({ storageFolder: folder, followedCar: metadata.followedCar, followedCars: [metadata.followedCar],
    sessionMode: metadata.sessionMode || 'race', trackCondition: latest[0]?.trackCondition || 'dry', setupComplete: true,
    analysisConditionFilter: 'combined', theme: 'light', pitRules, timingUrl: metadata.timingUrl });
  harness.setSettings(settings);
  const car = settings.followedCar;
  const history = analytics.prepareHistory(recoverStoredTiming(raw));
  const headers = debug.detectedHeaders;
  const parse = (entries) => entries.map((row) => ({ ...row,
    ...parseTimingRow(headers, headers.map((header, i) => row.raw?.[header || `column_${i}`] || '')) }));
  const seed = adaptTimingFeed({}, headers, parse(raw.slice(0, latest.length)));
  const rows = adaptTimingFeed(seed.state, headers, parse(latest)).rows;
  const collectedAt = latest[0]?.collectedAt || raw.at(-1).collectedAt;
  const session = { ...debug.session, sessionName: SESSION_NAME };
  harness.setState({ lapHistory: history, rows, session, storageSessionFolder: folder, status: 'collecting',
    message: 'Collecting live timing', lastSuccessAt: new Date().toISOString() });
  harness.rebuildCollectorDerivedState(settings, { collectedAt, session }, rows);

  // The gap model needs every poll of the race, not only the last snapshot.
  let feed = {}, gaps = {};
  for (const poll of loadPolls(path.join(data, 'lap_history.jsonl'))) {
    const adaptedPoll = adaptTimingFeed(feed, headers, poll.rows);
    feed = adaptedPoll.state;
    gaps = updateGapMemory(gaps, { rows: adaptedPoll.rows, followedCars: [car], collectedAt: poll.at });
  }

  // Extras that are not in the archive: two race control messages and the
  // "ending the session" overlay.
  const now = Date.now();
  const extras = { raceMessages: [
    { id: 'm1', text: 'Track limits turn 4: car #12, lap 41. Warning.', cars: ['12'], firstSeenAt: new Date(now - 14 * 60000).toISOString(), lastSeenAt: new Date(now - 13 * 60000).toISOString() },
    { id: 'm2', text: `Car #${car}: drive-through penalty for an unsafe release.`, cars: [car], firstSeenAt: new Date(now - 30000).toISOString(), lastSeenAt: new Date(now).toISOString() }
  ] };
  const channels = new Map();
  const project = (sender, reset = false) => {
    if (!channels.has(sender.id)) channels.set(sender.id, createRendererChannel());
    const state = harness.getState();
    const analyticsSummary = state.analyticsSummary && { ...state.analyticsSummary,
      gapModel: { ...state.analyticsSummary.gapModel, sourceMode: gaps.sourceMode, viewsByCar: gaps.viewsByCar } };
    return channels.get(sender.id)({ ...state, analyticsSummary, ...extras }, car, sender.getURL().includes('graphs.html'), reset);
  };
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', () => settings);
  ipcMain.handle('collector:getState', (event) => project(event.sender, true));
  for (const channel of ['graphs:open', 'drivers:open', 'collector:start', 'collector:openLiveWindow', 'storage:chooseFolder', 'export:current']) {
    ipcMain.handle(channel, () => false);
  }
  ipcMain.handle('pitNotes:save', () => ({ ok: false, error: 'Read-only' }));
  ipcMain.handle('fuel:update', () => ({ settings, state: null }));

  fs.mkdirSync(output, { recursive: true });
  // Windows stay open until the end: destroying one aborts the next page load.
  const open = async (file, size = { width: 1600, height: 1000 }) => {
    const win = new BrowserWindow({ show: false, ...size, webPreferences: {
      preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.resolve(__dirname, '../src/renderer', file), { query: { car } });
    await wait(2500);
    return win;
  };
  const shot = async (win, name) => {
    // Hidden windows only repaint on request.
    win.webContents.invalidate();
    await wait(600);
    fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
    console.log('saved', name);
  };
  const run = (win, code) => win.webContents.executeJavaScript(code);
  const send = (win, extra) => { Object.assign(extras, extra); win.webContents.send('collector:update', project(win.webContents)); };

  const drivers = await open('drivers.html', { width: 1400, height: 950 });
  await shot(drivers, 'driver-overview.png');
  const graphs = await open('graphs.html');
  await shot(graphs, 'graphs.png');

  // The car-mentioned message would pop up straight away; keep it unread for later.
  extras.raceMessages[1].firstSeenAt = new Date(now - 20 * 60000).toISOString();
  const dashboard = await open('index.html');
  await shot(dashboard, 'dashboard.png');

  await run(dashboard, `document.getElementById('comparison-next-tab').click(); document.getElementById('comparison-next-tab').click(); document.getElementById('comparison-next-tab').click();`);
  await shot(dashboard, 'class-gaps.png');
  await run(dashboard, `document.getElementById('comparison-next-tab').click();`);

  send(dashboard, { pitNotesByCar: { [car]: { history: [], latest: { eventId: 'stop-3', stopNumber: 3, closed: true, needsAttention: true,
    detectedAt: new Date(Date.now() - 4 * 60000).toISOString(), durationMs: 286000, driverBefore: 'Driver B', driverAfter: 'Driver A' } } } });
  await wait(500);
  await run(dashboard, `if (document.getElementById('pit-notes-modal').classList.contains('hidden')) document.getElementById('open-pit-notes').click();
    document.getElementById('pit-notes-fuel').checked = true;
    document.getElementById('pit-notes-tyres').checked = true;
    document.getElementById('pit-notes-tyreset').value = 'Set 3 (used)';
    document.getElementById('pit-notes-driver').value = 'Understeer in the slow corners, rear tyres gone in the last 5 laps.';
    document.getElementById('pit-notes-pit').value = 'Front right wheel nut slow. Full tank.';
    document.getElementById('pit-notes-status').textContent = '';`);
  await shot(dashboard, 'pit-notes.png');
  await run(dashboard, `document.getElementById('pit-notes-cancel')?.click(); document.querySelector('#pit-notes-modal .modal-close, #pit-notes-close')?.click();
    document.getElementById('pit-notes-modal').classList.add('hidden');`);

  // A new message about our car opens the popup with a flashing red border.
  extras.raceMessages[1].firstSeenAt = new Date().toISOString();
  extras.raceMessages[1].id = 'm3';
  send(dashboard, {});
  await wait(1200);
  await shot(dashboard, 'race-messages.png');
  await run(dashboard, `document.getElementById('messages-modal').classList.add('hidden');`);

  send(dashboard, { finalizing: { active: true, detail: 'Generating the final reports: stints, overview and debrief…', startedAt: new Date(Date.now() - 65000).toISOString() } });
  await wait(1500);
  await shot(dashboard, 'ending-session.png');
  send(dashboard, { finalizing: { active: false } });
  await wait(500);

  await run(dashboard, `document.getElementById('open-setup').click();
    document.getElementById('setup-url').value = '${metadata.timingUrl}';
    document.getElementById('setup-folder').value = 'D:\\\\Races\\\\Spa';`);
  await shot(dashboard, 'setup.png');


  // First pages of the race report (the same HTML the app prints to PDF).
  const payload = buildCanonicalReportPayload({ history, carNumber: car, session, gapSamples: [],
    stints: drivingStintsForCar(history, car, { closeFinalAt: collectedAt }), pitRules: settings.pitRules });
  const reportFile = path.join(folder, 'report.html');
  fs.writeFileSync(reportFile, buildCanonicalFallbackHtml(payload, true));
  const report = new BrowserWindow({ show: false, width: 1404, height: 1000, webPreferences: { sandbox: true } });
  await report.loadFile(reportFile);
  await report.webContents.insertCSS('html, body { overflow: hidden !important; }');
  await wait(1500);
  await shot(report, 'report.png');
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
