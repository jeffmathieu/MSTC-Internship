// Short DOM lookup helper used throughout the renderer. All IDs referenced here
// must exist in index.html, including the hidden settings inputs.
const $ = (id) => document.getElementById(id);

// currentSettings mirrors the persisted settings from the main process.
// currentState mirrors collectorState from src/main/main.js.
let currentSettings = null;
let currentState = null;

const classBattle = window.classBattle;

// Maps collector states to the visual status pill classes in styles.css.
function statusClass(status) {
  if (['collecting', 'connected'].includes(status)) return 'ok';
  if (['waiting', 'loading', 'idle'].includes(status)) return 'warn';
  return 'bad';
}

// Updates the compact status pill. The message is currently shown elsewhere via
// debug/state data; add a visible message target here if the topbar needs one.
function setStatus(status, message) {
  const pill = $('status-pill');
  pill.className = `status-pill ${statusClass(status)}`;
  $('status-text').textContent = String(status || 'idle').toUpperCase();
}

// Displays missing table values consistently.
function rowValue(value) { return value === null || value === undefined || value === '' ? '—' : value; }

// Formats stored millisecond values for details tables.
function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '-' : '';
  let remaining = Math.abs(Math.round(ms));
  const hours = Math.floor(remaining / 3600000); remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000); remaining %= 60000;
  const seconds = Math.floor(remaining / 1000);
  const milli = remaining % 1000;
  if (hours > 0) return `${sign}${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(milli).padStart(3,'0')}`;
  return `${sign}${minutes}:${String(seconds).padStart(2,'0')}.${String(milli).padStart(3,'0')}`;
}

// Numeric helper used by driver/stint tables.
function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

// Returns completed stored laps for one car in chronological order.
function historyLapForUi(entry) {
  const lastLapMs = Number(entry.lastLapMs ?? entry.lapTimeMs);
  return {
    ...entry,
    driver: entry.driver ?? entry.driverName ?? '',
    team: entry.team ?? entry.teamName ?? '',
    car: entry.car ?? entry.carModel ?? '',
    lastLapMs,
    bestLapMs: Number(entry.bestLapMs),
    sector1Ms: Number(entry.sector1Ms),
    sector2Ms: Number(entry.sector2Ms),
    sector3Ms: Number(entry.sector3Ms)
  };
}

