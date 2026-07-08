// Graph dataset builder.
//
// This module contains every calculation needed by the graphs window. It is
// UMD-style so Node tests and the browser renderer use exactly the same logic.
(function initGraphData(root, factory) {
  const analytics = typeof module === 'object' && module.exports
    ? require('./lapAnalytics')
    : root?.lapAnalytics;
  const api = factory(analytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.graphData = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createGraphDataApi(lapAnalytics) {
  const GRAPH_OPTIONS = [
    { value: 'driver-laps', label: 'Lap times per driver' },
    { value: 'driver-pace', label: 'Driver pace comparison' },
    { value: 'driver-sectors', label: 'Sector comparison' },
    { value: 'class-pace', label: 'Class pace comparison' }
  ];

  function average(values) {
    const valid = values.filter(Number.isFinite);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  }

  // Uses the official lap number when available. The fallback sequence keeps
  // old timing providers without lap numbers usable in line charts.
  function chartLapNumber(lap, fallbackIndex) {
    return Number.isFinite(lap.lapNumber) && lap.lapNumber > 0 ? lap.lapNumber : fallbackIndex + 1;
  }

  function followedCarLaps(history, carNumber) {
    return lapAnalytics.lapsForCar(history, carNumber);
  }

  // Shows only laps that are valid for pace analysis. FCY, Safety Car, inlaps,
  // and outlaps remain stored but are deliberately absent from readable graphs.
  function driverLapTimes(history, carNumber) {
    const groups = new Map();
    const laps = followedCarLaps(history, carNumber);
    const representative = new Set(lapAnalytics.representativePaceLaps(laps));
    laps.forEach((lap, index) => {
      if (!representative.has(lap)) return;
      const driver = lap.driverName || 'Unknown';
      if (!groups.has(driver)) groups.set(driver, []);
      const driverLapNumber = groups.get(driver).length + 1;
      const raceLapNumber = chartLapNumber(lap, index);
      groups.get(driver).push({
        x: driverLapNumber,
        y: lap.lapTimeMs,
        eligible: true,
        raceLapNumber,
        condition: lap.lapCondition || lap.trackCondition || 'unknown',
        label: `Driver lap ${driverLapNumber} · race lap ${raceLapNumber}`
      });
    });
    return {
      type: 'line',
      title: 'Lap times per driver',
      subtitle: 'Green-flag race laps only; pit, FCY and Safety Car laps are excluded.',
      yFormat: 'time',
      xLabel: 'Driver lap',
      series: [...groups.entries()].map(([name, points]) => ({ name, points }))
    };
  }

  // Compares long-term pace with current form. The recent metric intentionally
  // uses only the latest ten eligible laps, regardless of stint length.
  function driverPaceComparison(history, carNumber, recentLapCount = 10, mode = 'race') {
    const drivers = lapAnalytics.driverStats(history, carNumber);
    const categories = drivers.map((driver) => driver.driverName);
    const recentAverage = (driver) => {
      const recent = lapAnalytics.representativePaceLaps(driver.laps).slice(-recentLapCount);
      return average(recent.map((lap) => lap.lapTimeMs));
    };
    if (mode === 'qualifying') {
      return {
        type: 'bar',
        title: 'Driver qualifying comparison',
        subtitle: 'Best and latest valid flying lap per team driver.',
        yFormat: 'time',
        categories,
        series: [
          { name: 'Best lap', values: drivers.map((driver) => driver.bestLapMs) },
          { name: 'Last valid', values: drivers.map((driver) => driver.lastLapMs) }
        ]
      };
    }
    return {
      type: 'bar',
      title: 'Driver pace comparison',
      subtitle: `Best, full average and latest ${recentLapCount} valid laps.`,
      yFormat: 'time',
      categories,
      series: [
        { name: 'Best lap', values: drivers.map((driver) => driver.bestLapMs) },
        { name: 'Average', values: drivers.map((driver) => driver.averageLapMs) },
        { name: `Last ${recentLapCount}`, values: drivers.map(recentAverage) }
      ]
    };
  }

  // Sector eligibility is evaluated independently. A lap interrupted by FCY in
  // S3 can therefore still contribute valid S1 and S2 values here.
  function driverSectorComparison(history, carNumber) {
    const drivers = lapAnalytics.driverStats(history, carNumber);
    return {
      type: 'bar',
      title: 'Sector comparison',
      subtitle: 'Average sectors are solid; best sectors use the lighter bars.',
      yFormat: 'time',
      categories: drivers.map((driver) => driver.driverName),
      series: [
        { name: 'Average S1', values: drivers.map((driver) => driver.averageSector1Ms) },
        { name: 'Best S1', values: drivers.map((driver) => driver.bestSector1Ms), muted: true },
        { name: 'Average S2', values: drivers.map((driver) => driver.averageSector2Ms) },
        { name: 'Best S2', values: drivers.map((driver) => driver.bestSector2Ms), muted: true },
        { name: 'Average S3', values: drivers.map((driver) => driver.averageSector3Ms) },
        { name: 'Best S3', values: drivers.map((driver) => driver.bestSector3Ms), muted: true }
      ]
    };
  }

  // Builds a rolling average from consecutive eligible samples. Early points
  // use the data already available; after `windowSize` laps it becomes a fixed
  // rolling window. This lets the graph appear before five laps are complete.
  function rollingAveragePoints(laps, windowSize = 5) {
    const eligible = lapAnalytics.representativePaceLaps(laps);
    return eligible.map((lap, index) => {
      const window = eligible.slice(Math.max(0, index - windowSize + 1), index + 1);
      return {
        x: chartLapNumber(lap, index),
        y: average(window.map((entry) => entry.lapTimeMs)),
        eligible: true,
        sampleCount: window.length,
        label: `Lap ${chartLapNumber(lap, index)} · ${window.length}-lap average`
      };
    });
  }

  function classPaceComparison(history, carNumber, windowSize = 5) {
    const ourCar = lapAnalytics.carStats(history, carNumber);
    const classCars = ourCar.className ? lapAnalytics.carsInClass(history, ourCar.className) : [];
    const ourLapTimes = new Map(lapAnalytics.representativePaceLaps(ourCar.laps)
      .map((lap, index) => [chartLapNumber(lap, index), lap.lapTimeMs]));
    return {
      type: 'line',
      title: 'Class pace comparison',
      subtitle: 'Actual valid lap times for every car in our class.',
      yFormat: 'time',
      xLabel: 'Race lap',
      series: classCars.map((car) => ({
        name: `#${car.carNumber}${car.teamName ? ` ${car.teamName}` : ''}`,
        carNumber: car.carNumber,
        highlight: String(car.carNumber) === String(carNumber),
        points: lapAnalytics.representativePaceLaps(car.laps)
          .map((lap, index) => {
            const raceLapNumber = chartLapNumber(lap, index);
            const ourLapMs = ourLapTimes.get(raceLapNumber);
            return {
              x: raceLapNumber,
              y: lap.lapTimeMs,
              eligible: true,
              condition: lap.lapCondition || lap.trackCondition || 'unknown',
              label: `Lap ${raceLapNumber}`,
              deltaToOurCarMs: Number.isFinite(ourLapMs) ? lap.lapTimeMs - ourLapMs : null
            };
          })
      }))
    };
  }

  function buildGraph(type, history, carNumber, options = {}) {
    if (type === 'driver-pace') return driverPaceComparison(history, carNumber, 10, options.mode);
    if (type === 'driver-sectors') return driverSectorComparison(history, carNumber);
    if (type === 'class-pace') return classPaceComparison(history, carNumber);
    return driverLapTimes(history, carNumber);
  }

  // Zoom state is stored as normalized fractions of the complete x-axis. This
  // survives incoming live laps and works for graphs with different lap ranges.
  function normalizeViewport(viewport = {}) {
    const rawStart = Number(viewport.start);
    const rawEnd = Number(viewport.end);
    const start = Number.isFinite(rawStart) ? Math.max(0, Math.min(1, rawStart)) : 0;
    const end = Number.isFinite(rawEnd) ? Math.max(start, Math.min(1, rawEnd)) : 1;
    return end > start ? { start, end } : { start: 0, end: 1 };
  }

  function zoomViewport(viewport, factor, anchor = 0.5, minimumSpan = 0.08) {
    const current = normalizeViewport(viewport);
    const span = current.end - current.start;
    const nextSpan = Math.max(minimumSpan, Math.min(1, span * factor));
    const safeAnchor = Math.max(0, Math.min(1, Number(anchor) || 0));
    const focus = current.start + span * safeAnchor;
    let start = focus - nextSpan * safeAnchor;
    let end = start + nextSpan;
    if (start < 0) { end -= start; start = 0; }
    if (end > 1) { start -= end - 1; end = 1; }
    return normalizeViewport({ start, end });
  }

  function panViewport(viewport, direction, fraction = 0.3) {
    const current = normalizeViewport(viewport);
    const span = current.end - current.start;
    const offset = span * Math.max(0, Number(fraction) || 0) * Math.sign(direction || 0);
    let start = current.start + offset;
    let end = current.end + offset;
    if (start < 0) { end -= start; start = 0; }
    if (end > 1) { start -= end - 1; end = 1; }
    return normalizeViewport({ start, end });
  }

  return {
    GRAPH_OPTIONS,
    average,
    chartLapNumber,
    driverLapTimes,
    driverPaceComparison,
    driverSectorComparison,
    rollingAveragePoints,
    classPaceComparison,
    buildGraph,
    normalizeViewport,
    zoomViewport,
    panViewport
  };
});
