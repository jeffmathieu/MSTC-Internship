// Builds the session Excel export: lap data sheets (green-flag laps and all
// laps), driver/stint/pit tables, the whole field, and one chart sheet per
// followed car. Everything is derived from already-stored session data.
const lapAnalytics = require('../../shared/lapAnalytics');
const { buildDriverOverview } = require('../../shared/driverOverview');
const { Workbook, excel, PALETTE } = require('./xlsxWriter');

const num = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const lapNumberOf = (lap) => lap.displayLapNumber ?? lap.lapNumber ?? lap.historySequence ?? null;
const ms = (value) => excel.duration(num(value));
const seconds = (value) => (num(value) === null ? null : num(value) / 1000);
const modeLabel = (mode) => ({ race: 'Race', practice: 'Practice', qualifying: 'Qualifying' }[mode] || 'Session');
const yesNo = (value) => (value === true ? 'yes' : value === false ? 'no' : '');

function carLaps(history, car) {
  return lapAnalytics.lapsForCar(history, car).filter((lap) => num(lap.lapTimeMs) !== null);
}

// Stints are consecutive runs of laps, so lap k belongs to the stint whose
// cumulative lap count first exceeds k.
function stintNumberForLaps(laps, stints) {
  const numbers = [];
  stints.forEach((stint) => { for (let i = 0; i < (stint.lapCount || 0); i += 1) numbers.push(stint.stintNumber); });
  return laps.map((_, index) => numbers[index] ?? '');
}

function addDataSheet(workbook, name, header, columns, rows, { freeze = true, filter = true } = {}) {
  const sheet = workbook.addSheet(name);
  sheet.header = header;
  sheet.columns = columns;
  sheet.rows = rows;
  sheet.freezeHeader = freeze;
  sheet.filter = filter;
  return sheet;
}

function lapRow(lap, stintNumber, car, extended) {
  const reasons = lapAnalytics.baseLapExclusionReasons(lap);
  const base = [car, lapNumberOf(lap), lap.driverName || '', stintNumber, ms(lap.lapTimeMs), ms(lap.sector1Ms), ms(lap.sector2Ms), ms(lap.sector3Ms),
    lap.lapCondition || lap.trackCondition || '', lap.sessionFlag || lap.lapFlag || '', excel.dateTime(lap.recordedAt || lap.collectedAt)];
  if (!extended) return base;
  return [...base, lap.lapPhase || '', lapAnalytics.lapPaceEligible(lap) ? 'yes' : 'no', reasons.join(', '), lap.manualLapStatus || ''];
}

const LAP_HEADER = ['Car', 'Lap', 'Driver', 'Stint', 'Lap time', 'Sector 1', 'Sector 2', 'Sector 3', 'Condition', 'Flag', 'Time'];
const LAP_COLUMNS = [{ style: 'int', width: 7 }, { style: 'int', width: 7 }, { width: 24 }, { style: 'int', width: 7 }, { style: 'lapTime', width: 12 },
  { style: 'lapTime', width: 11 }, { style: 'lapTime', width: 11 }, { style: 'lapTime', width: 11 }, { width: 12 }, { width: 18 }, { style: 'dateTime', width: 20 }];

// One block of a chart-data sheet: a styled header row followed by data rows.
// Returns the 1-based row numbers so charts can reference the cells.
function appendBlock(rows, header, data) {
  if (rows.length) rows.push([], []);
  const headerRow = rows.length + 1;
  rows.push(header.map((label) => ({ v: label, style: 'header' })));
  data.forEach((row) => rows.push(row));
  return { headerRow, first: headerRow + 1, last: headerRow + data.length };
}

function range(sheet, column, block, values, extra = {}) {
  return { sheet, column, first: block.first, last: Math.max(block.first, block.last), values, ...extra };
}

