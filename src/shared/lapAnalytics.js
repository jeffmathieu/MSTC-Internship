// Lap analytics module.
//
// This file is UMD-style so it can be used by Node tests with require() and by
// the renderer as window.lapAnalytics without a build step.
(function initLapAnalytics(root, factory) {
  const conditions = typeof module === 'object' && module.exports
    ? require('./trackConditions')
    : root?.trackConditions;
  const api = factory(conditions);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.lapAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createLapAnalyticsApi(trackConditions) {
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
    manualLapStatus: normalizedManualLapStatus(entry.manualLapStatus),
    paceEligible: boolOrNull(entry.paceEligible),
    sector1Eligible: boolOrNull(entry.sector1Eligible),
    sector2Eligible: boolOrNull(entry.sector2Eligible),
    sector3Eligible: boolOrNull(entry.sector3Eligible),
    trackCondition: trackConditions.normalizeTrackCondition(entry.trackCondition),
    lapCondition: trackConditions.deriveLapCondition(entry),
    conditionPhaseId: String(entry.conditionPhaseId || ''),
    sector1Condition: trackConditions.normalizeTrackCondition(entry.sector1Condition),
    sector2Condition: trackConditions.normalizeTrackCondition(entry.sector2Condition),
    sector3Condition: trackConditions.normalizeTrackCondition(entry.sector3Condition),
    sector1ConditionPhaseId: String(entry.sector1ConditionPhaseId || ''),
    sector2ConditionPhaseId: String(entry.sector2ConditionPhaseId || ''),
    sector3ConditionPhaseId: String(entry.sector3ConditionPhaseId || ''),
    pitInfo: String(entry.pitInfo ?? entry.pit ?? ''),
    lapPhase: String(entry.lapPhase ?? ''),
    isPitLap: boolOrNull(entry.isPitLap),
    recordedAt: entry.recordedAt || entry.collectedAt || ''
  };
}

function recordedTimeMs(lap) {
  const timestamp = lap?.recordedAt || lap?.collectedAt || '';
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function compareLapsChronologically(a, b) {
  const aTime = recordedTimeMs(a);
  const bTime = recordedTimeMs(b);
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
  const lapDelta = (a.lapNumber ?? 0) - (b.lapNumber ?? 0);
  if (lapDelta) return lapDelta;
  return 0;
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

function pitInfoShowsInPit(lap) {
  return /^p\d*$/i.test(String(lap?.pitInfo ?? lap?.pit ?? '').trim());
}

function normalizedManualLapStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['fcy', 'full-course-yellow', 'full course yellow'].includes(status)) return 'fcy';
  if (['sc', 'safety-car', 'safety car'].includes(status)) return 'sc';
  if (['track-limits', 'track limits', 'tracklimits'].includes(status)) return 'track-limits';
  if (['invalid', 'ongeldig', 'excluded', 'exclude'].includes(status)) return 'invalid';
  return '';
}

// Annotates old and new history without requiring a storage migration. Explicit
// in-pit rows queue the next completed lap as the outlap. Some providers update
// only the numeric PIT counter after the car has already left again; for that
// late signal, the previous completed lap is the inlap and the current completed
// lap is the outlap. Both remain stored but are excluded from pace.
function annotatePitPhases(laps) {
  const stateByCar = new Map();
  const annotated = [];
  laps.forEach((lap) => {
    const state = stateByCar.get(lap.carNumber) || { previousPitCount: null, nextIsOutlap: false, previousIndex: null, previousDriver: '', previousWasInPit: false };
    const pitCount = pitCountFromLap(lap);
    let lapPhase = lap.lapPhase;
    let isPitLap = lap.isPitLap;
    const driverName = String(lap.driverName || '').trim();
    const driverChanged = Boolean(driverName && state.previousDriver && driverName !== state.previousDriver);

    const pitCountIncreased = pitCount !== null && state.previousPitCount !== null && pitCount > state.previousPitCount;
    const explicitlyInPit = rowShowsInPit(lap) || (pitInfoShowsInPit(lap) && pitCountIncreased);
    const driverChangedAtPit = driverChanged && (pitCountIncreased || state.previousWasInPit);
    if (driverChangedAtPit && state.previousIndex !== null) {
      // A completed lap attributed to a new driver can only follow a stop. The
      // previous driver's final lap is the inlap and this first new-driver lap
      // is the outlap. This is stronger evidence than provider PIT counters,
      // which often increment only after the car has already left the pits.
      annotated[state.previousIndex] = {
        ...annotated[state.previousIndex],
        lapPhase: 'inlap',
        isPitLap: true
      };
      lapPhase = 'outlap';
      isPitLap = true;
      state.nextIsOutlap = false;
    } else if (!lapPhase && state.nextIsOutlap && !explicitlyInPit) {
      lapPhase = 'outlap';
      isPitLap = true;
      state.nextIsOutlap = false;
    }
    if (!driverChangedAtPit && explicitlyInPit) {
      lapPhase = 'inlap';
      isPitLap = true;
      state.nextIsOutlap = true;
    }
    if (!driverChangedAtPit && pitCountIncreased && !isPitLap) {
      // Most providers increment PIT after the car has completed the outlap.
      // In that case the previous completed lap is the inlap and the current
      // completed lap is the outlap. If an explicit IN state was seen earlier,
      // the previous branch already marked that row and queued this lap.
      if (state.previousIndex !== null) {
        annotated[state.previousIndex] = {
          ...annotated[state.previousIndex],
          lapPhase: 'inlap',
          isPitLap: true
        };
      }
      lapPhase = 'outlap';
      isPitLap = true;
      state.nextIsOutlap = false;
    }
    if (pitCount !== null) state.previousPitCount = pitCount;
    state.previousIndex = annotated.length;
    if (driverName) state.previousDriver = driverName;
    state.previousWasInPit = explicitlyInPit;
    stateByCar.set(lap.carNumber, state);
    annotated.push({ ...lap, lapPhase, isPitLap: isPitLap === true });
  });
  return annotated;
}

// Returns stable reason codes used by analytics JSON, tests and future reports.
// Keeping reasons here prevents each consumer inventing a different pace filter.
function baseLapExclusionReasons(lap) {
  const reasons = [];
  const manualStatus = normalizedManualLapStatus(lap?.manualLapStatus);
  if (manualStatus === 'track-limits') reasons.push('track-limits');
  if (manualStatus === 'invalid') reasons.push('manual-invalid');
  if (manualStatus === 'fcy' || manualStatus === 'sc') reasons.push('manual-neutralized');
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
  if (normalizedManualLapStatus(lap?.manualLapStatus)) return false;
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
  const conditionFilter = trackConditions.normalizeAnalysisFilter(options.conditionFilter, 'combined');
  const eligible = (laps || [])
    .filter((lap) => trackConditions.lapMatchesCondition(lap, conditionFilter))
    .filter(lapPaceEligible);
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
function sectorPaceEligible(lap, sectorNumber, options = {}) {
  if (pitAffectedLap(lap)) return false;
  if (normalizedManualLapStatus(lap?.manualLapStatus)) return false;
  const conditionFilter = trackConditions.normalizeAnalysisFilter(options.conditionFilter, 'combined');
  if (!trackConditions.sectorMatchesCondition(lap, sectorNumber, conditionFilter)) return false;
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
    .sort(compareLapsChronologically);
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
function statsForLaps(laps, options = {}) {
  const conditionFilter = trackConditions.normalizeAnalysisFilter(options.conditionFilter, 'combined');
  const sortedAll = [...laps].sort(compareLapsChronologically);
  const lapCandidates = conditionFilter === 'combined'
    ? sortedAll
    : sortedAll.filter((lap) => trackConditions.lapMatchesCondition(lap, conditionFilter));
  const rawPaceLaps = lapCandidates.filter(lapPaceEligible);
  const paceLaps = representativePaceLaps(lapCandidates, { ...options, conditionFilter });
  const paceLapSet = new Set(paceLaps);
  const rawPaceLapSet = new Set(rawPaceLaps);
  const lapTimes = paceLaps.map((lap) => lap.lapTimeMs);
  const sectorValues = (sectorNumber) => sortedAll
    .filter((lap) => sectorPaceEligible(lap, sectorNumber, { conditionFilter }))
    .map((lap) => lap[`sector${sectorNumber}Ms`]);
  const excludedLaps = lapCandidates.filter((lap) => !paceLapSet.has(lap)).map((lap) => ({
    lapNumber: lap.lapNumber,
    lapTimeMs: lap.lapTimeMs,
    reasons: rawPaceLapSet.has(lap) ? ['timing-outlier'] : baseLapExclusionReasons(lap)
  }));
  const excludedByReason = excludedLaps.reduce((counts, lap) => {
    lap.reasons.forEach((reason) => { counts[reason] = (counts[reason] || 0) + 1; });
    return counts;
  }, {});
  const sectorSelection = (sectorNumber) => {
    const included = sortedAll.filter((lap) => sectorPaceEligible(lap, sectorNumber, { conditionFilter }) && numberOrNull(lap[`sector${sectorNumber}Ms`]) !== null);
    return {
      includedCount: included.length,
      excludedCount: sortedAll.length - included.length
    };
  };
  return {
    lapCount: lapCandidates.length,
    conditionFilter,
    conditionCounts: trackConditions.conditionCounts(sortedAll),
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
    laps: lapCandidates
  };
}

// Returns separate pace summaries without blending wet and dry performance.
// "combined" remains available for descriptive race totals, but live models
// should select the current condition explicitly.
function statsByCondition(laps) {
  return Object.fromEntries(['dry', 'wet', 'transition', 'combined'].map((conditionFilter) => [
    conditionFilter,
    statsForLaps(laps, { conditionFilter })
  ]));
}

// Groups one car's laps by driver name and returns stats for each driver/stint.
function driverStats(history, carNumber, options = {}) {
  const groups = new Map();
  lapsForCar(history, carNumber).forEach((lap) => {
    const driver = lap.driverName || 'Unknown';
    if (!groups.has(driver)) groups.set(driver, []);
    groups.get(driver).push(lap);
  });

  return [...groups.entries()].map(([driverName, laps]) => ({
    driverName,
    carNumber: String(carNumber),
    ...statsForLaps(laps, options)
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
function bestDriverByAverage(history, carNumber, options = {}) {
  return driverStats(history, carNumber, options)
    .filter((stats) => stats.averageLapMs !== null)
    .sort((a, b) => a.averageLapMs - b.averageLapMs)[0] || null;
}

// Compares the current driver with the best-average driver in the same car.
// Deltas are current minus reference: positive means the current driver is slower.
function compareBestDriverToCurrentDriver(history, carNumber, explicitCurrentDriverName = '', options = {}) {
  const currentName = currentDriverName(history, carNumber, explicitCurrentDriverName);
  const current = driverStats(history, carNumber, options).find((stats) => stats.driverName === currentName) || null;
  const best = bestDriverByAverage(history, carNumber, options);
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
function carStats(history, carNumber, options = {}) {
  const laps = lapsForCar(history, carNumber);
  const base = statsForLaps(laps, options);
  return {
    carNumber: String(carNumber),
    className: laps[0]?.className || '',
    teamName: laps[0]?.teamName || '',
    ...base
  };
}

// Returns stats for every car with at least one completed lap in the class.
function carsInClass(history, className, options = {}) {
  const carNumbers = new Set(completedLaps(history).filter((lap) => lap.className === className).map((lap) => lap.carNumber));
  return [...carNumbers].map((carNumber) => carStats(history, carNumber, options));
}

// Finds the best-in-class car by average lap time.
function bestCarInClassByAverage(history, className, options = {}) {
  return carsInClass(history, className, options)
    .filter((stats) => stats.averageLapMs !== null)
    .sort((a, b) => a.averageLapMs - b.averageLapMs)[0] || null;
}

// Returns only the final contiguous block for the active driver. A driver can
// return later in the race, so filtering every lap by name would incorrectly
// merge two separate stints into the current-stint comparison.
function currentStintStats(history, carNumber, currentDriver = '', options = {}) {
  const driver = currentDriverName(history, carNumber, currentDriver);
  const carLaps = lapsForCar(history, carNumber);
  const driverKey = String(driver || '').trim().toLocaleLowerCase();
  const latestDriverKey = String(carLaps.at(-1)?.driverName || '').trim().toLocaleLowerCase();
  const currentLaps = driverKey && driverKey === latestDriverKey
    ? carLaps.slice(carLaps.findLastIndex((lap, index) => index === 0
      || String(carLaps[index - 1]?.driverName || '').trim().toLocaleLowerCase() !== driverKey))
    : [];
  return {
    driverName: driver,
    carNumber: String(carNumber),
    ...statsForLaps(currentLaps, options)
  };
}

// Compares our current stint/driver average with the best car in class and an
// optional selected class car. Deltas are our current stint average minus target
// car average: positive means our current stint is slower.
function compareCarToClassTargets(history, ourCarNumber, selectedCarNumber = '', currentDriver = '', options = {}) {
  const ourCar = carStats(history, ourCarNumber, options);
  const ourCurrentStint = currentStintStats(history, ourCarNumber, currentDriver, options);
  const bestClassCar = ourCar.className ? bestCarInClassByAverage(history, ourCar.className, options) : null;
  const selectedCar = selectedCarNumber ? carStats(history, selectedCarNumber, options) : null;

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
    conditionFilter: trackConditions.normalizeAnalysisFilter(options.conditionFilter, 'combined'),
    currentDriverName: currentDriver,
    driverComparison: compareBestDriverToCurrentDriver(history, ourCarNumber, currentDriver, options),
    classComparison: compareCarToClassTargets(history, ourCarNumber, options.selectedCarNumber || '', currentDriver, options)
  };
}

return {
  numberOrNull,
  average,
  median,
  isNeutralizedFlag,
  normalizedManualLapStatus,
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
  statsByCondition,
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
