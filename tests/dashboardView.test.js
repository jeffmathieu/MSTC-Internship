const assert = require('assert');
const dashboardView = require('../src/shared/dashboardView');

const state = {
  analyticsSummary: {
    followedCar: '13',
    dashboardAnalysis: { car: 'legacy-primary-13' },
    adjacentClassBattles: { car: 'legacy-primary-13' },
    dashboardAnalysisByCar: {
      13: { car: '13' },
      2: { car: '2' },
      9: { car: '9' }
    },
    adjacentClassBattlesByCar: {
      13: { car: '13' },
      2: { car: '2' },
      9: { car: '9' }
    },
    comparisonViewsByCar: {
      13: { car: '13' },
      2: { car: '2' },
      9: { car: '9' }
    },
    modeAdjacentViewsByCar: {
      13: { car: 'mode-13' },
      2: { car: 'mode-2' },
      9: { car: 'mode-9' }
    }
  },
  lapPrediction: { car: 'legacy-primary-13' },
  lapPredictionsByCar: { 13: { car: '13' }, 2: { car: '2' }, 9: { car: '9' } },
  pitstopPlan: { car: 'legacy-primary-13' },
  pitstopPlansByCar: { 13: { car: '13' }, 2: { car: '2' }, 9: { car: '9' } }
};

assert.strictEqual(dashboardView.analyticsForCar(state.analyticsSummary, '2').dashboardAnalysis.car, '2');
assert.strictEqual(dashboardView.analyticsForCar(state.analyticsSummary, '2').comparisonView.car, '2');
assert.strictEqual(dashboardView.analyticsForCar(state.analyticsSummary, '2').adjacentClassBattles.car, 'mode-2');
assert.strictEqual(dashboardView.predictionForCar(state, '9').car, '9');
assert.strictEqual(dashboardView.pitstopPlanForCar(state, '9').car, '9');
assert.strictEqual(dashboardView.analyticsForCar(state.analyticsSummary, '13').dashboardAnalysis.car, '13');
assert.strictEqual(dashboardView.analyticsForCar(state.analyticsSummary, '').dashboardAnalysis, null);
assert.strictEqual(dashboardView.analyticsForCar(state.analyticsSummary, '99').dashboardAnalysis, null);
assert.strictEqual(dashboardView.predictionForCar(state, '99'), null);
assert.strictEqual(dashboardView.pitstopPlanForCar(state, '99'), null);
assert.strictEqual(dashboardView.predictionForCar(null, '13'), null);
assert.strictEqual(dashboardView.pitstopPlanForCar({}, '13'), null);

const legacyState = {
  analyticsSummary: { followedCar: '13', dashboardAnalysis: { car: '13' }, adjacentClassBattles: { car: '13' } },
  lapPrediction: { car: '13' },
  pitstopPlan: { car: '13' }
};
assert.strictEqual(dashboardView.analyticsForCar(legacyState.analyticsSummary, 13).dashboardAnalysis.car, '13');
assert.strictEqual(dashboardView.predictionForCar(legacyState, 13).car, '13');
assert.strictEqual(dashboardView.pitstopPlanForCar(legacyState, 13).car, '13');
assert.strictEqual(dashboardView.analyticsForCar(null, 13), null);

const partialMaps = {
  analyticsSummary: {
    followedCar: '13',
    dashboardAnalysis: { car: 'fallback-13' },
    adjacentClassBattles: { car: 'fallback-13' },
    dashboardAnalysisByCar: {},
    adjacentClassBattlesByCar: {}
  },
  lapPrediction: { car: 'fallback-13' },
  lapPredictionsByCar: {},
  pitstopPlan: { car: 'fallback-13' },
  pitstopPlansByCar: {}
};
assert.strictEqual(dashboardView.analyticsForCar(partialMaps.analyticsSummary, 13).dashboardAnalysis.car, 'fallback-13');
assert.strictEqual(dashboardView.predictionForCar(partialMaps, 13).car, 'fallback-13');
assert.strictEqual(dashboardView.pitstopPlanForCar(partialMaps, 13).car, 'fallback-13');

console.log('Dashboard view tests passed.');
