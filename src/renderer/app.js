// Short DOM lookup helper used throughout the renderer. All IDs referenced here
// must exist in index.html, including the hidden settings inputs.
const $ = (id) => document.getElementById(id);

// currentSettings mirrors the persisted settings from the main process.
// currentState mirrors collectorState from src/main/main.js.
let currentSettings = null;
let currentState = null;
let currentAnalysis = null;

// Shared norm-time prediction module loaded from src/shared/normPrediction.js.
// Tests use the same module through require(), so prediction behavior is covered
// without needing to launch the Electron renderer.
const normPrediction = window.normPrediction;
const lapAnalytics = window.lapAnalytics;
const classBattle = window.classBattle;

// UI warning thresholds. Prediction math lives in normPrediction.js; these
// margins only decide how the dashboard colors the warning panel.
const normWarningConfig = {
  warningMarginMs: 1000,
  criticalMarginMs: 500
};

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

// Renderer-side copy of timing formatting for graphs and warning text. Keep it
// behaviorally aligned with src/shared/parser.js when changing time formats.
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

function formatSeconds(ms) { return Number.isFinite(ms) ? `${(ms / 1000).toFixed(3)}s` : '—'; }

// Numeric helpers used by graph summaries and driver/stint tables.
function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function stddev(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length < 2) return null;
  const avg = average(usable);
  return Math.sqrt(average(usable.map((value) => (value - avg) ** 2)));
}

