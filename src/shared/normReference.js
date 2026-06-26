// Norm/reference-time helpers.
//
// These rules are deliberately UI-independent so they can be tested with race
// scenarios directly. The renderer should only format the returned status into
// colors/text; if the race director explains different margins later, adjust the
// thresholds here first.
(function initNormReference(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.normReference = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createNormReferenceApi() {
const DEFAULT_THRESHOLDS_MS = {
  redMarginMs: 500,
  orangeMarginMs: 2000
};

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Accepts race-engineer friendly time entry:
// - "41.2" means 41.200 seconds
// - "124.500" means 2:04.500
// - "2:04.500" means 2 minutes 4.500 seconds
function parseDashboardTimeToMs(value) {
  const text = String(value || '').trim().replace(',', '.');
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 1) return Math.round(parts[0] * 1000);
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  return null;
}

function displayDeltaSeconds(ms) {
  if (!Number.isFinite(ms)) return '—';
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

// Positive delta means safely above the minimum/reference time. Negative means
// too fast. Close-but-still-above values warn the engineer before a rule breach.
function normState(deltaMs, thresholds = DEFAULT_THRESHOLDS_MS) {
  if (!Number.isFinite(deltaMs)) return 'neutral';
  if (deltaMs <= thresholds.redMarginMs) return 'bad';
  if (deltaMs <= thresholds.orangeMarginMs) return 'warn';
  return 'good';
}

function deltaToReference(valueMs, referenceMs) {
  const value = numberOrNull(valueMs);
  const reference = numberOrNull(referenceMs);
  return value === null || reference === null ? null : value - reference;
}

function lapReferenceStatus(valueMs, referenceMs, thresholds = DEFAULT_THRESHOLDS_MS) {
  const deltaMs = deltaToReference(valueMs, referenceMs);
  return {
    valueMs: numberOrNull(valueMs),
    referenceMs: numberOrNull(referenceMs),
    deltaMs,
    deltaLabel: deltaMs === null ? '—' : displayDeltaSeconds(deltaMs),
    state: normState(deltaMs, thresholds)
  };
}

function sectorReferenceStatus(lastMs, bestMs, referenceMs, thresholds = DEFAULT_THRESHOLDS_MS) {
  const lastDeltaMs = deltaToReference(lastMs, referenceMs);
  const bestDeltaMs = deltaToReference(bestMs, referenceMs);
  const usableDeltas = [lastDeltaMs, bestDeltaMs].filter(Number.isFinite);
  const tightestDeltaMs = usableDeltas.length ? Math.min(...usableDeltas) : null;
  return {
    referenceMs: numberOrNull(referenceMs),
    lastDeltaMs,
    bestDeltaMs,
    tightestDeltaMs,
    label: numberOrNull(referenceMs) === null
      ? 'Last — · Best —'
      : `Last ${lastDeltaMs === null ? '—' : displayDeltaSeconds(lastDeltaMs)} · Best ${bestDeltaMs === null ? '—' : displayDeltaSeconds(bestDeltaMs)}`,
    state: normState(tightestDeltaMs, thresholds)
  };
}

function idealReferenceStatus(bestSector1Ms, bestSector2Ms, bestSector3Ms, referenceLapMs, thresholds = DEFAULT_THRESHOLDS_MS) {
  const sectors = [bestSector1Ms, bestSector2Ms, bestSector3Ms].map(numberOrNull);
  const idealMs = sectors.every((value) => value !== null)
    ? sectors.reduce((sum, value) => sum + value, 0)
    : null;
  return {
    idealMs,
    ...lapReferenceStatus(idealMs, referenceLapMs, thresholds)
  };
}

return {
  DEFAULT_THRESHOLDS_MS,
  numberOrNull,
  parseDashboardTimeToMs,
  displayDeltaSeconds,
  normState,
  deltaToReference,
  lapReferenceStatus,
  sectorReferenceStatus,
  idealReferenceStatus
};
});
