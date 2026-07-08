const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lapAnalytics = require('../shared/lapAnalytics');
const { buildStintInsights, classComparisonsForStint, classRankingForStint } = require('../shared/stintInsights');

const REPORT_LAYOUT_VERSION = 'canonical-reportlab-landscape-v4-conditions';

function safeFilePart(value, fallback = 'Unknown') {
  const safe = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function formatMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  let remaining = Math.max(0, Math.round(numeric));
  const hours = Math.floor(remaining / 3600000); remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000); remaining %= 60000;
  const seconds = Math.floor(remaining / 1000);
  const millis = remaining % 1000;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lapStatus(lap, representativeLaps) {
  if (lap.lapPhase === 'inlap') return 'pit-in';
  if (lap.lapPhase === 'outlap') return 'pit-out';
  if (!lapAnalytics.lapPaceEligible(lap)) return 'neutralized';
  if (!representativeLaps.has(lap)) return 'outlier';
  return 'valid';
}

function sectorStatus(lap, sectorNumber) {
  if (lap.lapPhase === 'inlap') return 'pit-in';
  if (lap.lapPhase === 'outlap') return 'pit-out';
  return lapAnalytics.sectorPaceEligible(lap, sectorNumber) ? 'valid' : 'neutralized';
}

function gapSamplesForStint(samples = [], stint = {}) {
  const start = new Date(stint.startedAt || 0).getTime();
  const end = new Date(stint.closedAt || '9999-12-31T23:59:59.999Z').getTime();
  return (samples || [])
    .filter((sample) => String(sample.followedCarNumber) === String(stint.carNumber))
    .filter((sample) => sample.suppressed !== true)
    .filter((sample) => {
      const timestamp = new Date(sample.confirmedAt || 0).getTime();
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
    })
    .sort((a, b) => new Date(a.confirmedAt) - new Date(b.confirmedAt))
    .map((sample) => ({
      rivalCarNumber: String(sample.rivalCarNumber || ''),
      relation: sample.relation || '',
      confirmedAt: sample.confirmedAt || '',
      gapMs: Number.isFinite(Number(sample.gapMs)) ? Number(sample.gapMs) : null,
      lapGap: Number.isFinite(Number(sample.lapGap)) ? Number(sample.lapGap) : null,
      estimated: Boolean(sample.estimated),
      source: sample.source || ''
    }));
}

function buildStintReportPayload(stint, session = {}, gapSamples = []) {
  const representativeLaps = new Set(lapAnalytics.representativePaceLaps(stint.laps || []));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    session: {
      sessionName: session.sessionName || session.pageTitle || '',
      carNumber: String(stint.carNumber || ''),
      driverName: stint.driverName || '',
      className: stint.laps?.find((lap) => lap.className)?.className || '',
      teamName: stint.laps?.find((lap) => lap.teamName)?.teamName || ''
    },
    stint: {
      stintNumber: stint.stintNumber,
      driverStintNumber: stint.driverStintNumber,
      detectionSource: stint.detectionSource,
      startLap: stint.startLap,
      endLap: stint.endLap,
      startedAt: stint.startedAt,
      closedAt: stint.closedAt,
      stintTimeMs: stint.stintTimeMs,
      totalDriverTimeMs: stint.totalDriverTimeMs,
      lapCount: stint.lapCount,
      stats: stint.stats,
      laps: (stint.laps || []).map((lap) => ({
        lapNumber: lap.lapNumber,
        lapTimeMs: lap.lapTimeMs,
        sector1Ms: lap.sector1Ms,
        sector2Ms: lap.sector2Ms,
        sector3Ms: lap.sector3Ms,
        lapPhase: lap.lapPhase || '',
        flag: lap.sessionFlag || lap.lapFlag || '',
        lapCondition: lap.lapCondition || lap.trackCondition || 'unknown',
        sector1Condition: lap.sector1Condition || lap.lapCondition || lap.trackCondition || 'unknown',
        sector2Condition: lap.sector2Condition || lap.lapCondition || lap.trackCondition || 'unknown',
        sector3Condition: lap.sector3Condition || lap.lapCondition || lap.trackCondition || 'unknown',
        status: lapStatus(lap, representativeLaps),
        sector1Status: sectorStatus(lap, 1),
        sector2Status: sectorStatus(lap, 2),
        sector3Status: sectorStatus(lap, 3)
      }))
    },
    gapHistory: gapSamplesForStint(gapSamples, stint)
  };
}

