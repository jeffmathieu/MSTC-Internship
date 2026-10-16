// One-page post-race debrief: result, stint timeline, driver comparison, lap
// chart, pit stops (with the engineer's notes) and a few auto-written
// takeaways. Drawn with the same SVG page helpers as the other reports, so it
// prints identically on every platform.
const lapAnalytics = require('../../shared/lapAnalytics');
const { buildDriverOverview } = require('../../shared/driverOverview');
const { wrapDocument, Page, graph, C, COLORS, PAGE_W, time, duration, deltaDuration, finite } = require('./canonicalReportHtml');

const MODE_LABELS = { race: 'RACE', practice: 'PRACTICE', qualifying: 'QUALIFYING' };
const clip = (value, length) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

const { notesForStop } = require('../../shared/pitNotes');

function buildDebriefModel({ payload, history = [], stints = [], pitNotes = {} }) {
  const summary = payload.raceSummary || {};
  const carNumber = String(payload.race?.carNumber || '');
  const totalTimeByDriver = {};
  stints.forEach((stint) => { totalTimeByDriver[stint.driverName] = stint.totalDriverTimeMs; });
  const overview = buildDriverOverview({ laps: history, stintCar: { stints, totalTimeByDriver }, carNumber });
  const laps = lapAnalytics.lapsForCar(history, carNumber);
  const paceLaps = laps.filter((lap) => lapAnalytics.lapPaceEligible(lap) && finite(Number(lap.lapTimeMs)));
  const fastest = overview.totals.fastestLap;
  const fastestLap = fastest ? paceLaps.find((lap) => Number(lap.lapTimeMs) === fastest.ms && lap.driverName === fastest.driverName) : null;
  const pitStops = (summary.pitStops || []).map((stop) => ({ ...stop, notes: stop.notes || notesForStop(stop, pitNotes) }));
  const analysis = summary.pitAnalysis || {};
  const control = summary.raceControl || {};
  const consistent = overview.drivers.filter((d) => d.paceLapCount >= 5 && finite(d.consistencyMs))
    .sort((a, b) => a.consistencyMs - b.consistencyMs)[0] || null;
  const first = laps[0] || {}, last = laps.at(-1) || {};
  const tyreSets = [...new Set(pitStops.map((stop) => stop.notes?.tyreSet).filter(Boolean))];
  const noted = pitStops.filter((stop) => stop.notes);

  const takeaways = [
    fastest && `Fastest lap ${time(fastest.ms)} by ${fastest.driverName}${fastestLap ? ` (lap ${fastestLap.displayLapNumber ?? fastestLap.lapNumber ?? '-'})` : ''}`,
    overview.totals.fastestAverage && `Best average pace: ${overview.totals.fastestAverage.driverName} (${time(overview.totals.fastestAverage.ms)})`,
    consistent && `Most consistent: ${consistent.driverName} (σ ${(consistent.consistencyMs / 1000).toFixed(3)}s over ${consistent.paceLapCount} laps)`,
    overview.totals.longestStint && `Longest stint: ${overview.totals.longestStint.driverName} ${duration(overview.totals.longestStint.drivingMs)} (stint ${overview.totals.longestStint.number})`,
    pitStops.length && `Pit stops: ${pitStops.length}${finite(analysis.averageDurationMs) ? `, average ${duration(analysis.averageDurationMs)}` : ''}${analysis.slowestStop ? `, slowest #${analysis.slowestStop.stopNumber ?? '-'} ${duration(analysis.slowestStop.durationMs)}` : ''}`,
    noted.length && `Tyres changed at ${noted.filter((stop) => stop.notes.tyresChanged).length}/${pitStops.length} stops${tyreSets.length ? `; sets: ${tyreSets.join(', ')}` : ''}`,
    (first.position && last.position) && `Overall position: P${first.position} on lap 1 → P${last.position} at the end`,
    `Race control: FCY ${control.fcy || 0} (${time(control.durationsMs?.fcy)}), SC ${control.safetyCar || 0}, red ${control.redFlag || 0}`
  ].filter(Boolean);

  return {
    payload,
    mode: payload.reportMode || 'race',
    overview,
    pitStops,
    takeaways,
    result: {
      classPosition: summary.finalClassPosition || last.classPosition || '-',
      overallPosition: last.position || '-',
      laps: summary.totalLaps || laps.length,
      drivingMs: overview.totals.drivingMs,
      fastest,
      pitStopCount: pitStops.length,
      averagePitMs: analysis.averageDurationMs
    }
  };
}

