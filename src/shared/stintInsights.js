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

function formatSeconds(valueMs) {
  return Number.isFinite(valueMs) ? `${Math.abs(valueMs / 1000).toFixed(3)}s` : '-';
}

function formatLapTime(valueMs) {
  if (!Number.isFinite(valueMs)) return '-';
  const totalMs = Math.round(valueMs);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return minutes ? `${minutes}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}` : `${seconds}.${String(ms).padStart(3, '0')}s`;
}

function validLapPhases(validLaps = []) {
  if (!validLaps.length) return [];
  const size = Math.ceil(validLaps.length / 3);
  return [
    validLaps.slice(0, size),
    validLaps.slice(size, size * 2),
    validLaps.slice(size * 2)
  ].filter((phase) => phase.length).map((phase) => {
    const values = phase.map((lap) => lap.lapTimeMs).filter(Number.isFinite);
    return {
      startLap: phase[0]?.lapNumber,
      endLap: phase.at(-1)?.lapNumber,
      averageLapMs: average(values),
      consistencyMs: standardDeviation(values),
      lapCount: values.length
    };
  });
}

function phaseLabel(phase) {
  if (!phase) return 'laps -';
  return phase.startLap === phase.endLap ? `lap ${phase.startLap}` : `laps ${phase.startLap}-${phase.endLap}`;
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

function buildCoachingSummary(validLaps = [], sectorValues = [], stats = {}) {
  if (!validLaps.length) return ['No valid pace laps available for coaching yet.'];

  const messages = [];
  const sectorLosses = sectorValues.map((values, index) => {
    const sectorAverage = average(values);
    const sectorBest = values.length ? Math.min(...values) : null;
    return {
      sector: index + 1,
      lossMs: Number.isFinite(sectorAverage) && Number.isFinite(sectorBest) ? sectorAverage - sectorBest : null
    };
  }).filter((item) => Number.isFinite(item.lossMs));
  const mainLoss = sectorLosses.sort((a, b) => b.lossMs - a.lossMs)[0];
  if (mainLoss && mainLoss.lossMs > 250) {
    messages.push(`Main time loss was S${mainLoss.sector}: avg ${formatSeconds(mainLoss.lossMs)} from best.`);
  } else {
    messages.push('Sector spread was balanced; no clear main loss sector.');
  }

  const trend = stats.paceTrendMsPerLap;
  if (Number.isFinite(trend)) {
    if (trend < -150) messages.push(`Pace improved through the stint by ${formatSeconds(trend)}/lap.`);
    else if (trend > 150) messages.push(`Pace faded through the stint by ${formatSeconds(trend)}/lap.`);
    else messages.push('Pace stayed stable through the stint.');
  }

  const phases = validLapPhases(validLaps);
  const bestPhase = phases.filter((phase) => Number.isFinite(phase.averageLapMs))
    .sort((a, b) => a.averageLapMs - b.averageLapMs)[0];
  if (bestPhase) {
    messages.push(`Best phase: ${phaseLabel(bestPhase)} at ${formatLapTime(bestPhase.averageLapMs)} avg.`);
  }

  const consistentPhase = phases.filter((phase) => phase.lapCount >= 2 && Number.isFinite(phase.consistencyMs))
    .sort((a, b) => a.consistencyMs - b.consistencyMs)[0];
  if (consistentPhase) {
    messages.push(`Most consistent: ${phaseLabel(consistentPhase)} (${formatSeconds(consistentPhase.consistencyMs)} stdev).`);
  }

  return messages.slice(0, 4);
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
  const baseInsights = {
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
  return {
    ...baseInsights,
    coachingSummary: buildCoachingSummary(validLaps, sectorValues, baseInsights)
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
  buildCoachingSummary,
  buildStintInsights,
  classComparisonsForStint,
  classRankingForStint
};
