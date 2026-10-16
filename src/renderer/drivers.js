// Driver overview window. All numbers are prepared in the main process
// (shared/driverOverview.js); this file only formats and draws them.
const SHARE_COLORS = ['#315fc7', '#d94c62', '#1e9f67', '#e2a11a', '#7a56b3', '#168a91', '#9c4f2c', '#525b66'];
let carNumber = '';

const $ = (id) => document.getElementById(id);
const finite = (value) => Number.isFinite(value);

function lapTime(ms) {
  if (!finite(ms)) return '—';
  const total = Math.round(ms);
  return `${Math.floor(total / 60000)}:${String(Math.floor((total % 60000) / 1000)).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}

function duration(ms) {
  if (!finite(ms)) return '—';
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function gap(ms) {
  if (!finite(ms)) return '—';
  if (Math.abs(ms) < 1) return '0.000';
  return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(3)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

function kpi(label, value, note = '') {
  const tile = el('div', 'kpi');
  tile.append(el('span', 'kpi-label', label), el('strong', 'kpi-value', value), el('span', 'kpi-note', note));
  return tile;
}

function renderKpis(overview) {
  const t = overview.totals;
  $('kpis').replaceChildren(
    kpi('Drivers', String(t.driverCount), `${t.stintCount} stint${t.stintCount === 1 ? '' : 's'}`),
    kpi('Driving time', duration(t.drivingMs), t.pitExcludedMs ? `${duration(t.pitExcludedMs)} pit time excluded` : 'no pit time yet'),
    kpi('Laps', String(t.lapCount), 'completed by all drivers'),
    kpi('Fastest lap', lapTime(t.fastestLap?.ms), t.fastestLap?.driverName || '—'),
    kpi('Best average', lapTime(t.fastestAverage?.ms), t.fastestAverage?.driverName || '—'),
    kpi('Longest stint', duration(t.longestStint?.drivingMs), t.longestStint ? `${t.longestStint.driverName} · stint ${t.longestStint.number}` : '—')
  );
}

function renderShare(overview) {
  const bar = $('share-bar'), legend = $('share-legend');
  bar.replaceChildren();
  legend.replaceChildren();
  overview.drivers.forEach((driver, index) => {
    const color = SHARE_COLORS[index % SHARE_COLORS.length];
    const pct = finite(driver.sharePct) ? driver.sharePct : 0;
    const segment = el('div', `share-segment${driver.isCurrent ? ' current' : ''}`);
    segment.style.width = `${pct}%`;
    segment.style.background = color;
    segment.title = `${driver.driverName}: ${duration(driver.drivingMs)} (${pct.toFixed(1)}%)`;
    if (pct >= 8) segment.textContent = `${pct.toFixed(0)}%`;
    bar.append(segment);
    const item = el('span', 'legend-item');
    const swatch = el('i', 'legend-swatch');
    swatch.style.background = color;
    item.append(swatch, document.createTextNode(`${driver.driverName} · ${duration(driver.drivingMs)}`));
    legend.append(item);
  });
  if (!overview.drivers.length) bar.append(el('div', 'empty', 'No drivers yet'));
}

// [header, value formatter, "is best" test, alignment]
const DRIVER_COLUMNS = [
  ['Driver', (d) => d.driverName, null, 'left'],
  ['Stints', (d) => String(d.stintCount)],
  ['Driving time', (d) => duration(d.drivingMs)],
  ['Share', (d) => (finite(d.sharePct) ? `${d.sharePct.toFixed(1)}%` : '—')],
  ['Laps', (d) => `${d.paceLapCount}/${d.lapCount}`],
  ['Best lap', (d) => lapTime(d.bestLapMs), (d) => d.isFastestLap],
  ['Δ best', (d) => gap(d.deltaBestMs)],
  ['Avg lap', (d) => lapTime(d.averageLapMs), (d) => d.isFastestAverage],
  ['Δ avg', (d) => gap(d.deltaAverageMs)],
  ['Consistency σ', (d) => (finite(d.consistencyMs) ? `${(d.consistencyMs / 1000).toFixed(3)}s` : '—')],
  ['Best S1', (d) => lapTime(d.bestSectorMs[0]), (d) => d.bestSectorFlags[0]],
  ['Best S2', (d) => lapTime(d.bestSectorMs[1]), (d) => d.bestSectorFlags[1]],
  ['Best S3', (d) => lapTime(d.bestSectorMs[2]), (d) => d.bestSectorFlags[2]],
  ['Avg stint', (d) => (finite(d.averageStintLaps) ? `${d.averageStintLaps.toFixed(1)} laps` : '—')],
  ['Longest stint', (d) => (d.longestStint ? `${duration(d.longestStint.drivingMs)} · ${d.longestStint.lapCount} laps` : '—')],
  ['Last stint', (d) => (d.lastStint ? `#${d.lastStint.number} · laps ${d.lastStint.startLap ?? '?'}–${d.lastStint.endLap ?? '?'}${d.lastStint.closed ? '' : ' · active'}` : '—')]
];

