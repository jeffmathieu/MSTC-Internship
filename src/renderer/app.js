// Short DOM lookup helper used throughout the renderer. All IDs referenced here
// must exist in index.html, including the hidden settings inputs.
const $ = (id) => document.getElementById(id);

// currentSettings mirrors the persisted settings from the main process.
// currentState mirrors collectorState from src/main/main.js.
let currentSettings = null;
let currentState = null;
let configuredFollowedCars = [];
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_FOLLOWED_CARS = 3;
const dashboardQuery = new URLSearchParams(window.location?.search || '');
const fixedDashboardCar = String(dashboardQuery.get('car') || '').trim();
const isSecondaryDashboard = dashboardQuery.get('secondary') === '1';

const classBattle = window.classBattle;
const lapAnalytics = window.lapAnalytics;
const pitstopPlanner = window.pitstopPlanner;
const pitstopCircuits = window.pitstopCircuits;
const normReference = window.normReference;
const dashboardView = window.dashboardView;
const timingHighlights = window.timingHighlights;
const previousMetricValues = new Map();

// Applies one of the two supported visual themes. Theme colors themselves are
// grouped at the top of styles.css, so changing the palette never requires
// touching renderer logic.
function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement?.setAttribute('data-theme', normalized);
  document.body?.setAttribute('data-theme', normalized);
  const button = $('theme-toggle');
  if (button) {
    const dark = normalized === 'dark';
    button.textContent = dark ? '☀' : '☾';
    button.setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  return normalized;
}

async function toggleTheme() {
  const next = currentSettings?.theme === 'dark' ? 'light' : 'dark';
  currentSettings = await window.liveTiming.setSettings({ theme: next });
  applyTheme(currentSettings.theme);
}

// Maps collector states to the visual status pill classes in styles.css.
function statusClass(status) {
  if (['collecting', 'connected'].includes(status)) return 'ok';
  if (['waiting', 'loading', 'idle'].includes(status)) return 'warn';
  return 'bad';
}

// Updates only the collector-health dot. Race-control status is rendered by
// updateSession(), so collection health and session flags cannot be confused.
function setStatus(status, message) {
  const dot = $('collector-health');
  if (!dot) return;
  const normalized = String(status || 'idle').toLowerCase();
  dot.classList.remove('is-ok', 'is-error', 'is-neutral');
  if (['collecting', 'connected'].includes(normalized)) dot.classList.add('is-ok');
  else if (normalized === 'error' || normalized === 'parser_error') dot.classList.add('is-error');
  else dot.classList.add('is-neutral');
  const tooltip = String(message || normalized || 'Collector idle');
  dot.setAttribute('title', tooltip);
  dot.setAttribute('aria-label', tooltip);
}

// Displays missing table values consistently.
function rowValue(value) { return value === null || value === undefined || value === '' ? '—' : value; }

function normalizedCarList(cars, fallback = '33') {
  const primary = String(fallback || '').trim();
  return [...new Set([primary, ...(cars || [])].map((car) => String(car || '').trim()).filter(Boolean))].slice(0, MAX_FOLLOWED_CARS);
}

function activeCarNumber() {
  return fixedDashboardCar || String($('followed-car')?.value || currentSettings?.followedCar || '').trim();
}

// Selects the precomputed backend analysis for this dashboard window. The
// renderer changes object references only; all race calculations stay in main.
function analyticsForActiveCar(summary) {
  return dashboardView.analyticsForCar(summary, activeCarNumber());
}

function predictionForActiveCar(state) {
  return dashboardView.predictionForCar(state, activeCarNumber());
}

function pitstopPlanForActiveCar(state) {
  return dashboardView.pitstopPlanForCar(state, activeCarNumber());
}

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
    const card = el.closest('.metric-box, .timing-row');
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

