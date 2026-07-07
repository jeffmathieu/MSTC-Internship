// Post-stint engineering insights shared by automatic and batch PDF reports.
// Every pace metric uses lapAnalytics eligibility rules, so pit, neutralized
// and timing-outlier samples cannot leak into report comparisons.
const lapAnalytics = require('./lapAnalytics');

function average(values = []) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function standardDeviation(values = []) {
  const mean = average(values);
  if (!Number.isFinite(mean)) return null;
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function sumFinite(values = []) {
  return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) : null;
}

function paceSlope(values = []) {
  if (values.length < 2) return null;
  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : null;
}

function phaseAverages(values = []) {
  if (!values.length) return { firstMs: null, middleMs: null, finalMs: null };
  const size = Math.ceil(values.length / 3);
  return {
    firstMs: average(values.slice(0, size)),
    middleMs: average(values.slice(size, size * 2)),
    finalMs: average(values.slice(size * 2))
  };
}

function personalBestProgression(laps = []) {
  let best = Infinity;
  return laps.reduce((progression, lap) => {
    if (Number.isFinite(lap.lapTimeMs) && lap.lapTimeMs < best) {
      best = lap.lapTimeMs;
      progression.push({ lapNumber: lap.lapNumber, lapTimeMs: lap.lapTimeMs });
    }
    return progression;
  }, []);
}

function compliance(values = [], referenceMs = null) {
  const usable = values.filter(Number.isFinite);
  if (!Number.isFinite(referenceMs) || referenceMs <= 0) {
    return { known: false, referenceMs: null, sampleCount: usable.length, compliantCount: usable.length, violationCount: 0, label: 'OK - reference not set' };
  }
  const compliantCount = usable.filter((value) => value >= referenceMs).length;
  return {
    known: true,
    referenceMs,
    sampleCount: usable.length,
    compliantCount,
    violationCount: usable.length - compliantCount,
    label: `${compliantCount}/${usable.length} safe`
  };
}

function buildStintInsights(laps = [], referenceTimes = {}) {
  const normalizedLaps = lapAnalytics.completedLaps(laps);
  const validLaps = lapAnalytics.representativePaceLaps(normalizedLaps);
  const lapValues = validLaps.map((lap) => lap.lapTimeMs).filter(Number.isFinite);
  const sectorValues = [1, 2, 3].map((sector) => normalizedLaps
    .filter((lap) => lapAnalytics.sectorPaceEligible(lap, sector))
    .map((lap) => lap[`sector${sector}Ms`])
    .filter(Number.isFinite));
  const bestSectors = sectorValues.map((values) => values.length ? Math.min(...values) : null);
  const averageSectors = sectorValues.map(average);
  const firstFiveMs = average(lapValues.slice(0, 5));
  const lastFiveMs = average(lapValues.slice(-5));
  const deviationMs = standardDeviation(lapValues);
  const lapAverageMs = average(lapValues);
  return {
    consistency: {
      standardDeviationMs: deviationMs,
      coefficientPercent: Number.isFinite(deviationMs) && Number.isFinite(lapAverageMs) && lapAverageMs > 0 ? deviationMs / lapAverageMs * 100 : null
    },
    paceTrendMsPerLap: paceSlope(lapValues),
    bestTheoreticalLapMs: sumFinite(bestSectors),
    averageTheoreticalLapMs: sumFinite(averageSectors),
    stintPhases: phaseAverages(lapValues),
    firstFiveMs,
    lastFiveMs,
    firstVsLastFiveDeltaMs: Number.isFinite(firstFiveMs) && Number.isFinite(lastFiveMs) ? lastFiveMs - firstFiveMs : null,
    personalBestProgression: personalBestProgression(validLaps),
    compliance: {
      lap: compliance(lapValues, Number(referenceTimes.lapMs)),
      sector1: compliance(sectorValues[0], Number(referenceTimes.sector1Ms)),
      sector2: compliance(sectorValues[1], Number(referenceTimes.sector2Ms)),
      sector3: compliance(sectorValues[2], Number(referenceTimes.sector3Ms))
    }
  };
}

function timestamp(lap) {
  const value = new Date(lap?.recordedAt || lap?.collectedAt || 0).getTime();
  return Number.isFinite(value) ? value : null;
}

function classComparisonsForStint(history = [], stintLaps = [], ourCarNumber = '', className = '') {
  const normalizedStintLaps = lapAnalytics.completedLaps(stintLaps);
  const times = normalizedStintLaps.map(timestamp).filter(Number.isFinite);
  if (!times.length || !className) return [];
  const start = Math.min(...times);
  const end = Math.max(...times);
  const ourStats = lapAnalytics.statsForLaps(normalizedStintLaps);
  const grouped = new Map();
  lapAnalytics.completedLaps(history).forEach((lap) => {
    const at = timestamp(lap);
    if (lap.className !== className || lap.carNumber === String(ourCarNumber) || !Number.isFinite(at) || at < start || at > end) return;
    if (!grouped.has(lap.carNumber)) grouped.set(lap.carNumber, []);
    grouped.get(lap.carNumber).push(lap);
  });
  return [...grouped.entries()].map(([carNumber, laps]) => {
    const stats = lapAnalytics.statsForLaps(laps);
    return {
      carNumber,
      teamName: laps[0]?.teamName || '',
      driverNames: [...new Set(laps.map((lap) => lap.driverName).filter(Boolean))],
      lapCount: stats.lapCount,
      paceLapCount: stats.paceLapCount,
      averageLapMs: stats.averageLapMs,
      bestLapMs: stats.bestLapMs,
      averageDeltaMs: Number.isFinite(ourStats.averageLapMs) && Number.isFinite(stats.averageLapMs) ? ourStats.averageLapMs - stats.averageLapMs : null,
      bestDeltaMs: Number.isFinite(ourStats.bestLapMs) && Number.isFinite(stats.bestLapMs) ? ourStats.bestLapMs - stats.bestLapMs : null
    };
  }).sort((a, b) => (a.averageLapMs ?? Infinity) - (b.averageLapMs ?? Infinity));
}

function classRankingForStint(stintLaps = [], comparisons = []) {
  const ourStats = lapAnalytics.statsForLaps(lapAnalytics.completedLaps(stintLaps));
  const entries = [
    { carNumber: 'our car', averageLapMs: ourStats.averageLapMs, bestLapMs: ourStats.bestLapMs },
    ...(comparisons || [])
  ];
  const rankFor = (key) => {
    const ranked = entries.filter((entry) => Number.isFinite(entry[key])).sort((a, b) => a[key] - b[key]);
    const rank = ranked.findIndex((entry) => entry.carNumber === 'our car');
    const leader = ranked[0] || null;
    return {
      rank: rank >= 0 ? rank + 1 : null,
      total: ranked.length,
      leaderCarNumber: leader?.carNumber || '',
      deltaToLeaderMs: rank >= 0 && leader ? ranked[rank][key] - leader[key] : null
    };
  };
  return { average: rankFor('averageLapMs'), best: rankFor('bestLapMs') };
}

module.exports = {
  average,
  standardDeviation,
  paceSlope,
  phaseAverages,
  personalBestProgression,
  compliance,
  buildStintInsights,
  classComparisonsForStint,
  classRankingForStint
};
