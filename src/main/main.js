const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { adaptTimingFeed } = require('../shared/timingFeed');
const { nextProviderFreshness } = require('../shared/providerFreshness');
const { updatePitEvents, serviceTimers } = require('../shared/pitEvents');
const { normalizeFuelConfig, updateFuelState, fuelAction, fuelSummary } = require('../shared/fuelModel');
const { createRendererChannel, compactView } = require('./rendererState');
const { createSnapshotWriter } = require('./snapshotWriter');
const {
  cleanText,
  parseTimingRow,
  looksLikeTimingHeaders,
  parseSessionInfo,
  applySingleClassFallback
} = require('../shared/parser');
const {
  LAP_HISTORY_COLUMNS,
  normalizeForStorage,
  analysisRowsFromParsedRows,
  lapRecordFromNormalizedRow,
  completedLapRowFromLiveRow,
  liveRowIdentity,
  lapIdentity,
  toCsvRows,
  detectSourceProvider
} = require('../shared/storageSchema');
const {
  completedLaps,
  prepareHistory,
  prepareConditionHistory,
  lapPaceEligible,
  representativePaceLaps,
  sectorCaptureTransition,
  captureSectorFlags,
  driverStats,
  carStats,
  carStatsWithProviderBest,
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
const { preferStableSessionName } = require('../shared/sessionName');
const { drivingStintsForCar: stintsForCar, buildDrivingStintState: buildStintState } = require('../shared/stintTracker');
const { updateSessionTiming } = require('../shared/sessionTiming');
const { followedClassCompletion, updateFinishCountdown } = require('../shared/sessionCompletion');
const { buildTimingHighlights } = require('../shared/timingHighlights');
const { resolveSessionFolder, loadSessionHistory, loadStoredJson, resolveFinalReportSettings,
  readJsonLines, appendJsonLines, atomicWriteFile, resolveSessionEndAt } = require('../shared/storageSession');
const { setupAutoUpdates } = require('./autoUpdater');
const { setupAppLifecycle } = require('./appLifecycle');
const { haltCollectorForCompletion } = require('./collectorCompletion');
const { printHtmlToPdf } = require('./stintReports');
const { createReportQueue } = require('./reportQueue');
const {
  normalizeTrackCondition,
  normalizeAnalysisFilter,
  resolveAnalysisCondition,
  captureSectorConditions
} = require('../shared/trackConditions');

// Main-process references. Electron keeps UI windows and timers alive through
// these variables, so every start/stop function below updates them carefully.
let mainWindow;
let liveWindow;
const additionalDashboardWindows = new Map();
const graphWindowsByCar = new Map();
let pollTimer;
let pollInFlight = false;
let activePoll = Promise.resolve();
let finishPoll = null;
let shouldCloseLiveWindow = false;
let gapMemoryState = null;
const pendingStintReports = new Set();
let automaticCompletionHandled = false;
let feedState = {};
let providerFreshness = {};
const lapReconciliationByCar = new Map();
const serviceStates = new Map();
const fuelStates = new Map();
const sequenceByCar = new Map();
const checkedCsvHeaders = new Set();
const rendererChannels = new Map();
const snapshotWriter = createSnapshotWriter((error, context) => addError(error, context));
const reportQueue = createReportQueue((html, pdfPath) => printHtmlToPdf(BrowserWindow, html, pdfPath));
const completedReportKeys = new Set();

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
// A changed LAST value needs the previous snapshot exactly once to finish the
// old lap. The next poll clears that evidence so FCY/SC sector flags cannot
// leak into a new green lap when a provider temporarily repeats sector values.
const sectorCaptureResetPendingByCar = new Set();
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
  sessionTiming: null,
  finishCountdown: null,
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
    fuelByCar: Object.fromEntries(Object.entries(settings?.fuelByCar || {}).map(([car, config]) => [car, normalizeFuelConfig(config)])),
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('collector:update', stateForRenderer(mainWindow.webContents));
  additionalDashboardWindows.forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('collector:update', stateForRenderer(win.webContents));
  });
  graphWindowsByCar.forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('collector:update', stateForRenderer(win.webContents));
  });
}

