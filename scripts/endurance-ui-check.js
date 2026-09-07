// Run with Electron. Uses isolated userData and synthetic timing only.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { mainHarness } = require('../tests/helpers/mainHarness');
const { prepareHistory } = require('../src/shared/lapAnalytics');
const { createRendererChannel } = require('../src/main/rendererState');
const { buildCanonicalReportPayload, renderReportLabPdf } = require('../src/main/stintReports');
const { stintsForCar } = require('../src/shared/stintTracker');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-endurance-ui-'));
app.setPath('userData', path.join(folder, 'electron'));
app.whenReady().then(async () => {
  const harness = mainHarness(folder);
  const settings = harness.normalizeSettings({ storageFolder: folder, followedCar: '1', followedCars: ['1'],
    sessionMode: 'race', trackCondition: 'dry', setupComplete: true, theme: 'light' });
  harness.setSettings(settings);
  const raw = Array.from({ length: 31095 }, (_, i) => ({ carNumber: String(i % 45 + 1), className: `Class ${i % 3}`,
    driverName: Math.floor(i / 45) < 345 ? 'Peter Bens' : 'Ellen Leysen', teamName: `Team ${i % 45 + 1}`,
    lapNumber: '', historySequence: Math.floor(i / 45) + 1, lapTimeMs: 125000 + Math.sin(i / 20) * 1500,
    sector1Ms: 40000, sector2Ms: 45000, sector3Ms: 40000, lastLap: '2:05.000',
    collectedAt: new Date(Date.UTC(2026, 8, 7) + Math.floor(i / 45) * 125000).toISOString(),
    pitInfo: '0', sessionFlag: 'Green flag', trackCondition: 'dry' }));
  const history = prepareHistory(raw);
  const rows = Array.from({ length: 45 }, (_, i) => ({ carNumber: String(i + 1), className: `Class ${i % 3}`,
    classPosition: Math.floor(i / 3) + 1, position: i + 1, driver: 'Ellen Leysen', team: `Team ${i + 1}`,
    lastLap: '2:05.000', lastLapMs: 125000, bestLapMs: 123500, bestLap: '2:03.500', lapNumber: 691,
    sector1: '40.000', sector1Ms: 40000, sector2: '45.000', sector2Ms: 45000,
    pit: '21', gap: `${i * 3}.100`, diff: '3.100' }));
  harness.setState({ lapHistory: history, rows, storageSessionFolder: folder,
    session: { sessionName: '24h Endurance - verification', flag: 'Green flag', timeToGo: '01:00:00' } });
  harness.rebuildCollectorDerivedState(settings, { collectedAt: '2026-09-07T23:59:00Z', session: { timeToGo: '01:00:00', flag: 'Green flag' } }, rows);
  const state = harness.getState();
  state.pitstopPlansByCar['1'].serviceTimers = { active: true, phase: 'pit', fuelDurationMs: 45000, pitDurationMs: 50000, totalDurationMs: 95000 };
  const channels = new Map();
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('collector:getState', (event) => {
    const graph = event.sender.getURL().includes('graphs.html');
    if (!channels.has(event.sender.id)) channels.set(event.sender.id, createRendererChannel());
    return channels.get(event.sender.id)(state, '1', graph, true);
  });
  const errors = [];
  const open = async (filename) => {
    const win = new BrowserWindow({ show: false, width: 1600, height: 1000,
      webPreferences: { preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await win.loadFile(path.resolve(__dirname, '../src/renderer', filename));
    // Wait on actual content, not a fixed startup delay.
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0; const timer = setInterval(() => {
        const ready = ${filename === 'index.html' ? "document.querySelectorAll('.lap-strip-row').length > 0" : "document.querySelector('.chart-panel h1')?.textContent === 'Lap times per driver'"};
        if (ready) { clearInterval(timer); resolve(); } else if (++attempts > 100) { clearInterval(timer); reject(new Error('UI did not render')); }
      }, 50);
    })`);
    return win;
  };
  const dashboard = await open('index.html');
  const scrolling = await dashboard.webContents.executeJavaScript(`(async () => {
    const list = document.getElementById('lap-strip-list');
    const rowsBefore = list.querySelectorAll('.lap-strip-row').length;
    const t = performance.now();
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event('scroll'));
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return { rowsBefore, rowsAfter: list.querySelectorAll('.lap-strip-row').length,
      firstVisible: list.querySelector('.lap-strip-row .lap-number')?.textContent,
      scrollMs: performance.now() - t, overflow: document.documentElement.scrollHeight > innerHeight };
  })()`);
  assert.ok(scrolling.rowsBefore < 80 && scrolling.rowsAfter < 80);
  fs.writeFileSync(path.join(folder, 'dashboard.png'), (await dashboard.webContents.capturePage()).toPNG());
  const graphs = await open('graphs.html');
  const graphMetrics = await graphs.webContents.executeJavaScript(`(async () => {
    const canvas = document.querySelector('canvas'); const t = performance.now();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, clientX: 300, bubbles: true, cancelable: true }));
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return { zoomMs: performance.now() - t, tooltipPoints: document.querySelectorAll('canvas').length };
  })()`);
  fs.writeFileSync(path.join(folder, 'graphs.png'), (await graphs.webContents.capturePage()).toPNG());
  assert.deepStrictEqual(errors.filter((message) => !message.includes('Content Security Policy')), []);
  const stops = Array.from({ length: 23 }, (_, i) => ({ id: `1|${i}`, carNumber: '1', stopNumber: i + 1,
    lapNumber: 20 + i * 25, lapNumberSource: 'observed-sequence', closed: true,
    durationMs: i === 0 ? null : 75000 + i * 1000, durationSource: i % 2 ? 'observed' : 'provider',
    fuelDurationMs: i === 0 ? null : i % 2 ? 45000 : 0, pitDurationMs: i === 0 ? null : 76000,
    totalDurationMs: i === 0 ? null : i % 2 ? 121000 : 76000, targetDurationMs: 75000,
    driverBefore: i === 0 ? '' : 'Peter Bens', driverAfter: i % 2 ? 'Ellen Leysen' : 'Peter Bens',
    positionAfter: 27, classPositionAfter: 6 }));
  const payload = buildCanonicalReportPayload({ history, carNumber: '1', pitEvents: stops,
    stints: stintsForCar(history, '1', { closeFinalAt: '2026-09-08T00:00:00Z' }),
    session: { sessionName: '24h Endurance - verification' }, pitRules: { pitStopDurationMs: 75000 } });
  const jsonPath = path.join(folder, 'report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload));
  const pdfPath = path.join(folder, 'report.pdf');
  const pdf = renderReportLabPdf(jsonPath, pdfPath, { includeSummary: true });
  assert.ok(pdf.rendered, JSON.stringify(pdf));
  await harness.flush();
  console.log(JSON.stringify({ folder, scrolling, graphMetrics, pdfPath, errors }, null, 2));
  dashboard.destroy(); graphs.destroy(); app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