function compactStats(stats) {
  if (!stats) return {};
  const { laps, ...compact } = stats;
  return compact;
}

function sumLapTimes(laps = []) {
  return laps.reduce((total, lap) => total + (Number(lap.lapTimeMs) || 0), 0);
}

function flagCategory(value) {
  const flag = String(value || '');
  if (/full course|\bfcy\b/i.test(flag)) return 'fcy';
  if (/safety/i.test(flag)) return 'safetyCar';
  if (/red/i.test(flag)) return 'redFlag';
  return 'green';
}

// Rows from all cars can share a collection timestamp. Collapsing each poll
// before counting transitions avoids reporting one FCY period per timing row.
function raceControlSummary(history = []) {
  const timeline = new Map();
  history.forEach((row) => {
    if (row.collectedAt && !timeline.has(row.collectedAt)) {
      timeline.set(row.collectedAt, flagCategory(row.sessionFlag || row.lapFlag));
    }
  });
  const counts = { fcy: 0, safetyCar: 0, redFlag: 0 };
  let previous = null;
  [...timeline.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([, category]) => {
    if (category !== previous && category !== 'green') counts[category] += 1;
    previous = category;
  });
  return counts;
}

function durationMs(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2})$/);
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null;
}

// PIT is cumulative and L. PIT is the provider-measured duration of the last
// stop. A counter increase therefore identifies one unique completed pitstop.
function pitStopsFromHistory(history = [], carNumber = '') {
  const laps = lapAnalytics.lapsForCar(history, carNumber);
  const byLap = new Map(laps.map((lap) => [Number(lap.lapNumber), lap]));
  const stops = [];
  let previousCount = 0;
  laps.forEach((lap) => {
    const count = Number.parseInt(String(lap.pitInfo || lap.pit || ''), 10);
    if (!Number.isFinite(count) || count <= previousCount) return;
    const lapNumber = Number(lap.lapNumber);
    const before = byLap.get(lapNumber - 1);
    stops.push({
      stopNumber: count,
      lapNumber,
      durationMs: durationMs(lap.lastPit),
      rawDuration: lap.lastPit || '',
      driverBefore: before?.driverName || '',
      driverAfter: lap.driverName || ''
    });
    previousCount = count;
  });
  return stops;
}

function canonicalStint(stint, session, gapSamples, driverStats, history, referenceTimes) {
  const legacy = buildStintReportPayload(stint, session, gapSamples);
  const stats = legacy.stint.stats || {};
  const firstLap = legacy.stint.laps[0];
  const lastLap = legacy.stint.laps.at(-1);
  const teammates = driverStats
    .filter((driver) => driver.driverName !== legacy.session.driverName)
    .map((driver) => ({
      driverName: driver.driverName,
      averageLapMs: driver.averageLapMs,
      bestLapMs: driver.bestLapMs,
      averageDeltaMs: Number.isFinite(stats.averageLapMs) && Number.isFinite(driver.averageLapMs)
        ? stats.averageLapMs - driver.averageLapMs
        : null,
      bestDeltaMs: Number.isFinite(stats.bestLapMs) && Number.isFinite(driver.bestLapMs)
        ? stats.bestLapMs - driver.bestLapMs
        : null
    }));
  const classComparisons = classComparisonsForStint(history, stint.laps || [], stint.carNumber, legacy.session.className);
  const insights = buildStintInsights(stint.laps || [], referenceTimes);
  insights.classRanking = classRankingForStint(stint.laps || [], classComparisons);
  return {
    stintNumber: legacy.stint.stintNumber,
    driverStintNumber: legacy.stint.driverStintNumber,
    driverName: legacy.session.driverName,
    startLap: legacy.stint.startLap ?? firstLap?.lapNumber ?? null,
    endLap: legacy.stint.endLap ?? lastLap?.lapNumber ?? null,
    stintTimeMs: legacy.stint.stintTimeMs,
    totalDriverTimeMs: legacy.stint.totalDriverTimeMs,
    stats: compactStats(stats),
    statsByCondition: Object.fromEntries(Object.entries(lapAnalytics.statsByCondition(stint.laps || []))
      .map(([condition, conditionStats]) => [condition, compactStats(conditionStats)])),
    driverRaceStats: driverStats.find((driver) => driver.driverName === legacy.session.driverName) || null,
    teammates,
    classComparisons,
    insights,
    laps: legacy.stint.laps,
    gapHistory: legacy.gapHistory
  };
}

