// Short DOM lookup helper used throughout the renderer. All IDs referenced here
// must exist in index.html, including the hidden settings inputs.
const $ = (id) => document.getElementById(id);

// currentSettings mirrors the persisted settings from the main process.
// currentState mirrors collectorState from src/main/main.js.
let currentSettings = null;
let currentState = null;
const DEFAULT_POLL_INTERVAL_MS = 5000;

const classBattle = window.classBattle;
const lapAnalytics = window.lapAnalytics;
const pitstopPlanner = window.pitstopPlanner;
const normReference = window.normReference;
const previousMetricValues = new Map();

// Maps collector states to the visual status pill classes in styles.css.
function statusClass(status) {
  if (['collecting', 'connected'].includes(status)) return 'ok';
  if (['waiting', 'loading', 'idle'].includes(status)) return 'warn';
  return 'bad';
}

// Updates the compact status text in the top information strip.
function setStatus(status, message) {
  const target = $('status-text');
  if (target) target.textContent = String(status || 'idle').toUpperCase();
}

// Displays missing table values consistently.
function rowValue(value) { return value === null || value === undefined || value === '' ? '—' : value; }

// Writes plain text into one dashboard element, always converting missing values
// through rowValue() so all panels display the same placeholder.
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(rowValue(value));
}

// Writes a metric value and optionally flashes its containing card when the
// value changes. This is used for best/last times where changes should catch the
// engineer's eye without changing layout.
function setMetric(id, value, { flash = false } = {}) {
  const el = $(id);
  if (!el) return;
  const next = String(rowValue(value));
  const previous = previousMetricValues.get(id);
  el.textContent = next;
  if (flash && previous && previous !== '—' && next !== '—' && previous !== next) {
    const card = el.closest('.metric-box');
    if (card) {
      card.classList.remove('flash-good');
      void card.offsetWidth;
      card.classList.add('flash-good');
    }
  }
  previousMetricValues.set(id, next);
}

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

function numericMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Formats a signed delta. Positive/negative meaning depends on the caller, so
// setDelta() is responsible for assigning good/bad styling.
function displayDelta(ms) {
  return normReference.displayDeltaSeconds(ms);
}

// Parses dashboard-entered times such as "2:04.500", "124.500" or "41.2".
// Values are stored as milliseconds in settings so race/quali reference times
// can change without touching code.
function parseDashboardTimeToMs(value) {
  return normReference.parseDashboardTimeToMs(value);
}

function msFromHiddenInput(id) {
  const n = Number($(id)?.value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function currentReferenceTimes() {
  return {
    lapMs: msFromHiddenInput('reference-lap-ms'),
    sector1Ms: msFromHiddenInput('reference-sector1-ms'),
    sector2Ms: msFromHiddenInput('reference-sector2-ms'),
    sector3Ms: msFromHiddenInput('reference-sector3-ms')
  };
}

function setHiddenMs(id, value) {
  const input = $(id);
  if (input) input.value = Number.isFinite(value) ? String(Math.round(value)) : '';
}

function syncReferenceInputs(settings = currentSettings || {}) {
  const refs = settings.referenceTimes || {};
  setHiddenMs('reference-lap-ms', numericMs(refs.lapMs));
  setHiddenMs('reference-sector1-ms', numericMs(refs.sector1Ms));
  setHiddenMs('reference-sector2-ms', numericMs(refs.sector2Ms));
  setHiddenMs('reference-sector3-ms', numericMs(refs.sector3Ms));
}

function setNormCardState(id, state) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('norm-good', 'norm-warn', 'norm-bad');
  if (state && state !== 'neutral') el.classList.add(`norm-${state}`);
}

function setNormTextState(id, state) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('norm-text', 'norm-good', 'norm-warn', 'norm-bad');
  if (state && state !== 'neutral') {
    el.classList.add('norm-text');
    el.classList.add(`norm-${state}`);
  }
}

// Reads pit duration inputs as seconds. Invalid values fall back so one bad UI
// input cannot break the pitstop planner.
function secondsFromInput(id, fallbackSeconds) {
  const value = Number($(id)?.value);
  return Number.isFinite(value) && value >= 0 ? value : fallbackSeconds;
}

// Reads race duration inputs as hours. Race length is editable because short
// demos and 24h races use the same dashboard.
function hoursFromInput(id, fallbackHours) {
  const value = Number($(id)?.value);
  return Number.isFinite(value) && value > 0 ? value : fallbackHours;
}

