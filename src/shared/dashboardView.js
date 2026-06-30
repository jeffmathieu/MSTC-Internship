// Selects one followed car's precomputed view from the shared collector state.
// This module performs no race calculations; it prevents independent dashboard
// windows from accidentally displaying another followed car's analysis.
(function initDashboardView(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.dashboardView = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createDashboardViewApi() {
  function analyticsForCar(summary, carNumber) {
    if (!summary) return null;
    const key = String(carNumber || '');
    const isPrimary = key === String(summary.followedCar || '');
    return {
      ...summary,
      dashboardAnalysis: summary.dashboardAnalysisByCar?.[key] || (isPrimary ? summary.dashboardAnalysis : null),
      adjacentClassBattles: summary.adjacentClassBattlesByCar?.[key] || (isPrimary ? summary.adjacentClassBattles : null)
    };
  }

  function predictionForCar(state, carNumber) {
    const key = String(carNumber || '');
    const isPrimary = key === String(state?.analyticsSummary?.followedCar || '');
    return state?.lapPredictionsByCar?.[key] || (isPrimary ? state?.lapPrediction : null);
  }

  function pitstopPlanForCar(state, carNumber) {
    const key = String(carNumber || '');
    const isPrimary = key === String(state?.analyticsSummary?.followedCar || '');
    return state?.pitstopPlansByCar?.[key] || (isPrimary ? state?.pitstopPlan : null);
  }

  return { analyticsForCar, predictionForCar, pitstopPlanForCar };
});
