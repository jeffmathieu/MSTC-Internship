const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  cleanText,
  parseTimingRow,
  looksLikeTimingHeaders,
  parseLapTimeToMs,
  formatMs
} = require('../shared/parser');

// Main-process references. Electron keeps UI windows and timers alive through
// these variables, so every start/stop function below updates them carefully.
let mainWindow;
let liveWindow;
let pollTimer;
let replayTimer;
let replayData = null;
let replayStep = 0;
let replayLapsPerTick = 1;

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
  pollIntervalMs: 3000,
  replay: { active: false, paused: false, currentLap: 0, maxLap: 0, source: '' }
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
    replayIntervalMs: 350,
    replayLapsPerTick: 1,
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
// reveal it through collector:openLiveWindow.
function createLiveWindow() {
  if (liveWindow && !liveWindow.isDestroyed()) return liveWindow;
  liveWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  liveWindow.on('closed', () => { liveWindow = null; });
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

// Converts a raw page snapshot into the normalized shape used by the UI,
// storage, and replay code. The parser module owns column-name interpretation;
// this function chooses the best table and attaches diagnostics.
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

// Escapes one value for CSV output. Keep this centralized so all CSV files use
// the same quoting rules.
function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Serializes the current live timing table. Add/remove columns here when the
// latest_live_rows.csv export should change.
function toCsv(rows) {
  const columns = ['position','carNumber','team','car','driver','className','classPosition','gap','diff','lastLap','bestLap','inValue','lapNumber','sector1','sector2','sector3','pit'];
  return [columns.join(','), ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(','))].join('\n');
}

// Defines the persistent lap-history CSV schema. When adding columns, also add
// matching fields in historyEntryFromRow().
function lapHistoryColumns() {
  return ['recordedAt','sourceMode','sessionName','carNumber','team','car','driver','className','position','classPosition','gap','diff','lapNumber','lastLap','lastLapSeconds','bestLap','bestLapSeconds','sector1','sector1Seconds','sector2','sector2Seconds','sector3','sector3Seconds','pit'];
}

// Builds one durable history record from a parsed timing row. Millisecond values
// are kept for code, while "*Seconds" fields make spreadsheets easier to use.
function historyEntryFromRow(row, session, recordedAt, sourceMode = collectorState.mode || 'live') {
  return {
    recordedAt,
    sourceMode,
    sessionName: session.sessionName || session.statusText || session.pageTitle || '',
    carNumber: row.carNumber,
    team: row.team || '',
    car: row.car || '',
    driver: row.driver || '',
    className: row.className || '',
    position: row.position,
    classPosition: row.classPosition,
    gap: row.gap || '',
    diff: row.diff || '',
    lapNumber: row.lapNumber,
    lastLap: row.lastLap || '',
    lastLapMs: row.lastLapMs,
    lastLapSeconds: row.lastLapMs == null ? '' : (row.lastLapMs / 1000).toFixed(3),
    bestLap: row.bestLap || '',
    bestLapMs: row.bestLapMs,
    bestLapSeconds: row.bestLapMs == null ? '' : (row.bestLapMs / 1000).toFixed(3),
    sector1: row.sector1 || '',
    sector1Ms: row.sector1Ms,
    sector1Seconds: row.sector1Ms == null ? '' : (row.sector1Ms / 1000).toFixed(3),
    sector2: row.sector2 || '',
    sector2Ms: row.sector2Ms,
    sector2Seconds: row.sector2Ms == null ? '' : (row.sector2Ms / 1000).toFixed(3),
    sector3: row.sector3 || '',
    sector3Ms: row.sector3Ms,
    sector3Seconds: row.sector3Ms == null ? '' : (row.sector3Ms / 1000).toFixed(3),
    pit: row.pit || ''
  };
}

// Converts a history entry into one CSV row using the schema above.
function entryToCsvRow(entry) {
  return lapHistoryColumns().map((col) => csvEscape(entry[col])).join(',');
}

