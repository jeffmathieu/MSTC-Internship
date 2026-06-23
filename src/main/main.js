const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  cleanText,
  parseTimingRow,
  looksLikeTimingHeaders
} = require('../shared/parser');
const {
  LAP_HISTORY_COLUMNS,
  normalizeForStorage,
  lapRecordFromNormalizedRow,
  lapIdentity,
  toCsvRows,
  detectSourceProvider
} = require('../shared/storageSchema');

// Main-process references. Electron keeps UI windows and timers alive through
// these variables, so every start/stop function below updates them carefully.
let mainWindow;
let liveWindow;
let pollTimer;
let shouldCloseLiveWindow = false;

// Stores unique lap identifiers that have already been written to disk.
// Change the key format in updateLapHistory/loadExistingHistory if duplicate
// detection ever needs to include extra fields such as driver or class.
const knownLapKeys = new Set();

// Single source of truth for the collector UI. The renderer receives this
// object through the "collector:update" IPC event whenever something changes.
let collectorState = {
  status: 'idle',
  mode: 'idle',
  message: 'Collector not started',
  url: '',
  startedAt: null,
  lastPollAt: null,
  lastSuccessAt: null,
  headers: [],
  rows: [],
  lapHistory: [],
  session: {},
  diagnostics: {},
  errors: [],
  snapshots: [],
  storage: {},
  pollIntervalMs: 3000
};

// Electron chooses a safe OS-specific folder for app settings. Race data is
// stored in Documents by default so users can easily find CSV/JSON exports.
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultStorageFolder = () => path.join(app.getPath('documents'), 'ZolderLiveTimingReader');

// Loads saved user settings. If the settings file does not exist or cannot be
// parsed, the app falls back to defaults. Adjust default URLs, intervals, or
// reference values here when changing the initial app configuration.
function loadSettings() {
  try {
    const file = settingsPath();
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('Could not load settings', error);
  }
  return {
    timingUrl: 'https://livetiming.getraceresults.com/demo#screen-results',
    followedCar: '33',
    storageFolder: defaultStorageFolder(),
    pollIntervalMs: 3000,
    referenceTime: '1:42.000',
    setupComplete: false
  };
}

// Persists settings as formatted JSON. Any new setting added to loadSettings()
// can be saved here automatically because the whole settings object is written.
function saveSettings(settings) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// Creates the visible application window. Size, minimum size, theme background,
// and the renderer entry point can be changed here.
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 990,
    minWidth: 1150,
    minHeight: 760,
    backgroundColor: '#080b12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox is disabled because the preload/main bridge is trusted in this
      // local Electron app. Revisit this if the renderer starts loading remote UI.
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// Creates the hidden browser window used to load the live timing website.
// show:false keeps it invisible during normal collection; the debug button can
// reveal it through collector:openLiveWindow. Closing the debug window only
// hides it, because the collector still needs this BrowserWindow to keep polling.
function createLiveWindow() {
  if (liveWindow && !liveWindow.isDestroyed()) return liveWindow;
  liveWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  liveWindow.on('close', (event) => {
    if (shouldCloseLiveWindow) return;
    event.preventDefault();
    liveWindow.hide();
  });
  liveWindow.on('closed', () => {
    liveWindow = null;
    shouldCloseLiveWindow = false;
  });
  return liveWindow;
}

// Pushes the latest collector state to the renderer. Add new state fields to
// collectorState first; the whole object is sent as-is.
function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('collector:update', collectorState);
}

// Adds a compact error entry for the Debug panel. Only the latest 20 errors are
// kept to prevent the state object from growing forever during long sessions.
function addError(error, context = '') {
  const entry = { at: new Date().toISOString(), context, message: error?.message || String(error) };
  collectorState.errors = [entry, ...collectorState.errors].slice(0, 20);
}