function timeline(page, model) {
  const { overview } = model;
  page.panel(28, 383, PAGE_W - 56, 62, 'Stint timeline (driving time)');
  const stints = overview.stints.filter((stint) => finite(stint.drivingMs) && stint.drivingMs > 0);
  if (!stints.length) { page.text(PAGE_W / 2, 408, 'No completed stints yet', 8, C.muted, false, 'middle'); return; }
  const total = stints.reduce((sum, stint) => sum + stint.drivingMs, 0);
  const width = PAGE_W - 56 - 24;
  let x = 40;
  stints.forEach((stint) => {
    const w = Math.max(3, stint.drivingMs / total * width - 1.5);
    const index = Math.max(0, overview.drivers.findIndex((d) => d.driverName === stint.driverName));
    page.rect(x, 394, w, 24, COLORS[index % COLORS.length], 2);
    if (w > 54) page.text(x + w / 2, 403, `${stint.driverName.split(' ').at(-1)} · ${duration(stint.drivingMs)}`, 6.5, '#FFFFFF', true, 'middle', w - 6);
    else if (w > 22) page.text(x + w / 2, 403, `S${stint.number}`, 6, '#FFFFFF', true, 'middle');
    x += w + 1.5;
  });
}

function driversPanel(page, model) {
  const { drivers } = model.overview;
  const x = 28, y = 207, h = 168, w = 442;
  page.panel(x, y, w, h, 'Drivers');
  const columns = [[40, 'Driver', 'start'], [215, 'Stints', 'end'], [262, 'Driving', 'end'], [297, 'Share', 'end'], [342, 'Laps', 'end'], [386, 'Best', 'end'], [433, 'σ', 'end']];
  columns.forEach(([cx, label, anchor]) => page.text(cx, y + h - 34, label, 6.6, C.muted, true, anchor));
  page.line(38, y + h - 38, x + w - 10, y + h - 38);
  if (!drivers.length) { page.text(x + w / 2, y + h / 2, 'No driver data yet', 8, C.muted, false, 'middle'); return; }
  drivers.slice(0, 6).forEach((driver, index) => {
    const ry = y + h - 55 - index * 21;
    page.rect(38, ry - 3, 4, 12, COLORS[index % COLORS.length]);
    const cells = [driver.driverName, driver.stintCount, duration(driver.drivingMs), finite(driver.sharePct) ? `${driver.sharePct.toFixed(0)}%` : '-',
      `${driver.paceLapCount}/${driver.lapCount}`, time(driver.bestLapMs), finite(driver.consistencyMs) ? (driver.consistencyMs / 1000).toFixed(2) : '-'];
    columns.forEach(([cx, , anchor], i) => page.text(i === 0 ? cx + 9 : cx, ry, cells[i], 7.4, driver.isFastestLap && i === 5 ? C.green : C.ink, i === 0 || (driver.isFastestLap && i === 5), anchor, i === 0 ? 150 : null));
    page.text(cx0(columns), ry - 9, `avg ${time(driver.averageLapMs)}${finite(driver.deltaAverageMs) && driver.deltaAverageMs > 0 ? `  (${(driver.deltaAverageMs / 1000).toFixed(3)}s slower than best)` : driver.isFastestAverage ? '  (best average)' : ''}`, 5.6, C.muted);
  });
  if (drivers.length > 6) page.text(x + w - 10, y + 8, `+${drivers.length - 6} more drivers`, 6, C.muted, false, 'end');
}
const cx0 = (columns) => columns[0][0] + 9;