// Adapts live stint objects to the exact payload consumed by the polished
// ReportLab renderer used by the post-race script. This is the single contract
// that keeps manual and automatic PDFs visually and statistically identical.
function buildCanonicalReportPayload({ stints = [], session = {}, gapSamples = [], history = [], carNumber = '', referenceTimes = {} }) {
  const followedCar = String(carNumber || stints[0]?.carNumber || '');
  const carLaps = lapAnalytics.lapsForCar(history, followedCar);
  const fallbackLaps = stints.flatMap((stint) => stint.laps || []);
  const raceLaps = carLaps.length ? carLaps : fallbackLaps;
  const firstLap = raceLaps[0] || stints[0]?.laps?.[0] || {};
  const rawDriverStats = carLaps.length
    ? lapAnalytics.driverStats(history, followedCar)
    : [...new Set(fallbackLaps.map((lap) => lap.driverName).filter(Boolean))].map((driverName) => ({
      driverName,
      ...lapAnalytics.statsForLaps(fallbackLaps.filter((lap) => lap.driverName === driverName))
    }));
  const driverStats = rawDriverStats.map(compactStats);
  const pitStops = pitStopsFromHistory(history, followedCar);
  const legacy = stints[0] ? buildStintReportPayload(stints[0], session, gapSamples) : null;
  return {
    schemaVersion: 2,
    reportLayoutVersion: REPORT_LAYOUT_VERSION,
    generatedAt: new Date().toISOString(),
    race: {
      sessionName: session.sessionName || session.pageTitle || 'Race session',
      carNumber: followedCar,
      teamName: firstLap.teamName || '',
      className: firstLap.className || '',
      circuit: session.circuit || session.trackName || ''
    },
    referenceTimes: {
      lapMs: Number(referenceTimes.lapMs) || 0,
      sector1Ms: Number(referenceTimes.sector1Ms) || 0,
      sector2Ms: Number(referenceTimes.sector2Ms) || 0,
      sector3Ms: Number(referenceTimes.sector3Ms) || 0
    },
    raceSummary: {
      stats: compactStats(lapAnalytics.statsForLaps(raceLaps)),
      statsByCondition: Object.fromEntries(Object.entries(lapAnalytics.statsByCondition(raceLaps))
        .map(([condition, conditionStats]) => [condition, compactStats(conditionStats)])),
      recordedRaceTimeMs: sumLapTimes(raceLaps),
      totalLaps: raceLaps.length,
      finalClassPosition: raceLaps.at(-1)?.classPosition || '',
      drivers: driverStats,
      pitStops,
      totalPitTimeMs: pitStops.length && pitStops.every((stop) => Number.isFinite(stop.durationMs))
        ? pitStops.reduce((total, stop) => total + stop.durationMs, 0)
        : null,
      raceControl: raceControlSummary(history)
    },
    caveats: [],
    stints: stints.map((stint) => canonicalStint(stint, session, gapSamples, driverStats, history, referenceTimes)),
    // Keep the first automatic-report schema available to existing readers.
    session: legacy?.session || null,
    stint: legacy?.stint || null,
    gapHistory: legacy?.gapHistory || []
  };
}

function signedGapMs(sample) {
  if (!Number.isFinite(sample?.gapMs)) return null;
  return sample.relation === 'ahead' ? -sample.gapMs : sample.gapMs;
}

