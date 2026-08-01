// Session-mode calculations shared by main-process analytics and tests.
// The renderer consumes the returned labels/values and performs no race math.
(function initSessionMode(root, factory) {
  const analytics = typeof module === 'object' && module.exports
    ? require('./lapAnalytics')
    : root?.lapAnalytics;
  const labels = typeof module === 'object' && module.exports
    ? require('./driverLabels')
    : root?.driverLabels;
  const api = factory(analytics, labels);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.sessionMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createSessionModeApi(lapAnalytics, driverLabels) {
  const MODES = ['race', 'practice', 'qualifying'];

  function normalizeMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'quali' || normalized === 'qualification') return 'qualifying';
    return MODES.includes(normalized) ? normalized : 'race';
  }

  function subtract(left, right) {
    return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
  }

  function average(values) {
    const usable = values.filter(Number.isFinite);
    return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
  }

  function recentAverage(stats, count = 10) {
    const laps = lapAnalytics.representativePaceLaps(stats?.laps || []).slice(-count);
    return average(laps.map((lap) => lap.lapTimeMs));
  }

  function initials(name) {
    return driverLabels.baseDriverCode(name);
  }

  function shortDriverName(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    const uppercase = parts.filter((part) => /[A-Z]/.test(part) && part === part.toUpperCase());
    return uppercase.join(' ') || initials(name);
  }

  function metric(label, current, reference) {
    return { label, valueMs: Number.isFinite(current) ? current : null, referenceMs: Number.isFinite(reference) ? reference : null, deltaMs: subtract(current, reference) };
  }

  // External-car comparisons use target minus our time. A slower rival is
  // therefore positive/red; a faster rival is negative/green.
  function targetMetric(label, ourValue, targetValue) {
    return { label, valueMs: Number.isFinite(targetValue) ? targetValue : null, referenceMs: Number.isFinite(targetValue) ? targetValue : null, deltaMs: subtract(targetValue, ourValue) };
  }

  function sectorAverages(displaySource, ourReference = null) {
    return [1, 2, 3].map((sector) => ({
      label: `S${sector}`,
      averageMs: Number.isFinite(displaySource?.[`averageSector${sector}Ms`]) ? displaySource[`averageSector${sector}Ms`] : null,
      deltaMs: ourReference ? subtract(displaySource?.[`averageSector${sector}Ms`], ourReference?.[`averageSector${sector}Ms`]) : null,
      showDelta: Boolean(ourReference)
    }));
  }

  function lapNumberFromRow(row) {
    const value = Number(row?.lapNumber ?? row?.laps ?? row?.lap ?? row?.LAPS);
    return Number.isFinite(value) ? value : null;
  }

  // Comparison tabs follow the official class order. Some providers omit PIC
  // temporarily, so overall position and finally car number provide stable
  // fallbacks instead of moving our car to an artificial first position.
  function sortablePosition(value) {
    const position = Number(value);
    return Number.isFinite(position) && position > 0 ? position : Number.POSITIVE_INFINITY;
  }

  function compareClassCars(left, right) {
    const leftClassPosition = sortablePosition(left.classPosition);
    const rightClassPosition = sortablePosition(right.classPosition);
    if (leftClassPosition !== rightClassPosition) return leftClassPosition < rightClassPosition ? -1 : 1;

    const leftOverallPosition = sortablePosition(left.position);
    const rightOverallPosition = sortablePosition(right.position);
    if (leftOverallPosition !== rightOverallPosition) return leftOverallPosition < rightOverallPosition ? -1 : 1;

    return String(left.carNumber).localeCompare(String(right.carNumber), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  function isRunningClassRow(row, classLeaderLap) {
    const state = String(row?.state || row?.status || '').trim().toLowerCase();
    if (/\b(ret|dnf|dns|out|stop|finished|finish|disq|dq)\b/.test(state)) return false;
    const pitLike = /\b(p|pit|in pit)\b/.test(state) || /in pit/i.test(String(row?.eta || row?.pitStatus || ''));
    const lap = lapNumberFromRow(row);
    if (pitLike && Number.isFinite(classLeaderLap) && Number.isFinite(lap) && classLeaderLap - lap >= 5) return false;
    return true;
  }

  function statsForCar(history, rows, carNumber, conditionFilter = 'combined') {
    return lapAnalytics.carStatsWithProviderBest(history, rows, carNumber, { conditionFilter });
  }

  // The benchmark column normally shows the best-average car in class. When
  // that is our own car, showing it again would create a useless duplicate of
  // the first column. In that case use the next-fastest other car. During the
  // opening laps, before another car has a valid average, fall back to the
  // first other car in the official live class order so the column still
  // identifies the intended comparison target.
  function classBenchmarkForComparison(history, rows, ourCarNumber, className, conditionFilter = 'combined') {
    if (!className) return { car: null, isActualBic: false };
    const paceCars = lapAnalytics.carsInClass(history, className, { conditionFilter })
      .filter((car) => Number.isFinite(car.averageLapMs))
      .sort((left, right) => left.averageLapMs - right.averageLapMs);
    const actualBic = paceCars[0] || null;
    const benchmarkReference = String(actualBic?.carNumber || '') === String(ourCarNumber)
      ? paceCars.find((car) => String(car.carNumber) !== String(ourCarNumber)) || null
      : actualBic;
    if (benchmarkReference) {
      return {
        car: statsForCar(history, rows, benchmarkReference.carNumber, conditionFilter),
        isActualBic: String(benchmarkReference.carNumber) === String(actualBic?.carNumber)
      };
    }

    const fallbackRow = (rows || [])
      .filter((row) => row.className === className && String(row.carNumber) !== String(ourCarNumber))
      .sort(compareClassCars)[0];
    return {
      car: fallbackRow ? statsForCar(history, rows, fallbackRow.carNumber, conditionFilter) : null,
      isActualBic: false
    };
  }

  function classCarsForComparison(history, rows, ourCarNumber, ourReference, conditionFilter = 'combined') {
    const ourRow = (rows || []).find((row) => String(row.carNumber) === String(ourCarNumber));
    const ourCar = ourReference || statsForCar(history, rows, ourCarNumber, conditionFilter);
    const className = ourRow?.className || ourCar.className;
    if (!className) return [];
    const classRows = (rows || [])
      .filter((row) => row.className === className)
      .sort((a, b) => (Number(a.classPosition) || 999999) - (Number(b.classPosition) || 999999));
    const classLeaderLap = Math.max(...classRows.map(lapNumberFromRow).filter(Number.isFinite));
    const activeRows = classRows.filter((row) => isRunningClassRow(row, classLeaderLap));
    const bic = lapAnalytics.bestCarInClassByAverage(history, className);

    const cars = activeRows.map((row) => {
      const stats = statsForCar(history, rows, row.carNumber, conditionFilter);
      const drivers = lapAnalytics.driverStats(history, row.carNumber);
      return {
        carNumber: String(row.carNumber || stats.carNumber || ''),
        classPosition: row.classPosition || '',
        position: row.position || '',
        teamName: row.team || row.teamName || stats.teamName || '',
        isOurCar: String(row.carNumber) === String(ourCarNumber),
        isBic: bic && String(row.carNumber) === String(bic.carNumber),
        metrics: [
          targetMetric('Best', ourCar.bestLapMs, stats.bestLapMs),
          targetMetric('Last', ourCar.lastLapMs, stats.lastLapMs),
          targetMetric('Last 10', recentAverage(ourCar), recentAverage(stats))
        ],
        totalAverageMs: stats.averageLapMs,
        totalAverageDeltaMs: subtract(stats.averageLapMs, ourCar.averageLapMs),
        averages: averageRows(drivers, ourCar.averageLapMs, false),
        sectors: sectorAverages(stats, ourCar)
      };
    });
    return cars.sort(compareClassCars);
  }

  function averageRows(stats = [], comparisonMs = null, comparisonFirst = true) {
    const codes = driverLabels.uniqueDriverCodes(stats.map((driver) => driver.driverName));
    return stats.map((driver) => ({
      label: codes[driver.driverName] || initials(driver.driverName),
      valueMs: driver.averageLapMs,
      deltaMs: comparisonFirst
        ? subtract(comparisonMs, driver.averageLapMs)
        : subtract(driver.averageLapMs, comparisonMs)
    }));
  }

  function comparisonMatrix(history, rows, ourCarNumber, selectedCarNumber, conditionFilter = 'combined') {
    const ourCar = statsForCar(history, rows, ourCarNumber, conditionFilter);
    const current = driverStatsForName(history, ourCarNumber, liveDriver(rows, ourCarNumber, history));
    const best = lapAnalytics.bestDriverByAverage(history, ourCarNumber);
    const benchmark = classBenchmarkForComparison(history, rows, ourCarNumber, ourCar.className, conditionFilter);
    const bic = benchmark.car;
    const xic = selectedCarNumber ? statsForCar(history, rows, selectedCarNumber, conditionFilter) : null;
    const ourDrivers = lapAnalytics.driverStats(history, ourCarNumber);
    const column = (target, kind) => ({
      kind,
      targetCarNumber: target?.carNumber || '',
      metrics: [
        targetMetric('Best', ourCar.bestLapMs, target?.bestLapMs),
        targetMetric('Last', ourCar.lastLapMs, target?.lastLapMs),
        targetMetric('Last 10', recentAverage(ourCar), recentAverage(target))
      ],
      totalAverageMs: target?.averageLapMs ?? null,
      totalAverageDeltaMs: subtract(target?.averageLapMs, ourCar.averageLapMs),
      averages: averageRows(target ? lapAnalytics.driverStats(history, target.carNumber) : [], ourCar.averageLapMs, false),
      sectors: sectorAverages(target, ourCar)
    });
    const teammate = {
      kind: 'teammate',
      targetCarNumber: String(ourCarNumber || ''),
      title: `${shortDriverName(current?.driverName)} vs. ${shortDriverName(best?.driverName)}`,
      metrics: [
        metric('Best', current?.bestLapMs, best?.bestLapMs),
        metric('Last', current?.lastLapMs, best?.lastLapMs),
        metric('Last 10', recentAverage(current), recentAverage(best))
      ],
      totalAverageMs: ourCar.averageLapMs,
      totalAverageDeltaMs: subtract(ourCar.averageLapMs, best?.averageLapMs),
      averages: averageRows(ourDrivers, best?.averageLapMs, false),
      sectors: sectorAverages(ourCar)
    };
    const bicColumn = column(bic, 'bic');
    const xicColumn = column(xic, 'xic');
    return {
      ourCarNumber: String(ourCarNumber || ''),
      teammate,
      bic: bicColumn,
      xic: xicColumn,
      averageCars: [
        { ...teammate, carNumber: String(ourCarNumber || ''), isOurCar: true, isBic: false },
        { ...bicColumn, carNumber: String(bic?.carNumber || ''), isOurCar: false, isBic: benchmark.isActualBic },
        { ...xicColumn, carNumber: String(xic?.carNumber || selectedCarNumber || ''), isOurCar: String(xic?.carNumber || '') === String(ourCarNumber), isBic: false, isXic: true }
      ],
      classCars: classCarsForComparison(history, rows, ourCarNumber, ourCar, conditionFilter)
    };
  }

  function liveDriver(rows, carNumber, history) {
    const row = (rows || []).find((candidate) => String(candidate.carNumber) === String(carNumber));
    return row?.driver || row?.driverName || lapAnalytics.currentDriverName(history, carNumber);
  }

  function driverStatsForName(history, carNumber, driverName) {
    return lapAnalytics.driverStats(history, carNumber).find((driver) => driver.driverName === driverName) || null;
  }

  function bestDriverByBestLap(history, carNumber) {
    return lapAnalytics.driverStats(history, carNumber)
      .filter((driver) => Number.isFinite(driver.bestLapMs))
      .sort((a, b) => a.bestLapMs - b.bestLapMs)[0] || null;
  }

  function bestCarByBestLap(history, className, rows = [], conditionFilter = 'combined') {
    const historyCars = lapAnalytics.carsInClass(history, className).map((car) => car.carNumber);
    const liveCars = (rows || []).filter((row) => row.className === className).map((row) => row.carNumber);
    return [...new Set([...historyCars, ...liveCars])]
      .map((carNumber) => statsForCar(history, rows, carNumber, conditionFilter))
      .filter((car) => Number.isFinite(car.bestLapMs))
      .sort((a, b) => a.bestLapMs - b.bestLapMs)[0] || null;
  }

  function targetCurrentDriverStats(history, rows, target) {
    if (!target) return null;
    return driverStatsForName(history, target.carNumber, liveDriver(rows, target.carNumber, history));
  }

  function raceComparisonView(history, rows, ourCarNumber, selectedCarNumber, conditionFilter = 'combined') {
    const ourCar = statsForCar(history, rows, ourCarNumber, conditionFilter);
    const current = driverStatsForName(history, ourCarNumber, liveDriver(rows, ourCarNumber, history));
    const best = lapAnalytics.bestDriverByAverage(history, ourCarNumber);
    const bic = classBenchmarkForComparison(history, rows, ourCarNumber, ourCar.className, conditionFilter).car;
    const xic = selectedCarNumber ? statsForCar(history, rows, selectedCarNumber, conditionFilter) : null;
    const bicDriver = targetCurrentDriverStats(history, rows, bic);
    const xicDriver = targetCurrentDriverStats(history, rows, xic);
    return {
      mode: 'race',
      columns: [
        { topLabel: 'Best D1', topMs: best?.bestLapMs, bottomLabel: 'Last D2', bottomMs: current?.lastLapMs, deltaLabel: 'Delta D2 vs D1', deltaMs: subtract(current?.lastLapMs, best?.bestLapMs) },
        { topLabel: 'Best D1', topMs: best?.bestLapMs, bottomLabel: 'Best D2', bottomMs: current?.bestLapMs, deltaLabel: 'Delta D2 vs D1', deltaMs: subtract(current?.bestLapMs, best?.bestLapMs) },
        { topLabel: 'Average D1', topMs: best?.averageLapMs, bottomLabel: 'Average D2', bottomMs: current?.averageLapMs, deltaLabel: 'Delta D2 vs D1', deltaMs: subtract(current?.averageLapMs, best?.averageLapMs) },
        { targetCarNumber: bic?.carNumber || '', topScope: 'car', bottomScope: 'current-driver', topLabel: 'Average BIC', topMs: bic?.averageLapMs, bottomLabel: 'Average Dact', bottomMs: bicDriver?.averageLapMs, deltaLabel: 'Delta Dact vs BIC', deltaMs: subtract(bicDriver?.averageLapMs, bic?.averageLapMs) },
        { targetCarNumber: xic?.carNumber || '', topScope: 'car', bottomScope: 'current-driver', topLabel: 'Average XIC', topMs: xic?.averageLapMs, bottomLabel: 'Average Dact', bottomMs: xicDriver?.averageLapMs, deltaLabel: 'Delta Dact vs XIC', deltaMs: subtract(xicDriver?.averageLapMs, xic?.averageLapMs) }
      ]
    };
  }

  function qualifyingComparisonView(history, rows, ourCarNumber, selectedCarNumber, conditionFilter = 'combined') {
    const ourCar = statsForCar(history, rows, ourCarNumber, conditionFilter);
    const current = driverStatsForName(history, ourCarNumber, liveDriver(rows, ourCarNumber, history));
    const best = bestDriverByBestLap(history, ourCarNumber);
    const bic = ourCar.className ? bestCarByBestLap(history, ourCar.className, rows, conditionFilter) : null;
    const xic = selectedCarNumber ? statsForCar(history, rows, selectedCarNumber, conditionFilter) : null;
    return {
      mode: 'qualifying',
      columns: [
        { topLabel: 'Best team driver', topMs: best?.bestLapMs, bottomLabel: 'Last current', bottomMs: current?.lastLapMs, deltaLabel: 'Delta current vs best', deltaMs: subtract(current?.lastLapMs, best?.bestLapMs) },
        { topLabel: 'Best team driver', topMs: best?.bestLapMs, bottomLabel: 'Best current', bottomMs: current?.bestLapMs, deltaLabel: 'Delta current vs best', deltaMs: subtract(current?.bestLapMs, best?.bestLapMs) },
        { topLabel: 'Last team driver', topMs: best?.lastLapMs, bottomLabel: 'Last current', bottomMs: current?.lastLapMs, deltaLabel: 'Delta current vs team', deltaMs: subtract(current?.lastLapMs, best?.lastLapMs) },
        { topLabel: 'Best BIC', topMs: bic?.bestLapMs, bottomLabel: 'Last BIC', bottomMs: bic?.lastLapMs, deltaLabel: 'Delta best - last', deltaMs: subtract(bic?.lastLapMs, bic?.bestLapMs) },
        { topLabel: 'Best XIC', topMs: xic?.bestLapMs, bottomLabel: 'Last XIC', bottomMs: xic?.lastLapMs, deltaLabel: 'Delta best - last', deltaMs: subtract(xic?.lastLapMs, xic?.bestLapMs) }
      ]
    };
  }

  function buildComparisonView({ history = [], rows = [], ourCarNumber = '', selectedCarNumber = '', mode = 'race', conditionFilter = 'combined' } = {}) {
    const normalizedMode = normalizeMode(mode);
    const view = normalizedMode === 'qualifying'
      ? qualifyingComparisonView(history, rows, ourCarNumber, selectedCarNumber, conditionFilter)
      : { ...raceComparisonView(history, rows, ourCarNumber, selectedCarNumber, conditionFilter), mode: normalizedMode };
    return { ...view, matrix: comparisonMatrix(history, rows, ourCarNumber, selectedCarNumber, conditionFilter) };
  }

  function qualifyingAdjacentView(history, rows, ourCarNumber, options = {}) {
    const followed = (rows || []).find((row) => String(row.carNumber) === String(ourCarNumber));
    if (!followed?.className) return { available: false, mode: 'qualifying', ahead: null, behind: null };
    const classRows = rows
      .filter((row) => row.className === followed.className)
      .sort((a, b) => (Number(a.classPosition) || 999999) - (Number(b.classPosition) || 999999));
    const ourIndex = classRows.findIndex((row) => String(row.carNumber) === String(ourCarNumber));
    const conditionFilter = options.conditionFilter || 'combined';
    const ourBestLapMs = statsForCar(history, rows, ourCarNumber, conditionFilter).bestLapMs;
    const itemFor = (row) => {
      if (!row) return null;
      const rivalBestLapMs = statsForCar(history, rows, row.carNumber, conditionFilter).bestLapMs;
      const bestLapDeltaMs = subtract(rivalBestLapMs, ourBestLapMs);
      return {
        row,
        ourBestLapMs,
        rivalBestLapMs,
        bestLapDeltaMs,
        trendState: !Number.isFinite(bestLapDeltaMs) || bestLapDeltaMs === 0 ? 'neutral' : bestLapDeltaMs > 0 ? 'bad' : 'good'
      };
    };
    return {
      available: true,
      mode: 'qualifying',
      ahead: itemFor(ourIndex > 0 ? classRows[ourIndex - 1] : null),
      behind: itemFor(ourIndex >= 0 && ourIndex < classRows.length - 1 ? classRows[ourIndex + 1] : null)
    };
  }

  return {
    MODES,
    normalizeMode,
    subtract,
    bestDriverByBestLap,
    bestCarByBestLap,
    initials,
    shortDriverName,
    comparisonMatrix,
    buildComparisonView,
    qualifyingAdjacentView
  };
});
