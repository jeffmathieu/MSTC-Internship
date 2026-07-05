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

// Safely reads numeric storage values. Empty strings are common in CSV/JSONL
// exports and must mean "missing", not zero.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Averages only valid numeric values. Returning null makes the UI show "—" until
// there is enough usable race data.
function average(values) {
  const usable = values.map(numberOrNull).filter((value) => value !== null);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

// Finds the minimum valid value for best laps/sectors.
function min(values) {
  const usable = values.map(numberOrNull).filter((value) => value !== null);
  return usable.length ? Math.min(...usable) : null;
}

function median(values) {
  const usable = values.map(numberOrNull).filter((value) => value !== null).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

// Reads booleans stored as booleans, numbers, or CSV strings.
function boolOrNull(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

// Detects race-control states where lap times should be stored but excluded
// from pace averages.
function isNeutralizedFlag(value) {
  const text = String(value || '').toLowerCase();
  return /safety\s*car|full\s*course\s*yellow|\bfcy\b|code\s*60|yellow|red\s*flag|\bred\b/.test(text);
}

// Treats empty flags as green because most timing pages only show exceptional
// states. Explicit sector/lap flags can still override this.
function isGreenFlag(value) {
  const text = String(value || '').toLowerCase();
  return !text || /green/.test(text);
}

// Captures the global race-control flag when a sector value first appears in a
// live row. Unchanged values keep their original flag until the completed lap
// is stored, even if race control changes later in the same lap.
function captureSectorFlags(row, previous = null, currentFlag = '') {
  const annotated = { ...row };
  const sectorValues = [1, 2, 3].map((sectorNumber) => row[`sector${sectorNumber}`]);
  const activeSectorNumber = sectorValues.findIndex((value) => !value) + 1;
  [1, 2, 3].forEach((sectorNumber) => {
    const valueKey = `sector${sectorNumber}`;
    const flagKey = `sector${sectorNumber}Flag`;
    const eligibleKey = `sector${sectorNumber}Eligible`;
    const previousValue = previous?.[valueKey] || '';
    const previousFlag = previous?.[flagKey] || '';
    const sameObservedValue = Boolean(row[valueKey]) && row[valueKey] === previousValue;
    const completedPendingSector = Boolean(row[valueKey]) && !previousValue && Boolean(previousFlag);
    const isActiveSector = activeSectorNumber === sectorNumber;

    // A neutralization can begin before the active sector has a visible time.
    // Persist that pending flag now, then keep it when the sector time appears.
    // Once any part of a sector was neutralized, a later green flag must not
    // make that sector eligible again.
    const pendingNeutralization = isActiveSector && isNeutralizedFlag(previousFlag);
    let observedFlag = row[flagKey] || '';
    if (!observedFlag && isNeutralizedFlag(previousFlag) && (sameObservedValue || completedPendingSector || pendingNeutralization)) observedFlag = previousFlag;
    if (!observedFlag && sameObservedValue) observedFlag = previousFlag;
    if (!observedFlag && isNeutralizedFlag(currentFlag) && (isActiveSector || row[valueKey])) observedFlag = currentFlag;
    if (!observedFlag && completedPendingSector) observedFlag = previousFlag;
    if (!observedFlag && (isActiveSector || row[valueKey])) observedFlag = currentFlag;
    if (!row[valueKey] && !isActiveSector) return;
    annotated[flagKey] = observedFlag || '';
    if (row[eligibleKey] === '' || row[eligibleKey] === null || row[eligibleKey] === undefined || isNeutralizedFlag(observedFlag)) {
      annotated[eligibleKey] = observedFlag ? String(!isNeutralizedFlag(observedFlag)) : '';
    }
  });
  return annotated;
}

// Converts any saved lap-like object into the canonical analytics shape. This
// keeps old exports, current memory state, and future storage schema changes
// compatible with the same calculations.
function normalizeLap(entry) {
  const lapTimeMs = numberOrNull(entry.lapTimeMs ?? entry.lastLapMs);
  const sector1Ms = numberOrNull(entry.sector1Ms);
  const sector2Ms = numberOrNull(entry.sector2Ms);
  let sector3Ms = numberOrNull(entry.sector3Ms);
  // Older RIS history created before current-row sector reconciliation can miss
  // only S3. Recover it from LAST - S1 - S2 when the result is positive and a
  // plausible fraction of the lap; the original JSONL record remains untouched.
  if (sector3Ms === null && entry.sourceProvider === 'ris-timing' && lapTimeMs !== null && sector1Ms !== null && sector2Ms !== null) {
    const derived = lapTimeMs - sector1Ms - sector2Ms;
    if (derived >= 5000 && derived <= lapTimeMs * 0.6) sector3Ms = derived;
  }
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
    sector1Ms,
    sector2Ms,
    sector3Ms,
    sessionFlag,
    lapFlag: String(entry.lapFlag ?? sessionFlag),
    sector1Flag: String(entry.sector1Flag ?? ''),
    sector2Flag: String(entry.sector2Flag ?? ''),
    sector3Flag: String(entry.sector3Flag ?? ''),
    paceEligible: boolOrNull(entry.paceEligible),
    sector1Eligible: boolOrNull(entry.sector1Eligible),
    sector2Eligible: boolOrNull(entry.sector2Eligible),
    sector3Eligible: boolOrNull(entry.sector3Eligible),
    pitInfo: String(entry.pitInfo ?? entry.pit ?? ''),
    lapPhase: String(entry.lapPhase ?? ''),
    isPitLap: boolOrNull(entry.isPitLap),
    recordedAt: entry.recordedAt || entry.collectedAt || ''
  };
}

// Reads the cumulative PIT counter saved with each lap. Text such as "P2" or
// "stops 2" is accepted; status-only values remain unknown.
function pitCountFromLap(lap) {
  const match = String(lap?.pitInfo ?? lap?.pit ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function pitAffectedLap(lap) {
  return lap?.isPitLap === true || /^(inlap|outlap)$/i.test(String(lap?.lapPhase || ''));
}

function rowShowsInPit(lap) {
  return /^(in|in pit|pit)$/i.test(String(lap?.state || '').trim());
}

// Annotates old and new history without requiring a storage migration. A PIT
// counter increase marks the just-completed lap as the pit/inlap and the next
// completed lap as the outlap. Both remain stored but are excluded from pace.
function annotatePitPhases(laps) {
  const stateByCar = new Map();
  return laps.map((lap) => {
    const state = stateByCar.get(lap.carNumber) || { previousPitCount: null, nextIsOutlap: false };
    const pitCount = pitCountFromLap(lap);
    let lapPhase = lap.lapPhase;
    let isPitLap = lap.isPitLap;

    const explicitlyInPit = rowShowsInPit(lap);
    if (!lapPhase && state.nextIsOutlap && !explicitlyInPit) {
      lapPhase = 'outlap';
      isPitLap = true;
      state.nextIsOutlap = false;
    }
    if (explicitlyInPit) {
      lapPhase = 'inlap';
      isPitLap = true;
      state.nextIsOutlap = true;
    }
    if (pitCount !== null && state.previousPitCount !== null && pitCount > state.previousPitCount && !isPitLap) {
      // Providers differ on when PIT increments. Without an explicit IN state,
      // conservatively exclude this lap and the next one.
      lapPhase = 'inlap';
      isPitLap = true;
      state.nextIsOutlap = true;
    }
    if (pitCount !== null) state.previousPitCount = pitCount;
    stateByCar.set(lap.carNumber, state);
    return { ...lap, lapPhase, isPitLap: isPitLap === true };
  });
}

// Returns stable reason codes used by analytics JSON, tests and future reports.
// Keeping reasons here prevents each consumer inventing a different pace filter.
function baseLapExclusionReasons(lap) {
  const reasons = [];
  if (lap?.lapPhase === 'inlap' || rowShowsInPit(lap)) reasons.push('pit-in');
  else if (lap?.lapPhase === 'outlap') reasons.push('pit-out');
  else if (pitAffectedLap(lap)) reasons.push('pit-affected');
  if ([lap?.lapFlag, lap?.sessionFlag, lap?.sector1Flag, lap?.sector2Flag, lap?.sector3Flag].some(isNeutralizedFlag)) reasons.push('neutralized');
  if (boolOrNull(lap?.paceEligible) === false) reasons.push('explicitly-ineligible');
  if (!Number.isFinite(numberOrNull(lap?.lapTimeMs))) reasons.push('missing-lap-time');
  return [...new Set(reasons)];
}

// Decides whether a full lap should count for lap-time pace statistics. Explicit
// paceEligible fields win; otherwise neutralized race-control flags exclude it.
function lapPaceEligible(lap) {
  // Hard exclusions always win over a stale/incorrect explicit true value.
  // One neutralized sector means the complete lap was not fully green.
  if (pitAffectedLap(lap)) return false;
  if ([lap.lapFlag, lap.sessionFlag, lap.sector1Flag, lap.sector2Flag, lap.sector3Flag].some(isNeutralizedFlag)) return false;
  const explicit = boolOrNull(lap.paceEligible);
  if (explicit !== null) return explicit;
  return true;
}

// Removes only extreme timing-feed anomalies from pace calculations. The
// default requires at least three green/pit-free samples and rejects a lap only
// when it differs from their median by both 60 seconds and 50%. This catches a
// session-elapsed value such as 35:05 among 2:53 laps without discarding normal
// traffic, mistakes, or a roughly one-minute wet-weather pace change.
function representativePaceLaps(laps, options = {}) {
  const eligible = (laps || []).filter(lapPaceEligible);
  const minimumSamples = Number.isFinite(Number(options.minimumSamples)) ? Number(options.minimumSamples) : 3;
  if (eligible.length < minimumSamples) return eligible;

  const baselineMs = median(eligible.map((lap) => lap.lapTimeMs));
  if (!Number.isFinite(baselineMs) || baselineMs <= 0) return eligible;
  const absoluteThresholdMs = Number.isFinite(Number(options.absoluteThresholdMs))
    ? Number(options.absoluteThresholdMs)
    : 60000;
  const relativeThreshold = Number.isFinite(Number(options.relativeThreshold))
    ? Number(options.relativeThreshold)
    : 0.5;
  const allowedDeviationMs = Math.max(absoluteThresholdMs, baselineMs * relativeThreshold);
  return eligible.filter((lap) => {
    if (Math.abs(lap.lapTimeMs - baselineMs) <= allowedDeviationMs) return true;

    // A complete sectorsum is stronger evidence than a statistical threshold:
    // spins, rain, and other genuine slow laps must remain part of the average.
    const sectors = [lap.sector1Ms, lap.sector2Ms, lap.sector3Ms].map(numberOrNull);
    if (sectors.some((value) => value === null)) return false;
    const sectorSumMs = sectors.reduce((sum, value) => sum + value, 0);
    const reconciliationToleranceMs = Math.max(2000, lap.lapTimeMs * 0.02);
    return Math.abs(sectorSumMs - lap.lapTimeMs) <= reconciliationToleranceMs;
  });
}

// Decides whether one sector should count for sector averages/bests. This is
// deliberately more granular than lapPaceEligible: a lap can become FCY in S3
// while S1/S2 remain valid.
function sectorPaceEligible(lap, sectorNumber) {
  if (pitAffectedLap(lap)) return false;
  const explicit = boolOrNull(lap[`sector${sectorNumber}Eligible`]);
  const sectorFlag = lap[`sector${sectorNumber}Flag`];
  if (isNeutralizedFlag(sectorFlag)) return false;
  if (explicit !== null) return explicit;
  if (sectorFlag) return isGreenFlag(sectorFlag) && !isNeutralizedFlag(sectorFlag);

  // If the exact sector flag is unknown, fall back to the lap/session flag. This
  // is conservative: a lap marked FCY excludes all sectors unless the sector has
  // its own explicit green/eligible marker.
  return lapPaceEligible(lap);
}

// Returns all completed laps sorted chronologically enough for averages and
// "last lap" values. Invalid/no-car rows are dropped here.
function completedLaps(history) {
  const sorted = (history || [])
    .map(normalizeLap)
    .filter((lap) => lap.carNumber && lap.lapTimeMs !== null)
    .sort((a, b) => {
      const lapDelta = (a.lapNumber ?? 0) - (b.lapNumber ?? 0);
      if (lapDelta) return lapDelta;
      return new Date(a.recordedAt || 0) - new Date(b.recordedAt || 0);
    });
  return annotatePitPhases(sorted);
}

// Convenience filter for all completed laps of one car.
function lapsForCar(history, carNumber) {
  return completedLaps(history).filter((lap) => lap.carNumber === String(carNumber));
}

// Convenience filter for one driver's laps in one car.
function lapsForDriver(history, carNumber, driverName) {
  return lapsForCar(history, carNumber).filter((lap) => lap.driverName === driverName);
}

// Calculates all lap/sector statistics from a set of laps. Full-lap averages
// use only pace-eligible laps; sector averages use sector-level eligibility.
function statsForLaps(laps) {
  const sorted = [...laps].sort((a, b) => {
    const lapDelta = (a.lapNumber ?? 0) - (b.lapNumber ?? 0);
    if (lapDelta) return lapDelta;
    return new Date(a.recordedAt || 0) - new Date(b.recordedAt || 0);
  });
  const rawPaceLaps = sorted.filter(lapPaceEligible);
  const paceLaps = representativePaceLaps(sorted);
  const paceLapSet = new Set(paceLaps);
  const rawPaceLapSet = new Set(rawPaceLaps);
  const lapTimes = paceLaps.map((lap) => lap.lapTimeMs);
  const sectorValues = (sectorNumber) => sorted
    .filter((lap) => sectorPaceEligible(lap, sectorNumber))
    .map((lap) => lap[`sector${sectorNumber}Ms`]);
  const excludedLaps = sorted.filter((lap) => !paceLapSet.has(lap)).map((lap) => ({
    lapNumber: lap.lapNumber,
    lapTimeMs: lap.lapTimeMs,
    reasons: rawPaceLapSet.has(lap) ? ['timing-outlier'] : baseLapExclusionReasons(lap)
  }));
  const excludedByReason = excludedLaps.reduce((counts, lap) => {
    lap.reasons.forEach((reason) => { counts[reason] = (counts[reason] || 0) + 1; });
    return counts;
  }, {});
  const sectorSelection = (sectorNumber) => {
    const included = sorted.filter((lap) => sectorPaceEligible(lap, sectorNumber) && numberOrNull(lap[`sector${sectorNumber}Ms`]) !== null);
    return {
      includedCount: included.length,
      excludedCount: sorted.length - included.length
    };
  };
  return {
    lapCount: sorted.length,
    paceLapCount: paceLaps.length,
    excludedOutlierLapCount: rawPaceLaps.length - paceLaps.length,
    averageLapMs: average(lapTimes),
    bestLapMs: min(lapTimes),
    lastLapMs: paceLaps.length ? paceLaps.at(-1).lapTimeMs : null,
    averageSector1Ms: average(sectorValues(1)),
    averageSector2Ms: average(sectorValues(2)),
    averageSector3Ms: average(sectorValues(3)),
    bestSector1Ms: min(sectorValues(1)),
    bestSector2Ms: min(sectorValues(2)),
    bestSector3Ms: min(sectorValues(3)),
    selection: {
      lap: {
        includedCount: paceLaps.length,
        excludedCount: excludedLaps.length,
        excludedByReason,
        excludedLaps
      },
      sectors: {
        sector1: sectorSelection(1),
        sector2: sectorSelection(2),
        sector3: sectorSelection(3)
      }
    },
    laps: sorted
  };
}

// Groups one car's laps by driver name and returns stats for each driver/stint.
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

// Chooses the current driver from the explicit live row when available, or from
// the latest stored lap as a fallback.
function currentDriverName(history, carNumber, explicitDriverName = '') {
  if (explicitDriverName) return explicitDriverName;
  const laps = lapsForCar(history, carNumber);
  return laps.length ? laps.at(-1).driverName : '';
}

// Finds the driver with the lowest average lap time in one car. This is used as
// D1/reference driver in the dashboard comparison boxes.
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

// Returns aggregate pace statistics for one car, including class/team metadata
// from its first stored lap.
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

// Returns stats for every car with at least one completed lap in the class.
function carsInClass(history, className) {
  const carNumbers = new Set(completedLaps(history).filter((lap) => lap.className === className).map((lap) => lap.carNumber));
  return [...carNumbers].map((carNumber) => carStats(history, carNumber));
}

// Finds the best-in-class car by average lap time.
function bestCarInClassByAverage(history, className) {
  return carsInClass(history, className)
    .filter((stats) => stats.averageLapMs !== null)
    .sort((a, b) => a.averageLapMs - b.averageLapMs)[0] || null;
}

// Current stint is currently approximated as all laps for the active driver in
// the car. If stint IDs become reliable later, narrow the filter here.
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
function compareCarToClassTargets(history, ourCarNumber, selectedCarNumber = '', currentDriver = '') {
  const ourCar = carStats(history, ourCarNumber);
  const ourCurrentStint = currentStintStats(history, ourCarNumber, currentDriver);
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

// Builds the compact analytics object consumed by main.js/renderer. Keeping this
// shape stable makes UI changes possible without touching calculation details.
function buildDashboardAnalysis(history, options = {}) {
  const ourCarNumber = options.ourCarNumber || '';
  if (!ourCarNumber) return null;
  const currentDriver = currentDriverName(history, ourCarNumber, options.currentDriverName || '');
  return {
    ourCarNumber: String(ourCarNumber),
    selectedCarNumber: options.selectedCarNumber ? String(options.selectedCarNumber) : '',
    currentDriverName: currentDriver,
    driverComparison: compareBestDriverToCurrentDriver(history, ourCarNumber, currentDriver),
    classComparison: compareCarToClassTargets(history, ourCarNumber, options.selectedCarNumber || '', currentDriver)
  };
}

return {
  numberOrNull,
  average,
  median,
  isNeutralizedFlag,
  captureSectorFlags,
  lapPaceEligible,
  representativePaceLaps,
  sectorPaceEligible,
  normalizeLap,
  pitCountFromLap,
  pitAffectedLap,
  rowShowsInPit,
  annotatePitPhases,
  baseLapExclusionReasons,
  completedLaps,
  lapsForCar,
  lapsForDriver,
  statsForLaps,
  driverStats,
  currentDriverName,
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