// Stint clocks prioritize readability over lap-timing precision. Internal
// calculations keep milliseconds; the compact header displays whole minutes.
function formatStintClock(ms) {
  if (!Number.isFinite(Number(ms))) return '—';
  const totalMinutes = Math.max(0, Math.floor(Number(ms) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}u${String(minutes).padStart(2, '0')}` : `${minutes}m`;
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
  const selectedCircuit = pitstopCircuits?.pitstopCircuitById($('pit-circuit')?.value);
  const configuredDistance = Number($('pit-distance-meters')?.value);
  const configuredFcySpeed = Number($('pit-fcy-speed')?.value);
  const configuredSafetyLaps = Number($('pit-safety-laps')?.value);
  return {
    raceDurationMs: hoursFromInput('pit-race-hours', 24) * 60 * 60 * 1000,
    pitClosedStartMs: secondsFromInput('pit-closed-start-minutes', 25) * 60 * 1000,
    pitClosedEndMs: secondsFromInput('pit-closed-end-minutes', 25) * 60 * 1000,
    pitCooldownMs: secondsFromInput('pit-cooldown-minutes', 25) * 60 * 1000,
    pitStopDurationMs: secondsFromInput('pit-duration', 75) * 1000,
    requiredPitStops: Math.max(0, Math.floor(secondsFromInput('pit-required-input', 2))),
    nearWindowLaps: 2,
    safetyBufferLaps: Number.isFinite(configuredSafetyLaps) && configuredSafetyLaps >= 0 ? configuredSafetyLaps : 2,
    fixedSafetyBufferMs: secondsFromInput('pit-safety-seconds', 30) * 1000,
    decisionLeadMs: secondsFromInput('pit-decision-seconds', 15) * 1000,
    timingUncertaintyMs: secondsFromInput('pit-uncertainty-seconds', 10) * 1000,
    ruleTimingReference: $('pit-rule-reference')?.value === 'pit-exit' ? 'pit-exit' : 'pit-entry',
    fcyConsiderSavingsMs: secondsFromInput('pit-fcy-consider-seconds', 5) * 1000,
    fcyStrongSavingsMs: secondsFromInput('pit-fcy-strong-seconds', 15) * 1000,
    circuitId: selectedCircuit?.id || currentSettings?.pitCircuitId || 'zolder',
    regularTrackDistanceMeters: Number.isFinite(configuredDistance) && configuredDistance > 0
      ? configuredDistance
      : selectedCircuit?.regularTrackDistanceMeters ?? null,
    fcySpeedKph: Number.isFinite(configuredFcySpeed) && configuredFcySpeed > 0
      ? configuredFcySpeed
      : selectedCircuit?.fcySpeedKph ?? 60
  };
}

function populatePitstopCircuits() {
  const select = $('pit-circuit');
  if (!select || !pitstopCircuits) return;
  select.innerHTML = '';
  pitstopCircuits.PITSTOP_CIRCUITS.forEach((circuit) => {
    const option = document.createElement('option');
    option.value = circuit.id;
    option.textContent = circuit.label;
    select.appendChild(option);
  });
}

function updatePitDistanceNote() {
  const distance = Number($('pit-distance-meters')?.value);
  const speed = Number($('pit-fcy-speed')?.value);
  if (!(distance > 0) || !(speed > 0)) {
    setText('pit-distance-note', 'Enter a positive distance and FCY speed.');
    return;
  }
  const travelSeconds = distance / (speed / 3.6);
  setText('pit-distance-note', `A non-pitting car needs approximately ${travelSeconds.toFixed(1)}s between pit-in and pit-out.`);
}

// Selecting a layout loads its saved defaults. The engineer can then override
// either value for race-specific regulations without changing the profile.
function applyPitCircuitDefaults() {
  const circuit = pitstopCircuits?.pitstopCircuitById($('pit-circuit')?.value);
  if ($('pit-distance-meters')) $('pit-distance-meters').value = String(circuit?.regularTrackDistanceMeters ?? '');
  if ($('pit-fcy-speed')) $('pit-fcy-speed').value = String(circuit?.fcySpeedKph ?? 60);
  updatePitDistanceNote();
}

function showPitSetup(show = true) {
  if (show) {
    $('pit-race-hours').value = String((currentSettings?.pitRules?.raceDurationMs || 86400000) / 3600000);
    $('pit-required-input').value = String(currentSettings?.pitRules?.requiredPitStops ?? 2);
    $('pit-closed-start-minutes').value = String((currentSettings?.pitRules?.pitClosedStartMs ?? 1500000) / 60000);
    $('pit-closed-end-minutes').value = String((currentSettings?.pitRules?.pitClosedEndMs ?? 1500000) / 60000);
    $('pit-cooldown-minutes').value = String((currentSettings?.pitRules?.pitCooldownMs ?? 1500000) / 60000);
    $('pit-circuit').value = currentSettings?.pitCircuitId || currentSettings?.pitRules?.circuitId || 'zolder';
    const selectedCircuit = pitstopCircuits?.pitstopCircuitById($('pit-circuit').value);
    $('pit-distance-meters').value = String(currentSettings?.pitRules?.regularTrackDistanceMeters ?? selectedCircuit?.regularTrackDistanceMeters ?? '');
    $('pit-fcy-speed').value = String(currentSettings?.pitRules?.fcySpeedKph ?? selectedCircuit?.fcySpeedKph ?? 60);
    $('pit-safety-laps').value = String(currentSettings?.pitRules?.safetyBufferLaps ?? 2);
    $('pit-safety-seconds').value = String((currentSettings?.pitRules?.fixedSafetyBufferMs ?? 30000) / 1000);
    $('pit-decision-seconds').value = String((currentSettings?.pitRules?.decisionLeadMs ?? 15000) / 1000);
    $('pit-uncertainty-seconds').value = String((currentSettings?.pitRules?.timingUncertaintyMs ?? 10000) / 1000);
    $('pit-rule-reference').value = currentSettings?.pitRules?.ruleTimingReference === 'pit-exit' ? 'pit-exit' : 'pit-entry';
    $('pit-fcy-consider-seconds').value = String((currentSettings?.pitRules?.fcyConsiderSavingsMs ?? 5000) / 1000);
    $('pit-fcy-strong-seconds').value = String((currentSettings?.pitRules?.fcyStrongSavingsMs ?? 15000) / 1000);
    updatePitDistanceNote();
  }
  $('pit-setup-modal')?.classList.toggle('hidden', !show);
}

function referenceTimesFromInputs() {
  return currentReferenceTimes();
}

function selectedSessionMode() {
  return ['race', 'practice', 'qualifying'].find((mode) => $(`mode-${mode}`)?.checked) || currentSettings?.sessionMode || 'race';
}

function syncSessionMode(mode = currentSettings?.sessionMode || 'race') {
  const normalized = ['race', 'practice', 'qualifying'].includes(mode) ? mode : 'race';
  if ($(`mode-${normalized}`)) $(`mode-${normalized}`).checked = true;
  document.body?.classList.remove('mode-race', 'mode-practice', 'mode-qualifying');
  document.body?.classList.add(`mode-${normalized}`);
}

// Updates a delta card using the global current-minus-reference contract:
// positive means the current value is slower (red), negative is faster (green).
function setDelta(cardId, textId, deltaMs) {
  const card = $(cardId);
  const numeric = Number.isFinite(deltaMs) ? deltaMs : null;
  setMetric(textId, numeric !== null ? displayDelta(numeric) : '—');
  if (!card) return;
  card.classList.remove('good', 'bad', 'neutral');
  if (numeric === null || numeric === 0) card.classList.add('neutral');
  else card.classList.add(numeric > 0 ? 'bad' : 'good');
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

// Shows every completed lap for the active dashboard car, newest first. The
// list remains vertically scrollable for a complete 24-hour history. Status,
// initials and best-lap highlights are precomputed by timingHighlights.js.
function renderLapStrip(state, precomputedHighlights = null) {
  const list = $('lap-strip-list');
  if (!list) return;
  const previousScrollTop = Number(list.scrollTop || 0);
  const wasAtTop = previousScrollTop <= 2;
  const carNumber = activeCarNumber();
  const storedLapCount = lapsForCar(state?.lapHistory || [], carNumber).length;
  // lapHistory is the source of truth. Normally the collector supplies an
  // equally fresh precomputed highlight list; after a partial write/error or
  // while resuming an older folder, rebuild through the shared module whenever
  // that list trails the stored history. The renderer still performs no timing
  // comparison itself.
  const currentHighlights = precomputedHighlights?.lapStrip?.length === storedLapCount
    ? precomputedHighlights
    : timingHighlights?.buildTimingHighlights(state?.lapHistory || [], carNumber) || precomputedHighlights;
  const laps = [...(currentHighlights?.lapStrip || [])].reverse();
  const currentStint = state?.stintState?.cars?.[carNumber]?.currentStint || null;
  setText('info-stint', currentStint
    ? `Driver stint ${currentStint.driverStintNumber} · ${formatStintClock(currentStint.stintTimeMs)} / total ${formatStintClock(currentStint.totalDriverTimeMs)}`
    : 'Waiting for stint data');
  setText('info-car-stint', currentStint ? `Car stint ${currentStint.stintNumber}` : '—');
  list.innerHTML = '';
  if (!laps.length) {
    const empty = document.createElement('p');
    empty.className = 'lap-strip-empty';
    empty.textContent = 'No stored laps yet';
    list.appendChild(empty);
    return;
  }
  laps.forEach((lap, index) => {
    const row = document.createElement('div');
    row.className = `lap-strip-row ${lap.status || 'normal'} ${lap.highlight || 'none'}`;
    row.setAttribute('title', lap.tooltip || lap.driverName || 'Unknown driver');
    const number = document.createElement('span');
    number.className = 'lap-number';
    number.textContent = lapDisplayLabel(lap, laps.length - index - 1);
    const time = document.createElement('strong');
    time.className = 'lap-time';
    time.textContent = formatMs(lap.lapTimeMs);
    const driver = document.createElement('span');
    driver.className = 'lap-driver';
    driver.textContent = lap.driverInitials || '';
    driver.setAttribute('title', lap.driverName || 'Unknown driver');
    const marker = document.createElement('span');
    marker.className = 'lap-marker';
    marker.textContent = lap.marker || '';
    row.appendChild(number);
    row.appendChild(time);
    row.appendChild(driver);
    row.appendChild(marker);
    list.appendChild(row);
  });
  // Polls rebuild the list. Keep the user's position while they inspect older
  // laps; only dashboards already at the top continue following newest-first.
  list.scrollTop = wasAtTop ? 0 : previousScrollTop;
}

// Converts verbose provider race-control text to labels that fit the compact
// header. Populated timing rows are stronger live evidence when RIS briefly
// reports "NO ACTIVE HEAT" despite an active session.
function compactSessionStatus(session = {}, hasTimingRows = false) {
  const raw = String(session.statusText || session.flag || '').trim();
  const normalized = `${session.flag || ''} ${session.statusText || ''}`.trim().toLowerCase();
  if (/full\s*course\s*yellow|\bfcy\b|code\s*60/.test(normalized)) return 'FCY';
  if (/safety\s*car|\bsc\b/.test(normalized)) return 'SC';
  if (/red\s*flag|^red$/.test(normalized)) return 'RED';
  if (/green/.test(normalized)) return 'GREEN';
  if (hasTimingRows && /no\s+active\s+heat|no\s+active\s+session/.test(normalized)) return 'GREEN';
  return raw ? raw.toUpperCase() : '—';
}

// Updates the session summary card in the top information strip.
function updateSession(session = {}, hasTimingRows = false) {
  setText('session-name', session.sessionName || session.pageTitle || '—');
  setText('session-time', session.timeToGo || session.pageUpdated || '—');
  const statusBlock = $('session-status-block');
  setText('status-text', compactSessionStatus(session, hasTimingRows));
  if (statusBlock) {
    const raceControl = String(session.flag || session.statusText || '').toLowerCase();
    statusBlock.classList.remove('flag-caution', 'flag-red');
    if (/red flag|\bred\b/.test(raceControl)) statusBlock.classList.add('flag-red');
    else if (/safety\s*car|full\s*course\s*yellow|\bfcy\b|code\s*60|yellow/.test(raceControl)) statusBlock.classList.add('flag-caution');
  }
}

// Updates the followed-car values shown in the compact session panel.
function setClassBestValue(id, isClassBest) {
  const element = $(id);
  if (element) element.classList.toggle('class-best-value', Boolean(isClassBest));
}

function renderFollowed(rows, timingHighlights = null) {
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
  const storedBestLapMs = numericMs(timingHighlights?.bestLap?.valueMs);
  setMetric('best-time', storedBestLapMs !== null ? formatMs(storedBestLapMs) : row.bestLap, { flash: true });
  setClassBestValue('best-time', timingHighlights?.bestLap?.isClassBest);
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

function renderSectorAnalytics(summary, rows = [], prediction = null) {
  const ourCar = getOurCarAnalytics(summary);
  const refs = currentReferenceTimes();
  const row = followedRow(rows);
  const bestS1 = numericMs(ourCar?.bestSector1Ms);
  const bestS2 = numericMs(ourCar?.bestSector2Ms);
  const bestS3 = numericMs(ourCar?.bestSector3Ms);
  setMetric('best-sector-1', formatMs(bestS1), { flash: true });
  setMetric('best-sector-2', formatMs(bestS2), { flash: true });
  setMetric('best-sector-3', formatMs(bestS3), { flash: true });
  setClassBestValue('best-sector-1', summary?.timingHighlights?.bestSectors?.sector1?.isClassBest);
  setClassBestValue('best-sector-2', summary?.timingHighlights?.bestSectors?.sector2?.isClassBest);
  setClassBestValue('best-sector-3', summary?.timingHighlights?.bestSectors?.sector3?.isClassBest);
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

function comparisonDeltaState(value) {
  const ms = numericMs(value);
  return ms === null || ms === 0 ? 'neutral' : ms < 0 ? 'good' : 'bad';
}

function fillComparisonList(id, items, rowClass, labelKey = 'label', valueKey = 'deltaMs') {
  const container = $(id);
  if (!container) return;
  container.innerHTML = '';
  (items || []).forEach((item) => {
    const row = document.createElement('div');
    row.className = `${rowClass} ${comparisonDeltaState(item[valueKey])}`;
    const label = document.createElement('span');
    label.textContent = item[labelKey] || '—';
    const value = document.createElement('output');
    if (valueKey === 'deltaMs') value.className = 'comparison-delta';
    value.textContent = valueKey === 'deltaMs' ? displayDelta(numericMs(item[valueKey])) : formatMs(numericMs(item[valueKey]));
    row.appendChild(label);
    if (rowClass === 'comparison-line') {
      const absolute = document.createElement('output');
      absolute.className = 'comparison-absolute';
      absolute.textContent = formatMs(numericMs(item.valueMs));
      row.appendChild(absolute);
    }
    if (rowClass === 'comparison-sector') {
      const average = document.createElement('output');
      average.className = 'comparison-sector-average';
      average.textContent = formatMs(numericMs(item.averageMs));
      row.appendChild(average);
    }
    if (rowClass !== 'comparison-sector' || item.showDelta) row.appendChild(value);
    container.appendChild(row);
  });
}

function renderComparisonMatrix(matrix) {
  if (!matrix) return false;
  const ourNumber = matrix.ourCarNumber || activeCarNumber() || '?';
  setText('comparison-team-title', matrix.teammate?.title || 'D2 vs. D1');
  $('comparison-team-title')?.setAttribute('title', matrix.teammate?.title || 'D2 vs. D1');
  setText('comparison-bic-title', `#${ourNumber} vs. BIC${matrix.bic?.targetCarNumber ? ` #${matrix.bic.targetCarNumber}` : ''}`);
  setText('comparison-xic-title', `#${ourNumber} vs.`);
  if ($('comparison-xic-car') && document.activeElement !== $('comparison-xic-car')) {
    $('comparison-xic-car').value = matrix.xic?.targetCarNumber || currentSettings?.comparisonCar || '';
  }
  [
    ['team', matrix.teammate],
    ['bic', matrix.bic],
    ['xic', matrix.xic]
  ].forEach(([id, column]) => {
    fillComparisonList(`comparison-${id}-metrics`, column?.metrics, 'comparison-line');
    const averages = [
      { label: 'Total average', valueMs: column?.totalAverageMs, deltaMs: column?.totalAverageDeltaMs, total: true },
      ...(column?.averages || [])
    ];
    const averagesContainer = $(`comparison-${id}-averages`);
    if (averagesContainer) {
      averagesContainer.innerHTML = '';
      averages.forEach((item) => {
        const row = document.createElement('div');
        row.className = `comparison-average${item.total ? ' total' : ''}`;
        const label = document.createElement('span');
        label.textContent = item.label;
        const value = document.createElement('output');
        value.textContent = formatMs(numericMs(item.valueMs));
        const delta = document.createElement('output');
        delta.className = `comparison-average-delta ${comparisonDeltaState(item.deltaMs)}`;
        delta.textContent = displayDelta(numericMs(item.deltaMs));
        row.appendChild(label);
        row.appendChild(value);
        row.appendChild(delta);
        averagesContainer.appendChild(row);
      });
    }
    fillComparisonList(`comparison-${id}-sectors`, column?.sectors, 'comparison-sector');
  });
  return true;
}

// Fills the D1/D2, BIC, and XIC comparison boxes from precomputed analytics.
// Renderer only formats values; lap/sector math stays in shared modules/main.
function renderDriverAndClassComparisons(summary, rows) {
  const view = summary?.comparisonView;
  if (renderComparisonMatrix(view?.matrix)) return;
  if (view?.columns?.length === 5) {
    const ids = [
      ['best-d1-a', 'last-d2', 'delta-best-last-card', 'delta-best-last'],
      ['best-d1-b', 'best-d2', 'delta-best-best-card', 'delta-best-best'],
      ['average-d1', 'average-d2', 'delta-average-drivers-card', 'delta-average-drivers'],
      ['average-bic', 'average-bic-driver', 'delta-bic-card', 'delta-bic'],
      ['average-xic', 'average-xic-driver', 'delta-xic-card', 'delta-xic']
    ];
    view.columns.forEach((column, index) => {
      setText(`comparison-${index + 1}-top-label`, column.topLabel);
      setText(`comparison-${index + 1}-bottom-label`, column.bottomLabel);
      setText(`comparison-${index + 1}-delta-label`, column.deltaLabel);
      setMetric(ids[index][0], formatMs(numericMs(column.topMs)));
      setMetric(ids[index][1], formatMs(numericMs(column.bottomMs)));
      setDelta(ids[index][2], ids[index][3], numericMs(column.deltaMs));
    });
    return;
  }
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
  setDelta('delta-best-last-card', 'delta-best-last', numericMs(driverComparison?.deltas?.bestDriverBestLapToCurrentLastLapMs));

  setMetric('best-d1-b', formatMs(numericMs(bestDriver?.bestLapMs)));
  setMetric('best-d2', formatMs(numericMs(currentDriver?.bestLapMs)));
  setDelta('delta-best-best-card', 'delta-best-best', numericMs(driverComparison?.deltas?.bestDriverBestLapToCurrentBestLapMs));

  setMetric('average-d1', formatMs(numericMs(bestDriver?.averageLapMs)));
  setMetric('average-d2', formatMs(numericMs(currentDriver?.averageLapMs)));
  setDelta('delta-average-drivers-card', 'delta-average-drivers', numericMs(driverComparison?.deltas?.bestDriverAverageToCurrentAverageMs));

  setMetric('average-bic', formatMs(numericMs(bestClassCar?.averageLapMs)));
  setMetric('average-bic-driver', formatMs(numericMs(bicDriver?.averageLapMs)));
  const bicDelta = numericMs(bestClassCar?.averageLapMs) !== null && numericMs(bicDriver?.averageLapMs) !== null
    ? numericMs(bicDriver?.averageLapMs) - numericMs(bestClassCar?.averageLapMs)
    : null;
  setDelta('delta-bic-card', 'delta-bic', bicDelta);

  setMetric('average-xic', formatMs(numericMs(selectedCar?.averageLapMs)));
  setMetric('average-xic-driver', formatMs(numericMs(xicDriver?.averageLapMs)));
  const xicDelta = numericMs(selectedCar?.averageLapMs) !== null && numericMs(xicDriver?.averageLapMs) !== null
    ? numericMs(xicDriver?.averageLapMs) - numericMs(selectedCar?.averageLapMs)
    : null;
  setDelta('delta-xic-card', 'delta-xic', xicDelta);
}

// Renders the nearest same-class rivals from the precomputed class battle
// summary. No gap or pace arithmetic lives here; classBattle.js supplies last-
// lap deltas, the confirmed gap chain, and configurable recent-pace estimates.
function renderAdjacentClassBattles(summary) {
  const battles = summary?.adjacentClassBattles;
  const setDetailLines = (side, delta = '', trend = '', prediction = '') => {
    setText(`battle-${side}-delta`, delta);
    setText(`battle-${side}-trend`, trend);
    setText(`battle-${side}-prediction`, prediction);
  };
  const renderSide = (side, item) => {
    const card = $(`battle-${side}-card`);
    if (!item) {
      setText(`battle-${side}-main`, side === 'ahead' && battles?.available ? 'Class leader' : side === 'behind' && battles?.available ? 'No class car behind' : '—');
      setDetailLines(side, battles?.available ? 'No adjacent rival' : 'Waiting for class gap and pace');
      if (card) {
        card.classList.remove('good', 'bad');
        card.classList.add('neutral');
      }
      return;
    }
    if (battles?.mode === 'qualifying') {
      setText(`battle-${side}-main`, `#${item.row?.carNumber || '?'} · Best Δ ${displayDelta(numericMs(item.bestLapDeltaMs))}`);
      setDetailLines(
        side,
        `Their best ${formatMs(numericMs(item.rivalBestLapMs))}`,
        `Our best ${formatMs(numericMs(item.ourBestLapMs))}`,
        'Qualifying comparison'
      );
      if (card) {
        card.classList.remove('good', 'bad', 'neutral');
        card.classList.add(item.trendState || 'neutral');
      }
      return;
    }
    if (item.suppressed) {
      setText(`battle-${side}-main`, `#${item.row?.carNumber || '?'} · In pit`);
      setDetailLines(
        side,
        `Last lap Δ ${item.lastLapDeltaLabel || '—'}`,
        item.trendLabel || `#${item.row?.carNumber || '?'} remains in pit`,
        item.predictionLabel || `Prediction paused after ${item.rivalPitLaps} of our laps`
      );
    } else {
      setText(`battle-${side}-main`, `#${item.row?.carNumber || '?'} · Gap ${item.gapLabel}`);
      // New summaries provide explicit labels. catchInfo remains a fallback for
      // race folders saved before the three-line battle-card layout existed.
      const fallbackParts = String(item.catchInfo || '').split(' · ');
      setDetailLines(
        side,
        `Last lap Δ ${item.lastLapDeltaLabel || '—'}`,
        item.trendLabel || fallbackParts.slice(0, 2).join(' · '),
        item.predictionLabel || fallbackParts.slice(2).join(' · ') || 'No catch prediction available'
      );
    }
    if (card) {
      card.classList.remove('good', 'bad', 'neutral');
      card.classList.add(item.trendState || 'neutral');
    }
  };
  renderSide('ahead', battles?.ahead || null);
  renderSide('behind', battles?.behind || null);
}

// Converts the structured after-pit projection into one compact label. Lap gaps
// are shown as "1L", "4L", etc. instead of fake seconds.
function projectionLabel(projection) {
  if (!projection?.available) return projection?.reason || 'Waiting for class gaps';
  const position = projection.projectedClassPosition ? `PIC ${projection.projectedClassPosition}` : 'PIC ?';
  const gapLabel = (item) => {
    if (!item) return '';
    if (Number.isFinite(item.lapDeltaToUs) && item.lapDeltaToUs !== 0) return `${Math.abs(item.lapDeltaToUs)}L`;
    return formatMs(Math.abs(item.projectedGapToUsMs));
  };
  const behind = projection.carAhead ? `${gapLabel(projection.carAhead)} behind #${projection.carAhead.carNumber}` : 'class lead';
  const ahead = projection.carBehind ? `${gapLabel(projection.carBehind)} ahead #${projection.carBehind.carNumber}` : 'no car behind';
  const label = `${position} · ${behind} · ${ahead}`;
  return projection.provisional ? `FCY gaps stabilizing · ${label}` : label;
}

// Renders pit window status, required-stop progress, next allowed pit time, and
// after-pit class projection. All rule calculations come from pitstopPlanner.
function renderPitstopPlan(plan) {
  const pitWindow = $('pit-window');
  if ($('open-pit-setup')) {
    $('open-pit-setup').disabled = false;
    $('open-pit-setup').title = 'Adjust pitstop strategy settings';
  }
  if (!plan) {
    setText('pit-status', 'Waiting');
    setText('pit-next', '—');
    setText('pit-projection', '—');
    setText('pit-stops-summary', `0/${$('pit-required-input')?.value || '2'}`);
    setText('pit-detail', 'Waiting for race clock and class gaps.');
    if (pitWindow) pitWindow.classList.remove('open', 'soon', 'closed', 'urgent', 'complete');
    return;
  }

  setText('pit-status', plan.label || plan.status);
  setText('pit-stops-summary', `${plan.completedPitStops}/${plan.rules?.requiredPitStops ?? $('pit-required-input')?.value ?? '2'}`);
  setText('pit-next', plan.requirementsComplete
    ? (plan.canPitNow ? 'Optional' : 'Closed')
    : plan.recommendation?.action || (plan.canPitNow ? 'Now' : (Number.isFinite(plan.waitMs) ? pitstopPlanner.formatDuration(plan.waitMs) : 'Closed')));
  setText('pit-projection', projectionLabel(plan.projection));
  const safeDeadline = plan.schedule?.next?.latestSafeEntryElapsedMs ?? plan.latestSafePitElapsedMs;
  const possibleDeadline = plan.schedule?.next?.latestPossibleEntryElapsedMs ?? plan.latestPossiblePitElapsedMs;
  const bufferMs = plan.schedule?.buffer?.totalMs;
  const detailParts = [
    Number.isFinite(plan.clock?.elapsedMs) ? `Elapsed ${pitstopPlanner.formatDuration(plan.clock.elapsedMs)}` : '',
    Number.isFinite(plan.clock?.remainingMs) ? `remaining ${pitstopPlanner.formatDuration(plan.clock.remainingMs)}` : '',
    Number.isFinite(plan.totalPitStops) && plan.totalPitStops !== plan.completedPitStops ? `total pits ${plan.totalPitStops}, valid ${plan.completedPitStops}` : '',
    Number.isFinite(safeDeadline) ? `safe by ${pitstopPlanner.formatDuration(safeDeadline)} (${pitstopPlanner.formatDuration(safeDeadline - plan.clock.elapsedMs)} left)` : '',
    Number.isFinite(possibleDeadline) ? `legal limit ${pitstopPlanner.formatDuration(possibleDeadline)}` : '',
    Number.isFinite(bufferMs) ? `buffer ${pitstopPlanner.formatDuration(bufferMs)}` : '',
    Number.isFinite(plan.recommendation?.fcySavingsMs) ? `FCY saves ${pitstopPlanner.formatDuration(plan.recommendation.fcySavingsMs)}` : '',
    Number.isFinite(plan.pitLoss?.pitLossMs)
      ? `${plan.pitLoss?.active ? 'FCY net pit loss' : 'pit loss'} ${pitstopPlanner.formatDuration(plan.pitLoss.pitLossMs)}`
      : plan.pitLoss?.reason || '',
    plan.recommendation?.reason || ''
  ].filter(Boolean);
  setText('pit-detail', detailParts.join(' · '));
  if ($('pit-detail')) {
    const buffer = plan.schedule?.buffer || {};
    $('pit-detail').title = [
      `Rule timing point: ${plan.schedule?.ruleTimingReference || plan.rules?.ruleTimingReference || 'pit-entry'}`,
      `Lap buffer: ${pitstopPlanner.formatDuration(buffer.lapBufferMs)}`,
      `Fixed buffer: ${pitstopPlanner.formatDuration(buffer.fixedSafetyBufferMs)}`,
      `Decision lead: ${pitstopPlanner.formatDuration(buffer.decisionLeadMs)}`,
      `Timing uncertainty: ${pitstopPlanner.formatDuration(buffer.timingUncertaintyMs)}`
    ].join('\n');
  }

  if (pitWindow) {
    pitWindow.classList.remove('open', 'soon', 'closed', 'urgent', 'complete');
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
    const open = Math.max(0, race - start - end);
    bar.style.gridTemplateColumns = `${start}fr ${open}fr ${end}fr`;
  }
  const cooldownOverlays = $('pit-cooldown-overlays');
  if (cooldownOverlays && plan.rules?.raceDurationMs) {
    const race = Math.max(1, Number(plan.rules.raceDurationMs));
    const cooldownMs = Math.max(0, Number(plan.rules.pitCooldownMs || 0));
    const history = (plan.validPitElapsedHistoryMs || plan.pitState?.validPitElapsedHistoryMs || [])
      .map(numericMs)
      .filter(Number.isFinite);
    if (!history.length && plan.pitState?.lastPitCountedAsValid) {
      const latest = numericMs(plan.lastPitElapsedMs ?? plan.pitState?.lastPitElapsedMs);
      if (Number.isFinite(latest)) history.push(latest);
    }
    cooldownOverlays.innerHTML = '';
    history.forEach((pitElapsedMs) => {
      const startPct = Math.max(0, Math.min(100, (pitElapsedMs / race) * 100));
      const endPct = Math.max(startPct, Math.min(100, ((pitElapsedMs + cooldownMs) / race) * 100));
      if (endPct <= startPct) return;
      const overlay = document.createElement('i');
      overlay.className = 'pit-cooldown-period';
      overlay.style.left = `${startPct}%`;
      overlay.style.width = `${endPct - startPct}%`;
      cooldownOverlays.appendChild(overlay);
    });
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
  updateSession(currentState.session || {}, rows.length > 0);
  $('row-count').textContent = String(rows.length);
  $('history-count').textContent = String(history.length);
  $('last-update').textContent = currentState.lastSuccessAt ? new Date(currentState.lastSuccessAt).toLocaleTimeString() : '—';
  const activeAnalytics = analyticsForActiveCar(currentState.analyticsSummary || null);
  renderFollowed(rows, activeAnalytics?.timingHighlights || null);
  renderLapStrip(currentState, activeAnalytics?.timingHighlights || null);
  syncSessionMode(activeAnalytics?.sessionMode || currentSettings?.sessionMode || 'race');
  renderSectorAnalytics(activeAnalytics, rows, predictionForActiveCar(currentState));
  renderDriverAndClassComparisons(activeAnalytics, rows);
  renderAdjacentClassBattles(activeAnalytics);
  renderPitstopPlan(pitstopPlanForActiveCar(currentState));
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
  const primaryCar = String(configuredFollowedCars[0] || currentSettings?.followedCar || $('followed-car').value || '33').trim();
  const followedCars = normalizedCarList(configuredFollowedCars, primaryCar);
  const previousMode = currentSettings?.sessionMode || 'race';
  const sessionMode = selectedSessionMode();
  const referenceTimesByMode = {
    race: { ...(currentSettings?.referenceTimesByMode?.race || {}) },
    practice: { ...(currentSettings?.referenceTimesByMode?.practice || {}) },
    qualifying: { ...(currentSettings?.referenceTimesByMode?.qualifying || {}) }
  };
  referenceTimesByMode[previousMode] = referenceTimesFromInputs();
  const activeReferenceTimes = sessionMode === previousMode
    ? referenceTimesFromInputs()
    : referenceTimesByMode[sessionMode];
  const patch = {
    timingUrl: $('timing-url').value.trim(),
    followedCar: primaryCar,
    followedCars,
    sessionMode,
    comparisonCar: $('comparison-car')?.value.trim() || '',
    referenceTimes: activeReferenceTimes,
    referenceTimesByMode,
    pitCircuitId: $('pit-circuit')?.value || currentSettings?.pitCircuitId || 'zolder',
    storageFolder: $('storage-folder').value.trim(),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    pitRules: pitRulesFromInputs()
  };
  if (setupComplete) patch.setupComplete = true;
  currentSettings = await window.liveTiming.setSettings(patch);
  configuredFollowedCars = normalizedCarList(currentSettings.followedCars, currentSettings.followedCar);
  syncReferenceInputs(currentSettings);
  syncSessionMode(currentSettings.sessionMode);
  return currentSettings;
}

function renderExtraCarInputs() {
  const container = $('setup-extra-cars');
  if (!container) return;
  if ($('setup-add-car')) $('setup-add-car').disabled = configuredFollowedCars.length >= MAX_FOLLOWED_CARS;
  container.innerHTML = '';
  configuredFollowedCars.slice(1).forEach((carNumber, offset) => {
    const index = offset + 1;
    const row = document.createElement('div');
    row.className = 'setup-car-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = carNumber;
    input.className = 'setup-extra-car';
    input.setAttribute('aria-label', `Additional car ${index + 1} number`);
    input.addEventListener('input', () => { configuredFollowedCars[index] = input.value; });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary setup-car-action';
    remove.textContent = '−';
    remove.title = 'Remove this car dashboard';
    remove.setAttribute('aria-label', `Remove additional car ${index + 1}`);
    remove.addEventListener('click', () => {
      configuredFollowedCars.splice(index, 1);
      renderExtraCarInputs();
    });
    row.appendChild(input);
    row.appendChild(remove);
    container.appendChild(row);
  });
}

// Copies global settings into the visible setup modal. Secondary dashboards
// still edit the same shared list; their fixed display car does not become the
// primary car accidentally.
function syncSetupFromMain() {
  $('setup-url').value = $('timing-url').value;
  configuredFollowedCars = normalizedCarList(currentSettings?.followedCars, currentSettings?.followedCar || '33');
  $('setup-car').value = configuredFollowedCars[0] || '33';
  $('setup-folder').value = $('storage-folder').value;
  syncSessionMode(currentSettings?.sessionMode || 'race');
  renderExtraCarInputs();
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
  const card = button.closest('.metric-box, .timing-row');
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
  configuredFollowedCars[0] = $('setup-car').value;
  configuredFollowedCars = normalizedCarList(configuredFollowedCars, $('setup-car').value || '33');
  if (!fixedDashboardCar) $('followed-car').value = configuredFollowedCars[0] || '33';
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
  applyTheme(currentSettings.theme);
  configuredFollowedCars = normalizedCarList(currentSettings.followedCars, currentSettings.followedCar || '33');
  $('timing-url').value = currentSettings.timingUrl || 'https://livetiming.getraceresults.com/demo#screen-results';
  $('followed-car').value = fixedDashboardCar || currentSettings.followedCar || '33';
  if (fixedDashboardCar) document.title = `Race Engineer Dashboard - Car #${fixedDashboardCar}`;
  $('storage-folder').value = currentSettings.storageFolder || '';
  if ($('comparison-car')) $('comparison-car').value = currentSettings.comparisonCar || '';
  if ($('comparison-xic-car')) $('comparison-xic-car').value = currentSettings.comparisonCar || '';
  syncReferenceInputs(currentSettings);
  syncSessionMode(currentSettings.sessionMode || 'race');
  populatePitstopCircuits();
  if ($('pit-circuit')) $('pit-circuit').value = currentSettings.pitCircuitId || currentSettings.pitRules?.circuitId || 'zolder';
  if ($('pit-duration')) $('pit-duration').value = String(Math.round((currentSettings.pitRules?.pitStopDurationMs || 75000) / 1000));
  if ($('pit-required-input')) $('pit-required-input').value = String(currentSettings.pitRules?.requiredPitStops ?? 2);
  if ($('pit-race-hours')) $('pit-race-hours').value = String((currentSettings.pitRules?.raceDurationMs || 86400000) / 3600000);
  if ($('pit-closed-start-minutes')) $('pit-closed-start-minutes').value = String((currentSettings.pitRules?.pitClosedStartMs ?? 1500000) / 60000);
  if ($('pit-closed-end-minutes')) $('pit-closed-end-minutes').value = String((currentSettings.pitRules?.pitClosedEndMs ?? 1500000) / 60000);
  if ($('pit-cooldown-minutes')) $('pit-cooldown-minutes').value = String((currentSettings.pitRules?.pitCooldownMs ?? 1500000) / 60000);
  const initialPitCircuit = pitstopCircuits?.pitstopCircuitById($('pit-circuit')?.value);
  if ($('pit-distance-meters')) $('pit-distance-meters').value = String(currentSettings.pitRules?.regularTrackDistanceMeters ?? initialPitCircuit?.regularTrackDistanceMeters ?? '');
  if ($('pit-fcy-speed')) $('pit-fcy-speed').value = String(currentSettings.pitRules?.fcySpeedKph ?? initialPitCircuit?.fcySpeedKph ?? 60);
  if ($('pit-safety-laps')) $('pit-safety-laps').value = String(currentSettings.pitRules?.safetyBufferLaps ?? 2);
  if ($('pit-safety-seconds')) $('pit-safety-seconds').value = String((currentSettings.pitRules?.fixedSafetyBufferMs ?? 30000) / 1000);
  if ($('pit-decision-seconds')) $('pit-decision-seconds').value = String((currentSettings.pitRules?.decisionLeadMs ?? 15000) / 1000);
  if ($('pit-uncertainty-seconds')) $('pit-uncertainty-seconds').value = String((currentSettings.pitRules?.timingUncertaintyMs ?? 10000) / 1000);
  if ($('pit-rule-reference')) $('pit-rule-reference').value = currentSettings.pitRules?.ruleTimingReference === 'pit-exit' ? 'pit-exit' : 'pit-entry';
  if ($('pit-fcy-consider-seconds')) $('pit-fcy-consider-seconds').value = String((currentSettings.pitRules?.fcyConsiderSavingsMs ?? 5000) / 1000);
  if ($('pit-fcy-strong-seconds')) $('pit-fcy-strong-seconds').value = String((currentSettings.pitRules?.fcyStrongSavingsMs ?? 15000) / 1000);
  $('poll-interval').value = String(currentSettings.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  syncSetupFromMain();
  setupDetailTabs();

  // Race-day controls: each button calls a small preload API method, which then
  // invokes the matching ipcMain handler in main.js.
  $('start')?.addEventListener('click', async () => { await saveSettingsFromInputs(true); await window.liveTiming.startCollector(currentSettings.timingUrl); });
  $('stop')?.addEventListener('click', () => window.liveTiming.stopCollector());
  $('show-live')?.addEventListener('click', () => window.liveTiming.openLiveWindow());
  $('open-graphs')?.addEventListener('click', () => window.liveTiming.openGraphsWindow(activeCarNumber()));
  $('theme-toggle')?.addEventListener('click', toggleTheme);
  $('choose-folder')?.addEventListener('click', async () => { await chooseAndSetFolder('storage-folder'); await saveSettingsFromInputs(); });
  $('setup-choose-folder')?.addEventListener('click', async () => { await chooseAndSetFolder('setup-folder'); });
  $('setup-add-car')?.addEventListener('click', () => {
    if (configuredFollowedCars.length >= MAX_FOLLOWED_CARS) return;
    configuredFollowedCars.push('');
    renderExtraCarInputs();
    const inputs = $('setup-extra-cars')?.querySelectorAll?.('.setup-extra-car') || [];
    inputs[inputs.length - 1]?.focus();
  });
  $('setup-car')?.addEventListener('input', () => { configuredFollowedCars[0] = $('setup-car').value; });
  $('setup-save')?.addEventListener('click', async () => { syncMainFromSetup(); await saveSettingsFromInputs(true); showSetup(false); render(currentState || await window.liveTiming.getCollectorState()); });
  $('open-pit-setup')?.addEventListener('click', () => showPitSetup(true));
  $('pit-setup-cancel')?.addEventListener('click', () => showPitSetup(false));
  $('pit-circuit')?.addEventListener('change', applyPitCircuitDefaults);
  ['pit-distance-meters', 'pit-fcy-speed'].forEach((id) => $(id)?.addEventListener('input', updatePitDistanceNote));
  $('pit-setup-save')?.addEventListener('click', async () => {
    await saveSettingsFromInputs();
    showPitSetup(false);
    render(currentState);
  });
  $('open-setup')?.addEventListener('click', () => showSetup(true));
  $('comparison-xic-car')?.addEventListener('change', async () => {
    const comparisonCar = String($('comparison-xic-car').value || '').trim();
    if ($('comparison-car')) $('comparison-car').value = comparisonCar;
    currentSettings = await window.liveTiming.setSettings({ comparisonCar });
    render(currentState);
  });
  $('export')?.addEventListener('click', async () => { const result = await window.liveTiming.exportCurrent(); alert(`Exported:\n${result.csvPath}\n${result.jsonPath}\n${result.historyPath || ''}`); });

  // Persist settings immediately when hidden inputs change. If new settings are
  // added to the modal, include their hidden input IDs here.
  ['timing-url','followed-car','poll-interval'].forEach((id) => $(id)?.addEventListener('change', async () => { await saveSettingsFromInputs(); render(currentState); }));
  $('comparison-car')?.addEventListener('change', async () => { await saveSettingsFromInputs(); render(currentState); });
  $('pit-duration')?.addEventListener('change', async () => { await saveSettingsFromInputs(); render(currentState); });
  document.querySelectorAll('.edit-ref').forEach((button) => button.addEventListener('click', () => editReferenceTime(button)));
  window.liveTiming.onThemeUpdate?.((theme) => {
    currentSettings = { ...currentSettings, theme: applyTheme(theme) };
  });
  window.liveTiming.onCollectorUpdate(render);
  render(await window.liveTiming.getCollectorState());
  if (!currentSettings.setupComplete || !currentSettings.storageFolder) showSetup(true);
}
init();
