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
        { topLabel: 'Best D1', topMs: best?.bestLapMs, bottomLabel: 'Last D2', bottomMs: current?.lastLapMs, deltaLabel: 'Delta D1 - D2', deltaMs: subtract(best?.bestLapMs, current?.lastLapMs) },
        { topLabel: 'Best D1', topMs: best?.bestLapMs, bottomLabel: 'Best D2', bottomMs: current?.bestLapMs, deltaLabel: 'Delta D1 - D2', deltaMs: subtract(best?.bestLapMs, current?.bestLapMs) },
        { topLabel: 'Average D1', topMs: best?.averageLapMs, bottomLabel: 'Average D2', bottomMs: current?.averageLapMs, deltaLabel: 'Delta D1 - D2', deltaMs: subtract(best?.averageLapMs, current?.averageLapMs) },
        { targetCarNumber: bic?.carNumber || '', topScope: 'car', bottomScope: 'current-driver', topLabel: 'Average BIC', topMs: bic?.averageLapMs, bottomLabel: 'Average Dact', bottomMs: bicDriver?.averageLapMs, deltaLabel: 'Delta BIC - Dact', deltaMs: subtract(bic?.averageLapMs, bicDriver?.averageLapMs) },
        { targetCarNumber: xic?.carNumber || '', topScope: 'car', bottomScope: 'current-driver', topLabel: 'Average XIC', topMs: xic?.averageLapMs, bottomLabel: 'Average Dact', bottomMs: xicDriver?.averageLapMs, deltaLabel: 'Delta XIC - Dact', deltaMs: subtract(xic?.averageLapMs, xicDriver?.averageLapMs) }
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
        { topLabel: 'Best team driver', topMs: best?.bestLapMs, bottomLabel: 'Last current', bottomMs: current?.lastLapMs, deltaLabel: 'Delta best - last', deltaMs: subtract(best?.bestLapMs, current?.lastLapMs) },
        { topLabel: 'Best team driver', topMs: best?.bestLapMs, bottomLabel: 'Best current', bottomMs: current?.bestLapMs, deltaLabel: 'Delta best - best', deltaMs: subtract(best?.bestLapMs, current?.bestLapMs) },
        { topLabel: 'Last team driver', topMs: best?.lastLapMs, bottomLabel: 'Last current', bottomMs: current?.lastLapMs, deltaLabel: 'Delta last - last', deltaMs: subtract(best?.lastLapMs, current?.lastLapMs) },
        { topLabel: 'Best BIC', topMs: bic?.bestLapMs, bottomLabel: 'Last BIC', bottomMs: bic?.lastLapMs, deltaLabel: 'Delta best - last', deltaMs: subtract(bic?.lastLapMs, bic?.bestLapMs) },
        { topLabel: 'Best XIC', topMs: xic?.bestLapMs, bottomLabel: 'Last XIC', bottomMs: xic?.lastLapMs, deltaLabel: 'Delta best - last', deltaMs: subtract(xic?.lastLapMs, xic?.bestLapMs) }
      ]
    };
  }

  function buildComparisonView({ history = [], rows = [], ourCarNumber = '', selectedCarNumber = '', mode = 'race' } = {}) {
    const normalizedMode = normalizeMode(mode);
    if (normalizedMode === 'qualifying') return qualifyingComparisonView(history, rows, ourCarNumber, selectedCarNumber);
    return { ...raceComparisonView(history, rows, ourCarNumber, selectedCarNumber), mode: normalizedMode };
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
      const bestLapDeltaMs = subtract(rivalBestLapMs, ourBestLapMs);
      return {
        row,
        ourBestLapMs,
        rivalBestLapMs,
        bestLapDeltaMs,
        trendState: !Number.isFinite(bestLapDeltaMs) || bestLapDeltaMs === 0 ? 'neutral' : bestLapDeltaMs > 0 ? 'good' : 'bad'
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
    buildComparisonView,
    qualifyingAdjacentView
  };
});
