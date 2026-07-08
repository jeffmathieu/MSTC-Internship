// Lap-time prediction module.
//
// The prediction is intentionally small and explainable: use the sectors already
// driven in the current lap, then fill missing sectors with the recent average
// for the same driver in the same car. Keeping this rule isolated means the
// future norm-time warning can depend on this output without changing renderer
// code or the storage layer.
const { parseLapTimeToMs } = require('./parser');
const {
  completedLaps,
  currentDriverName,
  sectorPaceEligible,
  average,
  numberOrNull
} = require('./lapAnalytics');
const {
  normalizeTrackCondition,
  sectorMatchesCondition
} = require('./trackConditions');

const DEFAULT_OPTIONS = {
  // Ten laps is a practical compromise for endurance racing: it reacts to tyre,
  // fuel, traffic and weather changes without being dominated by one noisy lap.
  sampleSize: 10
};

function liveSectorMs(row, sectorNumber) {
  return numberOrNull(row?.[`sector${sectorNumber}Ms`]) ?? parseLapTimeToMs(row?.[`sector${sectorNumber}`]);
}

function currentSectorUsable(row, sectorNumber, condition = 'combined') {
  const explicit = row?.[`sector${sectorNumber}Eligible`];
  if (explicit === false || explicit === 'false' || explicit === 0 || explicit === '0') return false;
  const flag = String(row?.[`sector${sectorNumber}Flag`] || row?.lapFlag || row?.sessionFlag || '');
  if (/safety\s*car|full\s*course\s*yellow|\bfcy\b|code\s*60|yellow|red\s*flag|\bred\b/i.test(flag)) return false;
  return condition === 'combined' || sectorMatchesCondition(row, sectorNumber, condition);
}

function sortLapsChronologically(laps) {
  return [...laps].sort((a, b) => {
    const aLap = numberOrNull(a.lapNumber) ?? 0;
    const bLap = numberOrNull(b.lapNumber) ?? 0;
    if (aLap !== bLap) return aLap - bLap;
    return new Date(a.recordedAt || a.collectedAt || 0) - new Date(b.recordedAt || b.collectedAt || 0);
  });
}

// Returns the most recent valid sector values for one driver. Sector validity is
// checked per sector, so an FCY in sector 3 does not throw away sector 1 and 2.
function recentDriverSectorValues(history, carNumber, driverName, sectorNumber, sampleSize = DEFAULT_OPTIONS.sampleSize, options = {}) {
  const condition = options.condition || 'combined';
  return sortLapsChronologically(completedLaps(history))
    .filter((lap) => lap.carNumber === String(carNumber) && lap.driverName === driverName)
    .filter((lap) => sectorPaceEligible(lap, sectorNumber, { conditionFilter: condition }))
    .map((lap) => numberOrNull(lap[`sector${sectorNumber}Ms`]))
    .filter((value) => value !== null)
    .slice(-sampleSize);
}

function weightedAverage(values) {
  if (!values.length) return null;
  const weighted = values.reduce((result, value, index) => ({
    total: result.total + value * (index + 1),
    weight: result.weight + index + 1
  }), { total: 0, weight: 0 });
  return weighted.total / weighted.weight;
}

function recentCarSectorValues(history, carNumber, sectorNumber, sampleSize, condition) {
  return sortLapsChronologically(completedLaps(history))
    .filter((lap) => lap.carNumber === String(carNumber))
    .filter((lap) => sectorPaceEligible(lap, sectorNumber, { conditionFilter: condition }))
    .map((lap) => numberOrNull(lap[`sector${sectorNumber}Ms`]))
    .filter((value) => value !== null)
    .slice(-sampleSize);
}

function recentDriverSectorAverages(history, carNumber, driverName, options = {}) {
  const sampleSize = Math.max(1, Math.floor(options.sampleSize || DEFAULT_OPTIONS.sampleSize));
  const condition = options.condition || 'combined';
  const sectors = [1, 2, 3].map((sectorNumber) => {
    let values = recentDriverSectorValues(history, carNumber, driverName, sectorNumber, sampleSize, { condition });
    let modelScope = 'driver';
    if (!values.length && condition !== 'combined') {
      values = recentCarSectorValues(history, carNumber, sectorNumber, sampleSize, condition);
      modelScope = values.length ? 'car' : 'none';
    }
    return {
      sectorNumber,
      sampleCount: values.length,
      averageMs: condition === 'combined' ? average(values) : weightedAverage(values),
      modelScope,
      values
    };
  });
  return {
    driverName,
    carNumber: String(carNumber),
    condition,
    sampleSize,
    sectors
  };
}

