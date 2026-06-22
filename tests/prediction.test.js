const assert = require('assert');
const { predictCurrentLap, predictionProfileForRow } = require('../src/shared/normPrediction');

function lap(carNumber, driver, lapNumber, sector1Ms, sector2Ms, sector3Ms) {
  return {
    carNumber,
    driver,
    lapNumber,
    recordedAt: `2026-06-22T12:${String(lapNumber).padStart(2, '0')}:00.000Z`,
    sector1Ms,
    sector2Ms,
    sector3Ms,
    lastLapMs: sector1Ms + sector2Ms + sector3Ms
  };
}

const history = [
  lap(33, 'Alice', 1, 32000, 39000, 30000),
  lap(33, 'Alice', 2, 32100, 39100, 30100),
  lap(33, 'Alice', 3, 31900, 38900, 29900),
  lap(33, 'Bob', 4, 34000, 42000, 33000),
  lap(33, 'Bob', 5, 34100, 42100, 33100),
  lap(33, 'Bob', 6, 33900, 41900, 32900)
];

// Contract: prediction should not start until enough completed sector laps exist
// for either the current driver or the car fallback.
assert.strictEqual(
  predictCurrentLap({ carNumber: 44, driver: 'New Driver', sector1Ms: 32000 }, history),
  null
);

// Contract: driver-specific data is preferred when available. The exact math may
// change later, but the model source and sample size should still make that clear.
const aliceProfile = predictionProfileForRow({ carNumber: 33, driver: 'Alice' }, history);
assert.ok(aliceProfile);
assert.strictEqual(aliceProfile.source, 'driver Alice');
assert.strictEqual(aliceProfile.sampleSize, 3);

// Contract: a driver without enough own laps can still use the followed car's
// completed sector history as a fallback.
const carProfile = predictionProfileForRow({ carNumber: 33, driver: 'Charlie' }, history);
assert.ok(carProfile);
assert.strictEqual(carProfile.source, 'car average');
assert.strictEqual(carProfile.sampleSize, history.length);

// Contract: after S1 and S2, predictions expose the stage and produce a finite
// predicted time that is ahead of the elapsed sectors.
const afterS1 = predictCurrentLap({ carNumber: 33, driver: 'Alice', sector1Ms: 31000 }, history);
assert.ok(afterS1);
assert.strictEqual(afterS1.stage, 'S1');
assert.ok(Number.isFinite(afterS1.predictedMs));
assert.ok(afterS1.predictedMs > afterS1.elapsedMs);

const afterS2 = predictCurrentLap({ carNumber: 33, driver: 'Alice', sector1Ms: 31000, sector2Ms: 38000 }, history);
assert.ok(afterS2);
assert.strictEqual(afterS2.stage, 'S2');
assert.ok(Number.isFinite(afterS2.predictedMs));
assert.ok(afterS2.predictedMs > afterS2.elapsedMs);

// Contract: once all three sectors are present, the prediction equals the current
// completed sector total regardless of the future prediction model.
const afterS3 = predictCurrentLap({ carNumber: 33, driver: 'Alice', sector1Ms: 31000, sector2Ms: 38000, sector3Ms: 29000 }, history);
assert.ok(afterS3);
assert.strictEqual(afterS3.stage, 'S3');
assert.strictEqual(afterS3.predictedMs, 98000);

// Contract: callers can compare predictedMs with the configured norm time to
// decide whether the warning screen should go red. This avoids baking the exact
// dashboard color rules into the prediction module tests.
const normMs = 100000;
assert.ok(afterS3.predictedMs < normMs);

console.log('Prediction tests passed.');