function pitPanel(page, model) {
  const x = 28, y = 30, h = 169, w = 442;
  page.panel(x, y, w, h, 'Pit stops and notes');
  const stops = model.pitStops;
  if (!stops.length) { page.text(x + w / 2, y + h / 2, 'No pit stops recorded', 8, C.muted, false, 'middle'); return; }
  const columns = [[40, 'Stop'], [72, 'Lap'], [104, 'Driver change'], [250, 'Time'], [292, 'Fuel'], [326, 'Tyres'], [364, 'Set']];
  columns.forEach(([cx, label]) => page.text(cx, y + h - 34, label, 6.6, C.muted, true));
  page.line(38, y + h - 38, x + w - 10, y + h - 38);
  let ry = y + h - 51, shown = 0;
  for (const stop of stops) {
    const notes = stop.notes;
    const rowHeight = notes?.driverNotes || notes?.pitNotes ? 24 : 13;
    if (ry - rowHeight < y + 8) break;
    const yes = (value) => (value === true ? 'yes' : value === false ? 'no' : '-');
    const cells = [`#${stop.stopNumber ?? '-'}`, stop.lapNumber ?? '-', `${clip(stop.driverBefore || '-', 18)} → ${clip(stop.driverAfter || '-', 18)}`,
      duration(stop.durationMs), yes(notes?.fuelAdded), yes(notes?.tyresChanged), clip(notes?.tyreSet || '-', 14)];
    columns.forEach(([cx], i) => page.text(cx, ry, cells[i], 7, i === 3 && finite(stop.deltaVsTargetMs) ? (stop.deltaVsTargetMs > 0 ? C.red : C.green) : C.ink, i === 3, 'start', i === 2 ? 140 : i === 6 ? 60 : null));
    if (rowHeight > 13) {
      const remark = [notes.driverNotes && `Driver: ${clip(notes.driverNotes, 78)}`, notes.pitNotes && `Pit: ${clip(notes.pitNotes, 78)}`].filter(Boolean).join('   ');
      page.text(40, ry - 10, remark, 5.8, C.muted, false, 'start', w - 60);
    }
    ry -= rowHeight; shown += 1;
  }
  if (shown < stops.length) page.text(x + w - 10, y + 8, `+${stops.length - shown} more stops (see the pit stop analysis in the overview)`, 6, C.muted, false, 'end');
}

function takeawayPanel(page, model) {
  const x = 478, y = 30, h = 169, w = PAGE_W - 28 - 478;
  page.panel(x, y, w, h, 'Key takeaways');
  model.takeaways.slice(0, 8).forEach((line, index) => {
    page.circle(x + 14, y + h - 40 - index * 17 + 2.5, 1.8, C.blue);
    page.text(x + 22, y + h - 40 - index * 17, line, 7, C.ink, false, 'start', w - 34);
  });
}

function buildDebriefPage(model) {
  const { payload, result } = model;
  const page = new Page(payload, `${MODE_LABELS[model.mode] || 'SESSION'} DEBRIEF`, payload.race?.circuit || '');
  page.cards([
    ['Final position', `P${result.overallPosition} · PIC ${result.classPosition}`],
    ['Completed laps', result.laps],
    ['Driving time', duration(result.drivingMs)],
    ['Fastest lap', result.fastest ? time(result.fastest.ms) : '-'],
    ['Pit stops', `${result.pitStopCount}${finite(result.averagePitMs) ? ` · avg ${duration(result.averagePitMs)}` : ''}`],
    ['Drivers', model.overview.totals.driverCount]
  ]);
  timeline(page, model);
  driversPanel(page, model);
  graph(page, 478, 207, PAGE_W - 28 - 478, 168, { ...(payload.raceSummary?.graphs?.driverLaps || {}), title: 'Green-flag lap times by driver', subtitle: '' });
  pitPanel(page, model);
  takeawayPanel(page, model);
  page.footer(`Generated from stored timing data | ${model.mode} debrief`);
  return page;
}

function buildDebriefHtml(model) {
  return wrapDocument(model.payload, [buildDebriefPage(model)], `${model.mode} debrief`);
}

module.exports = { buildDebriefModel, buildDebriefHtml, notesForStop };
