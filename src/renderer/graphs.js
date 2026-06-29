// Renderer for the detachable graphs window. Dataset calculations live in
// shared/graphData.js; this file only draws those prepared datasets on canvas.
const graphApi = window.graphData;
const GRAPH_COLORS = ['#315fc7', '#d94c62', '#1e9f67', '#e2a11a', '#7a56b3', '#168a91', '#9c4f2c', '#525b66'];
const DEFAULT_GRAPHS = ['driver-laps', 'driver-pace', 'driver-sectors', 'class-pace'];

let currentState = {};
let followedCarNumber = '';
let resizeTimer = null;

function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const rounded = Math.max(0, Math.round(ms));
  const minutes = Math.floor(rounded / 60000);
  const seconds = Math.floor((rounded % 60000) / 1000);
  const millis = rounded % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function finiteValues(values) {
  return values.filter(Number.isFinite);
}

function chartHasData(chart) {
  if (chart.type === 'bar') return chart.series.some((series) => series.values.some(Number.isFinite));
  return chart.series.some((series) => series.points.some((point) => Number.isFinite(point.y)));
}

function colorForSeries(series, index) {
  if (series.highlight) return '#171717';
  return GRAPH_COLORS[index % GRAPH_COLORS.length];
}

function setCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function drawAxes(context, bounds, yMin, yMax, yFormat) {
  const { left, top, right, bottom } = bounds;
  context.font = '700 10px system-ui';
  context.textBaseline = 'middle';
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const ratio = index / 4;
    const y = bottom - ratio * (bottom - top);
    const value = yMin + ratio * (yMax - yMin);
    context.strokeStyle = index === 0 ? '#777771' : '#e1e1dc';
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.fillStyle = '#686864';
    context.textAlign = 'right';
    context.fillText(yFormat === 'time' ? formatTime(value) : String(Math.round(value)), left - 7, y);
  }
}

function paddedRange(values) {
  const usable = finiteValues(values);
  if (!usable.length) return { min: 0, max: 1 };
  const rawMin = Math.min(...usable);
  const rawMax = Math.max(...usable);
  const spread = rawMax - rawMin;
  const padding = spread > 0 ? spread * 0.12 : Math.max(500, rawMax * 0.01);
  return { min: Math.max(0, rawMin - padding), max: rawMax + padding };
}

function drawLineChart(context, width, height, chart) {
  const bounds = { left: 72, top: 10, right: Math.max(90, width - 12), bottom: Math.max(40, height - 30) };
  const allPoints = chart.series.flatMap((series) => series.points.map((point) => ({ ...point, series })));
  const scalePoints = allPoints.filter((point) => point.eligible !== false);
  const yRange = paddedRange((scalePoints.length ? scalePoints : allPoints).map((point) => point.y));
  const xValues = finiteValues(allPoints.map((point) => point.x));
  let xMin = xValues.length ? Math.min(...xValues) : 0;
  let xMax = xValues.length ? Math.max(...xValues) : 1;
  if (xMin === xMax) { xMin -= 1; xMax += 1; }
  drawAxes(context, bounds, yRange.min, yRange.max, chart.yFormat);
  const xAt = (value) => bounds.left + ((value - xMin) / (xMax - xMin)) * (bounds.right - bounds.left);
  const yAt = (value) => bounds.bottom - ((value - yRange.min) / (yRange.max - yRange.min)) * (bounds.bottom - bounds.top);
  const hitPoints = [];

  chart.series.forEach((series, seriesIndex) => {
    const color = colorForSeries(series, seriesIndex);
    const valid = series.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    context.strokeStyle = color;
    context.lineWidth = series.highlight ? 3 : 2;
    context.beginPath();
    let drawing = false;
    valid.forEach((point) => {
      if (point.eligible === false) { drawing = false; return; }
      const x = xAt(point.x);
      const y = Math.max(bounds.top, Math.min(bounds.bottom, yAt(point.y)));
      if (!drawing) context.moveTo(x, y); else context.lineTo(x, y);
      drawing = true;
    });
    context.stroke();

    valid.forEach((point) => {
      const x = xAt(point.x);
      const y = Math.max(bounds.top, Math.min(bounds.bottom, yAt(point.y)));
      const neutralized = point.eligible === false;
      context.fillStyle = neutralized ? '#9a9a94' : color;
      context.beginPath();
      context.arc(x, y, series.highlight ? 4 : 3, 0, Math.PI * 2);
      context.fill();
      hitPoints.push({ x, y, text: `${series.name} · ${point.label || `Lap ${point.x}`} · ${formatTime(point.y)}${neutralized ? ' · FCY/SC' : ''}` });
    });
  });

  context.fillStyle = '#686864';
  context.font = '700 10px system-ui';
  context.textBaseline = 'top';
  context.textAlign = 'left';
  context.fillText(`Lap ${Math.round(xMin)}`, bounds.left, bounds.bottom + 8);
  context.textAlign = 'right';
  context.fillText(`Lap ${Math.round(xMax)}`, bounds.right, bounds.bottom + 8);
  return hitPoints;
}