function fillTable(table, columns, items, emptyText, rowClass) {
  const head = el('tr');
  columns.forEach(([label, , , align]) => head.append(el('th', align === 'left' ? 'left' : '', label)));
  table.tHead.replaceChildren(head);
  const rows = items.map((item) => {
    const row = el('tr', rowClass(item));
    columns.forEach(([, value, best, align]) => {
      row.append(el('td', `${align === 'left' ? 'left ' : ''}${best?.(item) ? 'best' : ''}`.trim(), value(item)));
    });
    return row;
  });
  if (!rows.length) {
    const row = el('tr');
    const cell = el('td', 'empty', emptyText);
    cell.colSpan = columns.length;
    row.append(cell);
    rows.push(row);
  }
  table.tBodies[0].replaceChildren(...rows);
  return rows;
}

const STINT_COLUMNS = [
  ['#', (s) => String(s.number)],
  ['Driver', (s) => s.driverName, null, 'left'],
  ['Laps', (s) => `${s.startLap ?? '?'}–${s.endLap ?? '?'}`],
  ['Lap count', (s) => String(s.lapCount)],
  ['Driving time', (s) => `${duration(s.drivingMs)}${s.estimated ? ' ~' : ''}`],
  ['Elapsed', (s) => duration(s.elapsedMs)],
  ['Pit time excluded', (s) => duration(s.pitExcludedMs)],
  ['Avg lap', (s) => lapTime(s.averageLapMs)],
  ['Best lap', (s) => lapTime(s.bestLapMs)],
  ['Status', (s) => (s.closed ? 'closed' : 'active')]
];

function render(state) {
  const summary = state?.analyticsSummary || {};
  const overview = summary.driverOverviewByCar?.[carNumber] || {
    totals: { driverCount: 0, stintCount: 0, lapCount: 0, drivingMs: 0, pitExcludedMs: 0, bestSectors: [] }, drivers: [], stints: []
  };
  $('title').textContent = `Driver overview · Car #${carNumber || '—'}`;
  const session = state?.session?.sessionName || 'Waiting for timing data';
  $('subtitle').textContent = `${session}${state?.lastSuccessAt ? ` · updated ${new Date(state.lastSuccessAt).toLocaleTimeString()}` : ''}`;
  $('current-driver').textContent = overview.currentDriver ? `Driving now: ${overview.currentDriver}` : 'No driver detected';
  const filter = overview.conditionFilter || 'combined';
  $('condition').textContent = `Pace view: ${filter === 'combined' ? 'full' : filter}`;
  renderKpis(overview);
  renderShare(overview);
  const driverRows = fillTable($('driver-table'), DRIVER_COLUMNS, overview.drivers, 'Waiting for completed laps', (d) => (d.isCurrent ? 'current-row' : ''));
  overview.drivers.forEach((driver, index) => { if (driver.isCurrent) driverRows[index].cells[0].append(el('span', 'badge', 'driving')); });
  fillTable($('stint-table'), STINT_COLUMNS, overview.stints, 'No stints yet', (s) => (s.closed ? '' : 'current-row'));
}

async function init() {
  const settings = await window.liveTiming.getSettings();
  applyTheme(settings.theme);
  carNumber = String(new URLSearchParams(window.location.search).get('car') || settings.followedCar || '');
  document.title = `Driver overview - Car #${carNumber || '—'}`;
  window.liveTiming.onCollectorUpdate(render);
  window.liveTiming.onThemeUpdate?.(applyTheme);
  render(await window.liveTiming.getCollectorState());
}

init();
