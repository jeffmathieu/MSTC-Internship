// Session-mode calculations shared by main-process analytics and tests.
// The renderer consumes the returned labels/values and performs no race math.
(function initSessionMode(root, factory) {
  const analytics = typeof module === 'object' && module.exports
    ? require('./lapAnalytics')
    : root?.lapAnalytics;
  const api = factory(analytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.sessionMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createSessionModeApi(lapAnalytics) {
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
    return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map((part) => part[0].toUpperCase()).join('') || '—';
  }

  function shortDriverName(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    const uppercase = parts.filter((part) => /[A-Z]/.test(part) && part === part.toUpperCase());
    return uppercase.join(' ') || initials(name);
  }

  function metric(label, current, reference) {
    return { label, valueMs: Number.isFinite(current) ? current : null, referenceMs: Number.isFinite(reference) ? reference : null, deltaMs: subtract(current, reference) };
  }

  // BIC/XIC columns display the target car's absolute time while retaining the
  // dashboard-wide delta contract: our time minus their time.
  function targetMetric(label, ourValue, targetValue) {
    return { label, valueMs: Number.isFinite(targetValue) ? targetValue : null, referenceMs: Number.isFinite(targetValue) ? targetValue : null, deltaMs: subtract(ourValue, targetValue) };
  }

  function sectorAverages(displaySource, ourReference = null) {
    return [1, 2, 3].map((sector) => ({
      label: `S${sector}`,
      averageMs: Number.isFinite(displaySource?.[`averageSector${sector}Ms`]) ? displaySource[`averageSector${sector}Ms`] : null,
      deltaMs: ourReference ? subtract(ourReference?.[`averageSector${sector}Ms`], displaySource?.[`averageSector${sector}Ms`]) : null,
      showDelta: Boolean(ourReference)
    }));
  }

  function lapNumberFromRow(row) {
    const value = Number(row?.lapNumber ?? row?.laps ?? row?.lap ?? row?.LAPS);
    return Number.isFinite(value) ? value : null;
  }

  function isRunningClassRow(row, classLeaderLap) {
    const state = String(row?.state || row?.status || '').trim().toLowerCase();
    if (/\b(ret|dnf|dns|out|stop|finished|finish|disq|dq)\b/.test(state)) return false;
    const pitLike = /\b(p|pit|in pit)\b/.test(state) || /in pit/i.test(String(row?.eta || row?.pitStatus || ''));
    const lap = lapNumberFromRow(row);
    if (pitLike && Number.isFinite(classLeaderLap) && Number.isFinite(lap) && classLeaderLap - lap >= 5) return false;
    return true;
  }

  function classCarsForComparison(history, rows, ourCarNumber, ourReference) {
    const ourRow = (rows || []).find((row) => String(row.carNumber) === String(ourCarNumber));
    const ourCar = ourReference || lapAnalytics.carStats(history, ourCarNumber);
    const className = ourRow?.className || ourCar.className;
    if (!className) return [];
    const classRows = (rows || [])
      .filter((row) => row.className === className)
      .sort((a, b) => (Number(a.classPosition) || 999999) - (Number(b.classPosition) || 999999));
    const classLeaderLap = Math.max(...classRows.map(lapNumberFromRow).filter(Number.isFinite));
    const activeRows = classRows.filter((row) => isRunningClassRow(row, classLeaderLap));
    const bic = lapAnalytics.bestCarInClassByAverage(history, className);

    return activeRows.map((row) => {
      const stats = lapAnalytics.carStats(history, row.carNumber);
      const drivers = lapAnalytics.driverStats(history, row.carNumber);
      return {
        carNumber: String(row.carNumber || stats.carNumber || ''),
        classPosition: row.classPosition || '',
        teamName: row.team || row.teamName || stats.teamName || '',
        isOurCar: String(row.carNumber) === String(ourCarNumber),
        isBic: bic && String(row.carNumber) === String(bic.carNumber),
        metrics: [
          targetMetric('Best', ourCar.bestLapMs, stats.bestLapMs),
          targetMetric('Last', ourCar.lastLapMs, stats.lastLapMs),
          targetMetric('Last 10', recentAverage(ourCar), recentAverage(stats))
        ],
        totalAverageMs: stats.averageLapMs,
        totalAverageDeltaMs: subtract(ourCar.averageLapMs, stats.averageLapMs),
        averages: averageRows(drivers, ourCar.averageLapMs, true),
        sectors: sectorAverages(stats, ourCar)
      };
    });
  }

  function averageRows(stats = [], comparisonMs = null, comparisonFirst = true) {
    return stats.map((driver) => ({
      label: initials(driver.driverName),
      valueMs: driver.averageLapMs,
      deltaMs: comparisonFirst
        ? subtract(comparisonMs, driver.averageLapMs)
        : subtract(driver.averageLapMs, comparisonMs)
    }));
  }

  function comparisonMatrix(history, rows, ourCarNumber, selectedCarNumber) {
    const ourCar = lapAnalytics.carStats(history, ourCarNumber);
    const current = driverStatsForName(history, ourCarNumber, liveDriver(rows, ourCarNumber, history));
    const best = lapAnalytics.bestDriverByAverage(history, ourCarNumber);
    const bic = ourCar.className ? lapAnalytics.bestCarInClassByAverage(history, ourCar.className) : null;
    const xic = selectedCarNumber ? lapAnalytics.carStats(history, selectedCarNumber) : null;
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
      totalAverageDeltaMs: subtract(ourCar.averageLapMs, target?.averageLapMs),
      averages: averageRows(target ? lapAnalytics.driverStats(history, target.carNumber) : [], ourCar.averageLapMs, true),
      sectors: sectorAverages(target, ourCar)
    });
    return {
      ourCarNumber: String(ourCarNumber || ''),
      teammate: {
        kind: 'teammate',
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
      },
      bic: column(bic, 'bic'),
      xic: column(xic, 'xic'),
      classCars: classCarsForComparison(history, rows, ourCarNumber, ourCar)
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

  function bestCarByBestLap(history, className) {
    return lapAnalytics.carsInClass(history, className)
      .filter((car) => Number.isFinite(car.bestLapMs))
      .sort((a, b) => a.bestLapMs - b.bestLapMs)[0] || null;
  }

  function targetCurrentDriverStats(history, rows, target) {
    if (!target) return null;
    return driverStatsForName(history, target.carNumber, liveDriver(rows, target.carNumber, history));
  }

  function raceComparisonView(history, rows, ourCarNumber, selectedCarNumber) {
    const ourCar = lapAnalytics.carStats(history, ourCarNumber);
    const current = driverStatsForName(history, ourCarNumber, liveDriver(rows, ourCarNumber, history));
    const best = lapAnalytics.bestDriverByAverage(history, ourCarNumber);
    const bic = ourCar.className ? lapAnalytics.bestCarInClassByAverage(history, ourCar.className) : null;
    const xic = selectedCarNumber ? lapAnalytics.carStats(history, selectedCarNumber) : null;
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

  function qualifyingComparisonView(history, rows, ourCarNumber, selectedCarNumber) {
    const ourCar = lapAnalytics.carStats(history, ourCarNumber);
    const current = driverStatsForName(history, ourCarNumber, liveDriver(rows, ourCarNumber, history));
    const best = bestDriverByBestLap(history, ourCarNumber);
    const bic = ourCar.className ? bestCarByBestLap(history, ourCar.className) : null;
    const xic = selectedCarNumber ? lapAnalytics.carStats(history, selectedCarNumber) : null;
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

  function buildComparisonView({ history = [], rows = [], ourCarNumber = '', selectedCarNumber = '', mode = 'race' } = {}) {
    const normalizedMode = normalizeMode(mode);
    const view = normalizedMode === 'qualifying'
      ? qualifyingComparisonView(history, rows, ourCarNumber, selectedCarNumber)
      : { ...raceComparisonView(history, rows, ourCarNumber, selectedCarNumber), mode: normalizedMode };
    return { ...view, matrix: comparisonMatrix(history, rows, ourCarNumber, selectedCarNumber) };
  }

  function qualifyingAdjacentView(history, rows, ourCarNumber) {
    const followed = (rows || []).find((row) => String(row.carNumber) === String(ourCarNumber));
    if (!followed?.className) return { available: false, mode: 'qualifying', ahead: null, behind: null };
    const classRows = rows
      .filter((row) => row.className === followed.className)
      .sort((a, b) => (Number(a.classPosition) || 999999) - (Number(b.classPosition) || 999999));
    const ourIndex = classRows.findIndex((row) => String(row.carNumber) === String(ourCarNumber));
    const ourBestLapMs = lapAnalytics.carStats(history, ourCarNumber).bestLapMs;
    const itemFor = (row) => {
      if (!row) return null;
      const rivalBestLapMs = lapAnalytics.carStats(history, row.carNumber).bestLapMs;
      const bestLapDeltaMs = subtract(ourBestLapMs, rivalBestLapMs);
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