// This script runs inside the hidden live timing page, not inside this Node
// process. Keep it dependency-free because it executes in the website context.
// If the provider changes their HTML, update the table/header extraction logic
// here before changing the parser.
const pageExtractionScript = String.raw`(() => {
  const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const tables = Array.from(document.querySelectorAll('table')).map((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll('tr'));
    let headerCells = [];
    const explicitHeader = table.querySelector('thead tr');
    if (explicitHeader) {
      headerCells = Array.from(explicitHeader.querySelectorAll('th,td')).map((cell) => clean(cell.textContent || cell.innerText));
    } else {
      const firstHeaderRow = rows.find((row) => Array.from(row.querySelectorAll('th')).length > 0) || rows[0];
      headerCells = firstHeaderRow ? Array.from(firstHeaderRow.querySelectorAll('th,td')).map((cell) => clean(cell.textContent || cell.innerText)) : [];
    }
    const bodyRows = rows
      .map((row) => Array.from(row.querySelectorAll('td,th')).map((cell) => clean(cell.textContent || cell.innerText)))
      .filter((cells) => cells.length > 0)
      .filter((cells) => cells.join('|') !== headerCells.join('|'));
    return { tableIndex, headers: headerCells, rows: bodyRows, rowCount: bodyRows.length, className: table.className || '', id: table.id || '' };
  });
  const allText = clean(document.body ? (document.body.textContent || document.body.innerText) : '');
  const inputs = Array.from(document.querySelectorAll('input, select')).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', value: el.value || '', name: el.getAttribute('name') || '', id: el.id || '', placeholder: el.getAttribute('placeholder') || '' }));
  return { location: window.location.href, title: document.title || '', bodyText: allText.slice(0, 12000), tables, inputs, collectedAt: new Date().toISOString() };
})()`;