// Builds the pit rule object saved to settings. If new pit rules become
// configurable, add their input mapping here and the planner default.
function pitRulesFromInputs() {
  return {
    raceDurationMs: hoursFromInput('pit-race-hours', 24) * 60 * 60 * 1000,
    pitClosedStartMs: 25 * 60 * 1000,
    pitClosedEndMs: 25 * 60 * 1000,
    pitCooldownMs: 25 * 60 * 1000,
    pitStopDurationMs: secondsFromInput('pit-duration', 75) * 1000,
    requiredPitStops: Math.max(0, Math.floor(secondsFromInput('pit-required-input', 2))),
    nearWindowLaps: 2
  };
}

function referenceTimesFromInputs() {
  return currentReferenceTimes();
}

// Updates a delta card and applies semantic border color. In this UI positive
// means good for the displayed comparison because backend deltas are inverted
// before they arrive here when needed.
function setDelta(cardId, textId, deltaMs) {
  const card = $(cardId);
  const numeric = Number.isFinite(deltaMs) ? deltaMs : null;
  setMetric(textId, numeric !== null ? displayDelta(numeric) : '—');
  if (!card) return;
  card.classList.remove('good', 'bad', 'neutral');
  if (numeric === null || numeric === 0) card.classList.add('neutral');
  else card.classList.add(numeric > 0 ? 'good' : 'bad');
}

