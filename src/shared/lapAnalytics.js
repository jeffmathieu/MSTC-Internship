// Lap analytics module.
//
// This file is UMD-style so it can be used by Node tests with require() and by
// the renderer as window.lapAnalytics without a build step.
(function initLapAnalytics(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.lapAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createLapAnalyticsApi() {
// This module works on saved lap history records, not live DOM rows. It accepts
// both the new normalized storage fields (driverName, teamName, lapTimeMs) and
// older in-memory fields (driver, team, lastLapMs), so existing dashboard state
// and future storage exports can use the same calculations.

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const usable = values.map(numberOrNull).filter((value) => value !== null);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function min(values) {
  const usable = values.map(numberOrNull).filter((value) => value !== null);
  return usable.length ? Math.min(...usable) : null;
}

function boolOrNull(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function isNeutralizedFlag(value) {
  const text = String(value || '').toLowerCase();
  return /safety\s*car|full\s*course\s*yellow|\bfcy\b|code\s*60|yellow/.test(text);
}

function isGreenFlag(value) {
  const text = String(value || '').toLowerCase();
  return !text || /green/.test(text);
}

function normalizeLap(entry) {
  const lapTimeMs = numberOrNull(entry.lapTimeMs ?? entry.lastLapMs);
  const sessionFlag = String(entry.sessionFlag ?? entry.flagState ?? entry.lapFlag ?? '');
  return {
    ...entry,
    carNumber: String(entry.carNumber ?? ''),
    className: String(entry.className ?? ''),
    teamName: String(entry.teamName ?? entry.team ?? ''),
    driverName: String(entry.driverName ?? entry.driver ?? ''),
    lapNumber: numberOrNull(entry.lapNumber),
    lapTimeMs,
    lastLapMs: lapTimeMs,
    sector1Ms: numberOrNull(entry.sector1Ms),
    sector2Ms: numberOrNull(entry.sector2Ms),
    sector3Ms: numberOrNull(entry.sector3Ms),
    sessionFlag,
    lapFlag: String(entry.lapFlag ?? sessionFlag),
    sector1Flag: String(entry.sector1Flag ?? ''),
    sector2Flag: String(entry.sector2Flag ?? ''),
    sector3Flag: String(entry.sector3Flag ?? ''),
    paceEligible: boolOrNull(entry.paceEligible),
    sector1Eligible: boolOrNull(entry.sector1Eligible),
    sector2Eligible: boolOrNull(entry.sector2Eligible),
    sector3Eligible: boolOrNull(entry.sector3Eligible),
    recordedAt: entry.recordedAt || entry.collectedAt || ''
  };
}

function lapPaceEligible(lap) {
  const explicit = boolOrNull(lap.paceEligible);
  if (explicit !== null) return explicit;
  return !isNeutralizedFlag(lap.lapFlag || lap.sessionFlag);
}

function sectorPaceEligible(lap, sectorNumber) {
  const explicit = boolOrNull(lap[`sector${sectorNumber}Eligible`]);
  if (explicit !== null) return explicit;

  const sectorFlag = lap[`sector${sectorNumber}Flag`];
  if (sectorFlag) return isGreenFlag(sectorFlag) && !isNeutralizedFlag(sectorFlag);

  // If the exact sector flag is unknown, fall back to the lap/session flag. This
  // is conservative: a lap marked FCY excludes all sectors unless the sector has
  // its own explicit green/eligible marker.
  return lapPaceEligible(lap);
}

function completedLaps(history) {
  return (history || [])
    .map(normalizeLap)
    .filter((lap) => lap.carNumber && lap.lapTimeMs !== null)
    .sort((a, b) => {
      const lapDelta = (a.lapNumber ?? 0) - (b.lapNumber ?? 0);
      if (lapDelta) return lapDelta;
      return new Date(a.recordedAt || 0) - new Date(b.recordedAt || 0);
    });
}

function lapsForCar(history, carNumber) {
  return completedLaps(history).filter((lap) => lap.carNumber === String(carNumber));
}

function lapsForDriver(history, carNumber, driverName) {
  return lapsForCar(history, carNumber).filter((lap) => lap.driverName === driverName);
}

function statsForLaps(laps) {
  const sorted = [...laps].sort((a, b) => {
    const lapDelta = (a.lapNumber ?? 0) - (b.lapNumber ?? 0);
    if (lapDelta) return lapDelta;
    return new Date(a.recordedAt || 0) - new Date(b.recordedAt || 0);
  });
  const paceLaps = sorted.filter(lapPaceEligible);
  const lapTimes = paceLaps.map((lap) => lap.lapTimeMs);
  const sectorValues = (sectorNumber) => sorted
    .filter((lap) => sectorPaceEligible(lap, sectorNumber))
    .map((lap) => lap[`sector${sectorNumber}Ms`]);
  return {
    lapCount: sorted.length,
    paceLapCount: paceLaps.length,
    averageLapMs: average(lapTimes),
    bestLapMs: min(lapTimes),
    lastLapMs: paceLaps.length ? paceLaps.at(-1).lapTimeMs : null,
    averageSector1Ms: average(sectorValues(1)),
    averageSector2Ms: average(sectorValues(2)),
    averageSector3Ms: average(sectorValues(3)),
    bestSector1Ms: min(sectorValues(1)),
    bestSector2Ms: min(sectorValues(2)),
    bestSector3Ms: min(sectorValues(3)),
    laps: sorted
  };
}

function driverStats(history, carNumber) {
  const groups = new Map();
  lapsForCar(history, carNumber).forEach((lap) => {
    const driver = lap.driverName || 'Unknown';
    if (!groups.has(driver)) groups.set(driver, []);
    groups.get(driver).push(lap);
  });

  return [...groups.entries()].map(([driverName, laps]) => ({
    driverName,
    carNumber: String(carNumber),
    ...statsForLaps(laps)
  }));
}

function currentDriverName(history, carNumber, explicitDriverName = '') {
  if (explicitDriverName) return explicitDriverName;
  const laps = lapsForCar(history, carNumber);
  return laps.length ? laps.at(-1).driverName : '';
}

function bestDriverByAverage(history, carNumber) {
  return driverStats(history, carNumber)
    .filter((stats) => stats.averageLapMs !== null)
    .sort((a, b) => a.averageLapMs - b.averageLapMs)[0] || null;
}

// Compares the current driver with the best-average driver in the same car.
// Deltas are current minus reference: positive means the current driver is slower.
function compareBestDriverToCurrentDriver(history, carNumber, explicitCurrentDriverName = '') {
  const currentName = currentDriverName(history, carNumber, explicitCurrentDriverName);
  const current = driverStats(history, carNumber).find((stats) => stats.driverName === currentName) || null;
  const best = bestDriverByAverage(history, carNumber);
  if (!current || !best) return null;

  return {
    carNumber: String(carNumber),
    bestDriver: best,
    currentDriver: current,
    deltas: {
      bestDriverBestLapToCurrentLastLapMs: current.lastLapMs === null || best.bestLapMs === null ? null : current.lastLapMs - best.bestLapMs,
      bestDriverBestLapToCurrentBestLapMs: current.bestLapMs === null || best.bestLapMs === null ? null : current.bestLapMs - best.bestLapMs,
      bestDriverAverageToCurrentAverageMs: current.averageLapMs === null || best.averageLapMs === null ? null : current.averageLapMs - best.averageLapMs
    }
  };
}

function carStats(history, carNumber) {
  const laps = lapsForCar(history, carNumber);
  const base = statsForLaps(laps);
  return {
    carNumber: String(carNumber),
    className: laps[0]?.className || '',
    teamName: laps[0]?.teamName || '',
    ...base
  };
}

function carsInClass(history, className) {
  const carNumbers = new Set(completedLaps(history).filter((lap) => lap.className === className).map((lap) => lap.carNumber));
  return [...carNumbers].map((carNumber) => carStats(history, carNumber));
}

function bestCarInClassByAverage(history, className) {
  return carsInClass(history, className)
    .filter((stats) => stats.averageLapMs !== null)
    .sort((a, b) => a.averageLapMs - b.averageLapMs)[0] || null;
}

function currentStintStats(history, carNumber, currentDriver = '') {
  const driver = currentDriverName(history, carNumber, currentDriver);
  return {
    driverName: driver,
    carNumber: String(carNumber),
    ...statsForLaps(lapsForDriver(history, carNumber, driver))
  };
}

// Compares our current stint/driver average with the best car in class and an
// optional selected class car. Deltas are our current stint average minus target
// car average: positive means our current stint is slower.
function compareCarToClassTargets(history, ourCarNumber, selectedCarNumber = '') {
  const ourCar = carStats(history, ourCarNumber);
  const ourCurrentStint = currentStintStats(history, ourCarNumber);
  const bestClassCar = ourCar.className ? bestCarInClassByAverage(history, ourCar.className) : null;
  const selectedCar = selectedCarNumber ? carStats(history, selectedCarNumber) : null;

  const deltaTo = (target) => {
    if (!target || ourCurrentStint.averageLapMs === null || target.averageLapMs === null) return null;
    return ourCurrentStint.averageLapMs - target.averageLapMs;
  };

  return {
    ourCar,
    ourCurrentStint,
    bestClassCar,
    selectedCar,
    deltas: {
      currentStintAverageToBestClassCarAverageMs: deltaTo(bestClassCar),
      currentStintAverageToSelectedCarAverageMs: deltaTo(selectedCar)
    }
  };
}

function buildDashboardAnalysis(history, options = {}) {
  const ourCarNumber = options.ourCarNumber || '';
  if (!ourCarNumber) return null;
  const currentDriver = currentDriverName(history, ourCarNumber, options.currentDriverName || '');
  return {
    ourCarNumber: String(ourCarNumber),
    selectedCarNumber: options.selectedCarNumber ? String(options.selectedCarNumber) : '',
    currentDriverName: currentDriver,
    driverComparison: compareBestDriverToCurrentDriver(history, ourCarNumber, currentDriver),
    classComparison: compareCarToClassTargets(history, ourCarNumber, options.selectedCarNumber || '')
  };
}

return {
  numberOrNull,
  average,
  isNeutralizedFlag,
  lapPaceEligible,
  sectorPaceEligible,
  normalizeLap,
  completedLaps,
  lapsForCar,
  lapsForDriver,
  statsForLaps,
  driverStats,
  bestDriverByAverage,
  compareBestDriverToCurrentDriver,
  carStats,
  carsInClass,
  bestCarInClassByAverage,
  currentStintStats,
  compareCarToClassTargets,
  buildDashboardAnalysis
};
});