function historySortTime(entry) {
  const timestamp = entry.recordedAt || entry.collectedAt || '';
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function lapSortNumber(entry) {
  const n = Number(entry.lapNumber);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function lapDisplayLabel(entry, fallbackIndex = null) {
  const lapNumber = lapSortNumber(entry);
  if (lapNumber !== null) return String(lapNumber);
  return fallbackIndex === null ? '—' : String(fallbackIndex + 1);
}

function lapsForCar(history, carNumber) {
  return (history || [])
    .map(historyLapForUi)
    .filter((entry) => String(entry.carNumber) === String(carNumber) && Number.isFinite(entry.lastLapMs))
    .sort((a, b) => {
      const aLap = lapSortNumber(a);
      const bLap = lapSortNumber(b);
      if (aLap !== null && bLap !== null && aLap !== bLap) return aLap - bLap;
      return historySortTime(a) - historySortTime(b);
    });
}

// Updates the session summary card in the left column.
function updateSession(session = {}) {
  $('session-time').textContent = session.timeToGo || session.pageUpdated || '—';
}

// Updates the followed-car values shown in the compact session panel.
function renderFollowed(rows) {
  const wanted = String($('followed-car').value || '').trim();
  const match = rows.find((row) => String(row.carNumber) === wanted);
  const row = match || {};
  $('f-driver').textContent = rowValue(row.driver);
  $('f-class').textContent = rowValue(row.className);
  $('f-pic').textContent = rowValue(row.classPosition);
  $('f-pos').textContent = rowValue(row.position);
  $('f-last').textContent = rowValue(row.lastLap);
  $('f-best').textContent = rowValue(row.bestLap);
}

// Renders the same-class timing table and highlights the followed car.
function renderClassTable(rows, history) {
  const tbody = document.querySelector('#class-table tbody');
  tbody.innerHTML = '';
  const wanted = String($('followed-car').value || '').trim();
  const summary = classBattle.buildClassBattleSummary(rows, history, wanted);
  if (!summary.followed) {
    $('class-summary').textContent = 'No class detected yet';
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Waiting until our car and class are detected.</td></tr>';
    return;
  }
  $('class-summary').textContent = `${summary.className} · ${summary.classRows.length} cars · our PIC ${rowValue(summary.followed.classPosition)}`;
  summary.items.forEach(({ row, classGap, battle }) => {
    const tr = document.createElement('tr');
    if (String(row.carNumber) === wanted) tr.classList.add('followed');
    const catchInfo = battle?.catchInfo || 'our car';
    [row.classPosition, row.carNumber, row.team, row.driver, row.lastLap, row.bestLap, classGap.label, catchInfo].forEach((value, index) => {
      const td = document.createElement('td');
      td.textContent = rowValue(value);
      if ([1,4,5].includes(index)) td.classList.add('mono');
      if (index === 7) td.classList.add('catch-cell');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// Renders the full parsed timing table in the details/debug area.
function renderAllRowsTable(rows) {
  const tbody = document.querySelector('#cars-table tbody');
  tbody.innerHTML = '';
  const wanted = String($('followed-car').value || '').trim();
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    if (String(row.carNumber) === wanted) tr.classList.add('followed');
    [row.position,row.carNumber,row.team,row.car,row.driver,row.className,row.classPosition,row.gap,row.diff,row.lastLap,row.bestLap,row.lapNumber,row.sector1,row.sector2,row.sector3,row.pit].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = rowValue(value);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// Summarizes stored laps by driver/stint for the details panel.
function renderDriverSummary(laps) {
  const tbody = document.querySelector('#driver-table tbody'); tbody.innerHTML = '';
  const grouped = new Map();
  laps.forEach((lap) => { const name = lap.driver || 'Unknown'; if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(lap); });
  if (!grouped.size) { tbody.innerHTML = '<tr><td colspan="6" class="muted">No stored driver laps yet.</td></tr>'; return; }
  [...grouped.entries()].forEach(([driver, entries]) => {
    const times = entries.map((entry) => entry.lastLapMs).filter(Number.isFinite);
    const tr = document.createElement('tr');
    [driver, entries.length, formatMs(average(times)), formatMs(times.length ? Math.min(...times) : null), lapDisplayLabel(entries[0]), lapDisplayLabel(entries.at(-1))].forEach((value) => {
      const td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// Shows recent stored laps for the followed car.
function renderHistoryTable(laps) {
  const tbody = document.querySelector('#history-table tbody'); tbody.innerHTML = '';
  if (!laps.length) { tbody.innerHTML = '<tr><td colspan="6" class="muted">No stored laps yet.</td></tr>'; return; }
  laps.forEach((lap, index) => {
    const tr = document.createElement('tr');
    [lapDisplayLabel(lap, index), lap.driver, lap.lastLap, lap.sector1, lap.sector2, lap.sector3].forEach((value) => { const td = document.createElement('td'); td.textContent = rowValue(value); tr.appendChild(td); });
    tbody.appendChild(tr);
  });
}

// Updates all details/debug tabs. Debug data mirrors parser diagnostics from
// the main process and is useful when a live timing page changes its markup.
function renderDetails(state) {
  const wanted = String($('followed-car').value || '').trim();
  const laps = lapsForCar(state.lapHistory || [], wanted);
  renderDriverSummary(laps);
  renderHistoryTable(laps.slice(-25).reverse());
  $('headers-debug').textContent = JSON.stringify(state.headers || [], null, 2);
  $('rows-debug').textContent = JSON.stringify((state.rows || []).slice(0, 6), null, 2);
  $('tables-debug').textContent = JSON.stringify(state.diagnostics?.tableSummaries || state.diagnostics || [], null, 2);
  $('errors-debug').textContent = JSON.stringify(state.errors || [], null, 2);
}

// Central render function called on every collector:update event. Keep new UI
// panels wired here so they update whenever live data changes.
function render(state) {
  currentState = state || {};
  const rows = currentState.rows || [], history = currentState.lapHistory || [];
  setStatus(currentState.status, currentState.message);
  updateSession(currentState.session || {});
  $('row-count').textContent = String(rows.length);
  $('history-count').textContent = String(history.length);
  $('last-update').textContent = currentState.lastSuccessAt ? new Date(currentState.lastSuccessAt).toLocaleTimeString() : '—';
  renderFollowed(rows);
  renderClassTable(rows, history);
  renderAllRowsTable(rows);
  renderDetails(currentState);
}

// Opens the native folder picker through the preload bridge and synchronizes
// both hidden main inputs and visible setup-modal inputs.
async function chooseAndSetFolder(targetInputId = 'storage-folder') {
  const folder = await window.liveTiming.chooseFolder();
  if (folder) {
    $(targetInputId).value = folder;
    $('storage-folder').value = folder;
    $('setup-folder').value = folder;
  }
  return folder;
}

// Reads settings from hidden inputs and persists them in the main process.
// Add new user settings to this patch and to main.js loadSettings/settings:set.
async function saveSettingsFromInputs(setupComplete = false) {
  const patch = {
    timingUrl: $('timing-url').value.trim(),
    followedCar: $('followed-car').value.trim(),
    storageFolder: $('storage-folder').value.trim(),
    pollIntervalMs: Number($('poll-interval').value || 3000)
  };
  if (setupComplete) patch.setupComplete = true;
  currentSettings = await window.liveTiming.setSettings(patch);
  return currentSettings;
}

// Copies hidden dashboard settings into the visible setup modal.
function syncSetupFromMain() {
  $('setup-url').value = $('timing-url').value;
  $('setup-car').value = $('followed-car').value;
  $('setup-folder').value = $('storage-folder').value;
}

// Copies visible setup modal values back into the hidden dashboard inputs used
// by the rest of app.js.
function syncMainFromSetup() {
  $('timing-url').value = $('setup-url').value;
  $('followed-car').value = $('setup-car').value;
  $('storage-folder').value = $('setup-folder').value;
}

// Opens or closes the first-run/setup modal.
function showSetup(show = true) {
  syncSetupFromMain();
  $('setup-modal').classList.toggle('hidden', !show);
}

// Enables the All rows / Stored laps / Parser debug tab buttons.
function setupDetailTabs() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
      document.querySelectorAll('.detail-tab').forEach((content) => content.classList.remove('active'));
      button.classList.add('active');
      $(`detail-${button.dataset.tab}`).classList.add('active');
    });
  });
}

// Renderer entry point. It loads persisted settings, wires UI events to the
// preload API, subscribes to collector updates, and opens setup when required.
async function init() {
  currentSettings = await window.liveTiming.getSettings();
  $('timing-url').value = currentSettings.timingUrl || 'https://livetiming.getraceresults.com/demo#screen-results';
  $('followed-car').value = currentSettings.followedCar || '33';
  $('storage-folder').value = currentSettings.storageFolder || '';
  $('poll-interval').value = String(currentSettings.pollIntervalMs || 3000);
  syncSetupFromMain();
  setupDetailTabs();

  // Race-day controls: each button calls a small preload API method, which then
  // invokes the matching ipcMain handler in main.js.
  $('start')?.addEventListener('click', async () => { await saveSettingsFromInputs(true); await window.liveTiming.startCollector(currentSettings.timingUrl); });
  $('stop')?.addEventListener('click', () => window.liveTiming.stopCollector());
  $('show-live')?.addEventListener('click', () => window.liveTiming.openLiveWindow());
  $('choose-folder')?.addEventListener('click', async () => { await chooseAndSetFolder('storage-folder'); await saveSettingsFromInputs(); });
  $('setup-choose-folder')?.addEventListener('click', async () => { await chooseAndSetFolder('setup-folder'); });
  $('setup-save')?.addEventListener('click', async () => { syncMainFromSetup(); await saveSettingsFromInputs(true); showSetup(false); render(currentState || await window.liveTiming.getCollectorState()); });
  $('open-setup')?.addEventListener('click', () => showSetup(true));
  $('export')?.addEventListener('click', async () => { const result = await window.liveTiming.exportCurrent(); alert(`Exported:\n${result.csvPath}\n${result.jsonPath}\n${result.historyPath || ''}`); });

  // Persist settings immediately when hidden inputs change. If new settings are
  // added to the modal, include their hidden input IDs here.
  ['timing-url','followed-car','poll-interval'].forEach((id) => $(id)?.addEventListener('change', async () => { await saveSettingsFromInputs(); render(currentState); }));
  window.liveTiming.onCollectorUpdate(render);
  render(await window.liveTiming.getCollectorState());
  if (!currentSettings.setupComplete || !currentSettings.storageFolder) showSetup(true);
}
init();
