const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  cleanText,
  parseTimingRow,
  looksLikeTimingHeaders,
  parseSessionInfo
} = require('../shared/parser');
const {
  LAP_HISTORY_COLUMNS,
  normalizeForStorage,
  analysisRowsFromParsedRows,
  lapRecordFromNormalizedRow,
  completedLapRowFromLiveRow,
  lapIdentity,
  toCsvRows,
  detectSourceProvider
} = require('../shared/storageSchema');
const {
  completedLaps,
  lapPaceEligible,
  representativePaceLaps,
  captureSectorFlags,
  driverStats,
  carStats,
  carsInClass,
  lapsForCar,
  statsByCondition,
  currentStintStats,
  buildDashboardAnalysis
} = require('../shared/lapAnalytics');
const {
  DEFAULT_RULES: DEFAULT_PIT_RULES,
  buildPitstopPlan,
  nextPitStateFromRow,
  nextFcyGapState
} = require('../shared/pitstopPlanner');
const { pitstopCircuitById, normalizePitstopCircuitId } = require('../shared/pitstopCircuits');
const { buildLapPrediction } = require('../shared/lapPrediction');
const { buildAdjacentClassBattles } = require('../shared/classBattle');
const {
  DEFAULT_PACE_WINDOW: DEFAULT_GAP_PACE_WINDOW,
  DEFAULT_PIT_SUPPRESSION_LAPS,
  updateGapMemory
} = require('../shared/gapMemory');
const { normalizeMode, buildComparisonView, qualifyingAdjacentView } = require('../shared/sessionMode');
const { stintsForCar, buildStintState } = require('../shared/stintTracker');
const { buildTimingHighlights } = require('../shared/timingHighlights');
const { resolveSessionFolder, loadSessionHistory, loadStoredJson } = require('../shared/storageSession');
const { setupAutoUpdates } = require('./autoUpdater');
const { setupAppLifecycle } = require('./appLifecycle');
const { writeClosedStintArtifacts, writeEventSummaryArtifacts } = require('./stintReports');
const {
  normalizeTrackCondition,
  normalizeAnalysisFilter,
  resolveAnalysisCondition,
  captureSectorConditions,
  conditionFilteredHistory
} = require('../shared/trackConditions');

// Main-process references. Electron keeps UI windows and timers alive through
// these variables, so every start/stop function below updates them carefully.
let mainWindow;
let liveWindow;
const additionalDashboardWindows = new Map();
const graphWindowsByCar = new Map();
let pollTimer;
let shouldCloseLiveWindow = false;
let gapMemoryState = null;
const pendingStintReports = new Set();

// A real application quit must bypass the hidden live window's normal
// close-to-hide behavior and stop the polling timer before Electron exits.
const appLifecycle = setupAppLifecycle({
  app,
  onBeforeQuit: () => {
    shouldCloseLiveWindow = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
});

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
const latestFcyGapStateByCar = new Map();

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
  lapPrediction: null,
  lapPredictionsByCar: {},
  pitstopPlan: null,
  pitstopPlansByCar: {},
  gapMemory: null,
  stintState: null,
  storageSessionFolder: '',
  pollIntervalMs: 5000
};

// Electron chooses a safe OS-specific folder for app settings. Race data is
// stored in Documents by default so users can easily find CSV/JSON exports.
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaultStorageFolder = () => path.join(app.getPath('documents'), 'ZolderLiveTimingReader');
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_REFERENCE_TIMES = {
  lapMs: null,
  sector1Ms: null,
  sector2Ms: null,
  sector3Ms: null
};
const MAX_FOLLOWED_CARS = 3;

function normalizeFollowedCars(settings = {}) {
  const candidates = Array.isArray(settings.followedCars) ? settings.followedCars : [];
  const primary = String(settings.followedCar || candidates[0] || '33').trim();
  return [...new Set([primary, ...candidates].map((car) => String(car || '').trim()).filter(Boolean))].slice(0, MAX_FOLLOWED_CARS);
}