function buildLineChart(title, points, options = {}) {
  const usable = (points || []).filter((point) => Number.isFinite(point.value));
  if (!usable.length) return `<section class="chart"><h2>${htmlEscape(title)}</h2><p>No reliable samples for this stint.</p></section>`;
  const width = 760;
  const height = 180;
  const left = 62;
  const right = 18;
  const top = 25;
  const bottom = 28;
  const values = usable.map((point) => point.value);
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  if (minimum === maximum) { minimum -= 1000; maximum += 1000; }
  const spread = maximum - minimum;
  minimum -= spread * 0.08;
  maximum += spread * 0.08;
  const xFor = (index) => left + (usable.length === 1 ? (width - left - right) / 2 : index * (width - left - right) / (usable.length - 1));
  const yFor = (value) => top + (maximum - value) * (height - top - bottom) / (maximum - minimum);
  const coordinates = usable.map((point, index) => `${xFor(index).toFixed(1)},${yFor(point.value).toFixed(1)}`).join(' ');
  const circles = usable.map((point, index) => `<circle cx="${xFor(index).toFixed(1)}" cy="${yFor(point.value).toFixed(1)}" r="3"><title>${htmlEscape(point.tooltip || point.label || '')}</title></circle>`).join('');
  const formatValue = options.formatValue || formatMs;
  return `<section class="chart"><h2>${htmlEscape(title)}</h2><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${htmlEscape(title)}">
    <line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" class="axis" />
    <line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" class="axis" />
    <line x1="${left}" y1="${top}" x2="${width - right}" y2="${top}" class="grid" />
    <text x="4" y="${top + 4}">${htmlEscape(formatValue(maximum))}</text>
    <text x="4" y="${height - bottom + 4}">${htmlEscape(formatValue(minimum))}</text>
    <text x="${left}" y="${height - 7}">${htmlEscape(usable[0].label || '')}</text>
    <text x="${width - right}" y="${height - 7}" text-anchor="end">${htmlEscape(usable.at(-1).label || '')}</text>
    <polyline points="${coordinates}" style="stroke:${htmlEscape(options.color || '#2476c7')}" />${circles}
  </svg></section>`;
}

