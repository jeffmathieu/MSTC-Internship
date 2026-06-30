// Pitstop planning module.
//
// This file is UMD-style so Node tests and the renderer/main process can share
// the exact same calculations. The renderer should only render this output; race
// rules and projections belong here so they can be tested in isolation.
(function initPitstopPlanner(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.pitstopPlanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createPitstopPlannerApi() {
const DEFAULT_RULES = {
  raceDurationMs: 24 * 60 * 60 * 1000,
  pitClosedStartMs: 25 * 60 * 1000,
  pitClosedEndMs: 25 * 60 * 1000,
  pitCooldownMs: 25 * 60 * 1000,
  pitStopDurationMs: 75 * 1000,
  requiredPitStops: 2,
  nearWindowLaps: 2,
  averageLapMs: null,
  circuitId: 'zolder',
  regularTrackDistanceMeters: null,
  fcySpeedKph: 60,
  fcyStablePollsRequired: 3,
  fcyMinimumAgeMs: 15 * 1000
};

// Converts optional numeric inputs into a real number or null. Most planner
// inputs come from UI fields or parsed timing text, so this keeps callers from
// accidentally treating empty strings as zero.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Bounds race-clock progress so impossible timing input cannot move the UI
// marker outside the pit window bar.
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Reads a non-negative numeric rule value and falls back to the default when the
// UI/settings contain invalid data. Change this if negative offsets ever become
// meaningful for a future rule variant.
function positiveNumber(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? n : fallback;
}

// Merges user-configurable pit rules with defaults. This is the main place to
// adjust rule defaults such as first/last closed minutes, cooldown duration,
// mandatory stop count, or minimum pit loss.
function normalizeRules(rules = {}) {
  const merged = { ...DEFAULT_RULES, ...rules };
  const configuredFcySpeedKph = numberOrNull(merged.fcySpeedKph);
  return {
    raceDurationMs: positiveNumber(merged.raceDurationMs, DEFAULT_RULES.raceDurationMs),
    pitClosedStartMs: positiveNumber(merged.pitClosedStartMs, DEFAULT_RULES.pitClosedStartMs),
    pitClosedEndMs: positiveNumber(merged.pitClosedEndMs, DEFAULT_RULES.pitClosedEndMs),
    pitCooldownMs: positiveNumber(merged.pitCooldownMs, DEFAULT_RULES.pitCooldownMs),
    pitStopDurationMs: positiveNumber(merged.pitStopDurationMs, DEFAULT_RULES.pitStopDurationMs),
    requiredPitStops: Math.max(0, Math.floor(positiveNumber(merged.requiredPitStops, DEFAULT_RULES.requiredPitStops))),
    nearWindowLaps: Math.max(0, Math.floor(positiveNumber(merged.nearWindowLaps, DEFAULT_RULES.nearWindowLaps))),
    averageLapMs: numberOrNull(merged.averageLapMs),
    circuitId: String(merged.circuitId || DEFAULT_RULES.circuitId),
    regularTrackDistanceMeters: numberOrNull(merged.regularTrackDistanceMeters),
    // Zero cannot be accepted here because FCY travel time divides by speed.
    fcySpeedKph: configuredFcySpeedKph !== null && configuredFcySpeedKph > 0
      ? configuredFcySpeedKph
      : DEFAULT_RULES.fcySpeedKph,
    fcyStablePollsRequired: Math.max(1, Math.floor(positiveNumber(merged.fcyStablePollsRequired, DEFAULT_RULES.fcyStablePollsRequired))),
    fcyMinimumAgeMs: positiveNumber(merged.fcyMinimumAgeMs, DEFAULT_RULES.fcyMinimumAgeMs)
  };
}

function isFcySession(session = {}) {
  const flag = String(session.flag || session.sessionFlag || session.raceControl || '').toLowerCase();
  return /full\s*course\s*yellow|\bfcy\b/.test(flag);
}

// Produces compact signatures from timing rows. Gap stability alone is not
// enough because three polls may repeat stale webpage data; a changed lap,
// sector, or last-lap value proves that at least one new timing passage arrived.
function fcyRowSignatures(rows = []) {
  const ordered = overallSortedRows(rows);
  return {
    gap: ordered.map((row) => `${row.carNumber}:${row.interval ?? row.diff ?? row.gap ?? ''}`).join('|'),
    timing: ordered.map((row) => `${row.carNumber}:${row.lapNumber ?? ''}:${row.sector1 ?? ''}:${row.sector2 ?? ''}:${row.sector3 ?? ''}:${row.lastLap ?? ''}`).join('|')
  };
}

// Tracks whether FCY intervals have had time to refresh and stabilize. Main.js
// stores this small state between polls; the function remains pure and directly
// testable. A prediction may still be shown while status is "stabilizing", but
// callers must label it provisional.
function nextFcyGapState({ previous = {}, session = {}, rows = [], collectedAt = '', rules = {} } = {}) {
  const normalized = normalizeRules(rules);
  const signatures = fcyRowSignatures(rows);
  const active = isFcySession(session);
  const nowMs = Number.isFinite(Date.parse(collectedAt)) ? Date.parse(collectedAt) : Date.now();
  if (!active) {
    return {
      active: false,
      status: 'green',
      ready: false,
      startedAtMs: null,
      stablePolls: 0,
      freshTimingObserved: false,
      lastGapSignature: signatures.gap,
      lastTimingSignature: signatures.timing
    };
  }

  const justStarted = previous.active !== true;
  const startedAtMs = justStarted ? nowMs : (numberOrNull(previous.startedAtMs) ?? nowMs);
  const sameGap = !justStarted && signatures.gap !== '' && signatures.gap === previous.lastGapSignature;
  const stablePolls = sameGap ? (Number(previous.stablePolls) || 0) + 1 : 0;
  const freshTimingObserved = Boolean(previous.freshTimingObserved)
    || signatures.timing !== String(previous.lastTimingSignature || '');
  const ageMs = Math.max(0, nowMs - startedAtMs);
  const ready = freshTimingObserved
    && ageMs >= normalized.fcyMinimumAgeMs
    && stablePolls >= normalized.fcyStablePollsRequired;

  return {
    active: true,
    status: ready ? 'ready' : 'stabilizing',
    ready,
    startedAtMs,
    ageMs,
    stablePolls,
    freshTimingObserved,
    lastGapSignature: signatures.gap,
    lastTimingSignature: signatures.timing
  };
}

// Calculates only the time lost relative to a non-pitting car. The dashboard's
// pit time is measured pit-in to pit-out; under FCY we subtract the time another
// car spends on the regular track between those exact reference points.
function pitLossForSession({ session = {}, rules = {}, fcyGapState = {} } = {}) {
  const normalized = normalizeRules(rules);
  if (!isFcySession(session)) {
    return { active: false, status: 'green', reliable: true, pitLossMs: normalized.pitStopDurationMs };
  }

  const distanceMeters = numberOrNull(normalized.regularTrackDistanceMeters);
  if (!(distanceMeters > 0)) {
    return {
      active: true,
      status: 'missing-distance',
      reliable: false,
      pitLossMs: null,
      circuitId: normalized.circuitId,
      reason: `Regular-track pit distance is not configured for ${normalized.circuitId}`
    };
  }
  // Store strategy times at millisecond precision, matching every other timing
  // value in the app and avoiding floating-point tails such as 29999.999999.
  const regularTrackTravelMs = Math.round((distanceMeters / (normalized.fcySpeedKph / 3.6)) * 1000);
  return {
    active: true,
    status: fcyGapState.ready ? 'ready' : 'stabilizing',
    reliable: Boolean(fcyGapState.ready),
    provisional: !fcyGapState.ready,
    circuitId: normalized.circuitId,
    regularTrackDistanceMeters: distanceMeters,
    fcySpeedKph: normalized.fcySpeedKph,
    regularTrackTravelMs,
    pitLossMs: normalized.pitStopDurationMs - regularTrackTravelMs
  };
}

// Parses race-clock and timing strings to milliseconds. It accepts seconds,
// mm:ss, hh:mm:ss, and values like "55:54 / 1" from the dashboard header.
function parseTimeToMs(value) {
  const text = String(value || '').trim().replace(',', '.');
  if (!text || /^(—|-|--|\?)$/i.test(text)) return null;
  const main = text.split('/')[0].trim();
  const parts = main.split(':').map((part) => part.trim());
  if (!parts.every((part) => part !== '' && Number.isFinite(Number(part)))) return null;
  if (parts.length === 1) return Math.round(Number(parts[0]) * 1000);
  if (parts.length === 2) return Math.round((Number(parts[0]) * 60 + Number(parts[1])) * 1000);
  if (parts.length === 3) return Math.round((Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])) * 1000);
  return null;
}

// Formats milliseconds for compact dashboard labels. It intentionally omits
// milliseconds because pit window/cooldown information is strategic timing, not
// lap timing precision.
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const sign = ms < 0 ? '-' : '';
  let remaining = Math.abs(Math.round(ms));
  const hours = Math.floor(remaining / 3600000);
  remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000);
  remaining %= 60000;
  const seconds = Math.floor(remaining / 1000);
  if (hours > 0) return `${sign}${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Converts session "time left" into elapsed/remaining/progress. If the timing
// page does not expose a clock yet, the planner returns null values instead of
// guessing and possibly counting an invalid pitstop as valid.
function raceClockFromSession(session = {}, rules = {}) {
  const normalized = normalizeRules(rules);
  const remainingMs = parseTimeToMs(session.timeToGo || session.remaining || '');
  if (remainingMs === null) {
    return {
      raceDurationMs: normalized.raceDurationMs,
      elapsedMs: null,
      remainingMs: null,
      progress: 0
    };
  }
  const raceDurationMs = Math.max(normalized.raceDurationMs, remainingMs);
  const elapsedMs = clamp(raceDurationMs - remainingMs, 0, raceDurationMs);
  return {
    raceDurationMs,
    elapsedMs,
    remainingMs,
    progress: raceDurationMs > 0 ? elapsedMs / raceDurationMs : 0
  };
}

// Extracts the pitstop count from provider fields. RIS/GetRaceResults may expose
// this as "P2", "stops 2", or similar text, so we only keep the first number.
function pitCountFromRow(row = {}) {
  const candidates = [row.pit, row.pitInfo, row.pitStops];
  for (const candidate of candidates) {
    const match = String(candidate ?? '').match(/\d+/);
    if (match) return Number(match[0]);
  }
  return 0;
}

// Updates the remembered pit state for our car using one fresh live row.
//
// Important behavior:
// - the first sample is accepted as baseline because the app cannot know when
//   earlier stops happened before it started;
// - every later increase in the PIT counter only counts as a required/valid
//   stop when the pit window was open at that moment;
// - invalid stops remain visible in completedPitStops but do not reduce the
//   remaining mandatory stop count.
function nextPitStateFromRow({ previous = {}, row = {}, session = {}, rules = {}, averageLapMs = null, collectedAt = '' } = {}) {
  const normalizedRules = normalizeRules(rules);
  const previousState = {
    completedPitStops: 0,
    validCompletedPitStops: 0,
    rawPitCount: null,
    lastPitAt: '',
    lastPitElapsedMs: null,
    validPitElapsedHistoryMs: [],
    ...previous
  };
  const nextCount = pitCountFromRow(row);
  const completedPitStops = Math.max(previousState.completedPitStops || 0, nextCount);
  const clock = raceClockFromSession(session, normalizedRules);
  const windowAtPit = timeUntilNextAllowedPit({ clock, rules: normalizedRules, pitState: previousState });
  const isFirstPitSample = previousState.rawPitCount === null || previousState.rawPitCount === undefined;
  const pitCountIncreased = !isFirstPitSample && nextCount > (previousState.rawPitCount || 0);
  // Existing stops that are already present on the first sample are accepted as
  // baseline stops because the app cannot reconstruct when they happened. Every
  // new increase after that must happen in a green/open window to count.
  const baselineValidPitStops = isFirstPitSample ? nextCount : (previousState.validCompletedPitStops || 0);
  const validIncrement = pitCountIncreased && windowAtPit.allowed ? nextCount - (previousState.rawPitCount || 0) : 0;
  const next = {
    ...previousState,
    completedPitStops,
    validCompletedPitStops: Math.min(completedPitStops, baselineValidPitStops + validIncrement),
    rawPitCount: nextCount,
    averageLapMs: numberOrNull(averageLapMs)
  };
  if (pitCountIncreased) {
    next.lastPitAt = collectedAt || new Date().toISOString();
    next.lastPitElapsedMs = clock.elapsedMs;
    next.lastPitCountedAsValid = windowAtPit.allowed;
    next.lastPitValidityReason = windowAtPit.allowed ? 'Pitstop counted: pit window was open.' : `Pitstop not counted: ${windowAtPit.reason}.`;
    if (windowAtPit.allowed && Number.isFinite(clock.elapsedMs)) {
      next.validPitElapsedHistoryMs = [...(previousState.validPitElapsedHistoryMs || []), clock.elapsedMs];
    }
  }
  return next;
}

// Normalizes lap numbers from live rows. Null means "unknown", which is safer
// than assuming two cars are on the same lap.
function lapNumber(row = {}) {
  const n = Number(row.lapNumber);
  return Number.isFinite(n) ? n : null;
}

// Orders cars by race distance first and timing table position second. This is
// used when class positions are duplicated or missing.
function compareRaceOrder(a, b) {
  const lapDelta = (lapNumber(b) ?? 0) - (lapNumber(a) ?? 0);
  if (lapDelta) return lapDelta;
  return (Number(a.position) || 999999) - (Number(b.position) || 999999);
}

// Sorts the full timing table by overall position. This is separate from
// compareRaceOrder because provider DIFF/INT columns are relative to visual
// table order, not class order.
function overallSortedRows(rows) {
  return [...(rows || [])].sort((a, b) => (Number(a.position) || 999999) - (Number(b.position) || 999999));
}

// Finds the row immediately above another car in the full timing table.
function previousOverallRow(rows, row) {
  const ordered = overallSortedRows(rows);
  const index = ordered.findIndex((candidate) => String(candidate.carNumber) === String(row.carNumber));
  return index > 0 ? ordered[index - 1] : null;
}

// Returns our followed row plus all rows in the same class, sorted by class
// position. Future UI filters for class can be added here.
function classRows(rows, followedCarNumber) {
  const followed = (rows || []).find((row) => String(row.carNumber) === String(followedCarNumber));
  if (!followed?.className) return { followed: followed || null, rows: [] };
  const sorted = rows
    .filter((row) => row.className === followed.className)
    .sort((a, b) => (Number(a.classPosition) || 999999) - (Number(b.classPosition) || 999999) || compareRaceOrder(a, b));
  return { followed, rows: sorted };
}

// Parses gap/interval text while rejecting lap gaps such as "1L". Lap gaps must
// be handled through lapNumber, otherwise a car several laps behind can look
// only a few seconds away.
function parseGapToMs(value) {
  const text = String(value || '').trim();
  if (!text || text === '--' || text === '?' || /\d+\s*l/i.test(text)) return null;
  return parseTimeToMs(text.replace(/^\+/, ''));
}

// Chooses the best available short gap source for a row. Providers disagree on
// whether "INT", "DIFF", or "GAP" means the nearest-car interval, so this keeps
// the priority in one place.
function intervalForRow(row) {
  return parseGapToMs(row.interval) ?? parseGapToMs(row.diff) ?? parseGapToMs(row.gap);
}

// Estimates a representative lap time for converting lap differences into race
// distance. A provided average wins; otherwise the median live last-lap value is
// used because it is less sensitive to one bad/slow car than a mean.
function estimateAverageLapMs(rows, fallback = null) {
  const explicit = numberOrNull(fallback);
  if (explicit !== null) return explicit;
  const lapTimes = (rows || [])
    .map((row) => numberOrNull(row.lastLapMs) ?? parseTimeToMs(row.lastLap))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!lapTimes.length) return null;
  return lapTimes[Math.floor(lapTimes.length / 2)];
}

// Builds cumulative gaps from class leader using adjacent class intervals. When
// any interval becomes unreliable, later cumulative gaps are marked unreliable
// instead of silently producing a false after-pit prediction.
// A class interval is reliable only when the previous overall timing row is
// also the previous class row. Otherwise another-class traffic sits between the
// cars and DIFF/INT describes the wrong car.
function relativeGapsFromClassIntervals(rows, rowsInClass) {
  let totalMs = 0;
  let reliable = true;
  return rowsInClass.map((row, index) => {
    if (index === 0) return { row, gapToClassLeaderMs: 0, reliable: true };
    const previousClassRow = rowsInClass[index - 1];
    const previousOverall = previousOverallRow(rows, row);
    if (!previousOverall || String(previousOverall.carNumber) !== String(previousClassRow.carNumber)) reliable = false;
    const intervalMs = intervalForRow(row);
    if (!Number.isFinite(intervalMs)) reliable = false;
    if (reliable) totalMs += intervalMs;
    return {
      row,
      gapToClassLeaderMs: reliable ? totalMs : null,
      reliable
    };
  });
}

// Walks down the full timing table from our car and adds adjacent overall
// intervals until the configured pit loss is consumed. This mirrors how the
// timing page itself defines DIFF/INT: each row's interval is to the previous
// overall row, regardless of class. Lap-gap labels are not converted to seconds
// here; if the provider gives a numeric DIFF/INT, that is the physical gap chain
// we need for "where do we rejoin after the stop?".
function overallGapsBehindFollowed(rows, followedCarNumber, averageLapMs = null) {
  const ordered = overallSortedRows(rows);
  const startIndex = ordered.findIndex((row) => String(row.carNumber) === String(followedCarNumber));
  if (startIndex < 0) return [];
  let totalMs = 0;
  const gaps = [];

  for (let index = startIndex + 1; index < ordered.length; index += 1) {
    const row = ordered[index];
    const intervalMs = intervalForRow(row);
    if (!Number.isFinite(intervalMs)) break;
    totalMs += intervalMs;
    gaps.push({ row, gapFromFollowedMs: totalMs });
  }
  return gaps;
}

// Predicts where our car would rejoin the class after losing pitLossMs.
//
// The first path uses the provider's overall DIFF/INT chain, which is the best
// source for the physical rejoin position after a pitstop. The class-gap
// fallback below is only used when that overall chain is unavailable.
function projectClassAfterPit(rows, followedCarNumber, pitLossMs, options = {}) {
  const { followed, rows: rowsInClass } = classRows(rows, followedCarNumber);
  if (!followed || !rowsInClass.length) return { available: false, reason: 'No class data yet', items: [] };
  const averageLapMs = estimateAverageLapMs(rowsInClass, options.averageLapMs);
  const overallBehind = overallGapsBehindFollowed(rows, followedCarNumber, averageLapMs);
  const classBehind = overallBehind.filter((item) => item.row.className === followed.className);
  if (Number.isFinite(pitLossMs) && classBehind.length) {
    const passedClassCars = classBehind.filter((item) => item.gapFromFollowedMs <= pitLossMs);
    const carAheadEntry = passedClassCars.at(-1) || null;
    const carBehindEntry = classBehind.find((item) => item.gapFromFollowedMs > pitLossMs) || null;
    const currentClassPosition = Number(followed.classPosition);
    const projectedClassPosition = Number.isFinite(currentClassPosition)
      ? currentClassPosition + passedClassCars.length
      : rowsInClass.findIndex((row) => String(row.carNumber) === String(followedCarNumber)) + 1 + passedClassCars.length;

    return {
      available: true,
      projectedClassPosition,
      averageLapMs,
      carAhead: carAheadEntry ? {
        carNumber: String(carAheadEntry.row.carNumber),
        team: carAheadEntry.row.team || '',
        driver: carAheadEntry.row.driver || '',
        currentClassPosition: carAheadEntry.row.classPosition || null,
        lapDeltaToUs: Number.isFinite(lapNumber(carAheadEntry.row)) && Number.isFinite(lapNumber(followed)) ? lapNumber(carAheadEntry.row) - lapNumber(followed) : null,
        projectedGapToUsMs: carAheadEntry.gapFromFollowedMs - pitLossMs,
        isOurCar: false
      } : null,
      carBehind: carBehindEntry ? {
        carNumber: String(carBehindEntry.row.carNumber),
        team: carBehindEntry.row.team || '',
        driver: carBehindEntry.row.driver || '',
        currentClassPosition: carBehindEntry.row.classPosition || null,
        lapDeltaToUs: Number.isFinite(lapNumber(carBehindEntry.row)) && Number.isFinite(lapNumber(followed)) ? lapNumber(carBehindEntry.row) - lapNumber(followed) : null,
        projectedGapToUsMs: carBehindEntry.gapFromFollowedMs - pitLossMs,
        isOurCar: false
      } : null,
      items: [
        ...passedClassCars.map((item) => ({ carNumber: String(item.row.carNumber), projectedGapToUsMs: item.gapFromFollowedMs - pitLossMs, isOurCar: false })),
        { carNumber: String(followedCarNumber), projectedGapToUsMs: 0, isOurCar: true },
        ...classBehind.filter((item) => item.gapFromFollowedMs > pitLossMs).map((item) => ({ carNumber: String(item.row.carNumber), projectedGapToUsMs: item.gapFromFollowedMs - pitLossMs, isOurCar: false }))
      ]
    };
  }

  const relative = relativeGapsFromClassIntervals(rows, rowsInClass);
  const our = relative.find((item) => String(item.row.carNumber) === String(followedCarNumber));
  const ourLap = lapNumber(followed);
  const canUseLapAwareProjection = Number.isFinite(averageLapMs) && Number.isFinite(ourLap);

  if ((!our || !Number.isFinite(our.gapToClassLeaderMs)) && !canUseLapAwareProjection) {
    return { available: false, reason: 'Class gaps/laps are not reliable yet', items: [] };
  }

  const scoreFor = (item, extraLossMs = 0) => {
    const lap = lapNumber(item.row);
    if (canUseLapAwareProjection && Number.isFinite(lap)) {
      if (lap === ourLap && !Number.isFinite(item.gapToClassLeaderMs)) return null;
      const knownGapMs = Number.isFinite(item.gapToClassLeaderMs) ? item.gapToClassLeaderMs : 0;
      return (lap * averageLapMs) - knownGapMs - extraLossMs;
    }
    if (Number.isFinite(item.gapToClassLeaderMs)) return -item.gapToClassLeaderMs - extraLossMs;
    return null;
  };

  const ourScore = scoreFor(our, pitLossMs);
  if (!Number.isFinite(ourScore)) return { available: false, reason: 'Our projected race distance is not reliable yet', items: [] };

  const projected = relative
    .map((item) => {
      const isOurCar = String(item.row.carNumber) === String(followedCarNumber);
      const score = isOurCar ? ourScore : scoreFor(item, 0);
      if (!Number.isFinite(score)) return null;
      const lapDeltaToUs = Number.isFinite(lapNumber(item.row)) && Number.isFinite(ourLap) ? lapNumber(item.row) - ourLap : null;
      return {
        carNumber: String(item.row.carNumber),
        team: item.row.team || '',
        driver: item.row.driver || '',
        currentClassPosition: item.row.classPosition || null,
        lapDeltaToUs,
        projectedGapToUsMs: isOurCar ? 0 : ourScore - score,
        isOurCar
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.projectedGapToUsMs - b.projectedGapToUsMs);

  const ourProjectedIndex = projected.findIndex((item) => item.isOurCar);
  const carAhead = ourProjectedIndex > 0 ? projected[ourProjectedIndex - 1] : null;
  const carBehind = ourProjectedIndex >= 0 && ourProjectedIndex < projected.length - 1 ? projected[ourProjectedIndex + 1] : null;

  return {
    available: true,
    projectedClassPosition: ourProjectedIndex >= 0 ? ourProjectedIndex + 1 : null,
    averageLapMs,
    carAhead,
    carBehind,
    items: projected
  };
}

// Applies the green/red pit-window rules at the current race clock. This checks
// only whether a pitstop is allowed by time windows/cooldown; strategic urgency
// is added in buildPitstopPlan().
function timeUntilNextAllowedPit({ clock, rules, pitState = {} }) {
  if (clock.elapsedMs === null || clock.remainingMs === null) {
    return { allowed: false, reason: 'Waiting for race clock', waitMs: null };
  }
  if (clock.elapsedMs < rules.pitClosedStartMs) {
    return { allowed: false, reason: 'Pit closed at race start', waitMs: rules.pitClosedStartMs - clock.elapsedMs };
  }
  if (clock.remainingMs <= rules.pitClosedEndMs) {
    return { allowed: false, reason: 'Pit closed near race finish', waitMs: null };
  }
  const lastPitElapsedMs = numberOrNull(pitState.lastPitElapsedMs);
  if (lastPitElapsedMs !== null) {
    const cooldownEnd = lastPitElapsedMs + rules.pitCooldownMs;
    if (clock.elapsedMs < cooldownEnd) {
      return { allowed: false, reason: 'Minimum time after last pitstop', waitMs: cooldownEnd - clock.elapsedMs };
    }
  }
  return { allowed: true, reason: 'Pit window open', waitMs: 0 };
}

// Calculates the latest elapsed race time at which the next required stop can
// happen while still leaving enough cooldown-separated windows for remaining
// mandatory stops.
function latestSafePitElapsedMsForRemainingStops({ clock, rules, pitState = {} }) {
  if (clock.elapsedMs === null || clock.remainingMs === null) return null;
  const completed = Math.max(0, Number(pitState.validCompletedPitStops ?? pitState.completedPitStops) || 0);
  const remainingStops = Math.max(0, rules.requiredPitStops - completed);
  if (remainingStops <= 0) return clock.raceDurationMs - rules.pitClosedEndMs;
  return clock.raceDurationMs - rules.pitClosedEndMs - ((remainingStops - 1) * rules.pitCooldownMs);
}

// Produces the full dashboard-facing pitstop object. Callers pass live rows,
// session clock, current pit state, and rules; the returned object contains all
// status labels, required-stop counts, timing windows, and after-pit projection.
function buildPitstopPlan({ rows = [], session = {}, followedCarNumber = '', pitState = {}, rules = {}, fcyGapState = {} } = {}) {
  const normalizedRules = normalizeRules(rules);
  const clock = raceClockFromSession(session, normalizedRules);
  const windowState = timeUntilNextAllowedPit({ clock, rules: normalizedRules, pitState });
  const totalPitStops = Math.max(0, Number(pitState.completedPitStops) || 0);
  const completedPitStops = Math.max(0, Number(pitState.validCompletedPitStops ?? pitState.completedPitStops) || 0);
  const remainingRequiredStops = Math.max(0, normalizedRules.requiredPitStops - completedPitStops);
  const averageLapMs = normalizedRules.averageLapMs || numberOrNull(pitState.averageLapMs);
  const nearWindowMs = averageLapMs ? averageLapMs * normalizedRules.nearWindowLaps : null;
  const isNearlyOpen = !windowState.allowed && Number.isFinite(windowState.waitMs) && Number.isFinite(nearWindowMs) && windowState.waitMs <= nearWindowMs;
  const latestSafePitElapsedMs = latestSafePitElapsedMsForRemainingStops({ clock, rules: normalizedRules, pitState });
  const mustPitSoonMs = latestSafePitElapsedMs !== null && clock.elapsedMs !== null ? latestSafePitElapsedMs - clock.elapsedMs : null;
  const isStrategyUrgent = remainingRequiredStops > 0 && Number.isFinite(mustPitSoonMs) && mustPitSoonMs <= 0;
  const pitLoss = pitLossForSession({ session, rules: normalizedRules, fcyGapState });
  const projection = Number.isFinite(pitLoss.pitLossMs)
    ? { ...projectClassAfterPit(rows, followedCarNumber, pitLoss.pitLossMs, { averageLapMs }), provisional: pitLoss.provisional, fcyStatus: pitLoss.status }
    : { available: false, reason: pitLoss.reason, items: [], fcyStatus: pitLoss.status };

  let status = 'unknown';
  if (isStrategyUrgent) status = 'urgent';
  else if (windowState.allowed) status = 'open';
  else if (isNearlyOpen) status = 'soon';
  else status = 'closed';

  const label = status === 'open'
    ? 'Pit window open'
    : status === 'soon'
      ? `Pit window soon (${formatDuration(windowState.waitMs)})`
      : status === 'urgent'
        ? 'Pit now to finish required stops'
        : windowState.reason;

  return {
    rules: normalizedRules,
    clock,
    status,
    label,
    canPitNow: windowState.allowed || isStrategyUrgent,
    isNearlyOpen,
    waitMs: windowState.waitMs,
    completedPitStops,
    totalPitStops,
    lastPitElapsedMs: numberOrNull(pitState.lastPitElapsedMs),
    validPitElapsedHistoryMs: (pitState.validPitElapsedHistoryMs || []).map(numberOrNull).filter(Number.isFinite),
    remainingRequiredStops,
    latestSafePitElapsedMs,
    mustPitSoonMs,
    projection,
    pitLoss,
    fcyGapState
  };
}

return {
  DEFAULT_RULES,
  numberOrNull,
  normalizeRules,
  parseTimeToMs,
  formatDuration,
  pitCountFromRow,
  nextPitStateFromRow,
  estimateAverageLapMs,
  raceClockFromSession,
  isFcySession,
  fcyRowSignatures,
  nextFcyGapState,
  pitLossForSession,
  projectClassAfterPit,
  timeUntilNextAllowedPit,
  latestSafePitElapsedMsForRemainingStops,
  buildPitstopPlan
};
});
