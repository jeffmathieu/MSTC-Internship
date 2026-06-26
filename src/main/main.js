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
const {
  completedLaps,
  lapPaceEligible,
  driverStats,
  carStats,
  carsInClass,
  buildDashboardAnalysis
} = require('../shared/lapAnalytics');
const {
  DEFAULT_RULES: DEFAULT_PIT_RULES,
  buildPitstopPlan,
  nextPitStateFromRow
} = require('../shared/pitstopPlanner');

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

// Stores the latest live table row per car. Live sector columns describe the
// lap currently in progress, while LAST describes the most recently completed
// lap. When LAST changes, the previous row's sector values are the best sector
// evidence we have for the lap that just completed.
const latestLiveRowByCar = new Map();
const latestPitStateByCar = new Map();

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
  analyticsSummary: null,
  pitstopPlan: null,
  storageSessionFolder: '',
  pollIntervalMs: 5000
};

// Electron chooses a safe OS-specific folder for app settings. Race data is
// stored in Documents by default so users can easily find CSV/JSON exports.
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultStorageFolder = () => path.join(app.getPath('documents'), 'ZolderLiveTimingReader');
const DEFAULT_POLL_INTERVAL_MS = 5000;

function normalizeSettings(settings) {
  return {
    ...settings,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    pitRules: {
      ...DEFAULT_PIT_RULES,
      ...(settings?.pitRules || {})
    }
  };
}