function buildStintReportHtml(payload) {
  const { session, stint } = payload;
  const stats = stint.stats || {};
  const validLaps = (stint.laps || []).filter((lap) => lap.status === 'valid');
  const lapChart = buildLineChart('Lap times', validLaps.map((lap) => ({ label: `Lap ${lap.lapNumber}`, value: lap.lapTimeMs, tooltip: formatMs(lap.lapTimeMs) })));
  const sectorCharts = [1, 2, 3].map((sectorNumber) => buildLineChart(
    `Sector ${sectorNumber}`,
    (stint.laps || []).filter((lap) => lap[`sector${sectorNumber}Status`] === 'valid')
      .map((lap) => ({ label: `Lap ${lap.lapNumber}`, value: lap[`sector${sectorNumber}Ms`], tooltip: formatMs(lap[`sector${sectorNumber}Ms`]) })),
    { color: ['#1e9f67', '#dda321', '#7b61b7'][sectorNumber - 1] }
  )).join('');
  const gapChart = buildLineChart(
    'Confirmed class gap (ahead − / behind +)',
    (payload.gapHistory || []).map((sample, index) => ({
      label: `S${index + 1}`,
      value: signedGapMs(sample),
      tooltip: `#${sample.rivalCarNumber} ${sample.relation} ${formatMs(sample.gapMs)}`
    })),
    { color: '#d94c62', formatValue: (value) => `${value >= 0 ? '+' : '-'}${(Math.abs(value) / 1000).toFixed(1)}s` }
  );
  const rows = (stint.laps || []).map((lap) => `
    <tr class="${htmlEscape(lap.status)}">
      <td>${htmlEscape(lap.lapNumber ?? '—')}</td>
      <td>${htmlEscape(formatMs(lap.lapTimeMs))}</td>
      <td>${htmlEscape(formatMs(lap.sector1Ms))}</td>
      <td>${htmlEscape(formatMs(lap.sector2Ms))}</td>
      <td>${htmlEscape(formatMs(lap.sector3Ms))}</td>
      <td>${htmlEscape(lap.status)}</td>
    </tr>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1b201e; background: #f4f6f3; font: 12px Arial, sans-serif; }
  header { padding: 18px 20px; border: 2px solid #242a27; background: #fff; }
  h1 { margin: 3px 0 5px; font-size: 26px; }
  p { margin: 0; color: #626a66; }
  .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0; }
  .metric { min-height: 63px; padding: 10px; border: 2px solid #242a27; background: #fff; }
  .metric span { display: block; margin-bottom: 7px; color: #626a66; font-weight: bold; text-transform: uppercase; }
  .metric strong { font-size: 19px; }
  .chart { margin: 10px 0; padding: 10px 12px; border: 2px solid #242a27; background: #fff; break-inside: avoid; }
  .chart h2 { margin: 0 0 4px; color: #626a66; font-size: 13px; text-transform: uppercase; }
  .chart svg { display: block; width: 100%; height: auto; }
  .chart .axis { stroke: #242a27; stroke-width: 1.5; }
  .chart .grid { stroke: #d3d8d4; stroke-width: 1; }
  .chart polyline { fill: none; stroke-width: 2.5; }
  .chart circle { fill: #2476c7; }
  .chart text { fill: #626a66; font-size: 10px; }
  .sector-charts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .sector-charts .chart { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { padding: 6px 7px; border: 1px solid #cfd5d1; text-align: right; }
  th:first-child, td:first-child, th:last-child, td:last-child { text-align: left; }
  th { background: #e9ece8; text-transform: uppercase; }
  tr.neutralized td { background: #faedc9; }
  tr.pit-in td, tr.pit-out td { background: #f8dde1; }
  tr.outlier td { color: #777; background: #ecefeb; }
  footer { margin-top: 8px; color: #626a66; font-size: 10px; }
</style></head><body>
  <header>
    <p>${htmlEscape(session.sessionName || 'Race session')} · car #${htmlEscape(session.carNumber)}</p>
    <h1>${htmlEscape(session.driverName)} · driver stint ${htmlEscape(stint.driverStintNumber)}</h1>
    <p>${htmlEscape(session.teamName)}${session.className ? ` · ${htmlEscape(session.className)}` : ''} · car stint ${htmlEscape(stint.stintNumber)} · laps ${htmlEscape(stint.startLap)}–${htmlEscape(stint.endLap)}</p>
  </header>
  <section class="metrics">
    <div class="metric"><span>Stint time</span><strong>${htmlEscape(formatMs(stint.stintTimeMs))}</strong></div>
    <div class="metric"><span>Average lap</span><strong>${htmlEscape(formatMs(stats.averageLapMs))}</strong></div>
    <div class="metric"><span>Best lap</span><strong>${htmlEscape(formatMs(stats.bestLapMs))}</strong></div>
    <div class="metric"><span>Average S1</span><strong>${htmlEscape(formatMs(stats.averageSector1Ms))}</strong></div>
    <div class="metric"><span>Average S2</span><strong>${htmlEscape(formatMs(stats.averageSector2Ms))}</strong></div>
    <div class="metric"><span>Average S3</span><strong>${htmlEscape(formatMs(stats.averageSector3Ms))}</strong></div>
  </section>
  ${lapChart}
  <div class="sector-charts">${sectorCharts}</div>
  ${gapChart}
  <table><thead><tr><th>Lap</th><th>Lap time</th><th>S1</th><th>S2</th><th>S3</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
  <footer>Generated automatically when the next driver stint was confirmed. Yellow laps are neutralized; red laps are pit affected.</footer>
</body></html>`;
}

function artifactPaths(sessionFolder, stint) {
  const reportBaseName = `STINT_${stint.driverStintNumber}_${safeFilePart(stint.driverName)}`;
  const folder = path.join(
    sessionFolder,
    'stints',
    `car-${safeFilePart(stint.carNumber, 'unknown')}`,
    reportBaseName
  );
  return {
    folder,
    jsonPath: path.join(folder, `${reportBaseName}.json`),
    pdfPath: path.join(folder, `${reportBaseName}.pdf`)
  };
}

function findPdfPython() {
  const candidates = [
    process.env.PDF_PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
    'python3',
    'python'
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const check = spawnSync(candidate, ['-c', 'import reportlab'], { stdio: 'ignore' });
    if (!check.error && check.status === 0) return candidate;
  }
  return null;
}

function reportRendererPath() {
  const sourcePath = path.join(__dirname, 'reports', 'render-stint-report.py');
  // electron-builder places explicitly unpacked files beside app.asar. Python
  // cannot open a script inside the archive, so packaged builds use that copy.
  return sourcePath.includes(`${path.sep}app.asar${path.sep}`)
    ? sourcePath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    : sourcePath;
}

function renderReportLabPdf(payloadPath, pdfPath, options = {}) {
  const python = options.python || findPdfPython();
  if (!python) return { rendered: false, reason: 'reportlab-unavailable' };
  const renderer = options.renderer || reportRendererPath();
  const args = [
    renderer,
    '--input', payloadPath,
    '--output', path.dirname(pdfPath),
    '--single-output', pdfPath
  ];
  if (options.includeSummary) args.push('--include-summary');
  const result = spawnSync(python, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0 || !fs.existsSync(pdfPath)) {
    return {
      rendered: false,
      reason: 'reportlab-failed',
      error: result.error?.message || result.stderr || `renderer exited with status ${result.status}`
    };
  }
  return { rendered: true, engine: 'reportlab' };
}

async function printHtmlToPdf(BrowserWindow, html, pdfPath) {
  const reportWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await reportWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 }
    });
    fs.writeFileSync(pdfPath, pdf);
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
}