function drawBarChart(context, width, height, chart) {
  const bounds = { left: 72, top: 10, right: Math.max(90, width - 12), bottom: Math.max(48, height - 44) };
  const values = chart.series.flatMap((series) => series.values);
  const yRange = paddedRange(values);
  drawAxes(context, bounds, yRange.min, yRange.max, chart.yFormat);
  const yAt = (value) => bounds.bottom - ((value - yRange.min) / (yRange.max - yRange.min)) * (bounds.bottom - bounds.top);
  const categoryWidth = (bounds.right - bounds.left) / Math.max(1, chart.categories.length);
  const groupWidth = categoryWidth * 0.78;
  const barWidth = Math.max(2, groupWidth / Math.max(1, chart.series.length));
  const hitPoints = [];

  chart.categories.forEach((category, categoryIndex) => {
    const groupStart = bounds.left + categoryIndex * categoryWidth + (categoryWidth - groupWidth) / 2;
    chart.series.forEach((series, seriesIndex) => {
      const value = series.values[categoryIndex];
      if (!Number.isFinite(value)) return;
      const x = groupStart + seriesIndex * barWidth;
      const y = Math.max(bounds.top, Math.min(bounds.bottom, yAt(value)));
      context.globalAlpha = series.muted ? 0.45 : 1;
      context.fillStyle = GRAPH_COLORS[seriesIndex % GRAPH_COLORS.length];
      context.fillRect(x + 1, y, Math.max(2, barWidth - 2), bounds.bottom - y);
      context.globalAlpha = 1;
      hitPoints.push({ x: x + barWidth / 2, y, radius: Math.max(7, barWidth / 2), text: `${category} · ${series.name} · ${formatTime(value)}` });
    });
    context.fillStyle = '#686864';
    context.font = '700 9px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    const shortLabel = category.length > 14 ? `${category.slice(0, 12)}…` : category;
    context.fillText(shortLabel, bounds.left + (categoryIndex + 0.5) * categoryWidth, bounds.bottom + 8);
  });
  return hitPoints;
}

function renderLegend(panel, chart) {
  const legend = panel.querySelector('.chart-legend');
  legend.innerHTML = '';
  chart.series.forEach((series, index) => {
    const item = document.createElement('span');
    item.className = `legend-item${series.highlight ? ' highlight' : ''}`;
    const swatch = document.createElement('i');
    swatch.className = 'legend-swatch';
    swatch.style.setProperty('--swatch', colorForSeries(series, index));
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(series.name));
    legend.appendChild(item);
  });
  if (chart.series.some((series) => series.points?.some((point) => point.eligible === false))) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = '<i class="legend-swatch" style="--swatch:#9a9a94"></i>FCY / SC';
    legend.appendChild(item);
  }
}

function wireTooltip(panel, canvas, hitPoints) {
  const tooltip = panel.querySelector('.chart-tooltip');
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const nearest = hitPoints
      .map((point) => ({ point, distance: Math.hypot(point.x - x, point.y - y) }))
      .sort((a, b) => a.distance - b.distance)[0];
    const allowedDistance = nearest?.point?.radius || 12;
    if (!nearest || nearest.distance > allowedDistance) {
      tooltip.style.display = 'none';
      return;
    }
    tooltip.textContent = nearest.point.text;
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.min(rect.width - 230, Math.max(4, x + 10))}px`;
    tooltip.style.top = `${Math.max(4, y - 34)}px`;
  };
  canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
}

function renderPanel(panel) {
  const type = panel.querySelector('select').value;
  const chart = graphApi.buildGraph(type, currentState.lapHistory || [], followedCarNumber);
  panel.querySelector('h1').textContent = chart.title;
  panel.querySelector('p').textContent = chart.subtitle;
  const canvas = panel.querySelector('canvas');
  const empty = panel.querySelector('.chart-empty');
  const { context, width, height } = setCanvasSize(canvas);
  context.clearRect(0, 0, width, height);
  const hasData = chartHasData(chart);
  empty.style.display = hasData ? 'none' : 'grid';
  renderLegend(panel, chart);
  if (!hasData) {
    wireTooltip(panel, canvas, []);
    return;
  }
  const hitPoints = chart.type === 'bar'
    ? drawBarChart(context, width, height, chart)
    : drawLineChart(context, width, height, chart);
  wireTooltip(panel, canvas, hitPoints);
}

function renderGraphs(state) {
  currentState = state || {};
  document.getElementById('graphs-session').textContent = currentState.session?.sessionName || currentState.session?.pageTitle || 'Waiting for session data';
  document.getElementById('graphs-car').textContent = followedCarNumber || '—';
  document.getElementById('graphs-lap-count').textContent = String((currentState.lapHistory || []).length);
  document.getElementById('graphs-updated').textContent = currentState.lastSuccessAt ? new Date(currentState.lastSuccessAt).toLocaleTimeString() : '—';
  document.querySelectorAll('.chart-panel').forEach(renderPanel);
}

async function initGraphs() {
  const settings = await window.liveTiming.getSettings();
  followedCarNumber = String(settings.followedCar || '');
  document.querySelectorAll('.chart-panel').forEach((panel, index) => {
    const select = panel.querySelector('select');
    graphApi.GRAPH_OPTIONS.forEach((option) => {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    });
    select.value = DEFAULT_GRAPHS[index];
    select.addEventListener('change', () => renderPanel(panel));
  });
  window.liveTiming.onCollectorUpdate(renderGraphs);
  renderGraphs(await window.liveTiming.getCollectorState());
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderGraphs(currentState), 80);
  });
}

initGraphs();