// Loads saved user settings. If the settings file does not exist or cannot be
// parsed, the app falls back to defaults. Adjust default URLs, intervals, or
// reference values here when changing the initial app configuration.
function loadSettings() {
  try {
    const file = settingsPath();
    if (fs.existsSync(file)) return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    console.error('Could not load settings', error);
  }
  return normalizeSettings({
    timingUrl: 'https://livetiming.getraceresults.com/demo#screen-results',
    followedCar: '33',
    comparisonCar: '',
    storageFolder: defaultStorageFolder(),
    pitRules: DEFAULT_PIT_RULES,
    setupComplete: false
  });
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

function slugPart(value, fallback = 'session') {
  const slug = cleanText(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

function providerOrHostFromUrl(url) {
  const provider = detectSourceProvider({ timingUrl: url });
  if (provider !== 'unknown') return provider;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'timing'; }
}

function uniqueFolderPath(baseFolder, folderName) {
  let candidate = path.join(baseFolder, folderName);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseFolder, `${folderName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function createStorageSessionFolder(settings, url, startedAt) {
  const baseFolder = settings.storageFolder || defaultStorageFolder();
  fs.mkdirSync(baseFolder, { recursive: true });
  const timestamp = new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
  const provider = slugPart(providerOrHostFromUrl(url), 'timing');
  const followedCar = settings.followedCar ? `car-${slugPart(settings.followedCar, 'unknown')}` : 'car-unknown';
  const folder = uniqueFolderPath(baseFolder, `${timestamp}_${provider}_${followedCar}`);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

// Makes sure the active session storage folder exists before writing
// exports/history. The user-selected storageFolder is treated as a base folder;
// startCollector() creates a session-specific child folder for each live run.
function ensureStorage(settings) {
  const folder = collectorState.storageSessionFolder || settings.storageFolder || defaultStorageFolder();
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

function averageLapForPitPlan(settings) {
  const analysis = collectorState.analyticsSummary?.dashboardAnalysis;
  const fromCurrentStint = analysis?.classComparison?.ourCurrentStint?.averageLapMs;
  const fromOurCar = collectorState.analyticsSummary?.cars?.find((car) => String(car.carNumber) === String(settings.followedCar || ''))?.averageLapMs;
  const n = Number(fromCurrentStint ?? fromOurCar);
  return Number.isFinite(n) ? n : null;
}

function updatePitState(settings, rows, context) {
  const followedCar = String(settings.followedCar || '');
  const row = (rows || []).find((candidate) => String(candidate.carNumber) === followedCar);
  if (!followedCar || !row) return latestPitStateByCar.get(followedCar) || { completedPitStops: 0, validCompletedPitStops: 0 };

  const previous = latestPitStateByCar.get(followedCar) || { completedPitStops: 0, validCompletedPitStops: 0, rawPitCount: null, lastPitAt: '', lastPitElapsedMs: null };
  const next = nextPitStateFromRow({
    previous,
    row,
    session: context?.session || {},
    rules: settings.pitRules,
    averageLapMs: averageLapForPitPlan(settings),
    collectedAt: context?.collectedAt || new Date().toISOString()
  });
  latestPitStateByCar.set(followedCar, next);
  return next;
}

function writePitstopPlan(settings, context, rows) {
  const folder = ensureStorage(settings);
  const pitState = updatePitState(settings, rows, context);
  const plan = buildPitstopPlan({
    rows,
    session: context?.session || {},
    followedCarNumber: settings.followedCar || '',
    pitState,
    rules: {
      ...settings.pitRules,
      averageLapMs: averageLapForPitPlan(settings)
    }
  });
  fs.writeFileSync(path.join(folder, 'pitstop_plan.json'), JSON.stringify({ ...plan, pitState }, null, 2));
  collectorState.pitstopPlan = { ...plan, pitState };
  return collectorState.pitstopPlan;
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
    baseStorageFolder: settings.storageFolder || defaultStorageFolder(),
    storageFolder: folder,
    storageSchemaVersion: 1
  }, null, 2));
}

function compactStats(stats) {
  if (!stats) return null;
  const { laps, ...compact } = stats;
  return compact;
}

function compactDashboardAnalysis(analysis) {
  if (!analysis) return null;
  return {
    ...analysis,
    driverComparison: analysis.driverComparison ? {
      ...analysis.driverComparison,
      bestDriver: compactStats(analysis.driverComparison.bestDriver),
      currentDriver: compactStats(analysis.driverComparison.currentDriver)
    } : null,
    classComparison: analysis.classComparison ? {
      ...analysis.classComparison,
      ourCar: compactStats(analysis.classComparison.ourCar),
      ourCurrentStint: compactStats(analysis.classComparison.ourCurrentStint),
      bestClassCar: compactStats(analysis.classComparison.bestClassCar),
      selectedCar: compactStats(analysis.classComparison.selectedCar)
    } : null
  };
}

function buildAnalyticsSummary(settings, context) {
  const history = collectorState.lapHistory || [];
  const laps = completedLaps(history);
  const carNumbers = [...new Set(laps.map((lap) => lap.carNumber).filter(Boolean))];
  const classNames = [...new Set(laps.map((lap) => lap.className).filter(Boolean))];
  const selectedCarNumber = settings.comparisonCar || settings.selectedComparisonCar || '';

  return {
    storageSchemaVersion: 1,
    generatedFrom: 'lap_history',
    updatedAt: context?.collectedAt || new Date().toISOString(),
    followedCar: settings.followedCar || '',
    selectedComparisonCar: selectedCarNumber,
    lapCount: laps.length,
    paceLapCount: laps.filter(lapPaceEligible).length,
    cars: carNumbers.map((carNumber) => compactStats(carStats(history, carNumber))),
    classes: classNames.map((className) => ({
      className,
      cars: carsInClass(history, className).map(compactStats)
    })),
    driversByCar: Object.fromEntries(carNumbers.map((carNumber) => [
      carNumber,
      driverStats(history, carNumber).map(compactStats)
    ])),
    dashboardAnalysis: compactDashboardAnalysis(buildDashboardAnalysis(history, {
      ourCarNumber: settings.followedCar || '',
      selectedCarNumber
    }))
  };
}

function writeAnalyticsSummary(settings, context) {
  const folder = ensureStorage(settings);
  const summary = buildAnalyticsSummary(settings, context);
  fs.writeFileSync(path.join(folder, 'analytics_summary.json'), JSON.stringify(summary, null, 2));
  collectorState.analyticsSummary = summary;
  return summary;
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
  latestLiveRowByCar.clear();
  latestPitStateByCar.clear();
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

function liveRowKey(row) {
  return [row.sourceProvider, row.timingUrl, row.sessionName, row.carNumber].join('|');
}

function withoutCurrentSectors(row) {
  return {
    ...row,
    sector1: '',
    sector2: '',
    sector3: '',
    sector1Flag: '',
    sector2Flag: '',
    sector3Flag: '',
    sector1Eligible: '',
    sector2Eligible: '',
    sector3Eligible: ''
  };
}

function completedLapRowFromLiveRow(row, previousRow) {
  if (!previousRow) return withoutCurrentSectors(row);
  return {
    ...row,
    driverName: previousRow.driverName || row.driverName,
    sector1: previousRow.sector1 || '',
    sector2: previousRow.sector2 || '',
    sector3: previousRow.sector3 || '',
    sector1Flag: previousRow.sector1Flag || '',
    sector2Flag: previousRow.sector2Flag || '',
    sector3Flag: previousRow.sector3Flag || '',
    sector1Eligible: previousRow.sector1Eligible || '',
    sector2Eligible: previousRow.sector2Eligible || '',
    sector3Eligible: previousRow.sector3Eligible || ''
  };
}

// Stores newly completed laps from provider-independent normalized storage rows.
function updateLapHistory(settings, storageRows) {
  const newEntries = [];
  storageRows.forEach((row) => {
    if (!row.carNumber || !row.lastLap) return;
    const carKey = liveRowKey(row);
    const previousRow = latestLiveRowByCar.get(carKey);
    latestLiveRowByCar.set(carKey, row);

    if (previousRow && previousRow.lastLap === row.lastLap) return;

    const completedRow = completedLapRowFromLiveRow(row, previousRow);
    const entry = lapRecordFromNormalizedRow(completedRow);
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
    const { storageRows, context } = saveLatestSnapshot(settings, normalized);
    const newLapCount = updateLapHistory(settings, storageRows);
    let analyticsSummary = collectorState.analyticsSummary;
    let pitstopPlan = collectorState.pitstopPlan;
    try { analyticsSummary = writeAnalyticsSummary(settings, context); } catch (error) { addError(error, 'writeAnalyticsSummary'); }
    try { pitstopPlan = writePitstopPlan(settings, context, normalized.rows); } catch (error) { addError(error, 'writePitstopPlan'); }
    collectorState = {
      ...collectorState,
      mode: 'live',
      status: normalized.status,
      message: newLapCount ? `${normalized.message} Stored ${newLapCount} new completed lap(s).` : normalized.message,
      lastSuccessAt: new Date().toISOString(), headers: normalized.headers, rows: normalized.rows, session: normalized.session, diagnostics: normalized.diagnostics,
      storage: storageInfo(settings), analyticsSummary, pitstopPlan, pollIntervalMs: Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS),
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
  const baseFolder = settings.storageFolder || defaultStorageFolder();
  const folder = collectorState.storageSessionFolder || baseFolder;
  return {
    baseFolder,
    folder,
    latestRowsCsv: path.join(folder, 'latest_live_rows.csv'),
    latestRowsJson: path.join(folder, 'latest_live_rows.json'),
    lapHistoryCsv: path.join(folder, 'lap_history.csv'),
    lapHistoryJsonl: path.join(folder, 'lap_history.jsonl'),
    parserDebugJson: path.join(folder, 'parser_debug.json'),
    sessionMetadataJson: path.join(folder, 'session_metadata.json'),
    analyticsSummaryJson: path.join(folder, 'analytics_summary.json'),
    pitstopPlanJson: path.join(folder, 'pitstop_plan.json')
  };
}

// Starts live collection for a URL. It opens/loads the hidden live window, does
// an immediate poll, then schedules repeated polls.
// Poll frequency is controlled by settings.pollIntervalMs.
async function startCollector(url) {
  stopCollector(false);
  const settings = loadSettings();
  const startedAt = new Date().toISOString();
  const storageSessionFolder = createStorageSessionFolder(settings, url, startedAt);
  latestPitStateByCar.clear();
  collectorState = { ...collectorState, mode: 'live', status: 'loading', message: 'Loading live timing page...', url, startedAt, lastPollAt: null, lastSuccessAt: null, headers: [], rows: [], lapHistory: [], session: {}, diagnostics: {}, errors: [], snapshots: [], storage: {}, analyticsSummary: null, pitstopPlan: null, storageSessionFolder, pollIntervalMs: Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) };
  collectorState = { ...collectorState, lapHistory: loadExistingHistory(settings), storage: storageInfo(settings) };
  broadcastState();
  try {
    const win = createLiveWindow();
    win.webContents.removeAllListeners('did-fail-load');
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => { collectorState.status = 'error'; collectorState.message = `Live timing page failed to load: ${errorDescription} (${errorCode})`; addError(new Error(errorDescription), 'did-fail-load'); broadcastState(); });
    await win.loadURL(url);
    collectorState.status = 'connected'; collectorState.message = 'Live timing page loaded. Waiting for timing table...'; broadcastState();
    await pollLivePage();
    pollTimer = setInterval(pollLivePage, Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS));
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
  const previous = loadSettings();
  const merged = { ...previous, ...settings };
  // Clamp user-editable timing values so accidental input cannot create an
  // unusably fast/slow collector.
  merged.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  saveSettings(merged);
  if ((previous.storageFolder || '') !== (merged.storageFolder || '')) {
    collectorState = {
      ...collectorState,
      lapHistory: loadExistingHistory(merged),
      storage: storageInfo(merged),
      snapshots: []
    };
    broadcastState();
  }
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