// Creates a checksum for snapshot rows. The UI/debug view can use this to see
// whether table contents changed between polls.
function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Extracts race/session metadata from the page text. These regexes are tuned to
// common GetRaceResults wording; add patterns here when supporting new timing
// providers or different language/page layouts.
function parseSessionInfo(snapshot) {
  const text = cleanText(snapshot.bodyText || '');
  const session = { pageTitle: snapshot.title, url: snapshot.location, statusText: '', timeToGo: '', flag: '', sessionName: '', circuit: '', pageUpdated: '' };

  const toGo = text.match(/To go:\s*([^A-Z\n\r]+?)\s+([A-Z][A-Za-z0-9 .:&'()\-]+?\s-\s(?:Race|Qualifying|Practice|Session|Warm.?up))/i);
  if (toGo) {
    session.timeToGo = cleanText(toGo[1]);
    session.sessionName = cleanText(toGo[2]);
  } else {
    const simpleToGo = text.match(/To go:\s*([^\n\r]+)/i);
    if (simpleToGo) session.timeToGo = cleanText(simpleToGo[1]).split(/\s{2,}/)[0];
  }

  const flagMatch = text.match(/(Green flag|Red flag|Yellow flag|Safety car|Full course yellow|Code 60|Finished flag)/i);
  if (flagMatch) session.flag = cleanText(flagMatch[1]);

  const commonStatus = ['No active heat', 'Waiting for the LiveTiming data', 'Not connected to the LiveTiming server', 'Trying to reconnect to the LiveTiming server', 'Connecting to the LiveTiming server'];
  const foundStatus = commonStatus.find((line) => text.includes(line));
  if (foundStatus) session.statusText = foundStatus;

  if (!session.sessionName) {
    const sessionMatch = text.match(/([A-Z][A-Za-z0-9 .:&'()\-]+?\s-\s(?:Race|Qualifying|Practice|Session|Warm.?up))/i);
    if (sessionMatch) session.sessionName = cleanText(sessionMatch[1]);
  }

  const updated = text.match(/Page updated\s*([0-9:]+\s*\(UTC\))?/i);
  if (updated) session.pageUpdated = cleanText(updated[1] || '');
  return session;
}

// Converts a raw page snapshot into the normalized shape used by the UI and
// storage. The parser module owns column-name interpretation; this function
// chooses the best table and attaches diagnostics.
function normalizeSnapshot(snapshot) {
  const timingTable = snapshot.tables.find((table) => looksLikeTimingHeaders(table.headers));
  const diagnostics = {
    url: snapshot.location,
    title: snapshot.title,
    tableCount: snapshot.tables.length,
    tableSummaries: snapshot.tables.map((table) => ({ tableIndex: table.tableIndex, headers: table.headers, rowCount: table.rowCount, id: table.id, className: table.className })),
    bodyTextSample: (snapshot.bodyText || '').slice(0, 1600),
    inputs: snapshot.inputs || []
  };
  if (!timingTable) {
    return { status: snapshot.bodyText?.includes('No active heat') ? 'waiting' : 'parser_error', message: 'No timing table with NR/TEAM/LAST/BEST-style headers detected yet.', headers: [], rows: [], session: parseSessionInfo(snapshot), diagnostics };
  }
  const rows = timingTable.rows
    .map((cells, rowIndex) => ({ rowIndex, ...parseTimingRow(timingTable.headers, cells), cells }))
    .filter((row) => row.carNumber !== null && row.carNumber !== undefined);
  return {
    status: rows.length ? 'collecting' : 'waiting',
    message: rows.length ? `Collecting ${rows.length} live timing rows.` : 'Timing table detected, but no car rows parsed yet.',
    headers: timingTable.headers,
    rows,
    session: parseSessionInfo(snapshot),
    diagnostics: { ...diagnostics, selectedTableIndex: timingTable.tableIndex, selectedHeaders: timingTable.headers, parsedCarNumbers: rows.map((row) => row.carNumber), firstParsedRows: rows.slice(0, 5) }
  };
}

// Makes sure the selected storage folder exists before writing exports/history.
// Change defaultStorageFolder() instead of this function when only the default
// location needs to move.
function ensureStorage(settings) {
  const folder = settings.storageFolder || defaultStorageFolder();
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function storageContext(settings, normalized, collectedAt = new Date().toISOString()) {
  const timingUrl = normalized.session?.url || collectorState.url || loadSettings().timingUrl || '';
  return {
    collectedAt,
    timingUrl,
    sourceProvider: detectSourceProvider({ timingUrl }),
    session: normalized.session || {},
    startedAt: collectorState.startedAt,
    followedCar: settings.followedCar || ''
  };
}

// Provider adapters produce app rows with canonical fields; the storage layer is
// intentionally provider-agnostic and only writes normalized storage rows.
function normalizeRowsForStorage(rows, context) {
  return rows.map((row) => normalizeForStorage(row, context));
}

function writeLatestRows(settings, normalizedRows) {
  const folder = ensureStorage(settings);
  fs.writeFileSync(path.join(folder, 'latest_live_rows.json'), JSON.stringify(normalizedRows, null, 2));
  fs.writeFileSync(path.join(folder, 'latest_live_rows.csv'), toCsvRows(normalizedRows));
}

function appendLapHistory(settings, lapRecords) {
  if (!lapRecords.length) return;
  const folder = ensureStorage(settings);
  const jsonlPath = path.join(folder, 'lap_history.jsonl');
  const csvPath = path.join(folder, 'lap_history.csv');
  const expectedHeader = LAP_HISTORY_COLUMNS.join(',');
  let rewroteCsv = false;
  if (fs.existsSync(csvPath)) {
    const currentHeader = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/, 1)[0];
    if (currentHeader !== expectedHeader) {
      const existingRecords = fs.existsSync(jsonlPath)
        ? fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        : [];
      fs.writeFileSync(csvPath, toCsvRows([...existingRecords, ...lapRecords], LAP_HISTORY_COLUMNS) + '\n');
      rewroteCsv = true;
    }
  } else {
    fs.writeFileSync(csvPath, `${expectedHeader}\n`);
  }
  fs.appendFileSync(jsonlPath, lapRecords.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const currentHeader = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/, 1)[0];
  if (!rewroteCsv && currentHeader === expectedHeader) fs.appendFileSync(csvPath, lapRecords.map((entry) => toCsvRows([entry], LAP_HISTORY_COLUMNS).split('\n')[1]).join('\n') + '\n');
}

function writeParserDebug(settings, debugInfo) {
  const folder = ensureStorage(settings);
  fs.writeFileSync(path.join(folder, 'parser_debug.json'), JSON.stringify(debugInfo, null, 2));
}

function writeSessionMetadata(settings, context) {
  const folder = ensureStorage(settings);
  fs.writeFileSync(path.join(folder, 'session_metadata.json'), JSON.stringify({
    timingUrl: context.timingUrl || '',
    sourceProvider: context.sourceProvider || 'unknown',
    sessionName: normalizeForStorage({}, context).sessionName,
    startedAt: context.startedAt || '',
    lastUpdatedAt: context.collectedAt || '',
    followedCar: context.followedCar || '',
    storageSchemaVersion: 1
  }, null, 2));
}

function parserDebugFromNormalized(normalized, storageRows, context, lastError = '') {
  return {
    timingUrl: context.timingUrl || '',
    sourceProvider: context.sourceProvider || 'unknown',
    detectedHeaders: normalized.headers || [],
    rowCount: storageRows.length,
    parsedCarNumbers: storageRows.map((row) => row.carNumber).filter(Boolean),
    firstThreeRows: storageRows.slice(0, 3),
    warnings: normalized.status === 'parser_error' ? [normalized.message] : [],
    lastError,
    updatedAt: context.collectedAt || new Date().toISOString()
  };
}

// Loads already-recorded lap history at startup and rebuilds knownLapKeys so
// the app does not duplicate old laps after restarting.
function loadExistingHistory(settings) {
  knownLapKeys.clear();
  const folder = ensureStorage(settings);
  const jsonlPath = path.join(folder, 'lap_history.jsonl');
  if (!fs.existsSync(jsonlPath)) return [];
  try {
    const entries = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    entries.forEach((entry) => {
      if (entry.carNumber && entry.lastLap) knownLapKeys.add(lapIdentity(entry));
    });
    return entries.slice(-20000);
  } catch (error) {
    addError(error, 'loadExistingHistory');
    return [];
  }
}

// Stores newly completed laps from provider-independent normalized storage rows.
function updateLapHistory(settings, storageRows) {
  const newEntries = [];
  storageRows.forEach((row) => {
    const entry = lapRecordFromNormalizedRow(row);
    if (!entry.carNumber || !entry.lastLap || entry.lapTimeMs === '') return;
    const key = lapIdentity(entry);
    if (knownLapKeys.has(key)) return;
    knownLapKeys.add(key);
    newEntries.push(entry);
  });
  try { appendLapHistory(settings, newEntries); } catch (error) { addError(error, 'appendLapHistory'); }
  if (newEntries.length) collectorState.lapHistory = [...collectorState.lapHistory, ...newEntries].slice(-20000);
  return newEntries.length;
}

// Writes the latest table/session snapshot to predictable filenames. These files
// are overwritten on every successful poll/tick so external tools can read the
// current state without searching for timestamps.
function saveLatestSnapshot(settings, normalized) {
  try {
    const collectedAt = new Date().toISOString();
    const context = storageContext(settings, normalized, collectedAt);
    const storageRows = normalizeRowsForStorage(normalized.rows, context);
    writeLatestRows(settings, storageRows);
    writeParserDebug(settings, parserDebugFromNormalized(normalized, storageRows, context));
    writeSessionMetadata(settings, context);
    return { storageRows, context };
  } catch (error) { addError(error, 'saveLatestSnapshot'); }
  return { storageRows: [], context: null };
}

// Reads the hidden live timing page once, normalizes the data, updates history,
// writes latest exports, and broadcasts state to the renderer.
async function pollLivePage() {
  if (!liveWindow || liveWindow.isDestroyed()) return;
  collectorState.lastPollAt = new Date().toISOString();
  try {
    const settings = loadSettings();
    const snapshot = await liveWindow.webContents.executeJavaScript(pageExtractionScript, true);
    const normalized = normalizeSnapshot(snapshot);
    const { storageRows } = saveLatestSnapshot(settings, normalized);
    const newLapCount = updateLapHistory(settings, storageRows);
    collectorState = {
      ...collectorState,
      mode: 'live',
      status: normalized.status,
      message: newLapCount ? `${normalized.message} Stored ${newLapCount} new completed lap(s).` : normalized.message,
      lastSuccessAt: new Date().toISOString(), headers: normalized.headers, rows: normalized.rows, session: normalized.session, diagnostics: normalized.diagnostics,
      storage: storageInfo(settings), pollIntervalMs: Number(settings.pollIntervalMs || 3000),
      snapshots: [{ at: new Date().toISOString(), checksum: hashObject(normalized.rows), rowCount: normalized.rows.length, newLapCount }, ...collectorState.snapshots].slice(0, 20)
    };
  } catch (error) {
    collectorState.status = 'error'; collectorState.message = 'Could not read the live timing page. See Debug for details.'; addError(error, 'pollLivePage');
  }
  broadcastState();
}

// Returns user-facing paths for the Debug/Storage UI. Add new exported files
// here if the renderer should display their locations.
function storageInfo(settings) {
  const folder = settings.storageFolder || defaultStorageFolder();
  return {
    folder,
    latestRowsCsv: path.join(folder, 'latest_live_rows.csv'),
    latestRowsJson: path.join(folder, 'latest_live_rows.json'),
    lapHistoryCsv: path.join(folder, 'lap_history.csv'),
    lapHistoryJsonl: path.join(folder, 'lap_history.jsonl'),
    parserDebugJson: path.join(folder, 'parser_debug.json'),
    sessionMetadataJson: path.join(folder, 'session_metadata.json')
  };
}

// Starts live collection for a URL. It opens/loads the hidden live window, does
// an immediate poll, then schedules repeated polls.
// Poll frequency is controlled by settings.pollIntervalMs.
async function startCollector(url) {
  stopCollector(false);
  const settings = loadSettings();
  collectorState = { ...collectorState, mode: 'live', status: 'loading', message: 'Loading live timing page...', url, startedAt: new Date().toISOString(), lastPollAt: null, lastSuccessAt: null, headers: [], rows: [], lapHistory: loadExistingHistory(settings), session: {}, diagnostics: {}, errors: [], snapshots: [], storage: storageInfo(settings), pollIntervalMs: Number(settings.pollIntervalMs || 3000) };
  broadcastState();
  try {
    const win = createLiveWindow();
    win.webContents.removeAllListeners('did-fail-load');
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => { collectorState.status = 'error'; collectorState.message = `Live timing page failed to load: ${errorDescription} (${errorCode})`; addError(new Error(errorDescription), 'did-fail-load'); broadcastState(); });
    await win.loadURL(url);
    collectorState.status = 'connected'; collectorState.message = 'Live timing page loaded. Waiting for timing table...'; broadcastState();
    await pollLivePage();
    pollTimer = setInterval(pollLivePage, Number(settings.pollIntervalMs || 3000));
  } catch (error) { collectorState.status = 'error'; collectorState.message = 'Failed to start live collector.'; addError(error, 'startCollector'); broadcastState(); }
}

// Stops the live collector and optionally closes the hidden live window. Use
// closeLiveWindow=false when switching modes but keeping the window lifecycle
// under control elsewhere.
function stopCollector(closeLiveWindow = true) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (closeLiveWindow && liveWindow && !liveWindow.isDestroyed()) {
    shouldCloseLiveWindow = true;
    liveWindow.close();
  }
  if (collectorState.mode === 'live') { collectorState.status = 'idle'; collectorState.message = 'Live collector stopped'; }
  broadcastState();
}

// IPC handlers are the public API used by preload.js and the renderer. When
// adding a UI action, add its handler here and expose a matching function in
// preload.js.
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_event, settings) => {
  const merged = { ...loadSettings(), ...settings };
  // Clamp user-editable timing values so accidental input cannot create an
  // unusably fast/slow collector.
  merged.pollIntervalMs = Math.max(1000, Math.min(10000, Number(merged.pollIntervalMs || 3000)));
  saveSettings(merged);
  return merged;
});

// Opens a native folder picker and stores the chosen export/history directory.
ipcMain.handle('storage:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const settings = { ...loadSettings(), storageFolder: result.filePaths[0] };
  saveSettings(settings);
  return settings.storageFolder;
});

ipcMain.handle('collector:start', (_event, url) => startCollector(url));
ipcMain.handle('collector:stop', () => stopCollector(true));
ipcMain.handle('collector:getState', () => collectorState);
ipcMain.handle('collector:openLiveWindow', () => { if (liveWindow && !liveWindow.isDestroyed()) { liveWindow.show(); liveWindow.focus(); return true; } return false; });

// Creates timestamped exports of the current rows and in-memory lap history.
// The always-overwritten "latest_*" files are written by saveLatestSnapshot().
ipcMain.handle('export:current', async () => {
  const settings = loadSettings();
  const folder = ensureStorage(settings);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(folder, `live_rows_${timestamp}.json`);
  const csvPath = path.join(folder, `live_rows_${timestamp}.csv`);
  const historyPath = path.join(folder, `lap_history_${timestamp}.json`);
  const context = storageContext(settings, { session: collectorState.session || {} }, new Date().toISOString());
  const storageRows = normalizeRowsForStorage(collectorState.rows || [], context);
  fs.writeFileSync(jsonPath, JSON.stringify(storageRows, null, 2));
  fs.writeFileSync(csvPath, toCsvRows(storageRows));
  fs.writeFileSync(historyPath, JSON.stringify({ session: collectorState.session, lapHistory: collectorState.lapHistory }, null, 2));
  return { jsonPath, csvPath, historyPath };
});

// Electron app lifecycle. On macOS the app remains open after all windows close,
// matching normal platform behavior; other platforms quit immediately.
app.whenReady().then(() => { createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); });
app.on('window-all-closed', () => { stopCollector(true); if (process.platform !== 'darwin') app.quit(); });