function followedLiveRow(rows, carNumber) {
  return (rows || []).find((row) => String(row.carNumber) === String(carNumber)) || null;
}

// Builds the prediction for the current live lap. No prediction is returned
// until at least sector 1 has been driven and every missing sector has a recent
// same-driver average. S3 is deliberately not allowed to update predictedLapMs:
// once S3 exists the lap is effectively done, so S3 is only used to calculate
// actualLapMs and predictionDeltaMs. This lets the dashboard keep showing what
// we predicted after S1/S2 and compare it with what really happened.
function buildLapPrediction({ history = [], rows = [], carNumber = '', currentDriver = '', options = {} } = {}) {
  const row = followedLiveRow(rows, carNumber);
  const driverName = currentDriver || row?.driver || row?.driverName || currentDriverName(history, carNumber);
  if (!row || !carNumber) {
    return { available: false, reason: 'No live row for followed car', carNumber: String(carNumber || ''), driverName: driverName || '' };
  }
  if (!driverName) {
    return { available: false, reason: 'No current driver yet', carNumber: String(carNumber), driverName: '' };
  }

  const currentCondition = options.currentCondition
    ? normalizeTrackCondition(options.currentCondition)
    : normalizeTrackCondition(row.trackCondition);
  const predictionCondition = currentCondition === 'unknown' ? 'combined' : currentCondition;
  const averages = recentDriverSectorAverages(history, carNumber, driverName, {
    ...options,
    condition: predictionCondition
  });
  const liveSectors = [1, 2, 3].map((sectorNumber) => {
    const liveMs = liveSectorMs(row, sectorNumber);
    return {
      sectorNumber,
      valueMs: liveMs,
      usable: liveMs !== null && currentSectorUsable(row, sectorNumber, predictionCondition)
    };
  });
  const sectorParts = [1, 2, 3].map((sectorNumber) => {
    const averageInfo = averages.sectors[sectorNumber - 1];
    const liveInfo = liveSectors[sectorNumber - 1];
    // Only S1/S2 are prediction inputs. S3 is kept as an average input so the
    // predicted value stays frozen while the actual-vs-predicted delta appears.
    const useLive = sectorNumber < 3 && liveInfo.usable;
    return {
      sectorNumber,
      source: useLive ? 'live' : 'average',
      valueMs: useLive ? liveInfo.valueMs : averageInfo.averageMs,
      sampleCount: averageInfo.sampleCount
    };
  });

  if (!liveSectors[0].usable) {
    const reason = currentCondition === 'transition'
      ? 'Transition lap: waiting for condition-specific sector 1'
      : 'Waiting for sector 1';
    return { available: false, reason, carNumber: String(carNumber), driverName, condition: predictionCondition, averages, sectors: sectorParts };
  }

  const missingAverage = sectorParts.find((part) => part.valueMs === null);
  if (missingAverage) {
    return {
      available: false,
      reason: `Need sector ${missingAverage.sectorNumber} history for ${driverName}`,
      carNumber: String(carNumber),
      driverName,
      condition: predictionCondition,
      averages,
      sectors: sectorParts
    };
  }

  const predictedLapMs = sectorParts.reduce((sum, part) => sum + part.valueMs, 0);
  const completedSectorCount = sectorParts.filter((part) => part.source === 'live').length;
  const actualLapMs = liveSectors.every((sector) => sector.usable)
    ? liveSectors.reduce((sum, sector) => sum + sector.valueMs, 0)
    : null;
  return {
    available: true,
    carNumber: String(carNumber),
    driverName,
    condition: predictionCondition,
    predictedLapMs,
    actualLapMs,
    predictionDeltaMs: actualLapMs === null ? null : actualLapMs - predictedLapMs,
    completedSectorCount,
    label: `After S${completedSectorCount}`,
    sampleSize: averages.sampleSize,
    sectors: sectorParts,
    averages
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  recentDriverSectorValues,
  recentDriverSectorAverages,
  weightedAverage,
  buildLapPrediction
};