async function writeClosedStintArtifacts({
  BrowserWindow,
  sessionFolder,
  stint,
  session = {},
  gapSamples = [],
  history = [],
  referenceTimes = {},
  renderPdf = renderReportLabPdf
}) {
  if (!stint?.closed) return { written: false, reason: 'stint-open' };
  const paths = artifactPaths(sessionFolder, stint);
  fs.mkdirSync(paths.folder, { recursive: true });
  let previousPayload = null;
  try {
    if (fs.existsSync(paths.jsonPath)) previousPayload = JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8'));
  } catch (_error) {
    previousPayload = null;
  }
  const payload = buildCanonicalReportPayload({
    stints: [stint],
    session,
    gapSamples,
    history,
    referenceTimes,
    carNumber: stint.carNumber
  });
  fs.writeFileSync(paths.jsonPath, JSON.stringify(payload, null, 2));
  const needsPdf = !fs.existsSync(paths.pdfPath)
    || previousPayload?.reportLayoutVersion !== REPORT_LAYOUT_VERSION;
  if (needsPdf) {
    const result = await renderPdf(paths.jsonPath, paths.pdfPath, { includeSummary: false });
    if (!result?.rendered) {
      // Keep report generation functional on installations without ReportLab.
      // The JSON records why the canonical renderer was unavailable, while the
      // Electron fallback still gives the engineer a readable report.
      payload.renderFallbackReason = result?.reason || 'unknown-renderer-error';
      fs.writeFileSync(paths.jsonPath, JSON.stringify(payload, null, 2));
      await printHtmlToPdf(BrowserWindow, buildStintReportHtml({
        session: payload.session,
        stint: payload.stint,
        gapHistory: payload.gapHistory
      }), paths.pdfPath);
      return { ...paths, written: true, pdfCreated: true, engine: 'electron-fallback' };
    }
    return { ...paths, written: true, pdfCreated: true, engine: result.engine || 'reportlab' };
  }
  return { ...paths, written: true, pdfCreated: false };
}