function normalizeSettings(settings) {
  const followedCars = normalizeFollowedCars(settings);
  const sessionMode = normalizeMode(settings?.sessionMode);
  const theme = settings?.theme === 'dark' ? 'dark' : 'light';
  const pitCircuitId = normalizePitstopCircuitId(settings?.pitCircuitId || settings?.pitRules?.circuitId);
  const pitCircuit = pitstopCircuitById(pitCircuitId);
  const configuredPitDistance = Number(settings?.pitRules?.regularTrackDistanceMeters);
  const configuredFcySpeed = Number(settings?.pitRules?.fcySpeedKph);
  const trackCondition = normalizeTrackCondition(settings?.trackCondition, 'dry');
  const requestedAnalysisFilter = normalizeAnalysisFilter(settings?.analysisConditionFilter, 'combined');
  const analysisConditionFilter = ['dry', 'wet'].includes(requestedAnalysisFilter)
    ? requestedAnalysisFilter
    : 'combined';
  const conditionPhaseCounter = Math.max(1, Math.floor(Number(settings?.conditionPhaseCounter) || 1));
  const legacyReferenceTimes = { ...DEFAULT_REFERENCE_TIMES, ...(settings?.referenceTimes || {}) };
  const referenceTimesByMode = {
    race: { ...DEFAULT_REFERENCE_TIMES, ...(settings?.referenceTimesByMode?.race || legacyReferenceTimes) },
    practice: { ...DEFAULT_REFERENCE_TIMES, ...(settings?.referenceTimesByMode?.practice || {}) },
    qualifying: { ...DEFAULT_REFERENCE_TIMES, ...(settings?.referenceTimesByMode?.qualifying || {}) }
  };
  return {
    ...settings,
    followedCar: followedCars[0] || '33',
    followedCars,
    sessionMode,
    theme,
    trackCondition,
    analysisConditionFilter,
    conditionPhaseCounter,
    conditionPhaseId: String(settings?.conditionPhaseId || `${trackCondition}-${conditionPhaseCounter}`),
    pitCircuitId,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    referenceTimesByMode,
    referenceTimes: referenceTimesByMode[sessionMode],
    pitRules: {
      ...DEFAULT_PIT_RULES,
      ...(settings?.pitRules || {}),
      circuitId: pitCircuitId,
      regularTrackDistanceMeters: Number.isFinite(configuredPitDistance) && configuredPitDistance > 0
        ? configuredPitDistance
        : pitCircuit?.regularTrackDistanceMeters ?? null,
      fcySpeedKph: Number.isFinite(configuredFcySpeed) && configuredFcySpeed > 0
        ? configuredFcySpeed
        : pitCircuit?.fcySpeedKph ?? DEFAULT_PIT_RULES.fcySpeedKph
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
    followedCars: ['33'],
    sessionMode: 'race',
    trackCondition: 'dry',
    analysisConditionFilter: 'combined',
    conditionPhaseCounter: 1,
    conditionPhaseId: 'dry-1',
    comparisonCar: '',
    referenceTimes: DEFAULT_REFERENCE_TIMES,
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

// Track-condition changes are append-only race events. Lap records also carry
// their resolved sector conditions, while this small log preserves exactly
// when the engineer changed the manual condition selector for later auditing.
function appendTrackConditionEvent(previous, next) {
  if (previous.trackCondition === next.trackCondition || !next.setupComplete) return null;
  const folder = resolveSessionFolder(
    collectorState.storageSessionFolder || next.storageFolder,
    defaultStorageFolder()
  );
  fs.mkdirSync(folder, { recursive: true });
  const event = {
    changedAt: new Date().toISOString(),
    source: 'manual',
    previousCondition: previous.trackCondition || 'unknown',
    condition: next.trackCondition,
    conditionPhaseId: next.conditionPhaseId,
    analysisConditionFilter: next.analysisConditionFilter,
    followedCars: normalizeFollowedCars(next),
    liveLapNumbers: Object.fromEntries((collectorState.rows || [])
      .filter((row) => normalizeFollowedCars(next).includes(String(row.carNumber)))
      .map((row) => [String(row.carNumber), row.lapNumber ?? row.laps ?? null]))
  };
  fs.appendFileSync(path.join(folder, 'track_condition_events.jsonl'), `${JSON.stringify(event)}\n`);
  fs.writeFileSync(path.join(folder, 'track_condition_state.json'), JSON.stringify(event, null, 2));
  return event;
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
  appLifecycle.attachMainWindow(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// Secondary dashboards load the same renderer with a fixed car query. They do
// not create collectors or duplicate race storage; they only select their own
// precomputed per-car view from collectorState.
function createAdditionalDashboardWindow(carNumber) {
  const key = String(carNumber || '').trim();
  if (!key) return null;
  const existing = additionalDashboardWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 1600,
    height: 990,
    minWidth: 1150,
    minHeight: 760,
    backgroundColor: '#f7f7f4',
    title: `Race Engineer Dashboard - Car #${key}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  additionalDashboardWindows.set(key, win);
  win.on('closed', () => additionalDashboardWindows.delete(key));
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { car: key, secondary: '1' } });
  return win;
}

function syncAdditionalDashboardWindows(settings = loadSettings()) {
  const desiredCars = normalizeFollowedCars(settings).slice(1);
  [...additionalDashboardWindows.entries()].forEach(([carNumber, win]) => {
    if (desiredCars.includes(carNumber)) return;
    if (!win.isDestroyed()) win.close();
    additionalDashboardWindows.delete(carNumber);
  });
  desiredCars.forEach(createAdditionalDashboardWindow);
}

// Creates a separate analysis window so four graphs can remain available
// without taking permanent space from the race dashboard. Closing this window
// destroys only the graph UI; collection continues in the main process and a
// later click creates a fresh window with the current collector state.
function openGraphsWindow(carNumber = loadSettings().followedCar) {
  const key = String(carNumber || loadSettings().followedCar || '').trim();
  const existing = graphWindowsByCar.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return true;
  }
  const graphsWindow = new BrowserWindow({
    width: 1450,
    height: 920,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#f7f7f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  graphWindowsByCar.set(key, graphsWindow);
  graphsWindow.on('closed', () => graphWindowsByCar.delete(key));
  graphsWindow.loadFile(path.join(__dirname, '../renderer/graphs.html'), { query: { car: key } });
  return true;
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
  additionalDashboardWindows.forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('collector:update', collectorState);
  });
  graphWindowsByCar.forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('collector:update', collectorState);
  });
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
  // Preserve visual line boundaries inside RIS TEAM INFO cells. Plain
  // textContent flattens "team" and "driver - car" into one ambiguous string.
  const cellText = (cell) => clean(String(cell.innerText || cell.textContent || '').replace(/(?:\r?\n)+/g, ' | '));
  const tables = Array.from(document.querySelectorAll('table')).map((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll('tr'));
    let headerCells = [];
    const explicitHeader = table.querySelector('thead tr');
    if (explicitHeader) {
      headerCells = Array.from(explicitHeader.querySelectorAll('th,td')).map(cellText);
    } else {
      const firstHeaderRow = rows.find((row) => Array.from(row.querySelectorAll('th')).length > 0) || rows[0];
      headerCells = firstHeaderRow ? Array.from(firstHeaderRow.querySelectorAll('th,td')).map(cellText) : [];
    }
    const bodyRows = rows
      .map((row) => Array.from(row.querySelectorAll('td,th')).map(cellText))
      .filter((cells) => cells.length > 0)
      .filter((cells) => cells.join('|') !== headerCells.join('|'));
    return { tableIndex, headers: headerCells, rows: bodyRows, rowCount: bodyRows.length, className: table.className || '', id: table.id || '' };
  });
  const allText = clean(document.body ? (document.body.textContent || document.body.innerText) : '');
  const labelledValue = (label) => {
    const labelElement = Array.from(document.querySelectorAll('body *'))
      .find((element) => clean(element.textContent || '') === label);
    if (!labelElement || !labelElement.parentElement) return '';
    const parentText = clean(labelElement.parentElement.innerText || labelElement.parentElement.textContent || '');
    return parentText.toLowerCase().startsWith(label.toLowerCase())
      ? clean(parentText.slice(label.length))
      : parentText;
  };
  const sessionHeading = document.querySelector('h1');
  const sessionFields = {
    status: labelledValue('Status:'),
    elapsed: labelledValue('Elapsed:'),
    remaining: labelledValue('Remaining:'),
    sessionName: sessionHeading && sessionHeading.parentElement
      ? clean(sessionHeading.parentElement.innerText || sessionHeading.parentElement.textContent || '').replace(/\s*[•·]\s*/, ' - ')
      : ''
  };
  const inputs = Array.from(document.querySelectorAll('input, select')).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', value: el.value || '', name: el.getAttribute('name') || '', id: el.id || '', placeholder: el.getAttribute('placeholder') || '' }));
  return { location: window.location.href, title: document.title || '', bodyText: allText.slice(0, 12000), sessionFields, tables, inputs, collectedAt: new Date().toISOString() };
})()`;

// Creates a checksum for snapshot rows. The UI/debug view can use this to see
// whether table contents changed between polls.
function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

// Makes sure the manually selected session folder exists before reading or
// writing race data. The same folder is deliberately reused after an app crash
// or restart so lap_history.jsonl can restore progress and prevent duplicates.
function ensureStorage(settings) {
  const folder = resolveSessionFolder(collectorState.storageSessionFolder || settings.storageFolder, defaultStorageFolder());
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
    followedCar: settings.followedCar || '',
    trackCondition: settings.trackCondition || 'unknown',
    conditionPhaseId: settings.conditionPhaseId || ''
  };
}

// Chooses the best available lap average for pit projections. Current-stint pace
// is preferred because it reflects the car/driver right now; full-car average is
// the fallback while stint data is still building.
function averageLapForPitPlan(settings, carNumber = settings.followedCar) {
  const key = String(carNumber || '');
  const currentConditionHistory = conditionFilteredHistory(
    collectorState.lapHistory || [],
    normalizeTrackCondition(settings.trackCondition)
  );
  const liveRow = (collectorState.rows || []).find((row) => String(row.carNumber) === key);
  const fromCurrentStint = currentStintStats(
    currentConditionHistory,
    key,
    liveRow?.driver || liveRow?.driverName || ''
  ).averageLapMs;
  const fromOurCar = carStats(currentConditionHistory, key).averageLapMs;
  const n = Number(fromCurrentStint ?? fromOurCar);
  return Number.isFinite(n) ? n : null;
}

// Maintains the in-memory pit state for the followed car. The shared planner
// owns the rule for whether a new PIT-count increase is valid; main.js keeps the
// resulting state between polls.
function updatePitState(settings, rows, context, carNumber = settings.followedCar) {
  const followedCar = String(carNumber || '');
  const row = (rows || []).find((candidate) => String(candidate.carNumber) === followedCar);
  if (!followedCar || !row) return latestPitStateByCar.get(followedCar) || { completedPitStops: 0, validCompletedPitStops: 0 };

  const previous = latestPitStateByCar.get(followedCar) || { completedPitStops: 0, validCompletedPitStops: 0, rawPitCount: null, lastPitAt: '', lastPitElapsedMs: null, validPitElapsedHistoryMs: [] };
  const next = nextPitStateFromRow({
    previous,
    row,
    session: context?.session || {},
    rules: settings.pitRules,
    averageLapMs: averageLapForPitPlan(settings, followedCar),
    collectedAt: context?.collectedAt || new Date().toISOString()
  });
  latestPitStateByCar.set(followedCar, next);
  return next;
}

// Builds and persists the pitstop plan after each successful poll. The renderer
// receives this same object through collectorState, while pitstop_plan.json lets
// external/debug tools inspect the current strategy state.
function buildAndWritePitstopPlan(settings, context, rows, carNumber) {
  const folder = ensureStorage(settings);
  const followedCarNumber = String(carNumber || '');
  const pitState = updatePitState(settings, rows, context, followedCarNumber);
  const fcyGapState = nextFcyGapState({
    previous: latestFcyGapStateByCar.get(followedCarNumber),
    session: context?.session || {},
    rows,
    collectedAt: context?.collectedAt || new Date().toISOString(),
    rules: settings.pitRules
  });
  latestFcyGapStateByCar.set(followedCarNumber, fcyGapState);
  const plan = buildPitstopPlan({
    rows,
    session: context?.session || {},
    followedCarNumber,
    pitState,
    fcyGapState,
    confirmedGapView: gapMemoryState?.viewsByCar?.[followedCarNumber] || null,
    rules: {
      ...settings.pitRules,
      averageLapMs: averageLapForPitPlan(settings, followedCarNumber)
    }
  });
  const payload = { ...plan, pitState };
  fs.writeFileSync(path.join(folder, `pitstop_plan_car-${slugPart(followedCarNumber, 'unknown')}.json`), JSON.stringify(payload, null, 2));
  if (followedCarNumber === String(settings.followedCar || '')) fs.writeFileSync(path.join(folder, 'pitstop_plan.json'), JSON.stringify(payload, null, 2));
  return payload;
}

function writePitstopPlans(settings, context, rows) {
  const plans = Object.fromEntries(normalizeFollowedCars(settings).map((carNumber) => [
    carNumber,
    buildAndWritePitstopPlan(settings, context, rows, carNumber)
  ]));
  collectorState.pitstopPlansByCar = plans;
  collectorState.pitstopPlan = plans[String(settings.followedCar || '')] || null;
  return plans;
}

// Provider adapters produce app rows with canonical fields; the storage layer is
// intentionally provider-agnostic and only writes normalized storage rows.
function normalizeRowsForStorage(rows, context) {
  return rows.map((row) => normalizeForStorage(row, context));
}

// Captures the race-control state when each live sector first appears. Timing
// pages usually expose only the current global flag, so preserving the first
// observation lets analytics later distinguish green S1/S2 from an S3 that was
// completed after FCY/SC began.
function annotateLiveSectorFlags(storageRows, context) {
  const currentFlag = String(context?.session?.flag || context?.sessionFlag || '');
  return storageRows.map((row) => {
    const previous = latestLiveRowByCar.get(liveRowKey(row));
    const flagged = captureSectorFlags(row, previous, currentFlag);
    return captureSectorConditions(
      flagged,
      previous,
      context?.trackCondition || 'unknown',
      context?.conditionPhaseId || ''
    );
  });
}

function writeLatestRows(settings, normalizedRows) {
  const folder = ensureStorage(settings);
  fs.writeFileSync(path.join(folder, 'latest_live_rows.json'), JSON.stringify(normalizedRows, null, 2));
  fs.writeFileSync(path.join(folder, 'latest_live_rows.csv'), toCsvRows(normalizedRows));
}

// Commits only start/finish-confirmed GAP/INT/DIFF values. The compact state is
// overwritten for crash recovery; the append-only history supports later gap
// graphs and auditing without storing every volatile five-second poll.
function updateAndWriteGapMemory(settings, context, rows) {
  const folder = ensureStorage(settings);
  gapMemoryState = updateGapMemory(gapMemoryState || {}, {
    rows,
    followedCars: normalizeFollowedCars(settings),
    collectedAt: context?.collectedAt || new Date().toISOString(),
    paceWindow: DEFAULT_GAP_PACE_WINDOW,
    pitSuppressionLaps: DEFAULT_PIT_SUPPRESSION_LAPS
  });
  fs.writeFileSync(path.join(folder, 'gap_state.json'), JSON.stringify({ ...gapMemoryState, samples: [], newSamples: [] }, null, 2));
  if (gapMemoryState.newSamples.length) {
    fs.appendFileSync(
      path.join(folder, 'gap_history.jsonl'),
      `${gapMemoryState.newSamples.map((sample) => JSON.stringify(sample)).join('\n')}\n`
    );
  }
  collectorState.gapMemory = gapMemoryState;
  return gapMemoryState;
}

function loadExistingGapMemory(settings) {
  const folder = resolveSessionFolder(collectorState.storageSessionFolder || settings.storageFolder, defaultStorageFolder());
  try {
    const stored = loadStoredJson(fs, path.join(folder, 'gap_state.json'));
    gapMemoryState = stored && typeof stored === 'object' ? stored : null;
  } catch (error) {
    gapMemoryState = null;
    addError(error, 'loadExistingGapMemory');
  }
  collectorState.gapMemory = gapMemoryState;
  return gapMemoryState;
}

// Appends newly completed laps to JSONL and CSV. If the CSV header changed
// between versions, it rewrites the CSV from JSONL so older stored data remains
// readable after schema changes.
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

// Stores parser diagnostics that explain which timing table was selected and
// how rows were normalized. Inspect this first when a timing provider changes
// its HTML/column names.
function writeParserDebug(settings, debugInfo) {
  const folder = ensureStorage(settings);
  fs.writeFileSync(path.join(folder, 'parser_debug.json'), JSON.stringify(debugInfo, null, 2));
}

// Writes session-level metadata beside the latest rows/history so every session
// folder is self-describing.
function writeSessionMetadata(settings, context) {
  const folder = ensureStorage(settings);
  fs.writeFileSync(path.join(folder, 'session_metadata.json'), JSON.stringify({
    timingUrl: context.timingUrl || '',
    sourceProvider: context.sourceProvider || 'unknown',
    sessionName: normalizeForStorage({}, context).sessionName,
    startedAt: context.startedAt || '',
    lastUpdatedAt: context.collectedAt || '',
    followedCar: context.followedCar || '',
    followedCars: normalizeFollowedCars(settings),
    baseStorageFolder: folder,
    storageFolder: folder,
    storageSchemaVersion: 2
  }, null, 2));
}

// Removes heavy raw lap arrays before writing analytics_summary.json. Full lap
// history stays in lap_history.jsonl; dashboard summaries only need aggregates.
function compactStats(stats) {
  if (!stats) return null;
  const { laps, ...compact } = stats;
  return compact;
}

// Compacts nested dashboard analysis for the renderer/storage summary.
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

// Rebuilds all aggregate analytics from stored lap history. This runs after
// every poll, but the output stays compact enough for renderer state and disk.
function buildAnalyticsSummary(settings, context, rows = []) {
  const history = collectorState.lapHistory || [];
  const resolvedConditionFilter = resolveAnalysisCondition(settings.analysisConditionFilter, settings.trackCondition);
  const analysisHistory = conditionFilteredHistory(history, resolvedConditionFilter);
  const laps = completedLaps(history);
  const carNumbers = [...new Set(laps.map((lap) => lap.carNumber).filter(Boolean))];
  const classNames = [...new Set(laps.map((lap) => lap.className).filter(Boolean))];
  const selectedCarNumber = settings.comparisonCar || settings.selectedComparisonCar || '';
  const followedCars = normalizeFollowedCars(settings);
  const sessionMode = normalizeMode(settings.sessionMode);
  const dashboardAnalysisByCar = Object.fromEntries(followedCars.map((carNumber) => [
    carNumber,
    compactDashboardAnalysis(buildDashboardAnalysis(analysisHistory, {
      ourCarNumber: carNumber,
      selectedCarNumber,
      conditionFilter: 'combined',
      currentDriverName: (() => {
        const liveRow = rows.find((row) => String(row.carNumber) === String(carNumber));
        return liveRow?.driver || liveRow?.driverName || '';
      })()
    }))
  ]));
  const adjacentClassBattlesByCar = Object.fromEntries(followedCars.map((carNumber) => [
    carNumber,
    buildAdjacentClassBattles(rows, analysisHistory, carNumber, {
      lapWindow: gapMemoryState?.paceWindow || DEFAULT_GAP_PACE_WINDOW,
      confirmedGapView: gapMemoryState?.viewsByCar?.[carNumber] || null
    })
  ]));
  const comparisonViewsByCar = Object.fromEntries(followedCars.map((carNumber) => [
    carNumber,
    buildComparisonView({ history: analysisHistory, rows, ourCarNumber: carNumber, selectedCarNumber, mode: sessionMode })
  ]));
  const modeAdjacentViewsByCar = Object.fromEntries(followedCars.map((carNumber) => [
    carNumber,
    sessionMode === 'qualifying'
      ? qualifyingAdjacentView(analysisHistory, rows, carNumber)
      : sessionMode === 'race' ? adjacentClassBattlesByCar[carNumber] : null
  ]));
  const timingHighlightsByCar = Object.fromEntries(followedCars.map((carNumber) => [
    carNumber,
    buildTimingHighlights(history, carNumber, { conditionFilter: resolvedConditionFilter })
  ]));
  const primaryCar = String(settings.followedCar || followedCars[0] || '');

  return {
    storageSchemaVersion: 2,
    generatedFrom: 'lap_history',
    analyticsSourceOfTruth: true,
    paceSelectionRules: {
      fullLap: 'green sectors only; excludes pit-in, pit-out and timing outliers',
      sector: 'sector must be green and not pit-affected',
      outlier: 'after 3 eligible laps, excludes deviations greater than both 60 seconds and 50 percent unless sectors reconcile'
    },
    updatedAt: context?.collectedAt || new Date().toISOString(),
    followedCar: primaryCar,
    followedCars,
    sessionMode,
    trackCondition: settings.trackCondition,
    conditionPhaseId: settings.conditionPhaseId,
    analysisConditionFilter: settings.analysisConditionFilter,
    resolvedConditionFilter,
    selectedComparisonCar: selectedCarNumber,
    gapModel: {
      source: 'start-finish-confirmed-memory',
      paceWindow: gapMemoryState?.paceWindow || DEFAULT_GAP_PACE_WINDOW,
      pitSuppressionLaps: gapMemoryState?.pitSuppressionLaps || DEFAULT_PIT_SUPPRESSION_LAPS,
      sourceMode: gapMemoryState?.sourceMode || 'waiting',
      viewsByCar: gapMemoryState?.viewsByCar || {}
    },
    lapCount: laps.length,
    paceLapCount: representativePaceLaps(completedLaps(analysisHistory)).length,
    cars: carNumbers.map((carNumber) => ({
      ...compactStats(carStats(analysisHistory, carNumber)),
      byCondition: Object.fromEntries(Object.entries(statsByCondition(
        lapsForCar(history, carNumber)
      )).map(([condition, stats]) => [condition, compactStats(stats)]))
    })),
    classes: classNames.map((className) => ({
      className,
      cars: carsInClass(analysisHistory, className).map(compactStats)
    })),
    driversByCar: Object.fromEntries(carNumbers.map((carNumber) => [
      carNumber,
      driverStats(analysisHistory, carNumber).map(compactStats)
    ])),
    stintsByCar: collectorState.stintState?.cars || {},
    timingHighlightsByCar,
    adjacentClassBattlesByCar,
    comparisonViewsByCar,
    modeAdjacentViewsByCar,
    dashboardAnalysisByCar,
    adjacentClassBattles: modeAdjacentViewsByCar[primaryCar] || null,
    comparisonView: comparisonViewsByCar[primaryCar] || null,
    dashboardAnalysis: dashboardAnalysisByCar[primaryCar] || null
  };
}

// Writes analytics_summary.json and mirrors it into collectorState for the UI.
function writeAnalyticsSummary(settings, context, rows = []) {
  const folder = ensureStorage(settings);
  const summary = buildAnalyticsSummary(settings, context, rows);
  fs.writeFileSync(path.join(folder, 'analytics_summary.json'), JSON.stringify(summary, null, 2));
  collectorState.analyticsSummary = summary;
  return summary;
}

// Reconstructs driver stints from immutable lap history on every update. This
// makes stint numbering restart-safe: reopening an existing session folder
// produces the same groups without relying on transient in-memory counters.
// Closed stints receive one JSON and one Electron-generated PDF report.
async function writeStintStateAndReports(settings, context, rows = []) {
  const folder = ensureStorage(settings);
  const followedCars = normalizeFollowedCars(settings);
  const generatedAt = context?.collectedAt || new Date().toISOString();
  const sessionStatus = String(context?.session?.statusText || context?.session?.status || context?.session?.flag || '');
  const sessionFinished = /finished|complete(?:d)?|checkered|chequered|session\s+ended/i.test(sessionStatus);
  const stintOptions = {
    closeFinalAt: sessionFinished ? generatedAt : null,
    generatedAt,
    liveRows: rows,
    previousState: collectorState.stintState
  };
  const stintState = buildStintState(collectorState.lapHistory || [], followedCars, generatedAt, stintOptions);
  fs.writeFileSync(path.join(folder, 'stint_state.json'), JSON.stringify(stintState, null, 2));
  collectorState.stintState = stintState;

  for (const carNumber of followedCars) {
    const liveRow = rows.find((row) => String(row.carNumber) === String(carNumber));
    const closedStints = stintsForCar(collectorState.lapHistory || [], carNumber, {
      ...stintOptions,
      liveRow,
      previousCurrentStint: stintOptions.previousState?.cars?.[carNumber]?.currentStint || null,
      previousGeneratedAt: stintOptions.previousState?.generatedAt || null
    }).filter((stint) => stint.closed);
    for (const stint of closedStints) {
      const reportKey = `${folder}|${carNumber}|${stint.stintNumber}|${stint.driverName}`;
      if (pendingStintReports.has(reportKey)) continue;
      pendingStintReports.add(reportKey);
      try {
        await writeClosedStintArtifacts({
          BrowserWindow,
          sessionFolder: folder,
          stint,
          session: context?.session || collectorState.session || {},
          gapSamples: gapMemoryState?.samples || [],
          history: collectorState.lapHistory || [],
          referenceTimes: settings.referenceTimes || {},
          pitRules: settings.pitRules || {}
        });
      } finally {
        pendingStintReports.delete(reportKey);
      }
    }
    if (sessionFinished && closedStints.length) {
      await writeEventSummaryArtifacts({
        BrowserWindow,
        sessionFolder: folder,
        carNumber,
        stints: closedStints,
        session: context?.session || collectorState.session || {},
        gapSamples: gapMemoryState?.samples || [],
        history: collectorState.lapHistory || [],
        referenceTimes: settings.referenceTimes || {},
        pitRules: settings.pitRules || {}
      });
    }
  }
  return stintState;
}

// Builds and stores the current-lap prediction from live sectors plus completed
// lap history. The renderer only displays this object; all prediction rules stay
// in src/shared/lapPrediction.js where they are covered by focused tests.
function buildAndWriteLapPrediction(settings, context, rows, carNumber) {
  const folder = ensureStorage(settings);
  const followedCarNumber = String(carNumber || '');
  const liveRow = (rows || []).find((row) => String(row.carNumber) === String(followedCarNumber));
  const prediction = buildLapPrediction({
    history: collectorState.lapHistory || [],
    rows,
    carNumber: followedCarNumber,
    currentDriver: liveRow?.driver || liveRow?.driverName || '',
    options: { sampleSize: 10, currentCondition: settings.trackCondition }
  });
  const payload = { ...prediction, updatedAt: context?.collectedAt || new Date().toISOString() };
  fs.writeFileSync(path.join(folder, `lap_prediction_car-${slugPart(followedCarNumber, 'unknown')}.json`), JSON.stringify(payload, null, 2));
  if (followedCarNumber === String(settings.followedCar || '')) fs.writeFileSync(path.join(folder, 'lap_prediction.json'), JSON.stringify(payload, null, 2));
  return payload;
}

function writeLapPredictions(settings, context, rows) {
  const predictions = Object.fromEntries(normalizeFollowedCars(settings).map((carNumber) => [
    carNumber,
    buildAndWriteLapPrediction(settings, context, rows, carNumber)
  ]));
  collectorState.lapPredictionsByCar = predictions;
  collectorState.lapPrediction = predictions[String(settings.followedCar || '')] || null;
  return predictions;
}

// Converts parser + storage context into a small debug object for disk/UI.
function parserDebugFromNormalized(normalized, storageRows, context, lastError = '') {
  return {
    timingUrl: context.timingUrl || '',
    sourceProvider: context.sourceProvider || 'unknown',
    session: normalized.session || {},
    bodyTextSample: normalized.diagnostics?.bodyTextSample || '',
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
  latestFcyGapStateByCar.clear();
  const folder = ensureStorage(settings);
  const jsonlPath = path.join(folder, 'lap_history.jsonl');
  try {
    const { entries, knownKeys } = loadSessionHistory({ fs, jsonlPath, identityForLap: lapIdentity });
    knownKeys.forEach((key) => knownLapKeys.add(key));
    return entries;
  } catch (error) {
    addError(error, 'loadExistingHistory');
    return [];
  }
}

// Restores valid-stop counts and cooldown timestamps written on the previous
// poll. Without this, restarting shortly after a stop would incorrectly reopen
// the pit window even though lap history itself resumed correctly.
function loadExistingPitStates(settings) {
  const folder = ensureStorage(settings);
  normalizeFollowedCars(settings).forEach((carNumber) => {
    const filePath = path.join(folder, `pitstop_plan_car-${slugPart(carNumber, 'unknown')}.json`);
    try {
      const stored = loadStoredJson(fs, filePath);
      if (stored?.pitState && typeof stored.pitState === 'object') {
        latestPitStateByCar.set(String(carNumber), stored.pitState);
      }
    } catch (error) {
      addError(error, `loadExistingPitState:${carNumber}`);
    }
  });
}

function liveRowKey(row) {
  return [row.sourceProvider, row.timingUrl, row.sessionName, row.carNumber].join('|');
}

function currentPitTargetDurationMs(settings = {}) {
  const value = Number(settings.pitRules?.pitStopDurationMs);
  return Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : '';
}

// Stores newly completed laps from provider-independent normalized storage rows.
function updateLapHistory(settings, storageRows) {
  const newEntries = [];
  const pitTargetDurationMs = currentPitTargetDurationMs(settings);
  storageRows.forEach((row) => {
    if (!row.carNumber || !row.lastLap) return;
    const carKey = liveRowKey(row);
    const previousRow = latestLiveRowByCar.get(carKey);
    latestLiveRowByCar.set(carKey, row);

    if (previousRow && previousRow.lastLap === row.lastLap) return;

    const completedRow = completedLapRowFromLiveRow(row, previousRow);
    const entry = lapRecordFromNormalizedRow(completedRow);
    entry.pitTargetDurationMs = pitTargetDurationMs;
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

function normalizeManualLapStatusInput(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['fcy', 'full-course-yellow', 'full course yellow'].includes(status)) return 'fcy';
  if (['sc', 'safety-car', 'safety car'].includes(status)) return 'sc';
  if (['track-limits', 'track limits', 'tracklimits'].includes(status)) return 'track-limits';
  if (['invalid', 'ongeldig', 'excluded', 'exclude'].includes(status)) return 'invalid';
  return 'normal';
}

function manualLapPatch(status) {
  const normalized = normalizeManualLapStatusInput(status);
  if (normalized === 'fcy' || normalized === 'sc') {
    const flag = normalized === 'fcy' ? 'Full Course Yellow' : 'Safety car';
    return {
      manualLapStatus: normalized,
      sessionFlag: flag,
      lapFlag: flag,
      sector1Flag: flag,
      sector2Flag: flag,
      sector3Flag: flag,
      paceEligible: 'false',
      sector1Eligible: 'false',
      sector2Eligible: 'false',
      sector3Eligible: 'false'
    };
  }
  if (normalized === 'track-limits' || normalized === 'invalid') {
    return {
      manualLapStatus: normalized,
      paceEligible: 'false',
      sector1Eligible: 'false',
      sector2Eligible: 'false',
      sector3Eligible: 'false'
    };
  }
  return {
    manualLapStatus: '',
    sessionFlag: 'Green flag',
    lapFlag: 'Green flag',
    sector1Flag: 'Green flag',
    sector2Flag: 'Green flag',
    sector3Flag: 'Green flag',
    paceEligible: 'true',
    sector1Eligible: 'true',
    sector2Eligible: 'true',
    sector3Eligible: 'true'
  };
}

function manualLapTargetMatches(entry, target = {}) {
  if (String(entry.carNumber || '') !== String(target.carNumber || '')) return false;
  const entryLap = String(entry.lapNumber || '');
  const targetLap = String(target.lapNumber || '');
  if (entryLap && targetLap && entryLap !== targetLap) return false;
  if (target.collectedAt && entry.collectedAt) return String(entry.collectedAt) === String(target.collectedAt);
  if (target.lapTimeMs !== undefined && String(entry.lapTimeMs || '') !== String(target.lapTimeMs || '')) return false;
  return Boolean(entryLap || targetLap || target.lapTimeMs !== undefined);
}

function rewriteLapHistoryFiles(settings, history) {
  const folder = ensureStorage(settings);
  fs.writeFileSync(
    path.join(folder, 'lap_history.jsonl'),
    history.map((entry) => JSON.stringify(entry)).join('\n') + (history.length ? '\n' : '')
  );
  fs.writeFileSync(path.join(folder, 'lap_history.csv'), toCsvRows(history, LAP_HISTORY_COLUMNS));
}

function rebuildCollectorDerivedState(settings, context = null, rows = collectorState.rows || []) {
  const generatedAt = context?.collectedAt || new Date().toISOString();
  const followedCars = normalizeFollowedCars(settings);
  collectorState.stintState = buildStintState(collectorState.lapHistory || [], followedCars, generatedAt, {
    generatedAt,
    liveRows: rows,
    previousState: collectorState.stintState
  });
  fs.writeFileSync(path.join(ensureStorage(settings), 'stint_state.json'), JSON.stringify(collectorState.stintState, null, 2));
  collectorState.analyticsSummary = writeAnalyticsSummary(settings, context || { collectedAt: generatedAt, session: collectorState.session || {} }, rows);
  collectorState.lapPredictionsByCar = writeLapPredictions(settings, context || { collectedAt: generatedAt }, rows);
  if (normalizeMode(settings.sessionMode) === 'race') {
    collectorState.pitstopPlansByCar = writePitstopPlans(settings, context || { collectedAt: generatedAt, session: collectorState.session || {} }, rows);
  }
  const primaryCar = String(settings.followedCar || '');
  collectorState.lapPrediction = collectorState.lapPredictionsByCar?.[primaryCar] || null;
  collectorState.pitstopPlan = collectorState.pitstopPlansByCar?.[primaryCar] || null;
  collectorState.storage = storageInfo(settings);
  return collectorState;
}

function updateStoredLapManualStatus(payload = {}) {
  const settings = loadSettings();
  const patch = manualLapPatch(payload.status);
  let changed = false;
  const nextHistory = (collectorState.lapHistory || []).map((entry) => {
    if (!manualLapTargetMatches(entry, payload)) return entry;
    changed = true;
    return { ...entry, ...patch };
  });
  if (!changed) return { ok: false, message: 'Lap not found', state: collectorState };
  collectorState.lapHistory = nextHistory;
  rewriteLapHistoryFiles(settings, nextHistory);
  rebuildCollectorDerivedState(settings);
  collectorState.message = `Lap ${payload.lapNumber || ''} marked as ${normalizeManualLapStatusInput(payload.status)}.`;
  broadcastState();
  return { ok: true, state: collectorState };
}

// Writes the latest table/session snapshot to predictable filenames. These files
// are overwritten on every successful poll/tick so external tools can read the
// current state without searching for timestamps.
// It returns both storage rows and context because history/analytics/pit logic
// all need to use the exact same timestamp/session metadata.
function saveLatestSnapshot(settings, normalized) {
  try {
    const collectedAt = new Date().toISOString();
    const context = storageContext(settings, normalized, collectedAt);
    const storageRows = annotateLiveSectorFlags(normalizeRowsForStorage(normalized.rows, context), context);
    const analysisRows = analysisRowsFromParsedRows(normalized.rows, storageRows);
    writeLatestRows(settings, storageRows);
    writeParserDebug(settings, parserDebugFromNormalized(normalized, storageRows, context));
    writeSessionMetadata(settings, context);
    return { storageRows, analysisRows, context };
  } catch (error) { addError(error, 'saveLatestSnapshot'); }
  return { storageRows: [], analysisRows: [], context: null };
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
    const { storageRows, analysisRows, context } = saveLatestSnapshot(settings, normalized);
    const newLapCount = updateLapHistory(settings, storageRows);
    try { updateAndWriteGapMemory(settings, context, analysisRows); } catch (error) { addError(error, 'updateAndWriteGapMemory'); }
    let stintState = collectorState.stintState;
    let analyticsSummary = collectorState.analyticsSummary;
    let lapPredictionsByCar = collectorState.lapPredictionsByCar;
    let pitstopPlansByCar = collectorState.pitstopPlansByCar;
    try { stintState = await writeStintStateAndReports(settings, context, analysisRows); } catch (error) { addError(error, 'writeStintStateAndReports'); }
    try { analyticsSummary = writeAnalyticsSummary(settings, context, analysisRows); } catch (error) { addError(error, 'writeAnalyticsSummary'); }
    try { lapPredictionsByCar = writeLapPredictions(settings, context, analysisRows); } catch (error) { addError(error, 'writeLapPredictions'); }
    if (normalizeMode(settings.sessionMode) === 'race') {
      try { pitstopPlansByCar = writePitstopPlans(settings, context, analysisRows); } catch (error) { addError(error, 'writePitstopPlans'); }
    } else {
      pitstopPlansByCar = {};
      collectorState.pitstopPlansByCar = {};
      collectorState.pitstopPlan = null;
    }
    const primaryCar = String(settings.followedCar || '');
    collectorState = {
      ...collectorState,
      mode: 'live',
      status: normalized.status,
      message: newLapCount ? `${normalized.message} Stored ${newLapCount} new completed lap(s).` : normalized.message,
      lastSuccessAt: new Date().toISOString(), headers: normalized.headers, rows: analysisRows, session: normalized.session, diagnostics: normalized.diagnostics,
      storage: storageInfo(settings), analyticsSummary, lapPredictionsByCar, pitstopPlansByCar, gapMemory: gapMemoryState, stintState,
      lapPrediction: lapPredictionsByCar?.[primaryCar] || null,
      pitstopPlan: pitstopPlansByCar?.[primaryCar] || null,
      pollIntervalMs: Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS),
      snapshots: [{ at: new Date().toISOString(), checksum: hashObject(analysisRows), rowCount: analysisRows.length, newLapCount }, ...collectorState.snapshots].slice(0, 20)
    };
  } catch (error) {
    collectorState.status = 'error'; collectorState.message = 'Could not read the live timing page. See Debug for details.'; addError(error, 'pollLivePage');
  }
  broadcastState();
}

// Returns user-facing paths for the Debug/Storage UI. Add new exported files
// here if the renderer should display their locations.
function storageInfo(settings) {
  const folder = resolveSessionFolder(collectorState.storageSessionFolder || settings.storageFolder, defaultStorageFolder());
  return {
    baseFolder: folder,
    folder,
    latestRowsCsv: path.join(folder, 'latest_live_rows.csv'),
    latestRowsJson: path.join(folder, 'latest_live_rows.json'),
    lapHistoryCsv: path.join(folder, 'lap_history.csv'),
    lapHistoryJsonl: path.join(folder, 'lap_history.jsonl'),
    parserDebugJson: path.join(folder, 'parser_debug.json'),
    sessionMetadataJson: path.join(folder, 'session_metadata.json'),
    analyticsSummaryJson: path.join(folder, 'analytics_summary.json'),
    lapPredictionJson: path.join(folder, 'lap_prediction.json'),
    pitstopPlanJson: path.join(folder, 'pitstop_plan.json'),
    gapStateJson: path.join(folder, 'gap_state.json'),
    gapHistoryJsonl: path.join(folder, 'gap_history.jsonl'),
    stintStateJson: path.join(folder, 'stint_state.json'),
    stintsFolder: path.join(folder, 'stints')
  };
}

// Starts live collection for a URL. It opens/loads the hidden live window, does
// an immediate poll, then schedules repeated polls.
// Poll frequency is controlled by settings.pollIntervalMs.
async function startCollector(url) {
  stopCollector(false);
  const settings = loadSettings();
  const startedAt = new Date().toISOString();
  const storageSessionFolder = resolveSessionFolder(settings.storageFolder, defaultStorageFolder());
  fs.mkdirSync(storageSessionFolder, { recursive: true });
  latestPitStateByCar.clear();
  gapMemoryState = null;
  collectorState = { ...collectorState, mode: 'live', status: 'loading', message: 'Loading live timing page...', url, startedAt, lastPollAt: null, lastSuccessAt: null, headers: [], rows: [], lapHistory: [], session: {}, diagnostics: {}, errors: [], snapshots: [], storage: {}, analyticsSummary: null, lapPrediction: null, lapPredictionsByCar: {}, pitstopPlan: null, pitstopPlansByCar: {}, gapMemory: null, stintState: null, storageSessionFolder, pollIntervalMs: Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) };
  collectorState = { ...collectorState, lapHistory: loadExistingHistory(settings), storage: storageInfo(settings) };
  collectorState.stintState = buildStintState(collectorState.lapHistory, normalizeFollowedCars(settings), startedAt);
  loadExistingPitStates(settings);
  loadExistingGapMemory(settings);
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
  const requestedCondition = settings?.trackCondition === undefined
    ? previous.trackCondition
    : normalizeTrackCondition(settings.trackCondition, previous.trackCondition || 'dry');
  const conditionChanged = requestedCondition !== previous.trackCondition;
  const conditionPhaseCounter = conditionChanged
    ? Math.max(1, Number(previous.conditionPhaseCounter) || 1) + 1
    : previous.conditionPhaseCounter;
  const merged = normalizeSettings({
    ...previous,
    ...settings,
    trackCondition: requestedCondition,
    conditionPhaseCounter,
    conditionPhaseId: conditionChanged
      ? `${requestedCondition}-${conditionPhaseCounter}`
      : previous.conditionPhaseId
  });
  // Clamp user-editable timing values so accidental input cannot create an
  // unusably fast/slow collector.
  merged.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  saveSettings(merged);
  try { appendTrackConditionEvent(previous, merged); } catch (error) { addError(error, 'appendTrackConditionEvent'); }
  syncAdditionalDashboardWindows(merged);
  if (previous.theme !== merged.theme) {
    BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('theme:update', merged.theme));
  }
  if ((previous.storageFolder || '') !== (merged.storageFolder || '')) {
    // Activate the new folder before loading; ensureStorage() intentionally
    // prefers collectorState.storageSessionFolder while a session is open.
    collectorState.storageSessionFolder = merged.storageFolder || defaultStorageFolder();
    const lapHistory = loadExistingHistory(merged);
    loadExistingPitStates(merged);
    loadExistingGapMemory(merged);
    collectorState = {
      ...collectorState,
      lapHistory,
      stintState: buildStintState(lapHistory, normalizeFollowedCars(merged)),
      storage: storageInfo(merged),
      snapshots: []
    };
    broadcastState();
  }
  return merged;
});

// Opens a native folder picker and stores the chosen export/history directory.
ipcMain.handle('storage:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose or create the folder for this race session',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('collector:start', (_event, url) => startCollector(url));
ipcMain.handle('collector:stop', () => stopCollector(true));
ipcMain.handle('collector:getState', () => collectorState);
ipcMain.handle('collector:openLiveWindow', () => { if (liveWindow && !liveWindow.isDestroyed()) { liveWindow.show(); liveWindow.focus(); return true; } return false; });
ipcMain.handle('graphs:open', (_event, carNumber) => openGraphsWindow(carNumber));
ipcMain.handle('laps:updateStatus', (_event, payload) => updateStoredLapManualStatus(payload));

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

// Electron app startup. Shutdown behavior is registered through appLifecycle
// above so it is consistent on macOS, Windows, and Linux.
app.whenReady().then(() => {
  createMainWindow();
  syncAdditionalDashboardWindows(loadSettings());
  setupAutoUpdates({
    app,
    dialog,
    autoUpdater,
    getParentWindow: () => mainWindow,
    onBeforeQuitAndInstall: () => appLifecycle.beginQuit()
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      syncAdditionalDashboardWindows(loadSettings());
    }
  });
});
