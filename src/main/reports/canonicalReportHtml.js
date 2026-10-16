// Portable version of render-stint-report.py's landscape report. Each SVG is
// one complete A4 page, so the packaged Electron renderer preserves the same
// panels, charts and pagination without depending on an installed Python.
const PAGE_W = 841.8897637795277;
const PAGE_H = 595.2755905511812;
const C = { navy: '#152238', ink: '#17201D', muted: '#68716D', paper: '#F5F6F2',
  grid: '#D8DDD7', blue: '#2474B5', green: '#1F9D70', yellow: '#E6AD2F', red: '#D94C5F',
  orange: '#D97730', gray: '#9AA19D', wet: '#2A9DB0' };
const COLORS = [C.blue, C.red, C.green, C.yellow, '#7651B5', C.wet, C.orange, C.gray];
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
function time(ms, decimals = 3) {
  if (!finite(ms)) return '-';
  const seconds = Math.round(Math.abs(ms) / 1000 * 10 ** decimals) / 10 ** decimals;
  const minutes = Math.floor(seconds / 60);
  return `${ms < 0 ? '-' : ''}${minutes}:${(seconds - minutes * 60).toFixed(decimals).padStart(3 + decimals, '0')}`;
}
function duration(ms) {
  if (!finite(ms)) return '-';
  const seconds = Math.round(Math.abs(ms) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${ms < 0 ? '-' : ''}${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
const delta = (ms) => finite(ms) ? `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(3)}s` : '-';
const deltaDuration = (ms) => finite(ms) ? `${ms >= 0 ? '+' : '-'}${duration(Math.abs(ms))}` : '-';
const sumTimes = (...values) => values.every(finite) ? values.reduce((sum, value) => sum + value, 0) : null;
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

class Page {
  constructor(payload, title, detail = '') {
    this.parts = [];
    this.rect(0, 0, PAGE_W, PAGE_H, C.paper);
    this.rect(0, PAGE_H - 58, PAGE_W, 58, C.navy);
    const race = payload.race || {};
    this.text(28, PAGE_H - 26, race.sessionName, 15, '#FFFFFF', true, 'start', 490);
    this.text(28, PAGE_H - 43, [race.circuit, `#${race.carNumber || ''} ${race.teamName || ''}`.trim(), race.className].filter(Boolean).join('  |  '), 8, '#FFFFFF', false, 'start', 490);
    this.text(PAGE_W - 28, PAGE_H - 27, title, 14, '#FFFFFF', true, 'end', 265);
    if (detail) this.text(PAGE_W - 28, PAGE_H - 43, detail, 8, '#FFFFFF', false, 'end', 320);
  }
  rect(x, y, width, height, fill, radius = 0, stroke = 'none') {
    this.parts.push(`<rect x="${x}" y="${PAGE_H - y - height}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`);
  }
  text(x, y, value, size = 7, color = C.ink, bold = false, anchor = 'start', maxWidth = null, rotation = null) {
    const label = String(value ?? '-');
    const fit = maxWidth && label.length * size * .55 > maxWidth ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : '';
    const transform = rotation === null ? '' : ` transform="rotate(${rotation} ${x} ${PAGE_H - y})"`;
    this.parts.push(`<text x="${x}" y="${PAGE_H - y}" font-size="${size}" fill="${color}" font-weight="${bold ? 700 : 400}" text-anchor="${anchor}"${fit}${transform}>${escape(label)}</text>`);
  }
  line(x1, y1, x2, y2, color = C.grid, width = .5, dash = '') {
    this.parts.push(`<line x1="${x1}" y1="${PAGE_H - y1}" x2="${x2}" y2="${PAGE_H - y2}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
  }
  circle(x, y, radius, fill, stroke = 'none') {
    this.parts.push(`<circle cx="${x}" cy="${PAGE_H - y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="0.75"/>`);
  }
  panel(x, y, width, height, title = '') {
    this.rect(x, y, width, height, '#FFFFFF', 5, C.grid);
    if (title) this.text(x + 10, y + height - 15, title.toUpperCase(), 7.5, C.muted, true);
  }
  metric(x, y, label, value, size = 12) {
    this.text(x, y + 14, label.toUpperCase(), 6.8, C.muted, true);
    this.text(x, y, value, size, C.ink, true);
  }
  cards(items) {
    const width = (PAGE_W - 72) / items.length;
    items.forEach(([label, value], index) => {
      const x = 28 + index * (width + 4);
      this.panel(x, 455, width, 57);
      this.text(x + 10, 494, label.toUpperCase(), 7, C.muted, true);
      this.text(x + 10, 469, value, 15, C.ink, true);
    });
  }
  footer(label) { this.text(PAGE_W - 28, 18, label, 6.5, C.muted, false, 'end'); }
  html() {
    return `<section class="report-page"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_W} ${PAGE_H}" role="img" font-family="Arial, Helvetica, sans-serif">${this.parts.join('')}</svg></section>`;
  }
}

function driverTable(page, drivers, y = 118, height = 170) {
  page.panel(28, y, PAGE_W - 56, height, 'Driver session comparison');
  const positions = [42, 328, 378, 433, 510, 583, 660, 737];
  ['Driver', 'Laps', 'Valid', 'Average', 'Best', 'Avg S1', 'Avg S2', 'Avg S3'].forEach((label, i) => page.text(positions[i], y + height - 34, label, 7, C.muted, true));
  drivers.forEach((driver, index) => {
    const values = [driver.driverName, driver.lapCount ?? 0, driver.paceLapCount ?? 0, time(driver.averageLapMs), time(driver.bestLapMs), time(driver.averageSector1Ms), time(driver.averageSector2Ms), time(driver.averageSector3Ms)];
    values.forEach((value, i) => page.text(positions[i], y + height - 60 - index * 22, value, 7.5, C.ink, false, 'start', i ? 70 : 265));
  });
}

function overview(payload) {
  const summary = payload.raceSummary || {}, stats = summary.stats || {};
  const page = new Page(payload, `FULL ${(payload.reportMode || 'race').toUpperCase()} OVERVIEW`);
  page.cards([['Recorded session time', duration(summary.recordedRaceTimeMs)], ['Completed laps', summary.totalLaps || 0],
    ['Valid pace laps', stats.paceLapCount || 0], ['Best lap', time(stats.bestLapMs)], ['Final PIC', summary.finalClassPosition || '-']]);
  page.panel(28, 300, 470, 140, 'Full-session pace statistics');
  const metrics = [['Average lap', time(stats.averageLapMs)], ['Average S1', time(stats.averageSector1Ms)], ['Average S2', time(stats.averageSector2Ms)],
    ['Average S3', time(stats.averageSector3Ms)], ['Best S1', time(stats.bestSector1Ms)], ['Best S2', time(stats.bestSector2Ms)],
    ['Best S3', time(stats.bestSector3Ms)], ['Ideal best', time(sumTimes(stats.bestSector1Ms, stats.bestSector2Ms, stats.bestSector3Ms))],
    ['Ideal avg', time(sumTimes(stats.averageSector1Ms, stats.averageSector2Ms, stats.averageSector3Ms))], ['Excluded', stats.selection?.lap?.excludedCount ?? 0]];
  metrics.forEach(([label, value], index) => page.metric(44 + index % 5 * 86, 372 - Math.floor(index / 5) * 48, label, value));
  const x = 506;
  page.panel(x, 300, PAGE_W - 534, 140, 'Condition pace breakdown');
  ['Mode', 'Laps', 'Average', 'Best'].forEach((label, i) => page.text(x + [18, 95, 142, 220][i], 406, label, 6.5, C.muted, true));
  const conditions = summary.statsByCondition || {};
  [['Combined', conditions.combined || stats], ['Dry', conditions.dry || {}], ['Wet', conditions.wet || {}], ['Intermediate', conditions.transition || {}]].forEach(([label, item], index) => {
    const values = [label, item.lapCount || 0, item.paceLapCount ? time(item.averageLapMs) : '-', item.paceLapCount ? time(item.bestLapMs) : '-'];
    values.forEach((value, i) => page.text(x + [18, 95, 142, 220][i], 386 - index * 20, value, 7, C.ink, label === 'Combined'));
  });
  driverTable(page, (summary.drivers || []).slice(0, 5));
  page.panel(28, 72, PAGE_W - 56, 34, 'Race control');
  const control = summary.raceControl || {};
  [['FCY', 'fcy', C.yellow], ['SC', 'safetyCar', C.yellow], ['Red', 'redFlag', C.red]].forEach(([label, key, color], index) => {
    const xx = 42 + index * 210;
    page.circle(xx, 86, 2.6, color);
    page.text(xx + 8, 84, label, 6.6, C.muted, true);
    page.text(xx + 35, 84, `${control[key] || 0} / ${time(control.durationsMs?.[key])}`, 8, C.ink, true);
  });
  page.footer(`Generated from stored timing data | ${payload.reportMode || 'race'} overview`);
  const pages = [page];
  chunks((summary.drivers || []).slice(5), 17).forEach((drivers) => {
    const continuation = new Page(payload, 'DRIVER COMPARISON');
    driverTable(continuation, drivers, 72, 450); pages.push(continuation);
  });
  return pages;
}

const rejoin = (stop) => [stop.classPositionAfter ? `PIC ${stop.classPositionAfter}` : '', stop.positionAfter ? `P${stop.positionAfter}` : ''].filter(Boolean).join(' / ');
function pitPages(payload) {
  const summary = payload.raceSummary || {}, analysis = summary.pitAnalysis || {};
  const groups = chunks(summary.pitStops || [], 20);
  return groups.map((stops, index) => {
    const page = new Page(payload, 'PITSTOP ANALYSIS', groups.length > 1 ? `page ${index + 1}/${groups.length}` : '');
    page.cards([['Stops', analysis.stopCount ?? summary.pitStops.length], ['Measured total', duration(summary.totalPitTimeMs)],
      ['Average stop', duration(analysis.averageDurationMs)], ['Avg vs target', deltaDuration(analysis.averageDeltaVsTargetMs)], ['Driver changes', analysis.driverChangeCount || 0]]);
    page.panel(28, 72, PAGE_W - 56, 355, 'Recorded pitstops and fuel');
    const positions = [42, 76, 116, 166, 206, 246, 291, 331, 378, 456, 574, 696];
    ['Stop', 'Lap', 'Duration', 'Fuel*', 'Pit*', 'Total*', 'Target', 'Delta', 'Rejoin', 'Driver before', 'Driver after', 'Change'].forEach((label, i) => page.text(positions[i], 389, label, 7, C.muted, true));
    page.line(40, 382, PAGE_W - 40, 382);
    stops.forEach((stop, row) => {
      const values = [`#${stop.stopNumber || '-'}`, `${stop.lapNumber || '-'}${stop.lapNumber && stop.lapNumberSource === 'observed-sequence' ? '~' : ''}`,
        `${duration(stop.durationMs)}${stop.durationSource === 'observed' ? '*' : ''}`, duration(stop.fuelDurationMs), duration(stop.pitDurationMs), duration(stop.totalDurationMs),
        duration(stop.targetDurationMs), deltaDuration(stop.deltaVsTargetMs), rejoin(stop) || '-', stop.driverBefore || '-', stop.driverAfter || '-', stop.driverChanged == null ? 'unknown' : stop.driverChanged ? 'yes' : 'no'];
      values.forEach((value, i) => page.text(positions[i], 364 - row * 15, value, 7,
        i === 7 && finite(stop.deltaVsTargetMs) ? stop.deltaVsTargetMs > 0 ? C.red : C.green : C.ink, false, 'start', i === 9 || i === 10 ? 110 : i === 8 ? 72 : null));
    });
    page.text(28, 56, '* Observed feed transitions; polling precision. Duration prefers provider L. PIT. Total = observed fuel + pit.', 6.5, C.muted);
    page.text(28, 46, '~ Recorded passage number, not official race lap. Unknown data is shown as a dash; absent fuel is 0:00 for fully observed stops.', 6.5, C.muted);
    page.text(28, 34, `Fastest stop #${analysis.fastestStop?.stopNumber || '-'} ${duration(analysis.fastestStop?.durationMs)}; slowest stop #${analysis.slowestStop?.stopNumber || '-'} ${duration(analysis.slowestStop?.durationMs)}. Delta is measured pit duration minus configured target pit time.`, 6.5, C.muted);
    page.footer(`Generated from stored race data | pitstops ${index + 1}/${groups.length}`);
    return page;
  });
}

function lapChart(page, x, y, width, height, title, laps, key, average, statusKey) {
  page.panel(x, y, width, height, title);
  const points = laps.filter((lap) => lap[statusKey] === 'valid' && finite(lap[key]));
  if (!points.length) { page.text(x + width / 2, y + height / 2, 'No valid values', 9, C.muted, false, 'middle'); return; }
  const values = points.map((lap) => lap[key]);
  const padding = Math.max(750, (Math.max(...values) - Math.min(...values)) * .12);
  const low = Math.min(...values) - padding, high = Math.max(...values) + padding;
  const px = (index) => x + 38 + (points.length === 1 ? .5 : index / (points.length - 1)) * (width - 52);
  const py = (value) => y + 24 + (value - low) / (high - low) * (height - 48);
  for (let index = 0; index < 7; index++) {
    const yy = y + 24 + (height - 48) * index / 6;
    page.line(x + 38, yy, x + width - 14, yy, index % 2 ? '#A3A3A3' : C.grid, .5, index % 2 ? '1.2 2.2' : '');
    page.text(x + 33, yy - 2, time(low + (high - low) * index / 6), index % 2 ? 5.6 : 6.5, C.muted, false, 'end');
  }
  points.forEach((lap, index) => {
    if (index) page.line(px(index - 1), py(points[index - 1][key]), px(index), py(lap[key]), C.blue, 1.1);
    page.circle(px(index), py(lap[key]), 1.5, C.blue);
    const condition = lap[key === 'lapTimeMs' ? 'lapCondition' : key.replace('Ms', 'Condition')];
    if (condition === 'wet' || condition === 'transition') page.circle(px(index), py(lap[key]), 2.6, 'none', condition === 'wet' ? C.wet : C.orange);
  });
  if (finite(average) && average >= low && average <= high) {
    page.line(x + 38, py(average), x + width - 14, py(average), C.green, .7, '3 2');
    page.text(x + width - 14, py(average) + 3, `avg ${time(average)}`, 6.5, C.green, true, 'end');
  }
  [['FAST', Math.min(...values), -10, C.green], ['SLOW', Math.max(...values), 5, C.red]].forEach(([label, value, offset, color]) => {
    const xx = Math.max(x + 60, Math.min(x + width - 42, px(values.indexOf(value))));
    page.text(xx, py(value) + offset, `${label} ${time(value)}`, 6, color, true, 'middle');
  });
  page.text(x + 38, y + 8, `Lap ${points[0].lapNumber || 1}`, 6.5, C.muted);
  page.text(x + width - 14, y + 8, `Lap ${points.at(-1).lapNumber || points.length}`, 6.5, C.muted, false, 'end');
}

function stintPage(payload, stint, index) {
  const detail = `Driver stint ${stint.driverStintNumber || stint.stintNumber}  |  Car stint ${stint.stintNumber}  |  ${stint.lapNumberSource === 'observed-sequence' ? 'observed laps' : 'laps'} ${stint.startLap || '-'}-${stint.endLap || '-'}`;
  const page = new Page(payload, stint.driverName, detail), stats = stint.stats || {}, laps = stint.laps || [];
  if (stint.endPitStop) {
    const stop = stint.endPitStop;
    page.text(PAGE_W - 28, PAGE_H - 54, `End pit #${stop.stopNumber || '-'}: ${duration(stop.durationMs)} | fuel ${duration(stop.fuelDurationMs)} | pit ${duration(stop.pitDurationMs)} (${deltaDuration(stop.deltaVsTargetMs)} vs target)${rejoin(stop) ? ` | rejoined ${rejoin(stop)}` : ''}`, 6.2, '#FFFFFF', false, 'end', 420);
  }
  lapChart(page, 28, 328, PAGE_W - 56, 190, 'Lap times', laps, 'lapTimeMs', stats.averageLapMs, 'status');
  const width = (PAGE_W - 72) / 3;
  for (let sector = 1; sector <= 3; sector++) lapChart(page, 28 + (sector - 1) * (width + 8), 184, width, 132, `Sector ${sector}`, laps, `sector${sector}Ms`, stats[`averageSector${sector}Ms`], `sector${sector}Status`);
  page.panel(28, 34, width, 138, 'Stint statistics');
  const metrics = [[stint.timerSource === 'net-driving-time' ? 'Driving time' : 'Stint time', `${stint.drivingTimeEstimated ? '~ ' : ''}${duration(stint.stintTimeMs)}`],
    ['Total driver', duration(stint.totalDriverTimeMs)], ['Average lap', time(stats.averageLapMs)], ['Best lap', time(stats.bestLapMs)],
    ['Valid laps', `${stats.paceLapCount || 0}/${stats.lapCount || 0}`], ['Ideal time', time(sumTimes(stats.bestSector1Ms, stats.bestSector2Ms, stats.bestSector3Ms))],
    ['Average S1', time(stats.averageSector1Ms)], ['Average S2', time(stats.averageSector2Ms)], ['Average S3', time(stats.averageSector3Ms)]];
  metrics.forEach(([label, value], i) => page.metric(40 + i % 3 * (width - 24) / 3, 129 - Math.floor(i / 3) * 34, label, value));
  const conditionPace = ['dry', 'wet'].filter((key) => stint.statsByCondition?.[key]?.paceLapCount)
    .map((key) => `${key === 'dry' ? 'Dry' : 'Wet'} ${time(stint.statsByCondition[key].averageLapMs)} (${stint.statsByCondition[key].paceLapCount})`).join(' | ');
  if (conditionPace) page.text(28 + width - 10, 157, conditionPace, 5.5, C.muted, false, 'end');
  comparisons(page, 36 + width, width, stint);
  insights(page, 44 + width * 2, width, stint.insights || {});
  page.circle(35, 19, 3, C.blue);
  page.text(41, 17, 'Valid samples only; rings:', 6.5, C.muted);
  page.circle(129, 19, 4, 'none', C.wet); page.text(138, 17, 'wet', 6.5, C.muted);
  page.circle(171, 19, 4, 'none', C.orange); page.text(180, 17, 'transition; excluded laps remain counted.', 6.5, C.muted);
  page.text(52 + width * 2, 23, '* Consistency = standard deviation of valid lap times;', 5.2, C.muted);
  page.text(52 + width * 2, 16, 'a lower value means more consistent pace.', 5.2, C.muted);
  // Keep the original report footer clear of the consistency note.
  page.text(28, 7, `Generated from stored ${payload.reportMode === 'race' ? 'race' : 'session'} data | page ${index}`, 5.5, C.muted);
  return page;
}

function comparisons(page, x, width, stint) {
  page.panel(x, 34, width, 138, 'Team and class comparison');
  const xx = [x + 10, x + width * .49, x + width * .69, x + width * .85];
  ['Target', 'Avg', 'Delta', 'Best D'].forEach((label, i) => page.text(xx[i], 141, label, 7, C.muted, true));
  let y = 128;
  const section = (title, rows, empty, label) => {
    page.text(x + 10, y, title, 5.8, C.muted, true); y -= 12;
    if (!rows.length) { page.text(x + 10, y, empty, 6, C.muted); y -= 13; }
    rows.forEach((row) => {
      page.text(xx[0], y, label(row), 6.2, C.ink, false, 'start', width * .45 - 10);
      page.text(xx[1], y, time(row.averageLapMs), 6.2);
      page.text(xx[2], y, delta(row.averageDeltaMs), 6.2, row.averageDeltaMs > 0 ? C.red : C.green);
      page.text(xx[3], y, delta(row.bestDeltaMs), 6.2, row.bestDeltaMs > 0 ? C.red : C.green); y -= 13;
    });
  };
  section('TEAM', (stint.teammates || []).slice(0, 2), 'No teammate comparison', (row) => row.driverName);
  section('CLASS DURING THIS STINT', (stint.classComparisons || []).slice(0, 4), 'No same-window class laps', (row) => `#${row.carNumber || '?'} ${row.teamName || ''}`);
}

function insights(page, x, width, data) {
  page.panel(x, 34, width, 138, 'Stint engineering insights');
  page.text(x + 10, 142, 'COACHING SUMMARY', 4.9, C.muted, true);
  (data.coachingSummary?.length ? data.coachingSummary : ['No coaching summary available.']).slice(0, 3)
    .forEach((line, i) => page.text(x + 10, 133 - i * 8, line, 5.6, C.ink, false, 'start', width - 20));
  const rank = (key) => {
    const item = data.classRanking?.[key];
    return item?.rank && item.total ? `${item.rank}/${item.total} | ${item.leaderCarNumber && item.leaderCarNumber !== 'our car' ? `${delta(item.deltaToLeaderMs)} vs #${item.leaderCarNumber}` : 'class benchmark'}` : '-';
  };
  const coefficient = data.consistency?.coefficientPercent;
  const sd = data.consistency?.standardDeviationMs;
  const gap = finite(sd) ? Math.abs(sd) < 60000 ? `${(Math.abs(sd) / 1000).toFixed(3)}s` : time(sd) : '-';
  const columns = [
    [['Consistency*', finite(coefficient) ? `${gap} | ${coefficient.toFixed(2)}%` : '-'], ['Pace trend', finite(data.paceTrendMsPerLap) ? `${delta(data.paceTrendMsPerLap)}/lap` : '-'],
      ['Best theoretical', time(data.bestTheoreticalLapMs)], ['Average theoretical', time(data.averageTheoreticalLapMs)]],
    [['Class average rank', rank('average')], ['Class best-lap rank', rank('best')], ['Stint phases F/M/L', ['firstMs', 'middleMs', 'finalMs'].map((key) => time(data.stintPhases?.[key])).join(' / ')],
      ['First 5 vs last 5', `${time(data.firstFiveMs)} / ${time(data.lastFiveMs)} | ${delta(data.firstVsLastFiveDeltaMs)}`]]
  ];
  columns.forEach((items, column) => items.forEach(([label, value], row) => {
    const xx = x + (column ? width * .51 : 10), yy = 103 - row * 18;
    page.text(xx, yy, label.toUpperCase(), 4.8, C.muted, true);
    page.text(xx, yy - 8, value, 6.1, C.ink, true, 'start', width * .47 - 10);
  }));
}

function graph(page, x, y, width, height, data = {}) {
  page.panel(x, y, width, height, data.title || 'Graph');
  page.text(x + 10, y + height - 27, data.subtitle || '', 5.5, C.muted, false, 'start', width - 20);
  const bars = data.type === 'bar', series = data.series || [], categories = data.categories || [];
  const points = series.flatMap((item) => (item.points || []).filter((point) => finite(point.x) && finite(point.y)));
  const values = bars ? series.flatMap((item) => item.values || []).filter(finite) : points.map((point) => point.y);
  if (!values.length || bars && !categories.length) { page.text(x + width / 2, y + height / 2, 'No valid samples available', 9, C.muted, true, 'middle'); return; }
  const lowValue = Math.min(...values), highValue = Math.max(...values);
  const padding = highValue > lowValue ? (highValue - lowValue) * .08 : Math.max(Math.abs(highValue) * .02, 1000);
  const low = lowValue - padding, high = highValue + padding;
  const plotX = x + 42, plotY = y + 39, plotW = width - 54, plotH = height - 80;
  const py = (value) => plotY + (value - low) / (high - low) * plotH;
  for (let i = 0; i < 5; i++) {
    const yy = plotY + plotH * i / 4;
    page.line(plotX, yy, plotX + plotW, yy);
    page.text(plotX - 5, yy - 2, time(low + (high - low) * i / 4), 5.5, C.muted, false, 'end');
  }
  if (bars) {
    const groupW = plotW / categories.length, barW = Math.min(18, groupW * .72 / Math.max(1, series.length));
    categories.forEach((category, i) => {
      const center = plotX + groupW * (i + .5), start = center - barW * series.length / 2;
      series.forEach((item, j) => {
        const value = item.values?.[i]; if (!finite(value)) return;
        const xx = start + j * barW, barH = Math.max(1, py(value) - plotY);
        page.rect(xx, plotY, Math.max(2, barW - 1), barH, COLORS[j % COLORS.length]);
        page.text(xx + barW / 2, plotY + barH + 3, time(value), 4.5, C.ink, true, 'start', null, -90);
      });
      page.text(center, plotY - 12, category, 5.2, C.ink, false, 'middle', groupW - 5);
    });
  } else {
    const minX = Math.min(...points.map((point) => point.x)), maxX = Math.max(...points.map((point) => point.x));
    const px = (value) => plotX + (value - minX) / Math.max(1, maxX - minX) * plotW;
    series.forEach((item, index) => {
      const usable = (item.points || []).filter((point) => finite(point.x) && finite(point.y));
      const color = COLORS[index % COLORS.length];
      usable.forEach((point, i) => {
        if (i) page.line(px(usable[i - 1].x), py(usable[i - 1].y), px(point.x), py(point.y), color, item.highlight ? 1.1 : .7);
        page.circle(px(point.x), py(point.y), item.highlight ? 1.25 : .8, color);
      });
    });
    page.text(plotX, plotY - 12, `${data.xLabel || 'Lap'} ${minX}`, 5.5, C.muted);
    page.text(plotX + plotW, plotY - 12, `${data.xLabel || 'Lap'} ${maxX}`, 5.5, C.muted, false, 'end');
  }
  let legendX = x + 10, legendY = y + 10;
  series.forEach((item, i) => {
    const label = String(item.name || '').slice(0, 32), itemW = Math.min(165, 18 + label.length * 3.2);
    if (legendX + itemW > x + width - 10) { legendX = x + 10; legendY += 9; }
    page.rect(legendX, legendY, 7, 2.5, COLORS[i % COLORS.length]);
    page.text(legendX + 10, legendY - 1, label, 5.2); legendX += itemW;
  });
}

function buildCanonicalReportHtml(payload, includeSummary = false) {
  const pages = [];
  if (includeSummary) pages.push(...overview(payload), ...pitPages(payload));
  (payload.stints || []).forEach((stint, index) => pages.push(stintPage(payload, stint, index + 1)));
  if (includeSummary) {
    const graphs = payload.raceSummary?.graphs || {};
    if (graphs.driverLaps || graphs.driverPace || graphs.driverSectors) {
      const page = new Page(payload, 'RACE ANALYSIS GRAPHS');
      graph(page, 24, 305, PAGE_W - 48, 220, graphs.driverLaps);
      const width = (PAGE_W - 56) / 2;
      graph(page, 24, 32, width, 258, graphs.driverPace);
      graph(page, 32 + width, 32, width, 258, graphs.driverSectors); pages.push(page);
    }
    const classPages = graphs.classPacePages?.length ? graphs.classPacePages : graphs.classPace ? [graphs.classPace] : [];
    classPages.forEach((data, index) => {
      const page = new Page(payload, classPages.length > 1 ? `CLASS LAP TIMES ${index + 1}/${classPages.length}` : 'CLASS LAP TIMES');
      graph(page, 24, 35, PAGE_W - 48, 490, data); pages.push(page);
    });
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(payload.race?.sessionName)} stint analysis</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
    <style>@page { size: A4 landscape; margin: 0; } * { box-sizing: border-box; } html,body { margin:0; padding:0; }
    .report-page { width:297mm; height:210mm; overflow:hidden; break-after:page; } .report-page:last-child { break-after:auto; }
    .report-page svg { display:block; width:100%; height:100%; } </style></head><body>${pages.map((page) => page.html()).join('')}</body></html>`;
}

module.exports = { buildCanonicalReportHtml };