function buildEventSummaryHtml(title, payloads = []) {
  const sections = payloads.map(({ session, stint }) => `
    <section>
      <h2>${htmlEscape(session.driverName)} · driver stint ${htmlEscape(stint.driverStintNumber)} <small>car stint ${htmlEscape(stint.stintNumber)}</small></h2>
      <p>Laps ${htmlEscape(stint.startLap)}–${htmlEscape(stint.endLap)} · ${htmlEscape(formatMs(stint.stintTimeMs))}</p>
      <div class="metrics">
        <div><span>Average</span><strong>${htmlEscape(formatMs(stint.stats?.averageLapMs))}</strong></div>
        <div><span>Best</span><strong>${htmlEscape(formatMs(stint.stats?.bestLapMs))}</strong></div>
        <div><span>Valid laps</span><strong>${htmlEscape(stint.stats?.paceLapCount ?? 0)} / ${htmlEscape(stint.lapCount)}</strong></div>
      </div>
    </section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1b201e; background: #f4f6f3; font: 12px Arial, sans-serif; }
    header, section { margin-bottom: 10px; padding: 14px 16px; border: 2px solid #242a27; background: #fff; break-inside: avoid; }
    h1 { margin: 0; font-size: 26px; } h2 { margin: 0 0 4px; font-size: 18px; }
    h2 small { color: #626a66; font-size: 11px; } p { margin: 0; color: #626a66; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
    .metrics div { padding: 8px; background: #e9ece8; } .metrics span { display: block; color: #626a66; font-weight: bold; text-transform: uppercase; }
    .metrics strong { display: block; margin-top: 4px; font-size: 17px; }
  </style></head><body><header><h1>${htmlEscape(title)}</h1><p>${payloads.length} completed stint${payloads.length === 1 ? '' : 's'}</p></header>${sections}</body></html>`;
}

async function writeEventSummaryArtifacts({
  BrowserWindow,
  sessionFolder,
  carNumber,
  stints = [],
  session = {},
  gapSamples = [],
  history = [],
  referenceTimes = {},
  renderPdf = renderReportLabPdf
}) {
  const closed = stints.filter((stint) => stint.closed);
  if (!closed.length) return [];
  const carFolder = path.join(sessionFolder, 'stints', `car-${safeFilePart(carNumber, 'unknown')}`);
  fs.mkdirSync(carFolder, { recursive: true });
  const groups = [
    { baseName: 'RACE_SUMMARY', title: `${session.sessionName || 'Race'} · car #${carNumber}`, stints: closed, includeSummary: true }
  ];
  const byDriver = new Map();
  closed.forEach((stint) => {
    const key = stint.driverName || 'Unknown';
    if (!byDriver.has(key)) byDriver.set(key, []);
    byDriver.get(key).push(stint);
  });
  byDriver.forEach((driverStints, driverName) => groups.push({
    baseName: `DRIVER_${safeFilePart(driverName)}_SUMMARY`,
    title: `${driverName} · car #${carNumber}`,
    stints: driverStints
  }));

  const results = [];
  for (const group of groups) {
    const payloads = group.stints.map((stint) => buildStintReportPayload(stint, session, gapSamples));
    const payload = buildCanonicalReportPayload({
      stints: group.stints,
      session,
      gapSamples,
      history,
      referenceTimes,
      carNumber
    });
    payload.title = group.title;
    payload.legacyPayloads = payloads;
    const jsonPath = path.join(carFolder, `${group.baseName}.json`);
    const pdfPath = path.join(carFolder, `${group.baseName}.pdf`);
    let previousPayload = null;
    try {
      if (fs.existsSync(jsonPath)) previousPayload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (_error) {
      previousPayload = null;
    }
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    if (!fs.existsSync(pdfPath) || previousPayload?.reportLayoutVersion !== REPORT_LAYOUT_VERSION) {
      const result = await renderPdf(jsonPath, pdfPath, { includeSummary: Boolean(group.includeSummary) });
      if (!result?.rendered) {
        payload.renderFallbackReason = result?.reason || 'unknown-renderer-error';
        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
        await printHtmlToPdf(BrowserWindow, buildEventSummaryHtml(group.title, payloads), pdfPath);
      }
    }
    results.push({ jsonPath, pdfPath });
  }
  return results;
}

module.exports = {
  safeFilePart,
  formatMs,
  htmlEscape,
  lapStatus,
  sectorStatus,
  compactStats,
  raceControlSummary,
  pitStopsFromHistory,
  gapSamplesForStint,
  signedGapMs,
  buildLineChart,
  buildStintReportPayload,
  buildCanonicalReportPayload,
  buildStintReportHtml,
  artifactPaths,
  findPdfPython,
  reportRendererPath,
  renderReportLabPdf,
  printHtmlToPdf,
  writeClosedStintArtifacts,
  buildEventSummaryHtml,
  writeEventSummaryArtifacts
};
