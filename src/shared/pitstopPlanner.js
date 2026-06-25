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
  averageLapMs: null
};

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positiveNumber(value, fallback) {
  const n = numberOrNull(value);
  return n !== null && n >= 0 ? n : fallback;
}

function normalizeRules(rules = {}) {
  const merged = { ...DEFAULT_RULES, ...rules };
  return {
    raceDurationMs: positiveNumber(merged.raceDurationMs, DEFAULT_RULES.raceDurationMs),
    pitClosedStartMs: positiveNumber(merged.pitClosedStartMs, DEFAULT_RULES.pitClosedStartMs),
    pitClosedEndMs: positiveNumber(merged.pitClosedEndMs, DEFAULT_RULES.pitClosedEndMs),
    pitCooldownMs: positiveNumber(merged.pitCooldownMs, DEFAULT_RULES.pitCooldownMs),
    pitStopDurationMs: positiveNumber(merged.pitStopDurationMs, DEFAULT_RULES.pitStopDurationMs),
    requiredPitStops: Math.max(0, Math.floor(positiveNumber(merged.requiredPitStops, DEFAULT_RULES.requiredPitStops))),
    nearWindowLaps: Math.max(0, Math.floor(positiveNumber(merged.nearWindowLaps, DEFAULT_RULES.nearWindowLaps))),
    averageLapMs: numberOrNull(merged.averageLapMs)
  };
}

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

function pitCountFromRow(row = {}) {
  const candidates = [row.pit, row.pitInfo, row.pitStops];
  for (const candidate of candidates) {
    const match = String(candidate ?? '').match(/\d+/);
    if (match) return Number(match[0]);
  }
  return 0;
}

function lapNumber(row = {}) {
  const n = Number(row.lapNumber);
  return Number.isFinite(n) ? n : null;
}

function compareRaceOrder(a, b) {
  const lapDelta = (lapNumber(b) ?? 0) - (lapNumber(a) ?? 0);
  if (lapDelta) return lapDelta;
  return (Number(a.position) || 999999) - (Number(b.position) || 999999);
}

function classRows(rows, followedCarNumber) {
  const followed = (rows || []).find((row) => String(row.carNumber) === String(followedCarNumber));
  if (!followed?.className) return { followed: followed || null, rows: [] };
  const sorted = rows
    .filter((row) => row.className === followed.className)
    .sort((a, b) => (Number(a.classPosition) || 999999) - (Number(b.classPosition) || 999999) || compareRaceOrder(a, b));
  return { followed, rows: sorted };
}

function parseGapToMs(value) {
  const text = String(value || '').trim();
  if (!text || text === '--' || text === '?' || /\d+\s*l/i.test(text)) return null;
  return parseTimeToMs(text.replace(/^\+/, ''));
}

function intervalForRow(row) {
  return parseGapToMs(row.interval) ?? parseGapToMs(row.diff) ?? parseGapToMs(row.gap);
}

function relativeGapsFromClassIntervals(rowsInClass) {
  let totalMs = 0;
  let reliable = true;
  return rowsInClass.map((row, index) => {
    if (index === 0) return { row, gapToClassLeaderMs: 0, reliable: true };
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

function projectClassAfterPit(rows, followedCarNumber, pitLossMs) {
  const { followed, rows: rowsInClass } = classRows(rows, followedCarNumber);
  if (!followed || !rowsInClass.length) return { available: false, reason: 'No class data yet', items: [] };
  const relative = relativeGapsFromClassIntervals(rowsInClass);
  const our = relative.find((item) => String(item.row.carNumber) === String(followedCarNumber));
  if (!our || !Number.isFinite(our.gapToClassLeaderMs)) {
    return { available: false, reason: 'Class gaps are not reliable yet', items: [] };
  }

  const projectedOurGapMs = our.gapToClassLeaderMs + pitLossMs;
  const projected = relative
    .filter((item) => Number.isFinite(item.gapToClassLeaderMs))
    .map((item) => {
      const isOurCar = String(item.row.carNumber) === String(followedCarNumber);
      return {
        carNumber: String(item.row.carNumber),
        team: item.row.team || '',
        driver: item.row.driver || '',
        currentClassPosition: item.row.classPosition || null,
        projectedGapToUsMs: isOurCar ? 0 : item.gapToClassLeaderMs - projectedOurGapMs,
        isOurCar
      };
    })
    .sort((a, b) => a.projectedGapToUsMs - b.projectedGapToUsMs);

  const ourProjectedIndex = projected.findIndex((item) => item.isOurCar);
  const carAhead = ourProjectedIndex > 0 ? projected[ourProjectedIndex - 1] : null;
  const carBehind = ourProjectedIndex >= 0 && ourProjectedIndex < projected.length - 1 ? projected[ourProjectedIndex + 1] : null;

  return {
    available: true,
    projectedClassPosition: ourProjectedIndex >= 0 ? ourProjectedIndex + 1 : null,
    projectedOurGapMs,
    carAhead,
    carBehind,
    items: projected
  };
}

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

function latestSafePitElapsedMsForRemainingStops({ clock, rules, pitState = {} }) {
  if (clock.elapsedMs === null || clock.remainingMs === null) return null;
  const completed = Math.max(0, Number(pitState.completedPitStops) || 0);
  const remainingStops = Math.max(0, rules.requiredPitStops - completed);
  if (remainingStops <= 0) return clock.raceDurationMs - rules.pitClosedEndMs;
  return clock.raceDurationMs - rules.pitClosedEndMs - ((remainingStops - 1) * rules.pitCooldownMs);
}

function buildPitstopPlan({ rows = [], session = {}, followedCarNumber = '', pitState = {}, rules = {} } = {}) {
  const normalizedRules = normalizeRules(rules);
  const clock = raceClockFromSession(session, normalizedRules);
  const windowState = timeUntilNextAllowedPit({ clock, rules: normalizedRules, pitState });
  const completedPitStops = Math.max(0, Number(pitState.completedPitStops) || 0);
  const remainingRequiredStops = Math.max(0, normalizedRules.requiredPitStops - completedPitStops);
  const averageLapMs = normalizedRules.averageLapMs || numberOrNull(pitState.averageLapMs);
  const nearWindowMs = averageLapMs ? averageLapMs * normalizedRules.nearWindowLaps : null;
  const isNearlyOpen = !windowState.allowed && Number.isFinite(windowState.waitMs) && Number.isFinite(nearWindowMs) && windowState.waitMs <= nearWindowMs;
  const latestSafePitElapsedMs = latestSafePitElapsedMsForRemainingStops({ clock, rules: normalizedRules, pitState });
  const mustPitSoonMs = latestSafePitElapsedMs !== null && clock.elapsedMs !== null ? latestSafePitElapsedMs - clock.elapsedMs : null;
  const isStrategyUrgent = remainingRequiredStops > 0 && Number.isFinite(mustPitSoonMs) && mustPitSoonMs <= 0;
  const projection = projectClassAfterPit(rows, followedCarNumber, normalizedRules.pitStopDurationMs);

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
    remainingRequiredStops,
    latestSafePitElapsedMs,
    mustPitSoonMs,
    projection
  };
}

return {
  DEFAULT_RULES,
  numberOrNull,
  normalizeRules,
  parseTimeToMs,
  formatDuration,
  pitCountFromRow,
  raceClockFromSession,
  projectClassAfterPit,
  timeUntilNextAllowedPit,
  latestSafePitElapsedMsForRemainingStops,
  buildPitstopPlan
};
});
