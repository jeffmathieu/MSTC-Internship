// Track-condition model shared by storage, analytics, predictions and UI.
// Conditions are deliberately manual: timing pages do not expose reliable rain
// intensity or tyre information, so the application must never invent it.
(function initTrackConditions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.trackConditions = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createTrackConditionsApi() {
  const TRACK_CONDITIONS = ['unknown', 'dry', 'wet', 'transition'];
  const ANALYSIS_FILTERS = ['current', 'dry', 'wet', 'transition', 'combined'];

  function normalizeTrackCondition(value, fallback = 'unknown') {
    const normalized = String(value || '').trim().toLowerCase();
    return TRACK_CONDITIONS.includes(normalized) ? normalized : fallback;
  }

  function normalizeAnalysisFilter(value, fallback = 'current') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'all') return 'combined';
    return ANALYSIS_FILTERS.includes(normalized) ? normalized : fallback;
  }

  function resolveAnalysisCondition(filter, currentCondition) {
    const normalizedFilter = normalizeAnalysisFilter(filter);
    return normalizedFilter === 'current'
      ? normalizeTrackCondition(currentCondition)
      : normalizedFilter;
  }

  function mergeConditions(left, right) {
    const a = normalizeTrackCondition(left);
    const b = normalizeTrackCondition(right);
    if (a === 'unknown') return b;
    if (b === 'unknown') return a;
    if (a === b) return a;
    return 'transition';
  }

  function deriveLapCondition(lap = {}, fallback = 'unknown') {
    const explicit = normalizeTrackCondition(lap.lapCondition);
    if (explicit !== 'unknown') return explicit;
    const sectors = [1, 2, 3]
      .map((sector) => normalizeTrackCondition(lap[`sector${sector}Condition`]))
      .filter((condition) => condition !== 'unknown');
    if (!sectors.length) return normalizeTrackCondition(lap.trackCondition, normalizeTrackCondition(fallback));
    return sectors.reduce(mergeConditions);
  }

  function lapMatchesCondition(lap = {}, filter = 'combined') {
    const normalized = normalizeAnalysisFilter(filter, 'combined');
    if (normalized === 'combined' || normalized === 'current') return true;
    return deriveLapCondition(lap) === normalized;
  }

  function sectorMatchesCondition(lap = {}, sectorNumber, filter = 'combined') {
    const normalized = normalizeAnalysisFilter(filter, 'combined');
    if (normalized === 'combined' || normalized === 'current') return true;
    const sectorCondition = normalizeTrackCondition(lap[`sector${sectorNumber}Condition`]);
    if (sectorCondition !== 'unknown') return sectorCondition === normalized;
    return deriveLapCondition(lap) === normalized;
  }

  // Captures the condition while each sector is being driven. If a manual
  // change occurs before the sector time appears, the sector becomes
  // "transition" instead of being incorrectly assigned wholly dry or wet.
  function captureSectorConditions(row = {}, previous = null, currentCondition = 'unknown', phaseId = '') {
    const annotated = {
      ...row,
      trackCondition: normalizeTrackCondition(currentCondition),
      conditionPhaseId: String(phaseId || '')
    };
    const sectorValues = [1, 2, 3].map((sector) => row[`sector${sector}`]);
    const activeSectorNumber = sectorValues.findIndex((value) => !value) + 1;

    [1, 2, 3].forEach((sectorNumber) => {
      const valueKey = `sector${sectorNumber}`;
      const conditionKey = `sector${sectorNumber}Condition`;
      const phaseKey = `sector${sectorNumber}ConditionPhaseId`;
      const previousValue = previous?.[valueKey] || '';
      const previousCondition = normalizeTrackCondition(previous?.[conditionKey]);
      const sameObservedValue = Boolean(row[valueKey]) && row[valueKey] === previousValue;
      const isActiveSector = activeSectorNumber === sectorNumber;

      if (sameObservedValue && previousCondition !== 'unknown') {
        annotated[conditionKey] = previousCondition;
        annotated[phaseKey] = previous?.[phaseKey] || phaseId || '';
        return;
      }
      if (!row[valueKey] && !isActiveSector) return;

      const rowCondition = normalizeTrackCondition(row[conditionKey]);
      let observed = rowCondition !== 'unknown' ? rowCondition : normalizeTrackCondition(currentCondition);
      if (previousCondition !== 'unknown' && (isActiveSector || !previousValue)) {
        observed = mergeConditions(previousCondition, observed);
      }
      annotated[conditionKey] = observed;
      annotated[phaseKey] = observed === 'transition'
        ? `${previous?.[phaseKey] || 'unknown'}>${phaseId || 'unknown'}`
        : String(phaseId || previous?.[phaseKey] || '');
    });
    annotated.lapCondition = deriveLapCondition(annotated, currentCondition);
    return annotated;
  }

  // Applies an analysis filter without deleting records. Full-lap and sector
  // eligibility are disabled independently, preserving dry sectors from a lap
  // that became wet later in the lap.
  function conditionFilteredHistory(history = [], filter = 'combined') {
    const normalized = normalizeAnalysisFilter(filter, 'combined');
    if (normalized === 'combined' || normalized === 'current') return [...history];
    return (history || []).map((entry) => {
      const copy = { ...entry };
      if (!lapMatchesCondition(copy, normalized)) copy.paceEligible = 'false';
      [1, 2, 3].forEach((sector) => {
        if (!sectorMatchesCondition(copy, sector, normalized)) copy[`sector${sector}Eligible`] = 'false';
      });
      return copy;
    });
  }

  function conditionCounts(laps = []) {
    return laps.reduce((counts, lap) => {
      const condition = deriveLapCondition(lap);
      counts[condition] = (counts[condition] || 0) + 1;
      return counts;
    }, { dry: 0, wet: 0, transition: 0, unknown: 0 });
  }

  return {
    TRACK_CONDITIONS,
    ANALYSIS_FILTERS,
    normalizeTrackCondition,
    normalizeAnalysisFilter,
    resolveAnalysisCondition,
    mergeConditions,
    deriveLapCondition,
    lapMatchesCondition,
    sectorMatchesCondition,
    captureSectorConditions,
    conditionFilteredHistory,
    conditionCounts
  };
});