// Parses lap/gap strings in the renderer so UI calculations do not need another
// round trip to the main process. Keep supported formats aligned with parser.js.
function parseLapTimeToMs(text) {
  const raw = String(text || '').trim().replace(',', '.');
  if (!raw || /^(—|-|--|\?|in pit|out lap)$/i.test(raw)) return null;
  const parts = raw.split(':');
  let seconds = null;
  if (parts.length === 1) {
    const n = Number(parts[0]);
    if (Number.isFinite(n)) seconds = n;
  } else if (parts.length === 2) {
    const m = Number(parts[0]), s = Number(parts[1]);
    if (Number.isFinite(m) && Number.isFinite(s)) seconds = m * 60 + s;
  } else if (parts.length === 3) {
    const first = Number(parts[0]), middle = Number(parts[1]), last = parts[2];
    if (Number.isFinite(first) && Number.isFinite(middle)) {
      if (!last.includes('.') && first < 10 && middle < 60) {
        const milli = Number(String(last).padEnd(3, '0').slice(0, 3));
        if (Number.isFinite(milli)) seconds = first * 60 + middle + milli / 1000;
      } else {
        const sec = Number(last);
        if (Number.isFinite(sec)) seconds = first * 3600 + middle * 60 + sec;
      }
    }
  }
  return seconds === null ? null : Math.round(seconds * 1000);
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

// Converts prediction/current-lap context and the configured norm time into the
// warning level used by the panel CSS classes.
function normStatus(row, history, referenceMs) {
  if (!row || !Number.isFinite(referenceMs)) {
    return { level: 'unknown', title: 'No reference warning yet', predictionText: 'Waiting for car/reference', detail: 'Set the reference time and wait until our car is detected.' };
  }

  const readiness = normPrediction.predictionReadiness(row, history);
  const prediction = normPrediction.predictCurrentLap(row, history);
  if (prediction && Number.isFinite(prediction.predictedMs)) {
    const margin = prediction.predictedMs - referenceMs;
    const modelText = `${prediction.profile.source}, ${prediction.profile.sampleSize} lap sample`;
    const predictionText = `After ${prediction.stage}: ${formatMs(prediction.predictedMs)}`;
    if (margin < 0) {
      return {
        level: 'bad',
        title: 'PREDICTED TOO FAST',
        predictionText,
        detail: `After ${prediction.stage}, predicted lap is ${formatMs(prediction.predictedMs)} (${formatSeconds(Math.abs(margin))} below norm ${formatMs(referenceMs)}). Model: ${modelText}.`
      };
    }
    if (margin <= normWarningConfig.criticalMarginMs) {
      return {
        level: 'critical',
        title: 'Critical: predicted close to norm',
        predictionText,
        detail: `After ${prediction.stage}, predicted lap is ${formatMs(prediction.predictedMs)} (${formatSeconds(margin)} above norm ${formatMs(referenceMs)}). Model: ${modelText}.`
      };
    }
    if (margin <= normWarningConfig.warningMarginMs) {
      return {
        level: 'warning',
        title: 'Warning: predicted near norm',
        predictionText,
        detail: `After ${prediction.stage}, predicted lap is ${formatMs(prediction.predictedMs)} (${formatSeconds(margin)} above norm ${formatMs(referenceMs)}). Model: ${modelText}.`
      };
    }
    return {
      level: 'safe',
      title: 'Predicted safe margin',
      predictionText,
      detail: `After ${prediction.stage}, predicted lap is ${formatMs(prediction.predictedMs)} (${formatSeconds(margin)} above norm ${formatMs(referenceMs)}). Model: ${modelText}.`
    };
  }

  let predictionText = 'Waiting for S1';
  let predictionDetail = 'Prediction starts after S1/S2 sector data is available.';
  if (readiness.reason === 'not-enough-history') {
    predictionText = `Need 2 sector laps (${readiness.driverLapCount} driver / ${readiness.carLapCount} car)`;
    predictionDetail = 'Prediction needs two completed laps with valid S1, S2 and S3 values. If this is a restarted demo with old stored laps, emptying the data folder is a good test.';
  } else if (readiness.reason === 'waiting-for-s1') {
    predictionText = 'Waiting for S1 from timing page';
    predictionDetail = `Prediction model is ready (${readiness.profile.source}, ${readiness.profile.sampleSize} lap sample), but the current live row does not contain a parsed S1 yet.`;
  }

  if (!Number.isFinite(row.lastLapMs)) {
    return {
      level: 'unknown',
      title: 'Waiting for sector prediction',
      predictionText,
      detail: predictionDetail
    };
  }

  const margin = row.lastLapMs - referenceMs;
  if (margin < 0) return { level: 'bad', title: 'LAST LAP TOO FAST', predictionText, detail: `Last completed lap was ${formatMs(row.lastLapMs)} (${formatSeconds(Math.abs(margin))} below norm ${formatMs(referenceMs)}). ${predictionDetail}` };
  if (margin <= normWarningConfig.criticalMarginMs) return { level: 'critical', title: 'Critical: last lap close to norm', predictionText, detail: `Last completed lap was ${formatMs(row.lastLapMs)} (${formatSeconds(margin)} above norm ${formatMs(referenceMs)}). ${predictionDetail}` };
  if (margin <= normWarningConfig.warningMarginMs) return { level: 'warning', title: 'Warning: last lap near norm', predictionText, detail: `Last completed lap was ${formatMs(row.lastLapMs)} (${formatSeconds(margin)} above norm ${formatMs(referenceMs)}). ${predictionDetail}` };
  return { level: 'safe', title: 'Safe margin to norm time', predictionText, detail: `Last completed lap was ${formatMs(row.lastLapMs)} (${formatSeconds(margin)} above norm ${formatMs(referenceMs)}). ${predictionDetail}` };
}

// Updates the norm-time warning panel for the followed car.
function renderWarning(rows, history) {
  const wanted = String($('followed-car').value || '').trim();
  const followed = rows.find((row) => String(row.carNumber) === wanted);
  const referenceMs = parseLapTimeToMs($('reference-time').value);
  const info = normStatus(followed, history || [], referenceMs);
  const panel = $('warning-panel');
  panel.className = `panel warning-panel ${info.level}`;
  $('warning-title').textContent = info.title;
  $('warning-prediction').textContent = info.predictionText || 'Waiting for S1';
  $('warning-detail').textContent = info.detail;
}

// Wraps inline SVG chart bodies. Graphs are generated directly in the renderer
// so they can update without external chart dependencies.
function svgBase(width, height, body) {
  return `<svg viewBox="0 0 ${width} ${height}" role="img">${body}</svg>`;
}

// Draws one or more lap-time series. To add tooltips or axes, extend this
// helper so all line graphs inherit the behavior.
function drawLineGraph(container, series, opts = {}) {
  container.innerHTML = '';
  const width = Math.max(760, container.clientWidth || 900);
  const height = Math.max(420, container.clientHeight || 420);
  const padL = 72, padR = 28, padT = 42, padB = 54;

  // Normalize graph points so every series has plot coordinates and lap labels.
  const normalizedSeries = (series || []).map((s) => ({
    ...s,
    points: (s.points || [])
      .filter((p) => Number.isFinite(p.y))
      .map((p, index) => ({ ...p, xPlot: Number.isFinite(p.xPlot) ? p.xPlot : index + 1, lapLabel: p.lapLabel ?? p.x }))
  })).filter((s) => s.points.length);
  const allPoints = normalizedSeries.flatMap((s) => s.points);
  if (!allPoints.length) { container.innerHTML = '<span class="muted">No stored laps yet for this graph.</span>'; return; }

  const minX = Math.min(...allPoints.map((p) => p.xPlot));
  const maxX = Math.max(...allPoints.map((p) => p.xPlot));
  const minYReal = Math.min(...allPoints.map((p) => p.y));
  const maxYReal = Math.max(...allPoints.map((p) => p.y));
  const marginY = Math.max(250, (maxYReal - minYReal) * 0.18);
  const minY = minYReal - marginY;
  const maxY = maxYReal + marginY;
  const xScale = (x) => minX === maxX ? width / 2 : padL + ((x - minX) / (maxX - minX)) * (width - padL - padR);
  const yScale = (y) => maxY === minY ? height / 2 : height - padB - ((y - minY) / (maxY - minY)) * (height - padT - padB);
  const palette = ['c1','c2','c3','c4','c5','c6'];

  // Simple five-line Y grid. Increase this array if denser charts are needed.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const yValue = minY + (maxY - minY) * fraction;
    const y = yScale(yValue);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" class="grid-line" />
      <text x="${padL - 10}" y="${(y + 4).toFixed(1)}" class="chart-label" text-anchor="end">${formatMs(yValue)}</text>`;
  }).join('');

  const lines = normalizedSeries.map((s, i) => {
    const cls = palette[i % palette.length];
    const points = s.points.map((p) => `${xScale(p.xPlot).toFixed(1)},${yScale(p.y).toFixed(1)}`).join(' ');
    const circles = s.points.map((p) => `<circle class="${cls}" cx="${xScale(p.xPlot).toFixed(1)}" cy="${yScale(p.y).toFixed(1)}" r="3.8"><title>${s.label} · lap ${p.lapLabel}: ${formatMs(p.y)}</title></circle>`).join('');
    return s.points.length > 1 ? `<polyline class="graph-line ${cls}" points="${points}" />${circles}` : circles;
  }).join('');

  const xLabels = allPoints.length === 1
    ? `<text x="${xScale(allPoints[0].xPlot)}" y="${height - 18}" class="chart-label" text-anchor="middle">Lap ${allPoints[0].lapLabel}</text>`
    : [minX, Math.round((minX + maxX) / 2), maxX].filter((v, i, a) => a.indexOf(v) === i).map((x) => {
        const closest = allPoints.reduce((best, p) => Math.abs(p.xPlot - x) < Math.abs(best.xPlot - x) ? p : best, allPoints[0]);
        return `<text x="${xScale(x)}" y="${height - 18}" class="chart-label" text-anchor="middle">Lap ${closest.lapLabel}</text>`;
      }).join('');

  const legend = normalizedSeries.slice(0, 8).map((s, i) => `<span><i class="legend-dot ${palette[i % palette.length]}"></i>${s.label}</span>`).join('');
  container.innerHTML = `<div class="legend">${legend}</div>` + svgBase(width, height, `
    ${yTicks}
    <line x1="${padL}" y1="${height - padB}" x2="${width - padR}" y2="${height - padB}" class="axis" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${height - padB}" class="axis" />
    ${opts.referenceMs ? `<line x1="${padL}" y1="${yScale(opts.referenceMs).toFixed(1)}" x2="${width - padR}" y2="${yScale(opts.referenceMs).toFixed(1)}" class="reference-line" />` : ''}
    ${lines}${xLabels}
    <text x="${padL}" y="25" class="chart-label">Fastest ${formatMs(minYReal)} · slowest ${formatMs(maxYReal)}</text>
  `);
}

// Draws grouped sector bars, currently used for driver sector comparisons.
function drawBarGraph(container, groups, title) {
  container.innerHTML = '';
  const width = Math.max(760, container.clientWidth || 900), height = Math.max(420, container.clientHeight || 420), pad = 58;
  const values = groups.flatMap((g) => g.values).filter((v) => Number.isFinite(v.value));
  if (!values.length) { container.innerHTML = '<span class="muted">Not enough sector data yet.</span>'; return; }
  const max = Math.max(...values.map((v) => v.value)) * 1.12;
  const barArea = width - pad * 2;
  const groupWidth = barArea / groups.length;
  const colors = ['c1','c2','c3'];
  const bars = groups.map((group, gi) => group.values.map((v, vi) => {
    const bw = Math.min(46, groupWidth / 4);
    const x = pad + gi * groupWidth + 10 + vi * (bw + 6);
    const h = (v.value / max) * (height - pad * 2);
    const y = height - pad - h;
    return `<rect class="bar ${colors[vi % colors.length]}" x="${x}" y="${y}" width="${bw}" height="${h}"><title>${group.label} ${v.label}: ${formatMs(v.value)}</title></rect>`;
  }).join('') + `<text x="${pad + gi * groupWidth + groupWidth/2}" y="${height-14}" class="chart-label" text-anchor="middle">${group.label.slice(0,16)}</text>`).join('');
  container.innerHTML = `<div class="legend"><span>${title}</span><span><i class="legend-dot c1"></i>S1</span><span><i class="legend-dot c2"></i>S2</span><span><i class="legend-dot c3"></i>S3</span></div>` + svgBase(width, height, `
    <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="axis" />
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="axis" />${bars}
  `);
}

// Registry for switchable graph views. Add new graph types by appending an
// object with id, label, description, and render(container, state).
const graphRegistry = [
  {
    id: 'lapTimeByDriver',
    label: 'Our lap time over race',
    description: 'Followed-car lap time by completed lap. Points are colored by driver/stint. The dashed line is the configurable norm time.',
    render(container, state) {
      const car = $('followed-car').value.trim();
      const laps = lapsForCar(state.lapHistory || [], car);
      const byDriver = new Map();
      laps.forEach((lap, index) => { const d = lap.driver || 'Unknown driver'; if (!byDriver.has(d)) byDriver.set(d, []); byDriver.get(d).push({ xPlot: index + 1, x: lapSortNumber(lap) ?? index + 1, lapLabel: lapDisplayLabel(lap, index), y: lap.lastLapMs }); });
      const referenceMs = parseLapTimeToMs($('reference-time').value);
      drawLineGraph(container, [...byDriver.entries()].map(([label, points]) => ({ label, points })), { referenceMs });
    }
  },
  {
    id: 'classComparison',
    label: 'Same-class lap comparison',
    description: 'Recent average lap time for our car and same-class competitors. Useful for seeing if we are gaining or losing pace.',
    render(container, state) {
      const rows = state.rows || [];
      const followed = rows.find((row) => String(row.carNumber) === String($('followed-car').value.trim()));
      if (!followed) { container.innerHTML = '<span class="muted">Followed car not detected yet.</span>'; return; }
      const sameClass = rows.filter((row) => row.className === followed.className).slice(0, 10);
      const series = sameClass.map((row) => ({
        label: `#${row.carNumber} ${row.team || ''}`.trim(),
        points: lapsForCar(state.lapHistory || [], row.carNumber).slice(-25).map((lap, index) => ({ xPlot: index + 1, x: lapSortNumber(lap) ?? index + 1, lapLabel: lapDisplayLabel(lap, index), y: lap.lastLapMs }))
      })).filter((s) => s.points.length >= 2);
      drawLineGraph(container, series);
    }
  },
  {
    id: 'sectorByDriver',
    label: 'Driver sector comparison',
    description: 'Average sector times for each detected driver in our car. This is built as a separate graph renderer so new graph types can be added later.',
    render(container, state) {
      const car = $('followed-car').value.trim();
      const laps = lapsForCar(state.lapHistory || [], car);
      const grouped = new Map();
      laps.forEach((lap) => { const d = lap.driver || 'Unknown'; if (!grouped.has(d)) grouped.set(d, []); grouped.get(d).push(lap); });
      const groups = [...grouped.entries()].map(([driver, entries]) => ({
        label: driver,
        values: [
          { label: 'S1', value: average(entries.map((e) => e.sector1Ms)) },
          { label: 'S2', value: average(entries.map((e) => e.sector2Ms)) },
          { label: 'S3', value: average(entries.map((e) => e.sector3Ms)) }
        ]
      }));
      drawBarGraph(container, groups, 'Average sector by driver');
    }
  }
];