function addCarCharts(workbook, car, model) {
  const { drivers, stints } = model.overview;
  const laps = model.laps;
  const dataName = `Chart data #${car}`;
  const data = workbook.addSheet(dataName);
  const rows = [];
  data.rows = rows;
  data.columns = [{ width: 24 }, ...Array.from({ length: 12 }, () => ({ width: 14 }))];
  const charts = [];
  const column = (index) => String.fromCharCode(65 + index);

  // 1. Green-flag lap times, one series per driver.
  const green = laps.filter((lap) => lapAnalytics.lapPaceEligible(lap));
  const lapNumbers = [...new Set(green.map(lapNumberOf).filter((n) => n !== null))].sort((a, b) => a - b);
  const driverNames = drivers.map((d) => d.driverName);
  const byDriver = new Map(driverNames.map((name) => [name, new Map(green.filter((lap) => lap.driverName === name).map((lap) => [lapNumberOf(lap), num(lap.lapTimeMs)]))]));
  const lapBlock = appendBlock(rows, ['Lap', ...driverNames],
    lapNumbers.map((n) => [{ v: n, style: 'int' }, ...driverNames.map((name) => ({ v: ms(byDriver.get(name).get(n)), style: 'lapTime' }))]));
  if (lapNumbers.length) {
    const cat = range(dataName, 'A', lapBlock, lapNumbers, { kind: 'num', format: '0' });
    const valid = green.map((lap) => num(lap.lapTimeMs)).filter((v) => v !== null);
    charts.push({ type: 'line', title: 'Green-flag lap times by driver', categoryTitle: 'Lap', valueTitle: 'Lap time', valueFormat: 'm:ss.0',
      valueMin: Math.floor(Math.min(...valid) / 1000 - 1) * 1000 / 86400000, valueMax: Math.ceil(Math.max(...valid) / 1000 + 1) * 1000 / 86400000,
      series: driverNames.map((name, i) => ({ name, cat, val: range(dataName, column(i + 1), lapBlock,
        lapNumbers.map((n) => ms(byDriver.get(name).get(n))), { format: 'm:ss.000' }) })) });
  }

  // 2. Average and best lap per stint.
  const stintRows = stints.filter((s) => num(s.averageLapMs) !== null);
  if (stintRows.length) {
    const stintBlock = appendBlock(rows, ['Stint', 'Average lap', 'Best lap', 'Driving time'],
      stintRows.map((s) => [`S${s.number} ${s.driverName}`, { v: ms(s.averageLapMs), style: 'lapTime' }, { v: ms(s.bestLapMs), style: 'lapTime' }, { v: ms(s.drivingMs), style: 'duration' }]));
    const cat = range(dataName, 'A', stintBlock, stintRows.map((s) => `S${s.number} ${s.driverName}`), { kind: 'str' });
    const values = stintRows.flatMap((s) => [num(s.averageLapMs), num(s.bestLapMs)]).filter((v) => v !== null);
    charts.push({ type: 'bar', title: 'Average and best lap per stint', valueTitle: 'Lap time', valueFormat: 'm:ss.0',
      valueMin: Math.floor(Math.min(...values) / 1000 - 2) * 1000 / 86400000,
      series: [['Average lap', 'B', 'average'], ['Best lap', 'C', 'best']].map(([name, col, key]) => ({ name, cat,
        val: range(dataName, col, stintBlock, stintRows.map((s) => ms(key === 'average' ? s.averageLapMs : s.bestLapMs)), { format: 'm:ss.000' }) })) });
  }

  // 3-5. Driver blocks: driving share, best sectors, pace gap to the best driver.
  if (drivers.length) {
    const driverBlock = appendBlock(rows, ['Driver', 'Driving time', 'Best S1', 'Best S2', 'Best S3', 'Gap to best average (s)', 'Consistency (s)'],
      drivers.map((d) => [d.driverName, { v: ms(d.drivingMs), style: 'duration' }, { v: ms(d.bestSectorMs[0]), style: 'lapTime' }, { v: ms(d.bestSectorMs[1]), style: 'lapTime' },
        { v: ms(d.bestSectorMs[2]), style: 'lapTime' }, { v: seconds(d.deltaAverageMs), style: 'dec3' }, { v: seconds(d.consistencyMs), style: 'dec3' }]));
    const cat = range(dataName, 'A', driverBlock, driverNames, { kind: 'str' });
    charts.push({ type: 'pie', title: 'Driving time share',
      series: [{ name: 'Driving time', cat, val: range(dataName, 'B', driverBlock, drivers.map((d) => ms(d.drivingMs)), { format: '[h]:mm:ss' }) }] });
    const sectors = [0, 1, 2].flatMap((i) => drivers.map((d) => num(d.bestSectorMs[i]))).filter((v) => v !== null);
    if (sectors.length) {
      charts.push({ type: 'bar', title: 'Best sector times by driver', valueTitle: 'Sector time', valueFormat: 'm:ss.0',
        valueMin: Math.floor(Math.min(...sectors) / 1000 - 2) * 1000 / 86400000,
        series: [0, 1, 2].map((i) => ({ name: `Best S${i + 1}`, cat, val: range(dataName, column(2 + i), driverBlock, drivers.map((d) => ms(d.bestSectorMs[i])), { format: 'm:ss.000' }) })) });
    }
    if (drivers.some((d) => num(d.deltaAverageMs) !== null)) {
      charts.push({ type: 'bar', title: 'Average pace gap to the best driver', valueTitle: 'Seconds per lap', valueFormat: '0.000',
        series: [{ name: 'Gap (s)', cat, val: range(dataName, 'F', driverBlock, drivers.map((d) => seconds(d.deltaAverageMs)), { format: '0.000' }) }] });
    }
  }

  // 6. Pit stop durations.
  const stops = model.pitStops.filter((stop) => num(stop.durationMs ?? stop.totalDurationMs) !== null);
  if (stops.length) {
    const label = (stop, i) => `Stop ${stop.stopNumber ?? i + 1}`;
    const stopBlock = appendBlock(rows, ['Pit stop', 'Duration'],
      stops.map((stop, i) => [label(stop, i), { v: ms(stop.durationMs ?? stop.totalDurationMs), style: 'duration' }]));
    charts.push({ type: 'bar', title: 'Pit stop durations', valueTitle: 'Time in pit', valueFormat: 'm:ss',
      series: [{ name: 'Duration', cat: range(dataName, 'A', stopBlock, stops.map(label), { kind: 'str' }),
        val: range(dataName, 'B', stopBlock, stops.map((stop) => ms(stop.durationMs ?? stop.totalDurationMs)), { format: 'm:ss' }) }] });
  }

  // 7. Position by lap (1 is at the top).
  const positioned = laps.filter((lap) => num(lap.position) !== null);
  if (positioned.length) {
    const posBlock = appendBlock(rows, ['Lap', 'Overall position', 'Class position'],
      positioned.map((lap) => [{ v: lapNumberOf(lap), style: 'int' }, { v: num(lap.position), style: 'int' }, { v: num(lap.classPosition), style: 'int' }]));
    const cat = range(dataName, 'A', posBlock, positioned.map(lapNumberOf), { kind: 'num', format: '0' });
    charts.push({ type: 'line', title: 'Position by lap', categoryTitle: 'Lap', valueTitle: 'Position', valueFormat: '0', reverseValueAxis: true, valueMin: 1,
      series: [['Overall position', 'B', 'position'], ['Class position', 'C', 'classPosition']].map(([name, col, key]) => ({ name, cat,
        val: range(dataName, col, posBlock, positioned.map((lap) => num(lap[key])), { format: '0' }) })) });
  }

  const sheet = workbook.addSheet(`Charts #${car}`);
  sheet.columns = [{ width: 10 }];
  sheet.rows = [[{ v: `Car #${car}: charts (data on the "${dataName}" sheet)`, style: 'title' }]];
  charts.forEach((chart, index) => {
    chart.anchor = { col: (index % 2) * 10, row: 2 + Math.floor(index / 2) * 22, cols: 10, rows: 21 };
    sheet.charts.push(chart);
  });
  return charts.length;
}