function stateForRenderer(contents, reset = false) {
  if (!rendererChannels.has(contents.id)) {
    rendererChannels.set(contents.id, createRendererChannel());
    contents.once('destroyed', () => rendererChannels.delete(contents.id));
  }
  const url = new URL(contents.getURL() || 'file:///index.html');
  const car = url.searchParams.get('car') || loadSettings().followedCar;
  return rendererChannels.get(contents.id)(collectorState, car, url.pathname.endsWith('/graphs.html'), reset);
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
  // GetRaceResults has no labelled "Status:" field. Read the small current
  // race-control banner near the top of the page instead. Historical messages
  // can contain the same words lower down, so they must never be selected as
  // the live flag.
  const currentFlagElement = Array.from(document.querySelectorAll('body *'))
    .map((element) => ({
      element,
      text: clean(element.innerText || element.textContent || ''),
      rect: element.getBoundingClientRect()
    }))
    .filter(({ element, text, rect }) => {
      if (!/^(?:green(?: flag)?|full course yellow|fcy|safety car|red(?: flag)?|yellow(?: flag)?|code 60|finish(?:ed)?(?: flag)?)$/i.test(text)) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
        && rect.top >= 0
        && rect.top <= Math.max(260, window.innerHeight * 0.3);
    })
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0];
  const sessionHeading = document.querySelector('h1');
  const sessionFields = {
    currentFlag: currentFlagElement ? currentFlagElement.text : '',
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
  const session = parseSessionInfo(snapshot);
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
    return { status: snapshot.bodyText?.includes('No active heat') ? 'waiting' : 'parser_error', message: 'No timing table with NR/TEAM/LAST/BEST-style headers detected yet.', headers: [], rows: [], session, diagnostics };
  }
  const parsedRows = applySingleClassFallback(timingTable.rows
    .map((cells, rowIndex) => ({ rowIndex, ...parseTimingRow(timingTable.headers, cells), cells }))
    .filter((row) => row.carNumber !== null && row.carNumber !== undefined));
  const adapted = adaptTimingFeed(feedState, timingTable.headers, parsedRows);
  feedState = adapted.state;
  const rows = adapted.rows;
  return {
    status: rows.length ? 'collecting' : 'waiting',
    message: rows.length ? `Collecting ${rows.length} live timing rows.` : 'Timing table detected, but no car rows parsed yet.',
    headers: timingTable.headers,
    rows,
    session,
    diagnostics: { ...diagnostics, gapLayout: feedState.alternating ? 'alternating-laps-and-adjacent-gap' : 'standard', selectedTableIndex: timingTable.tableIndex, selectedHeaders: timingTable.headers, parsedCarNumbers: rows.map((row) => row.carNumber), firstParsedRows: rows.slice(0, 5) }
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
  const currentConditionHistory = prepareConditionHistory(
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
  const payload = { ...plan, pitState, serviceTimers: serviceTimers(serviceStates.get(followedCarNumber), context.collectedAt),
    fuel: fuelSummary(fuelStates.get(followedCarNumber), settings.fuelByCar?.[followedCarNumber], {
      averageLapMs: averageLapForPitPlan(settings, followedCarNumber), waitMs: plan.waitMs
    }) };
  snapshotWriter.write(path.join(folder, `pitstop_plan_car-${slugPart(followedCarNumber, 'unknown')}.json`), JSON.stringify(payload));
  if (followedCarNumber === String(settings.followedCar || '')) snapshotWriter.write(path.join(folder, 'pitstop_plan.json'), JSON.stringify(payload));
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
    const carKey = liveRowIdentity(row);
    const previous = latestLiveRowByCar.get(carKey);
    const transition = sectorCaptureTransition(
      previous,
      row,
      sectorCaptureResetPendingByCar.has(carKey)
    );
    if (transition.resetPending) sectorCaptureResetPendingByCar.add(carKey);
    else sectorCaptureResetPendingByCar.delete(carKey);
    const flagged = captureSectorFlags(row, transition.previousForCapture, currentFlag);
    return captureSectorConditions(
      flagged,
      transition.previousForCapture,
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
    appendJsonLines(fs, path.join(folder, 'gap_history.jsonl'), gapMemoryState.newSamples);
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
  // Commit the canonical journal first. A failed CSV export must never cause
  // an already-committed passage to be appended to JSONL again on the next poll.
  appendJsonLines(fs, jsonlPath, lapRecords);
  try {
    if (!checkedCsvHeaders.has(csvPath)) {
      const { entries: records } = readJsonLines(fs, jsonlPath);
      fs.writeFileSync(csvPath, toCsvRows(records, LAP_HISTORY_COLUMNS) + '\n');
      checkedCsvHeaders.add(csvPath);
    } else {
      fs.appendFileSync(csvPath, lapRecords.map((entry) => toCsvRows([entry], LAP_HISTORY_COLUMNS).split('\n')[1]).join('\n') + '\n');
    }
  } catch (error) {
    checkedCsvHeaders.delete(csvPath);
    addError(error, 'csv-export');
  }
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
function writeSessionMetadata(settings, context, options = {}) {
  const folder = ensureStorage(settings);
  const metadataPath = path.join(folder, 'session_metadata.json');
  let previousMetadata = {};
  try {
    if (fs.existsSync(metadataPath)) previousMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    addError(error, 'readSessionMetadata');
  }
  const currentSessionName = normalizeForStorage({}, context).sessionName;
  let observedAt = context.sourceObservedAt || context.collectedAt || previousMetadata.lastUpdatedAt || '';
  // A genuinely resumed source observation reopens the folder. Exporting an
  // archive alone must keep its saved endpoint unchanged.
  const resumed = context.sourceProgressObserved === true
    && !/finish|checkered|chequered/i.test(context.session?.flag || '')
    && Date.parse(observedAt) > Date.parse(previousMetadata.finishedAt);
  const finishedAt = options.finishedAt || (resumed ? null : previousMetadata.finishedAt) || null;
  if (finishedAt && !resumed && !options.finishedAt) observedAt = previousMetadata.lastUpdatedAt || finishedAt;
  if (finishedAt) context.finishedAt = finishedAt;
  atomicWriteFile(fs, metadataPath, JSON.stringify({
    timingUrl: context.timingUrl || '',
    sourceProvider: context.sourceProvider || 'unknown',
    sessionName: preferStableSessionName(currentSessionName, previousMetadata.sessionName),
    startedAt: context.startedAt || previousMetadata.startedAt || '',
    lastUpdatedAt: observedAt,
    finishedAt,
    followedCar: context.followedCar || '',
    followedCars: normalizeFollowedCars(settings),
    sessionMode: normalizeMode(settings.sessionMode),
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
  return compactView(compact);
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
  const history = prepareHistory(collectorState.lapHistory || []);
  const resolvedConditionFilter = resolveAnalysisCondition(settings.analysisConditionFilter, settings.trackCondition);
  const analysisHistory = prepareConditionHistory(history, resolvedConditionFilter);
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
    buildComparisonView({
      history: analysisHistory,
      rows,
      ourCarNumber: carNumber,
      selectedCarNumber,
      mode: sessionMode,
      conditionFilter: resolvedConditionFilter
    })
  ]));
  const modeAdjacentViewsByCar = Object.fromEntries(followedCars.map((carNumber) => [
    carNumber,
    sessionMode === 'qualifying'
      ? qualifyingAdjacentView(analysisHistory, rows, carNumber, { conditionFilter: resolvedConditionFilter })
      : sessionMode === 'race' ? adjacentClassBattlesByCar[carNumber] : null
  ]));
  const timingHighlightsByCar = Object.fromEntries(followedCars.map((carNumber) => [
    carNumber,
    buildTimingHighlights(history, carNumber, { conditionFilter: resolvedConditionFilter, rows })
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
      ...compactStats(carStatsWithProviderBest(analysisHistory, rows, carNumber, {
        conditionFilter: resolvedConditionFilter
      })),
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
  snapshotWriter.write(path.join(folder, 'analytics_summary.json'), JSON.stringify(summary));
  collectorState.analyticsSummary = summary;
  return summary;
}

// Live timers stay in the collector; report calculations and rendering run in
// a serial worker queue. Only session finalization waits for those jobs.
async function writeStintStateAndReports(settings, context, rows = [], options = {}) {
  const folder = ensureStorage(settings);
  const followedCars = normalizeFollowedCars(settings);
  const generatedAt = context?.collectedAt || new Date().toISOString();
  const sessionFinished = Boolean(options.sessionFinished);
  const reportSessionMode = normalizeMode(settings.sessionMode);
  const stintOptions = {
    pitEventsByCar: Object.fromEntries([...serviceStates].map(([car, state]) => [car, state.events || []])),
    closeFinalAt: sessionFinished ? options.finishedAt || context?.finishedAt || generatedAt : null,
    generatedAt,
    liveRows: rows,
    previousState: collectorState.stintState,
    timerRunning: collectorState.sessionTiming?.started === true
      || (!collectorState.sessionTiming && Boolean(collectorState.lapHistory?.length)),
    sessionStartedAt: collectorState.sessionTiming?.startedAt || null
  };
  const stintState = buildStintState(collectorState.lapHistory || [], followedCars, generatedAt, stintOptions);
  snapshotWriter.write(path.join(folder, 'stint_state.json'), JSON.stringify(stintState));
  collectorState.stintState = stintState;
  const generatedStintReports = [];
  const generatedEventSummaries = [];

  for (const carNumber of followedCars) {
    const liveRow = rows.find((row) => String(row.carNumber) === String(carNumber));
    const closedStints = stintState.cars[carNumber].stints.filter((stint) => stint.closed && stint.lapCount > 0);
    const input = { sessionFolder: folder, carNumber,
      session: context?.session || collectorState.session || {},
      gapSamples: gapMemoryState?.samples || [],
      pitEvents: serviceStates.get(carNumber)?.events || [],
      referenceTimes: settings.referenceTimes || {}, pitRules: settings.pitRules || {}, sessionMode: reportSessionMode,
      stintOptions: { closeFinalAt: stintOptions.closeFinalAt, generatedAt, liveRow } };
    if (sessionFinished && closedStints.length) {
      const result = await reportQueue.enqueue(`${folder}|${carNumber}|final`, { ...input, final: true });
      generatedStintReports.push(...result.results);
      generatedEventSummaries.push(...result.summaries);
      continue;
    }
    for (const stint of closedStints) {
      const reportKey = `${folder}|${carNumber}|${stint.stintNumber}|${stint.driverName}`;
      if (pendingStintReports.has(reportKey) || completedReportKeys.has(reportKey)) continue;
      pendingStintReports.add(reportKey);
      reportQueue.enqueue(reportKey, { ...input, stintNumber: stint.stintNumber })
        .then(() => completedReportKeys.add(reportKey))
        .catch((error) => addError(error, 'stint-report-worker'))
        .finally(() => pendingStintReports.delete(reportKey));
    }
  }
  return { ...stintState, generatedStintReports, generatedEventSummaries };
}

async function showReportGeneratedMessage(result = {}, automatic = false) {
  const eventPdfs = (result.generatedEventSummaries || []).map((report) => report.pdfPath).filter(Boolean);
  const stintPdfs = (result.generatedStintReports || []).map((report) => report.pdfPath).filter(Boolean);
  const pdfs = eventPdfs.length ? eventPdfs : stintPdfs;
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: automatic ? 'Session completed' : 'Session ended',
    message: automatic ? 'Session completion was detected.' : 'Collection has been stopped.',
    detail: pdfs.length
      ? `${eventPdfs.length ? 'Session overview' : 'Final stint'} PDF generated:\n${pdfs[0]}`
      : 'No new PDF was required. Existing reports remain available in the session folder.',
    buttons: ['OK']
  });
}

async function finalizeCurrentSession({ automatic = false } = {}) {
  stopCollector(true);
  await activePoll;
  await snapshotWriter.flush();
  await reportQueue.flush();
  const configuredSettings = loadSettings();
  const folder = ensureStorage(configuredSettings);
  const storedHistory = loadExistingHistory(configuredSettings);
  if (storedHistory.length) collectorState.lapHistory = storedHistory;
  let metadata = {};
  try {
    metadata = loadStoredJson(fs, path.join(folder, 'session_metadata.json')) || {};
  } catch (error) {
    addError(error, 'loadFinalReportMetadata');
  }
  const settings = resolveFinalReportSettings(configuredSettings, metadata, collectorState.lapHistory || []);
  const session = {
    ...metadata,
    ...(collectorState.session || {}),
    sessionName: preferStableSessionName(collectorState.session?.sessionName, metadata.sessionName)
  };
  if (metadata.timingUrl) session.url = metadata.timingUrl;
  const context = storageContext(settings, { session }, new Date().toISOString());
  const finishedAt = resolveSessionEndAt(metadata, collectorState.lapHistory || [],
    collectorState.lastSuccessAt, [...serviceStates.values()].flatMap((state) => state.events || []));
  if (!finishedAt) throw new Error('No confirmed session observations are available for final reports.');
  context.finishedAt = finishedAt;
  context.sourceObservedAt = metadata.lastUpdatedAt || finishedAt;
  try { writeSessionMetadata(settings, context, { finishedAt }); }
  catch (error) { addError(error, 'save-session-endpoint'); }
  const stintState = await writeStintStateAndReports(settings, context, collectorState.rows || [], { sessionFinished: true, finishedAt });
  collectorState.stintState = stintState;
  stopCollector(true);
  collectorState.status = 'finished';
  collectorState.message = automatic
    ? 'Session completion detected; final reports generated.'
    : 'Session ended after confirmation.';
  broadcastState();
  await showReportGeneratedMessage(stintState, automatic);
  return collectorState;
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
  lapReconciliationByCar.clear();
  sectorCaptureResetPendingByCar.clear();
  latestPitStateByCar.clear();
  latestFcyGapStateByCar.clear();
  sequenceByCar.clear();
  checkedCsvHeaders.clear();
  serviceStates.clear();
  fuelStates.clear();
  const folder = ensureStorage(settings);
  const jsonlPath = path.join(folder, 'lap_history.jsonl');
  let restoredEntries = [];
  try {
    const { entries, knownKeys, invalidLines } = loadSessionHistory({ fs, jsonlPath, identityForLap: lapIdentity });
    restoredEntries = entries;
    if (invalidLines.length) {
      addError(new Error(`Recovered ${entries.length} laps; skipped damaged journal lines ${invalidLines.map((line) => line.lineNumber).join(', ')}.`), 'lap-journal-recovery');
      try { atomicWriteFile(fs, `${jsonlPath}.corrupt.json`, JSON.stringify(invalidLines, null, 2)); }
      catch (error) { addError(error, 'lap-journal-quarantine'); }
    }
    try {
      const storedFuel = loadStoredJson(fs, path.join(folder, 'fuel_state.json')) || {};
      Object.entries(storedFuel).forEach(([car, state]) => fuelStates.set(car, state));
    } catch (error) { addError(error, 'loadFuelState'); }
    knownKeys.forEach((key) => knownLapKeys.add(key));
    entries.forEach((entry) => {
      const key = liveRowIdentity(entry);
      latestLiveRowByCar.set(key, entry);
      if (entry.awaitingLastLap) lapReconciliationByCar.set(key, { awaiting: entry, evidence: entry.completedLapEvidence });
      sequenceByCar.set(key, Math.max(Number(entry.historySequence) || 0, (sequenceByCar.get(key) || 0) + 1));
    });
    const storedServices = loadStoredJson(fs, path.join(folder, 'pit_event_state.json')) || {};
    Object.entries(storedServices).forEach(([car, state]) => serviceStates.set(car, state));
    const ledgerPath = path.join(folder, 'pit_events.jsonl');
    if (fs.existsSync(ledgerPath)) {
      const { entries: events, invalidLines: damagedEvents } = readJsonLines(fs, ledgerPath);
      if (damagedEvents.length) addError(new Error(`Skipped ${damagedEvents.length} damaged pit ledger records.`), 'pit-journal-recovery');
      events.forEach((event) => {
        const state = serviceStates.get(event.carNumber) || { events: [] };
        const events = new Map((state.events || []).map((item) => [item.id, item]));
        events.set(event.id, event);
        state.events = [...events.values()];
        state.active = state.events.at(-1)?.closed ? null : state.events.at(-1);
        serviceStates.set(event.carNumber, state);
      });
    }
    feedState = loadStoredJson(fs, path.join(folder, 'timing_feed_state.json')) || {};
    return prepareHistory(entries);
  } catch (error) {
    addError(error, 'loadExistingHistory');
    // A damaged optional timer checkpoint must not discard a valid lap log.
    return prepareHistory(restoredEntries);
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

function currentPitTargetDurationMs(settings = {}) {
  const value = Number(settings.pitRules?.pitStopDurationMs);
  return Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : '';
}

// Stores newly completed laps from provider-independent normalized storage rows.
function updateLapHistory(settings, storageRows) {
  const newEntries = [];
  const corrections = new Map();
  const stagedRows = new Map();
  const stagedReconciliation = new Map();
  const pitTargetDurationMs = currentPitTargetDurationMs(settings);
  storageRows.forEach((row) => {
    if (!row.carNumber) return;
    const carKey = liveRowIdentity(row);
    const previousRow = latestLiveRowByCar.get(carKey);
    const reliableCounter = row.lapNumber && row.lapNumberSource !== 'alternating-gap';
    // A transient older row must not become the baseline for a new passage.
    if (reliableCounter && Number(row.lapNumber) < Number(previousRow?.lapNumber)) return;
    stagedRows.set(carKey, row);
    if (!row.lastLap) return;

    const reconciliation = lapReconciliationByCar.get(carKey) || {};
    const sameCounter = previousRow && String(previousRow.lapNumber) === String(row.lapNumber);
    let evidence = previousRow;
    let completedRow = row;
    if (reliableCounter && previousRow?.lastLap && sameCounter) {
      if (previousRow.lastLap === row.lastLap) return;
      const awaiting = reconciliation.awaiting;
      const delayMs = Date.parse(row.collectedAt) - Date.parse(awaiting?.collectedAt);
      const correctionWindowMs = Math.min(Number(awaiting?.lapTimeMs) / 2,
        Math.max(15000, Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) * 3));
      if (awaiting && String(awaiting.lapNumber) === String(row.lapNumber)
        && Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= correctionWindowMs) {
        // Counter arrived first. Replace that passage, preserving its identity,
        // fuel sequence and any manual classification, rather than adding a lap.
        const stored = lapsForCar(collectorState.lapHistory, row.carNumber).find((lap) => lap.lapId === awaiting.lapId);
        if (stored) {
          const corrected = { ...stored,
            ...lapRecordFromNormalizedRow(completedLapRowFromLiveRow(row, reconciliation.evidence)),
            collectedAt: stored.collectedAt, recordedAt: stored.recordedAt,
            lapId: stored.lapId, historySequence: stored.historySequence,
            pitTargetDurationMs: stored.pitTargetDurationMs, awaitingLastLap: false };
          delete corrected.completedLapEvidence;
          if (stored.manualLapStatus) Object.assign(corrected, manualLapPatch(stored.manualLapStatus));
          corrections.set(stored.lapId, corrected);
          stagedReconciliation.set(carKey, {});
          return;
        }
      }
      // LAST arrived first (or the update is too late to pair safely). Keep
      // its sector/driver evidence until the counter confirms a new passage.
      stagedReconciliation.set(carKey, { pendingLast: row, evidence: previousRow });
      return;
    }
    if (previousRow && !reliableCounter && previousRow.lastLap === row.lastLap) return;
    if (reliableCounter && reconciliation.pendingLast?.lastLap === row.lastLap) {
      completedRow = { ...reconciliation.pendingLast, lapNumber: row.lapNumber };
      evidence = reconciliation.evidence;
    }

    const entry = lapRecordFromNormalizedRow(completedLapRowFromLiveRow(completedRow, evidence));
    entry.pitTargetDurationMs = pitTargetDurationMs;
    if (!entry.carNumber || !entry.lastLap || entry.lapTimeMs === '') return;
    entry.historySequence = (sequenceByCar.get(carKey) || 0) + 1;
    entry.lapId = `${carKey}|observed-${entry.historySequence}`;
    const key = lapIdentity(entry);
    if (knownLapKeys.has(key)) return;
    // Identical consecutive laps remain valid. Mark the timing as provisional
    // only when the counter changed while LAST repeated, so a delayed LAST can
    // correct it within a short pairing window, including after a restart.
    if (reliableCounter && previousRow?.lastLap === row.lastLap && !sameCounter
      && !reconciliation.pendingLast) {
      entry.awaitingLastLap = true;
      entry.completedLapEvidence = previousRow;
      stagedReconciliation.set(carKey, { awaiting: entry, evidence: previousRow });
    } else stagedReconciliation.set(carKey, {});
    newEntries.push(entry);
  });
  const previousHistory = collectorState.lapHistory;
  if (corrections.size) {
    const nextHistory = [...previousHistory.map((entry) => corrections.get(entry.lapId) || entry), ...newEntries];
    rewriteLapHistoryFiles(settings, nextHistory);
    collectorState.lapHistory = prepareHistory(nextHistory);
  } else appendLapHistory(settings, newEntries);
  stagedRows.forEach((row, key) => latestLiveRowByCar.set(key, row));
  stagedReconciliation.forEach((value, key) => lapReconciliationByCar.set(key, value));
  newEntries.forEach((entry) => {
    knownLapKeys.add(lapIdentity(entry));
    sequenceByCar.set(liveRowIdentity(entry), entry.historySequence);
  });
  if (newEntries.length && !corrections.size) {
    collectorState.lapHistory = prepareHistory([...previousHistory, ...newEntries], previousHistory, newEntries);
  }
  return newEntries.length;
}

function updateServiceEvents(settings, rows, context) {
  const folder = ensureStorage(settings);
  const followed = new Set(normalizeFollowedCars(settings));
  rows.filter((row) => followed.has(String(row.carNumber))).forEach((row) => {
    const key = String(row.carNumber);
    const carLaps = lapsForCar(collectorState.lapHistory, key);
    const result = updatePitEvents(serviceStates.get(key), row, context.collectedAt, {
      historySequence: carLaps.at(-1)?.historySequence ?? null,
      maximumObservationGapMs: Math.max(15000, Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) * 3),
      targetDurationMs: settings.pitRules?.pitStopDurationMs
    });
    appendJsonLines(fs, path.join(folder, 'pit_events.jsonl'), result.changedEvents);
    serviceStates.set(key, result.state);
    fuelStates.set(key, updateFuelState(fuelStates.get(key), { sequence: carLaps.at(-1)?.historySequence || 0,
      events: result.state.events, config: settings.fuelByCar?.[key] }));
  });
  snapshotWriter.write(path.join(folder, 'pit_event_state.json'), JSON.stringify(Object.fromEntries(serviceStates)));
  snapshotWriter.write(path.join(folder, 'timing_feed_state.json'), JSON.stringify(feedState));
  snapshotWriter.write(path.join(folder, 'fuel_state.json'), JSON.stringify(Object.fromEntries(fuelStates)));
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
  if (target.lapId) return entry.lapId === target.lapId;
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
  atomicWriteFile(fs,
    path.join(folder, 'lap_history.jsonl'),
    history.map((entry) => JSON.stringify(entry)).join('\n') + (history.length ? '\n' : '')
  );
  const csvPath = path.join(folder, 'lap_history.csv');
  try {
    atomicWriteFile(fs, csvPath, toCsvRows(history, LAP_HISTORY_COLUMNS) + '\n');
    checkedCsvHeaders.add(csvPath);
  } catch (error) {
    checkedCsvHeaders.delete(csvPath);
    addError(error, 'csv-export');
  }
}

function rebuildCollectorDerivedState(settings, context = null, rows = collectorState.rows || []) {
  const generatedAt = context?.collectedAt || new Date().toISOString();
  const followedCars = normalizeFollowedCars(settings);
  collectorState.stintState = buildStintState(collectorState.lapHistory || [], followedCars, generatedAt, {
    pitEventsByCar: Object.fromEntries([...serviceStates].map(([car, state]) => [car, state.events || []])),
    generatedAt,
    liveRows: rows,
    previousState: collectorState.stintState,
    timerRunning: collectorState.sessionTiming?.started === true
      || (!collectorState.sessionTiming && Boolean(collectorState.lapHistory?.length)),
    sessionStartedAt: collectorState.sessionTiming?.startedAt || null
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
  rewriteLapHistoryFiles(settings, nextHistory);
  collectorState.lapHistory = prepareHistory(nextHistory);
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
function prepareLatestSnapshot(settings, normalized) {
  const context = storageContext(settings, normalized, normalized.collectedAt || new Date().toISOString());
  const storageRows = annotateLiveSectorFlags(normalizeRowsForStorage(normalized.rows, context), context);
  return { storageRows, analysisRows: analysisRowsFromParsedRows(normalized.rows, storageRows), context };
}

function saveLatestSnapshot(settings, normalized, prepared = prepareLatestSnapshot(settings, normalized)) {
  const { storageRows, context } = prepared;
  for (const [name, write] of [
    ['latest-rows-export', () => writeLatestRows(settings, storageRows)],
    ['parser-debug-export', () => writeParserDebug(settings, parserDebugFromNormalized(normalized, storageRows, context))],
    ['session-metadata-export', () => writeSessionMetadata(settings, context)]
  ]) {
    try { write(); } catch (error) { addError(error, name); }
  }
  return prepared;
}

// Reads the hidden live timing page once, normalizes the data, updates history,
// writes latest exports, and broadcasts state to the renderer.
async function pollLivePage() {
  // setInterval does not wait for an async callback. Prevent a slow page read
  // or PDF build from allowing another poll to start concurrently.
  if (pollInFlight || !liveWindow || liveWindow.isDestroyed()) return;
  pollInFlight = true;
  activePoll = new Promise((resolve) => { finishPoll = resolve; });
  collectorState.lastPollAt = new Date().toISOString();
  try {
    const settings = loadSettings();
    const snapshot = await liveWindow.webContents.executeJavaScript(pageExtractionScript, true);
    const normalized = normalizeSnapshot(snapshot);
    const observedAt = new Date().toISOString();
    providerFreshness = nextProviderFreshness(providerFreshness, { ...normalized, observedAt,
      pollIntervalMs: Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) });
    if (!providerFreshness.usable) {
      latestFcyGapStateByCar.clear();
      collectorState = { ...collectorState, status: providerFreshness.status,
        message: providerFreshness.message || normalized.message,
        pitstopPlan: null, pitstopPlansByCar: {}, lapPrediction: null, lapPredictionsByCar: {},
        diagnostics: { ...normalized.diagnostics, providerFreshness } };
      return;
    }
    normalized.collectedAt = observedAt;
    normalized.session.sessionName = preferStableSessionName(
      normalized.session?.sessionName,
      collectorState.session?.sessionName
    );
    const prepared = prepareLatestSnapshot(settings, normalized);
    const { storageRows, analysisRows, context } = prepared;
    context.sourceObservedAt = providerFreshness.lastProgressAt;
    context.sourceProgressObserved = providerFreshness.progressObserved;
    const primaryCar = String(settings.followedCar || '');
    const completion = followedClassCompletion(analysisRows, primaryCar);
    const newLapCount = updateLapHistory(settings, storageRows);
    saveLatestSnapshot(settings, normalized, prepared);
    updateServiceEvents(settings, analysisRows, context);
    const primaryStats = carStats(collectorState.lapHistory || [], primaryCar);
    const primaryRow = analysisRows.find((row) => String(row.carNumber) === primaryCar);
    const finishCountdown = updateFinishCountdown(collectorState.finishCountdown, {
      session: context?.session || normalized.session || {},
      rows: analysisRows,
      nowMs: context?.collectedAt || new Date().toISOString(),
      primaryAverageLapMs: primaryStats.averageLapMs,
      primaryLastLapMs: primaryRow?.lastLapMs
    });
    const automaticCompletionReason = completion.complete
      ? 'all-class-cars-finished'
      : finishCountdown.expired
        ? 'finish-countdown-expired'
        : '';
    const shouldFinalizeAutomatically = Boolean(automaticCompletionReason) && !automaticCompletionHandled;
    if (shouldFinalizeAutomatically) {
      context.finishedAt ||= observedAt;
      try { writeSessionMetadata(settings, context, { finishedAt: context.finishedAt }); }
      catch (error) { addError(error, 'save-session-endpoint'); }
      automaticCompletionHandled = true;
      const completionMessage = automaticCompletionReason === 'all-class-cars-finished'
        ? 'All cars in the followed class have finished.'
        : 'Finish countdown elapsed after the primary car average lap plus 25% buffer.';

      // Stop and publish first. Report generation and the native OK dialog can
      // take an arbitrary amount of time and must never keep collection alive.
      const haltErrors = haltCollectorForCompletion({
        clearPolling: () => {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
        },
        closeLiveSource: () => {
          if (liveWindow && !liveWindow.isDestroyed()) {
            shouldCloseLiveWindow = true;
            liveWindow.close();
          }
        },
        markFinished: () => {
          collectorState = {
            ...collectorState,
            status: 'finished',
            message: completionMessage,
            finishCountdown
          };
        },
        publishState: broadcastState
      });
      haltErrors.forEach(({ name, error }) => addError(error, `automaticCompletion:${name}`));
    }
    collectorState.sessionTiming = updateSessionTiming(
      collectorState.sessionTiming,
      context?.session || normalized.session || {},
      collectorState.lapHistory || [],
      context?.collectedAt || new Date().toISOString()
    );
    try { updateAndWriteGapMemory(settings, context, analysisRows); } catch (error) { addError(error, 'updateAndWriteGapMemory'); }
    let stintState = collectorState.stintState;
    let analyticsSummary = collectorState.analyticsSummary;
    let lapPredictionsByCar = collectorState.lapPredictionsByCar;
    let pitstopPlansByCar = collectorState.pitstopPlansByCar;
    try { stintState = await writeStintStateAndReports(settings, context, analysisRows, { sessionFinished: shouldFinalizeAutomatically }); } catch (error) { addError(error, 'writeStintStateAndReports'); }
    try { analyticsSummary = writeAnalyticsSummary(settings, context, analysisRows); } catch (error) { addError(error, 'writeAnalyticsSummary'); }
    try { lapPredictionsByCar = writeLapPredictions(settings, context, analysisRows); } catch (error) { addError(error, 'writeLapPredictions'); }
    if (normalizeMode(settings.sessionMode) === 'race') {
      try { pitstopPlansByCar = writePitstopPlans(settings, context, analysisRows); } catch (error) { addError(error, 'writePitstopPlans'); }
    } else {
      pitstopPlansByCar = {};
      collectorState.pitstopPlansByCar = {};
      collectorState.pitstopPlan = null;
    }
    collectorState = {
      ...collectorState,
      mode: 'live',
      status: shouldFinalizeAutomatically ? 'finished' : normalized.status,
      message: shouldFinalizeAutomatically
        ? collectorState.message
        : newLapCount
          ? `${normalized.message} Stored ${newLapCount} new completed lap(s).`
          : normalized.message,
      lastSuccessAt: providerFreshness.lastProgressAt, headers: normalized.headers, rows: analysisRows, session: normalized.session,
      diagnostics: { ...normalized.diagnostics, providerFreshness },
      storage: storageInfo(settings), analyticsSummary, lapPredictionsByCar, pitstopPlansByCar, gapMemory: gapMemoryState, stintState,
      sessionTiming: collectorState.sessionTiming,
      finishCountdown,
      lapPrediction: lapPredictionsByCar?.[primaryCar] || null,
      pitstopPlan: pitstopPlansByCar?.[primaryCar] || null,
      pollIntervalMs: Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS),
      snapshots: [{ at: new Date().toISOString(), checksum: hashObject(analysisRows), rowCount: analysisRows.length, newLapCount }, ...collectorState.snapshots].slice(0, 20)
    };
    if (shouldFinalizeAutomatically) {
      try {
        await showReportGeneratedMessage(stintState || {}, true);
      } catch (error) {
        // A failed or unanswered informational dialog must not change the
        // already-finished collector state.
        addError(error, 'showAutomaticReportGeneratedMessage');
      }
    }
  } catch (error) {
    collectorState.status = 'error'; collectorState.message = 'Could not read the live timing page. See Debug for details.'; addError(error, 'pollLivePage');
  } finally {
    pollInFlight = false;
    finishPoll?.();
    finishPoll = null;
    broadcastState();
  }
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
  await activePoll;
  await snapshotWriter.flush();
  completedReportKeys.clear();
  const settings = loadSettings();
  const startedAt = new Date().toISOString();
  const storageSessionFolder = resolveSessionFolder(settings.storageFolder, defaultStorageFolder());
  fs.mkdirSync(storageSessionFolder, { recursive: true });
  latestPitStateByCar.clear();
  automaticCompletionHandled = false;
  providerFreshness = {};
  gapMemoryState = null;
  collectorState = { ...collectorState, mode: 'live', status: 'loading', message: 'Loading live timing page...', url, startedAt, lastPollAt: null, lastSuccessAt: null, headers: [], rows: [], lapHistory: [], session: {}, diagnostics: {}, errors: [], snapshots: [], storage: {}, analyticsSummary: null, lapPrediction: null, lapPredictionsByCar: {}, pitstopPlan: null, pitstopPlansByCar: {}, gapMemory: null, stintState: null, sessionTiming: null, finishCountdown: null, storageSessionFolder, pollIntervalMs: Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS) };
  collectorState = { ...collectorState, lapHistory: loadExistingHistory(settings), storage: storageInfo(settings) };
  collectorState.sessionTiming = updateSessionTiming(null, {}, collectorState.lapHistory, startedAt);
  collectorState.stintState = buildStintState(collectorState.lapHistory, normalizeFollowedCars(settings), startedAt, {
    timerRunning: collectorState.sessionTiming.started,
    sessionStartedAt: collectorState.sessionTiming.startedAt
  });
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
    if (collectorState.status !== 'finished') {
      pollTimer = setInterval(pollLivePage, Number(settings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS));
    }
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
    providerFreshness = {};
    const lapHistory = loadExistingHistory(merged);
    loadExistingPitStates(merged);
    loadExistingGapMemory(merged);
    const sessionTiming = updateSessionTiming(null, {}, lapHistory);
    collectorState = {
      ...collectorState,
      lastSuccessAt: null,
      session: {},
      rows: [],
      lapHistory,
      sessionTiming,
      stintState: buildStintState(lapHistory, normalizeFollowedCars(merged), new Date().toISOString(), {
        timerRunning: sessionTiming.started,
        sessionStartedAt: sessionTiming.startedAt
      }),
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
ipcMain.handle('collector:stop', async (event) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'End this session?',
    message: 'Stop live collection and close the current session?',
    detail: 'The current stint will be closed and the available final report will be generated.',
    buttons: ['Cancel', 'End session'],
    defaultId: 0,
    cancelId: 0
  });
  if (result.response !== 1) return { cancelled: true, state: stateForRenderer(event.sender) };
  await finalizeCurrentSession({ automatic: false });
  return { cancelled: false, state: stateForRenderer(event.sender) };
});
ipcMain.handle('collector:getState', (event) => stateForRenderer(event.sender, true));
ipcMain.handle('collector:openLiveWindow', () => { if (liveWindow && !liveWindow.isDestroyed()) { liveWindow.show(); liveWindow.focus(); return true; } return false; });
ipcMain.handle('graphs:open', (_event, carNumber) => openGraphsWindow(carNumber));
async function updateFuelSettingsAndState(payload = {}) {
  const settings = loadSettings();
  const car = String(payload.carNumber || settings.followedCar);
  if (!normalizeFollowedCars(settings).includes(car)) throw new Error('Select a followed car.');
  const sequence = lapsForCar(collectorState.lapHistory, car).at(-1)?.historySequence || 0;
  const service = serviceStates.get(car);
  let state = updateFuelState(fuelStates.get(car), { sequence, events: service?.events || [], config: settings.fuelByCar?.[car] });
  const config = normalizeFuelConfig(payload.config || settings.fuelByCar?.[car]);
  if (payload.config && Object.values(payload.config).some((v) => v != null && v !== '' && (!Number.isFinite(Number(v)) || Number(v) < 0))) {
    throw new Error('Fuel settings must be non-negative numbers.');
  }
  if (config.capacityLitres && config.reserveLitres > config.capacityLitres) throw new Error('Reserve cannot exceed tank capacity.');
  const stop = service?.active || service?.events?.at(-1);
  if (payload.action) state = fuelAction(state, { action: payload.action, litres: payload.litres,
    at: new Date().toISOString(), sequence, stopId: stop?.id, stopActive: Boolean(service?.active), stopExitAt: stop?.exitAt }, config);
  if (config.capacityLitres && state.balanceLitres > config.capacityLitres) throw new Error('Tank capacity is below the current estimate. Calibrate the level first.');
  const updated = { ...settings, fuelByCar: { ...settings.fuelByCar, [car]: config } };
  saveSettings(updated);
  fuelStates.set(car, state);
  snapshotWriter.write(path.join(ensureStorage(updated), 'fuel_state.json'), JSON.stringify(Object.fromEntries(fuelStates)));
  await snapshotWriter.flush();
  rebuildCollectorDerivedState(updated);
  return updated;
}
ipcMain.handle('fuel:update', async (event, payload = {}) => {
  const updated = await updateFuelSettingsAndState(payload);
  broadcastState();
  return { settings: updated, state: stateForRenderer(event.sender) };
});
ipcMain.handle('laps:updateStatus', (event, payload) => {
  const result = updateStoredLapManualStatus(payload);
  return { ...result, state: stateForRenderer(event.sender) };
});

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