// Populates the graph selector from graphRegistry so the HTML stays generic.
function setupGraphRegistry() {
  const select = $('graph-select');
  select.innerHTML = '';
  graphRegistry.forEach((graph) => {
    const option = document.createElement('option');
    option.value = graph.id;
    option.textContent = graph.label;
    select.appendChild(option);
  });
  select.onchange = () => renderGraph(currentState || { lapHistory: [], rows: [] });
}

// Selects and renders the active graph. Falls back to the first registry item
// so the dashboard remains usable if a saved/old graph id disappears.
function renderGraph(state) {
  const graph = graphRegistry.find((g) => g.id === $('graph-select').value) || graphRegistry[0];
  $('graph-title').textContent = graph.label;
  $('graph-meta').textContent = graph.description;
  graph.render($('main-graph'), state || { rows: [], lapHistory: [] });
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
  currentAnalysis = lapAnalytics.buildDashboardAnalysis(history, {
    ourCarNumber: $('followed-car').value.trim()
  });
  // Kept as a debug/extension hook for the future UI that will display driver
  // and class deltas without recalculating them in the DOM layer.
  window.currentLapAnalysis = currentAnalysis;
  setStatus(currentState.status, currentState.message);
  updateSession(currentState.session || {});
  $('row-count').textContent = String(rows.length);
  $('history-count').textContent = String(history.length);
  $('last-update').textContent = currentState.lastSuccessAt ? new Date(currentState.lastSuccessAt).toLocaleTimeString() : '—';
  renderFollowed(rows);
  renderClassTable(rows, history);
  renderWarning(rows, history);
  renderGraph(currentState);
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
    pollIntervalMs: Number($('poll-interval').value || 3000),
    referenceTime: $('reference-time').value.trim()
  };
  if (setupComplete) patch.setupComplete = true;
  currentSettings = await window.liveTiming.setSettings(patch);
  return currentSettings;
}

// Copies hidden dashboard settings into the visible setup modal.
function syncSetupFromMain() {
  $('setup-url').value = $('timing-url').value;
  $('setup-car').value = $('followed-car').value;
  $('setup-reference').value = $('reference-time').value;
  $('setup-folder').value = $('storage-folder').value;
}

// Copies visible setup modal values back into the hidden dashboard inputs used
// by the rest of app.js.
function syncMainFromSetup() {
  $('timing-url').value = $('setup-url').value;
  $('followed-car').value = $('setup-car').value;
  $('reference-time').value = $('setup-reference').value;
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
  $('reference-time').value = currentSettings.referenceTime || '1:42.000';
  syncSetupFromMain();
  setupGraphRegistry();
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
  ['timing-url','followed-car','poll-interval','reference-time'].forEach((id) => $(id)?.addEventListener('change', async () => { await saveSettingsFromInputs(); render(currentState); }));
  window.liveTiming.onCollectorUpdate(render);
  render(await window.liveTiming.getCollectorState());
  if (!currentSettings.setupComplete || !currentSettings.storageFolder) showSetup(true);
}
init();
