// Persistent start/finish gap memory.
//
// Timing-page intervals can move on every poll while a car is between timing
// loops. This module commits a car's GAP/INT/DIFF only when its completed-lap
// marker changes, then derives class gaps from those confirmed per-car values.
(function initGapMemory(root, factory) {
  const battle = typeof module === 'object' && module.exports
    ? require('./classBattle')
    : root?.classBattle;
  const api = factory(battle);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gapMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createGapMemoryApi(classBattle) {
// Spa race one-step MAE: 3 laps 14.691s, 5 laps 14.644s, 10 laps 14.807s.
// Five laps was marginally best and reacts faster than a ten-lap window.
const DEFAULT_PACE_WINDOW = 5;
const DEFAULT_PIT_SUPPRESSION_LAPS = 5;
const MAX_SAMPLES = 5000;

function carKey(value) {
  return String(value ?? '');
}

function lapNumber(row) {
  const value = Number(row?.lapNumber ?? row?.laps);
  return Number.isFinite(value) ? value : null;
}

function isInPit(row) {
  return /^(in|in pit|pit)$/i.test(String(row?.state || '').trim());
}

function rowCrossed(previous, row) {
  if (!previous) return true;
  const nextLap = lapNumber(row);
  if (nextLap !== null && nextLap !== previous.lapNumber) return true;
  const lastLap = String(row?.lastLap || row?.lastLapMs || '');
  return nextLap === null && Boolean(lastLap) && lastLap !== previous.lastLap;
}

function representativeLapMs(rows) {
  const values = (rows || []).map((row) => classBattle.parseTimeToMs(row.lastLap) ?? Number(row.lastLapMs))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : null;
}

function confirmedRow(previous, rows, row, index, collectedAt, cumulative, averageLapMs) {
  if (!rowCrossed(previous, row)) return previous;
  const predecessor = index > 0 ? rows[index - 1] : null;
  const numericInterval = classBattle.parseGapToMs(row.diff)
    ?? classBattle.parseGapToMs(row.interval)
    ?? (!cumulative ? classBattle.parseGapToMs(row.gap) : null);
  const cumulativeMs = cumulative
    ? classBattle.cumulativeGapToLeaderMs(rows, row, averageLapMs)
    : null;
  return {
    carNumber: carKey(row.carNumber),
    className: row.className || '',
    classPosition: row.classPosition ?? '',
    overallPosition: row.position ?? '',
    lapNumber: lapNumber(row),
    lastLap: String(row.lastLap || row.lastLapMs || ''),
    predecessorCarNumber: predecessor ? carKey(predecessor.carNumber) : '',
    intervalToPreviousMs: Number.isFinite(numericInterval) ? numericInterval : null,
    cumulativeGapToLeaderMs: Number.isFinite(cumulativeMs) ? cumulativeMs : null,
    lapGapToLeader: cumulative ? classBattle.parseLapGap(row.gap) : null,
    source: cumulative ? 'cumulative-gap' : 'adjacent-interval-chain',
    sourceProvider: row.sourceProvider || '',
    confirmedAt: collectedAt
  };
}

function confirmedGapBetween(rows, confirmedCars, fromRow, toRow, averageLapMs) {
  const ordered = classBattle.overallSortedRows(rows);
  const fromIndex = ordered.findIndex((row) => carKey(row.carNumber) === carKey(fromRow?.carNumber));
  const toIndex = ordered.findIndex((row) => carKey(row.carNumber) === carKey(toRow?.carNumber));
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
  const from = confirmedCars[carKey(fromRow.carNumber)];
  const to = confirmedCars[carKey(toRow.carNumber)];
  if (!from || !to) return null;
  const lapGap = from.lapNumber !== null && to.lapNumber !== null
    ? Math.abs(from.lapNumber - to.lapNumber)
    : null;
  if (Number.isFinite(lapGap) && lapGap > 0) {
    return {
      gapMs: Number.isFinite(averageLapMs) ? lapGap * averageLapMs : null,
      lapGap,
      estimated: true,
      source: 'confirmed-lap-gap',
      confirmedAt: [from.confirmedAt, to.confirmedAt].sort().at(-1)
    };
  }
  if (Number.isFinite(from.cumulativeGapToLeaderMs) && Number.isFinite(to.cumulativeGapToLeaderMs)) {
    return {
      gapMs: Math.abs(to.cumulativeGapToLeaderMs - from.cumulativeGapToLeaderMs),
      lapGap: 0,
      estimated: false,
      source: 'confirmed-cumulative-gap',
      confirmedAt: [from.confirmedAt, to.confirmedAt].sort().at(-1)
    };
  }
  let totalMs = 0;
  for (let index = Math.min(fromIndex, toIndex) + 1; index <= Math.max(fromIndex, toIndex); index += 1) {
    const row = ordered[index];
    const state = confirmedCars[carKey(row.carNumber)];
    const expectedPredecessor = carKey(ordered[index - 1].carNumber);
    if (!state || state.predecessorCarNumber !== expectedPredecessor || !Number.isFinite(state.intervalToPreviousMs)) return null;
    totalMs += state.intervalToPreviousMs;
  }
  return {
    gapMs: totalMs,
    lapGap: 0,
    estimated: false,
    source: 'confirmed-interval-chain',
    confirmedAt: [from.confirmedAt, to.confirmedAt].sort().at(-1)
  };
}

function pairKey(followed, rival) {
  return `${carKey(followed)}|${carKey(rival)}`;
}

function buildView(rows, confirmedCars, followedCarNumber, pitByPair, options) {
  const followed = (rows || []).find((row) => carKey(row.carNumber) === carKey(followedCarNumber));
  if (!followed?.className) return { available: false, ahead: null, behind: null, classCoordinates: [] };
  const classRows = classBattle.classSortedRows(rows, followed.className);
  const ourIndex = classRows.findIndex((row) => carKey(row.carNumber) === carKey(followedCarNumber));
  const averageLapMs = representativeLapMs(classRows);
  const describe = (rival, relation) => {
    if (!rival) return null;
    const gap = confirmedGapBetween(rows, confirmedCars, followed, rival, averageLapMs);
    const pit = pitByPair[pairKey(followedCarNumber, rival.carNumber)] || {};
    const ourLap = lapNumber(followed) ?? confirmedCars[carKey(followedCarNumber)]?.lapNumber;
    const pitLaps = Number.isFinite(ourLap) && Number.isFinite(pit.sinceFollowedLap) ? Math.max(0, ourLap - pit.sinceFollowedLap) : 0;
    return {
      rivalCarNumber: carKey(rival.carNumber),
      relation,
      gapMs: gap?.gapMs ?? null,
      lapGap: gap?.lapGap ?? null,
      estimated: gap?.estimated ?? true,
      source: gap?.source || 'unavailable',
      confirmedAt: gap?.confirmedAt || null,
      suppressed: Boolean(pit.inPit && pitLaps >= options.pitSuppressionLaps),
      rivalInPit: Boolean(pit.inPit),
      rivalPitLaps: pitLaps
    };
  };
  const ahead = describe(ourIndex > 0 ? classRows[ourIndex - 1] : null, 'ahead');
  const behind = describe(ourIndex >= 0 && ourIndex < classRows.length - 1 ? classRows[ourIndex + 1] : null, 'behind');
  const classCoordinates = classRows.map((row) => {
    if (carKey(row.carNumber) === carKey(followedCarNumber)) return { carNumber: carKey(row.carNumber), gapToUsMs: 0, estimated: false };
    const relation = Number(row.classPosition) < Number(followed.classPosition) ? 'ahead' : 'behind';
    const gap = confirmedGapBetween(rows, confirmedCars, followed, row, averageLapMs);
    return {
      carNumber: carKey(row.carNumber),
      relation,
      gapToUsMs: Number.isFinite(gap?.gapMs) ? (relation === 'ahead' ? -gap.gapMs : gap.gapMs) : null,
      lapGap: gap?.lapGap ?? null,
      estimated: gap?.estimated ?? true,
      source: gap?.source || 'unavailable'
    };
  });
  return { available: true, followedCarNumber: carKey(followedCarNumber), ahead, behind, classCoordinates };
}

function updateGapMemory(previous = {}, input = {}) {
  const rows = classBattle.overallSortedRows(input.rows || []);
  const followedCars = (input.followedCars || []).map(carKey).filter(Boolean);
  const collectedAt = input.collectedAt || new Date().toISOString();
  const options = {
    paceWindow: Number(input.paceWindow) || DEFAULT_PACE_WINDOW,
    pitSuppressionLaps: Number(input.pitSuppressionLaps) || DEFAULT_PIT_SUPPRESSION_LAPS
  };
  const cumulative = classBattle.usesCumulativeGap(rows);
  const averageLapMs = representativeLapMs(rows);
  const confirmedCars = { ...(previous.confirmedCars || {}) };
  const committedCars = new Set();
  rows.forEach((row, index) => {
    const key = carKey(row.carNumber);
    const before = confirmedCars[key];
    const after = confirmedRow(before, rows, row, index, collectedAt, cumulative, averageLapMs);
    confirmedCars[key] = after;
    if (after !== before) committedCars.add(key);
  });

  const pitByPair = { ...(previous.pitByPair || {}) };
  followedCars.forEach((followedCar) => {
    const followed = rows.find((row) => carKey(row.carNumber) === followedCar);
    const followedLap = lapNumber(followed) ?? confirmedCars[followedCar]?.lapNumber;
    rows.forEach((rival) => {
      if (!followed || rival.className !== followed.className || carKey(rival.carNumber) === followedCar) return;
      const key = pairKey(followedCar, rival.carNumber);
      if (isInPit(rival)) {
        const existing = pitByPair[key];
        pitByPair[key] = existing?.inPit
          ? {
              ...existing,
              sinceFollowedLap: Number.isFinite(existing.sinceFollowedLap) ? existing.sinceFollowedLap : followedLap
            }
          : { inPit: true, sinceFollowedLap: followedLap, sinceAt: collectedAt };
      } else if (pitByPair[key]?.inPit) {
        pitByPair[key] = { inPit: false, sinceFollowedLap: null, resumedAt: collectedAt };
      }
    });
  });

  const viewsByCar = Object.fromEntries(followedCars.map((car) => [car, buildView(rows, confirmedCars, car, pitByPair, options)]));
  const newSamples = [];
  followedCars.forEach((followedCar) => {
    ['ahead', 'behind'].forEach((relation) => {
      const item = viewsByCar[followedCar]?.[relation];
      if (!item || (!committedCars.has(followedCar) && !committedCars.has(item.rivalCarNumber))) return;
      if (!Number.isFinite(item.gapMs) && !Number.isFinite(item.lapGap)) return;
      newSamples.push({
        key: pairKey(followedCar, item.rivalCarNumber),
        followedCarNumber: followedCar,
        rivalCarNumber: item.rivalCarNumber,
        relation,
        gapMs: item.gapMs,
        lapGap: item.lapGap,
        estimated: item.estimated,
        source: item.source,
        confirmedAt: item.confirmedAt || collectedAt
      });
    });
  });
  const sampleIds = new Set();
  const samples = [...(previous.samples || []), ...newSamples].filter((sample) => {
    const id = [sample.key, sample.relation, sample.confirmedAt, sample.gapMs, sample.lapGap].join('|');
    if (sampleIds.has(id)) return false;
    sampleIds.add(id);
    return true;
  }).slice(-MAX_SAMPLES);
  return {
    storageSchemaVersion: 1,
    updatedAt: collectedAt,
    sourceMode: cumulative ? 'cumulative-gap' : 'adjacent-interval-chain',
    paceWindow: options.paceWindow,
    pitSuppressionLaps: options.pitSuppressionLaps,
    confirmedCars,
    pitByPair,
    viewsByCar,
    samples,
    newSamples
  };
}

return {
  DEFAULT_PACE_WINDOW,
  DEFAULT_PIT_SUPPRESSION_LAPS,
  carKey,
  lapNumber,
  isInPit,
  rowCrossed,
  confirmedGapBetween,
  updateGapMemory
};
});