// Backend driver deltas are stored as current minus reference. The UI wants
// green when we are faster/better, so driver deltas are inverted before display.
function invertedDelta(value) {
  const n = numericMs(value);
  return n === null ? null : -n;
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

// Reads lap numbers while treating missing/zero as unknown. This keeps debug
// history labels stable for providers that do not expose lap numbers.
function lapSortNumber(entry) {
  const n = Number(entry.lapNumber);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Chooses a display label for stored laps, falling back to row index when lap
// number is missing.
function lapDisplayLabel(entry, fallbackIndex = null) {
  const lapNumber = lapSortNumber(entry);
  if (lapNumber !== null) return String(lapNumber);
  return fallbackIndex === null ? '—' : String(fallbackIndex + 1);
}

// Returns stored laps for one car in chronological order for debug tables.
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
  setText('session-name', session.sessionName || session.pageTitle || '—');
  setText('session-time', session.timeToGo || session.pageUpdated || '—');
}

// Updates the followed-car values shown in the compact session panel.
function renderFollowed(rows) {
  const wanted = String($('followed-car').value || '').trim();
  const match = rows.find((row) => String(row.carNumber) === wanted);
  const row = match || {};
  const classPic = row.className || row.classPosition
    ? `${rowValue(row.className)} / ${rowValue(row.classPosition)}`
    : '—';
  setText('info-car', wanted || row.carNumber || '—');
  setText('info-driver', row.driver);
  setText('info-class-pic', classPic);
  setMetric('last-time', row.lastLap, { flash: true });
  setMetric('best-time', row.bestLap, { flash: true });
  setMetric('sector-1', row.sector1);
  setMetric('sector-2', row.sector2);
  setMetric('sector-3', row.sector3);
}

// Renders the same-class timing table and highlights the followed car.
function renderClassTable(rows, history) {
  const tbody = document.querySelector('#class-table tbody');
  if (!tbody) return;
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

function getOurCarAnalytics(summary) {
  const wanted = String($('followed-car').value || '').trim();
  return (summary?.cars || []).find((car) => String(car.carNumber) === wanted) || null;
}

// Renders best sector values and ideal time from analytics_summary.json. Ref
// fields stay fixed placeholders for now; prediction comes from main.js so the
// renderer does not duplicate sector-average rules.
function rowSectorMs(row, sectorNumber) {
  return numericMs(row?.[`sector${sectorNumber}Ms`]) ?? parseDashboardTimeToMs(row?.[`sector${sectorNumber}`]);
}

function followedRow(rows) {
  const wanted = String($('followed-car').value || '').trim();
  return (rows || []).find((row) => String(row.carNumber) === wanted) || null;
}

function renderRefSector(sectorNumber, refMs, lastMs, bestMs) {
  const status = normReference.sectorReferenceStatus(lastMs, bestMs, refMs);
  setMetric(`ref-sector-${sectorNumber}`, formatMs(refMs));
  setText(`ref-sector-${sectorNumber}-delta`, status.label);
  setNormCardState(`ref-sector${sectorNumber}-card`, status.state);
}

function renderSectorAnalytics(summary, rows = []) {
  const ourCar = getOurCarAnalytics(summary);
  const prediction = currentState?.lapPrediction || null;
  const refs = currentReferenceTimes();
  const row = followedRow(rows);
  const bestS1 = numericMs(ourCar?.bestSector1Ms);
  const bestS2 = numericMs(ourCar?.bestSector2Ms);
  const bestS3 = numericMs(ourCar?.bestSector3Ms);
  setMetric('best-sector-1', formatMs(bestS1), { flash: true });
  setMetric('best-sector-2', formatMs(bestS2), { flash: true });
  setMetric('best-sector-3', formatMs(bestS3), { flash: true });
  const ideal = [bestS1, bestS2, bestS3].every(Number.isFinite) ? bestS1 + bestS2 + bestS3 : null;
  const idealStatus = normReference.idealReferenceStatus(bestS1, bestS2, bestS3, refs.lapMs);
  setMetric('ideal-time', formatMs(ideal), { flash: true });
  setText('ideal-time-delta', idealStatus.deltaMs !== null ? `Delta ${idealStatus.deltaLabel}` : 'Best S1 + best S2 + best S3');
  setNormTextState('ideal-time', idealStatus.state);

  renderRefSector(1, refs.sector1Ms, rowSectorMs(row, 1), bestS1);
  renderRefSector(2, refs.sector2Ms, rowSectorMs(row, 2), bestS2);
  renderRefSector(3, refs.sector3Ms, rowSectorMs(row, 3), bestS3);
  setMetric('reference-lap-time', formatMs(refs.lapMs));
  setNormCardState('reference-lap-card', 'neutral');
  setMetric('predicted-lap-time', prediction?.available ? formatMs(numericMs(prediction.predictedLapMs)) : '—', { flash: true });
  const predictionDelta = numericMs(prediction?.predictionDeltaMs);
  const predictionDetail = prediction?.available && predictionDelta !== null
    ? `Delta ${displayDelta(predictionDelta)}`
    : prediction?.available ? rowValue(prediction.label) : rowValue(prediction?.reason || 'Waiting for S1');
  setText('predicted-lap-delta', predictionDetail);
  const predictedMs = numericMs(prediction?.predictedLapMs);
  const predictedStatus = normReference.lapReferenceStatus(prediction?.available ? predictedMs : null, refs.lapMs);
  setNormCardState('predicted-lap-card', predictedStatus.state);
}

// Looks up the current live driver for a car and then finds that driver's stored
// analytics. This prevents comparing the BIC/XIC car against the wrong driver.
function driverStatsForLiveCar(summary, rows, carNumber) {
  const row = (rows || []).find((candidate) => String(candidate.carNumber) === String(carNumber));
  const driverName = row?.driver || '';
  const stats = (summary?.driversByCar?.[String(carNumber)] || []).find((driver) => driver.driverName === driverName) || null;
  return { row, driverName, stats };
}

// Fills the D1/D2, BIC, and XIC comparison boxes from precomputed analytics.
// Renderer only formats values; lap/sector math stays in shared modules/main.
function renderDriverAndClassComparisons(summary, rows) {
  const driverComparison = summary?.dashboardAnalysis?.driverComparison;
  const classComparison = summary?.dashboardAnalysis?.classComparison;
  const bestDriver = driverComparison?.bestDriver || null;
  const currentDriver = driverComparison?.currentDriver || null;
  const bestClassCar = classComparison?.bestClassCar || null;
  const selectedCar = classComparison?.selectedCar || null;
  const bicDriver = bestClassCar ? driverStatsForLiveCar(summary, rows, bestClassCar.carNumber).stats : null;
  const xicDriver = selectedCar ? driverStatsForLiveCar(summary, rows, selectedCar.carNumber).stats : null;

  setMetric('best-d1-a', formatMs(numericMs(bestDriver?.bestLapMs)));
  setMetric('last-d2', formatMs(numericMs(currentDriver?.lastLapMs)));
  setDelta('delta-best-last-card', 'delta-best-last', invertedDelta(driverComparison?.deltas?.bestDriverBestLapToCurrentLastLapMs));

  setMetric('best-d1-b', formatMs(numericMs(bestDriver?.bestLapMs)));
  setMetric('best-d2', formatMs(numericMs(currentDriver?.bestLapMs)));
  setDelta('delta-best-best-card', 'delta-best-best', invertedDelta(driverComparison?.deltas?.bestDriverBestLapToCurrentBestLapMs));

  setMetric('average-d1', formatMs(numericMs(bestDriver?.averageLapMs)));
  setMetric('average-d2', formatMs(numericMs(currentDriver?.averageLapMs)));
  setDelta('delta-average-drivers-card', 'delta-average-drivers', invertedDelta(driverComparison?.deltas?.bestDriverAverageToCurrentAverageMs));

  setMetric('average-bic', formatMs(numericMs(bestClassCar?.averageLapMs)));
  setMetric('average-bic-driver', formatMs(numericMs(bicDriver?.averageLapMs)));
  const bicDelta = numericMs(bestClassCar?.averageLapMs) !== null && numericMs(bicDriver?.averageLapMs) !== null
    ? numericMs(bestClassCar?.averageLapMs) - numericMs(bicDriver?.averageLapMs)
    : null;
  setDelta('delta-bic-card', 'delta-bic', bicDelta);

  setMetric('average-xic', formatMs(numericMs(selectedCar?.averageLapMs)));
  setMetric('average-xic-driver', formatMs(numericMs(xicDriver?.averageLapMs)));
  const xicDelta = numericMs(selectedCar?.averageLapMs) !== null && numericMs(xicDriver?.averageLapMs) !== null
    ? numericMs(selectedCar?.averageLapMs) - numericMs(xicDriver?.averageLapMs)
    : null;
  setDelta('delta-xic-card', 'delta-xic', xicDelta);
}

// Converts the structured after-pit projection into one compact label. Lap gaps
// are shown as "1L", "4L", etc. instead of fake seconds.
function projectionLabel(projection) {
  if (!projection?.available) return projection?.reason || 'Waiting for class gaps';
  const position = projection.projectedClassPosition ? `PIC ${projection.projectedClassPosition}` : 'PIC ?';
  const gapLabel = (item) => {
    if (!item) return '';
    if (Number.isFinite(item.lapDeltaToUs) && item.lapDeltaToUs !== 0) return `${Math.abs(item.lapDeltaToUs)}L`;
    return displayDelta(Math.abs(item.projectedGapToUsMs));
  };
  const behind = projection.carAhead ? `${gapLabel(projection.carAhead)} behind #${projection.carAhead.carNumber}` : 'class lead';
  const ahead = projection.carBehind ? `${gapLabel(projection.carBehind)} ahead #${projection.carBehind.carNumber}` : 'no car behind';
  return `${position} · ${behind} · ${ahead}`;
}

// Renders pit window status, required-stop progress, next allowed pit time, and
// after-pit class projection. All rule calculations come from pitstopPlanner.
function renderPitstopPlan(plan) {
  const pitWindow = document.querySelector('.pit-window');
  if (!plan) {
    setText('pit-status', 'Waiting');
    setText('pit-next', '—');
    setText('pit-projection', '—');
    setText('pit-stops-summary', `0/${$('pit-required-input')?.value || '2'}`);
    setText('pit-detail', 'Waiting for race clock and class gaps.');
    if (pitWindow) pitWindow.classList.remove('open', 'soon', 'closed', 'urgent');
    return;
  }

  setText('pit-status', plan.label || plan.status);
  setText('pit-stops-summary', `${plan.completedPitStops}/${plan.rules?.requiredPitStops ?? $('pit-required-input')?.value ?? '2'}`);
  setText('pit-next', plan.canPitNow ? 'Now' : (Number.isFinite(plan.waitMs) ? pitstopPlanner.formatDuration(plan.waitMs) : 'Closed'));
  setText('pit-projection', projectionLabel(plan.projection));
  const detailParts = [
    Number.isFinite(plan.clock?.elapsedMs) ? `Elapsed ${pitstopPlanner.formatDuration(plan.clock.elapsedMs)}` : '',
    Number.isFinite(plan.clock?.remainingMs) ? `remaining ${pitstopPlanner.formatDuration(plan.clock.remainingMs)}` : '',
    Number.isFinite(plan.totalPitStops) && plan.totalPitStops !== plan.completedPitStops ? `total pits ${plan.totalPitStops}, valid ${plan.completedPitStops}` : '',
    Number.isFinite(plan.mustPitSoonMs) ? `latest safe stop in ${pitstopPlanner.formatDuration(plan.mustPitSoonMs)}` : '',
    `pit loss ${pitstopPlanner.formatDuration(plan.rules?.pitStopDurationMs)}`
  ].filter(Boolean);
  setText('pit-detail', detailParts.join(' · '));

  if (pitWindow) {
    pitWindow.classList.remove('open', 'soon', 'closed', 'urgent');
    pitWindow.classList.add(plan.status || 'closed');
  }
  const progress = $('pit-progress');
  if (progress) {
    const pct = Math.max(0, Math.min(100, Number(plan.clock?.progress || 0) * 100));
    progress.style.left = `${pct}%`;
  }
  const bar = $('pit-bar');
  if (bar && plan.rules?.raceDurationMs) {
    const race = Math.max(1, Number(plan.rules.raceDurationMs));
    const start = Math.max(0, Number(plan.rules.pitClosedStartMs || 0));
    const end = Math.max(0, Number(plan.rules.pitClosedEndMs || 0));
    const cooldown = Math.max(0, Number(plan.rules.pitCooldownMs || 0));
    const open = Math.max(0, race - start - end - cooldown);
    bar.style.gridTemplateColumns = `${start}fr ${open / 2}fr ${cooldown}fr ${open / 2}fr ${end}fr`;
  }
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
  const tbody = document.querySelector('#driver-table tbody'); if (!tbody) return; tbody.innerHTML = '';
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
  const tbody = document.querySelector('#history-table tbody'); if (!tbody) return; tbody.innerHTML = '';
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
  renderSectorAnalytics(currentState.analyticsSummary || null, rows);
  renderDriverAndClassComparisons(currentState.analyticsSummary || null, rows);
  renderPitstopPlan(currentState.pitstopPlan || null);
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
    comparisonCar: $('comparison-car')?.value.trim() || '',
    referenceTimes: referenceTimesFromInputs(),
    storageFolder: $('storage-folder').value.trim(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    pitRules: pitRulesFromInputs()
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

async function editReferenceTime(button) {
  const key = button?.dataset?.refKey;
  const inputByKey = {
    lapMs: 'reference-lap-ms',
    sector1Ms: 'reference-sector1-ms',
    sector2Ms: 'reference-sector2-ms',
    sector3Ms: 'reference-sector3-ms'
  };
  if (!key || !inputByKey[key]) return;
  const card = button.closest('.metric-box');
  if (!card || card.querySelector('.ref-edit-input')) return;
  const currentMs = msFromHiddenInput(inputByKey[key]);
  const editor = document.createElement('input');
  editor.className = 'ref-edit-input';
  editor.type = 'text';
  editor.value = Number.isFinite(currentMs) ? formatMs(currentMs) : '';
  editor.placeholder = '2:04.500';
  card.appendChild(editor);
  editor.focus();
  editor.select();

  let finished = false;
  const close = () => {
    if (editor.parentElement) editor.parentElement.removeChild(editor);
  };
  const commit = async () => {
    if (finished) return;
    finished = true;
    const parsed = parseDashboardTimeToMs(editor.value);
    if (parsed === null) {
      alert('Please enter a time like 2:04.500, 124.500, or 41.2');
      finished = false;
      editor.focus();
      editor.select();
      return;
    }
    setHiddenMs(inputByKey[key], parsed);
    close();
    await saveSettingsFromInputs();
    render(currentState);
  };

  editor.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter') await commit();
    if (event.key === 'Escape') {
      finished = true;
      close();
    }
  });
  editor.addEventListener('blur', commit);
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
  if ($('comparison-car')) $('comparison-car').value = currentSettings.comparisonCar || '';
  syncReferenceInputs(currentSettings);
  if ($('pit-duration')) $('pit-duration').value = String(Math.round((currentSettings.pitRules?.pitStopDurationMs || 75000) / 1000));
  if ($('pit-required-input')) $('pit-required-input').value = String(currentSettings.pitRules?.requiredPitStops ?? 2);
  if ($('pit-race-hours')) $('pit-race-hours').value = String((currentSettings.pitRules?.raceDurationMs || 86400000) / 3600000);
  $('poll-interval').value = String(currentSettings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
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
  $('comparison-car')?.addEventListener('change', async () => { await saveSettingsFromInputs(); render(currentState); });
  ['pit-duration','pit-required-input','pit-race-hours'].forEach((id) => $(id)?.addEventListener('change', async () => { await saveSettingsFromInputs(); render(currentState); }));
  document.querySelectorAll('.edit-ref').forEach((button) => button.addEventListener('click', () => editReferenceTime(button)));
  window.liveTiming.onCollectorUpdate(render);
  render(await window.liveTiming.getCollectorState());
  if (!currentSettings.setupComplete || !currentSettings.storageFolder) showSetup(true);
}
init();