// Appends one completed lap to both JSONL and CSV history files. JSONL is useful
// for robust incremental writes; CSV is useful for spreadsheets.
function appendHistoryEntry(settings, entry) {
  const folder = ensureStorage(settings);
  const jsonlPath = path.join(folder, 'lap_history.jsonl');
  const csvPath = path.join(folder, 'lap_history.csv');
  if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, `${lapHistoryColumns().join(',')}\n`);
  fs.appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`);
  fs.appendFileSync(csvPath, `${entryToCsvRow(entry)}\n`);
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
      if (entry.carNumber !== undefined && entry.lapNumber !== null && entry.lapNumber !== undefined && entry.lastLap) {
        knownLapKeys.add(`${entry.sourceMode || 'live'}|${entry.sessionName || ''}|${entry.carNumber}|${entry.lapNumber}`);
      }
    });
    return entries.slice(-20000);
  } catch (error) {
    addError(error, 'loadExistingHistory');
    return [];
  }
}

// Stores newly completed laps from normalized rows. A row is considered complete
// only when it has a car number, lap number, last lap text, and parsed last-lap
// milliseconds. Adjust this guard if incomplete laps should also be recorded.
function updateLapHistory(settings, normalized, sourceMode = collectorState.mode || 'live') {
  const recordedAt = new Date().toISOString();
  const newEntries = [];
  normalized.rows.forEach((row) => {
    if (row.carNumber == null || row.lapNumber == null || !row.lastLap || row.lastLapMs == null) return;
    const sessionKey = normalized.session?.sessionName || normalized.session?.pageTitle || '';
    const key = `${sourceMode}|${sessionKey}|${row.carNumber}|${row.lapNumber}`;
    if (knownLapKeys.has(key)) return;
    knownLapKeys.add(key);
    const entry = historyEntryFromRow(row, normalized.session, recordedAt, sourceMode);
    newEntries.push(entry);
    try { appendHistoryEntry(settings, entry); } catch (error) { addError(error, 'appendHistoryEntry'); }
  });
  if (newEntries.length) collectorState.lapHistory = [...collectorState.lapHistory, ...newEntries].slice(-20000);
  return newEntries.length;
}

// Writes the latest table/session snapshot to predictable filenames. These files
// are overwritten on every successful poll/tick so external tools can read the
// current state without searching for timestamps.
function saveLatestSnapshot(settings, normalized) {
  try {
    const folder = ensureStorage(settings);
    fs.writeFileSync(path.join(folder, 'latest_live_rows.json'), JSON.stringify({ collectedAt: new Date().toISOString(), session: normalized.session, headers: normalized.headers, rows: normalized.rows }, null, 2));
    fs.writeFileSync(path.join(folder, 'latest_live_rows.csv'), toCsv(normalized.rows));
    fs.writeFileSync(path.join(folder, 'latest_session_info.json'), JSON.stringify(normalized.session, null, 2));
  } catch (error) { addError(error, 'saveLatestSnapshot'); }
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
    const newLapCount = updateLapHistory(settings, normalized, 'live');
    collectorState = {
      ...collectorState,
      mode: 'live',
      status: normalized.status,
      message: newLapCount ? `${normalized.message} Stored ${newLapCount} new completed lap(s).` : normalized.message,
      lastSuccessAt: new Date().toISOString(), headers: normalized.headers, rows: normalized.rows, session: normalized.session, diagnostics: normalized.diagnostics,
      storage: storageInfo(settings), pollIntervalMs: Number(settings.pollIntervalMs || 3000),
      snapshots: [{ at: new Date().toISOString(), checksum: hashObject(normalized.rows), rowCount: normalized.rows.length, newLapCount }, ...collectorState.snapshots].slice(0, 20)
    };
    saveLatestSnapshot(settings, normalized);
  } catch (error) {
    collectorState.status = 'error'; collectorState.message = 'Could not read the live timing page. See Debug for details.'; addError(error, 'pollLivePage');
  }
  broadcastState();
}

// Returns user-facing paths for the Debug/Storage UI. Add new exported files
// here if the renderer should display their locations.
function storageInfo(settings) {
  const folder = settings.storageFolder || defaultStorageFolder();
  return { folder, latestRowsCsv: path.join(folder, 'latest_live_rows.csv'), lapHistoryCsv: path.join(folder, 'lap_history.csv'), lapHistoryJsonl: path.join(folder, 'lap_history.jsonl') };
}

// Starts live collection for a URL. It stops replay first, opens/loads the
// hidden live window, does an immediate poll, then schedules repeated polls.
// Poll frequency is controlled by settings.pollIntervalMs.
async function startCollector(url) {
  stopReplay(false);
  stopCollector(false);
  const settings = loadSettings();
  collectorState = { ...collectorState, mode: 'live', status: 'loading', message: 'Loading live timing page...', url, startedAt: new Date().toISOString(), lastPollAt: null, lastSuccessAt: null, headers: [], rows: [], lapHistory: loadExistingHistory(settings), session: {}, diagnostics: {}, errors: [], snapshots: [], storage: storageInfo(settings), pollIntervalMs: Number(settings.pollIntervalMs || 3000), replay: { active: false, paused: false, currentLap: 0, maxLap: 0, source: '' } };
  broadcastState();
  try {
    const win = createLiveWindow();
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
  if (closeLiveWindow && liveWindow && !liveWindow.isDestroyed()) liveWindow.close();
  if (collectorState.mode === 'live') { collectorState.status = 'idle'; collectorState.message = 'Live collector stopped'; }
  broadcastState();
}

// Loads built-in replay data once and caches it. Change the JSON file path here
// if a different built-in replay should be shipped with the app.
function loadReplayData() {
  if (replayData) return replayData;
  replayData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/belcar_race_replay.json'), 'utf8'));
  return replayData;
}

// Small wrappers keep replay math readable and reuse the shared timing parser.
function msFromLapTime(text) { return parseLapTimeToMs(text); }
function sectorEstimate(lapMs, factor) { return lapMs == null ? '' : formatMs(Math.round(lapMs * factor)); }

// Builds timing-table-like rows for the replay at a given lap number. The
// resulting objects intentionally match live parsed rows so the renderer and
// storage code do not need separate replay handling.
function buildReplayRows(data, currentLap) {
  const carStates = data.cars.map((car) => {
    const done = car.laps.filter((lap) => lap.lapNumber <= currentLap);
    const last = done.at(-1);
    const best = done.reduce((best, lap) => {
      const ms = msFromLapTime(lap.lapTime);
      return best == null || ms < best ? ms : best;
    }, null);
    const elapsed = done.reduce((sum, lap) => sum + (msFromLapTime(lap.lapTime) || 0), 0);
    return { car, done, last, best, elapsed, completed: done.length };
  }).filter((state) => state.completed > 0);

  // Race order: more completed laps wins; ties are sorted by lower elapsed time.
  const overall = [...carStates].sort((a, b) => (b.completed - a.completed) || (a.elapsed - b.elapsed));

  // Calculate position within each class separately from the overall position.
  const classGroups = new Map();
  for (const st of overall) {
    if (!classGroups.has(st.car.className)) classGroups.set(st.car.className, []);
    classGroups.get(st.car.className).push(st);
  }
  const classPos = new Map();
  for (const [cls, group] of classGroups.entries()) {
    group.forEach((st, idx) => classPos.set(st.car.carNumber, idx + 1));
  }
  const leader = overall[0];

  return overall.map((st, idx) => {
    const lastMs = msFromLapTime(st.last.lapTime);
    const driver = st.last.driver || st.car.drivers?.[0] || '';
    const gapMs = leader ? st.elapsed - leader.elapsed : 0;
    // Gap is shown as laps behind when a car has completed fewer laps than the leader.
    const gap = idx === 0 ? '-- leader --' : st.completed < leader.completed ? `-- ${leader.completed - st.completed} lap${leader.completed - st.completed === 1 ? '' : 's'} --` : formatMs(gapMs);
    const diffMs = idx === 0 ? null : st.elapsed - overall[idx - 1].elapsed;
    const diff = idx === 0 ? '' : st.completed < overall[idx - 1].completed ? `-- ${overall[idx - 1].completed - st.completed} lap --` : formatMs(diffMs);
    return {
      position: idx + 1,
      movement: '',
      carNumber: st.car.carNumber,
      team: st.car.team,
      car: st.car.car,
      driver,
      className: st.car.className,
      classPosition: classPos.get(st.car.carNumber),
      gap,
      diff,
      lastLap: st.last.lapTime,
      bestLap: formatMs(st.best),
      inValue: '',
      lapNumber: st.last.lapNumber,
      // Replay data does not contain real sectors, so these percentages estimate
      // plausible sector splits. Adjust factors if a replay dataset includes a
      // different track profile, keeping the total close to 1.0.
      sector1: sectorEstimate(lastMs, 0.305),
      sector2: sectorEstimate(lastMs, 0.395),
      sector3: sectorEstimate(lastMs, 0.300),
      pit: lastMs > 180000 ? 'slow/pit' : '',
      lastLapMs: lastMs,
      bestLapMs: st.best,
      sector1Ms: lastMs ? Math.round(lastMs * 0.305) : null,
      sector2Ms: lastMs ? Math.round(lastMs * 0.395) : null,
      sector3Ms: lastMs ? Math.round(lastMs * 0.300) : null,
      replayElapsedMs: st.elapsed
    };
  });
}

// Creates session metadata for replay mode using the same fields as live mode.
function replaySessionInfo(data, currentLap) {
  return { pageTitle: `${data.series} - ${data.session}`, url: 'built-in Belcar race replay', sessionName: `${data.series} - ${data.session} replay`, circuit: data.circuit, timeToGo: `Replay lap ${currentLap}`, flag: 'Replay mode', pageUpdated: new Date().toLocaleTimeString() };
}

// Advances replay by one or more laps, updates the same state/files as live
// polling, and stops the replay timer when the final lap is reached.
function replayTick() {
  const settings = loadSettings();
  const data = loadReplayData();
  replayStep = Math.min(replayStep + replayLapsPerTick, Math.max(...data.cars.map((c) => c.laps.length)));
  const rows = buildReplayRows(data, replayStep);
  const session = replaySessionInfo(data, replayStep);
  const normalized = { status: 'collecting', message: `Replaying Belcar race lap ${replayStep}.`, headers: ['POS','NR','TEAM','CAR','DRIVER IN CAR','CLS','PIC','GAP','DIFF','LAST','BEST','LAP','SECT-1','SECT-2','SECT-3','PIT'], rows, session, diagnostics: { replaySource: data.source, replayCars: data.cars.length, currentLap: replayStep } };
  const newLapCount = updateLapHistory(settings, normalized, 'replay');
  collectorState = { ...collectorState, mode: 'replay', status: replayStep >= Math.max(...data.cars.map((c) => c.laps.length)) ? 'replay_finished' : 'collecting', message: `${normalized.message} Stored ${newLapCount} new lap(s).`, lastSuccessAt: new Date().toISOString(), headers: normalized.headers, rows: normalized.rows, session, diagnostics: normalized.diagnostics, storage: storageInfo(settings), replay: { active: true, paused: false, currentLap: replayStep, maxLap: Math.max(...data.cars.map((c) => c.laps.length)), source: data.source }, snapshots: [{ at: new Date().toISOString(), rowCount: rows.length, newLapCount, replayStep }, ...collectorState.snapshots].slice(0, 20) };
  saveLatestSnapshot(settings, normalized);
  broadcastState();
  if (collectorState.status === 'replay_finished') stopReplay(false, true);
}

// Starts the built-in replay. It stops live collection first so only one data
// source controls collectorState at a time.
function startReplay() {
  stopCollector(true);
  stopReplay(false);
  const settings = loadSettings();
  const data = loadReplayData();
  replayStep = 0;
  replayLapsPerTick = Number(settings.replayLapsPerTick || 1);
  knownLapKeys.clear();
  collectorState = { ...collectorState, mode: 'replay', status: 'loading', message: 'Starting built-in Belcar race replay...', url: 'built-in replay', startedAt: new Date().toISOString(), lastPollAt: null, lastSuccessAt: null, rows: [], lapHistory: loadExistingHistory(settings), session: replaySessionInfo(data, 0), diagnostics: { replaySource: data.source }, errors: [], snapshots: [], storage: storageInfo(settings), replay: { active: true, paused: false, currentLap: 0, maxLap: Math.max(...data.cars.map((c) => c.laps.length)), source: data.source } };
  broadcastState();
  replayTick();
  replayTimer = setInterval(replayTick, Number(settings.replayIntervalMs || 350));
}

// Stops the replay timer. keepFinished=true preserves the final
// "replay_finished" state after the last tick.
function stopReplay(broadcast = true, keepFinished = false) {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
  if (collectorState.mode === 'replay' && !keepFinished) { collectorState.status = 'idle'; collectorState.message = 'Replay stopped'; collectorState.replay = { ...collectorState.replay, active: false, paused: false }; }
  if (broadcast) broadcastState();
}

// Pauses replay by clearing the timer but keeping replay state active.
function pauseReplay() {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
  collectorState.status = 'replay_paused'; collectorState.message = 'Replay paused'; collectorState.replay = { ...collectorState.replay, paused: true };
  broadcastState();
}

// Restarts replay ticking from the current replayStep.
function resumeReplay() {
  if (collectorState.mode !== 'replay') return;
  if (replayTimer) clearInterval(replayTimer);
  collectorState.status = 'collecting'; collectorState.message = 'Replay resumed'; collectorState.replay = { ...collectorState.replay, paused: false };
  replayTimer = setInterval(replayTick, Number(loadSettings().replayIntervalMs || 350));
  broadcastState();
}

// IPC handlers are the public API used by preload.js and the renderer. When
// adding a UI action, add its handler here and expose a matching function in
// preload.js.
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_event, settings) => {
  const merged = { ...loadSettings(), ...settings };
  // Clamp user-editable timing values so accidental input cannot create an
  // unusably fast/slow collector or replay.
  merged.pollIntervalMs = Math.max(1000, Math.min(10000, Number(merged.pollIntervalMs || 3000)));
  merged.replayIntervalMs = Math.max(50, Math.min(5000, Number(merged.replayIntervalMs || 350)));
  merged.replayLapsPerTick = Math.max(1, Math.min(10, Number(merged.replayLapsPerTick || 1)));
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
ipcMain.handle('collector:stop', () => { stopCollector(true); stopReplay(true); });
ipcMain.handle('collector:getState', () => collectorState);
ipcMain.handle('collector:openLiveWindow', () => { if (liveWindow && !liveWindow.isDestroyed()) { liveWindow.show(); liveWindow.focus(); return true; } return false; });
ipcMain.handle('replay:start', () => startReplay());
ipcMain.handle('replay:pause', () => pauseReplay());
ipcMain.handle('replay:resume', () => resumeReplay());
ipcMain.handle('replay:stop', () => stopReplay(true));

// Creates timestamped exports of the current rows and in-memory lap history.
// The always-overwritten "latest_*" files are written by saveLatestSnapshot().
ipcMain.handle('export:current', async () => {
  const settings = loadSettings();
  const folder = ensureStorage(settings);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(folder, `live_rows_${timestamp}.json`);
  const csvPath = path.join(folder, `live_rows_${timestamp}.csv`);
  const historyPath = path.join(folder, `lap_history_${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ session: collectorState.session, headers: collectorState.headers, rows: collectorState.rows }, null, 2));
  fs.writeFileSync(csvPath, toCsv(collectorState.rows));
  fs.writeFileSync(historyPath, JSON.stringify({ session: collectorState.session, lapHistory: collectorState.lapHistory }, null, 2));
  return { jsonPath, csvPath, historyPath };
});

// Electron app lifecycle. On macOS the app remains open after all windows close,
// matching normal platform behavior; other platforms quit immediately.
app.whenReady().then(() => { createMainWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); }); });
app.on('window-all-closed', () => { stopCollector(true); stopReplay(false); if (process.platform !== 'darwin') app.quit(); });
