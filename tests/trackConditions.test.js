const assert = require('assert');
const conditions = require('../src/shared/trackConditions');
const analytics = require('../src/shared/lapAnalytics');
const { buildLapPrediction } = require('../src/shared/lapPrediction');

assert.strictEqual(conditions.normalizeTrackCondition('WET'), 'wet');
assert.strictEqual(conditions.normalizeTrackCondition('rain'), 'unknown');
assert.strictEqual(conditions.normalizeAnalysisFilter('all'), 'combined');
assert.strictEqual(conditions.normalizeAnalysisFilter('overall'), 'combined');
assert.strictEqual(conditions.resolveAnalysisCondition('current', 'wet'), 'wet');
assert.strictEqual(conditions.mergeConditions('dry', 'wet'), 'transition');

const dryStart = conditions.captureSectorConditions(
  { carNumber: '33', sector1: '', sector2: '', sector3: '' },
  null,
  'dry',
  'dry-1'
);
assert.strictEqual(dryStart.sector1Condition, 'dry');

const dryS1Complete = conditions.captureSectorConditions(
  { carNumber: '33', sector1: '30.000', sector2: '', sector3: '' },
  dryStart,
  'dry',
  'dry-1'
);
const wetAfterCompletedS1 = conditions.captureSectorConditions(
  { carNumber: '33', sector1: '30.000', sector2: '', sector3: '' },
  dryS1Complete,
  'wet',
  'wet-2'
);
assert.strictEqual(wetAfterCompletedS1.sector1Condition, 'dry', 'a completed sector keeps its original condition');
assert.strictEqual(wetAfterCompletedS1.sector1ConditionPhaseId, 'dry-1');
assert.strictEqual(wetAfterCompletedS1.sector2Condition, 'transition', 'the active sector records the condition change');

const rainDuringS1 = conditions.captureSectorConditions(
  { carNumber: '33', sector1: '', sector2: '', sector3: '' },
  dryStart,
  'wet',
  'wet-2'
);
assert.strictEqual(rainDuringS1.sector1Condition, 'transition');

const s1Finished = conditions.captureSectorConditions(
  { carNumber: '33', sector1: '35.000', sector2: '', sector3: '' },
  rainDuringS1,
  'wet',
  'wet-2'
);
assert.strictEqual(s1Finished.sector1Condition, 'transition');
assert.strictEqual(s1Finished.sector2Condition, 'wet');

const history = [
	  {
	    carNumber: '33', driverName: 'Driver', lapNumber: 2, lapTimeMs: 100000,
	    sector1Ms: 30000, sector2Ms: 40000, sector3Ms: 30000,
	    lapCondition: 'dry', sector1Condition: 'dry', sector2Condition: 'dry', sector3Condition: 'dry'
	  },
	  {
	    carNumber: '33', driverName: 'Driver', lapNumber: 3, lapTimeMs: 130000,
	    sector1Ms: 35000, sector2Ms: 55000, sector3Ms: 40000,
	    lapCondition: 'wet', sector1Condition: 'wet', sector2Condition: 'wet', sector3Condition: 'wet'
	  },
	  {
	    carNumber: '33', driverName: 'Driver', lapNumber: 4, lapTimeMs: 120000,
	    sector1Ms: 31000, sector2Ms: 50000, sector3Ms: 39000,
	    lapCondition: 'transition', sector1Condition: 'dry', sector2Condition: 'transition', sector3Condition: 'wet'
  }
];

const dryStats = analytics.statsForLaps(history, { conditionFilter: 'dry' });
assert.strictEqual(dryStats.averageLapMs, 100000);
assert.strictEqual(dryStats.averageSector1Ms, 30500, 'dry sector from a transition lap remains usable');
assert.strictEqual(dryStats.averageSector2Ms, 40000);

const wetStats = analytics.statsForLaps(history, { conditionFilter: 'wet' });
assert.strictEqual(wetStats.averageLapMs, 130000);
assert.strictEqual(wetStats.averageSector3Ms, 39500, 'wet sector from a transition lap remains usable');
assert.deepStrictEqual(analytics.statsByCondition(history).dry.conditionCounts, {
  dry: 1, wet: 1, transition: 1, unknown: 0
});

const filtered = conditions.conditionFilteredHistory(history, 'wet');
assert.strictEqual(filtered[0].paceEligible, 'false');
assert.strictEqual(filtered[2].sector3Eligible, undefined);
assert.strictEqual(filtered[2].sector1Eligible, 'false');

const wetPrediction = buildLapPrediction({
  history,
  rows: [{
    carNumber: '33', driver: 'Driver', sector1: '36.000', sector2: '', sector3: '',
    sector1Condition: 'wet'
  }],
  carNumber: '33',
  options: { currentCondition: 'wet' }
});
assert.strictEqual(wetPrediction.available, true);
assert.strictEqual(wetPrediction.condition, 'wet');
assert.ok(wetPrediction.predictedLapMs > 125000 && wetPrediction.predictedLapMs < 135000);

const transitionPrediction = buildLapPrediction({
  history,
  rows: [{
    carNumber: '33', driver: 'Driver', sector1: '36.000', sector2: '', sector3: '',
    sector1Condition: 'transition'
  }],
  carNumber: '33',
  options: { currentCondition: 'wet' }
});
assert.strictEqual(transitionPrediction.available, false);
assert.strictEqual(transitionPrediction.reason, 'Waiting for sector 1');

console.log('Track condition tests passed.');
