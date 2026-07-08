const assert = require('assert');
const { buildTyreStrategyScenario } = require('../src/shared/pitstopPlanner');

assert.strictEqual(buildTyreStrategyScenario().status, 'disabled');
assert.strictEqual(buildTyreStrategyScenario({
  strategy: { enabled: true, currentTyre: 'dry', candidateTyre: 'dry', gainMaxMsPerLap: 1000, expectedLaps: 10 }
}).status, 'invalid');
assert.strictEqual(buildTyreStrategyScenario({
  strategy: { enabled: true, currentTyre: 'dry', candidateTyre: 'wet', gainMaxMsPerLap: 0, expectedLaps: 10 }
}).status, 'insufficient-data');

const combined = buildTyreStrategyScenario({
  currentCondition: 'wet',
  pitLoss: { pitLossMs: 75000 },
  strategy: {
    enabled: true,
    currentTyre: 'dry',
    candidateTyre: 'wet',
    gainMinMsPerLap: 3000,
    gainMaxMsPerLap: 5000,
    expectedLaps: 10,
    additionalPitTimeMs: 10000,
    combinedWithPlannedStop: true
  }
});
assert.strictEqual(combined.available, true);
assert.strictEqual(combined.changeCostMs, 10000);
assert.strictEqual(combined.breakEvenBestCaseLaps, 2);
assert.ok(Math.abs(combined.breakEvenWorstCaseLaps - (10 / 3)) < 0.0001);
assert.strictEqual(combined.netGainMinMs, 20000);
assert.strictEqual(combined.netGainMaxMs, 40000);
assert.strictEqual(combined.status, 'favourable');

const standalone = buildTyreStrategyScenario({
  currentCondition: 'wet',
  pitLoss: { pitLossMs: 75000 },
  strategy: { ...combined, enabled: true, currentTyre: 'dry', candidateTyre: 'wet', combinedWithPlannedStop: false }
});
assert.strictEqual(standalone.changeCostMs, 85000);
assert.strictEqual(standalone.status, 'not-favourable');

const waiting = buildTyreStrategyScenario({
  strategy: { enabled: true, currentTyre: 'dry', candidateTyre: 'wet', gainMaxMsPerLap: 5000, expectedLaps: 10 }
});
assert.strictEqual(waiting.status, 'waiting');

const mismatch = buildTyreStrategyScenario({
  currentCondition: 'dry',
  pitLoss: { pitLossMs: 10000 },
  strategy: { enabled: true, currentTyre: 'dry', candidateTyre: 'wet', gainMinMsPerLap: 1000, gainMaxMsPerLap: 2000, expectedLaps: 10, combinedWithPlannedStop: true }
});
assert.strictEqual(mismatch.conditionMismatch, true);
assert.match(mismatch.reason, /do not match/);

console.log('Tyre strategy tests passed.');
