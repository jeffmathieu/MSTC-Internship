const analytics = require('../shared/lapAnalytics');

const LAP_FIELDS = ['lapId', 'carNumber', 'className', 'teamName', 'driverName', 'lapNumber', 'displayLapNumber',
  'historySequence', 'lapNumberSource', 'lapTimeMs', 'sector1Ms', 'sector2Ms', 'sector3Ms', 'bestLapMs',
  'lastLap', 'collectedAt', 'sourceProvider', 'sessionFlag', 'lapFlag', 'sector1Flag', 'sector2Flag', 'sector3Flag',
  'lapPhase', 'isPitLap', 'pitInfo', 'manualLapStatus', 'paceEligible', 'sector1Eligible', 'sector2Eligible',
  'sector3Eligible', 'lapCondition', 'trackCondition', 'sector1Condition', 'sector2Condition', 'sector3Condition'];
const compactLaps = new WeakMap();
const signatures = new WeakMap();
function signature(item) {
  if (!signatures.has(item)) signatures.set(item, JSON.stringify(item));
  return signatures.get(item);
}
function compactLap(lap) {
  if (!compactLaps.has(lap)) compactLaps.set(lap, Object.fromEntries(LAP_FIELDS
    .filter((key) => lap[key] !== undefined).map((key) => [key, lap[key]])));
  return compactLaps.get(lap);
}

// No raw provider cells, repeated lap arrays or per-lap exclusion lists in a
// live summary. They remain in the archive and report payloads.
function compactView(value) {
  if (Array.isArray(value)) return value.map(compactView);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['raw', 'cells', 'headerMap', 'laps', 'excludedLaps', 'lapStrip', 'samples', 'newSamples'].includes(key))
    .map(([key, item]) => [key, compactView(item)]));
}

function arrayPatch(previous, next, reset) {
  let from = 0;
  if (!reset) while (from < previous.length && from < next.length
    && (previous[from] === next[from] || signature(previous[from]) === signature(next[from]))) from++;
  return from === next.length && from === previous.length && !reset ? null : { from, items: next.slice(from) };
}

function viewForCar(summary, car, graphs) {
  const own = (map) => map?.[car] ? { [car]: map[car] } : {};
  const comparison = summary.dashboardAnalysisByCar?.[car]?.classComparison;
  const driverCars = new Set([car, comparison?.bestClassCar?.carNumber, comparison?.selectedCar?.carNumber].map(String));
  if (graphs) return Object.fromEntries(['followedCar', 'sessionMode', 'trackCondition',
    'analysisConditionFilter', 'resolvedConditionFilter'].map((key) => [key, summary[key]]));
  return { ...summary, cars: summary.cars?.filter((item) => String(item.carNumber) === car),
    classes: undefined, driversByCar: Object.fromEntries(Object.entries(summary.driversByCar || {})
      .filter(([key]) => driverCars.has(key))), stintsByCar: undefined,
    dashboardAnalysis: undefined, comparisonView: undefined, adjacentClassBattles: undefined,
    gapModel: summary.gapModel ? { ...summary.gapModel, viewsByCar: own(summary.gapModel.viewsByCar) } : null,
    ...Object.fromEntries(['timingHighlightsByCar', 'adjacentClassBattlesByCar', 'comparisonViewsByCar',
      'modeAdjacentViewsByCar', 'dashboardAnalysisByCar'].map((key) => [key, own(summary[key])])) };
}

function createRendererChannel() {
  let lastHistory = null;
  let lastKey = '';
  let history = [];
  let strip = [];
  let sequence = 0;
  return (state, carNumber, graphs = false, reset = false) => {
    const summary = state.analyticsSummary || {};
    const car = String(carNumber || summary.followedCar || '');
    const sessionKey = `${state.storageSessionFolder}|${car}|${graphs}`;
    reset ||= lastKey !== sessionKey;
    let nextHistory = history;
    if (lastHistory !== state.lapHistory || reset) {
      const ourLaps = analytics.lapsForCar(state.lapHistory || [], car);
      const className = ourLaps.at(-1)?.className || state.rows?.find((row) => String(row.carNumber) === car)?.className;
      nextHistory = (graphs ? analytics.completedLaps(state.lapHistory || []).filter((lap) =>
        lap.carNumber === car || (className && lap.className === className)) : ourLaps).map(compactLap);
    }
    const nextStrip = graphs ? [] : summary.timingHighlightsByCar?.[car]?.lapStrip || [];
    const payload = {
      ...compactView(Object.fromEntries(Object.entries(state).filter(([key]) => !['lapHistory', 'analyticsSummary',
        'stintState', 'gapMemory', 'pitstopPlan', 'lapPrediction', 'pitstopPlansByCar', 'lapPredictionsByCar'].includes(key)))),
      analyticsSummary: compactView(viewForCar(summary, car, graphs)),
      stintState: graphs ? null : compactView({ cars: { [car]: state.stintState?.cars?.[car] } }),
      pitstopPlansByCar: graphs ? {} : compactView({ [car]: state.pitstopPlansByCar?.[car] }),
      lapPredictionsByCar: graphs ? {} : compactView({ [car]: state.lapPredictionsByCar?.[car] }),
      historyCount: state.lapHistory?.length || 0,
      historyPatch: arrayPatch(history, nextHistory, reset),
      stripPatch: arrayPatch(strip, nextStrip, reset),
      transportSequence: ++sequence, transportReset: reset
    };
    history = nextHistory;
    strip = nextStrip;
    lastHistory = state.lapHistory;
    lastKey = sessionKey;
    return payload;
  };
}

// The preload owns this cache; consumers receive stable array identities on
// timer-only polls, so rendering can skip every unchanged history panel.
function mergeRendererState(previous = {}, payload = {}) {
  if (!payload.transportSequence) return payload;
  if (payload.transportSequence <= (previous.transportSequence || 0)) return previous;
  const apply = (old, patch) => patch ? [...(old || []).slice(0, patch.from), ...patch.items] : old || [];
  const { historyPatch, stripPatch, ...state } = payload;
  return { ...state, lapHistory: apply(previous.lapHistory, historyPatch), lapStrip: apply(previous.lapStrip, stripPatch) };
}

module.exports = { compactView, createRendererChannel, mergeRendererState };