function buildSessionWorkbook({ sessionName = '', generatedAt = new Date().toISOString(), mode = 'race', trackCondition = '', followedCars = [],
  history = [], fieldCars = [], stintStateCars = {}, pitEventsByCar = {}, pitNotesByCar = {}, timingUrl = '', raceMessages = [] }) {
  const workbook = new Workbook();
  const models = followedCars.map((car) => {
    const laps = carLaps(history, car);
    const stintCar = stintStateCars[car] || null;
    const overview = buildDriverOverview({ laps: history, stintCar, carNumber: car });
    const events = pitEventsByCar[car] || [];
    const notes = pitNotesByCar[car] || {};
    const pitStops = events.map((event) => ({ ...event, notes: notes[event.id] || null }));
    return { car, laps, overview, stintCar, pitStops };
  });

  // Summary
  const summary = workbook.addSheet('Summary');
  summary.columns = [{ width: 30 }, { width: 22 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  summary.rows = [
    [{ v: sessionName || 'Session export', style: 'title' }],
    [{ v: 'Mode', style: 'bold' }, modeLabel(mode)],
    [{ v: 'Generated', style: 'bold' }, { v: excel.dateTime(generatedAt), style: 'dateTime' }],
    [{ v: 'Track condition', style: 'bold' }, trackCondition || ''],
    [{ v: 'Timing source', style: 'bold' }, timingUrl || ''],
    [{ v: 'Followed cars', style: 'bold' }, followedCars.map((car) => `#${car}`).join(', ')],
    [{ v: 'Green-flag laps', style: 'bold' }, { v: 'Laps counted in pace statistics: not the first lap, not an in-/out-lap, no FCY/SC/yellow neutralisation and no manual exclusion. "All laps" lists every lap with the reason it was excluded.', style: 'wrap' }],
    [],
    [{ v: 'Car', style: 'header' }, { v: 'Class', style: 'header' }, { v: 'Laps', style: 'header' }, { v: 'Green laps', style: 'header' }, { v: 'Best lap', style: 'header' },
      { v: 'Average green lap', style: 'header' }, { v: 'Driving time', style: 'header' }, { v: 'Pit stops', style: 'header' }, { v: 'Drivers', style: 'header' }]
  ];
  models.forEach((model) => {
    const green = model.laps.filter((lap) => lapAnalytics.lapPaceEligible(lap)).map((lap) => num(lap.lapTimeMs));
    summary.rows.push([{ v: `#${model.car}`, style: 'bold' }, model.laps.at(-1)?.className || '', { v: model.laps.length, style: 'int' }, { v: green.length, style: 'int' },
      { v: ms(model.overview.totals.fastestLap?.ms ?? (green.length ? Math.min(...green) : null)), style: 'lapTime' },
      { v: ms(green.length ? green.reduce((a, b) => a + b, 0) / green.length : null), style: 'lapTime' },
      { v: ms(model.overview.totals.drivingMs), style: 'duration' }, { v: model.pitStops.length, style: 'int' }, { v: model.overview.totals.driverCount, style: 'int' }]);
  });

  // Lap sheets
  const greenRows = [], allRows = [];
  models.forEach((model) => {
    const stintNumbers = stintNumberForLaps(model.laps, model.stintCar?.stints || []);
    model.laps.forEach((lap, index) => {
      allRows.push(lapRow(lap, stintNumbers[index], model.car, true));
      if (lapAnalytics.lapPaceEligible(lap)) greenRows.push(lapRow(lap, stintNumbers[index], model.car, false));
    });
  });
  addDataSheet(workbook, 'Green laps', LAP_HEADER, LAP_COLUMNS, greenRows);
  addDataSheet(workbook, 'All laps', [...LAP_HEADER, 'Pit phase', 'In pace stats', 'Exclusion reasons', 'Manual status'],
    [...LAP_COLUMNS, { width: 10 }, { width: 12 }, { width: 28 }, { width: 14 }], allRows);

  // Drivers
  addDataSheet(workbook, 'Drivers',
    ['Car', 'Driver', 'Stints', 'Driving time', 'Share', 'Laps', 'Green laps', 'Best lap', 'Average lap', 'Gap to best lap', 'Gap to best average', 'Consistency (s)',
      'Avg S1', 'Avg S2', 'Avg S3', 'Best S1', 'Best S2', 'Best S3', 'Avg stint (laps)', 'Longest stint'],
    [{ style: 'int', width: 7 }, { width: 24 }, { style: 'int', width: 8 }, { style: 'duration', width: 13 }, { style: 'percent', width: 9 }, { style: 'int', width: 8 }, { style: 'int', width: 10 },
      { style: 'lapTime', width: 12 }, { style: 'lapTime', width: 12 }, { style: 'delta', width: 14 }, { style: 'delta', width: 16 }, { style: 'dec3', width: 14 },
      ...Array.from({ length: 6 }, () => ({ style: 'lapTime', width: 11 })), { style: 'dec3', width: 14 }, { style: 'duration', width: 13 }],
    models.flatMap((model) => model.overview.drivers.map((d) => [model.car, d.driverName, d.stintCount, ms(d.drivingMs), num(d.sharePct) === null ? null : d.sharePct / 100,
      d.lapCount, d.paceLapCount, ms(d.bestLapMs), ms(d.averageLapMs), seconds(d.deltaBestMs), seconds(d.deltaAverageMs), seconds(d.consistencyMs),
      ...d.averageSectorMs.map(ms), ...d.bestSectorMs.map(ms), d.averageStintLaps, ms(d.longestStint?.drivingMs)])));

  // Stints
  addDataSheet(workbook, 'Stints',
    ['Car', 'Stint', 'Driver', 'Start lap', 'End lap', 'Laps', 'Driving time', 'Elapsed', 'Pit time excluded', 'Average lap', 'Best lap', 'Started', 'Status'],
    [{ style: 'int', width: 7 }, { style: 'int', width: 7 }, { width: 24 }, { style: 'int', width: 10 }, { style: 'int', width: 9 }, { style: 'int', width: 8 }, { style: 'duration', width: 13 },
      { style: 'duration', width: 12 }, { style: 'duration', width: 17 }, { style: 'lapTime', width: 12 }, { style: 'lapTime', width: 12 }, { style: 'dateTime', width: 20 }, { width: 10 }],
    models.flatMap((model) => (model.stintCar?.stints || []).map((s) => [model.car, s.stintNumber, s.driverName, s.startLap, s.endLap, s.lapCount, ms(s.stintTimeMs), ms(s.elapsedTimeMs),
      ms(s.excludedPitTimeMs), ms(s.stats?.averageLapMs), ms(s.stats?.bestLapMs), excel.dateTime(s.startedAt), s.closed ? 'closed' : 'active'])));

  // Pit stops with the engineer's notes
  addDataSheet(workbook, 'Pit stops',
    ['Car', 'Stop', 'Detected', 'Left pits', 'Lap', 'Driver before', 'Driver after', 'Duration', 'Fuel time', 'Pit time', 'Fuel added', 'Tyres changed', 'Tyre set', 'Driver notes', 'Pit stop notes'],
    [{ style: 'int', width: 7 }, { style: 'int', width: 7 }, { style: 'dateTime', width: 20 }, { style: 'dateTime', width: 20 }, { style: 'int', width: 7 }, { width: 22 }, { width: 22 },
      { style: 'duration', width: 11 }, { style: 'duration', width: 11 }, { style: 'duration', width: 11 }, { width: 11 }, { width: 14 }, { width: 18 }, { style: 'wrap', width: 40 }, { style: 'wrap', width: 40 }],
    models.flatMap((model) => model.pitStops.map((stop) => [model.car, stop.stopNumber, excel.dateTime(stop.entryAt), excel.dateTime(stop.exitAt), stop.lapNumber,
      stop.driverBefore || '', stop.driverAfter || '', ms(stop.durationMs ?? stop.totalDurationMs), ms(stop.fuelDurationMs), ms(stop.pitDurationMs),
      yesNo(stop.notes?.fuelAdded), yesNo(stop.notes?.tyresChanged), stop.notes?.tyreSet || '', stop.notes?.driverNotes || '', stop.notes?.pitNotes || ''])));

  // The whole field (every car seen in the timing)
  if (fieldCars.length) {
    addDataSheet(workbook, 'Field',
      ['Car', 'Class', 'Team', 'Laps', 'Green laps', 'Best lap', 'Average lap', 'Best S1', 'Best S2', 'Best S3'],
      [{ style: 'int', width: 7 }, { width: 14 }, { width: 28 }, { style: 'int', width: 8 }, { style: 'int', width: 10 }, { style: 'lapTime', width: 12 }, { style: 'lapTime', width: 12 },
        { style: 'lapTime', width: 11 }, { style: 'lapTime', width: 11 }, { style: 'lapTime', width: 11 }],
      fieldCars.map((car) => [num(car.carNumber) ?? car.carNumber, car.className || '', car.teamName || '', car.lapCount, car.paceLapCount, ms(car.bestLapMs), ms(car.averageLapMs),
        ms(car.bestSector1Ms), ms(car.bestSector2Ms), ms(car.bestSector3Ms)]));
  }

  // Steward / race-control messages seen on the timing page.
  if (raceMessages.length) {
    addDataSheet(workbook, 'Race messages', ['Time', 'Message', 'Followed cars mentioned'],
      [{ style: 'dateTime', width: 20 }, { style: 'wrap', width: 90 }, { width: 22 }],
      raceMessages.map((message) => [excel.dateTime(message.firstSeenAt), message.text, (message.cars || []).map((car) => `#${car}`).join(', ')]));
  }

  // Charts last, so the data sheets come first in the workbook.
  models.forEach((model) => addCarCharts(workbook, model.car, { ...model, overview: model.overview }));
  return workbook.toBuffer();
}

module.exports = { buildSessionWorkbook, PALETTE };
